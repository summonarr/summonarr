// Plex Server-Sent Events (SSE) client for real-time playback state.
//
// Plex's polled /status/sessions endpoint lies: when a client (especially
// mobile/TV) closes without a clean Stop, the session lingers in /status/sessions
// for up to 30 minutes, leaving Summonarr's "now playing" card stuck on PLAYING.
//
// The /:/eventsource/notifications endpoint is the authoritative signal — Plex
// emits a `playing` event with state="stopped" the moment a session ends.
// This module owns a single long-lived SSE connection per Node process (per
// CLAUDE.md guardrail 17) and finalizes ActiveSession rows the instant Plex
// reports them stopped. The 5s poller in /api/sync/play-history is kept as a
// metadata-enrichment + discovery layer and as a fallback if SSE drops.
//
// The `recentlyFinalizedPlexSessions` ledger that the poller relies on for
// re-create gating now lives here so both subsystems share one source of
// truth.

import { prisma } from "./prisma";
import { safeFetchAdminConfigured } from "./safe-fetch";
import { applyFinalTick, recordCompletedSession, isPlayHistoryEnabled, isSourceEnabled } from "./play-history";

// Plex sometimes keeps a quit session in /status/sessions for up to 30 min
// (mobile/TV clients that close without a clean Stop). When the playhead has
// not advanced for this long while state still reports "playing", treat it as
// a quit and finalize early. Tertiary fallback under the SSE feed.
export const PLEX_STALL_THRESHOLD_MS = 60_000;

// Ledger of Plex sessions finalized via SSE, the stall path, or the stale
// loop. Keyed by ActiveSession.id ("plex:<sessionKey>"). Subsequent polls
// skip re-creating the row while Plex's /status/sessions still includes the
// ghost. In-memory: persists across polls inside the same Node process; a
// restart loses the ledger but Plex has usually dropped the session by then.
const recentlyFinalizedPlexSessions = new Map<string, number>();
const RECENTLY_FINALIZED_TTL_MS = 60 * 60 * 1000;

export function markPlexSessionFinalized(id: string, nowMs: number = Date.now()): void {
  recentlyFinalizedPlexSessions.set(id, nowMs);
}

export function isPlexSessionRecentlyFinalized(id: string): boolean {
  return recentlyFinalizedPlexSessions.has(id);
}

export function pruneRecentlyFinalized(nowMs: number): void {
  for (const [id, finalizedAt] of recentlyFinalizedPlexSessions) {
    if (nowMs - finalizedAt > RECENTLY_FINALIZED_TTL_MS) {
      recentlyFinalizedPlexSessions.delete(id);
    }
  }
}

// SSE frame parse target. Plex's "playing" event payload wraps a single
// notification under PlaySessionStateNotification. Tautulli's WebSocket
// payload encodes it as an array; the SSE feed emits a single object. Handle
// both defensively.
interface PlaySessionStateNotification {
  sessionKey?: string;
  state?: string;
  viewOffset?: number;
  ratingKey?: string;
  clientIdentifier?: string;
  key?: string;
}

type PlayingEventData = {
  PlaySessionStateNotification?:
    | PlaySessionStateNotification
    | PlaySessionStateNotification[];
};

// Reconnect backoff parameters. The poller already runs every 5s, so an SSE
// outage degrades to 60s detection (stall fallback) rather than 30 min — no
// need to hammer the server.
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

// Plex's SSE feed has no defined upper time bound. Reconnect periodically to
// keep the size-cap accumulator and any undici-side state fresh.
const PERIODIC_RECYCLE_MS = 22 * 60 * 60 * 1000;

class PlexEventStreamManager {
  private currentUrl: string | null = null;
  private currentToken: string | null = null;
  private abortController: AbortController | null = null;
  private backoffMs = INITIAL_BACKOFF_MS;
  private running = false;
  private loopPromise: Promise<void> | null = null;

  async reconcile(): Promise<void> {
    const [phEnabled, plexSourceEnabled, settings] = await Promise.all([
      isPlayHistoryEnabled(),
      isSourceEnabled("plex"),
      prisma.setting.findMany({
        where: { key: { in: ["plexServerUrl", "plexAdminToken"] } },
        select: { key: true, value: true },
      }),
    ]);

    const settingMap = new Map(settings.map((r) => [r.key, r.value]));
    const url = settingMap.get("plexServerUrl")?.replace(/\/$/, "") ?? null;
    const token = settingMap.get("plexAdminToken") ?? null;

    const shouldRun = phEnabled && plexSourceEnabled && !!url && !!token;

    if (!shouldRun) {
      if (this.running) this.stop();
      return;
    }

    if (this.running && this.currentUrl === url && this.currentToken === token) {
      return;
    }

    this.stop();
    this.currentUrl = url;
    this.currentToken = token;
    this.running = true;
    this.backoffMs = INITIAL_BACKOFF_MS;
    this.loopPromise = this.runLoop().catch((err) => {
      console.warn("[plex-events] loop crashed:", err);
    });
  }

  private stop(): void {
    this.running = false;
    this.abortController?.abort();
    this.abortController = null;
  }

