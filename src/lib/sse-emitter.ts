import { EventEmitter } from "events";

declare global {
  // eslint-disable-next-line no-var
  var __sseEmitter: EventEmitter | undefined;
}

// Persist the emitter on globalThis so Next.js hot-reloads don't create a new instance and drop live SSE connections
const emitter: EventEmitter = globalThis.__sseEmitter ?? new EventEmitter();
// One listener per open SSE connection — 500 covers a heavily multi-tabbed admin without MaxListenersExceededWarning
emitter.setMaxListeners(500);
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

  | { type: "activity:sessions"; sessions: unknown[] };

export function emitSSE(event: SSEEvent) {
  emitter.emit("event", event);
}
