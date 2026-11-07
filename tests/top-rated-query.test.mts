// The top-rated pool behind /top and /api/top-rated (src/lib/top-rated.ts).
//
// The page and the route each had a copy of this pipeline and the copies
// drifted. What is pinned here, all through the one shared module:
//
//   • THE DEFAULT VIEW IS ONE ORDER ACROSS PAGES. With no filter and the
//     default IMDb sort, the pool used to be sliced in source order (TMDB's
//     top-rated lists, then Trakt POPULAR, then MDBList) and only each 36-title
//     page sorted. A title rated 9.9 sitting 40th in source order showed on
//     page 2 under 7s on page 1. The whole pool is now ordered by CACHED IMDb
//     rating — a cache read only, never an upstream call — before paging.
//   • HIDDEN TITLES LEAVE THE POOL BEFORE PAGING. Removed per page (by
//     attachAllAvailability), pages came back short and totalMovies still
//     counted them (the rule guardrail 35a states for server-hidden titles).
//   • The posterless backfill is two `tmdbId IN` lists, never one OR clause
//     per title (every Trakt title is posterless: ~1,000 clauses a request).
//   • A junk year, mediaType or sort is "not set", and a title with no year is
//     outside EITHER year bound (it used to fail fromYear but pass toYear).
//
// No DB, no network: the source lists are served from a stubbed TmdbCache,
// every enrichment delegate is shadowed in-memory (tests/browse-query.test.mts
// pattern), and any outbound fetch fails the test.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.TMDB_READ_TOKEN = "test-token";

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const {
  TOP_RATED_PER_PAGE,
  applyFilters,
  backfillMetadata,
  parseTopRatedQuery,
  runTopRatedQuery,
} = await import("../src/lib/top-rated.ts");
type TmdbMedia = import("../src/lib/tmdb-types.ts").TmdbMedia;
type SummonarrSession = import("../src/lib/api-auth.ts").SummonarrSession;

const errors: string[] = [];
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// Every title in the scripted pool is cached, so ANY fetch is an upstream call
// the default view must not make.
let fetchCalls = 0;
globalThis.fetch = (async () => {
  fetchCalls++;
  return new Response("{}", { status: 500 });
}) as unknown as typeof fetch;

// ── the pool ────────────────────────────────────────────────────────────────

const POOL_SIZE = 45;
// Source order = id order, and vote averages fall with it, so "unrated titles
// keep source order" is observable.
function poolItem(id: number): TmdbMedia {
  return {
    id,
    mediaType: "movie",
    title: `Movie ${id}`,
    overview: "",
    posterPath: `/p${id}.jpg`,
    backdropPath: null,
    releaseDate: "2000-01-01",
    releaseYear: "2000",
    voteAverage: 9 - id / 100,
    voteCount: 5000,
  };
}
const pool = Array.from({ length: POOL_SIZE }, (_, i) => poolItem(i + 1));

/** Cached IMDb ratings by tmdbId; every other title reads as "no ratings". */
let imdb = new Map<number, string>();
/** Titles with NO ratings row at all — a true cache miss. */
let uncached = new Set<number>();
let hiddenRows: Array<{ tmdbId: number; mediaType: "MOVIE" | "TV" }> = [];
let coreReads: Array<{ where: unknown }> = [];

