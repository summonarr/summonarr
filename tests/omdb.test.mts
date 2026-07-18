// Unit tests for the OMDB client surface (src/lib/omdb.ts) BEYOND the
// quota-lockout family — tests/omdb-quota.test.mts already pins the lockout
// contracts (trips on 429/quota bodies, not on invalid-key/not-found; locked
// short-circuits; cached values served while locked; strict-< 1h expiry) plus
// the not-found sentinel write/short-circuit and one basic Response=True parse.
// This file covers the rest of the module:
//   - getOmdbRatings response parsing: the Ratings array is consulted ONLY for
//     the "Rotten Tomatoes" source (the array's Metacritic entry is ignored —
//     metacritic comes solely from the top-level Metascore), every "N/A" and
//     every absent optional field maps to null, and the result's imdbId is the
//     CALLER's id (the body's imdbID is ignored). The wire URL is pinned
//     exactly, and the positive cache write uses the age-scaled TTL
//     (libraryDetailsTtl) — an all-null Response=True row is still a positive
//     cache entry, never the not-found sentinel.
//   - getApiKey memoization: many calls inside the 30s window issue exactly one
//     Setting read; the window expiring re-reads; testOmdbConnection's
//     { fresh: true } bypasses the memo so a rotated key is visible immediately.
//   - fetchAndCacheOmdbForTmdb: resolves the IMDb id via TMDB external_ids
//     (bearer-authed, wire pinned) and writes BOTH cache rows (omdb:<imdbId>
//     inside getOmdbRatings + the caller's tmdb-keyed row); a missing imdb_id
//     negative-caches ONLY the tmdb key (24h) without ever calling OMDB; a
//     failed external_ids fetch and an OMDB transient error both map to
//     { transient: true } with NOTHING cached; a missing TMDB read token is the
//     odd one out — keyConfigured:true with NO transient flag and no cache write.
//   - getOmdbRatingsForTmdb cache-first flow: cold miss populates, warm serves
//     with zero fetches, a cached sentinel reads as found:false, concurrent
//     cold misses coalesce into ONE upstream chain (inflightCold), and a stale
//     row is served immediately while exactly one background revalidation
//     (revalidating-set dedup) refreshes it.
//   - testOmdbConnection: fixed tt0133093 probe, Title/"OK" fallback, HTTP and
//     Response=False throw shapes, no-key throw with zero fetches — and (LAST,
//     after deliberately tripping the module-global lockout) that the
//     connection test is exempt from the quota lockout by design.
//
// Ordering notes: the API-key memo is module-global with a 30s TTL, so tests
// that change the key bust the memo by advancing the mocked clock
// (resetApiKey). The quota lockout is also module-global — the single
// lockout-tripping test runs LAST so it cannot leak into earlier tests.
//
// No DB or network: prisma.setting / prisma.tmdbCache are shadowed in-memory
// (tests/_helpers.mts), globalThis.fetch is scripted per host, and
// dns/promises.lookup is stubbed so the safe-fetch SSRF resolver never issues
// a real lookup for www.omdbapi.com / api.themoviedb.org.
import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto
const TMDB_TOKEN = "test-tmdb-token";
process.env.TMDB_READ_TOKEN = TMDB_TOKEN; // tmdbAuth() reads this per call

// Freeze the clock BEFORE the module graph loads (imports below are DYNAMIC —
// static imports would hoist above this): lockout arithmetic, cache TTLs, and
// the 30s API-key memo all read the mocked Date.
const T0 = Date.UTC(2026, 0, 15, 12, 0, 0);
mock.timers.enable({ apis: ["Date"], now: T0 });
let clockNow = T0;
function advanceClock(ms: number): void {
  clockNow += ms;
  mock.timers.setTime(clockNow);
}
const API_KEY_TTL_MS = 30_000; // mirrors src/lib/omdb.ts
const DAY_MS = 24 * 60 * 60 * 1000;

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
  getOmdbRatings,
  getOmdbRatingsForTmdb,
  fetchAndCacheOmdbForTmdb,
  testOmdbConnection,
  isOmdbQuotaLocked,
} = await import("../src/lib/omdb.ts");

