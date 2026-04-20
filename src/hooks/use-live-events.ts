"use client";

import { useEffect, useRef } from "react";

export type LiveEvent =
  | { type: "connected" }
  | { type: "request:new"; requestId: string }
  | { type: "request:updated"; requestId: string; status: string }
  | { type: "request:deleted"; requestId: string }
  | { type: "issue:new"; issueId: string }
  | { type: "issue:updated"; issueId: string; status: string }
  | { type: "issue:deleted"; issueId: string }
  | { type: "issuemessage:created"; issueId: string }
  | { type: "activity:sessions"; sessions: ActiveSessionLive[] };

export interface ActiveSessionLive {
  id: string;
  source: string;
  state: string;
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
}

type Subscriber = (event: LiveEvent) => void;
// Module-level singleton: a single SSE connection is shared across all useLiveEvents consumers
const subscribers = new Set<Subscriber>();
let singleton: EventSource | null = null;

function ensureEventSource() {
  if (singleton) return;
  // SSE reconnects automatically on error; do not replace with WebSocket
  const es = new EventSource("/api/events");
  es.onmessage = (e: MessageEvent) => {
    try {
      const event = JSON.parse(e.data as string) as LiveEvent;
      for (const sub of subscribers) sub(event);
    } catch {

    }
  };
  es.onerror = () => {

    console.warn("[live-events] SSE connection error, browser will retry");
  };
  singleton = es;
}

function teardownEventSource() {
  if (!singleton) return;
  singleton.close();
  singleton = null;
}

export function useLiveEvents(onEvent: (event: LiveEvent) => void) {
  // Ref keeps the callback stable so the effect doesn't re-run when the parent re-renders
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    const sub: Subscriber = (event) => onEventRef.current(event);
    subscribers.add(sub);
    ensureEventSource();
    return () => {
      subscribers.delete(sub);
      if (subscribers.size === 0) teardownEventSource();
    };
  }, []);
}
