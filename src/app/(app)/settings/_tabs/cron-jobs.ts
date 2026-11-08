// The System tab's scheduled-jobs table: which jobs it lists, and how a job's
// last run and recent rate are read off the run ledger (and, for a job that
// has never run since the ledger existed, its last audit row). Pure: the reads
// are in system-tab-data.ts.
import type { CronJobInfo } from "@/components/settings/cron-job-table";
import {
  CRON_RUN_HISTORY_LIMIT,
  countCronRunsSince,
  parseCronLastRun,
  type CronRunEntry,
} from "@/lib/cron-history";
import type { Translator } from "@/lib/i18n/translate";

export interface CronJobDef {
  target: string;
  nameKey: string;
  descriptionKey: string;
  endpoint: string;
  envVar: string;
  defaultSeconds: string;
}

// Every scheduled job the System tab lists, once: the run-ledger target its
// last run and runs/h are read under, the endpoint its Run button POSTs to, and
// the interval env var with the container's default (docker-entrypoint.sh's
// _CRON_JOBS). Catalog keys are written out whole so the unused-key scan sees
// them.
export const CRON_JOBS: ReadonlyArray<CronJobDef> = [
  { target: "sync:full", nameKey: "settings.cron.job.librarySync.name", descriptionKey: "settings.cron.job.librarySync.description", endpoint: "/api/sync", envVar: "SYNC_INTERVAL", defaultSeconds: "3600" },
  { target: "upcoming-cache", nameKey: "settings.cron.job.upcomingSync.name", descriptionKey: "settings.cron.job.upcomingSync.description", endpoint: "/api/sync/upcoming", envVar: "UPCOMING_SYNC_INTERVAL", defaultSeconds: "86400" },
  { target: "ratings-sync", nameKey: "settings.cron.job.ratingsSync.name", descriptionKey: "settings.cron.job.ratingsSync.description", endpoint: "/api/sync/ratings", envVar: "RATINGS_SYNC_INTERVAL", defaultSeconds: "86400" },
  { target: "list-cache", nameKey: "settings.cron.job.warmListCache.name", descriptionKey: "settings.cron.job.warmListCache.description", endpoint: "/api/cron/warm-list-cache", envVar: "LIST_CACHE_SYNC_INTERVAL", defaultSeconds: "21600" },
  { target: "activity", nameKey: "settings.cron.job.warmActivity.name", descriptionKey: "settings.cron.job.warmActivity.description", endpoint: "/api/cron/warm-activity", envVar: "WARM_ACTIVITY_INTERVAL", defaultSeconds: "1800" },
  { target: "mdblist", nameKey: "settings.cron.job.warmMdblist.name", descriptionKey: "settings.cron.job.warmMdblist.description", endpoint: "/api/cron/warm-mdblist", envVar: "WARM_MDBLIST_INTERVAL", defaultSeconds: "86400" },
  { target: "omdb", nameKey: "settings.cron.job.warmOmdb.name", descriptionKey: "settings.cron.job.warmOmdb.description", endpoint: "/api/cron/warm-omdb", envVar: "WARM_OMDB_INTERVAL", defaultSeconds: "86400" },
  { target: "recommendations", nameKey: "settings.cron.job.warmRecommendations.name", descriptionKey: "settings.cron.job.warmRecommendations.description", endpoint: "/api/cron/warm-recommendations", envVar: "WARM_RECOMMENDATIONS_INTERVAL", defaultSeconds: "43200" },
  // Distinct from Admin -> Library's "Warm library cache" button, which
  // POSTs /api/admin/library-warm: that one runs the metadata walk ALONE,
  // records no cron run, and so never appears in this table. This row is
  // the only browser trigger that also builds the suggestion graph.
  { target: "library", nameKey: "settings.cron.job.warmLibrary.name", descriptionKey: "settings.cron.job.warmLibrary.description", endpoint: "/api/cron/warm-library", envVar: "WARM_LIBRARY_INTERVAL", defaultSeconds: "86400" },
  { target: "auth-sessions:purge-expired", nameKey: "settings.cron.job.purgeSessions.name", descriptionKey: "settings.cron.job.purgeSessions.description", endpoint: "/api/cron/purge-auth-sessions", envVar: "PURGE_SESSIONS_INTERVAL", defaultSeconds: "86400" },
  { target: "notifications:purge", nameKey: "settings.cron.job.purgeNotifications.name", descriptionKey: "settings.cron.job.purgeNotifications.description", endpoint: "/api/cron/purge-notifications", envVar: "PURGE_NOTIFICATIONS_INTERVAL", defaultSeconds: "86400" },
  { target: "audit-log:pii-scrub", nameKey: "settings.cron.job.scrubAuditPii.name", descriptionKey: "settings.cron.job.scrubAuditPii.description", endpoint: "/api/cron/scrub-audit-pii", envVar: "SCRUB_AUDIT_PII_INTERVAL", defaultSeconds: "86400" },
  { target: "trash-sync", nameKey: "settings.cron.job.trashSync.name", descriptionKey: "settings.cron.job.trashSync.description", endpoint: "/api/cron/trash-sync", envVar: "TRASH_SYNC_INTERVAL", defaultSeconds: "86400" },
  { target: "plex-watchlist", nameKey: "settings.cron.job.plexWatchlist.name", descriptionKey: "settings.cron.job.plexWatchlist.description", endpoint: "/api/cron/sync-plex-watchlists", envVar: "PLEX_WATCHLIST_SYNC_INTERVAL", defaultSeconds: "1800" },
  { target: "trakt", nameKey: "settings.cron.job.trakt.name", descriptionKey: "settings.cron.job.trakt.description", endpoint: "/api/cron/sync-trakt", envVar: "TRAKT_SYNC_INTERVAL", defaultSeconds: "1800" },
  { target: "upstream-watch", nameKey: "settings.cron.job.upstreamWatch.name", descriptionKey: "settings.cron.job.upstreamWatch.description", endpoint: "/api/cron/refresh-upstream-watch", envVar: "UPSTREAM_WATCH_SYNC_INTERVAL", defaultSeconds: "86400" },
  { target: "watch-sync", nameKey: "settings.cron.job.watchSync.name", descriptionKey: "settings.cron.job.watchSync.description", endpoint: "/api/cron/watch-sync", envVar: "WATCH_SYNC_INTERVAL", defaultSeconds: "300" },
  { target: "arr-watch", nameKey: "settings.cron.job.arrWatch.name", descriptionKey: "settings.cron.job.arrWatch.description", endpoint: "/api/cron/arr-watch", envVar: "ARR_WATCH_INTERVAL", defaultSeconds: "900" },
  { target: "arr-snapshots", nameKey: "settings.cron.job.arrSnapshots.name", descriptionKey: "settings.cron.job.arrSnapshots.description", endpoint: "/api/cron/refresh-arr-snapshots", envVar: "ARR_SNAPSHOT_INTERVAL", defaultSeconds: "300" },
  // Not a container cron of its own: the orchestrator runs the same pass every
  // sync, so it shares the library sync's interval.
  { target: "download-policies", nameKey: "settings.cron.job.downloadPolicy.name", descriptionKey: "settings.cron.job.downloadPolicy.description", endpoint: "/api/cron/sync-download-policies", envVar: "SYNC_INTERVAL", defaultSeconds: "3600" },
];

