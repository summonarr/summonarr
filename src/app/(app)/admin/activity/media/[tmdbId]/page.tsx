import { auth } from "@/lib/auth";
import { redirect, notFound } from "next/navigation";
import { Card } from "@/components/ui/card";
import { getMediaPlayStats } from "@/lib/play-history";
import Link from "next/link";
import { ArrowLeft, Film, Tv2 } from "lucide-react";
import {
  TranscodeRatioBars,
  HorizontalBar,
} from "@/components/admin/activity-chart-primitives";

export const dynamic = "force-dynamic";

function formatDuration(seconds: number): string {
  if (seconds <= 0) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
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

export default async function MediaActivityPage({
  params,
}: {
  params: Promise<{ tmdbId: string }>;
}) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") redirect("/");

  const { tmdbId: tmdbIdStr } = await params;
  const tmdbId = parseInt(tmdbIdStr, 10);
  if (!Number.isFinite(tmdbId)) notFound();

  const stats = await getMediaPlayStats(tmdbId);

  const mediaHref = stats.mediaType === "TV" ? `/tv/${tmdbId}` : `/movie/${tmdbId}`;
  const resolutionMax = Math.max(...stats.resolutionBreakdown.map((r) => r.count), 1);

  return (
    <div>
      <Link
        href="/admin/activity"
        className="flex items-center gap-1.5 text-sm text-zinc-400 hover:text-white mb-4 transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Activity
      </Link>

      <div className="mb-8">
        <div className="flex items-center gap-2 mb-1">
          {stats.mediaType === "TV" ? (
            <Tv2 className="w-5 h-5 text-zinc-400" />
          ) : (
            <Film className="w-5 h-5 text-zinc-400" />
          )}
          <h1 className="text-2xl font-bold">
            <Link href={mediaHref} className="hover:text-indigo-400 transition-colors">
              {stats.title}
            </Link>
          </h1>
          {stats.year && <span className="text-zinc-500">({stats.year})</span>}
        </div>
        <p className="text-zinc-400 text-sm">Playback activity for this title</p>
      </div>

      {}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-8">
        <Card className="bg-zinc-900 border-zinc-800 p-4">
          <p className="text-xs text-zinc-500 uppercase tracking-wide mb-1">Total Plays</p>
          <p className="text-2xl font-bold text-white tabular-nums">{stats.totalPlays}</p>
        </Card>
        <Card className="bg-zinc-900 border-zinc-800 p-4">
          <p className="text-xs text-zinc-500 uppercase tracking-wide mb-1">Unique Viewers</p>
          <p className="text-2xl font-bold text-white tabular-nums">{stats.uniqueViewers}</p>
        </Card>
        <Card className="bg-zinc-900 border-zinc-800 p-4">
          <p className="text-xs text-zinc-500 uppercase tracking-wide mb-1">Avg Completion</p>
          <p className="text-2xl font-bold text-white tabular-nums">{stats.avgCompletion}%</p>
        </Card>
      </div>

      {}
      {stats.playsByDay.length > 0 && (
        <Card className="bg-zinc-900 border-zinc-800 p-5 mb-8">
          <h2 className="font-semibold text-white mb-4 text-sm">Plays Over Time (90d)</h2>
          <div className="flex items-end gap-1 h-24">
            {stats.playsByDay.map((d) => {
              const max = Math.max(...stats.playsByDay.map((x) => x.count), 1);
              const height = (d.count / max) * 100;
              return (
                <div
                  key={d.day}
                  className="flex-1 bg-indigo-600 rounded-t hover:bg-indigo-500 transition-all"
                  style={{ height: `${Math.max(height, 2)}%` }}
                  title={`${d.day}: ${d.count} plays`}
                />
              );
            })}
          </div>
        </Card>
      )}

      {}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-8">
        {stats.topViewers.length > 0 && (
          <Card className="bg-zinc-900 border-zinc-800 p-5 lg:col-span-1">
            <h2 className="font-semibold text-white mb-4">Who Watched</h2>
            <div className="space-y-2">
              {stats.topViewers.map((v, i) => {
                const maxCount = stats.topViewers[0]?.count ?? 1;
                return (
                  <div key={v.id} className="flex items-center gap-3">
                    <span className="text-zinc-600 w-5 text-right text-xs">{i + 1}.</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between text-sm mb-0.5">
                        <Link
                          href={`/admin/activity/user/${v.id}`}
                          className="text-white hover:text-indigo-400 transition-colors truncate"
                        >
                          {v.username}
                        </Link>
                        <span className="text-zinc-400 tabular-nums shrink-0 ml-2">
                          {v.count} · {v.hours}h
                        </span>
                      </div>
                      <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-indigo-600 rounded-full"
                          style={{ width: `${maxCount > 0 ? (v.count / maxCount) * 100 : 0}%` }}
                        />
                      </div>
                      <span className="text-[10px] text-zinc-600">{v.source}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        )}

        {stats.transcodeRatio.length > 0 && (
          <Card className="bg-zinc-900 border-zinc-800 p-5">
            <h2 className="font-semibold text-white mb-4 text-sm">Stream Type</h2>
            <TranscodeRatioBars data={stats.transcodeRatio} />
          </Card>
        )}

        {stats.resolutionBreakdown.length > 0 && (
          <Card className="bg-zinc-900 border-zinc-800 p-5">
            <h2 className="font-semibold text-white mb-4 text-sm">Resolutions</h2>
            <HorizontalBar
              items={stats.resolutionBreakdown.map((r) => ({ label: r.resolution, value: r.count }))}
              max={resolutionMax}
              color="bg-emerald-600"
            />
          </Card>
        )}
      </div>

      {}
      <Card className="bg-zinc-900 border-zinc-800 p-5 mb-8">
        <h2 className="font-semibold text-white mb-4">
          Play History ({stats.recentPlays.length})
        </h2>
        {stats.recentPlays.length === 0 ? (
          <p className="text-zinc-500 text-sm">No plays recorded</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-zinc-500 uppercase tracking-wider border-b border-zinc-800">
                  <th className="text-left py-2 pr-4">User</th>
                  <th className="text-left py-2 pr-4">Quality</th>
                  <th className="text-left py-2 pr-4">Platform</th>
                  <th className="text-right py-2 pr-4">Duration</th>
                  <th className="text-right py-2">When</th>
                </tr>
              </thead>
              <tbody>
                {stats.recentPlays.map((p) => {
                  const qualityParts: string[] = [];
                  if (p.playMethod)
                    qualityParts.push(
                      p.playMethod === "DirectPlay" ? "Direct" : p.playMethod,
                    );
                  if (p.resolution) qualityParts.push(p.resolution);
                  if (p.videoCodec) qualityParts.push(p.videoCodec.toUpperCase());

                  return (
                    <tr
                      key={p.id}
                      className="border-b border-zinc-800/50 hover:bg-zinc-800/30"
                    >
                      <td className="py-2.5 pr-4">
                        <Link
                          href={`/admin/activity/user/${p.mediaServerUserId}`}
                          className="text-zinc-300 hover:text-indigo-400 transition-colors"
                        >
                          {p.mediaServerUser.username}
                        </Link>
                      </td>
                      <td className="py-2.5 pr-4 text-zinc-500 text-xs">
                        {qualityParts.length > 0 ? qualityParts.join(" · ") : "—"}
                      </td>
                      <td className="py-2.5 pr-4 text-zinc-500">
                        {p.player ?? p.platform ?? "—"}
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
