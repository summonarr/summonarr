"use client";

import { useRouter } from "next/navigation";
import { useLiveEvents } from "@/hooks/use-live-events";
import type { LiveEvent } from "@/hooks/use-live-events";

export function LiveRefresh({ on }: { on: Array<LiveEvent["type"]> }) {
  const router = useRouter();
  useLiveEvents((event) => {
    if ((on as string[]).includes(event.type)) {
      router.refresh();
    }
  });
  return null;
}
