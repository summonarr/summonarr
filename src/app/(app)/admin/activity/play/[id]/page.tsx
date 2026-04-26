import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { Card } from "@/components/ui/card";
import { posterUrl } from "@/lib/tmdb-types";
import {
  ArrowLeft, Film, Tv2, User, Monitor, Zap,
  Clock, CheckCircle2, Circle,
} from "lucide-react";
import { DeletePlayButton } from "@/components/admin/delete-play-button";
import { IpInfo } from "@/components/admin/ip-info";

export const dynamic = "force-dynamic";

function formatDuration(seconds: number | null): string {
  if (!seconds || seconds <= 0) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatBitrate(raw: number | null): string {
  if (!raw || raw <= 0) return "—";
  const kbps = raw > 100000 ? raw / 1000 : raw;
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`;
  return `${Math.round(kbps)} kbps`;
}

function formatTs(d: Date | null): string {
  if (!d) return "—";
  return d.toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  });
}

function LabeledValue({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div>
      <p className="text-xs text-zinc-500 uppercase tracking-wide mb-0.5">{label}</p>
      <p className={`text-sm text-zinc-200 ${mono ? "tabular-nums font-mono" : ""}`}>{value}</p>
    </div>
  );
}

function PlayMethodBadge({ method }: { method: string | null }) {
  if (!method) return <span className="text-zinc-500">—</span>;
  const colors: Record<string, string> = {
    DirectPlay: "bg-green-500/15 text-green-400",
    DirectStream: "bg-blue-500/15 text-blue-400",
    Transcode: "bg-orange-500/15 text-orange-400",
  };
  const labels: Record<string, string> = {
    DirectPlay: "Direct Play",
    DirectStream: "Direct Stream (Remux)",
    Transcode: "Transcode",
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${colors[method] ?? "bg-zinc-700 text-zinc-300"}`}>
      {labels[method] ?? method}
    </span>
  );
}

