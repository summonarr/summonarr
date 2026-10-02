"use client";

// Expanded session-detail panel for a history row. Timestamp cells thread the
// parent's `mounted` flag through fmtTimestamp so SSR and hydration agree
// (guardrail 16).

import Link from "next/link";
import { IpInfo } from "@/components/admin/ip-info";
import {
  fmtDuration,
  fmtBitrate,
  fmtTimestamp,
} from "@/components/admin/activity-ui";
import { fmtMarkerOffset } from "./helpers";
import type { HistoryRow } from "./types";
import { useLocale, useT } from "@/components/i18n/i18n-provider";

export function DetailRow({
  play,
  colSpan,
  mounted,
}: {
  play: HistoryRow;
  colSpan: number;
  mounted: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  // A "chain" is one viewing that was paused and resumed across several
  // sittings (segments). When grouping is on, the table shows one row per
  // chain, and every duration/timestamp in this panel covers the WHOLE chain —
  // watch time, paused time, first start and last stop — not just the newest
  // segment that row stands for. With grouping off the API fills the chain
  // fields with the row's own values, so the same code works in both modes.
  // (The table's Started column still shows the row's own startedAt on
  // purpose: that is what the grouped list is sorted by.)
  const effectivePlay = play.totalPlayDuration ?? play.playDuration;
  const effectivePaused = play.totalPausedDuration ?? play.pausedDuration;
  const startedAt = play.firstStartedAt ?? play.startedAt;
  const stoppedAt = play.lastStoppedAt ?? play.stoppedAt;
  const segments = play.segmentCount ?? 1;
  // Clamped like the row's progress bar: a chain's totalPlayDuration is a SUM
  // over segments, so a rewatched span pushes it past the title's duration.
  const pct =
    play.duration > 0
      ? Math.min(100, Math.round((effectivePlay / play.duration) * 100))
      : 0;
  const details: [string, React.ReactNode][] = [
    [t("adminActivity.field.started"), fmtTimestamp(startedAt, mounted, locale)],
    [t("adminActivity.field.stopped"), fmtTimestamp(stoppedAt, mounted, locale)],
    [t("adminActivity.field.totalDuration"), fmtDuration(play.duration)],
    [t("adminActivity.kpi.watchTime"), fmtDuration(effectivePlay)],
    [t("adminActivity.field.paused"), effectivePaused ? fmtDuration(effectivePaused) : "—"],
    [t("adminActivity.field.progress"), `${pct}%`],
    ...(segments > 1
      ? ([[t("adminActivity.field.segments"), t("adminActivity.detail.segmentsValue", { count: segments })]] as [string, React.ReactNode][])
      : []),
    [t("adminActivity.field.device"), play.device ?? "—"],
    [
      t("adminActivity.field.ipAddress"),
      play.ipAddress ? <IpInfo ip={play.ipAddress} inline /> : "—",
    ],
    [t("adminActivity.field.container"), play.container ?? "—"],
    [t("adminActivity.field.bitrate"), fmtBitrate(play.bitrate, play.source)],
    [t("adminActivity.field.videoCodec"), play.videoCodec ?? "—"],
    [t("adminActivity.field.audioCodec"), play.audioCodec ?? "—"],
    [t("adminActivity.field.videoDecision"), play.videoDecision ?? "—"],
    [t("adminActivity.field.audioDecision"), play.audioDecision ?? "—"],
  ];

  // Network metadata. Plex-only — Jellyfin rows leave these null. Suppress
  // the cells entirely when there's nothing to show rather than emit a row
  // of dashes that pads the panel for no reason.
  if (play.location || play.secure != null || play.relayed != null || play.bandwidth != null) {
    if (play.location) {
      details.push([t("adminActivity.field.connection"), play.location.toUpperCase()]);
    }
    if (play.secure != null) {
      details.push([t("adminActivity.field.secure"), play.secure ? "TLS" : "HTTP"]);
    }
    if (play.relayed) {
      details.push([t("adminActivity.field.relay"), t("adminActivity.detail.viaPlexTv")]);
    }
    if (play.bandwidth != null) {
      // Plex reports bandwidth in kbps; surface as Mbps for parity with the
      // rest of the panel.
      const mbps = play.bandwidth / 1000;
      details.push([t("adminActivity.field.sessionBandwidth"), `${mbps.toFixed(1)} Mbps`]);
    }
  }

  // Intro/credits markers (Plex includeMarkers=1). Same suppression rule.
  if (play.introStartMs != null && play.introEndMs != null) {
    details.push([
      t("adminActivity.field.introMarker"),
      `${fmtMarkerOffset(play.introStartMs)} – ${fmtMarkerOffset(play.introEndMs)}`,
    ]);
  }
  if (play.creditsStartMs != null) {
    const tail = play.creditsEndMs != null && play.duration > 0
      && play.creditsEndMs >= play.duration * 1000 - 1000
      ? t("adminActivity.detail.end")
      : play.creditsEndMs != null
        ? fmtMarkerOffset(play.creditsEndMs)
        : t("adminActivity.detail.end");
    details.push([
      t("adminActivity.field.creditsMarker"),
      `${fmtMarkerOffset(play.creditsStartMs)} – ${tail}`,
    ]);
  }

  if (play.mediaType === "TV" && play.seasonNumber != null) {
    details.push([
      t("adminActivity.field.episode"),
      `S${String(play.seasonNumber).padStart(2, "0")} · E${String(
        play.episodeNumber ?? 0,
      ).padStart(2, "0")}${play.episodeTitle ? ` — ${play.episodeTitle}` : ""}`,
    ]);
  }
  return (
    <tr
      style={{
        background: "var(--ds-bg-1)",
        borderBottom: "1px solid var(--ds-border)",
      }}
    >
      <td colSpan={colSpan} style={{ padding: "16px 22px 18px 56px" }}>
        <div
          className="ds-mono uppercase"
          style={{
            fontSize: 9.5,
            color: "var(--ds-fg-subtle)",
            letterSpacing: "0.1em",
            marginBottom: 10,
          }}
        >
          {t("adminActivity.detail.sessionDetail")}
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
            gap: "10px 24px",
          }}
        >
          {details.map(([k, v]) => (
            <div
              key={k}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 2,
                minWidth: 0,
              }}
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
              <span
                className="ds-mono"
                style={{
                  fontSize: 12,
                  color: "var(--ds-fg-muted)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {v}
              </span>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
          {play.tmdbId && (
            <Link
              href={`/admin/activity/media/${play.tmdbId}${play.mediaType ? `?type=${play.mediaType}` : ""}`}
              style={{
                fontSize: 11.5,
                padding: "5px 11px",
                borderRadius: 6,
                background: "var(--ds-bg-3)",
                border: "1px solid var(--ds-border)",
                color: "var(--ds-fg)",
                textDecoration: "none",
                whiteSpace: "nowrap",
              }}
            >
              {t("adminActivity.detail.viewTitleActivity")}
            </Link>
          )}
          <Link
            href={`/admin/activity/user/${play.mediaServerUserId}`}
            style={{
              fontSize: 11.5,
              padding: "5px 11px",
              borderRadius: 6,
              background: "var(--ds-bg-3)",
              border: "1px solid var(--ds-border)",
              color: "var(--ds-fg)",
              textDecoration: "none",
              whiteSpace: "nowrap",
            }}
          >
            {t("adminActivity.detail.userActivity")}
          </Link>
        </div>
      </td>
    </tr>
  );
}
