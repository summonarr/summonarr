import { EventEmitter } from "events";
import type { ActiveSessionLive } from "@/lib/live-event-frames";

declare global {
  var __sseEmitter: EventEmitter | undefined;
}

// Persist the emitter on globalThis so Next.js hot-reloads don't create a new instance and drop live SSE connections
const emitter: EventEmitter = globalThis.__sseEmitter ?? new EventEmitter();

// One "event" listener is registered per open SSE connection (see
// /api/events), so this value also bounds the concurrent-connection cap in
// that route — they must move together or Node emits MaxListenersExceededWarning.
// Tunable via SSE_MAX_LISTENERS for large deployments; default 500 covers a
// heavily multi-tabbed admin. Invalid/non-positive values fall back to 500.
const parsedMax = parseInt(process.env.SSE_MAX_LISTENERS ?? "", 10);
export const SSE_MAX_LISTENERS =
  Number.isInteger(parsedMax) && parsedMax > 0 ? parsedMax : 500;

emitter.setMaxListeners(SSE_MAX_LISTENERS);
globalThis.__sseEmitter = emitter;

export const sseEmitter = emitter;

export type SSEEvent =
  | { type: "request:new"; requestId: string; userId: string }
  | { type: "request:updated"; requestId: string; status: string; userId: string }
  | { type: "request:deleted"; requestId: string; userId: string }
  // Named request:* on purpose: the /api/events delivery rule keys on that prefix, so the
  // requester (userId match) and every MANAGE_REQUESTS holder get it and nobody else.
  | { type: "request:comment"; requestId: string; userId: string }
  | { type: "issue:new"; issueId: string; userId: string }
  | { type: "issue:updated"; issueId: string; status: string; userId: string }
  | { type: "issue:deleted"; issueId: string; userId: string }
  // `messageId`: the new message, so a client that already shows it (its own
  // send) skips the re-read.
  | { type: "issuemessage:created"; issueId: string; messageId: string; userId: string }

  // The same session shape the browser checks each frame against
  // (live-event-frames.ts), so the server and client unions can't drift.
  | { type: "activity:sessions"; sessions: ActiveSessionLive[] }
  | { type: "activity:history-updated" }
  // Emitted by plex-events.ts when local reachability flips for ONE server. The
  // current value is also persisted in Setting(plexSettingKey(instance,
  // "ServerReachable")) for the initial page render; this event drives live
  // updates without polling. `instance` is the server's slug — "" for the
  // default, so a single-server deployment sees the same event shape it always
  // did plus one additive field.
  | { type: "plex:reachability"; reachable: boolean; instance: string }
  // The admin nav's arr badges (href → count, `{}` for none), pushed when a
  // Radarr/Sonarr monitor run stores a new summary — the same value GET
  // /api/admin/arr-watch answers in `navBadges`. Admins only.
  | { type: "nav:badges"; badges: Record<string, number> };

export function emitSSE(event: SSEEvent) {
  // Listeners run synchronously: one stream's failing listener must not surface
  // in the route that emitted the event, often after its write has committed.
  try {
    emitter.emit("event", event);
  } catch (err) {
    console.error(`[sse] listener threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}
