"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useLiveEvents } from "@/hooks/use-live-events";
import type { LiveEvent } from "@/hooks/use-live-events";

export function LiveRefresh({ on }: { on: Array<LiveEvent["type"]> }) {
  const router = useRouter();
  // Debounced ~500ms so an event burst (a sync flipping several requests at
  // once) coalesces into one refresh — mirrors activity-live-refresher.tsx.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useLiveEvents((event) => {
    if (!(on as string[]).includes(event.type)) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => router.refresh(), 500);
  });

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return null;
}
