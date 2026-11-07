"use client";

// The Stats tab of the admin Activity page, drawn from the result of
// getPlayHistoryStats(). It only renders its props. Date labels are built from
// fixed "YYYY-MM-DD" strings, never from the current time, so the server and
// the browser always print the same text (guardrail 16).

import { useMemo, type ReactNode } from "react";
import type { PlayHistoryStatsResult } from "@/lib/play-history";
import type { ActivityMediaType } from "@/lib/activity-days";
import { posterUrl } from "@/lib/tmdb-types";
import {
  isPlexStreamOnlyReason,
  reasonCalloutKind,
  translateTranscodeReason,
  UNKNOWN_REASON,
} from "@/lib/transcode-reasons";
import {
  ActivityCard,
  AreaChart,
  Avatar,
  BarColumn,
  Empty,
  HorizontalBars,
  LeaderboardRow,
  Poster,
  SectionHeader,
  StreamTypeBars,
  ZoneTag,
  WEEKDAY_KEYS,
  sourceDotColor,
  streamTypeSegments,
} from "@/components/admin/activity-ui";
import { foldStreamMethods } from "@/lib/activity-stream-mix";
import { zoneShortLabel } from "@/lib/stats-time-zone";
import { hourCounts, peakBucket, streamShares, weekdayCounts } from "@/lib/activity-stats-view";
import { KpiStrip, type Kpi } from "@/components/admin/activity-sections";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import type { Translator } from "@/lib/i18n/translate";

// Only what this page draws. The page builds it from the shared stats result so
// the fields this tab never renders (heatmap, completion buckets, top episodes,
// rewatch leaderboard, …) are not serialized into the client payload.
export type ActivityStatsData = Pick<
  PlayHistoryStatsResult,
  | "timeZone"
  | "totalPlays"
  | "totalWatchTimeHours"
  | "uniqueViewers"
  | "totalBandwidthGB"
  | "rewatchPlays"
  | "rewatchRate"
  | "peakConcurrent"
  | "prevPeriod"
  | "playsByDay"
  | "watchTimeByDay"
  | "bandwidthByDay"
  | "uniqueViewersByDay"
  | "topUsers"
  | "topWatched"
  | "transcodeRatio"
  | "transcodeReasons"
  | "sourceSplit"
  | "playsByDow"
  | "playsByHour"
  | "resolutionBreakdown"
  | "videoCodecBreakdown"
  | "audioCodecBreakdown"
  | "containerBreakdown"
  | "bitrateBuckets"
  | "topPlayers"
  | "playsByPlatform"
  | "topDevices"
  | "decadeBreakdown"
>;

// One decimal in the UI language, so "avg 3,5h" sits beside the
// locale-formatted "peak 1.234" instead of a hard-coded dot decimal.
function fmt1(n: number, locale: string): string {
  return n.toLocaleString(locale, { maximumFractionDigits: 1 });
}

// The day keys are already the statistics zone's dates; parsing one as UTC
// midnight and formatting in UTC prints that date unchanged, so SSR and the
// client agree on the label. Mirrors activity-calendar.tsx (guardrail 16). ONE
// formatter per locale: a 3650-day window labels ~15k points, and
// toLocaleDateString builds a fresh Intl formatter on every call (~380 ms of
// render at that size, against ~20 ms reusing one).
function useShortDay(locale: string): (day: string) => string {
  return useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone: "UTC" });
    return (day: string) => fmt.format(new Date(`${day.slice(0, 10)}T00:00:00Z`));
  }, [locale]);
}

// Hour-of-day labels in the UI language ("6:00 PM" in English, "18:00"
// elsewhere). The buckets are already the statistics zone's hours, so each
// label only names its number: built from a fixed UTC date (never the clock,
// guardrail 16) and formatted in UTC. ICU versions
// differ on the space before AM/PM (a narrow no-break space in some), so it is
// normalised to keep the server and browser text identical. One formatter per
// locale, as above.
function useHourLabel(locale: string): (hour: number) => string {
  return useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
    return (hour: number) => fmt.format(new Date(Date.UTC(2000, 0, 1, hour))).replace(/\u202f/g, " ");
  }, [locale]);
}

