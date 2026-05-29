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
import { applyFinalTick, recordCompletedSession, isPlayHistoryEnabled, isSourceEnabled, emitActiveSessionsSnapshot, reanchorActiveSessionsOnBoot, SESSION_ABSENCE_GRACE_MS } from "./play-history";
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

// Plex "timeline" event payload — fires when the scanner adds, updates, or
// deletes a library item. metadataState transitions through a small lifecycle:
// "queued" → "processing" → "created" / "updated" / "deleted". Only the
// terminal states (created / updated / deleted) materially change our cached
// library data; intermediate states are noise.
interface PlexTimelineEntry {
  itemID?: number;
  sectionID?: number;
  title?: string;
  type?: number;
  metadataState?: string;
  mediaState?: string;
}

type TimelineEventData = {
  TimelineEntry?: PlexTimelineEntry | PlexTimelineEntry[];
};

// Debounce window for the scanner-triggered library re-sync. Plex's scanner
// emits a TimelineEntry for every item it touches — a full Sonarr-style import
// can produce hundreds of events in a few seconds. Coalesce them into one
// /api/sync call rather than N. 30 s is long enough to absorb a normal
// re-scan while still being responsive to one-off edits.
const TIMELINE_RESYNC_DEBOUNCE_MS = 30_000;

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
      // Subscribe to playing + timeline event types. Playing drives the Now
      // Playing card; timeline lets us invalidate the library cache when Plex's
      // scanner adds/removes items. We deliberately do NOT subscribe to
      // reachability — that reports plex.tv *remote-access* status, which is
      // irrelevant for a self-hosted server reached over LAN/VPN; local
      // reachability is derived from getPlexSessions succeeding instead (see
      // persistReachability). Other notification types (transcode.*,
      // preferences, account) are dropped server-side by the filter.
      const sseUrl = `${url}/:/eventsource/notifications?filters=playing,timeline&X-Plex-Token=${encodeURIComponent(token)}`;
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
    // Re-anchor lastSeenAt to boot time BEFORE reading the rows, so a restart's
    // downtime can't make the absence-grace check below trivially true and
    // finalize a still-playing session on the first (fragile) boot snapshot.
    // Once-guarded — only the first reconcile after process start does this.
    await reanchorActiveSessionsOnBoot();

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

    // A successful getPlexSessions() against the local server is authoritative
    // proof Summonarr can reach Plex — mark it reachable. This is the connect-
    // time complement to the 5s poller, which is the steady-state writer (it
    // reports true on every successful poll and false when getPlexSessions
    // throws). The lastReachable guard keeps this a no-op once true.
    void this.persistReachability(true);

    const seenKeys = new Set<string>();
    for (const s of plexSessions) {
      if (s.sessionKey) seenKeys.add(s.sessionKey);
    }

    // Release ledger entries Plex is no longer reporting — the ghost they were
    // suppressing is actually gone, and a future play reusing the key should
    // not be invisible.
    clearFinalizedNotInCurrentSnapshot(seenKeys);

    const now = new Date();
    const nowMs = now.getTime();

    // Apply the SESSION_ABSENCE_GRACE_MS window the 5s poller uses. Without
    // it, a Summonarr restart (or any SSE reconnect) that races a Plex API
    // tick where the session is briefly missing from /status/sessions
    // finalizes a session that's still playing, ledger-locks the sessionKey,
    // and prevents the next poll from re-creating the row — the "Now Playing"
    // card disappears forever from the user's perspective. lastSeenAt is the
    // wall-clock anchor for "we know it was active recently"; a sub-60s gap
    // means trust the cached state and let the next snapshot confirm.
    const stale = activeDbRows.filter((r) =>
      !seenKeys.has(r.sessionKey)
      && nowMs - r.lastSeenAt.getTime() >= SESSION_ABSENCE_GRACE_MS,
    );
    if (stale.length === 0) return;

    await Promise.all(
      stale.map(async (session) => {
        markPlexSessionFinalized(session.id, nowMs);
        try {
          await recordCompletedSession(applyFinalTick(session, now), { stoppedAt: now });
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

    if (dataParts.length === 0) return;

    if (eventType === "playing") {
      this.handlePlaying(dataParts.join("\n"));
    } else if (eventType === "timeline") {
      this.handleTimeline(dataParts.join("\n"));
    }
  }

  private handlePlaying(payload: string): void {
    let parsed: PlayingEventData;
    try {
      parsed = JSON.parse(payload) as PlayingEventData;
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
      if (!n.sessionKey) continue;
      if (n.state === "stopped") {
        // viewOffset is the playhead position at stop. Pass it through so the
        // PlayHistory row's progressMs reflects where the user actually left
        // off, not the last 5s-poll snapshot which can lag.
        void this.finalizeStopped(n.sessionKey, n.viewOffset);
      } else if (n.state === "playing" || n.state === "paused" || n.state === "buffering") {
        // Non-stop state transitions: update ActiveSession.state in near
        // realtime so the Now Playing card flips between PLAYING / PAUSED /
        // BUFFERING within ~1s instead of waiting up to 5s for the next poll.
        // The 5s poller is still authoritative for progressMs, playtimeMs
        // accumulation, and full metadata refresh.
        void this.applyLiveStateUpdate(n.sessionKey, n.state, n.viewOffset);
      }
    }
  }

  private handleTimeline(payload: string): void {
    let parsed: TimelineEventData;
    try {
      parsed = JSON.parse(payload) as TimelineEventData;
    } catch {
      return;
    }
    const raw = parsed.TimelineEntry;
    const entries: PlexTimelineEntry[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
    let materialChange = false;
    for (const e of entries) {
      // Only "created" / "updated" / "deleted" terminal states change the
      // library shape we cache. "queued" and "processing" are intermediate
      // scan steps that the next terminal event supersedes — ignoring them
      // both halves the event rate and avoids triggering a sync mid-scan.
      if (e.metadataState === "created" || e.metadataState === "updated" || e.metadataState === "deleted") {
        materialChange = true;
        break;
      }
    }
    if (materialChange) {
      this.requestLibraryResync();
    }
  }

  // Debounce + dispatch for the scanner-triggered library re-sync. Plex emits
  // a TimelineEntry per touched item; coalescing inside this window keeps a
  // full re-scan from N+1ing /api/sync. The trigger fires HTTP to the local
  // sync route with the cron bearer token — exactly the same path the
  // external cron uses, so observability + auth stay consistent.
  private resyncTimer: ReturnType<typeof setTimeout> | null = null;
  private requestLibraryResync(): void {
    if (this.resyncTimer) clearTimeout(this.resyncTimer);
    this.resyncTimer = setTimeout(() => {
      this.resyncTimer = null;
      void this.triggerLibrarySync();
    }, TIMELINE_RESYNC_DEBOUNCE_MS);
  }

  private async triggerLibrarySync(): Promise<void> {
    try {
      const secret = process.env.CRON_SECRET;
      if (!secret) return; // no auth token available — silently skip.
      const port = process.env.PORT ?? "3000";
      await fetch(`http://127.0.0.1:${port}/api/sync`, {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}` },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[plex-events] timeline-triggered library sync failed: ${msg}`);
    }
  }

  // Last reachability value this process persisted. Guards the upsert + SSE
  // emit so an unchanged value (the 5s poller reports the same state every
  // tick) doesn't write the row or fan out an event on every poll. null until
  // the first persist, so a stale value in the DB is corrected on the first
  // poll/connect.
  private lastReachable: boolean | null = null;

  // Persist whether Summonarr can reach the *local* Plex server. Called with
  // true after a successful getPlexSessions() (SSE bootstrap + 5s poller) and
  // false when that call throws. This is NOT plex.tv remote-access status —
  // that signal is intentionally ignored (irrelevant for a self-hosted server
  // reached over LAN/VPN). Exposed to the poller via setPlexReachable().
  async persistReachability(reachable: boolean): Promise<void> {
    // No-op when the value is unchanged since this process last persisted it.
    if (this.lastReachable === reachable) return;
    // Setting is the single source of truth used by the UI to render the
    // server-reachability indicator. Store a JSON blob so we can add fields
    // (lastChangedAt etc) without a schema change.
    try {
      const value = JSON.stringify({ reachable, observedAt: new Date().toISOString() });
      await prisma.setting.upsert({
        where: { key: "plexServerReachable" },
        create: { key: "plexServerReachable", value },
        update: { value },
      });
      // Only record the value as persisted after the write succeeds, so a
      // failed upsert is retried on the next call rather than silently latched.
      this.lastReachable = reachable;
      // Broadcast so the UI updates without polling.
      const { emitSSE } = await import("./sse-emitter");
      emitSSE({ type: "plex:reachability", reachable });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[plex-events] persist reachability failed: ${msg}`);
    }
  }

  private async applyLiveStateUpdate(
    sessionKey: string,
    state: "playing" | "paused" | "buffering",
    viewOffset: number | undefined,
  ): Promise<void> {
    const id = `plex:${sessionKey}`;
    // Skip if this session was just finalized — a late state event arriving
    // after a stop should not resurrect the row.
    if (isPlexSessionRecentlyFinalized(id)) return;
    try {
      // Read prior state so we can refresh progressUpdatedAt on a
      // resume-to-playing transition. The 5s poll's stall detector uses
      // progressUpdatedAt as the "playhead last advanced" anchor — if we
      // flip state to playing here without refreshing, the next poll sees
      // existing.state=playing (set by us) with a progressUpdatedAt frozen
      // from before the pause, and stall-finalizes on the first tick after
      // resume. The 5s poll has its own resumedToPlaying guard for the same
      // case, but it only fires when *its* prior observation was non-playing
      // — once SSE has already pre-flipped state to playing, that guard
      // silently misses, hence this companion refresh here.
      const prior = await prisma.activeSession.findUnique({
        where: { id },
        select: { state: true, progressMs: true },
      });
      if (!prior) return;
      const transitionedToPlaying = prior.state !== "playing" && state === "playing";

      // Did the playhead MOVE in this event (forward OR backward — a seek is
      // still liveness)? The 5s poller's stall detector treats
      // progressUpdatedAt as "when the playhead last moved" and finalizes a
      // still-playing session once it's >60s stale (PLEX_STALL_THRESHOLD_MS).
      // Both writers must refresh the anchor on any movement; checking for a
      // strict forward advance misses backward seeks and lets the anchor go
      // stale on an actively-scrubbed stream. A frozen ghost never emits SSE
      // events at all, so refreshing on movement here cannot keep one alive.
      const playheadMoved =
        viewOffset != null && Number.isFinite(viewOffset) && viewOffset >= 0
          ? BigInt(Math.floor(viewOffset)) !== prior.progressMs
          : false;

      const result = await prisma.activeSession.updateMany({
        where: { id },
        data: {
          state,
          ...(viewOffset != null && Number.isFinite(viewOffset) && viewOffset >= 0
            ? { progressMs: BigInt(Math.floor(viewOffset)) }
            : {}),
          ...(transitionedToPlaying || playheadMoved ? { progressUpdatedAt: new Date() } : {}),
        },
      });
      // Push a sessions snapshot only if the row actually changed — avoids
      // SSE storms when Plex hammers "playing" notifications during scrubbing.
      if (result.count > 0) {
        await emitActiveSessionsSnapshot();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[plex-events] live state update failed for ${id}: ${msg}`);
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

      // Plex Web and several cast/mobile clients emit a spurious state="stopped"
      // SSE event on pause, app-background, or player-navigation transitions —
      // not just on real stops. Without this cross-check, every such event
      // writes a Stopped PlayHistory row, deletes the ActiveSession, and ledger-
      // locks the sessionKey so the next poll can't even resurrect it as paused.
      // Confirm against /status/sessions: if Plex still reports the session in
      // any state (playing, paused, buffering), treat the SSE as advisory and
      // let the 5s poller drive state going forward. The poller's stall
      // detector + grace window catch true stops within 60s as the backstop.
      if (this.currentUrl && this.currentToken) {
        try {
          const sessions = await getPlexSessions(this.currentUrl, this.currentToken);
          if (sessions.some((s) => s.sessionKey === sessionKey)) return;
        } catch (err) {
          // Network blip cross-checking — fall through and finalize. Real stops
          // should win over transient errors; the 1h ledger entry below
          // prevents a racey reappearance from recreating the row.
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[plex-events] cross-check failed for ${id}: ${msg}`);
        }
      }

      markPlexSessionFinalized(id);

      const now = new Date();
      const finalized = applyFinalTick(existing, now, {
        ...(viewOffset != null && Number.isFinite(viewOffset) && viewOffset >= 0
          ? { progressMs: BigInt(Math.floor(viewOffset)) }
          : {}),
      });

      await recordCompletedSession(finalized, { stoppedAt: now });

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

// Report whether the local Plex server is reachable. Called by the 5s poller:
// true after a successful getPlexSessions(), false when it throws. Deduped +
// SSE-broadcast inside the manager so the UI's reachability badge tracks actual
// local connectivity rather than plex.tv remote-access status.
export function setPlexReachable(reachable: boolean): Promise<void> {
  return manager.persistReachability(reachable);
}
