"use client";

// Shared building blocks (cards, headers, tags, bars, tiles) for the Activity
// dashboard, used by the activity-* client components and by the server-rendered
// play detail page (admin/activity/play/[id]), so every Activity view shares one
// look. The rest lives beside it and is re-exported from here, so the views
// import one module:
//   activity-format.ts   pure formatters, labels and folds (no "use client": a
//                        server page calls them directly — import them from
//                        there in server code)
//   activity-charts.tsx  Sparkline / AreaChart
//   activity-heatmap.tsx HourHeatmap
//   activity-table.tsx   Th / Td and the table icons

import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { foldBarItems } from "@/lib/activity-bars";
import { zoneShortLabel } from "@/lib/stats-time-zone";
import { Chip, EmptyState, SectionHeader as DsSectionHeader } from "@/components/ui/design";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { isLoadablePoster, sourceMeta, type MethodClass } from "./activity-format";

export {
  SOURCE_META,
  STREAM_META,
  WEEKDAY_KEYS,
  bucketLabel,
  fmtBitrate,
  fmtDuration,
  fmtTimestamp,
  formatMs,
  isLoadablePoster,
  methodLabel,
  normalizeHeatmapMatrix,
  sourceDotColor,
  sourceMeta,
  streamTypeSegments,
  toHeatmapMatrix,
  utcShortDayFormatter,
  type MethodClass,
  type SourceMeta,
} from "./activity-format";
export { AreaChart, Sparkline } from "./activity-charts";
export { HourHeatmap } from "./activity-heatmap";
export { ChevIcon, SortIcon, Td, Th } from "./activity-table";

/* ── Source helpers ───────────────────────────────────────────── */

// The small Plex/Jellyfin dot beside a name. Colour alone can't tell a screen
// reader or a colour-blind viewer which server it is, so the dot carries the
// name as an image label (and a hover title). Brand colours stay fills
// (guardrail 42); brand names are not translated. A source no server type
// names shows as itself, in a neutral colour (sourceMeta).
export function SourceDot({
  source,
  size = 5,
  style,
}: {
  source: string;
  size?: number;
  style?: CSSProperties;
}) {
  const meta = sourceMeta(source);
  return (
    <span
      role="img"
      aria-label={meta.label}
      title={meta.label}
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: 999,
        flexShrink: 0,
        background: meta.color,
        ...style,
      }}
    />
  );
}

// `instance` is a media-server instance slug (see media-instances.ts). When it
// is non-empty the tag reads "PLEX:remote", matching mediaInstanceLabel. The
// default server's slug is "" (also what every older row holds), so it shows
// just "PLEX" — single-server setups look exactly as they did before.
// The colour depends only on `source`. Renders the design-system Chip
// (`.ds-chip-plex` / `.ds-chip-jellyfin`) so the badge is the same pill as
// every other Plex/Jellyfin chip in the app, not a second squared rendering.
export function SourceTag({ source, instance }: { source: string; instance?: string }) {
  const meta = sourceMeta(source);
  return (
    <Chip tone={meta.tone} className="ds-mono uppercase">
      {meta.label}
      {instance ? `:${instance}` : ""}
    </Chip>
  );
}

/* ── Stream method pill ───────────────────────────────────────── */

const METHOD_COLORS: Record<MethodClass, { bg: string; fg: string }> = {
  // Tints are the status TOKENS at 12–14% (guardrail 42: the text tokens are
  // tuned against their own 5–20% tints), so a token retune carries here.
  ok: { bg: "color-mix(in oklab, var(--ds-success) 12%, transparent)", fg: "var(--ds-success)" },
  info: { bg: "color-mix(in oklab, var(--ds-info) 13%, transparent)", fg: "var(--ds-info)" },
  warn: { bg: "color-mix(in oklab, var(--ds-warning) 14%, transparent)", fg: "var(--ds-warning)" },
  err: { bg: "color-mix(in oklab, var(--ds-danger) 14%, transparent)", fg: "var(--ds-danger)" },
  muted: { bg: "var(--ds-bg-3)", fg: "var(--ds-fg-muted)" },
};