// Bandwidth in the UI language's own units through Intl ("12,3 Go" in French).
// `gbSuffix` is what follows the number, for the charts that print their own
// numbers; the number parts match fmt1's.
function useBandwidthFormat(locale: string): { gb: (n: number) => string; tb: (n: number) => string; gbSuffix: string } {
  return useMemo(() => {
    const gb = new Intl.NumberFormat(locale, { style: "unit", unit: "gigabyte", maximumFractionDigits: 1 });
    const tb = new Intl.NumberFormat(locale, { style: "unit", unit: "terabyte", maximumFractionDigits: 1 });
    const gbSuffix = gb
      .formatToParts(1)
      .filter((p) => p.type === "literal" || p.type === "unit")
      .map((p) => p.value)
      .join("");
    return { gb: (n) => gb.format(n), tb: (n) => tb.format(n), gbSuffix };
  }, [locale]);
}

// Picks up to five evenly spaced x-axis labels, but never more labels than
// there are days. Always using five made short ranges repeat a date (a 4-day
// range printed "Aug 26 · 27 · 28 · 28 · 29"). With at most one label per day,
// the chosen positions are at least one apart, so no date is printed twice.
function axisLabels(labels: string[]): string[] {
  if (labels.length < 2) return labels;
  const ticks = Math.min(5, labels.length);
  return Array.from({ length: ticks }, (_, i) =>
    labels[Math.round((i / (ticks - 1)) * (labels.length - 1))],
  );
}

// The aggregate SQL's catch-all buckets are English literals; translate them
// at render. Everything else in these charts is a codec, a client or a
// resolution name, shown as the server reported it.
function bucketLabel(label: string, t: Translator): string {
  if (label === UNKNOWN_REASON || label === "unknown") return t("adminActivity.stats.unknown");
  if (label === "Other") return t("adminActivity.stats.other");
  return label;
}

// `complete` is false when play history doesn't cover the previous window
// (tracking began, or retention purged, inside it): a delta would then compare
// against a gap, so none is shown.
function delta(
  t: Translator,
  current: number,
  previous: number,
  complete: boolean,
): Kpi["delta"] {
  if (!complete) return null;
  if (previous === 0 && current === 0) return null;
  if (previous === 0) return { text: t("adminActivity.kpi.new"), dir: "up" };
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return { text: "0%", dir: "flat" };
  return { text: `${Math.abs(pct)}%`, dir: pct > 0 ? "up" : "down" };
}

// The page's day labels, built once: every daily series is padded over the
// same days (padDailySeries), so one set serves all four trends and the KPI
// sparklines. A series that doesn't line up gets its own.
type LabelsFor = (series: { day: string }[]) => string[];

export function ActivityStatsRedesign({
  stats,
  days,
  mediaType,
}: {
  stats: ActivityStatsData;
  days: number;
  // The page's media-type filter. Only "TV" changes anything: the Movie decades
  // card is empty by construction then, and says why instead of "No data yet".
  mediaType?: ActivityMediaType;
}) {
  const locale = useLocale();
  const shortDay = useShortDay(locale);
  const dayKeys = stats.playsByDay.map((d) => d.day);
  const dayLabels = dayKeys.map(shortDay);
  const labelsFor: LabelsFor = (series) =>
    series.length === dayKeys.length && series.every((d, i) => d.day === dayKeys[i])
      ? dayLabels
      : series.map((d) => shortDay(d.day));

  return (
    <div>
      <StatsKpis stats={stats} labelsFor={labelsFor} />
      <TrendsSection stats={stats} days={days} labelsFor={labelsFor} />
      <TopChartsSection stats={stats} />
      <QualitySection stats={stats} days={days} />
      <TranscodeSection stats={stats} days={days} />
      <WhenSection stats={stats} />
      <AudienceSection stats={stats} mediaType={mediaType} />
    </div>
  );
}

/* ── Layout pieces ────────────────────────────────────────────── */

function StatsSection({ children }: { children: ReactNode }) {
  return <section style={{ marginBottom: 22 }}>{children}</section>;
}

function Grid({
  className,
  columns,
  children,
}: {
  className: "resp-grid-2" | "resp-grid-3";
  columns: string;
  children: ReactNode;
}) {
  return (
    <div className={className} style={{ display: "grid", gridTemplateColumns: columns, gap: 10 }}>
      {children}
    </div>
  );
}

const THREE_EQUAL = "repeat(3, minmax(0, 1fr))";

