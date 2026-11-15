"use client";

// Click-to-open drill-down popover for the activity heatmap cells
// (activity-calendar.tsx day cells, activity-ui.tsx HourHeatmap dow/hour cells).
// Lazy-fetches /api/admin/play-history/heatmap-cell for the clicked bucket and
// renders the per-cell aggregate. Rendered in a body portal with position:fixed
// so the heatmaps' `overflow-x: auto` containers can't clip it.

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { Loader2, X } from "@/components/icons";
import type { HeatmapCellDetail } from "@/lib/play-history";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { translateTranscodeReason } from "@/lib/transcode-reasons";
import { cellLoadError, fetchHeatmapCell, joinParts, pct, type CellLoadError } from "@/components/admin/heatmap-cell-detail";
import { mediaServerName } from "@/lib/media-server-name";

const POPOVER_WIDTH = 264;
const MARGIN = 8;

export interface HeatmapCellAnchor {
  // Viewport coordinates of the clicked cell (getBoundingClientRect).
  x: number;
  y: number;
  w: number;
  h: number;
}

// Lazy-fetch the clicked cell's detail. queryString is stable (set once in the
// parent's click handler), so this fires once per opened cell, and again per
// Retry (`attempt`). A new cell, a Retry or closing the popover aborts the read
// in flight. The raw transport/server detail goes to the console.
function useCellDetail(queryString: string, attempt: number) {
  const [detail, setDetail] = useState<HeatmapCellDetail | null>(null);
  const [error, setError] = useState<CellLoadError | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setDetail(null);
    setError(null);
    void fetchHeatmapCell(queryString, controller.signal).then((res) => {
      if (res.ok) {
        setDetail(res.data);
        return;
      }
      if (res.kind === "aborted") return;
      console.error("[heatmap-cell]", res.detail);
      setError(cellLoadError(res));
    });
    return () => controller.abort();
  }, [queryString, attempt]);
  return { detail, error };
}

// Position below the cell when there's room, else above; clamp horizontally to
// the viewport. Measured after layout so the height is known before placing;
// re-measured when the body changes height (`body`, `failure`: loaded, failed).
function usePlacement(ref: RefObject<HTMLDivElement | null>, anchor: HeatmapCellAnchor, body: unknown, failure: unknown) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = anchor.x;
    if (left + POPOVER_WIDTH + MARGIN > vw) left = vw - POPOVER_WIDTH - MARGIN;
    if (left < MARGIN) left = MARGIN;
    const below = anchor.y + anchor.h + 6;
    const top = below + rect.height + MARGIN > vh ? anchor.y - rect.height - 6 : below;
    setPos({ left, top: Math.max(MARGIN, top) });
  }, [ref, anchor, body, failure]);
  return pos;
}

// The popover is portaled to the end of <body>, so without this a keyboard
// user would have to tab through the whole page to reach its links. Move
// focus in once it is placed (a visibility:hidden element can't take focus),
// and hand it back to whatever opened it on close.
function useFocusHandoff(ref: RefObject<HTMLDivElement | null>, closeRef: RefObject<HTMLButtonElement | null>, placed: boolean) {
  const movedFocusRef = useRef(false);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const popover = ref.current;
    return () => {
      const active = document.activeElement;
      const focusInside = !active || active === document.body || (popover?.contains(active) ?? false);
      if (focusInside && opener?.isConnected) opener.focus();
    };
  }, [ref]);
  useEffect(() => {
    if (!placed || movedFocusRef.current) return;
    movedFocusRef.current = true;
    closeRef.current?.focus();
  }, [placed, closeRef]);
}

// Dismiss on outside click, Escape, ANY page scroll and a resize. The
// popover is position:fixed on an anchor measured once at click time, so a
// scroll or a reflow would leave it floating over whatever moved underneath.
// Scroll events don't bubble, hence `capture` — the heatmaps' own overflow
// containers scroll too. The popover's own body scrolls when it is taller
// than the viewport, so a scroll inside it is not a dismissal.
//
// The listeners are registered ONCE: both callers pass an inline onClose,
// which a dependency would re-register on every parent render. They call the
// latest one through a ref, updated after each commit.
function useDismiss(ref: RefObject<HTMLDivElement | null>, onClose: () => void) {
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    const close = () => onCloseRef.current();
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    // Tabbing out of the dialog dismisses it, so it never floats beside the page's own focus.
    function onFocusIn(e: FocusEvent) {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) close();
    }
    function onScroll(e: Event) {
      if (e.target instanceof Node && ref.current?.contains(e.target)) return;
      close();
    }
    const scrollOpts: AddEventListenerOptions = { passive: true, capture: true };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocusIn);
    window.addEventListener("scroll", onScroll, scrollOpts);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("scroll", onScroll, scrollOpts);
      window.removeEventListener("resize", close);
    };
  }, [ref]);
}

