"use client";

// Per-title activity screen, drawn from getMediaPlayStats(). "2h ago" style
// labels only appear after the page has mounted in the browser (useHasMounted),
// so the server and the first browser render match (guardrail 16).

import Link from "next/link";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { formatRelativeTime } from "@/lib/relative-time";
import {
  ActivityCard,
  AreaChart,
  Avatar,
  DetailHeader,
  HeaderStat,
  HorizontalBars,
  MethodPill,
  Poster,
  SectionHeader,
  StreamTypeBars,
  Th,
  fmtDuration,
  methodLabel,
} from "@/components/admin/activity-ui";

export interface TitleDetailData {
  tmdbId: number;
  title: string;
  posterSrc: string | null;
  mediaType: string | null;
  year: string | null;
  totalPlays: number;
  uniqueViewers: number;
  avgCompletion: number;
  // Both derived from the ≤50-row recent-plays sample (any watched status),
  // NOT from the all-time watched-only `totalPlays` — the two populations
  // differ, so never pair them in one label.
  watchedCount: number;
  recentSampleSize: number;
  libraryHref: string;
  topViewers: {
    id: string;
    username: string;
    source: string;
    count: number;
    hours: number;
  }[];
  transcodeRatio: { method: string; count: number }[];
  resolutionBreakdown: { resolution: string; count: number }[];
  platforms: { label: string; count: number }[];
  completionHist: { label: string; count: number }[];
  playsByDay: { day: string; count: number }[];
  recentPlays: {
    id: string;
    username: string;
    userSource: string;
    mediaServerUserId: string;
    seasonNumber: number | null;
    episodeNumber: number | null;
    resolution: string | null;
    videoCodec: string | null;
    platform: string | null;
    playMethod: string | null;
    videoDecision: string | null;
    audioDecision: string | null;
    playDuration: number;
    startedAtIso: string;
  }[];
}

const STREAM_META: Record<string, { label: string; color: string }> = {
  DirectPlay: { label: "Direct Play", color: "var(--ds-success)" },
  DirectStream: { label: "Remux", color: "var(--ds-info)" },
  Transcode: { label: "Transcode", color: "var(--ds-warning)" },
};

