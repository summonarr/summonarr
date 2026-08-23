"use client";

import { Fragment, useEffect, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, Loader2 } from "@/components/icons";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { formatRelativeTime } from "@/lib/relative-time";
import { bitrateToKbps } from "@/lib/bitrate";
import {
  ActivityCard,
  Avatar,
  MethodPill,
  ProgressTrack,
  methodLabel,
  sourceDotColor,
} from "@/components/admin/activity-ui";
import { IpInfo } from "@/components/admin/ip-info";
import { withBasePath } from "@/lib/base-path";

export interface RecentPlay {
  id: string;
  source: string;
  // Media-server instance slug (media-instances.ts). "" = the default/only
  // server, and also what every row written before multi-server support reads
  // (`@default("")`) — so the badge below renders only when non-empty.
  serverInstance: string;
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

// `source` is required: Plex reports kbps, Jellyfin bps, and the row is the
// only thing that can tell them apart (lib/bitrate.ts).
function formatBitrate(raw: number | null, source: string | null): string {
  const kbps = bitrateToKbps(raw, source);
  if (kbps <= 0) return "—";
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`;
  return `${Math.round(kbps)} kbps`;
}

// Unpinned locale/timezone (via "en-US" + no timeZone) is only safe because
// the sole caller (below, inside DetailRow) never renders during SSR/first
// paint — DetailRow is gated behind `isExpanded`, false until a post-hydration
// click (guardrail 16). Don't call this from an ungated render path.
function formatTimestamp(dateStr: string | null): string {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleString("en-US");
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
  const cells: [string, React.ReactNode][] = [
    ["Device", play.device ?? "—"],
    [
      "IP Address",
      play.ipAddress ? <IpInfo ip={play.ipAddress} inline /> : "—",
    ],
    ["Container", play.container?.toUpperCase() ?? "—"],
    ["Bitrate", formatBitrate(play.bitrate, play.source)],
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
              <div
                style={{
                  margin: "2px 0 0",
                  fontSize: 12,
                  color: "var(--ds-fg-muted)",
                }}
              >
                {v}
              </div>
            </div>
          ))}
        </div>
      </td>
    </tr>
  );
}

// Recent-plays table with expandable per-session detail rows and cursor-style
// "Load more" pagination against /api/play-history.
export function ActivityRecentPlays({
  plays: initialPlays,
  source,
  mediaType,
  startDateIso,
}: {
  plays: RecentPlay[];
  source?: string;
  mediaType?: string;
  // Period lower bound, computed once on the server so paginated client
  // fetches stay consistent with the server-rendered first page (guardrail 16).
  startDateIso?: string;
}) {
  const [plays, setPlays] = useState<RecentPlay[]>(initialPlays);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(initialPlays.length >= 20);
  const [page, setPage] = useState(1);
  const mounted = useHasMounted();

  // ActivityLiveRefresher calls router.refresh() on every activity:history-updated
  // SSE event so this table reflects a finished stream. But router.refresh()
  // re-renders the SERVER tree without unmounting client components, and this
  // component's key only changes on a filter change — so `plays` stayed frozen at
  // whatever loaded on first mount while the cards and leaderboards around it
  // updated. Re-seed from the incoming prop. Same pattern as browse-grid.tsx and
  // audit-log-table.tsx.
  useEffect(() => {
    // Only re-seed while the user is still on page 1. A live SSE refresh fires
    // router.refresh() on every finished play, and re-seeding unconditionally
    // threw away every page loaded via "Load more" — on a busy server the list
    // snapped back to 20 rows mid-read, repeatedly, which made the button
    // effectively unusable. Past page 1 the newest rows arrive on the next
    // explicit load instead.
    if (page !== 1) return;
    setPlays(initialPlays);
    setHasMore(initialPlays.length >= 20);
  }, [initialPlays, page]);

  const loadMore = async () => {
    setLoading(true);
    try {
      const nextPage = page + 1;
      const filterParams = new URLSearchParams();
      filterParams.set("page", String(nextPage));
      filterParams.set("limit", "20");
      if (source) filterParams.set("source", source);
      if (mediaType) filterParams.set("mediaType", mediaType);
      if (startDateIso) filterParams.set("startDate", startDateIso);
      const res = await fetch(withBasePath(`/api/play-history?${filterParams.toString()}`));
      if (!res.ok) return;
      type PlayHistoryApiItem = Omit<RecentPlay, "username" | "userSource" | "userThumb"> & {
        mediaServerUser?: { username?: string | null; source?: string | null; thumbUrl?: string | null } | null;
      };
      const data = (await res.json()) as { items: PlayHistoryApiItem[] };
      const items: RecentPlay[] = data.items.map((p) => ({
        id: p.id,
        source: p.source,
        serverInstance: p.serverInstance,
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
        username: p.mediaServerUser?.username ?? "Unknown",
        userSource: p.mediaServerUser?.source ?? "",
        userThumb: p.mediaServerUser?.thumbUrl ?? null,
      }));
      // De-dup by id. Pagination is OFFSET-based over a newest-first list, so a
      // play finishing between page 1 and page 2 shifts every row down one and
      // the next page repeats the row that straddled the boundary. That gives
      // React duplicate keys, and — independently of keys — `expandedId === p.id`
      // matches both copies, so clicking one expands both. The two sibling
      // load-more lists (watch-history-list, notification-list) already do this.
      setPlays((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        return [...prev, ...items.filter((p) => !seen.has(p.id))];
      });
      setPage(nextPage);
      setHasMore(items.length >= 20);
    } catch (err) {
      // Without this, a network failure rejected loadMore's promise as an
      // unhandled rejection (it's wired straight to onClick with no await).
      console.error("[activity-recent-plays] load more failed:", err);
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
                    scope="col"
                    className="ds-mono uppercase"
                    style={{ ...TH, width: 26 }}
                  />
                  {["User", "Title", "Started", "Duration", "Stream", "Quality", ""].map(
                    (h, i) => (
                      <th
                        key={i}
                        scope="col"
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
                      ? `/admin/activity/media/${p.tmdbId}?type=${p.mediaType}`
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
                        tabIndex={0}
                        aria-expanded={isExpanded}
                        onClick={() =>
                          setExpandedId(isExpanded ? null : p.id)
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setExpandedId(isExpanded ? null : p.id);
                          }
                        }}
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
                            {/* Instance slug for a named server. Rendered only
                                when non-empty — "" is both the default server
                                and every pre-multi-server row, which must stay
                                unlabelled. Colour keyed off `source` (same as
                                the dot), never off the slug. */}
                            {p.serverInstance && (
                              <span
                                className="ds-mono"
                                title={`Played on the "${p.serverInstance}" ${p.source} server`}
                                style={{
                                  fontSize: 9.5,
                                  padding: "1px 5px",
                                  borderRadius: 999,
                                  background: "oklch(1 0 0 / 0.06)",
                                  color: sourceDotColor(p.source),
                                  letterSpacing: "0.04em",
                                  flexShrink: 0,
                                }}
                              >
                                {p.serverInstance}
                              </span>
                            )}
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
