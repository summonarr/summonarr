"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useLiveEvents, type ActiveSessionLive } from "@/hooks/use-live-events";
import { withBasePath } from "@/lib/base-path";
import { parseActiveSessionId } from "@/lib/media-instances";
import { bitrateToKbps } from "@/lib/bitrate";
import { IpInfo } from "@/components/admin/ip-info";
import { Loader2, X } from "@/components/icons";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/design";
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogPopup,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Avatar,
  KeyVal,
  MethodPill,
  Poster,
  ProgressTrack,
  SectionHeader,
  SourceTag,
  fmtBitrate,
  formatMs,
  methodLabel,
} from "@/components/admin/activity-ui";

// ActiveSession.id is "<source>:<sessionKey>" for the default instance, or
// "<source>:<instance>:<sessionKey>" for a named one (see activeSessionId in
// media-instances.ts). Both sources need the real parse — a naive prefix-strip
// on a named instance's session would send the instance slug as part of the
// sessionKey and the server would 404 it (and resolve against the wrong
// server's snapshot). Returns the endpoint + key + instance for the sources
// that support termination (Plex, Jellyfin), or null otherwise.
function terminateTargetFor(
  session: ActiveSessionLive,
): { endpoint: string; sessionKey: string; serverInstance?: string } | null {
  if (session.id.startsWith("plex:")) {
    const parsed = parseActiveSessionId(session.id);
    return {
      endpoint: "/api/admin/play-history/terminate-session",
      sessionKey: parsed.sessionKey,
      serverInstance: parsed.serverInstance,
    };
  }
  if (session.id.startsWith("jellyfin:")) {
    const parsed = parseActiveSessionId(session.id);
    return {
      endpoint: "/api/admin/play-history/terminate-jellyfin-session",
      sessionKey: parsed.sessionKey,
      serverInstance: parsed.serverInstance,
    };
  }
  return null;
}

// Format a ms offset as m:ss (or h:mm:ss if >=1h). Used for marker labels.
// Delegates to the shared formatMs (same shape as the progress/duration
// labels in the card); the clamp is the only delta — a negative marker offset
// must never render as "-1:-5".
function fmtOffset(ms: number): string {
  return formatMs(Math.max(0, ms));
}

function MarkersChip({ s }: { s: ActiveSessionLive }) {
  const t = useT();
  const hasIntro = s.introStartMs != null && s.introEndMs != null;
  const hasCredits = s.creditsStartMs != null;
  if (!hasIntro && !hasCredits) return null;
  const creditsLabel = hasCredits
    ? (s.creditsEndMs != null && s.creditsEndMs >= s.durationMs - 1000
        ? `${fmtOffset(s.creditsStartMs!)}+`
        : `${fmtOffset(s.creditsStartMs!)}–${fmtOffset(s.creditsEndMs ?? s.durationMs)}`)
    : null;
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
      {hasIntro && (
        <span title={t("adminActivity.nowPlaying.introTitle")}>
          <span style={{ color: "var(--ds-fg-subtle)" }}>{t("adminActivity.nowPlaying.intro")} </span>
          {fmtOffset(s.introStartMs!)}–{fmtOffset(s.introEndMs!)}
        </span>
      )}
      {hasCredits && (
        <span title={t("adminActivity.nowPlaying.creditsTitle")}>
          <span style={{ color: "var(--ds-fg-subtle)" }}>{t("adminActivity.nowPlaying.credits")} </span>
          {creditsLabel}
        </span>
      )}
    </div>
  );
}

function NetworkBadges({ s }: { s: ActiveSessionLive }) {
  const t = useT();
  // Only render anything when at least one signal is present. Plex populates
  // these; Jellyfin currently leaves them null.
  if (s.location == null && s.secure == null && s.relayed == null) {
    return <span style={{ color: "var(--ds-fg-disabled)" }}>—</span>;
  }
  const locColor = s.location === "lan"
    ? "var(--ds-success, #2c9)"
    : s.location === "relay"
      ? "var(--ds-warning, #c84)"
      : "var(--ds-fg-muted)";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      {s.location && (
        <span className="ds-mono" style={{ color: locColor, textTransform: "uppercase" }}>
          {s.location}
        </span>
      )}
      {s.relayed && (
        <span
          className="ds-mono"
          style={{ color: "var(--ds-warning, #c84)" }}
          title={t("adminActivity.nowPlaying.relayTitle")}
        >
          RELAY
        </span>
      )}
      {s.secure != null && (
        <span
          className="ds-mono"
          style={{ color: s.secure ? "var(--ds-fg-subtle)" : "var(--ds-warning, #c84)" }}
          title={s.secure ? t("adminActivity.nowPlaying.httpsTitle") : t("adminActivity.nowPlaying.httpTitle")}
        >
          {s.secure ? "TLS" : "HTTP"}
        </span>
      )}
    </span>
  );
}

