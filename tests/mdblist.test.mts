// Unit tests for the MDBList client surface (src/lib/mdblist.ts) BEYOND the
// pure parser — tests/mdblist-parse.test.mts already pins parseBatchItem
// (source-name aliasing, per-source formatting, null/absent handling), and
// tests/omdb-availability.test.mts pins hasAnyMdblistRating over the row shape.
// This file covers the I/O layer around them:
//   - fetchAndCacheMdblistForTmdb: exact wire URLs (movie → /tmdb/movie/<id>/,
//     tv → /tmdb/show/<id>/), the parsed row is returned AND cached with the
//     age-scaled TTL (libraryDetailsTtl); a 404 is the ONLY negative-cache
//     (24h not-found sentinel, result without a transient flag), while 5xx and
//     200-with-error-body responses are transient — warned, never cached.
//   - getMdblistRatingsForTmdb cache-first flow: cold miss fetches+caches,
//     warm serves with zero fetches, a cached sentinel reads as found:false,
//     and a stale row is served immediately while one background revalidation
//     refreshes it.
//   - fetchMdblistBatch: POST wire shape ({ ids } body, Content-Type), 200-id
//     chunking, per-item release-date TTLs, a failed page warns and does NOT
//     abort later pages, one 503 retry, id-based response matching (out-of-order
//     rows, positional fallback for id-less rows, over-length rows dropped),
//     and the negative-cache coverage rule: only a FULL-length response
//     sentinels omitted ids — short and empty responses never negative-cache.
//   - getMdblistTopLists / getMdblistListItems / getMdblistTopRated: wire +
//     TmdbMedia-skeleton parsing (tmdb_id guards, show→tv mapping, media-type
//     filter, dedup), DISCOVER-TTL caching, and cache-first second calls.
//   - No-API-key short-circuits: every surface returns its empty shape with
//     ZERO fetches; an empty batch returns before even the Setting read.
//   - Quota lockout (LAST — module-global state): a 429 or quota-error body
//     trips a 1h suspension with strict-< expiry; while locked every surface
//     short-circuits with zero fetches but warm cache rows are still served;
//     the batch loop BREAKS (remaining pages skipped) on a quota signal.
//
// Ordering notes: the API-key memo is module-global with a 30s TTL, so tests
// that change the key bust the memo by advancing the mocked clock
// (resetApiKey). The quota lockout is module-global too — the tripping tests
// run LAST and clear the lockout between trips by advancing past the 1h expiry.
//
// No DB or network: prisma.setting / prisma.tmdbCache are shadowed in-memory
// (tests/_helpers.mts), globalThis.fetch is scripted (with request-body
// capture for the batch POSTs), and dns/promises.lookup is stubbed so the
// safe-fetch SSRF resolver never issues a real lookup for api.mdblist.com.
import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto

// Freeze the clock BEFORE the module graph loads (imports below are DYNAMIC —
// static imports would hoist above this): lockout arithmetic, cache TTLs, and
// the 30s API-key memo all read the mocked Date. setTimeout stays REAL (the
// batch 503 retry genuinely sleeps ~1.5s in its test).
const T0 = Date.UTC(2026, 0, 15, 12, 0, 0);
mock.timers.enable({ apis: ["Date"], now: T0 });
let clockNow = T0;
function advanceClock(ms: number): void {
  clockNow += ms;
  mock.timers.setTime(clockNow);
}
const API_KEY_TTL_MS = 30_000; // mirrors src/lib/mdblist.ts
const HOUR_MS = 60 * 60 * 1000; // QUOTA_LOCKOUT_MS in src/lib/mdblist.ts
const DAY_MS = 24 * HOUR_MS;

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

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const {
  fetchAndCacheMdblistForTmdb,
  getMdblistRatingsForTmdb,
  fetchMdblistBatch,
  getMdblistTopLists,
  getMdblistListItems,
  getMdblistTopRated,
  isMdblistQuotaLocked,
} = await import("../src/lib/mdblist.ts");
type MdblistRatings = import("../src/lib/mdblist.ts").MdblistRatings;