export function HeatmapCellPopover({
  queryString,
  anchor,
  label,
  viewPlaysHref,
  onClose,
}: {
  queryString: string;
  anchor: HeatmapCellAnchor;
  label: string;
  // When set, a "View these plays →" footer links to the History tab filtered
  // to this bucket. Day cells pass it; hour cells don't (no hour-of-day filter).
  viewPlaysHref?: string;
  onClose: () => void;
}) {
  const t = useT();
  // Bumped by Retry to re-run the fetch for the same cell.
  const [attempt, setAttempt] = useState(0);
  const { detail, error } = useCellDetail(queryString, attempt);
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const pos = usePlacement(ref, anchor, detail, error);
  useFocusHandoff(ref, closeRef, pos !== null);
  useDismiss(ref, onClose);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={t("adminActivity.popover.dialogAria", { label })}
      style={{
        position: "fixed",
        left: pos?.left ?? anchor.x,
        top: pos?.top ?? anchor.y + anchor.h + 6,
        width: POPOVER_WIDTH,
        // Never taller than the viewport: the header and the "View these
        // plays" link stay put and the body between them scrolls.
        maxHeight: `calc(100dvh - ${MARGIN * 2}px)`,
        display: "flex",
        flexDirection: "column",
        visibility: pos ? "visible" : "hidden",
        zIndex: 60,
        background: "var(--ds-bg-1)",
        border: "1px solid var(--ds-border)",
        borderRadius: 10,
        boxShadow: "var(--ds-shadow-lg)",
        padding: 0,
        fontSize: 11,
        color: "var(--ds-fg)",
      }}
    >
      <div
        className="flex items-center justify-between"
        style={{ padding: "9px 12px", borderBottom: "1px solid var(--ds-border)" }}
      >
        <span className="ds-mono" style={{ fontSize: 11, color: "var(--ds-fg)" }}>
          {label}
        </span>
        <button
          type="button"
          ref={closeRef}
          onClick={onClose}
          aria-label={t("adminActivity.common.close")}
          className="inline-flex items-center justify-center rounded-full"
          style={{ width: 32, height: 32, margin: "-6px -8px -6px 0", background: "transparent", border: 0, color: "var(--ds-fg-muted)" }}
        >
          <X style={{ width: 13, height: 13 }} />
        </button>
      </div>

      <div style={{ padding: "10px 12px", overflowY: "auto", minHeight: 0 }}>
        {error ? (
          <div>
            <p role="alert" style={{ color: "var(--ds-danger)", margin: 0 }}>{"text" in error ? error.text : t(error.key)}</p>
            <button
              type="button"
              className="ds-hover-tint ds-mono"
              onClick={() => setAttempt((n) => n + 1)}
              style={{
                marginTop: 8,
                fontSize: 10.5,
                padding: "4px 10px",
                borderRadius: 6,
                background: "transparent",
                border: "1px solid var(--ds-border)",
                color: "var(--ds-fg-muted)",
              }}
            >
              {t("adminActivity.common.retry")}
            </button>
          </div>
        ) : !detail ? (
          <div
            className="ds-mono flex items-center"
            style={{ gap: 7, padding: "10px 0", color: "var(--ds-fg-subtle)" }}
          >
            <Loader2 className="animate-spin" style={{ width: 13, height: 13, color: "var(--ds-accent-text)" }} />
            {t("adminActivity.common.loading")}
          </div>
        ) : detail.totalPlays === 0 ? (
          <p style={{ color: "var(--ds-fg-subtle)", margin: 0 }}>{t("adminActivity.popover.noPlays")}</p>
        ) : (
          <CellBody detail={detail} />
        )}
      </div>

      {viewPlaysHref && detail && detail.totalPlays > 0 && (
        <Link
          href={viewPlaysHref}
          className="ds-mono"
          style={{
            display: "block",
            padding: "8px 12px",
            borderTop: "1px solid var(--ds-border)",
            fontSize: 10.5,
            color: "var(--ds-accent-text)",
            textDecoration: "none",
          }}
        >
          {t("adminActivity.popover.viewPlays")}
        </Link>
      )}
    </div>,
    document.body,
  );
}