// The row of tick labels under a chart.
function AxisLabels({ labels }: { labels: string[] }) {
  return (
    <div
      className="ds-mono"
      style={{
        display: "flex",
        justifyContent: "space-between",
        marginTop: 6,
        fontSize: 9.5,
        color: "var(--ds-fg-subtle)",
      }}
    >
      {labels.map((l, i) => (
        <span key={i}>{l}</span>
      ))}
    </div>
  );
}

/* ── KPIs ─────────────────────────────────────────────────────── */

function StatsKpis({ stats, labelsFor }: { stats: ActivityStatsData; labelsFor: LabelsFor }) {
  const t = useT();
  const locale = useLocale();
  const bandwidth = useBandwidthFormat(locale);
  const hoursSuffix = t("adminActivity.common.hoursSuffix");
  const prevComplete = stats.prevPeriod.complete;
  const watchHours = Math.round(stats.totalWatchTimeHours);

  const kpis: Kpi[] = [
    {
      label: t("adminActivity.stat.plays"),
      value: stats.totalPlays.toLocaleString(locale),
      delta: delta(t, stats.totalPlays, stats.prevPeriod.totalPlays, prevComplete),
      spark: stats.playsByDay.map((d) => d.count),
      sparkLabels: labelsFor(stats.playsByDay),
      sparkSuffix: t("adminActivity.common.playsSuffix"),
    },
    {
      label: t("adminActivity.stats.watchHours"),
      value: `${watchHours.toLocaleString(locale)}${hoursSuffix}`,
      delta: delta(t, watchHours, Math.round(stats.prevPeriod.totalWatchTimeHours), prevComplete),
      spark: stats.watchTimeByDay.map((d) => d.hours),
      sparkLabels: labelsFor(stats.watchTimeByDay),
      sparkSuffix: hoursSuffix,
    },
    {
      label: t("adminActivity.stats.uniqueViewers"),
      value: stats.uniqueViewers.toLocaleString(locale),
      delta: delta(t, stats.uniqueViewers, stats.prevPeriod.uniqueViewers, prevComplete),
      spark: stats.uniqueViewersByDay.map((d) => d.count),
      sparkLabels: labelsFor(stats.uniqueViewersByDay),
    },
    {
      label: t("adminActivity.kpi.bandwidth"),
      value:
        stats.totalBandwidthGB >= 1000
          ? bandwidth.tb(stats.totalBandwidthGB / 1000)
          : bandwidth.gb(stats.totalBandwidthGB),
      spark: stats.bandwidthByDay.map((d) => d.gb),
      sparkLabels: labelsFor(stats.bandwidthByDay),
      sparkSuffix: bandwidth.gbSuffix,
    },
    {
      // Share of watched plays that re-watch a movie or episode the same viewer
      // had already watched (play-history.ts) — not plays per title, which
      // counted every new episode of a show as a "repeat".
      label: t("adminActivity.stats.rewatchRate"),
      value: `${fmt1(stats.rewatchRate, locale)}%`,
      sub: t("adminActivity.stats.rewatchSub", {
        count: stats.totalPlays,
        n: stats.rewatchPlays.toLocaleString(locale),
        total: stats.totalPlays.toLocaleString(locale),
      }),
    },
    {
      label: t("adminActivity.stats.peakConcurrency"),
      value: stats.peakConcurrent.toLocaleString(locale),
      sub: t("adminActivity.stats.maxSimultaneous"),
    },
  ];

  return <KpiStrip kpis={kpis} />;
}

/* ── Trends 2×2 ───────────────────────────────────────────────── */

