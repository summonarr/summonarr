"use client";

// The life cycle the library page's sync buttons share (Resync libraries, Sync
// episodes): idle → loading → done/error, a result line that clears after
// SYNC_RESULT_CLEAR_MS, and a refresh of the page's counts when a run rewrote
// something.
//
// Both runs can outlast the page: an admin who navigates away mid-run must not
// be touched by its end. `finish` applies nothing once the button has
// unmounted — the app router outlives it, so a late refresh (or the old
// router.push of the click-time URL) would act on whatever page they moved to.
// The page reloads with router.refresh(): pushing the same URL again stacked a
// duplicate history entry per run, so Back seemed to do nothing.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useDelayed } from "@/hooks/use-delayed";

export type SyncButtonStatus = "idle" | "confirm" | "loading" | "done" | "error";

export const SYNC_RESULT_CLEAR_MS = 10_000;

export function useSyncButtonState() {
  const router = useRouter();
  const [status, setStatus] = useState<SyncButtonStatus>("idle");
  const [result, setResult] = useState<string | null>(null);
  // Cancelled when a run starts: a previous run's reset landing mid-run flipped
  // "loading" back to "idle" and re-enabled the button during the rebuild.
  const later = useDelayed();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const isAlive = useCallback(() => alive.current, []);

  /** Opens an inline confirm; the previous run's line goes with it, so Cancel never brings it back untimed. */
  const confirm = useCallback(() => {
    later.cancel();
    setResult(null);
    setStatus("confirm");
  }, [later]);

  const cancel = useCallback(() => setStatus("idle"), []);

  const begin = useCallback(() => {
    later.cancel();
    setStatus("loading");
    setResult(null);
  }, [later]);

  const finish = useCallback((next: "done" | "error", text: string, refresh: boolean) => {
    if (!alive.current) return;
    setStatus(next);
    setResult(text);
    if (refresh) router.refresh();
    later(() => {
      setStatus("idle");
      setResult(null);
    }, SYNC_RESULT_CLEAR_MS);
  }, [later, router]);

  return { status, result, isAlive, confirm, cancel, begin, finish };
}

/** The run's result beside its button: an alert when it failed, a polite status otherwise. */
export function SyncResultText({ status, result }: { status: SyncButtonStatus; result: string | null }) {
  if (!result) return null;
  const failed = status === "error";
  return (
    <span
      role={failed ? "alert" : "status"}
      aria-live={failed ? "assertive" : "polite"}
      className={`text-xs ${failed ? "text-red-400" : "text-zinc-400"}`}
    >
      {result}
    </span>
  );
}