// ── prisma stubs ────────────────────────────────────────────────────────────
const DEFAULT_KEY = "test-omdb-key";
let omdbApiKeyValue: string | null = DEFAULT_KEY;
const settingReads: string[] = [];
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    settingReads.push(args.where.key);
    return args.where.key === "omdbApiKey" && omdbApiKeyValue !== null
      ? { key: "omdbApiKey", value: omdbApiKeyValue }
      : null;
  },
});

// Change the stored key AND advance past the 30s memo TTL so the next
// getApiKey() actually re-reads it. (testOmdbConnection's fresh read also
// rewrites the memo, so restoring the key always goes through this helper.)
function resetApiKey(value: string | null): void {
  omdbApiKeyValue = value;
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

// ── scripted fetch ──────────────────────────────────────────────────────────
type FetchCall = { url: URL; method: string; headers: Headers };
const fetchCalls: FetchCall[] = [];
let respond: (url: URL) => Response = () => {
  throw new Error("unexpected fetch — script a responder for this test");
};

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  fetchCalls.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers) });
  return respond(url);
}) as typeof fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Route by upstream host: fetchAndCacheOmdbForTmdb talks to BOTH
// api.themoviedb.org (external_ids resolve) and www.omdbapi.com.
function route(handlers: { tmdb?: (url: URL) => Response; omdb?: (url: URL) => Response }): void {
  respond = (url) => {
    const handler =
      url.hostname === "api.themoviedb.org" ? handlers.tmdb :
      url.hostname === "www.omdbapi.com" ? handlers.omdb :
      undefined;
    if (!handler) throw new Error(`unexpected fetch to ${url.hostname}`);
    return handler(url);
  };
}

// Flush the microtask/macrotask queues until `cond` holds — for observing the
// fire-and-forget SWR revalidation. Bounded so a broken chain fails loudly
// instead of hanging.
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

// ── getOmdbRatings parsing ──────────────────────────────────────────────────

test("happy body: exact field mapping (caller's imdbId wins over the body's), exact wire URL, age-scaled positive cache write, warm second call", async () => {
  route({
    omdb: () => jsonResponse({
      Response: "True",
      imdbID: "tt7654321", // deliberately different from the input — must be ignored
      imdbRating: "8.8",
      imdbVotes: "2,100,000",
      Ratings: [
        { Source: "Internet Movie Database", Value: "8.8/10" },
        { Source: "Rotten Tomatoes", Value: "87%" },
        { Source: "Metacritic", Value: "73/100" },
      ],
      Metascore: "73",
    }),
  });
  const result = await getOmdbRatings("tt0133093", "1999-03-31");
  assert.deepEqual(result, {
    imdbId: "tt0133093", // the input id, NOT the body's imdbID
    imdbRating: "8.8",
    imdbVotes: "2,100,000",
    rottenTomatoes: "87%",
    metacritic: "73/100",
  });

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url.toString(), "https://www.omdbapi.com/?apikey=test-omdb-key&i=tt0133093");
  assert.equal(fetchCalls[0].method, "GET");

  // Positive cache write under omdb:<imdbId>, TTL from libraryDetailsTtl:
  // a 1999 release is deep back-catalog → the 30-day bucket.
  assert.equal(cacheUpserts.length, 1);
  assert.equal(cacheUpserts[0].key, "omdb:tt0133093");
  assert.deepEqual(JSON.parse(cacheUpserts[0].data), result);
  assert.equal(cacheUpserts[0].expiresAt.getTime(), Date.now() + 30 * DAY_MS);

  // Cache-first: the very next call for the same id issues no fetch.
  assert.deepEqual(await getOmdbRatings("tt0133093"), result);
  assert.equal(fetchCalls.length, 1);
});

