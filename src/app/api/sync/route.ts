import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  addMovieToRadarr,
  addSeriesToSonarr,
} from "@/lib/arr";
import { refreshArrCache } from "@/lib/arr-cache-refresh";
import { getPlexTmdbIds, getPlexLibrarySections, getPlexTVEpisodes, type PlexLibraryItemData, type PlexTVEpisodeData, type PlexLegacyGuidRef } from "@/lib/plex";
import { resolvePlexLegacyGuids, mergeResolvedLegacyItems } from "@/lib/plex-legacy-resolve";
import { getPlexConfig } from "@/lib/plex-config";
import { buildSeriesItemIdIndex, getJellyfinSyncFolders, getJellyfinTmdbIds, getJellyfinTVEpisodes, type JellyfinLibraryItemData, type JellyfinTVEpisodeData } from "@/lib/jellyfin";
import { getJellyfinConfig } from "@/lib/jellyfin-config";
import { getMediaInstances, getSyncableMediaInstances, type MediaInstanceConfig } from "@/lib/media-instance-registry";
import { DEFAULT_MEDIA_INSTANCE, plexSettingKey, jellyfinSettingKey } from "@/lib/media-instances";
import { syncDownloadPolicies } from "@/lib/download-policy";
import { runDownloadCheck } from "@/lib/download-check";
import { logAudit } from "@/lib/audit";
import { getCronActor, type CronActor } from "@/lib/cron-auth";
import { CRON_DEGRADED_HEADER, cronSkippedResponse, withCronRunRecording } from "@/lib/cron-history";
import { patchPlexShowFilePaths, replacePlexLibraryForInstances, replaceJellyfinLibraryForInstances, type PlexLibraryRow, type JellyfinLibraryRow } from "@/lib/library-staging";
import { replaceEpisodeCacheForSource } from "@/lib/episode-cache";
import { arrRowKey, sonarrIncompleteKeys } from "@/lib/arr-availability";
import { isFeatureEnabled } from "@/lib/features";
import { withAdvisoryLock, SYNC_ORCHESTRATOR_LOCK_ID, DOWNLOAD_POLICIES_LOCK_ID } from "@/lib/advisory-lock";
import { claimAvailableNotifications, clearDeletionVotesForTmdbs } from "@/lib/notify-available";
import { fanOutAvailableWinners } from "@/lib/request-notifications";
import {
  PENDING_REQUEST_SELECT,
  claimAndAnnounce,
  createRequesterCache,
  fallbackShouldNotify,
  flipToAvailable,
  inLibrary,
  markAvailableFromLibrary,
  readPendingRequests,
  requesterPermissions,
  withoutSonarrHeld,
  type LibrarySource,
  type PendingRequest,
} from "@/lib/available-marking";
import { parseLibrarySelection, stampLibrarySyncSuccess } from "@/lib/library-resync";
import { getArrInstances } from "@/lib/arr-instance-registry";
import { DEFAULT_ARR_INSTANCE, FOURK_ARR_INSTANCE } from "@/lib/arr-instances";
import { parseMediaServerGrants } from "@/lib/permissions";
import { visibleInstancesFor, type VisibleServerInstances } from "@/lib/media-visibility";
import { deduplicatePlexRowsByRatingKey } from "@/lib/plex-dedupe";
import { plexLibraryRow, jellyfinLibraryRow } from "@/lib/library-rows";
import { warnOnChange, forgetWarnOnChange } from "@/lib/log-dedup";
import { plexHoldNeedsCounts, plexHoldReason } from "@/lib/plex-sync-guard";
import { jellyfinHoldNeedsCounts, jellyfinHoldReason } from "@/lib/jellyfin-sync-guard";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import type { Translator } from "@/lib/i18n/translate";
import { SERVE_STALE_DETAILS_WHERE, SERVE_STALE_RATINGS_WHERE } from "@/lib/tmdb-cache";

// SYNC_ORCHESTRATOR_LOCK_ID (2000, advisory-lock.ts) — distinct from every other cron's id.
// An advisory lock is a Postgres-held named mutex. Held for the entire orchestrator run so a
// second concurrent invocation (admin "Resync" while the cron POST is mid-flight) returns
// immediately with skipped=true rather than racing the shared-state writes (notifiedAvailable
// CAS, library tables, MediaRequest status updates).

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
// Shared with getCache's lazy delete (tmdb-cache.ts), which skips the same
// namespaces, so the two can't drift.
const STALE_RATINGS_KEY_PREFIXES = SERVE_STALE_RATINGS_WHERE;

// The `:details` blobs are a serve-stale surface too: the admin dashboard reads
// them via getCacheStaleMany and the library prewarm's carry-forward reads the
// previous row at rewrite time — an immediate purge collapses both to cold
// misses within one SYNC_INTERVAL of expiry. A shorter grace than the ratings
// namespaces keeps table growth modest. The endsWith pin keeps every sibling
// namespace (credits, suggestions, seasons, the `:details:missing` prewarm
// tombstones) expiring immediately.
const STALE_DETAILS_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_DETAILS_KEY_SHAPES = SERVE_STALE_DETAILS_WHERE;

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
const vkey = arrRowKey;

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

// Inverse of addPresence, for ids the ratingKey dedupe dropped from an
// instance's written rows: remove that instance's contribution and, when no
// other instance still holds the id, the union entry itself. Without this the
// marking pass reads ids the written rows don't contain — flipping requests
// AVAILABLE (and notifying) for titles every badge reader calls missing, and
// permanently so, since conflations are stable properties of the library.
const removePresence = <V>(
  slugs: Map<number, Set<string>>,
  ids: Map<number, V>,
  tmdbId: number,
  slug: string,
): void => {
  const holders = slugs.get(tmdbId);
  holders?.delete(slug);
  if (!holders || holders.size === 0) {
    slugs.delete(tmdbId);
    ids.delete(tmdbId);
  }
};

// tmdbIds present in `input` but absent from `kept` (both carry one row per tmdbId).
const droppedTmdbIds = <T extends { tmdbId: number }>(input: T[], kept: T[]): number[] => {
  if (kept.length === input.length) return [];
  const keptSet = new Set(kept.map((r) => r.tmdbId));
  return input.filter((r) => !keptSet.has(r.tmdbId)).map((r) => r.tmdbId);
};

export async function POST(request: NextRequest) {
  const t = translatorForRequest(request);
  const actor = await getCronActor(request);
  if (!actor) {
    return NextResponse.json({ error: t("apiAdmin.common.forbidden") }, { status: 403 });
  }

  return withCronRunRecording("sync:full", () => withAdvisoryLock(
    SYNC_ORCHESTRATOR_LOCK_ID,
    (signal: AbortSignal) => runSyncOrchestrator(actor, t, signal),
    // X-Cron-Skipped keeps a busy answer out of the sync:full ledger (no run
    // happened). Same 200 and body: internal-trigger reads `skipped: true`.
    () => cronSkippedResponse("sync already running"),
  ));
}

// One run, phase by phase. Each phase below is a function of what the earlier
// phases returned; this sequencer is the ONLY place the order lives, and the only
// place the lock-loss check (windDownBefore) runs between phases (guardrail 41).
// The order is load-bearing:
//   - the first ARR pass reads the cache as it stood at run start; the refresh
//     then rewrites it, and the second pass reads the FRESH cache;
//   - the download-check backstop runs after the second pass (a title that
//     imported since the last tick is in neither the queue nor the old cache);
//   - the revert runs after the library writes (it needs this run's union) and
//     BEFORE marking, and marking reads ONE stillPending snapshot that both the
//     Plex and the Jellyfin pass share (guardrail 15);
//   - the AVAILABLE+unnotified fallback runs last.
async function runSyncOrchestrator(actor: CronActor, t: Translator, signal?: AbortSignal): Promise<NextResponse> {
  // withAdvisoryLock aborts the signal at DEFAULT_WORK_TIMEOUT_MS (30 min) and
  // answers its caller at once; it keeps the lock only for a bounded grace while
  // this function winds down, and a dropped lock connection frees the lock in
  // Postgres immediately. It cannot cancel this function (guardrail 41). Left
  // unobserved, a run past either would carry on lock-free while the next
  // trigger acquired the freed lock and started a SECOND concurrent full library
  // sync — two delete-and-replace passes over the same tables (guardrail 13).
  // Real runs have exceeded 10 minutes, so the margin is not comfortable.
  //
  // Checked ONLY at arm and phase boundaries, never inside one. Prisma 7's
  // $transaction(fn, opts) takes no AbortSignal, so a mid-transaction bail is not
  // expressible — and stopping between a scoped deleteMany and its repopulate
  // would be far worse than running long.
  //
  // Skipping an arm needs no new downstream handling: its *SyncSucceeded flag
  // simply stays false, which is exactly the state a failed fetch produces and
  // exactly what already gates the revert, re-push and stale-fallback paths.
  // The later PHASES (backstop, re-push, sweeps, revert, marking, notify) are
  // checked too: an abort that lands mid-arm leaves that arm's flags true, and
  // every phase after the arms writes shared state the next run — holding the
  // freed lock — is writing too. On abort the run returns there (never throws).
  let abortLogged = false;
  const windDownBefore = (arm: string): boolean => {
    if (!signal?.aborted) return false;
    if (!abortLogged) {
      abortLogged = true;
      console.warn(
        `[sync] advisory lock lost (timed out or its connection dropped) — winding down before the ${arm} step; ` +
          "the remaining steps are skipped and this run's partial state stands",
      );
    }
    return true;
  };
  const startTime = Date.now();

  const [approved, available] = await readSnapshot();

  let marked = 0;
  let reverted = 0;
  let repushed = 0;
  // The answer for a run that stopped at a phase boundary (see windDownBefore).
  // Degraded, so withCronRunRecording records it red.
  const windDownResponse = (): NextResponse => NextResponse.json(
    {
      checked: { approved: approved.length, available: available.length },
      marked,
      reverted,
      repushed,
      windDown: true,
      error: t("apiAdmin.sync.windDown"),
    },
    { headers: { [CRON_DEGRADED_HEADER]: "wind-down" } },
  );
  // Read BEFORE the first ARR pass: a disabled integration's cache is never
  // cleared (the refresh just stops), so its last-synced rows must not mark
  // anything available — the second pass and the revert are gated the same way.
  const flags = await readSyncFlags();

  const first = await firstArrPass(approved, flags);
  marked = first.marked;

  // Refresh Radarr/Sonarr caches BEFORE the AVAILABLE→APPROVED revert below. The revert reads
  // radarr/sonarr {Available,Wanted}Item — if those tables are stale from a prior failed run,
  // a fresh tick that also fails would mass-demote everything. We only consult the cache for
  // the revert decision when the current run successfully refreshed it.
  const arr = await refreshArrCaches(flags, windDownBefore);

  if (windDownBefore("second ARR pass")) return windDownResponse();
  const second = await secondArrPass(approved, first.arrNotifiedIds, flags, arr);
  marked += second.marked;

  if (windDownBefore("download check")) return windDownResponse();
  await overdueBackstop(approved, first, second);

  if (windDownBefore("re-push")) return windDownResponse();
  repushed = await repushStranded(approved, flags, arr);

  if (windDownBefore("library read")) return windDownResponse();
  const arrPresence = await arrPresenceOfAvailable(available, flags, arr);

  const targets = await readLibraryTargets();
  const { plex, jellyfin } = await syncLibraries(flags, targets, windDownBefore, signal);

  if (windDownBefore("de-registered sweep")) return windDownResponse();
  const registered = await sweepDeregistered();

  if (windDownBefore("revert")) return windDownResponse();
  const coverage = await libraryCoverage(flags, targets, registered);
  const vis = requesterVisibility(targets, plex, jellyfin);
  const revert = await revertAvailable(available, { flags, arr, coverage, plex, jellyfin, arrPresence, vis });
  reverted = revert.reverted;

  if (windDownBefore("library marking")) return windDownResponse();
  const { plexMarked, jellyfinMarked } = await markLibraryPasses(revert.revertedIds, arr, plex, jellyfin, vis);

  if (windDownBefore("pending notify")) return windDownResponse();
  await notifyPendingAvailable(coverage, plex, jellyfin, vis);

  if (windDownBefore("cache purge")) return windDownResponse();
  await purgeExpiredTmdbCache();

  const { radarrWanted, sonarrWanted } = arr;
  const durationMs = Date.now() - startTime;

  // `lastRunAt` observability for /settings?tab=system. The outer withCronRunRecording
  // wrapper writes the Setting row on every run (including throws + non-2xx). The audit
  // row below stays scoped to admin-triggered runs to avoid hourly flooding of the
  // audit table.
  // DB-checked attribution comes from the SAME session read that authorized the
  // request (getCronActor in POST) — a stale/revoked admin JWT can't
  // mis-attribute the audit row, and the verify isn't paid twice. A CRON_SECRET
  // run has no session to attribute, so it writes no audit row.
  if (actor.trigger === "admin") {
    void logAudit({
      userId: actor.userId,
      userName: actor.userName,
      action: "LIBRARY_SYNC",
      target: "sync:full",
      details: { marked, reverted, repushed, plexMarked, jellyfinMarked, radarrWanted, sonarrWanted, durationMs },
    });
  }

  const { failedSources, failedSourceLabels, skippedSources } = runSources(flags, arr, coverage, plex.succeeded, jellyfin.succeeded);

  // Surface degraded runs to withCronRunRecording via the X-Cron-Degraded header,
  // so an enabled source that failed this run shows up on the admin System tab
  // instead of reading green when nothing was refreshed. Status
  // stays 200 (NOT 502) deliberately — the docker entrypoint reschedules non-2xx
  // after CRON_RETRY_INTERVAL (300s), so a 502 during a sustained Radarr/Plex
  // outage would run this full library replace every 5 minutes instead of hourly.
  // The correctness guards above already gate on the *SyncSucceeded flags.
  return NextResponse.json(
    {
      checked: { approved: approved.length, available: available.length },
      marked,
      reverted,
      repushed,
      // Per source, never summed: a title on both servers is counted by each (guardrail 36).
      plexMarked,
      jellyfinMarked,
      radarrWanted,
      sonarrWanted,
      // `error` is what the admin SyncButton surfaces; failedSources is for logs.
      ...(failedSources.length > 0
        ? { failedSources, error: t("apiAdmin.sync.degraded", { sources: failedSourceLabels.join(", ") }) }
        : {}),
      // Both source lists are omitted when empty, matching failedSources above:
      // absent means "nothing skipped", which is the correct reading for an
      // older client that has never heard of the field.
      ...(skippedSources.length > 0 ? { skippedSources } : {}),
    },
    failedSources.length > 0
      ? { headers: { [CRON_DEGRADED_HEADER]: failedSources.join(",") } }
      : undefined,
  );
}

