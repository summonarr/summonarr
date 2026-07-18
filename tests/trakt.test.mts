// Unit tests for the Trakt response parsers (src/lib/trakt.ts) — the
// normalizeMovie/normalizeShow mapping that turns Trakt API rows into the
// TmdbMedia shape every discovery grid renders, exercised through the exported
// list functions (the parsers are module-private). The contracts pinned here:
//   - a Trakt row maps to EXACTLY the TmdbMedia skeleton the grids expect:
//     id = ids.tmdb, mediaType movie/tv, releaseYear = String(year), and the
//     TMDB-only fields (overview/posterPath/backdropPath/releaseDate) pinned
//     to their empty defaults — a drift here breaks every card render;
//   - rows without a tmdb id are silently dropped (no TMDB id ⇒ no way to
//     enrich from the TMDB cache), and duplicate tmdb ids dedup first-wins;
//   - missing optional fields degrade (year null/absent → releaseYear null,
//     absent title → "");
//   - trending rows are wrapped ({ watchers, movie|show }) and are unwrapped
//     before normalization;
//   - a malformed entry (no `ids` object at all) throws inside the map and the
//     whole call degrades to [] via the catch — pinned as CURRENT behavior;
//   - fetchPages settles per-page: a failed page is dropped, fulfilled pages
//     survive;
//   - non-empty results are cached (TmdbCache upsert) and served from cache on
//     the next call; empty results are NOT cached; no API key ⇒ [] with no
//     fetch. A 429 trips the in-process lockout (tested LAST — module-global).
//
// No DB or network: prisma.setting / prisma.tmdbCache are shadowed in-memory
// (tests/_helpers.mts), globalThis.fetch is scripted per URL, and
// dns/promises.lookup is stubbed so the safe-fetch SSRF resolver never issues
// a real lookup for api.trakt.tv.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto

// ── DNS stub (see tests/omdb-quota.test.mts for the rationale) ──────────────
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
// (static imports would hoist above them — the poster-cache.test pattern).
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const {
  getTraktPopularMovies,
  getTraktPopularTV,
  getTraktTrendingMovies,
  getTraktTrendingTV,
  testTraktConnection,
} = await import("../src/lib/trakt.ts");

// ── prisma stubs ────────────────────────────────────────────────────────────
let traktClientId: string | null = "test-trakt-client-id";
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) =>
    args.where.key === "traktClientId" && traktClientId !== null
      ? { key: "traktClientId", value: traktClientId }
      : null,
});

type CacheRow = { key: string; data: string; cachedAt: Date; expiresAt: Date };
const cacheRows = new Map<string, CacheRow>();
const cacheUpserts: CacheRow[] = [];
shadowPrismaModel(prisma, "tmdbCache", {
  findUnique: async (args: { where: { key: string } }) => cacheRows.get(args.where.key) ?? null,
  upsert: async (args: { where: { key: string }; create: CacheRow }) => {
    cacheUpserts.push(args.create);
    cacheRows.set(args.where.key, args.create);
    return args.create;
  },
  deleteMany: async (args: { where: { key: string } }) => {
    cacheRows.delete(args.where.key);
    return { count: 1 };
  },
});

// ── scripted fetch ──────────────────────────────────────────────────────────
// The responder is keyed on the request URL so per-page scripting (page=1 ok,
// page=2 failing) is possible. Headers are captured for the wire-shape pin.
type FetchCall = { url: URL; headers: Headers };
const fetchCalls: FetchCall[] = [];
let respond: (url: URL) => Response = () => {
  throw new Error("unexpected fetch — script a responder for this test");
};

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  fetchCalls.push({ url, headers: new Headers(init?.headers) });
  return respond(url);
}) as typeof fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  traktClientId = "test-trakt-client-id";
  cacheRows.clear();
  cacheUpserts.length = 0;
  fetchCalls.length = 0;
  respond = () => {
    throw new Error("unexpected fetch — script a responder for this test");
  };
});

// Trakt row factories. `ids` carries more than tmdb in real responses; the
// extra ids must be ignored, not leak into the output.
function movieRow(tmdb: number | undefined, title?: string, year: number | null = 2021) {
  return { title, year, ids: { trakt: 9000 + (tmdb ?? 0), slug: "s", imdb: "tt1", tmdb } };
}
function showRow(tmdb: number | undefined, title?: string, year: number | null = 2019) {
  return { title, year, ids: { trakt: 9000 + (tmdb ?? 0), slug: "s", imdb: "tt2", tmdb } };
}

// ── mapping contracts ───────────────────────────────────────────────────────

test("a full movie row maps to the exact TmdbMedia skeleton (and the wire shape is pinned)", async () => {
  respond = () => jsonResponse([movieRow(438631, "Dune", 2021)]);
  const result = await getTraktPopularMovies(1);
  assert.deepEqual(result, [
    {
      id: 438631,
      mediaType: "movie",
      title: "Dune",
      overview: "",
      posterPath: null,
      backdropPath: null,
      releaseDate: null,
      releaseYear: "2021",
      voteAverage: 0,
    },
  ]);
  // Wire shape: one page, Trakt v2 headers, the configured client id as key.
  assert.equal(fetchCalls.length, 1);
  const call = fetchCalls[0];
  assert.equal(call.url.origin + call.url.pathname, "https://api.trakt.tv/movies/popular");
  assert.equal(call.url.searchParams.get("page"), "1");
  assert.equal(call.url.searchParams.get("limit"), "100");
  assert.equal(call.headers.get("trakt-api-version"), "2");
  assert.equal(call.headers.get("trakt-api-key"), "test-trakt-client-id");
});

