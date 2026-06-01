"use client";

// Click-to-open drill-down popover for the activity heatmap cells
// (activity-calendar.tsx day cells, activity-ui.tsx HourHeatmap dow/hour cells).
// Lazy-fetches /api/admin/play-history/heatmap-cell for the clicked bucket and
// renders the per-cell aggregate. Rendered in a body portal with position:fixed
// so the heatmaps' `overflow-x: auto` containers can't clip it.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, X } from "@/components/icons";
import type { HeatmapCellDetail } from "@/lib/play-history";

const POPOVER_WIDTH = 264;
const MARGIN = 8;

export interface HeatmapCellAnchor {
  // Viewport coordinates of the clicked cell (getBoundingClientRect).
  x: number;
  y: number;
  w: number;
  h: number;
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
  const [detail, setDetail] = useState<HeatmapCellDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Lazy-fetch the clicked cell's detail. queryString is stable (set once in the
  // parent's click handler), so this fires once per opened cell.
  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    fetch(`/api/admin/play-history/heatmap-cell?${queryString}`)
      .then(async (res) => {
        if (!res.ok) {
          const d = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(d.error ?? `HTTP ${res.status}`);
        }
        return res.json() as Promise<HeatmapCellDetail>;
      })
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [queryString]);

  // Position below the cell when there's room, else above; clamp horizontally to
  // the viewport. Measured after layout so the height is known before placing.
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
  }, [anchor, detail, error]);

  // Dismiss on outside click + Escape.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={`Activity detail for ${label}`}
      style={{
        position: "fixed",
        left: pos?.left ?? anchor.x,
        top: pos?.top ?? anchor.y + anchor.h + 6,
        width: POPOVER_WIDTH,
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
          onClick={onClose}
          aria-label="Close"
          className="inline-flex items-center justify-center rounded-full"
          style={{ width: 22, height: 22, background: "transparent", border: 0, color: "var(--ds-fg-muted)", cursor: "pointer" }}
        >
          <X style={{ width: 13, height: 13 }} />
        </button>
      </div>

      <div style={{ padding: "10px 12px" }}>
        {error ? (
          <p style={{ color: "var(--ds-fg-danger, #c44)", margin: 0 }}>{error}</p>
        ) : !detail ? (
          <div
            className="ds-mono flex items-center"
            style={{ gap: 7, padding: "10px 0", color: "var(--ds-fg-subtle)" }}
          >
            <Loader2 className="animate-spin" style={{ width: 13, height: 13, color: "var(--ds-accent)" }} />
            Loading…
          </div>
        ) : detail.totalPlays === 0 ? (
          <p style={{ color: "var(--ds-fg-subtle)", margin: 0 }}>No plays in this period.</p>
        ) : (
          <CellBody detail={detail} />
        )}
      </div>

      {viewPlaysHref && detail && detail.totalPlays > 0 && (
        <a
          href={viewPlaysHref}
          className="ds-mono"
          style={{
            display: "block",
            padding: "8px 12px",
            borderTop: "1px solid var(--ds-border)",
            fontSize: 10.5,
            color: "var(--ds-accent)",
            textDecoration: "none",
          }}
        >
          View these plays →
        </a>
      )}
    </div>,
    document.body,
  );
}

