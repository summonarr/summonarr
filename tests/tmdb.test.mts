// Unit tests for the TMDB orchestration layer (src/lib/tmdb.ts) — the module
// every discovery grid, search box, and detail page funnels through. Sibling
// files own the layers around it, and this file deliberately does NOT re-test
// them: tests/tmdb-cache.test.mts owns getCache/setCache/TTL-registry
// semantics, tests/tmdb-cache-ttl.test.mts owns libraryDetailsTtl,
// tests/tmdb-auth.test.mts owns bearer-header shaping, tests/tmdb-types.test.mts
// owns posterUrl/backdropUrl/stillUrl/languageName, tests/tmdb-core-sync.test.mts
// owns the TmdbMediaCore writers, tests/concurrency.test.mts owns
// mapLimit/settleLimit internals, and tests/request-meta.test.mts already pins
// verifyTmdbMedia's live wire shape (404→null, no-title→null) through
// resolveMediaMeta. What THIS file pins is the module's own orchestration:
//
//  - coalesce(): concurrent same-key callers share ONE execution (same array
//    instance back), different keys don't, a settled key re-executes (in-flight
//    dedup only, not memoization), and a rejected factory doesn't poison the
//    key for the next caller;
//  - list helpers end-to-end (getTrending 5 pages, getTopRatedMovies 20 pages,
//    getUpcomingTV 10 discover pages): cache-first (seeded row ⇒ zero fetches),
//    cold fan-out wire shape (exact path, page set, v4 bearer header),
//    media_type routing + person/zero-id filtering + first-wins dedup, the
//    min-vote gate on top_rated, the today-anchored first_air_date filter on
//    upcoming TV, cache write under the fixed list key with TTL.DISCOVER, and
//    the every-page-fulfilled gate: a partial fan-out is SERVED but NOT cached
//    (unlike trakt.ts, which caches partials), an all-empty result is not
//    cached, and two concurrent cold callers share one fan-out;
//  - searchMulti: trim + lowercase cache keying, query encoding round-trip
//    (& ? : survive as one param), include_adult=false, person/junk-id
//    filtering, empty query short-circuit, empty result never negative-cached;
//  - details paths: the `movie:<id>:details` / `tv:<id>:details` key shapes and
//    that the stored blob is the NORMALIZED TmdbMedia (mediaType present) —
//    plus the c472788 self-heal: a poisoned raw-snake_case row (no mediaType,
//    written by the pre-split getMovieReleaseInfo) is treated as a MISS and
//    overwritten; US certification is extracted and kept; official-YouTube
//    trailer selection; credits sliced to 12 under `:credits`; suggestions
//    (similar-then-recommendations, self/no-poster dropped) under
//    `:suggestions`; a fresh cached row is served with zero fetches and zero
//    rewrites; object-form keyword rows are migrated and re-persisted; a TV row
//    without `seasons` is busted (tmdbCache.delete) and re-fetched with the
//    specials/placeholder seasons filtered out;
//  - discover pages: sanitizeDiscoverFilters (junk sort → popularity.desc,
//    non-digit ids dropped, minRating clamped to 0..10, year bounds 1888..2100,
//    watchRegion uppercased) feeding BOTH the outbound params and the exact
//    discoverKey cache key, movie vs tv date-param families, totalPages capped
//    at 500;
//  - degradation: no TMDB_READ_TOKEN ⇒ list helpers return [] with zero
//    fetches and cache nothing, while searchMulti propagates the error (pinned
//    as CURRENT behavior); UND_ERR_SOCKET rejections are retried twice even
//    after safe-fetch wraps them in a SafeFetchError message, and non-socket
//    network failures surface after exactly one attempt.
//
// No DB or network: prisma.tmdbCache / setting / tmdbMediaCore / $transaction
// are shadowed in-memory (tests/_helpers.mts; setting.findUnique → null keeps
// the MDBList/OMDB ratings tiers key-less so fetchUnifiedRatings degrades
// without touching the wire), globalThis.fetch is scripted per URL, and
// dns/promises.lookup is stubbed so safe-fetch's SSRF resolver never issues a
// real lookup for api.themoviedb.org.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto
process.env.TMDB_READ_TOKEN = "test-tmdb-read-token"; // tmdbAuth() reads this at call time

// ── DNS stub (see tests/trakt.test.mts for the rationale) ───────────────────
const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) {
  throw new Error("could not stub dns.lookup — aborting before a real DNS query can leave the process");
}

// ── console capture ─────────────────────────────────────────────────────────
const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// Dynamic imports so the stubs above genuinely precede the module-graph load
// (static imports would hoist — the poster-cache.test pattern).
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const {
  getTrending,
  getTopRatedMovies,
  getUpcomingTV,
  searchMulti,
  getMovieDetails,
  getTVDetails,
  discoverMoviesPage,
  discoverTVPage,
} = await import("../src/lib/tmdb.ts");

