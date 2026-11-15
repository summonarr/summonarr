"use client";

// Admin → Missing: every row's own Search and "Search selected"
// (missing-report.tsx).
//
// Each ticked row goes through the same per-row search (re-judged live, 409
// when nothing is missing any more) via runBulkSearch, two requests at a time.
// That pacing is only Summonarr's own: each POST answers 202 once the arr has
// QUEUED its command, so Radarr/Sonarr — and every indexer behind them — get
// the whole selection within minutes. Hence the cap (BULK_SEARCH_MAX; the
// library-wide search in Arr System is the tool for more), the confirmation
// above BULK_SEARCH_CONFIRM_OVER titles, and Cancel. Every row shows its own
// outcome.
//
// Two hooks, because the page's list reads sit between them:
// - `useBulkSearch` holds the rows' search state and the run, for every list.
//   The list reads need it first: no snapshot paints over a list the admin is
//   busy on (`listIdle`), and a Refresh resets the list's rows (`resetList`).
// - `useBulkSelection` is what is ticked on the list on screen: the counts,
//   the cap and the actions of the bulk bar. It needs that list's rows.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { withBasePath } from "@/lib/base-path";
import { useT } from "@/components/i18n/i18n-provider";
import type { ReportKey, Reports } from "@/components/admin/use-missing-reports";
import { readApiError } from "@/lib/client/api-error";
import { listSelection, pageSelection, type SelectionRules } from "@/components/admin/bulk-selection";
import {
  BULK_SEARCH_CONFIRM_OVER,
  BULK_SEARCH_MAX,
  capSelection,
  runBulkSearch,
  searchAttemptFromResponse,
  type SearchAttempt,
  type SearchOutcome,
} from "@/lib/bulk-search-run";
import { timedFetch } from "@/lib/client/fetch-json";
import { modeOf, serviceOf } from "@/components/admin/missing-report-rules";
import { check, v } from "@/lib/validate";

// The only field of the 202 the runner reads.
const PARTIAL_ANSWER = v.object({ partial: v.optional(v.boolean()) });

// `outcome` null while a request is in flight (or before any); `message` is the
// route's own text — the error for "failed", the 409's reason for "already".
export type SearchState = { busy: boolean; outcome: SearchOutcome | null; message: string };
export type BulkRow = { instance: string; arrId: number; title: string; monitored?: boolean };
export type BulkResult = {
  key: ReportKey;
  started: number;
  already: number;
  /** Row keys (`${reportKey}|${instance}:${arrId}`) — what "Retry failed" re-selects. */
  failed: string[];
  skipped: number;
  notRun: number;
  total: number;
  cancelled: boolean;
};

export const rowKey = (r: { instance: string; arrId: number }) => `${r.instance}:${r.arrId}`;