// ── prisma stubs ────────────────────────────────────────────────────────────
const DEFAULT_KEY = "test-mdblist-key";
let mdblistApiKeyValue: string | null = DEFAULT_KEY;
const settingReads: string[] = [];
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    settingReads.push(args.where.key);
    return args.where.key === "mdblistApiKey" && mdblistApiKeyValue !== null
      ? { key: "mdblistApiKey", value: mdblistApiKeyValue }
      : null;
  },
});

// Change the stored key AND advance past the 30s memo TTL so the next
// getApiKey() actually re-reads it.
function resetApiKey(value: string | null): void {
  mdblistApiKeyValue = value;
  advanceClock(API_KEY_TTL_MS + 1_000);
}

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
  deleteMany: async (args: { where: { key?: string } }) => {
    if (args.where.key) cacheRows.delete(args.where.key);
    return { count: 1 };
  },
});

// ── scripted fetch (captures the POST body for batch-shape pins) ────────────
type FetchCall = { url: URL; method: string; headers: Headers; body: string | null };
const fetchCalls: FetchCall[] = [];
let respond: (url: URL, call: FetchCall) => Response = () => {
  throw new Error("unexpected fetch — script a responder for this test");
};

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const call: FetchCall = {
    url,
    method: init?.method ?? "GET",
    headers: new Headers(init?.headers),
    body: typeof init?.body === "string" ? init.body : null,
  };
  fetchCalls.push(call);
  return respond(url, call);
}) as typeof fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bodyIds(call: FetchCall): number[] {
  return (JSON.parse(call.body ?? "{}") as { ids: number[] }).ids;
}

// A fully-null MdblistRatings row; overrides layer fields on top (mirrors the
// fixture in tests/omdb-availability.test.mts).
function mdbRow(overrides: Partial<MdblistRatings> = {}): MdblistRatings {
  return {
    imdbId: null,
    imdbRating: null,
    imdbVotes: null,
    rottenTomatoes: null,
    rtAudienceScore: null,
    metacritic: null,
    traktRating: null,
    letterboxdRating: null,
    mdblistScore: null,
    malRating: null,
    rogerEbertRating: null,
    releasedDigital: null,
    trailerUrl: null,
    ...overrides,
  };
}

// Flush the microtask/macrotask queues until `cond` holds — for observing the
// fire-and-forget SWR revalidation. Bounded so a broken chain fails loudly.
async function settleUntil(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`condition never settled: ${what}`);
}

beforeEach(() => {
  fetchCalls.length = 0;
  cacheRows.clear();
  cacheUpserts.length = 0;
  warns.length = 0;
  errors.length = 0;
  respond = () => {
    throw new Error("unexpected fetch — script a responder for this test");
  };
});

// ── fetchAndCacheMdblistForTmdb ─────────────────────────────────────────────

test("single-title fetch (movie): exact wire URL, parseBatchItem row returned AND cached with the age-scaled TTL", async () => {
  respond = () => jsonResponse({
    id: 603,
    title: "The Matrix",
    type: "movie",
    year: 1999,
    imdb_id: "tt0133093",
    score: 71.5,
    trailer: "https://youtube.com/watch?v=abc",
    released_digital: "1999-09-21",
    ratings: [
      { source: "imdb", value: 8.7, votes: 1_500_000 },
      { source: "tomatoes", value: 83 },
    ],
  });
  const expected = mdbRow({
    imdbId: "tt0133093",
    imdbRating: "8.7",
    imdbVotes: "1500000",
    rottenTomatoes: "83%",
    mdblistScore: "72",
    releasedDigital: "1999-09-21",
    trailerUrl: "https://youtube.com/watch?v=abc",
  });
  const result = await fetchAndCacheMdblistForTmdb(603, "movie", "mdblist:tmdb:movie:603", "1999-03-31");
  assert.deepEqual(result, { found: true, data: expected });

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url.toString(), "https://api.mdblist.com/tmdb/movie/603/?apikey=test-mdblist-key");
  assert.equal(fetchCalls[0].method, "GET");

  // Cache write: the parsed row under the caller's key, TTL from the
  // releaseDate ARGUMENT (a 1999 release → the 30-day back-catalog bucket).
  assert.equal(cacheUpserts.length, 1);
  assert.equal(cacheUpserts[0].key, "mdblist:tmdb:movie:603");
  assert.deepEqual(JSON.parse(cacheUpserts[0].data), expected);
  assert.equal(cacheUpserts[0].expiresAt.getTime(), Date.now() + 30 * DAY_MS);
});