// ── prisma stubs ────────────────────────────────────────────────────────────
type CacheRow = { key: string; data: string; cachedAt: Date; expiresAt: Date };
type UpsertArgs = { where: { key: string }; create: CacheRow };

const cacheRows = new Map<string, CacheRow>();
const cacheUpserts: CacheRow[] = [];
const cacheDeletes: string[] = [];
shadowPrismaModel(prisma, "tmdbCache", {
  findUnique: async (args: { where: { key: string } }): Promise<CacheRow | null> =>
    cacheRows.get(args.where.key) ?? null,
  upsert: async (args: UpsertArgs): Promise<CacheRow> => {
    cacheUpserts.push(args.create);
    cacheRows.set(args.where.key, args.create);
    return args.create;
  },
  // getCache's lazy expiry cleanup — never triggered here (no expired seeds),
  // but must not explode if a future test adds one.
  deleteMany: async (): Promise<{ count: number }> => ({ count: 0 }),
  // getTVDetails busts seasons-less rows through a point delete.
  delete: async (args: { where: { key: string } }): Promise<{ key: string }> => {
    cacheDeletes.push(args.where.key);
    cacheRows.delete(args.where.key);
    return { key: args.where.key };
  },
});

// No MDBList/OMDB API keys configured, ever: the ratings tiers inside the
// details paths short-circuit at getApiKey() and never reach the network.
shadowPrismaModel(prisma, "setting", {
  findUnique: async (): Promise<null> => null,
});

// The fire-and-forget TmdbMediaCore sync — its internals are owned by
// tests/tmdb-core-sync.test.mts; here we only record that the helpers drive it.
const coreUpserts: { tmdbId: number; mediaType: string }[] = [];
shadowPrismaModel(prisma, "tmdbMediaCore", {
  upsert: async (args: { where: { tmdbId_mediaType: { tmdbId: number; mediaType: string } } }) => {
    coreUpserts.push(args.where.tmdbId_mediaType);
    return args;
  },
});
shadowPrismaClientMethod(prisma, "$transaction", async (ops: unknown): Promise<unknown> =>
  Array.isArray(ops) ? Promise.all(ops) : (ops as (tx: unknown) => unknown)(prisma),
);

// ── scripted fetch ──────────────────────────────────────────────────────────
// Keyed on URL + call index so per-page scripting (page 3 failing) and
// per-attempt scripting (socket error twice, then success) are both possible.
type FetchCall = { url: URL; headers: Headers };
const fetchCalls: FetchCall[] = [];
let respond: (url: URL, callIndex: number) => Response | Promise<Response> = () => {
  throw new Error("unexpected fetch — script a responder for this test");
};

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  fetchCalls.push({ url, headers: new Headers(init?.headers) });
  return respond(url, fetchCalls.length - 1);
}) as typeof fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function pageOf(results: unknown[], total_pages = 1) {
  return { results, total_pages, total_results: results.length };
}

// Raw TMDB row factories — the minimal list-item shape plus overrides.
function rawMovie(id: number, title: string, over: Record<string, unknown> = {}) {
  return {
    id, title, overview: `${title} overview`,
    poster_path: `/p${id}.jpg`, backdrop_path: `/b${id}.jpg`,
    release_date: "2021-10-22", vote_average: 7.8, vote_count: 1200,
    ...over,
  };
}
function rawTV(id: number, name: string, over: Record<string, unknown> = {}) {
  return {
    id, name, overview: `${name} overview`,
    poster_path: `/p${id}.jpg`, backdrop_path: `/b${id}.jpg`,
    first_air_date: "2019-04-01", vote_average: 8.1, vote_count: 900,
    ...over,
  };
}

function seedCache(key: string, value: unknown, expiresInMs = 60 * 60 * 1000): void {
  cacheRows.set(key, {
    key,
    data: JSON.stringify(value),
    cachedAt: new Date(Date.now() - 1000),
    expiresAt: new Date(Date.now() + expiresInMs),
  });
}

function upsertFor(key: string): CacheRow | undefined {
  return cacheUpserts.find((u) => u.key === key);
}

const HOUR_MS = 3600 * 1000;

beforeEach(() => {
  process.env.TMDB_READ_TOKEN = "test-tmdb-read-token";
  cacheRows.clear();
  cacheUpserts.length = 0;
  cacheDeletes.length = 0;
  coreUpserts.length = 0;
  fetchCalls.length = 0;
  warns.length = 0;
  errors.length = 0;
  respond = () => {
    throw new Error("unexpected fetch — script a responder for this test");
  };
});

