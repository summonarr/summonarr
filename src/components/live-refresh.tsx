"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useLiveEvents } from "@/hooks/use-live-events";
import type { LiveEvent } from "@/hooks/use-live-events";

export function LiveRefresh({
  on,
  updatedStatuses,
}: {
  on: Array<LiveEvent["type"]>;
  /** Narrows `request:updated` to these statuses. /for-you drops every title
      the viewer has a PENDING/APPROVED request for, so refreshing on the
      viewer's own request:new (or its APPROVED follow-up) pulled the card they
      had just requested out from under the cursor. Omitted = every status. */
  updatedStatuses?: string[];
}) {
  const router = useRouter();
  // Debounced ~500ms so an event burst (a sync flipping several requests at
  // once) coalesces into one refresh — mirrors activity-live-refresher.tsx.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useLiveEvents((event) => {
    if (!(on as string[]).includes(event.type)) return;
    if (
      event.type === "request:updated" &&
      updatedStatuses &&
      !updatedStatuses.includes(event.status)
    ) {
      return;
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => router.refresh(), 500);
  });

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return null;
}