function absTime(iso: string): string {
  // Format in UTC so the server (its own time zone) and the browser (the
  // viewer's time zone) print the same date. Otherwise a play near midnight
  // could show different days and cause a React #418 hydration error. This is
  // the text shown before mount, and for the chart's day labels.
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function TitleDetailView({ data: s }: { data: TitleDetailData }) {
  const mounted = useHasMounted();
  const when = (iso: string) => (mounted ? formatRelativeTime(iso) : absTime(iso));
  const accent = "oklch(0.36 0.08 60)";
  const isTV = s.mediaType === "TV";

  const streamTypes = ["DirectPlay", "DirectStream", "Transcode"].map((m) => ({
    label: STREAM_META[m].label,
    count: s.transcodeRatio.find((r) => r.method === m)?.count ?? 0,
    color: STREAM_META[m].color,
  }));
  const playsByDay = s.playsByDay.map((d) => d.count);
  const maxViewer = s.topViewers[0]?.count ?? 1;

  return (
    <div className="ds-page-enter">
      <DetailHeader
        back={{ href: "/admin/activity", label: "Back to activity" }}
        leading={
          <Poster
            src={s.posterSrc}
            letter={(s.title[0] ?? "?").toUpperCase()}
            accent={accent}
            w={56}
            h={84}
            radius={5}
          />
        }
        title={s.title}
        meta={
          <span
            className="ds-mono uppercase"
            style={{
              fontSize: 10,
              letterSpacing: "0.14em",
              color: "var(--ds-fg-subtle)",
              whiteSpace: "nowrap",
            }}
          >
            {isTV ? "Television series" : "Feature film"}
          </span>
        }
        subtitle={`${s.year ? `${s.year} · ` : ""}TMDB ${s.tmdbId} · playback activity across ${s.uniqueViewers} viewers`}
        right={
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "auto auto auto",
              gap: 24,
            }}
          >
            <HeaderStat label="Plays" value={s.totalPlays.toLocaleString("en-US")} />
            <HeaderStat
              label="Viewers"
              value={s.uniqueViewers.toLocaleString("en-US")}
            />
            <HeaderStat
              label="Completion"
              value={`${s.avgCompletion}%`}
              tone={
                s.avgCompletion >= 75
                  ? "ok"
                  : s.avgCompletion >= 50
                    ? "info"
                    : "warn"
              }
            />
          </div>
        }
      >
        <Link
          href={s.libraryHref}
          className="ds-hover-tint"
          style={{
            fontSize: 12,
            padding: "6px 11px",
            borderRadius: 6,
            background: "var(--ds-bg-3)",
            border: "1px solid var(--ds-border)",
            color: "var(--ds-fg)",
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            whiteSpace: "nowrap",
            textDecoration: "none",
          }}
        >
          Open in library
          <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden>
            <path
              d="M4 3h5v5M9 3l-6 6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </Link>
      </DetailHeader>

      <div style={{ marginBottom: 22 }}>
        <ActivityCard>
          <SectionHeader
            label="Plays per day · 90d"
            sub={`${s.watchedCount} of last ${s.recentSampleSize} plays watched fully · recent sample`}
          />
          <AreaChart
            data={playsByDay}
            h={130}
            labels={s.playsByDay.map((d) => absTime(`${d.day}T00:00:00Z`))}
            valueSuffix=" plays"
          />
        </ActivityCard>
      </div>

      <div
        className="resp-grid-3"
        style={{
          display: "grid",
          gridTemplateColumns: "1.4fr 1fr 1fr",
          gap: 10,
          marginBottom: 22,
        }}
      >
        <ActivityCard>
          <SectionHeader
            label="Who watched"
            sub={`${s.topViewers.length} viewers`}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {s.topViewers.map((v, i) => (
              <div
                key={v.id}
                style={{ display: "flex", alignItems: "center", gap: 10 }}
              >
                <span
                  className="ds-mono"
                  style={{
                    width: 16,
                    textAlign: "right",
                    fontSize: 10.5,
                    color: "var(--ds-fg-subtle)",
                  }}
                >
                  {(i + 1).toString().padStart(2, "0")}
                </span>
                <Avatar
                  letter={(v.username[0] ?? "?").toUpperCase()}
                  size={22}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "baseline",
                      marginBottom: 3,
                      gap: 8,
                    }}
                  >
                    <Link
                      href={`/admin/activity/user/${v.id}`}
                      style={{
                        fontSize: 12.5,
                        color: "var(--ds-fg)",
                        textDecoration: "none",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {v.username}
                      <span
                        style={{
                          width: 5,
                          height: 5,
                          borderRadius: 999,
                          background:
                            v.source === "plex"
                              ? "var(--ds-plex)"
                              : "var(--ds-jellyfin)",
                        }}
                      />
                    </Link>
                    <span
                      className="ds-mono"
                      style={{
                        fontSize: 11,
                        color: "var(--ds-fg-muted)",
                        fontVariantNumeric: "tabular-nums",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {v.count}{" "}
                      <span style={{ color: "var(--ds-fg-subtle)" }}>
                        · {v.hours.toFixed(1)}h
                      </span>
                    </span>
                  </div>
                  <div
                    style={{
                      height: 4,
                      background: "color-mix(in oklab, var(--ds-fg) 5%, transparent)",
                      borderRadius: 999,
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        width: `${(v.count / maxViewer) * 100}%`,
                        height: "100%",
                        background: "var(--ds-accent)",
                        borderRadius: 999,
                      }}
                    />
                  </div>
                </div>
              </div>
            ))}
            {s.topViewers.length === 0 && (
              <div
                style={{
                  fontSize: 12,
                  color: "var(--ds-fg-subtle)",
                  padding: "20px 0",
                  textAlign: "center",
                }}
              >
                No viewers yet
              </div>
            )}
          </div>
        </ActivityCard>
        <ActivityCard>
          <SectionHeader
            label="Completion"
            sub="recent sample"
          />
          <HorizontalBars
            items={s.completionHist}
            color="var(--ds-success)"
            labelWidth={70}
          />
        </ActivityCard>
        <ActivityCard>
          <SectionHeader label="Stream type" sub="play method mix" />
          <StreamTypeBars data={streamTypes} />
        </ActivityCard>
      </div>

      <div
        className="resp-grid-2"
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 10,
          marginBottom: 22,
        }}
      >
        <ActivityCard>
          <SectionHeader label="Resolutions" />
          <HorizontalBars
            items={s.resolutionBreakdown.map((r) => ({
              label: r.resolution,
              count: r.count,
            }))}
            color="oklch(0.68 0.16 158)"
            labelWidth={70}
          />
        </ActivityCard>
        <ActivityCard>
          <SectionHeader
            label="Platforms"
            sub={`${s.platforms.length} unique`}
          />
          <HorizontalBars
            items={s.platforms.slice(0, 6)}
            color="oklch(0.62 0.14 295)"
            labelWidth={110}
          />
        </ActivityCard>
      </div>

      <div style={{ marginBottom: 22 }}>
        <ActivityCard style={{ padding: 0, overflow: "hidden" }}>
          <div
            style={{
              padding: "16px 18px 12px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              borderBottom: "1px solid var(--ds-border)",
            }}
          >
            <div
              style={{ display: "flex", alignItems: "baseline", gap: 12 }}
            >
              <h2
                style={{
                  margin: 0,
                  fontSize: 13,
                  fontWeight: 600,
                  letterSpacing: "-0.01em",
                  color: "var(--ds-fg)",
                }}
              >
                Play history
              </h2>
              <span
                className="ds-mono"
                style={{ fontSize: 11, color: "var(--ds-fg-subtle)" }}
              >
                latest {s.recentPlays.length} sessions
              </span>
            </div>
          </div>
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
                  <Th label="User" />
                  {isTV && <Th label="Episode" />}
                  <Th label="Quality" />
                  <Th label="Platform" />
                  <Th label="Stream" />
                  <Th label="Duration" align="right" />
                  <Th label="When" align="right" />
                </tr>
              </thead>
              <tbody>
                {s.recentPlays.map((p, i) => {
                  const ml = methodLabel(
                    p.playMethod,
                    p.videoDecision,
                    p.audioDecision,
                  );
                  return (
                    <tr
                      key={p.id}
                      className="recent-row"
                      style={{
                        borderBottom:
                          i < s.recentPlays.length - 1
                            ? "1px solid var(--ds-border)"
                            : "none",
                      }}
                    >
                      <td
                        style={{ padding: "10px 14px", whiteSpace: "nowrap" }}
                      >
                        <Link
                          href={`/admin/activity/user/${p.mediaServerUserId}`}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 8,
                            textDecoration: "none",
                            color: "inherit",
                          }}
                        >
                          <Avatar
                            letter={(p.username[0] ?? "?").toUpperCase()}
                            size={20}
                          />
                          <span style={{ color: "var(--ds-fg)" }}>
                            {p.username}
                          </span>
                          <span
                            style={{
                              width: 4,
                              height: 4,
                              borderRadius: 999,
                              background:
                                p.userSource === "plex"
                                  ? "var(--ds-plex)"
                                  : "var(--ds-jellyfin)",
                            }}
                          />
                        </Link>
                      </td>
                      {isTV && (
                        <td
                          className="ds-mono"
                          style={{
                            padding: "10px 14px",
                            color: "var(--ds-fg-muted)",
                            fontSize: 11,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {p.seasonNumber != null
                            ? `S${String(p.seasonNumber).padStart(2, "0")} · E${String(p.episodeNumber ?? 0).padStart(2, "0")}`
                            : "—"}
                        </td>
                      )}
                      <td
                        className="ds-mono"
                        style={{
                          padding: "10px 14px",
                          color: "var(--ds-fg-muted)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {p.resolution ?? "—"}
                        {p.videoCodec && (
                          <span style={{ color: "var(--ds-fg-subtle)" }}>
                            {" "}
                            · {p.videoCodec}
                          </span>
                        )}
                      </td>
                      <td
                        style={{
                          padding: "10px 14px",
                          color: "var(--ds-fg-muted)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {p.platform ?? "—"}
                      </td>
                      <td
                        style={{ padding: "10px 14px", whiteSpace: "nowrap" }}
                      >
                        <MethodPill method={ml.label} methodClass={ml.cls} />
                      </td>
                      <td
                        className="ds-mono"
                        style={{
                          padding: "10px 14px",
                          color: "var(--ds-fg-muted)",
                          textAlign: "right",
                          fontVariantNumeric: "tabular-nums",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {fmtDuration(p.playDuration)}
                      </td>
                      <td
                        className="ds-mono"
                        style={{
                          padding: "10px 14px",
                          color: "var(--ds-fg-subtle)",
                          textAlign: "right",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {when(p.startedAtIso)}
                      </td>
                    </tr>
                  );
                })}
                {s.recentPlays.length === 0 && (
                  <tr>
                    <td
                      colSpan={isTV ? 7 : 6}
                      style={{
                        padding: "40px 20px",
                        textAlign: "center",
                        color: "var(--ds-fg-subtle)",
                      }}
                    >
                      No plays recorded
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </ActivityCard>
      </div>
    </div>
  );
}