function CellBody({ detail }: { detail: HeatmapCellDetail }) {
  const m = detail.methods;
  const methodTotal = m.directPlay + m.directStream + m.transcode + m.other;
  const methodRows = [
    { label: "Direct Play", count: m.directPlay, color: "var(--ds-success, #2c9)" },
    { label: "Direct Stream", count: m.directStream, color: "var(--ds-accent)" },
    { label: "Transcode", count: m.transcode, color: "var(--ds-warning)" },
    { label: "Other", count: m.other, color: "var(--ds-fg-disabled)" },
  ].filter((r) => r.count > 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* Headline numbers */}
      <div style={{ display: "flex", gap: 14, alignItems: "baseline" }}>
        <Stat value={detail.totalPlays.toLocaleString("en-US")} unit="plays" big />
        <Stat value={`${detail.watchHours}`} unit="h watched" />
        <Stat value={`${detail.avgSessionMinutes}`} unit="min avg" />
      </div>

      {/* Transcode / stream mix */}
      {methodRows.length > 0 && (
        <Section title="Stream method">
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
      )}

      {detail.topTranscodeReasons.length > 0 && (
        <Section title="Transcode reasons">
          {detail.topTranscodeReasons.map((r) => (
            <KV key={r.reason} k={r.reason} v={`${r.count}`} />
          ))}
        </Section>
      )}

      {detail.topTitles.length > 0 && (
        <Section title="Top titles">
          {detail.topTitles.map((t) => (
            <KV
              key={t.tmdbId ?? t.title}
              k={t.title}
              v={`${t.count}`}
              href={t.tmdbId ? `/admin/activity/media/${t.tmdbId}` : undefined}
            />
          ))}
        </Section>
      )}

      {detail.topUsers.length > 0 && (
        <Section title={detail.topUsers.length > 1 ? "Top viewers" : "Top viewer"}>
          {detail.topUsers.map((u) => (
            <KV
              key={u.id}
              k={u.username}
              v={`${u.count}`}
              href={`/admin/activity/user/${u.id}`}
            />
          ))}
        </Section>
      )}

      {/* Completion */}
      <Section title="Completion">
        <KV k="Finished" v={`${detail.completedPct}% · ${detail.completedCount}/${detail.totalPlays}`} />
      </Section>

      {/* Quality & network */}
      <Section title="Quality & network">
        {detail.avgBitrateMbps > 0 && <KV k="Avg bitrate" v={`${detail.avgBitrateMbps} Mbps`} />}
        {detail.dataTransferredGb > 0 && <KV k="Data" v={`${detail.dataTransferredGb} GB`} />}
        {detail.topResolutions.length > 0 && (
          <KV k="Resolution" v={detail.topResolutions.map((r) => `${r.resolution} (${r.count})`).join(", ")} />
        )}
        {(detail.network.lan > 0 || detail.network.wan > 0 || detail.network.relay > 0) && (
          <KV
            k="Network"
            v={[
              detail.network.lan > 0 ? `LAN ${detail.network.lan}` : null,
              detail.network.wan > 0 ? `WAN ${detail.network.wan}` : null,
              detail.network.relay > 0 ? `Relay ${detail.network.relay}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          />
        )}
      </Section>

      {/* Source / type context */}
      <Section title="Breakdown">
        {(detail.source.plex > 0 || detail.source.jellyfin > 0) && (
          <KV
            k="Source"
            v={[
              detail.source.plex > 0 ? `Plex ${detail.source.plex}` : null,
              detail.source.jellyfin > 0 ? `Jellyfin ${detail.source.jellyfin}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          />
        )}
        {(detail.mediaType.movie > 0 || detail.mediaType.tv > 0) && (
          <KV
            k="Type"
            v={[
              detail.mediaType.movie > 0 ? `Movies ${detail.mediaType.movie}` : null,
              detail.mediaType.tv > 0 ? `TV ${detail.mediaType.tv}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          />
        )}
      </Section>
    </div>
  );
}

function pct(n: number, total: number): string {
  return total > 0 ? `${Math.round((n / total) * 100)}%` : "0%";
}

function Stat({ value, unit, big }: { value: string; unit: string; big?: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <span style={{ fontSize: big ? 20 : 14, fontWeight: 600, lineHeight: 1, color: "var(--ds-fg)" }}>
        {value}
      </span>
      <span className="ds-mono" style={{ fontSize: 9, color: "var(--ds-fg-disabled)", marginTop: 2 }}>
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
        style={{ fontSize: 8.5, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--ds-fg-disabled)", margin: "0 0 4px" }}
      >
        {title}
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>{children}</div>
    </div>
  );
}

function KV({ k, v, dot, href }: { k: string; v: string; dot?: string; href?: string }) {
  const keyText = (
    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{k}</span>
  );
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--ds-fg-muted)", minWidth: 0 }}>
        {dot && <span style={{ width: 7, height: 7, borderRadius: 2, background: dot, flexShrink: 0 }} />}
        {href ? (
          <a
            href={href}
            title={k}
            style={{ color: "var(--ds-accent)", textDecoration: "none", minWidth: 0 }}
          >
            {keyText}
          </a>
        ) : (
          keyText
        )}
      </span>
      <span className="ds-mono" style={{ color: "var(--ds-fg)", textAlign: "right", whiteSpace: "nowrap" }}>
        {v}
      </span>
    </div>
  );
}
