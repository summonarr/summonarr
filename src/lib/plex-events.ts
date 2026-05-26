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
import { getPlexSessions } from "./plex";

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

// Drop ledger entries for sessionKeys Plex no longer reports in /status/sessions.
// The ledger exists to gate re-creation while Plex keeps a ghost session in its
// snapshot after the user quit; once Plex actually drops the key, the ghost is
// gone and the entry is just suppressing future plays that happen to reuse the
// key. Pair with the 1h TTL backstop in case Plex never drops a ghost.
//
// Edge case (acknowledged, not addressed): if the Plex server itself restarts
// (sessionKey counter resets to 1) within the 1h TTL of a finalize, the first
// new play in the post-restart server can land on a key we've ledger-blocked.
// Detection would require persisting machineIdentifier across Node restarts.
export function clearFinalizedNotInCurrentSnapshot(currentPlexSessionKeys: ReadonlySet<string>): void {
  for (const id of recentlyFinalizedPlexSessions.keys()) {
    if (!id.startsWith("plex:")) continue;
    const sessionKey = id.slice(5);
    if (!currentPlexSessionKeys.has(sessionKey)) {
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
  // Coalesce concurrent reconcile() callers (boot + sync route + future paths)
  // so they can't both pass the "is anything changing?" check and end up each
  // calling stop() + start a new runLoop, leaving two SSE connections alive.
  // While one reconcile is in flight, subsequent callers set `pending`; the
  // in-flight call re-runs once after it finishes to pick up the latest state.
  private reconciling = false;
  private reconcilePending = false;

  async reconcile(): Promise<void> {
    if (this.reconciling) {
      this.reconcilePending = true;
      return;
    }
    this.reconciling = true;
    try {
      do {
        this.reconcilePending = false;
        await this.doReconcile();
      } while (this.reconcilePending);
    } finally {
      this.reconciling = false;
    }
  }

  private async doReconcile(): Promise<void> {
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

    // Safe-start reconcile: SSE is a "from-now" feed — events that fired while
    // we were disconnected (process restart, network blip, settings change) are
    // gone forever. Before subscribing, snapshot /status/sessions and finalize
    // any DB rows Plex no longer reports. Closes the post-restart window in
    // which a ghost "PLAYING" card could linger until the 5s poller or 60s
    // stall detector caught up. Runs once per (re)connect.
    await this.bootstrapReconcile(url, token);

    // Capture the AbortController in a local const so the recycle timer can't
    // later end up aborting a *different* connection (e.g. a settings-change
    // restart that swapped `this.abortController` for a fresh one). The
    // recycle timer must only fire against the connection it was paired with.
    const localAbort = new AbortController();
    this.abortController = localAbort;
    const recycleTimer = setTimeout(() => localAbort.abort(), PERIODIC_RECYCLE_MS);

    try {
      const sseUrl = `${url}/:/eventsource/notifications?filters=playing&X-Plex-Token=${encodeURIComponent(token)}`;
      const res = await safeFetchAdminConfigured(sseUrl, {
        headers: {
          Accept: "text/event-stream",
          // Required by Plex for any client-style request.
          "X-Plex-Product": "Summonarr",
          "X-Plex-Version": "1.0",
        },
        signal: localAbort.signal,
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
        // SSE spec allows either LF or CRLF line endings; Plex currently emits
        // LF, but normalize defensively so the frame-boundary indexOf below
        // doesn't desync if a future Plex build switches conventions.
        if (buffer.includes("\r")) buffer = buffer.replace(/\r\n/g, "\n");

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
      // Clear `this.abortController` only if it still points at our local one.
      // A concurrent reconcile may have swapped it for a fresh connection's
      // controller; in that case we leave it alone so the new connection can
      // still be stopped.
      if (this.abortController === localAbort) this.abortController = null;
    }
  }

  private async bootstrapReconcile(url: string, token: string): Promise<void> {
    let plexSessions;
    let activeDbRows;
    try {
      [plexSessions, activeDbRows] = await Promise.all([
        getPlexSessions(url, token),
        prisma.activeSession.findMany({ where: { source: "plex" } }),
      ]);
    } catch (err) {
      // Don't block the SSE connect on a transient Plex or DB hiccup — the 5s
      // poller will reconcile within one tick.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[plex-events] bootstrap reconcile failed: ${msg}`);
      return;
    }

    const seenKeys = new Set<string>();
    for (const s of plexSessions) {
      if (s.sessionKey) seenKeys.add(s.sessionKey);
    }

    // Release ledger entries Plex is no longer reporting — the ghost they were
    // suppressing is actually gone, and a future play reusing the key should
    // not be invisible.
    clearFinalizedNotInCurrentSnapshot(seenKeys);

    const stale = activeDbRows.filter((r) => !seenKeys.has(r.sessionKey));
    if (stale.length === 0) return;

    const now = new Date();
    const nowMs = now.getTime();

    await Promise.all(
      stale.map(async (session) => {
        markPlexSessionFinalized(session.id, nowMs);
        try {
          await recordCompletedSession(applyFinalTick(session, now, { stoppedAt: now }));
        } catch (err) {
          console.warn(`[plex-events] bootstrap finalize failed for ${session.id}:`, err);
        }
      }),
    );
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

      // SSE is the authoritative stop signal. recordCompletedSession's CAS on
      // lastSeenAt may have left the ActiveSession row in place if the poller
      // bumped lastSeenAt between our findUnique and the upsert. The
      // PlayHistory row is already written; force-clean the ActiveSession so
      // the now-playing UI clears on the next sessions snapshot. The ledger
      // entry above prevents a re-create race with the concurrent poller.
      await prisma.activeSession.deleteMany({ where: { id } }).catch(() => {});
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
