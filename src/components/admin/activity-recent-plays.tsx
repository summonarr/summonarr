"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Film, Tv2, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { useHasMounted } from "@/hooks/use-has-mounted";

export interface RecentPlay {
  id: string;
  source: string;
  title: string;
  tmdbId: number | null;
  mediaType: string | null;
  startedAt: string;
  stoppedAt: string | null;
  duration: number;
  playDuration: number;
  pausedDuration: number | null;
  watched: boolean;
  platform: string | null;
  player: string | null;
  device: string | null;
  ipAddress: string | null;
  playMethod: string | null;
  resolution: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  bitrate: number | null;
  container: string | null;
  videoDecision: string | null;
  audioDecision: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  episodeTitle: string | null;
  mediaServerUserId: string;
  username: string;
  userSource: string;
  userThumb: string | null;
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatBitrate(raw: number | null): string {
  if (!raw || raw <= 0) return "—";

  const kbps = raw > 100000 ? raw / 1000 : raw;
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`;
  return `${Math.round(kbps)} kbps`;
}

function formatTimestamp(dateStr: string | null): string {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleString();
}

function MediaLink({
  tmdbId,
  mediaType,
  title,
}: {
  tmdbId: number | null;
  mediaType: string | null;
  title: string;
}) {
  if (tmdbId && mediaType) {
    const href = mediaType === "TV" ? `/tv/${tmdbId}` : `/movie/${tmdbId}`;
    return (
      <Link
        href={href}
        className="text-white hover:text-indigo-400 transition-colors truncate max-w-[250px] block"
      >
        {title}
      </Link>
    );
  }
  return <span className="text-white truncate max-w-[250px] block">{title}</span>;
}

function StreamBadge({ method }: { method: string | null }) {
  if (!method) return <span className="text-zinc-600">—</span>;
  const color =
    method === "Transcode"
      ? "text-orange-400"
      : method === "DirectPlay"
        ? "text-green-500"
        : "text-blue-400";
  return (
    <span className={color}>
      {method === "DirectPlay" ? "Direct" : method === "DirectStream" ? "Remux" : method}
    </span>
  );
}

function DetailRow({ play }: { play: RecentPlay }) {
  return (
    <tr className="bg-zinc-800/30">
      <td colSpan={7} className="px-4 py-3">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-6 gap-y-2 text-xs">
          <div>
            <span className="text-zinc-500">Device</span>
            <p className="text-zinc-300">{play.device ?? "—"}</p>
          </div>
          <div>
            <span className="text-zinc-500">IP Address</span>
            <p className="text-zinc-300 tabular-nums">{play.ipAddress ?? "—"}</p>
          </div>
          <div>
            <span className="text-zinc-500">Container</span>
            <p className="text-zinc-300">{play.container ?? "—"}</p>
          </div>
          <div>
            <span className="text-zinc-500">Bitrate</span>
            <p className="text-zinc-300">{formatBitrate(play.bitrate)}</p>
          </div>
          <div>
            <span className="text-zinc-500">Video Decision</span>
            <p className="text-zinc-300">{play.videoDecision ?? "—"}</p>
          </div>
          <div>
            <span className="text-zinc-500">Audio Decision</span>
            <p className="text-zinc-300">{play.audioDecision ?? "—"}</p>
          </div>
          <div>
            <span className="text-zinc-500">Audio Codec</span>
            <p className="text-zinc-300">{play.audioCodec?.toUpperCase() ?? "—"}</p>
          </div>
          <div>
            <span className="text-zinc-500">Paused Duration</span>
            <p className="text-zinc-300">{play.pausedDuration ? formatDuration(play.pausedDuration) : "—"}</p>
          </div>
          <div>
            <span className="text-zinc-500">Started</span>
            <p className="text-zinc-300">{formatTimestamp(play.startedAt)}</p>
          </div>
          <div>
            <span className="text-zinc-500">Stopped</span>
            <p className="text-zinc-300">{formatTimestamp(play.stoppedAt)}</p>
          </div>
          <div>
            <span className="text-zinc-500">Total Duration</span>
            <p className="text-zinc-300">{formatDuration(play.duration)}</p>
          </div>
          <div>
            <span className="text-zinc-500">Actual Watch Time</span>
            <p className="text-zinc-300">{formatDuration(play.playDuration)}</p>
          </div>
        </div>
      </td>
    </tr>
  );
}

export function ActivityRecentPlays({
  plays: initialPlays,
  source,
  mediaType,
  days,
}: {
  plays: RecentPlay[];
  source?: string;
  mediaType?: string;
  days?: number;
}) {
  const [plays, setPlays] = useState<RecentPlay[]>(initialPlays);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(initialPlays.length >= 20);
  const [page, setPage] = useState(1);
  const mounted = useHasMounted();

  const loadMore = async () => {
    setLoading(true);
    try {
      const nextPage = page + 1;
      const filterParams = new URLSearchParams();
      filterParams.set("page", String(nextPage));
      filterParams.set("limit", "20");
      if (source) filterParams.set("source", source);
      if (mediaType) filterParams.set("mediaType", mediaType);
      if (days) {
        const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        filterParams.set("startDate", startDate);
      }
      const res = await fetch(`/api/play-history?${filterParams.toString()}`);
      if (!res.ok) return;
      const data = await res.json();
      const items: RecentPlay[] = data.items.map((p: Record<string, unknown>) => ({
        id: p.id,
        source: p.source,
        title: p.title,
        tmdbId: p.tmdbId,
        mediaType: p.mediaType,
        startedAt: p.startedAt,
        stoppedAt: p.stoppedAt,
        duration: p.duration,
        playDuration: p.playDuration,
        pausedDuration: p.pausedDuration,
        watched: p.watched,
        platform: p.platform,
        player: p.player,
        device: p.device,
        ipAddress: p.ipAddress,
        playMethod: p.playMethod,
        resolution: p.resolution,
        videoCodec: p.videoCodec,
        audioCodec: p.audioCodec,
        bitrate: p.bitrate,
        container: p.container,
        videoDecision: p.videoDecision,
        audioDecision: p.audioDecision,
        seasonNumber: p.seasonNumber,
        episodeNumber: p.episodeNumber,
        episodeTitle: p.episodeTitle,
        mediaServerUserId: p.mediaServerUserId,
        username: (p.mediaServerUser as Record<string, unknown>)?.username ?? "Unknown",
        userSource: (p.mediaServerUser as Record<string, unknown>)?.source ?? "",
        userThumb: (p.mediaServerUser as Record<string, unknown>)?.thumbUrl ?? null,
      }));
      setPlays((prev) => [...prev, ...items]);
      setPage(nextPage);
      setHasMore(items.length >= 20);
    } finally {
      setLoading(false);
    }
  };

  if (plays.length === 0) {
    return (
      <Card className="bg-zinc-900 border-zinc-800 p-5 mb-8">
        <h2 className="font-semibold text-white mb-4">Recent Plays</h2>
        <p className="text-zinc-500 text-sm">No play history recorded yet</p>
      </Card>
    );
  }

  return (
    <Card className="bg-zinc-900 border-zinc-800 p-5 mb-8">
      <h2 className="font-semibold text-white mb-4">Recent Plays</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-zinc-500 uppercase tracking-wider border-b border-zinc-800">
              <th className="text-left py-2 pr-2 w-6"></th>
              <th className="text-left py-2 pr-4">Media</th>
              <th className="text-left py-2 pr-4">User</th>
              <th className="text-left py-2 pr-4">Source</th>
              <th className="text-left py-2 pr-4">Quality</th>
              <th className="text-right py-2 pr-4">Duration</th>
              <th className="text-right py-2">When</th>
            </tr>
          </thead>
          <tbody>
            {plays.map((p) => {
              const isExpanded = expandedId === p.id;
              const qualityParts: string[] = [];
              if (p.resolution) qualityParts.push(p.resolution);
              if (p.videoCodec) qualityParts.push(p.videoCodec.toUpperCase());
              const qualityStr = qualityParts.length > 0 ? qualityParts.join(" · ") : null;

              return (
                <Fragment key={p.id}>
                  <tr
                    className="border-b border-zinc-800/50 hover:bg-zinc-800/30 cursor-pointer"
                    onClick={() => setExpandedId(isExpanded ? null : p.id)}
                  >
                    <td className="py-2.5 pr-2 text-zinc-500">
                      {isExpanded ? (
                        <ChevronDown className="w-3.5 h-3.5" />
                      ) : (
                        <ChevronRight className="w-3.5 h-3.5" />
                      )}
                    </td>
                    <td className="py-2.5 pr-4">
                      <div className="flex items-center gap-2">
                        {p.mediaType === "TV" ? (
                          <Tv2 className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                        ) : (
                          <Film className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                        )}
                        <MediaLink tmdbId={p.tmdbId} mediaType={p.mediaType} title={p.title} />
                        {p.mediaType === "TV" && p.seasonNumber != null && (
                          <span className="text-zinc-500 text-xs shrink-0">
                            S{String(p.seasonNumber).padStart(2, "0")}
                            E{String(p.episodeNumber ?? 0).padStart(2, "0")}
                          </span>
                        )}
                        {p.watched && (
                          <span className="text-[10px] bg-green-600/20 text-green-400 px-1.5 py-0.5 rounded shrink-0">
                            watched
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-2.5 pr-4">
                      <Link
                        href={`/admin/activity/user/${p.mediaServerUserId}`}
                        className="text-zinc-300 hover:text-indigo-400 transition-colors"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {p.username}
                      </Link>
                    </td>
                    <td className="py-2.5 pr-4">
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                          p.source === "plex"
                            ? "bg-amber-500/15 text-amber-400"
                            : "bg-purple-500/15 text-purple-400"
                        }`}
                      >
                        {p.source === "plex" ? "Plex" : "Jellyfin"}
                      </span>
                    </td>
                    <td className="py-2.5 pr-4">
                      <div className="flex items-center gap-2">
                        <StreamBadge method={p.playMethod} />
                        {qualityStr && (
                          <span className="text-zinc-600 text-xs">{qualityStr}</span>
                        )}
                      </div>
                    </td>
                    <td className="py-2.5 pr-4 text-right text-zinc-400 tabular-nums">
                      {formatDuration(p.playDuration)}
                    </td>
                    <td className="py-2.5 text-right text-zinc-500">
                      {mounted ? formatRelativeTime(p.startedAt) : ""}
                    </td>
                  </tr>
                  {isExpanded && <DetailRow play={p} />}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {hasMore && (
        <div className="flex justify-center mt-4">
          <button
            onClick={loadMore}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 text-sm text-zinc-400 hover:text-white bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors disabled:opacity-50"
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Loading...
              </>
            ) : (
              "Load More"
            )}
          </button>
        </div>
      )}
    </Card>
  );
}
