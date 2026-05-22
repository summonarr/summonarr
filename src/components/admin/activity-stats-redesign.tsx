"use client";

// Refined Stats tab, ported from the Claude Design "Activity Page" handoff
// (stats.jsx), wired to the real getPlayHistoryStats() result. Pure
// render-from-props; date labels are derived from fixed YYYY-MM-DD strings
// (deterministic — not Date.now()/new Date()-with-no-args, guardrail 16).

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

const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function shortDay(day: string): string {
  // Parse explicitly as UTC and format in UTC so SSR (UTC) and client (local
  // TZ) agree on the day label. Mirrors activity-calendar.tsx (guardrail 16).
  return new Date(`${day.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function axisLabels(days: string[]): string[] {
  if (days.length < 2) return days.map(shortDay);
  return [0, 0.25, 0.5, 0.75, 1].map((p) =>
    shortDay(days[Math.round(p * (days.length - 1))]),
  );
}

function delta(
  current: number,
  previous: number,
): Kpi["delta"] {
  if (previous === 0 && current === 0) return null;
  if (previous === 0) return { text: "new", dir: "up" };
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return { text: "0%", dir: "flat" };
  return { text: `${Math.abs(pct)}%`, dir: pct > 0 ? "up" : "down" };
}

const STREAM_META: Record<string, { label: string; color: string }> = {
  DirectPlay: { label: "Direct Play", color: "var(--ds-success)" },
  DirectStream: { label: "Remux", color: "var(--ds-info)" },
  Transcode: { label: "Transcode", color: "var(--ds-warning)" },
};

export function ActivityStatsRedesign({
  stats,
  days,
}: {
  stats: PlayHistoryStatsResult;
  days: number;
}) {
  const watchHours = Math.round(stats.totalWatchTimeHours);
  const repeatRate =
    stats.uniqueTitles > 0
      ? Math.round((stats.totalPlays / stats.uniqueTitles) * 10) / 10
      : 0;

  const kpis: Kpi[] = [
    {
      label: "Plays",
      value: stats.totalPlays.toLocaleString(),
      delta: delta(stats.totalPlays, stats.prevPeriod.totalPlays),
      spark: stats.playsByDay.map((d) => d.count),
    },
    {
      label: "Watch hours",
      value: `${watchHours.toLocaleString()}h`,
      delta: delta(watchHours, Math.round(stats.prevPeriod.totalWatchTimeHours)),
      spark: stats.watchTimeByDay.map((d) => d.hours),
    },
    {
      label: "Unique viewers",
      value: stats.uniqueViewers.toLocaleString(),
      delta: delta(stats.uniqueViewers, stats.prevPeriod.uniqueViewers),
      spark: stats.uniqueViewersByDay.map((d) => d.count),
    },
    {
      label: "Bandwidth",
      value:
        stats.totalBandwidthGB >= 1000
          ? `${(stats.totalBandwidthGB / 1000).toFixed(1)} TB`
          : `${stats.totalBandwidthGB} GB`,
      spark: stats.bandwidthByDay.map((d) => d.gb),
    },
    {
      label: "Repeat rate",
      value: `${repeatRate.toFixed(1)}×`,
      sub: `${stats.uniqueTitles.toLocaleString()} unique titles`,
    },
    {
      label: "Peak concurrency",
      value: stats.peakConcurrent.toLocaleString(),
      sub: "max simultaneous streams",
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
      label: "Plays per day",
      data: stats.playsByDay.map((d) => d.count),
      color: "var(--ds-accent)",
      unit: "",
      days: stats.playsByDay.map((d) => d.day),
    },
    {
      label: "Watch hours per day",
      data: stats.watchTimeByDay.map((d) => d.hours),
      color: "oklch(0.68 0.16 158)",
      unit: "h",
      days: stats.watchTimeByDay.map((d) => d.day),
    },
    {
      label: "Bandwidth per day",
      data: stats.bandwidthByDay.map((d) => d.gb),
      color: "oklch(0.72 0.13 220)",
      unit: "GB",
      days: stats.bandwidthByDay.map((d) => d.day),
    },
    {
      label: "Unique viewers per day",
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
    label: STREAM_META[m].label,
    count: stats.transcodeRatio.find((r) => r.method === m)?.count ?? 0,
    color: STREAM_META[m].color,
  }));
  const sourceSplit = stats.sourceSplit.map((r) => ({
    label: r.source === "plex" ? "Plex" : "Jellyfin",
    count: r.count,
    color: r.source === "plex" ? "var(--ds-plex)" : "var(--ds-jellyfin)",
  }));
  const transcodeTotal = stats.transcodeReasons.reduce(
    (s, r) => s + r.count,
    0,
  );
  const transcodePct =
    stats.totalPlays > 0
      ? Math.round(
          ((streamTypes[2]?.count ?? 0) / stats.totalPlays) * 100,
        )
      : 0;
  const directPct =
    stats.totalPlays > 0
      ? Math.round(((streamTypes[0]?.count ?? 0) / stats.totalPlays) * 100)
      : 0;
  const topReason = [...stats.transcodeReasons].sort(
    (a, b) => b.count - a.count,
  )[0];
  const topReasonPct =
    transcodeTotal > 0 && topReason
      ? Math.round((topReason.count / transcodeTotal) * 100)
      : 0;

  // playsByDow: Postgres DOW 0=Sun..6=Sat → design wants Mon-first.
  const dowItems = DOW_LABELS.map((label, i) => {
    const dow = (i + 1) % 7;
    return {
      label,
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
          {trends.map((t) => {
            const peak = Math.max(...t.data, 0);
            const avg =
              t.data.length > 0
                ? t.data.reduce((s, v) => s + v, 0) / t.data.length
                : 0;
            return (
              <ActivityCard key={t.label}>
                <SectionHeader
                  label={t.label}
                  sub={`last ${days}d · peak ${peak.toLocaleString()}${t.unit}`}
                  right={
                    <span
                      className="ds-mono"
                      style={{
                        fontSize: 10.5,
                        color: "var(--ds-fg-subtle)",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      avg {avg.toFixed(1)}
                      {t.unit}
                    </span>
                  }
                />
                <AreaChart
                  data={t.data}
                  h={120}
                  color={t.color}
                  labels={t.days.map(shortDay)}
                  valueSuffix={t.unit ? ` ${t.unit}` : ""}
                />
                <div
                  className="ds-mono"
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    marginTop: 6,
                    fontSize: 9.5,
                    color: "var(--ds-fg-disabled)",
                  }}
                >
                  {axisLabels(t.days).map((l, i) => (
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
              label="Top viewers"
              sub={`${stats.topUsers.length} of ${stats.uniqueViewers}`}
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
                  primary={`${u.count} plays`}
                  pct={(u.count / userMax) * 100}
                />
              ))}
            </div>
          </ActivityCard>
          <ActivityCard>
            <SectionHeader label="Top movies" sub={`${topMovies.length} ranked`} />
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {topMovies.map((m, i) => (
                <LbRow
                  key={m.tmdbId}
                  href={`/admin/activity/media/${m.tmdbId}`}
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
                  primary={`${m.plays} plays`}
                  secondary={`${m.viewers} viewers`}
                  pct={(m.plays / movieMax) * 100}
                />
              ))}
              {topMovies.length === 0 && <Empty />}
            </div>
          </ActivityCard>
          <ActivityCard>
            <SectionHeader label="Top TV" sub={`${topTV.length} ranked`} />
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {topTV.map((m, i) => (
                <LbRow
                  key={m.tmdbId}
                  href={`/admin/activity/media/${m.tmdbId}`}
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
                  primary={`${m.plays} plays`}
                  secondary={`${m.viewers} viewers`}
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
          label="Quality & infrastructure"
          sub={`how viewers stream · last ${days}d`}
        />
        <div className="resp-grid-3" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
          <ActivityCard>
            <SectionHeader label="Resolution" />
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
            <SectionHeader label="Video codec" />
            <HorizontalBars
              items={stats.videoCodecBreakdown.map((r) => ({
                label: r.codec,
                count: r.count,
              }))}
              labelWidth={70}
            />
          </ActivityCard>
          <ActivityCard>
            <SectionHeader label="Audio codec" />
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
            <SectionHeader label="Container" />
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
            <SectionHeader label="Bitrate" sub="distribution" />
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
            <SectionHeader label="Top players" sub="client apps" />
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
              label="Why we're transcoding"
              sub={`${transcodeTotal.toLocaleString()} transcoded sessions · ${transcodePct}% of plays`}
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
                      <>
                        {topReasonPct}% of transcodes have no recorded reason.
                        Reasons are captured from new sessions onward — this
                        clears as fresh playback data accumulates.
                      </>
                    ) : (
                      <>
                        {topReasonPct}% of transcodes are caused by{" "}
                        <span style={{ color: "var(--ds-fg)" }}>
                          {topReason.reason.toLowerCase()}
                        </span>
                        . Addressing it would meaningfully cut server
                        transcode load.
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}
          </ActivityCard>
          <ActivityCard>
            <SectionHeader
              label={`Stream method · ${days}d`}
              sub={`${directPct}% direct play`}
            />
            <StreamTypeBars data={streamTypes} />
            <hr
              style={{
                border: 0,
                borderTop: "1px solid var(--ds-border)",
                margin: "14px 0 12px",
              }}
            />
            <SectionHeader label="Source split" />
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
            <SectionHeader label="Day of week" sub="plays by weekday" />
            <HorizontalBars items={dowItems} labelWidth={42} />
          </ActivityCard>
          <ActivityCard>
            <SectionHeader
              label="Hour of day"
              sub="24-hour distribution"
              right={
                <span
                  className="ds-mono"
                  style={{
                    fontSize: 10.5,
                    color: "var(--ds-fg-subtle)",
                    whiteSpace: "nowrap",
                  }}
                >
                  peak {peakHour}:00 · {Math.max(...hourData, 0)} plays
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
                color: "var(--ds-fg-disabled)",
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
              label="Platforms"
              sub={`${stats.playsByPlatform.length} unique`}
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
              label="Devices"
              sub={`${stats.topDevices.length} known`}
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
              label="Movie decades"
              sub="release year · movies only"
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
  return (
    <div
      style={{
        fontSize: 12,
        color: "var(--ds-fg-disabled)",
        padding: "20px 0",
        textAlign: "center",
      }}
    >
      No data yet
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
          color: "var(--ds-fg-disabled)",
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
              <span style={{ color: "var(--ds-fg-disabled)" }}>
                {" "}
                · {secondary}
              </span>
            )}
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
