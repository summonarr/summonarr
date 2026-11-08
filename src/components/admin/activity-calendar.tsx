"use client";

// GitHub-style 365-day heatmap: one small square per day, darker = more plays.
// The data comes from getActivityCalendarUncached() in play-history.ts; the
// grid itself (days, columns, month labels, arrow-key targets) is worked out in
// activity-calendar-grid.ts and memoized, so moving the focus re-renders
// without rebuilding it.

import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  HeatmapCellPopover,
  type HeatmapCellAnchor,
} from "@/components/admin/heatmap-cell-popover";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { zoneShortLabel } from "@/lib/stats-time-zone";
import {
  buildCalendarModel,
  calendarKeyTarget,
  cellBg,
  type CalendarCell,
  type CalendarDayCount,
  type CalendarModel,
} from "./activity-calendar-grid";

// Sun-first gutter: catalog keys for the labelled rows, translated at render.
const DOW_LABEL_KEYS = ["", "adminActivity.weekday.mon", "", "adminActivity.weekday.wed", "", "adminActivity.weekday.fri", ""];
const CELL = 11;
const GAP = 2;

type DetailBase = { userId?: string; source?: string; mediaType?: string; historyPath?: string };

interface SelectedCell {
  queryString: string;
  anchor: HeatmapCellAnchor;
  label: string;
  viewPlaysHref?: string;
}

// The popover for a clicked day: its query, where it opens and its heading.
// Runs in an event handler only (never during SSR/hydration), so the Date
// formatting here is safe — see guardrail 16.
function selectedCellFor(el: HTMLDivElement, date: string, detailBase: DetailBase, locale: string): SelectedCell {
  const rect = el.getBoundingClientRect();
  const params = new URLSearchParams({ mode: "day", day: date });
  if (detailBase.userId) params.set("userId", detailBase.userId);
  if (detailBase.source) params.set("source", detailBase.source);
  if (detailBase.mediaType) params.set("mediaType", detailBase.mediaType);
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
  return {
    queryString: params.toString(),
    anchor: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
    label,
    viewPlaysHref,
  };
}

function MonthLabels({ model }: { model: CalendarModel }) {
  const byWeek = new Map(model.monthLabels.map((m) => [m.weekIndex, m.label]));
  // Informational text reads in --ds-fg-subtle, never --ds-fg-disabled
  // (~1.8:1 dark / ~2.5:1 light — guardrail 42); the disabled token is for "—"
  // placeholders and chevrons only.
  return (
    <div style={{ display: "flex", marginLeft: 26, marginBottom: 6, gap: GAP }}>
      {model.weeks.map((_, wi) => (
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
          {byWeek.get(wi) ?? ""}
        </div>
      ))}
    </div>
  );
}

function DayGutter() {
  const t = useT();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: GAP }}>
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
  );
}

function Legend({ max, timeZone }: { max: number; timeZone: string }) {
  const t = useT();
  return (
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
        <span title={t("adminActivity.stats.zoneDaysTitle", { zone: timeZone })}>
          {t("adminActivity.calendar.daysInZone", { zone: zoneShortLabel(timeZone) })}
        </span>
      </span>
    </div>
  );
}

// One day square. With a drill-down and plays it is a button in the roving
// tab order (`tabbable` marks the one Tab stop).
function DayCell({
  day,
  max,
  clickable,
  tabbable,
  cellRef,
  onFocus,
  onOpen,
  onKey,
}: {
  day: CalendarCell;
  max: number;
  clickable: boolean;
  tabbable: boolean;
  cellRef?: (el: HTMLDivElement | null) => void;
  onFocus: () => void;
  onOpen: (el: HTMLDivElement) => void;
  onKey: (e: KeyboardEvent<HTMLDivElement>) => void;
}) {
  const t = useT();
  return (
    <div
      ref={clickable ? cellRef : undefined}
      title={t("adminActivity.calendar.cellTitle", { date: day.date, count: day.count })}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? (tabbable ? 0 : -1) : undefined}
      // Outline, not a ring: a box-shadow would sit under the next cells,
      // which paint after this one.
      className={
        clickable
          ? "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color:var(--ds-fg)]"
          : undefined
      }
      onFocus={clickable ? onFocus : undefined}
      onClick={clickable ? (e) => onOpen(e.currentTarget) : undefined}
      onKeyDown={clickable ? onKey : undefined}
      style={{
        width: CELL,
        height: CELL,
        borderRadius: 2,
        background: cellBg(day.count, max),
        cursor: clickable ? "pointer" : "default",
      }}
    />
  );
}

