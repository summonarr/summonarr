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
//   - a malformed entry (no `ids` object at all) throws inside the map and the
//     whole call degrades to [] via the catch — pinned as CURRENT behavior;
//   - fetchPages settles per-page: a failed page is dropped, fulfilled pages
//     survive — but a PARTIAL fan-out is served WITHOUT being cached (the
//     all-pages-fulfilled gate, mirroring tmdb.ts's list helpers), so the next
//     call re-fetches instead of serving a 12h-pinned truncation;
//   - non-empty COMPLETE results are cached (TmdbCache upsert) and served from
//     cache on the next call; empty results are NOT cached; no API key ⇒ []
//     with no fetch; concurrent cold-cache callers share ONE fan-out via
//     coalesce (guardrail 31). A 429 trips the in-process lockout (tested
//     LAST — module-global).
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
  getTraktPopularWithStatus,
  testTraktConnection,
  clampTraktLockoutMs,
} = await import("../src/lib/trakt.ts");

// ── prisma stubs ────────────────────────────────────────────────────────────
let traktClientId: string | null = "test-trakt-client-id";
let settingReads = 0;
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    settingReads++;
    return args.where.key === "traktClientId" && traktClientId !== null
      ? { key: "traktClientId", value: traktClientId }
      : null;
  },
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
  settingReads = 0;
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

test("a malformed entry (no `ids` object, a null, a string tmdb id) is dropped — the good rows on its page survive", async () => {
  // Every row is read field by field: one bad entry used to throw inside the
  // map, and the whole page's good rows were lost with it.
  respond = () => jsonResponse([
    movieRow(603, "The Matrix", 1999),
    { title: "Broken", year: 2000 },
    null,
    { title: "String id", year: 2001, ids: { tmdb: "604" } },
  ]);
  errors.length = 0;
  const result = await getTraktPopularMovies(1);
  assert.deepEqual(result.map((m) => m.id), [603]);
  assert.deepEqual(errors, [], "nothing threw");
  assert.equal(cacheUpserts.length, 1, "the complete list is cached as usual");
});

// ── paging, caching, key gating ─────────────────────────────────────────────

test("a failed page is dropped while fulfilled pages survive (allSettled per page) — and the partial is NOT cached", async () => {
  respond = (url) =>
    url.searchParams.get("page") === "2"
      ? jsonResponse({ error: "server exploded" }, 500)
      : jsonResponse([movieRow(1, "Page One")]);
  const result = await getTraktPopularMovies(2);
  assert.equal(fetchCalls.length, 2); // both pages were attempted
  assert.deepEqual(result.map((m) => m.id), [1]);
  // The all-pages-fulfilled gate: a transiently truncated list must not be
  // pinned into TmdbCache for the 12h TTL (and the warm cron could never
  // repair it — every helper is cache-first).
  assert.equal(cacheUpserts.length, 0);

  // The next call re-fetches (no cached truncation to serve) and, with every
  // page now healthy, caches the complete result.
  fetchCalls.length = 0;
  respond = () => jsonResponse([movieRow(1, "Page One")]);
  const healed = await getTraktPopularMovies(2);
  assert.equal(fetchCalls.length, 2);
  assert.deepEqual(healed.map((m) => m.id), [1]);
  assert.equal(cacheUpserts.length, 1);
});

test("concurrent cold-cache callers share ONE page fan-out and one cache write (coalesce)", async () => {
  respond = () => jsonResponse([movieRow(550, "Fight Club", 1999)]);
  const [a, b] = await Promise.all([getTraktPopularMovies(2), getTraktPopularMovies(2)]);
  assert.equal(fetchCalls.length, 2, "one fan-out (2 pages), not two (4)");
  assert.equal(settingReads, 1, "the client id is read once for the fan-out, not once per page");
  assert.equal(cacheUpserts.length, 1, "one cache write, not a duplicate upsert");
  assert.equal(a, b, "coalesced callers get the same array instance back");
});

test("a non-empty result is cached under the list key and served from cache on the next call", async () => {
  respond = () => jsonResponse([movieRow(550, "Fight Club", 1999)]);
  // The default page count — every production caller's — keeps the plain key.
  const first = await getTraktPopularMovies();
  assert.equal(fetchCalls.length, 5);
  assert.equal(cacheUpserts.length, 1);
  assert.equal(cacheUpserts[0].key, "trakt:popular:movies");
  assert.deepEqual(JSON.parse(cacheUpserts[0].data), first);

  // Second call: cache hit, no new fetch.
  fetchCalls.length = 0;
  assert.deepEqual(await getTraktPopularMovies(), first);
  assert.equal(fetchCalls.length, 0);
});

test("two page counts never share a cache entry: a one-page list can't stand in for the five-page one", async () => {
  respond = (url) => jsonResponse([movieRow(Number(url.searchParams.get("page")), `Page ${url.searchParams.get("page")}`)]);
  const one = await getTraktPopularMovies(1);
  assert.deepEqual(one.map((m) => m.id), [1]);
  assert.equal(cacheUpserts[0].key, "trakt:popular:movies:pages=1");

  fetchCalls.length = 0;
  const two = await getTraktPopularMovies(2);
  assert.equal(fetchCalls.length, 2, "a miss: the one-page entry is not served for two pages");
  assert.deepEqual(two.map((m) => m.id), [1, 2]);
  assert.equal(cacheUpserts[1].key, "trakt:popular:movies:pages=2");
});

test("no configured client id ⇒ [] without touching the network", async () => {
  traktClientId = null;
  const result = await getTraktPopularMovies(1);
  assert.deepEqual(result, []);
  assert.equal(fetchCalls.length, 0);
});

