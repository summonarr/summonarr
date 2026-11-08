"use client";

// Sections of the admin Activity overview page. These components only draw
// what they are given: every time, label and total is worked out on the
// server in page.tsx and passed in as props, so nothing here calls
// Date.now()/new Date() while rendering (CLAUDE.md guardrail 16). The file is
// "use client" only because the shared chart pieces call React's useId().

import type { ReactNode } from "react";
import {
  ActivityCard,
  AreaChart,
  Avatar,
  DistributionList,
  Empty,
  HourHeatmap,
  LeaderboardRow,
  Poster,
  SectionHeader,
  Sparkline,
} from "@/components/admin/activity-ui";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { accentFor } from "@/components/admin/activity-accent";
import { mediaTypeLabel } from "@/components/admin/activity-history/helpers";

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

// Long values shrink a step so they never wrap in the strip.
function kpiValueSize(value: string): number {
  return value.length > 7 ? 17 : value.length > 5 ? 20 : 22;
}

const DELTA_STYLE: Record<NonNullable<Kpi["delta"]>["dir"], { color: string; arrow: string }> = {
  up: { color: "var(--ds-success)", arrow: "↑" },
  down: { color: "var(--ds-danger)", arrow: "↓" },
  flat: { color: "var(--ds-fg-subtle)", arrow: "" },
};

function KpiCell({ k, last }: { k: Kpi; last: boolean }) {
  const delta = k.delta ? DELTA_STYLE[k.delta.dir] : null;
  return (
    <div
      style={{
        padding: "14px 14px",
        borderRight: last ? "none" : "1px solid var(--ds-border)",
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
            fontSize: kpiValueSize(k.value),
            fontWeight: 600,
            letterSpacing: "-0.025em",
            color: "var(--ds-fg)",
            fontVariantNumeric: "tabular-nums",
            whiteSpace: "nowrap",
          }}
        >
          {k.value}
        </span>
        {k.delta && delta && (
          <span
            className="ds-mono"
            style={{
              fontSize: 10.5,
              color: delta.color,
              fontVariantNumeric: "tabular-nums",
              whiteSpace: "nowrap",
            }}
          >
            {delta.arrow}{" "}
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
        {kpis.map((k, i) => (
          <KpiCell key={k.label} k={k} last={i === kpis.length - 1} />
        ))}
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
  timeZone,
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
  // The statistics zone the heatmap's hours are in (getPlayHistoryStats names it).
  timeZone: string;
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
          gridTemplateColumns: "minmax(0, 1.5fr) minmax(0, 1.2fr) minmax(0, 1fr)",
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
          <HourHeatmap matrix={heatmapMatrix} detailBase={heatmapDetailBase} timeZone={timeZone} />
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

// One leaderboard card: its header, an empty note when there are no rows,
// and the rows themselves.
function LeaderboardCard({ label, sub, empty, children }: { label: string; sub: string; empty: boolean; children: ReactNode }) {
  return (
    <ActivityCard>
      <SectionHeader label={label} sub={sub} />
      {empty && <Empty />}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{children}</div>
    </ActivityCard>
  );
}

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
  // Scaled to the real leader (only a zero is guarded), so a #1 under an hour
  // still gets a full bar; a floor of 1 drew a 0.4 h leader at 40%.
  const maxHours = Math.max(0, ...users.map((u) => u.hours)) || 1;
  const maxPlays = Math.max(...rewatched.map((m) => m.plays), 1);
  // Accents are hashed from the person or title (activity-accent.ts), so a
  // row keeps its colour when the ranking moves, and a title matches its Now
  // playing card.
  return (
    <section style={{ marginBottom: 22 }}>
      <div
        className="resp-grid-2"
        style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}
      >
        <LeaderboardCard
          label={t("adminActivity.overview.topViewers")}
          sub={t("adminActivity.overview.usersDays", { count: users.length, days })}
          empty={users.length === 0}
        >
          {users.map((u) => (
            <LeaderboardRow
              key={u.id}
              href={`/admin/activity/user/${u.id}`}
              rank={u.rank}
              avatar={
                showPosters && (
                  <Avatar
                    letter={(u.username[0] ?? "?").toUpperCase()}
                    accent={accentFor(u.id)}
                    size={26}
                  />
                )
              }
              title={u.username}
              source={u.source}
              primary={`${dec1.format(u.hours)}${hoursSuffix}`}
              secondary={t("adminActivity.common.playsFormatted", { count: u.plays, n: u.plays.toLocaleString(locale) })}
              pct={(u.hours / maxHours) * 100}
            />
          ))}
        </LeaderboardCard>
        <LeaderboardCard
          label={t("adminActivity.overview.mostRewatched")}
          sub={t("adminActivity.overview.libraryChampions", { days })}
          empty={rewatched.length === 0}
        >
          {rewatched.map((m) => (
            <LeaderboardRow
              key={`${m.mediaType}-${m.tmdbId}`}
              href={`/admin/activity/media/${m.tmdbId}?type=${m.mediaType}`}
              rank={m.rank}
              avatar={
                showPosters && (
                  <Poster
                    src={m.posterSrc}
                    letter={(m.title[0] ?? "?").toUpperCase()}
                    accent={accentFor(m.title)}
                    w={26}
                    h={36}
                    radius={3}
                  />
                )
              }
              title={m.title}
              tag={
                <span
                  className="ds-mono uppercase"
                  style={{
                    fontSize: 9,
                    color: "var(--ds-fg-subtle)",
                    letterSpacing: "0.06em",
                    flexShrink: 0,
                  }}
                >
                  {mediaTypeLabel(t, m.mediaType)}
                </span>
              }
              primary={m.plays.toLocaleString(locale)}
              secondary={t("adminActivity.common.viewers", { count: m.viewers })}
              pct={(m.plays / maxPlays) * 100}
            />
          ))}
        </LeaderboardCard>
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