// Which sources this run FAILED and which it never attempted (guardrail 36).
//
// For *arr the *SyncSucceeded flag alone is not the verdict: it stays true when
// only a NAMED instance's fetch failed (the default's rows were still
// rewritten), so the per-instance failed-slug lists are OR'd in. Plex/Jellyfin
// already fold every instance into their flag.
//
// A source that is not configured (or whose feature flag is off) was never
// ATTEMPTED, which is a different thing from failing and must never be painted
// as an error — and a client cannot work it out from the counts, since
// plexMarked/jellyfinMarked are always serialized. For *arr, enabled is
// deliberately NOT "configured": an enabled-but-unconfigured integration still
// sets *SyncSucceeded while refreshing nothing, so the synced-slug set says
// whether any instance was actually there to sync. A source is never BOTH
// failed and skipped: an install whose only configured Radarr is a named
// instance that is down has synced nothing, but it was attempted — the failed
// predicate wins.
function runSources(
  { radarrEnabled, sonarrEnabled }: SyncFlags,
  arr: ArrRefresh,
  { plexConfiguredEnabled, jellyfinConfiguredEnabled }: LibraryCoverage,
  plexSyncSucceeded: boolean,
  jellyfinSyncSucceeded: boolean,
): { failedSources: string[]; failedSourceLabels: string[]; skippedSources: string[] } {
  const radarrFailed = radarrEnabled && (!arr.radarrSyncSucceeded || arr.radarrFailedSlugs.length > 0);
  const sonarrFailed = sonarrEnabled && (!arr.sonarrSyncSucceeded || arr.sonarrFailedSlugs.length > 0);
  const failedSources = [
    ...(radarrFailed ? ["radarr"] : []),
    ...(sonarrFailed ? ["sonarr"] : []),
    ...(plexConfiguredEnabled && !plexSyncSucceeded ? ["plex"] : []),
    ...(jellyfinConfiguredEnabled && !jellyfinSyncSucceeded ? ["jellyfin"] : []),
  ];
  // Human-readable only — the `failedSources` array and the X-Cron-Degraded
  // header stay plain source names (the admin SyncButton and the cron recorder
  // key on them). The slug list says WHICH instance to go look at.
  const slugLabel = (slug: string): string => (slug === DEFAULT_ARR_INSTANCE ? "default" : slug);
  const failedSourceLabels = failedSources.map((source) => {
    const slugs = source === "radarr" ? arr.radarrFailedSlugs : source === "sonarr" ? arr.sonarrFailedSlugs : [];
    return slugs.length > 0 ? `${source} (${slugs.map(slugLabel).join(", ")})` : source;
  });
  const skippedSources = [
    ...(!radarrEnabled || (!radarrFailed && arr.radarrSyncedSlugs.size === 0) ? ["radarr"] : []),
    ...(!sonarrEnabled || (!sonarrFailed && arr.sonarrSyncedSlugs.size === 0) ? ["sonarr"] : []),
    ...(!plexConfiguredEnabled ? ["plex"] : []),
    ...(!jellyfinConfiguredEnabled ? ["jellyfin"] : []),
  ];
  return { failedSources, failedSourceLabels, skippedSources };
}

type SyncFlags = { plexEnabled: boolean; jellyfinEnabled: boolean; radarrEnabled: boolean; sonarrEnabled: boolean };
type WindDown = (arm: string) => boolean;

async function readSyncFlags(): Promise<SyncFlags> {
  const [plexEnabled, jellyfinEnabled, radarrEnabled, sonarrEnabled] = await Promise.all([
    isFeatureEnabled("feature.integration.plex"),
    isFeatureEnabled("feature.integration.jellyfin"),
    isFeatureEnabled("feature.integration.radarr"),
    isFeatureEnabled("feature.integration.sonarr"),
  ]);
  return { plexEnabled, jellyfinEnabled, radarrEnabled, sonarrEnabled };
}

// The run-start snapshots every phase reads (never re-read: a phase that needs
// the live state queries it itself).
function readSnapshot() {
  return Promise.all([
    prisma.mediaRequest.findMany({
      where: { status: "APPROVED" },
      select: { id: true, tmdbId: true, mediaType: true, arrInstance: true, requestedBy: true, title: true, posterPath: true, pendingNotifyAt: true, notifiedAvailable: true },
    }),
    prisma.mediaRequest.findMany({
      where: { status: "AVAILABLE" },
      select: { id: true, tmdbId: true, mediaType: true, arrInstance: true, requestedBy: true, title: true, posterPath: true, notifiedAvailable: true },
    }),
  ]);
}
type Snapshot = Awaited<ReturnType<typeof readSnapshot>>;
type ApprovedRow = Snapshot[0][number];
type AvailableRow = Snapshot[1][number];

// The (tmdbId, arrInstance) keys of the requested titles one Radarr/Sonarr
// available table holds. One `tmdbId IN` read per table (each called once per
// pass over the APPROVED snapshot).
async function arrAvailableKeys(
  rows: readonly { tmdbId: number; mediaType: string }[],
  include: (row: { mediaType: string }) => boolean = () => true,
): Promise<{ movies: Set<string>; tv: Set<string> }> {
  const movieIds = rows.filter((r) => r.mediaType === "MOVIE" && include(r)).map((r) => r.tmdbId);
  const tvIds    = rows.filter((r) => r.mediaType === "TV"    && include(r)).map((r) => r.tmdbId);
  if (movieIds.length === 0 && tvIds.length === 0) return { movies: new Set(), tv: new Set() };
  const movies = new Set<string>();
  const tv = new Set<string>();
  await Promise.all([
    arrKeysIn("radarrAvailableItem", movieIds, movies),
    arrKeysIn("sonarrAvailableItem", tvIds, tv),
  ]);
  return { movies, tv };
}

// ARR-available means "downloaded in Radarr/Sonarr", which is not the same as
// "scanned into the user's preferred Plex/Jellyfin library yet". The ARR passes
// act ONLY on users with no mediaServer preference; a preference-pinned user is
// left APPROVED so the library-marking pass flips + notifies them once the item
// actually appears in their chosen server — no premature "now available" off a
// library they haven't reached.
async function withoutPinnedRequesters<R extends { requestedBy: string }>(rows: R[]): Promise<R[]> {
  const preferred = new Map<string, string | null>();
  for (const ids of inChunks([...new Set(rows.map((r) => r.requestedBy))])) {
    const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, mediaServer: true } });
    for (const u of users) preferred.set(u.id, u.mediaServer);
  }
  return rows.filter((r) => !(preferred.get(r.requestedBy) ?? null));
}

// One ARR-cache marking step, shared by both passes. The unnotified rows go
// through the claim (UPDATE … RETURNING, guardrail 14), so a row a concurrent
// sync/webhook claimed between a read and the update is never double-notified.
// The rest — a request the revert moved back to APPROVED keeps its burned
// claim — flip without re-notifying, but only once their claim IS burned
// (flipToAvailable's onlyNotified). Returns the deliverable winners (already
// announced) and how many rows actually moved.
async function markArrAvailable(rows: ApprovedRow[]): Promise<{ deliverable: ApprovedRow[]; marked: number }> {
  if (rows.length === 0) return { deliverable: [], marked: 0 };
  const unpinned = await withoutPinnedRequesters(rows);
  const { claimed, deliverable } = await claimAndAnnounce(unpinned, "sync");
  const claimedIds = new Set(claimed.map((w) => w.id));
  const flipped = await flipToAvailable(unpinned.filter((r) => !claimedIds.has(r.id)), { onlyNotified: true });
  return { deliverable, marked: claimed.length + flipped };
}

// The first AVAILABLE-marking pass, over the Radarr/Sonarr caches as they stood
// at run start. Returns the ids it announced, the run-start available sets (the
// overdue backstop reads them too) and how many rows it moved.
//
// `arrInstance` rides on every row: the outbound `request.available` event
// names the instance (guardrail 32), and this pass is the normal route to
// AVAILABLE for a 4K/named request — the arr knows about the file before the
// library scan does.
async function firstArrPass(approved: ApprovedRow[], flags: SyncFlags): Promise<{ arrNotifiedIds: Set<string>; availableMovieSet: Set<string>; availableTvSet: Set<string>; marked: number }> {
  const { radarrEnabled, sonarrEnabled } = flags;
  // The sets stay populated whatever the flags say: the overdue backstop reads
  // them, and runDownloadCheck is not flag-gated.
  const { movies: availableMovieSet, tv: availableTvSet } = await arrAvailableKeys(approved);
  const nowAvailableApproved = approved.filter((r) =>
    r.mediaType === "MOVIE"
      ? radarrEnabled && availableMovieSet.has(vkey(r.tmdbId, r.arrInstance))
      : sonarrEnabled && availableTvSet.has(vkey(r.tmdbId, r.arrInstance)),
  );
  const { deliverable, marked } = await markArrAvailable(nowAvailableApproved);
  return { arrNotifiedIds: new Set(deliverable.map((r) => r.id)), availableMovieSet, availableTvSet, marked };
}

// One service's cache refresh, as the run reads it. `configuredSlugs` is
// undefined when the refresh THREW before it learned the configured set: the
// Sonarr completeness gate must then read the registry itself and hold on the
// cached wanted rows (guardrail 14a), never take "no instance" as "nothing is
// held" and flip every TV request off library presence.
type ArrServiceRefresh = {
  wanted: number;
  succeeded: boolean;
  syncedSlugs: Set<string>;
  failedSlugs: string[];
  configuredSlugs: ReadonlySet<string> | undefined;
};
// A service that was not refreshed this run (disabled, or the run wound down):
// nothing synced, nothing configured to hold on.
const arrNotRefreshed = (): ArrServiceRefresh => ({ wanted: 0, succeeded: false, syncedSlugs: new Set(), failedSlugs: [], configuredSlugs: new Set() });