test('"N/A" and absent optional fields both map to null — and the all-null row is a POSITIVE cache entry with the fresh-release TTL', async () => {
  route({
    omdb: () => jsonResponse({
      Response: "True",
      imdbRating: "N/A",
      imdbVotes: "N/A",
      Ratings: [{ Source: "Rotten Tomatoes", Value: "N/A" }],
      Metascore: "N/A",
    }),
  });
  const currentYear = new Date().getFullYear(); // mocked — 2026
  const allNa = await getOmdbRatings("tt0000100", `${currentYear}-01-01`);
  assert.deepEqual(allNa, {
    imdbId: "tt0000100",
    imdbRating: null,
    imdbVotes: null,
    rottenTomatoes: null,
    metacritic: null,
  });
  // Cached as a positive row (NOT the not-found sentinel) — "OMDB knows the
  // title but has no scores" is authoritative data, not absence.
  const row = cacheRows.get("omdb:tt0000100");
  assert.ok(row, "the all-N/A response must still be cached");
  assert.equal("_notFound" in (JSON.parse(row.data) as Record<string, unknown>), false);
  assert.equal(row.expiresAt.getTime(), Date.now() + 3 * DAY_MS); // released this year → freshest bucket

  // Fields absent entirely (not "N/A") degrade identically.
  route({ omdb: () => jsonResponse({ Response: "True" }) });
  assert.deepEqual(await getOmdbRatings("tt0000101"), {
    imdbId: "tt0000101",
    imdbRating: null,
    imdbVotes: null,
    rottenTomatoes: null,
    metacritic: null,
  });
});

test('Ratings array extraction: only the "Rotten Tomatoes" source is read; the array\'s Metacritic entry never feeds metacritic', async () => {
  // No Ratings array at all → null.
  route({ omdb: () => jsonResponse({ Response: "True", imdbRating: "7.0" }) });
  const noArray = await getOmdbRatings("tt0000102");
  assert.equal(noArray?.rottenTomatoes, null);

  // Array present but without an RT source → null; the Metacritic ARRAY entry
  // is ignored (metacritic comes solely from the top-level Metascore field).
  route({
    omdb: () => jsonResponse({
      Response: "True",
      Ratings: [
        { Source: "Internet Movie Database", Value: "7.0/10" },
        { Source: "Metacritic", Value: "70/100" },
      ],
    }),
  });
  const noRt = await getOmdbRatings("tt0000103");
  assert.equal(noRt?.rottenTomatoes, null);
  assert.equal(noRt?.metacritic, null); // no Metascore field ⇒ null despite the array entry

  // RT among other sources → its Value is taken verbatim.
  route({
    omdb: () => jsonResponse({
      Response: "True",
      Ratings: [
        { Source: "Internet Movie Database", Value: "9.0/10" },
        { Source: "Rotten Tomatoes", Value: "93%" },
        { Source: "Metacritic", Value: "80/100" },
      ],
    }),
  });
  assert.equal((await getOmdbRatings("tt0000104"))?.rottenTomatoes, "93%");
});

// ── getApiKey memoization ───────────────────────────────────────────────────

test("getApiKey is memoized: three lookups in the 30s window issue exactly ONE Setting read; the window expiring re-reads", async () => {
  resetApiKey(DEFAULT_KEY);
  route({ omdb: () => jsonResponse({ Response: "True", imdbRating: "5.0" }) });
  const base = settingReads.length;
  await getOmdbRatings("tt0000110");
  await getOmdbRatings("tt0000111");
  await getOmdbRatings("tt0000112");
  assert.equal(settingReads.length - base, 1); // one read serves the burst

  advanceClock(API_KEY_TTL_MS + 1_000);
  await getOmdbRatings("tt0000113");
  assert.equal(settingReads.length - base, 2); // expired window → fresh read
});

// ── fetchAndCacheOmdbForTmdb ────────────────────────────────────────────────