test("404 is the only negative cache: 24h not-found sentinel, no transient flag, and the sentinel then serves without a fetch", async () => {
  respond = () => new Response("not found", { status: 404 });
  const result = await fetchAndCacheMdblistForTmdb(604, "movie", "mdblist:tmdb:movie:604");
  assert.deepEqual(result, { found: false, keyConfigured: true }); // authoritative absence — transient ABSENT

  const row = cacheRows.get("mdblist:tmdb:movie:604");
  assert.ok(row, "a 404 must be negative-cached");
  assert.deepEqual(JSON.parse(row.data), { _notFound: true });
  assert.equal(row.expiresAt.getTime(), Date.now() + DAY_MS);

  // The public cache-first entry now reads the sentinel — zero further fetches.
  assert.equal(fetchCalls.length, 1);
  assert.deepEqual(await getMdblistRatingsForTmdb(604, "movie"), { found: false, keyConfigured: true });
  assert.equal(fetchCalls.length, 1);
});

test("5xx and 200-with-error-body are transient: warned, NEVER negative-cached", async () => {
  // 5xx.
  respond = () => new Response("boom", { status: 500 });
  assert.deepEqual(await fetchAndCacheMdblistForTmdb(605, "movie", "mdblist:tmdb:movie:605"), {
    found: false, keyConfigured: true, transient: true,
  });
  assert.ok(warns.some((w) => w.includes("[mdblist] API returned 500 for movie:605")));

  // 200 with a string error (non-quota).
  respond = () => jsonResponse({ error: "Invalid API key!" });
  assert.deepEqual(await fetchAndCacheMdblistForTmdb(606, "movie", "mdblist:tmdb:movie:606"), {
    found: false, keyConfigured: true, transient: true,
  });
  assert.ok(warns.some((w) => w.includes("[mdblist] API error for movie:606: Invalid API key!")));

  // 200 with { error: true, message } — the message becomes the error string.
  respond = () => jsonResponse({ error: true, message: "backend restarting" });
  assert.deepEqual(await fetchAndCacheMdblistForTmdb(607, "tv", "mdblist:tmdb:tv:607"), {
    found: false, keyConfigured: true, transient: true,
  });
  assert.ok(warns.some((w) => w.includes("[mdblist] API error for tv:607: backend restarting")));

  assert.equal(cacheUpserts.length, 0); // none of the three wrote anything
});

// ── getMdblistRatingsForTmdb cache-first flow ───────────────────────────────

test("cache-first: a tv cold miss hits the /tmdb/show/ endpoint once, then warm calls serve with zero fetches", async () => {
  respond = () => jsonResponse({ id: 1399, ratings: [{ source: "trakt", value: 82.4 }] });
  const cold = await getMdblistRatingsForTmdb(1399, "tv", "2011-04-17");
  assert.deepEqual(cold, { found: true, data: mdbRow({ traktRating: "82" }) });
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url.toString(), "https://api.mdblist.com/tmdb/show/1399/?apikey=test-mdblist-key");

  const warm = await getMdblistRatingsForTmdb(1399, "tv", "2011-04-17");
  assert.deepEqual(warm, cold);
  assert.equal(fetchCalls.length, 1); // served from mdblist:tmdb:tv:1399
});

