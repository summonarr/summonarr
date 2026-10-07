"use client";

// Shared building blocks (cards, headers, charts, tags) for the Activity
// dashboard. Used by the activity-* client components and by the server-rendered
// play detail page (admin/activity/play/[id]), so every Activity view shares one
// look. Sparkline/AreaChart keep hover state, which is why this is a client
// module. Tooltip date labels are computed on the server and passed in as
// `labels` — never built from Date here (CLAUDE.md guardrail 16).

import {
  Fragment,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import Link from "next/link";
import { bitrateToKbps } from "@/lib/bitrate";
import { formatDurationHM } from "@/lib/format-duration";
import { Chip, SectionHeader as DsSectionHeader } from "@/components/ui/design";
import {
  HeatmapCellPopover,
  type HeatmapCellAnchor,
} from "@/components/admin/heatmap-cell-popover";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import type { Translator } from "@/lib/i18n/translate";

// Mon-first weekday catalog keys, shared by the heatmaps. Translated at render.
export const WEEKDAY_KEYS = [
  "adminActivity.weekday.mon",
  "adminActivity.weekday.tue",
  "adminActivity.weekday.wed",
  "adminActivity.weekday.thu",
  "adminActivity.weekday.fri",
  "adminActivity.weekday.sat",
  "adminActivity.weekday.sun",
] as const;

/* ── Source helpers ───────────────────────────────────────────── */

export function sourceDotColor(source: string): string {
  return source === "plex" ? "var(--ds-plex)" : "var(--ds-jellyfin)";
}

// `instance` is a media-server instance slug (see media-instances.ts). When it
// is non-empty the tag reads "PLEX:remote", matching mediaInstanceLabel. The
// default server's slug is "" (also what every older row holds), so it shows
// just "PLEX" — single-server setups look exactly as they did before.
// The colour depends only on `source`. Renders the design-system Chip
// (`.ds-chip-plex` / `.ds-chip-jellyfin`) so the badge is the same pill as
// every other Plex/Jellyfin chip in the app, not a second squared rendering.
export function SourceTag({ source, instance }: { source: string; instance?: string }) {
  const isPlex = source === "plex";
  return (
    <Chip tone={isPlex ? "plex" : "jellyfin"} className="ds-mono uppercase">
      {isPlex ? "Plex" : "Jellyfin"}
      {instance ? `:${instance}` : ""}
    </Chip>
  );
}

/* ── Stream method pill ───────────────────────────────────────── */

export type MethodClass = "ok" | "info" | "warn" | "err" | "muted";

export function methodLabel(
  t: Translator,
  playMethod: string | null,
  videoDecision?: string | null,
  audioDecision?: string | null,
): { label: string; cls: MethodClass } {
  if (playMethod === "DirectPlay") return { label: t("adminActivity.method.directPlay"), cls: "ok" };
  if (playMethod === "DirectStream") return { label: t("adminActivity.method.remux"), cls: "info" };
  if (playMethod === "Transcode") {
    const v = videoDecision === "transcode";
    const a = audioDecision === "transcode";
    if (v && a) return { label: t("adminActivity.method.transcodeAV"), cls: "warn" };
    if (v) return { label: t("adminActivity.method.transcodeVideo"), cls: "warn" };
    if (a) return { label: t("adminActivity.method.transcodeAudio"), cls: "warn" };
    return { label: t("adminActivity.method.transcode"), cls: "warn" };
  }
  if (playMethod) return { label: playMethod, cls: "muted" };
  return { label: "—", cls: "muted" };
}

export function MethodPill({
  method,
  methodClass,
}: {
  method: string;
  methodClass: MethodClass;
}) {
  const colors: Record<MethodClass, { bg: string; fg: string }> = {
    // Tints are the status TOKENS at 12–14% (guardrail 42: the text tokens are
    // tuned against their own 5–20% tints), so a token retune carries here.
    ok: { bg: "color-mix(in oklab, var(--ds-success) 12%, transparent)", fg: "var(--ds-success)" },
    info: { bg: "color-mix(in oklab, var(--ds-info) 13%, transparent)", fg: "var(--ds-info)" },
    warn: { bg: "color-mix(in oklab, var(--ds-warning) 14%, transparent)", fg: "var(--ds-warning)" },
    err: { bg: "color-mix(in oklab, var(--ds-danger) 14%, transparent)", fg: "var(--ds-danger)" },
    muted: { bg: "var(--ds-bg-3)", fg: "var(--ds-fg-muted)" },
  };
  const c = colors[methodClass] ?? colors.muted;
  return (
    <span
      className="ds-mono"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: 10,
        padding: "2px 7px",
        borderRadius: 999,
        background: c.bg,
        color: c.fg,
        whiteSpace: "nowrap",
        letterSpacing: "0.02em",
      }}
    >
      <span
        style={{
          width: 5,
          height: 5,
          borderRadius: 999,
          background: "currentColor",
        }}
      />
      {method}
    </span>
  );
}