test("fetchAndCacheOmdbForTmdb: bearer-authed TMDB external_ids resolve (wire pinned), OMDB by the resolved id, and BOTH cache rows written", async () => {
  route({
    tmdb: () => jsonResponse({ imdb_id: "tt7777777" }),
    omdb: () => jsonResponse({
      Response: "True",
      imdbRating: "8.1",
      imdbVotes: "900,000",
      Ratings: [{ Source: "Rotten Tomatoes", Value: "91%" }],
      Metascore: "77",
    }),
  });
  const expected = {
    imdbId: "tt7777777",
    imdbRating: "8.1",
    imdbVotes: "900,000",
    rottenTomatoes: "91%",
    metacritic: "77/100",
  };
  const result = await fetchAndCacheOmdbForTmdb(550, "movie", "omdb:tmdb:movie:550", "1999-10-15");
  assert.deepEqual(result, { found: true, data: expected });

  assert.equal(fetchCalls.length, 2);
  const ext = fetchCalls[0];
  assert.equal(ext.url.toString(), "https://api.themoviedb.org/3/movie/550/external_ids");
  assert.equal(ext.headers.get("authorization"), `Bearer ${TMDB_TOKEN}`);
  assert.equal(fetchCalls[1].url.hostname, "www.omdbapi.com");
  assert.equal(fetchCalls[1].url.searchParams.get("i"), "tt7777777");

  // Two writes: the imdb-keyed row (inside getOmdbRatings) then the caller's
  // tmdb-keyed row — identical ratings, identical age-scaled TTL.
  assert.deepEqual(cacheUpserts.map((u) => u.key), ["omdb:tt7777777", "omdb:tmdb:movie:550"]);
  assert.deepEqual(JSON.parse(cacheUpserts[1].data), expected);
  assert.equal(cacheUpserts[0].expiresAt.getTime(), Date.now() + 30 * DAY_MS);
  assert.equal(cacheUpserts[1].expiresAt.getTime(), Date.now() + 30 * DAY_MS);
});

test("TMDB reports no imdb_id: the tmdb key gets the 24h not-found sentinel and OMDB is never called", async () => {
  route({ tmdb: () => jsonResponse({ imdb_id: null }) });
  const result = await fetchAndCacheOmdbForTmdb(603, "movie", "omdb:tmdb:movie:603", "2003-05-15");
  assert.deepEqual(result, { found: false, keyConfigured: true }); // authoritative absence — no transient flag
  assert.equal(fetchCalls.length, 1); // external_ids only

  const row = cacheRows.get("omdb:tmdb:movie:603");
  assert.ok(row, "no-imdb-id must be negative-cached at the tmdb key");
  assert.deepEqual(JSON.parse(row.data), { _notFound: true });
  // Negative TTL is the fixed 24h, NOT the age-scaled positive TTL.
  assert.equal(row.expiresAt.getTime(), Date.now() + DAY_MS);
});

test("a failed external_ids fetch is transient: warned, nothing cached, no OMDB call", async () => {
  route({ tmdb: () => new Response("upstream broke", { status: 500 }) });
  const result = await fetchAndCacheOmdbForTmdb(604, "tv", "omdb:tmdb:tv:604");
  assert.deepEqual(result, { found: false, keyConfigured: true, transient: true });
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url.toString(), "https://api.themoviedb.org/3/tv/604/external_ids"); // tv path
  assert.equal(cacheUpserts.length, 0);
  assert.ok(
    warns.some((w) => w.includes("[omdb] TMDB external_ids fetch failed (500) for tv:604")),
    "the failure must be warned with the [omdb] scope",
  );
});

test("an OMDB transient error inside the chain maps to { transient: true } with NOTHING cached at either key", async () => {
  route({
    tmdb: () => jsonResponse({ imdb_id: "tt0000200" }),
    omdb: () => jsonResponse({ Response: "False", Error: "Invalid API key!" }),
  });
  const result = await fetchAndCacheOmdbForTmdb(605, "movie", "omdb:tmdb:movie:605");
  assert.deepEqual(result, { found: false, keyConfigured: true, transient: true });
  assert.equal(cacheUpserts.length, 0); // neither omdb:tt0000200 nor the tmdb key
  assert.ok(errors.some((e) => e.includes("[omdb]")), "the swallowed throw must be logged");
});

