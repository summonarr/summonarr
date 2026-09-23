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
  // Track the full URL (path + query), not just the path: most filters and
  // tabs in this app only change the query string, and those navigations must
  // complete the bar too.
  const searchParams = useSearchParams();
  const url = `${pathname}?${searchParams.toString()}`;
  const [width, setWidth] = useState(0);
  const [visible, setVisible] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stallRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The complete/hide timeouts scheduled by the URL-change effect. Kept in a
  // ref so a NEW navigation can cancel them; otherwise the previous
  // navigation's hide timer could fire mid-way through the next one.
  const completionTimeouts = useRef<ReturnType<typeof setTimeout>[]>([]);
  // Seeded with the mount URL so the completion effect does not run on mount.
  const prevUrl = useRef(url);
  // window.location's path + query as of the last committed navigation. Lets
  // a popstate (Back/Forward) that only moves between `#hash` entries — like
  // the settings side-nav's anchor links — be ignored, since no page load
  // follows it. Read in effects only (guardrail 16).
  const committedLocation = useRef<string | null>(null);

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
  // We listen for link clicks in the capture phase (before the router sees
  // the click), which is the earliest moment we can learn a navigation began.
  // Watching history.pushState does NOT work: the App Router only calls it
  // once the new URL is already committed, so the bar would start and finish
  // at the same instant.
  //
  // Known gap: a programmatic router.push (the header search, for one) is not
  // a click, so it starts no bar.
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

    // Back/forward: the URL changes with no click to observe. A hash-only
    // entry change commits no router navigation, so it must not start the bar
    // (same reasoning as the hash-only click guard above).
    const onPopState = () => {
      const here = window.location.pathname + window.location.search;
      if (committedLocation.current !== null && here === committedLocation.current) return;
      start();
    };

    committedLocation.current = window.location.pathname + window.location.search;
    document.addEventListener("click", onDocumentClick, true);
    window.addEventListener("popstate", onPopState);
    return () => {
      document.removeEventListener("click", onDocumentClick, true);
      window.removeEventListener("popstate", onPopState);
    };
  }, [start]);

  // Navigation COMPLETE — the new URL is live in this commit.
  useEffect(() => {
    if (url === prevUrl.current) return;
    prevUrl.current = url;
    committedLocation.current = window.location.pathname + window.location.search;

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
        // Glow follows the accent (bg-indigo-500 is token-mapped to it).
        boxShadow: "0 0 8px 0 color-mix(in oklab, var(--ds-accent) 60%, transparent)",
      }}
    />
  );
}
