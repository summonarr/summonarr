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
  DistributionBars,
} from "@/components/admin/activity-chart-primitives";

export interface StatsData {
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
  uniqueViewers: number;
  uniqueTitles: number;
  avgSessionMinutes: number;
  longestSessionMinutes: number;
  pauseRatio: number;
  peakConcurrent: number;
  uniqueViewersByDay: { day: string; count: number }[];
  playsByDow: { dow: number; count: number }[];
  resolutionBreakdown: { bucket: string; count: number }[];
  videoCodecBreakdown: { codec: string; count: number }[];
  audioCodecBreakdown: { codec: string; count: number }[];
  containerBreakdown: { container: string; count: number }[];
  bitrateBuckets: { bucket: string; count: number }[];
  transcodeReasons: { reason: string; count: number }[];
  topDevices: { device: string; count: number }[];
  topPlayers: { player: string; count: number }[];
  sourceSplit: { source: string; count: number }[];
  decadeBreakdown: { decade: string; count: number }[];
  topRewatched: { tmdbId: number; mediaType: string; title: string; plays: number; viewers: number }[];
  topEpisodes: { tmdbId: number | null; title: string; season: number | null; episode: number | null; episodeTitle: string | null; count: number }[];
}

const DOW_FULL = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function resolutionColor(label: string): string {
  switch (label) {
    case "4K":
      return "bg-fuchsia-500";
    case "1080p":
      return "bg-emerald-500";
    case "720p":
      return "bg-cyan-500";
    case "SD":
      return "bg-amber-500";
    case "Unknown":
      return "bg-zinc-600";
    default:
      return "bg-indigo-500";
  }
}

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-3 mb-4 mt-8 first:mt-0">
      <h2 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">{title}</h2>
      <div className="flex-1 h-px bg-zinc-800" />
    </div>
  );
}

