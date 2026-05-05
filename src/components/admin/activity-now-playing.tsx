"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { Card } from "@/components/ui/card";
import {
  Monitor, Pause, Play, Tv2, Film, Wifi, WifiOff,
  Smartphone, Laptop, MonitorPlay, Gamepad2, Tablet,
  User, Clock, Zap, HardDrive, Activity,
} from "lucide-react";
import { useLiveEvents, type ActiveSessionLive } from "@/hooks/use-live-events";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { IpInfo } from "@/components/admin/ip-info";

function formatDuration(ms: number): string {
  if (ms <= 0) return "0:00";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function formatBitrate(raw: number | null): string {
  if (!raw || raw <= 0) return "";
  const kbps = raw > 100000 ? raw / 1000 : raw;
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`;
  return `${Math.round(kbps)} kbps`;
}

function toBitrateKbps(raw: number | null): number {
  if (!raw || raw <= 0) return 0;
  // Plex reports bitrate in kbps; Jellyfin reports in bps — normalize to kbps
  return raw > 100000 ? raw / 1000 : raw;
}

function formatElapsed(startedAt: string | null): string {
  if (!startedAt) return "";
  const elapsed = Date.now() - new Date(startedAt).getTime();
  const mins = Math.floor(elapsed / 60000);
  if (mins < 1) return "just started";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function PlatformIcon({ platform }: { platform: string | null }) {
  const p = (platform ?? "").toLowerCase();
  if (p.includes("android") || p.includes("ios") || p.includes("iphone")) return <Smartphone className="w-4 h-4" />;
  if (p.includes("roku") || p.includes("apple tv") || p.includes("fire") || p.includes("chromecast") || p.includes("shield")) return <MonitorPlay className="w-4 h-4" />;
  if (p.includes("xbox") || p.includes("playstation") || p.includes("nintendo")) return <Gamepad2 className="w-4 h-4" />;
  if (p.includes("ipad") || p.includes("tablet")) return <Tablet className="w-4 h-4" />;
  if (p.includes("chrome") || p.includes("firefox") || p.includes("safari") || p.includes("web") || p.includes("edge")) return <Laptop className="w-4 h-4" />;
  return <Monitor className="w-4 h-4" />;
}

function PlayMethodLabel({ session }: { session: ActiveSessionLive }) {
  const vd = session.videoDecision;
  const ad = session.audioDecision;
  const method = session.playMethod;

  if (method === "DirectPlay") {
    return <span className="font-medium text-green-400">Direct Play</span>;
  }
  if (method === "DirectStream") {
    return <span className="font-medium text-blue-400">Remux</span>;
  }
  if (method === "Transcode") {
    const videoT = vd === "transcode";
    const audioT = ad === "transcode";
    if (videoT && audioT) return <span className="font-medium text-orange-400">Transcoding video + audio</span>;
    if (videoT) return <span className="font-medium text-orange-400">Transcoding video</span>;
    if (audioT) return <span className="font-medium text-orange-400">Transcoding audio</span>;
    return <span className="font-medium text-orange-400">Transcode</span>;
  }
  if (method) return <span className="font-medium text-zinc-300">{method}</span>;
  return null;
}

function StreamDetails({ session: s }: { session: ActiveSessionLive }) {
  const hasVideo = !!s.videoCodec;
  const hasAudio = !!s.audioCodec;
  if (!hasVideo && !hasAudio && !s.container) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mt-2 pt-2 border-t border-zinc-700/50 text-xs">
      {hasVideo && (
        <div className="flex items-center gap-1.5">
          <span className="text-zinc-500 text-[10px] uppercase w-10">Video</span>
          <span className={s.videoDecision === "transcode" ? "text-orange-400 font-medium" : "text-zinc-300"}>
            {s.videoCodec!.toUpperCase()}
          </span>
          {s.resolution && <span className="text-zinc-500">{s.resolution}</span>}
          {s.videoDecision && (
            <span className={`text-[9px] px-1 py-0.5 rounded ${
              s.videoDecision === "transcode"
                ? "bg-orange-500/15 text-orange-400"
                : "bg-green-500/15 text-green-400"
            }`}>
              {s.videoDecision === "transcode" ? "Transcode" : "Direct"}
            </span>
          )}
        </div>
      )}
      {hasAudio && (
        <div className="flex items-center gap-1.5">
          <span className="text-zinc-500 text-[10px] uppercase w-10">Audio</span>
          <span className={s.audioDecision === "transcode" ? "text-orange-400 font-medium" : "text-zinc-300"}>
            {s.audioCodec!.toUpperCase()}
          </span>
          {s.audioDecision && (
            <span className={`text-[9px] px-1 py-0.5 rounded ${
              s.audioDecision === "transcode"
                ? "bg-orange-500/15 text-orange-400"
                : "bg-green-500/15 text-green-400"
            }`}>
              {s.audioDecision === "transcode" ? "Transcode" : "Direct"}
            </span>
          )}
        </div>
      )}
      {s.container && (
        <div className="flex items-center gap-1.5">
          <span className="text-zinc-500 text-[10px] uppercase w-10">Cont.</span>
          <span className="text-zinc-400">{s.container.toUpperCase()}</span>
        </div>
      )}
    </div>
  );
}

function SessionCard({ session: s, mounted }: { session: ActiveSessionLive; mounted: boolean }) {
  const isTV = (s.mediaType ?? "").toUpperCase() === "TV";
  const mediaHref = s.tmdbId
    ? isTV ? `/tv/${s.tmdbId}` : `/movie/${s.tmdbId}`
    : null;

  const episodeStr = isTV && (s.seasonNumber || s.episodeNumber)
    ? `S${String(s.seasonNumber ?? 0).padStart(2, "0")}E${String(s.episodeNumber ?? 0).padStart(2, "0")}`
    : null;

  const bitrateStr = formatBitrate(s.bitrate);
  const elapsed = mounted ? formatElapsed(s.startedAt) : "";
  const remaining = s.durationMs > 0 && s.progressMs > 0
    ? formatDuration(s.durationMs - s.progressMs)
    : null;

  const isTranscoding = s.playMethod === "Transcode";

  return (
    <div className={`bg-zinc-800/60 rounded-xl overflow-hidden ${isTranscoding ? "ring-1 ring-orange-500/20" : ""}`}>
      <div className="flex">
        <div className="relative w-20 sm:w-28 shrink-0 bg-zinc-800">
          {s.posterUrl && /^https?:\/\//i.test(s.posterUrl) ? (
            mediaHref ? (
              <Link href={mediaHref} className="block w-full h-full">
                <Image
                  src={s.posterUrl}
                  alt={s.title}
                  width={154}
                  height={231}
                  className="w-full h-full object-cover"
                  unoptimized
                />
              </Link>
            ) : (
              <Image
                src={s.posterUrl}
                alt={s.title}
                width={154}
                height={231}
                className="w-full h-full object-cover"
                unoptimized
              />
            )
          ) : (
            <div className="w-full h-full flex items-center justify-center min-h-[120px]">
              {isTV ? (
                <Tv2 className="w-8 h-8 text-zinc-700" />
              ) : (
                <Film className="w-8 h-8 text-zinc-700" />
              )}
            </div>
          )}
          <div className={`absolute bottom-0 left-0 right-0 flex items-center justify-center py-1 ${
            s.state === "paused"
              ? "bg-yellow-500/90"
              : s.state === "buffering"
                ? "bg-blue-500/90"
                : "bg-green-500/90"
          }`}>
            <div className="flex items-center gap-1">
              {s.state === "paused" ? (
                <Pause className="w-3 h-3 text-white" />
              ) : (
                <Play className="w-3 h-3 text-white" />
              )}
              <span className="text-[10px] font-semibold text-white uppercase tracking-wide">
                {s.state === "paused" ? "Paused" : s.state === "buffering" ? "Buffering" : "Playing"}
              </span>
            </div>
          </div>
        </div>

        <div className="flex-1 min-w-0 p-3 sm:p-4">
          <div className="flex items-start justify-between gap-2 mb-1.5">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                {mediaHref ? (
                  <Link href={mediaHref} className="text-sm font-semibold text-white hover:text-indigo-400 transition-colors truncate">
                    {s.title}
                  </Link>
                ) : (
                  <span className="text-sm font-semibold text-white truncate">{s.title}</span>
                )}
                {s.year && <span className="text-zinc-600 text-xs shrink-0">({s.year})</span>}
              </div>
              {(episodeStr || s.episodeTitle) && (
                <p className="text-xs text-zinc-400 truncate mt-0.5">
                  {episodeStr && <span className="text-zinc-500 font-medium">{episodeStr}</span>}
                  {episodeStr && s.episodeTitle && <span className="text-zinc-600"> · </span>}
                  {s.episodeTitle && <span>{s.episodeTitle}</span>}
                </p>
              )}
            </div>
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold shrink-0 ${
              s.source === "plex" ? "bg-amber-500/15 text-amber-400" : "bg-purple-500/15 text-purple-400"
            }`}>
              {s.source === "plex" ? "Plex" : "Jellyfin"}
            </span>
          </div>

          <div className="flex items-center gap-2 mb-3">
            <span className="text-[11px] text-zinc-400 tabular-nums shrink-0 w-12 text-right">
              {formatDuration(s.progressMs)}
            </span>
            <div className="flex-1 h-1.5 bg-zinc-700 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-1000 ${
                  s.state === "paused" ? "bg-yellow-500" : "bg-indigo-500"
                }`}
                style={{ width: `${Math.min(s.progressPercent, 100)}%` }}
              />
            </div>
            <span className="text-[11px] text-zinc-500 tabular-nums shrink-0 w-12">
              {formatDuration(s.durationMs)}
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1.5 text-xs">
            <div className="flex items-center gap-1.5 text-zinc-300">
              <User className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
              {s.mediaServerUserId ? (
                <Link
                  href={`/admin/activity/user/${s.mediaServerUserId}`}
                  className="font-medium truncate hover:text-indigo-400 transition-colors"
                >
                  {s.serverUsername}
                </Link>
              ) : (
                <span className="font-medium truncate">{s.serverUsername}</span>
              )}
            </div>

            {(s.platform || s.player) && (
              <div className="flex items-center gap-1.5 text-zinc-400">
                <PlatformIcon platform={s.platform ?? s.player} />
                <span className="truncate">{s.player ?? s.platform}</span>
              </div>
            )}

            {elapsed && (
              <div className="flex items-center gap-1.5 text-zinc-400">
                <Clock className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                <span>Session: {elapsed}</span>
                {remaining && <span className="text-zinc-600">({remaining} left)</span>}
              </div>
            )}

            {s.playMethod && (
              <div className="flex items-center gap-1.5">
                <Zap className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                <PlayMethodLabel session={s} />
              </div>
            )}

            {bitrateStr && (
              <div className="flex items-center gap-1.5 text-zinc-400">
                <HardDrive className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                <span>{bitrateStr}</span>
              </div>
            )}

            {s.ipAddress && <IpInfo ip={s.ipAddress} />}
          </div>

          <StreamDetails session={s} />
        </div>
      </div>
    </div>
  );
}

export function ActivityNowPlaying({
  initialSessions,
  source,
  mediaType,
}: {
  initialSessions: ActiveSessionLive[];
  source?: string;
  mediaType?: string;
}) {
  const [sessions, setSessions] = useState<ActiveSessionLive[]>(initialSessions);
  const [connected, setConnected] = useState(false);
  const mounted = useHasMounted();

  useLiveEvents((event) => {
    if (event.type === "connected") {
      setConnected(true);
    }
    if (event.type === "activity:sessions") {
      setSessions((prev) => {
        // Preserve poster URLs from previous state: SSE payloads omit posterUrl to keep them small
        const posterMap = new Map(prev.map((s) => [s.id, s.posterUrl]));
        const filtered = event.sessions.filter((s) => {
          if (source && s.source !== source) return false;
          if (mediaType && (s.mediaType ?? "").toUpperCase() !== mediaType) return false;
          return true;
        });
        return filtered.map((s) => ({
          ...s,
          posterUrl: s.posterUrl ?? posterMap.get(s.id) ?? null,
        }));
      });
    }
  });

  const totalBitrateMbps = sessions.reduce((sum, s) => sum + toBitrateKbps(s.bitrate), 0) / 1000;

  return (
    <Card className="bg-zinc-900 border-zinc-800 p-5 mb-8">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-semibold text-white flex items-center gap-2">
          <Monitor className="w-4 h-4" />
          Now Playing
          {sessions.length > 0 && (() => {
            const plexCount = sessions.filter((s) => s.source === "plex").length;
            const jellyfinCount = sessions.filter((s) => s.source === "jellyfin").length;
            const singleSource = plexCount === 0 || jellyfinCount === 0;
            const sourceLabel = plexCount > 0 ? "Plex" : "Jellyfin";
            const sourceText = singleSource
              ? `${sessions.length} ${sourceLabel} stream${sessions.length !== 1 ? "s" : ""}`
              : `${sessions.length} streams • ${plexCount} Plex · ${jellyfinCount} Jellyfin`;
            return (
              <span className="text-xs bg-green-600/20 text-green-400 px-2 py-0.5 rounded-full">
                {sourceText}
              </span>
            );
          })()}
          {totalBitrateMbps > 0 && (
            <span className="text-xs text-zinc-500 flex items-center gap-1">
              <Activity className="w-3 h-3" />
              {totalBitrateMbps.toFixed(1)} Mbps
            </span>
          )}
        </h2>
        <div className="flex items-center gap-1.5 text-[10px]">
          {connected ? (
            <><Wifi className="w-3 h-3 text-green-500" /><span className="text-green-500">Live</span></>
          ) : (
            <><WifiOff className="w-3 h-3 text-zinc-600" /><span className="text-zinc-600">Connecting...</span></>
          )}
        </div>
      </div>

      {sessions.length === 0 ? (
        <p className="text-zinc-500 text-sm">No active streams</p>
      ) : (
        <div className="space-y-3">
          {sessions.map((s) => (
            <SessionCard key={s.id} session={s} mounted={mounted} />
          ))}
        </div>
      )}
    </Card>
  );
}
