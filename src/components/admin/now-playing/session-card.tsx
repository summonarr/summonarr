"use client";

// One live stream's card in the Now playing grid: what is playing and where it
// is up to, who is watching on what, and how it is streamed. The parts are
// small components below; the rules they lean on are pure (./rules).

import type { ReactNode } from "react";
import Link from "next/link";
import type { ActiveSessionLive } from "@/hooks/use-live-events";
import { parseActiveSessionId } from "@/lib/media-instances";
import { formatSeasonEpisode } from "@/lib/episode-label";
import { IpInfo } from "@/components/admin/ip-info";
import { accentFor } from "@/components/admin/activity-accent";
import { useT } from "@/components/i18n/i18n-provider";
import {
  Avatar,
  KeyVal,
  MethodPill,
  Poster,
  ProgressTrack,
  SourceTag,
  fmtBitrate,
  formatMs,
  methodLabel,
} from "@/components/admin/activity-ui";
import { creditsRange, networkSignals, terminateTargetFor } from "./rules";
import { TerminateButton } from "./terminate-button";

const DASH = <span style={{ color: "var(--ds-fg-disabled)" }}>—</span>;

// Format a ms offset as m:ss (or h:mm:ss if >=1h). Used for marker labels.
// Delegates to the shared formatMs (same shape as the progress/duration
// labels in the card); the clamp is the only delta — a negative marker offset
// must never render as "-1:-5".
function fmtOffset(ms: number): string {
  return formatMs(Math.max(0, ms));
}

