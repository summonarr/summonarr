import { authActive } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { hasPermission, Permission } from "@/lib/permissions";
import { getArrDiskSpace } from "@/lib/arr-stats";
import { StatsCharts } from "@/components/admin/stats-charts";
import { requireFeature } from "@/lib/features";
import { PageHeader, StatCard } from "@/components/ui/design";

export const dynamic = "force-dynamic";

export default async function StatsPage() {
  await requireFeature("feature.admin.stats");
  const session = await authActive();
  if (!session || !hasPermission(session.user.permissions, Permission.ADMIN)) redirect("/");

  const [
    statusCounts, mediaTypeCounts, issueStatusCounts,
    totalUsers,
    plexLibByType, jellyfinLibByType, episodesBySource,
    avgFulfillment,
    requestsByMonth,
    topRequesters,
  ] = await Promise.all([
    prisma.mediaRequest.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.mediaRequest.groupBy({ by: ["mediaType"], _count: { _all: true } }),
    prisma.issue.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.user.count(),
    prisma.plexLibraryItem.groupBy({ by: ["mediaType"], _count: { _all: true } }),
    prisma.jellyfinLibraryItem.groupBy({ by: ["mediaType"], _count: { _all: true } }),
    prisma.tVEpisodeCache.groupBy({ by: ["source"], _count: { _all: true }, _sum: { runtime: true } }),
    prisma.$queryRaw<{ avg_hours: number | null }[]>`
      SELECT (EXTRACT(EPOCH FROM AVG("availableAt" - "createdAt")) / 3600)::float8 AS avg_hours
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

  const libCount = (
    rows: { mediaType: string; _count: { _all: number } }[],
    type: "MOVIE" | "TV",
  ) => rows.find((r) => r.mediaType === type)?._count._all ?? 0;
  const episodeRow = (source: string) =>
    episodesBySource.find((r) => r.source === source);

  const libraryServers = [
    {
      name: "Plex",
      movies: libCount(plexLibByType, "MOVIE"),
      series: libCount(plexLibByType, "TV"),
      episodes: episodeRow("plex")?._count._all ?? 0,
      runtimeMin: episodeRow("plex")?._sum.runtime ?? 0,
    },
    {
      name: "Jellyfin",
      movies: libCount(jellyfinLibByType, "MOVIE"),
      series: libCount(jellyfinLibByType, "TV"),
      episodes: episodeRow("jellyfin")?._count._all ?? 0,
      runtimeMin: episodeRow("jellyfin")?._sum.runtime ?? 0,
    },
  ].filter((s) => s.movies + s.series + s.episodes > 0);

  const plexItems = libCount(plexLibByType, "MOVIE") + libCount(plexLibByType, "TV");
  const jellyfinItems =
    libCount(jellyfinLibByType, "MOVIE") + libCount(jellyfinLibByType, "TV");

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

  function formatRuntime(minutes: number) {
    if (minutes <= 0) return "0h";
    const days = Math.floor(minutes / 1440);
    const hours = Math.round((minutes % 1440) / 60);
    if (days > 0) return `${days}d ${hours}h`;
    return `${hours}h`;
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
    <div className="ds-page-enter">
      <PageHeader
        title="Statistics"
        subtitle="Server and request analytics"
      />

      <div
        className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6"
        style={{ gap: 10, marginBottom: 24 }}
      >
        {statCards.map((s) => (
          <StatCard
            key={s.label}
            label={s.label}
            value={s.value.toLocaleString()}
            mono
          />
        ))}
      </div>

      {libraryServers.length > 0 && (
        <StatsSection title="Library">
          <div
            className="grid grid-cols-1 lg:grid-cols-2"
            style={{ gap: 16 }}
          >
            {libraryServers.map((s) => (
              <LibraryServerCard
                key={s.name}
                name={s.name}
                movies={s.movies}
                series={s.series}
                episodes={s.episodes}
                runtime={formatRuntime(s.runtimeMin)}
              />
            ))}
          </div>
        </StatsSection>
      )}

      {avgHours !== null && avgHours !== undefined && (
        <StatsSection>
          <p
            className="ds-mono uppercase"
            style={{
              fontSize: 10.5,
              color: "var(--ds-fg-subtle)",
              letterSpacing: "0.08em",
              margin: "0 0 6px",
            }}
          >
            Average Fulfillment Time
          </p>
          <p
            className="font-semibold"
            style={{
              fontSize: 22,
              color: "var(--ds-fg)",
              letterSpacing: "-0.02em",
              margin: 0,
            }}
          >
            {avgHours < 1
              ? `${Math.round(avgHours * 60)} minutes`
              : avgHours < 24
                ? `${avgHours.toFixed(1)} hours`
                : `${(avgHours / 24).toFixed(1)} days`}
          </p>
          <p
            className="ds-mono"
            style={{
              fontSize: 10.5,
              color: "var(--ds-fg-subtle)",
              marginTop: 6,
            }}
          >
            From request creation to available
          </p>
        </StatsSection>
      )}

      {monthData.length > 0 && (
        <StatsSection title="Requests Over Time">
          <StatsCharts data={monthData} />
        </StatsSection>
      )}

      {topRequesters.length > 0 && (
        <StatsSection title="Top Requesters">
          <div className="flex flex-col" style={{ gap: 6 }}>
            {topRequesters.map((u, i) => (
              <div
                key={u.email}
                className="flex items-center justify-between"
                style={{ fontSize: 13 }}
              >
                <div className="flex items-center" style={{ gap: 12 }}>
                  <span
                    className="ds-mono text-right"
                    style={{
                      width: 20,
                      color: "var(--ds-fg-disabled)",
                      fontSize: 11,
                    }}
                  >
                    {i + 1}.
                  </span>
                  <span style={{ color: "var(--ds-fg)" }}>
                    {u.name ?? u.email}
                  </span>
                </div>
                <span
                  className="ds-mono"
                  style={{
                    color: "var(--ds-fg-muted)",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {Number(u.count)} requests
                </span>
              </div>
            ))}
          </div>
        </StatsSection>
      )}

      {(diskSpace.radarr || diskSpace.sonarr || diskSpace.extra.length > 0) && (
        <StatsSection title="Disk Space">
          <div className="flex flex-col" style={{ gap: 16 }}>
            {diskSpace.radarr && (
              <DiskGroup label="Radarr" items={diskSpace.radarr} formatBytes={formatBytes} />
            )}
            {diskSpace.sonarr && (
              <DiskGroup label="Sonarr" items={diskSpace.sonarr} formatBytes={formatBytes} />
            )}
            {diskSpace.extra.map((g) => (
              <DiskGroup key={`${g.service}:${g.slug}`} label={g.label} items={g.entries} formatBytes={formatBytes} />
            ))}
          </div>
        </StatsSection>
      )}
    </div>
  );
}

function StatsSection({
  title,
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      style={{
        padding: 20,
        background: "var(--ds-bg-2)",
        border: "1px solid var(--ds-border)",
        borderRadius: 8,
        marginBottom: 24,
      }}
    >
      {title && (
        <h2
          className="font-semibold"
          style={{
            fontSize: 15,
            letterSpacing: "-0.01em",
            color: "var(--ds-fg)",
            margin: "0 0 14px",
          }}
        >
          {title}
        </h2>
      )}
      {children}
    </section>
  );
}

function LibraryServerCard({
  name,
  movies,
  series,
  episodes,
  runtime,
}: {
  name: string;
  movies: number;
  series: number;
  episodes: number;
  runtime: string;
}) {
  const metrics = [
    { label: "Titles", value: (movies + series).toLocaleString() },
    { label: "Movies", value: movies.toLocaleString() },
    { label: "Series", value: series.toLocaleString() },
    { label: "Episodes", value: episodes.toLocaleString() },
    { label: "Episode Runtime", value: runtime },
  ];
  return (
    <div
      style={{
        padding: 16,
        background: "var(--ds-bg-3)",
        border: "1px solid var(--ds-border)",
        borderRadius: 8,
      }}
    >
      <h3
        className="ds-mono uppercase"
        style={{
          fontSize: 10.5,
          color: "var(--ds-fg-subtle)",
          letterSpacing: "0.08em",
          margin: "0 0 12px",
        }}
      >
        {name}
      </h3>
      <div
        className="grid grid-cols-2 sm:grid-cols-3"
        style={{ gap: 12 }}
      >
        {metrics.map((m) => (
          <div key={m.label}>
            <p
              className="font-semibold ds-mono"
              style={{
                fontSize: 18,
                color: "var(--ds-fg)",
                letterSpacing: "-0.02em",
                margin: 0,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {m.value}
            </p>
            <p
              className="ds-mono uppercase"
              style={{
                fontSize: 10,
                color: "var(--ds-fg-subtle)",
                letterSpacing: "0.06em",
                margin: "2px 0 0",
              }}
            >
              {m.label}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function DiskGroup({
  label,
  items,
  formatBytes,
}: {
  label: string;
  items: { path: string; label?: string; totalSpace: number; freeSpace: number }[];
  formatBytes: (n: number) => string;
}) {
  return (
    <div>
      <h3
        className="ds-mono uppercase"
        style={{
          fontSize: 10.5,
          color: "var(--ds-fg-subtle)",
          letterSpacing: "0.08em",
          margin: "0 0 8px",
        }}
      >
        {label}
      </h3>
      {items.map((d) => {
        const usedPct =
          d.totalSpace > 0
            ? ((d.totalSpace - d.freeSpace) / d.totalSpace) * 100
            : 0;
        const bar =
          usedPct > 90
            ? "var(--ds-danger)"
            : usedPct > 75
              ? "var(--ds-warning)"
              : "var(--ds-accent)";
        return (
          <div key={d.path} style={{ marginBottom: 10 }}>
            <div
              className="flex justify-between"
              style={{ fontSize: 12, marginBottom: 4 }}
            >
              <span
                className="truncate"
                style={{ color: "var(--ds-fg)", maxWidth: "60%" }}
              >
                {d.label || d.path}
              </span>
              <span
                className="ds-mono"
                style={{ color: "var(--ds-fg-muted)" }}
              >
                {formatBytes(d.totalSpace - d.freeSpace)} / {formatBytes(d.totalSpace)}
              </span>
            </div>
            <div
              className="overflow-hidden"
              style={{
                height: 6,
                background: "var(--ds-bg-3)",
                borderRadius: 999,
              }}
            >
              <div
                className="h-full transition-all"
                style={{
                  width: `${usedPct}%`,
                  background: bar,
                  borderRadius: 999,
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
