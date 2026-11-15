"use client";

// Expanded session-detail panel for a history row. Timestamp cells thread the
// parent's `mounted` flag through fmtTimestamp so SSR and hydration agree
// (guardrail 16), and show the statistics zone's time like the row does.

import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { IpInfo } from "@/components/admin/ip-info";
import {
  fmtDuration,
  fmtBitrate,
  fmtTimestamp,
} from "@/components/admin/activity-ui";
import { episodeLabel } from "@/lib/episode-label";
import type { Translator } from "@/lib/i18n/translate";
import { fmtMarkerOffset, playProgressPct } from "./helpers";
import type { HistoryRow } from "./types";
import { useLocale, useT } from "@/components/i18n/i18n-provider";

// The panel's three action links (play, title, user).
const linkStyle: CSSProperties = {
  fontSize: 11.5,
  padding: "5px 11px",
  borderRadius: 6,
  background: "var(--ds-bg-3)",
  border: "1px solid var(--ds-border)",
  color: "var(--ds-fg)",
  textDecoration: "none",
  whiteSpace: "nowrap",
};

type Entry = [label: string, value: ReactNode];

// The credits marker's end: "end" when it runs to the end of the title (or
// its end is unknown), else the offset.
function creditsTail(play: HistoryRow, t: Translator): string {
  const end = play.creditsEndMs;
  if (end == null) return t("adminActivity.detail.end");
  if (play.duration > 0 && end >= play.duration * 1000 - 1000) return t("adminActivity.detail.end");
  return fmtMarkerOffset(end);
}

// The panel's label/value pairs, in display order. A "chain" is one viewing
// that was paused and resumed across several sittings (segments). When
// grouping is on, the table shows one row per chain, and every duration and
// timestamp here covers the WHOLE chain — watch time, paused time, first start
// and last stop — not just the newest segment that row stands for. With
// grouping off the API fills the chain fields with the row's own values, so the
// same code works in both modes. The table's Started column shows the row's
// own startedAt (that is what the grouped list is sorted by), so a resumed
// chain names its first start and its last resume apart here instead of
// showing two different "Started" times.
function detailEntries(
  play: HistoryRow,
  { t, locale, mounted, timeZone }: { t: Translator; locale: string; mounted: boolean; timeZone: string },
): Entry[] {
  const time = (iso: string | null) => fmtTimestamp(iso, mounted, locale, timeZone);
  const effectivePlay = play.totalPlayDuration;
  const effectivePaused = play.totalPausedDuration ?? play.pausedDuration;
  const stoppedAt = play.lastStoppedAt ?? play.stoppedAt;
  const segments = play.segmentCount;

  const entries: (Entry | null)[] = [
    ...(segments > 1
      ? ([
          [t("adminActivity.field.firstStarted"), time(play.firstStartedAt)],
          [t("adminActivity.field.lastResumed"), time(play.startedAt)],
        ] as Entry[])
      : ([[t("adminActivity.field.started"), time(play.firstStartedAt)]] as Entry[])),
    [t("adminActivity.field.stopped"), time(stoppedAt)],
    [t("adminActivity.field.totalDuration"), fmtDuration(play.duration, locale)],
    [t("adminActivity.kpi.watchTime"), fmtDuration(effectivePlay, locale)],
    [t("adminActivity.field.paused"), effectivePaused ? fmtDuration(effectivePaused, locale) : "—"],
    [t("adminActivity.field.progress"), `${playProgressPct(effectivePlay, play.duration)}%`],
    segments > 1
      ? [t("adminActivity.field.segments"), t("adminActivity.detail.segmentsValue", { count: segments })]
      : null,
    [t("adminActivity.field.device"), play.device ?? "—"],
    [t("adminActivity.field.ipAddress"), play.ipAddress ? <IpInfo ip={play.ipAddress} inline /> : "—"],
    [t("adminActivity.field.container"), play.container ?? "—"],
    [t("adminActivity.field.bitrate"), fmtBitrate(play.bitrate, play.source, locale)],
    [t("adminActivity.field.videoCodec"), play.videoCodec ?? "—"],
    [t("adminActivity.field.audioCodec"), play.audioCodec ?? "—"],
    [t("adminActivity.field.videoDecision"), play.videoDecision ?? "—"],
    [t("adminActivity.field.audioDecision"), play.audioDecision ?? "—"],
    // Network metadata. Plex-only — Jellyfin rows leave these null. Each cell
    // is suppressed when there's nothing to show rather than emit a row of
    // dashes that pads the panel for no reason.
    play.location ? [t("adminActivity.field.connection"), play.location.toUpperCase()] : null,
    play.secure != null
      ? [t("adminActivity.field.secure"), play.secure ? t("adminActivity.common.tls") : t("adminActivity.common.http")]
      : null,
    play.relayed ? [t("adminActivity.field.relay"), t("adminActivity.detail.viaPlexTv")] : null,
    // Plex reports bandwidth in kbps; surface as Mbps for parity with the
    // rest of the panel.
    play.bandwidth != null
      ? [
          t("adminActivity.field.sessionBandwidth"),
          `${(play.bandwidth / 1000).toLocaleString(locale, { maximumFractionDigits: 1 })} Mbps`,
        ]
      : null,
    // Intro/credits markers (Plex includeMarkers=1). Same suppression rule.
    play.introStartMs != null && play.introEndMs != null
      ? [
          t("adminActivity.field.introMarker"),
          `${fmtMarkerOffset(play.introStartMs)} – ${fmtMarkerOffset(play.introEndMs)}`,
        ]
      : null,
    play.creditsStartMs != null
      ? [t("adminActivity.field.creditsMarker"), `${fmtMarkerOffset(play.creditsStartMs)} – ${creditsTail(play, t)}`]
      : null,
  ];

  const episode = play.mediaType === "TV" ? episodeLabel(play.seasonNumber, play.episodeNumber) : null;
  if (episode) {
    entries.push([t("adminActivity.field.episode"), `${episode}${play.episodeTitle ? ` — ${play.episodeTitle}` : ""}`]);
  }
  return entries.filter((entry): entry is Entry => entry !== null);
}

export function DetailRow({
  id,
  play,
  colSpan,
  mounted,
  timeZone,
}: {
  // The row's toggle names this panel (aria-controls).
  id?: string;
  play: HistoryRow;
  colSpan: number;
  mounted: boolean;
  timeZone: string;
}) {
  const t = useT();
  const locale = useLocale();
  const details = detailEntries(play, { t, locale, mounted, timeZone });
  return (
    <tr
      id={id}
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
        <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
          {/* The only product path into /admin/activity/play/<id> — the full
              session page with the delete action. Links the row's own id: in
              grouped mode that is the newest segment, which is what the row
              stands for. */}
          <Link
            href={`/admin/activity/play/${play.id}`}
            style={linkStyle}
          >
            {t("adminActivity.detail.openPlay")}
          </Link>
          {play.tmdbId != null && play.tmdbId > 0 && (
            <Link
              href={`/admin/activity/media/${play.tmdbId}${play.mediaType ? `?type=${play.mediaType}` : ""}`}
              style={linkStyle}
            >
              {t("adminActivity.detail.viewTitleActivity")}
            </Link>
          )}
          <Link
            href={`/admin/activity/user/${play.mediaServerUserId}`}
            style={linkStyle}
          >
            {t("adminActivity.detail.userActivity")}
          </Link>
        </div>
      </td>
    </tr>
  );
}
