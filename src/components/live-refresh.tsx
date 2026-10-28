"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useLiveEvents } from "@/hooks/use-live-events";
import type { LiveEvent } from "@/hooks/use-live-events";
import { cancelPageRefresh, requestPageRefresh } from "@/lib/client/refresh-hold";

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

  useLiveEvents((event) => {
    if (!(on as string[]).includes(event.type)) return;
    if (
      event.type === "request:updated" &&
      updatedStatuses &&
      !updatedStatuses.includes(event.status)
    ) {
      return;
    }
    // Debounced ~500ms so an event burst (a sync flipping several requests at
    // once) coalesces into one refresh — and through the page's ONE refresh
    // timer (refresh-hold.ts), so the event announcing a button's own change
    // joins the refresh that button asked for instead of adding a second.
    // Deferred while a dialog holds the page: the refresh would drop an issue
    // the dialog is still showing the result for.
    requestPageRefresh(() => router.refresh());
  });

  useEffect(() => () => cancelPageRefresh(), []);

  return null;
}
