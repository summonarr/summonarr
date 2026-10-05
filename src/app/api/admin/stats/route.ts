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
    totalRequests,
    pendingRequests,
    approvedRequests,
    availableRequests,
    declinedRequests,
    movieRequests,
    tvRequests,
    totalUsers,
    totalIssues,
    openIssues,
    inProgressIssues,
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
    prisma.mediaRequest.count(),
    prisma.mediaRequest.count({ where: { status: "PENDING" } }),
    prisma.mediaRequest.count({ where: { status: "APPROVED" } }),
    prisma.mediaRequest.count({ where: { status: "AVAILABLE" } }),
    prisma.mediaRequest.count({ where: { status: "DECLINED" } }),
    prisma.mediaRequest.count({ where: { mediaType: "MOVIE" } }),
    prisma.mediaRequest.count({ where: { mediaType: "TV" } }),
    // Accounts that can sign in — disabled and purged ones used to be counted.
    countActiveUsers(),
    prisma.issue.count(),
    prisma.issue.count({ where: { status: "OPEN" } }),
    prisma.issue.count({ where: { status: "IN_PROGRESS" } }),
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

  return NextResponse.json({
    requests: {
      total: totalRequests,
      pending: pendingRequests,
      approved: approvedRequests,
      available: availableRequests,
      declined: declinedRequests,
      movie: movieRequests,
      tv: tvRequests,
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
    issues: { total: totalIssues, open: openIssues, inProgress: inProgressIssues },
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
