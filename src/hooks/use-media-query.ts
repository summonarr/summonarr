"use client";

import { useCallback, useSyncExternalStore } from "react";

const getServerSnapshot = () => null;

// Returns whether `query` currently matches, or `null` during SSR and the
// hydration render. The null pass keeps the server HTML and the first client
// render identical (CLAUDE.md guardrail 16 — a viewport-dependent boolean is as
// nondeterministic across the two passes as a Date read), so callers must treat
// null as "not yet known" rather than as false. After hydration the value
// tracks the MediaQueryList's "change" event.
export function useMediaQuery(query: string): boolean | null {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
        return () => {};
      }
      const mq = window.matchMedia(query);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    [query],
  );
  const getSnapshot = useCallback(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return null;
    }
    return window.matchMedia(query).matches;
  }, [query]);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
