"use client";

// One play of the admin History table: the row itself and, when expanded, its
// detail panel. Presentational — the table owns every piece of state and hands
// in `isExpanded`, `mounted` and two stable callbacks. Memoized, so a search
// keystroke (which re-renders the table before its debounce fires) and an
// expand/collapse of another row skip it. Relative times wait for `mounted`
// (guardrail 16).

import { memo } from "react";
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
import type { HistoryRow } from "./types";

export const HistoryTableRow = memo(function HistoryTableRow({
  row: r,
  index: i,
  isExpanded,
  mounted,
  colSpan,
  onToggle,
  onDelete,
}: {
  row: HistoryRow;
  index: number;
  isExpanded: boolean;
  mounted: boolean;
  colSpan: number;
  onToggle: (id: string) => void;
  onDelete: (row: HistoryRow) => void;
}) {
  const t = useT();
  const locale = useLocale();
  // Use the chain total when present (grouped mode). In ungrouped mode the API
  // fills it with the row's own value, so this works either way.
  const effectivePlay = r.totalPlayDuration ?? r.playDuration;
  const pct =
    r.duration > 0
      ? Math.min(
          100,
          Math.round((effectivePlay / r.duration) * 100),
        )
      : 0;
  const ml = methodLabel(
    t,
    r.playMethod,
    r.videoDecision,
    r.audioDecision,
  );
  const ep = r.mediaType === "TV" ? episodeLabel(r.seasonNumber, r.episodeNumber) : null;
  const sub = ep ? (r.episodeTitle ? `${ep} · ${r.episodeTitle}` : ep) : (r.mediaType ?? "");
  return (
    <>
      <tr
        className="history-row"
        tabIndex={0}
        aria-expanded={isExpanded}
        onClick={() => onToggle(r.id)}
        onKeyDown={(e) => {
          // Only react to keys pressed on the row itself. A key
          // pressed on the user link or the delete button also
          // bubbles up here, and preventDefault() would stop
          // that link/button from working from the keyboard.
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle(r.id);
          }
        }}
        style={{
          background: isExpanded
            ? "var(--ds-bg-3)"
            : i % 2 === 1
              ? "color-mix(in oklab, var(--ds-fg) 1.2%, transparent)"
              : "transparent",
          borderBottom: "1px solid var(--ds-border)",
          cursor: "pointer",
        }}
      >
        <td style={{ padding: "10px 0 10px 12px" }}>
          <ChevIcon open={isExpanded} />
        </td>
        <td
          style={{
            padding: "10px 11px",
            whiteSpace: "nowrap",
          }}
        >
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
            <Avatar
              letter={(
                r.mediaServerUser.username[0] ?? "?"
              ).toUpperCase()}
              size={20}
            />
            <span style={{ color: "var(--ds-fg)" }}>
              {r.mediaServerUser.username}
            </span>
            <SourceDot source={r.source} size={4} />
            {/* Instance slug for a named server, so two plays
                on different servers of the same provider are
                distinguishable. Rendered only when non-empty:
                "" means the default server AND every row
                written before multi-server support, which must
                stay unlabelled. Colour is keyed off `source`
                (matching the dot), never off the slug. */}
            {r.serverInstance && (
              <span
                className="ds-mono"
                title={t("adminActivity.common.playedOnServer", { instance: r.serverInstance, source: r.source })}
                style={{
                  fontSize: 9.5,
                  padding: "1px 5px",
                  borderRadius: 999,
                  background: "color-mix(in oklab, var(--ds-fg) 6%, transparent)",
                  color:
                    r.source === "plex"
                      ? "var(--ds-plex-text)"
                      : "var(--ds-jellyfin-text)",
                  letterSpacing: "0.04em",
                  flexShrink: 0,
                }}
              >
                {r.serverInstance}
              </span>
            )}
          </Link>
        </td>
        <td style={{ padding: "10px 11px", minWidth: 240 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <Poster
              src={r.posterUrl}
              letter={(r.title[0] ?? "?").toUpperCase()}
              w={28}
              h={40}
              radius={3}
            />
            <div
              style={{
                minWidth: 0,
                lineHeight: 1.25,
                flex: 1,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  minWidth: 0,
                }}
              >
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
                {(r.segmentCount ?? 1) > 1 && (
                  <span
                    className="ds-mono"
                    title={t("adminActivity.history.continuedTitle")}
                    style={{
                      fontSize: 9.5,
                      padding: "2px 6px",
                      borderRadius: 999,
                      background: "color-mix(in oklab, var(--ds-fg) 6%, transparent)",
                      color: "var(--ds-fg-subtle)",
                      letterSpacing: "0.04em",
                      whiteSpace: "nowrap",
                      flexShrink: 0,
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
        <td
          className="ds-mono"
          style={{
            padding: "10px 11px",
            color: "var(--ds-fg-muted)",
            fontVariantNumeric: "tabular-nums",
            whiteSpace: "nowrap",
          }}
        >
          {fmtTimestamp(r.startedAt, mounted, locale)}
          <div
            className="ds-mono"
            style={{
              fontSize: 10,
              color: "var(--ds-fg-disabled)",
            }}
          >
            {mounted ? formatRelativeTimeLocalized(r.startedAt, locale) : ""}
          </div>
        </td>
        <td
          className="ds-mono"
          style={{
            padding: "10px 11px",
            color: "var(--ds-fg-muted)",
            textAlign: "right",
            fontVariantNumeric: "tabular-nums",
            whiteSpace: "nowrap",
          }}
        >
          {fmtDuration(r.duration, locale)}
        </td>
        <td
          style={{
            padding: "10px 11px",
            whiteSpace: "nowrap",
            minWidth: 130,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
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
                  background: r.watched
                    ? "var(--ds-success)"
                    : "var(--ds-accent)",
                  borderRadius: 999,
                }}
              />
            </div>
            <span
              className="ds-mono"
              style={{
                fontSize: 10.5,
                color: r.watched
                  ? "var(--ds-success)"
                  : "var(--ds-fg-subtle)",
                fontVariantNumeric: "tabular-nums",
                width: 32,
                textAlign: "right",
              }}
            >
              {pct}%
            </span>
          </div>
        </td>
        <td
          style={{
            padding: "10px 11px",
            whiteSpace: "nowrap",
          }}
        >
          <MethodPill
            method={ml.label}
            methodClass={ml.cls}
          />
        </td>
        <td
          className="ds-mono"
          style={{
            padding: "10px 11px",
            color: "var(--ds-fg-muted)",
            whiteSpace: "nowrap",
          }}
        >
          {r.resolution ?? "—"}
          {r.videoCodec && (
            <span
              style={{ color: "var(--ds-fg-disabled)" }}
            >
              {" "}
              · {r.videoCodec}
            </span>
          )}
        </td>
        <td
          style={{
            padding: "10px 11px",
            color: "var(--ds-fg-muted)",
            whiteSpace: "nowrap",
          }}
        >
          {r.platform ?? "—"}
        </td>
        <td
          style={{
            padding: "10px 11px",
            textAlign: "right",
            whiteSpace: "nowrap",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => onDelete(r)}
            className="history-delete"
            aria-label={t("adminActivity.history.deleteAriaFor", {
              title: r.title,
              user: r.mediaServerUser.username,
            })}
            // Muted, not disabled: the only destructive control
            // in the table must read as live. Hover/focus turn
            // it danger via the .history-delete rule in
            // globals.css (guardrail 42 — no inline cursor).
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
      </tr>
      {isExpanded && (
        <DetailRow
          play={r}
          colSpan={colSpan}
          mounted={mounted}
        />
      )}
    </>
  );
});