// ── coalesce: in-flight request dedup ───────────────────────────────────────
// coalesce() is module-private; searchMulti (one fetch per execution, a fresh
// key per distinct query) is the cheapest exported window onto it.

test("coalesce: concurrent same-key callers share ONE execution and get the same array instance", async () => {
  respond = () => jsonResponse(pageOf([{ ...rawMovie(101, "Shared"), media_type: "movie" }]));
  const [a, b] = await Promise.all([
    searchMulti("coalesce shared"),
    searchMulti("coalesce shared"),
  ]);
  assert.equal(fetchCalls.length, 1); // one upstream fetch for two callers
  assert.equal(a, b); // strict identity — literally the same execution's result
  assert.equal(a[0].id, 101);
});

test("coalesce: different keys run independently", async () => {
  respond = () => jsonResponse(pageOf([{ ...rawMovie(102, "Either"), media_type: "movie" }]));
  const [a, b] = await Promise.all([searchMulti("alpha query"), searchMulti("beta query")]);
  assert.equal(fetchCalls.length, 2); // no cross-key sharing
  assert.notEqual(a, b); // distinct executions, distinct arrays
});

test("coalesce: a settled key re-executes — in-flight dedup only, not memoization", async () => {
  respond = () => jsonResponse(pageOf([{ ...rawMovie(103, "Rerun"), media_type: "movie" }]));
  const first = await searchMulti("rerun query");
  assert.equal(fetchCalls.length, 1);
  // Remove the cache write so only a leaked in-flight entry could dedupe.
  cacheRows.clear();
  const second = await searchMulti("rerun query");
  assert.equal(fetchCalls.length, 2); // the inflight map entry was cleared on settle
  assert.notEqual(first, second);
  assert.deepEqual(first, second);
});

test("coalesce: a rejected execution doesn't poison the key — the next caller retries", async () => {
  respond = () => jsonResponse({ error: "boom" }, 500);
  // searchMulti has no catch: the upstream failure propagates (current behavior).
  await assert.rejects(() => searchMulti("phoenix query"), /TMDB \/search\/multi failed: 500/);
  assert.equal(fetchCalls.length, 1); // a non-socket failure is not retried
  respond = () => jsonResponse(pageOf([{ ...rawMovie(104, "Risen"), media_type: "movie" }]));
  const result = await searchMulti("phoenix query");
  assert.equal(fetchCalls.length, 2); // fresh execution, not the stored rejection
  assert.deepEqual(result.map((m) => m.id), [104]);
});

// ── searchMulti ─────────────────────────────────────────────────────────────

test("search wire shape: trimmed query round-trips encoding as ONE param; adult filter; lowercased cache key", async () => {
  respond = () => jsonResponse(pageOf([{ ...rawMovie(550, "Fight Club"), media_type: "movie" }]));
  await searchMulti("  Dune: Part Two & Friends?  ");
  assert.equal(fetchCalls.length, 1);
  const call = fetchCalls[0];
  assert.equal(call.url.origin + call.url.pathname, "https://api.themoviedb.org/3/search/multi");
  // Decoded round-trip returns the exact trimmed query — & ? : never split the param…
  assert.equal(call.url.searchParams.get("query"), "Dune: Part Two & Friends?");
  // …because the raw URL carries the & percent-encoded.
  assert.ok(call.url.search.includes("%26"), "the & must be percent-encoded on the wire");
  assert.equal(call.url.searchParams.get("include_adult"), "false");
  assert.equal(call.headers.get("authorization"), "Bearer test-tmdb-read-token");
  // The cache key is the trimmed, LOWERCASED query.
  assert.equal(cacheUpserts.length, 1);
  assert.equal(cacheUpserts[0].key, "search:dune: part two & friends?");
});

test("search routing: person rows and non-positive ids are dropped; movie/tv normalize to the exact TmdbMedia skeleton", async () => {
  respond = () =>
    jsonResponse(pageOf([
      { id: 5001, name: "Some Person", media_type: "person" },
      { ...rawMovie(0, "Zero Id"), media_type: "movie" },
      { ...rawMovie(601, "Valid Movie"), media_type: "movie" },
      { ...rawTV(602, "Valid Show"), media_type: "tv" },
    ]));
  const result = await searchMulti("routing query");
  assert.deepEqual(
    result.map((m) => [m.id, m.mediaType, m.title]),
    [[601, "movie", "Valid Movie"], [602, "tv", "Valid Show"]],
  );
  // Full skeleton pin for one of each — list items carry exactly these fields.
  assert.deepEqual(result[0], {
    id: 601, mediaType: "movie", title: "Valid Movie", overview: "Valid Movie overview",
    posterPath: "/p601.jpg", backdropPath: "/b601.jpg",
    releaseDate: "2021-10-22", releaseYear: "2021", voteAverage: 7.8, voteCount: 1200,
  });
  assert.deepEqual(result[1], {
    id: 602, mediaType: "tv", title: "Valid Show", overview: "Valid Show overview",
    posterPath: "/p602.jpg", backdropPath: "/b602.jpg",
    releaseDate: "2019-04-01", releaseYear: "2019", voteAverage: 8.1, voteCount: 900,
  });
});

