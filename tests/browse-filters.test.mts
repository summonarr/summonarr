// The browse filter set and the filter bars' pending-change rules
// (src/lib/browse-filters.ts).
//
//   • ONE parser and ONE "any filter set?" predicate for /movies, /tv,
//     BrowseGrid and FilterBar. Four hand-written copies of the same OR chain
//     meant a new filter had to be added in four places, and a missed one made
//     the subtitle, the grid and the query disagree. The UI predicate counts
//     hideAvailable; the QUERY predicate (browse-query's browseHasFilters) must
//     not, and neither counts watchRegion alone.
//   • A filter bar keeps its in-flight changes as a delta over the committed
//     URL. The controls show committed + delta (they used to snap back for the
//     whole server round-trip, and the hide-available button toggled from the
//     stale committed value, so a second click was lost). A committed URL the
//     bar never pushed voids the delta — otherwise a filter abandoned by a pager
//     or other Link click was re-applied on the next change.
//
// The bars themselves are .tsx (no JSX transform in the loader), so their
// wiring is pinned from source at the end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // browse-query.ts pulls in prisma.ts

const {
  BROWSE_FILTER_KEYS,
  canonicalQuery,
  discoverFiltersOf,
  hasActiveFilters,
  hasQueryFilters,
  overlayBrowseFilters,
  parseBrowseFilters,
  pendingFlag,
  pendingValue,
  reconcilePending,
  withPending,
} = await import("../src/lib/browse-filters.ts");
const { browseHasFilters } = await import("../src/lib/browse-query.ts");
const { first, searchParamGetter } = await import("../src/lib/search-params.ts");

const parse = (qs: string) => {
  const p = new URLSearchParams(qs);
  return parseBrowseFilters((k) => p.get(k));
};

// ── parsing and the two predicates ──────────────────────────────────────────

test("parseBrowseFilters: empty values are unset, hideAvailable is exactly '1'", () => {
  const f = parse("genreId=28&keywordId=&sortBy=vote_average.desc&hideAvailable=true");
  assert.equal(f.genreId, "28");
  assert.equal(f.keywordId, undefined, "an empty value is 'not set', as each caller's `|| undefined` had it");
  assert.equal(f.sortBy, "vote_average.desc");
  assert.equal(f.hideAvailable, false, "only hideAvailable=1 turns it on");
  assert.equal(parse("hideAvailable=1").hideAvailable, true);
});

test("hasActiveFilters is false for no params and for watchRegion alone", () => {
  assert.equal(hasActiveFilters(parse("")), false);
  assert.equal(hasActiveFilters(parse("watchRegion=GB")), false, "a region alone narrows nothing the user asked for");
  // The *Name params only label a chip; without their id they filter nothing.
  assert.equal(hasActiveFilters(parse("keywordName=Heist&companyName=A24&networkName=HBO")), false);
});

test("hasActiveFilters is true for every filter key on its own", () => {
  const filterKeys = [
    "genreId", "keywordId", "companyId", "networkId", "certification", "minRating",
    "ratingFilter", "minVoteCount", "fromYear", "toYear", "sortBy", "watchProvider",
  ];
  for (const key of filterKeys) {
    assert.ok((BROWSE_FILTER_KEYS as readonly string[]).includes(key), `${key} is not a parsed key`);
    assert.equal(hasActiveFilters(parse(`${key}=1`)), true, `${key} alone must count as a filter`);
  }
  assert.equal(hasActiveFilters(parse("hideAvailable=1")), true, "the UI predicate counts hideAvailable");
});

test("the QUERY predicate leaves out hideAvailable and watchRegion; browse-query uses it", () => {
  assert.equal(hasQueryFilters(discoverFiltersOf(parse("hideAvailable=1"))), false);
  assert.equal(browseHasFilters(discoverFiltersOf(parse("hideAvailable=1"))), false,
    "hideAvailable alone must not flip the query from popular to discover");
  assert.equal(browseHasFilters(discoverFiltersOf(parse("watchRegion=GB"))), false);
  assert.equal(browseHasFilters({}, "imdb:7"), true, "a rating filter is a query filter");
  assert.equal(browseHasFilters(discoverFiltersOf(parse("watchProvider=8"))), true);
});

test("a page's searchParams prop reads the first value of a repeated key", () => {
  assert.equal(first(["7", "8"]), "7");
  assert.equal(first("7"), "7");
  assert.equal(first(undefined), undefined);
  const f = parseBrowseFilters(searchParamGetter({ genreId: ["28", "12"], page: "2" }));
  assert.equal(f.genreId, "28", "an array must not reach the TMDB filters");
});

// ── the pending delta ───────────────────────────────────────────────────────

test("withPending applies the delta: a value sets, undefined or '' removes", () => {
  const p = withPending("genreId=28&fromYear=1990", { fromYear: undefined, toYear: "2000", genreId: "" });
  assert.equal(p.get("genreId"), null);
  assert.equal(p.get("fromYear"), null);
  assert.equal(p.get("toYear"), "2000");
});

test("the controls show committed + pending: a pending genre overrides the committed one", () => {
  const shown = overlayBrowseFilters(parse("genreId=28&fromYear=1990"), { genreId: "12", fromYear: undefined });
  assert.equal(shown.genreId, "12");
  assert.equal(shown.fromYear, undefined, "a pending removal shows as removed");
  assert.equal(pendingValue({}, "genreId", "28"), "28", "no delta → the committed value");
});

