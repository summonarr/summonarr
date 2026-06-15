import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { getArrDiskSpace } from "@/lib/arr-stats";

export const dynamic = "force-dynamic";

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
    plexItems,
    jellyfinItems,
    totalIssues,
    openIssues,
    avgFulfillment,
    requestsByMonth,
    recentRequests,
    plexLibByType,
    jellyfinLibByType,
    episodesBySource,
    topRequesters,
  ] = await Promise.all([
    prisma.mediaRequest.count(),
    prisma.mediaRequest.count({ where: { status: "PENDING" } }),
    prisma.mediaRequest.count({ where: { status: "APPROVED" } }),
    prisma.mediaRequest.count({ where: { status: "AVAILABLE" } }),
    prisma.mediaRequest.count({ where: { status: "DECLINED" } }),
    prisma.mediaRequest.count({ where: { mediaType: "MOVIE" } }),
    prisma.mediaRequest.count({ where: { mediaType: "TV" } }),
    prisma.user.count(),
    prisma.plexLibraryItem.count(),
    prisma.jellyfinLibraryItem.count(),
    prisma.issue.count(),
    prisma.issue.count({ where: { status: "OPEN" } }),
    prisma.$queryRaw<{ avg_hours: number | null }[]>`
      SELECT (EXTRACT(EPOCH FROM AVG("availableAt" - "createdAt")) / 3600)::float8 AS avg_hours
      FROM "MediaRequest"
      WHERE status = 'AVAILABLE' AND "availableAt" IS NOT NULL
    `,
    prisma.$queryRaw<{ month: string; count: bigint }[]>`
      SELECT to_char(date_trunc('month', "createdAt"), 'YYYY-MM') AS month,
             COUNT(*)::bigint AS count
      FROM "MediaRequest"
      WHERE "createdAt" >= NOW() - INTERVAL '12 months'
      GROUP BY month
      ORDER BY month
    `,
    prisma.mediaRequest.findMany({
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { title: true, mediaType: true, status: true, createdAt: true },
    }),
    // Per-server library breakdown (mirrors the web admin stats page's
    // LibraryServerCard): movies/series counts by media type, plus episode
    // counts and summed episode runtime by source.
    prisma.plexLibraryItem.groupBy({ by: ["mediaType"], _count: { _all: true } }),
    prisma.jellyfinLibraryItem.groupBy({ by: ["mediaType"], _count: { _all: true } }),
    prisma.tVEpisodeCache.groupBy({ by: ["source"], _count: { _all: true }, _sum: { runtime: true } }),
    // Top 10 requesters by request count (mirrors the web admin stats page).
    prisma.$queryRaw<{ name: string | null; email: string; count: bigint }[]>`
      SELECT u.name, u.email, COUNT(r.id)::bigint AS count
      FROM "MediaRequest" r
      JOIN "User" u ON u.id = r."requestedBy"
      GROUP BY u.name, u.email
      ORDER BY 3 DESC
      LIMIT 10
    `,
  ]);

  const diskSpace = await getArrDiskSpace();

  const libCount = (
    rows: { mediaType: string; _count: { _all: number } }[],
    type: "MOVIE" | "TV",
  ) => rows.find((r) => r.mediaType === type)?._count._all ?? 0;
  const episodeRow = (source: string) =>
    episodesBySource.find((r) => r.source === source);
  const serverBreakdown = (
    libByType: { mediaType: string; _count: { _all: number } }[],
    source: string,
  ) => {
    const runtimeMin = episodeRow(source)?._sum.runtime ?? 0;
    return {
      movies: libCount(libByType, "MOVIE"),
      series: libCount(libByType, "TV"),
      episodes: episodeRow(source)?._count._all ?? 0,
      episodeRuntimeMinutes: runtimeMin,
      episodeRuntimeHours: runtimeMin / 60,
    };
  };

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
      // Back-compat: existing integer counts (total items per server).
      plex: plexItems,
      jellyfin: jellyfinItems,
      // Additive: per-server movies/series/episodes + episode-runtime hours.
      plexBreakdown: serverBreakdown(plexLibByType, "plex"),
      jellyfinBreakdown: serverBreakdown(jellyfinLibByType, "jellyfin"),
    },
    issues: { total: totalIssues, open: openIssues },
    avgFulfillmentHours: avgFulfillment[0]?.avg_hours ?? null,
    requestsByMonth: requestsByMonth.map((r) => ({ month: r.month, count: Number(r.count) })),
    topRequesters: topRequesters.map((u) => ({
      name: u.name,
      email: u.email,
      count: Number(u.count),
    })),
    recentRequests,
    diskSpace,
  });
});
