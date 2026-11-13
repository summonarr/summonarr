"use client";

import { useEffect, useRef } from "react";
import { withBasePath } from "@/lib/base-path";
import { parseLiveEvent, type LiveEvent } from "@/lib/live-event-frames";

// The frame types and their runtime check live in one browser-safe module
// (src/lib/live-event-frames.ts); re-exported so consumers keep this import.
export type { ActiveSessionLive, LiveEvent } from "@/lib/live-event-frames";

type Subscriber = (event: LiveEvent) => void;
// Module-level singleton: a single SSE connection is shared across all useLiveEvents consumers
const subscribers = new Set<Subscriber>();
// Called when the stream is back after a drop. The stream carries no event
// ids, so whatever was emitted during the gap is gone for good (the server
// also recycles the stream on a schedule): a consumer that shows server data
// re-reads it here. Never called for the first connect.
const reconnectSubscribers = new Set<() => void>();
// True from a connection error until the server's next "connected" frame.
let dropped = false;
let singleton: EventSource | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
// Probe cadence after a PERMANENT EventSource failure (readyState CLOSED — the
// browser gave up, e.g. a 401 once the session expired mid-stream). One cheap
// request per interval while the tab stays open; live updates resume within one
// interval of re-authenticating.
// The interval doubles per consecutive permanent failure up to the cap, with
// jitter, so open tabs don't probe a failing endpoint in lockstep; any frame
// from the stream resets it.
const PERMANENT_FAILURE_RETRY_MS = 30_000;
const PERMANENT_FAILURE_RETRY_MAX_MS = 5 * 60_000;
let failureStreak = 0;

// Every subscriber gets the event even when an earlier one throws: one broken
// consumer must not starve the others, or the lifecycle code after a dispatch.
function dispatch(event: LiveEvent): void {
  for (const sub of subscribers) {
    try {
      sub(event);
    } catch (err) {
      console.error("[live-events] subscriber failed:", err);
    }
  }
}

function ensureEventSource() {
  if (singleton) return;
  // SSE reconnects automatically on error; do not replace with WebSocket
  const es = new EventSource(withBasePath("/api/events"));
  es.onmessage = (e: MessageEvent) => {
    failureStreak = 0;
    const event = typeof e.data === "string" ? parseLiveEvent(e.data) : null;
    // A frame this client doesn't know (or a malformed one) is dropped.
    if (!event) return;
    dispatch(event);
    if (event.type === "connected" && dropped) {
      dropped = false;
      for (const sub of reconnectSubscribers) {
        try {
          sub();
        } catch (err) {
          console.error("[live-events] reconnect subscriber failed:", err);
        }
      }
    }
  };
  es.onerror = () => {
    // CONNECTING → the browser is auto-retrying a transient drop; nothing to do.
    // CLOSED → permanent failure (an HTTP-error/wrong-MIME reconnect — e.g. the
    // server tore the stream down at the reauth tick and the reconnect got a
    // 401). The browser will NEVER retry on its own, and a dead singleton would
    // make ensureEventSource() a no-op forever — live updates gone until a full
    // page reload. Drop the singleton and re-probe on a timer so a
    // re-authenticated session picks the stream back up. The lifecycle runs
    // BEFORE the subscribers hear about it, so none of them can stop the reset.
    if (es.readyState === EventSource.CLOSED) {
      es.close();
      if (singleton === es) singleton = null;
      if (retryTimer === null && subscribers.size > 0) {
        console.warn("[live-events] SSE connection closed permanently; will re-probe");
        const base = Math.min(PERMANENT_FAILURE_RETRY_MS * 2 ** failureStreak, PERMANENT_FAILURE_RETRY_MAX_MS);
        failureStreak += 1;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          if (subscribers.size > 0) ensureEventSource();
        }, base * (0.75 + Math.random() * 0.5));
      }
    } else {
      console.warn("[live-events] SSE connection error, browser will retry");
    }
    dropped = true;
    dispatch({ type: "disconnected" });
  };
  singleton = es;
}

function teardownEventSource() {
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  // The next subscriber opens a fresh stream: its first frame is a first connect.
  dropped = false;
  if (!singleton) return;
  singleton.close();
  singleton = null;
}

export interface LiveEventsOptions {
  /**
   * Runs once each time the stream comes back after a drop — never on the
   * first connect. Events emitted during the gap were lost, so re-read here.
   */
  onReconnect?: () => void;
}

// Subscribes onEvent to the shared SSE stream, opening the single connection on
// first subscriber and tearing it down when the last one unmounts.
export function useLiveEvents(onEvent: (event: LiveEvent) => void, options?: LiveEventsOptions) {
  // Ref keeps the callback stable so the effect doesn't re-run when the parent re-renders
  const onEventRef = useRef(onEvent);
  const onReconnectRef = useRef(options?.onReconnect);
  // Update ref after each render so the subscriber always calls the latest onEvent
  useEffect(() => {
    onEventRef.current = onEvent;
    onReconnectRef.current = options?.onReconnect;
  });

  useEffect(() => {
    const sub: Subscriber = (event) => onEventRef.current(event);
    const reconnectSub = () => onReconnectRef.current?.();
    subscribers.add(sub);
    reconnectSubscribers.add(reconnectSub);
    ensureEventSource();
    // The server sends its one-shot {type:"connected"} only at stream open, so a
    // subscriber joining an already-open singleton (opened long ago by an
    // always-mounted consumer like the header bell) would never see it and any
    // connection indicator would read "Connecting…" until the stream recycles.
    // Synthesize it for late joiners.
    if (singleton && singleton.readyState === EventSource.OPEN) {
      sub({ type: "connected" });
    }
    return () => {
      subscribers.delete(sub);
      reconnectSubscribers.delete(reconnectSub);
      if (subscribers.size === 0) teardownEventSource();
    };
  }, []);
}