test("a show row maps with mediaType 'tv'", async () => {
  respond = () => jsonResponse([showRow(1399, "Game of Thrones", 2011)]);
  const result = await getTraktPopularTV(1);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 1399);
  assert.equal(result[0].mediaType, "tv");
  assert.equal(result[0].releaseYear, "2011");
});

test("rows without a tmdb id are dropped; the rest of the page survives", async () => {
  respond = () =>
    jsonResponse([movieRow(undefined, "Obscure Festival Cut"), movieRow(603, "The Matrix", 1999)]);
  const result = await getTraktPopularMovies(1);
  assert.deepEqual(result.map((m) => m.id), [603]);
});

test("missing optional fields degrade: null year → releaseYear null, absent title → ''", async () => {
  respond = () =>
    jsonResponse([movieRow(11, undefined, null)]);
  const result = await getTraktPopularMovies(1);
  assert.equal(result[0].title, "");
  assert.equal(result[0].releaseYear, null);
});

test("duplicate tmdb ids dedup first-wins", async () => {
  respond = () => jsonResponse([movieRow(7, "First"), movieRow(7, "Second"), movieRow(8, "Other")]);
  const result = await getTraktPopularMovies(1);
  assert.deepEqual(result.map((m) => [m.id, m.title]), [[7, "First"], [8, "Other"]]);
});

test("trending movies unwrap the { watchers, movie } envelope", async () => {
  respond = () => jsonResponse([{ watchers: 4321, movie: movieRow(27205, "Inception", 2010) }]);
  const result = await getTraktTrendingMovies(1);
  assert.equal(fetchCalls[0].url.pathname, "/movies/trending");
  assert.deepEqual(result.map((m) => [m.id, m.title, m.mediaType]), [[27205, "Inception", "movie"]]);
});

test("trending shows unwrap the { watchers, show } envelope", async () => {
  respond = () => jsonResponse([{ watchers: 99, show: showRow(66732, "Stranger Things", 2016) }]);
  const result = await getTraktTrendingTV(1);
  assert.equal(fetchCalls[0].url.pathname, "/shows/trending");
  assert.deepEqual(result.map((m) => [m.id, m.title, m.mediaType]), [[66732, "Stranger Things", "tv"]]);
});

test("PINS CURRENT BEHAVIOR: one entry without an `ids` object degrades the whole call to []", async () => {
  // normalizeMovie reads m.ids.tmdb unguarded — a row with no ids throws
  // inside the map, the function's catch eats it, and the caller gets [].
  // Good rows on the SAME page are lost too. If drop-the-row semantics are
  // ever wanted instead, this pin is the one to flip.
  respond = () => jsonResponse([movieRow(603, "The Matrix", 1999), { title: "Broken", year: 2000 }]);
  errors.length = 0;
  const result = await getTraktPopularMovies(1);
  assert.deepEqual(result, []);
  assert.ok(errors.some((e) => e.includes("[trakt]")), "the degrade must be logged with the [trakt] scope");
  assert.equal(cacheUpserts.length, 0); // an empty result is never cached
});

// ── paging, caching, key gating ─────────────────────────────────────────────

test("a failed page is dropped while fulfilled pages survive (allSettled per page)", async () => {
  respond = (url) =>
    url.searchParams.get("page") === "2"
      ? jsonResponse({ error: "server exploded" }, 500)
      : jsonResponse([movieRow(1, "Page One")]);
  const result = await getTraktPopularMovies(2);
  assert.equal(fetchCalls.length, 2); // both pages were attempted
  assert.deepEqual(result.map((m) => m.id), [1]);
});

test("a non-empty result is cached under the list key and served from cache on the next call", async () => {
  respond = () => jsonResponse([movieRow(550, "Fight Club", 1999)]);
  const first = await getTraktPopularMovies(1);
  assert.equal(cacheUpserts.length, 1);
  assert.equal(cacheUpserts[0].key, "trakt:popular:movies");
  assert.deepEqual(JSON.parse(cacheUpserts[0].data), first);

  // Second call: cache hit, no new fetch.
  fetchCalls.length = 0;
  assert.deepEqual(await getTraktPopularMovies(1), first);
  assert.equal(fetchCalls.length, 0);
});

test("no configured client id ⇒ [] without touching the network", async () => {
  traktClientId = null;
  const result = await getTraktPopularMovies(1);
  assert.deepEqual(result, []);
  assert.equal(fetchCalls.length, 0);
});

test("testTraktConnection returns the first title and throws on an empty response", async () => {
  respond = () => jsonResponse([movieRow(157336, "Interstellar", 2014)]);
  assert.equal(await testTraktConnection(), "Interstellar");

  respond = () => jsonResponse([]);
  await assert.rejects(() => testTraktConnection(), /Empty response from Trakt/);
});

// LAST on purpose: the lockout is module-global for the process lifetime and
// would short-circuit every traktFetch in tests that run after it.
test("HTTP 429 trips the in-process lockout: [] now, and the next call skips the network", async () => {
  respond = () => jsonResponse({ error: "slow down" }, 429);
  assert.deepEqual(await getTraktPopularMovies(1), []);
  assert.ok(
    warns.some((w) => w.includes("[trakt] Quota lockout tripped")),
    "lockout trip must warn with the [trakt] scope",
  );

  fetchCalls.length = 0;
  assert.deepEqual(await getTraktPopularMovies(1), []); // lockout error → caught → []
  assert.equal(fetchCalls.length, 0);
});