function CellBody({ detail }: { detail: HeatmapCellDetail }) {
  const t = useT();
  const locale = useLocale();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* Headline numbers */}
      <div style={{ display: "flex", gap: 14, alignItems: "baseline" }}>
        <Stat value={detail.totalPlays.toLocaleString(locale)} unit={t("adminActivity.popover.unitPlays", { count: detail.totalPlays })} big />
        <Stat value={detail.watchHours.toLocaleString(locale, { maximumFractionDigits: 1 })} unit={t("adminActivity.popover.unitHoursWatched")} />
        <Stat value={detail.avgSessionMinutes.toLocaleString(locale)} unit={t("adminActivity.popover.unitMinAvg")} />
      </div>

      <StreamMethodSection methods={detail.methods} />

      {detail.topTranscodeReasons.length > 0 && (
        <Section title={t("adminActivity.popover.transcodeReasons")}>
          {detail.topTranscodeReasons.map((r) => (
            <KV key={r.reason} k={translateTranscodeReason(r.reason, t)} v={`${r.count}`} />
          ))}
        </Section>
      )}

      {detail.topTitles.length > 0 && (
        <Section title={t("adminActivity.popover.topTitles")}>
          {detail.topTitles.map((tt) => (
            // Key on the tuple the SQL groups by — (tmdbId, mediaType), falling
            // back to the title when tmdbId is null. TMDB movie and TV ids are
            // separate namespaces that overlap numerically, so a movie and a
            // series sharing an integer are two rows: distinct keys, and the
            // link carries ?type= so the stats page doesn't blend the two.
            <KV
              key={`${tt.mediaType ?? ""}:${tt.tmdbId != null ? `id:${tt.tmdbId}` : `t:${tt.title}`}`}
              k={tt.title}
              v={`${tt.count}`}
              href={
                tt.tmdbId
                  ? `/admin/activity/media/${tt.tmdbId}${tt.mediaType ? `?type=${encodeURIComponent(tt.mediaType)}` : ""}`
                  : undefined
              }
            />
          ))}
        </Section>
      )}

      {detail.topUsers.length > 0 && (
        <Section title={t("adminActivity.popover.topViewers", { count: detail.topUsers.length })}>
          {detail.topUsers.map((u) => (
            <KV
              key={u.id}
              k={u.username}
              v={`${u.count}`}
              href={`/admin/activity/user/${encodeURIComponent(String(u.id))}`}
            />
          ))}
        </Section>
      )}

      {/* Completion */}
      <Section title={t("adminActivity.popover.completion")}>
        <KV k={t("adminActivity.popover.finished")} v={`${detail.completedPct}% · ${detail.completedCount}/${detail.totalPlays}`} />
      </Section>

      <QualityNetworkSection detail={detail} />

      <BreakdownSection detail={detail} />
    </div>
  );
}

// Transcode / stream mix: a stacked bar and its legend.
function StreamMethodSection({ methods: m }: { methods: HeatmapCellDetail["methods"] }) {
  const t = useT();
  const methodTotal = m.directPlay + m.directStream + m.transcode + m.other;
  const methodRows = [
    { label: t("adminActivity.method.directPlay"), count: m.directPlay, color: "var(--ds-success, #2c9)" },
    { label: t("adminActivity.method.directStream"), count: m.directStream, color: "var(--ds-accent)" },
    { label: t("adminActivity.method.transcode"), count: m.transcode, color: "var(--ds-warning)" },
    { label: t("adminActivity.method.other"), count: m.other, color: "var(--ds-fg-disabled)" },
  ].filter((r) => r.count > 0);
  if (methodRows.length === 0) return null;
  return (
    <Section title={t("adminActivity.popover.streamMethod")}>
      <div style={{ display: "flex", height: 5, borderRadius: 999, overflow: "hidden", gap: 1 }}>
        {methodRows.map((r) => (
          <div
            key={r.label}
            style={{ flex: r.count, background: r.color }}
            title={`${r.label}: ${r.count}`}
          />
        ))}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 10px", marginTop: 6 }}>
        {methodRows.map((r) => (
          <KV key={r.label} dot={r.color} k={r.label} v={`${r.count} · ${pct(r.count, methodTotal)}`} />
        ))}
      </div>
    </Section>
  );
}

