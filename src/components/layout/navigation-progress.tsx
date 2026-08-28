"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

export function NavigationProgress() {
  const pathname = usePathname();
  // The bar starts on any pushState, but completion was keyed on pathname
  // ALONE — so a query-only navigation (a filter change, a tab switch) never
  // completed it. Almost every filter surface in this app pushes exactly
  // that shape, so the bar sat pinned at ~85% across the viewport until the
  // user happened to navigate to a different path. Track the full URL.
  const searchParams = useSearchParams();
  const url = `${pathname}?${searchParams.toString()}`;
  const [width, setWidth] = useState(0);
  const [visible, setVisible] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Holds the complete/hide timeouts scheduled by the URL-change effect so a
  // NEW pushState can cancel them. They used to be effect-local consts the
  // pushState patch could never reach, so a stale hide-timeout from the
  // previous navigation would fire mid-way through the next one and blank the
  // bar until yet another navigation.
  const completionTimeouts = useRef<ReturnType<typeof setTimeout>[]>([]);
  const prevPathname = useRef(pathname);

  const clearCompletionTimeouts = () => {
    for (const id of completionTimeouts.current) clearTimeout(id);
    completionTimeouts.current = [];
  };

  useEffect(() => {
    // Monkey-patch history.pushState because Next.js App Router doesn't expose navigation start events
    const original = window.history.pushState.bind(window.history);

    window.history.pushState = function (...args: Parameters<typeof window.history.pushState>) {
      if (intervalRef.current) clearInterval(intervalRef.current);
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

      return original(...args);
    };

    return () => {
      window.history.pushState = original;
    };
  }, []);

  useEffect(() => {
    if (url === prevPathname.current) return;
    prevPathname.current = url;

    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

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
  }, [url]);

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