/* ── Poster / Avatar ──────────────────────────────────────────── */

export function Poster({
  src,
  letter,
  accent = "oklch(0.34 0.06 275)",
  w = 44,
  h = 66,
  radius = 4,
}: {
  src?: string | null;
  letter: string;
  accent?: string;
  w?: number;
  h?: number;
  radius?: number;
}) {
  const usable = src && /^https?:\/\//i.test(src);
  if (usable) {
    return (
      <Image
        src={src}
        alt=""
        width={Math.round(w * 2)}
        height={Math.round(h * 2)}
        sizes={`${w}px`}
        style={{
          width: w,
          height: h,
          borderRadius: radius,
          objectFit: "cover",
          border: "1px solid var(--ds-border)",
          flexShrink: 0,
          display: "block",
        }}
      />
    );
  }
  return (
    <div
      style={{
        width: w,
        height: h,
        borderRadius: radius,
        background: `linear-gradient(160deg, ${accent} 0%, oklch(0.18 0.01 275) 100%)`,
        border: "1px solid var(--ds-border)",
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "flex-start",
        padding: 4,
        overflow: "hidden",
        flexShrink: 0,
        position: "relative",
        boxShadow: "inset 0 0 0 1px color-mix(in oklab, var(--ds-fg) 4%, transparent)",
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-serif, 'Times New Roman', serif)",
          fontSize: Math.round(h * 0.42),
          fontWeight: 500,
          lineHeight: 1,
          color: "oklch(0.96 0 0 / 0.85)",
          letterSpacing: "-0.04em",
        }}
      >
        {letter}
      </span>
    </div>
  );
}

export function Avatar({
  letter,
  accent,
  size = 22,
}: {
  letter: string;
  accent?: string;
  size?: number;
}) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: 999,
        // With no accent this is a plain surface chip, so the letter uses a
        // theme colour. The fixed near-white letter below is only readable on
        // the dark accent backgrounds callers pass; on the light theme's
        // surface it would be white-on-white.
        background: accent ?? "var(--ds-bg-3)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: Math.round(size * 0.46),
        fontWeight: 600,
        color: accent ? "oklch(0.96 0 0 / 0.9)" : "var(--ds-fg-muted)",
        flexShrink: 0,
        textTransform: "uppercase",
      }}
    >
      {letter}
    </div>
  );
}

/* ── Charts ───────────────────────────────────────────────────── */