export function ActivityStatsCharts({ stats, days }: { stats: StatsData; days: number }) {
  const hourData = Array.from({ length: 24 }, (_, h) => ({
    hour: String(h).padStart(2, "0"),
    count: stats.playsByHour.find((p) => p.hour === h)?.count ?? 0,
  }));

  const dowData = Array.from({ length: 7 }, (_, d) => ({
    day: DOW_FULL[d],
    count: stats.playsByDow.find((p) => p.dow === d)?.count ?? 0,
  }));

  const topUsersMax = Math.max(...stats.topUsers.map((u) => u.count), 1);
  const platformMax = Math.max(...stats.playsByPlatform.map((p) => p.count), 1);
  const deviceMax = Math.max(...stats.topDevices.map((d) => d.count), 1);
  const playerMax = Math.max(...stats.topPlayers.map((p) => p.count), 1);
  const rewatchedMax = Math.max(...stats.topRewatched.map((r) => r.plays), 1);
  const episodesMax = Math.max(...stats.topEpisodes.map((e) => e.count), 1);

  const topMovies = stats.topMedia.filter((m) => (m.mediaType ?? "").toUpperCase() === "MOVIE");
  const topTV = stats.topMedia.filter((m) => (m.mediaType ?? "").toUpperCase() === "TV");
  const topMoviesMax = Math.max(...topMovies.map((m) => m.count), 1);
  const topTVMax = Math.max(...topTV.map((m) => m.count), 1);

  const resolutionItems = stats.resolutionBreakdown
    .map((r) => ({ label: r.bucket, value: r.count }))
    .sort((a, b) => b.value - a.value);
  const videoCodecItems = stats.videoCodecBreakdown.map((r) => ({ label: r.codec, value: r.count }));
  const audioCodecItems = stats.audioCodecBreakdown.map((r) => ({ label: r.codec, value: r.count }));
  const containerItems = stats.containerBreakdown.map((r) => ({ label: r.container, value: r.count }));
  const bitrateOrder = ["<2 Mbps", "2-5 Mbps", "5-10 Mbps", "10-20 Mbps", "20-50 Mbps", "50+ Mbps", "Unknown"];
  const bitrateItems = bitrateOrder
    .map((b) => ({ label: b, value: stats.bitrateBuckets.find((r) => r.bucket === b)?.count ?? 0 }))
    .filter((r) => r.value > 0);
  const transcodeReasonItems = stats.transcodeReasons.map((r) => ({ label: r.reason, value: r.count }));
  const sourceSplitItems = stats.sourceSplit.map((r) => ({
    label: r.source === "plex" ? "Plex" : r.source === "jellyfin" ? "Jellyfin" : r.source,
    value: r.count,
  }));
  const decadeItems = stats.decadeBreakdown
    .filter((d) => d.decade !== "Unknown")
    .map((d) => ({ label: d.decade, value: d.count }));

  return (
    <div>
      {}
      <SectionHeader title="Playback Trends" />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        {stats.playsByDay.length > 0 && (
          <Card className="bg-zinc-900 border-zinc-800 p-5">
            <h3 className="font-semibold text-white mb-3 text-sm">Plays Over Time ({days}d)</h3>
            <BarChart data={stats.playsByDay} labelKey="day" valueKey="count" />
          </Card>
        )}
        {stats.watchTimeByDay.length > 0 && (
          <Card className="bg-zinc-900 border-zinc-800 p-5">
            <h3 className="font-semibold text-white mb-3 text-sm">Watch Time Over Time ({days}d)</h3>
            <BarChart
              data={stats.watchTimeByDay}
              labelKey="day"
              valueKey="hours"
              color="bg-emerald-600 hover:bg-emerald-500"
              formatValue={(v) => `${v.toFixed(1)}h`}
            />
          </Card>
        )}
      </div>
      {stats.bandwidthByDay.length > 0 && (
        <Card className="bg-zinc-900 border-zinc-800 p-5 mb-4">
          <h3 className="font-semibold text-white mb-3 text-sm">Bandwidth Over Time ({days}d)</h3>
          <BarChart
            data={stats.bandwidthByDay}
            labelKey="day"
            valueKey="gb"
            color="bg-cyan-600 hover:bg-cyan-500"
            formatValue={(v) => (v < 1 ? `${Math.round(v * 1024)}MB` : `${v.toFixed(1)}GB`)}
          />
        </Card>
      )}
      {stats.uniqueViewersByDay.length > 0 && (
        <Card className="bg-zinc-900 border-zinc-800 p-5 mb-4">
          <h3 className="font-semibold text-white mb-3 text-sm">Unique Viewers Per Day ({days}d)</h3>
          <BarChart
            data={stats.uniqueViewersByDay}
            labelKey="day"
            valueKey="count"
            color="bg-fuchsia-600 hover:bg-fuchsia-500"
          />
        </Card>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <Card className="bg-zinc-900 border-zinc-800 p-5">
          <h3 className="font-semibold text-white mb-3 text-sm">Plays by Hour of Day</h3>
          <BarChart data={hourData} labelKey="hour" valueKey="count" />
        </Card>
        <Card className="bg-zinc-900 border-zinc-800 p-5">
          <h3 className="font-semibold text-white mb-3 text-sm">Plays by Day of Week</h3>
          <BarChart
            data={dowData}
            labelKey="day"
            valueKey="count"
            color="bg-teal-600 hover:bg-teal-500"
          />
        </Card>
      </div>
      {stats.heatmap.length > 0 && (
        <Card className="bg-zinc-900 border-zinc-800 p-5 mb-4">
          <h3 className="font-semibold text-white mb-3 text-sm">Activity Heatmap (day × hour)</h3>
          <HeatmapChart data={stats.heatmap} />
        </Card>
      )}

      {}
      <SectionHeader title="Content" />
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-4">
        {stats.mediaTypeBreakdown.length > 0 && (
          <Card className="bg-zinc-900 border-zinc-800 p-5">
            <h3 className="font-semibold text-white mb-3 text-sm">Movies vs TV</h3>
            <MediaTypeBar data={stats.mediaTypeBreakdown} />
          </Card>
        )}
        {stats.completionBuckets.length > 0 && (
          <Card className="bg-zinc-900 border-zinc-800 p-5">
            <h3 className="font-semibold text-white mb-3 text-sm">Watch Completion</h3>
            <CompletionHistogram data={stats.completionBuckets} />
          </Card>
        )}
        {sourceSplitItems.length > 0 && (
          <Card className="bg-zinc-900 border-zinc-800 p-5">
            <h3 className="font-semibold text-white mb-3 text-sm">Plex vs Jellyfin</h3>
            <DistributionBars
              items={sourceSplitItems}
              colorFor={(l) => (l === "Plex" ? "bg-amber-500" : l === "Jellyfin" ? "bg-purple-500" : "bg-zinc-600")}
            />
          </Card>
        )}
      </div>
      {decadeItems.length > 0 && (
        <Card className="bg-zinc-900 border-zinc-800 p-5 mb-4">
          <h3 className="font-semibold text-white mb-3 text-sm">Content by Release Decade</h3>
          <BarChart
            data={decadeItems.map((d) => ({ label: d.label, count: d.value }))}
            labelKey="label"
            valueKey="count"
            color="bg-amber-600 hover:bg-amber-500"
          />
        </Card>
      )}

      {}
      <SectionHeader title="Stream Quality" />
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-4">
        {stats.transcodeRatio.length > 0 && (
          <Card className="bg-zinc-900 border-zinc-800 p-5">
            <h3 className="font-semibold text-white mb-3 text-sm">Stream Type</h3>
            <TranscodeRatioBars data={stats.transcodeRatio} />
          </Card>
        )}
        {resolutionItems.length > 0 && (
          <Card className="bg-zinc-900 border-zinc-800 p-5">
            <h3 className="font-semibold text-white mb-3 text-sm">Resolution</h3>
            <DistributionBars items={resolutionItems} colorFor={(l) => resolutionColor(l)} />
          </Card>
        )}
        {bitrateItems.length > 0 && (
          <Card className="bg-zinc-900 border-zinc-800 p-5">
            <h3 className="font-semibold text-white mb-3 text-sm">Bitrate Distribution</h3>
            <DistributionBars items={bitrateItems} />
          </Card>
        )}
        {videoCodecItems.length > 0 && (
          <Card className="bg-zinc-900 border-zinc-800 p-5">
            <h3 className="font-semibold text-white mb-3 text-sm">Video Codec</h3>
            <DistributionBars items={videoCodecItems} />
          </Card>
        )}
        {audioCodecItems.length > 0 && (
          <Card className="bg-zinc-900 border-zinc-800 p-5">
            <h3 className="font-semibold text-white mb-3 text-sm">Audio Codec</h3>
            <DistributionBars items={audioCodecItems} />
          </Card>
        )}
        {containerItems.length > 0 && (
          <Card className="bg-zinc-900 border-zinc-800 p-5">
            <h3 className="font-semibold text-white mb-3 text-sm">Container Format</h3>
            <DistributionBars items={containerItems} />
          </Card>
        )}
      </div>
      {transcodeReasonItems.length > 0 && (
        <Card className="bg-zinc-900 border-zinc-800 p-5 mb-4">
          <h3 className="font-semibold text-white mb-3 text-sm">
            Transcode Reasons
            <span className="text-zinc-500 font-normal ml-2">(video decisions for transcoded streams)</span>
          </h3>
          <DistributionBars
            items={transcodeReasonItems}
            colorFor={() => "bg-orange-500"}
          />
        </Card>
      )}

      {}
      {(topMovies.length > 0 || topTV.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
          {topMovies.length > 0 && (
            <Card className="bg-zinc-900 border-zinc-800 p-5">
              <h3 className="font-semibold text-white mb-3 text-sm">Top Movies</h3>
              <div className="space-y-2">
                {topMovies.slice(0, 10).map((m, i) => {
                  const href = m.tmdbId ? `/movie/${m.tmdbId}` : null;
                  return (
                    <div key={`${m.title}-${i}`} className="flex items-center gap-3">
                      <span className="text-zinc-600 w-5 text-right text-xs">{i + 1}.</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between text-sm mb-0.5">
                          {href ? (
                            <Link href={href} className="text-white hover:text-indigo-400 transition-colors truncate">{m.title}</Link>
                          ) : (
                            <span className="text-white truncate">{m.title}</span>
                          )}
                          <span className="text-zinc-400 tabular-nums shrink-0 ml-2">{m.count}</span>
                        </div>
                        <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                          <div className="h-full bg-blue-600 rounded-full" style={{ width: `${topMoviesMax > 0 ? (m.count / topMoviesMax) * 100 : 0}%` }} />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}
          {topTV.length > 0 && (
            <Card className="bg-zinc-900 border-zinc-800 p-5">
              <h3 className="font-semibold text-white mb-3 text-sm">Top TV Shows</h3>
              <div className="space-y-2">
                {topTV.slice(0, 10).map((m, i) => {
                  const href = m.tmdbId ? `/tv/${m.tmdbId}` : null;
                  return (
                    <div key={`${m.title}-${i}`} className="flex items-center gap-3">
                      <span className="text-zinc-600 w-5 text-right text-xs">{i + 1}.</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between text-sm mb-0.5">
                          {href ? (
                            <Link href={href} className="text-white hover:text-indigo-400 transition-colors truncate">{m.title}</Link>
                          ) : (
                            <span className="text-white truncate">{m.title}</span>
                          )}
                          <span className="text-zinc-400 tabular-nums shrink-0 ml-2">{m.count}</span>
                        </div>
                        <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                          <div className="h-full bg-purple-600 rounded-full" style={{ width: `${topTVMax > 0 ? (m.count / topTVMax) * 100 : 0}%` }} />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}
        </div>
      )}

      {(stats.topRewatched.length > 0 || stats.topEpisodes.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
          {stats.topRewatched.length > 0 && (
            <Card className="bg-zinc-900 border-zinc-800 p-5">
              <h3 className="font-semibold text-white mb-3 text-sm">
                Most Rewatched
                <span className="text-zinc-500 font-normal ml-2">(plays · unique viewers)</span>
              </h3>
              <div className="space-y-2">
                {stats.topRewatched.map((r, i) => {
                  const href =
                    r.mediaType === "MOVIE" ? `/movie/${r.tmdbId}` : `/tv/${r.tmdbId}`;
                  return (
                    <div key={`${r.tmdbId}-${i}`} className="flex items-center gap-3">
                      <span className="text-zinc-600 w-5 text-right text-xs">{i + 1}.</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between text-sm mb-0.5">
                          <Link href={href} className="text-white hover:text-indigo-400 transition-colors truncate">
                            {r.title}
                          </Link>
                          <span className="text-zinc-400 tabular-nums shrink-0 ml-2">
                            {r.plays} <span className="text-zinc-600">· {r.viewers}</span>
                          </span>
                        </div>
                        <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-rose-500 rounded-full"
                            style={{ width: `${(r.plays / rewatchedMax) * 100}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}
          {stats.topEpisodes.length > 0 && (
            <Card className="bg-zinc-900 border-zinc-800 p-5">
              <h3 className="font-semibold text-white mb-3 text-sm">Top TV Episodes</h3>
              <div className="space-y-2">
                {stats.topEpisodes.map((e, i) => {
                  const tag = e.season != null && e.episode != null
                    ? `S${String(e.season).padStart(2, "0")}E${String(e.episode).padStart(2, "0")}`
                    : "";
                  const href = e.tmdbId ? `/tv/${e.tmdbId}` : null;
                  return (
                    <div key={`${e.tmdbId ?? "x"}-${i}`} className="flex items-center gap-3">
                      <span className="text-zinc-600 w-5 text-right text-xs">{i + 1}.</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between text-sm mb-0.5">
                          <div className="truncate">
                            {href ? (
                              <Link href={href} className="text-white hover:text-indigo-400 transition-colors">
                                {e.title}
                              </Link>
                            ) : (
                              <span className="text-white">{e.title}</span>
                            )}
                            {tag && <span className="text-zinc-500 ml-1.5 text-xs tabular-nums">{tag}</span>}
                            {e.episodeTitle && (
                              <span className="text-zinc-500 ml-1.5 text-xs truncate">— {e.episodeTitle}</span>
                            )}
                          </div>
                          <span className="text-zinc-400 tabular-nums shrink-0 ml-2">{e.count}</span>
                        </div>
                        <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-purple-500 rounded-full"
                            style={{ width: `${(e.count / episodesMax) * 100}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}
        </div>
      )}

      {}
      <SectionHeader title="Users &amp; Platforms" />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        {stats.topUsers.length > 0 && (
          <Card className="bg-zinc-900 border-zinc-800 p-5">
            <h3 className="font-semibold text-white mb-3 text-sm">Top Users by Plays</h3>
            <div className="space-y-2">
              {stats.topUsers.map((u, i) => (
                <div key={u.id} className="flex items-center gap-3">
                  <span className="text-zinc-600 w-5 text-right text-xs">{i + 1}.</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between text-sm mb-0.5">
                      <Link href={`/admin/activity/user/${u.id}`} className="text-white hover:text-indigo-400 transition-colors truncate">
                        {u.username}
                      </Link>
                      <div className="flex items-center gap-1.5 shrink-0 ml-2">
                        <span className={`text-[9px] px-1 py-0.5 rounded font-medium ${
                          u.source === "plex" ? "bg-amber-500/15 text-amber-400" : "bg-purple-500/15 text-purple-400"
                        }`}>
                          {u.source === "plex" ? "P" : "J"}
                        </span>
                        <span className="text-zinc-400 tabular-nums">{u.count}</span>
                      </div>
                    </div>
                    <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                      <div className="h-full bg-indigo-600 rounded-full" style={{ width: `${topUsersMax > 0 ? (u.count / topUsersMax) * 100 : 0}%` }} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}
        {stats.playsByPlatform.length > 0 && (
          <Card className="bg-zinc-900 border-zinc-800 p-5">
            <h3 className="font-semibold text-white mb-3 text-sm">Top Platforms</h3>
            <HorizontalBar
              items={stats.playsByPlatform.map((p) => ({ label: p.platform, value: p.count }))}
              max={platformMax}
            />
          </Card>
        )}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {stats.topDevices.length > 0 && (
          <Card className="bg-zinc-900 border-zinc-800 p-5">
            <h3 className="font-semibold text-white mb-3 text-sm">Top Devices</h3>
            <HorizontalBar
              items={stats.topDevices.map((d) => ({ label: d.device, value: d.count }))}
              max={deviceMax}
              color="bg-emerald-600"
            />
          </Card>
        )}
        {stats.topPlayers.length > 0 && (
          <Card className="bg-zinc-900 border-zinc-800 p-5">
            <h3 className="font-semibold text-white mb-3 text-sm">Top Players</h3>
            <HorizontalBar
              items={stats.topPlayers.map((p) => ({ label: p.player, value: p.count }))}
              max={playerMax}
              color="bg-cyan-600"
            />
          </Card>
        )}
      </div>
    </div>
  );
}