export function useBulkSearch() {
  const t = useT();
  // Keyed `${reportKey}|${instance}:${arrId}` — a Radarr and a Sonarr row can
  // share an instance slug and an arr id, and so can the two modes.
  const [searches, setSearches] = useState<Record<string, SearchState>>({});
  // Mirrors `searches`, written in the same step: the bulk runner reads a row's
  // state when it DEQUEUES the row, not from the render the run started in, so
  // a row a per-row click made busy (or already searched) is skipped.
  const searchesRef = useRef<Record<string, SearchState>>({});
  const updateSearches = useCallback((fn: (s: Record<string, SearchState>) => Record<string, SearchState>) => {
    searchesRef.current = fn(searchesRef.current);
    setSearches(searchesRef.current);
  }, []);
  // Rows ticked for "Search selected", keyed like `searches`.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulk, setBulk] = useState<{ key: ReportKey; done: number; total: number; cancelling: boolean } | null>(null);
  // Rows a running bulk search still has to take: their own Search is disabled
  // so a click can't search one the run is about to.
  const [bulkPending, setBulkPending] = useState<ReadonlySet<string>>(new Set());
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);
  const [confirming, setConfirming] = useState<{ key: ReportKey; count: number; unmonitored: number } | null>(null);
  // The running bulk search. Aborted by Cancel and when the page unmounts —
  // without that the loop kept POSTing after the admin navigated away.
  const bulkAbort = useRef<AbortController | null>(null);
  useEffect(() => () => bulkAbort.current?.abort(), []);

  // Nothing going on list k that a snapshot could paint under: no bulk search
  // (its runner and the selection it took stay exactly as they are — a run
  // whose list isn't committed yet counts), no confirmation of one, and no
  // row's own search in flight.
  const listIdle = (k: ReportKey) =>
    !(bulkAbort.current !== null && (bulk === null || bulk.key === k)) &&
    confirming?.key !== k &&
    !Object.entries(searchesRef.current).some(([key, st]) => st.busy && key.startsWith(`${k}|`));

  // A fresh live listing replaced an earlier live one (Refresh): the rows that
  // were searched may be gone, and any still listed can be searched again. A
  // row whose search is still IN FLIGHT keeps its state — its request settles
  // it, and until then its Search stays off (a cleared entry re-armed the
  // button mid-request).
  const resetList = useCallback((k: ReportKey) => {
    updateSearches((s) => Object.fromEntries(Object.entries(s).filter(([key, st]) => !key.startsWith(`${k}|`) || st.busy)));
    setSelected((prev) => new Set([...prev].filter((key) => !key.startsWith(`${k}|`))));
    setBulkResult((r) => (r?.key === k ? null : r));
  }, [updateSearches]);

  // One search request; marks the row busy and reports how it went without
  // settling it — the bulk runner may wait out a 429 and ask again first.
  async function requestSearch(key: ReportKey, row: { instance: string; arrId: number }): Promise<SearchAttempt> {
    const svc = serviceOf(key);
    const m = modeOf(key);
    const k = `${key}|${rowKey(row)}`;
    updateSearches((s) => ({ ...s, [k]: { busy: true, outcome: null, message: "" } }));
    try {
      const res = await timedFetch(withBasePath("/api/admin/missing/search"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: svc, instance: row.instance, arrId: row.arrId, mode: m }),
      }, 120_000);
      if (res.ok) {
        const attempt = searchAttemptFromResponse(res.status, "", null);
        // Sonarr refused a later command after earlier ones were queued: those
        // are running, the rest of the title's gap is not being searched.
        const body = check(PARTIAL_ANSWER, await res.json().catch(() => null));
        return body.ok && body.value.partial === true ? { ...attempt, message: t("adminManage.missing.searchPartial") } : attempt;
      }
      const message = await readApiError(res, t("adminManage.missing.searchError"));
      return searchAttemptFromResponse(res.status, message, res.headers.get("Retry-After"));
    } catch {
      return { outcome: "failed", message: t("adminManage.missing.searchError") };
    }
  }

  function settleSearch(key: ReportKey, row: { instance: string; arrId: number }, outcome: SearchOutcome, message: string) {
    const k = `${key}|${rowKey(row)}`;
    const text = outcome === "failed" ? message || t("adminManage.missing.searchError") : message;
    updateSearches((s) => ({ ...s, [k]: { busy: false, outcome, message: text } }));
  }

  // A row's own Search button. A 429 here just says so — only the bulk run
  // waits it out.
  async function startSearch(key: ReportKey, row: { instance: string; arrId: number }) {
    // A row being searched can't be ticked, so its own Search takes it out of
    // the selection: left ticked, it dropped out of the cap count only while
    // busy, a failure brought it back, and the ticks then exceeded the cap.
    const k = `${key}|${rowKey(row)}`;
    setSelected((prev) => {
      if (!prev.has(k)) return prev;
      const next = new Set(prev);
      next.delete(k);
      return next;
    });
    const attempt = await requestSearch(key, row);
    settleSearch(key, row, attempt.outcome === "rateLimited" ? "failed" : attempt.outcome, attempt.message);
  }

  async function searchSelected(key: ReportKey, picked: ReadonlyArray<BulkRow>) {
    const rows = capSelection(picked);
    if (rows.length === 0 || bulkAbort.current) return;
    const controller = new AbortController();
    bulkAbort.current = controller;
    const keyOf = (r: BulkRow) => `${key}|${rowKey(r)}`;
    setBulkResult(null);
    setBulkPending(new Set(rows.map(keyOf)));
    setBulk({ key, done: 0, total: rows.length, cancelling: false });
    try {
      const summary = await runBulkSearch(rows, {
        signal: controller.signal,
        attempt: (row) => requestSearch(key, row),
        skip: (row) => {
          const st = searchesRef.current[keyOf(row)];
          return !!st && (st.busy || st.outcome === "started" || st.outcome === "already");
        },
        onSettled: (row, outcome, message) => {
          if (outcome !== "skipped") settleSearch(key, row, outcome, message);
          setBulkPending((prev) => {
            const next = new Set(prev);
            next.delete(keyOf(row));
            return next;
          });
        },
        onProgress: (done) => setBulk((b) => (b && b.key === key ? { ...b, done } : b)),
      });
      setBulkResult({
        key,
        started: summary.started,
        already: summary.already,
        failed: summary.failed.map(keyOf),
        skipped: summary.skipped,
        notRun: summary.notRun,
        total: rows.length,
        cancelled: summary.cancelled,
      });
    } finally {
      bulkAbort.current = null;
      setBulk(null);
      setBulkPending(new Set());
      setSelected((prev) => new Set([...prev].filter((k) => !k.startsWith(`${key}|`))));
    }
  }

  function cancelBulk() {
    bulkAbort.current?.abort();
    setBulk((b) => (b ? { ...b, cancelling: true } : b));
  }

  // Whether a bulk search is running right now, for a callback that must not
  // act mid-run (a re-read would reset the rows the run holds). A live read, not
  // the `bulk` of the render the callback was made in.
  const isBulkRunning = useCallback(() => bulkAbort.current !== null, []);

  return {
    searches,
    selected,
    setSelected,
    bulk,
    bulkPending,
    bulkResult,
    confirming,
    setConfirming,
    isBulkRunning,
    listIdle,
    resetList,
    startSearch,
    searchSelected,
    cancelBulk,
  };
}

