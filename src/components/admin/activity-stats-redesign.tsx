"use client";

// The Stats tab of the admin Activity page, drawn from the result of
// getPlayHistoryStats(). It only renders its props. Date labels are built from
// fixed "YYYY-MM-DD" strings, never from the current time, so the server and
// the browser always print the same text (guardrail 16).

import { useMemo } from "react";
import Link from "next/link";
import type { PlayHistoryStatsResult } from "@/lib/play-history";
import { posterUrl } from "@/lib/tmdb-types";
import {
  OTHER_REASONS,
  UNKNOWN_REASON,
  isPlexStreamOnlyReason,
  translateTranscodeReason,
} from "@/lib/transcode-reasons";
import {
  ActivityCard,
  AreaChart,
  Avatar,
  BarColumn,
  HorizontalBars,
  Poster,
  SectionHeader,
  StreamTypeBars,
  UtcTag,
} from "@/components/admin/activity-ui";
import { KpiStrip, type Kpi } from "@/components/admin/activity-sections";
import { EmptyState } from "@/components/ui/design";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import type { Translator } from "@/lib/i18n/translate";

// Only what this page draws. The page builds it from the shared stats result so
// the fields this tab never renders (heatmap, completion buckets, top episodes,
// rewatch leaderboard, …) are not serialized into the client payload.
export type ActivityStatsData = Pick<
  PlayHistoryStatsResult,
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

// Mon-first weekday catalog keys, translated at render.
const DOW_LABEL_KEYS = [
  "adminActivity.weekday.mon",
  "adminActivity.weekday.tue",
  "adminActivity.weekday.wed",
  "adminActivity.weekday.thu",
  "adminActivity.weekday.fri",
  "adminActivity.weekday.sat",
  "adminActivity.weekday.sun",
];

// Parse explicitly as UTC and format in UTC so SSR (UTC) and client (local TZ)
// agree on the day label. Mirrors activity-calendar.tsx (guardrail 16). ONE
// formatter per locale: a 3650-day window labels ~15k points, and
// toLocaleDateString builds a fresh Intl formatter on every call (~380 ms of
// render at that size, against ~20 ms reusing one).
function useShortDay(locale: string): (day: string) => string {
  return useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone: "UTC" });
    return (day: string) => fmt.format(new Date(`${day.slice(0, 10)}T00:00:00Z`));
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

// `labelKey` is a catalog key, translated at render.
// `labelKey` is a catalog key, translated at render. Anything else the server
// recorded (no method at all, mostly older Jellyfin rows) is one "Other"
// segment, so the bars and the "% direct play" header divide by one total.
const STREAM_META: Record<string, { labelKey: string; color: string }> = {
  DirectPlay: { labelKey: "adminActivity.method.directPlay", color: "var(--ds-success)" },
  DirectStream: { labelKey: "adminActivity.method.remux", color: "var(--ds-info)" },
  Transcode: { labelKey: "adminActivity.method.transcode", color: "var(--ds-warning)" },
};
const STREAM_METHODS = ["DirectPlay", "DirectStream", "Transcode"];

