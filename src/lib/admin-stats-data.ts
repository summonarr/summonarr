// Admin Statistics — the prisma half. Every figure /admin/stats renders and
// GET /api/admin/stats serializes comes from here, so the web page and the
// native client can never disagree about what a number means. Pure rules
// (ranges, disk merging, durations) live in admin-stats.ts.
import { Prisma } from "@/generated/prisma";
import { prisma } from "./prisma";
import { getArrDiskSpace, type ArrDiskSpace } from "./arr-stats";
import { getArrInstances } from "./arr-instance-registry";
import { getMediaInstances } from "./media-instance-registry";
import { isFeatureEnabled } from "./features";
import { coalesce } from "./concurrency";
import { processSingleton } from "./process-singleton";
import { REQUEST_APPROVAL_BACKFILL_KEY } from "./request-approval";
import { getCachedArrLibraryIndex, type ArrLibraryEntry } from "./library-cleanup-arr";
import { CLEANUP_FEATURE_KEY, computeCleanupReport } from "./library-cleanup-data";
import { getWatchGradeSummaries } from "./watch-grade-data";
import type { AutoRequestSource } from "./auto-request";
import { watchGradeSpread, type WatchGradeSpread } from "./watch-grade";
import {
  AUTO_APPROVE_WINDOW_SECONDS,
  PENDING_AGE_ALERT_DAYS,
  PENDING_AGE_WARN_DAYS,
  STUCK_DOWNLOAD_DAYS,
  mergeDiskGroups,
  type MergedDisk,
} from "./admin-stats";
import { NEVER_WATCHED_FEATURE_KEY, shareLibraryWatchFacts } from "./never-watched-data";
import { getNeverWatchedReport } from "./never-watched-report";
import { DELETION_VOTE_THRESHOLD_KEY, parseDeletionVoteThreshold } from "./deletion-vote-keys";

type Status = "PENDING" | "APPROVED" | "DECLINED" | "AVAILABLE";
type Media = "MOVIE" | "TV";

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));

// Every raw query is built with Prisma.sql and handed to $queryRaw as ONE value,
// never written as a tagged template with fragments interpolated: inside the
// Next bundle the client's tagged-template path did not recognise a nested
// Prisma.sql/Prisma.empty from "@/generated/prisma" as SQL and bound it as a
// parameter ("syntax error at or near $1"). The unit loader shares one module
// instance, so only a live render showed it.

// A raw query's rows. $queryRaw answers an array; the guard keeps a stubbed or
// unexpected answer from throwing in the folds below (one place, not per query).
async function queryRows<T>(query: Prisma.Sql): Promise<T[]> {
  const rows = await prisma.$queryRaw<T[]>(query);
  return Array.isArray(rows) ? rows : [];
}

// The last 12 calendar months (UTC), oldest first, as a `months(start)` CTE
// body: `WITH ${LAST_12_MONTHS_CTE} …`. Every month is present even with no rows.
const LAST_12_MONTHS_CTE = Prisma.sql`months AS (
  SELECT gs AS start FROM generate_series(
    date_trunc('month', NOW() AT TIME ZONE 'UTC') - INTERVAL '11 months',
    date_trunc('month', NOW() AT TIME ZONE 'UTC'),
    '1 month'::interval) AS gs
)`;

// `AND r."createdAt" >= since` when a window applies, nothing otherwise.
function sinceClause(since: Date | null, column = Prisma.sql`r."createdAt"`): Prisma.Sql {
  return since ? Prisma.sql`AND ${column} >= ${since}` : Prisma.empty;
}

// ─── Requests ────────────────────────────────────────────────────────────────

export interface RequestOverview {
  total: number;
  byStatus: Record<Status, number>;
  byMediaType: Record<Media, number>;
  // Requests carrying an approval decision (approvedAt), whatever happened next.
  approved: number;
  // Requests created already-fulfilled: a copy of a title another request had
  // made AVAILABLE. Neither approved nor declined — nobody decided anything.
  mirrored: number;
}

export async function getRequestOverview(since: Date | null): Promise<RequestOverview> {
  const where = since ? { createdAt: { gte: since } } : {};
  const [byStatus, byType, approved, mirrored] = await Promise.all([
    prisma.mediaRequest.groupBy({ by: ["status"], where, _count: { _all: true } }),
    prisma.mediaRequest.groupBy({ by: ["mediaType"], where, _count: { _all: true } }),
    prisma.mediaRequest.count({ where: { ...where, approvedAt: { not: null } } }),
    prisma.mediaRequest.count({ where: { ...where, status: "AVAILABLE", approvedAt: null } }),
  ]);
  const s: Record<Status, number> = { PENDING: 0, APPROVED: 0, DECLINED: 0, AVAILABLE: 0 };
  for (const r of byStatus) s[r.status as Status] = r._count._all;
  const m: Record<Media, number> = { MOVIE: 0, TV: 0 };
  for (const r of byType) m[r.mediaType as Media] = r._count._all;
  return {
    total: s.PENDING + s.APPROVED + s.DECLINED + s.AVAILABLE,
    byStatus: s,
    byMediaType: m,
    approved,
    mirrored,
  };
}

export interface DurationStat {
  count: number;
  medianSeconds: number | null;
  p90Seconds: number | null;
}

export interface FulfillmentStats {
  // Time from request to an admin's approval. Auto-approvals and rows whose
  // approval time is unknown (approvedAt backfilled to createdAt) are left out.
  approve: DurationStat;
  // Approval → available.
  download: DurationStat;
  // Request → available, for requests that were approved.
  total: DurationStat & { avgSeconds: number | null };
  autoApproved: number;
  adminApproved: number;
  byMediaType: Record<Media, { download: DurationStat; total: DurationStat }>;
}

