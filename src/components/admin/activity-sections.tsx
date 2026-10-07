"use client";

// Sections of the admin Activity overview page. These components only draw
// what they are given: every time, label and total is worked out on the
// server in page.tsx and passed in as props, so nothing here calls
// Date.now()/new Date() while rendering (CLAUDE.md guardrail 16). The file is
// "use client" only because the shared chart pieces call React's useId().

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
import { useLocale, useT } from "@/components/i18n/i18n-provider";

/* ── KPI strip ────────────────────────────────────────────────── */

export interface Kpi {
  label: string;
  value: string;
  delta?: { text: string; dir: "up" | "down" | "flat" } | null;
  spark?: number[];
  // Tooltip label for each sparkline point (sparkLabels[i] goes with spark[i]).
  // Built on the server; never build these from a Date in the browser (guardrail 16).
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
          borderRadius: "var(--ds-r-lg)",
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
                  color: "var(--ds-fg-subtle)",
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
  const t = useT();
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
            label={t("adminActivity.overview.playsPerDay", { days })}
            sub={peakSub}
          />
          <AreaChart
            data={playsByDay}
            h={160}
            labels={playsByDayLabels}
            valueSuffix={t("adminActivity.common.playsSuffix")}
          />
          <div
            className="ds-mono"
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginTop: 8,
              fontSize: 9.5,
              color: "var(--ds-fg-subtle)",
            }}
          >
            {axisLabels.map((l, i) => (
              <span key={i}>{l}</span>
            ))}
          </div>
        </ActivityCard>
        <ActivityCard>
          <SectionHeader label={t("adminActivity.overview.dayHour")} sub={t("adminActivity.overview.dayHourSub")} />
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
          <SectionHeader label={t("adminActivity.overview.streamMix")} sub={t("adminActivity.common.lastDays", { days })} />
          <DistributionList rows={streamMix} />
          <hr
            style={{
              border: 0,
              borderTop: "1px solid var(--ds-border)",
              margin: "12px 0",
            }}
          />
          <SectionHeader label={t("adminActivity.overview.mediaMix")} />
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

// The same centred 12px block HorizontalBars shows for an empty list, so an
// empty leaderboard reads like every neighbouring empty card instead of a
// header over 300px of blank space.
function NoData() {
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
  const t = useT();
  const locale = useLocale();
  // One decimal, locale-separated — beside the Intl-formatted play counts, a
  // bare toFixed(1) mixed "1.234 plays" with "12.3h" for a de/fr/pt/it admin.
  const dec1 = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const hoursSuffix = t("adminActivity.common.hoursSuffix");
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
            label={t("adminActivity.overview.topViewers")}
            sub={t("adminActivity.overview.usersDays", { count: users.length, days })}
          />
          {users.length === 0 && <NoData />}
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
                    color: "var(--ds-fg-subtle)",
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
                      {dec1.format(u.hours)}{hoursSuffix}{" "}
                      <span style={{ color: "var(--ds-fg-subtle)" }}>
                        · {t("adminActivity.common.plays", { count: u.plays })}
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
            label={t("adminActivity.overview.mostRewatched")}
            sub={t("adminActivity.overview.libraryChampions", { days })}
          />
          {rewatched.length === 0 && <NoData />}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {rewatched.map((m, i) => (
              <Link
                key={`${m.tmdbId}-${i}`}
                href={`/admin/activity/media/${m.tmdbId}?type=${m.mediaType}`}
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
                          color: "var(--ds-fg-subtle)",
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
                      <span style={{ color: "var(--ds-fg-subtle)" }}>
                        · {t("adminActivity.common.viewers", { count: m.viewers })}
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
  const t = useT();
  const locale = useLocale();
  return (
    <section style={{ marginBottom: 22 }}>
      <ActivityCard>
        <SectionHeader
          label={t("adminActivity.calendar.title")}
          sub={t("adminActivity.calendar.sub", { count: activeDays, n: activeDays.toLocaleString(locale) })}
          right={
            <span
              className="ds-mono"
              style={{ fontSize: 10.5, color: "var(--ds-fg-subtle)" }}
            >
              {t("adminActivity.calendar.total", { count: totalPlays, n: totalPlays.toLocaleString(locale) })}
            </span>
          }
        />
        {children}
      </ActivityCard>
    </section>
  );
}
