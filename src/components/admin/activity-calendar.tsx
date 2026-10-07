"use client";

// GitHub-style 365-day heatmap: one small square per day, darker = more plays.
// The data comes from getActivityCalendarUncached() in play-history.ts.

import { useState } from "react";
import {
  HeatmapCellPopover,
  type HeatmapCellAnchor,
} from "@/components/admin/heatmap-cell-popover";
import { useLocale, useT } from "@/components/i18n/i18n-provider";

// Sun-first gutter: catalog keys for the labelled rows, translated at render.
const DOW_LABEL_KEYS = ["", "adminActivity.weekday.mon", "", "adminActivity.weekday.wed", "", "adminActivity.weekday.fri", ""];
const CELL = 11;
const GAP = 2;

interface CalendarData {
  day: string;
  count: number;
}

// Maps a day's play count to an accent wash whose strength scales with
// intensity (count/max), so the heatmap follows the chosen accent. Count 0
// renders a faint fg tint — strong enough (7%) to keep the grid visible on the
// white light-theme card, where 2.5% was ~1.05:1 and vanished.
//
// The ramp has a 30% FLOOR for any activity: with the old 12% floor a 1–3-play
// day on a server whose busiest day is 40 landed at 12–18% accent, which over
// either theme's card is within ~0.01 L of the 7%-of-fg zero cell — so the
// typical active day on a home server read as empty. The legend swatches call
// the same function, so they follow the floor automatically.
function cellBg(count: number, max: number): string {
  if (count === 0) return "color-mix(in oklab, var(--ds-fg) 7%, transparent)";
  const intensity = max > 0 ? count / max : 0;
  return `color-mix(in oklab, var(--ds-accent) ${(30 + intensity * 60).toFixed(1)}%, transparent)`;
}