const emptyDuration = (): DurationStat => ({ count: 0, medianSeconds: null, p90Seconds: null });

// Who counts:
//   - only requests that were APPROVED (approvedAt set). A copy created already
//     available (approvedAt null, availableAt = its creation) and a PENDING
//     request a library sync marked available (nobody approved it) used to land
//     in the average as near-zero "fulfillments".
//   - approvedAt = createdAt EXACTLY on a row created BEFORE the one-time
//     backfill ran (request-approval.ts, its Setting marker) is a row older than
//     the column: its approval time is unknown, so it sits out of the approve and
//     download figures but still counts request → available. The marker bound is
//     load-bearing: auto-approve sets approvedAt and Prisma fills createdAt in
//     the same millisecond most of the time, so equality alone read most
//     auto-approved requests as backfill and dropped them from every figure. No
//     marker ⇒ the backfill never ran ⇒ no backfilled rows.
// Known residue, accepted: availableAt is re-stamped when a title that left the
// library comes back, so such a request reads slower than it was.
export async function getFulfillmentStats(since: Date | null): Promise<FulfillmentStats> {
  const marker = await prisma.setting.findUnique({ where: { key: REQUEST_APPROVAL_BACKFILL_KEY } });
  const backfillRanAt = marker ? new Date(marker.value) : null;
  const legacy = backfillRanAt && !Number.isNaN(backfillRanAt.getTime())
    ? Prisma.sql`(r."approvedAt" = r."createdAt" AND r."createdAt" < ${backfillRanAt})`
    : Prisma.sql`false`;
  // Each non-legacy row is EITHER auto- or admin-approved: an approval inside
  // the auto window, or one recorded before its request (clock skew, imported
  // rows), is auto; everything else is an admin's. The two counts add up to the
  // non-legacy total.
  const rows = await queryRows<{
    media_type: Media | null;
    approve_n: bigint; approve_med: number | null; approve_p90: number | null;
    download_n: bigint; download_med: number | null; download_p90: number | null;
    total_n: bigint; total_med: number | null; total_p90: number | null; total_avg: number | null;
    auto_n: bigint; admin_n: bigint;
  }>(Prisma.sql`
    WITH r AS (
      SELECT r."mediaType" AS media_type,
             EXTRACT(EPOCH FROM (r."approvedAt" - r."createdAt"))::float8 AS approve_s,
             ${legacy} AS legacy,
             CASE WHEN r.status = 'AVAILABLE' AND r."availableAt" > r."approvedAt"
                  THEN EXTRACT(EPOCH FROM (r."availableAt" - r."approvedAt"))::float8 END AS download_s,
             CASE WHEN r.status = 'AVAILABLE' AND r."availableAt" > r."createdAt"
                  THEN EXTRACT(EPOCH FROM (r."availableAt" - r."createdAt"))::float8 END AS total_s
      FROM "MediaRequest" r
      WHERE r."approvedAt" IS NOT NULL ${sinceClause(since)}
    ),
    k AS (
      SELECT r.*,
             (NOT legacy AND approve_s >= ${AUTO_APPROVE_WINDOW_SECONDS}::float8) AS by_admin,
             (NOT legacy AND approve_s < ${AUTO_APPROVE_WINDOW_SECONDS}::float8) AS by_auto
      FROM r
    )
    SELECT media_type,
      COUNT(*) FILTER (WHERE by_admin)::bigint AS approve_n,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY approve_s) FILTER (WHERE by_admin) AS approve_med,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY approve_s) FILTER (WHERE by_admin) AS approve_p90,
      COUNT(download_s) FILTER (WHERE NOT legacy)::bigint AS download_n,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY download_s) FILTER (WHERE NOT legacy) AS download_med,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY download_s) FILTER (WHERE NOT legacy) AS download_p90,
      COUNT(total_s)::bigint AS total_n,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY total_s) AS total_med,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY total_s) AS total_p90,
      AVG(total_s)::float8 AS total_avg,
      COUNT(*) FILTER (WHERE by_auto)::bigint AS auto_n,
      COUNT(*) FILTER (WHERE by_admin)::bigint AS admin_n
    FROM k
    GROUP BY GROUPING SETS ((), (media_type))
  `);

  const dur = (n: unknown, med: unknown, p90: unknown): DurationStat => ({
    count: num(n),
    medianSeconds: numOrNull(med),
    p90Seconds: numOrNull(p90),
  });
  const out: FulfillmentStats = {
    approve: emptyDuration(),
    download: emptyDuration(),
    total: { ...emptyDuration(), avgSeconds: null },
    autoApproved: 0,
    adminApproved: 0,
    byMediaType: {
      MOVIE: { download: emptyDuration(), total: emptyDuration() },
      TV: { download: emptyDuration(), total: emptyDuration() },
    },
  };
  for (const r of rows) {
    if (r.media_type === "MOVIE" || r.media_type === "TV") {
      out.byMediaType[r.media_type] = {
        download: dur(r.download_n, r.download_med, r.download_p90),
        total: dur(r.total_n, r.total_med, r.total_p90),
      };
      continue;
    }
    out.approve = dur(r.approve_n, r.approve_med, r.approve_p90);
    out.download = dur(r.download_n, r.download_med, r.download_p90);
    out.total = { ...dur(r.total_n, r.total_med, r.total_p90), avgSeconds: numOrNull(r.total_avg) };
    out.autoApproved = num(r.auto_n);
    out.adminApproved = num(r.admin_n);
  }
  return out;
}

export interface MonthBucket {
  month: string; // "YYYY-MM" (UTC)
  count: number;
  byStatus: Record<Status, number>;
}

