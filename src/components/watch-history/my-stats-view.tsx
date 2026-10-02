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
import { formatRelativeTimeLocalized } from "@/lib/relative-time";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
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
import { BarChart3 } from "@/components/icons";
import { EmptyState } from "@/components/ui/design";

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

function absTime(iso: string, locale: string): string {
  // UTC-pinned so SSR (container TZ) and the first client paint produce the same
  // text — prevents a React #418 hydration mismatch on the relative-time labels
  // when they're gated behind useHasMounted (guardrail 16).
  return new Date(iso).toLocaleDateString(locale, {
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
  const t = useT();
  const locale = useLocale();
  const when = (iso: string | null) =>
    !iso ? "—" : mounted ? formatRelativeTimeLocalized(iso, locale) : absTime(iso, locale);

  // Postgres numbers weekdays 0=Sun..6=Sat, but the heatmap rows start on
  // Monday (like the admin grid), so a day lands on row (dow + 6) % 7.
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
      <EmptyState
        icon={BarChart3}
        title={t("personal.stats.noActivityTitle")}
        description={t("personal.stats.noActivityDescription")}
      />
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: 10,
        }}
      >
        <MiniKpi label={t("personal.stats.totalPlays")} value={s.totalPlays.toLocaleString(locale)} big />
        <MiniKpi label={t("personal.stats.watchTime")} value={`${s.totalWatchTimeHours.toLocaleString(locale)}h`} big />
        <MiniKpi label={t("personal.stats.lastActive")} value={when(s.lastActiveIso)} />
        <MiniKpi label={t("personal.stats.avgSession")} value={fmtDuration(s.avgSessionDuration)} />
      </div>

      {s.activityCalendar.length > 0 && (
        <ActivityCard>
          <SectionHeader
            label={t("personal.stats.calendar")}
            sub={t("personal.stats.activeDays", { count: s.activityCalendar.filter((v) => v.count > 0).length })}
          />
          <ActivityCalendar data={s.activityCalendar} today={s.todayIso} />
        </ActivityCard>
      )}

      <div style={CARD_GRID}>
        <ActivityCard>
          <SectionHeader
            label={t("personal.stats.playsPerDay")}
            sub={t("personal.stats.peakPlays", { count: Math.max(...playsByDay, 0) })}
          />
          <AreaChart
            data={playsByDay}
            h={130}
            labels={s.playsByDay.map((d) => absTime(`${d.day}T00:00:00Z`, locale))}
            valueSuffix={t("personal.stats.playsSuffix")}
          />
        </ActivityCard>
        <ActivityCard>
          <SectionHeader label={t("personal.stats.heatmap")} sub={t("personal.stats.heatmapSub")} />
          <HourHeatmap matrix={heatmapMatrix} />
        </ActivityCard>
      </div>

      <div style={CARD_GRID}>
        <ActivityCard>
          <SectionHeader
            label={t("personal.stats.platforms")}
            sub={t("personal.stats.uniqueCount", { count: s.platformBreakdown.length })}
          />
          <HorizontalBars
            items={s.platformBreakdown.slice(0, 6).map((p) => ({ label: p.platform, count: p.count }))}
          />
        </ActivityCard>
        <ActivityCard>
          <SectionHeader
            label={t("personal.stats.devices")}
            sub={t("personal.stats.knownCount", { count: s.deviceList.length })}
          />
          <HorizontalBars
            items={s.deviceList.slice(0, 6).map((d) => ({ label: d.device, count: d.count }))}
            color="var(--ds-info)"
            labelWidth={100}
          />
        </ActivityCard>
      </div>

      {s.topMedia.length > 0 && (
        <ActivityCard>
          <SectionHeader
            label={t("personal.stats.mostWatched")}
            sub={t("personal.stats.titleCount", { count: s.topMedia.length })}
          />
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
                      {t("personal.stats.plays", { count: m.count, n: m.count.toLocaleString(locale) })}
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
