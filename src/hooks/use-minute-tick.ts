"use client";

import { useSyncExternalStore } from "react";

// Re-renders the calling component once a minute, so mounted-gated relative
// times ("2 minutes ago") keep up on a page left open. It never reads the
// clock itself: the ticker only bumps a counter, and the caller's own
// mounted-gated formatter reads the time on the re-render (guardrail 16).
//
// ONE ticker serves every mounted caller, so every relative time on the page
// turns over together instead of each from its own mount time. It is paused
// while the tab is hidden; on return it ticks at once and restarts.

const listeners = new Set<() => void>();
let tick = 0;
let id: ReturnType<typeof setInterval> | null = null;

function emit(): void {
  tick += 1;
  for (const l of listeners) l();
}

function isHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function stop(): void {
  if (id !== null) clearInterval(id);
  id = null;
}

// Running exactly while someone listens and the tab is visible.
function sync(): void {
  if (listeners.size === 0 || isHidden()) stop();
  else if (id === null) id = setInterval(emit, 60_000);
}

function onVisibilityChange(): void {
  if (isHidden()) {
    stop();
    return;
  }
  // Back from the background: catch up now, then a fresh minute from here.
  stop();
  emit();
  sync();
}

function subscribe(onTick: () => void): () => void {
  listeners.add(onTick);
  if (listeners.size === 1 && typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange);
  }
  sync();
  return () => {
    listeners.delete(onTick);
    if (listeners.size === 0 && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
    sync();
  };
}

const getSnapshot = () => tick;
const getServerSnapshot = () => 0;

export function useMinuteTick(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
