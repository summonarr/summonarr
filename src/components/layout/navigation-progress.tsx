"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

// A started bar hides itself after this long if no URL change ever arrives. A
// cancelled navigation, a failed RSC fetch or a link that resolves to the page
// you are already on commits nothing, and without this the bar would sit pinned
// at 85% until the next navigation happened to complete it.
const STALL_TIMEOUT_MS = 8000;

export function NavigationProgress() {
  const pathname = usePathname();
  // Completion was keyed on pathname ALONE, so a query-only navigation (a filter
  // change, a tab switch) never completed the bar. Almost every filter surface in
  // this app pushes exactly that shape, so it sat pinned across the viewport
  // until the user navigated to a different path. Track the full URL.
  const searchParams = useSearchParams();
  const url = `${pathname}?${searchParams.toString()}`;
  const [width, setWidth] = useState(0);
  const [visible, setVisible] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stallRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Holds the complete/hide timeouts scheduled by the URL-change effect so a NEW
  // navigation can cancel them. They used to be effect-local consts the start
  // path could never reach, so a stale hide-timeout from the previous navigation
  // fired mid-way through the next one and blanked the bar.
  const completionTimeouts = useRef<ReturnType<typeof setTimeout>[]>([]);
  // Seeded with the mount URL so the completion effect does not run on mount.
  const prevUrl = useRef(url);

  const clearCompletionTimeouts = () => {
    for (const id of completionTimeouts.current) clearTimeout(id);
    completionTimeouts.current = [];
  };

  const stop = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (stallRef.current) {
      clearTimeout(stallRef.current);
      stallRef.current = null;
    }
  }, []);

  const start = useCallback(() => {
    stop();
    clearCompletionTimeouts();
    setVisible(true);
    setWidth(0);

    let w = 0;
    intervalRef.current = setInterval(() => {
      w = Math.min(w + Math.random() * 8 + 4, 85);
      setWidth(w);
      if (w >= 85 && intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }, 150);

    stallRef.current = setTimeout(() => {
      stop();
      setVisible(false);
      setWidth(0);
    }, STALL_TIMEOUT_MS);
  }, [stop]);

  // Navigation START.
  //
  // This used to monkey-patch history.pushState, which cannot work: the App
  // Router calls pushState from a useInsertionEffect keyed on the router state,
  // i.e. in the commit that ALREADY carries the new URL — the same commit in
  // which usePathname()/useSearchParams() below return that URL. Start and
  // completion therefore fired together and the bar only ever flashed 0→100
  // AFTER the navigation, never during the fetch it exists to cover.
  //
  // A capture-phase click listener runs before the router handles the event, so
  // it is the earliest signal available without wrapping every Link. Known gap:
  // a programmatic router.push (the header search, for one) starts no bar. Next
  // exposes Link's onNavigate and useLinkStatus for per-link pending state, but
  // neither reaches a single global bar; wrap those call sites if the coverage
  // matters more than the indirection.
  useEffect(() => {
    const onDocumentClick = (e: MouseEvent) => {
      // Anything the browser will not treat as a plain in-page navigation:
      // already handled, non-primary button, or a modifier that opens a new tab.
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;

      const anchor = e.target instanceof Element ? e.target.closest("a") : null;
      // instanceof, not a truthiness check: closest("a") also matches an SVG
      // anchor, whose href is an SVGAnimatedString rather than a URL string.
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.hasAttribute("download")) return;
      const target = anchor.getAttribute("target");
      if (target && target !== "_self") return;
      if (!anchor.getAttribute("href")) return;

      let next: URL;
      try {
        next = new URL(anchor.href, window.location.href);
      } catch {
        return;
      }
      // A different origin leaves the app entirely, and a same-URL or hash-only
      // link commits no router navigation — in both cases the completion effect
      // would never fire and the bar would ride its stall timeout for nothing.
      if (next.origin !== window.location.origin) return;
      if (next.href === window.location.href) return;
      if (
        next.pathname === window.location.pathname &&
        next.search === window.location.search
      ) {
        return;
      }

      start();
    };

    document.addEventListener("click", onDocumentClick, true);
    // Back/forward: the URL changes with no click to observe.
    window.addEventListener("popstate", start);
    return () => {
      document.removeEventListener("click", onDocumentClick, true);
      window.removeEventListener("popstate", start);
    };
  }, [start]);

  // Navigation COMPLETE — the new URL is live in this commit.
  useEffect(() => {
    if (url === prevUrl.current) return;
    prevUrl.current = url;

    stop();

    const completeId = setTimeout(() => setWidth(100), 0);
    const hideId = setTimeout(() => {
      setVisible(false);
      setWidth(0);
    }, 300);
    completionTimeouts.current = [completeId, hideId];

    return () => {
      clearTimeout(completeId);
      clearTimeout(hideId);
    };
  }, [url, stop]);

  // Unmount: drop every timer this component owns.
  useEffect(() => {
    return () => {
      stop();
      clearCompletionTimeouts();
    };
  }, [stop]);

  if (!visible) return null;

  return (
    <div
      className="fixed top-0 left-0 z-[200] h-0.5 bg-indigo-500 transition-[width] duration-200 ease-out pointer-events-none"
      style={{
        width: `${width}%`,
        boxShadow: "0 0 8px 0 rgba(99,102,241,0.6)",
      }}
    />
  );
}