function MarkersChip({ s }: { s: ActiveSessionLive }) {
  const t = useT();
  const intro = s.introStartMs != null && s.introEndMs != null ? { start: s.introStartMs, end: s.introEndMs } : null;
  const credits = s.creditsStartMs != null ? creditsRange(s.creditsStartMs, s.creditsEndMs, s.durationMs) : null;
  if (!intro && !credits) return null;
  return (
    <div
      className="ds-mono"
      style={{
        display: "flex",
        gap: 8,
        fontSize: 9.5,
        color: "var(--ds-fg-subtle)",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {/* The Intro/Credits prefixes are labels, so they read in --ds-fg-subtle
          like the rest of the chip — --ds-fg-disabled is ~1.8:1 dark / ~2.5:1
          light and is reserved for "—" placeholders (guardrail 42). */}
      {intro && (
        <span title={t("adminActivity.nowPlaying.introTitle")}>
          <span style={{ color: "var(--ds-fg-subtle)" }}>{t("adminActivity.nowPlaying.intro")} </span>
          {fmtOffset(intro.start)}–{fmtOffset(intro.end)}
        </span>
      )}
      {credits && (
        <span title={t("adminActivity.nowPlaying.creditsTitle")}>
          <span style={{ color: "var(--ds-fg-subtle)" }}>{t("adminActivity.nowPlaying.credits")} </span>
          {credits.end === null
            ? `${fmtOffset(credits.start)}+`
            : `${fmtOffset(credits.start)}–${fmtOffset(credits.end)}`}
        </span>
      )}
    </div>
  );
}

// Plex populates these; Jellyfin currently leaves them null.
function NetworkBadges({ s }: { s: ActiveSessionLive }) {
  const t = useT();
  const net = networkSignals(s);
  if (net.empty) return DASH;
  const locColor = net.location === "lan"
    ? "var(--ds-success)"
    : net.location === "relay"
      ? "var(--ds-warning)"
      : "var(--ds-fg-muted)";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      {net.location && (
        <span className="ds-mono" style={{ color: locColor, textTransform: "uppercase" }}>
          {net.location}
        </span>
      )}
      {net.relay && (
        <span
          className="ds-mono"
          style={{ color: "var(--ds-warning)" }}
          title={t("adminActivity.nowPlaying.relayTitle")}
        >
          {t("adminActivity.nowPlaying.relay")}
        </span>
      )}
      {net.secure !== null && (
        <span
          className="ds-mono"
          style={{ color: net.secure ? "var(--ds-fg-subtle)" : "var(--ds-warning)" }}
          title={net.secure ? t("adminActivity.nowPlaying.httpsTitle") : t("adminActivity.nowPlaying.httpTitle")}
        >
          {net.secure ? t("adminActivity.common.tls") : t("adminActivity.common.http")}
        </span>
      )}
    </span>
  );
}

// The card's link to the title's activity page, when the session is matched.
function mediaHrefFor(s: ActiveSessionLive): string | null {
  if (!s.tmdbId) return null;
  const type = s.mediaType ? `?type=${s.mediaType.toUpperCase()}` : "";
  return `/admin/activity/media/${s.tmdbId}${type}`;
}

function StateLabel({ state }: { state: string }) {
  const t = useT();
  return (
    <span className="ds-mono" style={{ fontSize: 9.5, color: "var(--ds-fg-subtle)" }}>
      {state === "paused"
        ? t("adminActivity.nowPlaying.state.paused")
        : state === "buffering"
          ? t("adminActivity.nowPlaying.state.buffering")
          : t("adminActivity.nowPlaying.state.playing")}
    </span>
  );
}

// "S02 · E03 · Title" for an episode (the shared helper drops an unknown
// season/episode, never "S00 · E00"), "1999 · Movie" otherwise.
function SessionSubtitle({ s, isTV }: { s: ActiveSessionLive; isTV: boolean }) {
  const t = useT();
  const seasonEpisode = isTV ? formatSeasonEpisode(s.seasonNumber, s.episodeNumber) : "";
  return (
    <div
      style={{
        fontSize: 11.5,
        color: "var(--ds-fg-muted)",
        lineHeight: 1.3,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {isTV ? (
        <>
          {seasonEpisode}
          {s.episodeTitle && (
            <>
              {seasonEpisode ? " · " : ""}
              <span style={{ color: "var(--ds-fg-subtle)" }}>{s.episodeTitle}</span>
            </>
          )}
        </>
      ) : (
        <>
          {s.year ? `${s.year} · ` : ""}{t("adminActivity.common.movie")}
        </>
      )}
    </div>
  );
}

function SessionProgress({ s }: { s: ActiveSessionLive }) {
  return (
    <div style={{ position: "relative" }}>
      <ProgressTrack
        pct={Math.min(s.progressPercent, 100) / 100}
        paused={s.state === "paused"}
        height={3}
      />
      <div
        className="ds-mono"
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginTop: 6,
          fontSize: 10.5,
          color: "var(--ds-fg-subtle)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        <span>
          {formatMs(s.progressMs)} / {formatMs(s.durationMs)}
        </span>
        <span>{Math.round(Math.min(s.progressPercent, 100))}%</span>
      </div>
      <MarkersChip s={s} />
    </div>
  );
}

function UserValue({ s, accent }: { s: ActiveSessionLive; accent: string }): ReactNode {
  if (!s.serverUsername) return "—";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        minWidth: 0,
      }}
    >
      <Avatar
        letter={(s.serverUsername[0] ?? "?").toUpperCase()}
        accent={accent}
        size={14}
      />
      {s.mediaServerUserId ? (
        <Link
          href={`/admin/activity/user/${s.mediaServerUserId}`}
          style={{ color: "inherit", textDecoration: "none" }}
        >
          {s.serverUsername}
        </Link>
      ) : (
        <span>{s.serverUsername}</span>
      )}
    </span>
  );
}

