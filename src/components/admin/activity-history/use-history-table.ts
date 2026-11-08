"use client";

// The History table's state and loading, as hooks the table composes:
// - useHistoryQuery: the filters/sort/page-size/page, mirrored into the URL;
// - useHistoryPage: the page of rows /api/play-history answers for it;
// - useHistoryOptions: the User and Platform dropdowns' choices;
// - useHistoryDelete: the delete dialog's request.
// Every request goes through fetchJson (timeout, abort, shape check) under the
// table's one useAsyncAction (`loader`), so an unmount or a newer request drops
// a stale answer.

import { useCallback, useEffect, useReducer, useRef, useState, type Dispatch } from "react";
import { useSearchParams } from "next/navigation";
import { withBasePath } from "@/lib/base-path";
import { fetchJson } from "@/lib/client/fetch-json";
import type { AsyncAction } from "@/hooks/use-async-action";
import {
  applyHistoryUrlEntries,
  beginLoad,
  buildHistoryFilterParams,
  dateRangeInverted,
  deleteOutcome,
  historyQueryReducer,
  historyUrlEntries,
  initialHistoryQuery,
  NEW_LOAD_TRACKER,
  settleLoad,
} from "./helpers";
import { historyPageSchema, platformOptionsSchema, userOptionsSchema } from "./schema";
import type {
  HistoryQuery,
  HistoryQueryAction,
  HistoryRow,
  MediaServerUserOption,
  WatchedFilter,
} from "./types";

const SEARCH_DEBOUNCE_MS = 350;

export interface HistoryQueryState {
  query: HistoryQuery;
  dispatch: Dispatch<HistoryQueryAction>;
  // The search box's text; committed to `query.filters.search` after the debounce.
  searchDraft: string;
  setSearchDraft: (value: string) => void;
}