test("a stale row is served immediately, one background revalidation refreshes it, and the next call serves the fresh row", async () => {
  const oldData = mdbRow({ traktRating: "10" });
  cacheRows.set("mdblist:tmdb:movie:888", {
    key: "mdblist:tmdb:movie:888",
    data: JSON.stringify(oldData),
    cachedAt: new Date(Date.now() - DAY_MS),
    expiresAt: new Date(Date.now() - 1_000), // expired ⇒ stale
  });
  respond = () => jsonResponse({ id: 888, ratings: [{ source: "trakt", value: 90 }] });

  const stale = await getMdblistRatingsForTmdb(888, "movie");
  assert.deepEqual(stale, { found: true, data: oldData }); // old value, no waiting

  await settleUntil(
    () => cacheRows.get("mdblist:tmdb:movie:888")?.data.includes('"90"') === true,
    "background revalidation writes the fresh row",
  );
  assert.equal(fetchCalls.length, 1); // exactly one revalidation fetch

  const after = await getMdblistRatingsForTmdb(888, "movie");
  assert.deepEqual(after, { found: true, data: mdbRow({ traktRating: "90" }) });
  assert.equal(fetchCalls.length, 1);
});

// ── fetchMdblistBatch ───────────────────────────────────────────────────────

test("batch wire shape: one POST with a JSON { ids } body, and per-item releaseDates drive per-row cache TTLs", async () => {
  const currentYear = new Date().getFullYear(); // mocked — 2026
  respond = () => jsonResponse([
    { id: 11, ratings: [{ source: "imdb", value: 7 }] },
    { id: 22, ratings: [{ source: "imdb", value: 6 }] },
  ]);
  const map = await fetchMdblistBatch(
    [
      { id: 11, releaseDate: `${currentYear}-01-05` }, // fresh → 3d bucket
      { id: 22, releaseDate: "1994-06-15" },           // back-catalog → 30d bucket
    ],
    "movie",
  );
  assert.equal(map.size, 2);
  assert.equal(map.get(11)?.imdbRating, "7");
  assert.equal(map.get(22)?.imdbRating, "6");

  assert.equal(fetchCalls.length, 1);
  const call = fetchCalls[0];
  assert.equal(call.url.toString(), "https://api.mdblist.com/tmdb/movie/?apikey=test-mdblist-key");
  assert.equal(call.method, "POST");
  assert.equal(call.headers.get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(call.body ?? ""), { ids: [11, 22] });

  const row11 = cacheRows.get("mdblist:tmdb:movie:11");
  const row22 = cacheRows.get("mdblist:tmdb:movie:22");
  assert.ok(row11, "item 11 must be cached");
  assert.ok(row22, "item 22 must be cached");
  assert.equal(row11.expiresAt.getTime(), Date.now() + 3 * DAY_MS);
  assert.equal(row22.expiresAt.getTime(), Date.now() + 30 * DAY_MS);
});

test("chunking: 201 ids split into a 200-page and a 1-page; a failed page warns and later pages still run", async () => {
  const items = Array.from({ length: 201 }, (_, i) => ({ id: i + 1 }));
  const echo = (call: FetchCall) =>
    jsonResponse(bodyIds(call).map((id) => ({ id, ratings: [{ source: "imdb", value: 5 }] })));

  // Phase 1: both pages succeed and merge into one map.
  respond = (_url, call) => echo(call);
  const map = await fetchMdblistBatch(items, "movie");
  assert.equal(map.size, 201);
  assert.equal(fetchCalls.length, 2);
  const firstIds = bodyIds(fetchCalls[0]);
  assert.equal(firstIds.length, 200);
  assert.equal(firstIds[0], 1);
  assert.equal(firstIds[199], 200);
  assert.deepEqual(bodyIds(fetchCalls[1]), [201]);

  // Phase 2: page 1 returns 500 → warned and SKIPPED (continue, not break);
  // page 2 still processes.
  fetchCalls.length = 0;
  respond = (_url, call) => (bodyIds(call).length === 200 ? new Response("boom", { status: 500 }) : echo(call));
  const map2 = await fetchMdblistBatch(items, "movie");
  assert.equal(fetchCalls.length, 2); // the second page was still attempted
  assert.deepEqual([...map2.keys()], [201]);
  assert.ok(warns.some((w) => w.includes("[mdblist] batch movie returned 500")));
});