// Every configured instance of the service (default first, plus the legacy 4K
// and any named ones), bounded (guardrail 31). The default is authoritative: if
// its fetch failed the whole cache update is skipped, so a transient default
// outage can't mass-demote AVAILABLE requests. Only instances whose fetch
// succeeded are scoped-cleared and rewritten (guardrail 13), under advisory lock
// 1001,1 / 1001,2 (shared with the webhooks).
async function refreshArrService(service: "radarr" | "sonarr"): Promise<ArrServiceRefresh> {
  const label = service === "radarr" ? "Radarr" : "Sonarr";
  try {
    const refresh = await refreshArrCache(service);
    // failedSlugs: every configured instance whose fetch returned null THIS run.
    // Kept apart from `succeeded` on purpose: that flag means "the step did not
    // blow up" and stays true when only a NAMED instance (legacy 4K, "anime") is
    // down, because the default's rows are still rewritten. Without the list a
    // named-instance outage read green (guardrail 36: a CONFIGURED server that
    // failed is red, never neutral).
    const known = { configuredSlugs: new Set(refresh.configuredSlugs), failedSlugs: refresh.failedSlugs };
    if (refresh.outcome === "default-failed") {
      console.warn(`[sync] skipping ${label} cache update — ARR fetch failed`);
      return { ...arrNotRefreshed(), ...known };
    }
    if (refresh.outcome === "write-failed") {
      console.error(`[sync] ${label} wanted sync failed:`, refresh.error);
      return { ...arrNotRefreshed(), ...known };
    }
    // syncedSlugs: the slugs whose cache THIS run actually refreshed. An
    // enabled-but-UNCONFIGURED integration yields none while `succeeded` is
    // still true (the no-op "sync" didn't fail) — the flag keeps meaning "step
    // didn't blow up" for run reporting, and this set is what the revert and
    // re-push key on, so an empty cache from an unconfigured instance is never
    // read as authoritative absence (the mass AVAILABLE→APPROVED demotion case).
    return { ...known, wanted: refresh.wanted, succeeded: true, syncedSlugs: new Set(refresh.syncedSlugs) };
  } catch (err) {
    console.error(`[sync] ${label} wanted sync failed:`, err);
    return { ...arrNotRefreshed(), configuredSlugs: undefined };
  }
}

// Refreshes the Radarr and Sonarr caches. Each arm is gated on the lock-loss
// check; a skipped or failed arm leaves its *SyncSucceeded false, the state
// every later gate already reads as "this run's cache is not authoritative".
async function refreshArrCaches(flags: SyncFlags, windDownBefore: WindDown) {
  const radarr = flags.radarrEnabled && !windDownBefore("Radarr") ? await refreshArrService("radarr") : arrNotRefreshed();
  // sonarrConfiguredSlugs is every CONFIGURED Sonarr instance (not just the
  // ones whose fetch succeeded) — the completeness gate holds a TV request only
  // on an instance Sonarr is actually the oracle for, and a Sonarr outage this
  // run must still hold (the synced set would drop the slug and let an
  // incomplete series flip off library presence mid-outage).
  const sonarr = flags.sonarrEnabled && !windDownBefore("Sonarr") ? await refreshArrService("sonarr") : arrNotRefreshed();
  return {
    radarrWanted: radarr.wanted,
    radarrSyncSucceeded: radarr.succeeded,
    radarrSyncedSlugs: radarr.syncedSlugs,
    radarrFailedSlugs: radarr.failedSlugs,
    sonarrWanted: sonarr.wanted,
    sonarrSyncSucceeded: sonarr.succeeded,
    sonarrSyncedSlugs: sonarr.syncedSlugs,
    sonarrConfiguredSlugs: sonarr.configuredSlugs,
    sonarrFailedSlugs: sonarr.failedSlugs,
  };
}
type ArrRefresh = Awaited<ReturnType<typeof refreshArrCaches>>;

async function secondArrPass(
  approved: ApprovedRow[],
  arrNotifiedIds: Set<string>,
  flags: SyncFlags,
  arr: ArrRefresh,
): Promise<{ arrNotifiedIds: Set<string>; freshMovieSet: Set<string>; freshTvSet: Set<string>; marked: number }> {
  // Second AVAILABLE-marking pass over the FRESHLY refreshed Radarr/Sonarr caches. The first
  // pass read the cache as it stood at run start; a request that became available in
  // Radarr/Sonarr since the prior tick would otherwise wait a full SYNC_INTERVAL to be marked.
  // Only the rows the first pass did not announce are reconsidered, and only against a cache
  // the current run successfully rewrote. Same step as the first pass (markArrAvailable), so a
  // reverted row whose claim is already burned flips here too instead of waiting a run.
  const radarrFresh = flags.radarrEnabled && arr.radarrSyncSucceeded;
  const sonarrFresh = flags.sonarrEnabled && arr.sonarrSyncSucceeded;
  const stillApprovedForMark = approved.filter((r) => !arrNotifiedIds.has(r.id));
  // Hoisted for the overdue backstop: a file on disk in the FRESH cache means
  // the download finished, whether or not this pass flipped the row.
  const { movies: freshMovieSet, tv: freshTvSet } = await arrAvailableKeys(
    stillApprovedForMark,
    (r) => (r.mediaType === "MOVIE" ? radarrFresh : sonarrFresh),
  );
  const nowAvailableSecond = stillApprovedForMark.filter((r) =>
    r.mediaType === "MOVIE"
      ? radarrFresh && freshMovieSet.has(vkey(r.tmdbId, r.arrInstance))
      : sonarrFresh && freshTvSet.has(vkey(r.tmdbId, r.arrInstance)),
  );
  const { marked } = await markArrAvailable(nowAvailableSecond);
  return { arrNotifiedIds, freshMovieSet, freshTvSet, marked };
}

async function overdueBackstop(
  approved: ApprovedRow[],
  { availableMovieSet, availableTvSet }: { availableMovieSet: Set<string>; availableTvSet: Set<string> },
  { arrNotifiedIds, freshMovieSet, freshTvSet }: { arrNotifiedIds: Set<string>; freshMovieSet: Set<string>; freshTvSet: Set<string> },
): Promise<void> {
  // The pendingNotifyAt BACKSTOP ("did the approval actually start downloading?").
  // It runs AFTER the Radarr/Sonarr refresh and the second marking pass, never
  // before: "not in the download queue" is only "never started" when the title is
  // also not on disk, and a title that imported since the last tick is absent from
  // the queue AND from the run-start cache. Checked earlier, it DMed "hasn't
  // started downloading" moments before the second pass DMed "now available".
  // A row whose (tmdbId, arrInstance) is in EITHER available cache is skipped —
  // that covers the pinned users the ARR passes deliberately leave APPROVED.
  // Each row goes through runDownloadCheck, which re-reads status (a row this run
  // flipped AVAILABLE is dropped) and CONSUMES the backstop with a CAS, so a sweep
  // overlapping a still-running 90s job for the same row DMs once, not twice. It
  // also applies guardrail 33 (a disabled requester's backstop is consumed, no DM).
  const now = new Date();
  const overdue = approved.filter((r) => {
    if (!r.pendingNotifyAt || r.pendingNotifyAt > now) return false;
    if (arrNotifiedIds.has(r.id)) return false;
    const key = vkey(r.tmdbId, r.arrInstance);
    return r.mediaType === "MOVIE"
      ? !availableMovieSet.has(key) && !freshMovieSet.has(key)
      : !availableTvSet.has(key) && !freshTvSet.has(key);
  });
  await runConcurrent(overdue, async (req) => {
    try {
      await runDownloadCheck(
        {
          requestId: req.id,
          tmdbId: req.tmdbId,
          mediaType: req.mediaType as "MOVIE" | "TV",
          arrInstance: req.arrInstance,
          requestedBy: req.requestedBy,
          title: req.title,
        },
        { consumeWhenDownloading: true },
      );
    } catch (err) {
      console.error("[sync] pendingNotifyAt check failed for", req.id, err);
    }
  });
}

