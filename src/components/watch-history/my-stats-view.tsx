"use client";

// Personal watch-stats dashboard — the caller's OWN aggregates. A deliberately
// lean sibling of the admin per-user screen (activity-user-detail.tsx): it
// reuses the same DS-styled primitives but omits the admin-only surfaces (known
// IPs, per-play codecs, transcode/resolution forensics), matching the lean
// posture of my-watch-history.ts. Relative-time labels are gated behind
// useHasMounted (guardrail 16): SSR renders a UTC-pinned absolute fallback, the
// client swaps in "Xd ago" after hydration.

import type { CSSProperties } from "react";
import Link from "next/link";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { formatRelativeTime } from "@/lib/relative-time";
import {
  ActivityCard,
  AreaChart,
  HorizontalBars,
  HourHeatmap,
  Poster,
  SectionHeader,
  MiniKpi,
  fmtDuration,
} from "@/components/admin/activity-ui";
import { ActivityCalendar } from "@/components/admin/activity-calendar";

export interface MyStatsData {
  totalPlays: number;
  totalWatchTimeHours: number;
  avgSessionDuration: number;
  lastActiveIso: string | null;
  activityCalendar: { day: string; count: number }[];
  todayIso: string;
  playsByDay: { day: string; count: number; hours: number }[];
  userHeatmap: { dow: number; hour: number; count: number }[];
  platformBreakdown: { platform: string; count: number }[];
  deviceList: { device: string; count: number }[];
  topMedia: {
    title: string;
    tmdbId: number | null;
    mediaType: string | null;
    count: number;
    posterSrc: string | null;
  }[];
}

function absTime(iso: string): string {
  // UTC-pinned so SSR (container TZ) and the first client paint produce the same
  // text — prevents a React #418 hydration mismatch on the relative-time labels
  // when they're gated behind useHasMounted (guardrail 16).
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

const CARD_GRID: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
  gap: 10,
};

export function MyStatsView({ data: s }: { data: MyStatsData }) {
  const mounted = useHasMounted();
  const when = (iso: string | null) =>
    !iso ? "—" : mounted ? formatRelativeTime(iso) : absTime(iso);

  // Postgres DOW 0=Sun..6=Sat → heatmap rows are Mon-first (matches the admin
  // grid): pgDow (row + 6) % 7.
  const heatmapMatrix: number[][] = Array.from({ length: 7 }, () =>
    new Array<number>(24).fill(0),
  );
  for (const c of s.userHeatmap) {
    if (c.dow >= 0 && c.dow < 7 && c.hour >= 0 && c.hour < 24) {
      heatmapMatrix[(c.dow + 6) % 7][c.hour] = c.count;
    }
  }

  const playsByDay = s.playsByDay.map((d) => d.count);

  // Linked, but nothing recorded yet — a media-server user with no plays.
  if (s.totalPlays === 0 && s.topMedia.length === 0) {
    return (
      <ActivityCard>
        <div
          style={{
            padding: "24px 8px",
            textAlign: "center",
            color: "var(--ds-fg-subtle)",
            fontSize: 13,
            lineHeight: 1.6,
          }}
        >
          No watch activity has been recorded yet. Once you play something on the
          server, your stats will appear here.
        </div>
      </ActivityCard>
    );
  }

  return (
    <div className="ds-page-enter" style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: 10,
        }}
      >
        <MiniKpi label="Total plays" value={s.totalPlays.toLocaleString("en-US")} big />
        <MiniKpi label="Watch time" value={`${s.totalWatchTimeHours.toLocaleString("en-US")}h`} big />
        <MiniKpi label="Last active" value={when(s.lastActiveIso)} />
        <MiniKpi label="Avg session" value={fmtDuration(s.avgSessionDuration)} />
      </div>

      {s.activityCalendar.length > 0 && (
        <ActivityCard>
          <SectionHeader
            label="365-day activity"
            sub={`${s.activityCalendar.filter((v) => v.count > 0).length} active days`}
          />
          <ActivityCalendar data={s.activityCalendar} today={s.todayIso} />
        </ActivityCard>
      )}

      <div style={CARD_GRID}>
        <ActivityCard>
          <SectionHeader label="Plays per day · 90d" sub={`peak ${Math.max(...playsByDay, 0)} plays`} />
          <AreaChart
            data={playsByDay}
            h={130}
            labels={s.playsByDay.map((d) => absTime(`${d.day}T00:00:00Z`))}
            valueSuffix=" plays"
          />
        </ActivityCard>
        <ActivityCard>
          <SectionHeader label="Viewing heatmap" sub="day × hour" />
          <HourHeatmap matrix={heatmapMatrix} />
        </ActivityCard>
      </div>

      <div style={CARD_GRID}>
        <ActivityCard>
          <SectionHeader label="Platforms" sub={`${s.platformBreakdown.length} unique`} />
          <HorizontalBars
            items={s.platformBreakdown.slice(0, 6).map((p) => ({ label: p.platform, count: p.count }))}
          />
        </ActivityCard>
        <ActivityCard>
          <SectionHeader label="Devices" sub={`${s.deviceList.length} known`} />
          <HorizontalBars
            items={s.deviceList.slice(0, 6).map((d) => ({ label: d.device, count: d.count }))}
            color="oklch(0.62 0.14 295)"
            labelWidth={100}
          />
        </ActivityCard>
      </div>

      {s.topMedia.length > 0 && (
        <ActivityCard>
          <SectionHeader label="Most watched" sub={`${s.topMedia.length} titles`} />
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {s.topMedia.map((m, i) => {
              const href =
                m.tmdbId != null ? (m.mediaType === "TV" ? `/tv/${m.tmdbId}` : `/movie/${m.tmdbId}`) : null;
              return (
                <div key={`${m.title}-${i}`} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span
                    className="ds-mono"
                    style={{ width: 16, textAlign: "right", fontSize: 10.5, color: "var(--ds-fg-disabled)" }}
                  >
                    {(i + 1).toString().padStart(2, "0")}
                  </span>
                  <Poster src={m.posterSrc} letter={(m.title[0] ?? "?").toUpperCase()} w={28} h={40} radius={3} />
                  <div
                    style={{
                      flex: 1,
                      minWidth: 0,
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "baseline",
                      gap: 8,
                    }}
                  >
                    {href ? (
                      <Link
                        href={href}
                        style={{
                          fontSize: 13,
                          color: "var(--ds-fg)",
                          textDecoration: "none",
                          minWidth: 0,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {m.title}
                      </Link>
                    ) : (
                      <span
                        style={{
                          fontSize: 13,
                          color: "var(--ds-fg)",
                          minWidth: 0,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {m.title}
                      </span>
                    )}
                    <span
                      className="ds-mono"
                      style={{
                        fontSize: 11,
                        color: "var(--ds-fg-subtle)",
                        fontVariantNumeric: "tabular-nums",
                        flexShrink: 0,
                      }}
                    >
                      {m.count.toLocaleString("en-US")} {m.count === 1 ? "play" : "plays"}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </ActivityCard>
      )}
    </div>
  );
}
