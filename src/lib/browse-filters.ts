// The /movies and /tv filter set, read ONE way by the pages, BrowseGrid and
// FilterBar. Each used to read the same sixteen params by hand and OR its own
// copy of the "any filter set?" list, so a new filter meant editing four files
// and a missed one made the subtitle, the grid and the query disagree.
//
// Client-safe on purpose (BrowseGrid and FilterBar are client components):
// nothing here may import a server-only module. browse-query.ts, which is
// server-only, takes its query predicate from here rather than the other way
// round.
import type { DiscoverFilters } from "./tmdb-types";

// Every URL param the browse filters own. The *Name params only label a chip
// (the id is the filter); watchRegion only qualifies watchProvider.
export const BROWSE_FILTER_KEYS = [
  "genreId",
  "keywordId",
  "keywordName",
  "companyId",
  "companyName",
  "networkId",
  "networkName",
  "certification",
  "minRating",
  "ratingFilter",
  "minVoteCount",
  "fromYear",
  "toYear",
  "sortBy",
  "watchProvider",
  "watchRegion",
] as const;

type BrowseFilterKey = (typeof BROWSE_FILTER_KEYS)[number];

export type BrowseFilters = { [K in BrowseFilterKey]?: string } & { hideAvailable: boolean };

// `get` is URLSearchParams.get or a page's searchParamGetter. An empty value
// is "not set", exactly as each caller's `|| undefined` treated it.
export function parseBrowseFilters(get: (key: string) => string | null | undefined): BrowseFilters {
  const out: BrowseFilters = { hideAvailable: get("hideAvailable") === "1" };
  for (const key of BROWSE_FILTER_KEYS) out[key] = get(key) || undefined;
  return out;
}

// The TMDB discover subset (no labels, no hideAvailable, no ratingFilter).
export function discoverFiltersOf(f: BrowseFilters): DiscoverFilters {
  return {
    genreId: f.genreId,
    keywordId: f.keywordId,
    companyId: f.companyId,
    networkId: f.networkId,
    certification: f.certification,
    minRating: f.minRating,
    minVoteCount: f.minVoteCount,
    fromYear: f.fromYear,
    toYear: f.toYear,
    sortBy: f.sortBy,
    watchProvider: f.watchProvider,
    watchRegion: f.watchRegion,
  };
}

// The QUERY predicate: whether TMDB must be asked through discover rather than
// the popular list. watchRegion is deliberately left out — it only qualifies
// watchProvider and must not by itself flip the query — and so is
// hideAvailable, which TMDB knows nothing about.
export function hasQueryFilters(f: DiscoverFilters & { ratingFilter?: string }): boolean {
  return !!(
    f.genreId || f.keywordId || f.companyId || f.networkId || f.certification || f.minRating || f.ratingFilter ||
    f.minVoteCount || f.fromYear || f.toYear || f.sortBy || f.watchProvider
  );
}

// The UI predicate: the query's filters plus hideAvailable. It drives the
// page subtitle, the grid's empty state and the bar's "Clear filters".
export function hasActiveFilters(f: BrowseFilters): boolean {
  return hasQueryFilters(f) || f.hideAvailable;
}

// ── pending filter changes (FilterBar, TopFilterBar) ────────────────────────
//
// A filter bar pushes a new URL and the server answers it, so `searchParams`
// (the COMMITTED url) lags every change. The bars keep the changes still in
// flight as a delta: key → new value, undefined/"" for "remove".

export type PendingDelta = Record<string, string | undefined>;

// `committed` with the delta applied — the URL a push builds, and what the
// controls show until the server render lands.
export function withPending(committed: string, pending: PendingDelta): URLSearchParams {
  const params = new URLSearchParams(committed);
  for (const [k, v] of Object.entries(pending)) {
    if (v === undefined || v === "") params.delete(k);
    else params.set(k, v);
  }
  return params;
}

// One spelling per query, so a pushed target and the URL that lands compare
// equal whatever order the keys were written in.
export function canonicalQuery(query: string | URLSearchParams): string {
  const params = new URLSearchParams(query);
  params.sort();
  return params.toString();
}

// What is still pending once the URL commits `committed`.
//
// A committed query this bar never pushed means something ELSE navigated: the
// pager or another Link on the page, Back/Forward, or the server normalising
// the value. None of the deltas will land then, and keeping them would re-apply
// a filter the user had abandoned on their next change — so all are dropped.
// A query the bar did push drops only the deltas it shows; the rest are still
// in flight (two quick changes can commit one at a time).
export function reconcilePending(
  pending: PendingDelta,
  committed: string,
  pushed: ReadonlySet<string>,
): { pending: PendingDelta; pushed: Set<string> } {
  if (!pushed.has(canonicalQuery(committed))) {
    return { pending: Object.keys(pending).length === 0 ? pending : {}, pushed: new Set() };
  }
  const current = new URLSearchParams(committed);
  let next: PendingDelta | null = null;
  for (const [k, v] of Object.entries(pending)) {
    const landed = v === undefined || v === "" ? current.get(k) === null : current.get(k) === v;
    if (!landed) continue;
    next ??= { ...pending };
    delete next[k];
  }
  const remaining = next ?? pending;
  // Nothing left in flight: forget the pushed queries too.
  return { pending: remaining, pushed: Object.keys(remaining).length === 0 ? new Set() : new Set(pushed) };
}

// A control's displayed value: the pushed-but-not-committed one when there is
// one, else the committed one. Without this a controlled <select> snapped back
// to its old value for the whole server round-trip.
export function pendingValue(pending: PendingDelta, key: string, committed: string | undefined): string | undefined {
  return Object.prototype.hasOwnProperty.call(pending, key) ? pending[key] || undefined : committed;
}

export function pendingFlag(pending: PendingDelta, key: string, committed: boolean): boolean {
  return Object.prototype.hasOwnProperty.call(pending, key) ? pending[key] === "1" : committed;
}

// The browse filters as the bar should SHOW them: committed, overlaid with
// what is in flight.
export function overlayBrowseFilters(committed: BrowseFilters, pending: PendingDelta): BrowseFilters {
  const out: BrowseFilters = { hideAvailable: pendingFlag(pending, "hideAvailable", committed.hideAvailable) };
  for (const key of BROWSE_FILTER_KEYS) out[key] = pendingValue(pending, key, committed[key]);
  return out;
}