test("the status variant tells an outage from an answer: a failed page is incomplete, no client id and a full answer are complete", async () => {
  respond = (url) =>
    url.searchParams.get("page") === "3"
      ? jsonResponse({ error: "server exploded" }, 500)
      : jsonResponse([movieRow(Number(url.searchParams.get("page")), "Row")]);
  const partial = await getTraktPopularWithStatus("movie");
  assert.equal(partial.complete, false, "a failed page leaves the list incomplete");
  assert.equal(partial.items.length, 4, "the pages that answered are still served");

  respond = () => jsonResponse([movieRow(550, "Fight Club", 1999)]);
  const whole = await getTraktPopularWithStatus("movie");
  assert.equal(whole.complete, true);
  assert.equal((await getTraktPopularWithStatus("movie")).complete, true, "a cache hit is complete");

  cacheRows.clear();
  traktClientId = null;
  const unconfigured = await getTraktPopularWithStatus("tv");
  assert.deepEqual(unconfigured, { items: [], complete: true }, "nothing to fetch is not an outage");
});

test("testTraktConnection returns the first title and throws on an empty response", async () => {
  respond = () => jsonResponse([movieRow(157336, "Interstellar", 2014)]);
  assert.equal(await testTraktConnection(), "Interstellar");

  respond = () => jsonResponse([]);
  await assert.rejects(() => testTraktConnection(), /Empty response from Trakt/);
});

// LAST on purpose: the lockout is module-global for the process lifetime and
// would short-circuit every traktFetch in tests that run after it.
test("HTTP 429 trips the in-process lockout: [] now, and the next call skips the network; Retry-After tunes the window", async () => {
  // First a 429 carrying Retry-After: Trakt's rate windows are short and it
  // sends the header, so a fixed 1h lockout over-suspends a transient burst. A
  // 5s value clamps up to the 30s floor (0.5 min) — far enough below the 1h
  // fallback that the warn text discriminates the two paths. The lockout is
  // module-global, so this one 429 also satisfies the "next call skips the
  // network" contract and leaves the lockout tripped for the bypass pin below.
  respond = () =>
    new Response(JSON.stringify({ error: "slow down" }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "5" },
    });
  assert.deepEqual(await getTraktPopularMovies(1), []);
  assert.ok(
    warns.some((w) => /\[trakt\] Quota lockout tripped .* suspending calls for 0\.5 min/.test(w)),
    `the honored Retry-After (5s → 30s floor = 0.5 min) must show in the warn, got: ${JSON.stringify(warns)}`,
  );
  assert.ok(
    !warns.some((w) => w.includes("suspending calls for 60.0 min")),
    "a present Retry-After must NOT fall back to the 1h ceiling",
  );

  // Inside the honored window a call still short-circuits with zero egress —
  // and without even reading the client id.
  fetchCalls.length = 0;
  settingReads = 0;
  assert.deepEqual(await getTraktPopularMovies(1), []);
  assert.equal(fetchCalls.length, 0);
  assert.equal(settingReads, 0);
});

test("HTTP 429 with NO Retry-After falls back to the 1h ceiling (pure-fn check, no shared lockout state)", () => {
  // A direct unit check of the clamp so the module-global lockout ordering
  // (the test above leaves it tripped for the bypass pin) can't mask a
  // regression: undefined → the 1h fallback, a present value → clamp to
  // [30s, 1h].
  assert.equal(clampTraktLockoutMs(undefined), 60 * 60 * 1000, "no Retry-After ⇒ 1h fallback");
  assert.equal(clampTraktLockoutMs(5_000), 30 * 1000, "below the floor clamps up to 30s");
  assert.equal(clampTraktLockoutMs(10 * 60 * 1000), 10 * 60 * 1000, "in-range value is honored");
  assert.equal(clampTraktLockoutMs(3 * 60 * 60 * 1000), 60 * 60 * 1000, "above the ceiling clamps to 1h");
});

test("testTraktConnection bypasses the lockout: the admin test reaches the wire while list helpers stay suspended", async () => {
  // The lockout tripped in the test above (module-global). An admin actively
  // fixing their client id needs immediate feedback, not a 1h suspension —
  // mirrors testOmdbConnection's deliberate exemption.
  respond = () => jsonResponse([movieRow(603, "The Matrix", 1999)]);
  fetchCalls.length = 0;
  assert.equal(await testTraktConnection(), "The Matrix");
  assert.equal(fetchCalls.length, 1, "the connection test must not be short-circuited by the lockout");
});

test("guardrail 27a: the 429 lockout is process-wide — a second copy of trakt.ts (another chunk) is locked too", async () => {
  // Still inside the window the 429 test above tripped (30s, real clock).
  const specifier = "../src/lib/trakt.ts?chunk=page";
  const other: typeof import("../src/lib/trakt.ts") = await import(specifier);
  respond = () => jsonResponse([movieRow(603, "The Matrix", 1999)]);
  fetchCalls.length = 0;
  assert.deepEqual(await other.getTraktPopularMovies(1), []);
  assert.equal(fetchCalls.length, 0, "the other copy saw the lockout");
});

test("a 429 answered to the admin's connection test trips the lockout too — the test shares the one request path", async () => {
  respond = () =>
    new Response(JSON.stringify({ error: "slow down" }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "120" },
    });
  await assert.rejects(() => testTraktConnection(), /rate limited/);
  assert.ok(warns.some((w) => /\[trakt\] Quota lockout tripped .* suspending calls for 2\.0 min/.test(w)));
});
