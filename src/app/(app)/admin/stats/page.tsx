import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui/card";
import { getArrDiskSpace } from "@/lib/arr-stats";
import { StatsCharts } from "@/components/admin/stats-charts";

export const dynamic = "force-dynamic";

export default async function StatsPage() {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") redirect("/");

  const [
    statusCounts, mediaTypeCounts, issueStatusCounts,
    totalUsers,
    plexItems, jellyfinItems,
    avgFulfillment,
    requestsByMonth,
    topRequesters,
  ] = await Promise.all([
    prisma.mediaRequest.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.mediaRequest.groupBy({ by: ["mediaType"], _count: { _all: true } }),
    prisma.issue.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.user.count(),
    prisma.plexLibraryItem.count(),
    prisma.jellyfinLibraryItem.count(),
    prisma.$queryRaw<{ avg_hours: number | null }[]>`
      SELECT EXTRACT(EPOCH FROM AVG("availableAt" - "createdAt")) / 3600 AS avg_hours
      FROM "MediaRequest"
      WHERE status = 'AVAILABLE' AND "availableAt" IS NOT NULL
    `,
    prisma.$queryRaw<{ month: string; count: bigint }[]>`
      WITH months AS (
        SELECT to_char(gs, 'YYYY-MM') AS month
        FROM generate_series(
          date_trunc('month', NOW() - INTERVAL '11 months'),
          date_trunc('month', NOW()),
          '1 month'::interval
        ) AS gs
      )
      SELECT m.month,
             COALESCE(COUNT(r.id), 0)::bigint AS count
      FROM months m
      LEFT JOIN "MediaRequest" r
        ON to_char(date_trunc('month', r."createdAt"), 'YYYY-MM') = m.month
      GROUP BY m.month
      ORDER BY m.month
    `,
    prisma.$queryRaw<{ name: string | null; email: string; count: bigint }[]>`
      SELECT u.name, u.email, COUNT(r.id)::bigint AS count
      FROM "MediaRequest" r
      JOIN "User" u ON u.id = r."requestedBy"
      GROUP BY u.name, u.email
      ORDER BY 3 DESC
      LIMIT 10
    `,
  ]);

  const statusMap = new Map(statusCounts.map((r) => [r.status, r._count._all]));
  const mediaTypeMap = new Map(mediaTypeCounts.map((r) => [r.mediaType, r._count._all]));
  const issueStatusMap = new Map(issueStatusCounts.map((r) => [r.status, r._count._all]));
  const pendingRequests   = statusMap.get("PENDING")   ?? 0;
  const approvedRequests  = statusMap.get("APPROVED")  ?? 0;
  const availableRequests = statusMap.get("AVAILABLE") ?? 0;
  const declinedRequests  = statusMap.get("DECLINED")  ?? 0;
  const totalRequests     = pendingRequests + approvedRequests + availableRequests + declinedRequests;
  const movieRequests     = mediaTypeMap.get("MOVIE") ?? 0;
  const tvRequests        = mediaTypeMap.get("TV")    ?? 0;
  const openIssues        = issueStatusMap.get("OPEN") ?? 0;
  const totalIssues       = Array.from(issueStatusMap.values()).reduce((a, b) => a + b, 0);

  const diskSpace = await getArrDiskSpace();
  const avgHours = avgFulfillment[0]?.avg_hours;
  const monthData = requestsByMonth.map((r) => ({ month: r.month, count: Number(r.count) }));

  function formatBytes(bytes: number) {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  }

  const statCards = [
    { label: "Total Requests", value: totalRequests },
    { label: "Pending", value: pendingRequests },
    { label: "Approved", value: approvedRequests },
    { label: "Available", value: availableRequests },
    { label: "Declined", value: declinedRequests },
    { label: "Movies", value: movieRequests },
    { label: "TV Shows", value: tvRequests },
    { label: "Users", value: totalUsers },
    { label: "Plex Items", value: plexItems },
    { label: "Jellyfin Items", value: jellyfinItems },
    { label: "Issues", value: totalIssues },
    { label: "Open Issues", value: openIssues },
  ];

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold mb-1">Statistics</h1>
        <p className="text-zinc-400 text-sm">Server and request analytics</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-3 mb-8">
        {statCards.map((s) => (
          <Card key={s.label} className="bg-zinc-900 border-zinc-800 p-4">
            <p className="text-xs text-zinc-500 uppercase tracking-wide mb-1">{s.label}</p>
            <p className="text-2xl font-bold text-white tabular-nums">{s.value.toLocaleString()}</p>
          </Card>
        ))}
      </div>

      {avgHours !== null && avgHours !== undefined && (
        <Card className="bg-zinc-900 border-zinc-800 p-5 mb-8">
          <p className="text-xs text-zinc-500 uppercase tracking-wide mb-1">Average Fulfillment Time</p>
          <p className="text-2xl font-bold text-white">
            {avgHours < 1
              ? `${Math.round(avgHours * 60)} minutes`
              : avgHours < 24
                ? `${avgHours.toFixed(1)} hours`
                : `${(avgHours / 24).toFixed(1)} days`}
          </p>
          <p className="text-xs text-zinc-500 mt-1">From request creation to available</p>
        </Card>
      )}

      {monthData.length > 0 && (
        <Card className="bg-zinc-900 border-zinc-800 p-5 mb-8">
          <h2 className="font-semibold text-white mb-4">Requests Over Time</h2>
          <StatsCharts data={monthData} />
        </Card>
      )}

      {topRequesters.length > 0 && (
        <Card className="bg-zinc-900 border-zinc-800 p-5 mb-8">
          <h2 className="font-semibold text-white mb-4">Top Requesters</h2>
          <div className="space-y-2">
            {topRequesters.map((u, i) => (
              <div key={u.email} className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-3">
                  <span className="text-zinc-600 w-5 text-right">{i + 1}.</span>
                  <span className="text-white">{u.name ?? u.email}</span>
                </div>
                <span className="text-zinc-400 tabular-nums">{Number(u.count)} requests</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {(diskSpace.radarr || diskSpace.sonarr) && (
        <Card className="bg-zinc-900 border-zinc-800 p-5 mb-8">
          <h2 className="font-semibold text-white mb-4">Disk Space</h2>
          <div className="space-y-4">
            {diskSpace.radarr && (
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">Radarr</h3>
                {diskSpace.radarr.map((d) => {
                  const usedPct = d.totalSpace > 0 ? ((d.totalSpace - d.freeSpace) / d.totalSpace) * 100 : 0;
                  return (
                    <div key={d.path} className="mb-2">
                      <div className="flex justify-between text-sm mb-1">
                        <span className="text-zinc-300 truncate max-w-[60%]">{d.label || d.path}</span>
                        <span className="text-zinc-400">
                          {formatBytes(d.totalSpace - d.freeSpace)} / {formatBytes(d.totalSpace)}
                        </span>
                      </div>
                      <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${usedPct > 90 ? "bg-red-500" : usedPct > 75 ? "bg-yellow-500" : "bg-indigo-500"}`}
                          style={{ width: `${usedPct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {diskSpace.sonarr && (
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">Sonarr</h3>
                {diskSpace.sonarr.map((d) => {
                  const usedPct = d.totalSpace > 0 ? ((d.totalSpace - d.freeSpace) / d.totalSpace) * 100 : 0;
                  return (
                    <div key={d.path} className="mb-2">
                      <div className="flex justify-between text-sm mb-1">
                        <span className="text-zinc-300 truncate max-w-[60%]">{d.label || d.path}</span>
                        <span className="text-zinc-400">
                          {formatBytes(d.totalSpace - d.freeSpace)} / {formatBytes(d.totalSpace)}
                        </span>
                      </div>
                      <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${usedPct > 90 ? "bg-red-500" : usedPct > 75 ? "bg-yellow-500" : "bg-indigo-500"}`}
                          style={{ width: `${usedPct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