// The last 12 calendar months (UTC), oldest first, every month present even
// with no requests. Range predicate on the raw timestamp so it can be served
// from an index rather than formatting every row of the table.
export async function getRequestsByMonth(): Promise<MonthBucket[]> {
  const rows = await queryRows<{ month: string; status: Status | null; count: bigint }>(Prisma.sql`
    WITH ${LAST_12_MONTHS_CTE}
    SELECT to_char(m.start, 'YYYY-MM') AS month, r.status, COUNT(r.id)::bigint AS count
    FROM months m
    LEFT JOIN "MediaRequest" r
      ON r."createdAt" >= m.start AND r."createdAt" < m.start + INTERVAL '1 month'
    GROUP BY m.start, r.status
    ORDER BY m.start
  `);
  const byMonth = new Map<string, MonthBucket>();
  for (const r of rows) {
    let b = byMonth.get(r.month);
    if (!b) {
      b = { month: r.month, count: 0, byStatus: { PENDING: 0, APPROVED: 0, DECLINED: 0, AVAILABLE: 0 } };
      byMonth.set(r.month, b);
    }
    if (r.status) {
      const n = num(r.count);
      b.byStatus[r.status] += n;
      b.count += n;
    }
  }
  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
}

export interface PendingQueue {
  // Awaiting a decision: PENDING and never approved. A PENDING row WITH an
  // approval is a rolled-back push (see stuck requests), not queue work.
  requests: number;
  titles: number;
  oldestCreatedAt: string | null;
  olderThanWarn: number;
  olderThanAlert: number;
}

export async function getPendingQueue(): Promise<PendingQueue> {
  const [row] = await queryRows<{
    requests: bigint; titles: bigint; oldest: Date | null; warn: bigint; alert: bigint;
  }>(Prisma.sql`
    SELECT COUNT(*)::bigint AS requests,
           COUNT(DISTINCT (r."tmdbId", r."mediaType"))::bigint AS titles,
           MIN(r."createdAt") AS oldest,
           COUNT(*) FILTER (WHERE r."createdAt" < NOW() - make_interval(days => ${PENDING_AGE_WARN_DAYS}::int))::bigint AS warn,
           COUNT(*) FILTER (WHERE r."createdAt" < NOW() - make_interval(days => ${PENDING_AGE_ALERT_DAYS}::int))::bigint AS alert
    FROM "MediaRequest" r
    WHERE r.status = 'PENDING' AND r."approvedAt" IS NULL
  `);
  return {
    requests: num(row?.requests),
    titles: num(row?.titles),
    oldestCreatedAt: row?.oldest ? new Date(row.oldest).toISOString() : null,
    olderThanWarn: num(row?.warn),
    olderThanAlert: num(row?.alert),
  };
}

export interface WantedTitle {
  tmdbId: number;
  mediaType: Media;
  title: string;
  requesters: number;
  oldestCreatedAt: string;
}

// Pending titles ranked by how many different people asked for them.
export async function getMostWantedPending(limit = 8): Promise<WantedTitle[]> {
  const rows = await queryRows<{
    tmdbId: number; mediaType: Media; title: string; requesters: bigint; oldest: Date;
  }>(Prisma.sql`
    SELECT r."tmdbId", r."mediaType", MAX(r.title) AS title,
           COUNT(DISTINCT r."requestedBy")::bigint AS requesters,
           MIN(r."createdAt") AS oldest
    FROM "MediaRequest" r
    WHERE r.status = 'PENDING' AND r."approvedAt" IS NULL
    GROUP BY r."tmdbId", r."mediaType"
    ORDER BY requesters DESC, oldest ASC, r."tmdbId" ASC
    LIMIT ${limit}::int
  `);
  return rows.map((r) => ({
    tmdbId: r.tmdbId,
    mediaType: r.mediaType,
    title: r.title,
    requesters: num(r.requesters),
    oldestCreatedAt: new Date(r.oldest).toISOString(),
  }));
}

// Every stuck reason, in the order the stats page lists them. The type is
// derived from it, so a new reason can't miss the page's totals or grid.
export const STUCK_REASONS = ["push-failed", "not-in-arr", "slow-download"] as const;
export type StuckReason = (typeof STUCK_REASONS)[number];

export interface StuckRequest {
  id: string;
  tmdbId: number;
  mediaType: Media;
  title: string;
  arrInstance: string;
  reason: StuckReason;
  approvedAt: string;
  lastArrPushAt: string | null;
}

export interface StuckRequests {
  counts: Record<StuckReason, number>;
  oldest: StuckRequest[];
}