export function ActivityStatsRedesign({
  stats,
  days,
}: {
  stats: ActivityStatsData;
  days: number;
}) {
  const t = useT();
  const locale = useLocale();
  const shortDay = useShortDay(locale);
  const hoursSuffix = t("adminActivity.common.hoursSuffix");
  const prevComplete = stats.prevPeriod.complete;
  const watchHours = Math.round(stats.totalWatchTimeHours);
  // Every daily series is padded over the same days (padDailySeries), so one
  // set of labels serves all four trends and the three KPI sparklines.
  const dayKeys = stats.playsByDay.map((d) => d.day);
  const dayLabels = dayKeys.map(shortDay);
  const labelsFor = (series: { day: string }[]) =>
    series.length === dayKeys.length && series.every((d, i) => d.day === dayKeys[i])
      ? dayLabels
      : series.map((d) => shortDay(d.day));
  const bandwidthUnit = " GB";

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
          ? `${fmt1(stats.totalBandwidthGB / 1000, locale)} TB`
          : `${fmt1(stats.totalBandwidthGB, locale)} GB`,
      spark: stats.bandwidthByDay.map((d) => d.gb),
      sparkLabels: labelsFor(stats.bandwidthByDay),
      sparkSuffix: bandwidthUnit,
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

  // Series colours are the DS chart ramp (--ds-chart-1..4, in order), never
  // oklch literals: the old hand-picked hues duplicated three of the six accent
  // fills (so "Plays" and "Bandwidth" were one colour under the cyan accent)
  // and never got the light-theme darkening the tokens carry (guardrail 42).
  // `unit` carries its own spacing: the hours suffix sits flush ("12h", as on
  // the KPI tile) and is translated (zh "小时"); GB keeps a space.
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
      unit: bandwidthUnit,
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

  const topMovies = stats.topWatched
    .filter((m) => m.mediaType === "MOVIE")
    .slice(0, 8);
  const topTV = stats.topWatched
    .filter((m) => m.mediaType === "TV")
    .slice(0, 8);
  // The page passes the overall top ten. (The query returns each source's top
  // ten; the overall top ten always sits inside that union.)
  const userMax = stats.topUsers[0]?.count ?? 1;
  const movieMax = topMovies[0]?.plays ?? 1;
  const tvMax = topTV[0]?.plays ?? 1;

  const streamTypes = STREAM_METHODS.map((m) => ({
    label: t(STREAM_META[m].labelKey),
    count: stats.transcodeRatio.find((r) => r.method === m)?.count ?? 0,
    color: STREAM_META[m].color,
  }));
  const otherMethodCount = stats.transcodeRatio
    .filter((r) => !STREAM_METHODS.includes(r.method))
    .reduce((s, r) => s + r.count, 0);
  if (otherMethodCount > 0) {
    streamTypes.push({
      label: t("adminActivity.method.other"),
      count: otherMethodCount,
      color: "var(--ds-fg-disabled)",
    });
  }
  const sourceSplit = stats.sourceSplit.map((r) => ({
    label: r.source === "plex" ? "Plex" : "Jellyfin",
    count: r.count,
    color: r.source === "plex" ? "var(--ds-plex)" : "var(--ds-jellyfin)",
  }));
  // Both the count and the percentage in the "N transcoded sessions · P% of
  // sessions" line come from this one number, so they always agree. The
  // reason list folds its long tail into an "Other reasons" row
  // (play-history.ts), so summing it gives the true transcode total.
  const transcodeTotal = stats.transcodeReasons.reduce(
    (s, r) => s + r.count,
    0,
  );
  // transcodeRatio counts every session, but stats.totalPlays counts only
  // watched ones (play-history.ts's `wwhere` filter). Percentages of stream
  // method must divide by the all-sessions total, not by totalPlays — and that
  // total is exactly what the bars below sum to, "Other" segment included.
  const sessionTotal = stats.transcodeRatio.reduce((s, r) => s + r.count, 0);
  const transcodePct =
    sessionTotal > 0 ? Math.round((transcodeTotal / sessionTotal) * 100) : 0;
  const directPct =
    sessionTotal > 0
      ? Math.round(((streamTypes[0]?.count ?? 0) / sessionTotal) * 100)
      : 0;
  // The SQL orders reasons by count with the rolled-up tail last, so the first
  // named bucket is the most common reason. "Other reasons" is a bundle, never
  // a cause, even when the bundle outnumbers any single reason.
  const topReason = stats.transcodeReasons.find((r) => r.reason !== OTHER_REASONS);
  const topReasonPct =
    transcodeTotal > 0 && topReason
      ? Math.round((topReason.count / transcodeTotal) * 100)
      : 0;

  // Postgres numbers weekdays 0=Sun..6=Sat; this chart starts the week on Monday.
  const dowItems = DOW_LABEL_KEYS.map((key, i) => {
    const dow = (i + 1) % 7;
    return {
      label: t(key),
      count: stats.playsByDow.find((d) => d.dow === dow)?.count ?? 0,
    };
  });
  const hourData = Array.from(
    { length: 24 },
    (_, h) => stats.playsByHour.find((p) => p.hour === h)?.count ?? 0,
  );
  // indexOf(0) is hour 0 when every bucket is empty, so the "peak" caption is
  // only shown once there is a real peak — never "peak 0:00 · 0 plays".
  const peakCount = Math.max(...hourData, 0);
  const peakHour = hourData.indexOf(peakCount);
  const hourTitles = hourData.map((count, h) =>
    t("adminActivity.stats.hourBar", { hour: `${h}:00`, count, n: count.toLocaleString(locale) }),
  );

  return (
    <div>
      <KpiStrip kpis={kpis} />

      {/* Trends 2×2 */}
      <section style={{ marginBottom: 22 }}>
        <div className="resp-grid-2" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {trends.map((tr) => {
            const peak = Math.max(...tr.data, 0);
            // Per 24 hours of the window. The series has days + 1 entries (the
            // rolling cutoff splits the oldest and newest UTC days), but together
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
                      <UtcTag title={t("adminActivity.stats.utcDaysTitle")} />
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
                  {axisLabels(tr.labels).map((l, i) => (
                    <span key={i}>{l}</span>
                  ))}
                </div>
              </ActivityCard>
            );
          })}
        </div>
      </section>

      {/* Top of the chart */}
      <section style={{ marginBottom: 22 }}>
        <div className="resp-grid-3" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
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
                <LbRow
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
          <ActivityCard>
            <SectionHeader label={t("adminActivity.stats.topMovies")} sub={t("adminActivity.stats.ranked", { count: topMovies.length })} />
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {topMovies.map((m, i) => (
                <LbRow
                  key={m.tmdbId}
                  href={`/admin/activity/media/${m.tmdbId}?type=MOVIE`}
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
                  pct={(m.plays / movieMax) * 100}
                />
              ))}
              {topMovies.length === 0 && <Empty />}
            </div>
          </ActivityCard>
          <ActivityCard>
            <SectionHeader label={t("adminActivity.stats.topTv")} sub={t("adminActivity.stats.ranked", { count: topTV.length })} />
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {topTV.map((m, i) => (
                <LbRow
                  key={m.tmdbId}
                  href={`/admin/activity/media/${m.tmdbId}?type=TV`}
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
                  pct={(m.plays / tvMax) * 100}
                />
              ))}
              {topTV.length === 0 && <Empty />}
            </div>
          </ActivityCard>
        </div>
      </section>

      {/* Quality & infrastructure */}
      <section style={{ marginBottom: 22 }}>
        <SectionHeader
          label={t("adminActivity.stats.qualityInfra")}
          sub={t("adminActivity.stats.howViewersStream", { days })}
        />
        {/* One single-series chart per card; the ramp (--ds-chart-1..4) is
            walked in card order so neighbours differ. HorizontalBars' default
            colour is the accent, i.e. --ds-chart-1. */}
        <div className="resp-grid-3" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
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
        </div>
      </section>

      {/* Transcode forensics */}
      <section style={{ marginBottom: 22 }}>
        <div
          className="resp-grid-2"
          style={{
            display: "grid",
            gridTemplateColumns: "1.2fr 1fr",
            gap: 10,
          }}
        >
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
                    {topReason.reason === UNKNOWN_REASON ? (
                      <>{t("adminActivity.stats.noReason", { pct: topReasonPct })}</>
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
        </div>
      </section>

      {/* When people watch */}
      <section style={{ marginBottom: 22 }}>
        <div
          className="resp-grid-2"
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1.4fr",
            gap: 10,
          }}
        >
          <ActivityCard>
            <SectionHeader
              label={t("adminActivity.stats.dayOfWeek")}
              sub={t("adminActivity.stats.playsByWeekday")}
              right={<UtcTag title={t("adminActivity.stats.utcDaysTitle")} />}
            />
            <HorizontalBars items={dowItems} labelWidth={42} />
          </ActivityCard>
          <ActivityCard>
            <SectionHeader
              label={t("adminActivity.stats.hourOfDay")}
              sub={t("adminActivity.stats.hourDistribution")}
              right={
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  {peakCount > 0 && (
                    <span
                      className="ds-mono"
                      style={{
                        fontSize: 10.5,
                        color: "var(--ds-fg-subtle)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {t("adminActivity.stats.peakHour", {
                        hour: `${peakHour}:00`,
                        count: peakCount,
                        n: peakCount.toLocaleString(locale),
                      })}
                    </span>
                  )}
                  <UtcTag title={t("adminActivity.heatmap.utcTitle")} />
                </span>
              }
            />
            <BarColumn data={hourData} h={120} titles={hourTitles} />
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
              {[0, 6, 12, 18, 23].map((h) => (
                <span key={h}>{h}:00</span>
              ))}
            </div>
          </ActivityCard>
        </div>
      </section>

      {/* Audience composition */}
      <section style={{ marginBottom: 22 }}>
        <div className="resp-grid-3" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
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
            <HorizontalBars
              items={stats.decadeBreakdown.map((d) => ({
                label: bucketLabel(d.decade, t),
                count: d.count,
              }))}
              color="var(--ds-chart-3)"
              labelWidth={56}
            />
          </ActivityCard>
        </div>
      </section>
    </div>
  );
}