// Scheduled-job intervals arrive from env as a raw second count. Every other
// column in that table is already humanised ("21m ago", "170.7s"), so a bare
// "86400s" was the one value nobody could read at a glance. Unparseable or
// non-positive values are shown verbatim rather than silently normalised — an
// operator who typo'd the env var needs to see what they actually set.
export function formatInterval(t: Translator, seconds: string | undefined, fallback: string): string {
  const raw = seconds ?? fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return raw;
  if (n === 3_600) return t("settings.cron.interval.hourly");
  if (n === 86_400) return t("settings.cron.interval.daily");
  if (n === 604_800) return t("settings.cron.interval.weekly");
  if (n % 86_400 === 0) return t("settings.cron.interval.days", { n: n / 86_400 });
  if (n % 3_600 === 0) return t("settings.cron.interval.hours", { n: n / 3_600 });
  if (n % 60 === 0) return t("settings.cron.interval.minutes", { n: n / 60 });
  return t("settings.cron.interval.seconds", { n });
}

/** A job's last run as the table shows it. A null status means "we can't tell". */
export interface CronLastRunInfo {
  at: Date;
  durationMs: number | null;
  status: "ok" | "error" | null;
}

/**
 * A `cron:lastRun:<target>` ledger row's last run, or null when it is unusable.
 * parseCronLastRun passes `at` through verbatim (its tests pin that), so a
 * corrupted or hand-edited row can carry a non-date there; an Invalid Date's
 * toISOString() throws and took the whole System tab down. Such a row is
 * skipped and the audit-log fallback stands.
 */