function TerminateButton({ session }: { session: ActiveSessionLive }) {
  const t = useT();
  // Pre-filled reason shown on the viewer's client; editable before sending.
  const DEFAULT_TERMINATE_REASON = t("adminActivity.terminate.defaultReason");
  const target = terminateTargetFor(session);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState(DEFAULT_TERMINATE_REASON);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bounded release of the `busy` gate on a successful terminate (see onSubmit).
  const terminateFallback = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(terminateFallback.current), []);
  if (!target) return null;
  const { endpoint, sessionKey, serverInstance } = target;
  const serverLabel = session.source === "jellyfin" ? "Jellyfin" : "Plex";

  function openDialog() {
    clearTimeout(terminateFallback.current);
    setReason(DEFAULT_TERMINATE_REASON);
    setError(null);
    setBusy(false);
    setOpen(true);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(withBasePath(endpoint), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionKey,
          ...(serverInstance !== undefined ? { serverInstance } : {}),
          reason: reason.trim() || DEFAULT_TERMINATE_REASON,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: t("adminActivity.terminate.unknownError") }));
        setError(typeof data.error === "string" ? data.error : t("adminActivity.terminate.failed"));
        setBusy(false);
        return;
      }
      // Success: keep the dialog in its "Terminating…" state. The session card
      // unmounts on the next activity:sessions SSE push (within ~1s) once the
      // server tears the stream down — that removes this whole component (and
      // the dialog) with it, so we don't flash the dialog closed prematurely.
      //
      // ...but that unmount is not guaranteed: Plex ignores termination for some
      // direct-play clients (200 returned, stream keeps going), and the shared SSE
      // connection can be parked on its 30s permanent-failure re-probe. Every
      // dismissal route (Escape, backdrop, X, Cancel) is gated on `busy`, so
      // without a bound the admin's only way out was a full page reload. Release
      // the gate after 10s so the dialog is always escapable; if the card does
      // unmount first this timer dies with it.
      terminateFallback.current = setTimeout(() => setBusy(false), 10_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        style={{
          fontSize: 10.5,
          padding: "3px 8px",
          background: "transparent",
          border: "1px solid var(--ds-border)",
          borderRadius: 6,
          color: "var(--ds-fg-muted)",
        }}
        title={t("adminActivity.terminate.buttonTitle", { server: serverLabel })}
      >
        {t("adminActivity.terminate.button")}
      </button>

      {open && (
        <Dialog
          open
          onOpenChange={(next) => {
            // Don't allow dismissing mid-request — the card will unmount on its own.
            if (!next && !busy) setOpen(false);
          }}
        >
          <DialogPortal>
            <DialogBackdrop />
            <DialogPopup
              className="max-w-md"
              style={{
                background: "var(--ds-bg-1)",
                border: "1px solid var(--ds-border)",
                borderRadius: 12,
                boxShadow: "var(--ds-shadow-lg)",
              }}
            >
              <div
                className="flex items-center justify-between"
                style={{ padding: "14px 20px", borderBottom: "1px solid var(--ds-border)" }}
              >
                <div>
                  <DialogTitle
                    className="font-semibold"
                    style={{ fontSize: 15, color: "var(--ds-fg)", margin: 0 }}
                  >
                    {t("adminActivity.terminate.dialogTitle", { server: serverLabel })}
                  </DialogTitle>
                  <p
                    className="ds-mono truncate max-w-72"
                    style={{ fontSize: 11, color: "var(--ds-fg-subtle)", margin: "2px 0 0" }}
                  >
                    {session.title}
                  </p>
                </div>
                <DialogClose
                  aria-label={t("adminActivity.common.close")}
                  disabled={busy}
                  className="inline-flex items-center justify-center rounded-full transition-colors disabled:opacity-40"
                  style={{
                    width: 28,
                    height: 28,
                    background: "transparent",
                    border: 0,
                    color: "var(--ds-fg-muted)",
                  }}
                >
                  <X style={{ width: 14, height: 14 }} />
                </DialogClose>
              </div>

              <form onSubmit={onSubmit} className="px-5 py-4 space-y-4">
                <div className="space-y-1.5">
                  <label
                    htmlFor="terminate-reason"
                    className="text-xs font-medium text-zinc-400 uppercase tracking-wide"
                  >
                    {t("adminActivity.terminate.reasonLabel")}
                  </label>
                  <textarea
                    id="terminate-reason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    maxLength={500}
                    rows={3}
                    autoFocus
                    disabled={busy}
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-500 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 resize-none"
                  />
                </div>

                {error && <p className="text-xs text-red-400">{error}</p>}

                <div className="flex justify-end gap-2 pt-1">
                  {/* The shared Button primitive, like every other dialog's
                      actions — same radius, height, focus ring and hover
                      (the hand-rolled danger fill had none). */}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setOpen(false)}
                    disabled={busy}
                  >
                    {t("adminActivity.common.cancel")}
                  </Button>
                  <Button type="submit" variant="destructive" size="sm" disabled={busy}>
                    {busy && <Loader2 className="animate-spin" />}
                    {busy ? t("adminActivity.terminate.terminating") : t("adminActivity.terminate.button")}
                  </Button>
                </div>
              </form>
            </DialogPopup>
          </DialogPortal>
        </Dialog>
      )}
    </>
  );
}

