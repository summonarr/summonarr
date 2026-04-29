import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect, notFound } from "next/navigation";
import { Card } from "@/components/ui/card";
import { getUserPlayStats } from "@/lib/play-history";
import Link from "next/link";
import { ArrowLeft, Film, Tv2 } from "lucide-react";
import { ActivityCalendar } from "@/components/admin/activity-calendar";
import {
  HeatmapChart,
  TranscodeRatioBars,
  HorizontalBar,
} from "@/components/admin/activity-chart-primitives";
import { IpInfo } from "@/components/admin/ip-info";

export const dynamic = "force-dynamic";

function formatDuration(seconds: number): string {
  if (seconds <= 0) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${seconds}s`;
}

function formatRelativeTime(date: Date): string {
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}

export default async function UserActivityPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") redirect("/");

  const { id } = await params;

  const msUser = await prisma.mediaServerUser.findUnique({
    where: { id },
    include: { user: { select: { name: true, email: true } } },
  });

  if (!msUser) notFound();

  const stats = await getUserPlayStats(id);

  const ipGroups = await prisma.playHistory.groupBy({
    by: ["ipAddress"],
    where: { mediaServerUserId: id, ipAddress: { not: null } },
    _count: { _all: true },
    _max: { startedAt: true },
  });
  const knownIps = ipGroups
    .filter((g): g is typeof g & { ipAddress: string } => !!g.ipAddress)
    .map((g) => ({
      ip: g.ipAddress,
      plays: g._count._all,
      lastSeen: g._max.startedAt,
    }))
    .sort((a, b) => (b.lastSeen?.getTime() ?? 0) - (a.lastSeen?.getTime() ?? 0));

  const platformMax = Math.max(...stats.platformBreakdown.map((p) => p.count), 1);
  const resolutionMax = Math.max(...stats.resolutionBreakdown.map((r) => r.count), 1);
  const deviceMax = Math.max(...stats.deviceList.map((d) => d.count), 1);

  const directPlays = stats.transcodeRatio.find((r) => r.method === "DirectPlay")?.count ?? 0;
  const totalWithMethod = stats.transcodeRatio.reduce((s, r) => s + r.count, 0);
  const directPct = totalWithMethod > 0 ? Math.round((directPlays / totalWithMethod) * 100) : null;

  return (
    <div>
      <Link href="/admin/activity" className="flex items-center gap-1.5 text-sm text-zinc-400 hover:text-white mb-4 transition-colors">
        <ArrowLeft className="w-4 h-4" />
        Back to Activity
      </Link>

      <div className="mb-8">
        <div className="flex items-center gap-3 mb-1">
          {msUser.thumbUrl && /^https?:\/\//i.test(msUser.thumbUrl) && (
            <img src={msUser.thumbUrl} alt="" className="w-10 h-10 rounded-full object-cover" />
          )}
          <h1 className="text-2xl font-bold">{msUser.username}</h1>
        </div>
        <div className="flex items-center gap-3 text-sm text-zinc-400">
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
            msUser.source === "plex" ? "bg-amber-500/15 text-amber-400" : "bg-purple-500/15 text-purple-400"
          }`}>
            {msUser.source === "plex" ? "Plex" : "Jellyfin"}
          </span>
          {msUser.user && <span>Linked to {msUser.user.name ?? msUser.user.email}</span>}
          {msUser.email && <span>{msUser.email}</span>}
        </div>
      </div>

      {}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-8">
        <Card className="bg-zinc-900 border-zinc-800 p-4">
          <p className="text-xs text-zinc-500 uppercase tracking-wide mb-1">Total Plays</p>
          <p className="text-2xl font-bold text-white tabular-nums">{stats.totalPlays}</p>
        </Card>
        <Card className="bg-zinc-900 border-zinc-800 p-4">
          <p className="text-xs text-zinc-500 uppercase tracking-wide mb-1">Watch Time</p>
          <p className="text-2xl font-bold text-white tabular-nums">{stats.totalWatchTimeHours}h</p>
        </Card>
        <Card className="bg-zinc-900 border-zinc-800 p-4">
          <p className="text-xs text-zinc-500 uppercase tracking-wide mb-1">Last Active</p>
          <p className="text-lg font-bold text-white">
            {stats.recentPlays.length > 0 ? formatRelativeTime(stats.recentPlays[0].startedAt) : "Never"}
          </p>
        </Card>
        <Card className="bg-zinc-900 border-zinc-800 p-4">
          <p className="text-xs text-zinc-500 uppercase tracking-wide mb-1">Avg Session</p>
          <p className="text-lg font-bold text-white">{formatDuration(stats.avgSessionDuration)}</p>
        </Card>
        {directPct !== null && (
          <Card className="bg-zinc-900 border-zinc-800 p-4">
            <p className="text-xs text-zinc-500 uppercase tracking-wide mb-1">Direct Play</p>
            <p className="text-2xl font-bold text-green-400 tabular-nums">{directPct}%</p>
          </Card>
        )}
      </div>

      {}
      {stats.activityCalendar.length > 0 && (
        <Card className="bg-zinc-900 border-zinc-800 p-5 mb-8">
          <h2 className="font-semibold text-white mb-4">Activity (365 days)</h2>
          <ActivityCalendar data={stats.activityCalendar} today={new Date().toISOString()} />
        </Card>
      )}

      {}
      {stats.userHeatmap.length > 0 && (
        <Card className="bg-zinc-900 border-zinc-800 p-5 mb-8">
          <h2 className="font-semibold text-white mb-4 text-sm">Viewing Heatmap</h2>
          <HeatmapChart data={stats.userHeatmap} />
        </Card>
      )}

      {}
      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4 mb-8">
        {stats.playsByDay.length > 0 && (
          <Card className="bg-zinc-900 border-zinc-800 p-5">
            <h3 className="font-semibold text-white mb-3 text-sm">Plays Over Time (90d)</h3>
            <div className="flex items-end gap-1 h-24">
              {stats.playsByDay.map((d) => {
                const max = Math.max(...stats.playsByDay.map((x) => x.count), 1);
                const height = (d.count / max) * 100;
                return (
                  <div
                    key={d.day}
                    className="flex-1 bg-indigo-600 rounded-t hover:bg-indigo-500 transition-all"
                    style={{ height: `${Math.max(height, 2)}%` }}
                    title={`${d.day}: ${d.count} plays (${d.hours}h)`}
                  />
                );
              })}
            </div>
          </Card>
        )}

        {stats.platformBreakdown.length > 0 && (
          <Card className="bg-zinc-900 border-zinc-800 p-5">
            <h3 className="font-semibold text-white mb-3 text-sm">Platforms</h3>
            <HorizontalBar
              items={stats.platformBreakdown.slice(0, 8).map((p) => ({ label: p.platform, value: p.count }))}
              max={platformMax}
            />
          </Card>
        )}

        {stats.transcodeRatio.length > 0 && (
          <Card className="bg-zinc-900 border-zinc-800 p-5">
            <h3 className="font-semibold text-white mb-3 text-sm">Stream Type</h3>
            <TranscodeRatioBars data={stats.transcodeRatio} />
          </Card>
        )}

        {stats.resolutionBreakdown.length > 0 && (
          <Card className="bg-zinc-900 border-zinc-800 p-5">
            <h3 className="font-semibold text-white mb-3 text-sm">Resolutions</h3>
            <HorizontalBar
              items={stats.resolutionBreakdown.map((r) => ({ label: r.resolution, value: r.count }))}
              max={resolutionMax}
              color="bg-emerald-600"
            />
          </Card>
        )}

        {stats.deviceList.length > 0 && (
          <Card className="bg-zinc-900 border-zinc-800 p-5">
            <h3 className="font-semibold text-white mb-3 text-sm">Devices</h3>
            <HorizontalBar
              items={stats.deviceList.map((d) => ({ label: d.device, value: d.count }))}
              max={deviceMax}
              color="bg-violet-600"
            />
          </Card>
        )}
      </div>

      {}
      {stats.topMedia.length > 0 && (
        <Card className="bg-zinc-900 border-zinc-800 p-5 mb-8">
          <h2 className="font-semibold text-white mb-4">Most Watched</h2>
          <div className="space-y-2">
            {stats.topMedia.map((m, i) => {
              const href = m.tmdbId && m.mediaType
                ? (m.mediaType === "TV" ? `/tv/${m.tmdbId}` : `/movie/${m.tmdbId}`)
                : null;
              const activityHref = m.tmdbId ? `/admin/activity/media/${m.tmdbId}` : null;
              return (
                <div key={`${m.title}-${i}`} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-3">
                    <span className="text-zinc-600 w-5 text-right">{i + 1}.</span>
                    {m.mediaType === "TV" ? <Tv2 className="w-3.5 h-3.5 text-zinc-500" /> : <Film className="w-3.5 h-3.5 text-zinc-500" />}
                    {href ? (
                      <Link href={href} className="text-white hover:text-indigo-400 transition-colors">{m.title}</Link>
                    ) : (
                      <span className="text-white">{m.title}</span>
                    )}
                    {activityHref && (
                      <Link href={activityHref} className="text-[10px] text-zinc-600 hover:text-indigo-400 transition-colors">
                        activity
                      </Link>
                    )}
                  </div>
                  <span className="text-zinc-400 tabular-nums">{m.count} plays</span>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {knownIps.length > 0 && (
        <Card className="bg-zinc-900 border-zinc-800 p-5 mb-8">
          <h2 className="font-semibold text-white mb-4">
            Known IP Addresses ({knownIps.length})
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-zinc-500 uppercase tracking-wider border-b border-zinc-800">
                  <th className="text-left py-2 pr-4">IP Address</th>
                  <th className="text-right py-2 pr-4">Plays</th>
                  <th className="text-right py-2">Last Seen</th>
                </tr>
              </thead>
              <tbody>
                {knownIps.map((ip) => (
                  <tr key={ip.ip} className="border-b border-zinc-800/50 align-top">
                    <td className="py-2.5 pr-4">
                      <IpInfo ip={ip.ip} />
                    </td>
                    <td className="py-2.5 pr-4 text-right text-zinc-400 tabular-nums">
                      {ip.plays}
                    </td>
                    <td className="py-2.5 text-right text-zinc-500">
                      {ip.lastSeen ? formatRelativeTime(ip.lastSeen) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {}
      <Card className="bg-zinc-900 border-zinc-800 p-5 mb-8">
        <h2 className="font-semibold text-white mb-4">Play History ({stats.recentPlays.length})</h2>
        {stats.recentPlays.length === 0 ? (
          <p className="text-zinc-500 text-sm">No plays recorded</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-zinc-500 uppercase tracking-wider border-b border-zinc-800">
                  <th className="text-left py-2 pr-4">Media</th>
                  <th className="text-left py-2 pr-4">Quality</th>
                  <th className="text-right py-2 pr-4">Duration</th>
                  <th className="text-right py-2">When</th>
                </tr>
              </thead>
              <tbody>
                {stats.recentPlays.map((p) => {
                  const qualityParts: string[] = [];
                  if (p.playMethod) qualityParts.push(p.playMethod === "DirectPlay" ? "Direct" : p.playMethod);
                  if (p.resolution) qualityParts.push(p.resolution);
                  if (p.videoCodec) qualityParts.push(p.videoCodec.toUpperCase());

                  const displayTitle = p.mediaType === "TV" && p.seasonNumber != null
                    ? `${p.title} S${String(p.seasonNumber).padStart(2, "0")}E${String(p.episodeNumber ?? 0).padStart(2, "0")}`
                    : p.title;

                  return (
                    <tr key={p.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/30">
                      <td className="py-2.5 pr-4">
                        <div className="flex items-center gap-2">
                          {p.mediaType === "TV" ? (
                            <Tv2 className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                          ) : (
                            <Film className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                          )}
                          <Link href={`/admin/activity/play/${p.id}`} className="text-white hover:text-indigo-400 transition-colors truncate max-w-[300px]">
                            {displayTitle}
                          </Link>
                          {p.watched && (
                            <span className="text-[10px] bg-green-600/20 text-green-400 px-1.5 py-0.5 rounded shrink-0">watched</span>
                          )}
                        </div>
                      </td>
                      <td className="py-2.5 pr-4 text-zinc-500 text-xs">
                        {qualityParts.length > 0 ? qualityParts.join(" · ") : "—"}
                      </td>
                      <td className="py-2.5 pr-4 text-right text-zinc-400 tabular-nums">
                        {formatDuration(p.playDuration)}
                      </td>
                      <td className="py-2.5 text-right text-zinc-500">
                        {formatRelativeTime(p.startedAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