export type BulkSearch = ReturnType<typeof useBulkSearch>;

// Stable, so a list with no report yet doesn't redo the whole-list passes every render.
const NO_ROWS: ReadonlyArray<BulkRow> = [];

// The selection on the list on screen. A tick outlives a page turn and a
// filter change, so the selection is every ticked row of this tab and mode —
// the listed ones in the order shown (every page), then those the filters now
// hide. The cap, the count on the button and the run all use this one list:
// counting only the rows on screen let a filter change tick past the cap, and
// the run then searched fewer titles than the button said.
export function useBulkSelection(
  run: BulkSearch,
  {
    current,
    currentRows,
    pageRows,
    report,
    loadingKeys,
  }: {
    current: ReportKey;
    /** Every row the filters list, in the order shown, across every page. */
    currentRows: ReadonlyArray<BulkRow>;
    /** The rows on screen: this page (a slice of currentRows). */
    pageRows: ReadonlyArray<BulkRow>;
    /** The list's unfiltered report. */
    report: Reports[ReportKey];
    loadingKeys: ReadonlySet<ReportKey>;
  },
) {
  const { searches, selected, setSelected, bulk, bulkPending, bulkResult, confirming, setConfirming, searchSelected } = run;
  const loadingHere = loadingKeys.has(current);
  const selKey = useCallback((r: { instance: string; arrId: number }) => `${current}|${rowKey(r)}`, [current]);
  // A row that is being searched, was searched, or turned out complete can't be
  // ticked; one a bulk run still holds can't either.
  const isOpen = useCallback((r: BulkRow) => {
    const k = selKey(r);
    const st = searches[k];
    return !st?.busy && st?.outcome !== "started" && st?.outcome !== "already" && !bulkPending.has(k);
  }, [selKey, searches, bulkPending]);
  // Every row of the report is a BulkRow (each list's rows carry instance,
  // arrId and title — checked on read, missing-report-shape.ts).
  const reportItems: ReadonlyArray<BulkRow> = report?.items ?? NO_ROWS;
  const rules = useMemo<SelectionRules<BulkRow>>(() => ({ selected, selKey, isOpen }), [selected, selKey, isOpen]);
  // The passes over the whole list (every page, and the unfiltered report)
  // run once per change of what they read; the page's own view is a page of
  // rows, taken every render (bulk-selection.ts).
  const list = useMemo(() => listSelection(currentRows, reportItems, rules), [currentRows, reportItems, rules]);
  const { selectedHidden, selectedHere, toRun, atCap } = list;
  const { selectable, shownKeys, selectedOffPage, roomOnPage, allSelected } = pageSelection(list, pageRows, rules);
  const bulkRunning = bulk !== null;
  const runningHere = bulk?.key === current ? bulk : null;
  const resultHere = bulkResult?.key === current ? bulkResult : null;

  function toggleSelected(k: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else if (!atCap) next.add(k);
      return next;
    });
  }

  // The header box: on ticks the rows on screen (this page), in the order
  // shown, as far as the cap leaves room beside the ticks on other pages and
  // the ones the filters hide; off unticks the rows on screen. The ticks
  // elsewhere stay either way — "Clear selection" drops them too.
  function selectAll(on: boolean) {
    setSelected((prev) => {
      const next = new Set([...prev].filter((k) => !shownKeys.has(k)));
      if (on) for (const r of capSelection(selectable, roomOnPage)) next.add(selKey(r));
      return next;
    });
  }

  function clearSelection() {
    setSelected((prev) => new Set([...prev].filter((k) => !k.startsWith(`${current}|`))));
  }

  function requestBulk() {
    const rows = capSelection(selectedHere);
    // Not while this list is reloading: the fresh listing clears every row's
    // state and selection, mid-run.
    if (rows.length === 0 || bulkRunning || loadingHere) return;
    if (rows.length > BULK_SEARCH_CONFIRM_OVER) {
      setConfirming({ key: current, count: rows.length, unmonitored: rows.filter((r) => r.monitored === false).length });
      return;
    }
    void searchSelected(current, rows);
  }

  function confirmBulk() {
    const c = confirming;
    setConfirming(null);
    // The dialog is modal, so the selection it described is still the one here.
    if (c && c.key === current && !loadingKeys.has(current)) void searchSelected(current, capSelection(selectedHere));
  }

  // Re-ticks exactly the rows the last run could not search.
  function retryFailed() {
    if (!bulkResult || bulkResult.key !== current) return;
    const open = new Set(reportItems.filter(isOpen).map(selKey));
    const failed = bulkResult.failed.filter((k) => open.has(k)).slice(0, BULK_SEARCH_MAX);
    setSelected((prev) => new Set([...[...prev].filter((k) => !k.startsWith(`${current}|`)), ...failed]));
  }

  return {
    selectable,
    selectedOffPage,
    selectedHidden,
    selectedHere,
    toRun,
    atCap,
    allSelected,
    bulkRunning,
    runningHere,
    resultHere,
    toggleSelected,
    selectAll,
    clearSelection,
    requestBulk,
    confirmBulk,
    retryFailed,
  };
}
