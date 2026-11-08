"use client";

import { useCallback, useState } from "react";
import { useDelayed } from "@/hooks/use-delayed";
import { useAsyncAction } from "@/hooks/use-async-action";
import type { FetchJsonResult } from "@/lib/client/fetch-json";
import type { ActionState, ApplyResult, RunError } from "./types";

/** Why a run ran nothing: the trash lock was held, or TRaSH is off on the server. */
export type RunSkip = "running" | "disabled";

// The one state machine behind the TRaSH cards' long actions — Refresh
// Catalog, Apply (spec tabs and the starter pack) and Sync Now:
//
// - `running` while the request is out; a second click while it is does nothing.
// - A SKIP (409, or the cron's skip) ran nothing, so it is neither a success
//   nor a failure: an amber note that clears itself.
// - A success clears after 3 s; an error stays until dismissed or the next run,
//   so a 409/429 reason that vanished after 3 s can't leave no trace.
// - One timer per message, cancelled when the run starts again: an earlier
//   run's reset re-enabled the button in the middle of the next one, and a
//   reset only ever moves its own state ("ok") back to idle.
// - Leaving the page drops the request (useAsyncAction): `request` resolves
//   undefined and the card applies nothing.
export function useTrashRun() {
  const [state, setState] = useState<ActionState>("idle");
  const [skipped, setSkipped] = useState<RunSkip | null>(null);
  const [error, setError] = useState<RunError | null>(null);
  const [log, setLog] = useState<ApplyResult[]>([]);
  const laterState = useDelayed();
  const laterSkipped = useDelayed();
  const action = useAsyncAction();

  const begin = useCallback(() => {
    laterState.cancel();
    laterSkipped.cancel();
    setState("running");
    setSkipped(null);
    setError(null);
    setLog([]);
  }, [laterState, laterSkipped]);

  /** The run's one request; undefined when it was dropped (a run already out, or the card unmounted). */
  const request = useCallback(
    <T,>(send: (signal: AbortSignal) => Promise<FetchJsonResult<T>>) => action.run("run", send, { ifBusy: "skip" }),
    [action],
  );

  const skip = useCallback((reason: RunSkip, clearAfterMs = 3000) => {
    setState("idle");
    setSkipped(reason);
    laterSkipped(() => setSkipped(null), clearAfterMs);
  }, [laterSkipped]);

  /** The route answered: failed or not, the banner's errors (if any) and the apply log to show. */
  const done = useCallback((failed: boolean, runError: RunError | null, runLog: ApplyResult[] = []) => {
    setState(failed ? "error" : "ok");
    setError(runError);
    setLog(runLog);
    laterState(() => setState((s) => (s === "ok" ? "idle" : s)), 3000);
  }, [laterState]);

  /** No answer came (the request failed, or a proxy's own error page). */
  const fail = useCallback((message: string) => {
    setState("error");
    setError({ errors: [message] });
  }, []);

  // The inline failure note goes once the run's banner and log are both gone.
  const dismissError = useCallback(() => {
    setError(null);
    if (log.length === 0) setState((s) => (s === "error" ? "idle" : s));
  }, [log.length]);
  const dismissLog = useCallback(() => {
    setLog([]);
    if (!error) setState((s) => (s === "error" ? "idle" : s));
  }, [error]);
  /** An inline note's own Dismiss: the note and its reason go; the apply log stays. */
  const dismissStatus = useCallback(() => {
    setError(null);
    setState((s) => (s === "error" ? "idle" : s));
  }, []);

  return {
    state,
    running: state === "running",
    /** A run's request is out (live, unlike `running` read from a render's closure). */
    busy: () => action.busy("run"),
    skipped,
    error,
    log,
    begin,
    request,
    skip,
    done,
    fail,
    dismissError,
    dismissLog,
    dismissStatus,
  };
}

export type TrashRun = ReturnType<typeof useTrashRun>;
