"use client";

// Refined Activity overview sections, ported from the Claude Design
// "Activity Page" handoff (sections.jsx). These are pure render-from-props
// components — every time/label/aggregate is computed server-side in
// page.tsx and passed down, so there is no Date.now()/new Date() in the
// client render path (CLAUDE.md guardrail 16). The module is "use client"
// only because the shared chart primitives call useId().

import Link from "next/link";
import type { ReactNode } from "react";
import {
  ActivityCard,
  AreaChart,
  Avatar,
  DistributionList,
  HourHeatmap,
  Poster,
  SectionHeader,
  Sparkline,
  sourceDotColor,
} from "@/components/admin/activity-ui";

/* ── KPI strip ────────────────────────────────────────────────── */

export interface Kpi {
  label: string;
  value: string;
  delta?: { text: string; dir: "up" | "down" | "flat" } | null;
  spark?: number[];
  // Precomputed server-side per-point labels for the sparkline tooltip
  // (element i ↔ spark[i]). Never derive from Date client-side — guardrail 16.
  sparkLabels?: string[];
  sparkSuffix?: string;
  sub?: string;
}

export function KpiStrip({ kpis }: { kpis: Kpi[] }) {
  return (
    <section style={{ marginBottom: 22 }}>
      <div
        className="resp-kpi"
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${kpis.length}, minmax(0, 1fr))`,
          gap: 0,
          background: "var(--ds-bg-2)",
          border: "1px solid var(--ds-border)",
          borderRadius: 10,
          overflow: "hidden",
        }}
      >
        {kpis.map((k, i) => {
          // Long values shrink slightly so they never wrap in the strip.
          const valueLen = k.value.length;
          const valueSize = valueLen > 7 ? 17 : valueLen > 5 ? 20 : 22;
          return (
            <div
              key={k.label}
              style={{
                padding: "14px 14px",
                borderRight:
                  i < kpis.length - 1 ? "1px solid var(--ds-border)" : "none",
                display: "flex",
                flexDirection: "column",
                gap: 6,
                minWidth: 0,
                overflow: "hidden",
              }}
            >
              <div
                className="ds-mono uppercase"
                style={{
                  fontSize: 9.5,
                  color: "var(--ds-fg-disabled)",
                  letterSpacing: "0.1em",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {k.label}
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 6,
                  whiteSpace: "nowrap",
                  minWidth: 0,
                }}
              >
                <span
                  style={{
                    fontSize: valueSize,
                    fontWeight: 600,
                    letterSpacing: "-0.025em",
                    color: "var(--ds-fg)",
                    fontVariantNumeric: "tabular-nums",
                    whiteSpace: "nowrap",
                  }}
                >
                  {k.value}
                </span>
                {k.delta && (
                  <span
                    className="ds-mono"
                    style={{
                      fontSize: 10.5,
                      color:
                        k.delta.dir === "up"
                          ? "var(--ds-success)"
                          : k.delta.dir === "down"
                            ? "var(--ds-danger)"
                            : "var(--ds-fg-subtle)",
                      fontVariantNumeric: "tabular-nums",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {k.delta.dir === "up"
                      ? "↑"
                      : k.delta.dir === "down"
                        ? "↓"
                        : ""}{" "}
                    {k.delta.text}
                  </span>
                )}
              </div>
              {k.spark && k.spark.length > 1 ? (
                <Sparkline
                  data={k.spark}
                  w={140}
                  h={22}
                  labels={k.sparkLabels}
                  valueSuffix={k.sparkSuffix ?? ""}
                />
              ) : k.sub ? (
                <span
                  className="ds-mono"
                  style={{
                    fontSize: 10.5,
                    color: "var(--ds-fg-subtle)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {k.sub}
                </span>
              ) : (
                <span style={{ height: 22 }} />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* ── Analytics row ────────────────────────────────────────────── */

interface DistRow {
  label: string;
  pct: number;
  value: string;
  color: string;
}

export function AnalyticsRow({
  playsByDay,
  heatmapMatrix,
  heatmapDetailBase,
  streamMix,
  mediaMix,
  days,
  peakSub,
  axisLabels,
  playsByDayLabels,
  heatmapInsight,
}: {
  playsByDay: number[];
  heatmapMatrix: number[][];
  // Forwarded to HourHeatmap so its cells open the drill-down popover.
  heatmapDetailBase?: { userId?: string; source?: string; mediaType?: string; days?: number };
  streamMix: DistRow[];
  mediaMix: DistRow[];
  days: number;
  peakSub: string;
  axisLabels: string[];
  // Per-point date labels for the area-chart hover tooltip (server-computed).
  playsByDayLabels: string[];
  heatmapInsight: string;
}) {
  return (
    <section style={{ marginBottom: 22 }}>
      <div
        className="resp-analytics"
        style={{
          display: "grid",
          gridTemplateColumns: "1.5fr 1.2fr 1fr",
          gap: 10,
        }}
      >
        <ActivityCard>
          <SectionHeader
            label={`Plays per day · last ${days}d`}
            sub={peakSub}
          />
          <AreaChart
            data={playsByDay}
            h={160}
            labels={playsByDayLabels}
            valueSuffix=" plays"
          />
          <div
            className="ds-mono"
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginTop: 8,
              fontSize: 9.5,
              color: "var(--ds-fg-disabled)",
            }}
          >
            {axisLabels.map((l, i) => (
              <span key={i}>{l}</span>
            ))}
          </div>
        </ActivityCard>
        <ActivityCard>
          <SectionHeader label="Day × hour" sub="when watching happens" />
          <HourHeatmap matrix={heatmapMatrix} detailBase={heatmapDetailBase} />
          <div
            className="ds-mono"
            style={{
              marginTop: 10,
              fontSize: 10.5,
              color: "var(--ds-fg-subtle)",
            }}
          >
            {heatmapInsight}
          </div>
        </ActivityCard>
        <ActivityCard>
          <SectionHeader label="Stream mix" sub={`last ${days}d`} />
          <DistributionList rows={streamMix} />
          <hr
            style={{
              border: 0,
              borderTop: "1px solid var(--ds-border)",
              margin: "12px 0",
            }}
          />
          <SectionHeader label="Media mix" />
          <DistributionList rows={mediaMix} />
        </ActivityCard>
      </div>
    </section>
  );
}

/* ── Leaderboards ─────────────────────────────────────────────── */

export interface LeaderUser {
  id: string;
  username: string;
  source: string;
  hours: number;
  plays: number;
  rank: number;
}

export interface RewatchedTitle {
  tmdbId: number;
  mediaType: string;
  title: string;
  plays: number;
  viewers: number;
  rank: number;
  posterSrc?: string | null;
}

const POSTER_ACCENTS = [
  "oklch(0.42 0.08 60)",
  "oklch(0.32 0.06 230)",
  "oklch(0.36 0.10 30)",
  "oklch(0.40 0.08 145)",
  "oklch(0.38 0.10 320)",
  "oklch(0.34 0.08 195)",
];

export function Leaderboards({
  users,
  rewatched,
  showPosters = true,
  days,
}: {
  users: LeaderUser[];
  rewatched: RewatchedTitle[];
  showPosters?: boolean;
  days: number;
}) {
  const maxHours = Math.max(...users.map((u) => u.hours), 1);
  const maxPlays = Math.max(...rewatched.map((m) => m.plays), 1);
  return (
    <section style={{ marginBottom: 22 }}>
      <div
        className="resp-grid-2"
        style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}
      >
        <ActivityCard>
          <SectionHeader
            label="Top viewers · watch time"
            sub={`${users.length} users · ${days}d`}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {users.map((u, i) => (
              <Link
                key={u.id}
                href={`/admin/activity/user/${u.id}`}
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
                  {u.rank.toString().padStart(2, "0")}
                </span>
                {showPosters && (
                  <Avatar
                    letter={(u.username[0] ?? "?").toUpperCase()}
                    accent={POSTER_ACCENTS[i % POSTER_ACCENTS.length]}
                    size={26}
                  />
                )}
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
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {u.username}
                      <span
                        style={{
                          marginLeft: 6,
                          width: 5,
                          height: 5,
                          display: "inline-block",
                          borderRadius: 999,
                          background: sourceDotColor(u.source),
                          verticalAlign: "middle",
                        }}
                      />
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
                      {u.hours.toFixed(1)}h{" "}
                      <span style={{ color: "var(--ds-fg-disabled)" }}>
                        · {u.plays} plays
                      </span>
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
                        width: `${(u.hours / maxHours) * 100}%`,
                        height: "100%",
                        background: "var(--ds-accent)",
                        borderRadius: 999,
                      }}
                    />
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </ActivityCard>
        <ActivityCard>
          <SectionHeader
            label="Most rewatched"
            sub={`library champions · ${days}d`}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {rewatched.map((m, i) => (
              <Link
                key={`${m.tmdbId}-${i}`}
                href={`/admin/activity/media/${m.tmdbId}`}
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
                  }}
                >
                  {m.rank.toString().padStart(2, "0")}
                </span>
                {showPosters && (
                  <Poster
                    src={m.posterSrc}
                    letter={(m.title[0] ?? "?").toUpperCase()}
                    accent={POSTER_ACCENTS[i % POSTER_ACCENTS.length]}
                    w={26}
                    h={36}
                    radius={3}
                  />
                )}
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
                      {m.plays}{" "}
                      <span style={{ color: "var(--ds-fg-disabled)" }}>
                        · {m.viewers} viewers
                      </span>
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
                        width: `${(m.plays / maxPlays) * 100}%`,
                        height: "100%",
                        background: "var(--ds-accent)",
                        borderRadius: 999,
                      }}
                    />
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </ActivityCard>
      </div>
    </section>
  );
}

/* ── 365-day calendar section ─────────────────────────────────── */

export function CalendarSection({
  activeDays,
  totalPlays,
  children,
}: {
  activeDays: number;
  totalPlays: number;
  children: ReactNode;
}) {
  return (
    <section style={{ marginBottom: 22 }}>
      <ActivityCard>
        <SectionHeader
          label="365-day activity"
          sub={`${activeDays.toLocaleString("en-US")} active days · always the last 365 days, independent of the period filter`}
          right={
            <span
              className="ds-mono"
              style={{ fontSize: 10.5, color: "var(--ds-fg-subtle)" }}
            >
              Total {totalPlays.toLocaleString("en-US")} plays
            </span>
          }
        />
        {children}
      </ActivityCard>
    </section>
  );
}