test("response rows are matched by id (out-of-order); rows beyond the page length with unknown ids are dropped; id-less rows fall back positionally", async () => {
  // Out-of-order + one extra unknown-id row past the page length.
  respond = () => jsonResponse([
    { id: 20, ratings: [{ source: "imdb", value: 2 }] },
    { id: 10, ratings: [{ source: "imdb", value: 9 }] },
    { id: 99, ratings: [{ source: "imdb", value: 5 }] }, // no page slot left → dropped
  ]);
  const map = await fetchMdblistBatch([{ id: 10 }, { id: 20 }], "movie");
  assert.equal(map.size, 2);
  assert.equal(map.get(10)?.imdbRating, "9"); // matched by id, not position
  assert.equal(map.get(20)?.imdbRating, "2");
  assert.equal(map.has(99), false);
  assert.equal(cacheRows.has("mdblist:tmdb:movie:99"), false);

  // A row without an id falls back to its request position.
  respond = () => jsonResponse([{ ratings: [{ source: "imdb", value: 4 }] }]);
  const map2 = await fetchMdblistBatch([{ id: 7 }], "movie");
  assert.equal(map2.get(7)?.imdbRating, "4");
  assert.ok(cacheRows.has("mdblist:tmdb:movie:7"));
});

test("a full-length response padded with an unknown id drops the foreign row and does NOT sentinel the displaced requested id", async () => {
  // MDBList echoing an id we never asked for (here 42) must not fall back
  // positionally — that would mis-bind it to the wrong requested item — and it
  // must not pad the "response covered the full request" count: id 2 was never
  // actually answered for, so negative-caching it would suppress a title that
  // may exist for the full 24h TTL.
  respond = () => jsonResponse([
    { id: 1, ratings: [{ source: "imdb", value: 8 }] },
    { id: 42, ratings: [{ source: "imdb", value: 3 }] },
  ]);
  const map = await fetchMdblistBatch([{ id: 1 }, { id: 2 }], "movie");
  assert.deepEqual([...map.keys()], [1]);
  assert.equal(map.has(42), false);
  assert.equal(cacheRows.has("mdblist:tmdb:movie:42"), false, "the foreign id is dropped, not cached");
  assert.equal(cacheRows.has("mdblist:tmdb:movie:2"), false, "the displaced requested id is NOT negative-cached");
  assert.ok(
    warns.some((w) => w.includes("[mdblist] batch movie returned 1 unmatched row(s) (2 rows for 2 ids)")),
    "the unmatched row must be warned",
  );
});

test("short and empty batch responses NEVER negative-cache the omitted ids (warned as partial/transient instead)", async () => {
  // Short response: 1 of 3 → no sentinels for 2 and 3.
  respond = () => jsonResponse([{ id: 1, ratings: [{ source: "imdb", value: 8 }] }]);
  const map = await fetchMdblistBatch([{ id: 1 }, { id: 2 }, { id: 3 }], "movie");
  assert.deepEqual([...map.keys()], [1]);
  assert.equal(cacheRows.has("mdblist:tmdb:movie:2"), false);
  assert.equal(cacheRows.has("mdblist:tmdb:movie:3"), false);
  assert.ok(
    warns.some((w) => w.includes("[mdblist] batch movie returned partial response (1/3)")),
    "a short response must be warned as partial",
  );

  // Empty response: likely transient — nothing cached at all.
  respond = () => jsonResponse([]);
  const map2 = await fetchMdblistBatch([{ id: 5 }], "movie");
  assert.equal(map2.size, 0);
  assert.equal(cacheRows.has("mdblist:tmdb:movie:5"), false);
  assert.ok(
    warns.some((w) => w.includes("[mdblist] batch movie returned empty array for 1 items")),
    "an empty response must be warned",
  );
});

