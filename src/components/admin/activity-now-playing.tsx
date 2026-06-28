"use client";

import { useState } from "react";
import Link from "next/link";
import { useLiveEvents, type ActiveSessionLive } from "@/hooks/use-live-events";
import { IpInfo } from "@/components/admin/ip-info";
import { Loader2, X } from "@/components/icons";
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
  formatMs,
  methodLabel,
} from "@/components/admin/activity-ui";

// ActiveSession.id is "<source>:<sessionKey>". Strip the prefix to recover the
// raw sessionKey the terminate endpoints expect. Returns the endpoint + key for
// the sources that support termination (Plex, Jellyfin), or null otherwise.
function terminateTargetFor(
  session: ActiveSessionLive,
): { endpoint: string; sessionKey: string } | null {
  if (session.id.startsWith("plex:")) {
    return {
      endpoint: "/api/admin/play-history/terminate-session",
      sessionKey: session.id.slice(5),
    };
  }
  if (session.id.startsWith("jellyfin:")) {
    return {
      endpoint: "/api/admin/play-history/terminate-jellyfin-session",
      sessionKey: session.id.slice(9),
    };
  }
  return null;
}

// Format a ms offset as m:ss (or h:mm:ss if >=1h). Used for marker labels.
function fmtOffset(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function MarkersChip({ s }: { s: ActiveSessionLive }) {
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
      {hasIntro && (
        <span title="Intro marker (from Plex)">
          <span style={{ color: "var(--ds-fg-disabled)" }}>INTRO </span>
          {fmtOffset(s.introStartMs!)}–{fmtOffset(s.introEndMs!)}
        </span>
      )}
      {hasCredits && (
        <span title="Credits marker (from Plex)">
          <span style={{ color: "var(--ds-fg-disabled)" }}>CREDITS </span>
          {creditsLabel}
        </span>
      )}
    </div>
  );
}

function NetworkBadges({ s }: { s: ActiveSessionLive }) {
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
          title="Streaming through Plex's relay proxy"
        >
          RELAY
        </span>
      )}
      {s.secure != null && (
        <span
          className="ds-mono"
          style={{ color: s.secure ? "var(--ds-fg-subtle)" : "var(--ds-warning, #c84)" }}
          title={s.secure ? "HTTPS connection" : "Plain HTTP connection"}
        >
          {s.secure ? "TLS" : "HTTP"}
        </span>
      )}
    </span>
  );
}

const DEFAULT_TERMINATE_REASON = "Session terminated by an administrator.";

function TerminateButton({ session }: { session: ActiveSessionLive }) {
  const target = terminateTargetFor(session);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState(DEFAULT_TERMINATE_REASON);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!target) return null;
  const { endpoint, sessionKey } = target;
  const serverLabel = session.source === "jellyfin" ? "Jellyfin" : "Plex";

  function openDialog() {
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
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionKey,
          reason: reason.trim() || DEFAULT_TERMINATE_REASON,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Unknown error" }));
        setError(typeof data.error === "string" ? data.error : "Failed");
        setBusy(false);
        return;
      }
      // Success: keep the dialog in its "Terminating…" state. The session card
      // unmounts on the next activity:sessions SSE push (within ~1s) once the
      // server tears the stream down — that removes this whole component (and
      // the dialog) with it, so we don't flash the dialog closed prematurely.
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
          cursor: "pointer",
        }}
        title={`Terminate this ${serverLabel} session`}
      >
        Terminate
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
                    Terminate {serverLabel} session
                  </DialogTitle>
                  <p
                    className="ds-mono truncate max-w-72"
                    style={{ fontSize: 11, color: "var(--ds-fg-subtle)", margin: "2px 0 0" }}
                  >
                    {session.title}
                  </p>
                </div>
                <DialogClose
                  aria-label="Close"
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
                    Reason shown to the user
                  </label>
                  <textarea
                    id="terminate-reason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    maxLength={500}
                    rows={3}
                    autoFocus
                    disabled={busy}
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-zinc-500 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 resize-none"
                  />
                </div>

                {error && <p className="text-xs text-red-400">{error}</p>}

                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    disabled={busy}
                    className="inline-flex items-center justify-center font-medium transition-colors disabled:opacity-50"
                    style={{
                      padding: "6px 12px",
                      height: 30,
                      borderRadius: 6,
                      fontSize: 12,
                      background: "transparent",
                      color: "var(--ds-fg-muted)",
                      border: "1px solid var(--ds-border)",
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={busy}
                    className="inline-flex items-center justify-center gap-1.5 font-medium transition-colors disabled:opacity-50"
                    style={{
                      padding: "6px 14px",
                      height: 30,
                      borderRadius: 6,
                      fontSize: 12,
                      background: "var(--ds-danger, #c44)",
                      color: "oklch(0.98 0 0)",
                      border: "1px solid transparent",
                    }}
                  >
                    {busy && <Loader2 className="animate-spin" style={{ width: 12, height: 12 }} />}
                    {busy ? "Terminating…" : "Terminate"}
                  </button>
                </div>
              </form>
            </DialogPopup>
          </DialogPortal>
        </Dialog>
      )}
    </>
  );
}