// `today` arrives as an ISO date string from the server page so the server
// render and the browser's hydration agree on the 365-day window. DO NOT
// replace it with `new Date()` in render: the server and the browser would
// read the clock at different moments (and possibly on different days), and
// React reports that mismatch as hydration error #418 (guardrail 16). It is
// the statistics zone's date at UTC midnight (zonedTodayIso), so the UTC date
// walk yields that zone's day keys, the same days the data is bucketed by;
// `timeZone` names the zone for the legend.
export function ActivityCalendar({
  data,
  today: todayIso,
  timeZone,
  detailBase,
}: {
  data: CalendarDayCount[];
  today: string;
  timeZone: string;
  // When provided, day cells with plays become clickable and open the
  // drill-down popover. Holds the fixed filter context (everything except the
  // clicked day, which is filled in on click). Omit to render a static calendar.
  // `historyPath` (e.g. "/admin/activity") enables the popover's "View these
  // plays" deep-link; omit it on pages with no history table (user detail).
  detailBase?: DetailBase;
}) {
  const t = useT();
  const locale = useLocale();
  const [selected, setSelected] = useState<SelectedCell | null>(null);
  // Roving tabindex: the clickable days are ONE Tab stop (the day last focused,
  // else the most recent active day) and the arrow keys move between them, so a
  // keyboard user isn't made to tab through up to 365 cells to leave the grid.
  const [focusDate, setFocusDate] = useState<string | null>(null);
  const cellRefs = useRef(new Map<string, HTMLDivElement>());

  const clickableGrid = !!detailBase;
  const model = useMemo(
    () => buildCalendarModel(data, todayIso, locale, clickableGrid),
    [data, todayIso, locale, clickableGrid],
  );
  const { days, weeks, activeIdx, dayIndex, max } = model;

  const lastActive = activeIdx.length > 0 ? days[activeIdx[activeIdx.length - 1]].date : null;
  const focusIdx = focusDate === null ? undefined : dayIndex.get(focusDate);
  const rovingDate = focusIdx !== undefined && days[focusIdx].count > 0 ? focusDate : lastActive;

  function openCell(el: HTMLDivElement, date: string, count: number) {
    if (!detailBase || count === 0) return;
    setSelected(selectedCellFor(el, date, detailBase, locale));
  }

  function onCellKey(e: KeyboardEvent<HTMLDivElement>, date: string, count: number) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openCell(e.currentTarget, date, count);
      return;
    }
    const from = dayIndex.get(date);
    if (from === undefined) return;
    const to = calendarKeyTarget(e.key, model, from);
    if (to === undefined) return;
    // Also at an edge: an arrow key must not scroll the overflow container.
    e.preventDefault();
    if (to === null || to === from) return;
    const next = days[to].date;
    setFocusDate(next);
    cellRefs.current.get(next)?.focus();
  }

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
            total: model.totalPlays.toLocaleString(locale),
            activeDays: model.activeDays,
            peak: model.peak,
          })}
          style={{ minWidth: 700 }}
        >
          <MonthLabels model={model} />

          <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
            <DayGutter />

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
                  {week.map((day) => (
                    <DayCell
                      key={day.date}
                      day={day}
                      max={max}
                      clickable={clickableGrid && day.count > 0}
                      tabbable={day.date === rovingDate}
                      cellRef={(el) => {
                        if (el) cellRefs.current.set(day.date, el);
                        else cellRefs.current.delete(day.date);
                      }}
                      onFocus={() => setFocusDate(day.date)}
                      onOpen={(el) => openCell(el, day.date, day.count)}
                      onKey={(e) => onCellKey(e, day.date, day.count)}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>

          <Legend max={max} timeZone={timeZone} />
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
