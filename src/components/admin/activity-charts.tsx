"use client";

import Link from "next/link";
import { Card } from "@/components/ui/card";
import {
  BarChart,
  HorizontalBar,
  HeatmapChart,
  MediaTypeBar,
  CompletionHistogram,
  TranscodeRatioBars,
} from "@/components/admin/activity-chart-primitives";

interface Stats {
  totalPlays: number;
  totalWatchTimeHours: number;
  playsByDay: { day: string; count: number }[];
  topUsers: { id: string; username: string; source: string; count: number }[];
  topMedia: { title: string; tmdbId: number | null; mediaType: string | null; count: number }[];
  transcodeRatio: { method: string; count: number }[];
  playsByPlatform: { platform: string; count: number }[];
  playsByHour: { hour: number; count: number }[];
  mediaTypeBreakdown: { type: string; count: number }[];
  watchTimeByDay: { day: string; hours: number }[];
  heatmap: { dow: number; hour: number; count: number }[];
  completionRate: number;
  completionBuckets: { bucket: string; count: number }[];
  avgBitrateMbps: number;
  totalBandwidthGB: number;
  bandwidthByDay: { day: string; gb: number }[];
}

export function ActivityCharts({ stats, days }: { stats: Stats; days: number }) {
  const topMediaMax = Math.max(...stats.topMedia.map((m) => m.count), 1);
  const platformMax = Math.max(...stats.playsByPlatform.map((p) => p.count), 1);

  const hourData = Array.from({ length: 24 }, (_, h) => ({
    hour: String(h).padStart(2, "0"),
    count: stats.playsByHour.find((p) => p.hour === h)?.count ?? 0,
  }));

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
      {stats.playsByDay.length > 0 && (
        <Card className="bg-zinc-900 border-zinc-800 p-5">
          <h3 className="font-semibold text-white mb-3 text-sm">
            Plays Over Time ({days}d)
          </h3>
          <BarChart data={stats.playsByDay} labelKey="day" valueKey="count" />
        </Card>
      )}

      {stats.watchTimeByDay.length > 0 && (
        <Card className="bg-zinc-900 border-zinc-800 p-5">
          <h3 className="font-semibold text-white mb-3 text-sm">
            Watch Time Over Time ({days}d)
          </h3>
          <BarChart
            data={stats.watchTimeByDay}
            labelKey="day"
            valueKey="hours"
            color="bg-emerald-600 hover:bg-emerald-500"
            formatValue={(v) => `${v.toFixed(1)}h`}
          />
        </Card>
      )}

      {stats.bandwidthByDay.length > 0 && (
        <Card className="bg-zinc-900 border-zinc-800 p-5">
          <h3 className="font-semibold text-white mb-3 text-sm">
            Bandwidth Over Time ({days}d)
          </h3>
          <BarChart
            data={stats.bandwidthByDay}
            labelKey="day"
            valueKey="gb"
            color="bg-cyan-600 hover:bg-cyan-500"
            formatValue={(v) => (v < 1 ? `${Math.round(v * 1024)}MB` : `${v.toFixed(1)}GB`)}
          />
        </Card>
      )}

      <Card className="bg-zinc-900 border-zinc-800 p-5">
        <h3 className="font-semibold text-white mb-3 text-sm">Plays by Hour of Day</h3>
        <BarChart data={hourData} labelKey="hour" valueKey="count" />
      </Card>

      {stats.heatmap.length > 0 && (
        <Card className="bg-zinc-900 border-zinc-800 p-5 md:col-span-2">
          <h3 className="font-semibold text-white mb-3 text-sm">Activity Heatmap</h3>
          <HeatmapChart data={stats.heatmap} />
        </Card>
      )}

      {stats.topMedia.length > 0 && (
        <Card className="bg-zinc-900 border-zinc-800 p-5">
          <h3 className="font-semibold text-white mb-3 text-sm">Most Played</h3>
          <div className="space-y-2">
            {stats.topMedia.map((m, i) => {
              const href =
                m.tmdbId && m.mediaType
                  ? m.mediaType === "TV"
                    ? `/tv/${m.tmdbId}`
                    : `/movie/${m.tmdbId}`
                  : null;
              return (
                <div key={`${m.title}-${i}`} className="flex items-center gap-3">
                  <span className="text-zinc-600 w-5 text-right text-xs">{i + 1}.</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between text-sm mb-0.5">
                      {href ? (
                        <Link
                          href={href}
                          className="text-white hover:text-indigo-400 transition-colors truncate"
                        >
                          {m.title}
                        </Link>
                      ) : (
                        <span className="text-white truncate">{m.title}</span>
                      )}
                      <span className="text-zinc-400 tabular-nums shrink-0 ml-2">{m.count}</span>
                    </div>
                    <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-indigo-600 rounded-full"
                        style={{
                          width: `${topMediaMax > 0 ? (m.count / topMediaMax) * 100 : 0}%`,
                        }}
                      />
                    </div>
                    <span className="text-[10px] text-zinc-600">{m.mediaType}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {stats.mediaTypeBreakdown.length > 0 && (
        <Card className="bg-zinc-900 border-zinc-800 p-5">
          <h3 className="font-semibold text-white mb-3 text-sm">Movies vs TV</h3>
          <MediaTypeBar data={stats.mediaTypeBreakdown} />
        </Card>
      )}

      {stats.completionBuckets.length > 0 && (
        <Card className="bg-zinc-900 border-zinc-800 p-5">
          <h3 className="font-semibold text-white mb-3 text-sm">
            Watch Completion Distribution
          </h3>
          <CompletionHistogram data={stats.completionBuckets} />
        </Card>
      )}

      {stats.transcodeRatio.length > 0 && (
        <Card className="bg-zinc-900 border-zinc-800 p-5">
          <h3 className="font-semibold text-white mb-3 text-sm">Stream Type Breakdown</h3>
          <TranscodeRatioBars data={stats.transcodeRatio} />
        </Card>
      )}

      {stats.playsByPlatform.length > 0 && (
        <Card className="bg-zinc-900 border-zinc-800 p-5">
          <h3 className="font-semibold text-white mb-3 text-sm">Top Platforms</h3>
          <HorizontalBar
            items={stats.playsByPlatform.map((p) => ({
              label: p.platform,
              value: p.count,
            }))}
            max={platformMax}
          />
        </Card>
      )}
    </div>
  );
}