test("search: an empty result is returned but never negative-cached — the next call re-fetches", async () => {
  respond = () => jsonResponse(pageOf([]));
  assert.deepEqual(await searchMulti("nothing here"), []);
  assert.equal(cacheUpserts.length, 0);
  assert.deepEqual(await searchMulti("nothing here"), []);
  assert.equal(fetchCalls.length, 2); // no negative cache to serve from
});

test("search: an empty/whitespace query short-circuits to [] without touching the network", async () => {
  assert.deepEqual(await searchMulti(""), []);
  assert.deepEqual(await searchMulti("   "), []);
  assert.equal(fetchCalls.length, 0);
});

test("search: a seeded cache row is served with zero fetches, matched case-insensitively", async () => {
  const cached = [{
    id: 42, mediaType: "movie", title: "Cached", overview: "",
    posterPath: null, backdropPath: null, releaseDate: null, releaseYear: null,
    voteAverage: 0, voteCount: 0,
  }];
  seedCache("search:cached query", cached);
  const result = await searchMulti("  CACHED Query "); // trims + lowercases onto the same key
  assert.deepEqual(result, cached);
  assert.equal(fetchCalls.length, 0);
});

// ── getTrending: the 5-page list-helper fan-out ─────────────────────────────

test("trending: a seeded list cache row is served with zero fetches", async () => {
  const cached = [{
    id: 9, mediaType: "tv", title: "From Cache", overview: "",
    posterPath: null, backdropPath: null, releaseDate: null, releaseYear: null,
    voteAverage: 0, voteCount: 0,
  }];
  seedCache("trending:week", cached);
  assert.deepEqual(await getTrending(), cached);
  assert.equal(fetchCalls.length, 0);
});

test("trending cold: 5-page fan-out wire shape, media_type routing, first-wins dedup, DISCOVER-TTL cache write, core sync", async () => {
  respond = (url) => {
    const p = url.searchParams.get("page");
    if (p === "1") {
      return jsonResponse(pageOf([
        { ...rawMovie(11, "Movie One"), media_type: "movie" },
        { id: 5001, name: "A Person", media_type: "person" },
        { ...rawTV(12, "Show One"), media_type: "tv" },
      ], 5));
    }
    if (p === "2") {
      return jsonResponse(pageOf([
        { ...rawMovie(11, "Movie One Dup"), media_type: "movie" }, // dup id — page 1 wins
        { ...rawMovie(0, "Zero Id"), media_type: "movie" },
        { ...rawMovie(13, "Movie Two"), media_type: "movie" },
      ], 5));
    }
    return jsonResponse(pageOf([], 5));
  };
  const before = Date.now();
  const result = await getTrending();
  const after = Date.now();

  assert.equal(fetchCalls.length, 5);
  for (const c of fetchCalls) {
    assert.equal(c.url.origin + c.url.pathname, "https://api.themoviedb.org/3/trending/all/week");
    assert.equal(c.headers.get("authorization"), "Bearer test-tmdb-read-token");
  }
  assert.deepEqual(
    fetchCalls.map((c) => Number(c.url.searchParams.get("page"))).sort((a, b) => a - b),
    [1, 2, 3, 4, 5],
  );
  assert.deepEqual(
    result.map((m) => [m.id, m.mediaType]),
    [[11, "movie"], [12, "tv"], [13, "movie"]],
  );
  assert.equal(result[0].title, "Movie One"); // dedup is first-wins, in page order

  // Cache write: the fixed list key, the exact result, expiry = now + TTL.DISCOVER (12h).
  const upsert = upsertFor("trending:week");
  assert.ok(upsert, "an all-fulfilled non-empty fan-out must be cached");
  assert.deepEqual(JSON.parse(upsert.data), result);
  assert.ok(
    upsert.expiresAt.getTime() >= before + 12 * HOUR_MS &&
      upsert.expiresAt.getTime() <= after + 12 * HOUR_MS,
    "list rows use TTL.DISCOVER",
  );

  // The fire-and-forget TmdbMediaCore sync was driven with the same items.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(coreUpserts.map((u) => u.tmdbId).sort((a, b) => a - b), [11, 12, 13]);
  assert.equal(errors.length, 0); // silent success (guardrail 7)
});

