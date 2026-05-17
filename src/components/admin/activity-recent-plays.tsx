"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { useHasMounted } from "@/hooks/use-has-mounted";
import {
  ActivityCard,
  Avatar,
  MethodPill,
  ProgressTrack,
  methodLabel,
  sourceDotColor,
} from "@/components/admin/activity-ui";

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

const TH: React.CSSProperties = {
  textAlign: "left",
  padding: "9px 14px",
  fontSize: 9.5,
  fontWeight: 500,
  color: "var(--ds-fg-disabled)",
  letterSpacing: "0.08em",
  borderBottom: "1px solid var(--ds-border)",
  whiteSpace: "nowrap",
};
const TD: React.CSSProperties = {
  padding: "10px 14px",
  color: "var(--ds-fg-muted)",
  verticalAlign: "middle",
};

function DetailRow({ play }: { play: RecentPlay }) {
  const cells: [string, string][] = [
    ["Device", play.device ?? "—"],
    ["IP Address", play.ipAddress ?? "—"],
    ["Container", play.container?.toUpperCase() ?? "—"],
    ["Bitrate", formatBitrate(play.bitrate)],
    ["Video Decision", play.videoDecision ?? "—"],
    ["Audio Decision", play.audioDecision ?? "—"],
    ["Audio Codec", play.audioCodec?.toUpperCase() ?? "—"],
    [
      "Paused",
      play.pausedDuration ? formatDuration(play.pausedDuration) : "—",
    ],
    ["Started", formatTimestamp(play.startedAt)],
    ["Stopped", formatTimestamp(play.stoppedAt)],
    ["Total Duration", formatDuration(play.duration)],
    ["Actual Watch Time", formatDuration(play.playDuration)],
  ];
  return (
    <tr style={{ background: "var(--ds-bg-1)" }}>
      <td colSpan={8} style={{ padding: "14px 18px" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
            gap: "10px 24px",
          }}
        >
          {cells.map(([k, v]) => (
            <div key={k}>
              <span
                className="ds-mono uppercase"
                style={{
                  fontSize: 9,
                  color: "var(--ds-fg-disabled)",
                  letterSpacing: "0.08em",
                }}
              >
                {k}
              </span>
              <p
                style={{
                  margin: "2px 0 0",
                  fontSize: 12,
                  color: "var(--ds-fg-muted)",
                }}
              >
                {v}
              </p>
            </div>
          ))}
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
        const startDate = new Date(
          Date.now() - days * 24 * 60 * 60 * 1000,
        ).toISOString();
        filterParams.set("startDate", startDate);
      }
      const res = await fetch(`/api/play-history?${filterParams.toString()}`);
      if (!res.ok) return;
      const data = await res.json();
      const items: RecentPlay[] = data.items.map(
        (p: Record<string, unknown>) => ({
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
          username:
            (p.mediaServerUser as Record<string, unknown>)?.username ??
            "Unknown",
          userSource:
            (p.mediaServerUser as Record<string, unknown>)?.source ?? "",
          userThumb:
            (p.mediaServerUser as Record<string, unknown>)?.thumbUrl ?? null,
        }),
      );
      setPlays((prev) => [...prev, ...items]);
      setPage(nextPage);
      setHasMore(items.length >= 20);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section style={{ marginBottom: 22 }}>
      <ActivityCard style={{ padding: 0, overflow: "hidden" }}>
        <div
          style={{
            padding: "16px 18px 12px",
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            borderBottom: "1px solid var(--ds-border)",
            gap: 12,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 12,
              minWidth: 0,
            }}
          >
            <h2
              style={{
                margin: 0,
                fontSize: 13,
                fontWeight: 600,
                letterSpacing: "-0.01em",
                color: "var(--ds-fg)",
                whiteSpace: "nowrap",
              }}
            >
              Recent plays
            </h2>
            <span
              className="ds-mono"
              style={{
                fontSize: 11,
                color: "var(--ds-fg-subtle)",
                whiteSpace: "nowrap",
              }}
            >
              last {plays.length} sessions
            </span>
          </div>
          <Link
            href="/admin/activity?tab=history"
            className="ds-mono"
            style={{
              fontSize: 11,
              color: "var(--ds-fg-muted)",
              textDecoration: "none",
              whiteSpace: "nowrap",
            }}
          >
            View history →
          </Link>
        </div>

        {plays.length === 0 ? (
          <p
            style={{
              padding: "28px 18px",
              margin: 0,
              color: "var(--ds-fg-subtle)",
              fontSize: 13,
              textAlign: "center",
            }}
          >
            No play history recorded yet
          </p>
        ) : (
          <div className="resp-table-scroll">
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 12.5,
              }}
            >
              <thead>
                <tr style={{ background: "var(--ds-bg-1)" }}>
                  <th
                    className="ds-mono uppercase"
                    style={{ ...TH, width: 26 }}
                  />
                  {["User", "Title", "Started", "Duration", "Stream", "Quality", ""].map(
                    (h, i) => (
                      <th
                        key={i}
                        className="ds-mono uppercase"
                        style={{
                          ...TH,
                          textAlign: h === "" ? "right" : "left",
                        }}
                      >
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {plays.map((p, i) => {
                  const isExpanded = expandedId === p.id;
                  const m = methodLabel(
                    p.playMethod,
                    p.videoDecision,
                    p.audioDecision,
                  );
                  const pct =
                    p.duration > 0
                      ? Math.min(
                          100,
                          Math.round((p.playDuration / p.duration) * 100),
                        )
                      : p.watched
                        ? 100
                        : 0;
                  const isTV = p.mediaType === "TV";
                  const mediaHref =
                    p.tmdbId && p.mediaType
                      ? `/admin/activity/media/${p.tmdbId}`
                      : null;
                  const sub = isTV
                    ? [
                        p.seasonNumber != null
                          ? `S${String(p.seasonNumber).padStart(2, "0")}`
                          : null,
                        p.episodeNumber != null
                          ? `E${String(p.episodeNumber).padStart(2, "0")}`
                          : null,
                        p.episodeTitle,
                      ]
                        .filter(Boolean)
                        .join(" · ")
                    : "Movie";
                  return (
                    <Fragment key={p.id}>
                      <tr
                        className="recent-row"
                        onClick={() =>
                          setExpandedId(isExpanded ? null : p.id)
                        }
                        style={{
                          borderBottom:
                            i < plays.length - 1
                              ? "1px solid var(--ds-border)"
                              : "none",
                          cursor: "pointer",
                        }}
                      >
                        <td style={{ ...TD, color: "var(--ds-fg-disabled)" }}>
                          {isExpanded ? (
                            <ChevronDown style={{ width: 14, height: 14 }} />
                          ) : (
                            <ChevronRight style={{ width: 14, height: 14 }} />
                          )}
                        </td>
                        <td style={TD}>
                          <Link
                            href={`/admin/activity/user/${p.mediaServerUserId}`}
                            onClick={(e) => e.stopPropagation()}
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 8,
                              color: "var(--ds-fg)",
                              textDecoration: "none",
                            }}
                          >
                            <Avatar
                              letter={(p.username[0] ?? "?").toUpperCase()}
                              size={20}
                            />
                            <span>{p.username}</span>
                            <span
                              style={{
                                width: 4,
                                height: 4,
                                borderRadius: 999,
                                background: sourceDotColor(p.source),
                              }}
                            />
                          </Link>
                        </td>
                        <td style={{ ...TD, maxWidth: 320 }}>
                          <div
                            style={{
                              color: "var(--ds-fg)",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {mediaHref ? (
                              <Link
                                href={mediaHref}
                                onClick={(e) => e.stopPropagation()}
                                style={{
                                  color: "inherit",
                                  textDecoration: "none",
                                }}
                              >
                                {p.title}
                              </Link>
                            ) : (
                              p.title
                            )}
                          </div>
                          <div
                            className="ds-mono"
                            style={{
                              fontSize: 10.5,
                              color: "var(--ds-fg-disabled)",
                              marginTop: 1,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {sub}
                          </div>
                        </td>
                        <td
                          className="ds-mono"
                          style={{
                            ...TD,
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {mounted ? formatRelativeTime(p.startedAt) : ""}
                        </td>
                        <td
                          className="ds-mono"
                          style={{
                            ...TD,
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {formatDuration(p.playDuration)}
                        </td>
                        <td style={TD}>
                          <MethodPill method={m.label} methodClass={m.cls} />
                        </td>
                        <td className="ds-mono" style={TD}>
                          {[p.resolution, p.videoCodec?.toUpperCase()]
                            .filter(Boolean)
                            .join(" · ") || "—"}
                        </td>
                        <td
                          style={{
                            ...TD,
                            textAlign: "right",
                            width: 140,
                          }}
                        >
                          <div
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 6,
                            }}
                          >
                            <div style={{ width: 60 }}>
                              <ProgressTrack
                                pct={pct / 100}
                                height={3}
                                color={
                                  p.watched
                                    ? "var(--ds-success)"
                                    : "var(--ds-accent)"
                                }
                              />
                            </div>
                            <span
                              className="ds-mono"
                              style={{
                                fontSize: 10.5,
                                color: p.watched
                                  ? "var(--ds-success)"
                                  : "var(--ds-fg-subtle)",
                                width: 32,
                                textAlign: "right",
                                fontVariantNumeric: "tabular-nums",
                              }}
                            >
                              {pct}%
                            </span>
                          </div>
                        </td>
                      </tr>
                      {isExpanded && <DetailRow play={p} />}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {hasMore && (
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              padding: "14px 0 18px",
            }}
          >
            <button
              onClick={loadMore}
              disabled={loading}
              className="ds-mono"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                fontSize: 11.5,
                padding: "6px 14px",
                borderRadius: 6,
                background: "var(--ds-bg-3)",
                border: "1px solid var(--ds-border)",
                color: "var(--ds-fg-muted)",
                cursor: loading ? "default" : "pointer",
                opacity: loading ? 0.5 : 1,
              }}
            >
              {loading ? (
                <>
                  <Loader2
                    style={{ width: 14, height: 14 }}
                    className="animate-spin"
                  />
                  Loading…
                </>
              ) : (
                "Load more"
              )}
            </button>
          </div>
        )}
      </ActivityCard>
    </section>
  );
}
