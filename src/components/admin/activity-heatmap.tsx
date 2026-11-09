"use client";

// The 7 × 24 day/hour heatmap of the Activity overview, the user detail page
// and My stats. An ARIA grid: one tab stop for the whole grid (roving
// tabindex), the arrow keys move between cells, Home/End to a row's ends, and
// every cell is named ("Mon 21:00 New York, 5 plays") — not a title only a
// mouse can read. With `detailBase`, Enter or Space on a cell with plays opens
// its drill-down popover, as a click does.

import { useRef, useState, type KeyboardEvent } from "react";
import { zoneShortLabel } from "@/lib/stats-time-zone";
import {
  HeatmapCellPopover,
  type HeatmapCellAnchor,
} from "@/components/admin/heatmap-cell-popover";
import { useT } from "@/components/i18n/i18n-provider";
import { WEEKDAY_KEYS, normalizeHeatmapMatrix } from "./activity-format";
import { heatmapDetailQuery, heatmapKeyTarget } from "./activity-chart-math";

// The hour of the last label on the heatmap's hour axis (0, 6, 12, 18); the
// columns after it carry the time zone marker instead.
const LAST_HOUR_LABEL = 18;
const CELL = 12;
const GAP = 2;
const HOURS = 24;
// The gutter for the weekday names, then one column per hour. Every row is its
// own grid on these tracks, so the columns line up as one grid would.
const COLUMNS = `28px repeat(${HOURS}, ${CELL}px)`;