test("trending: two concurrent cold callers coalesce into ONE 5-page fan-out", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    respond = async () => {
      await gate; // hold every page open until both callers have registered
      return jsonResponse(pageOf([{ ...rawMovie(21, "Gated"), media_type: "movie" }], 5));
    };
    const p1 = getTrending();
    const p2 = getTrending();
    await Promise.resolve();
    release();
    const [a, b] = await Promise.all([p1, p2]);
    assert.equal(fetchCalls.length, 5); // ONE fan-out, not ten fetches
    assert.equal(a, b); // both callers got the same execution's array
  } finally {
    release(); // never leave the shared "trending:week" key stuck in-flight
  }
});

test("trending: a failed page is dropped and the partial result is SERVED but NOT cached", async () => {
  respond = (url) => {
    const p = Number(url.searchParams.get("page"));
    if (p === 3) return jsonResponse({ error: "upstream boom" }, 500);
    return jsonResponse(pageOf([{ ...rawMovie(30 + p, `Page ${p}`), media_type: "movie" }], 5));
  };
  const result = await getTrending();
  assert.equal(fetchCalls.length, 5); // every page was attempted
  assert.deepEqual(result.map((m) => m.id).sort((a, b) => a - b), [31, 32, 34, 35]);
  // The every-page-fulfilled gate: caching a truncated list for 12h would pin
  // the degradation — the next request must re-fetch instead.
  assert.equal(upsertFor("trending:week"), undefined);
});

test("trending: an all-empty (but fulfilled) fan-out returns [] and caches nothing", async () => {
  respond = () => jsonResponse(pageOf([], 5));
  assert.deepEqual(await getTrending(), []);
  assert.equal(fetchCalls.length, 5);
  assert.equal(cacheUpserts.length, 0); // result.length > 0 gates the write
});

// ── other list helpers ──────────────────────────────────────────────────────

test("top-rated movies: 20-page fan-out of /movie/top_rated with the >=200-vote gate", async () => {
  respond = (url) =>
    url.searchParams.get("page") === "1"
      ? jsonResponse(pageOf([
          rawMovie(201, "Well Voted", { vote_count: 200 }),
          rawMovie(202, "Barely Under", { vote_count: 199 }),
        ], 20))
      : jsonResponse(pageOf([], 20));
  const result = await getTopRatedMovies();
  assert.equal(fetchCalls.length, 20);
  assert.ok(fetchCalls.every((c) => c.url.pathname === "/3/movie/top_rated"));
  assert.deepEqual(
    fetchCalls.map((c) => Number(c.url.searchParams.get("page"))).sort((a, b) => a - b),
    Array.from({ length: 20 }, (_, i) => i + 1),
  );
  assert.deepEqual(result.map((m) => m.id), [201]); // 200 kept (>=), 199 dropped
  assert.equal(cacheUpserts[0]?.key, "movies:top_rated");
});

test("upcoming TV: 10 discover pages anchored on today; past/dateless rows are filtered client-side", async () => {
  const before = new Date().toISOString().slice(0, 10);
  respond = (url) =>
    url.searchParams.get("page") === "1"
      ? jsonResponse(pageOf([
          rawTV(301, "Future Premiere", { first_air_date: "2999-06-01" }),
          rawTV(302, "Long Runner", { first_air_date: "1994-09-22" }), // TMDB returns it; we drop it
          rawTV(303, "No Date", { first_air_date: undefined }),
        ], 10))
      : jsonResponse(pageOf([], 10));
  const result = await getUpcomingTV();
  const after = new Date().toISOString().slice(0, 10);

  assert.equal(fetchCalls.length, 10);
  const call = fetchCalls[0];
  assert.equal(call.url.pathname, "/3/discover/tv");
  assert.equal(call.url.searchParams.get("include_adult"), "false");
  assert.equal(call.url.searchParams.get("sort_by"), "popularity.desc");
  const gte = call.url.searchParams.get("first_air_date.gte");
  assert.ok(gte === before || gte === after, "first_air_date.gte must be today's date");
  assert.deepEqual(result.map((m) => m.id), [301]);
  assert.equal(cacheUpserts[0]?.key, "tv:upcoming");
});

// ── details paths ───────────────────────────────────────────────────────────

