"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";

const getServerSnapshot = () => null;

// Returns whether `query` currently matches, or `null` during SSR and the
// hydration render. The null pass keeps the server HTML and the first client
// render identical (CLAUDE.md guardrail 16 — a viewport-dependent boolean is as
// nondeterministic across the two passes as a Date read), so callers must treat
// null as "not yet known" rather than as false. After hydration the value
// tracks the MediaQueryList's "change" event. One MediaQueryList per query
// serves both the subscription and every snapshot read.
export function useMediaQuery(query: string): boolean | null {
  const mq = useMemo(
    () => (typeof window === "undefined" || typeof window.matchMedia !== "function" ? null : window.matchMedia(query)),
    [query],
  );
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!mq) return () => {};
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    [mq],
  );
  const getSnapshot = useCallback(() => (mq ? mq.matches : null), [mq]);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
