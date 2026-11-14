"use client";

// One play in the overview's Recent plays table, plus its detail row when
// expanded. Memoized: the card re-renders on an expand or a refresh, and only
// the rows whose props changed follow. The relative "Started" time ticks on
// its own (StartedAgo), so the whole table no longer re-renders every minute.
//
// The expand toggle is a real button in the chevron cell (aria-expanded,
// aria-controls); a click anywhere else on the row toggles too, as a pointer
// shortcut.

import { memo, useId, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight } from "@/components/icons";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { useMinuteTick } from "@/hooks/use-minute-tick";
import { formatRelativeTimeLocalized } from "@/lib/relative-time";
import { formatSeasonEpisode } from "@/lib/episode-label";
import { formatDurationHM } from "@/lib/format-duration";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { Avatar, MethodPill, ProgressTrack, SourceDot, fmtBitrate, methodLabel } from "@/components/admin/activity-ui";
import { IpInfo } from "@/components/admin/ip-info";
import { mediaTypeLabel, playProgressPct } from "@/components/admin/activity-history/helpers";
import type { RecentPlay } from "./map";

export const RECENT_COL_SPAN = 8;

export const TH: CSSProperties = {
  textAlign: "left",
  padding: "9px 14px",
  fontSize: 9.5,
  fontWeight: 500,
  color: "var(--ds-fg-subtle)",
  letterSpacing: "0.08em",
  borderBottom: "1px solid var(--ds-border)",
  whiteSpace: "nowrap",
};
const TD: CSSProperties = {
  padding: "10px 14px",
  color: "var(--ds-fg-muted)",
  verticalAlign: "middle",
};
const NUMERIC_TD: CSSProperties = { ...TD, fontVariantNumeric: "tabular-nums" };
const ELLIPSIS: CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

// A full timestamp in the statistics zone, with the zone's name (guardrail
// 19g: the zone comes from the server and is shown by name). Only called from
// the detail row, which renders after a click, never during SSR/first paint
// (guardrail 16).
function formatTimestamp(dateStr: string | null, locale: string, timeZone: string): string {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleString(locale, { timeZone, timeZoneName: "short" });
}

// "3 minutes ago", once mounted (guardrail 16), refreshed once a minute.
function StartedAgo({ iso }: { iso: string }) {
  const mounted = useHasMounted();
  const locale = useLocale();
  useMinuteTick();
  return <>{mounted ? formatRelativeTimeLocalized(iso, locale) : ""}</>;
}

function RecentDetailRow({ id, play, timeZone }: { id: string; play: RecentPlay; timeZone: string }) {
  const t = useT();
  const locale = useLocale();
  const cells: [string, ReactNode][] = [
    [t("adminActivity.field.device"), play.device ?? "—"],
    [
      t("adminActivity.field.ipAddress"),
      play.ipAddress ? <IpInfo ip={play.ipAddress} inline /> : "—",
    ],
    [t("adminActivity.field.container"), play.container?.toUpperCase() ?? "—"],
    [t("adminActivity.field.bitrate"), fmtBitrate(play.bitrate, play.source)],
    [t("adminActivity.field.videoDecision"), play.videoDecision ?? "—"],
    [t("adminActivity.field.audioDecision"), play.audioDecision ?? "—"],
    [t("adminActivity.field.audioCodec"), play.audioCodec?.toUpperCase() ?? "—"],
    [
      t("adminActivity.field.paused"),
      play.pausedDuration ? formatDurationHM(play.pausedDuration, locale) : "—",
    ],
    [t("adminActivity.field.started"), formatTimestamp(play.startedAt, locale, timeZone)],
    [t("adminActivity.field.stopped"), formatTimestamp(play.stoppedAt, locale, timeZone)],
    [t("adminActivity.field.totalDuration"), formatDurationHM(play.duration, locale)],
    [t("adminActivity.field.actualWatchTime"), formatDurationHM(play.playDuration, locale)],
  ];
  return (
    <tr id={id} style={{ background: "var(--ds-bg-1)" }}>
      <td colSpan={RECENT_COL_SPAN} style={{ padding: "14px 18px" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
            gap: "10px 24px",
          }}
        >
          {cells.map(([k, v]) => (
            <div key={k}>
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
                style={{
                  margin: "2px 0 0",
                  fontSize: 12,
                  color: "var(--ds-fg-muted)",
                }}
              >
                {v}
              </div>
            </div>
          ))}
        </div>
      </td>
    </tr>
  );
}

