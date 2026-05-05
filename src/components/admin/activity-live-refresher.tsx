"use client";

import { useRef } from "react";
import { useRouter } from "next/navigation";
import { useLiveEvents } from "@/hooks/use-live-events";

// Calls router.refresh() when a play history record is written so the stats
// cards, leaderboard, and recent-plays table reflect the new data.
// Debounced 1 s so a batch of simultaneous completions triggers one reload.
export function ActivityLiveRefresher() {
  const router = useRouter();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useLiveEvents((event) => {
    if (event.type !== "activity:history-updated") return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => router.refresh(), 1_000);
  });

  return null;
}