test("no TMDB read token: keyConfigured-only miss — NO transient flag, no fetch, no cache write", async () => {
  // The sharp edge: an unconfigured TMDB token is neither a transient failure
  // nor a cacheable absence — every call degrades per-request until the token
  // exists. deepEqual pins the exact shape (transient must be ABSENT).
  delete process.env.TMDB_READ_TOKEN;
  try {
    const result = await fetchAndCacheOmdbForTmdb(606, "movie", "omdb:tmdb:movie:606");
    assert.deepEqual(result, { found: false, keyConfigured: true });
    assert.equal(fetchCalls.length, 0);
    assert.equal(cacheUpserts.length, 0);
  } finally {
    process.env.TMDB_READ_TOKEN = TMDB_TOKEN;
  }
});

// ── getOmdbRatingsForTmdb cache-first flow ──────────────────────────────────

test("getOmdbRatingsForTmdb: cold miss runs the two-fetch chain, warm serves with zero fetches, a cached sentinel reads as found:false", async () => {
  route({
    tmdb: () => jsonResponse({ imdb_id: "tt0000300" }),
    omdb: () => jsonResponse({ Response: "True", imdbRating: "7.7" }),
  });
  const cold = await getOmdbRatingsForTmdb(700, "movie", "2020-01-01");
  assert.deepEqual(cold, {
    found: true,
    data: { imdbId: "tt0000300", imdbRating: "7.7", imdbVotes: null, rottenTomatoes: null, metacritic: null },
  });
  assert.equal(fetchCalls.length, 2);

  const warm = await getOmdbRatingsForTmdb(700, "movie", "2020-01-01");
  assert.deepEqual(warm, cold);
  assert.equal(fetchCalls.length, 2); // served from the tmdb-keyed row

  // A previously negative-cached tmdb id is an authoritative miss — no fetch.
  cacheRows.set("omdb:tmdb:movie:701", {
    key: "omdb:tmdb:movie:701",
    data: JSON.stringify({ _notFound: true }),
    cachedAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
  });
  assert.deepEqual(await getOmdbRatingsForTmdb(701, "movie"), { found: false, keyConfigured: true });
  assert.equal(fetchCalls.length, 2);
});

test("concurrent cold misses for one tmdb id coalesce into a single upstream chain (inflightCold)", async () => {
  route({
    tmdb: () => jsonResponse({ imdb_id: "tt0000400" }),
    omdb: () => jsonResponse({ Response: "True", imdbRating: "6.6" }),
  });
  const p1 = getOmdbRatingsForTmdb(710, "movie");
  const p2 = getOmdbRatingsForTmdb(710, "movie");
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.deepEqual(r1, r2);
  assert.equal(r1.found, true);
  assert.equal(fetchCalls.length, 2); // one TMDB + one OMDB — not four
});

test("a stale row is served to every concurrent reader immediately while exactly ONE background revalidation refreshes it", async () => {
  const oldData = { imdbId: "tt0000500", imdbRating: "5.5", imdbVotes: null, rottenTomatoes: null, metacritic: null };
  cacheRows.set("omdb:tmdb:movie:720", {
    key: "omdb:tmdb:movie:720",
    data: JSON.stringify(oldData),
    cachedAt: new Date(Date.now() - DAY_MS),
    expiresAt: new Date(Date.now() - 1_000), // expired ⇒ stale
  });
  route({
    tmdb: () => jsonResponse({ imdb_id: "tt0000500" }),
    omdb: () => jsonResponse({ Response: "True", imdbRating: "9.9" }),
  });

  // Two concurrent stale readers: both get the OLD value without waiting.
  const [r1, r2] = await Promise.all([
    getOmdbRatingsForTmdb(720, "movie"),
    getOmdbRatingsForTmdb(720, "movie"),
  ]);
  assert.deepEqual(r1, { found: true, data: oldData });
  assert.deepEqual(r2, r1);

  // The revalidating-set dedup means ONE background chain, not two.
  await settleUntil(
    () => cacheRows.get("omdb:tmdb:movie:720")?.data.includes('"9.9"') === true,
    "background revalidation writes the fresh row",
  );
  assert.equal(fetchCalls.length, 2); // one TMDB + one OMDB total

  // The refreshed row now serves fresh — still no extra fetch.
  const after = await getOmdbRatingsForTmdb(720, "movie");
  assert.deepEqual(after, {
    found: true,
    data: { imdbId: "tt0000500", imdbRating: "9.9", imdbVotes: null, rottenTomatoes: null, metacritic: null },
  });
  assert.equal(fetchCalls.length, 2);
});