// Approved requests that are not turning into files:
//   push-failed   — PENDING with an approval: the Radarr/Sonarr add failed and
//                   rolled the request back (approvedAt is kept on purpose).
//   not-in-arr    — APPROVED, the sync has already tried a re-push
//                   (lastArrPushAt), and the instance still lists it as neither
//                   wanted nor downloaded.
//   slow-download — APPROVED for over STUCK_DOWNLOAD_DAYS and still wanted.
// The two *arr-cache verdicts only apply while that integration is enabled —
// a disabled one keeps stale cache rows that would read as anything.
export async function getStuckRequests(limit = 10): Promise<StuckRequests> {
  const [radarrOn, sonarrOn] = await Promise.all([
    isFeatureEnabled("feature.integration.radarr"),
    isFeatureEnabled("feature.integration.sonarr"),
  ]);
  const classified = Prisma.sql`
    WITH c AS (
      SELECT r.id, r."tmdbId", r."mediaType", r.title, r."arrInstance", r."approvedAt", r."lastArrPushAt",
        CASE
          WHEN r.status = 'PENDING' THEN 'push-failed'
          WHEN NOT (CASE WHEN r."mediaType" = 'MOVIE' THEN ${radarrOn}::boolean ELSE ${sonarrOn}::boolean END) THEN NULL
          WHEN r."mediaType" = 'MOVIE' AND EXISTS (
                 SELECT 1 FROM "RadarrWantedItem" w WHERE w."tmdbId" = r."tmdbId" AND w."arrInstance" = r."arrInstance")
            THEN CASE WHEN r."approvedAt" < NOW() - make_interval(days => ${STUCK_DOWNLOAD_DAYS}::int) THEN 'slow-download' END
          WHEN r."mediaType" = 'TV' AND EXISTS (
                 SELECT 1 FROM "SonarrWantedItem" w WHERE w."tmdbId" = r."tmdbId" AND w."arrInstance" = r."arrInstance")
            THEN CASE WHEN r."approvedAt" < NOW() - make_interval(days => ${STUCK_DOWNLOAD_DAYS}::int) THEN 'slow-download' END
          WHEN r."lastArrPushAt" IS NOT NULL AND NOT EXISTS (
                 SELECT 1 FROM "RadarrAvailableItem" a WHERE r."mediaType" = 'MOVIE' AND a."tmdbId" = r."tmdbId" AND a."arrInstance" = r."arrInstance"
                 UNION ALL
                 SELECT 1 FROM "SonarrAvailableItem" a WHERE r."mediaType" = 'TV' AND a."tmdbId" = r."tmdbId" AND a."arrInstance" = r."arrInstance")
            THEN 'not-in-arr'
        END AS reason
      FROM "MediaRequest" r
      WHERE r."approvedAt" IS NOT NULL AND r.status IN ('PENDING', 'APPROVED')
    )`;
  // ONE pass over the classification (its EXISTS probes run once per row): the
  // oldest `limit` rows, plus each reason's first row to carry that reason's
  // FULL count past the list's cut.
  const all = await queryRows<{
    id: string; tmdbId: number; mediaType: Media; title: string; arrInstance: string;
    reason: StuckReason; approvedAt: Date; lastArrPushAt: Date | null;
    reason_count: bigint; rn: bigint;
  }>(Prisma.sql`
    ${classified}
    SELECT * FROM (
      SELECT c.*,
             COUNT(*) OVER (PARTITION BY c.reason)::bigint AS reason_count,
             ROW_NUMBER() OVER (ORDER BY c."approvedAt" ASC, c.id ASC) AS rn,
             ROW_NUMBER() OVER (PARTITION BY c.reason ORDER BY c."approvedAt" ASC, c.id ASC) AS rn_reason
      FROM c
      WHERE c.reason IS NOT NULL
    ) t
    WHERE t.rn <= ${limit}::int OR t.rn_reason = 1
    ORDER BY t.rn ASC
  `);
  const out: StuckRequests = { counts: { "push-failed": 0, "not-in-arr": 0, "slow-download": 0 }, oldest: [] };
  for (const r of all) out.counts[r.reason] = num(r.reason_count);
  out.oldest = all.filter((r) => num(r.rn) <= limit).map((r) => ({
    id: r.id,
    tmdbId: r.tmdbId,
    mediaType: r.mediaType,
    title: r.title,
    arrInstance: r.arrInstance,
    reason: r.reason,
    approvedAt: new Date(r.approvedAt).toISOString(),
    lastArrPushAt: r.lastArrPushAt ? new Date(r.lastArrPushAt).toISOString() : null,
  }));
  return out;
}

// Filed by the watchlist auto-request, per AutoRequestLedger source.
export interface AutoRequestSources {
  // The in-app (Summonarr) watchlist.
  watchlist: number;
  plexWatchlist: number;
  traktWatchlist: number;
}

export interface RequestSources extends AutoRequestSources {
  // Everything else: the web app, the iOS app, Discord and bulk requests, which
  // nothing records apart.
  other: number;
}

// Typed on AutoRequestSource, so a new ledger source fails to compile until it
// has a bucket of its own here.
const SOURCE_BUCKET: Record<AutoRequestSource, keyof AutoRequestSources> = {
  watchlist: "watchlist",
  "plex-watchlist": "plexWatchlist",
  "trakt-watchlist": "traktWatchlist",
};

// Independent of the window's total, so it runs alongside the other aggregates;
// requestSources() derives `other` once both are in. A request several ledger
// rows point at (two people's watchlists, one request) is credited to ONE
// source — the earliest ledger row's — so the buckets never sum past the
// requests they count.
export async function getAutoRequestSources(since: Date | null): Promise<AutoRequestSources> {
  const rows = await queryRows<{ source: string; count: bigint }>(Prisma.sql`
    SELECT t.source, COUNT(*)::bigint AS count
    FROM (
      SELECT DISTINCT ON (r.id) l.source
      FROM "MediaRequest" r
      JOIN "AutoRequestLedger" l ON l."requestId" = r.id
      WHERE TRUE ${sinceClause(since)}
      ORDER BY r.id, l."createdAt" ASC, l.id ASC
    ) t
    GROUP BY t.source
  `);
  const out: AutoRequestSources = { watchlist: 0, plexWatchlist: 0, traktWatchlist: 0 };
  for (const r of rows) {
    // A value no AutoRequestSource names (none is written today) stays in `other`
    // rather than being credited to a source it isn't.
    const bucket = Object.hasOwn(SOURCE_BUCKET, r.source) ? SOURCE_BUCKET[r.source as AutoRequestSource] : null;
    if (bucket) out[bucket] += num(r.count);
  }
  return out;
}

// `total` is the window's request count (getRequestOverview).
export function requestSources(auto: AutoRequestSources, total: number): RequestSources {
  return { ...auto, other: Math.max(0, total - auto.watchlist - auto.plexWatchlist - auto.traktWatchlist) };
}

