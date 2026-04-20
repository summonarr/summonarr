import { NextResponse } from "next/server";
import { auth, isTokenExpired } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getArrDiskSpace } from "@/lib/arr-stats";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session || isTokenExpired(session) || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

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
      SELECT EXTRACT(EPOCH FROM AVG("availableAt" - "createdAt")) / 3600 AS avg_hours
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
  ]);

  const diskSpace = await getArrDiskSpace();

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
    library: { plex: plexItems, jellyfin: jellyfinItems },
    issues: { total: totalIssues, open: openIssues },
    avgFulfillmentHours: avgFulfillment[0]?.avg_hours ?? null,
    requestsByMonth: requestsByMonth.map((r) => ({ month: r.month, count: Number(r.count) })),
    recentRequests,
    diskSpace,
  });
}
