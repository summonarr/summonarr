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
import { getPlexTmdbIds, getPlexLibrarySections, getPlexTVEpisodes, type PlexLibraryItemData } from "@/lib/plex";
import { getPlexConfig } from "@/lib/plex-config";
import { getJellyfinTmdbIds, getJellyfinTVEpisodes, type JellyfinLibraryItemData } from "@/lib/jellyfin";
import { getJellyfinConfig } from "@/lib/jellyfin-config";
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
type PlexDedupeRow = { tmdbId: number; plexRatingKey: string | null };
async function deduplicatePlexRowsByRatingKey<T extends PlexDedupeRow>(
  rows: T[],
  mediaType: "MOVIE" | "TV",
): Promise<T[]> {
  const ratingKeyCount = new Map<string, number>();
  for (const r of rows) {
    if (r.plexRatingKey) ratingKeyCount.set(r.plexRatingKey, (ratingKeyCount.get(r.plexRatingKey) ?? 0) + 1);
  }
  const conflatedKeys = new Set([...ratingKeyCount.entries()].filter(([, n]) => n > 1).map(([k]) => k));
  if (conflatedKeys.size === 0) return rows;

  const conflatedTmdbIds = rows.filter((r) => r.plexRatingKey && conflatedKeys.has(r.plexRatingKey)).map((r) => r.tmdbId);
  const existing = await prisma.plexLibraryItem.findMany({
    where: { mediaType, tmdbId: { in: conflatedTmdbIds } },
    select: { tmdbId: true, plexRatingKey: true },
  });
  const fixedIdByRatingKey = new Map<string, number>();
  for (const e of existing) {
    if (e.plexRatingKey) fixedIdByRatingKey.set(e.plexRatingKey, e.tmdbId);
  }

  const seenRatingKeys = new Set<string>();
  return rows.filter((r) => {
    if (!r.plexRatingKey || !conflatedKeys.has(r.plexRatingKey)) return true;
    const fixed = fixedIdByRatingKey.get(r.plexRatingKey);
    if (fixed !== undefined) {
      if (r.tmdbId !== fixed) {
        console.warn(`[sync] conflated ratingKey=${r.plexRatingKey}: dropping tmdb=${r.tmdbId}, keeping fixed tmdb=${fixed}`);
        return false;
      }
    } else if (seenRatingKeys.has(r.plexRatingKey)) {
      return false;
    }
    seenRatingKeys.add(r.plexRatingKey);
    return true;
  });
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
        where: { id: { in: catchupIds }, notifiedAvailable: true, status: { not: "AVAILABLE" } },
        data: { status: "AVAILABLE", availableAt: new Date(), pendingNotifyAt: null },
      });
    }
    marked = arrUnpinned.length;
  }

  const now = new Date();
  const overdue = approved.filter((r) => r.pendingNotifyAt && r.pendingNotifyAt <= now && !arrNotify.find((n) => n.id === r.id));
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
        const firstAired = await getSeriesFirstAired(req.tmdbId);
        if (firstAired && new Date(firstAired) > now) {
          released = false;
          soonestReleaseDate = firstAired;
        }
      }
      await prisma.mediaRequest.update({ where: { id: req.id }, data: { pendingNotifyAt: null } });
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

  const [plexConfig, jellyfinConfig, plexLibrariesRow, jfLibrariesRow] = await Promise.all([
    getPlexConfig(),
    getJellyfinConfig(),
    prisma.setting.findUnique({ where: { key: "plexLibraries" } }),
    prisma.setting.findUnique({ where: { key: "jellyfinLibraries" } }),
  ]);

  let plexMovieIds = new Map<number, PlexLibraryItemData>();
  let plexTvIds    = new Map<number, PlexLibraryItemData>();
  let jfMovieIds   = new Map<number, JellyfinLibraryItemData>();
  let jfTvIds      = new Map<number, JellyfinLibraryItemData>();
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
      if (!plexConfig.url || !plexConfig.token) return;
      try {
        const serverUrl = plexConfig.url.replace(/\/$/, "");
        const token = plexConfig.token;
        // Respect the admin's selected Plex libraries (mirrors /api/sync/plex). Without
        // this the scheduled full sync ingested EVERY section, marking media in an
        // excluded library as owned → availability false positives on every cron tick.
        const selectedPlexKeys = plexLibrariesRow?.value
          ? new Set(plexLibrariesRow.value.split(",").map((k) => k.trim()).filter(Boolean))
          : undefined;
        const sections = await getPlexLibrarySections(serverUrl, token);
        [plexMovieIds, plexTvIds] = await Promise.all([
          getPlexTmdbIds(serverUrl, token, "MOVIE", false, selectedPlexKeys, sections),
          getPlexTmdbIds(serverUrl, token, "TV", false, selectedPlexKeys, sections),
        ]);
        const movieRows = Array.from(plexMovieIds.entries()).map(([tmdbId, d]) => ({ tmdbId, mediaType: "MOVIE" as const, filePath: d.filePath, plexRatingKey: d.ratingKey, title: sanitizeStr(d.title, 500) ?? "", year: d.year, overview: sanitizeStr(d.overview), contentRating: sanitizeStr(d.contentRating, 50), addedAt: d.addedAt }));
        const tvRows    = Array.from(plexTvIds.entries()).map(([tmdbId, d])    => ({ tmdbId, mediaType: "TV"    as const, filePath: d.filePath, plexRatingKey: d.ratingKey, title: sanitizeStr(d.title, 500) ?? "", year: d.year, overview: sanitizeStr(d.overview), contentRating: sanitizeStr(d.contentRating, 50), addedAt: d.addedAt }));
        const finalMovieRows = await deduplicatePlexRowsByRatingKey(movieRows, "MOVIE");
        const finalTvRows    = await deduplicatePlexRowsByRatingKey(tvRows, "TV");
        // Advisory lock 2001,1 — matches /api/sync/plex so the two callers can't race the same write.
        await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(2001, 1)`;
          await tx.plexLibraryItem.deleteMany();
          if (finalMovieRows.length > 0) await batchCreateMany(tx.plexLibraryItem, finalMovieRows);
          if (finalTvRows.length    > 0) await batchCreateMany(tx.plexLibraryItem, finalTvRows);
        }, { timeout: BATCH_TX_TIMEOUT });
        plexSyncSucceeded = true;
        // Stamp last-success timestamp so the notify-fallback (below) can detect a stale source.
        await prisma.setting.upsert({
          where: { key: "lastPlexSyncSucceededAt" },
          update: { value: String(Date.now()) },
          create: { key: "lastPlexSyncSucceededAt", value: String(Date.now()) },
        }).catch((err) => console.error("[sync] failed to stamp lastPlexSyncSucceededAt:", err));
        try {
          // Full replace: clear unconditionally then insert. getPlexTVEpisodes THROWS on
          // a fetch failure (caught below → no clear), so reaching here with an empty
          // result means the library genuinely has no episodes — clear the stale ones
          // rather than leaving phantom ownership (the old `if (>0)` guard never cleared).
          const episodes = await getPlexTVEpisodes(serverUrl, token, selectedPlexKeys, sections);
          const episodeRows = episodes.map((e) => ({ source: "plex" as const, ...e }));
          await prisma.$transaction(async (tx) => {
            // Advisory lock 2002,1 — shared with /api/sync/tv-episodes and sync/plex so the
            // wholesale Plex TVEpisodeCache rewrite can't be interleaved with another writer.
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(2002, 1)`;
            await tx.tVEpisodeCache.deleteMany({ where: { source: "plex" } });
            if (episodeRows.length > 0) await batchCreateMany(tx.tVEpisodeCache, episodeRows);
          }, { timeout: BATCH_TX_TIMEOUT });
        } catch (err) {
          console.error("[sync] Plex TV episode cache failed:", err);
        }
      } catch (err) {
        console.error("[sync] Plex check failed:", err);
      }
    })(),
    (async () => {
      if (!jellyfinEnabled) return;
      if (!jellyfinConfig.url || !jellyfinConfig.apiKey) return;
      try {
        const baseUrl = jellyfinConfig.url.replace(/\/$/, "");
        const apiKey  = jellyfinConfig.apiKey;
        // Respect the admin's selected Jellyfin libraries (mirrors /api/sync/jellyfin);
        // otherwise the scheduled full sync ingests every library and marks excluded
        // media as owned.
        const selectedJellyfinIds = jfLibrariesRow?.value
          ? new Set(jfLibrariesRow.value.split(",").map((k) => k.trim()).filter(Boolean))
          : undefined;
        [jfMovieIds, jfTvIds] = await Promise.all([
          getJellyfinTmdbIds(baseUrl, apiKey, "MOVIE", selectedJellyfinIds),
          getJellyfinTmdbIds(baseUrl, apiKey, "TV", selectedJellyfinIds),
        ]);
        const movieRows = Array.from(jfMovieIds.entries()).map(([tmdbId, d]) => ({ tmdbId, mediaType: "MOVIE" as const, filePath: d.filePath, jellyfinItemId: d.itemId, title: sanitizeStr(d.title, 500) ?? "", year: d.year, overview: sanitizeStr(d.overview), contentRating: sanitizeStr(d.contentRating, 50), communityRating: d.communityRating, addedAt: d.addedAt }));
        const tvRows    = Array.from(jfTvIds.entries()).map(([tmdbId, d])    => ({ tmdbId, mediaType: "TV"    as const, filePath: d.filePath, jellyfinItemId: d.itemId, title: sanitizeStr(d.title, 500) ?? "", year: d.year, overview: sanitizeStr(d.overview), contentRating: sanitizeStr(d.contentRating, 50), communityRating: d.communityRating, addedAt: d.addedAt }));
        // Advisory lock 2001,2 — matches /api/sync/jellyfin so the two callers can't race the same write.
        await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(2001, 2)`;
          await tx.jellyfinLibraryItem.deleteMany();
          if (movieRows.length > 0) await batchCreateMany(tx.jellyfinLibraryItem, movieRows);
          if (tvRows.length    > 0) await batchCreateMany(tx.jellyfinLibraryItem, tvRows);
        }, { timeout: BATCH_TX_TIMEOUT });
        jellyfinSyncSucceeded = true;
        // Stamp last-success timestamp so the notify-fallback (below) can detect a stale source.
        await prisma.setting.upsert({
          where: { key: "lastJellyfinSyncSucceededAt" },
          update: { value: String(Date.now()) },
          create: { key: "lastJellyfinSyncSucceededAt", value: String(Date.now()) },
        }).catch((err) => console.error("[sync] failed to stamp lastJellyfinSyncSucceededAt:", err));

        const jfSeriesMap = new Map<string, number>();
        for (const [tmdbId, data] of jfTvIds) {
          if (data.itemId) jfSeriesMap.set(data.itemId, tmdbId);
        }
        try {
          // Full replace: clear then insert (see the Plex block above). getJellyfinTVEpisodes
          // throws on a fetch failure (caught below → no clear), so an empty result here is a
          // genuinely-empty library and the stale episode ownership should be cleared.
          const episodes = await getJellyfinTVEpisodes(baseUrl, apiKey, selectedJellyfinIds, jfSeriesMap);
          const episodeRows = episodes.map((e) => ({ source: "jellyfin" as const, ...e }));
          await prisma.$transaction(async (tx) => {
            // Advisory lock 2002,2 — Jellyfin counterpart; same coordination contract as 2002,1.
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(2002, 2)`;
            await tx.tVEpisodeCache.deleteMany({ where: { source: "jellyfin" } });
            if (episodeRows.length > 0) await batchCreateMany(tx.tVEpisodeCache, episodeRows);
          }, { timeout: BATCH_TX_TIMEOUT });
        } catch (err) {
          console.error("[sync] Jellyfin TV episode cache failed:", err);
        }
      } catch (err) {
        console.error("[sync] Jellyfin check failed:", err);
      }
    })(),
  ]);
  for (const result of syncResults) {
    if (result.status === "rejected") {
      console.error("[sync] Unexpected top-level sync rejection:", result.reason);
    }
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
  const plexConfiguredEnabled = plexEnabled && !!(plexConfig.url && plexConfig.token);
  const jellyfinConfiguredEnabled = jellyfinEnabled && !!(jellyfinConfig.url && jellyfinConfig.apiKey);
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
    const inArr = req.mediaType === "MOVIE"
      ? inRadarrSet.has(vkey(req.tmdbId, req.arrInstance))
      : inSonarrSet.has(vkey(req.tmdbId, req.arrInstance));
    // Only count a source's map as authoritative-present when it actually synced.
    const inLibrary = req.mediaType === "MOVIE"
      ? (plexSyncSucceeded && plexMovieIds.has(req.tmdbId)) || (jellyfinSyncSucceeded && jfMovieIds.has(req.tmdbId))
      : (plexSyncSucceeded && plexTvIds.has(req.tmdbId))    || (jellyfinSyncSucceeded && jfTvIds.has(req.tmdbId));
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

  const markLibraryRequests = async (
    movieIds: Map<number, unknown>,
    tvIds: Map<number, unknown>,
    source: "plex" | "jellyfin",
  ): Promise<number> => {
    const toMark = stillPending.filter((req) =>
      req.mediaType === "MOVIE" ? movieIds.has(req.tmdbId) : tvIds.has(req.tmdbId)
    );
    if (toMark.length === 0) return 0;

    // Re-fetch notifiedAvailable to catch any updates the concurrent Plex pass may have committed
    const freshRows = await prisma.mediaRequest.findMany({
      where: { id: { in: toMark.map((r) => r.id) } },
      select: { id: true, notifiedAvailable: true },
    });
    const alreadyNotifiedIds = new Set(freshRows.filter((r) => r.notifiedAvailable).map((r) => r.id));

    const unnotified = toMark.filter((r) => !alreadyNotifiedIds.has(r.id));
    if (unnotified.length > 0) {

      const userRows = await prisma.user.findMany({
        where: { id: { in: unnotified.map((r) => r.requestedBy) } },
        select: { id: true, mediaServer: true },
      });
      const userMediaServer = new Map(userRows.map((u) => [u.id, u.mediaServer]));

      // Users with a mediaServer preference only get notified by their preferred source;
      // users with no preference get notified by whichever source sees the item first
      const toNotify = unnotified.filter((r) => {
        const ms = userMediaServer.get(r.requestedBy) ?? null;
        return !ms || ms === source;
      });

      // Mark available without notifying users whose preferred server is a different source
      const toMarkOnly = unnotified.filter((r) => {
        const ms = userMediaServer.get(r.requestedBy) ?? null;
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
    const plexConfigured = !!(plexConfig.url && plexConfig.token);
    const jellyfinConfigured = !!(jellyfinConfig.url && jellyfinConfig.apiKey);

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
    const plexStale = plexConfigured && !plexSyncSucceeded &&
      lastPlexSuccessAt != null && (nowMs - lastPlexSuccessAt) > STALE_SYNC_FALLBACK_MS;
    const jellyfinStale = jellyfinConfigured && !jellyfinSyncSucceeded &&
      lastJellyfinSuccessAt != null && (nowMs - lastJellyfinSuccessAt) > STALE_SYNC_FALLBACK_MS;

    const userRows = await prisma.user.findMany({
      where: { id: { in: pendingAvailableNotify.map((r) => r.requestedBy) } },
      select: { id: true, mediaServer: true },
    });
    const userMediaServer = new Map(userRows.map((u) => [u.id, u.mediaServer]));

    // Collect candidate ids, then do a single CAS updateMany + a single notify per channel
    // rather than one-DB-roundtrip-per-request and one-notify-call-per-request.
    const toNotify: typeof pendingAvailableNotify = [];
    for (const req of pendingAvailableNotify) {
      const ms = userMediaServer.get(req.requestedBy) ?? null;
      const inPlex = req.mediaType === "MOVIE" ? plexMovieIds.has(req.tmdbId) : plexTvIds.has(req.tmdbId);
      const inJellyfin = req.mediaType === "MOVIE" ? jfMovieIds.has(req.tmdbId) : jfTvIds.has(req.tmdbId);
      // Use sync success flags rather than configured flags so a failed sync doesn't trigger false notifications.
      // 24h-stale fallback (above) also flips dataValid TRUE so the other source can satisfy alone.
      const plexDataValid = plexSyncSucceeded || !plexConfigured || plexStale;
      const jellyfinDataValid = jellyfinSyncSucceeded || !jellyfinConfigured || jellyfinStale;
      const shouldNotify = !ms
        ? inPlex || inJellyfin || (plexDataValid && jellyfinDataValid && !plexConfigured && !jellyfinConfigured)
        : ms === "plex"
        ? inPlex || (plexDataValid && !plexConfigured && (inJellyfin || (jellyfinDataValid && !jellyfinConfigured)))
        : ms === "jellyfin"
        ? inJellyfin || (jellyfinDataValid && !jellyfinConfigured && (inPlex || (plexDataValid && !plexConfigured)))
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
    await prisma.tmdbCache.deleteMany({
      where: { expiresAt: { lt: new Date() } },
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
