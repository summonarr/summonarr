"use client";

// The Activity line charts: Sparkline (KPI tiles) and AreaChart (trend cards).
// Both are one ChartFrame — the hover, keyboard and touch handling, the marker,
// the crosshair and the portalled tooltip — around their own SVG body, so a
// tooltip or accessibility fix lands in both at once. The arithmetic is pure
// and tested (activity-chart-math.ts). Tooltip date labels are computed on the
// server and passed in as `labels` — never built from Date here (guardrail 16).

import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import {
  indexFraction,
  keyedIndex,
  nearestIndex,
  placeTooltip,
  pointDetail,
  polylinePoints,
  seriesStats,
  trendOf,
  type PointDetail,
} from "./activity-chart-math";

const TREND_COLOR = {
  up: "var(--ds-success)",
  down: "var(--ds-danger)",
  flat: "var(--ds-fg-subtle)",
} as const;
const TREND_ARROW = { up: "↑", down: "↓", flat: "→" } as const;

// One set of number formats per locale: the tooltip re-renders on every point
// the pointer crosses.
function useChartFormats(locale: string) {
  return useMemo(() => {
    const share = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 });
    const signedPct = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0, signDisplay: "exceptZero" });
    const signed = new Intl.NumberFormat(locale, { maximumFractionDigits: 1, signDisplay: "exceptZero" });
    const plain = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
    return { share, signedPct, signed, plain };
  }, [locale]);
}
type ChartFormats = ReturnType<typeof useChartFormats>;