function DecisionBadge({ decision }: { decision: string | null }) {
  if (!decision) return <span className="text-zinc-500">—</span>;
  const isTranscode = decision === "transcode";
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
      isTranscode ? "bg-orange-500/15 text-orange-400" : "bg-green-500/15 text-green-400"
    }`}>
      {isTranscode ? "Transcode" : "Direct"}
    </span>
  );
}

export default async function PlayDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") redirect("/");

  const { id } = await params;

  const play = await prisma.playHistory.findUnique({
    where: { id },
    include: {
      mediaServerUser: {
        select: { id: true, username: true, source: true, thumbUrl: true },
      },
    },
  });

  if (!play) notFound();

  const isTV = (play.mediaType ?? "").toString() === "TV";
  const mediaHref = play.tmdbId
    ? isTV ? `/tv/${play.tmdbId}` : `/movie/${play.tmdbId}`
    : null;
  const episodeStr = isTV && play.seasonNumber != null
    ? `S${String(play.seasonNumber).padStart(2, "0")}E${String(play.episodeNumber ?? 0).padStart(2, "0")}`
    : null;

  let posterPath: string | null = null;
  if (play.tmdbId) {
    const cacheKeys = [`movie:${play.tmdbId}:details`, `tv:${play.tmdbId}:details`];
    const cacheRows = await prisma.tmdbCache.findMany({
      where: { key: { in: cacheKeys } },
      select: { data: true },
    });
    for (const row of cacheRows) {
      try {
        const parsed = JSON.parse(row.data) as { posterPath?: string | null; poster_path?: string | null };
        const path = parsed.posterPath ?? parsed.poster_path ?? null;
        if (path) { posterPath = posterUrl(path, "w342"); break; }
      } catch { }
    }
  }

  const playDurationS = play.playDuration;
  const durationS = play.duration;
  const pct = durationS > 0 ? Math.min(Math.round((playDurationS / durationS) * 100), 100) : 0;

  return (
    <div className="max-w-4xl">
      <Link
        href="/admin/activity?tab=history"
        className="flex items-center gap-1.5 text-sm text-zinc-400 hover:text-white mb-4 transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to History
      </Link>

      {}
      <div className="flex items-start gap-4 mb-8">
        {posterPath && (
          <div className="shrink-0 w-16 sm:w-20 rounded-lg overflow-hidden shadow-lg">
            {mediaHref ? (
              <Link href={mediaHref}>
                <Image src={posterPath} alt={play.title} width={154} height={231} className="w-full h-auto" unoptimized />
              </Link>
            ) : (
              <Image src={posterPath} alt={play.title} width={154} height={231} className="w-full h-auto" unoptimized />
            )}
          </div>
        )}
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            {isTV ? <Tv2 className="w-5 h-5 text-zinc-400 shrink-0" /> : <Film className="w-5 h-5 text-zinc-400 shrink-0" />}
            <h1 className="text-2xl font-bold text-white">
              {mediaHref ? (
                <Link href={mediaHref} className="hover:text-indigo-400 transition-colors">{play.title}</Link>
              ) : play.title}
            </h1>
            {play.year && <span className="text-zinc-500 text-lg">({play.year})</span>}
          </div>
          {episodeStr && (
            <p className="text-zinc-400 text-sm mb-1">
              <span className="font-medium">{episodeStr}</span>
              {play.episodeTitle && <span className="text-zinc-500"> — {play.episodeTitle}</span>}
            </p>
          )}
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
              play.source === "plex" ? "bg-amber-500/15 text-amber-400" : "bg-purple-500/15 text-purple-400"
            }`}>
              {play.source === "plex" ? "Plex" : "Jellyfin"}
            </span>
            {play.watched ? (
              <span className="flex items-center gap-1 text-xs text-green-400">
                <CheckCircle2 className="w-3.5 h-3.5" /> Watched
              </span>
            ) : (
              <span className="flex items-center gap-1 text-xs text-zinc-500">
                <Circle className="w-3.5 h-3.5" /> Not watched
              </span>
            )}
            <span className="text-xs text-zinc-500">{pct}% complete</span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        {}
        <Card className="bg-zinc-900 border-zinc-800 p-5 md:col-span-1">
          <h2 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
            <Clock className="w-4 h-4 text-zinc-400" /> Playback
          </h2>
          <div className="space-y-3">
            <LabeledValue label="Started" value={formatTs(play.startedAt)} />
            <LabeledValue label="Stopped" value={formatTs(play.stoppedAt)} />
            <div>
              <p className="text-xs text-zinc-500 uppercase tracking-wide mb-1">Progress</p>
              <div className="flex items-center gap-2">
                <div className="flex-1 h-2 bg-zinc-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${pct >= 80 ? "bg-green-500" : pct >= 50 ? "bg-blue-500" : "bg-zinc-500"}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="text-xs text-zinc-400 tabular-nums w-8 text-right">{pct}%</span>
              </div>
            </div>
            <LabeledValue label="Watch Time" value={formatDuration(playDurationS)} />
            <LabeledValue label="Total Duration" value={formatDuration(durationS)} />
            {play.pausedDuration > 0 && (
              <LabeledValue label="Paused" value={formatDuration(play.pausedDuration)} />
            )}
          </div>
        </Card>

        {}
        <Card className="bg-zinc-900 border-zinc-800 p-5 md:col-span-1">
          <h2 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
            <Zap className="w-4 h-4 text-zinc-400" /> Stream Quality
          </h2>
          <div className="space-y-3">
            <div>
              <p className="text-xs text-zinc-500 uppercase tracking-wide mb-0.5">Play Method</p>
              <PlayMethodBadge method={play.playMethod} />
            </div>
            <LabeledValue label="Resolution" value={play.resolution ?? "—"} />
            <div>
              <p className="text-xs text-zinc-500 uppercase tracking-wide mb-0.5">Video Codec</p>
              <span className="text-sm text-zinc-200">{play.videoCodec?.toUpperCase() ?? "—"}</span>
              {play.videoDecision && (
                <span className="ml-2"><DecisionBadge decision={play.videoDecision} /></span>
              )}
            </div>
            <div>
              <p className="text-xs text-zinc-500 uppercase tracking-wide mb-0.5">Audio Codec</p>
              <span className="text-sm text-zinc-200">{play.audioCodec?.toUpperCase() ?? "—"}</span>
              {play.audioDecision && (
                <span className="ml-2"><DecisionBadge decision={play.audioDecision} /></span>
              )}
            </div>
            <LabeledValue label="Container" value={play.container?.toUpperCase() ?? "—"} />
            <LabeledValue label="Bitrate" value={formatBitrate(play.bitrate)} />
          </div>
        </Card>

        {}
        <Card className="bg-zinc-900 border-zinc-800 p-5 md:col-span-1">
          <h2 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
            <Monitor className="w-4 h-4 text-zinc-400" /> Device
          </h2>
          <div className="space-y-3">
            <div>
              <p className="text-xs text-zinc-500 uppercase tracking-wide mb-0.5">User</p>
              <Link
                href={`/admin/activity/user/${play.mediaServerUser.id}`}
                className="flex items-center gap-2 text-sm text-indigo-400 hover:text-indigo-300 transition-colors"
              >
                {play.mediaServerUser.thumbUrl && /^https?:\/\//i.test(play.mediaServerUser.thumbUrl) && (
                  <img src={play.mediaServerUser.thumbUrl} alt="" className="w-5 h-5 rounded-full object-cover" />
                )}
                <User className="w-3.5 h-3.5" />
                {play.mediaServerUser.username}
              </Link>
            </div>
            <LabeledValue label="Platform" value={play.platform ?? "—"} />
            <LabeledValue label="Player" value={play.player ?? "—"} />
            <LabeledValue label="Device" value={play.device ?? "—"} />
            <div>
              <p className="text-xs text-zinc-500 uppercase tracking-wide mb-0.5">IP Address</p>
              {play.ipAddress
                ? <IpInfo ip={play.ipAddress} />
                : <p className="text-sm text-zinc-200">—</p>}
            </div>
          </div>
        </Card>
      </div>

      {}
      <div className="flex justify-end">
        <DeletePlayButton id={play.id} />
      </div>
    </div>
  );
}