// Bitrate, data, resolutions and where the streams came from (LAN/WAN/relay).
function QualityNetworkSection({ detail }: { detail: HeatmapCellDetail }) {
  const t = useT();
  const locale = useLocale();
  const oneDecimal = (n: number) => n.toLocaleString(locale, { maximumFractionDigits: 1 });
  return (
    <Section title={t("adminActivity.popover.qualityNetwork")}>
      {detail.avgBitrateMbps > 0 && <KV k={t("adminActivity.popover.avgBitrate")} v={t("adminActivity.popover.bitrateValue", { value: oneDecimal(detail.avgBitrateMbps) })} />}
      {detail.dataTransferredGb > 0 && <KV k={t("adminActivity.popover.data")} v={t("adminActivity.popover.dataValue", { value: oneDecimal(detail.dataTransferredGb) })} />}
      {detail.topResolutions.length > 0 && (
        <KV
          k={t("adminActivity.popover.resolution")}
          wrapValue
          v={detail.topResolutions.map((r) => `${r.resolution} (${r.count})`).join(", ")}
        />
      )}
      {(detail.network.lan > 0 || detail.network.wan > 0 || detail.network.relay > 0) && (
        <KV
          k={t("adminActivity.popover.network")}
          wrapValue
          v={joinParts([
            detail.network.lan > 0 && t("adminActivity.popover.lanCount", { count: detail.network.lan }),
            detail.network.wan > 0 && t("adminActivity.popover.wanCount", { count: detail.network.wan }),
            detail.network.relay > 0 && t("adminActivity.popover.relayCount", { count: detail.network.relay }),
          ])}
        />
      )}
    </Section>
  );
}

// Which server and which kind of title the plays were.
function BreakdownSection({ detail }: { detail: HeatmapCellDetail }) {
  const t = useT();
  return (
    <Section title={t("adminActivity.popover.breakdown")}>
      {(detail.source.plex > 0 || detail.source.jellyfin > 0) && (
        <KV
          k={t("adminActivity.popover.source")}
          v={joinParts([
            detail.source.plex > 0 && t("adminActivity.popover.serverCount", { server: mediaServerName("plex"), count: detail.source.plex }),
            detail.source.jellyfin > 0 && t("adminActivity.popover.serverCount", { server: mediaServerName("jellyfin"), count: detail.source.jellyfin }),
          ])}
        />
      )}
      {(detail.mediaType.movie > 0 || detail.mediaType.tv > 0) && (
        <KV
          k={t("adminActivity.popover.type")}
          v={joinParts([
            detail.mediaType.movie > 0 && t("adminActivity.popover.moviesCount", { count: detail.mediaType.movie }),
            detail.mediaType.tv > 0 && t("adminActivity.popover.tvCount", { count: detail.mediaType.tv }),
          ])}
        />
      )}
    </Section>
  );
}

function Stat({ value, unit, big }: { value: string; unit: string; big?: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <span style={{ fontSize: big ? 20 : 14, fontWeight: 600, lineHeight: 1, color: "var(--ds-fg)" }}>
        {value}
      </span>
      <span className="ds-mono" style={{ fontSize: 10, color: "var(--ds-fg-subtle)", marginTop: 2 }}>
        {unit}
      </span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p
        className="ds-mono"
        style={{ fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--ds-fg-subtle)", margin: "0 0 4px" }}
      >
        {title}
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>{children}</div>
    </div>
  );
}

function KV({
  k,
  v,
  dot,
  href,
  wrapValue,
}: {
  k: string;
  v: string;
  dot?: string;
  href?: string;
  // Multi-item values (Resolution, Network) can exceed the popover width. With
  // wrapValue the label stays fixed and the value wraps inside the box instead
  // of running off the right edge (the overhang bug).
  wrapValue?: boolean;
}) {
  const keyText = (
    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{k}</span>
  );
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 10,
        alignItems: wrapValue ? "flex-start" : "center",
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          color: "var(--ds-fg-muted)",
          minWidth: 0,
          flexShrink: wrapValue ? 0 : 1,
        }}
      >
        {dot && <span style={{ width: 7, height: 7, borderRadius: 2, background: dot, flexShrink: 0 }} />}
        {href ? (
          <Link
            href={href}
            title={k}
            style={{ color: "var(--ds-accent-text)", textDecoration: "none", minWidth: 0 }}
          >
            {keyText}
          </Link>
        ) : (
          keyText
        )}
      </span>
      <span
        className="ds-mono"
        style={{
          color: "var(--ds-fg)",
          textAlign: "right",
          whiteSpace: wrapValue ? "normal" : "nowrap",
          wordBreak: wrapValue ? "break-word" : undefined,
          minWidth: 0,
        }}
      >
        {v}
      </span>
    </div>
  );
}
