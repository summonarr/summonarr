// Pure helpers for the admin history table. No React, no state — the parent
// (activity-history-table.tsx) memoizes/threads these as needed, and the unit
// suite drives them directly (tests/history-table-query.test.mts).

import type { Translator } from "@/lib/i18n/translate";
import type { FetchJsonResult } from "@/lib/client/fetch-json";
import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZES,
  PLAY_METHODS,
  SORT_FIELDS,
  type HistoryFilters,
  type HistoryQuery,
  type HistoryQueryAction,
  type SortDir,
  type SortField,
  type WatchedFilter,
} from "./types";

// Format a millisecond offset as m:ss / h:mm:ss for marker labels in the
// session detail panel. Matches the formatter on the Now Playing card so the
// numbers line up visually.
export function fmtMarkerOffset(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

// How much of a title was played, as a whole percent clamped to 100: a
// chain's play time is a SUM over its sittings, so a rewatched span pushes it
// past the title's length. `ifUnknown` is the answer when the length is.
export function playProgressPct(playedSeconds: number, durationSeconds: number, ifUnknown = 0): number {
  if (durationSeconds <= 0) return ifUnknown;
  return Math.min(100, Math.round((playedSeconds / durationSeconds) * 100));
}

// A play's media type in the viewer's language. Null is "", and a value the
// enum doesn't know is shown as it came.
export function mediaTypeLabel(t: Translator, mediaType: string | null | undefined): string {
  if (mediaType === "MOVIE") return t("adminActivity.common.movie");
  if (mediaType === "TV") return t("adminActivity.filter.tv");
  return mediaType ?? "";
}

// A YYYY-MM-DD day filter means a whole calendar day in the statistics time zone,
// the zone every per-day count is bucketed in — including the activity heatmap,
// whose cells link here as ?from=&to=. The day is sent as is (fromDay/toDay) and
// the SERVER turns it into that zone's midnights: the browser can't know the
// zone's offset on that date, and the admin's own midnight would not match the
// day the cell counted. A malformed or impossible date (2026-13-01, or
// 2026-02-30, which Date silently rolls forward to Mar 2) is dropped here rather
// than sent, since the API answers it with a 400.
export function validDay(day: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const date = Number(m[3]);
  const start = new Date(Date.UTC(year, month - 1, date));
  if (
    Number.isNaN(start.getTime()) ||
    start.getUTCFullYear() !== year ||
    start.getUTCMonth() !== month - 1 ||
    start.getUTCDate() !== date
  ) {
    return null;
  }
  return day;
}

// A From day after the To day. The pickers bound each other, but a typed or
// pasted date isn't held to `min`/`max`, and the API answers the range with an
// unexplained empty table, so the table says why and asks for nothing.
// YYYY-MM-DD compares in date order as text.
export function dateRangeInverted(fromDate: string, toDate: string): boolean {
  const from = validDay(fromDate);
  const to = validDay(toDate);
  return from !== null && to !== null && from > to;
}

// Filter/sort state serialized as query params for both the table fetch
// (/api/play-history) and the CSV/JSON export (/api/play-history/export).
export interface HistoryFilterInput {
  globalSource?: string;
  globalMediaType?: string;
  startDateIso?: string;
  filters: HistoryFilters;
  sortBy: SortField;
  sortDir: SortDir;
  grouped: boolean;
}

// Whether the calendar day `day` is over before `iso`, whatever zone the day
// is counted in: a day ends at most 36 hours after its UTC midnight (UTC-12).
// A To day that ends before the period begins can match nothing while the
// period's lower bound is sent with it, and the table would answer "no plays
// match" without saying the period is why — so that bound is dropped and To
// alone means "up to that day".
export function dayEndsBefore(day: string, iso: string): boolean {
  const dayStart = Date.parse(`${day}T00:00:00Z`);
  const bound = Date.parse(iso);
  if (Number.isNaN(dayStart) || Number.isNaN(bound)) return false;
  return dayStart + 36 * 60 * 60 * 1000 <= bound;
}

export function buildHistoryFilterParams({
  globalSource,
  globalMediaType,
  startDateIso,
  filters,
  sortBy,
  sortDir,
  grouped,
}: HistoryFilterInput): URLSearchParams {
  const params = new URLSearchParams();
  if (globalSource) params.set("source", globalSource);
  if (globalMediaType) params.set("mediaType", globalMediaType);
  const from = filters.fromDate ? validDay(filters.fromDate) : null;
  const to = filters.toDate ? validDay(filters.toDate) : null;
  if (from) {
    params.set("fromDay", from);
  } else if (startDateIso && !(to && dayEndsBefore(to, startDateIso))) {
    params.set("startDate", startDateIso);
  }
  if (to) params.set("toDay", to);
  if (filters.search) params.set("search", filters.search);
  if (filters.watched) params.set("watched", filters.watched);
  if (filters.method) params.set("playMethod", filters.method);
  if (filters.platform) params.set("platform", filters.platform);
  if (filters.userId) params.set("userId", filters.userId);
  params.set("sortBy", sortBy);
  params.set("sortDir", sortDir);
  // API defaults to grouped; only set the flag in the ungrouped case so a
  // bare-URL share still lands on the default-on behaviour.
  if (!grouped) params.set("ungrouped", "true");
  return params;
}

export const EMPTY_HISTORY_FILTERS: HistoryFilters = {
  search: "",
  watched: "",
  method: "",
  platform: "",
  userId: "",
  fromDate: "",
  toDate: "",
};

const DEFAULT_SORT_BY: SortField = "startedAt";
const DEFAULT_SORT_DIR: SortDir = "desc";

// Whether anything narrows the rows: the filters, or a search still being
// typed (its Clear button should show before the debounce commits it).
export function hasActiveFilter(filters: HistoryFilters, searchDraft: string): boolean {
  return searchDraft !== "" || Object.values(filters).some((value) => value !== "");
}

function sameFilters(a: HistoryFilters, b: HistoryFilters): boolean {
  return (Object.keys(a) as (keyof HistoryFilters)[]).every((key) => a[key] === b[key]);
}

// The table's query state. Every change but a page change goes back to page 1
// IN THE SAME UPDATE, so the fetch effect sees the new filters and page 1
// together and sends exactly one request. (Resetting the page in an effect of
// its own would fetch the OLD page with the NEW filters first; the browser
// cancels that one, but the server still runs the expensive grouped query.)
// A change to the value already set returns the same state, so nothing
// refetches.
export function historyQueryReducer(state: HistoryQuery, action: HistoryQueryAction): HistoryQuery {
  switch (action.type) {
    case "filter": {
      const filters = { ...state.filters, ...action.patch };
      if (sameFilters(filters, state.filters)) return state;
      return { ...state, filters, page: 1 };
    }
    case "clearFilters":
      if (sameFilters(state.filters, EMPTY_HISTORY_FILTERS)) return state;
      return { ...state, filters: EMPTY_HISTORY_FILTERS, page: 1 };
    case "grouped":
      if (state.grouped === action.grouped) return state;
      return { ...state, grouped: action.grouped, page: 1 };
    case "sort":
      // The same column flips direction; a new one starts newest-first for the
      // date and A→Z / shortest-first for the rest.
      if (state.sortBy === action.field) {
        return { ...state, sortDir: state.sortDir === "asc" ? "desc" : "asc", page: 1 };
      }
      return { ...state, sortBy: action.field, sortDir: action.field === "startedAt" ? "desc" : "asc", page: 1 };
    case "limit":
      if (state.limit === action.limit) return state;
      return { ...state, limit: action.limit, page: 1 };
    case "page": {
      const page = Math.max(1, Math.floor(action.page));
      if (state.page === page) return state;
      return { ...state, page };
    }
  }
}

// ── The URL copy of the table's state ────────────────────────────────────────
//
// The table writes its filters, sort and page size into the query string, and
// reads them back on (re)mount. The period/source/type selector copies the
// whole query string into its push, and the page remounts the table on those
// filters, so without this a period change silently dropped the search, user,
// platform, stream method, grouping, sort and page size. The page number is
// not kept: a new period starts on page 1. Defaults are left out, so a plain
// History link stays a plain URL.

const MAX_SEARCH_PARAM = 500;
const MAX_PLATFORM_PARAM = 256;
const MAX_USER_ID_PARAM = 64;

// The URL keys, in the order they're written. `from`/`to`/`watched` are the
// names the calendar's "View these plays" link already uses; the rest are the
// API's own names for the same filters.
export function historyUrlEntries(
  q: Pick<HistoryQuery, "filters" | "grouped" | "sortBy" | "sortDir" | "limit">,
): [string, string][] {
  const f = q.filters;
  return [
    ["from", f.fromDate],
    ["to", f.toDate],
    ["watched", f.watched],
    ["search", f.search],
    ["playMethod", f.method],
    ["platform", f.platform],
    ["userId", f.userId],
    ["ungrouped", q.grouped ? "" : "true"],
    ["sortBy", q.sortBy === DEFAULT_SORT_BY ? "" : q.sortBy],
    ["sortDir", q.sortDir === DEFAULT_SORT_DIR ? "" : q.sortDir],
    ["limit", q.limit === DEFAULT_PAGE_SIZE ? "" : String(q.limit)],
  ];
}

// Applies the entries to `url` ("" removes a key). True when anything changed,
// so an unchanged state never touches history.
export function applyHistoryUrlEntries(url: URL, entries: readonly (readonly [string, string])[]): boolean {
  let changed = false;
  for (const [key, value] of entries) {
    if (value === "") {
      if (url.searchParams.has(key)) {
        url.searchParams.delete(key);
        changed = true;
      }
    } else if (url.searchParams.get(key) !== value) {
      url.searchParams.set(key, value);
      changed = true;
    }
  }
  return changed;
}

type ParamReader = { get(key: string): string | null };

function boundedParam(params: ParamReader, key: string, max: number): string {
  const value = params.get(key) ?? "";
  return value.length <= max ? value : "";
}

function oneOf<T extends string | number>(value: string | number | null, allowed: readonly T[]): T | undefined {
  if (value === null) return undefined;
  return allowed.find((candidate) => candidate === value);
}

// The table's opening state. The day range and the watched filter are the
// SERVER page's validated seeds (it already parses `from`/`to`/`watched`); the
// rest is read from the URL here, and anything malformed is dropped.
export function initialHistoryQuery(
  seed: { fromDate?: string; toDate?: string; watched?: WatchedFilter },
  params: ParamReader,
): HistoryQuery {
  const limitParam = Number(params.get("limit"));
  return {
    filters: {
      ...EMPTY_HISTORY_FILTERS,
      fromDate: seed.fromDate ?? "",
      toDate: seed.toDate ?? "",
      watched: seed.watched ?? "",
      search: boundedParam(params, "search", MAX_SEARCH_PARAM),
      method: oneOf(params.get("playMethod"), PLAY_METHODS) ?? "",
      platform: boundedParam(params, "platform", MAX_PLATFORM_PARAM),
      userId: boundedParam(params, "userId", MAX_USER_ID_PARAM),
    },
    grouped: params.get("ungrouped") !== "true",
    sortBy: oneOf(params.get("sortBy"), SORT_FIELDS) ?? DEFAULT_SORT_BY,
    sortDir: oneOf(params.get("sortDir"), ["asc", "desc"] as const) ?? DEFAULT_SORT_DIR,
    limit: oneOf(Number.isInteger(limitParam) ? limitParam : null, PAGE_SIZES) ?? DEFAULT_PAGE_SIZE,
    page: 1,
  };
}

// What a delete's answer means for the dialog: close it and re-read the table
// ("done" — a 404 too: the play is already gone, which is what was asked),
// leave everything as it is ("ignore": the request was dropped), or show the
// route's own reason (the rate limit's "wait a moment"), else the generic copy
// fetchJson was given.
export function deleteOutcome(res: FetchJsonResult<unknown>): { kind: "done" } | { kind: "ignore" } | { kind: "error"; message: string } {
  if (res.ok || (res.kind === "http" && res.status === 404)) return { kind: "done" };
  if (res.kind === "aborted") return { kind: "ignore" };
  return { kind: "error", message: res.error };
}

// Which loads the admin is waiting on. A load whose foreground key (the request
// minus the period's lower bound, plus a Retry/delete reload) is the one last
// asked for is a live refresh's background re-read: it must not dim the rows
// or swallow clicks. One that supersedes a foreground load still in flight (a
// refresh arriving mid-load) stays foreground, so the dimmed rows and any
// error are still settled by an answer.
export interface LoadTracker {
  lastKey: string | null;
  pending: boolean;
}

export const NEW_LOAD_TRACKER: LoadTracker = { lastKey: null, pending: false };

export function beginLoad(tracker: LoadTracker, foregroundKey: string): { background: boolean; tracker: LoadTracker } {
  const background = tracker.lastKey === foregroundKey && !tracker.pending;
  return { background, tracker: { lastKey: foregroundKey, pending: tracker.pending || !background } };
}

// An answer landed (rows or an error): nothing is pending.
export function settleLoad(tracker: LoadTracker): LoadTracker {
  return tracker.pending ? { ...tracker, pending: false } : tracker;
}