const FRESH = () => new Date(Date.now() + 60 * 60 * 1000);
shadowPrismaModel(prisma, "tmdbCache", {
  // The source lists: TMDB's movie top-rated list is the pool; every other
  // list key is a miss (and with no Trakt/MDBList key configured, empty).
  findUnique: async (args: { where: { key: string } }) =>
    args.where.key === "movies:top_rated"
      ? { key: args.where.key, data: JSON.stringify(pool), cachedAt: new Date(), expiresAt: FRESH() }
      : null,
  // The ratings warm cache. Always a FRESH hit (a value or a "not found"
  // sentinel): a miss would send attachRatingsUnified into after(), which has
  // no request scope here.
  findMany: async (args: { where: { key: { in: string[] } } }) =>
    args.where.key.in.filter((key) => !uncached.has(Number(key.split(":").pop()))).map((key) => {
      const id = Number(key.split(":").pop());
      const rating = key.startsWith("mdblist:") ? imdb.get(id) : undefined;
      return {
        key,
        data: JSON.stringify(rating ? { imdbRating: rating } : { _notFound: true }),
        cachedAt: new Date(),
        expiresAt: FRESH(),
      };
    }),
  upsert: async () => ({}),
  deleteMany: async () => ({ count: 0 }),
});
shadowPrismaModel(prisma, "tmdbMediaCore", {
  findMany: async (args: { where: unknown }) => {
    coreReads.push(args);
    return [];
  },
  upsert: async () => ({}),
  createMany: async () => ({ count: 0 }),
  updateMany: async () => ({ count: 0 }),
});
shadowPrismaModel(prisma, "hiddenItem", { findMany: async () => hiddenRows });
for (const m of [
  "plexLibraryItem", "jellyfinLibraryItem", "radarrWantedItem", "radarrAvailableItem",
  "sonarrWantedItem", "sonarrAvailableItem", "mediaRequest", "blacklistItem",
]) {
  shadowPrismaModel(prisma, m, { findMany: async () => [] });
}
shadowPrismaModel(prisma, "user", { findUnique: async () => null });
shadowPrismaModel(prisma, "setting", {
  findMany: async () => [],
  findUnique: async () => null,
});

function session(): SummonarrSession {
  return { user: { id: "u1", role: "USER", permissions: 1n, mediaServer: "plex" } } as unknown as SummonarrSession;
}
const MOVIES_ONLY = parseTopRatedQuery((k) => (k === "mediaType" ? "movies" : null));

beforeEach(() => {
  imdb = new Map();
  uncached = new Set();
  hiddenRows = [];
  coreReads = [];
  fetchCalls = 0;
  errors.length = 0;
});

// ── the default view's order ────────────────────────────────────────────────

test("default view: the whole pool is ordered by cached IMDb rating BEFORE paging", async () => {
  imdb = new Map([[40, "9.9"], [2, "7.0"]]);
  const p1 = await runTopRatedQuery({ query: MOVIES_ONLY, page: 1, session: session() });
  assert.equal(p1.movies.length, TOP_RATED_PER_PAGE);
  assert.deepEqual(
    p1.movies.slice(0, 3).map((m) => m.id),
    [40, 2, 1],
    "the 40th title in source order, rated highest, leads page 1; unrated titles follow in source order",
  );
  const p2 = await runTopRatedQuery({ query: MOVIES_ONLY, page: 2, session: session() });
  assert.ok(!p2.movies.some((m) => m.id === 40 || m.id === 2), "a rated title is never pushed to a later page");
  assert.equal(p1.movies.length + p2.movies.length, POOL_SIZE, "the two pages partition the pool");
  assert.equal(p1.totalMovies, POOL_SIZE);
});

test("default view: ordering the pool is a cache read — an uncached title off the page warms nothing", async () => {
  // Titles 37-45 (page 2) have no ratings row. Ordering must treat them as
  // unrated, not fetch them: a blocking read would call upstream here, and a
  // deferred warm needs after(), which has no request scope in this test.
  // Only the visible page is enriched, and every title on it is cached.
  for (let id = 37; id <= POOL_SIZE; id++) uncached.add(id);
  const r = await runTopRatedQuery({ query: MOVIES_ONLY, page: 1, session: session() });
  assert.deepEqual(r.movies.map((m) => m.id), Array.from({ length: TOP_RATED_PER_PAGE }, (_, i) => i + 1));
  assert.equal(fetchCalls, 0, "ordering the pool must not call MDBList/OMDb/TMDB");
});

// ── hidden titles ───────────────────────────────────────────────────────────

test("a hidden title leaves the pool before paging: page 1 stays full and the total drops by one", async () => {
  hiddenRows = [{ tmdbId: 5, mediaType: "MOVIE" }]; // inside the first 36
  const r = await runTopRatedQuery({ query: MOVIES_ONLY, page: 1, session: session() });
  assert.equal(r.movies.length, TOP_RATED_PER_PAGE, "a hidden title must not leave a hole in the page");
  assert.ok(!r.movies.some((m) => m.id === 5));
  assert.equal(r.totalMovies, POOL_SIZE - 1, "the total must not count the hidden title");
  assert.equal(r.totalPages, Math.ceil((POOL_SIZE - 1) / TOP_RATED_PER_PAGE));
});