// `today` arrives as an ISO date string from the server page so the server
// render and the browser's hydration agree on the 365-day window. DO NOT
// replace it with `new Date()` in render: the server and the browser would
// read the clock at different moments (and possibly on different days), and
// React reports that mismatch as hydration error #418 (guardrail 16).
export function ActivityCalendar({
  data,
  today: todayIso,
  detailBase,
}: {
  data: CalendarData[];
  today: string;
  // When provided, day cells with plays become clickable and open the
  // drill-down popover. Holds the fixed filter context (everything except the
  // clicked day, which is filled in on click). Omit to render a static calendar.
  // `historyPath` (e.g. "/admin/activity") enables the popover's "View these
  // plays" deep-link; omit it on pages with no history table (user detail).
  detailBase?: { userId?: string; source?: string; mediaType?: string; historyPath?: string };
}) {
  const t = useT();
  const locale = useLocale();
  const [selected, setSelected] = useState<
    {
      queryString: string;
      anchor: HeatmapCellAnchor;
      label: string;
      viewPlaysHref?: string;
    } | null
  >(null);

  function openCell(el: HTMLDivElement, date: string, count: number) {
    if (!detailBase || count === 0) return;
    const rect = el.getBoundingClientRect();
    const params = new URLSearchParams({ mode: "day", day: date });
    if (detailBase.userId) params.set("userId", detailBase.userId);
    if (detailBase.source) params.set("source", detailBase.source);
    if (detailBase.mediaType) params.set("mediaType", detailBase.mediaType);
    // Date formatting in an event handler runs only client-side (never during
    // SSR/hydration), so new Date() here is safe — see guardrail 16.
    const label = new Date(`${date}T00:00:00Z`).toLocaleDateString(locale, {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
    let viewPlaysHref: string | undefined;
    if (detailBase.historyPath) {
      // watched=true: the cell count and the popover count only watched plays,
      // so the history table must open on the same filter or it lists more rows
      // than the number that was clicked.
      const hp = new URLSearchParams({ from: date, to: date, watched: "true" });
      if (detailBase.source) hp.set("source", detailBase.source);
      if (detailBase.mediaType) hp.set("mediaType", detailBase.mediaType);
      viewPlaysHref = `${detailBase.historyPath}?${hp.toString()}`;
    }
    setSelected({
      queryString: params.toString(),
      anchor: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
      label,
      viewPlaysHref,
    });
  }

  const countMap = new Map(data.map((d) => [d.day, d.count]));
  // `max` is floored at 1 so the colour maths never divides by zero; `peak`
  // is the real busiest day, which is 0 when there were no plays at all.
  const max = Math.max(...data.map((d) => d.count), 1);
  const peak = Math.max(...data.map((d) => d.count), 0);
  const totalPlays = data.reduce((sum, d) => sum + d.count, 0);
  const activeDays = data.filter((d) => d.count > 0).length;

  const today = new Date(todayIso);
  const days: { date: string; dow: number }[] = [];
  for (let i = 364; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    days.push({ date: d.toISOString().split("T")[0], dow: d.getUTCDay() });
  }

  const weeks: { date: string; dow: number; count: number }[][] = [];
  let currentWeek: { date: string; dow: number; count: number }[] = [];
  for (const day of days) {
    if (day.dow === 0 && currentWeek.length > 0) {
      weeks.push(currentWeek);
      currentWeek = [];
    }
    currentWeek.push({ ...day, count: countMap.get(day.date) ?? 0 });
  }
  if (currentWeek.length > 0) weeks.push(currentWeek);

  const monthLabels: { label: string; weekIndex: number }[] = [];
  let lastMonth = -1;
  weeks.forEach((week, wi) => {
    const firstDay = week[0];
    if (firstDay) {
      const month = new Date(firstDay.date).getUTCMonth();
      if (month !== lastMonth) {
        monthLabels.push({
          label: new Date(firstDay.date).toLocaleString(locale, {
            month: "short",
            timeZone: "UTC",
          }),
          weekIndex: wi,
        });
        lastMonth = month;
      }
    }
  });

  return (
    <div>
      <p
        className="sm:hidden ds-mono"
        style={{
          fontSize: 10.5,
          color: "var(--ds-fg-subtle)",
          marginBottom: 6,
          userSelect: "none",
        }}
      >
        {t("adminActivity.calendar.swipe")}
      </p>
      <div className="overflow-x-auto">
        <div
          // role="img" hides everything inside from screen readers, so it is
          // only used when the cells are not clickable. Clickable cells need a
          // "group" so their role="button" stays reachable.
          role={detailBase ? "group" : "img"}
          aria-label={t("adminActivity.calendar.aria", {
            total: totalPlays.toLocaleString(locale),
            activeDays,
            peak,
          })}
          style={{ minWidth: 700 }}
        >
          {/* Month labels. Informational text reads in --ds-fg-subtle, never
              --ds-fg-disabled (~1.8:1 dark / ~2.5:1 light — guardrail 42);
              the disabled token is for "—" placeholders and chevrons only. */}
          <div style={{ display: "flex", marginLeft: 26, marginBottom: 6, gap: GAP }}>
            {weeks.map((_, wi) => {
              const ml = monthLabels.find((m) => m.weekIndex === wi);
              return (
                <div
                  key={wi}
                  className="ds-mono"
                  style={{
                    width: CELL,
                    fontSize: 9.5,
                    color: "var(--ds-fg-subtle)",
                    flexShrink: 0,
                    whiteSpace: "nowrap",
                  }}
                >
                  {ml?.label ?? ""}
                </div>
              );
            })}
          </div>

          <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
            {/* Day-of-week gutter */}
            <div
              style={{ display: "flex", flexDirection: "column", gap: GAP }}
            >
              {DOW_LABEL_KEYS.map((key, i) => (
                <div
                  key={i}
                  className="ds-mono"
                  style={{
                    height: CELL,
                    lineHeight: `${CELL}px`,
                    fontSize: 9.5,
                    color: "var(--ds-fg-subtle)",
                    textAlign: "right",
                    width: 20,
                  }}
                >
                  {key ? t(key) : ""}
                </div>
              ))}
            </div>

            {/* Cells */}
            <div style={{ display: "flex", gap: GAP }}>
              {weeks.map((week, wi) => (
                <div
                  key={wi}
                  style={{ display: "flex", flexDirection: "column", gap: GAP }}
                >
                  {wi === 0 &&
                    Array.from({ length: week[0]?.dow ?? 0 }, (_, i) => (
                      <div
                        key={`empty-${i}`}
                        style={{ width: CELL, height: CELL }}
                      />
                    ))}
                  {week.map((day) => {
                    const clickable = !!detailBase && day.count > 0;
                    return (
                      <div
                        key={day.date}
                        title={t("adminActivity.calendar.cellTitle", { date: day.date, count: day.count })}
                        role={clickable ? "button" : undefined}
                        tabIndex={clickable ? 0 : undefined}
                        onClick={
                          clickable
                            ? (e) => openCell(e.currentTarget, day.date, day.count)
                            : undefined
                        }
                        onKeyDown={
                          clickable
                            ? (e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  openCell(e.currentTarget, day.date, day.count);
                                }
                              }
                            : undefined
                        }
                        style={{
                          width: CELL,
                          height: CELL,
                          borderRadius: 2,
                          background: cellBg(day.count, max),
                          cursor: clickable ? "pointer" : "default",
                        }}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>

          {/* Legend */}
          <div
            className="ds-mono"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginTop: 10,
              marginLeft: 26,
              fontSize: 10,
              color: "var(--ds-fg-subtle)",
            }}
          >
            <span>{t("adminActivity.calendar.less")}</span>
            {[0, 0.25, 0.5, 0.75, 1].map((level) => (
              <div
                key={level}
                style={{
                  width: CELL,
                  height: CELL,
                  borderRadius: 2,
                  background: cellBg(level === 0 ? 0 : level * max, max),
                }}
              />
            ))}
            <span>{t("adminActivity.calendar.more")}</span>
            <span style={{ marginLeft: "auto" }}>
              {t("adminActivity.calendar.daysUtc")}
            </span>
          </div>
        </div>
      </div>
      {selected && (
        <HeatmapCellPopover
          queryString={selected.queryString}
          anchor={selected.anchor}
          label={selected.label}
          viewPlaysHref={selected.viewPlaysHref}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