// The shared DS empty block, iconless — the one "nothing here" recipe the
// whole Activity dashboard uses (now-playing and recent-plays do the same).
function Empty() {
  const t = useT();
  return <EmptyState description={t("adminActivity.common.noDataYet")} />;
}

function LbRow({
  href,
  rank,
  avatar,
  title,
  source,
  primary,
  secondary,
  pct,
}: {
  href: string;
  rank: number;
  avatar: React.ReactNode;
  title: string;
  source?: string;
  primary: string;
  secondary?: string;
  pct: number;
}) {
  return (
    <Link
      href={href}
      className="lb-row"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "4px 6px",
        margin: "0 -6px",
        borderRadius: 5,
        textDecoration: "none",
      }}
    >
      <span
        className="ds-mono"
        style={{
          width: 16,
          textAlign: "right",
          fontSize: 10.5,
          color: "var(--ds-fg-subtle)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {rank.toString().padStart(2, "0")}
      </span>
      {avatar}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            marginBottom: 3,
            gap: 8,
            minWidth: 0,
          }}
        >
          <span
            style={{
              fontSize: 12.5,
              color: "var(--ds-fg)",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              minWidth: 0,
            }}
          >
            <span
              style={{ overflow: "hidden", textOverflow: "ellipsis" }}
            >
              {title}
            </span>
            {source && (
              <span
                style={{
                  width: 5,
                  height: 5,
                  borderRadius: 999,
                  flexShrink: 0,
                  background:
                    source === "plex"
                      ? "var(--ds-plex)"
                      : "var(--ds-jellyfin)",
                }}
              />
            )}
          </span>
          <span
            className="ds-mono"
            style={{
              fontSize: 11,
              color: "var(--ds-fg-muted)",
              fontVariantNumeric: "tabular-nums",
              whiteSpace: "nowrap",
            }}
          >
            {primary}
            {secondary && (
              <span style={{ color: "var(--ds-fg-subtle)" }}>
                {" "}
                · {secondary}
              </span>
            )}
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
              width: `${Math.max(0, Math.min(100, pct))}%`,
              height: "100%",
              background: "var(--ds-accent)",
              borderRadius: 999,
            }}
          />
        </div>
      </div>
    </Link>
  );
}
