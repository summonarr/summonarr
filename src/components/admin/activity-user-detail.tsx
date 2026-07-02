"use client";

// Refined per-user activity screen, ported from the Claude Design handoff
// (details.jsx → UserDetail), wired to getUserPlayStats(). Relative-time
// labels are gated behind useHasMounted (guardrail 16): server renders an
// absolute fallback, the client swaps in "Xd ago" after hydration.

import Link from "next/link";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { formatRelativeTime } from "@/lib/relative-time";
import { IpInfo } from "@/components/admin/ip-info";
import {
  ActivityCard,
  AreaChart,
  Avatar,
  HorizontalBars,
  HourHeatmap,
  Poster,
  SectionHeader,
  SourceTag,
  StreamTypeBars,
  MiniKpi,
  Th,
  fmtDuration,
} from "@/components/admin/activity-ui";
import { ActivityCalendar } from "@/components/admin/activity-calendar";

export interface UserDetailData {
  userId: string; // mediaServerUserId — scopes the heatmap drill-down popovers
  username: string;
  source: string;
  linkedLabel: string | null;
  email: string | null;
  totalPlays: number;
  totalWatchTimeHours: number;
  avgSessionDuration: number;
  directPct: number | null;
  lastActiveIso: string | null;
  activityCalendar: { day: string; count: number }[];
  todayIso: string;
  playsByDay: { day: string; count: number; hours: number }[];
  userHeatmap: { dow: number; hour: number; count: number }[];
  platformBreakdown: { platform: string; count: number }[];
  resolutionBreakdown: { resolution: string; count: number }[];
  deviceList: { device: string; count: number }[];
  transcodeRatio: { method: string; count: number }[];
  topMedia: {
    title: string;
    tmdbId: number | null;
    mediaType: string | null;
    count: number;
    posterSrc: string | null;
  }[];
  knownIps: { ip: string; plays: number; lastSeenIso: string | null }[];
  recentPlays: {
    id: string;
    title: string;
    tmdbId: number | null;
    mediaType: string | null;
    seasonNumber: number | null;
    episodeNumber: number | null;
    resolution: string | null;
    videoCodec: string | null;
    startedAtIso: string;
  }[];
}

const STREAM_META: Record<string, { label: string; color: string }> = {
  DirectPlay: { label: "Direct Play", color: "var(--ds-success)" },
  DirectStream: { label: "Remux", color: "var(--ds-info)" },
  Transcode: { label: "Transcode", color: "var(--ds-warning)" },
};