export interface InstanceCount {
  slug: string;
  name: string;
  count: number;
}

export async function getRequestsByInstance(since: Date | null): Promise<InstanceCount[]> {
  const [rows, radarr, sonarr] = await Promise.all([
    prisma.mediaRequest.groupBy({
      by: ["arrInstance"],
      where: since ? { createdAt: { gte: since } } : {},
      _count: { _all: true },
    }),
    getArrInstances("radarr"),
    getArrInstances("sonarr"),
  ]);
  // A slug on both services keeps the Radarr name, like the request queue.
  const names = new Map<string, string>();
  for (const i of [...sonarr, ...radarr]) names.set(i.slug, i.name);
  return rows
    // A slug no longer registered (or the legacy 4K one, synthesized only while
    // configured) still has requests; show it rather than drop them.
    .map((r) => ({ slug: r.arrInstance, name: names.get(r.arrInstance) ?? (r.arrInstance === "4k" ? "4K" : r.arrInstance), count: r._count._all }))
    .sort((a, b) => b.count - a.count || a.slug.localeCompare(b.slug));
}

// ─── Users ───────────────────────────────────────────────────────────────────

export interface UserStats {
  // Accounts that can sign in (not disabled). Disabled includes purged.
  active: number;
  disabled: number;
  // Distinct accounts with a session seen in the last 30 days.
  seenLast30Days: number;
  // Distinct accounts that filed a request in the window.
  requesters: number;
  newByMonth: Array<{ month: string; count: number }>;
}

export async function countActiveUsers(): Promise<number> {
  return prisma.user.count({ where: { deactivatedAt: null } });
}

export async function getUserStats(since: Date | null): Promise<UserStats> {
  const [active, disabled, seen, requesters, months] = await Promise.all([
    countActiveUsers(),
    prisma.user.count({ where: { deactivatedAt: { not: null } } }),
    queryRows<{ n: bigint }>(Prisma.sql`
      SELECT COUNT(DISTINCT s."userId")::bigint AS n
      FROM "AuthSession" s JOIN "User" u ON u.id = s."userId"
      WHERE s."lastSeenAt" >= NOW() - INTERVAL '30 days' AND u."deactivatedAt" IS NULL
    `),
    queryRows<{ n: bigint }>(Prisma.sql`
      SELECT COUNT(DISTINCT r."requestedBy")::bigint AS n FROM "MediaRequest" r WHERE TRUE ${sinceClause(since)}
    `),
    queryRows<{ month: string; count: bigint }>(Prisma.sql`
      WITH ${LAST_12_MONTHS_CTE}
      SELECT to_char(m.start, 'YYYY-MM') AS month, COUNT(u.id)::bigint AS count
      FROM months m
      LEFT JOIN "User" u ON u."createdAt" >= m.start AND u."createdAt" < m.start + INTERVAL '1 month'
      GROUP BY m.start ORDER BY m.start
    `),
  ]);
  return {
    active,
    disabled,
    seenLast30Days: num(seen[0]?.n),
    requesters: num(requesters[0]?.n),
    newByMonth: months.map((m) => ({ month: m.month, count: num(m.count) })),
  };
}

export interface TopRequester {
  id: string;
  name: string | null;
  email: string;
  count: number;
  available: number;
  declined: number;
  disabled: boolean;
}

// Grouped by account id (an email can change; the id can't), ties broken by
// name then id so the list doesn't reshuffle between renders.
export async function getTopRequesters(since: Date | null, limit = 10): Promise<TopRequester[]> {
  const rows = await queryRows<{
    id: string; name: string | null; email: string; count: bigint; available: bigint; declined: bigint; disabled: boolean;
  }>(Prisma.sql`
    SELECT u.id, u.name, u.email,
           COUNT(r.id)::bigint AS count,
           COUNT(r.id) FILTER (WHERE r.status = 'AVAILABLE')::bigint AS available,
           COUNT(r.id) FILTER (WHERE r.status = 'DECLINED')::bigint AS declined,
           (u."deactivatedAt" IS NOT NULL) AS disabled
    FROM "MediaRequest" r
    JOIN "User" u ON u.id = r."requestedBy"
    WHERE TRUE ${sinceClause(since)}
    GROUP BY u.id
    ORDER BY count DESC, u.name ASC NULLS LAST, u.id ASC
    LIMIT ${limit}::int
  `);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    count: num(r.count),
    available: num(r.available),
    declined: num(r.declined),
    disabled: !!r.disabled,
  }));
}

// ─── Library ─────────────────────────────────────────────────────────────────

export interface ServerLibrary {
  service: "plex" | "jellyfin";
  slug: string;
  name: string;
  movies: number;
  series: number;
}

export interface LibraryStats {
  // Distinct titles across every Plex AND Jellyfin server — a title on two
  // servers is one title.
  unique: { movies: number; series: number };
  // Distinct titles per service (a title on two Plex servers counts once).
  perService: Record<"plex" | "jellyfin", { movies: number; series: number; episodes: number }>;
  servers: ServerLibrary[];
}