// Stable, pleasant per-title poster wash so the radial accent is consistent
// across renders without depending on TMDB colors.
function accentFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `oklch(0.38 0.08 ${hue})`;
}

function SessionCard({ s }: { s: ActiveSessionLive }) {
  const t = useT();
  const isTV = (s.mediaType ?? "").toUpperCase() === "TV";
  const mediaHref = s.tmdbId
    ? `/admin/activity/media/${s.tmdbId}${s.mediaType ? `?type=${(s.mediaType ?? "").toUpperCase()}` : ""}`
    : null;
  const accent = accentFor(s.title || s.id);
  // Which media server this stream is on. ActiveSessionLive carries no
  // `serverInstance` field (neither does the SSE snapshot select), but the id
  // encodes the slug by construction — see activeSessionId in
  // media-instances.ts — so the badge needs no wire change. "" for the default
  // instance, and SourceTag renders nothing extra in that case.
  const serverInstance = parseActiveSessionId(s.id).serverInstance;
  const m = methodLabel(t, s.playMethod, s.videoDecision, s.audioDecision);
  // Same recipe as the Recent plays detail row (fmtBitrate resolves the unit
  // from `source` — guardrail 19a), so a 650 kbps phone transcode reads
  // "650 kbps" here and there, not "0.7 Mbps" on one and "650 kbps" on the other.
  const bitrateLabel = fmtBitrate(s.bitrate, s.source);
  const paused = s.state === "paused";
  // Composed exactly like recent-plays' `sub`: an unknown season/episode is
  // dropped, never rendered as "S00 · E00".
  const seasonEpisode = isTV
    ? [
        s.seasonNumber != null ? `S${String(s.seasonNumber).padStart(2, "0")}` : null,
        s.episodeNumber != null ? `E${String(s.episodeNumber).padStart(2, "0")}` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  const userNode = s.serverUsername ? (
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
  ) : (
    "—"
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
            <Poster
              src={s.posterUrl}
              letter={(s.title[0] ?? "?").toUpperCase()}
              accent={accent}
              w={50}
              h={75}
              radius={5}
            />
          </Link>
        ) : (
          <Poster
            src={s.posterUrl}
            letter={(s.title[0] ?? "?").toUpperCase()}
            accent={accent}
            w={50}
            h={75}
            radius={5}
          />
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
            <span
              className="ds-mono"
              style={{ fontSize: 9.5, color: "var(--ds-fg-subtle)" }}
            >
              {paused
                ? t("adminActivity.nowPlaying.state.paused")
                : s.state === "buffering"
                  ? t("adminActivity.nowPlaying.state.buffering")
                  : t("adminActivity.nowPlaying.state.playing")}
            </span>
            {(s.source === "plex" || s.source === "jellyfin") && (
              <span style={{ marginLeft: "auto" }}>
                <TerminateButton session={s} />
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
        </div>
      </div>

      <div style={{ position: "relative" }}>
        <ProgressTrack
          pct={Math.min(s.progressPercent, 100) / 100}
          paused={paused}
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

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 8,
          position: "relative",
        }}
      >
        <KeyVal k={t("adminActivity.field.user")} v={userNode} />
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
          v={
            s.ipAddress ? (
              <IpInfo ip={s.ipAddress} inline />
            ) : (
              <span style={{ color: "var(--ds-fg-disabled)" }}>—</span>
            )
          }
        />
        <KeyVal k={t("adminActivity.field.network")} v={<NetworkBadges s={s} />} />
      </div>
    </article>
  );
}

// Live "Now playing" grid. It starts from the sessions the server rendered,
// then updates from activity:sessions / plex:reachability messages on the SSE
// stream (server-sent events: the server's one-way live push to the browser).
export function ActivityNowPlaying({
  initialSessions,
  source,
  mediaType,
  plexReachability = [],
}: {
  initialSessions: ActiveSessionLive[];
  source?: string;
  mediaType?: string;
  // One entry per configured Plex server. `reachable`: null = unknown (not
  // configured / not polled yet), true = Summonarr can reach it
  // (getPlexSessions succeeds), false = it cannot (poll/connect failing). This
  // tracks *local* reachability, not plex.tv remote access. Read server-side
  // from each instance's Setting; SSE updates flow via the plex:reachability
  // event below, matched on `instance`.
  plexReachability?: { instance: string; name: string; reachable: boolean | null }[];
}) {
  const t = useT();
  const locale = useLocale();
  const [sessions, setSessions] =
    useState<ActiveSessionLive[]>(initialSessions);
  const [connected, setConnected] = useState(false);
  // One entry per Plex server. An SSE event only updates the entry whose
  // `instance` slug matches, so one server's news never overwrites another's.
  const [reachability, setReachability] = useState(plexReachability);

  useLiveEvents((event) => {
    if (event.type === "connected") setConnected(true);
    if (event.type === "disconnected") setConnected(false);
    if (event.type === "activity:sessions") {
      setSessions((prev) => {
        // SSE payloads omit posterUrl to stay small — carry the prior value.
        const posterMap = new Map(prev.map((s) => [s.id, s.posterUrl]));
        const filtered = event.sessions.filter((s) => {
          if (source && s.source !== source) return false;
          if (mediaType && (s.mediaType ?? "").toUpperCase() !== mediaType)
            return false;
          return true;
        });
        return filtered.map((s) => ({
          ...s,
          posterUrl: s.posterUrl ?? posterMap.get(s.id) ?? null,
        }));
      });
    }
    if (event.type === "plex:reachability") {
      setReachability((prev) =>
        prev.map((r) => (r.instance === event.instance ? { ...r, reachable: event.reachable } : r)),
      );
    }
  });

  const plexCount = sessions.filter((s) => s.source === "plex").length;
  const jellyfinCount = sessions.length - plexCount;
  const totalMbps =
    sessions.reduce((sum, s) => sum + bitrateToKbps(s.bitrate, s.source), 0) / 1000;

  const sub =
    sessions.length === 0
      ? t("adminActivity.nowPlaying.noActiveLower")
      : `${t("adminActivity.nowPlaying.activeCount", { count: sessions.length })}${
          plexCount > 0 && jellyfinCount > 0
            ? ` · ${plexCount} Plex · ${jellyfinCount} Jellyfin`
            : ""
        }${
          totalMbps > 0
            ? ` · ${t("adminActivity.nowPlaying.combined", {
                mbps: totalMbps.toLocaleString(locale, { maximumFractionDigits: 1 }),
              })}`
            : ""
        }`;

  return (
    <section style={{ marginBottom: 28 }}>
      <SectionHeader
        label={t("adminActivity.nowPlaying.title")}
        sub={sub}
        right={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
            {reachability
              .filter((r) => r.reachable === false)
              .map((r) => (
                <span
                  key={r.instance}
                  className="ds-mono"
                  title={t("adminActivity.nowPlaying.unreachableTitle", { name: r.name })}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    fontSize: 10.5,
                    color: "var(--ds-warning, #c84)",
                    whiteSpace: "nowrap",
                  }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 999,
                      background: "var(--ds-warning, #c84)",
                    }}
                  />
                  {/* The default server's name is "Plex", so a single-server
                      deployment renders exactly the string it always did. */}
                  {t("adminActivity.nowPlaying.unreachable", { name: r.name })}
                </span>
              ))}
            <span
              className="ds-mono"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                fontSize: 10.5,
                color: connected ? "var(--ds-success)" : "var(--ds-fg-subtle)",
                whiteSpace: "nowrap",
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 999,
                  background: connected
                    ? "var(--ds-success)"
                    : "var(--ds-fg-disabled)",
                }}
              />
              {connected ? t("adminActivity.nowPlaying.live") : t("adminActivity.nowPlaying.connecting")}
            </span>
          </span>
        }
      />
      {sessions.length === 0 ? (
        <EmptyState description={t("adminActivity.nowPlaying.noActive")} />
      ) : (
        <div
          className="resp-grid-3"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
            gap: 10,
          }}
        >
          {sessions.map((s) => (
            <SessionCard key={s.id} s={s} />
          ))}
        </div>
      )}
    </section>
  );
}