test("movie details cold: append_to_response wire, certification kept, official trailer, collection, 3 cache writes with DETAILS TTL", async () => {
  respond = () =>
    jsonResponse({
      ...rawMovie(603, "The Matrix", { release_date: "1999-03-31" }),
      release_dates: {
        results: [
          { iso_3166_1: "DE", release_dates: [{ certification: "16", type: 3 }] },
          // The US entry's first row has no certification — the extractor must
          // skip it and keep the first NON-EMPTY one.
          { iso_3166_1: "US", release_dates: [{ certification: "", type: 1 }, { certification: "R", type: 3 }] },
        ],
      },
      videos: {
        results: [
          { key: "teaser-official", site: "YouTube", type: "Teaser", official: true },
          { key: "unofficial-trailer", site: "YouTube", type: "Trailer", official: false },
          { key: "official-trailer", site: "YouTube", type: "Trailer", official: true },
          { key: "vimeo-trailer", site: "Vimeo", type: "Trailer", official: true },
        ],
      },
      belongs_to_collection: { id: 2344, name: "The Matrix Collection" },
      credits: {
        cast: Array.from({ length: 13 }, (_, i) => ({
          id: 900 + i, name: `Actor ${i}`, character: `Role ${i}`,
          profile_path: i === 0 ? "/a0.jpg" : null, order: i,
        })),
      },
      similar: {
        results: [
          rawMovie(603, "Self Reference"), // the title itself never suggests itself
          rawMovie(604, "Similar One"),
          rawMovie(605, "No Poster", { poster_path: null }), // posterless dropped
        ],
      },
      recommendations: { results: [rawMovie(604, "Duplicate"), rawMovie(606, "Rec One")] },
      keywords: { keywords: [{ id: 1, name: "cyberpunk" }, { id: 2, name: "simulation" }] },
    });

  const before = Date.now();
  const result = await getMovieDetails(603);
  const after = Date.now();

  assert.equal(fetchCalls.length, 1);
  const call = fetchCalls[0];
  assert.equal(call.url.pathname, "/3/movie/603");
  assert.equal(
    call.url.searchParams.get("append_to_response"),
    "release_dates,videos,credits,recommendations,similar,keywords,watch/providers,external_ids",
  );

  assert.equal(result.mediaType, "movie");
  assert.equal(result.certification, "R"); // US, first non-empty cert
  assert.equal(result.trailerKey, "official-trailer"); // official YouTube Trailer beats teaser/unofficial/Vimeo
  assert.equal(result.collectionId, 2344);
  assert.equal(result.collectionName, "The Matrix Collection");
  assert.deepEqual(result.keywords, ["cyberpunk", "simulation"]);
  // No ratings key configured → fields stay UNDEFINED (not null), so a later
  // read with a key configured can still lazily fetch them.
  assert.equal(result.imdbRating, undefined);

  // Exactly three cache writes: details + credits + suggestions, movie-prefixed.
  assert.deepEqual(
    cacheUpserts.map((u) => u.key).sort(),
    ["movie:603:credits", "movie:603:details", "movie:603:suggestions"],
  );
  const details = upsertFor("movie:603:details");
  assert.ok(details);
  assert.equal((JSON.parse(details.data) as { mediaType?: string }).mediaType, "movie"); // normalized blob, not raw TMDB
  assert.ok(
    details.expiresAt.getTime() >= before + 7 * 24 * HOUR_MS &&
      details.expiresAt.getTime() <= after + 7 * 24 * HOUR_MS,
    "details rows use TTL.DETAILS (7d)",
  );
  const credits = JSON.parse(upsertFor("movie:603:credits")!.data) as unknown[];
  assert.equal(credits.length, 12); // sliced from 13
  assert.deepEqual(credits[0], { id: 900, name: "Actor 0", character: "Role 0", profilePath: "/a0.jpg" });
  const suggestions = JSON.parse(upsertFor("movie:603:suggestions")!.data) as { id: number }[];
  assert.deepEqual(suggestions.map((s) => s.id), [604, 606]); // similar first, dedup, self/posterless dropped
});

test("movie details self-heal: a poisoned raw row (no mediaType) is a MISS and is overwritten normalized", async () => {
  // The pre-key-split getMovieReleaseInfo wrote the RAW snake_case TMDB body
  // under movie:<id>:details. Serving it would hand callers a shape with
  // mediaType/posterPath/releaseDate undefined for the rest of the 7-day TTL.
  seedCache("movie:777:details", {
    id: 777, title: "Poisoned", release_date: "2001-01-01",
    poster_path: "/x.jpg", vote_average: 6, vote_count: 10,
  });
  respond = () => jsonResponse(rawMovie(777, "Healed"));
  const result = await getMovieDetails(777);
  assert.equal(fetchCalls.length, 1); // the poisoned row did NOT serve
  assert.equal(result.title, "Healed");
  assert.equal(result.mediaType, "movie");
  const rewritten = JSON.parse(cacheRows.get("movie:777:details")!.data) as { mediaType?: string; title?: string };
  assert.equal(rewritten.mediaType, "movie"); // overwritten with the normalized shape
  assert.equal(rewritten.title, "Healed");
});