test("a pending hideAvailable '1' shows ON, so the next toggle REMOVES it", () => {
  const committed = parse("");
  const shown = overlayBrowseFilters(committed, { hideAvailable: "1" });
  assert.equal(shown.hideAvailable, true);
  // The bar's toggle: next = shown ? undefined : "1". Reading the committed
  // (stale) value here pushed "1" a second time and lost the user's "off".
  const next = shown.hideAvailable ? undefined : "1";
  assert.equal(next, undefined);
  assert.equal(pendingFlag({ hideAvailable: undefined }, "hideAvailable", true), false);
});

test("reconcile: landed deltas are dropped, in-flight ones kept", () => {
  // Two quick changes; the first navigation commits before the second.
  const pending = { genreId: "12", fromYear: "1990" };
  const pushed = new Set([canonicalQuery("genreId=12"), canonicalQuery("genreId=12&fromYear=1990")]);
  const r = reconcilePending(pending, "genreId=12", pushed);
  assert.deepEqual(r.pending, { fromYear: "1990" }, "the year is still in flight");
  assert.equal(r.pushed.size, 2, "pushed queries are kept while anything is pending");

  const done = reconcilePending(r.pending, "fromYear=1990&genreId=12", r.pushed);
  assert.deepEqual(done.pending, {}, "key order does not matter");
  assert.equal(done.pushed.size, 0, "nothing in flight → the pushed set is forgotten");
});

test("reconcile: a committed URL the bar never pushed voids every delta", () => {
  // A pending genre change superseded by a pager Link built from the old URL.
  const pending = { genreId: "12" };
  const pushed = new Set([canonicalQuery("genreId=12")]);
  const r = reconcilePending(pending, "genreId=28&page=2", pushed);
  assert.deepEqual(r.pending, {}, "the abandoned genre must not be re-applied on the next change");
  assert.equal(r.pushed.size, 0);
});

test("reconcile: an untouched delta keeps its identity (no needless re-render)", () => {
  const pending = {};
  assert.equal(reconcilePending(pending, "a=1", new Set()).pending, pending);
  const inFlight = { genreId: "12" };
  const pushed = new Set([canonicalQuery("genreId=12&fromYear=1990"), canonicalQuery("fromYear=1990")]);
  assert.equal(reconcilePending(inFlight, "fromYear=1990", pushed).pending, inFlight);
});

// ── the bars' wiring, from source ───────────────────────────────────────────

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

test("FilterBar reads the shared overlay and toggles hide-available from what it SHOWS", () => {
  const bar = src("src/components/media/filter-bar.tsx");
  assert.match(bar, /usePendingFilters\(navigate\)/);
  assert.match(bar, /overlayBrowseFilters\(filters, pending\)/);
  assert.match(bar, /push\(\{ hideAvailable: f\.hideAvailable \? undefined : "1" \}\)/);
  assert.doesNotMatch(bar, /activeHideAvailable/, "the stale committed prop must not drive the toggle");
  assert.match(bar, /hasActiveFilters\(f\)/, "one predicate for Clear filters");
  // An unnamed provider id still gets a chip it can be removed from (the chip
  // rules are filter-bar-options.ts, tests/filter-bar-options.test.mts).
  assert.match(src("src/components/media/filter-bar-options.ts"), /activeProviderName \?\? t\("media\.filter\.serviceChip"/);
  assert.match(bar, /filterChips\(f, \{ genres, providers: sortedProviders, showCertification \}, t\)/);
  assert.match(bar, /\{chips\.length > 0 && \(/, "the chip row renders only when it has a chip");
});

test("TopFilterBar overlays the pending delta on its committed props", () => {
  const bar = src("src/components/media/top-filter-bar.tsx");
  assert.match(bar, /usePendingFilters\(startTransition\)/);
  assert.match(bar, /pendingFlag\(pending, "hideAvailable", committedHideAvailable\)/);
  assert.doesNotMatch(bar, /useRef|pendingRef/, "the delta lives in the shared hook, not a private ref");
});

test("the shared hook reconciles against the queries it pushed", () => {
  const hook = src("src/components/media/use-pending-filters.ts");
  assert.match(hook, /reconcilePending\(pendingRef\.current, committed, pushedRef\.current\)/);
  assert.match(hook, /pushedRef\.current\.add\(canonicalQuery\(qs\)\)/);
  assert.match(hook, /addEventListener\("popstate"/);
});

test("BrowseGrid parses the filters once and hands FilterBar one object", () => {
  const grid = src("src/components/media/browse-grid.tsx");
  assert.match(grid, /parseBrowseFilters\(/);
  assert.match(grid, /filters=\{filters\}/);
  assert.doesNotMatch(grid, /active[A-Z]\w+=\{/, "no per-filter active* props");
  assert.match(grid, /priority=\{i < 6\}/, "the dead `items === initialItems` term is gone");
});

test("every locale names an unlabelled streaming-service chip", () => {
  for (const locale of ["en", "es", "fr", "de", "pt", "it", "zh"]) {
    const catalog = JSON.parse(src(`src/lib/i18n/messages/${locale}/media.json`)) as Record<string, string>;
    assert.match(catalog["media.filter.serviceChip"] ?? "", /\{id\}/, `${locale} lacks media.filter.serviceChip`);
  }
});
