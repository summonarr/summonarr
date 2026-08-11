import { NextRequest, NextResponse } from "next/server";
import { readActiveSummonarrSessionFromRequest } from "@/lib/session-server";
import { prisma } from "@/lib/prisma";
import {
  getRadarrWantedTmdbIds,
  getSonarrWantedTmdbIds,
  isMovieDownloadingInRadarr,
  isSeriesDownloadingInSonarr,
  getMovieReleaseInfo,
  getSeriesFirstAired,
  addMovieToRadarr,
  addSeriesToSonarr,
} from "@/lib/arr";
import { getPlexTmdbIds, getPlexLibrarySections, getPlexTVEpisodes, type PlexLibraryItemData, type PlexTVEpisodeData, type PlexLegacyGuidRef } from "@/lib/plex";
import { resolvePlexLegacyGuids, mergeResolvedLegacyItems } from "@/lib/plex-legacy-resolve";
import { getPlexConfig } from "@/lib/plex-config";
import { getJellyfinTmdbIds, getJellyfinTVEpisodes, type JellyfinLibraryItemData, type JellyfinTVEpisodeData } from "@/lib/jellyfin";
import { getJellyfinConfig } from "@/lib/jellyfin-config";
import { getMediaInstances, getSyncableMediaInstances } from "@/lib/media-instance-registry";
import { type MediaInstanceKey, plexSettingKey, jellyfinSettingKey } from "@/lib/media-instances";
import { syncDownloadPolicies } from "@/lib/download-policy";
import { notifyUsersRequestsAvailable, notifyUserAwaitingRelease, notifyUserDownloadPending } from "@/lib/discord-notify";
import { notifyUsersRequestsAvailablePush } from "@/lib/push";
import { logAudit } from "@/lib/audit";
import { isCronAuthorized, BATCH_TX_TIMEOUT, batchCreateMany, withCronRunRecording } from "@/lib/cron-auth";
import { isFeatureEnabled } from "@/lib/features";
import { withAdvisoryLock } from "@/lib/advisory-lock";
import { claimAvailableNotificationWinners, clearDeletionVotesForTmdbs } from "@/lib/notify-available";
import { notifyUsersRequestsAvailableEmail, writeAvailableInAppNotifications } from "@/lib/request-notifications";
import { getSyncableArrInstances } from "@/lib/arr-instance-registry";
import { DEFAULT_ARR_INSTANCE } from "@/lib/arr-instances";
import { settleLimit } from "@/lib/concurrency";
import { effectivePermissions, parseMediaServerGrants } from "@/lib/permissions";
import { visibleInstancesFor, type VisibleServerInstances } from "@/lib/media-visibility";

// Advisory-lock id 2000 — distinct from 2001-2011 (cron warm/sync routes) and TRASH_SYNC_LOCK_ID (2010).
// Held for the entire orchestrator run so a second concurrent invocation (admin "Resync" while
// the cron POST is mid-flight) returns immediately with skipped=true rather than racing the
// shared-state writes (notifiedAvailable CAS, library tables, MediaRequest status updates).
const SYNC_ORCHESTRATOR_LOCK_ID = 2000;

const CONCURRENCY_LIMIT = 5;

// Re-push backoff for APPROVED requests the *arr never accepted (e.g. unreleased title with
// no Radarr/TheTVDB metadata yet). Without this the orchestrator would retry every sync tick
// (hourly) forever. Upstream metadata for an upcoming title appears some unpredictable day in
// the weeks before air, so a daily attempt catches it within ~24h of it landing while cutting
// the wasted lookups ~24×.
const ARR_REPUSH_BACKOFF_MS = 24 * 60 * 60 * 1000;

// The tail purge below reaps every expired TmdbCache row, but the two ratings namespaces
// are a deliberate serve-stale surface: an expired row is still a hit. Give them a long
// grace so a provider outage falls back to the previous values instead of no badges at
// all. `:tmdb:` is load-bearing — bare `mdblist:`/`omdb:` also match the list caches
// (and the legacy `omdb:<imdbId>` rows, whose writer was removed — they should simply
// expire out).
const STALE_RATINGS_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
const STALE_RATINGS_KEY_PREFIXES = [
  { key: { startsWith: "mdblist:tmdb:" } },
  { key: { startsWith: "omdb:tmdb:" } },
];

// The `:details` blobs are a serve-stale surface too: the admin dashboard reads
// them via getCacheStaleMany and the library prewarm's carry-forward reads the
// previous row at rewrite time — an immediate purge collapses both to cold
// misses within one SYNC_INTERVAL of expiry. A shorter grace than the ratings
// namespaces keeps table growth modest. The endsWith pin keeps every sibling
// namespace (credits, suggestions, seasons, the `:details:missing` prewarm
// tombstones) expiring immediately.
const STALE_DETAILS_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_DETAILS_KEY_SHAPES = [
  { key: { startsWith: "movie:", endsWith: ":details" } },
  { key: { startsWith: "tv:", endsWith: ":details" } },
];

async function runConcurrent<T>(
  items: T[],
  fn: (item: T) => Promise<void>
): Promise<void> {
  for (let i = 0; i < items.length; i += CONCURRENCY_LIMIT) {
    await Promise.all(items.slice(i, i + CONCURRENCY_LIMIT).map(fn));
  }
}

// ARR cache + requests are keyed by (tmdbId, arrInstance slug) so each configured
// instance stays independent. Library marking stays instance-agnostic (keyed by
// tmdbId) — a Plex/Jellyfin hit marks every instance's request for that title AVAILABLE.
const vkey = (tmdbId: number, arrInstance: string) => `${tmdbId}:${arrInstance}`;

// Per-instance presence accumulator: tmdbId → the set of server slugs that hold it.
// The union maps below answer "is this title anywhere", which is no longer a
// sufficient answer once a restricted instance's library counts as availability
// ONLY for the users granted `view` on it — a per-requester decision has to know
// WHICH server holds the title. Populated from the same per-instance fetch
// results as the union, so it can never disagree with it and costs no extra query.
const addPresence = (m: Map<number, Set<string>>, tmdbId: number, slug: string): void => {
  const existing = m.get(tmdbId);
  if (existing) existing.add(slug);
  else m.set(tmdbId, new Set([slug]));
};