// Extra context shown in the line/area chart hover tooltips: where the hovered
// point sits relative to the whole series. All derived from `data` (no extra
// props) so every line chart gets the same richer tooltip for free.
function ChartTooltipDetail({
  data,
  i,
}: {
  data: number[];
  i: number;
}) {
  const t = useT();
  const locale = useLocale();
  const total = data.reduce((a, b) => a + b, 0);
  const value = data[i] ?? 0;
  const avg = data.length > 0 ? total / data.length : 0;
  const prev = i > 0 ? data[i - 1] : null;
  // Round floats (watch-hours series) to one decimal; integers stay integer.
  const round1 = (n: number) => Math.round(n * 10) / 10;
  const fmt = (n: number) => round1(n).toLocaleString(locale);
  const share = total > 0 ? round1((value / total) * 100) : 0;
  const avgPct = avg > 0 ? Math.round(((value - avg) / avg) * 100) : null;
  const delta = prev !== null ? round1(value - prev) : null;
  const deltaPct =
    prev !== null && prev !== 0 ? Math.round(((value - prev) / prev) * 100) : null;

  const rows: { label: string; value: string; color: string }[] = [
    { label: t("adminActivity.chart.share"), value: `${share}%`, color: "var(--ds-fg-muted)" },
  ];
  if (avgPct !== null) {
    rows.push({
      label: t("adminActivity.chart.vsAvg"),
      value: `${avgPct > 0 ? "+" : ""}${avgPct}%`,
      color:
        avgPct > 0
          ? "var(--ds-success)"
          : avgPct < 0
            ? "var(--ds-danger)"
            : "var(--ds-fg-subtle)",
    });
  }
  if (delta !== null) {
    const arrow = delta > 0 ? "↑" : delta < 0 ? "↓" : "→";
    rows.push({
      label: t("adminActivity.chart.vsPrev"),
      value: `${arrow} ${delta > 0 ? "+" : ""}${fmt(delta)}${
        deltaPct !== null ? ` (${deltaPct > 0 ? "+" : ""}${deltaPct}%)` : ""
      }`,
      color:
        delta > 0
          ? "var(--ds-success)"
          : delta < 0
            ? "var(--ds-danger)"
            : "var(--ds-fg-subtle)",
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
        <div
          key={r.label}
          style={{ display: "flex", justifyContent: "space-between", gap: 8 }}
        >
          <span
            className="ds-mono uppercase"
            style={{ fontSize: 8.5, letterSpacing: "0.06em", color: "var(--ds-fg-subtle)" }}
          >
            {r.label}
          </span>
          <span
            className="ds-mono"
            style={{ fontSize: 9.5, fontVariantNumeric: "tabular-nums", color: r.color }}
          >
            {r.value}
          </span>
        </div>
      ))}
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
  const locale = useLocale();
  const wrapRef = useRef<HTMLDivElement>(null);
  // `x` is the SVG-local crosshair coord; `px`/`py` are the hovered point's
  // viewport coords for the portalled tooltip. All captured in the mousemove
  // handler (which has the live rect), not read off the ref during render —
  // the React Compiler forbids reading ref.current in the render path.
  const [hover, setHover] = useState<{
    i: number;
    x: number;
    px: number;
    py: number;
  } | null>(null);

  if (!data || data.length < 2)
    return <span style={{ display: "block", height: h }} />;

  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const step = w / (data.length - 1);
  const yFor = (v: number) => h - ((v - min) / range) * h;
  const pts = data
    .map((v, i) => `${(i * step).toFixed(2)},${yFor(v).toFixed(2)}`)
    .join(" ");
  const area = `0,${h} ${pts} ${w},${h}`;

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const i = Math.round(t * (data.length - 1));
    setHover({
      i,
      x: t * rect.width,
      // Viewport anchor for the portalled tooltip; clamp X off the edges.
      px: Math.max(
        90,
        Math.min(window.innerWidth - 90, rect.left + t * rect.width),
      ),
      py: rect.top,
    });
  };

  const TT_W = 120;

  return (
    <div
      ref={wrapRef}
      onMouseMove={interactive ? onMove : undefined}
      onMouseLeave={interactive ? () => setHover(null) : undefined}
      style={{
        position: "relative",
        width: "100%",
        height: h,
        cursor: interactive ? "crosshair" : "default",
      }}
    >
      <svg
        width="100%"
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        style={{ display: "block", overflow: "visible" }}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.32" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={area} fill={`url(#${gradId})`} />
        <polyline
          points={pts}
          fill="none"
          stroke={color}
          strokeWidth="1.25"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {/* hover.i was recorded against the data as it was when the mouse
            moved. A live refresh or filter change can shrink `data` while the
            pointer stays put, leaving hover.i past the end. Reading
            data[hover.i] would then crash the whole dashboard, so an
            out-of-range index simply hides the tooltip (showing `?? 0` would
            invent a value that was never in the data). */}
        {hover && hover.i < data.length && (
          <>
            <line
              x1={hover.i * step}
              x2={hover.i * step}
              y1={0}
              y2={h}
              stroke={color}
              strokeOpacity="0.5"
              strokeWidth="1"
              strokeDasharray="1.5 2"
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={hover.i * step}
              cy={yFor(data[hover.i])}
              r="2.2"
              fill="var(--ds-bg)"
              stroke={color}
              strokeWidth="1.4"
              vectorEffect="non-scaling-stroke"
            />
          </>
        )}
      </svg>
      {hover &&
        hover.i < data.length &&
        typeof document !== "undefined" &&
        createPortal(
        <div
          style={{
            // Portalled to <body> with position:fixed so it escapes the
            // app-shell scroll container (`<main overflow-y-auto>`), which
            // otherwise clips a tooltip popping above the sparkline.
            position: "fixed",
            left: hover.px,
            top: hover.py - 6,
            transform: "translate(-50%, -100%)",
            minWidth: TT_W,
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
          {labels?.[hover.i] && (
            <div
              className="ds-mono uppercase"
              style={{
                fontSize: 9,
                letterSpacing: "0.08em",
                color: "var(--ds-fg-subtle)",
                marginBottom: 2,
              }}
            >
              {labels[hover.i]}
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
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: 999,
                background: color,
                display: "inline-block",
              }}
            />
            {data[hover.i].toLocaleString(locale)}
            {valueSuffix}
          </div>
          <ChartTooltipDetail data={data} i={hover.i} />
        </div>,
          document.body,
        )}
    </div>
  );
}

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
  const locale = useLocale();
  const wrapRef = useRef<HTMLDivElement>(null);
  // `x`/`y` are SVG-local coords for the in-chart crosshair; `px`/`py` are the
  // hovered point's viewport coords, used to position the portalled tooltip.
  // All captured in the handler (which has the live rect), not read off the
  // ref during render.
  const [hover, setHover] = useState<{
    i: number;
    x: number;
    y: number;
    px: number;
    py: number;
  } | null>(null);
  const w = 1000;

  if (!data || data.length < 2) return <div style={{ height: h }} />;

  const max = Math.max(...data, 1);
  const step = w / (data.length - 1);
  const yFor = (v: number) => h - (v / max) * (h - 8) - 4;
  const pts = data
    .map((v, i) => `${(i * step).toFixed(2)},${yFor(v).toFixed(2)}`)
    .join(" ");
  const area = `0,${h} ${pts} ${w},${h}`;
  const grid = [0.25, 0.5, 0.75].map((p) => h - p * (h - 8) - 4);

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const i = Math.round(t * (data.length - 1));
    const yLocal = (yFor(data[i]) / h) * rect.height;
    setHover({
      i,
      x: t * rect.width,
      y: yLocal,
      // Viewport anchor for the portalled tooltip. Clamp X off the viewport
      // edges so a wide tooltip stays fully on-screen.
      px: Math.max(
        90,
        Math.min(window.innerWidth - 90, rect.left + t * rect.width),
      ),
      py: rect.top + yLocal,
    });
  };

  const TT_W = 120;

  return (
    <div
      ref={wrapRef}
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
      style={{
        position: "relative",
        width: "100%",
        height: h,
        cursor: "crosshair",
      }}
    >
      <svg
        width="100%"
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        style={{ display: "block", overflow: "visible" }}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.22" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {grid.map((y, i) => (
          <line
            key={i}
            x1="0"
            y1={y}
            x2={w}
            y2={y}
            stroke="var(--ds-border)"
            strokeWidth="1"
            strokeDasharray="2 4"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <polygon points={area} fill={`url(#${gradId})`} />
        <polyline
          points={pts}
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
          strokeLinejoin="round"
        />
        {/* hover.i was recorded against the data as it was when the mouse
            moved. A live refresh or filter change can shrink `data` while the
            pointer stays put, leaving hover.i past the end. Reading
            data[hover.i] would then crash the whole dashboard, so an
            out-of-range index simply hides the tooltip (showing `?? 0` would
            invent a value that was never in the data). */}
        {hover && hover.i < data.length && (
          <>
            <line
              x1={hover.i * step}
              x2={hover.i * step}
              y1={0}
              y2={h}
              stroke={color}
              strokeOpacity="0.45"
              strokeWidth="1"
              strokeDasharray="2 3"
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={hover.i * step}
              cy={yFor(data[hover.i])}
              r="3.2"
              fill="var(--ds-bg)"
              stroke={color}
              strokeWidth="1.8"
              vectorEffect="non-scaling-stroke"
            />
          </>
        )}
      </svg>
      {hover &&
        hover.i < data.length &&
        typeof document !== "undefined" &&
        createPortal(
        <div
          style={{
            // Portalled to <body> with position:fixed so it escapes the
            // app-shell scroll container (`<main overflow-y-auto>`), which
            // otherwise clips any tooltip drawn outside the chart card.
            // px/py are the hovered point's viewport coords; translate(-50%,
            // -100%) centers the box on the point and floats it above.
            position: "fixed",
            left: hover.px,
            top: hover.py - 12,
            transform: "translate(-50%, -100%)",
            minWidth: TT_W,
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
          {labels?.[hover.i] && (
            <div
              className="ds-mono uppercase"
              style={{
                fontSize: 9,
                letterSpacing: "0.08em",
                color: "var(--ds-fg-subtle)",
                marginBottom: 2,
              }}
            >
              {labels[hover.i]}
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
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: 999,
                background: color,
                display: "inline-block",
              }}
            />
            {data[hover.i].toLocaleString(locale)}
            {valueSuffix}
          </div>
          <ChartTooltipDetail data={data} i={hover.i} />
        </div>,
          document.body,
        )}
    </div>
  );
}

// `matrix` is 7 rows (Mon..Sun) × 24 cols (hour 0..23) of raw counts.
export function HourHeatmap({
  matrix,
  detailBase,
}: {
  matrix: number[][];
  // When provided, cells with plays become clickable and open the drill-down
  // popover. `days` scopes the admin grid; per-user grids pass `userId` instead
  // (all-history) — matches getHeatmapCellDetail's scoping. Omit for static.
  detailBase?: { userId?: string; source?: string; mediaType?: string; days?: number };
}) {
  const t = useT();
  const DAYS = WEEKDAY_KEYS.map((k) => t(k));
  const cell = 12;
  const gap = 2;
  const max = Math.max(1, ...matrix.flat());
  const [selected, setSelected] = useState<
    { queryString: string; anchor: HeatmapCellAnchor; label: string } | null
  >(null);

  // Matrix rows are Mon-first (0=Mon..6=Sun); Postgres DOW is 0=Sun..6=Sat, so
  // pgDow = (row + 1) % 7 — the inverse of the (dow + 6) % 7 mapping the callers
  // use to build the matrix.
  function openCell(el: HTMLDivElement, r: number, c: number, v: number) {
    if (!detailBase || v === 0) return;
    const rect = el.getBoundingClientRect();
    const params = new URLSearchParams({
      mode: "hour",
      dow: String((r + 1) % 7),
      hour: String(c),
    });
    if (detailBase.userId) params.set("userId", detailBase.userId);
    if (detailBase.source) params.set("source", detailBase.source);
    if (detailBase.mediaType) params.set("mediaType", detailBase.mediaType);
    if (detailBase.days) params.set("days", String(detailBase.days));
    setSelected({
      queryString: params.toString(),
      anchor: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
      label: `${DAYS[r]} ${String(c).padStart(2, "0")}:00`,
    });
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
      style={{
        display: "grid",
        gridTemplateColumns: `28px repeat(24, ${cell}px)`,
        gap: `${gap}px ${gap}px`,
        justifyContent: "start",
      }}
    >
      <div
        className="ds-mono"
        title={t("adminActivity.heatmap.utcTitle")}
        style={{ fontSize: 7.5, color: "var(--ds-fg-subtle)", alignSelf: "end", lineHeight: 1 }}
      >
        UTC
      </div>
      {Array.from({ length: 24 }).map((_, hr) => (
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
      {matrix.map((row, r) => (
        <Fragment key={r}>
          <div
            className="ds-mono"
            style={{
              fontSize: 9.5,
              color: "var(--ds-fg-subtle)",
              lineHeight: `${cell}px`,
              textAlign: "right",
              paddingRight: 6,
            }}
          >
            {DAYS[r]}
          </div>
          {row.map((v, c) => {
            const clickable = !!detailBase && v > 0;
            return (
              <div
                key={c}
                title={t("adminActivity.heatmap.cellTitle", { day: DAYS[r], hour: `${c}:00`, count: v })}
                aria-label={clickable ? t("adminActivity.heatmap.cellAria", { day: DAYS[r], hour: `${c}:00`, count: v }) : undefined}
                role={clickable ? "button" : undefined}
                tabIndex={clickable ? 0 : undefined}
                onClick={clickable ? (e) => openCell(e.currentTarget, r, c, v) : undefined}
                onKeyDown={
                  clickable
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          openCell(e.currentTarget, r, c, v);
                        }
                      }
                    : undefined
                }
                style={{
                  width: cell,
                  height: cell,
                  borderRadius: 2,
                  cursor: clickable ? "pointer" : "default",
                  background:
                    v === 0
                      ? "color-mix(in oklab, var(--ds-fg) 2.5%, transparent)"
                      : `color-mix(in oklab, var(--ds-accent) ${(10 + (v / max) * 76).toFixed(1)}%, transparent)`,
                }}
              />
            );
          })}
        </Fragment>
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

/* ── Progress / distribution ──────────────────────────────────── */

export function ProgressTrack({
  pct,
  height = 3,
  color = "var(--ds-accent)",
  paused = false,
}: {
  pct: number;
  height?: number;
  color?: string;
  paused?: boolean;
}) {
  return (
    <div
      style={{
        position: "relative",
        height,
        background: "color-mix(in oklab, var(--ds-fg) 6%, transparent)",
        borderRadius: 999,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: `${Math.min(100, Math.max(0, pct * 100))}%`,
          height: "100%",
          background: paused ? "var(--ds-fg-subtle)" : color,
          borderRadius: 999,
          transition: "width 220ms var(--ds-ease)",
        }}
      />
    </div>
  );
}

export function DistributionList({
  rows,
}: {
  rows: { label: string; pct: number; value: string; color: string }[];
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {rows.map((r) => (
        <div key={r.label}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              marginBottom: 4,
              fontSize: 11.5,
              gap: 10,
            }}
          >
            <span style={{ color: "var(--ds-fg-muted)", whiteSpace: "nowrap" }}>
              {r.label}
            </span>
            <span
              className="ds-mono"
              style={{
                color: "var(--ds-fg-subtle)",
                fontVariantNumeric: "tabular-nums",
                whiteSpace: "nowrap",
              }}
            >
              {r.value} · {r.pct}%
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
                width: `${r.pct}%`,
                height: "100%",
                background: r.color,
                borderRadius: 999,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── Layout ───────────────────────────────────────────────────── */

export function ActivityCard({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <section
      style={{
        padding: 18,
        background: "var(--ds-bg-2)",
        border: "1px solid var(--ds-border)",
        borderRadius: "var(--ds-r-lg)",
        ...style,
      }}
    >
      {children}
    </section>
  );
}

// Thin wrapper over the design-system SectionHeader, so an Activity card
// heading is the same 15px title / 11px mono subtitle as every other in-page
// section (/popular, /top, the discover rails). The legacy `label` / `sub`
// prop names stay for the activity-* call sites and forward to the DS
// `title` / `subtitle`. The DS header keeps the right slot `shrink-0` beside a
// `min-w-0` text block, so a long heading wraps instead of running under the
// Live dot ("Now playingive").
export function SectionHeader({
  label,
  sub,
  right,
}: {
  label: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
}) {
  return <DsSectionHeader title={label} subtitle={sub} right={right} />;
}

// The one header composition every Activity DETAIL view uses (user, title,
// play): a back-link line, then the exact type scale of the shared PageHeader
// (22px / 600 / -0.02em title, 12px ds-mono subtitle) so a detail page reads
// as the same section as the tabbed list pages above it. `leading` is the
// avatar/poster, `meta` sits beside the title (source tag, year), `children`
// is an optional chip row under the subtitle, and `right` mirrors PageHeader's
// action slot (it stacks below on mobile via .ds-page-header).
export function DetailHeader({
  back,
  leading,
  title,
  meta,
  subtitle,
  right,
  children,
}: {
  back: { href: string; label: string };
  leading?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <>
      <Link
        href={back.href}
        className="ds-hover-tint"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          marginBottom: 14,
          marginLeft: -4,
          padding: "4px 8px 4px 4px",
          borderRadius: 6,
          fontSize: 12.5,
          color: "var(--ds-fg-muted)",
          textDecoration: "none",
        }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
          <path
            d="M7 3l-3 3 3 3"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {back.label}
      </Link>

      <header className="ds-page-header" style={{ marginBottom: 22 }}>
        <div
          className="flex-1 min-w-0"
          style={{ display: "flex", alignItems: "center", gap: 14 }}
        >
          {leading && <div style={{ flexShrink: 0 }}>{leading}</div>}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                flexWrap: "wrap",
              }}
            >
              <h1
                className="m-0 font-semibold"
                style={{
                  fontSize: 22,
                  letterSpacing: "-0.02em",
                  lineHeight: 1.2,
                  color: "var(--ds-fg)",
                  minWidth: 0,
                  overflowWrap: "anywhere",
                }}
              >
                {title}
              </h1>
              {meta}
            </div>
            {subtitle && (
              <p
                className="ds-mono m-0 mt-1"
                style={{ color: "var(--ds-fg-subtle)", fontSize: 12 }}
              >
                {subtitle}
              </p>
            )}
            {children && <div style={{ marginTop: 10 }}>{children}</div>}
          </div>
        </div>
        {right && (
          <div className="ds-page-header-actions flex gap-1.5 flex-wrap">
            {right}
          </div>
        )}
      </header>
    </>
  );
}

export function KeyVal({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}
    >
      <span
        className="ds-mono uppercase"
        style={{
          fontSize: 9,
          color: "var(--ds-fg-subtle)",
          letterSpacing: "0.08em",
        }}
      >
        {k}
      </span>
      <div
        // The value is clipped with an ellipsis; a string value gets a native
        // tooltip so the rest of a long device/IP string is still readable.
        title={typeof v === "string" ? v : undefined}
        style={{
          fontSize: 11.5,
          color: "var(--ds-fg-muted)",
          display: "inline-flex",
          alignItems: "center",
          lineHeight: 1.3,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {v}
      </div>
    </div>
  );
}

/* ── Formatting ───────────────────────────────────────────────── */

export function formatMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0)
    return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

// Seconds → "2h 15m" / "15m" / "45s", em-dash for non-positive. Delegates to
// the shared Intl-backed formatter (lib/format-duration.ts) so a non-English UI
// gets localized unit abbreviations. Without a `locale` it renders English —
// byte-identical to the old hand-rolled output — for the one-arg callers.
export function fmtDuration(seconds: number, locale = "en"): string {
  return formatDurationHM(seconds, locale);
}

// `source` is required, not optional: Plex reports kbps and Jellyfin bps, and
// the row is the only thing that can tell them apart (see lib/bitrate.ts). An
// optional param would silently default Jellyfin rows to the Plex reading and
// render them 1000x too high.
// `locale` localizes the decimal separator ("12,3 Mbps" for de/fr/pt/it); the
// unit stays "Mbps"/"kbps". Omitted, the legacy English output is unchanged.
export function fmtBitrate(raw: number | null, source: string | null, locale?: string): string {
  const kbps = bitrateToKbps(raw, source);
  if (kbps <= 0) return "—";
  if (kbps >= 1000) {
    const mbps = kbps / 1000;
    const text = locale
      ? new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(mbps)
      : mbps.toFixed(1);
    return `${text} Mbps`;
  }
  const whole = Math.round(kbps);
  return `${locale ? whole.toLocaleString(locale) : whole} kbps`;
}

// Renders a timestamp in the UI language and the viewer's timezone. TZ depends on the client, so the
// caller must pass `mounted` (from useHasMounted) — pre-hydration we return
// "" so SSR and the first client paint agree (guardrail 16).
export function fmtTimestamp(iso: string | null, mounted: boolean, locale: string): string {
  if (!mounted) return "";
  if (!iso) return "—";
  return new Date(iso).toLocaleString(locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/* ── Bars / distribution ──────────────────────────────────────── */

export function HorizontalBars({
  items,
  color = "var(--ds-accent)",
  labelWidth = 110,
}: {
  items: { label: string; count: number }[];
  color?: string;
  labelWidth?: number;
}) {
  const t = useT();
  const locale = useLocale();
  const max = Math.max(...items.map((i) => i.count), 1);
  if (items.length === 0)
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
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      {items.map((it) => (
        <div
          key={it.label}
          style={{ display: "flex", alignItems: "center", gap: 10 }}
        >
          <span
            style={{
              width: labelWidth,
              fontSize: 12,
              color: "var(--ds-fg-muted)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              flexShrink: 0,
            }}
          >
            {it.label}
          </span>
          <div
            style={{
              flex: 1,
              height: 6,
              background: "color-mix(in oklab, var(--ds-fg) 5%, transparent)",
              borderRadius: 999,
              overflow: "hidden",
              minWidth: 30,
            }}
          >
            <div
              style={{
                width: `${(it.count / max) * 100}%`,
                height: "100%",
                background: color,
                borderRadius: 999,
              }}
            />
          </div>
          <span
            className="ds-mono"
            style={{
              fontSize: 11,
              color: "var(--ds-fg-subtle)",
              fontVariantNumeric: "tabular-nums",
              width: 38,
              textAlign: "right",
              flexShrink: 0,
            }}
          >
            {it.count.toLocaleString(locale)}
          </span>
        </div>
      ))}
    </div>
  );
}

export function StreamTypeBars({
  data,
}: {
  data: { label: string; count: number; color: string }[];
}) {
  const locale = useLocale();
  const total = data.reduce((s, r) => s + r.count, 0);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div
        style={{
          display: "flex",
          height: 8,
          borderRadius: 999,
          overflow: "hidden",
          background: "color-mix(in oklab, var(--ds-fg) 4%, transparent)",
        }}
      >
        {data.map(
          (r) =>
            total > 0 &&
            r.count > 0 && (
              <div
                key={r.label}
                title={`${r.label}: ${r.count}`}
                style={{
                  flex: r.count,
                  background: r.color,
                  borderRight: "1px solid var(--ds-bg-2)",
                }}
              />
            ),
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {data.map((r) => {
          const pct = total > 0 ? Math.round((r.count / total) * 100) : 0;
          return (
            <div
              key={r.label}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                fontSize: 12,
                gap: 10,
              }}
            >
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 7,
                  color: "var(--ds-fg-muted)",
                  whiteSpace: "nowrap",
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 2,
                    background: r.color,
                    flexShrink: 0,
                  }}
                />
                {r.label}
              </span>
              <span
                className="ds-mono"
                style={{
                  fontSize: 11,
                  color: "var(--ds-fg-subtle)",
                  fontVariantNumeric: "tabular-nums",
                  whiteSpace: "nowrap",
                }}
              >
                {r.count.toLocaleString(locale)}{" "}
                <span style={{ color: "var(--ds-fg-subtle)" }}>· {pct}%</span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function BarColumn({
  data,
  h = 100,
  color = "var(--ds-accent)",
}: {
  data: number[];
  h?: number;
  color?: string;
}) {
  const max = Math.max(...data, 1);
  return (
    <div
      style={{ display: "flex", alignItems: "flex-end", gap: 2, height: h }}
    >
      {data.map((v, i) => (
        <div
          key={i}
          title={`${v}`}
          style={{
            flex: 1,
            minWidth: 0,
            height: `${Math.max((v / max) * 100, v > 0 ? 2 : 0)}%`,
            background: color,
            borderRadius: "2px 2px 0 0",
            opacity: 0.55 + (v / max) * 0.45,
          }}
        />
      ))}
    </div>
  );
}

/* ── KPI / stat tiles ─────────────────────────────────────────── */

// KPI tile. Label / value sizes and radius match the design-system StatCard
// (10.5px mono label, 26px value, var(--ds-r-lg)) so a tile on the Activity
// Users/Stats tabs is the same size as one on /admin/stats.
export function MiniKpi({
  label,
  value,
  sub,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  /** Legacy — every tile is StatCard-sized now; accepted so callers needn't change. */
  big?: boolean;
}) {
  return (
    <div
      style={{
        padding: "14px 16px",
        background: "var(--ds-bg-2)",
        border: "1px solid var(--ds-border)",
        borderRadius: "var(--ds-r-lg)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div
        className="ds-mono uppercase"
        style={{
          fontSize: 10.5,
          color: "var(--ds-fg-subtle)",
          letterSpacing: "0.08em",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 26,
          fontWeight: 600,
          letterSpacing: "-0.02em",
          color: "var(--ds-fg)",
          fontVariantNumeric: "tabular-nums",
          whiteSpace: "nowrap",
        }}
      >
        {value}
      </div>
      {sub && (
        <div
          className="ds-mono"
          style={{
            fontSize: 10.5,
            color: "var(--ds-fg-subtle)",
            whiteSpace: "nowrap",
          }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}

export function HeaderStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: ReactNode;
  tone?: "ok" | "info" | "warn";
}) {
  const color =
    tone === "ok"
      ? "var(--ds-success)"
      : tone === "info"
        ? "var(--ds-info)"
        : tone === "warn"
          ? "var(--ds-warning)"
          : "var(--ds-fg)";
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 3,
        alignItems: "flex-end",
        textAlign: "right",
      }}
    >
      <span
        className="ds-mono uppercase"
        style={{
          fontSize: 9.5,
          color: "var(--ds-fg-subtle)",
          letterSpacing: "0.1em",
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 20,
          fontWeight: 600,
          color,
          letterSpacing: "-0.02em",
          fontVariantNumeric: "tabular-nums",
          lineHeight: 1,
        }}
      >
        {value}
      </span>
    </div>
  );
}

/* ── Table header / sort / chevron ────────────────────────────── */

export function ChevIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 12 12"
      style={{
        transform: open ? "rotate(90deg)" : "none",
        transition: "transform 150ms var(--ds-ease)",
        color: "var(--ds-fg-subtle)",
      }}
    >
      <path
        d="M4.5 3l3 3-3 3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SortIcon({
  active,
  dir,
}: {
  active: boolean;
  dir?: "asc" | "desc";
}) {
  if (!active) {
    return (
      <svg
        width="10"
        height="10"
        viewBox="0 0 12 12"
        style={{ opacity: 0.3, color: "currentColor" }}
      >
        <path
          d="M4 5l2-2 2 2M4 7l2 2 2-2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 12 12"
      style={{ color: "var(--ds-accent-text)" }}
    >
      {dir === "asc" ? (
        <path
          d="M3 7l3-3 3 3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="M3 5l3 3 3-3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

export function Th({
  label,
  onSort,
  active,
  dir,
  width,
  align = "left",
}: {
  label?: string;
  onSort?: () => void;
  active?: boolean;
  dir?: "asc" | "desc";
  width?: number;
  align?: "left" | "right";
}) {
  return (
    <th
      scope="col"
      aria-sort={onSort ? (active ? (dir === "asc" ? "ascending" : "descending") : "none") : undefined}
      style={{
        textAlign: align,
        padding: "10px 11px",
        fontSize: 9.5,
        fontWeight: 500,
        color: active ? "var(--ds-fg)" : "var(--ds-fg-subtle)",
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        borderBottom: "1px solid var(--ds-border)",
        whiteSpace: "nowrap",
        userSelect: "none",
        width,
        fontFamily: "var(--font-mono)",
      }}
    >
      {onSort ? (
        <button
          type="button"
          onClick={onSort}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            justifyContent: align === "right" ? "flex-end" : "flex-start",
            width: "100%",
            padding: 0,
            border: 0,
            background: "transparent",
            color: "inherit",
            font: "inherit",
            letterSpacing: "inherit",
            textTransform: "inherit",
          }}
        >
          <span>{label}</span>
          <SortIcon active={!!active} dir={dir} />
        </button>
      ) : (
        label
      )}
    </th>
  );
}
