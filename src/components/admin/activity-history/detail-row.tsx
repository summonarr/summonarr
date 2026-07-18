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

export function DetailRow({
  play,
  colSpan,
  mounted,
}: {
  play: HistoryRow;
  colSpan: number;
  mounted: boolean;
}) {
  // Mirror the row body's grouping-aware effective values: when this PlayHistory
  // is a chain representative, the watch time / progress reflect the whole
  // chain. In ungrouped mode the API mirrors these into single-segment
  // defaults, so the expression is uniform.
  const effectivePlay = play.totalPlayDuration ?? play.playDuration;
  const segments = play.segmentCount ?? 1;
  const pct =
    play.duration > 0
      ? Math.round((effectivePlay / play.duration) * 100)
      : 0;
  const details: [string, React.ReactNode][] = [
    ["Started", fmtTimestamp(play.startedAt, mounted)],
    ["Stopped", fmtTimestamp(play.stoppedAt, mounted)],
    ["Total length", fmtDuration(play.duration)],
    ["Watch time", fmtDuration(effectivePlay)],
    [
      "Paused",
      play.pausedDuration ? fmtDuration(play.pausedDuration) : "—",
    ],
    ["Progress", `${pct}%`],
    ...(segments > 1 ? ([["Segments", `${segments} (grouped resume)`]] as [string, React.ReactNode][]) : []),
    ["Device", play.device ?? "—"],
    [
      "IP address",
      play.ipAddress ? <IpInfo ip={play.ipAddress} inline /> : "—",
    ],
    ["Container", play.container ?? "—"],
    ["Bitrate", fmtBitrate(play.bitrate)],
    ["Video codec", play.videoCodec ?? "—"],
    ["Audio codec", play.audioCodec ?? "—"],
    ["Video decision", play.videoDecision ?? "—"],
    ["Audio decision", play.audioDecision ?? "—"],
  ];

  // Network metadata. Plex-only — Jellyfin rows leave these null. Suppress
  // the cells entirely when there's nothing to show rather than emit a row
  // of dashes that pads the panel for no reason.
  if (play.location || play.secure != null || play.relayed != null || play.bandwidth != null) {
    if (play.location) {
      details.push(["Connection", play.location.toUpperCase()]);
    }
    if (play.secure != null) {
      details.push(["Secure", play.secure ? "TLS" : "HTTP"]);
    }
    if (play.relayed) {
      details.push(["Relay", "via plex.tv"]);
    }
    if (play.bandwidth != null) {
      // Plex reports bandwidth in kbps; surface as Mbps for parity with the
      // rest of the panel.
      const mbps = play.bandwidth / 1000;
      details.push(["Session bandwidth", `${mbps.toFixed(1)} Mbps`]);
    }
  }

  // Intro/credits markers (Plex includeMarkers=1). Same suppression rule.
  if (play.introStartMs != null && play.introEndMs != null) {
    details.push([
      "Intro marker",
      `${fmtMarkerOffset(play.introStartMs)} – ${fmtMarkerOffset(play.introEndMs)}`,
    ]);
  }
  if (play.creditsStartMs != null) {
    const tail = play.creditsEndMs != null && play.duration > 0
      && play.creditsEndMs >= play.duration * 1000 - 1000
      ? "end"
      : play.creditsEndMs != null
        ? fmtMarkerOffset(play.creditsEndMs)
        : "end";
    details.push([
      "Credits marker",
      `${fmtMarkerOffset(play.creditsStartMs)} – ${tail}`,
    ]);
  }

  if (play.mediaType === "TV" && play.seasonNumber != null) {
    details.push([
      "Episode",
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
            color: "var(--ds-fg-disabled)",
            letterSpacing: "0.1em",
            marginBottom: 10,
          }}
        >
          Session detail
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
                  color: "var(--ds-fg-disabled)",
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
              View title activity →
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
            User activity →
          </Link>
        </div>
      </td>
    </tr>
  );
}
