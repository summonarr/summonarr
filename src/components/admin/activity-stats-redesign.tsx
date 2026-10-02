"use client";

// The Stats tab of the admin Activity page, drawn from the result of
// getPlayHistoryStats(). It only renders its props. Date labels are built from
// fixed "YYYY-MM-DD" strings, never from the current time, so the server and
// the browser always print the same text (guardrail 16).

import Link from "next/link";
import type { PlayHistoryStatsResult } from "@/lib/play-history";
import { posterUrl } from "@/lib/tmdb-types";
import {
  ActivityCard,
  AreaChart,
  Avatar,
  BarColumn,
  HorizontalBars,
  Poster,
  SectionHeader,
  StreamTypeBars,
} from "@/components/admin/activity-ui";
import { KpiStrip, type Kpi } from "@/components/admin/activity-sections";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import type { Translator } from "@/lib/i18n/translate";

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

function shortDay(day: string, locale: string): string {
  // Parse explicitly as UTC and format in UTC so SSR (UTC) and client (local
  // TZ) agree on the day label. Mirrors activity-calendar.tsx (guardrail 16).
  return new Date(`${day.slice(0, 10)}T00:00:00Z`).toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

// Picks up to five evenly spaced x-axis labels, but never more labels than
// there are days. Always using five made short ranges repeat a date (a 4-day
// range printed "Aug 26 · 27 · 28 · 28 · 29"). With at most one label per day,
// the chosen positions are at least one apart, so no date is printed twice.
function axisLabels(days: string[], locale: string): string[] {
  if (days.length < 2) return days.map((d) => shortDay(d, locale));
  const ticks = Math.min(5, days.length);
  return Array.from({ length: ticks }, (_, i) =>
    shortDay(days[Math.round((i / (ticks - 1)) * (days.length - 1))], locale),
  );
}

function delta(
  t: Translator,
  current: number,
  previous: number,
): Kpi["delta"] {
  if (previous === 0 && current === 0) return null;
  if (previous === 0) return { text: t("adminActivity.kpi.new"), dir: "up" };
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return { text: "0%", dir: "flat" };
  return { text: `${Math.abs(pct)}%`, dir: pct > 0 ? "up" : "down" };
}

// `labelKey` is a catalog key, translated at render.
const STREAM_META: Record<string, { labelKey: string; color: string }> = {
  DirectPlay: { labelKey: "adminActivity.method.directPlay", color: "var(--ds-success)" },
  DirectStream: { labelKey: "adminActivity.method.remux", color: "var(--ds-info)" },
  Transcode: { labelKey: "adminActivity.method.transcode", color: "var(--ds-warning)" },
};

export function ActivityStatsRedesign({
  stats,
  days,
}: {
  stats: PlayHistoryStatsResult;
  days: number;
}) {
  const t = useT();
  const locale = useLocale();
  const watchHours = Math.round(stats.totalWatchTimeHours);
  const repeatRate =
    stats.uniqueTitles > 0
      ? Math.round((stats.totalPlays / stats.uniqueTitles) * 10) / 10
      : 0;

  const kpis: Kpi[] = [
    {
      label: t("adminActivity.stat.plays"),
      value: stats.totalPlays.toLocaleString(locale),
      delta: delta(t, stats.totalPlays, stats.prevPeriod.totalPlays),
      spark: stats.playsByDay.map((d) => d.count),
    },
    {
      label: t("adminActivity.stats.watchHours"),
      value: `${watchHours.toLocaleString(locale)}h`,
      delta: delta(t, watchHours, Math.round(stats.prevPeriod.totalWatchTimeHours)),
      spark: stats.watchTimeByDay.map((d) => d.hours),
    },
    {
      label: t("adminActivity.stats.uniqueViewers"),
      value: stats.uniqueViewers.toLocaleString(locale),
      delta: delta(t, stats.uniqueViewers, stats.prevPeriod.uniqueViewers),
      spark: stats.uniqueViewersByDay.map((d) => d.count),
    },
    {
      label: t("adminActivity.kpi.bandwidth"),
      value:
        stats.totalBandwidthGB >= 1000
          ? `${(stats.totalBandwidthGB / 1000).toFixed(1)} TB`
          : `${stats.totalBandwidthGB} GB`,
      spark: stats.bandwidthByDay.map((d) => d.gb),
    },
    {
      label: t("adminActivity.stats.repeatRate"),
      value: `${repeatRate.toFixed(1)}×`,
      sub: t("adminActivity.stats.uniqueTitles", { count: stats.uniqueTitles, n: stats.uniqueTitles.toLocaleString(locale) }),
    },
    {
      label: t("adminActivity.stats.peakConcurrency"),
      value: stats.peakConcurrent.toLocaleString(locale),
      sub: t("adminActivity.stats.maxSimultaneous"),
    },
  ];

  const trends: {
    label: string;
    data: number[];
    color: string;
    unit: string;
    days: string[];
  }[] = [
    {
      label: t("adminActivity.stats.playsPerDay"),
      data: stats.playsByDay.map((d) => d.count),
      color: "var(--ds-accent-text)",
      unit: "",
      days: stats.playsByDay.map((d) => d.day),
    },
    {
      label: t("adminActivity.stats.watchHoursPerDay"),
      data: stats.watchTimeByDay.map((d) => d.hours),
      color: "oklch(0.68 0.16 158)",
      unit: "h",
      days: stats.watchTimeByDay.map((d) => d.day),
    },
    {
      label: t("adminActivity.stats.bandwidthPerDay"),
      data: stats.bandwidthByDay.map((d) => d.gb),
      color: "oklch(0.72 0.13 220)",
      unit: "GB",
      days: stats.bandwidthByDay.map((d) => d.day),
    },
    {
      label: t("adminActivity.stats.uniqueViewersPerDay"),
      data: stats.uniqueViewersByDay.map((d) => d.count),
      color: "oklch(0.78 0.16 75)",
      unit: "",
      days: stats.uniqueViewersByDay.map((d) => d.day),
    },
  ];

  const topMovies = stats.topWatched
    .filter((m) => m.mediaType === "MOVIE")
    .slice(0, 8);
  const topTV = stats.topWatched
    .filter((m) => m.mediaType === "TV")
    .slice(0, 8);
  const userMax = stats.topUsers[0]?.count ?? 1;
  const movieMax = topMovies[0]?.plays ?? 1;
  const tvMax = topTV[0]?.plays ?? 1;

  const streamTypes = ["DirectPlay", "DirectStream", "Transcode"].map((m) => ({
    label: t(STREAM_META[m].labelKey),
    count: stats.transcodeRatio.find((r) => r.method === m)?.count ?? 0,
    color: STREAM_META[m].color,
  }));
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
  // method must divide by the all-sessions total, not by totalPlays.
  const sessionTotal = stats.transcodeRatio.reduce((s, r) => s + r.count, 0);
  const transcodePct =
    sessionTotal > 0 ? Math.round((transcodeTotal / sessionTotal) * 100) : 0;
  const directPct =
    sessionTotal > 0
      ? Math.round(((streamTypes[0]?.count ?? 0) / sessionTotal) * 100)
      : 0;
  const topReason = [...stats.transcodeReasons].sort(
    (a, b) => b.count - a.count,
  )[0];
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
  const peakHour = hourData.indexOf(Math.max(...hourData, 0));

  return (
    <div>
      <KpiStrip kpis={kpis} />

      {/* Trends 2×2 */}
      <section style={{ marginBottom: 22 }}>
        <div className="resp-grid-2" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {trends.map((tr) => {
            const peak = Math.max(...tr.data, 0);
            // Divide by the full window, not t.data.length: the query skips
            // days with no activity, so the array can be shorter than `days`.
            const avg =
              days > 0 ? tr.data.reduce((s, v) => s + v, 0) / days : 0;
            return (
              <ActivityCard key={tr.label}>
                <SectionHeader
                  label={tr.label}
                  sub={t("adminActivity.stats.lastDaysPeak", { days, peak: `${peak.toLocaleString(locale)}${tr.unit}` })}
                  right={
                    <span
                      className="ds-mono"
                      style={{
                        fontSize: 10.5,
                        color: "var(--ds-fg-subtle)",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {t("adminActivity.stats.avg", { value: `${avg.toFixed(1)}${tr.unit}` })}
                    </span>
                  }
                />
                <AreaChart
                  data={tr.data}
                  h={120}
                  color={tr.color}
                  labels={tr.days.map((d) => shortDay(d, locale))}
                  valueSuffix={tr.unit ? ` ${tr.unit}` : ""}
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
                  {axisLabels(tr.days, locale).map((l, i) => (
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
              sub={t("adminActivity.stats.nOfTotal", { n: stats.topUsers.length, total: stats.uniqueViewers })}
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
                      src={m.posterPath ? posterUrl(m.posterPath, "w342") : null}
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
                      src={m.posterPath ? posterUrl(m.posterPath, "w342") : null}
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
        <div className="resp-grid-3" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
          <ActivityCard>
            <SectionHeader label={t("adminActivity.popover.resolution")} />
            <HorizontalBars
              items={stats.resolutionBreakdown.map((r) => ({
                label: r.bucket,
                count: r.count,
              }))}
              color="oklch(0.68 0.16 158)"
              labelWidth={70}
            />
          </ActivityCard>
          <ActivityCard>
            <SectionHeader label={t("adminActivity.field.videoCodec")} />
            <HorizontalBars
              items={stats.videoCodecBreakdown.map((r) => ({
                label: r.codec,
                count: r.count,
              }))}
              labelWidth={70}
            />
          </ActivityCard>
          <ActivityCard>
            <SectionHeader label={t("adminActivity.stats.audioCodec")} />
            <HorizontalBars
              items={stats.audioCodecBreakdown.map((r) => ({
                label: r.codec,
                count: r.count,
              }))}
              color="oklch(0.62 0.14 295)"
              labelWidth={70}
            />
          </ActivityCard>
          <ActivityCard>
            <SectionHeader label={t("adminActivity.field.container")} />
            <HorizontalBars
              items={stats.containerBreakdown.map((r) => ({
                label: r.container,
                count: r.count,
              }))}
              color="oklch(0.78 0.16 75)"
              labelWidth={70}
            />
          </ActivityCard>
          <ActivityCard>
            <SectionHeader label={t("adminActivity.field.bitrate")} sub={t("adminActivity.stats.distribution")} />
            <HorizontalBars
              items={stats.bitrateBuckets.map((r) => ({
                label: r.bucket,
                count: r.count,
              }))}
              color="oklch(0.72 0.13 220)"
              labelWidth={92}
            />
          </ActivityCard>
          <ActivityCard>
            <SectionHeader label={t("adminActivity.stats.topPlayers")} sub={t("adminActivity.stats.clientApps")} />
            <HorizontalBars
              items={stats.topPlayers
                .slice(0, 8)
                .map((r) => ({ label: r.player, count: r.count }))}
              color="oklch(0.62 0.14 295)"
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
              sub={t("adminActivity.stats.transcodedSessions", { n: transcodeTotal.toLocaleString(locale), pct: transcodePct })}
            />
            <HorizontalBars
              items={stats.transcodeReasons.map((r) => ({
                label: r.reason,
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
                  background: "oklch(0.78 0.16 75 / 0.06)",
                  border: "1px solid oklch(0.78 0.16 75 / 0.18)",
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
                    {topReason.reason === "Unknown" ? (
                      <>{t("adminActivity.stats.noReason", { pct: topReasonPct })}</>
                    ) : (
                      <>
                        {(() => {
                          const [before, after] = t("adminActivity.stats.causedBy", {
                            pct: topReasonPct,
                            reason: "\u0000",
                          }).split("\u0000");
                          return (
                            <>
                              {before}
                              <span style={{ color: "var(--ds-fg)" }}>
                                {topReason.reason.toLowerCase()}
                              </span>
                              {after}
                            </>
                          );
                        })()}
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
            <SectionHeader label={t("adminActivity.stats.dayOfWeek")} sub={t("adminActivity.stats.playsByWeekday")} />
            <HorizontalBars items={dowItems} labelWidth={42} />
          </ActivityCard>
          <ActivityCard>
            <SectionHeader
              label={t("adminActivity.stats.hourOfDay")}
              sub={t("adminActivity.stats.hourDistribution")}
              right={
                <span
                  className="ds-mono"
                  style={{
                    fontSize: 10.5,
                    color: "var(--ds-fg-subtle)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {t("adminActivity.stats.peakHour", { hour: `${peakHour}:00`, count: Math.max(...hourData, 0) })}
                </span>
              }
            />
            <BarColumn data={hourData} h={120} />
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
              items={stats.playsByPlatform
                .slice(0, 8)
                .map((p) => ({ label: p.platform, count: p.count }))}
              labelWidth={100}
            />
          </ActivityCard>
          <ActivityCard>
            <SectionHeader
              label={t("adminActivity.user.devices")}
              sub={t("adminActivity.user.known", { count: stats.topDevices.length })}
            />
            <HorizontalBars
              items={stats.topDevices
                .slice(0, 8)
                .map((d) => ({ label: d.device, count: d.count }))}
              color="oklch(0.62 0.14 295)"
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
                label: d.decade,
                count: d.count,
              }))}
              color="oklch(0.78 0.16 75)"
              labelWidth={56}
            />
          </ActivityCard>
        </div>
      </section>
    </div>
  );
}

function Empty() {
  const t = useT();
  return (
    <div
      style={{
        fontSize: 12,
        color: "var(--ds-fg-subtle)",
        padding: "20px 0",
        textAlign: "center",
      }}
    >
      {t("adminActivity.common.noDataYet")}
    </div>
  );
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
