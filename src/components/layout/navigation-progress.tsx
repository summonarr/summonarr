"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

export function NavigationProgress() {
  const pathname = usePathname();
  const [width, setWidth] = useState(0);
  const [visible, setVisible] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevPathname = useRef(pathname);

  useEffect(() => {
    // Monkey-patch history.pushState because Next.js App Router doesn't expose navigation start events
    const original = window.history.pushState.bind(window.history);

    window.history.pushState = function (...args: Parameters<typeof window.history.pushState>) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);

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
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (pathname === prevPathname.current) return;
    prevPathname.current = pathname;

    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    setWidth(100);

    timeoutRef.current = setTimeout(() => {
      setVisible(false);
      setWidth(0);
    }, 300);

    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [pathname]);

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
