"use client";

// Personal watch-stats dashboard — the caller's OWN aggregates. A deliberately
// lean sibling of the admin per-user screen (activity-user-detail.tsx): it
// reuses the same DS-styled primitives but omits the admin-only surfaces (known
// IPs, per-play codecs, transcode/resolution forensics), matching the lean
// posture of my-watch-history.ts. Relative-time labels are gated behind
// useHasMounted (guardrail 16): SSR renders an absolute fallback pinned to the
// statistics zone, the client swaps in "Xd ago" after hydration.

import type { CSSProperties } from "react";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { formatRelativeTimeLocalized } from "@/lib/relative-time";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import {
  ActivityCard,
  AreaChart,
  HorizontalBars,
  HourHeatmap,
  SectionHeader,
  MiniKpi,
  toHeatmapMatrix,
} from "@/components/admin/activity-ui";
import { formatDurationHM } from "@/lib/format-duration";
import { mediaHref } from "@/lib/media-href";
import { ActivityCalendar } from "@/components/admin/activity-calendar";
import { BarChart3 } from "@/components/icons";
import { EmptyState } from "@/components/ui/design";
import { RankedTitleRow } from "./ranked-title-row";

export interface MyStatsData {
  totalPlays: number;
  totalWatchTimeHours: number;
  avgSessionDuration: number;
  lastActiveIso: string | null;
  activityCalendar: { day: string; count: number }[];
  // The statistics zone every day and hour bucket here is in, and its today.
  todayIso: string;
  timeZone: string;
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

function absTime(iso: string, locale: string, timeZone: string): string {
  // Pinned to an explicit zone so SSR (container TZ) and the first client paint
  // produce the same text — prevents a React #418 hydration mismatch on the
  // relative-time labels gated behind useHasMounted (guardrail 16). An instant
  // (last active) is shown in the statistics zone (guardrail 19g); a day key
  // ("YYYY-MM-DD", already that zone's day) is printed in UTC, which prints its
  // own date.
  return new Date(iso).toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    timeZone,
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
    !iso ? "—" : mounted ? formatRelativeTimeLocalized(iso, locale) : absTime(iso, locale, s.timeZone);

  // Postgres numbers weekdays 0=Sun..6=Sat, but the heatmap rows start on
  // Monday, like the admin grid (toHeatmapMatrix).
  const heatmapMatrix = toHeatmapMatrix(s.userHeatmap);

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
        <MiniKpi label={t("personal.stats.totalPlays")} value={s.totalPlays.toLocaleString(locale)} />
        <MiniKpi label={t("personal.stats.watchTime")} value={t("personal.stats.watchTimeValue", { hours: s.totalWatchTimeHours.toLocaleString(locale) })} />
        <MiniKpi label={t("personal.stats.lastActive")} value={when(s.lastActiveIso)} />
        <MiniKpi label={t("personal.stats.avgSession")} value={formatDurationHM(s.avgSessionDuration, locale)} />
      </div>

      {s.activityCalendar.length > 0 && (
        <ActivityCard>
          <SectionHeader
            label={t("personal.stats.calendar")}
            sub={t("personal.stats.activeDays", { count: s.activityCalendar.filter((v) => v.count > 0).length })}
          />
          <ActivityCalendar data={s.activityCalendar} today={s.todayIso} timeZone={s.timeZone} />
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
            labels={s.playsByDay.map((d) => absTime(`${d.day}T00:00:00Z`, locale, "UTC"))}
            valueSuffix={t("personal.stats.playsSuffix")}
          />
        </ActivityCard>
        <ActivityCard>
          <SectionHeader label={t("personal.stats.heatmap")} sub={t("personal.stats.heatmapSub")} />
          <HourHeatmap matrix={heatmapMatrix} timeZone={s.timeZone} />
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
            {s.topMedia.map((m, i) => (
              <RankedTitleRow
                key={`${m.title}-${i}`}
                size="compact"
                rank={i + 1}
                title={m.title}
                href={mediaHref(m.tmdbId, m.mediaType)}
                posterSrc={m.posterSrc}
                count={t("personal.stats.plays", { count: m.count, n: m.count.toLocaleString(locale) })}
              />
            ))}
          </div>
        </ActivityCard>
      )}
    </div>
  );
}