function TrendsSection({
  stats,
  days,
  labelsFor,
}: {
  stats: ActivityStatsData;
  days: number;
  labelsFor: LabelsFor;
}) {
  const t = useT();
  const locale = useLocale();
  const bandwidth = useBandwidthFormat(locale);
  const hoursSuffix = t("adminActivity.common.hoursSuffix");

  // Series colours are the DS chart ramp (--ds-chart-1..4, in order), never
  // oklch literals: the old hand-picked hues duplicated three of the six accent
  // fills (so "Plays" and "Bandwidth" were one colour under the cyan accent)
  // and never got the light-theme darkening the tokens carry (guardrail 42).
  // `unit` carries its own spacing: the hours suffix sits flush ("12h", as on
  // the KPI tile) and is translated (zh "小时"); GB is Intl's own unit, with
  // its own spacing ("Go" in French).
  const trends: {
    label: string;
    data: number[];
    color: string;
    unit: string;
    labels: string[];
  }[] = [
    {
      label: t("adminActivity.stats.playsPerDay"),
      data: stats.playsByDay.map((d) => d.count),
      color: "var(--ds-chart-1)",
      unit: "",
      labels: labelsFor(stats.playsByDay),
    },
    {
      label: t("adminActivity.stats.watchHoursPerDay"),
      data: stats.watchTimeByDay.map((d) => d.hours),
      color: "var(--ds-chart-2)",
      unit: hoursSuffix,
      labels: labelsFor(stats.watchTimeByDay),
    },
    {
      label: t("adminActivity.stats.bandwidthPerDay"),
      data: stats.bandwidthByDay.map((d) => d.gb),
      color: "var(--ds-chart-3)",
      unit: bandwidth.gbSuffix,
      labels: labelsFor(stats.bandwidthByDay),
    },
    {
      label: t("adminActivity.stats.uniqueViewersPerDay"),
      data: stats.uniqueViewersByDay.map((d) => d.count),
      color: "var(--ds-chart-4)",
      unit: "",
      labels: labelsFor(stats.uniqueViewersByDay),
    },
  ];

  return (
    <StatsSection>
      <Grid className="resp-grid-2" columns="repeat(2, minmax(0, 1fr))">
        {trends.map((tr) => {
          const peak = Math.max(...tr.data, 0);
          // Per 24 hours of the window. The series has days + 1 entries (the
          // rolling cutoff splits the oldest and newest days), but together
          // they hold exactly `days` × 24 h of activity, so divide by `days`.
          const avg =
            days > 0 ? tr.data.reduce((s, v) => s + v, 0) / days : 0;
          return (
            <ActivityCard key={tr.label}>
              <SectionHeader
                label={tr.label}
                sub={t("adminActivity.stats.lastDaysPeak", { days, peak: `${fmt1(peak, locale)}${tr.unit}` })}
                right={
                  <span
                    style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
                  >
                    <span
                      className="ds-mono"
                      style={{
                        fontSize: 10.5,
                        color: "var(--ds-fg-subtle)",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {t("adminActivity.stats.avg", { value: `${fmt1(avg, locale)}${tr.unit}` })}
                    </span>
                    <ZoneTag
                      zone={stats.timeZone}
                      title={t("adminActivity.stats.zoneDaysTitle", { zone: stats.timeZone })}
                    />
                  </span>
                }
              />
              <AreaChart
                data={tr.data}
                h={120}
                color={tr.color}
                labels={tr.labels}
                valueSuffix={tr.unit}
              />
              <AxisLabels labels={axisLabels(tr.labels)} />
            </ActivityCard>
          );
        })}
      </Grid>
    </StatsSection>
  );
}

/* ── Top of the chart ─────────────────────────────────────────── */

function TopChartsSection({ stats }: { stats: ActivityStatsData }) {
  const t = useT();
  const locale = useLocale();
  // The page passes the overall top ten. (The query returns each source's top
  // ten; the overall top ten always sits inside that union.)
  const userMax = stats.topUsers[0]?.count ?? 1;
  return (
    <StatsSection>
      <Grid className="resp-grid-3" columns={THREE_EQUAL}>
        <ActivityCard>
          <SectionHeader
            label={t("adminActivity.stats.topViewers")}
            sub={t("adminActivity.stats.nOfTotal", {
              n: stats.topUsers.length.toLocaleString(locale),
              total: stats.uniqueViewers.toLocaleString(locale),
            })}
          />
          <div
            style={{ display: "flex", flexDirection: "column", gap: 6 }}
          >
            {stats.topUsers.map((u, i) => (
              <LeaderboardRow
                key={u.id}
                href={`/admin/activity/user/${u.id}`}
                rank={i + 1}
                avatar={
                  <Avatar
                    letter={(u.username[0] ?? "?").toUpperCase()}
                    size={22}
                  />
                }
                title={u.username}
                source={u.source}
                primary={t("adminActivity.common.plays", { count: u.count })}
                pct={(u.count / userMax) * 100}
              />
            ))}
            {stats.topUsers.length === 0 && <Empty />}
          </div>
        </ActivityCard>
        <TopTitlesCard
          label={t("adminActivity.stats.topMovies")}
          items={stats.topWatched.filter((m) => m.mediaType === "MOVIE").slice(0, 8)}
          type="MOVIE"
        />
        <TopTitlesCard
          label={t("adminActivity.stats.topTv")}
          items={stats.topWatched.filter((m) => m.mediaType === "TV").slice(0, 8)}
          type="TV"
        />
      </Grid>
    </StatsSection>
  );
}

// Top Movies and Top TV: one card, told which list and which type to link to.
function TopTitlesCard({
  label,
  items,
  type,
}: {
  label: string;
  items: ActivityStatsData["topWatched"];
  type: ActivityMediaType;
}) {
  const t = useT();
  const max = items[0]?.plays ?? 1;
  return (
    <ActivityCard>
      <SectionHeader label={label} sub={t("adminActivity.stats.ranked", { count: items.length })} />
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {items.map((m, i) => (
          <LeaderboardRow
            key={m.tmdbId}
            href={`/admin/activity/media/${m.tmdbId}?type=${type}`}
            rank={i + 1}
            avatar={
              <Poster
                src={m.posterPath ? posterUrl(m.posterPath, "w92") : null}
                letter={(m.title[0] ?? "?").toUpperCase()}
                w={26}
                h={36}
                radius={3}
              />
            }
            title={m.title}
            primary={t("adminActivity.common.plays", { count: m.plays })}
            secondary={t("adminActivity.common.viewers", { count: m.viewers })}
            pct={(m.plays / max) * 100}
          />
        ))}
        {items.length === 0 && <Empty />}
      </div>
    </ActivityCard>
  );
}

/* ── Quality & infrastructure ─────────────────────────────────── */

function QualitySection({ stats, days }: { stats: ActivityStatsData; days: number }) {
  const t = useT();
  return (
    <StatsSection>
      <SectionHeader
        label={t("adminActivity.stats.qualityInfra")}
        sub={t("adminActivity.stats.howViewersStream", { days })}
      />
      {/* One single-series chart per card; the ramp (--ds-chart-1..4) is
          walked in card order so neighbours differ. HorizontalBars' default
          colour is the accent, i.e. --ds-chart-1. */}
      <Grid className="resp-grid-3" columns={THREE_EQUAL}>
        <ActivityCard>
          <SectionHeader label={t("adminActivity.popover.resolution")} />
          <HorizontalBars
            items={stats.resolutionBreakdown.map((r) => ({
              label: bucketLabel(r.bucket, t),
              count: r.count,
            }))}
            color="var(--ds-chart-2)"
            labelWidth={70}
          />
        </ActivityCard>
        <ActivityCard>
          <SectionHeader label={t("adminActivity.field.videoCodec")} />
          <HorizontalBars
            items={stats.videoCodecBreakdown.map((r) => ({
              label: bucketLabel(r.codec, t),
              count: r.count,
            }))}
            labelWidth={70}
          />
        </ActivityCard>
        <ActivityCard>
          <SectionHeader label={t("adminActivity.stats.audioCodec")} />
          <HorizontalBars
            items={stats.audioCodecBreakdown.map((r) => ({
              label: bucketLabel(r.codec, t),
              count: r.count,
            }))}
            color="var(--ds-chart-3)"
            labelWidth={70}
          />
        </ActivityCard>
        <ActivityCard>
          <SectionHeader label={t("adminActivity.field.container")} />
          <HorizontalBars
            items={stats.containerBreakdown.map((r) => ({
              label: bucketLabel(r.container, t),
              count: r.count,
            }))}
            color="var(--ds-chart-4)"
            labelWidth={70}
          />
        </ActivityCard>
        <ActivityCard>
          <SectionHeader label={t("adminActivity.field.bitrate")} sub={t("adminActivity.stats.distribution")} />
          <HorizontalBars
            items={stats.bitrateBuckets.map((r) => ({
              label: bucketLabel(r.bucket, t),
              count: r.count,
            }))}
            color="var(--ds-chart-2)"
            labelWidth={92}
          />
        </ActivityCard>
        <ActivityCard>
          <SectionHeader label={t("adminActivity.stats.topPlayers")} sub={t("adminActivity.stats.clientApps")} />
          <HorizontalBars
            items={stats.topPlayers.slice(0, 8).map((r) => ({ label: bucketLabel(r.player, t), count: r.count }))}
            color="var(--ds-chart-3)"
            labelWidth={100}
          />
        </ActivityCard>
      </Grid>
    </StatsSection>
  );
}

/* ── Transcode forensics ──────────────────────────────────────── */

function TranscodeSection({ stats, days }: { stats: ActivityStatsData; days: number }) {
  const t = useT();
  const locale = useLocale();
  const streamMix = foldStreamMethods(stats.transcodeRatio);
  const streamTypes = streamTypeSegments(t, streamMix);
  const sourceSplit = stats.sourceSplit.map((r) => ({
    label: r.source === "plex" ? "Plex" : "Jellyfin",
    count: r.count,
    color: sourceDotColor(r.source),
  }));
  // Both the count and the percentage in the "N transcoded sessions · P% of
  // sessions" line come from transcodeTotal, so they always agree; every share
  // divides by the all-sessions total the bars below sum to (streamShares).
  // The SQL orders reasons by count with the rolled-up tail last, so the first
  // named bucket is the most common reason.
  const { transcodeTotal, transcodePct, directPct, topReason, topReasonPct } = streamShares(
    streamMix,
    stats.transcodeReasons,
  );

  return (
    <StatsSection>
      <Grid className="resp-grid-2" columns="minmax(0, 1.2fr) minmax(0, 1fr)">
        <ActivityCard>
          <SectionHeader
            label={t("adminActivity.stats.whyTranscoding")}
            sub={t("adminActivity.stats.transcodedSessions", {
              count: transcodeTotal,
              n: transcodeTotal.toLocaleString(locale),
              pct: transcodePct,
            })}
          />
          <HorizontalBars
            items={stats.transcodeReasons.map((r) => ({
              label: translateTranscodeReason(r.reason, t),
              count: r.count,
            }))}
            color="var(--ds-warning)"
            labelWidth={230}
          />
          {topReason && (
            <div
              style={{
                marginTop: 14,
                padding: "10px 12px",
                // Tinted off the same warning token the icon beside it uses,
                // so the callout follows the theme instead of a fixed amber.
                background: "color-mix(in oklab, var(--ds-warning) 6%, transparent)",
                border: "1px solid color-mix(in oklab, var(--ds-warning) 18%, transparent)",
                borderRadius: 8,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 8,
                }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 14 14"
                  aria-hidden
                  style={{
                    color: "var(--ds-warning)",
                    flexShrink: 0,
                    marginTop: 1,
                  }}
                >
                  <path
                    d="M7 2v5M7 10v0"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                  <circle
                    cx="7"
                    cy="7"
                    r="5.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.2"
                  />
                </svg>
                <div
                  style={{
                    fontSize: 11.5,
                    color: "var(--ds-fg-muted)",
                    lineHeight: 1.45,
                  }}
                >
                  {/* States only what the data holds: the most common
                      reason and its share. It used to add "addressing it
                      would meaningfully cut server transcode load" whatever
                      the share — and for Plex, whose "reason" was a guess. */}
                  {/* "No reason reported" is the server saying nothing for a
                      NEW session — not a cause, and unlike Unknown it does
                      not clear as data accumulates (guardrail 19c). */}
                  {reasonCalloutKind(topReason.reason) === "unknown" ? (
                    <>{t("adminActivity.stats.noReason", { pct: topReasonPct })}</>
                  ) : reasonCalloutKind(topReason.reason) === "unreported" ? (
                    <>{t("adminActivity.stats.noReasonReportedTop", { pct: topReasonPct })}</>
                  ) : (
                    <>
                      {(() => {
                        const [before, after] = t("adminActivity.stats.topReason", {
                          pct: topReasonPct,
                          reason: "\u0000",
                        }).split("\u0000");
                        return (
                          <>
                            {before}
                            <span style={{ color: "var(--ds-fg)" }}>
                              {translateTranscodeReason(topReason.reason, t)}
                            </span>
                            {after}
                          </>
                        );
                      })()}
                      {isPlexStreamOnlyReason(topReason.reason) && (
                        <> {t("adminActivity.stats.plexNoReason")}</>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          )}
        </ActivityCard>
        <ActivityCard>
          <SectionHeader
            label={t("adminActivity.stats.streamMethodDays", { days })}
            sub={t("adminActivity.stats.directPlayPct", { pct: directPct })}
          />
          <StreamTypeBars data={streamTypes} />
          <hr
            style={{
              border: 0,
              borderTop: "1px solid var(--ds-border)",
              margin: "14px 0 12px",
            }}
          />
          <SectionHeader label={t("adminActivity.stats.sourceSplit")} />
          <StreamTypeBars data={sourceSplit} />
        </ActivityCard>
      </Grid>
    </StatsSection>
  );
}

/* ── When people watch ────────────────────────────────────────── */

function WhenSection({ stats }: { stats: ActivityStatsData }) {
  const t = useT();
  const locale = useLocale();
  const hourLabel = useHourLabel(locale);
  const dowItems = weekdayCounts(stats.playsByDow).map((count, i) => ({
    label: t(WEEKDAY_KEYS[i]),
    count,
  }));
  const hourData = hourCounts(stats.playsByHour);
  // Shown only once there is a real peak — never "peak 0:00 · 0 plays".
  const peak = peakBucket(hourData);
  const zone = zoneShortLabel(stats.timeZone);
  const hourTitles = hourData.map((count, h) =>
    t("adminActivity.stats.hourBar", { hour: hourLabel(h), zone, count, n: count.toLocaleString(locale) }),
  );

  return (
    <StatsSection>
      <Grid className="resp-grid-2" columns="minmax(0, 1fr) minmax(0, 1.4fr)">
        <ActivityCard>
          <SectionHeader
            label={t("adminActivity.stats.dayOfWeek")}
            sub={t("adminActivity.stats.playsByWeekday")}
            right={
              <ZoneTag
                zone={stats.timeZone}
                title={t("adminActivity.stats.zoneDaysTitle", { zone: stats.timeZone })}
              />
            }
          />
          <HorizontalBars items={dowItems} labelWidth={42} />
        </ActivityCard>
        <ActivityCard>
          <SectionHeader
            label={t("adminActivity.stats.hourOfDay")}
            sub={t("adminActivity.stats.hourDistribution")}
            right={
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                {peak && (
                  <span
                    className="ds-mono"
                    style={{
                      fontSize: 10.5,
                      color: "var(--ds-fg-subtle)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {t("adminActivity.stats.peakHour", {
                      hour: hourLabel(peak.index),
                      count: peak.count,
                      n: peak.count.toLocaleString(locale),
                    })}
                  </span>
                )}
                <ZoneTag
                  zone={stats.timeZone}
                  title={t("adminActivity.heatmap.zoneTitle", { zone: stats.timeZone })}
                />
              </span>
            }
          />
          <BarColumn data={hourData} h={120} titles={hourTitles} />
          <AxisLabels labels={[0, 6, 12, 18, 23].map(hourLabel)} />
        </ActivityCard>
      </Grid>
    </StatsSection>
  );
}

/* ── Audience composition ─────────────────────────────────────── */

function AudienceSection({
  stats,
  mediaType,
}: {
  stats: ActivityStatsData;
  mediaType?: ActivityMediaType;
}) {
  const t = useT();
  return (
    <StatsSection>
      <Grid className="resp-grid-3" columns={THREE_EQUAL}>
        <ActivityCard>
          <SectionHeader
            label={t("adminActivity.title.platforms")}
            sub={t("adminActivity.title.unique", { count: stats.playsByPlatform.length })}
          />
          <HorizontalBars
            items={stats.playsByPlatform.slice(0, 8).map((p) => ({ label: bucketLabel(p.platform, t), count: p.count }))}
            labelWidth={100}
          />
        </ActivityCard>
        <ActivityCard>
          <SectionHeader
            label={t("adminActivity.user.devices")}
            sub={t("adminActivity.user.known", { count: stats.topDevices.length })}
          />
          <HorizontalBars
            items={stats.topDevices.slice(0, 8).map((d) => ({ label: bucketLabel(d.device, t), count: d.count }))}
            color="var(--ds-chart-2)"
            labelWidth={100}
          />
        </ActivityCard>
        <ActivityCard>
          <SectionHeader
            label={t("adminActivity.stats.movieDecades")}
            sub={t("adminActivity.stats.releaseYear")}
          />
          {mediaType === "TV" ? (
            // The same empty block HorizontalBars draws, so the row keeps its
            // three cards and the note reads like one.
            <Empty description={t("adminActivity.stats.movieDecadesTvFiltered")} />
          ) : (
            <HorizontalBars
              items={stats.decadeBreakdown.map((d) => ({
                label: bucketLabel(d.decade, t),
                count: d.count,
              }))}
              color="var(--ds-chart-3)"
              labelWidth={56}
            />
          )}
        </ActivityCard>
      </Grid>
    </StatsSection>
  );
}