test("no OMDB key on a cold miss: keyConfigured:false and bare getOmdbRatings degrades to null — zero fetches either way", async () => {
  resetApiKey(null);
  assert.deepEqual(await getOmdbRatingsForTmdb(730, "movie"), { found: false, keyConfigured: false });
  assert.equal(await getOmdbRatings("tt0000600"), null);
  assert.equal(fetchCalls.length, 0);
  resetApiKey(DEFAULT_KEY);
});

// ── testOmdbConnection ──────────────────────────────────────────────────────

test("testOmdbConnection: { fresh: true } bypasses the key memo (a rotated key is used immediately), probes tt0133093, and maps every failure shape", async () => {
  // Warm the memo with the default key first…
  resetApiKey(DEFAULT_KEY);
  route({ omdb: () => jsonResponse({ Response: "True", imdbRating: "1.0" }) });
  await getOmdbRatings("tt0000700");

  // …then rotate the stored key WITHOUT advancing the clock: the fresh read
  // must see the new value even though the memo still holds the old one.
  omdbApiKeyValue = "rotated-key";
  route({ omdb: () => jsonResponse({ Response: "True", Title: "The Matrix" }) });
  assert.equal(await testOmdbConnection(), "The Matrix");
  const probe = fetchCalls[fetchCalls.length - 1];
  assert.ok(probe);
  assert.equal(probe.url.searchParams.get("apikey"), "rotated-key");
  assert.equal(probe.url.searchParams.get("i"), "tt0133093"); // the fixed probe title

  // Response=True without a Title falls back to "OK".
  route({ omdb: () => jsonResponse({ Response: "True" }) });
  assert.equal(await testOmdbConnection(), "OK");

  // Non-2xx → HTTP-status throw.
  route({ omdb: () => new Response("down", { status: 503 }) });
  await assert.rejects(() => testOmdbConnection(), /OMDB returned HTTP 503/);

  // Response=False → the body's Error string, or the fixed fallback without one.
  route({ omdb: () => jsonResponse({ Response: "False", Error: "Invalid API key!" }) });
  await assert.rejects(() => testOmdbConnection(), /Invalid API key!/);
  route({ omdb: () => jsonResponse({ Response: "False" }) });
  await assert.rejects(() => testOmdbConnection(), /OMDB API key invalid/);

  // No key configured → throws before any fetch.
  omdbApiKeyValue = null;
  const before = fetchCalls.length;
  await assert.rejects(() => testOmdbConnection(), /No OMDB API key configured/);
  assert.equal(fetchCalls.length, before);

  resetApiKey(DEFAULT_KEY); // the fresh read memoized null — restore properly
});

// LAST on purpose: trips the module-global quota lockout, which would
// short-circuit every OMDB call in tests that ran after it.
test("the quota lockout does NOT gate testOmdbConnection — an admin can verify a recovered key mid-suspension", async () => {
  route({ omdb: () => new Response("rate limited", { status: 429 }) });
  await assert.rejects(() => getOmdbRatings("tt0000800"), /429/);
  assert.equal(isOmdbQuotaLocked(), true);
  assert.ok(
    warns.some((w) => w.includes("[omdb] Quota lockout tripped")),
    "the trip must warn with the [omdb] scope",
  );

  const before = fetchCalls.length;
  route({ omdb: () => jsonResponse({ Response: "True", Title: "Blade Runner" }) });
  assert.equal(await testOmdbConnection(), "Blade Runner");
  assert.equal(fetchCalls.length, before + 1); // the probe went out while locked
  assert.equal(isOmdbQuotaLocked(), true); // and the lockout itself is untouched
});