test("a 503 page is retried once after a pause, and the retry's response is used", async () => {
  let attempts = 0;
  respond = () => {
    attempts++;
    return attempts === 1
      ? new Response("nightly restart", { status: 503 })
      : jsonResponse([{ id: 9, ratings: [{ source: "imdb", value: 6 }] }]);
  };
  // NOTE: the retry back-off is a REAL ~1.5s setTimeout (only Date is mocked).
  const map = await fetchMdblistBatch([{ id: 9 }], "movie");
  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[0].url.toString(), fetchCalls[1].url.toString());
  assert.equal(map.get(9)?.imdbRating, "6");
});

// ── discovery lists ─────────────────────────────────────────────────────────

test("getMdblistTopLists: wire with the limit param, DISCOVER-TTL caching, cache key ignores limit, non-OK degrades to []", async () => {
  respond = () => jsonResponse([{ id: 1, name: "Best of 2026", slug: "best-2026", items: 100, likes: 50 }]);
  const lists = await getMdblistTopLists(3);
  assert.equal(lists.length, 1);
  assert.equal(lists[0].name, "Best of 2026");
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url.toString(), "https://api.mdblist.com/lists/top?apikey=test-mdblist-key&limit=3");

  const row = cacheRows.get("mdblist:top-lists");
  assert.ok(row, "a non-empty result must be cached");
  assert.equal(row.expiresAt.getTime(), Date.now() + 12 * HOUR_MS); // TTL.DISCOVER

  // The cache key carries no limit — a second call with a DIFFERENT limit is
  // still a cache hit.
  assert.deepEqual(await getMdblistTopLists(10), lists);
  assert.equal(fetchCalls.length, 1);

  // Non-OK (non-429) → [] and nothing cached.
  cacheRows.delete("mdblist:top-lists");
  const upsertsBefore = cacheUpserts.length;
  respond = () => new Response("boom", { status: 500 });
  assert.deepEqual(await getMdblistTopLists(3), []);
  assert.equal(cacheUpserts.length, upsertsBefore);
});

