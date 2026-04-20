import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getPlayHistoryStats } from "@/lib/play-history";
import { ActivityFilterBar } from "@/components/admin/activity-filter-bar";
import { ActivityStatsCharts } from "@/components/admin/activity-stats-charts";
import { StatTile } from "@/components/admin/activity-chart-primitives";
import { BarChart2 } from "lucide-react";

export const dynamic = "force-dynamic";

function pctDelta(current: number, previous: number): number {
  if (previous <= 0) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 100);
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export default async function StatsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; source?: string; mediaType?: string }>;
}) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") redirect("/");

  const { days: daysParam, source: sourceParam, mediaType: mediaTypeParam } = await searchParams;
  const days = Math.min(Math.max(parseInt(daysParam ?? "30", 10) || 30, 1), 3650);
  const source = sourceParam && ["plex", "jellyfin"].includes(sourceParam) ? sourceParam : undefined;
  const mediaType = mediaTypeParam && ["MOVIE", "TV"].includes(mediaTypeParam) ? mediaTypeParam : undefined;

  const stats = await getPlayHistoryStats({ days, source, mediaType });

  const totalGB = stats.totalBandwidthGB;
  const bandwidthDisplay = totalGB >= 1000
    ? `${(totalGB / 1000).toFixed(1)} TB`
    : `${totalGB} GB`;

  const playsDelta = pctDelta(stats.totalPlays, stats.prevPeriod.totalPlays);
  const watchDelta = pctDelta(stats.totalWatchTimeHours, stats.prevPeriod.totalWatchTimeHours);
  const viewersDelta = pctDelta(stats.uniqueViewers, stats.prevPeriod.uniqueViewers);
  const repeatRate =
    stats.uniqueTitles > 0 ? Math.round((stats.totalPlays / stats.uniqueTitles) * 10) / 10 : 0;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-1 flex items-center gap-2">
          <BarChart2 className="w-6 h-6 text-zinc-400" />
          Statistics
        </h1>
        <p className="text-zinc-400 text-sm">Detailed playback analytics</p>
      </div>

      <ActivityFilterBar />

      {}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
        <StatTile
          label={`${days}d Plays`}
          value={stats.totalPlays.toLocaleString()}
          delta={{ pct: playsDelta, good: "up" }}
        />
        <StatTile
          label={`${days}d Watch Time`}
          value={`${Math.round(stats.totalWatchTimeHours).toLocaleString()}h`}
          delta={{ pct: watchDelta, good: "up" }}
        />
        <StatTile
          label="Unique Viewers"
          value={stats.uniqueViewers.toLocaleString()}
          sub={`${stats.uniqueTitles.toLocaleString()} unique titles`}
          delta={{ pct: viewersDelta, good: "up" }}
        />
        <StatTile
          label="Peak Concurrent"
          value={stats.peakConcurrent.toLocaleString()}
          sub="max simultaneous streams"
        />
      </div>

      {}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        <StatTile
          label="Completion Rate"
          value={`${stats.completionRate}%`}
          sub={stats.pauseRatio > 0 ? `${Math.round(stats.pauseRatio * 100)}% paused` : undefined}
        />
        <StatTile
          label="Avg Session"
          value={formatDuration(stats.avgSessionMinutes)}
          sub={
            stats.longestSessionMinutes > 0
              ? `longest ${formatDuration(stats.longestSessionMinutes)}`
              : undefined
          }
        />
        <StatTile
          label="Repeat Rate"
          value={`${repeatRate}×`}
          sub="plays per unique title"
        />
        <StatTile
          label="Bandwidth"
          value={bandwidthDisplay}
          sub={stats.avgBitrateMbps > 0 ? `${stats.avgBitrateMbps} Mbps avg` : undefined}
        />
      </div>

      <ActivityStatsCharts stats={stats} days={days} />
    </div>
  );
}