function UserCell({ p }: { p: RecentPlay }) {
  const t = useT();
  return (
    <td style={TD}>
      <Link
        href={`/admin/activity/user/${p.mediaServerUserId}`}
        onClick={(e) => e.stopPropagation()}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          color: "var(--ds-fg)",
          textDecoration: "none",
        }}
      >
        <Avatar letter={(p.username[0] ?? "?").toUpperCase()} size={20} />
        <span>{p.username}</span>
        <SourceDot source={p.source} size={4} />
        {/* Instance slug for a named server. Rendered only when non-empty —
            "" is both the default server and every pre-multi-server row, which
            must stay unlabelled. Colour keyed off `source` (same as the dot),
            never off the slug. */}
        {p.serverInstance && (
          <span
            className="ds-mono"
            title={t("adminActivity.common.playedOnServer", { instance: p.serverInstance, source: p.source })}
            style={{
              fontSize: 9.5,
              padding: "1px 5px",
              borderRadius: 999,
              background: "color-mix(in oklab, var(--ds-fg) 6%, transparent)",
              // Brand colours are fills; as text they are 2.0–2.5:1 on light
              // surfaces (guardrail 42).
              color: p.source === "plex" ? "var(--ds-plex-text)" : "var(--ds-jellyfin-text)",
              letterSpacing: "0.04em",
              flexShrink: 0,
            }}
          >
            {p.serverInstance}
          </span>
        )}
      </Link>
    </td>
  );
}

function TitleCell({ p }: { p: RecentPlay }) {
  const t = useT();
  const mediaHref = p.tmdbId && p.mediaType ? `/admin/activity/media/${p.tmdbId}?type=${p.mediaType}` : null;
  // An unknown season/episode is dropped, never "S00 · E00".
  const sub = p.mediaType === "TV"
    ? [formatSeasonEpisode(p.seasonNumber, p.episodeNumber), p.episodeTitle].filter(Boolean).join(" · ")
    : mediaTypeLabel(t, p.mediaType);
  return (
    <td style={{ ...TD, maxWidth: 320 }}>
      <div style={{ color: "var(--ds-fg)", ...ELLIPSIS }}>
        {mediaHref ? (
          <Link
            href={mediaHref}
            onClick={(e) => e.stopPropagation()}
            style={{ color: "inherit", textDecoration: "none" }}
          >
            {p.title}
          </Link>
        ) : (
          p.title
        )}
      </div>
      <div
        className="ds-mono"
        style={{ fontSize: 10.5, color: "var(--ds-fg-subtle)", marginTop: 1, ...ELLIPSIS }}
      >
        {sub}
      </div>
    </td>
  );
}

function ProgressCell({ pct, watched }: { pct: number; watched: boolean }) {
  return (
    <td style={{ ...TD, textAlign: "right", width: 140 }}>
      <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <div style={{ width: 60 }}>
          <ProgressTrack
            pct={pct / 100}
            height={3}
            color={watched ? "var(--ds-success)" : "var(--ds-accent)"}
          />
        </div>
        <span
          className="ds-mono"
          style={{
            fontSize: 10.5,
            color: watched ? "var(--ds-success)" : "var(--ds-fg-subtle)",
            width: 32,
            textAlign: "right",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {pct}%
        </span>
      </div>
    </td>
  );
}

export const RecentPlayRow = memo(function RecentPlayRow({
  p,
  isLast,
  isExpanded,
  timeZone,
  onToggle,
}: {
  p: RecentPlay;
  isLast: boolean;
  isExpanded: boolean;
  // The statistics zone the detail row's times are shown in.
  timeZone: string;
  onToggle: (id: string) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const detailId = useId();
  const m = methodLabel(t, p.playMethod, p.videoDecision, p.audioDecision);
  // A play with no known length counts as done when it was watched.
  const pct = playProgressPct(p.playDuration, p.duration, p.watched ? 100 : 0);
  return (
    <>
      <tr
        className="recent-row"
        onClick={() => onToggle(p.id)}
        style={{
          borderBottom: isLast ? "none" : "1px solid var(--ds-border)",
          cursor: "pointer",
        }}
      >
        <td style={{ ...TD, color: "var(--ds-fg-disabled)" }}>
          <button
            type="button"
            className="ds-hover-tint"
            aria-expanded={isExpanded}
            aria-controls={isExpanded ? detailId : undefined}
            aria-label={t("adminActivity.common.detailsFor", { title: p.title })}
            onClick={(e) => {
              // The row's own click handler would toggle it straight back.
              e.stopPropagation();
              onToggle(p.id);
            }}
            style={{ background: "transparent", border: 0, padding: 0, lineHeight: 0, color: "inherit", borderRadius: 3 }}
          >
            {isExpanded ? (
              <ChevronDown style={{ width: 14, height: 14 }} />
            ) : (
              <ChevronRight style={{ width: 14, height: 14 }} />
            )}
          </button>
        </td>
        <UserCell p={p} />
        <TitleCell p={p} />
        <td className="ds-mono" style={NUMERIC_TD}>
          <StartedAgo iso={p.startedAt} />
        </td>
        <td className="ds-mono" style={NUMERIC_TD}>
          {formatDurationHM(p.playDuration, locale)}
        </td>
        <td style={TD}>
          <MethodPill method={m.label} methodClass={m.cls} />
        </td>
        <td className="ds-mono" style={TD}>
          {[p.resolution, p.videoCodec?.toUpperCase()].filter(Boolean).join(" · ") || "—"}
        </td>
        <ProgressCell pct={pct} watched={p.watched} />
      </tr>
      {isExpanded && <RecentDetailRow id={detailId} play={p} timeZone={timeZone} />}
    </>
  );
});
