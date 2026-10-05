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
import { loadArrLibraryIndex, type ArrLibraryEntry } from "./library-cleanup-arr";
import { CLEANUP_FEATURE_KEY, computeCleanupReport } from "./library-cleanup-data";
import { getWatchGradeSummaries } from "./watch-grade-data";
import { watchGradeSpread, type WatchGradeSpread } from "./watch-grade";
import {
  AUTO_APPROVE_WINDOW_SECONDS,
  PENDING_AGE_ALERT_DAYS,
  PENDING_AGE_WARN_DAYS,
  STUCK_DOWNLOAD_DAYS,
  mergeDiskGroups,
  type MergedDisk,
} from "./admin-stats";

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
//   - approvedAt = createdAt EXACTLY is the one-time backfill of rows older than
//     the column (request-approval.ts): their approval time is unknown, so they
//     sit out of the approve and download figures but still count request →
//     available.
// Known residue, accepted: availableAt is re-stamped when a title that left the
// library comes back, so such a request reads slower than it was.
export async function getFulfillmentStats(since: Date | null): Promise<FulfillmentStats> {
  const rows = await prisma.$queryRaw<Array<{
    media_type: Media | null;
    approve_n: bigint; approve_med: number | null; approve_p90: number | null;
    download_n: bigint; download_med: number | null; download_p90: number | null;
    total_n: bigint; total_med: number | null; total_p90: number | null; total_avg: number | null;
    auto_n: bigint; admin_n: bigint;
  }>>(Prisma.sql`
    WITH r AS (
      SELECT r."mediaType" AS media_type,
             EXTRACT(EPOCH FROM (r."approvedAt" - r."createdAt"))::float8 AS approve_s,
             r."approvedAt" = r."createdAt" AS legacy,
             CASE WHEN r.status = 'AVAILABLE' AND r."availableAt" > r."approvedAt"
                  THEN EXTRACT(EPOCH FROM (r."availableAt" - r."approvedAt"))::float8 END AS download_s,
             CASE WHEN r.status = 'AVAILABLE' AND r."availableAt" > r."createdAt"
                  THEN EXTRACT(EPOCH FROM (r."availableAt" - r."createdAt"))::float8 END AS total_s
      FROM "MediaRequest" r
      WHERE r."approvedAt" IS NOT NULL ${sinceClause(since)}
    )
    SELECT media_type,
      COUNT(*) FILTER (WHERE NOT legacy AND approve_s >= ${AUTO_APPROVE_WINDOW_SECONDS}::float8)::bigint AS approve_n,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY approve_s) FILTER (WHERE NOT legacy AND approve_s >= ${AUTO_APPROVE_WINDOW_SECONDS}::float8) AS approve_med,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY approve_s) FILTER (WHERE NOT legacy AND approve_s >= ${AUTO_APPROVE_WINDOW_SECONDS}::float8) AS approve_p90,
      COUNT(download_s) FILTER (WHERE NOT legacy)::bigint AS download_n,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY download_s) FILTER (WHERE NOT legacy) AS download_med,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY download_s) FILTER (WHERE NOT legacy) AS download_p90,
      COUNT(total_s)::bigint AS total_n,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY total_s) AS total_med,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY total_s) AS total_p90,
      AVG(total_s)::float8 AS total_avg,
      COUNT(*) FILTER (WHERE NOT legacy AND ABS(approve_s) < ${AUTO_APPROVE_WINDOW_SECONDS}::float8)::bigint AS auto_n,
      COUNT(*) FILTER (WHERE NOT legacy AND approve_s >= ${AUTO_APPROVE_WINDOW_SECONDS}::float8)::bigint AS admin_n
    FROM r
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
  for (const r of Array.isArray(rows) ? rows : []) {
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
  const rows = await prisma.$queryRaw<Array<{ month: string; status: Status | null; count: bigint }>>(Prisma.sql`
    WITH months AS (
      SELECT gs AS start
      FROM generate_series(
        date_trunc('month', NOW() AT TIME ZONE 'UTC') - INTERVAL '11 months',
        date_trunc('month', NOW() AT TIME ZONE 'UTC'),
        '1 month'::interval
      ) AS gs
    )
    SELECT to_char(m.start, 'YYYY-MM') AS month, r.status, COUNT(r.id)::bigint AS count
    FROM months m
    LEFT JOIN "MediaRequest" r
      ON r."createdAt" >= m.start AND r."createdAt" < m.start + INTERVAL '1 month'
    GROUP BY m.start, r.status
    ORDER BY m.start
  `);
  const byMonth = new Map<string, MonthBucket>();
  for (const r of Array.isArray(rows) ? rows : []) {
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
  const [row] = await prisma.$queryRaw<Array<{
    requests: bigint; titles: bigint; oldest: Date | null; warn: bigint; alert: bigint;
  }>>(Prisma.sql`
    SELECT COUNT(*)::bigint AS requests,
           COUNT(DISTINCT (r."tmdbId", r."mediaType"))::bigint AS titles,
           MIN(r."createdAt") AS oldest,
           COUNT(*) FILTER (WHERE r."createdAt" < NOW() - make_interval(days => ${PENDING_AGE_WARN_DAYS}::int))::bigint AS warn,
           COUNT(*) FILTER (WHERE r."createdAt" < NOW() - make_interval(days => ${PENDING_AGE_ALERT_DAYS}::int))::bigint AS alert
    FROM "MediaRequest" r
    WHERE r.status = 'PENDING' AND r."approvedAt" IS NULL
  `) ?? [];
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
  const rows = await prisma.$queryRaw<Array<{
    tmdbId: number; mediaType: Media; title: string; requesters: bigint; oldest: Date;
  }>>(Prisma.sql`
    SELECT r."tmdbId", r."mediaType", MAX(r.title) AS title,
           COUNT(DISTINCT r."requestedBy")::bigint AS requesters,
           MIN(r."createdAt") AS oldest
    FROM "MediaRequest" r
    WHERE r.status = 'PENDING' AND r."approvedAt" IS NULL
    GROUP BY r."tmdbId", r."mediaType"
    ORDER BY requesters DESC, oldest ASC, r."tmdbId" ASC
    LIMIT ${limit}::int
  `);
  return (Array.isArray(rows) ? rows : []).map((r) => ({
    tmdbId: r.tmdbId,
    mediaType: r.mediaType,
    title: r.title,
    requesters: num(r.requesters),
    oldestCreatedAt: new Date(r.oldest).toISOString(),
  }));
}

export type StuckReason = "push-failed" | "not-in-arr" | "slow-download";

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
  const [counts, oldest] = await Promise.all([
    prisma.$queryRaw<Array<{ reason: StuckReason; count: bigint }>>(Prisma.sql`
      ${classified}
      SELECT reason, COUNT(*)::bigint AS count FROM c WHERE reason IS NOT NULL GROUP BY reason
    `),
    prisma.$queryRaw<Array<{
      id: string; tmdbId: number; mediaType: Media; title: string; arrInstance: string;
      reason: StuckReason; approvedAt: Date; lastArrPushAt: Date | null;
    }>>(Prisma.sql`
      ${classified}
      SELECT * FROM c WHERE reason IS NOT NULL ORDER BY "approvedAt" ASC, id ASC LIMIT ${limit}::int
    `),
  ]);
  const out: StuckRequests = { counts: { "push-failed": 0, "not-in-arr": 0, "slow-download": 0 }, oldest: [] };
  for (const r of Array.isArray(counts) ? counts : []) out.counts[r.reason] = num(r.count);
  out.oldest = (Array.isArray(oldest) ? oldest : []).map((r) => ({
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

export interface RequestSources {
  // Filed by the watchlist auto-request, per AutoRequestLedger source.
  watchlist: number;
  plexWatchlist: number;
  // Everything else: the web app, the iOS app, Discord and bulk requests, which
  // nothing records apart.
  other: number;
}

export async function getRequestSources(since: Date | null, total: number): Promise<RequestSources> {
  const rows = await prisma.$queryRaw<Array<{ source: string; count: bigint }>>(Prisma.sql`
    SELECT l.source, COUNT(DISTINCT r.id)::bigint AS count
    FROM "MediaRequest" r
    JOIN "AutoRequestLedger" l ON l."requestId" = r.id
    WHERE TRUE ${sinceClause(since)}
    GROUP BY l.source
  `);
  let watchlist = 0;
  let plexWatchlist = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r.source === "plex-watchlist") plexWatchlist += num(r.count);
    else watchlist += num(r.count);
  }
  return { watchlist, plexWatchlist, other: Math.max(0, total - watchlist - plexWatchlist) };
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
    prisma.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
      SELECT COUNT(DISTINCT s."userId")::bigint AS n
      FROM "AuthSession" s JOIN "User" u ON u.id = s."userId"
      WHERE s."lastSeenAt" >= NOW() - INTERVAL '30 days' AND u."deactivatedAt" IS NULL
    `),
    prisma.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
      SELECT COUNT(DISTINCT r."requestedBy")::bigint AS n FROM "MediaRequest" r WHERE TRUE ${sinceClause(since)}
    `),
    prisma.$queryRaw<Array<{ month: string; count: bigint }>>(Prisma.sql`
      WITH months AS (
        SELECT gs AS start FROM generate_series(
          date_trunc('month', NOW() AT TIME ZONE 'UTC') - INTERVAL '11 months',
          date_trunc('month', NOW() AT TIME ZONE 'UTC'),
          '1 month'::interval) AS gs
      )
      SELECT to_char(m.start, 'YYYY-MM') AS month, COUNT(u.id)::bigint AS count
      FROM months m
      LEFT JOIN "User" u ON u."createdAt" >= m.start AND u."createdAt" < m.start + INTERVAL '1 month'
      GROUP BY m.start ORDER BY m.start
    `),
  ]);
  return {
    active,
    disabled,
    seenLast30Days: num(seen?.[0]?.n),
    requesters: num(requesters?.[0]?.n),
    newByMonth: (Array.isArray(months) ? months : []).map((m) => ({ month: m.month, count: num(m.count) })),
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
  const rows = await prisma.$queryRaw<Array<{
    id: string; name: string | null; email: string; count: bigint; available: bigint; declined: bigint; disabled: boolean;
  }>>(Prisma.sql`
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
  return (Array.isArray(rows) ? rows : []).map((r) => ({
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
    prisma.$queryRaw<Array<{ service: string; mediaType: Media; n: bigint }>>(Prisma.sql`
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
  for (const r of Array.isArray(distinctRows) ? distinctRows : []) {
    const target = r.service === "all" ? out.unique : r.service === "plex" ? out.perService.plex : r.service === "jellyfin" ? out.perService.jellyfin : null;
    if (!target) continue;
    if (r.mediaType === "MOVIE") target.movies = num(r.n);
    else if (r.mediaType === "TV") target.series = num(r.n);
  }
  for (const e of episodes) {
    if (e.source === "plex" || e.source === "jellyfin") out.perService[e.source].episodes = e._count._all;
  }

  const addServers = (
    service: "plex" | "jellyfin",
    rows: Array<{ serverInstance: string; mediaType: string; _count: { _all: number } }>,
    registry: Array<{ slug: string; name: string }>,
  ) => {
    const bySlug = new Map<string, ServerLibrary>();
    for (const r of rows) {
      let s = bySlug.get(r.serverInstance);
      if (!s) {
        const name = registry.find((i) => i.slug === r.serverInstance)?.name ?? r.serverInstance;
        s = { service, slug: r.serverInstance, name, movies: 0, series: 0 };
        bySlug.set(r.serverInstance, s);
      }
      if (r.mediaType === "MOVIE") s.movies += r._count._all;
      else if (r.mediaType === "TV") s.series += r._count._all;
    }
    // Registry order: the default first, then the admin's order.
    const order = (slug: string) => {
      const i = registry.findIndex((x) => x.slug === slug);
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    out.servers.push(...[...bySlug.values()].sort((a, b) => order(a.slug) - order(b.slug)));
  };
  addServers("plex", plexByInst, plexInst);
  addServers("jellyfin", jfByInst, jfInst);
  return out;
}

// Titles first added to ANY server in each of the last 12 months (UTC). Only
// titles still in a library are visible — nothing records what was removed.
export async function getLibraryGrowth(): Promise<Array<{ month: string; movies: number; series: number }>> {
  const rows = await prisma.$queryRaw<Array<{ month: string; movies: bigint; series: bigint }>>(Prisma.sql`
    WITH months AS (
      SELECT gs AS start FROM generate_series(
        date_trunc('month', NOW() AT TIME ZONE 'UTC') - INTERVAL '11 months',
        date_trunc('month', NOW() AT TIME ZONE 'UTC'),
        '1 month'::interval) AS gs
    ),
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
  return (Array.isArray(rows) ? rows : []).map((r) => ({ month: r.month, movies: num(r.movies), series: num(r.series) }));
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
    prisma.$queryRaw<Array<{ n: bigint; med: number | null; p90: number | null }>>(Prisma.sql`
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
  const r0 = resolve?.[0];
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
    prisma.setting.findUnique({ where: { key: "deletionVoteThreshold" } }),
    prisma.deletionVote.count(),
  ]);
  const threshold = parseInt(thresholdRow?.value ?? "0", 10);
  return {
    threshold: Number.isFinite(threshold) && threshold > 0 ? threshold : 0,
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
  computedAt: string;
}

// Every view would otherwise list every Radarr/Sonarr library in full (up to
// 50 MB a body) — the same listing the cleanup page makes on demand. Admin
// numbers a few minutes stale are fine; concurrent viewers share one fetch.
const STORAGE_TTL_MS = 5 * 60 * 1000;
const storageCache = processSingleton("admin-stats:storage", () => ({ value: null as StorageStats | null, at: 0 }));

export async function getStorageStats(opts: { fresh?: boolean } = {}): Promise<StorageStats> {
  if (!opts.fresh && storageCache.value && Date.now() - storageCache.at < STORAGE_TTL_MS) return storageCache.value;
  return coalesce("admin-stats:storage", async () => {
    const value = await computeStorageStats();
    storageCache.value = value;
    storageCache.at = Date.now();
    return value;
  });
}

async function computeStorageStats(): Promise<StorageStats> {
  const [disk, index, radarr, sonarr, cleanupOn] = await Promise.all([
    getArrDiskSpace(),
    loadArrLibraryIndex(),
    getArrInstances("radarr"),
    getArrInstances("sonarr"),
    isFeatureEnabled(CLEANUP_FEATURE_KEY),
  ]);
  const instName = (service: "radarr" | "sonarr", slug: string) =>
    (service === "radarr" ? radarr : sonarr).find((i) => i.slug === slug)?.name ?? slug;
  const svcLabel = (service: "radarr" | "sonarr", slug: string) =>
    `${service === "radarr" ? "Radarr" : "Sonarr"}${slug ? ` (${instName(service, slug)})` : ""}`;

  const disks = mergeDiskGroups([
    ...(disk.radarr ? [{ source: "Radarr", entries: disk.radarr }] : []),
    ...(disk.sonarr ? [{ source: "Sonarr", entries: disk.sonarr }] : []),
    ...disk.extra.map((g) => ({ source: g.label, entries: g.entries })),
  ]);

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

  let reclaimable: StorageStats["reclaimable"] = null;
  if (cleanupOn) {
    try {
      const report = await computeCleanupReport(index, new Date());
      const candidates = report.rows.filter((r) => r.candidate);
      reclaimable = {
        titles: candidates.length,
        bytes: candidates.reduce((sum, r) => sum + (r.sizeOnDisk ?? 0), 0),
      };
    } catch (err) {
      console.warn("[admin-stats] cleanup report failed:", err instanceof Error ? err.message : err);
    }
  }

  return {
    disks,
    unreachable: disk.unreachable,
    libraries: [...sizes.values()].sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name)),
    listingErrors: index.errors.map((e) => ({ service: e.service, slug: e.instance, name: svcLabel(e.service, e.instance) })),
    reclaimable,
    computedAt: new Date().toISOString(),
  };
}

// ─── Watch grades (slow: play-history aggregates) ───────────────────────────

// Letter spread across every active account that has filed a request. null
// while grades are unavailable (feature off, tracking off) or on failure.
export async function getWatchGradeSpreadForStats(): Promise<WatchGradeSpread | null> {
  const rows = await prisma.mediaRequest.findMany({
    where: { user: { deactivatedAt: null } },
    distinct: ["requestedBy"],
    select: { requestedBy: true },
  });
  if (rows.length === 0) return null;
  const summaries = await getWatchGradeSummaries(rows.map((r) => r.requestedBy));
  return summaries ? watchGradeSpread(summaries.values()) : null;
}