// Extra context in the tooltip: where the hovered point sits relative to the
// whole series. All derived from `data`, so every line chart gets it.
function ChartTooltipDetail({ detail, fmt }: { detail: PointDetail; fmt: ChartFormats }) {
  const t = useT();
  const rows: { label: string; value: string; color: string }[] = [
    { label: t("adminActivity.chart.share"), value: fmt.share.format(detail.share), color: "var(--ds-fg-muted)" },
  ];
  if (detail.vsAvg !== null) {
    rows.push({
      label: t("adminActivity.chart.vsAvg"),
      value: fmt.signedPct.format(detail.vsAvg),
      color: TREND_COLOR[trendOf(Math.round(detail.vsAvg * 100))],
    });
  }
  if (detail.delta !== null) {
    const trend = trendOf(Math.round(detail.delta * 10));
    const pct = detail.vsPrev !== null ? ` (${fmt.signedPct.format(detail.vsPrev)})` : "";
    rows.push({
      label: t("adminActivity.chart.vsPrev"),
      value: `${TREND_ARROW[trend]} ${fmt.signed.format(detail.delta)}${pct}`,
      color: TREND_COLOR[trend],
    });
  }

  return (
    <div
      style={{
        marginTop: 5,
        paddingTop: 5,
        borderTop: "1px solid var(--ds-border)",
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      {rows.map((r) => (
        <div key={r.label} style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span
            className="ds-mono uppercase"
            style={{ fontSize: 8.5, letterSpacing: "0.06em", color: "var(--ds-fg-subtle)" }}
          >
            {r.label}
          </span>
          <span className="ds-mono" style={{ fontSize: 9.5, fontVariantNumeric: "tabular-nums", color: r.color }}>
            {r.value}
          </span>
        </div>
      ))}
    </div>
  );
}

const TOOLTIP_MIN_W = 120;

// The hovered point's tooltip, portalled to <body> with position:fixed so it
// escapes the app-shell scroll container (`<main overflow-y-auto>`), which
// otherwise clips a tooltip drawn outside the chart card. It measures itself
// before paint and is placed by its real size: centred on the point, kept
// inside the viewport, and flipped below when there is no room above.
function ChartTooltip({
  anchor,
  gap,
  contentKey,
  children,
}: {
  anchor: { x: number; top: number; bottom: number };
  gap: number;
  // Changes whenever the content (and so the size) may: the hovered point.
  contentKey: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ w: number; h: number; vw: number; vh: number } | null>(null);
  // Measured before paint for each point; the update is a no-op when nothing moved.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const next = { w: el.offsetWidth, h: el.offsetHeight, vw: window.innerWidth, vh: window.innerHeight };
    setBox((prev) =>
      prev && prev.w === next.w && prev.h === next.h && prev.vw === next.vw && prev.vh === next.vh ? prev : next,
    );
  }, [contentKey]);
  const pos = box
    ? placeTooltip(anchor, { w: box.w, h: box.h }, { w: box.vw, h: box.vh }, gap)
    : { left: anchor.x, top: anchor.top - gap, below: false };
  return createPortal(
    <div
      ref={ref}
      style={{
        position: "fixed",
        left: pos.left,
        top: pos.top,
        // Unmeasured, it isn't shown: the first layout pass places it.
        visibility: box ? "visible" : "hidden",
        minWidth: TOOLTIP_MIN_W,
        width: "max-content",
        whiteSpace: "nowrap",
        pointerEvents: "none",
        background: "var(--ds-bg-1)",
        border: "1px solid var(--ds-border-strong)",
        borderRadius: 6,
        padding: "5px 8px",
        boxShadow: "0 6px 18px rgba(0,0,0,0.45)",
        fontSize: 11,
        color: "var(--ds-fg)",
        zIndex: 60,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

interface Hover {
  i: number;
  // The snapped point in viewport coordinates, for the fixed-position tooltip.
  x: number;
  top: number;
  bottom: number;
  // Moved there by a key: announced to screen readers.
  keyboard: boolean;
}

/**
 * Which point is active, from a mouse, a touch or the arrow keys. The pointer
 * snaps to the nearest point and the tooltip follows the POINT, not the
 * cursor; a move that stays on the same point changes no state, so the chart
 * doesn't re-render on every pixel. Positions come from the live rect inside
 * the handlers — never a ref read during render (the React Compiler forbids it).
 */
function useChartHover(
  count: number,
  // Where point i's anchor sits inside the chart box, as fractions of its height.
  anchorY: (i: number) => { top: number; bottom: number },
) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);

  // The anchor is a viewport snapshot, so a scroll or resize would leave the
  // fixed tooltip floating away from the chart: drop it instead.
  const shown = hover !== null;
  useEffect(() => {
    if (!shown) return;
    const clear = () => setHover(null);
    window.addEventListener("scroll", clear, { passive: true, capture: true });
    window.addEventListener("resize", clear);
    return () => {
      window.removeEventListener("scroll", clear, true);
      window.removeEventListener("resize", clear);
    };
  }, [shown]);

  const moveTo = (i: number, keyboard: boolean) => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const y = anchorY(i);
    const next: Hover = {
      i,
      x: rect.left + indexFraction(i, count) * rect.width,
      top: rect.top + y.top * rect.height,
      bottom: rect.top + y.bottom * rect.height,
      keyboard,
    };
    setHover((prev) =>
      prev && prev.i === next.i && prev.x === next.x && prev.top === next.top && prev.keyboard === next.keyboard
        ? prev
        : next,
    );
  };

  const fromPointer = (e: PointerEvent<HTMLDivElement>) => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    moveTo(nearestIndex(e.clientX, rect.left, rect.width, count), false);
  };

  return {
    wrapRef,
    hover,
    handlers: {
      onPointerMove: fromPointer,
      // A tap: touch sends no move without a drag.
      onPointerDown: fromPointer,
      // A mouse leaving hides it; a finger lifting doesn't (the tap IS the read),
      // and the tooltip goes when focus leaves the chart.
      onPointerLeave: (e: PointerEvent<HTMLDivElement>) => {
        if (e.pointerType === "mouse") setHover(null);
      },
      onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key === "Escape") {
          setHover(null);
          return;
        }
        const i = keyedIndex(e.key, hover && hover.i < count ? hover.i : null, count);
        if (i === null) return;
        e.preventDefault();
        moveTo(i, true);
      },
      onBlur: () => setHover(null),
    },
  };
}

/**
 * The shared chart shell: a full-width box `h` tall holding an SVG drawn in a
 * `viewW` × `h` viewBox stretched to the box's width (preserveAspectRatio
 * none), plus everything that follows a point. The marker is an HTML dot over
 * the SVG, so the horizontal stretch can't squash it into an ellipse.
 */
