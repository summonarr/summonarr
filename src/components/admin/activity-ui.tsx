// Shared presentational primitives for the refined Activity dashboard.
// Ported from the Claude Design "Activity Page" handoff — DS-token styled,
// no client state so this module is safe to import from both the server
// page (KPI strip / calendar) and the "use client" section components.

import { Fragment, useId, type CSSProperties, type ReactNode } from "react";
import Image from "next/image";

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

export function Sparkline({
  data,
  w = 140,
  h = 22,
  color = "var(--ds-accent)",
}: {
  data: number[];
  w?: number;
  h?: number;
  color?: string;
}) {
  const gradId = useId().replace(/[:]/g, "");
  if (!data || data.length < 2) return <span style={{ display: "block", height: h }} />;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const step = w / (data.length - 1);
  const pts = data
    .map(
      (v, i) =>
        `${(i * step).toFixed(2)},${(h - ((v - min) / range) * h).toFixed(2)}`,
    )
    .join(" ");
  const area = `0,${h} ${pts} ${w},${h}`;
  return (
    <svg width={w} height={h} style={{ display: "block", overflow: "visible" }}>
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
      />
    </svg>
  );
}

export function AreaChart({
  data,
  h = 160,
  color = "var(--ds-accent)",
}: {
  data: number[];
  h?: number;
  color?: string;
}) {
  const gradId = useId().replace(/[:]/g, "");
  const w = 1000;
  if (!data || data.length < 2) return <div style={{ height: h }} />;
  const max = Math.max(...data, 1);
  const step = w / (data.length - 1);
  const pts = data
    .map((v, i) => `${(i * step).toFixed(2)},${(h - (v / max) * (h - 8) - 4).toFixed(2)}`)
    .join(" ");
  const area = `0,${h} ${pts} ${w},${h}`;
  const grid = [0.25, 0.5, 0.75].map((p) => h - p * (h - 8) - 4);
  return (
    <svg
      width="100%"
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      style={{ display: "block" }}
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
    </svg>
  );
}

// `matrix` is 7 rows (Mon..Sun) × 24 cols (hour 0..23) of raw counts.
export function HourHeatmap({ matrix }: { matrix: number[][] }) {
  const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const cell = 12;
  const gap = 2;
  const max = Math.max(1, ...matrix.flat());
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `28px repeat(24, ${cell}px)`,
        gap: `${gap}px ${gap}px`,
        justifyContent: "start",
      }}
    >
      <div />
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
          {row.map((v, c) => (
            <div
              key={c}
              title={`${DAYS[r]} ${c}:00 — ${v} plays`}
              style={{
                width: cell,
                height: cell,
                borderRadius: 2,
                background:
                  v === 0
                    ? "oklch(1 0 0 / 0.025)"
                    : `oklch(0.58 0.21 275 / ${(0.1 + (v / max) * 0.76).toFixed(3)})`,
              }}
            />
          ))}
        </Fragment>
      ))}
    </div>
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
