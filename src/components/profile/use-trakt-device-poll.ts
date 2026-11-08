"use client";

import { useEffect, useRef } from "react";
import { withBasePath } from "@/lib/base-path";
import { fetchJson } from "@/lib/client/fetch-json";
import { backoffSeconds, readPollAnswer, type PollStep } from "./trakt-device-poll";

// The terminal outcomes of a poll run; "pending" and "backoff" are handled here.
export type PollEnd = Exclude<PollStep, { kind: "pending" } | { kind: "backoff" }>;

// The Trakt device-code poll loop (trakt-connect.tsx): one tracked timer, a
// generation that every stop bumps, and the code's remaining lifetime.
//
// - A poll request already in flight when the user cancels (or the page goes)
//   would otherwise resume afterwards, reschedule itself and keep polling (and
//   report "expired") for a flow the user abandoned: its answer is dropped when
//   the generation moved on, and the request itself is aborted.
// - Nothing is scheduled once the component has unmounted, including by a
//   start request that resolves after it (`begin` is then a no-op).
// - The lifetime is COUNTED, never a clock (guardrail 16's lesson): each
//   scheduled wait is spent from it, so the last poll lands on the expiry and
//   reports "expired". Request time isn't counted, so the run can end a little
//   after the real expiry — Trakt then answers "expired" itself.
export function useTraktDevicePoll(onEnd: (step: PollEnd) => void) {
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollGen = useRef(0);
  const inFlight = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  // The pending code's server-given poll interval (seconds) and how much of
  // its lifetime (ms) the scheduled polls have not yet used.
  const baseInterval = useRef(5);
  const pollBudgetMs = useRef(0);
  const onEndRef = useRef(onEnd);

  useEffect(() => {
    onEndRef.current = onEnd;
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stopPolling();
    };
  }, []);

  function stopPolling() {
    pollGen.current += 1;
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = null;
    inFlight.current?.abort();
    inFlight.current = null;
  }

  function schedulePoll(intervalSeconds: number) {
    stopPolling();
    if (!mounted.current) return;
    const gen = pollGen.current;
    // Never wait past the code's expiry: the last poll lands on it and reports.
    const delayMs = Math.min(Math.max(intervalSeconds, 2) * 1000, Math.max(pollBudgetMs.current, 0));
    pollBudgetMs.current -= delayMs;
    pollTimer.current = setTimeout(() => void poll(intervalSeconds, gen), delayMs);
  }

  async function poll(intervalSeconds: number, gen: number) {
    if (pollBudgetMs.current <= 0) {
      onEndRef.current({ kind: "expired" });
      return;
    }
    const controller = new AbortController();
    inFlight.current = controller;
    const res = await fetchJson(withBasePath("/api/profile/trakt/device/poll"), {
      init: { method: "POST" },
      signal: controller.signal,
    });
    if (pollGen.current !== gen) return;
    inFlight.current = null;
    const step = readPollAnswer(res.status, res.ok ? res.data : res.body);
    switch (step.kind) {
      case "backoff":
        schedulePoll(backoffSeconds(intervalSeconds));
        return;
      case "pending":
        schedulePoll(baseInterval.current);
        return;
      default:
        onEndRef.current(step);
    }
  }

  /** Starts polling a new code. A no-op once the component has unmounted. */
  function begin(intervalSeconds: number, expiresInSeconds: number) {
    if (!mounted.current) return;
    baseInterval.current = intervalSeconds;
    pollBudgetMs.current = expiresInSeconds * 1000;
    schedulePoll(intervalSeconds);
  }

  /** False once the component has unmounted: a late answer applies nothing. */
  function alive() {
    return mounted.current;
  }

  return { begin, stop: stopPolling, alive };
}