test("a hidden title leaves the FILTERED pool too", async () => {
  hiddenRows = [{ tmdbId: 5, mediaType: "MOVIE" }];
  const query = parseTopRatedQuery((k) => ({ mediaType: "movies", minVotes: "100" } as Record<string, string>)[k] ?? null);
  const r = await runTopRatedQuery({ query, page: 1, session: session() });
  assert.equal(r.movies.length, TOP_RATED_PER_PAGE);
  assert.equal(r.totalMovies, POOL_SIZE - 1);
});

// ── backfill ────────────────────────────────────────────────────────────────

test("the posterless backfill is at most two tmdbId IN lists, not an OR clause per title", async () => {
  const posterless = (id: number, mediaType: "movie" | "tv"): TmdbMedia => ({ ...poolItem(id), mediaType, posterPath: null });
  const items = [
    ...Array.from({ length: 500 }, (_, i) => posterless(1000 + i, "movie")),
    ...Array.from({ length: 300 }, (_, i) => posterless(5000 + i, "tv")),
  ];
  await backfillMetadata(items);
  assert.equal(coreReads.length, 1);
  const or = (coreReads[0].where as { OR: Array<{ mediaType: string; tmdbId: { in: number[] } }> }).OR;
  assert.equal(or.length, 2);
  assert.deepEqual(or.map((c) => [c.mediaType, c.tmdbId.in.length]), [["MOVIE", 500], ["TV", 300]]);
});

// ── query validation and the year bounds ────────────────────────────────────

test("a junk year, mediaType or sort is 'not set'", () => {
  const q = (params: Record<string, string>) => parseTopRatedQuery((k) => params[k] ?? null);
  assert.equal(q({ fromYear: "99" }).fromYear, undefined);
  assert.equal(q({ fromYear: "abc" }).fromYear, undefined);
  assert.equal(q({ toYear: "20001" }).toYear, undefined);
  assert.equal(q({ fromYear: "1999" }).fromYear, "1999");
  assert.equal(q({ mediaType: "foo" }).mediaType, undefined, "an unknown type shows both sections, so it is no filter");
  assert.equal(q({ mediaType: "tv" }).mediaType, "tv");
  assert.equal(q({ sortBy: "bogus" }).sortBy, "imdb");
  assert.equal(q({ minImdb: "x7" }).minImdb, undefined);
  assert.equal(q({ minImdb: "7.5" }).minImdb, "7.5");
});

test("a title with no year is outside EITHER year bound", () => {
  const items = [
    { ...poolItem(1), releaseYear: "1995" },
    { ...poolItem(2), releaseYear: null },
    { ...poolItem(3), releaseYear: "" },
  ];
  const base = { hideAvailable: false, showPlex: true, showJellyfin: true };
  assert.deepEqual(applyFilters(items, { ...base, fromYear: "1990" }).map((m) => m.id), [1]);
  assert.deepEqual(applyFilters(items, { ...base, toYear: "2000" }).map((m) => m.id), [1],
    "toYear alone must exclude the undated titles just as fromYear does");
  assert.deepEqual(applyFilters(items, base).map((m) => m.id), [1, 2, 3], "no bound, no year filter");
});

// ── one pipeline ────────────────────────────────────────────────────────────

test("/top and /api/top-rated share the pipeline instead of carrying copies", () => {
  for (const rel of ["src/app/(app)/top/page.tsx", "src/app/api/top-rated/route.ts"]) {
    const src = readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
    assert.match(src, /from "@\/lib\/top-rated"/, `${rel} must use the shared module`);
    assert.match(src, /runTopRatedQuery\(/);
    assert.match(src, /parseTopRatedQuery\(/);
    for (const fn of ["backfillMetadata", "applyFilters", "sortByRating", "dedup"]) {
      assert.doesNotMatch(src, new RegExp(`function ${fn}\\b`), `${rel} still defines its own ${fn}`);
    }
  }
});
