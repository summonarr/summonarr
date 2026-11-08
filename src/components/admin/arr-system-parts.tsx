"use client";

// Admin → Arr System: what its three tabs share (arr-system.tsx is the page):
// the report each tab reads and polls, the toolbar with its Reload and stale
// note, the before-the-first-report state, an instance's card, and the line
// for an instance that could not be read.

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ArrSnapshotNote } from "@/components/admin/arr-snapshot-note";
import { useArrSnapshot } from "@/components/admin/use-arr-snapshot";
import { arrInstanceLabel } from "@/components/admin/open-in-arr";
import { AlertTriangle, Loader2, RefreshCw, Server } from "@/components/icons";
import { useT } from "@/components/i18n/i18n-provider";
import { withBasePath } from "@/lib/base-path";
import { ARR_ERROR_KIND_KEYS, isArrErrorKind } from "@/lib/arr-error-kind";
import type { LoadKind } from "@/lib/arr-system";
import { arrCall } from "@/lib/client/arr-call";
import type { ArrServiceName, Report } from "@/lib/client/arr-answers";
import { check, type Schema } from "@/lib/validate";
import { useAsyncAction } from "@/hooks/use-async-action";

/**
 * The URL a tab's report is read from. ONE builder for the live read and its
 * snapshot (useArrSnapshot), so both name the same server-side snapshot key.
 */
const reportUrl = (path: string) => withBasePath(path);

/**
 * Load one of the system reports; `poll` re-reads while the tab is visible.
 * Every load runs under one key ("load", use-async-action.ts): a poll tick is
 * SKIPPED while a read is out (a dark instance holds its read for the whole
 * request timeout, longer than the poll interval — a tick that superseded it
 * would discard every read and the report would never arrive); Reload, and the
 * re-read after an action, abort whatever is out and go at once. `load`
 * resolves true only when ITS report landed — false when it was skipped,
 * superseded or failed (the old report is then still shown). A read gives up
 * after arr-call.ts's read timeout, so a stuck connection can't hold Reload.
 *
 * On open the tab's snapshot is painted while the first live read is out
 * (`staleAt` says when it was read), once it passes the report's shape check.
 * It only ever sets the report: errors, the tab's in-flight tests/saves/runs,
 * its switch overrides and its command watches are the tab's own state and a
 * snapshot never touches them — and it lands at most once, before any live
 * answer, i.e. before there is a row to act on that it could overwrite.
 */
export function useReport<T extends object>(path: string, schema: Schema<Report<T>>, fallback: string, poll: number | null) {
  const [report, setReport] = useState<Report<T> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const action = useAsyncAction();
  const fallbackRef = useRef(fallback);
  useEffect(() => {
    fallbackRef.current = fallback;
  }, [fallback]);
  const url = reportUrl(path);
  const snap = useArrSnapshot<unknown>(url, (data) => {
    const parsed = check(schema, data);
    if (!parsed.ok) return false;
    setReport(parsed.value);
    return true;
  });
  const { markLive } = snap;
  // Background polls that failed in a row. One is a blip beside a report that
  // is still on screen — the next tick usually answers — so only the second
  // in a row is shown; a manual load's failure always is.
  const pollFailures = useRef(0);
  const load = useCallback(async (kind: LoadKind = "manual"): Promise<boolean> => {
    // A poll refreshes quietly: nothing spins every tick, and Reload stays
    // enabled (a manual load supersedes the poll).
    if (kind !== "poll") setLoading(true);
    const res = await action.run(
      "load",
      (signal) => arrCall(url, { schema, signal, fallback: fallbackRef.current }),
      { ifBusy: kind === "poll" ? "skip" : "restart" },
    );
    // Skipped (a poll while a read is out), superseded by a newer load, or unmounted.
    if (res === undefined) return false;
    setLoading(false);
    if (res.ok) {
      pollFailures.current = 0;
      // This read's answer replaces whatever is shown, a snapshot included.
      markLive();
      setReport(res.data);
      setError("");
      return true;
    }
    if (kind === "poll" && ++pollFailures.current < 2) return false;
    setError(res.error);
    return false;
  }, [url, schema, action, markLive]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (poll === null) return;
    const h = window.setInterval(() => {
      if (document.visibilityState === "visible") void load("poll");
    }, poll);
    return () => window.clearInterval(h);
  }, [poll, load]);
  return { report, loading, error, load, staleAt: snap.staleAt };
}

