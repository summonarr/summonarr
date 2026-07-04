"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

// Returns false during SSR and the first client render, true after hydration.
// Gate render-time Date.now()/new Date() reads on this to avoid #418 hydration
// mismatches (CLAUDE.md guardrail 16).
export function useHasMounted(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
