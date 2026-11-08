"use client";

// One play of the admin History table: the row itself and, when expanded, its
// detail panel. Presentational — the table owns every piece of state and hands
// in `isExpanded`, `mounted` and two stable callbacks. Memoized, so a search
// keystroke (which re-renders the table before its debounce fires) and an
// expand/collapse of another row skip it. Relative times wait for `mounted`
// (guardrail 16).
//
// The expand toggle is a real button in the chevron cell (aria-expanded,
// aria-controls), so keyboard and assistive tech get a named control; a click
// anywhere else on the row toggles too, as a pointer shortcut.

import { memo, useId, type CSSProperties } from "react";
import Link from "next/link";
import { formatRelativeTimeLocalized } from "@/lib/relative-time";
import { episodeLabel } from "@/lib/episode-label";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import {
  Avatar,
  ChevIcon,
  MethodPill,
  Poster,
  SourceDot,
  fmtDuration,
  fmtTimestamp,
  methodLabel,
} from "@/components/admin/activity-ui";
import { DetailRow } from "./detail-row";
import { mediaTypeLabel, playProgressPct } from "./helpers";
import type { HistoryRow } from "./types";

const CELL: CSSProperties = { padding: "10px 11px", whiteSpace: "nowrap" };

// The small rounded tags beside a name or title (server slug, resume count).
const PILL: CSSProperties = {
  fontSize: 9.5,
  borderRadius: 999,
  background: "color-mix(in oklab, var(--ds-fg) 6%, transparent)",
  letterSpacing: "0.04em",
  flexShrink: 0,
};

// Zebra striping through a class, not an inline background, so the
// `.history-row:hover` rule in globals.css (unlayered, so it beats the
// utility) can show on hover. The expanded row keeps its inline fill: it is
// already marked.
const ZEBRA_CLASS = "bg-[color-mix(in_oklab,var(--ds-fg)_1.2%,transparent)]";

function UserCell({ row: r, username }: { row: HistoryRow; username: string }) {
  const t = useT();
  return (
    <td style={CELL}>
      <Link
        href={`/admin/activity/user/${r.mediaServerUserId}`}
        onClick={(e) => e.stopPropagation()}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          textDecoration: "none",
          color: "inherit",
        }}
      >
        <Avatar letter={(username[0] ?? "?").toUpperCase()} size={20} />
        <span style={{ color: "var(--ds-fg)" }}>{username}</span>
        <SourceDot source={r.source} size={4} />
        {/* Instance slug for a named server, so two plays on different
            servers of the same provider are distinguishable. Rendered only
            when non-empty: "" means the default server AND every row written
            before multi-server support, which must stay unlabelled. Colour is
            keyed off `source` (matching the dot), never off the slug. */}
        {r.serverInstance && (
          <span
            className="ds-mono"
            title={t("adminActivity.common.playedOnServer", { instance: r.serverInstance, source: r.source })}
            style={{
              ...PILL,
              padding: "1px 5px",
              color: r.source === "plex" ? "var(--ds-plex-text)" : "var(--ds-jellyfin-text)",
            }}
          >
            {r.serverInstance}
          </span>
        )}
      </Link>
    </td>
  );
}