test("getMdblistListItems: TmdbMedia skeleton with tmdb_id guards, show→tv mapping, media-type filter, dedup, and caching", async () => {
  respond = () => jsonResponse([
    { id: 1, rank: 1, title: "Kept Show", year: 2020, mediatype: "show", imdb_id: "tt1", tmdb_id: 100, score: 90 },
    { id: 2, rank: 2, title: "No Tmdb Id", year: 2020, mediatype: "show", imdb_id: null, tmdb_id: null, score: 80 },
    { id: 3, rank: 3, title: "Bad Tmdb Id", year: 2020, mediatype: "show", imdb_id: null, tmdb_id: -5, score: 70 },
    { id: 4, rank: 4, title: "A Movie", year: 2019, mediatype: "movie", imdb_id: null, tmdb_id: 200, score: 60 },
    { id: 5, rank: 5, title: "Duplicate", year: 2021, mediatype: "show", imdb_id: null, tmdb_id: 100, score: 50 },
    { id: 6, rank: 6, title: null, year: null, mediatype: "show", imdb_id: null, tmdb_id: 300, score: 40 },
  ]);
  const items = await getMdblistListItems(77, "tv");
  assert.equal(fetchCalls[0].url.toString(), "https://api.mdblist.com/lists/77/items?apikey=test-mdblist-key");
  assert.deepEqual(items, [
    {
      id: 100, mediaType: "tv", title: "Kept Show", overview: "",
      posterPath: null, backdropPath: null, releaseDate: null,
      releaseYear: "2020", voteAverage: 0,
    },
    {
      id: 300, mediaType: "tv", title: "", overview: "", // null title → "", null year → null
      posterPath: null, backdropPath: null, releaseDate: null,
      releaseYear: null, voteAverage: 0,
    },
  ]);
  assert.ok(cacheRows.has("mdblist:list:77:tv"), "the filtered result is cached under the :tv key");

  // No media-type filter → the :all key, movie AND show rows both kept.
  respond = () => jsonResponse([
    { id: 1, rank: 1, title: "Show", year: 2020, mediatype: "show", imdb_id: null, tmdb_id: 100, score: 90 },
    { id: 2, rank: 2, title: "Movie", year: 2019, mediatype: "movie", imdb_id: null, tmdb_id: 200, score: 80 },
  ]);
  const all = await getMdblistListItems(78);
  assert.deepEqual(all.map((i) => [i.id, i.mediaType]), [[100, "tv"], [200, "movie"]]);
  assert.ok(cacheRows.has("mdblist:list:78:all"));

  // A non-array body degrades to [] without caching.
  respond = () => jsonResponse({ error: "no such list" });
  assert.deepEqual(await getMdblistListItems(79), []);
  assert.equal(cacheRows.has("mdblist:list:79:all"), false);
});

test("getMdblistTopRated: fans out over the top lists, dedups across lists in order, caches the merged set, and is cache-first", async () => {
  const li = (tmdb: number, title: string) =>
    ({ id: tmdb, rank: 1, title, year: 2020, mediatype: "movie", imdb_id: null, tmdb_id: tmdb, score: 80 });
  respond = (url) => {
    if (url.pathname === "/lists/top") {
      return jsonResponse([
        { id: 1, name: "L1", slug: "l1", items: 2, likes: 9 },
        { id: 2, name: "L2", slug: "l2", items: 2, likes: 8 },
      ]);
    }
    if (url.pathname === "/lists/1/items") return jsonResponse([li(100, "A"), li(200, "B")]);
    if (url.pathname === "/lists/2/items") return jsonResponse([li(200, "B"), li(300, "C")]);
    throw new Error(`unexpected path ${url.pathname}`);
  };

  const result = await getMdblistTopRated("movie", 2);
  assert.equal(fetchCalls[0].url.searchParams.get("limit"), "2"); // maxLists flows into the top-lists limit
  assert.deepEqual(result.map((m) => m.id), [100, 200, 300]); // 200 deduped across lists, order preserved
  assert.equal(fetchCalls.length, 3); // 1 top-lists + 2 item lists
  assert.ok(cacheRows.has("mdblist:top-rated:movie"));

  // Second call: the merged cache row answers — zero additional fetches.
  assert.deepEqual(await getMdblistTopRated("movie", 2), result);
  assert.equal(fetchCalls.length, 3);
});

// ── no-API-key short-circuits ───────────────────────────────────────────────

test("no API key: every surface returns its empty shape with ZERO fetches; an empty batch returns before even the Setting read", async () => {
  resetApiKey(null);

  const readsBefore = settingReads.length;
  assert.equal((await fetchMdblistBatch([], "movie")).size, 0);
  assert.equal(settingReads.length, readsBefore); // empty input short-circuits ahead of getApiKey

  assert.equal((await fetchMdblistBatch([{ id: 1 }], "movie")).size, 0);
  assert.deepEqual(await fetchAndCacheMdblistForTmdb(1, "movie", "mdblist:tmdb:movie:1"), {
    found: false, keyConfigured: false,
  });
  assert.deepEqual(await getMdblistRatingsForTmdb(2, "movie"), { found: false, keyConfigured: false });
  assert.deepEqual(await getMdblistTopLists(), []);
  assert.deepEqual(await getMdblistListItems(9), []);
  assert.deepEqual(await getMdblistTopRated("movie"), []);
  assert.equal(fetchCalls.length, 0);

  resetApiKey(DEFAULT_KEY);
});

