// The sync orchestrator: one /api/sync run, phase by phase. The route
// (src/app/api/sync/route.ts) authorizes, takes the lock and calls
// runSyncOrchestrator; everything a run does lives here and in the siblings:
//   sync-orchestrator-shared.ts     run flags, the run-start snapshot, helpers
//   sync-orchestrator-arr.ts        Radarr/Sonarr passes, refresh, backstop, re-push
//   sync-orchestrator-libraries.ts  the Plex and Jellyfin library + episode arms
//   sync-orchestrator-marking.ts    sweep, coverage, revert, marking, pending notify
//   sync-orchestrator-tmdb-purge.ts the expired-TmdbCache purge
// Siblings import each other directly, never through this entry.
import { NextResponse } from "next/server";
import { logAudit } from "./audit";
import type { CronActor } from "./cron-auth";
import { CRON_DEGRADED_HEADER, } from "./cron-history";
import { drainOutbox } from "./outbox-drain";
import { DEFAULT_ARR_INSTANCE } from "./arr-instances";
import type { Translator } from "./i18n/translate";
import { type SyncFlags, readSyncFlags, readSnapshot } from "./sync-orchestrator-shared";
import { firstArrPass, refreshArrCaches, type ArrRefresh, secondArrPass, overdueBackstop, repushStranded, arrPresenceOfAvailable } from "./sync-orchestrator-arr";
import { readLibraryTargets, syncLibraries } from "./sync-orchestrator-libraries";
import { sweepDeregistered, libraryCoverage, type LibraryCoverage, requesterVisibility, revertAvailable, markLibraryPasses, notifyPendingAvailable } from "./sync-orchestrator-marking";
import { purgeExpiredTmdbCache } from "./sync-orchestrator-tmdb-purge";

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
export async function runSyncOrchestrator(actor: CronActor, t: Translator, signal?: AbortSignal): Promise<NextResponse> {
  try {
    return await runSyncPhases(actor, t, signal);
  } finally {
    // Notifications an earlier run claimed and never sent (a restart mid-send).
    // In a `finally` so a run that winds down at a phase boundary or throws still
    // redelivers: a row expires after 24 h and only this drain deletes it, so a
    // sync that kept stopping early would lose the notice for good (guardrail 14f).
    // Only rows whose lock has lapsed, so never this run's own claims. Never throws.
    await drainOutbox("sync");
  }
}

async function runSyncPhases(actor: CronActor, t: Translator, signal?: AbortSignal): Promise<NextResponse> {
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