function TitleCell({ row: r }: { row: HistoryRow }) {
  const t = useT();
  const ep = r.mediaType === "TV" ? episodeLabel(r.seasonNumber, r.episodeNumber) : null;
  const sub = ep ? (r.episodeTitle ? `${ep} · ${r.episodeTitle}` : ep) : mediaTypeLabel(t, r.mediaType);
  return (
    <td style={{ padding: "10px 11px", minWidth: 240 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Poster src={r.posterUrl} letter={(r.title[0] ?? "?").toUpperCase()} w={28} h={40} radius={3} />
        <div style={{ minWidth: 0, lineHeight: 1.25, flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
            <div
              style={{
                color: "var(--ds-fg)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {r.title}
            </div>
            {r.segmentCount > 1 && (
              <span
                className="ds-mono"
                title={t("adminActivity.history.continuedTitle")}
                style={{
                  ...PILL,
                  padding: "2px 6px",
                  color: "var(--ds-fg-subtle)",
                  whiteSpace: "nowrap",
                }}
              >
                {r.segmentCount}×
              </span>
            )}
          </div>
          <div
            className="ds-mono"
            style={{
              fontSize: 10.5,
              color: "var(--ds-fg-subtle)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {sub}
          </div>
        </div>
      </div>
    </td>
  );
}

function ProgressCell({ pct, watched }: { pct: number; watched: boolean }) {
  return (
    <td style={{ ...CELL, minWidth: 130 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div
          style={{
            flex: 1,
            height: 3,
            background: "color-mix(in oklab, var(--ds-fg) 6%, transparent)",
            borderRadius: 999,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${pct}%`,
              height: "100%",
              background: watched ? "var(--ds-success)" : "var(--ds-accent)",
              borderRadius: 999,
            }}
          />
        </div>
        <span
          className="ds-mono"
          style={{
            fontSize: 10.5,
            color: watched ? "var(--ds-success)" : "var(--ds-fg-subtle)",
            fontVariantNumeric: "tabular-nums",
            width: 32,
            textAlign: "right",
          }}
        >
          {pct}%
        </span>
      </div>
    </td>
  );
}

function DeleteCell({ label, onDelete }: { label: string; onDelete: () => void }) {
  return (
    <td style={{ ...CELL, textAlign: "right" }} onClick={(e) => e.stopPropagation()}>
      <button
        onClick={onDelete}
        className="history-delete"
        aria-label={label}
        // Muted, not disabled: the only destructive control in the table must
        // read as live. Hover/focus turn it danger via the .history-delete rule
        // in globals.css (guardrail 42 — no inline cursor).
        style={{
          background: "transparent",
          border: "1px solid transparent",
          color: "var(--ds-fg-muted)",
          borderRadius: 4,
          padding: "4px 6px",
          lineHeight: 0,
        }}
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2.5 3.5h9M5 3.5V2.5a1 1 0 011-1h2a1 1 0 011 1v1M5 6v5M9 6v5M3.5 3.5l.5 8a1 1 0 001 1h4a1 1 0 001-1l.5-8" />
        </svg>
      </button>
    </td>
  );
}

export const HistoryTableRow = memo(function HistoryTableRow({
  row: r,
  index: i,
  isExpanded,
  mounted,
  timeZone,
  colSpan,
  onToggle,
  onDelete,
}: {
  row: HistoryRow;
  index: number;
  isExpanded: boolean;
  mounted: boolean;
  // The statistics zone the times are shown in (the date filter's zone).
  timeZone: string;
  colSpan: number;
  onToggle: (id: string) => void;
  onDelete: (row: HistoryRow) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const detailId = useId();
  // The chain total in grouped mode; in ungrouped mode the API fills it with
  // the row's own value, so this works either way.
  const pct = playProgressPct(r.totalPlayDuration, r.duration);
  const ml = methodLabel(t, r.playMethod, r.videoDecision, r.audioDecision);
  const username = r.mediaServerUser?.username ?? t("adminActivity.common.unknownUser");
  return (
    <>
      <tr
        className={isExpanded || i % 2 === 0 ? "history-row" : `history-row ${ZEBRA_CLASS}`}
        onClick={() => onToggle(r.id)}
        style={{
          background: isExpanded ? "var(--ds-bg-3)" : undefined,
          borderBottom: "1px solid var(--ds-border)",
          cursor: "pointer",
        }}
      >
        <td style={{ padding: "10px 0 10px 12px" }}>
          <button
            type="button"
            className="ds-hover-tint"
            aria-expanded={isExpanded}
            aria-controls={isExpanded ? detailId : undefined}
            aria-label={t("adminActivity.common.detailsFor", { title: r.title })}
            onClick={(e) => {
              // The row's own click handler would toggle it straight back.
              e.stopPropagation();
              onToggle(r.id);
            }}
            style={{ background: "transparent", border: 0, padding: 0, lineHeight: 0, borderRadius: 3 }}
          >
            <ChevIcon open={isExpanded} />
          </button>
        </td>
        <UserCell row={r} username={username} />
        <TitleCell row={r} />
        <td
          className="ds-mono"
          style={{ ...CELL, color: "var(--ds-fg-muted)", fontVariantNumeric: "tabular-nums" }}
        >
          {fmtTimestamp(r.startedAt, mounted, locale, timeZone)}
          <div className="ds-mono" style={{ fontSize: 10, color: "var(--ds-fg-disabled)" }}>
            {mounted ? formatRelativeTimeLocalized(r.startedAt, locale) : ""}
          </div>
        </td>
        <td
          className="ds-mono"
          style={{
            ...CELL,
            color: "var(--ds-fg-muted)",
            textAlign: "right",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {fmtDuration(r.duration, locale)}
        </td>
        <ProgressCell pct={pct} watched={r.watched} />
        <td style={CELL}>
          <MethodPill method={ml.label} methodClass={ml.cls} />
        </td>
        <td className="ds-mono" style={{ ...CELL, color: "var(--ds-fg-muted)" }}>
          {r.resolution ?? "—"}
          {r.videoCodec && (
            <span style={{ color: "var(--ds-fg-disabled)" }}>
              {" "}
              · {r.videoCodec}
            </span>
          )}
        </td>
        <td style={{ ...CELL, color: "var(--ds-fg-muted)" }}>{r.platform ?? "—"}</td>
        <DeleteCell
          label={t("adminActivity.history.deleteAriaFor", { title: r.title, user: username })}
          onDelete={() => onDelete(r)}
        />
      </tr>
      {isExpanded && (
        <DetailRow
          id={detailId}
          play={r}
          colSpan={colSpan}
          mounted={mounted}
          timeZone={timeZone}
        />
      )}
    </>
  );
});
