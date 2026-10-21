"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * `later(fn, ms)` runs `fn` after `ms`, replacing any earlier pending call and
 * cancelling it on unmount — so "clear the toast after 2s" timers never set
 * state on an unmounted component or stack up on repeat clicks.
 */
export function useDelayed(): (fn: () => void, ms: number) => void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return useCallback((fn, ms) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(fn, ms);
  }, []);
}