// Plex reports bitrate in kbps; Jellyfin in bps — normalize to kbps.
function toBitrateKbps(raw: number | null): number {
  if (!raw || raw <= 0) return 0;
  return raw > 100000 ? raw / 1000 : raw;
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
  const isTV = (s.mediaType ?? "").toUpperCase() === "TV";
  const mediaHref = s.tmdbId
    ? `/admin/activity/media/${s.tmdbId}${s.mediaType ? `?type=${(s.mediaType ?? "").toUpperCase()}` : ""}`
    : null;
  const accent = accentFor(s.title || s.id);
  const m = methodLabel(s.playMethod, s.videoDecision, s.audioDecision);
  const bitrateMbps = toBitrateKbps(s.bitrate) / 1000;
  const paused = s.state === "paused";

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
            <SourceTag source={s.source} />
            <span
              className="ds-mono"
              style={{ fontSize: 9.5, color: "var(--ds-fg-disabled)" }}
            >
              {paused
                ? "PAUSED"
                : s.state === "buffering"
                  ? "BUFFERING"
                  : "PLAYING"}
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
                S{String(s.seasonNumber ?? 0).padStart(2, "0")} · E
                {String(s.episodeNumber ?? 0).padStart(2, "0")}
                {s.episodeTitle && (
                  <>
                    {" "}
                    · <span style={{ color: "var(--ds-fg-subtle)" }}>{s.episodeTitle}</span>
                  </>
                )}
              </>
            ) : (
              <>
                {s.year ? `${s.year} · ` : ""}Movie
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
        <KeyVal k="User" v={userNode} />
        <KeyVal
          k="Device"
          v={[s.device, s.platform ?? s.player].filter(Boolean).join(" · ") || "—"}
        />
        <KeyVal
          k="Stream"
          v={<MethodPill method={m.label} methodClass={m.cls} />}
        />
        <KeyVal
          k="Quality"
          v={
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <span className="ds-mono">{s.resolution ?? "—"}</span>
              {bitrateMbps > 0 && (
                <>
                  <span style={{ color: "var(--ds-fg-disabled)" }}>·</span>
                  <span className="ds-mono" style={{ color: "var(--ds-fg-subtle)" }}>
                    {bitrateMbps.toFixed(1)} Mbps
                  </span>
                </>
              )}
            </span>
          }
        />
        <KeyVal
          k="Codec"
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
          k="Origin"
          v={
            s.ipAddress ? (
              <IpInfo ip={s.ipAddress} inline />
            ) : (
              <span style={{ color: "var(--ds-fg-disabled)" }}>—</span>
            )
          }
        />
        <KeyVal k="Network" v={<NetworkBadges s={s} />} />
      </div>
    </article>
  );
}

export function ActivityNowPlaying({
  initialSessions,
  source,
  mediaType,
  initialPlexReachable,
}: {
  initialSessions: ActiveSessionLive[];
  source?: string;
  mediaType?: string;
  // null = unknown (no Plex configured / not polled yet),
  // true = Summonarr can reach the local Plex server (getPlexSessions succeeds),
  // false = Summonarr cannot reach Plex (poll/connect failing). This tracks
  // *local* reachability, not plex.tv remote access. Read server-side from
  // Setting('plexServerReachable'); SSE updates flow via the plex:reachability
  // event below.
  initialPlexReachable?: boolean | null;
}) {
  const [sessions, setSessions] =
    useState<ActiveSessionLive[]>(initialSessions);
  const [connected, setConnected] = useState(false);
  const [plexReachable, setPlexReachable] = useState<boolean | null>(
    initialPlexReachable ?? null,
  );

  useLiveEvents((event) => {
    if (event.type === "connected") setConnected(true);
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
      setPlexReachable(event.reachable);
    }
  });

  const plexCount = sessions.filter((s) => s.source === "plex").length;
  const jellyfinCount = sessions.length - plexCount;
  const totalMbps =
    sessions.reduce((sum, s) => sum + toBitrateKbps(s.bitrate), 0) / 1000;

  const sub =
    sessions.length === 0
      ? "no active streams"
      : `${sessions.length} active${
          plexCount > 0 && jellyfinCount > 0
            ? ` · ${plexCount} Plex · ${jellyfinCount} Jellyfin`
            : ""
        }${totalMbps > 0 ? ` · ${totalMbps.toFixed(1)} Mbps combined` : ""}`;

  return (
    <section style={{ marginBottom: 28 }}>
      <SectionHeader
        label="Now playing"
        sub={sub}
        right={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
            {plexReachable === false && (
              <span
                className="ds-mono"
                title="Summonarr can't reach the Plex server — Plex play tracking and now-playing are paused until it's reachable again. Checked every poll via getPlexSessions."
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
                Plex unreachable
              </span>
            )}
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
              {connected ? "Live" : "Connecting…"}
            </span>
          </span>
        }
      />
      {sessions.length === 0 ? (
        <div
          style={{
            padding: "28px 18px",
            background: "var(--ds-bg-2)",
            border: "1px solid var(--ds-border)",
            borderRadius: 10,
            color: "var(--ds-fg-subtle)",
            fontSize: 13,
            textAlign: "center",
          }}
        >
          No active streams
        </div>
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