export async function POST(request: NextRequest) {
  if (!(await isCronAuthorized(request))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return withCronRunRecording("sync:full", () => withAdvisoryLock(
    SYNC_ORCHESTRATOR_LOCK_ID,
    (signal: AbortSignal) => runSyncOrchestrator(request, signal),
    () => NextResponse.json({ skipped: true, reason: "sync already running" }, { status: 200 }),
  ));
}

// Strips angle brackets and null bytes, caps length. Shared between the
// orchestrator and the per-source /api/sync/{plex,jellyfin} routes so the
// PlexLibraryItem / JellyfinLibraryItem content is identical regardless of
// which path most recently wrote the row.
const sanitizeStr = (s: string | null | undefined, maxLen = 1000): string | null => {
  if (s == null) return null;
  return s.replace(/[<>]/g, "").replace(/\0/g, "").slice(0, maxLen) || null;
};

// Plex can conflate two TMDB IDs onto the same ratingKey when metadata bundles merge.
// Prefer the previously stored mapping so ownership doesn't flip-flop on every sync.
// Mirrors deduplicateByRatingKey in /api/sync/plex so the two writers agree on the row set.
// Scoped per instance: ratingKeys are small server-local integers, so the SAME key on two
// independently-administered servers is routine and legitimate — NOT conflation. Callers run
// this per instance batch, and the prior-mapping lookup consults only THAT instance's stored
// rows (an unscoped read could import another server's ratingKey→tmdbId mapping and wrongly
// drop this server's row).
type PlexDedupeRow = { tmdbId: number; plexRatingKey: string | null };
async function deduplicatePlexRowsByRatingKey<T extends PlexDedupeRow>(
  rows: T[],
  mediaType: "MOVIE" | "TV",
  serverInstance: MediaInstanceKey,
): Promise<T[]> {
  const ratingKeyCount = new Map<string, number>();
  for (const r of rows) {
    if (r.plexRatingKey) ratingKeyCount.set(r.plexRatingKey, (ratingKeyCount.get(r.plexRatingKey) ?? 0) + 1);
  }
  const conflatedKeys = new Set([...ratingKeyCount.entries()].filter(([, n]) => n > 1).map(([k]) => k));
  if (conflatedKeys.size === 0) return rows;

  const conflatedTmdbIds = rows.filter((r) => r.plexRatingKey && conflatedKeys.has(r.plexRatingKey)).map((r) => r.tmdbId);
  const existing = await prisma.plexLibraryItem.findMany({
    where: { mediaType, serverInstance, tmdbId: { in: conflatedTmdbIds } },
    select: { tmdbId: true, plexRatingKey: true },
  });
  const fixedIdByRatingKey = new Map<string, number>();
  for (const e of existing) {
    if (e.plexRatingKey) fixedIdByRatingKey.set(e.plexRatingKey, e.tmdbId);
  }

  const seenRatingKeys = new Set<string>();
  // Collected, not logged per row. The same handful of conflations recurs on
  // EVERY sync — they describe a stable property of the library, not an event
  // — so a line per dropped item made the library sync the loudest thing in
  // the log while saying nothing new each time. One summary per run keeps the
  // signal (how many, which keys, which instance) without the repetition.
  const dropped: string[] = [];
  const kept = rows.filter((r) => {
    if (!r.plexRatingKey || !conflatedKeys.has(r.plexRatingKey)) return true;
    const fixed = fixedIdByRatingKey.get(r.plexRatingKey);
    if (fixed !== undefined) {
      if (r.tmdbId !== fixed) {
        dropped.push(`${r.plexRatingKey}→${fixed} (dropped ${r.tmdbId})`);
        return false;
      }
    } else if (seenRatingKeys.has(r.plexRatingKey)) {
      return false;
    }
    seenRatingKeys.add(r.plexRatingKey);
    return true;
  });

  if (dropped.length > 0) {
    console.warn(
      `[sync] ${dropped.length} conflated ratingKey(s) kept their pinned tmdbId ` +
        `(${mediaType}, instance="${serverInstance}"): ${dropped.join(", ")}`,
    );
  }
  return kept;
}

async function runSyncOrchestrator(request: NextRequest, signal?: AbortSignal): Promise<NextResponse> {
  // signal fires when withAdvisoryLock's hard timeout trips (before the lock is
  // released). Wired through so callers (e.g. arrFetch) can opt in later, but
  // currently unobserved — Prisma 7's $transaction(fn, opts) takes no AbortSignal.
  void signal;
  const startTime = Date.now();

  const [approved, available] = await Promise.all([
    prisma.mediaRequest.findMany({
      where: { status: "APPROVED" },
      select: { id: true, tmdbId: true, mediaType: true, arrInstance: true, requestedBy: true, title: true, posterPath: true, pendingNotifyAt: true, notifiedAvailable: true },
    }),
    prisma.mediaRequest.findMany({
      where: { status: "AVAILABLE" },
      select: { id: true, tmdbId: true, mediaType: true, arrInstance: true, requestedBy: true, title: true, posterPath: true, notifiedAvailable: true },
    }),
  ]);

  let marked = 0;
  let reverted = 0;
  let repushed = 0;
  const arrNotify: Array<{ id: string; requestedBy: string; title: string; mediaType: string; tmdbId: number; posterPath: string | null }> = [];

  const approvedMovieTmdbIds = approved.filter((r) => r.mediaType === "MOVIE").map((r) => r.tmdbId);
  const approvedTvTmdbIds    = approved.filter((r) => r.mediaType === "TV").map((r) => r.tmdbId);
  let availableMovieSet = new Set<string>();
  let availableTvSet    = new Set<string>();
  if (approvedMovieTmdbIds.length > 0 || approvedTvTmdbIds.length > 0) {
    const [availableMovieRows, availableTvRows] = await Promise.all([
      approvedMovieTmdbIds.length > 0
        ? prisma.radarrAvailableItem.findMany({ where: { tmdbId: { in: approvedMovieTmdbIds } } })
        : Promise.resolve([]),
      approvedTvTmdbIds.length > 0
        ? prisma.sonarrAvailableItem.findMany({ where: { tmdbId: { in: approvedTvTmdbIds } } })
        : Promise.resolve([]),
    ]);
    availableMovieSet = new Set(availableMovieRows.map((r) => vkey(r.tmdbId, r.arrInstance)));
    availableTvSet    = new Set(availableTvRows.map((r) => vkey(r.tmdbId, r.arrInstance)));
  }

  // Collapse the per-request update loop into two updateMany calls — one CAS for the
  // unnotified candidates (which produces the arrNotify list), one bulk catch-up for the
  // already-notified rows. Snapshot pre-state so we can attribute the CAS winners.
  const nowAvailableApproved = approved.filter((r) =>
    r.mediaType === "MOVIE" ? availableMovieSet.has(vkey(r.tmdbId, r.arrInstance)) : availableTvSet.has(vkey(r.tmdbId, r.arrInstance)),
  );
  if (nowAvailableApproved.length > 0) {
    // ARR-available means "downloaded in Radarr/Sonarr", which is not the same as
    // "scanned into the user's preferred Plex/Jellyfin library yet". Act ONLY on users
    // with no mediaServer preference here. A preference-pinned user is left APPROVED so
    // the library-marking pass below flips + notifies them once the item actually appears
    // in their chosen server — avoiding a premature "now available" off an unreached lib.
    const arrUserRows = await prisma.user.findMany({
      where: { id: { in: [...new Set(nowAvailableApproved.map((r) => r.requestedBy))] } },
      select: { id: true, mediaServer: true },
    });
    const arrUserMediaServer = new Map(arrUserRows.map((u) => [u.id, u.mediaServer]));
    const arrUnpinned = nowAvailableApproved.filter((r) => !(arrUserMediaServer.get(r.requestedBy) ?? null));

    // Atomic claim (UPDATE ... RETURNING) closes the snapshot→CAS TOCTOU: only the
    // rows this statement actually flipped (notifiedAvailable false→true) come
    // back, so a row a concurrent sync/webhook claimed between a read and the
    // update is never double-notified. Mirrors the per-source plex/jellyfin paths.
    const winners = arrUnpinned.length > 0
      ? await claimAvailableNotificationWinners(arrUnpinned, { markAvailable: true })
      : [];
    const winnerIds = new Set(winners.map((w) => w.id));
    for (const req of winners) {
      arrNotify.push({ id: req.id, requestedBy: req.requestedBy, title: req.title, mediaType: req.mediaType, tmdbId: req.tmdbId, posterPath: req.posterPath });
    }
    // An ARR-driven re-add is an AVAILABLE transition: wipe stale deletion votes and the
    // per-item notify gate so a fresh round can re-arm (mirrors the library-marking path).
    if (winners.length > 0) {
      void clearDeletionVotesForTmdbs(winners.map((w) => ({ tmdbId: w.tmdbId, mediaType: w.mediaType as "MOVIE" | "TV" })));
    }
    if (winnerIds.size > 0) {
      // The helper sets status/availableAt/notifiedAvailable but not pendingNotifyAt.
      await prisma.mediaRequest.updateMany({
        where: { id: { in: [...winnerIds] } },
        data: { pendingNotifyAt: null },
      });
    }
    // Rows we didn't win (unpinned, but already notifiedAvailable elsewhere); still flip
    // them AVAILABLE without re-notifying — but only when not already AVAILABLE, so a
    // stable row's availableAt isn't rewritten on every tick.
    const catchupIds = arrUnpinned.filter((r) => !winnerIds.has(r.id)).map((r) => r.id);
    if (catchupIds.length > 0) {
      await prisma.mediaRequest.updateMany({
        // Guard on the SOURCE states, not `not: AVAILABLE`. `approved` is a snapshot
        // taken at the top of the run, so an admin who DECLINES one of these rows
        // mid-run would otherwise be matched by `not: AVAILABLE` and have their
        // decline silently reverted to AVAILABLE. Matches the PENDING/APPROVED guard
        // every sibling flip in this file uses.
        where: { id: { in: catchupIds }, notifiedAvailable: true, status: { in: ["PENDING", "APPROVED"] } },
        data: { status: "AVAILABLE", availableAt: new Date(), pendingNotifyAt: null },
      });
    }
    marked = arrUnpinned.length;
  }

  const now = new Date();
  const overdue = approved.filter((r) => r.pendingNotifyAt && r.pendingNotifyAt <= now && !arrNotify.find((n) => n.id === r.id));

  // Guardrail 33: account removal DISABLES rather than scrubs, so a removed user keeps
  // a live Discord link and would still be DMed. Suppression is documented as living at
  // exactly two chokepoints — claimAvailableNotificationWinners (batch "now available")
  // and notifyRequestStatusChange (single approve/decline/available) — and this
  // "awaiting release" / "download pending" backstop is a THIRD requester-facing path
  // that goes through neither. One batched read, not a per-request lookup.
  const disabledRequesters = new Set<string>();
  if (overdue.length > 0) {
    const rows = await prisma.user.findMany({
      where: { id: { in: [...new Set(overdue.map((r) => r.requestedBy))] }, deactivatedAt: { not: null } },
      select: { id: true },
    });
    for (const r of rows) disabledRequesters.add(r.id);
  }

  await runConcurrent(overdue, async (req) => {
    try {
      const downloading = req.mediaType === "MOVIE"
        ? await isMovieDownloadingInRadarr(req.tmdbId, req.arrInstance)
        : await isSeriesDownloadingInSonarr(req.tmdbId, req.arrInstance);
      // null = couldn't read the queue. Don't clear pendingNotifyAt — leave it so a
      // later tick re-checks once the queue API recovers. Only a confirmed `true`
      // clears the backstop.
      if (downloading !== false) {
        if (downloading === true) {
          await prisma.mediaRequest.update({ where: { id: req.id }, data: { pendingNotifyAt: null } });
        }
        return;
      }
      let released = true;
      let soonestReleaseDate: string | null = null;
      if (req.mediaType === "MOVIE") {
        const info = await getMovieReleaseInfo(req.tmdbId);
        if (info) {
          const futureDates = [info.digitalRelease, info.physicalRelease].filter((d): d is string => !!d && new Date(d) > now);
          const pastDates   = [info.digitalRelease, info.physicalRelease].filter((d): d is string => !!d && new Date(d) <= now);
          if (pastDates.length === 0 && futureDates.length > 0) {
            released = false;
            soonestReleaseDate = futureDates.sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0];
          }
        }
      } else {
        const firstAired = await getSeriesFirstAired(req.tmdbId, req.arrInstance);
        if (firstAired && new Date(firstAired) > now) {
          released = false;
          soonestReleaseDate = firstAired;
        }
      }
      await prisma.mediaRequest.update({ where: { id: req.id }, data: { pendingNotifyAt: null } });
      // The backstop is CONSUMED for a disabled requester, not deferred: pendingNotifyAt
      // is cleared above and the DM is dropped. That mirrors notify-available's
      // deliberate claim-burn — re-enabling an account must not replay a backlog of
      // stale "your download is pending" messages about requests long since resolved.
      if (disabledRequesters.has(req.requestedBy)) return;
      if (!released) {
        await notifyUserAwaitingRelease(req.requestedBy, req.title, req.mediaType, soonestReleaseDate);
      } else {
        await notifyUserDownloadPending(req.requestedBy, req.title, req.mediaType);
      }
    } catch (err) {
      console.error("[sync] pendingNotifyAt check failed for", req.id, err);
    }
  });

  notifyUsersRequestsAvailable(arrNotify).catch((err) => console.warn("[sync] Discord available notify failed:", err instanceof Error ? err.message : err));
  notifyUsersRequestsAvailablePush(arrNotify).catch((err) => console.warn("[sync] push available notify failed:", err instanceof Error ? err.message : err));
  void notifyUsersRequestsAvailableEmail(arrNotify, "sync");
  void writeAvailableInAppNotifications(arrNotify, "sync");

  const [plexEnabled, jellyfinEnabled, radarrEnabled, sonarrEnabled] = await Promise.all([
    isFeatureEnabled("feature.integration.plex"),
    isFeatureEnabled("feature.integration.jellyfin"),
    isFeatureEnabled("feature.integration.radarr"),
    isFeatureEnabled("feature.integration.sonarr"),
  ]);

  // Refresh Radarr/Sonarr caches BEFORE the AVAILABLE→APPROVED revert below. The revert reads
  // radarr/sonarr {Available,Wanted}Item — if those tables are stale from a prior failed run,
  // a fresh tick that also fails would mass-demote everything. We only consult the cache for
  // the revert decision when the current run successfully refreshed it.
  let radarrWanted = 0;
  let radarrSyncSucceeded = false;
  let radarrSyncedSlugs = new Set<string>();
  if (radarrEnabled) {
    try {
      // Fan out over every configured Radarr instance (default first, plus the legacy
      // 4K and any named instances). getRadarrWantedTmdbIds returns empty sets when an
      // instance is unconfigured and null on a real fetch failure. Bound the fan-out (G31).
      const instances = await getSyncableArrInstances("radarr");
      const settled = await settleLimit(instances, CONCURRENCY_LIMIT, async (inst) => ({
        slug: inst.slug,
        result: await getRadarrWantedTmdbIds(inst.slug),
      }));
      const fetched = settled.map((s, i) =>
        s.status === "fulfilled" ? s.value : { slug: instances[i].slug, result: null },
      );
      // The default instance ("") is authoritative: if its fetch failed, skip the whole
      // cache update (matches the legacy "HD fetch failed ⇒ skip everything" gate) so a
      // transient default outage can't mass-demote AVAILABLE requests below.
      const defaultFailed = fetched.some((f) => f.slug === DEFAULT_ARR_INSTANCE && f.result === null);
      if (defaultFailed) {
        console.warn("[sync] skipping Radarr cache update — ARR fetch failed");
      } else {
        // Only instances whose fetch succeeded get their rows scoped-cleared + rewritten;
        // a null result leaves THAT instance's existing rows intact (G13) so one instance's
        // fetch failure never empties another's cache.
        const writable = fetched.flatMap((f) => (f.result ? [{ slug: f.slug, result: f.result }] : []));
        // Advisory lock 1001,1 coordinates with the Radarr webhook handler. Each instance's
        // rows are cleared + rewritten independently (scoped by arrInstance).
        await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(1001, 1)`;
          for (const { slug, result } of writable) {
            const wantedRows    = Array.from(result.wanted).map((tmdbId) => ({ tmdbId, arrInstance: slug }));
            const availableRows = Array.from(result.available).map((tmdbId) => ({ tmdbId, arrInstance: slug }));
            await tx.radarrWantedItem.deleteMany({ where: { arrInstance: slug } });
            if (wantedRows.length > 0) await batchCreateMany(tx.radarrWantedItem, wantedRows);
            await tx.radarrAvailableItem.deleteMany({ where: { arrInstance: slug } });
            if (availableRows.length > 0) await batchCreateMany(tx.radarrAvailableItem, availableRows);
          }
        }, { timeout: BATCH_TX_TIMEOUT });
        radarrWanted = writable.reduce((sum, { result }) => sum + result.wanted.size, 0);
        radarrSyncSucceeded = true;
        // The slugs whose cache THIS run actually refreshed. Crucially, an
        // enabled-but-UNCONFIGURED integration yields writable=[] here while
        // radarrSyncSucceeded is still true (the no-op "sync" didn't fail) —
        // the flag keeps meaning "step didn't blow up" for run reporting, and
        // this set is what the revert/re-push passes below key on so an empty
        // cache from an unconfigured instance is never read as authoritative
        // absence (the mass AVAILABLE→APPROVED demotion case).
        radarrSyncedSlugs = new Set(writable.map((w) => w.slug));
      }
    } catch (err) {
      console.error("[sync] Radarr wanted sync failed:", err);
    }
  }

  let sonarrWanted = 0;
  let sonarrSyncSucceeded = false;
  let sonarrSyncedSlugs = new Set<string>();
  if (sonarrEnabled) {
    try {
      // Fan out over every configured Sonarr instance; same contract as the Radarr block.
      const instances = await getSyncableArrInstances("sonarr");
      const settled = await settleLimit(instances, CONCURRENCY_LIMIT, async (inst) => ({
        slug: inst.slug,
        result: await getSonarrWantedTmdbIds(inst.slug),
      }));
      const fetched = settled.map((s, i) =>
        s.status === "fulfilled" ? s.value : { slug: instances[i].slug, result: null },
      );
      const defaultFailed = fetched.some((f) => f.slug === DEFAULT_ARR_INSTANCE && f.result === null);
      if (defaultFailed) {
        console.warn("[sync] skipping Sonarr cache update — ARR fetch failed");
      } else {
        const writable = fetched.flatMap((f) => (f.result ? [{ slug: f.slug, result: f.result }] : []));
        // Advisory lock 1001,2 coordinates with the Sonarr webhook handler; per-instance
        // scoped clears so one instance's fetch failure never empties another's cache.
        await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(1001, 2)`;
          for (const { slug, result } of writable) {
            const wantedRows    = Array.from(result.wanted).map((tmdbId) => ({ tmdbId, arrInstance: slug }));
            const availableRows = Array.from(result.available).map((tmdbId) => ({ tmdbId, arrInstance: slug }));
            await tx.sonarrWantedItem.deleteMany({ where: { arrInstance: slug } });
            if (wantedRows.length > 0) await batchCreateMany(tx.sonarrWantedItem, wantedRows);
            await tx.sonarrAvailableItem.deleteMany({ where: { arrInstance: slug } });
            if (availableRows.length > 0) await batchCreateMany(tx.sonarrAvailableItem, availableRows);
          }
        }, { timeout: BATCH_TX_TIMEOUT });
        sonarrWanted = writable.reduce((sum, { result }) => sum + result.wanted.size, 0);
        sonarrSyncSucceeded = true;
        // Same contract as radarrSyncedSlugs — see the comment there.
        sonarrSyncedSlugs = new Set(writable.map((w) => w.slug));
      }
    } catch (err) {
      console.error("[sync] Sonarr wanted sync failed:", err);
    }
  }

  // Second AVAILABLE-marking pass over the FRESHLY refreshed Radarr/Sonarr caches. The first
  // pass (above) read the cache as it stood at run start; a request that became available in
  // Radarr/Sonarr since the prior tick would otherwise wait a full SYNC_INTERVAL to be marked.
  // Only the rows still APPROVED after the first pass are reconsidered, and only against a
  // cache the current run successfully rewrote.
  const stillApprovedForMark = approved.filter((r) => !arrNotify.find((n) => n.id === r.id));
  const secondMovieTmdbIds = stillApprovedForMark.filter((r) => r.mediaType === "MOVIE" && radarrEnabled && radarrSyncSucceeded).map((r) => r.tmdbId);
  const secondTvTmdbIds    = stillApprovedForMark.filter((r) => r.mediaType === "TV"    && sonarrEnabled && sonarrSyncSucceeded).map((r) => r.tmdbId);
  if (secondMovieTmdbIds.length > 0 || secondTvTmdbIds.length > 0) {
    const [freshMovieRows, freshTvRows] = await Promise.all([
      secondMovieTmdbIds.length > 0
        ? prisma.radarrAvailableItem.findMany({ where: { tmdbId: { in: secondMovieTmdbIds } } })
        : Promise.resolve([]),
      secondTvTmdbIds.length > 0
        ? prisma.sonarrAvailableItem.findMany({ where: { tmdbId: { in: secondTvTmdbIds } } })
        : Promise.resolve([]),
    ]);
    const freshMovieSet = new Set(freshMovieRows.map((r) => vkey(r.tmdbId, r.arrInstance)));
    const freshTvSet    = new Set(freshTvRows.map((r) => vkey(r.tmdbId, r.arrInstance)));
    const nowAvailableSecond = stillApprovedForMark.filter((r) =>
      r.mediaType === "MOVIE"
        ? radarrEnabled && radarrSyncSucceeded && freshMovieSet.has(vkey(r.tmdbId, r.arrInstance))
        : sonarrEnabled && sonarrSyncSucceeded && freshTvSet.has(vkey(r.tmdbId, r.arrInstance)),
    );
    if (nowAvailableSecond.length > 0) {
      // Same mediaServer gating as the first ARR pass: act only on unpinned users here.
      // Preference-pinned users stay APPROVED so the library-marking pass notifies them
      // once the item appears in their chosen server.
      const secondUserRows = await prisma.user.findMany({
        where: { id: { in: [...new Set(nowAvailableSecond.map((r) => r.requestedBy))] } },
        select: { id: true, mediaServer: true },
      });
      const secondMediaServer = new Map(secondUserRows.map((u) => [u.id, u.mediaServer]));
      const secondUnpinned = nowAvailableSecond.filter((r) => !(secondMediaServer.get(r.requestedBy) ?? null));

      const winners = secondUnpinned.length > 0
        ? await claimAvailableNotificationWinners(secondUnpinned, { markAvailable: true })
        : [];
      if (winners.length > 0) {
        await prisma.mediaRequest.updateMany({
          where: { id: { in: winners.map((w) => w.id) } },
          data: { pendingNotifyAt: null },
        });
        void clearDeletionVotesForTmdbs(winners.map((w) => ({ tmdbId: w.tmdbId, mediaType: w.mediaType as "MOVIE" | "TV" })));
        const secondNotify = winners.map((w) => ({ id: w.id, requestedBy: w.requestedBy, title: w.title, mediaType: w.mediaType, tmdbId: w.tmdbId, posterPath: w.posterPath }));
        notifyUsersRequestsAvailable(secondNotify).catch((err) => console.warn("[sync] Discord available notify failed:", err instanceof Error ? err.message : err));
        notifyUsersRequestsAvailablePush(secondNotify).catch((err) => console.warn("[sync] push available notify failed:", err instanceof Error ? err.message : err));
        void notifyUsersRequestsAvailableEmail(secondNotify, "sync");
        void writeAvailableInAppNotifications(secondNotify, "sync");
        marked += winners.length;
      }
    }
  }

  // Re-push APPROVED requests that never made it into Radarr/Sonarr. The approve-time push
  // can fail when the title has no Radarr/TheTVDB metadata yet (common for not-yet-released
  // titles, e.g. a show that airs in a few weeks); the request is then stranded in APPROVED
  // with nothing retrying it. We act only when the integration is enabled AND this run
  // refreshed its cache — same guard as the revert block below, so a stale or failed cache
  // can't trigger a mass re-push. A title absent from BOTH the freshly-synced wanted and
  // available sets is genuinely unknown to the *arr, so the earlier add never landed.
  // ARR_REPUSH_BACKOFF_MS gates retries to ~daily (lastArrPushAt is stamped on every
  // attempt, success or fail) so a permanently-unresolvable request doesn't churn hourly.
  const repushCutoff = new Date(Date.now() - ARR_REPUSH_BACKOFF_MS);
  const stillApproved = await prisma.mediaRequest.findMany({
    where: {
      id: { in: approved.map((r) => r.id) },
      status: "APPROVED",
      OR: [{ lastArrPushAt: null }, { lastArrPushAt: { lte: repushCutoff } }],
    },
    select: { id: true, tmdbId: true, mediaType: true, arrInstance: true, qualityProfileId: true, requestedBy: true, createdAt: true },
  });
  const repushMovieIds = stillApproved.filter((r) => r.mediaType === "MOVIE" && radarrEnabled && radarrSyncedSlugs.has(r.arrInstance)).map((r) => r.tmdbId);
  const repushTvIds    = stillApproved.filter((r) => r.mediaType === "TV"    && sonarrEnabled && sonarrSyncedSlugs.has(r.arrInstance)).map((r) => r.tmdbId);
  let knownRadarrSet = new Set<string>();
  let knownSonarrSet = new Set<string>();
  if (repushMovieIds.length > 0 || repushTvIds.length > 0) {
    const [rAvail, rWant, sAvail, sWant] = await Promise.all([
      repushMovieIds.length > 0
        ? prisma.radarrAvailableItem.findMany({ where: { tmdbId: { in: repushMovieIds } } })
        : Promise.resolve([]),
      repushMovieIds.length > 0
        ? prisma.radarrWantedItem.findMany({ where: { tmdbId: { in: repushMovieIds } } })
        : Promise.resolve([]),
      repushTvIds.length > 0
        ? prisma.sonarrAvailableItem.findMany({ where: { tmdbId: { in: repushTvIds } } })
        : Promise.resolve([]),
      repushTvIds.length > 0
        ? prisma.sonarrWantedItem.findMany({ where: { tmdbId: { in: repushTvIds } } })
        : Promise.resolve([]),
    ]);
    knownRadarrSet = new Set([...rAvail.map((r) => vkey(r.tmdbId, r.arrInstance)), ...rWant.map((r) => vkey(r.tmdbId, r.arrInstance))]);
    knownSonarrSet = new Set([...sAvail.map((r) => vkey(r.tmdbId, r.arrInstance)), ...sWant.map((r) => vkey(r.tmdbId, r.arrInstance))]);
  }
  // Per-slug gate (not the global flag): only re-push a request whose OWN instance's
  // cache was refreshed this run. An unconfigured instance (writable=[] with the flag
  // still true) would otherwise put every APPROVED title on that instance into a daily
  // guaranteed-to-fail push attempt; an instance whose fetch failed this run keeps its
  // stale rows, and pushing against state we couldn't read risks re-adding an item
  // that's actually there — both wait for a run that actually synced their instance.
  const toRepush = stillApproved.filter((r) =>
    r.mediaType === "MOVIE"
      ? radarrEnabled && radarrSyncedSlugs.has(r.arrInstance) && !knownRadarrSet.has(vkey(r.tmdbId, r.arrInstance))
      : sonarrEnabled && sonarrSyncedSlugs.has(r.arrInstance) && !knownSonarrSet.has(vkey(r.tmdbId, r.arrInstance)),
  );
  // Two users can each hold an APPROVED request for the same (tmdbId, mediaType, variant)
  // — an original plus a later mirror-approved row — with different qualityProfileId. If
  // the original *arr add never landed, both would enter this batch and race in the same
  // runConcurrent chunk; whichever POST wins sets the profile nondeterministically (the
  // *arr holds one item per tmdbId). Collapse to a single add per title/variant, preferring
  // the ORIGINAL (earliest createdAt, id tie-break) so the chosen profile is stable. The
  // deduped-out siblings still get lastArrPushAt stamped below so the backoff applies and
  // they don't re-enter this query every tick.
  const repushKeyOf = (r: { tmdbId: number; mediaType: string; arrInstance: string }) => `${r.mediaType}:${vkey(r.tmdbId, r.arrInstance)}`;
  const repushWinnerByKey = new Map<string, (typeof toRepush)[number]>();
  const repushSiblingIds: string[] = [];
  for (const r of toRepush) {
    const k = repushKeyOf(r);
    const existing = repushWinnerByKey.get(k);
    if (!existing) {
      repushWinnerByKey.set(k, r);
    } else if (
      r.createdAt < existing.createdAt ||
      (r.createdAt.getTime() === existing.createdAt.getTime() && r.id < existing.id)
    ) {
      repushSiblingIds.push(existing.id);
      repushWinnerByKey.set(k, r);
    } else {
      repushSiblingIds.push(r.id);
    }
  }
  const dedupedRepush = [...repushWinnerByKey.values()];
  const pushedAt = new Date();
  await runConcurrent(dedupedRepush, async (req) => {
    try {
      // Push to the request's own instance (fixes the latent HD-pin — a 4K/named
      // request re-pushed to the default instance would land at the wrong quality).
      if (req.mediaType === "MOVIE") {
        await addMovieToRadarr(req.tmdbId, req.arrInstance, req.qualityProfileId ?? undefined, req.requestedBy);
        await prisma.mediaRequest.update({ where: { id: req.id }, data: { lastArrPushAt: pushedAt } });
      } else {
        const tvdbId = await addSeriesToSonarr(req.tmdbId, req.arrInstance, req.qualityProfileId ?? undefined, req.requestedBy);
        await prisma.mediaRequest.update({ where: { id: req.id }, data: { tvdbId, lastArrPushAt: pushedAt } });
      }
      repushed++;
    } catch (err) {
      // Stamp the attempt so the backoff applies even though it failed.
      await prisma.mediaRequest.update({ where: { id: req.id }, data: { lastArrPushAt: pushedAt } }).catch(() => {});
      // Still unresolvable upstream (e.g. unreleased title with no Radarr/TVDB entry yet).
      // Leave the request APPROVED; a later tick retries once the metadata exists.
      console.error("[sync] re-push to *arr failed for", req.id, err);
    }
  });
  // Stamp the deduped-out siblings: the winner's add (above) covers their title/variant,
  // so they get the same backoff clock and don't re-enter the re-push query every tick.
  if (repushSiblingIds.length > 0) {
    await prisma.mediaRequest
      .updateMany({ where: { id: { in: repushSiblingIds } }, data: { lastArrPushAt: pushedAt } })
      .catch((err) => console.error("[sync] re-push sibling backoff stamp failed:", err));
  }

  const availableMovieTmdbIds = available.filter((r) => r.mediaType === "MOVIE").map((r) => r.tmdbId);
  const availableTvTmdbIds    = available.filter((r) => r.mediaType === "TV").map((r) => r.tmdbId);
  let inRadarrSet = new Set<string>();
  let inSonarrSet = new Set<string>();
  if (availableMovieTmdbIds.length > 0 || availableTvTmdbIds.length > 0) {
    const [inRadarrAvail, inRadarrWanted, inSonarrAvail, inSonarrWanted] = await Promise.all([
      availableMovieTmdbIds.length > 0
        ? prisma.radarrAvailableItem.findMany({ where: { tmdbId: { in: availableMovieTmdbIds } } })
        : Promise.resolve([]),
      availableMovieTmdbIds.length > 0
        ? prisma.radarrWantedItem.findMany({ where: { tmdbId: { in: availableMovieTmdbIds } } })
        : Promise.resolve([]),
      availableTvTmdbIds.length > 0
        ? prisma.sonarrAvailableItem.findMany({ where: { tmdbId: { in: availableTvTmdbIds } } })
        : Promise.resolve([]),
      availableTvTmdbIds.length > 0
        ? prisma.sonarrWantedItem.findMany({ where: { tmdbId: { in: availableTvTmdbIds } } })
        : Promise.resolve([]),
    ]);
    inRadarrSet = new Set([...inRadarrAvail.map((r) => vkey(r.tmdbId, r.arrInstance)), ...inRadarrWanted.map((r) => vkey(r.tmdbId, r.arrInstance))]);
    inSonarrSet = new Set([...inSonarrAvail.map((r) => vkey(r.tmdbId, r.arrInstance)), ...inSonarrWanted.map((r) => vkey(r.tmdbId, r.arrInstance))]);
  }

  let plexMarked = 0;
  let jellyfinMarked = 0;

  const [plexInstances, jellyfinInstances] = await Promise.all([
    // Every configured, connection-ready Plex/Jellyfin server (multi-server support) —
    // each instance's own url/token is resolved via getPlexConfig(instance.slug) /
    // getJellyfinConfig(instance.slug) inside its arm below.
    getSyncableMediaInstances("plex"),
    getSyncableMediaInstances("jellyfin"),
  ]);

  // The library selection is PER SERVER, and must be: a Plex section key is a
  // small integer scoped to one server, so server A's "1,2" names different
  // libraries on server B. Applying one selection to every instance silently
  // ingested the wrong sections from B and excluded the right ones — and since
  // each instance's write is a scoped full replace, B's rows were then replaced
  // with nothing and everything on B read as unavailable. Jellyfin ids are GUIDs
  // so they collide less, but a single selection still cannot express "these
  // libraries on A, those on B" and filtered B down to nothing just the same.
  //
  // An instance with no selection stored syncs ALL of its libraries, which is
  // both the correct default and what every named instance gets until an admin
  // chooses otherwise. The default instance's key is byte-identical to the
  // legacy `plexLibraries`/`jellyfinLibraries`, so existing installs keep their
  // exact selection with no migration.
  const librarySelections = new Map<string, Set<string> | undefined>();
  const selectionKeys = [
    ...plexInstances.map((i) => plexSettingKey(i.slug, "Libraries")),
    ...jellyfinInstances.map((i) => jellyfinSettingKey(i.slug, "Libraries")),
  ];
  const selectionRows = selectionKeys.length
    ? await prisma.setting.findMany({ where: { key: { in: selectionKeys } }, select: { key: true, value: true } })
    : [];
  for (const row of selectionRows) {
    const parsed = row.value
      ? new Set(row.value.split(",").map((k) => k.trim()).filter(Boolean))
      : undefined;
    librarySelections.set(row.key, parsed?.size ? parsed : undefined);
  }

  // Never reassigned — each configured instance's results are merged in via .set()
  // rather than replacing the map wholesale (union across servers of a type).
  const plexMovieIds = new Map<number, PlexLibraryItemData>();
  const plexTvIds    = new Map<number, PlexLibraryItemData>();
  const jfMovieIds = new Map<number, JellyfinLibraryItemData>();
  const jfTvIds    = new Map<number, JellyfinLibraryItemData>();
  // Per-instance presence, kept ALONGSIDE the union maps above (never replacing
  // them — ~300 lines of downstream availability logic ask the union "is this
  // tmdbId present" and must keep behaving identically). These answer the
  // narrower question the per-user visibility gate needs: WHICH servers hold it.
  // Same key set as the union by construction — both are filled from the same
  // per-instance loop below.
  const plexMovieSlugs = new Map<number, Set<string>>();
  const plexTvSlugs    = new Map<number, Set<string>>();
  const jfMovieSlugs   = new Map<number, Set<string>>();
  const jfTvSlugs      = new Map<number, Set<string>>();
  let plexSyncSucceeded = false;
  let jellyfinSyncSucceeded = false;

  // Plex and Jellyfin library writes + download-policy enforcement run concurrently
  const syncResults = await Promise.allSettled([
    // Lock 2009 serializes against the standalone /api/cron/sync-download-policies run, whose
    // read-then-reconcile prune would otherwise race this one. If that cron currently holds the
    // lock, skip the redundant pass — it will reconcile on its own.
    withAdvisoryLock(
      2009,
      () => syncDownloadPolicies(),
      () => [],
    ),
    (async () => {
      if (!plexEnabled) return;
      if (plexInstances.length === 0) return;

      // Respect the admin's selected Plex libraries (mirrors /api/sync/plex). Without
      // this the scheduled full sync ingested EVERY section, marking media in an
      // excluded library as owned → availability false positives on every cron tick.
      // Resolved per instance below, from THAT server's own selection.

      // Fan out over every configured, connection-ready Plex server (multi-server
      // support). Unlike arr, there's no per-request instance to attribute a fetch
      // failure to — availability here is a union across all configured servers, not
      // per-instance routing (see media-instances.ts) — so a failed instance simply
      // contributes nothing to the write below, and plexSyncSucceeded (used only by
      // the revert/stale-fallback checks further down, which need to know this run's
      // union data is a COMPLETE picture) requires every configured instance's fetch AND
      // the write to have both succeeded.
      const fetched = await Promise.all(
        plexInstances.map(async (instance) => {
          try {
            const cfg = await getPlexConfig(instance.slug);
            if (!cfg.url || !cfg.token) return { slug: instance.slug, result: null }; // defensive; getSyncableMediaInstances already filters to configured ones
            const serverUrl = cfg.url.replace(/\/$/, "");
            const token = cfg.token;
            const sections = await getPlexLibrarySections(serverUrl, token);
            const selectedPlexKeys = librarySelections.get(plexSettingKey(instance.slug, "Libraries"));
            // ratingKeyToTmdb accumulates the show walk's ratingKey→ids mapping
            // so the episode pass below reuses this type=2 listing instead of
            // re-paging every show section (per-instance — ratingKeys are
            // server-local). The legacy maps collect pre-2020-agent items
            // (thetvdb://, imdb:// guids) for best-effort tmdb resolution.
            const ratingKeyToTmdb = new Map<string, number[]>();
            const movieLegacy = new Map<string, PlexLegacyGuidRef>();
            const tvLegacy = new Map<string, PlexLegacyGuidRef>();
            const [movieIds, tvIds] = await Promise.all([
              getPlexTmdbIds(serverUrl, token, "MOVIE", false, selectedPlexKeys, sections, undefined, movieLegacy),
              // skipShowFilePaths: the episode walk below always follows on
              // this path and captures the same file paths from the type=4
              // listing — the per-show allLeaves probe (one HTTP request per
              // show, every run) is redundant here. The paths are patched onto
              // the rows post-write.
              getPlexTmdbIds(serverUrl, token, "TV", false, selectedPlexKeys, sections, ratingKeyToTmdb, tvLegacy, true),
            ]);
            // Resolve + merge legacy-agent items (self-catching, never throws):
            // a resolution failure degrades those items to their previous
            // invisibility rather than failing the instance's fetch.
            const [resolvedMovies, resolvedTv] = await Promise.all([
              resolvePlexLegacyGuids(movieLegacy, "MOVIE"),
              resolvePlexLegacyGuids(tvLegacy, "TV"),
            ]);
            mergeResolvedLegacyItems(resolvedMovies, movieIds);
            mergeResolvedLegacyItems(resolvedTv, tvIds, ratingKeyToTmdb);
            return { slug: instance.slug, result: { serverUrl, token, sections, movieIds, tvIds, ratingKeyToTmdb } };
          } catch (err) {
            console.error(`[sync] Plex check failed for instance "${instance.slug}":`, err);
            return { slug: instance.slug, result: null };
          }
        }),
      );
      const writable = fetched.flatMap((f) => (f.result ? [{ slug: f.slug, ...f.result }] : []));

      // Union into the shared maps the ~300 lines of downstream availability logic
      // already expect — they only ever ask "is this tmdbId in the map," so a plain
      // per-key merge is correct regardless of which instance's value wins a collision.
      // The parallel `*Slugs` maps record WHICH instance contributed each key: the
      // union's collision-winner is arbitrary, so it cannot answer "does the
      // requester see a server that actually holds this title" once an instance is
      // restricted. Filled here, inside the same loop, while the per-instance
      // results are still separate.
      for (const { slug, movieIds, tvIds } of writable) {
        for (const [tmdbId, d] of movieIds) {
          plexMovieIds.set(tmdbId, d);
          addPresence(plexMovieSlugs, tmdbId, slug);
        }
        for (const [tmdbId, d] of tvIds) {
          plexTvIds.set(tmdbId, d);
          addPresence(plexTvSlugs, tmdbId, slug);
        }
      }

      let libraryWriteSucceeded = true;
      if (writable.length > 0) {
        try {
          // Rows are built + deduped per instance BEFORE the transaction (the dedupe is
          // a DB read; doing it in-tx would hold the advisory lock across it for nothing).
          // Dedupe runs per instance batch (never across instances): two servers reusing
          // the same small integer ratingKey is legitimate, not conflation.
          const rowsByInstance = await Promise.all(
            writable.map(async ({ slug, movieIds, tvIds }) => {
              const movieRows = Array.from(movieIds.entries()).map(([tmdbId, d]) => ({ tmdbId, mediaType: "MOVIE" as const, serverInstance: slug, filePath: d.filePath, plexRatingKey: d.ratingKey, title: sanitizeStr(d.title, 500) ?? "", year: d.year, overview: sanitizeStr(d.overview), contentRating: sanitizeStr(d.contentRating, 50), addedAt: d.addedAt }));
              const tvRows    = Array.from(tvIds.entries()).map(([tmdbId, d])    => ({ tmdbId, mediaType: "TV"    as const, serverInstance: slug, filePath: d.filePath, plexRatingKey: d.ratingKey, title: sanitizeStr(d.title, 500) ?? "", year: d.year, overview: sanitizeStr(d.overview), contentRating: sanitizeStr(d.contentRating, 50), addedAt: d.addedAt }));
              return {
                slug,
                finalMovieRows: await deduplicatePlexRowsByRatingKey(movieRows, "MOVIE", slug),
                finalTvRows:    await deduplicatePlexRowsByRatingKey(tvRows, "TV", slug),
              };
            }),
          );
          // Advisory lock 2001,1 — matches /api/sync/plex so the two callers can't race the
          // same write. Per-instance scoped delete (mirrors the Jellyfin arm below) so one
          // instance's rewrite never touches another's rows; only instances whose fetch
          // succeeded are touched at all (G13 — a failed instance's existing rows are left
          // intact, never wiped).
          await prisma.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(2001, 1)`;
            for (const { slug, finalMovieRows, finalTvRows } of rowsByInstance) {
              await tx.plexLibraryItem.deleteMany({ where: { serverInstance: slug } });
              if (finalMovieRows.length > 0) await batchCreateMany(tx.plexLibraryItem, finalMovieRows);
              if (finalTvRows.length    > 0) await batchCreateMany(tx.plexLibraryItem, finalTvRows);
            }
          }, { timeout: BATCH_TX_TIMEOUT });
        } catch (err) {
          console.error("[sync] Plex library write failed:", err);
          libraryWriteSucceeded = false;
        }
      }

      plexSyncSucceeded = libraryWriteSucceeded && fetched.every((f) => f.result !== null);
      if (plexSyncSucceeded) {
        // Stamp last-success timestamp so the notify-fallback (below) can detect a stale
        // source. Means "every configured instance synced clean this run."
        await prisma.setting.upsert({
          where: { key: "lastPlexSyncSucceededAt" },
          update: { value: String(Date.now()) },
          create: { key: "lastPlexSyncSucceededAt", value: String(Date.now()) },
        }).catch((err) => console.error("[sync] failed to stamp lastPlexSyncSucceededAt:", err));
      }

      // TVEpisodeCache has no serverInstance column (episodes are TMDB-anchored, shared
      // data — see media-instances.ts) — a per-instance episode-fetch failure can't be
      // handled by leaving just THAT instance's rows stale the way the scoped
      // PlexLibraryItem delete above does, so any single failure here skips the WHOLE
      // write and leaves existing rows untouched — the same all-or-nothing contract the
      // pre-multi-instance code already had (getPlexTVEpisodes throwing skipped the
      // delete+insert entirely; reaching the write with an empty result means the
      // libraries genuinely have no episodes, so the stale rows must be cleared rather
      // than left as phantom ownership). Looping the delete+insert TOGETHER per instance
      // would also have each instance's pass wipe the previous instance's just-written
      // rows, so every instance's rows are accumulated and the delete+insert runs ONCE
      // at the end. Each fetch runs against ITS OWN instance's sections list — Plex
      // ratingKeys are server-local and never leave the per-instance fetch, so nothing
      // can resolve episodes onto another server's show.
      let allEpisodesFetched = true;
      const allPlexEpisodeRows: Array<{ source: "plex" } & PlexTVEpisodeData> = [];
      for (const { slug, serverUrl, token, sections, ratingKeyToTmdb } of writable) {
        try {
          // The precomputed ratingKeyToTmdb map (built by this instance's own
          // type=2 walk above) skips getPlexTVEpisodes' per-section re-walk of
          // the identical show listing.
          const episodeFilePaths = new Map<string, string>();
          const episodes = await getPlexTVEpisodes(serverUrl, token, librarySelections.get(plexSettingKey(slug, "Libraries")), sections, ratingKeyToTmdb, episodeFilePaths);
          allPlexEpisodeRows.push(...episodes.map((e) => ({ source: "plex" as const, ...e })));
          // Patch the show file paths the TV fetch skipped (skipShowFilePaths)
          // onto the just-written rows. Runs AFTER this instance's library
          // write by construction (the write completed above), is
          // instance-scoped, and touches only rows still missing a path —
          // idempotent and harmless if a concurrent writer replaced the rows.
          // Best-effort: a failure leaves paths null until the next run, the
          // same degradation a failed allLeaves probe had.
          if (episodeFilePaths.size > 0) {
            try {
              await prisma.$transaction(async (tx) => {
                for (const [ratingKey, file] of episodeFilePaths) {
                  await tx.plexLibraryItem.updateMany({
                    where: { serverInstance: slug, mediaType: "TV", plexRatingKey: ratingKey, filePath: null },
                    data: { filePath: file },
                  });
                }
              }, { timeout: BATCH_TX_TIMEOUT });
            } catch (err) {
              console.warn(`[sync] Plex show file-path patch failed for instance "${slug}":`, err instanceof Error ? err.message : err);
            }
          }
        } catch (err) {
          console.error(`[sync] Plex TV episode fetch failed for instance "${slug}":`, err);
          allEpisodesFetched = false;
        }
      }
      // The `writable.length === fetched.length` term is load-bearing: an instance
      // whose LIBRARY fetch failed never enters `writable`, so its episodes were
      // never fetched at all — without this term the whole-table rewrite below
      // would proceed and wipe that server's episode rows for the length of its
      // outage while every other safeguard in this arm correctly preserves its
      // data. A library-WRITE failure deliberately does not veto (the fetched
      // episode data is still a complete picture).
      if (allEpisodesFetched && writable.length === fetched.length && writable.length > 0) {
        try {
          await prisma.$transaction(async (tx) => {
            // Advisory lock 2002,1 — shared with /api/sync/tv-episodes and sync/plex so the
            // wholesale Plex TVEpisodeCache rewrite can't be interleaved with another writer.
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(2002, 1)`;
            await tx.tVEpisodeCache.deleteMany({ where: { source: "plex" } });
            if (allPlexEpisodeRows.length > 0) await batchCreateMany(tx.tVEpisodeCache, allPlexEpisodeRows);
          }, { timeout: BATCH_TX_TIMEOUT });
        } catch (err) {
          console.error("[sync] Plex TV episode cache failed:", err);
        }
      }
    })(),
    (async () => {
      if (!jellyfinEnabled) return;
      if (jellyfinInstances.length === 0) return;

      // Respect the admin's selected Jellyfin libraries (mirrors /api/sync/jellyfin);
      // otherwise the scheduled full sync ingests every library and marks excluded
      // media as owned. Resolved per instance below, from THAT server's selection.

      // Fan out over every configured, connection-ready Jellyfin server (multi-server
      // support). Unlike arr, there's no per-request instance to attribute a fetch
      // failure to — availability here is a union across all configured servers, not
      // per-instance routing (see media-instances.ts) — so a failed instance simply
      // contributes nothing to the write below, and jellyfinSyncSucceeded (used only by
      // the revert/stale-fallback checks further down, which need to know this run's
      // union data is a COMPLETE picture) requires every configured instance's fetch AND
      // the write to have both succeeded.
      const fetched = await Promise.all(
        jellyfinInstances.map(async (instance) => {
          try {
            const cfg = await getJellyfinConfig(instance.slug);
            if (!cfg.url || !cfg.apiKey) return { slug: instance.slug, result: null }; // defensive; getSyncableMediaInstances already filters to configured ones
            const baseUrl = cfg.url.replace(/\/$/, "");
            const apiKey = cfg.apiKey;
            const selectedJellyfinIds = librarySelections.get(jellyfinSettingKey(instance.slug, "Libraries"));
            const [movieIds, tvIds] = await Promise.all([
              getJellyfinTmdbIds(baseUrl, apiKey, "MOVIE", selectedJellyfinIds),
              getJellyfinTmdbIds(baseUrl, apiKey, "TV", selectedJellyfinIds),
            ]);
            return { slug: instance.slug, result: { baseUrl, apiKey, movieIds, tvIds } };
          } catch (err) {
            console.error(`[sync] Jellyfin check failed for instance "${instance.slug}":`, err);
            return { slug: instance.slug, result: null };
          }
        }),
      );
      const writable = fetched.flatMap((f) => (f.result ? [{ slug: f.slug, ...f.result }] : []));

      // Union into the shared maps the ~300 lines of downstream availability logic
      // already expect — they only ever ask "is this tmdbId in the map," so a plain
      // per-key merge is correct regardless of which instance's value wins a collision.
      // The parallel `*Slugs` maps record WHICH instance contributed each key — see
      // the identical comment in the Plex arm above for why the union alone can no
      // longer answer the per-requester visibility question.
      for (const { slug, movieIds, tvIds } of writable) {
        for (const [tmdbId, d] of movieIds) {
          jfMovieIds.set(tmdbId, d);
          addPresence(jfMovieSlugs, tmdbId, slug);
        }
        for (const [tmdbId, d] of tvIds) {
          jfTvIds.set(tmdbId, d);
          addPresence(jfTvSlugs, tmdbId, slug);
        }
      }

      let libraryWriteSucceeded = true;
      if (writable.length > 0) {
        try {
          // Advisory lock 2001,2 — matches /api/sync/jellyfin. Per-instance scoped delete
          // (mirrors the arr side's per-slug scoping above) so one instance's rewrite
          // never touches another's rows; only instances whose fetch succeeded are
          // touched at all (G13 — a failed instance's existing rows are left intact,
          // never wiped).
          await prisma.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(2001, 2)`;
            for (const { slug, movieIds, tvIds } of writable) {
              const movieRows = Array.from(movieIds.entries()).map(([tmdbId, d]) => ({ tmdbId, mediaType: "MOVIE" as const, serverInstance: slug, filePath: d.filePath, jellyfinItemId: d.itemId, title: sanitizeStr(d.title, 500) ?? "", year: d.year, overview: sanitizeStr(d.overview), contentRating: sanitizeStr(d.contentRating, 50), communityRating: d.communityRating, addedAt: d.addedAt }));
              const tvRows    = Array.from(tvIds.entries()).map(([tmdbId, d])    => ({ tmdbId, mediaType: "TV"    as const, serverInstance: slug, filePath: d.filePath, jellyfinItemId: d.itemId, title: sanitizeStr(d.title, 500) ?? "", year: d.year, overview: sanitizeStr(d.overview), contentRating: sanitizeStr(d.contentRating, 50), communityRating: d.communityRating, addedAt: d.addedAt }));
              await tx.jellyfinLibraryItem.deleteMany({ where: { serverInstance: slug } });
              if (movieRows.length > 0) await batchCreateMany(tx.jellyfinLibraryItem, movieRows);
              if (tvRows.length    > 0) await batchCreateMany(tx.jellyfinLibraryItem, tvRows);
            }
          }, { timeout: BATCH_TX_TIMEOUT });
        } catch (err) {
          console.error("[sync] Jellyfin library write failed:", err);
          libraryWriteSucceeded = false;
        }
      }

      jellyfinSyncSucceeded = libraryWriteSucceeded && fetched.every((f) => f.result !== null);
      if (jellyfinSyncSucceeded) {
        // Stamp last-success timestamp so the notify-fallback (below) can detect a stale
        // source. Means "every configured instance synced clean this run."
        await prisma.setting.upsert({
          where: { key: "lastJellyfinSyncSucceededAt" },
          update: { value: String(Date.now()) },
          create: { key: "lastJellyfinSyncSucceededAt", value: String(Date.now()) },
        }).catch((err) => console.error("[sync] failed to stamp lastJellyfinSyncSucceededAt:", err));
      }

      // TVEpisodeCache has no serverInstance column (episodes are TMDB-anchored, shared
      // data — see media-instances.ts) — a per-instance episode-fetch failure can't be
      // handled by leaving just THAT instance's rows stale the way the scoped
      // JellyfinLibraryItem delete above does, so any single failure here skips the WHOLE
      // write and leaves existing rows untouched — the same all-or-nothing contract the
      // pre-multi-instance code already had (getJellyfinTVEpisodes throwing skipped the
      // delete+insert entirely). Looping the delete+insert TOGETHER per instance would
      // also have each instance's pass wipe the previous instance's just-written rows, so
      // every instance's rows are accumulated and the delete+insert runs ONCE at the end.
      let allEpisodesFetched = true;
      const allEpisodeRows: Array<{ source: "jellyfin" } & JellyfinTVEpisodeData> = [];
      for (const { slug, baseUrl, apiKey, tvIds } of writable) {
        // Built from THIS instance's own TV map, never the cross-instance union: Jellyfin
        // item ids are server-local and can collide across independently-administered
        // servers, so a global series map could resolve episodes onto the wrong show.
        const jfSeriesMap = new Map<string, number>();
        for (const [tmdbId, data] of tvIds) {
          if (data.itemId) jfSeriesMap.set(data.itemId, tmdbId);
        }
        try {
          const episodes = await getJellyfinTVEpisodes(baseUrl, apiKey, librarySelections.get(jellyfinSettingKey(slug, "Libraries")), jfSeriesMap);
          allEpisodeRows.push(...episodes.map((e) => ({ source: "jellyfin" as const, ...e })));
        } catch (err) {
          console.error(`[sync] Jellyfin TV episode fetch failed for instance "${slug}":`, err);
          allEpisodesFetched = false;
        }
      }
      // `writable.length === fetched.length` — same load-bearing term as the Plex
      // arm above: a library-fetch failure keeps the instance out of `writable`,
      // so its episodes were never fetched; the whole-table rewrite must not run
      // on that incomplete union or the down server's episode rows are wiped for
      // the length of its outage.
      if (allEpisodesFetched && writable.length === fetched.length && writable.length > 0) {
        try {
          await prisma.$transaction(async (tx) => {
            // Advisory lock 2002,2 — Jellyfin counterpart; same coordination contract as 2002,1.
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(2002, 2)`;
            await tx.tVEpisodeCache.deleteMany({ where: { source: "jellyfin" } });
            if (allEpisodeRows.length > 0) await batchCreateMany(tx.tVEpisodeCache, allEpisodeRows);
          }, { timeout: BATCH_TX_TIMEOUT });
        } catch (err) {
          console.error("[sync] Jellyfin TV episode cache failed:", err);
        }
      }
    })(),
  ]);
  for (const result of syncResults) {
    if (result.status === "rejected") {
      console.error("[sync] Unexpected top-level sync rejection:", result.reason);
    }
  }

  // Sweep library rows belonging to servers that are no longer REGISTERED.
  //
  // Availability readers are an unscoped union across every row, and no sync
  // path ever targets a de-registered slug again — so an orphaned row makes
  // that server's whole catalogue read "in library" forever (guardrail 35).
  // /api/admin/media-instances deletes on removal, but two cases slip past it:
  // a removal that lands DURING this run (the arms above captured the instance
  // list before their multi-minute library walk, so the write can re-insert
  // rows for a slug removed in the meantime), and rows orphaned by a release
  // that predates that cleanup. Re-reading the registry here — after the
  // writes, in the same run — closes both.
  //
  // Scoped to REGISTERED (getMediaInstances), never merely syncable: an
  // instance that is registered but temporarily unconfigured (an admin
  // mid-edit, a blanked token) must keep its rows, exactly as the arms above
  // leave a failed instance's rows intact.
  try {
    const [registeredPlex, registeredJellyfin] = await Promise.all([
      getMediaInstances("plex"),
      getMediaInstances("jellyfin"),
    ]);
    const [orphanedPlex, orphanedJellyfin] = await Promise.all([
      prisma.plexLibraryItem.deleteMany({ where: { serverInstance: { notIn: registeredPlex.map((i) => i.slug) } } }),
      prisma.jellyfinLibraryItem.deleteMany({ where: { serverInstance: { notIn: registeredJellyfin.map((i) => i.slug) } } }),
    ]);
    if (orphanedPlex.count > 0 || orphanedJellyfin.count > 0) {
      console.warn(
        `[sync] Swept library rows for de-registered servers — plex: ${orphanedPlex.count}, jellyfin: ${orphanedJellyfin.count}`,
      );
    }
  } catch (err) {
    console.error("[sync] De-registered-instance sweep failed:", err);
  }

  // Demote AVAILABLE requests that have dropped out of *both* the *arr caches and the
  // Plex/Jellyfin library caches. Consulting the library caches here — not just *arr — is
  // what stops a request present in Plex but absent from Radarr from being reverted to
  // APPROVED and then immediately re-marked AVAILABLE by markLibraryRequests below: a
  // same-run flap that rewrote availableAt and inflated the reverted counter every tick.
  // Runs after the library sync so the maps are populated; library presence is only trusted
  // when that source synced successfully (an empty map from a failed/disabled source falls
  // back to the *arr-only decision).
  // A configured+enabled source that failed to refresh has an empty map that is NOT
  // proof of absence — reading it as "not in library" would false-demote an item that's
  // actually present in the unreached library. Only trust a library map when its source
  // synced; skip the demote entirely while a configured source is down.
  const plexConfiguredEnabled = plexEnabled && plexInstances.length > 0;
  const jellyfinConfiguredEnabled = jellyfinEnabled && jellyfinInstances.length > 0;
  // REGISTERED, not syncable. plexInstances/jellyfinInstances above are
  // getSyncableMediaInstances — CONFIGURED servers only — so a registered server whose
  // url/token an admin cleared silently drops out of this run's union while its
  // PlexLibraryItem/JellyfinLibraryItem rows are deliberately preserved (guardrail 35).
  // It never enters `fetched`, so it cannot make plexSyncSucceeded false either. A title
  // living only on that server therefore read as absent and its requests were demoted
  // AVAILABLE -> APPROVED, from data that simply was not consulted. One registry
  // findUnique per service.
  const [registeredPlex, registeredJellyfin] = await Promise.all([
    getMediaInstances("plex"),
    getMediaInstances("jellyfin"),
  ]);
  // `plexInstances.length > 0` is load-bearing. getMediaInstances ALWAYS synthesizes the
  // default instance, so a service with nothing configured reads as 1 registered vs 0
  // syncable — "incomplete" — and without this term the guard below disabled demotes on
  // every deployment not running BOTH Plex and Jellyfin, which is most of them. A service
  // that is entirely unconfigured is already handled by the plexConfiguredEnabled /
  // jellyfinConfiguredEnabled guards; this one is only about a service in USE that has a
  // registered server missing its connection details.
  // A raw count comparison is not enough either: getMediaInstances synthesizes the
  // default, so a deployment using a service EXCLUSIVELY through a named instance —
  // legacy default fields never filled in — reads as 2 registered vs 1 syncable on every
  // run and vetoed every demote forever. The guard's own rationale ("its preserved
  // library rows are not in this run's union") is vacuous for a server that was never
  // configured: it holds no rows, so absence IS provable. Veto only on a missing slug
  // that ACTUALLY still holds rows. The existence probe is gated behind both cheap
  // terms, so the common single-server path issues no extra query.
  const syncablePlexSlugs = new Set(plexInstances.map((i) => i.slug));
  const missingPlex = registeredPlex.filter((i) => !syncablePlexSlugs.has(i.slug)).map((i) => i.slug);
  const syncableJellyfinSlugs = new Set(jellyfinInstances.map((i) => i.slug));
  const missingJellyfin = registeredJellyfin.filter((i) => !syncableJellyfinSlugs.has(i.slug)).map((i) => i.slug);
  const plexUnionIncomplete =
    plexInstances.length > 0 && missingPlex.length > 0 &&
    !!(await prisma.plexLibraryItem.findFirst({ where: { serverInstance: { in: missingPlex } }, select: { tmdbId: true } }));
  const jellyfinUnionIncomplete =
    jellyfinInstances.length > 0 && missingJellyfin.length > 0 &&
    !!(await prisma.jellyfinLibraryItem.findFirst({ where: { serverInstance: { in: missingJellyfin } }, select: { tmdbId: true } }));
  if (plexUnionIncomplete || jellyfinUnionIncomplete) {
    console.warn(
      `[sync] skipping AVAILABLE->APPROVED demotes: ${plexUnionIncomplete ? missingPlex.length : 0} Plex and ` +
      `${jellyfinUnionIncomplete ? missingJellyfin.length : 0} Jellyfin server(s) are registered but not configured, ` +
      "so their preserved library rows are not in this run's union and absence cannot be proven.",
    );
  }
  // Hoisted above the revert (it used to sit below markLibraryRequests): the demote is
  // a per-user decision too, so it needs the same visibility helpers the marking pass
  // uses. Pure const declarations with no dependency on anything between here and
  // their old home.
  // visibilityEnforced is the byte-identical escape hatch (guardrail 35): with
  // no restricted instance configured — every single-server deployment, and
  // every multi-server one that hasn't opted in — every configured slug is
  // visible to everyone, the per-user answer collapses to the union, and every
  // decision below short-circuits to the pre-grants code path.
  const visibilityEnforced =
    plexInstances.some((i) => i.restricted) || jellyfinInstances.some((i) => i.restricted);

  type RequesterRow = { id: string; mediaServer: string | null; role: string; permissions: bigint; mediaServerGrants: unknown };
  // One batched read of the requester columns every per-user decision below
  // needs. `mediaServer` is the pre-existing preference filter; `role` +
  // `permissions` + `mediaServerGrants` are the grants gate's inputs — extra
  // COLUMNS on a query that already ran, not a new query. `role` is NOT
  // optional: the raw `permissions` column is `@default(0)` and is only seeded
  // by a MANUAL one-shot script, so an upgraded deployment can hold a
  // role="ADMIN" row with permissions=0. Passing that raw would deny an admin
  // the ADMIN short-circuit HERE while every read path grants it (they all go
  // through effectivePermissions), stranding the operator's own requests as
  // PENDING while the UI insists the title is available.
  const loadRequesters = async (userIds: string[]): Promise<Map<string, RequesterRow>> => {
    const rows = await prisma.user.findMany({
      where: { id: { in: [...new Set(userIds)] } },
      select: { id: true, mediaServer: true, role: true, permissions: true, mediaServerGrants: true },
    });
    const byId = new Map<string, RequesterRow>();
    for (const u of rows) byId.set(u.id, u);
    return byId;
  };

  // A requester's visible slugs, memoised for the whole run: a title present in
  // several libraries asks the same question about the same user repeatedly.
  const visibilityCache = new Map<string, VisibleServerInstances>();
  const visibilityOf = (requesters: Map<string, RequesterRow>, userId: string): VisibleServerInstances => {
    const hit = visibilityCache.get(userId);
    if (hit) return hit;
    // A requester whose row is missing (deleted between the snapshot and now)
    // resolves as 0n permissions + no grants — the least-privileged answer, so an
    // absent row can never WIDEN visibility. Mirrors getVisibleServerInstances'
    // null-session branch. Safe to memoise: within a run a row can only go away,
    // never appear, so a cached least-privileged answer can never be the stale
    // one that matters.
    const u = requesters.get(userId);
    const vis = visibleInstancesFor(
      // effectivePermissions, never the raw column — see loadRequesters. This
      // is what makes the sync gate agree with every read path for a legacy
      // ADMIN row whose permissions were never seeded.
      u ? effectivePermissions(u.role, u.permissions) : 0n,
      parseMediaServerGrants(u?.mediaServerGrants),
      plexInstances,
      jellyfinInstances,
    );
    visibilityCache.set(userId, vis);
    return vis;
  };

  // "Is this title on a <service> server THIS requester can see?" — the
  // per-viewer replacement for the union map's `.has()`. The union check runs
  // FIRST and unchanged: a title absent from every configured server is absent
  // for everyone and no grant can conjure it, so the overwhelmingly common
  // "not present" answer costs exactly what it did before.
  const presentForRequester = (
    req: { tmdbId: number; mediaType: string; requestedBy: string },
    service: "plex" | "jellyfin",
    requesters: Map<string, RequesterRow>,
  ): boolean => {
    const isMovie = req.mediaType === "MOVIE";
    const union = service === "plex"
      ? (isMovie ? plexMovieIds : plexTvIds)
      : (isMovie ? jfMovieIds : jfTvIds);
    if (!union.has(req.tmdbId)) return false;
    if (!visibilityEnforced) return true; // nothing restricted ⇒ the union IS the per-user answer
    const holders = (service === "plex"
      ? (isMovie ? plexMovieSlugs : plexTvSlugs)
      : (isMovie ? jfMovieSlugs : jfTvSlugs)
    ).get(req.tmdbId);
    // Unreachable — the union and presence maps are filled in the same loop — but
    // fail CLOSED rather than fall back to the union if they ever diverge.
    if (!holders) return false;
    const vis = visibilityOf(requesters, req.requestedBy);
    return (service === "plex" ? vis.plex : vis.jellyfin).some((slug) => holders.has(slug));
  };

  // Loaded once for the whole demote pass when any instance is restricted; skipped
  // entirely otherwise, so a deployment with nothing restricted issues exactly the
  // queries it did before (guardrail 35's byte-identical rule).
  const revertRequesters = visibilityEnforced
    ? await loadRequesters(available.map((r) => r.requestedBy))
    : new Map<string, RequesterRow>();

  const toRevert = available.filter((req) => {
    // Only consult the ARR cache when the integration is enabled AND this run refreshed
    // THE REQUEST'S OWN instance. A disabled integration, a failed refresh, or an
    // enabled-but-UNCONFIGURED instance all leave that instance's cache meaningless —
    // skip the demote. (The old global radarrSyncSucceeded flag read true after the
    // no-op empty loop of an unconfigured integration, so its empty cache masqueraded
    // as an authoritatively-empty library and mass-demoted every arr-backed AVAILABLE
    // request the moment an admin cleared the arr connection with the flag still on.)
    if (req.mediaType === "MOVIE" && (!radarrEnabled || !radarrSyncedSlugs.has(req.arrInstance))) return false;
    if (req.mediaType === "TV"    && (!sonarrEnabled || !sonarrSyncedSlugs.has(req.arrInstance))) return false;
    // Don't demote while a configured library source is down — we can't prove absence
    // from a library we never reached this run.
    if (plexConfiguredEnabled && !plexSyncSucceeded) return false;
    if (jellyfinConfiguredEnabled && !jellyfinSyncSucceeded) return false;
    // Same "can't prove absence" rule, for a server that is registered but no longer
    // configured: its rows survive and this run never looked at them.
    if (plexUnionIncomplete || jellyfinUnionIncomplete) return false;
    const inArr = req.mediaType === "MOVIE"
      ? inRadarrSet.has(vkey(req.tmdbId, req.arrInstance))
      : inSonarrSet.has(vkey(req.tmdbId, req.arrInstance));
    // Only count a source's map as authoritative-present when it actually synced, and
    // ask the question PER REQUESTER — the same predicate the marking pass uses. Reading
    // the global union here meant a restricted server the requester holds no grant for
    // still counted as "present", so their request stayed AVAILABLE for a copy they
    // cannot watch and the UI has always rendered as unavailable. presentForRequester
    // checks the union FIRST and short-circuits to it whenever nothing is restricted, so
    // the common case costs exactly what it did before.
    const inLibrary =
      (plexSyncSucceeded && presentForRequester(req, "plex", revertRequesters)) ||
      (jellyfinSyncSucceeded && presentForRequester(req, "jellyfin", revertRequesters));
    return !inArr && !inLibrary;
  });
  const revertedIds = new Set<string>();
  if (toRevert.length > 0) {
    const result = await prisma.mediaRequest.updateMany({
      // CAS on status: only demote rows still AVAILABLE. toRevert is built from the
      // run-start `available` snapshot, so a row that a concurrent path moved out of
      // AVAILABLE must not be blind-written back to APPROVED.
      where: { id: { in: toRevert.map((r) => r.id) }, status: "AVAILABLE" },
      // Clear pendingNotifyAt on demote: a stale overdue timestamp left from the
      // original approve would otherwise fire a false "download pending" notify
      // once the row is back to APPROVED.
      data: { status: "APPROVED", pendingNotifyAt: null },
    });
    reverted = result.count;
    for (const r of toRevert) revertedIds.add(r.id);
  }

  // Snapshot taken once after both library writes complete; both marking passes share this exact set.
  // Changes made by the Plex pass are NOT visible to the Jellyfin pass — intentional by design.
  //
  // Exclude rows we just reverted from AVAILABLE→APPROVED in this same run.
  // Otherwise markLibraryRequests below could re-flip them to AVAILABLE if
  // they're present in Plex/Jellyfin but absent from the ARR caches —
  // triggering exactly the same-run flap the revert was added to prevent.
  // Those items get a fresh look on the next sync run when the caches and
  // status are coherent.
  const stillPendingAll = await prisma.mediaRequest.findMany({
    where: { status: { in: ["PENDING", "APPROVED"] } },
    select: { id: true, tmdbId: true, mediaType: true, requestedBy: true, title: true, posterPath: true, notifiedAvailable: true },
  });
  const stillPending = revertedIds.size === 0
    ? stillPendingAll
    : stillPendingAll.filter((r) => !revertedIds.has(r.id));

  // ── Per-user media-server visibility (multi-server grants) ─────────────────
  //
  // A `restricted` Plex/Jellyfin instance contributes availability ONLY to users
  // granted `view` on it, so "is this request's title available" stopped being
  // one global answer: the SAME title on the SAME server is available to a
  // granted requester and not-yet-available to an ungranted one. The AVAILABLE
  // flip and the notification both follow that per-requester answer — an
  // ungranted requester's row stays PENDING/APPROVED and un-notified until a
  // copy lands on a server they can see, or until the grant is issued.
  //
  // Cost: no extra round-trip. plexInstances/jellyfinInstances were read once at
  // the top of this run (getSyncableMediaInstances → MediaInstanceConfig carries
  // `restricted`), and the two grant columns ride the user.findMany the
  // marking/notify passes already issue — never a per-requester query
  // (guardrail 31). visibleInstancesFor is the PURE resolver built for exactly
  // this many-requesters-one-registry-read shape.
  //
  // NOT applied to the two ARR marking passes above, deliberately: Radarr/Sonarr
  // availability is server-agnostic (the *arr knows a file exists in a root
  // folder, not which media server indexes it), so there is no per-instance
  // presence to gate on. In every real topology the *arr feeds the DEFAULT
  // server, which is visible to everyone by construction.
  //

  const markLibraryRequests = async (
    movieIds: Map<number, unknown>,
    tvIds: Map<number, unknown>,
    source: "plex" | "jellyfin",
  ): Promise<number> => {
    const candidates = stillPending.filter((req) =>
      req.mediaType === "MOVIE" ? movieIds.has(req.tmdbId) : tvIds.has(req.tmdbId)
    );
    if (candidates.length === 0) return 0;

    // GRANTS GATE — PRE-CAS BY CONSTRUCTION.
    //
    // This is a plain JS filter over the already-materialised candidate array,
    // and its position is the whole correctness argument:
    //   • guardrail 14 holds untouched. claimAvailableNotificationWinners is
    //     still the ONLY writer of notifiedAvailable; it simply never receives a
    //     gated id, so the exactly-once claim across the Plex and Jellyfin
    //     passes is unchanged.
    //   • the claim is NOT burned for a gated requester. (Contrast
    //     notify-available.ts's deactivatedAt filter, which sits AFTER the
    //     UPDATE … RETURNING and deliberately burns the claim so a re-enabled
    //     account can't replay a stale backlog. For grants that would be exactly
    //     wrong — an ungranted requester would permanently lose the
    //     notification even after being granted.) A gated row stays
    //     PENDING/APPROVED with notifiedAvailable=false, so the next run
    //     re-evaluates it and flips + notifies as soon as the grant lands or a
    //     copy appears on a server they can see.
    //   • guardrail 15 holds untouched. `stillPending` is still READ exactly once
    //     per run and both passes still share that one snapshot; the invariant
    //     constrains the read, not what a pass filters out of it afterwards.
    //
    // Gating `candidates` (rather than the later toNotify/toMarkOnly splits)
    // covers all three downstream branches at once — notify, flip-without-notify,
    // and the already-notified flip — so an invisible title can never move a
    // requester's row to AVAILABLE by any route.
    let requesters = new Map<string, RequesterRow>();
    let toMark = candidates;
    if (visibilityEnforced) {
      // Loaded at the CANDIDATE scope (wider than the `unnotified` scope the
      // pre-grants code used) because the gate must run before toMark is settled;
      // the same rows are then reused for the mediaServer split below, so this is
      // still ONE user query per pass.
      requesters = await loadRequesters(candidates.map((r) => r.requestedBy));
      toMark = candidates.filter((req) => presentForRequester(req, source, requesters));
    }
    if (toMark.length === 0) return 0;

    // Re-fetch notifiedAvailable to catch any updates the concurrent Plex pass may have committed
    const freshRows = await prisma.mediaRequest.findMany({
      where: { id: { in: toMark.map((r) => r.id) } },
      select: { id: true, notifiedAvailable: true },
    });
    const alreadyNotifiedIds = new Set(freshRows.filter((r) => r.notifiedAvailable).map((r) => r.id));

    const unnotified = toMark.filter((r) => !alreadyNotifiedIds.has(r.id));
    if (unnotified.length > 0) {

      // Already loaded at the candidate scope when the grants gate ran above;
      // otherwise issue exactly the query the pre-grants code issued.
      if (!visibilityEnforced) {
        requesters = await loadRequesters(unnotified.map((r) => r.requestedBy));
      }

      // Users with a mediaServer preference only get notified by their preferred source;
      // users with no preference get notified by whichever source sees the item first
      const toNotify = unnotified.filter((r) => {
        const ms = requesters.get(r.requestedBy)?.mediaServer ?? null;
        return !ms || ms === source;
      });

      // Mark available without notifying users whose preferred server is a different source
      const toMarkOnly = unnotified.filter((r) => {
        const ms = requesters.get(r.requestedBy)?.mediaServer ?? null;
        return !!ms && ms !== source;
      });

      if (toNotify.length > 0) {
        const winners = await claimAvailableNotificationWinners(toNotify, { markAvailable: true });
        if (winners.length > 0) {
          void clearDeletionVotesForTmdbs(winners);
          notifyUsersRequestsAvailable(winners).catch((err) => console.warn("[sync] Discord available notify failed:", err instanceof Error ? err.message : err));
          notifyUsersRequestsAvailablePush(winners).catch((err) => console.warn("[sync] push available notify failed:", err instanceof Error ? err.message : err));
          void notifyUsersRequestsAvailableEmail(winners, "sync");
          void writeAvailableInAppNotifications(winners, "sync");
        }
      }
      if (toMarkOnly.length > 0) {
        // status IN (PENDING, APPROVED): only forward transitions. Gates availableAt
        // rewrites on already-AVAILABLE rows AND refuses to resurrect a row an admin
        // DECLINED after this run's snapshot (AVAILABLE is terminal — unfixable).
        const flipped = await prisma.mediaRequest.updateMany({
          where: { id: { in: toMarkOnly.map((r) => r.id) }, status: { in: ["PENDING", "APPROVED"] } },
          data: { status: "AVAILABLE", availableAt: new Date() },
        });
        if (flipped.count > 0) void clearDeletionVotesForTmdbs(toMarkOnly);
      }
    }
    const alreadyNotified = toMark.filter((r) => alreadyNotifiedIds.has(r.id));
    if (alreadyNotified.length > 0) {
      // status IN (PENDING, APPROVED): only forward transitions. Gates availableAt
      // rewrites on already-AVAILABLE rows AND refuses to resurrect a row an admin
      // DECLINED after this run's snapshot (AVAILABLE is terminal — unfixable).
      const flipped = await prisma.mediaRequest.updateMany({
        where: { id: { in: alreadyNotified.map((r) => r.id) }, status: { in: ["PENDING", "APPROVED"] } },
        data: { status: "AVAILABLE", availableAt: new Date() },
      });
      if (flipped.count > 0) void clearDeletionVotesForTmdbs(alreadyNotified);
    }
    return toMark.length;
  };

  if (plexMovieIds.size > 0 || plexTvIds.size > 0) {
    plexMarked = await markLibraryRequests(plexMovieIds, plexTvIds, "plex");
  }
  if (jfMovieIds.size > 0 || jfTvIds.size > 0) {
    jellyfinMarked = await markLibraryRequests(jfMovieIds, jfTvIds, "jellyfin");
  }

  // Re-query LIVE rather than filter the run-start `available` snapshot: a
  // request the marking passes flipped AVAILABLE **this run** via the
  // non-notifying toMarkOnly path (user prefers the OTHER source; title present
  // in both libraries) is not in the snapshot — the source-pass notify claim
  // then finds status already AVAILABLE (its CAS only claims PENDING/APPROVED)
  // and the user's "now available" notification silently slips a full sync
  // cycle. A live read includes those rows; the requireStatusAvailable CAS
  // below still guarantees exactly-once against the webhook poller and
  // concurrent runs. Costs one extra findMany per run.
  const pendingAvailableNotify = await prisma.mediaRequest.findMany({
    where: { status: "AVAILABLE", notifiedAvailable: false },
    select: { id: true, tmdbId: true, mediaType: true, arrInstance: true, requestedBy: true, title: true, posterPath: true, notifiedAvailable: true },
  });
  if (pendingAvailableNotify.length > 0) {
    // Reuse the demote gate's enabled+configured predicate: a source whose integration
    // flag is OFF will never sync, so counting it as "configured" here starves every user
    // pinned to it forever — the same failure mode the stale fallback below exists to fix.
    const plexConfigured = plexConfiguredEnabled;
    const jellyfinConfigured = jellyfinConfiguredEnabled;

    // Fallback for notification starvation: if a per-source sync has been failing for more than
    // STALE_SYNC_FALLBACK_MS, treat that source's data as "valid" so the *other* source can
    // satisfy the notify gate alone. Without this, a permanently broken Plex would block every
    // Jellyfin-only user's "now available" notification forever (and vice versa). The within-window
    // guard is preserved: a recent failure still refuses to notify on stale data.
    const STALE_SYNC_FALLBACK_MS = 24 * 60 * 60 * 1000;
    const [lastPlexSuccessRow, lastJellyfinSuccessRow] = await Promise.all([
      prisma.setting.findUnique({ where: { key: "lastPlexSyncSucceededAt" } }),
      prisma.setting.findUnique({ where: { key: "lastJellyfinSyncSucceededAt" } }),
    ]);
    const parseTs = (v: string | null | undefined): number | null => {
      if (!v) return null;
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? n : null;
    };
    const lastPlexSuccessAt = parseTs(lastPlexSuccessRow?.value);
    const lastJellyfinSuccessAt = parseTs(lastJellyfinSuccessRow?.value);
    const nowMs = Date.now();
    // Seed a baseline the first time a configured source fails with NO recorded success:
    // the marker is only ever stamped on a clean run, so a source that has never synced
    // clean has no row, `*Stale` can never become true, and the fallback below starves
    // every user pinned to that source forever — the exact failure mode it exists to
    // prevent. skipDuplicates keeps it idempotent and can never overwrite a real success
    // stamp; a later clean run upserts over it. Recording a failure-time origin (not
    // treating a missing row as instantly stale) preserves the 24h within-window guard.
    const staleBaselineSeeds: Array<{ key: string; value: string }> = [];
    if (plexConfigured && !plexSyncSucceeded && lastPlexSuccessAt == null) {
      staleBaselineSeeds.push({ key: "lastPlexSyncSucceededAt", value: String(nowMs) });
    }
    if (jellyfinConfigured && !jellyfinSyncSucceeded && lastJellyfinSuccessAt == null) {
      staleBaselineSeeds.push({ key: "lastJellyfinSyncSucceededAt", value: String(nowMs) });
    }
    if (staleBaselineSeeds.length > 0) {
      await prisma.setting.createMany({ data: staleBaselineSeeds, skipDuplicates: true })
        .catch((err) => console.error("[sync] failed to seed the stale-sync baseline:", err));
    }
    const plexStale = plexConfigured && !plexSyncSucceeded &&
      lastPlexSuccessAt != null && (nowMs - lastPlexSuccessAt) > STALE_SYNC_FALLBACK_MS;
    const jellyfinStale = jellyfinConfigured && !jellyfinSyncSucceeded &&
      lastJellyfinSuccessAt != null && (nowMs - lastJellyfinSuccessAt) > STALE_SYNC_FALLBACK_MS;

    const requesters = await loadRequesters(pendingAvailableNotify.map((r) => r.requestedBy));

    // Collect candidate ids, then do a single CAS updateMany + a single notify per channel
    // rather than one-DB-roundtrip-per-request and one-notify-call-per-request.
    const toNotify: typeof pendingAvailableNotify = [];
    for (const req of pendingAvailableNotify) {
      const ms = requesters.get(req.requestedBy)?.mediaServer ?? null;
      // Per-viewer presence (grants): "in Plex" means "on a Plex server THIS
      // requester can see", so the notification follows the same gate as the
      // AVAILABLE flip in markLibraryRequests. Also pre-CAS — the filter builds
      // toNotify, and only that array reaches claimAvailableNotificationWinners,
      // so a gated row's claim is never burned and the next run re-offers it.
      // With nothing restricted this is exactly the union `.has()` it replaced.
      const inPlex = presentForRequester(req, "plex", requesters);
      const inJellyfin = presentForRequester(req, "jellyfin", requesters);
      // "Unusable" = this source cannot prove presence either way: not configured/enabled
      // at all, OR its sync has been failing past the 24h stale window. A source that
      // synced fine this run is NOT unusable, so its empty result still blocks a false
      // notify. The gate used to AND a `plexDataValid` term with `!plexConfigured`, where
      // plexDataValid is implied true — so plexStale (which requires plexConfigured) could
      // never contribute and a permanently-broken Plex starved every plex-pinned user's
      // "now available" notification forever, which is exactly what the fallback above
      // was written to prevent.
      // Grants extend "unusable" per requester: someone who can see NO configured
      // server of a type is in exactly the position of a deployment with that type
      // unconfigured — it can never prove presence for them either way, so it must
      // not block the OTHER source's notify. Reachable when the DEFAULT instance of
      // a type is unconfigured and only a restricted named one exists (the default
      // is visible to everyone by construction, so a configured default always
      // makes this false). Folding grants into the existing unusable term — not
      // just into inPlex/inJellyfin — is what preserves the fallback's
      // anti-starvation contract for a per-user answer.
      const noVisiblePlex = visibilityEnforced && visibilityOf(requesters, req.requestedBy).plex.length === 0;
      const noVisibleJellyfin = visibilityEnforced && visibilityOf(requesters, req.requestedBy).jellyfin.length === 0;
      const plexUnusable = !plexConfigured || plexStale || noVisiblePlex;
      const jellyfinUnusable = !jellyfinConfigured || jellyfinStale || noVisibleJellyfin;
      const shouldNotify = !ms
        ? inPlex || inJellyfin || (plexUnusable && jellyfinUnusable)
        : ms === "plex"
        ? inPlex || (plexUnusable && (inJellyfin || jellyfinUnusable))
        : ms === "jellyfin"
        ? inJellyfin || (jellyfinUnusable && (inPlex || plexUnusable))
        : false;
      if (shouldNotify) toNotify.push(req);
    }

    if (toNotify.length > 0) {
      // Atomic claim (UPDATE ... RETURNING) closes the snapshot→updateMany TOCTOU:
      // only rows this statement flipped (status AVAILABLE, notifiedAvailable
      // false→true) come back, so a row a concurrent path claimed between a read
      // and the update is never re-notified. requireStatusAvailable preserves the
      // original "only notify rows already marked AVAILABLE" guard.
      const winners = await claimAvailableNotificationWinners(toNotify, { requireStatusAvailable: true });
      if (winners.length > 0) {
        // Backstop wipe: the original AVAILABLE transition (per-source mark pass,
        // webhooks) should have wiped already, but a regression there is silent
        // until threshold notifications fire on stale votes — wipe again here.
        void clearDeletionVotesForTmdbs(winners);
        notifyUsersRequestsAvailable(winners).catch((err) => console.warn("[sync] Discord available notify failed:", err instanceof Error ? err.message : err));
        notifyUsersRequestsAvailablePush(winners).catch((err) => console.warn("[sync] push available notify failed:", err instanceof Error ? err.message : err));
        void notifyUsersRequestsAvailableEmail(winners, "sync");
        void writeAvailableInAppNotifications(winners, "sync");
      }
    }
  }

  try {
    // The ratings namespaces AND the :details blobs are read through
    // getCacheStale/getCacheStaleMany, which deliberately never delete an expired
    // row — an expired row is still a HIT, served immediately and revalidated
    // after the response. This purge was the only thing deleting them, within one
    // SYNC_INTERVAL of expiry, collapsing those serve-stale windows to under an
    // hour and turning a stale hit into a cold miss for the rest of the row's
    // life. Reap each namespace on its own grace instead. The ratings prefixes
    // must carry `:tmdb:`: bare `mdblist:`/`omdb:` also match the list caches,
    // which should still expire immediately.
    await prisma.tmdbCache.deleteMany({
      // `NOT: { OR: [...] }`, not a bare `NOT: [...]`: the shapes are mutually
      // exclusive, so if a list-NOT compiled to NOT(a AND b) the exclusion would be
      // a silent no-op. The nested form is unambiguously "none of these shapes".
      where: {
        expiresAt: { lt: new Date() },
        NOT: { OR: [...STALE_RATINGS_KEY_PREFIXES, ...STALE_DETAILS_KEY_SHAPES] },
      },
    });
    await prisma.tmdbCache.deleteMany({
      where: {
        expiresAt: { lt: new Date(Date.now() - STALE_RATINGS_GRACE_MS) },
        OR: STALE_RATINGS_KEY_PREFIXES,
      },
    });
    await prisma.tmdbCache.deleteMany({
      where: {
        expiresAt: { lt: new Date(Date.now() - STALE_DETAILS_GRACE_MS) },
        OR: STALE_DETAILS_KEY_SHAPES,
      },
    });
  } catch (err) {
    console.error("[sync] TMDB cache purge failed:", err);
  }

  const durationMs = Date.now() - startTime;

  // `lastRunAt` observability for /settings?tab=system. The outer withCronRunRecording
  // wrapper writes the Setting row on every run (including throws + non-2xx). The audit
  // row below stays scoped to admin-triggered runs to avoid hourly flooding of the
  // audit table.
  // DB-checked attribution (bearer-first then cookie) so a stale/revoked admin
  // JWT can't mis-attribute the audit row. The access-control gate stays
  // isCronAuthorized (above); this only attributes the admin-triggered run.
  const attributionClaims = await readActiveSummonarrSessionFromRequest(request);
  if (attributionClaims) {
    void logAudit({
      userId: attributionClaims.id,
      userName: attributionClaims.name ?? attributionClaims.id,
      action: "LIBRARY_SYNC",
      target: "sync:full",
      details: { marked, reverted, repushed, plexMarked, jellyfinMarked, radarrWanted, sonarrWanted, durationMs },
    });
  }

  // Surface degraded runs to withCronRunRecording via the X-Cron-Degraded header:
  // an enabled source that failed this run previously still recorded ok:true, so
  // the admin System tab showed green even when nothing was refreshed. Status
  // stays 200 (NOT 502) deliberately — the docker entrypoint reschedules non-2xx
  // after CRON_RETRY_INTERVAL (300s), so a 502 during a sustained Radarr/Plex
  // outage would run this full library replace every 5 minutes instead of hourly.
  // The correctness guards above already gate on the *SyncSucceeded flags.
  const failedSources = [
    ...(radarrEnabled && !radarrSyncSucceeded ? ["radarr"] : []),
    ...(sonarrEnabled && !sonarrSyncSucceeded ? ["sonarr"] : []),
    ...(plexConfiguredEnabled && !plexSyncSucceeded ? ["plex"] : []),
    ...(jellyfinConfiguredEnabled && !jellyfinSyncSucceeded ? ["jellyfin"] : []),
  ];

  return NextResponse.json(
    {
      checked: { approved: approved.length, available: available.length },
      marked,
      reverted,
      repushed,
      plexMarked,
      jellyfinMarked,
      radarrWanted,
      sonarrWanted,
      // `error` is what the admin SyncButton surfaces; failedSources is for logs.
      ...(failedSources.length > 0
        ? { failedSources, error: `Sync degraded — ${failedSources.join(", ")} failed to refresh` }
        : {}),
    },
    failedSources.length > 0
      ? { headers: { "X-Cron-Degraded": failedSources.join(",") } }
      : undefined,
  );
}