// ── quota lockout (LAST — module-global state) ──────────────────────────────

test("a 429 trips the 1h lockout: every surface then short-circuits with zero fetches, warm cache rows still serve, strict-< expiry", async () => {
  respond = () => new Response("slow down", { status: 429 });
  const tripped = await fetchAndCacheMdblistForTmdb(50, "movie", "mdblist:tmdb:movie:50");
  assert.deepEqual(tripped, { found: false, keyConfigured: true, quotaExhausted: true, transient: true });
  assert.equal(isMdblistQuotaLocked(), true);
  assert.ok(
    warns.some((w) => w.includes("[mdblist] Quota lockout tripped")),
    "the trip must warn with the [mdblist] scope",
  );

  // While locked: zero fetches from any surface.
  const lockedFetches = fetchCalls.length; // 1 (the tripping call)
  assert.equal((await fetchMdblistBatch([{ id: 51 }], "movie")).size, 0);
  assert.deepEqual(await fetchAndCacheMdblistForTmdb(52, "movie", "mdblist:tmdb:movie:52"), {
    found: false, keyConfigured: true, quotaExhausted: true, transient: true,
  });
  assert.deepEqual(await getMdblistRatingsForTmdb(53, "movie"), {
    found: false, keyConfigured: true, quotaExhausted: true, transient: true,
  });
  assert.deepEqual(await getMdblistTopLists(), []);
  assert.deepEqual(await getMdblistListItems(1), []);
  assert.equal(fetchCalls.length, lockedFetches);

  // A warm cache row is STILL served while locked — the cache read precedes
  // the lockout check.
  cacheRows.set("mdblist:tmdb:movie:54", {
    key: "mdblist:tmdb:movie:54",
    data: JSON.stringify(mdbRow({ imdbRating: "7.1" })),
    cachedAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
  });
  assert.deepEqual(await getMdblistRatingsForTmdb(54, "movie"), {
    found: true, data: mdbRow({ imdbRating: "7.1" }),
  });
  assert.equal(fetchCalls.length, lockedFetches);

  // Strict-< expiry: locked up to (but not at) the 1h boundary.
  advanceClock(HOUR_MS - 1);
  assert.equal(isMdblistQuotaLocked(), true);
  advanceClock(1);
  assert.equal(isMdblistQuotaLocked(), false);
});

test("a batch 429 BREAKS the page loop and re-trips; a 200 quota-error body trips too (after the previous lockout expires)", async () => {
  const items = Array.from({ length: 201 }, (_, i) => ({ id: i + 1 })); // two pages

  // 429 on page 1 → lockout + break: page 2 is never attempted.
  respond = () => new Response("slow down", { status: 429 });
  assert.equal((await fetchMdblistBatch(items, "movie")).size, 0);
  assert.equal(fetchCalls.length, 1);
  assert.equal(isMdblistQuotaLocked(), true);

  advanceClock(HOUR_MS); // clear the lockout
  assert.equal(isMdblistQuotaLocked(), false);

  // A 200 non-array quota-error body ("api limit") trips and breaks the same way.
  respond = () => jsonResponse({ error: "API limit reached! Upgrade your plan." });
  assert.equal((await fetchMdblistBatch(items, "movie")).size, 0);
  assert.equal(fetchCalls.length, 2); // one more call — page 2 skipped again
  assert.equal(isMdblistQuotaLocked(), true);
  assert.ok(warns.some((w) => w.includes("API limit reached!")), "the trip reason must carry the body's message");
});
