// Sync orchestrator (sync-orchestrator.ts): the Radarr/Sonarr half — both
// marking passes, the cache refresh, the download-check backstop, the re-push
// and the arr presence the revert reads.
import { prisma } from "./prisma";
import { addMovieToRadarr, addSeriesToSonarr } from "./arr";
import { refreshArrCache } from "./arr-cache-refresh";
import { runDownloadCheck } from "./download-check";
import { claimAndAnnounce, flipToAvailable } from "./available-marking";
import { runConcurrent, vkey, type SyncFlags, type WindDown, type ApprovedRow, type AvailableRow } from "./sync-orchestrator-shared";

// Re-push backoff for APPROVED requests the *arr never accepted (e.g. unreleased title with
// no Radarr/TheTVDB metadata yet). Without this the orchestrator would retry every sync tick
// (hourly) forever. Upstream metadata for an upcoming title appears some unpredictable day in
// the weeks before air, so a daily attempt catches it within ~24h of it landing while cutting
// the wasted lookups ~24×.
const ARR_REPUSH_BACKOFF_MS = 24 * 60 * 60 * 1000;

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
export async function firstArrPass(approved: ApprovedRow[], flags: SyncFlags): Promise<{ arrNotifiedIds: Set<string>; availableMovieSet: Set<string>; availableTvSet: Set<string>; marked: number }> {
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
export async function refreshArrCaches(flags: SyncFlags, windDownBefore: WindDown) {
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
export type ArrRefresh = Awaited<ReturnType<typeof refreshArrCaches>>;

export async function secondArrPass(
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

export async function overdueBackstop(
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
export async function repushStranded(approved: ApprovedRow[], flags: SyncFlags, arr: ArrRefresh): Promise<number> {
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
export function arrInstanceRefreshed(req: { mediaType: string; arrInstance: string }, { radarrEnabled, sonarrEnabled }: SyncFlags, arr: ArrRefresh): boolean {
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
export async function arrPresenceOfAvailable(available: AvailableRow[], flags: SyncFlags, arr: ArrRefresh): Promise<{ inRadarrSet: Set<string>; inSonarrSet: Set<string> }> {
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
export type ArrPresence = Awaited<ReturnType<typeof arrPresenceOfAvailable>>;