  private async runLoop(): Promise<void> {
    const startedUrl = this.currentUrl;
    const startedToken = this.currentToken;

    while (this.running && this.currentUrl === startedUrl && this.currentToken === startedToken) {
      try {
        await this.connectAndConsume();
      } catch (err) {
        if (!this.running) break;
        // Silent first failure; warn on persistent outages so an admin sees something.
        if (this.backoffMs >= MAX_BACKOFF_MS) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[plex-events] connection failing repeatedly: ${msg}`);
        }
      }
      if (!this.running) break;
      await new Promise((resolve) => setTimeout(resolve, this.backoffMs));
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    }
  }

  private async connectAndConsume(): Promise<void> {
    const url = this.currentUrl;
    const token = this.currentToken;
    if (!url || !token) throw new Error("not configured");

    this.abortController = new AbortController();
    const recycleTimer = setTimeout(() => this.abortController?.abort(), PERIODIC_RECYCLE_MS);

    try {
      const sseUrl = `${url}/:/eventsource/notifications?filters=playing&X-Plex-Token=${encodeURIComponent(token)}`;
      const res = await safeFetchAdminConfigured(sseUrl, {
        headers: {
          Accept: "text/event-stream",
          // Required by Plex for any client-style request.
          "X-Plex-Product": "Summonarr",
          "X-Plex-Version": "1.0",
        },
        signal: this.abortController.signal,
        // SSE is a long-lived stream. The default 15s timeout would abort it
        // after one quiet minute; the default 10 MB cap would trip after a few
        // days of ping accumulation. Periodic reconnect (PERIODIC_RECYCLE_MS)
        // keeps us under both ceilings without risking a runaway counter.
        timeoutMs: PERIODIC_RECYCLE_MS + 60_000,
        maxResponseBytes: Number.MAX_SAFE_INTEGER,
      });

      if (!res.ok || !res.body) {
        throw new Error(`SSE status ${res.status}`);
      }

      // First successful read is what resets backoff — reaching this line just
      // means TCP connected; Plex could still 401 mid-stream.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let firstRead = true;

      while (this.running) {
        const { done, value } = await reader.read();
        if (done) {
          throw new Error("SSE stream ended");
        }
        if (firstRead) {
          this.backoffMs = INITIAL_BACKOFF_MS;
          firstRead = false;
        }
        buffer += decoder.decode(value, { stream: true });

        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          this.handleFrame(frame);
          boundary = buffer.indexOf("\n\n");
        }
      }
    } finally {
      clearTimeout(recycleTimer);
    }
  }

  private handleFrame(frame: string): void {
    let eventType = "";
    const dataParts: string[] = [];
    for (const rawLine of frame.split("\n")) {
      const line = rawLine.trimEnd();
      if (!line || line.startsWith(":")) continue;
      const colonIdx = line.indexOf(":");
      const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
      // Per SSE spec, a single leading space after the colon is stripped.
      let value = colonIdx === -1 ? "" : line.slice(colonIdx + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") eventType = value;
      else if (field === "data") dataParts.push(value);
    }

    if (eventType !== "playing" || dataParts.length === 0) return;

    let parsed: PlayingEventData;
    try {
      parsed = JSON.parse(dataParts.join("\n")) as PlayingEventData;
    } catch {
      return;
    }

    const raw = parsed.PlaySessionStateNotification;
    const notifications: PlaySessionStateNotification[] = Array.isArray(raw)
      ? raw
      : raw
        ? [raw]
        : [];

    for (const n of notifications) {
      if (n.state === "stopped" && n.sessionKey) {
        // viewOffset is the playhead position at stop. Pass it through so the
        // PlayHistory row's progressMs reflects where the user actually left
        // off, not the last 5s-poll snapshot which can lag.
        void this.finalizeStopped(n.sessionKey, n.viewOffset);
      }
    }
  }

  private async finalizeStopped(sessionKey: string, viewOffset: number | undefined): Promise<void> {
    const id = `plex:${sessionKey}`;
    try {
      const existing = await prisma.activeSession.findUnique({ where: { id } });
      if (!existing) {
        // Plex sent stop for a session we never saw (started before our
        // connection, finalized by the poller already, …). Gate against a
        // racey re-create just in case.
        markPlexSessionFinalized(id);
        return;
      }

      markPlexSessionFinalized(id);

      const now = new Date();
      const finalized = applyFinalTick(existing, now, {
        stoppedAt: now,
        ...(viewOffset != null && Number.isFinite(viewOffset) && viewOffset >= 0
          ? { progressMs: BigInt(Math.floor(viewOffset)) }
          : {}),
      });

      await recordCompletedSession(finalized);
    } catch (err) {
      console.warn(`[plex-events] finalize stop failed for ${id}:`, err);
    }
  }
}

const manager = new PlexEventStreamManager();

// Idempotent: reads current Settings and starts/stops/restarts the SSE
// connection as needed. Cheap to call repeatedly — the sync route invokes
// this every 5s so settings edits via the admin UI propagate within one tick.
export function reconcilePlexEventStream(): Promise<void> {
  return manager.reconcile();
}