// Returns how many re-pushes landed.
async function repushStranded(approved: ApprovedRow[], flags: SyncFlags, arr: ArrRefresh): Promise<number> {
  // Re-push APPROVED requests that never made it into Radarr/Sonarr. The approve-time push
  // can fail when the title has no Radarr/TheTVDB metadata yet (common for not-yet-released
  // titles, e.g. a show that airs in a few weeks); the request is then stranded in APPROVED
  // with nothing retrying it. We act only when the integration is enabled AND this run
  // refreshed its cache — same guard as the revert, so a stale or failed cache can't
  // trigger a mass re-push. A title absent from BOTH the freshly-synced wanted and
  // available sets is genuinely unknown to the *arr, so the earlier add never landed.
  // ARR_REPUSH_BACKOFF_MS gates retries to ~daily (lastArrPushAt is stamped on every
  // attempt, success or fail) so a permanently-unresolvable request doesn't churn hourly.
  const repushCutoff = new Date(Date.now() - ARR_REPUSH_BACKOFF_MS);
  const stillApproved: Array<{ id: string; tmdbId: number; mediaType: string; arrInstance: string; qualityProfileId: number | null; requestedBy: string; createdAt: Date }> = [];
  for (const ids of inChunks(approved.map((r) => r.id))) {
    const rows = await prisma.mediaRequest.findMany({
      where: {
        id: { in: ids },
        status: "APPROVED",
        OR: [{ lastArrPushAt: null }, { lastArrPushAt: { lte: repushCutoff } }],
      },
      select: { id: true, tmdbId: true, mediaType: true, arrInstance: true, qualityProfileId: true, requestedBy: true, createdAt: true },
    });
    for (const r of rows) stillApproved.push(r);
  }
  // Per-slug gate (not the global flag): only re-push a request whose OWN instance's
  // cache was refreshed this run (arrInstanceRefreshed). An unconfigured instance
  // (nothing synced while the flag still reads true) would otherwise put every APPROVED
  // title on that instance into a daily guaranteed-to-fail push attempt; an instance
  // whose fetch failed this run keeps its stale rows, and pushing against state we
  // couldn't read risks re-adding an item that's actually there — both wait for a run
  // that actually synced their instance.
  const candidates = stillApproved.filter((r) => arrInstanceRefreshed(r, flags, arr));
  const movieIds = [...new Set(candidates.filter((r) => r.mediaType === "MOVIE").map((r) => r.tmdbId))];
  const tvIds    = [...new Set(candidates.filter((r) => r.mediaType === "TV").map((r) => r.tmdbId))];
  const knownRadarrSet = new Set<string>();
  const knownSonarrSet = new Set<string>();
  await Promise.all([
    arrKeysIn("radarrAvailableItem", movieIds, knownRadarrSet),
    arrKeysIn("radarrWantedItem", movieIds, knownRadarrSet),
    arrKeysIn("sonarrAvailableItem", tvIds, knownSonarrSet),
    arrKeysIn("sonarrWantedItem", tvIds, knownSonarrSet),
  ]);
  const toRepush = candidates.filter((r) =>
    !(r.mediaType === "MOVIE" ? knownRadarrSet : knownSonarrSet).has(vkey(r.tmdbId, r.arrInstance)),
  );
  const { winners, siblingIds } = repushWinners(toRepush);

  let repushed = 0;
  const pushedAt = new Date();
  await runConcurrent(winners, async (req) => {
    try {
      // Push to the request's own instance — a 4K/named request re-pushed to the
      // default instance would land at the wrong quality.
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
  // Stamp the deduped-out siblings: the winner's add covers their title/variant,
  // so they get the same backoff clock and don't re-enter the re-push query every tick.
  if (siblingIds.length > 0) {
    await prisma.mediaRequest
      .updateMany({ where: { id: { in: siblingIds } }, data: { lastArrPushAt: pushedAt } })
      .catch((err) => console.error("[sync] re-push sibling backoff stamp failed:", err));
  }
  return repushed;
}

// Two users can each hold an APPROVED request for the same (tmdbId, mediaType, variant)
// — an original plus a later mirror-approved row — with different qualityProfileId. If
// the original *arr add never landed, both would race in the same runConcurrent chunk;
// whichever POST wins sets the profile nondeterministically (the *arr holds one item per
// tmdbId). Collapse to a single add per title/variant, preferring the ORIGINAL (earliest
// createdAt, id tie-break) so the chosen profile is stable. The deduped-out siblings
// still get lastArrPushAt stamped so the backoff applies. Pure.
function repushWinners<R extends { id: string; tmdbId: number; mediaType: string; arrInstance: string; createdAt: Date }>(
  rows: readonly R[],
): { winners: R[]; siblingIds: string[] } {
  const winnerByKey = new Map<string, R>();
  const siblingIds: string[] = [];
  for (const r of rows) {
    const k = `${r.mediaType}:${vkey(r.tmdbId, r.arrInstance)}`;
    const existing = winnerByKey.get(k);
    if (!existing) {
      winnerByKey.set(k, r);
    } else if (
      r.createdAt < existing.createdAt ||
      (r.createdAt.getTime() === existing.createdAt.getTime() && r.id < existing.id)
    ) {
      siblingIds.push(existing.id);
      winnerByKey.set(k, r);
    } else {
      siblingIds.push(r.id);
    }
  }
  return { winners: [...winnerByKey.values()], siblingIds };
}

// Whether this run refreshed the request's OWN Radarr/Sonarr instance, with its
// integration enabled — the only requests whose arr cache state the run may act
// on (re-push, revert). Any other row's cache is never consulted, so neither the
// presence reads below nor the revert's requester read pay for it.
function arrInstanceRefreshed(req: { mediaType: string; arrInstance: string }, { radarrEnabled, sonarrEnabled }: SyncFlags, arr: ArrRefresh): boolean {
  return req.mediaType === "MOVIE"
    ? radarrEnabled && arr.radarrSyncedSlugs.has(req.arrInstance)
    : sonarrEnabled && arr.sonarrSyncedSlugs.has(req.arrInstance);
}

// The available-request history only grows, so these `tmdbId IN` reads are
// chunked: one statement stays far below Postgres's bind-parameter limit
// (guardrail 23c). Chunks are read one after another.
const ARR_PRESENCE_CHUNK = 5_000;

// `ids` split into runs that each fit one statement.
function inChunks<T>(ids: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += ARR_PRESENCE_CHUNK) out.push(ids.slice(i, i + ARR_PRESENCE_CHUNK));
  return out;
}

async function arrKeysIn(
  table: "radarrAvailableItem" | "radarrWantedItem" | "sonarrAvailableItem" | "sonarrWantedItem",
  tmdbIds: number[],
  into: Set<string>,
): Promise<void> {
  for (let i = 0; i < tmdbIds.length; i += ARR_PRESENCE_CHUNK) {
    const where = { tmdbId: { in: tmdbIds.slice(i, i + ARR_PRESENCE_CHUNK) } };
    const rows = table === "radarrAvailableItem" ? await prisma.radarrAvailableItem.findMany({ where })
      : table === "radarrWantedItem" ? await prisma.radarrWantedItem.findMany({ where })
      : table === "sonarrAvailableItem" ? await prisma.sonarrAvailableItem.findMany({ where })
      : await prisma.sonarrWantedItem.findMany({ where });
    for (const r of rows) into.add(vkey(r.tmdbId, r.arrInstance));
  }
}

// Which revertable AVAILABLE rows' titles Radarr/Sonarr still hold (available
// or wanted), for the revert.
async function arrPresenceOfAvailable(available: AvailableRow[], flags: SyncFlags, arr: ArrRefresh): Promise<{ inRadarrSet: Set<string>; inSonarrSet: Set<string> }> {
  const revertable = available.filter((r) => arrInstanceRefreshed(r, flags, arr));
  const movieIds = [...new Set(revertable.filter((r) => r.mediaType === "MOVIE").map((r) => r.tmdbId))];
  const tvIds    = [...new Set(revertable.filter((r) => r.mediaType === "TV").map((r) => r.tmdbId))];
  const inRadarrSet = new Set<string>();
  const inSonarrSet = new Set<string>();
  await Promise.all([
    arrKeysIn("radarrAvailableItem", movieIds, inRadarrSet),
    arrKeysIn("radarrWantedItem", movieIds, inRadarrSet),
    arrKeysIn("sonarrAvailableItem", tvIds, inSonarrSet),
    arrKeysIn("sonarrWantedItem", tvIds, inSonarrSet),
  ]);
  return { inRadarrSet, inSonarrSet };
}
type ArrPresence = Awaited<ReturnType<typeof arrPresenceOfAvailable>>;

// The configured servers and each one's own library selection.
async function readLibraryTargets(): Promise<{
  plexInstances: MediaInstanceConfig[];
  jellyfinInstances: MediaInstanceConfig[];
  librarySelections: Map<string, Set<string> | undefined>;
}> {
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
  for (const row of selectionRows) librarySelections.set(row.key, parseLibrarySelection(row.value));
  return { plexInstances, jellyfinInstances, librarySelections };
}
type LibraryTargets = Awaited<ReturnType<typeof readLibraryTargets>>;

// What one library arm (Plex or Jellyfin) produced, filled in as it runs.
// The union maps say "is this tmdbId on any configured server of the type";
// the *Slugs maps say WHICH servers hold it (the per-user visibility gate
// needs that). Same key set as the union by construction — both are filled
// from the same per-instance loop. `succeeded`: every configured instance's
// fetch AND the write succeeded this run (a COMPLETE picture).
interface LibraryArm<D> {
  movieIds: Map<number, D>;
  tvIds: Map<number, D>;
  movieSlugs: Map<number, Set<string>>;
  tvSlugs: Map<number, Set<string>>;
  succeeded: boolean;
}
function emptyLibraryArm<D>(): LibraryArm<D> {
  return { movieIds: new Map(), tvIds: new Map(), movieSlugs: new Map(), tvSlugs: new Map(), succeeded: false };
}

// Union each fetched server into the arm's shared maps — downstream only asks
// "is this tmdbId in the map", so a plain per-key merge is correct whichever
// instance's value wins a collision. The parallel `*Slugs` maps record WHICH
// instance contributed each key: the collision-winner is arbitrary, so it
// cannot answer "does the requester see a server that actually holds this
// title" once an instance is restricted. Filled here, while the per-instance
// results are still separate.
function unionIntoArm<D>(arm: LibraryArm<D>, writable: readonly { slug: string; movieIds: Map<number, D>; tvIds: Map<number, D> }[]): void {
  for (const { slug, movieIds, tvIds } of writable) {
    for (const [tmdbId, d] of movieIds) {
      arm.movieIds.set(tmdbId, d);
      addPresence(arm.movieSlugs, tmdbId, slug);
    }
    for (const [tmdbId, d] of tvIds) {
      arm.tvIds.set(tmdbId, d);
      addPresence(arm.tvSlugs, tmdbId, slug);
    }
  }
}

// A failed library write: this run's union is not authoritative (the same
// signal demotion already keys off). The maps were filled BEFORE the
// transaction, so they are dropped — no later reader may treat a rolled-back
// write as library presence.
function clearArm(arm: LibraryArm<unknown>): void {
  arm.movieIds.clear();
  arm.tvIds.clear();
  arm.movieSlugs.clear();
  arm.tvSlugs.clear();
}

// Plex and Jellyfin library writes + download-policy enforcement run
// concurrently. Each arm never throws for a server failure (that server simply
// contributes nothing); a rejection here is a bug, logged and otherwise read as
// that arm contributing nothing. `signal` is the run's lock: the Plex walks
// take it, so a lost lock stops them mid-listing (guardrail 41).
async function syncLibraries(flags: SyncFlags, targets: LibraryTargets, windDownBefore: WindDown, signal: AbortSignal | undefined) {
  const plex = emptyLibraryArm<PlexLibraryItemData>();
  const jellyfin = emptyLibraryArm<JellyfinLibraryItemData>();
  const results = await Promise.allSettled([
    // DOWNLOAD_POLICIES_LOCK_ID serializes against the standalone /api/cron/sync-download-policies
    // run, whose read-then-reconcile prune would otherwise race this one. If that cron currently
    // holds the lock, skip the redundant pass — it will reconcile on its own.
    withAdvisoryLock(
      DOWNLOAD_POLICIES_LOCK_ID,
      () => syncDownloadPolicies(),
      () => [],
    ),
    syncPlexLibraries(flags, targets, plex, windDownBefore, signal),
    syncJellyfinLibraries(flags, targets, jellyfin, windDownBefore),
  ]);
  for (const result of results) {
    if (result.status === "rejected") {
      console.error("[sync] Unexpected top-level sync rejection:", result.reason);
    }
  }
  return { plex, jellyfin };
}

type PlexFetched = {
  slug: string;
  result: {
    serverUrl: string;
    token: string;
    sections: Awaited<ReturnType<typeof getPlexLibrarySections>>;
    movieIds: Map<number, PlexLibraryItemData>;
    tvIds: Map<number, PlexLibraryItemData>;
    ratingKeyToTmdb: Map<string, number[]>;
  } | null;
};

// A Plex hold's warn-once signature and message (guardrail 7b: the same hold
// restates itself every run). Rules: plex-sync-guard.ts.
function plexHoldWarning(slug: string, hold: NonNullable<ReturnType<typeof plexHoldReason>>): { signature: string; message: string } {
  const noun = (mediaType: "MOVIE" | "TV", plural: boolean) => (mediaType === "MOVIE" ? (plural ? "movies" : "movie") : (plural ? "shows" : "show"));
  if (hold.kind === "missing-section") {
    return {
      signature: `missing:${hold.mediaType}:${hold.keys.join(",")}`,
      message: `[sync] Plex instance "${slug}" returned no ${noun(hold.mediaType, true)} and a selected library is no longer on the server (section ${hold.keys.join(", ")}) — keeping its stored rows (a library recreated in Plex gets a new key: tick it in the Plex library settings; if it was removed on purpose, Resync the Plex source)`,
    };
  }
  if (hold.kind === "empty-type") {
    return {
      signature: `empty:${hold.mediaType}`,
      message: `[sync] Plex instance "${slug}" returned no ${noun(hold.mediaType, true)} but has stored ${noun(hold.mediaType, false)} rows — keeping them (check whether Plex is still scanning; Resync clears a library that really was emptied)`,
    };
  }
  return {
    signature: "empty",
    message: `[sync] Plex instance "${slug}" returned no movies or shows but has stored library rows — keeping them (check the selected libraries, or whether Plex is still scanning)`,
  };
}

// One Plex server's fetch: sections, the movie and show walks (with
// legacy-agent resolution), then the short-answer hold. `result: null` is a
// failed or held server — its stored rows stay, and the run is not a complete
// picture. A walk the lock's abort ended rejects (never a partial library) and
// lands here the same way. Never throws.
async function fetchPlexInstance(
  instance: MediaInstanceConfig,
  librarySelections: LibraryTargets["librarySelections"],
  signal: AbortSignal | undefined,
): Promise<PlexFetched> {
  try {
    const cfg = await getPlexConfig(instance.slug);
    if (!cfg.url || !cfg.token) return { slug: instance.slug, result: null }; // defensive; getSyncableMediaInstances already filters to configured ones
    const serverUrl = cfg.url.replace(/\/$/, "");
    const token = cfg.token;
    const sections = await getPlexLibrarySections(serverUrl, token, signal);
    // Respect the admin's selected Plex libraries — THIS server's own selection
    // (a section key is server-local). Without it the scheduled full sync
    // ingested EVERY section, marking media in an excluded library as owned.
    const selectedPlexKeys = librarySelections.get(plexSettingKey(instance.slug, "Libraries"));
    // ratingKeyToTmdb accumulates the show walk's ratingKey→ids mapping so the
    // episode pass reuses this type=2 listing instead of re-paging every show
    // section (per-instance — ratingKeys are server-local). The legacy maps
    // collect pre-2020-agent items (thetvdb://, imdb:// guids) for best-effort
    // tmdb resolution.
    const ratingKeyToTmdb = new Map<string, number[]>();
    const movieLegacy = new Map<string, PlexLegacyGuidRef>();
    const tvLegacy = new Map<string, PlexLegacyGuidRef>();
    // The show rows come back pathless (a show item carries no file); the
    // episode walk that follows captures the paths from the type=4 listing and
    // patches them onto the rows post-write (writePlexEpisodeCache).
    const [movieIds, tvIds] = await Promise.all([
      getPlexTmdbIds(serverUrl, token, "MOVIE", { selectedKeys: selectedPlexKeys, sections, legacyOut: movieLegacy, signal }),
      getPlexTmdbIds(serverUrl, token, "TV", {
        selectedKeys: selectedPlexKeys,
        sections,
        ratingKeyToTmdbOut: ratingKeyToTmdb,
        legacyOut: tvLegacy,
        signal,
      }),
    ]);
    // Resolve + merge legacy-agent items (self-catching, never throws): a
    // resolution failure degrades those items to their previous invisibility
    // rather than failing the instance's fetch.
    const [resolvedMovies, resolvedTv] = await Promise.all([
      resolvePlexLegacyGuids(movieLegacy, "MOVIE"),
      resolvePlexLegacyGuids(tvLegacy, "TV"),
    ]);
    mergeResolvedLegacyItems(resolvedMovies, movieIds);
    mergeResolvedLegacyItems(resolvedTv, tvIds, ratingKeyToTmdb);
    // A SHORT answer for a server we already hold rows for is not a complete
    // picture: a saved selection naming a library Plex recreated under a new
    // key, or a Plex that is mid-scan or just started, comes back with one type
    // (or both) empty and no error. Treated as a success it would wipe those
    // rows and demote AVAILABLE requests. Hold the instance back like a failed
    // fetch (its rows stay, the run is not stamped clean); a library that really
    // was emptied is cleared by the admin's Resync on the Plex source.
    const holdInput = { selectedKeys: selectedPlexKeys, sections, movieCount: movieIds.size, tvCount: tvIds.size };
    const warnKey = `sync:plex-empty:${instance.slug}`;
    if (plexHoldNeedsCounts(holdInput)) {
      const [heldMovieRows, heldTvRows] = await Promise.all([
        prisma.plexLibraryItem.count({ where: { serverInstance: instance.slug, mediaType: "MOVIE" } }),
        prisma.plexLibraryItem.count({ where: { serverInstance: instance.slug, mediaType: "TV" } }),
      ]);
      const hold = plexHoldReason({ ...holdInput, heldMovieRows, heldTvRows });
      if (hold) {
        const { signature, message } = plexHoldWarning(instance.slug, hold);
        warnOnChange(warnKey, signature, message);
        return { slug: instance.slug, result: null };
      }
    }
    forgetWarnOnChange(warnKey);
    return { slug: instance.slug, result: { serverUrl, token, sections, movieIds, tvIds, ratingKeyToTmdb } };
  } catch (err) {
    // A lost lock is not a Plex failure: the run's wind-down notice says why.
    if (!signal?.aborted) console.error(`[sync] Plex check failed for instance "${instance.slug}":`, err);
    return { slug: instance.slug, result: null };
  }
}

// The Plex arm: fetch every configured server, union their titles into `arm`,
// write each server's rows (staged swap), then the episode cache. Never throws
// for a server failure — that server simply contributes nothing.
//
// Unlike arr, there's no per-request instance to attribute a fetch failure to —
// availability is a union across all configured servers (see
// media-instances.ts) — so `arm.succeeded` (read by the revert and the
// stale-fallback, which need this run's union to be a COMPLETE picture)
// requires every configured instance's fetch AND the write to have succeeded.
async function syncPlexLibraries(
  flags: SyncFlags,
  { plexInstances, librarySelections }: LibraryTargets,
  arm: LibraryArm<PlexLibraryItemData>,
  windDownBefore: WindDown,
  signal: AbortSignal | undefined,
): Promise<void> {
  // Same shape as the not-enabled return, deliberately: an arm that
  // contributes nothing leaves `succeeded` false, and every consumer already
  // treats that as "this run's union is not a complete picture".
  if (windDownBefore("Plex library")) return;
  if (!flags.plexEnabled || plexInstances.length === 0) return;

  const fetched = await Promise.all(plexInstances.map((instance) => fetchPlexInstance(instance, librarySelections, signal)));
  // Guardrail 41, at the arm's fetch → write boundary: a lock lost while the
  // walks ran (an instance whose walk had already finished included) writes
  // nothing. The arm contributes nothing, exactly like a failed fetch — every
  // server's stored rows stay — and the sequencer winds the run down (and says
  // so) at its next phase boundary.
  if (signal?.aborted) return;
  const writable = fetched.flatMap((f) => (f.result ? [{ slug: f.slug, ...f.result }] : []));
  unionIntoArm(arm, writable);

  let libraryWriteSucceeded = true;
  if (writable.length > 0) {
    try {
      // Rows are built + deduped per instance BEFORE the transaction (the dedupe is
      // a DB read; doing it in-tx would hold the advisory lock across it for nothing).
      // Dedupe runs per instance batch (never across instances): two servers reusing
      // the same small integer ratingKey is legitimate, not conflation (guardrail 37b).
      const rowsByInstance = await Promise.all(
        writable.map(async ({ slug, movieIds, tvIds }) => {
          const movieRows = Array.from(movieIds.entries()).map(([tmdbId, d]) => plexLibraryRow(tmdbId, d, "MOVIE", slug));
          const tvRows    = Array.from(tvIds.entries()).map(([tmdbId, d])    => plexLibraryRow(tmdbId, d, "TV", slug));
          const finalMovieRows = await deduplicatePlexRowsByRatingKey(movieRows, "MOVIE", slug, "sync");
          const finalTvRows    = await deduplicatePlexRowsByRatingKey(tvRows, "TV", slug, "sync");
          return {
            slug,
            finalMovieRows,
            finalTvRows,
            droppedMovieIds: droppedTmdbIds(movieRows, finalMovieRows),
            droppedTvIds:    droppedTmdbIds(tvRows, finalTvRows),
          };
        }),
      );
      // The union above was filled from the RAW fetch maps; reconcile it with
      // what dedupe actually kept, so the marking pass can never announce an
      // id that has no library row.
      for (const { slug, droppedMovieIds, droppedTvIds } of rowsByInstance) {
        for (const tmdbId of droppedMovieIds) removePresence(arm.movieSlugs, arm.movieIds, tmdbId, slug);
        for (const tmdbId of droppedTvIds)    removePresence(arm.tvSlugs,    arm.tvIds,    tmdbId, slug);
      }
      // Staged swap (replacePlexLibraryForInstances): the rows are bulk-loaded
      // into PlexLibraryItemStaging OUTSIDE any transaction, then swapped across
      // under advisory lock 2001,1 (shared with /api/sync/plex so the two callers
      // can't race the same write) in a transaction that holds only the
      // per-instance scoped deletes and one INSERT ... SELECT. Only instances
      // whose fetch succeeded are touched at all (guardrail 13 — a failed
      // instance's existing rows are left intact, never wiped).
      await replacePlexLibraryForInstances(
        rowsByInstance.map(({ slug, finalMovieRows, finalTvRows }) => ({ slug, rows: (finalMovieRows as PlexLibraryRow[]).concat(finalTvRows) })),
      );
    } catch (err) {
      console.error("[sync] Plex library write failed:", err);
      libraryWriteSucceeded = false;
      clearArm(arm);
    }
  }

  arm.succeeded = libraryWriteSucceeded && fetched.every((f) => f.result !== null);
  // The notify fallback's staleness clock: "every configured instance synced clean this run."
  if (arm.succeeded) await stampLibrarySyncSuccess("plex", "sync");

  await writePlexEpisodeCache(writable, fetched.length, librarySelections, signal);
}

// TVEpisodeCache has no serverInstance column (episodes are TMDB-anchored, shared
// data — see media-instances.ts) — a per-instance episode-fetch failure can't be
// handled by leaving just THAT instance's rows stale the way the scoped library
// delete does, so any single failure here skips the WHOLE write and leaves
// existing rows untouched. Reaching the write with an empty result means the
// libraries genuinely have no episodes, so the stale rows must be cleared rather
// than left as phantom ownership. Every instance's rows are accumulated and the
// replace runs ONCE (a per-instance replace would wipe the previous instance's
// just-written rows). Each fetch runs against ITS OWN instance's sections —
// Plex ratingKeys are server-local and never leave the per-instance fetch.
async function writePlexEpisodeCache(
  writable: readonly { slug: string; serverUrl: string; token: string; sections: Awaited<ReturnType<typeof getPlexLibrarySections>>; ratingKeyToTmdb: Map<string, number[]> }[],
  fetchedCount: number,
  librarySelections: LibraryTargets["librarySelections"],
  signal: AbortSignal | undefined,
): Promise<void> {
  let allEpisodesFetched = true;
  const allPlexEpisodeRows: Array<{ source: "plex" } & PlexTVEpisodeData> = [];
  for (const { slug, serverUrl, token, sections, ratingKeyToTmdb } of writable) {
    // Guardrail 41: a lost lock stops the episode phase between instances (a
    // walk already running rejects at its next page). Nothing below is written.
    if (signal?.aborted) return;
    try {
      // The precomputed ratingKeyToTmdb map (built by this instance's own
      // type=2 walk) skips getPlexTVEpisodes' per-section re-walk of the
      // identical show listing.
      const episodeFilePaths = new Map<string, string>();
      const episodes = await getPlexTVEpisodes(serverUrl, token, librarySelections.get(plexSettingKey(slug, "Libraries")), sections, ratingKeyToTmdb, episodeFilePaths, { signal });
      // Element-wise, never `push(...array)`: spreading a library-sized array as
      // call arguments throws RangeError past V8's argument ceiling, and the
      // catch below would turn that into `allEpisodesFetched = false`, skipping
      // the whole-table rewrite on EVERY run for exactly the large libraries
      // this path exists to serve.
      for (const e of episodes) allPlexEpisodeRows.push({ source: "plex" as const, ...e });
      // Patch the show file paths (the TV walk reads none) onto the
      // just-written rows. Runs AFTER this instance's library write by
      // construction, is instance-scoped, and touches only rows still missing a
      // path — idempotent and harmless if a concurrent writer replaced the rows.
      // Best-effort: a failure leaves paths null until the next run. One
      // VALUES-joined statement per chunk (patchPlexShowFilePaths), never one
      // updateMany per show. Not once the lock is lost (guardrail 41).
      if (episodeFilePaths.size > 0 && !signal?.aborted) {
        try {
          await patchPlexShowFilePaths(slug, episodeFilePaths);
        } catch (err) {
          console.warn(`[sync] Plex show file-path patch failed for instance "${slug}":`, err instanceof Error ? err.message : err);
        }
      }
    } catch (err) {
      if (!signal?.aborted) console.error(`[sync] Plex TV episode fetch failed for instance "${slug}":`, err);
      allEpisodesFetched = false;
    }
  }
  // `writable.length === fetchedCount` is load-bearing: an instance whose
  // LIBRARY fetch failed never enters `writable`, so its episodes were never
  // fetched — without it the whole-table rewrite would wipe that server's
  // episode rows for the length of its outage. A library-WRITE failure
  // deliberately does not veto (the fetched episode data is still complete).
  if (!episodesCoverEveryServer(allEpisodesFetched, writable.length, fetchedCount) || signal?.aborted) return;
  try {
    // Staged load + short atomic swap under advisory lock 2002,1 (shared with
    // /api/sync/tv-episodes and sync/plex). The rows never cross the wire
    // inside the transaction — see the helper.
    await replaceEpisodeCacheForSource("plex", allPlexEpisodeRows);
  } catch (err) {
    console.error("[sync] Plex TV episode cache failed:", err);
  }
}

// The whole-table episode rewrite runs only on a complete picture: every
// instance's library fetch succeeded (`writable === fetched`) and every
// episode fetch did too. Pure.
function episodesCoverEveryServer(allEpisodesFetched: boolean, writableCount: number, fetchedCount: number): boolean {
  return allEpisodesFetched && writableCount === fetchedCount && writableCount > 0;
}

type JellyfinFetched = {
  slug: string;
  result: { baseUrl: string; apiKey: string; movieIds: Map<number, JellyfinLibraryItemData>; tvIds: Map<number, JellyfinLibraryItemData> } | null;
};

// A Jellyfin hold's warn-once signature and message — the twin of plexHoldWarning.
// Rules: jellyfin-sync-guard.ts.
function jellyfinHoldWarning(slug: string, hold: NonNullable<ReturnType<typeof jellyfinHoldReason>>): { signature: string; message: string } {
  const noun = (mediaType: "MOVIE" | "TV") => (mediaType === "MOVIE" ? "movies" : "shows");
  if (hold.kind === "missing-library") {
    return {
      signature: `missing:${hold.mediaType}:${hold.ids.join(",")}`,
      message: `[sync] Jellyfin instance "${slug}" returned no ${noun(hold.mediaType)} and a selected library is no longer on the server (${hold.ids.join(", ")}) — keeping its stored rows (a library recreated in Jellyfin gets a new id: tick it in the Jellyfin library settings; if it was removed on purpose, Resync the Jellyfin source)`,
    };
  }
  if (hold.kind === "empty-type") {
    return {
      signature: `empty:${hold.mediaType}`,
      message: `[sync] Jellyfin instance "${slug}" returned no ${noun(hold.mediaType)} but has stored rows of them — keeping them (check whether Jellyfin is still scanning; Resync clears a library that really was emptied)`,
    };
  }
  return {
    signature: "empty",
    message: `[sync] Jellyfin instance "${slug}" returned no movies or shows but has stored library rows — keeping them (check the selected libraries, or whether Jellyfin is still scanning)`,
  };
}

// One Jellyfin server's fetch, then the short-answer hold — the twin of
// fetchPlexInstance. Never throws.
async function fetchJellyfinInstance(
  instance: MediaInstanceConfig,
  librarySelections: LibraryTargets["librarySelections"],
): Promise<JellyfinFetched> {
  try {
    const cfg = await getJellyfinConfig(instance.slug);
    if (!cfg.url || !cfg.apiKey) return { slug: instance.slug, result: null }; // defensive; getSyncableMediaInstances already filters to configured ones
    const baseUrl = cfg.url.replace(/\/$/, "");
    const apiKey = cfg.apiKey;
    // THIS server's own library selection; otherwise the scheduled full sync
    // ingests every library and marks excluded media as owned.
    const selectedJellyfinIds = librarySelections.get(jellyfinSettingKey(instance.slug, "Libraries"));
    const [movieIds, tvIds] = await Promise.all([
      getJellyfinTmdbIds(baseUrl, apiKey, "MOVIE", selectedJellyfinIds),
      getJellyfinTmdbIds(baseUrl, apiKey, "TV", selectedJellyfinIds),
    ]);
    // A SHORT answer for a server we already hold rows for is not a complete
    // picture (a library recreated under a new id, a server mid-scan): treated
    // as a success it would wipe the rows and the episode cache and demote
    // AVAILABLE requests. Hold the instance back like a failed fetch. The admin's
    // Resync (/api/sync/jellyfin, full) is the deliberate unguarded way to empty
    // a library.
    const holdInput = { selectedIds: selectedJellyfinIds, movieCount: movieIds.size, tvCount: tvIds.size };
    const warnKey = `sync:jellyfin-empty:${instance.slug}`;
    if (jellyfinHoldNeedsCounts(holdInput)) {
      const [heldMovieRows, heldTvRows] = await Promise.all([
        prisma.jellyfinLibraryItem.count({ where: { serverInstance: instance.slug, mediaType: "MOVIE" } }),
        prisma.jellyfinLibraryItem.count({ where: { serverInstance: instance.slug, mediaType: "TV" } }),
      ]);
      // The server's libraries only matter once something is stored to protect.
      // Mixed and untyped ones included: the guard counts them as either type.
      const folders = heldMovieRows > 0 || heldTvRows > 0 ? await getJellyfinSyncFolders(baseUrl, apiKey) : [];
      const hold = jellyfinHoldReason({ ...holdInput, folders, heldMovieRows, heldTvRows });
      if (hold) {
        const { signature, message } = jellyfinHoldWarning(instance.slug, hold);
        warnOnChange(warnKey, signature, message);
        return { slug: instance.slug, result: null };
      }
    }
    forgetWarnOnChange(warnKey);
    return { slug: instance.slug, result: { baseUrl, apiKey, movieIds, tvIds } };
  } catch (err) {
    console.error(`[sync] Jellyfin check failed for instance "${instance.slug}":`, err);
    return { slug: instance.slug, result: null };
  }
}

// The Jellyfin arm — the twin of the Plex arm above.
async function syncJellyfinLibraries(
  flags: SyncFlags,
  { jellyfinInstances, librarySelections }: LibraryTargets,
  arm: LibraryArm<JellyfinLibraryItemData>,
  windDownBefore: WindDown,
): Promise<void> {
  if (windDownBefore("Jellyfin library")) return;
  if (!flags.jellyfinEnabled || jellyfinInstances.length === 0) return;

  const fetched = await Promise.all(jellyfinInstances.map((instance) => fetchJellyfinInstance(instance, librarySelections)));
  const writable = fetched.flatMap((f) => (f.result ? [{ slug: f.slug, ...f.result }] : []));
  unionIntoArm(arm, writable);

  let libraryWriteSucceeded = true;
  if (writable.length > 0) {
    try {
      // Staged swap (replaceJellyfinLibraryForInstances): rows bulk-loaded into
      // JellyfinLibraryItemStaging OUTSIDE any transaction, then swapped across
      // under advisory lock 2001,2 (shared with /api/sync/jellyfin) in a
      // transaction holding only the per-instance scoped deletes and one
      // INSERT ... SELECT. Only instances whose fetch succeeded are touched at
      // all (guardrail 13).
      await replaceJellyfinLibraryForInstances(
        writable.map(({ slug, movieIds, tvIds }) => {
          const movieRows = Array.from(movieIds.entries()).map(([tmdbId, d]) => jellyfinLibraryRow(tmdbId, d, "MOVIE", slug));
          const tvRows    = Array.from(tvIds.entries()).map(([tmdbId, d])    => jellyfinLibraryRow(tmdbId, d, "TV", slug));
          return { slug, rows: (movieRows as JellyfinLibraryRow[]).concat(tvRows) };
        }),
      );
    } catch (err) {
      console.error("[sync] Jellyfin library write failed:", err);
      libraryWriteSucceeded = false;
      clearArm(arm);
    }
  }

  arm.succeeded = libraryWriteSucceeded && fetched.every((f) => f.result !== null);
  if (arm.succeeded) await stampLibrarySyncSuccess("jellyfin", "sync");

  await writeJellyfinEpisodeCache(writable, fetched.length, librarySelections);
}

// The Jellyfin twin of writePlexEpisodeCache: the same all-or-nothing whole-table
// rewrite, under advisory lock 2002,2.
async function writeJellyfinEpisodeCache(
  writable: readonly { slug: string; baseUrl: string; apiKey: string; tvIds: Map<number, JellyfinLibraryItemData> }[],
  fetchedCount: number,
  librarySelections: LibraryTargets["librarySelections"],
): Promise<void> {
  let allEpisodesFetched = true;
  const allEpisodeRows: Array<{ source: "jellyfin" } & JellyfinTVEpisodeData> = [];
  for (const { slug, baseUrl, apiKey, tvIds } of writable) {
    // Built from THIS instance's own TV map, never the cross-instance union: Jellyfin
    // item ids are server-local and can collide across independently-administered
    // servers, so a global series map could resolve episodes onto the wrong show.
    // Keyed on every item id per series — a show in two of this server's libraries
    // files its episodes under two SeriesIds, and only one id survives into the row.
    const jfSeriesMap = buildSeriesItemIdIndex(tvIds);
    try {
      const episodes = await getJellyfinTVEpisodes(baseUrl, apiKey, librarySelections.get(jellyfinSettingKey(slug, "Libraries")), jfSeriesMap);
      // Element-wise — see writePlexEpisodeCache.
      for (const e of episodes) allEpisodeRows.push({ source: "jellyfin" as const, ...e });
    } catch (err) {
      console.error(`[sync] Jellyfin TV episode fetch failed for instance "${slug}":`, err);
      allEpisodesFetched = false;
    }
  }
  if (!episodesCoverEveryServer(allEpisodesFetched, writable.length, fetchedCount)) return;
  try {
    await replaceEpisodeCacheForSource("jellyfin", allEpisodeRows);
  } catch (err) {
    console.error("[sync] Jellyfin TV episode cache failed:", err);
  }
}

// Returns the REGISTERED media servers, read once after the library writes and
// shared with the demote guard.
async function sweepDeregistered(): Promise<{ registeredPlex: MediaInstanceConfig[]; registeredJellyfin: MediaInstanceConfig[] }> {
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
  //
  // Read ONCE here, after the library writes, and shared with the demote guard
  // below (which needs the same REGISTERED set, for the same reason).
  const [registeredPlex, registeredJellyfin] = await Promise.all([
    getMediaInstances("plex"),
    getMediaInstances("jellyfin"),
  ]);
  try {
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

  // The same sweep for *arr instances. /api/admin/arr-instances purges on
  // removal, but that cleanup is diff-driven — it can only recognise a slug as
  // "just removed" in the one request where the registry stops listing it, so a
  // failure partway through that request orphans the rows permanently, with no
  // later request able to see them. These tables feed the availability union
  // unscoped exactly like the library tables above, so an orphan makes its
  // titles read "in *arr" forever.
  //
  // getArrInstances is the REGISTERED reader (and synthesizes the default ""
  // slug), never getSyncableArrInstances — an instance that is registered but
  // temporarily unconfigured must keep its rows, same rationale as above.
  //
  // The legacy "4k" slug is the one exception to "registered ⇒ listed": it is
  // never registry-backed (normalizeEntry rejects a "4k" entry) and
  // getArrInstancesWithConfigured synthesizes it ONLY while url+apiKey are BOTH
  // present. So an admin blanking one field mid key-rotation would drop it from
  // this list and the sweep would delete every 4K row — a badge hole for every
  // title until the key is re-entered and the following sync rebuilds the cache.
  // It can never be DE-REGISTERED, only unconfigured, so it is always spared.
  try {
    const [registeredRadarr, registeredSonarr] = await Promise.all([
      getArrInstances("radarr"),
      getArrInstances("sonarr"),
    ]);
    const spared = (registered: { slug: string }[]): string[] => {
      const slugs = registered.map((i) => i.slug);
      return slugs.includes(FOURK_ARR_INSTANCE) ? slugs : [...slugs, FOURK_ARR_INSTANCE];
    };
    const radarrSlugs = spared(registeredRadarr);
    const sonarrSlugs = spared(registeredSonarr);
    const swept = await Promise.all([
      prisma.radarrWantedItem.deleteMany({ where: { arrInstance: { notIn: radarrSlugs } } }),
      prisma.radarrAvailableItem.deleteMany({ where: { arrInstance: { notIn: radarrSlugs } } }),
      prisma.sonarrWantedItem.deleteMany({ where: { arrInstance: { notIn: sonarrSlugs } } }),
      prisma.sonarrAvailableItem.deleteMany({ where: { arrInstance: { notIn: sonarrSlugs } } }),
    ]);
    const sweptTotal = swept.reduce((n, r) => n + r.count, 0);
    if (sweptTotal > 0) {
      console.warn(`[sync] Swept ${sweptTotal} wanted/available row(s) for de-registered *arr instances`);
    }
  } catch (err) {
    console.error("[sync] De-registered *arr sweep failed:", err);
  }
  return { registeredPlex, registeredJellyfin };
}

// Whether this run can prove ABSENCE from each media-server type: configured and
// enabled, and no registered-but-unconfigured server still holding rows the run
// never looked at.
async function libraryCoverage(
  flags: SyncFlags,
  { plexInstances, jellyfinInstances }: LibraryTargets,
  { registeredPlex, registeredJellyfin }: { registeredPlex: MediaInstanceConfig[]; registeredJellyfin: MediaInstanceConfig[] },
): Promise<{ plexConfiguredEnabled: boolean; jellyfinConfiguredEnabled: boolean; plexUnionIncomplete: boolean; jellyfinUnionIncomplete: boolean }> {
  const { plexEnabled, jellyfinEnabled } = flags;
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
  // It never enters `fetched`, so it cannot make plexSyncSucceeded false either. Without
  // this guard a title living only on that server would read as absent and its requests
  // would be demoted AVAILABLE -> APPROVED, from data that simply was not consulted. The
  // registeredPlex/registeredJellyfin lists were read once, post-write, above
  // the de-registered-instance sweep and are shared with it.
  // `plexInstances.length > 0` is load-bearing. getMediaInstances ALWAYS synthesizes the
  // default instance, so a service with nothing configured reads as 1 registered vs 0
  // syncable — "incomplete" — and without this term the guard below would disable demotes
  // on every deployment not running BOTH Plex and Jellyfin, which is most of them. A service
  // that is entirely unconfigured is already handled by the plexConfiguredEnabled /
  // jellyfinConfiguredEnabled guards; this one is only about a service in USE that has a
  // registered server missing its connection details.
  // A raw count comparison is not enough either: getMediaInstances synthesizes the
  // default, so a deployment using a service EXCLUSIVELY through a named instance —
  // legacy default fields never filled in — reads as 2 registered vs 1 syncable on every
  // run and would veto every demote forever. The guard's own rationale ("its preserved
  // library rows are not in this run's union") is vacuous for a server that was never
  // configured: it holds no rows, so absence IS provable. Veto only on a missing slug
  // that ACTUALLY still holds rows. The existence probe is gated behind both cheap
  // terms, so the common single-server path issues no extra query.
  // The synthesized default ("") is EXCLUDED from the missing set. It can never
  // be de-registered (guardrail 35), so the only way it is registered-but-not-
  // syncable is that its connection was blanked — after which its surviving
  // library rows are stale ORPHANS, not the deliberately-preserved data of a
  // de-registered NAMED instance. Left in, a deployment that moved entirely to a
  // named server and cleared the default would keep matching its old default
  // rows here and veto EVERY demote forever, with no admin action able to clear
  // the state (nothing re-syncs the blanked default). Absence from a blanked
  // default is provable; only a missing NAMED slug that still holds rows vetoes.
  const syncablePlexSlugs = new Set(plexInstances.map((i) => i.slug));
  const missingPlex = registeredPlex.filter((i) => i.slug !== DEFAULT_MEDIA_INSTANCE && !syncablePlexSlugs.has(i.slug)).map((i) => i.slug);
  const syncableJellyfinSlugs = new Set(jellyfinInstances.map((i) => i.slug));
  const missingJellyfin = registeredJellyfin.filter((i) => i.slug !== DEFAULT_MEDIA_INSTANCE && !syncableJellyfinSlugs.has(i.slug)).map((i) => i.slug);
  const plexUnionIncomplete =
    plexInstances.length > 0 && missingPlex.length > 0 &&
    !!(await prisma.plexLibraryItem.findFirst({ where: { serverInstance: { in: missingPlex } }, select: { tmdbId: true } }));
  const jellyfinUnionIncomplete =
    jellyfinInstances.length > 0 && missingJellyfin.length > 0 &&
    !!(await prisma.jellyfinLibraryItem.findFirst({ where: { serverInstance: { in: missingJellyfin } }, select: { tmdbId: true } }));
  // A registered-but-unconfigured server that still holds rows is a STANDING
  // state until the admin acts, re-derived identically on every run — hourly,
  // and once per SSE-triggered run during a Plex scan. Guardrail 7b: log the
  // condition once and again when it differs; cadence is read from the cron run
  // history. The signature is the slug LISTS the counts are derived from, so a
  // swap of which server is missing (same count) still re-logs.
  const demoteSkipKey = "sync:demote-skip";
  if (plexUnionIncomplete || jellyfinUnionIncomplete) {
    warnOnChange(
      demoteSkipKey,
      `${plexUnionIncomplete ? missingPlex.join(",") : ""}|${jellyfinUnionIncomplete ? missingJellyfin.join(",") : ""}`,
      `[sync] skipping AVAILABLE->APPROVED demotes: ${plexUnionIncomplete ? missingPlex.length : 0} Plex and ` +
      `${jellyfinUnionIncomplete ? missingJellyfin.length : 0} Jellyfin server(s) are registered but not configured, ` +
      "so their preserved library rows are not in this run's union and absence cannot be proven.",
    );
  } else {
    forgetWarnOnChange(demoteSkipKey);
  }
  return { plexConfiguredEnabled, jellyfinConfiguredEnabled, plexUnionIncomplete, jellyfinUnionIncomplete };
}
type LibraryCoverage = Awaited<ReturnType<typeof libraryCoverage>>;

// The per-requester visibility answers the revert, the marking passes and the
// notify fallback share, over this run's library arms (read-only) and the
// configured instances. The requester rows and the memo are per run.
function requesterVisibility(
  { plexInstances, jellyfinInstances }: LibraryTargets,
  plex: LibraryArm<unknown>,
  jellyfin: LibraryArm<unknown>,
) {
  // Built before the revert because the demote is a per-user decision too, and
  // needs the same helpers the marking pass uses.
  // visibilityEnforced is the byte-identical escape hatch (guardrail 35): with
  // no restricted instance configured — every single-server deployment, and
  // every multi-server one that hasn't opted in — every configured slug is
  // visible to everyone, the per-user answer collapses to the union, and every
  // decision below short-circuits to the pre-grants code path.
  const visibilityEnforced =
    plexInstances.some((i) => i.restricted) || jellyfinInstances.some((i) => i.restricted);

  // Every per-user decision reads the requester through this one run-wide
  // cache (REQUESTER_SELECT: the mediaServer preference plus the grants gate's
  // inputs — extra COLUMNS on the requester read, never an extra query), each
  // user at most once (guardrail 31).
  const requesters = createRequesterCache();

  // A requester's visible slugs, memoised for the run: a title present in
  // several libraries asks the same question about the same user repeatedly.
  // Memoised ONLY once their row has been read: a user not read yet (or whose
  // row was deleted between the snapshot and now) answers least-privileged — 0n
  // permissions, no grants, so an absent row can never WIDEN visibility,
  // mirroring getVisibleServerInstances' null-session branch — and must not
  // keep that answer once their row is loaded.
  const visibilityCache = new Map<string, VisibleServerInstances>();
  const visibilityOf = (userId: string): VisibleServerInstances => {
    const hit = visibilityCache.get(userId);
    if (hit) return hit;
    const u = requesters.get(userId);
    const vis = visibleInstancesFor(
      // effectivePermissions, never the raw column (requesterPermissions): a
      // legacy ADMIN row whose permissions were never seeded keeps the ADMIN
      // short-circuit every read path grants it.
      requesterPermissions(u),
      parseMediaServerGrants(u?.mediaServerGrants),
      plexInstances,
      jellyfinInstances,
    );
    if (u) visibilityCache.set(userId, vis);
    return vis;
  };

  // "Is this title on a <service> server THIS requester can see?" — the
  // per-viewer replacement for the union map's `.has()`. The union check runs
  // FIRST and unchanged: a title absent from every configured server is absent
  // for everyone and no grant can conjure it, so the overwhelmingly common
  // "not present" answer costs exactly what it did before. Callers load the
  // requesters first.
  const presentForRequester = (
    req: { tmdbId: number; mediaType: string; requestedBy: string },
    service: LibrarySource,
  ): boolean => {
    const isMovie = req.mediaType === "MOVIE";
    const arm = service === "plex" ? plex : jellyfin;
    if (!(isMovie ? arm.movieIds : arm.tvIds).has(req.tmdbId)) return false;
    if (!visibilityEnforced) return true; // nothing restricted ⇒ the union IS the per-user answer
    const holders = (isMovie ? arm.movieSlugs : arm.tvSlugs).get(req.tmdbId);
    // Unreachable — the union and presence maps are filled in the same loop — but
    // fail CLOSED rather than fall back to the union if they ever diverge.
    if (!holders) return false;
    const vis = visibilityOf(req.requestedBy);
    return (service === "plex" ? vis.plex : vis.jellyfin).some((slug) => holders.has(slug));
  };
  return { visibilityEnforced, requesters, visibilityOf, presentForRequester };
}
type RequesterVisibility = ReturnType<typeof requesterVisibility>;

async function revertAvailable(
  available: AvailableRow[],
  { flags, arr, coverage, plex, jellyfin, arrPresence, vis }: {
    flags: SyncFlags;
    arr: ArrRefresh;
    coverage: LibraryCoverage;
    plex: LibraryArm<unknown>;
    jellyfin: LibraryArm<unknown>;
    arrPresence: ArrPresence;
    vis: RequesterVisibility;
  },
): Promise<{ reverted: number; revertedIds: Set<string> }> {
  // Demote AVAILABLE requests that have dropped out of *both* the *arr caches and the
  // Plex/Jellyfin library caches. Consulting the library caches here — not just *arr — is
  // what stops a request present in Plex but absent from Radarr from being reverted to
  // APPROVED and then immediately re-marked AVAILABLE by markLibraryRequests below: a
  // same-run flap that rewrote availableAt and inflated the reverted counter every tick.
  // Runs after the library sync so the maps are populated; library presence is only trusted
  // when that source synced successfully (an empty map from a failed/disabled source falls
  // back to the *arr-only decision).
  const none = { reverted: 0, revertedIds: new Set<string>() };
  const { plexConfiguredEnabled, jellyfinConfiguredEnabled, plexUnionIncomplete, jellyfinUnionIncomplete } = coverage;
  const { inRadarrSet, inSonarrSet } = arrPresence;
  // Don't demote while a configured library source is down — we can't prove absence
  // from a library we never reached this run. Same rule for a server that is registered
  // but no longer configured: its rows survive and this run never looked at them.
  if (plexConfiguredEnabled && !plex.succeeded) return none;
  if (jellyfinConfiguredEnabled && !jellyfin.succeeded) return none;
  if (plexUnionIncomplete || jellyfinUnionIncomplete) return none;

  // Only consult the ARR cache when the integration is enabled AND this run refreshed
  // THE REQUEST'S OWN instance. A disabled integration, a failed refresh, or an
  // enabled-but-UNCONFIGURED instance all leave that instance's cache meaningless —
  // skip the demote. (The global *SyncSucceeded flag is not enough: it reads true after
  // the no-op empty loop of an unconfigured integration, so its empty cache would look
  // like an authoritatively-empty library and mass-demote every arr-backed AVAILABLE
  // request the moment an admin cleared the arr connection.)
  const goneFromArr = available.filter((req) =>
    arrInstanceRefreshed(req, flags, arr) &&
    !(req.mediaType === "MOVIE" ? inRadarrSet : inSonarrSet).has(vkey(req.tmdbId, req.arrInstance)),
  );
  if (goneFromArr.length === 0) return none;

  // Library presence is asked PER REQUESTER — the same predicate the marking pass uses.
  // Reading the global union here would count a restricted server the requester holds no
  // grant for as "present", keeping their request AVAILABLE for a copy they cannot watch.
  // The requesters are read only when something is restricted, and only for the rows
  // that are already gone from the arr (guardrail 35's byte-identical rule otherwise).
  if (vis.visibilityEnforced) await vis.requesters.load(goneFromArr.map((r) => r.requestedBy));
  const toRevert = goneFromArr.filter((req) =>
    !(plex.succeeded && vis.presentForRequester(req, "plex")) &&
    !(jellyfin.succeeded && vis.presentForRequester(req, "jellyfin")),
  );
  if (toRevert.length === 0) return none;

  const result = await prisma.mediaRequest.updateMany({
    // CAS on status: only demote rows still AVAILABLE. toRevert is built from the
    // run-start `available` snapshot, so a row that a concurrent path moved out of
    // AVAILABLE must not be blind-written back to APPROVED.
    // `cleanedUpAt: null`: an admin deleted a stamped row's title on purpose
    // through Library cleanup, so its absence from every cache and library is
    // the INTENDED state, not a lost file. Demoting it would make the next
    // run's re-push send it straight back to Radarr/Sonarr and re-download what
    // was just removed. It stays AVAILABLE. Kept in the WHERE (not a JS filter
    // over the run-start snapshot) so a stamp landing mid-run still wins (guardrail 14b).
    where: { id: { in: toRevert.map((r) => r.id) }, status: "AVAILABLE", cleanedUpAt: null },
    // Clear pendingNotifyAt on demote: a stale overdue timestamp left from the
    // original approve would otherwise fire a false "download pending" notify
    // once the row is back to APPROVED.
    data: { status: "APPROVED", pendingNotifyAt: null },
  });
  return { reverted: result.count, revertedIds: new Set(toRevert.map((r) => r.id)) };
}

// The two library marking passes. Returns how many requests each source's pass
// MATCHED (its candidates past every gate) — per source, so a title on both
// servers is counted by each and the two are never summed (guardrail 36).
async function markLibraryPasses(
  revertedIds: Set<string>,
  { sonarrConfiguredSlugs }: ArrRefresh,
  plex: LibraryArm<unknown>,
  jellyfin: LibraryArm<unknown>,
  vis: RequesterVisibility,
): Promise<{ plexMarked: number; jellyfinMarked: number }> {
  // Snapshot taken once after both library writes complete; both marking passes share this
  // exact set (guardrail 15). Changes made by the Plex pass are NOT visible to the Jellyfin
  // pass's candidate set — intentional by design; only the claim flag is re-read
  // (markAvailableFromLibrary), and a row the Plex pass flipped without notifying is
  // notified by the fallback below.
  //
  // Exclude rows we just reverted from AVAILABLE→APPROVED in this same run. Otherwise
  // the marking could re-flip them to AVAILABLE if they're present in Plex/Jellyfin but
  // absent from the ARR caches — the same-run flap the revert was added to prevent.
  // Those items get a fresh look on the next run when the caches and status are coherent.
  const stillPending = (await readPendingRequests()).filter((r) => !revertedIds.has(r.id));

  // Sonarr completeness gate for the library passes (guardrail 14a). A TV title is in
  // Plex/Jellyfin the moment its FIRST episode imports, but a TV request is "ready" only
  // once Sonarr reports the series COMPLETE — an incomplete series sits in SonarrWantedItem
  // for its instance. Read ONCE here, for the union of both passes' candidates, so it rides
  // the single stillPending snapshot rather than re-querying per source (guardrail 15
  // constrains the READ; filtering the snapshot afterwards is fine). Pre-CAS by
  // construction: a held id never reaches the claim, so its once-only claim is never burned
  // (guardrail 14). A title Sonarr does not track at all (no wanted row) is marked off
  // library presence alone — the only sensible answer for a deployment with no Sonarr.
  // sonarrConfiguredSlugs is undefined when the Sonarr refresh threw: the helper then reads
  // the registry itself, so an outage still HOLDS.
  const held = await sonarrIncompleteKeys(stillPending, { configuredSlugs: sonarrConfiguredSlugs });
  const inputs: MarkInputs = { stillPending: withoutSonarrHeld(stillPending, held), vis };

  // A source whose library WRITE failed has empty maps here: each arm clears
  // them in its catch, because they were filled BEFORE the transaction and a
  // rolled-back replace must not flip requests AVAILABLE against rows that
  // never landed. Do NOT gate this on the arm's `succeeded`: that is also false
  // when ONE of several servers failed its fetch, and the healthy servers' rows
  // did land — presence there is still proof (only ABSENCE needs a complete
  // union, which is what demotion checks).
  const plexMarked = await markLibraryRequests(inputs, plex, "plex");
  const jellyfinMarked = await markLibraryRequests(inputs, jellyfin, "jellyfin");
  return { plexMarked, jellyfinMarked };
}

interface MarkInputs {
  // The ONE stillPending snapshot both passes share (guardrail 15), Sonarr hold applied.
  stillPending: PendingRequest[];
  vis: RequesterVisibility;
}

async function markLibraryRequests(
  { stillPending, vis }: MarkInputs,
  arm: LibraryArm<unknown>,
  source: LibrarySource,
): Promise<number> {
  if (arm.movieIds.size === 0 && arm.tvIds.size === 0) return 0;
  const candidates = inLibrary(stillPending, arm);
  if (candidates.length === 0) return 0;

  // GRANTS GATE — PRE-CAS BY CONSTRUCTION (guardrail 35).
  //
  // A `restricted` instance contributes availability ONLY to users granted `view`
  // on it, so the SAME title on the SAME server is available to a granted
  // requester and not-yet-available to an ungranted one. This is a plain filter
  // over the candidate array, and its position is the whole argument:
  //   • guardrail 14 holds untouched: the claim is still the ONLY writer of
  //     notifiedAvailable; it simply never receives a gated id.
  //   • the claim is NOT burned for a gated requester (contrast notify-available's
  //     deactivatedAt filter, which sits AFTER the UPDATE … RETURNING on purpose).
  //     A gated row stays PENDING/APPROVED with notifiedAvailable=false and is
  //     flipped + notified as soon as the grant lands or a copy appears on a
  //     server they can see.
  //   • guardrail 15 holds: the snapshot is read once; this filters it.
  // Gating the candidates covers every branch at once — notify, flip-only and the
  // already-notified flip — so an invisible title can never move a requester's
  // row to AVAILABLE by any route. NOT applied to the ARR passes, deliberately:
  // Radarr/Sonarr availability is server-agnostic, and in every real topology the
  // *arr feeds the DEFAULT server, which is visible to everyone.
  let toMark = candidates;
  if (vis.visibilityEnforced) {
    // Loaded at the CANDIDATE scope because the gate runs before toMark is
    // settled; the marking's mediaServer split then reads the same cached rows,
    // so this is still ONE requester read per pass.
    await vis.requesters.load(candidates.map((r) => r.requestedBy));
    toMark = candidates.filter((req) => vis.presentForRequester(req, source));
  }
  await markAvailableFromLibrary(toMark, source, { requesters: vis.requesters, logScope: "sync" });
  return toMark.length;
}

// Fallback for notification starvation: if a per-source sync has been failing for more than
// this long, that source's data counts as "unusable" so the *other* source can satisfy the
// notify gate alone. Without it, a permanently broken Plex would block every Jellyfin-only
// user's "now available" notification forever (and vice versa). Within the window a recent
// failure still refuses to notify on stale data.
const STALE_SYNC_FALLBACK_MS = 24 * 60 * 60 * 1000;

// Whether each media-server type has been failing past STALE_SYNC_FALLBACK_MS. A
// configured source that fails with NO recorded success gets a baseline seeded
// first: the marker is only ever stamped on a clean run, so a source that has
// never synced clean would otherwise have no origin, could never become stale,
// and would starve every user pinned to it forever. skipDuplicates keeps the
// seed idempotent and can never overwrite a real success stamp; a later clean
// run upserts over it. A failure-time origin (not "missing ⇒ instantly stale")
// keeps the 24h within-window guard.
async function staleLibrarySources(
  { plexConfiguredEnabled, jellyfinConfiguredEnabled }: LibraryCoverage,
  plexSyncSucceeded: boolean,
  jellyfinSyncSucceeded: boolean,
): Promise<{ plex: boolean; jellyfin: boolean }> {
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
  const plexFailing = plexConfiguredEnabled && !plexSyncSucceeded;
  const jellyfinFailing = jellyfinConfiguredEnabled && !jellyfinSyncSucceeded;
  const staleBaselineSeeds: Array<{ key: string; value: string }> = [];
  if (plexFailing && lastPlexSuccessAt == null) staleBaselineSeeds.push({ key: "lastPlexSyncSucceededAt", value: String(nowMs) });
  if (jellyfinFailing && lastJellyfinSuccessAt == null) staleBaselineSeeds.push({ key: "lastJellyfinSyncSucceededAt", value: String(nowMs) });
  if (staleBaselineSeeds.length > 0) {
    await prisma.setting.createMany({ data: staleBaselineSeeds, skipDuplicates: true })
      .catch((err) => console.error("[sync] failed to seed the stale-sync baseline:", err));
  }
  return {
    plex: plexFailing && lastPlexSuccessAt != null && nowMs - lastPlexSuccessAt > STALE_SYNC_FALLBACK_MS,
    jellyfin: jellyfinFailing && lastJellyfinSuccessAt != null && nowMs - lastJellyfinSuccessAt > STALE_SYNC_FALLBACK_MS,
  };
}

async function notifyPendingAvailable(
  coverage: LibraryCoverage,
  plex: LibraryArm<unknown>,
  jellyfin: LibraryArm<unknown>,
  vis: RequesterVisibility,
): Promise<void> {
  // Re-query LIVE rather than filter the run-start `available` snapshot: a
  // request the marking passes flipped AVAILABLE **this run** via the
  // non-notifying flip (user prefers the OTHER source; title present in both
  // libraries) is not in the snapshot — the source-pass notify claim then finds
  // status already AVAILABLE (its CAS only claims PENDING/APPROVED) and the
  // user's "now available" notification would slip a full sync cycle. A live
  // read includes those rows; the requireStatusAvailable CAS below still
  // guarantees exactly-once against the webhook poller and concurrent runs.
  const pending = await prisma.mediaRequest.findMany({
    where: { status: "AVAILABLE", notifiedAvailable: false },
    select: PENDING_REQUEST_SELECT,
  });
  if (pending.length === 0) return;

  const stale = await staleLibrarySources(coverage, plex.succeeded, jellyfin.succeeded);
  await vis.requesters.load(pending.map((r) => r.requestedBy));

  // Collect candidate ids, then ONE CAS + one notify per channel rather than a
  // round-trip and a notify call per request.
  const toNotify = pending.filter((req) => {
    // Grants extend "unusable" per requester: someone who can see NO configured
    // server of a type is in exactly the position of a deployment with that type
    // unconfigured — it can never prove presence for them either way, so it must
    // not block the OTHER source's notify. Reachable when the DEFAULT instance of
    // a type is unconfigured and only a restricted named one exists (the default
    // is visible to everyone by construction).
    const visible = vis.visibilityEnforced ? vis.visibilityOf(req.requestedBy) : null;
    return fallbackShouldNotify({
      preferred: vis.requesters.get(req.requestedBy)?.mediaServer ?? null,
      // Per-viewer presence (grants), the same gate as the AVAILABLE flip and
      // also pre-CAS: a gated row's claim is never burned, and the next run
      // re-offers it. A failed library write left that source's maps empty
      // (cleared in its arm), so presence is never read from a rolled-back write.
      inPlex: vis.presentForRequester(req, "plex"),
      inJellyfin: vis.presentForRequester(req, "jellyfin"),
      // Reuses the demote gate's enabled+configured predicate: a source whose
      // integration flag is OFF will never sync, so counting it as configured
      // would starve every user pinned to it — what the stale fallback exists to fix.
      plexUnusable: !coverage.plexConfiguredEnabled || stale.plex || visible?.plex.length === 0,
      jellyfinUnusable: !coverage.jellyfinConfiguredEnabled || stale.jellyfin || visible?.jellyfin.length === 0,
    });
  });
  if (toNotify.length === 0) return;

  // Atomic claim (UPDATE ... RETURNING) closes the snapshot→updateMany TOCTOU:
  // only rows this statement flipped (status AVAILABLE, notifiedAvailable
  // false→true) come back. requireStatusAvailable keeps the "only notify rows
  // already marked AVAILABLE" guard.
  const { claimed, deliverable } = await claimAvailableNotifications(toNotify, { requireStatusAvailable: true });
  if (claimed.length > 0) {
    // Backstop wipe: the original AVAILABLE transition (per-source mark pass,
    // webhooks) should have wiped already, but a regression there is silent
    // until threshold notifications fire on stale votes — wipe again here.
    void clearDeletionVotesForTmdbs(claimed);
  }
  if (deliverable.length > 0) void fanOutAvailableWinners(deliverable, "sync");
}

async function purgeExpiredTmdbCache(): Promise<void> {
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
}