function absTime(iso: string): string {
  // Pin to UTC so SSR (container TZ) and CSR (browser TZ) produce identical
  // text — prevents the React #418 hydration mismatch for plays near UTC
  // midnight when the formatRelativeTime() path is gated behind useHasMounted.
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function UserDetailView({ data: s }: { data: UserDetailData }) {
  const mounted = useHasMounted();
  const when = (iso: string | null) =>
    !iso ? "—" : mounted ? formatRelativeTime(iso) : absTime(iso);

  // Postgres DOW 0=Sun..6=Sat → design heatmap rows are Mon-first.
  const heatmapMatrix: number[][] = Array.from({ length: 7 }, () =>
    new Array<number>(24).fill(0),
  );
  for (const c of s.userHeatmap) {
    if (c.dow >= 0 && c.dow < 7 && c.hour >= 0 && c.hour < 24) {
      heatmapMatrix[(c.dow + 6) % 7][c.hour] = c.count;
    }
  }

  const streamTypes = ["DirectPlay", "DirectStream", "Transcode"].map((m) => ({
    label: STREAM_META[m].label,
    count: s.transcodeRatio.find((r) => r.method === m)?.count ?? 0,
    color: STREAM_META[m].color,
  }));

  const playsByDay = s.playsByDay.map((d) => d.count);
  const maxTopMedia = s.topMedia[0]?.count ?? 1;

  return (
    <div className="ds-page-enter">
      <Link
        href="/admin/activity/users"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          marginBottom: 18,
          fontSize: 12.5,
          color: "var(--ds-fg-muted)",
          textDecoration: "none",
        }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path
            d="M7 3l-3 3 3 3"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        Back to users
      </Link>

      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          marginBottom: 22,
        }}
      >
        <Avatar
          letter={(s.username[0] ?? "?").toUpperCase()}
          accent="oklch(0.42 0.10 275)"
          size={56}
        />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 4,
            }}
          >
            <h1
              style={{
                margin: 0,
                fontSize: 26,
                fontWeight: 600,
                letterSpacing: "-0.025em",
                color: "var(--ds-fg)",
              }}
            >
              {s.username}
            </h1>
            <SourceTag source={s.source} />
          </div>
          <div
            className="ds-mono"
            style={{ fontSize: 12, color: "var(--ds-fg-subtle)" }}
          >
            {[s.email, s.linkedLabel].filter(Boolean).join(" · ") ||
              `${s.source} account`}
          </div>
        </div>
      </header>

      <div
        className="resp-grid-3"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(5, 1fr)",
          gap: 10,
          marginBottom: 22,
        }}
      >
        <MiniKpi
          label="Total plays"
          value={s.totalPlays.toLocaleString("en-US")}
          big
        />
        <MiniKpi
          label="Watch time"
          value={`${s.totalWatchTimeHours.toLocaleString("en-US")}h`}
          big
        />
        <MiniKpi label="Last active" value={when(s.lastActiveIso)} />
        <MiniKpi
          label="Avg session"
          value={fmtDuration(s.avgSessionDuration)}
        />
        <MiniKpi
          label="Direct play"
          value={s.directPct != null ? `${s.directPct}%` : "—"}
          big
        />
      </div>

      {s.activityCalendar.length > 0 && (
        <div style={{ marginBottom: 22 }}>
          <ActivityCard>
            <SectionHeader
              label="365-day activity"
              sub={`${s.activityCalendar.filter((v) => v.count > 0).length} active days`}
            />
            <ActivityCalendar
              data={s.activityCalendar}
              today={s.todayIso}
              detailBase={{ userId: s.userId }}
            />
          </ActivityCard>
        </div>
      )}

      <div
        className="resp-grid-2"
        style={{
          display: "grid",
          gridTemplateColumns: "1.2fr 1fr",
          gap: 10,
          marginBottom: 22,
        }}
      >
        <ActivityCard>
          <SectionHeader
            label="Plays per day · 90d"
            sub={`peak ${Math.max(...playsByDay, 0)} plays`}
          />
          <AreaChart
            data={playsByDay}
            h={130}
            labels={s.playsByDay.map((d) => absTime(`${d.day}T00:00:00`))}
            valueSuffix=" plays"
          />
        </ActivityCard>
        <ActivityCard>
          <SectionHeader label="Viewing heatmap" sub="day × hour" />
          <HourHeatmap matrix={heatmapMatrix} detailBase={{ userId: s.userId }} />
        </ActivityCard>
      </div>

      <div
        className="resp-grid-2"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, 1fr)",
          gap: 10,
          marginBottom: 22,
        }}
      >
        <ActivityCard>
          <SectionHeader
            label="Platforms"
            sub={`${s.platformBreakdown.length} unique`}
          />
          <HorizontalBars
            items={s.platformBreakdown
              .slice(0, 6)
              .map((p) => ({ label: p.platform, count: p.count }))}
          />
        </ActivityCard>
        <ActivityCard>
          <SectionHeader label="Stream type" sub="play method mix" />
          <StreamTypeBars data={streamTypes} />
        </ActivityCard>
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
            label="Devices"
            sub={`${s.deviceList.length} known`}
          />
          <HorizontalBars
            items={s.deviceList
              .slice(0, 6)
              .map((d) => ({ label: d.device, count: d.count }))}
            color="oklch(0.62 0.14 295)"
            labelWidth={100}
          />
        </ActivityCard>
      </div>

      {s.topMedia.length > 0 && (
        <div style={{ marginBottom: 22 }}>
          <ActivityCard>
            <SectionHeader
              label="Most watched"
              sub={`${s.topMedia.length} titles`}
            />
            <div
              style={{ display: "flex", flexDirection: "column", gap: 8 }}
            >
              {s.topMedia.map((m, i) => (
                <div
                  key={`${m.title}-${i}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                  }}
                >
                  <span
                    className="ds-mono"
                    style={{
                      width: 16,
                      textAlign: "right",
                      fontSize: 10.5,
                      color: "var(--ds-fg-disabled)",
                    }}
                  >
                    {(i + 1).toString().padStart(2, "0")}
                  </span>
                  <Poster
                    src={m.posterSrc}
                    letter={(m.title[0] ?? "?").toUpperCase()}
                    w={28}
                    h={40}
                    radius={3}
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
                      {m.tmdbId ? (
                        <Link
                          href={`/admin/activity/media/${m.tmdbId}${m.mediaType ? `?type=${m.mediaType}` : ""}`}
                          style={{
                            fontSize: 13,
                            color: "var(--ds-fg)",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 6,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            textDecoration: "none",
                            minWidth: 0,
                          }}
                        >
                          <span
                            style={{
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                          >
                            {m.title}
                          </span>
                          {m.mediaType && (
                            <span
                              className="ds-mono"
                              style={{
                                fontSize: 9,
                                color: "var(--ds-fg-disabled)",
                                letterSpacing: "0.06em",
                                flexShrink: 0,
                              }}
                            >
                              {m.mediaType}
                            </span>
                          )}
                        </Link>
                      ) : (
                        <span
                          style={{
                            fontSize: 13,
                            color: "var(--ds-fg)",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {m.title}
                        </span>
                      )}
                      <span
                        className="ds-mono"
                        style={{
                          fontSize: 11,
                          color: "var(--ds-fg-muted)",
                          fontVariantNumeric: "tabular-nums",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {m.count} plays
                      </span>
                    </div>
                    <div
                      style={{
                        height: 4,
                        background: "oklch(1 0 0 / 0.05)",
                        borderRadius: 999,
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          width: `${(m.count / maxTopMedia) * 100}%`,
                          height: "100%",
                          background: "var(--ds-accent)",
                          borderRadius: 999,
                        }}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </ActivityCard>
        </div>
      )}

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
          <SectionHeader
            label="Known IP addresses"
            sub={`${s.knownIps.length} unique`}
          />
          {s.knownIps.length === 0 ? (
            <div
              style={{
                fontSize: 12,
                color: "var(--ds-fg-disabled)",
                padding: "20px 0",
                textAlign: "center",
              }}
            >
              No IP data
            </div>
          ) : (
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 12.5,
              }}
            >
              <thead>
                <tr>
                  <Th label="IP address" />
                  <Th label="Plays" align="right" />
                  <Th label="Last seen" align="right" />
                </tr>
              </thead>
              <tbody>
                {s.knownIps.map((ip) => (
                  <tr
                    key={ip.ip}
                    style={{ borderBottom: "1px solid var(--ds-border)" }}
                  >
                    <td style={{ padding: "9px 11px" }}>
                      <IpInfo ip={ip.ip} />
                    </td>
                    <td
                      className="ds-mono"
                      style={{
                        padding: "9px 11px",
                        color: "var(--ds-fg-muted)",
                        textAlign: "right",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {ip.plays}
                    </td>
                    <td
                      className="ds-mono"
                      style={{
                        padding: "9px 11px",
                        color: "var(--ds-fg-subtle)",
                        textAlign: "right",
                      }}
                    >
                      {when(ip.lastSeenIso)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </ActivityCard>
        <ActivityCard>
          <SectionHeader
            label="Recent plays"
            sub={`last ${s.recentPlays.length}`}
          />
          {s.recentPlays.length === 0 ? (
            <div
              style={{
                fontSize: 12,
                color: "var(--ds-fg-disabled)",
                padding: "20px 0",
                textAlign: "center",
              }}
            >
              No plays recorded
            </div>
          ) : (
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 12.5,
              }}
            >
              <thead>
                <tr>
                  <Th label="Title" />
                  <Th label="Quality" />
                  <Th label="When" align="right" />
                </tr>
              </thead>
              <tbody>
                {s.recentPlays.map((p, i) => (
                  <tr
                    key={p.id}
                    style={{
                      borderBottom:
                        i < s.recentPlays.length - 1
                          ? "1px solid var(--ds-border)"
                          : "none",
                    }}
                  >
                    <td style={{ padding: "9px 11px" }}>
                      {p.tmdbId ? (
                        <Link
                          href={`/admin/activity/media/${p.tmdbId}${p.mediaType ? `?type=${p.mediaType}` : ""}`}
                          style={{
                            color: "var(--ds-fg)",
                            fontSize: 12.5,
                            textDecoration: "none",
                            display: "block",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            maxWidth: 220,
                          }}
                        >
                          {p.title}
                        </Link>
                      ) : (
                        <span style={{ color: "var(--ds-fg)" }}>
                          {p.title}
                        </span>
                      )}
                      {p.mediaType === "TV" && p.seasonNumber != null && (
                        <span
                          className="ds-mono"
                          style={{
                            fontSize: 10,
                            color: "var(--ds-fg-disabled)",
                          }}
                        >
                          S{String(p.seasonNumber).padStart(2, "0")} · E
                          {String(p.episodeNumber ?? 0).padStart(2, "0")}
                        </span>
                      )}
                    </td>
                    <td
                      className="ds-mono"
                      style={{
                        padding: "9px 11px",
                        color: "var(--ds-fg-subtle)",
                        fontSize: 11,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {p.resolution ?? "—"}
                      {p.videoCodec && (
                        <span style={{ color: "var(--ds-fg-disabled)" }}>
                          {" "}
                          · {p.videoCodec}
                        </span>
                      )}
                    </td>
                    <td
                      className="ds-mono"
                      style={{
                        padding: "9px 11px",
                        color: "var(--ds-fg-subtle)",
                        textAlign: "right",
                        fontSize: 11,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {when(p.startedAtIso)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </ActivityCard>
      </div>
    </div>
  );
}