export async function getLibraryStats(): Promise<LibraryStats> {
  const [plexByInst, jfByInst, distinctRows, episodes, plexInst, jfInst] = await Promise.all([
    prisma.plexLibraryItem.groupBy({ by: ["serverInstance", "mediaType"], _count: { _all: true } }),
    prisma.jellyfinLibraryItem.groupBy({ by: ["serverInstance", "mediaType"], _count: { _all: true } }),
    queryRows<{ service: string; mediaType: Media; n: bigint }>(Prisma.sql`
      SELECT 'plex' AS service, "mediaType", COUNT(DISTINCT "tmdbId")::bigint AS n FROM "PlexLibraryItem" GROUP BY "mediaType"
      UNION ALL
      SELECT 'jellyfin', "mediaType", COUNT(DISTINCT "tmdbId")::bigint FROM "JellyfinLibraryItem" GROUP BY "mediaType"
      UNION ALL
      SELECT 'all', "mediaType", COUNT(*)::bigint FROM (
        SELECT "tmdbId", "mediaType" FROM "PlexLibraryItem"
        UNION
        SELECT "tmdbId", "mediaType" FROM "JellyfinLibraryItem"
      ) t GROUP BY "mediaType"
    `),
    prisma.tVEpisodeCache.groupBy({ by: ["source"], _count: { _all: true } }),
    getMediaInstances("plex"),
    getMediaInstances("jellyfin"),
  ]);

  const out: LibraryStats = {
    unique: { movies: 0, series: 0 },
    perService: {
      plex: { movies: 0, series: 0, episodes: 0 },
      jellyfin: { movies: 0, series: 0, episodes: 0 },
    },
    servers: [],
  };
  for (const r of distinctRows) {
    const target = r.service === "all" ? out.unique : r.service === "plex" ? out.perService.plex : r.service === "jellyfin" ? out.perService.jellyfin : null;
    if (!target) continue;
    if (r.mediaType === "MOVIE") target.movies = num(r.n);
    else if (r.mediaType === "TV") target.series = num(r.n);
  }
  for (const e of episodes) {
    if (e.source === "plex" || e.source === "jellyfin") out.perService[e.source].episodes = e._count._all;
  }

  out.servers = [
    ...serverLibraries("plex", plexByInst, plexInst),
    ...serverLibraries("jellyfin", jfByInst, jfInst),
  ];
  return out;
}

// One service's per-server title counts, in registry order (the default first,
// then the admin's order); a slug no longer registered sorts last under its slug.
function serverLibraries(
  service: "plex" | "jellyfin",
  rows: ReadonlyArray<{ serverInstance: string; mediaType: string; _count: { _all: number } }>,
  registry: ReadonlyArray<{ slug: string; name: string }>,
): ServerLibrary[] {
  const position = new Map<string, { index: number; name: string }>();
  registry.forEach((inst, index) => {
    if (!position.has(inst.slug)) position.set(inst.slug, { index, name: inst.name });
  });
  const bySlug = new Map<string, ServerLibrary>();
  for (const r of rows) {
    let s = bySlug.get(r.serverInstance);
    if (!s) {
      s = { service, slug: r.serverInstance, name: position.get(r.serverInstance)?.name ?? r.serverInstance, movies: 0, series: 0 };
      bySlug.set(r.serverInstance, s);
    }
    if (r.mediaType === "MOVIE") s.movies += r._count._all;
    else if (r.mediaType === "TV") s.series += r._count._all;
  }
  const order = (slug: string) => position.get(slug)?.index ?? Number.MAX_SAFE_INTEGER;
  return [...bySlug.values()].sort((a, b) => order(a.slug) - order(b.slug));
}

// Titles first added to ANY server in each of the last 12 months (UTC). Only
// titles still in a library are visible — nothing records what was removed.
export async function getLibraryGrowth(): Promise<Array<{ month: string; movies: number; series: number }>> {
  const rows = await queryRows<{ month: string; movies: bigint; series: bigint }>(Prisma.sql`
    WITH ${LAST_12_MONTHS_CTE},
    firsts AS (
      SELECT "tmdbId", "mediaType", MIN("addedAt") AS added
      FROM (
        SELECT "tmdbId", "mediaType", "addedAt" FROM "PlexLibraryItem" WHERE "addedAt" IS NOT NULL
        UNION ALL
        SELECT "tmdbId", "mediaType", "addedAt" FROM "JellyfinLibraryItem" WHERE "addedAt" IS NOT NULL
      ) t
      GROUP BY "tmdbId", "mediaType"
    )
    SELECT to_char(m.start, 'YYYY-MM') AS month,
           COUNT(f."tmdbId") FILTER (WHERE f."mediaType" = 'MOVIE')::bigint AS movies,
           COUNT(f."tmdbId") FILTER (WHERE f."mediaType" = 'TV')::bigint AS series
    FROM months m
    LEFT JOIN firsts f ON f.added >= m.start AND f.added < m.start + INTERVAL '1 month'
    GROUP BY m.start ORDER BY m.start
  `);
  return rows.map((r) => ({ month: r.month, movies: num(r.movies), series: num(r.series) }));
}

// ─── Issues ──────────────────────────────────────────────────────────────────

export interface IssueStats {
  open: number;
  inProgress: number;
  resolved: number;
  // Unresolved (OPEN + IN_PROGRESS) by type.
  backlogByType: Array<{ type: string; count: number }>;
  unclaimed: number;
  noAdminReply: number;
  oldestOpenCreatedAt: string | null;
  // Created / resolved inside the window.
  createdInRange: number;
  resolvedInRange: number;
  // Over issues whose resolvedAt is known (resolved since the column existed).
  resolve: DurationStat;
}

