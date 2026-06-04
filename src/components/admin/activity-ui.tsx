"use client";

// Shared presentational primitives for the refined Activity dashboard.
// Ported from the Claude Design "Activity Page" handoff — DS-token styled.
// Only ever consumed by the "use client" section components
// (activity-sections / -now-playing / -recent-plays); page.tsx never imports
// this module directly. Sparkline/AreaChart carry hover state, so this is a
// client module. Tooltip date labels are precomputed server-side and passed
// down as `labels` — never derived from Date here (CLAUDE.md guardrail 16).

import {
  Fragment,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import Image from "next/image";
import {
  HeatmapCellPopover,
  type HeatmapCellAnchor,
} from "@/components/admin/heatmap-cell-popover";

/* ── Source helpers ───────────────────────────────────────────── */

export function sourceDotColor(source: string): string {
  return source === "plex" ? "var(--ds-plex)" : "var(--ds-jellyfin)";
}

export function SourceTag({ source }: { source: string }) {
  const isPlex = source === "plex";
  return (
    <span
      className="ds-mono"
      style={{
        fontSize: 9.5,
        padding: "1px 5px",
        borderRadius: 3,
        background: isPlex ? "var(--ds-plex)" : "var(--ds-jellyfin)",
        color: isPlex ? "#000" : "#fff",
        fontWeight: 700,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
      }}
    >
      {isPlex ? "Plex" : "Jellyfin"}
    </span>
  );
}

/* ── Stream method pill ───────────────────────────────────────── */

export type MethodClass = "ok" | "info" | "warn" | "err" | "muted";

export function methodLabel(
  playMethod: string | null,
  videoDecision?: string | null,
  audioDecision?: string | null,
): { label: string; cls: MethodClass } {
  if (playMethod === "DirectPlay") return { label: "Direct Play", cls: "ok" };
  if (playMethod === "DirectStream") return { label: "Remux", cls: "info" };
  if (playMethod === "Transcode") {
    const v = videoDecision === "transcode";
    const a = audioDecision === "transcode";
    if (v && a) return { label: "Transcode A/V", cls: "warn" };
    if (v) return { label: "Transcode video", cls: "warn" };
    if (a) return { label: "Transcode audio", cls: "warn" };
    return { label: "Transcode", cls: "warn" };
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
    ok: { bg: "oklch(0.72 0.18 150 / 0.12)", fg: "var(--ds-success)" },
    info: { bg: "oklch(0.70 0.14 225 / 0.13)", fg: "var(--ds-info)" },
    warn: { bg: "oklch(0.78 0.16 75 / 0.14)", fg: "var(--ds-warning)" },
    err: { bg: "oklch(0.65 0.22 25 / 0.14)", fg: "var(--ds-danger)" },
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
        boxShadow: "inset 0 0 0 1px oklch(1 0 0 / 0.04)",
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
  accent = "var(--ds-bg-3)",
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
        background: accent,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: Math.round(size * 0.46),
        fontWeight: 600,
        color: "oklch(0.96 0 0 / 0.9)",
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
  const total = data.reduce((a, b) => a + b, 0);
  const value = data[i] ?? 0;
  const avg = data.length > 0 ? total / data.length : 0;
  const prev = i > 0 ? data[i - 1] : null;
  // Round floats (watch-hours series) to one decimal; integers stay integer.
  const round1 = (n: number) => Math.round(n * 10) / 10;
  const fmt = (n: number) => round1(n).toLocaleString("en-US");
  const share = total > 0 ? round1((value / total) * 100) : 0;
  const avgPct = avg > 0 ? Math.round(((value - avg) / avg) * 100) : null;
  const delta = prev !== null ? round1(value - prev) : null;
  const deltaPct =
    prev !== null && prev !== 0 ? Math.round(((value - prev) / prev) * 100) : null;

  const rows: { label: string; value: string; color: string }[] = [
    { label: "Share", value: `${share}%`, color: "var(--ds-fg-muted)" },
  ];
  if (avgPct !== null) {
    rows.push({
      label: "vs avg",
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
      label: "vs prev",
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
            style={{ fontSize: 8.5, letterSpacing: "0.06em", color: "var(--ds-fg-disabled)" }}
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
  const wrapRef = useRef<HTMLDivElement>(null);
  // `wrapW` is captured in the mousemove handler (which has the live rect),
  // not read off the ref during render — the React Compiler forbids reading
  // ref.current in the render path.
  const [hover, setHover] = useState<{
    i: number;
    x: number;
    wrapW: number;
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
    setHover({
      i: Math.round(t * (data.length - 1)),
      x: t * rect.width,
      wrapW: rect.width,
    });
  };

  const TT_W = 120;
  const ttLeft = hover
    ? Math.max(-4, Math.min(hover.wrapW - TT_W + 4, hover.x - TT_W / 2))
    : 0;

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
        {hover && (
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
      {hover && (
        <div
          style={{
            position: "absolute",
            left: ttLeft,
            bottom: h + 6,
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
            zIndex: 5,
          }}
        >
          {labels?.[hover.i] && (
            <div
              className="ds-mono uppercase"
              style={{
                fontSize: 9,
                letterSpacing: "0.08em",
                color: "var(--ds-fg-disabled)",
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
            {data[hover.i].toLocaleString("en-US")}
            {valueSuffix}
          </div>
          <ChartTooltipDetail data={data} i={hover.i} />
        </div>
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
  const wrapRef = useRef<HTMLDivElement>(null);
  // `wrapW` captured in the handler, not read off the ref during render.
  const [hover, setHover] = useState<{
    i: number;
    x: number;
    y: number;
    wrapW: number;
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
    setHover({
      i,
      x: t * rect.width,
      y: (yFor(data[i]) / h) * rect.height,
      wrapW: rect.width,
    });
  };

  const TT_W = 120;
  const ttLeft = hover
    ? Math.max(4, Math.min(hover.wrapW - TT_W - 4, hover.x - TT_W / 2))
    : 0;

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
        {hover && (
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
      {hover && (
        <div
          style={{
            position: "absolute",
            left: ttLeft,
            // Float the tooltip above the hovered point; translateY(-100%)
            // lifts it by its own height so it escapes the plot area upward
            // (the card chain is overflow:visible) instead of overlapping the
            // line or being clamped inside the graph.
            top: hover.y - 12,
            transform: "translateY(-100%)",
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
            zIndex: 4,
          }}
        >
          {labels?.[hover.i] && (
            <div
              className="ds-mono uppercase"
              style={{
                fontSize: 9,
                letterSpacing: "0.08em",
                color: "var(--ds-fg-disabled)",
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
            {data[hover.i].toLocaleString("en-US")}
            {valueSuffix}
          </div>
          <ChartTooltipDetail data={data} i={hover.i} />
        </div>
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
  const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
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
        title="Hours are bucketed in UTC"
        style={{ fontSize: 7.5, color: "var(--ds-fg-disabled)", alignSelf: "end", lineHeight: 1 }}
      >
        UTC
      </div>
      {Array.from({ length: 24 }).map((_, hr) => (
        <div
          key={hr}
          className="ds-mono"
          style={{
            fontSize: 8.5,
            color: "var(--ds-fg-disabled)",
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
              color: "var(--ds-fg-disabled)",
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
                title={`${DAYS[r]} ${c}:00 — ${v} plays`}
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
                      ? "oklch(1 0 0 / 0.025)"
                      : `oklch(0.58 0.21 275 / ${(0.1 + (v / max) * 0.76).toFixed(3)})`,
                }}
              />
            );
          })}
        </Fragment>
      ))}
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
        background: "oklch(1 0 0 / 0.06)",
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
              background: "oklch(1 0 0 / 0.05)",
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
        borderRadius: 10,
        ...style,
      }}
    >
      {children}
    </section>
  );
}

export function SectionHeader({
  label,
  sub,
  right,
}: {
  label: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        marginBottom: 12,
        gap: 10,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 10,
          minWidth: 0,
          flexWrap: "wrap",
        }}
      >
        <h2
          style={{
            margin: 0,
            fontSize: 13,
            fontWeight: 600,
            letterSpacing: "-0.01em",
            color: "var(--ds-fg)",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </h2>
        {sub && (
          <span
            className="ds-mono"
            style={{
              fontSize: 11,
              color: "var(--ds-fg-subtle)",
              fontVariantNumeric: "tabular-nums",
              whiteSpace: "nowrap",
            }}
          >
            {sub}
          </span>
        )}
      </div>
      {right}
    </div>
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
          color: "var(--ds-fg-disabled)",
          letterSpacing: "0.08em",
        }}
      >
        {k}
      </span>
      <div
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

export function fmtDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.round(seconds)}s`;
}

export function fmtBitrate(raw: number | null): string {
  if (!raw || raw <= 0) return "—";
  // Plex reports kbps; Jellyfin bps — normalize to kbps.
  const kbps = raw > 100000 ? raw / 1000 : raw;
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`;
  return `${Math.round(kbps)} kbps`;
}

// Renders a localized timestamp. Locale + TZ depend on the client, so the
// caller must pass `mounted` (from useHasMounted) — pre-hydration we return
// "" so SSR and the first client paint agree (guardrail 16).
export function fmtTimestamp(iso: string | null, mounted: boolean): string {
  if (!mounted) return "";
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
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
  const max = Math.max(...items.map((i) => i.count), 1);
  if (items.length === 0)
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
              background: "oklch(1 0 0 / 0.05)",
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
            {it.count.toLocaleString("en-US")}
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
  const total = data.reduce((s, r) => s + r.count, 0);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div
        style={{
          display: "flex",
          height: 8,
          borderRadius: 999,
          overflow: "hidden",
          background: "oklch(1 0 0 / 0.04)",
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
                {r.count.toLocaleString("en-US")}{" "}
                <span style={{ color: "var(--ds-fg-disabled)" }}>· {pct}%</span>
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

export function MiniKpi({
  label,
  value,
  sub,
  big,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  big?: boolean;
}) {
  return (
    <div
      style={{
        padding: "14px 16px",
        background: "var(--ds-bg-2)",
        border: "1px solid var(--ds-border)",
        borderRadius: 10,
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <div
        className="ds-mono uppercase"
        style={{
          fontSize: 9.5,
          color: "var(--ds-fg-disabled)",
          letterSpacing: "0.1em",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: big ? 22 : 19,
          fontWeight: 600,
          letterSpacing: "-0.025em",
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
          color: "var(--ds-fg-disabled)",
          letterSpacing: "0.1em",
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 26,
          fontWeight: 600,
          color,
          letterSpacing: "-0.025em",
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
      style={{ color: "var(--ds-accent)" }}
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
      onClick={onSort}
      style={{
        textAlign: align,
        padding: "10px 11px",
        fontSize: 9.5,
        fontWeight: 500,
        color: active ? "var(--ds-fg)" : "var(--ds-fg-disabled)",
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        borderBottom: "1px solid var(--ds-border)",
        cursor: onSort ? "pointer" : "default",
        whiteSpace: "nowrap",
        userSelect: "none",
        width,
        fontFamily: "var(--font-mono)",
      }}
    >
      {onSort ? (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            justifyContent: align === "right" ? "flex-end" : "flex-start",
            width: "100%",
          }}
        >
          <span>{label}</span>
          <SortIcon active={!!active} dir={dir} />
        </span>
      ) : (
        label
      )}
    </th>
  );
}
