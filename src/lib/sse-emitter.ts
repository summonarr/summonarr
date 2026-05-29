import { EventEmitter } from "events";

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
  | { type: "issue:new"; issueId: string; userId: string }
  | { type: "issue:updated"; issueId: string; status: string; userId: string }
  | { type: "issue:deleted"; issueId: string; userId: string }
  | { type: "issuemessage:created"; issueId: string; userId: string }

  | { type: "activity:sessions"; sessions: unknown[] }
  | { type: "activity:history-updated" }
  // Emitted by plex-events.ts when Plex's ReachabilityNotification flips. The
  // current value is also persisted in Setting('plexServerReachable') for the
  // initial page render; this event drives live updates without polling.
  | { type: "plex:reachability"; reachable: boolean };

export function emitSSE(event: SSEEvent) {
  emitter.emit("event", event);
}