function ChartFrame({
  data,
  h,
  viewW,
  color,
  labels,
  valueSuffix,
  interactive,
  yFor,
  anchorAtPoint,
  gap,
  marker,
  crosshair,
  children,
}: {
  data: number[];
  h: number;
  viewW: number;
  color: string;
  labels?: string[];
  valueSuffix: string;
  interactive: boolean;
  yFor: (v: number) => number;
  // true: the tooltip floats over the hovered point; false: over the chart's top edge.
  anchorAtPoint: boolean;
  gap: number;
  marker: { diameter: number; stroke: number };
  crosshair: { opacity: number; dash: string };
  children: ReactNode;
}) {
  const t = useT();
  const locale = useLocale();
  const fmt = useChartFormats(locale);
  const stats = useMemo(() => seriesStats(data), [data]);
  const { wrapRef, hover, handlers } = useChartHover(data.length, (i) => {
    if (!anchorAtPoint) return { top: 0, bottom: 1 };
    const y = yFor(data[i] ?? 0) / h;
    return { top: y, bottom: y };
  });
  // hover.i was recorded against the data as it was when the pointer moved. A
  // live refresh or a filter change can shrink `data` under a still pointer,
  // leaving hover.i past the end: an out-of-range index hides the tooltip
  // (showing `?? 0` would invent a value that was never in the data).
  const active = hover && hover.i < data.length ? hover : null;
  const step = viewW / (data.length - 1);
  const valueText = (i: number) => `${data[i].toLocaleString(locale)}${valueSuffix}`;
  const summary = t("adminActivity.chart.summary", {
    points: data.length,
    min: `${fmt.plain.format(stats.min)}${valueSuffix}`,
    max: `${fmt.plain.format(stats.max)}${valueSuffix}`,
  });

  return (
    <div
      ref={wrapRef}
      {...(interactive
        ? {
            ...handlers,
            tabIndex: 0,
            role: "group",
            "aria-label": `${summary} ${t("adminActivity.chart.keyboardHint")}`,
          }
        : { role: "img", "aria-label": summary })}
      className={interactive ? "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" : undefined}
      style={{
        position: "relative",
        width: "100%",
        height: h,
        cursor: interactive ? "crosshair" : "default",
        // A drag across the chart reads points; it doesn't scroll the page sideways.
        touchAction: interactive ? "pan-y" : undefined,
        borderRadius: 4,
      }}
    >
      <svg
        width="100%"
        height={h}
        viewBox={`0 0 ${viewW} ${h}`}
        preserveAspectRatio="none"
        aria-hidden
        style={{ display: "block", overflow: "visible" }}
      >
        {children}
        {active && (
          <line
            x1={active.i * step}
            x2={active.i * step}
            y1={0}
            y2={h}
            stroke={color}
            strokeOpacity={crosshair.opacity}
            strokeWidth="1"
            strokeDasharray={crosshair.dash}
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      {active && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            left: `${indexFraction(active.i, data.length) * 100}%`,
            top: yFor(data[active.i]),
            width: marker.diameter,
            height: marker.diameter,
            boxSizing: "border-box",
            transform: "translate(-50%, -50%)",
            borderRadius: 999,
            background: "var(--ds-bg)",
            border: `${marker.stroke}px solid ${color}`,
            pointerEvents: "none",
          }}
        />
      )}
      {interactive && (
        <span className="sr-only" aria-live="polite">
          {active?.keyboard
            ? t("adminActivity.chart.point", { label: labels?.[active.i] ?? String(active.i + 1), value: valueText(active.i) })
            : ""}
        </span>
      )}
      {active && typeof document !== "undefined" && (
        <ChartTooltip anchor={active} gap={gap} contentKey={active.i}>
          {labels?.[active.i] && (
            <div
              className="ds-mono uppercase"
              style={{ fontSize: 9, letterSpacing: "0.08em", color: "var(--ds-fg-subtle)", marginBottom: 2 }}
            >
              {labels[active.i]}
            </div>
          )}
          <div
            className="ds-mono"
            style={{
              fontSize: 12.5,
              fontVariantNumeric: "tabular-nums",
              color: "var(--ds-fg)",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span style={{ width: 7, height: 7, borderRadius: 999, background: color, display: "inline-block" }} />
            {valueText(active.i)}
          </div>
          <ChartTooltipDetail detail={pointDetail(data, active.i, stats)} fmt={fmt} />
        </ChartTooltip>
      )}
    </div>
  );
}

// `labels[i]` is the precomputed (server-side) display label for `data[i]` —
// e.g. "May 13". Never compute it from Date here (guardrail 16).
export function Sparkline({
  data,
  w = 140,
  h = 22,
  color = "var(--ds-accent)",
  labels,
  valueSuffix = "",
  interactive = true,
}: {
  data: number[];
  w?: number;
  h?: number;
  color?: string;
  labels?: string[];
  valueSuffix?: string;
  interactive?: boolean;
}) {
  const gradId = useId().replace(/[:]/g, "");
  const geometry = useMemo(() => {
    if (!data || data.length < 2) return null;
    const max = Math.max(...data, 1);
    const min = Math.min(...data, 0);
    const range = max - min || 1;
    const yFor = (v: number) => h - ((v - min) / range) * h;
    const pts = polylinePoints(data, w, yFor);
    return { yFor, pts, area: `0,${h} ${pts} ${w},${h}` };
  }, [data, w, h]);

  if (!geometry) return <span style={{ display: "block", height: h }} />;

  return (
    <ChartFrame
      data={data}
      h={h}
      viewW={w}
      color={color}
      labels={labels}
      valueSuffix={valueSuffix}
      interactive={interactive}
      yFor={geometry.yFor}
      anchorAtPoint={false}
      gap={6}
      marker={{ diameter: 5.8, stroke: 1.4 }}
      crosshair={{ opacity: 0.5, dash: "1.5 2" }}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.32" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={geometry.area} fill={`url(#${gradId})`} />
      <polyline
        points={geometry.pts}
        fill="none"
        stroke={color}
        strokeWidth="1.25"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </ChartFrame>
  );
}

const AREA_VIEW_W = 1000;

// `labels[i]` is the precomputed (server-side) label for `data[i]`.
export function AreaChart({
  data,
  h = 160,
  color = "var(--ds-accent)",
  labels,
  valueSuffix = "",
}: {
  data: number[];
  h?: number;
  color?: string;
  labels?: string[];
  valueSuffix?: string;
}) {
  const gradId = useId().replace(/[:]/g, "");
  const geometry = useMemo(() => {
    if (!data || data.length < 2) return null;
    const max = Math.max(...data, 1);
    const yFor = (v: number) => h - (v / max) * (h - 8) - 4;
    const pts = polylinePoints(data, AREA_VIEW_W, yFor);
    return {
      yFor,
      pts,
      area: `0,${h} ${pts} ${AREA_VIEW_W},${h}`,
      grid: [0.25, 0.5, 0.75].map((p) => h - p * (h - 8) - 4),
    };
  }, [data, h]);

  if (!geometry) return <div style={{ height: h }} />;

  return (
    <ChartFrame
      data={data}
      h={h}
      viewW={AREA_VIEW_W}
      color={color}
      labels={labels}
      valueSuffix={valueSuffix}
      interactive
      yFor={geometry.yFor}
      anchorAtPoint
      gap={12}
      marker={{ diameter: 8.2, stroke: 1.8 }}
      crosshair={{ opacity: 0.45, dash: "2 3" }}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {geometry.grid.map((y, i) => (
        <line
          key={i}
          x1="0"
          y1={y}
          x2={AREA_VIEW_W}
          y2={y}
          stroke="var(--ds-border)"
          strokeWidth="1"
          strokeDasharray="2 4"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      <polygon points={geometry.area} fill={`url(#${gradId})`} />
      <polyline
        points={geometry.pts}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
      />
    </ChartFrame>
  );
}