export function MethodPill({
  method,
  methodClass,
}: {
  method: string;
  methodClass: MethodClass;
}) {
  const c = METHOD_COLORS[methodClass] ?? METHOD_COLORS.muted;
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

// A TMDB poster, else a letter tile. Only TMDB's image path goes to next/image
// (the one remote pattern next.config.ts allows — any other URL is a 400), and
// a poster TMDB no longer serves falls back to the tile instead of a broken
// image. The failure is remembered per URL, so a new `src` gets its own try.
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
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (isLoadablePoster(src) && failedSrc !== src) {
    return (
      <Image
        src={src}
        alt=""
        width={Math.round(w * 2)}
        height={Math.round(h * 2)}
        sizes={`${w}px`}
        onError={() => setFailedSrc(src)}
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

// A row of Activity cards: a CSS grid of `columns` with the cards' 10px gap.
// `className` is the responsive collapse (resp-grid-2 / resp-grid-3 stack the
// columns on a phone).
export function ActivityGrid({
  className,
  columns,
  style,
  children,
}: {
  className: "resp-grid-2" | "resp-grid-3";
  columns: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <div className={className} style={{ display: "grid", gridTemplateColumns: columns, gap: 10, ...style }}>
      {children}
    </div>
  );
}

/* ── Time zone marker ─────────────────────────────────────────── */

// The activity aggregates bucket hours and days in the statistics time zone
// (an admin setting, the server's own zone by default). Every chart drawn from
// them says which: without it a viewer in another zone reads the evening peak
// as "2:00" with nothing to say why. `zone` comes from the server with the
// data; the tag shows its short name, `title` the full one.
export function ZoneTag({ zone, title }: { zone: string; title: string }) {
  return (
    <span
      className="ds-mono"
      title={title}
      style={{
        fontSize: 9.5,
        letterSpacing: "0.06em",
        color: "var(--ds-fg-subtle)",
        border: "1px solid var(--ds-border)",
        borderRadius: 4,
        padding: "0 4px",
        lineHeight: "15px",
        whiteSpace: "nowrap",
      }}
    >
      {zoneShortLabel(zone)}
    </span>
  );
}

/* ── Empty card body ──────────────────────────────────────────── */

// The shared DS empty block, iconless — the one "nothing here" recipe every
// Activity card uses (guardrail 42), so the cards of one row read alike.
// Defaults to "No data yet"; a card that knows WHY it is empty says so.
export function Empty({ description }: { description?: ReactNode }) {
  const t = useT();
  return <EmptyState description={description ?? t("adminActivity.common.noDataYet")} />;
}

/* ── Leaderboard row ──────────────────────────────────────────── */

// One ranked row of an Activity leaderboard (top viewers, top titles, most
// rewatched): rank, avatar/poster, name, figures and a bar scaled to the
// leader. The whole row is the link. `pct` is clamped, so a caller whose list
// isn't sorted by the bar's figure can't draw past the track.
export function LeaderboardRow({
  href,
  rank,
  avatar,
  title,
  source,
  tag,
  primary,
  secondary,
  pct,
}: {
  href: string;
  rank: number;
  avatar?: ReactNode;
  title: string;
  // Plex/Jellyfin dot after the name.
  source?: string;
  // A small trailing label after the name (the media type).
  tag?: ReactNode;
  primary: ReactNode;
  secondary?: ReactNode;
  pct: number;
}) {
  return (
    <Link
      href={href}
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
        {rank.toString().padStart(2, "0")}
      </span>
      {avatar}
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
              textOverflow: "ellipsis",
              minWidth: 0,
            }}
          >
            {/* title: the name is ellipsized, so hover shows the whole of it. */}
            <span
              title={title}
              style={{ overflow: "hidden", textOverflow: "ellipsis" }}
            >
              {title}
            </span>
            {source && <SourceDot source={source} />}
            {tag}
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
            {primary}
            {secondary && (
              <span style={{ color: "var(--ds-fg-subtle)" }}>
                {" "}
                · {secondary}
              </span>
            )}
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
              width: `${Math.max(0, Math.min(100, pct))}%`,
              height: "100%",
              background: "var(--ds-accent)",
              borderRadius: 999,
            }}
          />
        </div>
      </div>
    </Link>
  );
}

/* ── Bars / distribution ──────────────────────────────────────── */

export function HorizontalBars({
  items: rawItems,
  color = "var(--ds-accent)",
  labelWidth = 110,
}: {
  items: { label: string; count: number }[];
  color?: string;
  labelWidth?: number;
}) {
  const locale = useLocale();
  // Two stored values can share a display label ('Unknown' and an upstream
  // literal 'unknown' both read "Unknown"); the label is the row key, so they
  // are merged here, once, for every caller.
  const items = foldBarItems(rawItems);
  const max = Math.max(...items.map((i) => i.count), 1);
  if (items.length === 0) return <Empty />;
  // `contain: inline-size` is load-bearing, as on HourHeatmap: every caller
  // sits in a `1fr` grid column (minmax(auto, 1fr)), and while the column is
  // sized a percentage max-width has nothing to resolve against, so a wide
  // label (230px for transcode reasons) counted at full width and pushed the
  // card past a phone's gutter — at 360px, the page scrolled sideways. With
  // containment the list adds no width of its own and the label's maxWidth
  // then caps it to its share of the real row. The full text stays on hover.
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7, contain: "inline-size" }}>
      {items.map((it) => (
        <div
          key={it.label}
          style={{ display: "flex", alignItems: "center", gap: 10 }}
        >
          <span
            title={it.label}
            style={{
              width: labelWidth,
              maxWidth: "45%",
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
              minWidth: 38,
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
  const pctFmt = useMemo(() => new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }), [locale]);
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
          (r, i) =>
            total > 0 &&
            r.count > 0 && (
              <div
                key={`${i}:${r.label}`}
                title={`${r.label}: ${r.count.toLocaleString(locale)}`}
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
        {data.map((r, i) => {
          const share = total > 0 ? r.count / total : 0;
          return (
            <div
              key={`${i}:${r.label}`}
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
                <span style={{ color: "var(--ds-fg-subtle)" }}>· {pctFmt.format(share)}</span>
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
  titles,
}: {
  data: number[];
  h?: number;
  color?: string;
  // Per-bar hover text ("21:00 New York · 5 plays"). Without it a bar shows its bare count.
  titles?: string[];
}) {
  const max = Math.max(...data, 1);
  return (
    <div
      style={{ display: "flex", alignItems: "flex-end", gap: 2, height: h }}
    >
      {data.map((v, i) => (
        <div
          key={i}
          title={titles?.[i] ?? `${v}`}
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

export type HeaderStatTone = "ok" | "info" | "warn";
const HEADER_STAT_COLOR: Record<HeaderStatTone, string> = {
  ok: "var(--ds-success)",
  info: "var(--ds-info)",
  warn: "var(--ds-warning)",
};

export function HeaderStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: ReactNode;
  tone?: HeaderStatTone;
}) {
  const color = tone ? HEADER_STAT_COLOR[tone] : "var(--ds-fg)";
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
