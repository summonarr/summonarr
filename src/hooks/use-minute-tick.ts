"use client";

import { useEffect, useState } from "react";

// Re-renders the calling component once a minute, so mounted-gated relative
// times ("2 minutes ago") keep up on a page left open. It never reads the
// clock itself: the interval only bumps a counter, and the caller's own
// mounted-gated formatter reads the time on the re-render (guardrail 16).
export function useMinuteTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);
  return tick;
}