/**
 * The signal a tab hands its tests, saves and runs: aborted when the tab goes
 * away (another tab, the page left), so nothing it started is followed after.
 * A fresh one per mount — React's development double-mount included.
 */
export function useLifetimeSignal(): () => AbortSignal | undefined {
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const c = new AbortController();
    controller.current = c;
    return () => c.abort();
  }, []);
  return useCallback(() => controller.current?.signal, []);
}

export const labelOf = (report: Report<unknown>, service: ArrServiceName, slug: string) =>
  arrInstanceLabel(service, report.instances.find((i) => i.service === service && i.slug === slug)?.name, slug);

/** Each instance that could not be read, and why — in the viewer's language (the raw upstream detail stays in the server log). */
export function InstanceErrors({ report }: { report: Report<unknown> | null }) {
  const t = useT();
  if (!report || report.errors.length === 0) return null;
  return (
    <>
      {report.errors.map((e) => (
        <p key={`${e.service}:${e.instance}`} role="alert" className="m-0 flex items-center gap-1.5 text-xs text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {t(ARR_ERROR_KIND_KEYS[isArrErrorKind(e.kind) ? e.kind : "other"], { name: labelOf(report, e.service, e.instance) })}
        </p>
      ))}
    </>
  );
}

export function Card({ title, actions, children }: { title: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="grid gap-3 rounded-xl p-4" style={{ border: "1px solid var(--ds-border)", background: "var(--ds-bg-1)" }}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="m-0 flex items-center gap-2 text-sm font-semibold text-zinc-100"><Server className="h-4 w-4 text-zinc-500" aria-hidden /> {title}</h2>
        <span className="flex-1" />
        {actions}
      </div>
      {children}
    </section>
  );
}

/** Reload, the last read's error, and — while the report shown is a snapshot — when it was read. */
export function Toolbar({ loading, onReload, error, staleAt }: { loading: boolean; onReload: () => void; error: string; staleAt: string | null }) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-2">
      {error && (
        <p role="alert" className="m-0 flex items-center gap-1.5 text-sm" style={{ color: "var(--ds-danger)" }}>
          <AlertTriangle className="h-4 w-4 shrink-0" /> {error}
        </p>
      )}
      <ArrSnapshotNote at={staleAt} refreshing={loading} />
      <Button variant="ghost" size="sm" className="ml-auto" disabled={loading} onClick={onReload}>
        {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />} {t("adminArr.common.reload")}
      </Button>
    </div>
  );
}

/**
 * Before the first report: a spinner, or the first read's error with a Reload
 * — the Indexers and Storage tabs never poll, so without it a failed first
 * read stayed on screen until the tab was switched.
 */
export function Loading({ error, loading, onRetry }: { error: string; loading: boolean; onRetry: () => void }) {
  const t = useT();
  return error ? (
    <div className="flex flex-wrap items-center gap-2 py-6">
      <p role="alert" className="m-0 flex min-w-0 items-center gap-1.5 text-sm" style={{ color: "var(--ds-danger)" }}>
        <AlertTriangle className="h-4 w-4 shrink-0" /> <span className="min-w-0" style={{ overflowWrap: "anywhere" }}>{error}</span>
      </p>
      <Button variant="ghost" size="sm" disabled={loading} onClick={onRetry}>
        {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />} {t("adminArr.common.reload")}
      </Button>
    </div>
  ) : (
    <div className="flex items-center gap-2 py-10 text-sm text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" /> {t("adminArr.common.loading")}</div>
  );
}
