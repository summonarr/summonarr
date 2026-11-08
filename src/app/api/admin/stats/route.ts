import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { getArrDiskSpace } from "@/lib/arr-stats";
import {
  countActiveUsers,
  getFulfillmentStats,
  getLibraryStats,
  getPendingQueue,
  getRequestsByMonth,
  getStuckRequests,
  getTopRequesters,
} from "@/lib/admin-stats-data";

export const dynamic = "force-dynamic";

// The native client decodes this body (iOS AdminStats). Every field it reads
// keeps its name and type; new figures are additive only. The aggregates are
// the same functions /admin/stats renders (admin-stats-data.ts), so the two
// can't disagree about what a number means.
export const GET = withAdmin(async (_req, _ctx, _session) => {
  const [
    requestsByStatus,
    requestsByType,
    totalUsers,
    issuesByStatus,
    fulfillment,
    requestsByMonth,
    recentRequests,
    library,
    episodesBySource,
    topRequesters,
    pendingQueue,
    stuck,
    diskSpace,
  ] = await Promise.all([
    // One grouped read per breakdown, not a count per figure: every query here
    // runs at once, and the pool has five connections.
    prisma.mediaRequest.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.mediaRequest.groupBy({ by: ["mediaType"], _count: { _all: true } }),
    // Accounts that can sign in — disabled and purged ones used to be counted.
    countActiveUsers(),
    prisma.issue.groupBy({ by: ["status"], _count: { _all: true } }),
    getFulfillmentStats(null),
    getRequestsByMonth(),
    prisma.mediaRequest.findMany({
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { title: true, mediaType: true, status: true, createdAt: true },
    }),
    getLibraryStats(),
    prisma.tVEpisodeCache.groupBy({ by: ["source"], _sum: { runtime: true } }),
    getTopRequesters(null),
    getPendingQueue(),
    getStuckRequests(),
    // External Radarr/Sonarr HTTP fan-out — runs inside the batch so its
    // latency overlaps the DB aggregates instead of adding to them serially.
    getArrDiskSpace(),
  ]);

  const serverBreakdown = (source: "plex" | "jellyfin") => {
    const p = library.perService[source];
    // Episode runtime is only known for seasons someone opened recently (the
    // library sync rewrites TVEpisodeCache without it), so this undercounts.
    // Kept for the native client, which decodes the field; the web page no
    // longer shows it.
    const runtimeMin = episodesBySource.find((r) => r.source === source)?._sum.runtime ?? 0;
    return {
      movies: p.movies,
      series: p.series,
      episodes: p.episodes,
      episodeRuntimeMinutes: runtimeMin,
      episodeRuntimeHours: runtimeMin / 60,
    };
  };

  const avgSeconds = fulfillment.total.avgSeconds;

  // A group with no rows is absent from a groupBy, so every figure defaults to
  // 0; a total is the sum over every group (each row has exactly one status).
  const requestStatus = new Map(requestsByStatus.map((r) => [r.status, r._count._all]));
  const requestType = new Map(requestsByType.map((r) => [r.mediaType, r._count._all]));
  const issueStatus = new Map(issuesByStatus.map((r) => [r.status, r._count._all]));
  const sum = (counts: Map<unknown, number>) => [...counts.values()].reduce((a, b) => a + b, 0);

  return NextResponse.json({
    requests: {
      total: sum(requestStatus),
      pending: requestStatus.get("PENDING") ?? 0,
      approved: requestStatus.get("APPROVED") ?? 0,
      available: requestStatus.get("AVAILABLE") ?? 0,
      declined: requestStatus.get("DECLINED") ?? 0,
      movie: requestType.get("MOVIE") ?? 0,
      tv: requestType.get("TV") ?? 0,
    },
    users: totalUsers,
    library: {
      // Distinct titles per service: a title on two servers of one service
      // counts once (it used to count once per server).
      plex: library.perService.plex.movies + library.perService.plex.series,
      jellyfin: library.perService.jellyfin.movies + library.perService.jellyfin.series,
      plexBreakdown: serverBreakdown("plex"),
      jellyfinBreakdown: serverBreakdown("jellyfin"),
      // Additive: distinct titles across every server of both services.
      unique: library.unique,
    },
    issues: { total: sum(issueStatus), open: issueStatus.get("OPEN") ?? 0, inProgress: issueStatus.get("IN_PROGRESS") ?? 0 },
    // Request → available, over APPROVED requests only (see getFulfillmentStats).
    avgFulfillmentHours: avgSeconds === null ? null : avgSeconds / 3600,
    // Every one of the last 12 calendar months, zero months included.
    requestsByMonth: requestsByMonth.map((m) => ({ month: m.month, count: m.count, byStatus: m.byStatus })),
    topRequesters: topRequesters.map((u) => ({
      name: u.name,
      email: u.email,
      count: u.count,
      available: u.available,
      declined: u.declined,
    })),
    recentRequests,
    diskSpace,
    // Additive figures.
    fulfillment,
    pendingQueue,
    stuckRequests: stuck.counts,
  });
});