export function lastRunFromLedger(value: string): CronLastRunInfo | null {
  const parsed = parseCronLastRun(value);
  if (!parsed) return null;
  const atMs = Date.parse(parsed.at);
  if (!Number.isFinite(atMs)) return null;
  return { at: new Date(atMs), durationMs: parsed.durationMs, status: parsed.ok ? "ok" : "error" };
}

/**
 * A job's last run from its newest audit row (the fallback). Legacy rows carry
 * no `ok`, so a row without one reads as a success; `ok: false` is a failure;
 * details that don't parse to an object say nothing, so the status is unknown
 * rather than a success nobody recorded.
 */
export function lastRunFromAudit(createdAt: Date, details: string | null): CronLastRunInfo {
  if (details === null) return { at: createdAt, durationMs: null, status: "ok" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(details);
  } catch {
    return { at: createdAt, durationMs: null, status: null };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { at: createdAt, durationMs: null, status: null };
  }
  const d = parsed as { durationMs?: unknown; ok?: unknown };
  return {
    at: createdAt,
    durationMs: typeof d.durationMs === "number" && Number.isFinite(d.durationMs) ? d.durationMs : null,
    status: d.ok === false ? "error" : "ok",
  };
}

/** The table's rows, in CRON_JOBS order. `oneHourAgoMs` is read once on the server (guardrail 16). */
export function buildCronJobs(
  t: Translator,
  env: Readonly<Record<string, string | undefined>>,
  lastRuns: ReadonlyMap<string, CronLastRunInfo>,
  histories: ReadonlyMap<string, readonly CronRunEntry[]>,
  oneHourAgoMs: number,
): CronJobInfo[] {
  return CRON_JOBS.map((job) => {
    const history = histories.get(job.target);
    // null (not 0) when there is no ledger history at all: "we do not know
    // this job's rate" and "this job ran zero times in the last hour" are
    // different answers, and only the second one is worth rendering.
    const runsLastHour = history && history.length > 0 ? countCronRunsSince(history, oneHourAgoMs) : null;
    // The history is bounded, so a saturated count is a floor, not a total.
    const runsLastHourCapped = runsLastHour != null && runsLastHour >= CRON_RUN_HISTORY_LIMIT;
    const last = lastRuns.get(job.target);
    return {
      name: t(job.nameKey),
      description: t(job.descriptionKey),
      endpoint: job.endpoint,
      interval: formatInterval(t, env[job.envVar], job.defaultSeconds),
      lastRun: last ? last.at.toISOString() : null,
      lastDuration: last ? last.durationMs : null,
      lastStatus: last ? last.status : null,
      runsLastHour,
      runsLastHourCapped,
    };
  });
}