// `matrix` is 7 rows (Mon..Sun) × 24 cols (hour 0..23) of raw counts, bucketed
// in `timeZone`, the statistics zone the server named with the data.
export function HourHeatmap({
  matrix: rawMatrix,
  detailBase,
  timeZone,
}: {
  matrix: number[][];
  // When provided, cells with plays become clickable and open the drill-down
  // popover. `days` scopes the admin grid; per-user grids pass `userId` instead
  // (all-history) — matches getHeatmapCellDetail's scoping. Omit for static.
  detailBase?: { userId?: string; source?: string; mediaType?: string; days?: number };
  timeZone: string;
}) {
  const t = useT();
  const DAYS = WEEKDAY_KEYS.map((k) => t(k));
  const zone = zoneShortLabel(timeZone);
  // Always 7 × 24, whatever arrived: a short row draws zeros, never a hole.
  const matrix = normalizeHeatmapMatrix(rawMatrix);
  const max = Math.max(1, ...matrix.flat());
  const gridRef = useRef<HTMLDivElement>(null);
  // The one cell in the tab order (roving tabindex).
  const [focusCell, setFocusCell] = useState({ r: 0, c: 0 });
  const [selected, setSelected] = useState<
    { queryString: string; anchor: HeatmapCellAnchor; label: string } | null
  >(null);
  function openCell(el: HTMLElement, r: number, c: number, v: number) {
    if (!detailBase || v === 0) return;
    const rect = el.getBoundingClientRect();
    setSelected({
      queryString: heatmapDetailQuery(detailBase, r, c),
      anchor: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
      label: `${DAYS[r]} ${String(c).padStart(2, "0")}:00`,
    });
  }

  function onCellKey(e: KeyboardEvent<HTMLDivElement>, r: number, c: number, v: number) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (!detailBase || v === 0) return;
      openCell(e.currentTarget, r, c, v);
      return;
    }
    const next = heatmapKeyTarget(e.key, r, c);
    if (!next) return;
    e.preventDefault();
    setFocusCell(next);
    gridRef.current?.querySelector<HTMLElement>(`[data-cell="${next.r}-${next.c}"]`)?.focus();
  }

  return (
    <>
    {/* The grid is a fixed ~364px (28px gutter + 24 × 12px cells + gaps), so
        inside an 18px-padded card it overruns a 375px viewport. Same fix as
        the 365-day calendar (activity-calendar.tsx): scroll the grid inside
        its own container instead of clipping it. `contain: inline-size` is
        load-bearing: every caller places this card in a `1fr` grid column
        (minmax(auto, 1fr)), and without containment the wrapper's min-content
        width sizes the column, so the card grows past the viewport and the
        scroll container never engages. */}
    <div className="overflow-x-auto" style={{ contain: "inline-size" }}>
    <div
      ref={gridRef}
      role="grid"
      aria-label={t("adminActivity.heatmap.gridLabel", { zone: timeZone })}
      style={{ display: "flex", flexDirection: "column", gap: GAP, alignItems: "flex-start" }}
    >
      {/* The hour axis is for the eye: every cell names its own day, hour and
          zone, so the axis is left out of the accessibility tree. */}
      <div aria-hidden style={{ display: "grid", gridTemplateColumns: COLUMNS, columnGap: GAP }}>
        <div />
        {Array.from({ length: LAST_HOUR_LABEL + 1 }).map((_, hr) => (
          <div
            key={hr}
            className="ds-mono"
            style={{
              fontSize: 8.5,
              color: "var(--ds-fg-subtle)",
              textAlign: "center",
              lineHeight: 1,
            }}
          >
            {hr % 6 === 0 ? `${hr}` : ""}
          </div>
        ))}
        {/* The hours are the statistics zone's wall clock: its short name sits at
            the end of the hour axis, the full name in the title. */}
        <div
          className="ds-mono"
          title={t("adminActivity.heatmap.zoneTitle", { zone: timeZone })}
          style={{
            gridColumn: `span ${23 - LAST_HOUR_LABEL}`,
            fontSize: 7.5,
            color: "var(--ds-fg-subtle)",
            textAlign: "right",
            lineHeight: 1,
            alignSelf: "end",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {zone}
        </div>
      </div>
      {matrix.map((row, r) => (
        <HeatmapRow
          key={r}
          r={r}
          row={row}
          day={DAYS[r]}
          zone={zone}
          max={max}
          clickable={(v) => !!detailBase && v > 0}
          focusCell={focusCell}
          onFocusCell={(c) => setFocusCell((cur) => (cur.r === r && cur.c === c ? cur : { r, c }))}
          onOpen={(el, c, v) => openCell(el, r, c, v)}
          onKey={(e, c, v) => onCellKey(e, r, c, v)}
        />
      ))}
    </div>
    </div>
    {selected && (
      <HeatmapCellPopover
        queryString={selected.queryString}
        anchor={selected.anchor}
        label={selected.label}
        onClose={() => setSelected(null)}
      />
    )}
    </>
  );
}

const hourText = (c: number) => `${c}:00`;

// One weekday: its name, then a named cell per hour, the busier the stronger.
function HeatmapRow({
  r,
  row,
  day,
  zone,
  max,
  clickable,
  focusCell,
  onFocusCell,
  onOpen,
  onKey,
}: {
  r: number;
  row: number[];
  day: string;
  zone: string;
  max: number;
  clickable: (v: number) => boolean;
  focusCell: { r: number; c: number };
  onFocusCell: (c: number) => void;
  onOpen: (el: HTMLElement, c: number, v: number) => void;
  onKey: (e: KeyboardEvent<HTMLDivElement>, c: number, v: number) => void;
}) {
  const t = useT();
  return (
    <div role="row" style={{ display: "grid", gridTemplateColumns: COLUMNS, columnGap: GAP }}>
      <div
        role="rowheader"
        className="ds-mono"
        style={{
          fontSize: 9.5,
          color: "var(--ds-fg-subtle)",
          lineHeight: `${CELL}px`,
          textAlign: "right",
          paddingRight: 6,
        }}
      >
        {day}
      </div>
      {row.map((v, c) => {
        const canOpen = clickable(v);
        return (
          <div
            key={c}
            data-cell={`${r}-${c}`}
            role="gridcell"
            title={t("adminActivity.heatmap.cellTitle", { day, hour: hourText(c), count: v })}
            aria-label={t("adminActivity.heatmap.cellAria", { day, hour: hourText(c), zone, count: v })}
            aria-haspopup={canOpen ? "dialog" : undefined}
            tabIndex={focusCell.r === r && focusCell.c === c ? 0 : -1}
            onFocus={() => onFocusCell(c)}
            onClick={canOpen ? (e) => onOpen(e.currentTarget, c, v) : undefined}
            onKeyDown={(e) => onKey(e, c, v)}
            className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            style={{
              width: CELL,
              height: CELL,
              borderRadius: 2,
              cursor: canOpen ? "pointer" : "default",
              background:
                v === 0
                  ? "color-mix(in oklab, var(--ds-fg) 2.5%, transparent)"
                  : `color-mix(in oklab, var(--ds-accent) ${(10 + (v / max) * 76).toFixed(1)}%, transparent)`,
            }}
          />
        );
      })}
    </div>
  );
}