test("movie details cached: a fresh normalized row (ratings pinned null) serves with zero fetches and zero rewrites", async () => {
  const cachedMedia = {
    id: 888, mediaType: "movie", title: "Cached Film", overview: "o",
    posterPath: "/c.jpg", backdropPath: null, releaseDate: "2010-01-01", releaseYear: "2010",
    voteAverage: 7, voteCount: 100, trailerKey: null,
    // All three lazy-upgrade triggers present-and-null ⇒ no ratings re-fetch.
    imdbRating: null, rtAudienceScore: null, mdblistScore: null,
    // String-form keywords ⇒ no shape migration.
    keywords: ["one"], keywordList: [{ id: 1, name: "one" }],
  };
  seedCache("movie:888:details", cachedMedia);
  const result = await getMovieDetails(888);
  assert.deepEqual(result, cachedMedia);
  assert.equal(fetchCalls.length, 0);
  assert.equal(cacheUpserts.length, 0); // nothing changed ⇒ no needless rewrite
});

test("movie details cached: object-form keywords are migrated to names + keywordList and RE-PERSISTED", async () => {
  seedCache("movie:889:details", {
    id: 889, mediaType: "movie", title: "Old Keywords", overview: "",
    posterPath: null, backdropPath: null, releaseDate: "2015-05-05", releaseYear: "2015",
    voteAverage: 6.5, voteCount: 50, trailerKey: null,
    imdbRating: null, rtAudienceScore: null, mdblistScore: null,
    keywords: [{ id: 1, name: "heist" }, { id: 2, name: "crew" }], // pre-split object form
  });
  const result = await getMovieDetails(889);
  assert.equal(fetchCalls.length, 0);
  assert.deepEqual(result.keywords, ["heist", "crew"]); // native clients decode [String]?
  assert.deepEqual(result.keywordList, [{ id: 1, name: "heist" }, { id: 2, name: "crew" }]);
  const rewrite = upsertFor("movie:889:details");
  assert.ok(rewrite, "the migrated shape must be written back");
  assert.deepEqual((JSON.parse(rewrite.data) as { keywords: unknown }).keywords, ["heist", "crew"]);
});

test("TV details: a cached row without seasons is BUSTED (point delete) and re-fetched; seasons/cert normalize", async () => {
  seedCache("tv:100:details", {
    id: 100, mediaType: "tv", title: "Old Row", overview: "",
    posterPath: null, backdropPath: null, releaseDate: "2019-04-01", releaseYear: "2019",
    voteAverage: 8, voteCount: 500, // no `seasons` field — pre-seasons-era row
  });
  respond = () =>
    jsonResponse({
      ...rawTV(100, "Fresh Show"),
      content_ratings: {
        results: [{ iso_3166_1: "GB", rating: "15" }, { iso_3166_1: "US", rating: "TV-MA" }],
      },
      seasons: [
        { season_number: 0, episode_count: 8, air_date: null, poster_path: null, name: "Specials", overview: "" },
        { season_number: 1, episode_count: 10, air_date: "2019-04-01", poster_path: "/s1.jpg", name: undefined, overview: "intro" },
        { season_number: 2, episode_count: 0, air_date: null, poster_path: null, name: "Placeholder", overview: "" },
      ],
    });
  const result = await getTVDetails(100);

  assert.deepEqual(cacheDeletes, ["tv:100:details"]); // the stale row was busted
  assert.equal(fetchCalls.length, 1);
  const call = fetchCalls[0];
  assert.equal(call.url.pathname, "/3/tv/100");
  assert.equal(
    call.url.searchParams.get("append_to_response"),
    "content_ratings,videos,credits,recommendations,similar,seasons,keywords,watch/providers,external_ids",
  );
  assert.equal(result.mediaType, "tv");
  assert.equal(result.certification, "TV-MA"); // US content rating
  // Season 0 (specials) and zero-episode placeholders are dropped; a missing
  // name falls back to "Season <n>".
  assert.deepEqual(result.seasons, [
    { seasonNumber: 1, episodeCount: 10, airDate: "2019-04-01", posterPath: "/s1.jpg", name: "Season 1", overview: "intro" },
  ]);
  const rewritten = JSON.parse(cacheRows.get("tv:100:details")!.data) as { mediaType?: string; seasons?: unknown[] };
  assert.equal(rewritten.mediaType, "tv");
  assert.equal(rewritten.seasons?.length, 1);
});

// ── discover pages: filter sanitization → params AND cache key ──────────────