// Who, on what, and how: the card's key/value grid.
function SessionFacts({ s, accent }: { s: ActiveSessionLive; accent: string }) {
  const t = useT();
  const m = methodLabel(t, s.playMethod, s.videoDecision, s.audioDecision);
  // Same recipe as the Recent plays detail row (fmtBitrate resolves the unit
  // from `source` — guardrail 19a), so a 650 kbps phone transcode reads
  // "650 kbps" here and there, not "0.7 Mbps" on one and "650 kbps" on the other.
  const bitrateLabel = fmtBitrate(s.bitrate, s.source);
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
        gap: 8,
        position: "relative",
      }}
    >
      <KeyVal k={t("adminActivity.field.user")} v={<UserValue s={s} accent={accent} />} />
      <KeyVal
        k={t("adminActivity.field.device")}
        v={[s.device, s.platform ?? s.player].filter(Boolean).join(" · ") || "—"}
      />
      <KeyVal
        k={t("adminActivity.field.stream")}
        v={<MethodPill method={m.label} methodClass={m.cls} />}
      />
      <KeyVal
        k={t("adminActivity.field.quality")}
        v={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <span className="ds-mono">{s.resolution ?? "—"}</span>
            {bitrateLabel !== "—" && (
              <>
                <span style={{ color: "var(--ds-fg-disabled)" }}>·</span>
                <span className="ds-mono" style={{ color: "var(--ds-fg-subtle)" }}>
                  {bitrateLabel}
                </span>
              </>
            )}
          </span>
        }
      />
      <KeyVal
        k={t("adminActivity.field.codec")}
        v={
          <>
            <span className="ds-mono">
              {(s.videoCodec ?? "—").toUpperCase()}
            </span>
            {s.audioCodec && (
              <>
                {" "}
                ·{" "}
                <span className="ds-mono" style={{ color: "var(--ds-fg-subtle)" }}>
                  {s.audioCodec.toUpperCase()}
                </span>
              </>
            )}
          </>
        }
      />
      <KeyVal
        k={t("adminActivity.field.origin")}
        v={s.ipAddress ? <IpInfo ip={s.ipAddress} inline /> : DASH}
      />
      <KeyVal k={t("adminActivity.field.network")} v={<NetworkBadges s={s} />} />
    </div>
  );
}

export function SessionCard({ s }: { s: ActiveSessionLive }) {
  const isTV = (s.mediaType ?? "").toUpperCase() === "TV";
  const mediaHref = mediaHrefFor(s);
  const accent = accentFor(s.title || s.id);
  // Which media server this stream is on. ActiveSessionLive carries no
  // `serverInstance` field (neither does the SSE snapshot select), but the id
  // encodes the slug by construction — see activeSessionId in
  // media-instances.ts — so the badge needs no wire change. "" for the default
  // instance, and SourceTag renders nothing extra in that case.
  const serverInstance = parseActiveSessionId(s.id).serverInstance;
  const terminateTarget = terminateTargetFor(s.id);

  const poster = (
    <Poster
      src={s.posterUrl}
      letter={(s.title[0] ?? "?").toUpperCase()}
      accent={accent}
      w={50}
      h={75}
      radius={5}
    />
  );

  return (
    <article
      style={{
        padding: 16,
        background: "var(--ds-bg-2)",
        border: "1px solid var(--ds-border)",
        borderRadius: 10,
        display: "flex",
        flexDirection: "column",
        gap: 12,
        position: "relative",
        overflow: "hidden",
      }}
    >
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(120% 80% at 0% 0%, ${accent} 0%, transparent 55%)`,
          opacity: 0.1,
          pointerEvents: "none",
        }}
      />
      <div style={{ display: "flex", gap: 12, position: "relative" }}>
        {mediaHref ? (
          <Link href={mediaHref} style={{ display: "block" }}>
            {poster}
          </Link>
        ) : (
          poster
        )}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <SourceTag source={s.source} instance={serverInstance} />
            <StateLabel state={s.state} />
            {terminateTarget && (
              <span style={{ marginLeft: "auto" }}>
                <TerminateButton session={s} target={terminateTarget} />
              </span>
            )}
          </div>
          <h3
            style={{
              margin: 0,
              fontSize: 14.5,
              fontWeight: 600,
              letterSpacing: "-0.015em",
              color: "var(--ds-fg)",
              lineHeight: 1.25,
              overflow: "hidden",
              textOverflow: "ellipsis",
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
            }}
          >
            {mediaHref ? (
              <Link
                href={mediaHref}
                style={{ color: "inherit", textDecoration: "none" }}
              >
                {s.title}
              </Link>
            ) : (
              s.title
            )}
          </h3>
          <SessionSubtitle s={s} isTV={isTV} />
        </div>
      </div>

      <SessionProgress s={s} />
      <SessionFacts s={s} accent={accent} />
    </article>
  );
}
