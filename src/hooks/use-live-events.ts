"use client";

import { useEffect, useRef } from "react";
import { withBasePath } from "@/lib/base-path";

export type LiveEvent =
  | { type: "connected" }
  | { type: "request:new"; requestId: string }
  | { type: "request:updated"; requestId: string; status: string }
  | { type: "request:deleted"; requestId: string }
  | { type: "issue:new"; issueId: string }
  | { type: "issue:updated"; issueId: string; status: string }
  | { type: "issue:deleted"; issueId: string }
  | { type: "issuemessage:created"; issueId: string }
  | { type: "activity:sessions"; sessions: ActiveSessionLive[] }
  | { type: "activity:history-updated" }
  | { type: "plex:reachability"; reachable: boolean };

export interface ActiveSessionLive {
  id: string;
  source: string;
  state: string;
  mediaServerUserId: string;
  serverUsername: string;
  title: string;
  tmdbId: number | null;
  mediaType: string | null;
  year: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  episodeTitle: string | null;
  progressPercent: number;
  progressMs: number;
  durationMs: number;
  startedAt: string | null;
  platform: string | null;
  player: string | null;
  device: string | null;
  ipAddress: string | null;
  playMethod: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  resolution: string | null;
  bitrate: number | null;
  videoDecision: string | null;
  audioDecision: string | null;
  container: string | null;
  posterUrl: string | null;
  // Network metadata from /status/sessions Session + Player sub-objects.
  location: string | null;
  bandwidth: number | null;
  secure: boolean | null;
  relayed: boolean | null;
  // Intro/credits marker offsets in ms, from /library/metadata?includeMarkers=1.
  introStartMs: number | null;
  introEndMs: number | null;
  creditsStartMs: number | null;
  creditsEndMs: number | null;
}

type Subscriber = (event: LiveEvent) => void;
// Module-level singleton: a single SSE connection is shared across all useLiveEvents consumers
const subscribers = new Set<Subscriber>();
let singleton: EventSource | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
// Probe cadence after a PERMANENT EventSource failure (readyState CLOSED — the
// browser gave up, e.g. a 401 once the session expired mid-stream). One cheap
// request per interval while the tab stays open; live updates resume within one
// interval of re-authenticating.
const PERMANENT_FAILURE_RETRY_MS = 30_000;

function ensureEventSource() {
  if (singleton) return;
  // SSE reconnects automatically on error; do not replace with WebSocket
  const es = new EventSource(withBasePath("/api/events"));
  es.onmessage = (e: MessageEvent) => {
    try {
      const event = JSON.parse(e.data as string) as LiveEvent;
      for (const sub of subscribers) sub(event);
    } catch {

    }
  };
  es.onerror = () => {
    // CONNECTING → the browser is auto-retrying a transient drop; nothing to do.
    // CLOSED → permanent failure (an HTTP-error/wrong-MIME reconnect — e.g. the
    // server tore the stream down at the reauth tick and the reconnect got a
    // 401). The browser will NEVER retry on its own, and a dead singleton would
    // make ensureEventSource() a no-op forever — live updates gone until a full
    // page reload. Drop the singleton and re-probe on a timer so a
    // re-authenticated session picks the stream back up.
    if (es.readyState === EventSource.CLOSED) {
      es.close();
      if (singleton === es) singleton = null;
      if (retryTimer === null && subscribers.size > 0) {
        console.warn("[live-events] SSE connection closed permanently; will re-probe");
        retryTimer = setTimeout(() => {
          retryTimer = null;
          if (subscribers.size > 0) ensureEventSource();
        }, PERMANENT_FAILURE_RETRY_MS);
      }
      return;
    }
    console.warn("[live-events] SSE connection error, browser will retry");
  };
  singleton = es;
}

function teardownEventSource() {
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (!singleton) return;
  singleton.close();
  singleton = null;
}

// Subscribes onEvent to the shared SSE stream, opening the single connection on
// first subscriber and tearing it down when the last one unmounts.
export function useLiveEvents(onEvent: (event: LiveEvent) => void) {
  // Ref keeps the callback stable so the effect doesn't re-run when the parent re-renders
  const onEventRef = useRef(onEvent);
  // Update ref after each render so the subscriber always calls the latest onEvent
  useEffect(() => { onEventRef.current = onEvent; });

  useEffect(() => {
    const sub: Subscriber = (event) => onEventRef.current(event);
    subscribers.add(sub);
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
      if (subscribers.size === 0) teardownEventSource();
    };
  }, []);
}