export async function getIssueStats(since: Date | null): Promise<IssueStats> {
  const unresolved = { status: { in: ["OPEN", "IN_PROGRESS"] as Array<"OPEN" | "IN_PROGRESS"> } };
  const [byStatus, byType, unclaimed, noReply, oldest, created, resolve] = await Promise.all([
    prisma.issue.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.issue.groupBy({ by: ["issueType"], where: unresolved, _count: { _all: true } }),
    prisma.issue.count({ where: { ...unresolved, claimedBy: null } }),
    prisma.issue.count({ where: { ...unresolved, messages: { none: { fromAdmin: true } } } }),
    prisma.issue.findFirst({ where: unresolved, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
    prisma.issue.count({ where: since ? { createdAt: { gte: since } } : {} }),
    queryRows<{ n: bigint; med: number | null; p90: number | null }>(Prisma.sql`
      SELECT COUNT(*)::bigint AS n,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY s) AS med,
             percentile_cont(0.9) WITHIN GROUP (ORDER BY s) AS p90
      FROM (
        SELECT EXTRACT(EPOCH FROM (i."resolvedAt" - i."createdAt"))::float8 AS s
        FROM "Issue" i
        WHERE i.status = 'RESOLVED' AND i."resolvedAt" IS NOT NULL ${sinceClause(since, Prisma.sql`i."resolvedAt"`)}
      ) t
    `),
  ]);
  const s = new Map(byStatus.map((r) => [r.status, r._count._all]));
  const r0 = resolve[0];
  return {
    open: s.get("OPEN") ?? 0,
    inProgress: s.get("IN_PROGRESS") ?? 0,
    resolved: s.get("RESOLVED") ?? 0,
    backlogByType: byType
      .map((r) => ({ type: r.issueType as string, count: r._count._all }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)),
    unclaimed,
    noAdminReply: noReply,
    oldestOpenCreatedAt: oldest?.createdAt ? oldest.createdAt.toISOString() : null,
    createdInRange: created,
    resolvedInRange: num(r0?.n),
    resolve: { count: num(r0?.n), medianSeconds: numOrNull(r0?.med), p90Seconds: numOrNull(r0?.p90) },
  };
}

// ─── Deletion votes ──────────────────────────────────────────────────────────

export interface VotedTitle {
  tmdbId: number;
  mediaType: Media;
  title: string;
  votes: number;
}

export async function getTopDeletionVotes(limit = 5): Promise<{ threshold: number; titles: VotedTitle[]; total: number }> {
  const [groups, thresholdRow, total] = await Promise.all([
    prisma.deletionVote.groupBy({
      by: ["tmdbId", "mediaType"],
      _count: { id: true },
      _max: { title: true, createdAt: true },
      orderBy: [{ _count: { id: "desc" } }, { _max: { createdAt: "desc" } }, { tmdbId: "asc" }],
      take: limit,
    }),
    prisma.setting.findUnique({ where: { key: DELETION_VOTE_THRESHOLD_KEY } }),
    prisma.deletionVote.count(),
  ]);
  return {
    threshold: parseDeletionVoteThreshold(thresholdRow?.value),
    total,
    titles: groups.map((g) => ({
      tmdbId: g.tmdbId,
      mediaType: g.mediaType as Media,
      title: g._max.title ?? "",
      votes: g._count.id,
    })),
  };
}

// ─── Storage (slow: live Radarr/Sonarr calls) ───────────────────────────────

export interface InstanceLibrarySize {
  service: "radarr" | "sonarr";
  slug: string;
  name: string;
  titles: number;
  bytes: number;
}

export interface StorageStats {
  disks: MergedDisk[];
  unreachable: ArrDiskSpace["unreachable"];
  libraries: InstanceLibrarySize[];
  listingErrors: Array<{ service: "radarr" | "sonarr"; slug: string; name: string }>;
  // Present only while Library cleanup is enabled.
  reclaimable: { titles: number; bytes: number } | null;
  // Present only while the never-watched page is enabled (guardrail 14d).
  // `unknown`/`possible` count the titles AND seasons the verdict could not
  // call either way, so zero never-watched is not read as "all watched" while
  // nothing could be judged (`neverWatchedLine` in admin-stats.ts).
  neverWatched: {
    titles: number;
    bytes: number;
    seasons: number;
    seasonBytes: number;
    unknown: number;
    possible: number;
    trackingOn: boolean;
  } | null;
  computedAt: string;
}

// Every view would otherwise list every Radarr/Sonarr library in full (up to
// 50 MB a body) — the same listing the cleanup page makes on demand. Admin
// numbers a few minutes stale are fine; concurrent viewers share one fetch.
const STORAGE_TTL_MS = 5 * 60 * 1000;
const storageCache = processSingleton("admin-stats:storage", () => ({ value: null as StorageStats | null, at: 0 }));

export async function getStorageStats(opts: { fresh?: boolean } = {}): Promise<StorageStats> {
  const fresh = opts.fresh === true;
  if (!fresh && storageCache.value && Date.now() - storageCache.at < STORAGE_TTL_MS) return storageCache.value;
  // A fresh caller never joins a non-fresh computation already in flight (it
  // would get the cached library index it asked to skip).
  return coalesce(fresh ? "admin-stats:storage:fresh" : "admin-stats:storage", async () => {
    const value = await computeStorageStats(fresh);
    storageCache.value = value;
    storageCache.at = Date.now();
    return value;
  });
}

type ArrService = "radarr" | "sonarr";
type ArrLibraryIndex = Awaited<ReturnType<typeof getCachedArrLibraryIndex>>["index"];
type SharedWatchFacts = NonNullable<Parameters<typeof getNeverWatchedReport>[0]>["shared"];

async function computeStorageStats(fresh: boolean): Promise<StorageStats> {
  const [disk, { index, at: indexAt }, radarr, sonarr, cleanupOn, neverWatchedOn] = await Promise.all([
    getArrDiskSpace(),
    // Shared with the never-watched report (same 5-minute window).
    getCachedArrLibraryIndex({ fresh }),
    getArrInstances("radarr"),
    getArrInstances("sonarr"),
    isFeatureEnabled(CLEANUP_FEATURE_KEY),
    isFeatureEnabled(NEVER_WATCHED_FEATURE_KEY),
  ]);
  const svcLabel = arrServiceLabeller(radarr, sonarr);

  const disks = mergeDiskGroups([
    ...(disk.radarr ? [{ source: "Radarr", entries: disk.radarr }] : []),
    ...(disk.sonarr ? [{ source: "Sonarr", entries: disk.sonarr }] : []),
    ...disk.extra.map((g) => ({ source: g.label, entries: g.entries })),
  ]);

  // Both reports below read the same whole-library watch facts (five
  // whole-table PlayHistory aggregates, sessions, upstream evidence, requests,
  // coverage): ONE load for this computation, for the same index and the same
  // `now`, handed to each — and each still computes exactly what it computes on
  // its own page (SharedWatchFacts). Lazy: a never-watched cache hit with
  // cleanup off loads nothing.
  const shared = cleanupOn || neverWatchedOn
    ? shareLibraryWatchFacts(index, indexAt, { now: new Date(), seasons: neverWatchedOn })
    : null;

  // The never-watched report FIRST, and awaited before the cleanup report
  // starts: its cache reads its generation before the shared load starts, so a
  // report computed here can be stored for the page. Started by the cleanup
  // report first, the load could predate an invalidation, and the report would
  // be computed for this figure only.
  const neverWatched = neverWatchedOn && shared ? await neverWatchedFigure(shared) : null;
  const reclaimable = cleanupOn && shared ? await reclaimableFigure(index, shared) : null;

  return {
    disks,
    unreachable: disk.unreachable,
    libraries: librarySizes(index, svcLabel),
    listingErrors: index.errors.map((e) => ({ service: e.service, slug: e.instance, name: svcLabel(e.service, e.instance) })),
    reclaimable,
    neverWatched,
    computedAt: new Date().toISOString(),
  };
}

// "Radarr" / "Sonarr (<instance name>)" — the default instance has no suffix.
function arrServiceLabeller(
  radarr: ReadonlyArray<{ slug: string; name: string }>,
  sonarr: ReadonlyArray<{ slug: string; name: string }>,
): (service: ArrService, slug: string) => string {
  const names = { radarr: new Map<string, string>(), sonarr: new Map<string, string>() };
  for (const i of radarr) if (!names.radarr.has(i.slug)) names.radarr.set(i.slug, i.name);
  for (const i of sonarr) if (!names.sonarr.has(i.slug)) names.sonarr.set(i.slug, i.name);
  return (service, slug) =>
    `${service === "radarr" ? "Radarr" : "Sonarr"}${slug ? ` (${names[service].get(slug) ?? slug})` : ""}`;
}

// Titles and bytes on disk per Radarr/Sonarr instance, biggest first.
function librarySizes(index: ArrLibraryIndex, svcLabel: (service: ArrService, slug: string) => string): InstanceLibrarySize[] {
  const sizes = new Map<string, InstanceLibrarySize>();
  const add = (e: ArrLibraryEntry) => {
    const key = `${e.service}:${e.instance}`;
    let s = sizes.get(key);
    if (!s) {
      s = { service: e.service, slug: e.instance, name: svcLabel(e.service, e.instance), titles: 0, bytes: 0 };
      sizes.set(key, s);
    }
    s.titles += 1;
    s.bytes += e.sizeOnDisk;
  };
  for (const list of index.byKey.values()) list.forEach(add);
  for (const list of index.tvdbOnly.values()) list.forEach(add);
  return [...sizes.values()].sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
}

// The never-watched figure, or null when the report failed (logged).
async function neverWatchedFigure(shared: SharedWatchFacts): Promise<StorageStats["neverWatched"]> {
  try {
    const { totals, seasons, trackingOn } = await getNeverWatchedReport({ shared });
    return {
      titles: totals.never.titles,
      bytes: totals.never.bytes,
      seasons: totals.seasons.count,
      seasonBytes: totals.seasons.bytes,
      // The report's totals count unjudged TITLES only; a watched show's
      // season can be unjudged too (an undated episode).
      unknown: totals.unknown + seasons.filter((s) => s.state === "unobservable").length,
      possible: totals.possible + seasons.filter((s) => s.state === "possiblyWatched").length,
      trackingOn,
    };
  } catch (err) {
    console.warn("[admin-stats] never-watched report failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

// What Library cleanup would reclaim, or null when the report failed (logged).
async function reclaimableFigure(
  index: ArrLibraryIndex,
  shared: NonNullable<SharedWatchFacts>,
): Promise<StorageStats["reclaimable"]> {
  try {
    // "cached": a page render never waits on TMDB (CrossRefMode).
    const report = await computeCleanupReport(index, shared.now, undefined, { resolveTargets: true, crossRef: "cached", shared });
    const candidates = report.rows.filter((r) => r.candidate);
    return {
      titles: candidates.length,
      bytes: candidates.reduce((sum, r) => sum + (r.sizeOnDisk ?? 0), 0),
    };
  } catch (err) {
    console.warn("[admin-stats] cleanup report failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

// ─── Watch grades (slow: play-history aggregates) ───────────────────────────

// Letter spread across every active account that has filed a request. null
// while grades are unavailable (feature off, tracking off) or on failure.
export async function getWatchGradeSpreadForStats(): Promise<WatchGradeSpread | null> {
  // groupBy, not findMany + distinct: Prisma applies `distinct` in memory, so
  // that shape sent every request row to Node to find the requesters.
  const rows = await prisma.mediaRequest.groupBy({
    by: ["requestedBy"],
    where: { user: { deactivatedAt: null } },
  });
  if (rows.length === 0) return null;
  const summaries = await getWatchGradeSummaries(rows.map((r) => r.requestedBy));
  return summaries ? watchGradeSpread(summaries.values()) : null;
}