export function useHistoryQuery(seed: { fromDate?: string; toDate?: string; watched?: WatchedFilter }): HistoryQueryState {
  const searchParams = useSearchParams();
  const [query, dispatch] = useReducer(historyQueryReducer, undefined, () => initialHistoryQuery(seed, searchParams));
  const [searchDraft, setSearchDraft] = useState(query.filters.search);

  useEffect(() => {
    const timer = setTimeout(() => dispatch({ type: "filter", patch: { search: searchDraft } }), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchDraft]);

  // Keep the URL's copy of the table's state in step (helpers.ts says why). The
  // state argument is null on purpose: Next's patched replaceState skips its
  // router sync for a state carrying its own marker (which
  // `window.history.state` does), so the router kept the old query; with null,
  // Next copies its own history state itself.
  const { filters, grouped, sortBy, sortDir, limit } = query;
  useEffect(() => {
    const url = new URL(window.location.href);
    if (applyHistoryUrlEntries(url, historyUrlEntries({ filters, grouped, sortBy, sortDir, limit }))) {
      window.history.replaceState(null, "", url);
    }
  }, [filters, grouped, sortBy, sortDir, limit]);

  return { query, dispatch, searchDraft, setSearchDraft };
}

export interface HistoryPageState {
  rows: HistoryRow[];
  total: number;
  totalPages: number;
  // A load the admin is waiting on (first load, a filter, sort or page change):
  // the rows on screen dim and stop taking clicks. A live refresh re-reads in
  // the background and leaves them alone.
  loading: boolean;
  // A catalog key, translated at render.
  error: string | null;
  // The From day is after the To day: nothing was asked for.
  invertedRange: boolean;
  reload: () => void;
}

export function useHistoryPage({
  query,
  dispatch,
  globalSource,
  globalMediaType,
  startDateIso,
  loader,
}: {
  query: HistoryQuery;
  dispatch: Dispatch<HistoryQueryAction>;
  globalSource?: string;
  globalMediaType?: string;
  startDateIso?: string;
  loader: AsyncAction;
}): HistoryPageState {
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped by a delete or Retry to re-read the CURRENT page. The table is the
  // only thing that knows the DB changed — the DELETE route emits no SSE event.
  const [reloadToken, setReloadToken] = useState(0);

  const { filters, grouped, sortBy, sortDir, limit, page } = query;
  const invertedRange = dateRangeInverted(filters.fromDate, filters.toDate);
  const params = buildHistoryFilterParams({ globalSource, globalMediaType, startDateIso, filters, sortBy, sortDir, grouped });
  params.set("page", String(page));
  params.set("limit", String(limit));
  const requestQuery = params.toString();
  // What the admin asked for: the request without the period's lower bound,
  // plus a Retry/delete reload. `startDateIso` is read off the clock on every
  // server render, so the page's live refresher (a finished play →
  // router.refresh) hands the table a new one each time; a re-read for that
  // alone is a background refresh, and must not dim the rows or swallow clicks.
  params.delete("startDate");
  const foregroundKey = `${params.toString()}|${reloadToken}`;

  // Foreground or background (beginLoad, helpers.ts).
  const loads = useRef(NEW_LOAD_TRACKER);

  useEffect(() => {
    if (invertedRange) {
      loader.abort("page");
      setLoading(false);
      return;
    }
    const begun = beginLoad(loads.current, foregroundKey);
    loads.current = begun.tracker;
    const background = begun.background;
    if (!background) {
      setLoading(true);
      setError(null);
    }
    void (async () => {
      const res = await loader.run("page", (signal) =>
        fetchJson(withBasePath(`/api/play-history?${requestQuery}`), { schema: historyPageSchema, signal }),
      );
      if (!res) return; // a newer request or an unmount took over
      if (!res.ok) {
        if (res.kind === "aborted") return;
        loads.current = settleLoad(loads.current);
        console.error(`[activity-history] page load failed (${res.kind}, ${res.status}): ${res.detail}`);
        // A failed background re-read keeps the rows the admin is looking at.
        if (background) return;
        setError("adminActivity.history.loadError");
        setLoading(false);
        return;
      }
      // After a delete the current page can end up past the last page (e.g.
      // removing the only row on the final page). Step back to the new last
      // page; that is a new request, which fetches it.
      const lastPage = Math.max(1, res.data.totalPages);
      if (page > lastPage) {
        dispatch({ type: "page", page: lastPage });
        return;
      }
      loads.current = settleLoad(loads.current);
      setRows(res.data.items);
      setTotal(res.data.total);
      setTotalPages(res.data.totalPages);
      setLoading(false);
    })();
    // `startDateIso` on its own: with a From day set it isn't in the request,
    // and a live refresh still re-reads (a finished play may fall in range).
  }, [requestQuery, foregroundKey, invertedRange, startDateIso, page, loader, dispatch]);

  const reload = useCallback(() => setReloadToken((n) => n + 1), []);
  return { rows, total, totalPages, loading, error, invertedRange, reload };
}

// The options for the User and Platform dropdowns. A failed lookup leaves the
// dropdown at "All" and says so in the console; the table itself still works.
export function useHistoryOptions(loader: AsyncAction): { platforms: string[]; users: MediaServerUserOption[] } {
  const [platforms, setPlatforms] = useState<string[]>([]);
  const [users, setUsers] = useState<MediaServerUserOption[]>([]);

  useEffect(() => {
    void loader
      .run("options:platforms", (signal) =>
        fetchJson(withBasePath("/api/play-history?distinct=platforms"), { schema: platformOptionsSchema, signal }),
      )
      .then((res) => {
        if (!res) return;
        if (res.ok) setPlatforms(res.data);
        else if (res.kind !== "aborted") console.warn(`[activity-history] platform options failed (${res.kind}): ${res.detail}`);
      });
    void loader
      .run("options:users", (signal) =>
        fetchJson(withBasePath("/api/play-history?distinct=users"), { schema: userOptionsSchema, signal }),
      )
      .then((res) => {
        if (!res) return;
        if (res.ok) setUsers(res.data);
        else if (res.kind !== "aborted") console.warn(`[activity-history] user options failed (${res.kind}): ${res.detail}`);
      });
  }, [loader]);

  return { platforms, users };
}

export interface HistoryDeleteState {
  row: HistoryRow | null;
  open: (row: HistoryRow) => void;
  cancel: () => void;
  confirm: () => Promise<void>;
  deleting: boolean;
  error: string | null;
}

export function useHistoryDelete({
  grouped,
  loader,
  failedText,
  onDeleted,
}: {
  grouped: boolean;
  loader: AsyncAction;
  // Shown when the route gave no reason of its own (or none came back).
  failedText: string;
  onDeleted: () => void;
}): HistoryDeleteState {
  const [row, setRow] = useState<HistoryRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cancel = useCallback(() => {
    setRow(null);
    setError(null);
  }, []);

  async function confirm() {
    if (!row) return;
    setError(null);
    // In grouped mode a row IS the whole viewing — one film paused and
    // resumed across several sittings — so the delete has to take the chain.
    // The row's own id is only the NEWEST segment (the group's representative
    // is picked by startedAt DESC), so deleting it alone left the rest behind.
    const res = await loader.run(
      "delete",
      (signal) =>
        fetchJson(withBasePath(`/api/play-history/${encodeURIComponent(row.id)}${grouped ? "?chain=true" : ""}`), {
          init: { method: "DELETE" },
          signal,
          fallbackError: failedText,
        }),
      { ifBusy: "skip" },
    );
    if (!res) return;
    const outcome = deleteOutcome(res);
    if (outcome.kind === "done") {
      setRow(null);
      // Re-read rather than splice the row out and decrement the total. Both
      // were guesses about what the server did, and both were wrong for a
      // chain: the row vanished while its other segments survived, and the
      // total counts DISTINCT chains so it had not changed at all.
      onDeleted();
    } else if (outcome.kind === "error") {
      setError(outcome.message);
    }
  }

  return { row, open: setRow, cancel, confirm, deleting: loader.busy("delete"), error };
}
