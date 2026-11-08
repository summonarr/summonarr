"use client";

// Admin → Download Queue's reads (download-queue.tsx): the queue report, the
// load gate, the poll, the re-read after an action, and the snapshot painted
// on open (use-arr-snapshot.ts, guardrail 5h). The page keeps its filters,
// dialogs and actions; this decides when the queue is read and who may write
// the answer.

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/components/i18n/i18n-provider";
import { withBasePath } from "@/lib/base-path";
import type { QueueItem } from "@/lib/arr-queue";
import type { ArrErrorKind } from "@/lib/arr-error-kind";
import { createLoadGate, type LoadKind } from "@/lib/arr-system";
import { useArrSnapshot } from "@/components/admin/use-arr-snapshot";
import { readApiError } from "@/lib/client/api-error";
import { timedFetch } from "@/lib/client/fetch-json";

export type Service = "radarr" | "sonarr";

export interface QueueReport {
  instances: Array<{ service: Service; slug: string; name: string }>;
  errors: Array<{ service: Service; instance: string; error: string; kind?: ArrErrorKind }>;
  items: QueueItem[];
  // Instances whose queue ran past the server's page ceiling.
  truncated?: Array<{ service: Service; instance: string; read: number; total: number }>;
}

const POLL_MS = 20_000;
// The page's one read. The live load and its snapshot must name the SAME url,
// or the server's snapshot key misses.
const queueUrl = () => withBasePath("/api/admin/queue");

// A 200 that is not the report (an auth proxy's page, a stale deploy) is a failed
// load, never an empty queue: the three lists the page folds must be arrays.
function queueAnswer(body: unknown, error: string): { report: QueueReport } | { error: string } {
  if (body && typeof body === "object") {
    const r = body as Record<string, unknown>;
    if (Array.isArray(r.instances) && Array.isArray(r.errors) && Array.isArray(r.items)) return { report: body as QueueReport };
  }
  return { error };
}

export function useQueueData({
  configured,
  live,
  paused,
}: {
  configured: boolean;
  /** The page's Live switch: poll while it is on. */
  live: boolean;
  /** A dialog is open: no poll until it closes. */
  paused: boolean;
}) {
  const t = useT();
  const [report, setReport] = useState<QueueReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // Only the newest load may write state — a slow poll must not overwrite the
  // result of a refresh the admin clicked after it started. And a poll tick is
  // skipped while a load is out: a dark instance holds its page read for the
  // whole 30 s request timeout, past POLL_MS, and a tick that superseded it
  // would discard every answer (createLoadGate).
  const [gate] = useState(createLoadGate);
  // The snapshot only paints an EMPTY page: it never replaces rows already on
  // screen (a live answer, or a removal's optimistic drop), and leaves the
  // error, filters, selections and dialogs alone.
  const { staleAt: snapshotAt, markLive } = useArrSnapshot<QueueReport>(configured ? queueUrl() : null, (data) =>
    setReport((cur) => cur ?? data),
  );

  // Background polls that failed in a row. One is a blip beside a queue that
  // is still on screen — the next tick usually answers — so only the second in
  // a row is shown; a manual load's failure always is (the Arr System page's
  // rule).
  const pollFailures = useRef(0);
  const load = useCallback(async (kind: LoadKind = "manual") => {
    const id = gate.begin(kind);
    if (id === null) return;
    // A poll refreshes quietly: nothing spins every tick, and Refresh stays
    // enabled (a manual load supersedes the poll — createLoadGate).
    if (kind !== "poll") setLoading(true);
    let next: { report: QueueReport } | { error: string };
    try {
      const res = await timedFetch(queueUrl());
      next = res.ok ? queueAnswer(await res.json().catch(() => null), t("adminManage.queue.error.load")) : { error: await readApiError(res, t("adminManage.queue.error.load")) };
    } catch {
      next = { error: t("adminManage.queue.error.loadNetwork") };
    }
    if (!gate.settle(id)) return;
    setLoading(false);
    if ("report" in next) {
      pollFailures.current = 0;
      setReport(next.report);
      setError("");
      markLive();
      return;
    }
    if (kind === "poll" && ++pollFailures.current < 2) return;
    setError(next.error);
  }, [gate, t, markLive]);

  useEffect(() => {
    if (configured) void load();
  }, [configured, load]);

  // The re-read after an action (the arr acts in the background, so it waits a
  // moment): ONE pending timer — a newer action's replaces it — cleared when
  // the page goes away. Still a manual load (it supersedes one in flight).
  const reloadTimer = useRef<number | null>(null);
  const reloadSoon = useCallback((ms: number) => {
    if (reloadTimer.current !== null) window.clearTimeout(reloadTimer.current);
    reloadTimer.current = window.setTimeout(() => {
      reloadTimer.current = null;
      void load();
    }, ms);
  }, [load]);
  useEffect(() => () => {
    if (reloadTimer.current !== null) window.clearTimeout(reloadTimer.current);
  }, []);

  // Poll while live, visible, and no dialog is open (a refresh would
  // reshuffle the row being confirmed).
  useEffect(() => {
    if (!configured || !live || paused) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void load("poll");
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [configured, live, paused, load]);

  return { report, setReport, loading, error, snapshotAt, load, reloadSoon };
}