test("discover movies: junk filters are sanitized out of BOTH the wire params and the cache key; totalPages caps at 500", async () => {
  respond = () => jsonResponse(pageOf([rawMovie(41, "Disc Movie"), rawMovie(0, "Bad Id")], 812));
  const result = await discoverMoviesPage(
    {
      sortBy: "sneaky.desc",   // not allowlisted → popularity.desc
      genreId: "28,12",        // digit list → kept
      keywordId: "abc",        // non-digits → dropped
      minRating: "7.5",        // kept, canonical numeric form
      minVoteCount: "12x",     // non-integer → dropped
      fromYear: "1800",        // < 1888 → dropped
      toYear: "2030",          // kept
      watchProvider: "8",      // kept
      watchRegion: "us",       // uppercased
    },
    0, // pages clamp up to 1
  );

  assert.equal(fetchCalls.length, 1);
  const sp = fetchCalls[0].url.searchParams;
  assert.equal(fetchCalls[0].url.pathname, "/3/discover/movie");
  assert.equal(sp.get("include_adult"), "false");
  assert.equal(sp.get("sort_by"), "popularity.desc");
  assert.equal(sp.get("page"), "1");
  assert.equal(sp.get("with_genres"), "28,12");
  assert.equal(sp.get("with_keywords"), null);
  assert.equal(sp.get("vote_average.gte"), "7.5");
  assert.equal(sp.get("vote_count.gte"), null);
  assert.equal(sp.get("primary_release_date.gte"), null);
  assert.equal(sp.get("primary_release_date.lte"), "2030-12-31");
  assert.equal(sp.get("with_watch_providers"), "8");
  assert.equal(sp.get("watch_region"), "US");

  assert.deepEqual(result.items.map((i) => i.id), [41]); // junk-id row dropped
  assert.equal(result.totalPages, 500); // 812 clamped
  // The sanitized values — not the raw junk — form the cache key, so junk
  // inputs can't mint unbounded distinct TmdbCache rows.
  assert.equal(cacheUpserts[0]?.key, "discover:movie:popularity.desc:28,12::7.5:::2030:8:US:page:1");
});

test("discover TV: first_air_date param family, allowlisted sort passes through, minRating clamps to 10", async () => {
  respond = () => jsonResponse(pageOf([rawTV(42, "Disc Show")], 3));
  const result = await discoverTVPage(
    { sortBy: "first_air_date.desc", genreId: "16", fromYear: "1999", toYear: "2001", minRating: "15" },
    2,
  );

  const sp = fetchCalls[0].url.searchParams;
  assert.equal(fetchCalls[0].url.pathname, "/3/discover/tv");
  assert.equal(sp.get("sort_by"), "first_air_date.desc"); // allowlisted value survives
  assert.equal(sp.get("page"), "2");
  assert.equal(sp.get("first_air_date.gte"), "1999-01-01");
  assert.equal(sp.get("first_air_date.lte"), "2001-12-31");
  assert.equal(sp.get("primary_release_date.gte"), null); // the movie param family never leaks into TV
  assert.equal(sp.get("vote_average.gte"), "10"); // 15 clamped into 0..10
  assert.equal(result.totalPages, 3); // under the cap → untouched
  assert.equal(cacheUpserts[0]?.key, "discover:tv:first_air_date.desc:16::10::1999:2001:::page:2");
});

// ── degradation: missing token, transient socket errors ─────────────────────

test("no TMDB_READ_TOKEN: list helpers degrade to [] with ZERO fetches and cache nothing", async () => {
  delete process.env.TMDB_READ_TOKEN;
  const result = await getTrending();
  assert.deepEqual(result, []);
  assert.equal(fetchCalls.length, 0); // tmdbFetch throws before any network call
  assert.equal(cacheUpserts.length, 0); // the degraded [] must not be cached
});

test("PINS CURRENT BEHAVIOR: no TMDB_READ_TOKEN makes searchMulti REJECT (lists degrade, search propagates)", async () => {
  delete process.env.TMDB_READ_TOKEN;
  await assert.rejects(() => searchMulti("tokenless query"), /No TMDB credentials configured/);
  assert.equal(fetchCalls.length, 0);
});

test("UND_ERR_SOCKET rejections retry twice — the marker survives safe-fetch's error wrapping", async () => {
  respond = (_url, callIndex) => {
    if (callIndex < 2) {
      // Undici-shaped transient reset. safe-fetch wraps it in a SafeFetchError
      // whose message embeds the cause code — tmdbFetch's retry detection must
      // still see it there.
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } });
    }
    return jsonResponse(pageOf([{ ...rawMovie(71, "Third Try"), media_type: "movie" }]));
  };
  const result = await searchMulti("retry query");
  assert.equal(fetchCalls.length, 3); // two resets retried, third attempt served
  assert.deepEqual(result.map((m) => m.id), [71]);
});

test("a non-socket network failure is NOT retried — it surfaces after exactly one attempt", async () => {
  respond = () => {
    throw new TypeError("fetch failed"); // no UND_ERR_SOCKET cause
  };
  await assert.rejects(() => searchMulti("hard fail query"), /fetch failed for/);
  assert.equal(fetchCalls.length, 1);
});
