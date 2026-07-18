// Unit tests for the OMDB quota-lockout logic (src/lib/omdb.ts). The free tier
// is 1,000 requests/day and OMDB signals exhaustion as HTTP 200 with
// Response="False" + an Error string (or as a plain HTTP 429), so the module
// keeps an in-process lockout that suspends ALL OMDB calls for 1 hour once a
// quota condition is seen. The contracts pinned here:
//   - the lockout trips on HTTP 429 and on quota-error bodies ("limit"/"quota"),
//   - it does NOT trip on "Invalid API key" (an operator fixing their key needs
//     immediate feedback, not a 1h suspension) or on a genuine not-found,
//   - while locked, cold-cache lookups short-circuit WITHOUT touching the
//     network (getOmdbRatings throws — its transient semantics — and
//     fetchAndCacheOmdbForTmdb returns { quotaExhausted, transient }),
//   - cached values are still served while locked (the cache read precedes the
//     lockout check),
//   - the lockout expires after exactly QUOTA_LOCKOUT_MS (strict <, so the
//     boundary instant is already unlocked) and calls flow again.
//
// Tests in this file are ORDER-DEPENDENT: the lockout is module-global state
// with no reset export, so the sequence below walks it through
// unlocked → tripped → expired → re-tripped → expired deliberately, using
// node:test mock timers (Date only) to control the clock.
//
// No DB or network is touched: prisma.setting / prisma.tmdbCache are shadowed
// in-memory (tests/_helpers.mts), globalThis.fetch is a scripted mock, and
// dns/promises.lookup is stubbed so the safe-fetch SSRF resolver never issues
// a real lookup for www.omdbapi.com.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto

// Freeze the clock BEFORE the module graph loads (imports below are DYNAMIC —
// static imports would hoist above this): every Date.now() in the tests —
// lockout arithmetic, cache TTLs, the API-key memo — reads the mocked time.
const T0 = Date.UTC(2026, 0, 15, 12, 0, 0);
mock.timers.enable({ apis: ["Date"], now: T0 });
const HOUR_MS = 60 * 60 * 1000; // QUOTA_LOCKOUT_MS in src/lib/omdb.ts

// ── DNS stub ────────────────────────────────────────────────────────────────
// safeFetchTrusted resolves the hostname (twice: policy check + the TOCTOU
// re-check) via dns/promises `lookup` on the default-imported object; stub it
// with a fixed public address so no query leaves the process. Guarded like the
// prisma shadow — a non-writable core module would otherwise hang on real DNS.
const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) {
  throw new Error("could not stub dns.lookup — aborting before a real DNS query can leave the process");
}

// ── console capture ─────────────────────────────────────────────────────────
// Every path here is warn/error-noisy by design (lockout trip warns, transient
// throws are logged). Capture instead of printing; the warn text is asserted.
const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const { fetchAndCacheOmdbForTmdb, getOmdbRatings, isOmdbQuotaLocked } =
  await import("../src/lib/omdb.ts");
type OmdbRatings = import("../src/lib/omdb.ts").OmdbRatings;

// ── prisma stubs ────────────────────────────────────────────────────────────
// getApiKey reads the omdbApiKey Setting; getCache/setCache (tmdb-cache.ts)
// read/upsert TmdbCache rows. Both shadowed in-memory.
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) =>
    args.where.key === "omdbApiKey" ? { key: "omdbApiKey", value: "test-omdb-key" } : null,
});

type CacheRow = { key: string; data: string; cachedAt: Date; expiresAt: Date };
const cacheRows = new Map<string, CacheRow>();
shadowPrismaModel(prisma, "tmdbCache", {
  findUnique: async (args: { where: { key: string } }) => cacheRows.get(args.where.key) ?? null,
  upsert: async (args: { where: { key: string }; create: CacheRow }) => {
    cacheRows.set(args.where.key, args.create);
    return args.create;
  },
  deleteMany: async (args: { where: { key: string } }) => {
    cacheRows.delete(args.where.key);
    return { count: 1 };
  },
});

// ── scripted fetch ──────────────────────────────────────────────────────────
type FetchCall = { url: string };
const fetchCalls: FetchCall[] = [];
let nextResponse: (() => Response) | null = null; // null ⇒ any fetch is a test failure

globalThis.fetch = (async (input: RequestInfo | URL) => {
  fetchCalls.push({ url: String(input) });
  if (!nextResponse) throw new Error("unexpected fetch — this test must not reach the network path");
  return nextResponse();
}) as typeof fetch;

function omdbBody(body: unknown): () => Response {
  return () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

function script(responder: (() => Response) | null): void {
  fetchCalls.length = 0;
  nextResponse = responder;
}

// ── the ordered walk ────────────────────────────────────────────────────────

test("baseline: process starts unlocked", () => {
  assert.equal(isOmdbQuotaLocked(), false);
});

test("'Invalid API key' is transient (throws) but does NOT trip the lockout or cache a sentinel", async () => {
  script(omdbBody({ Response: "False", Error: "Invalid API key!" }));
  await assert.rejects(() => getOmdbRatings("tt0000001"), /transient/i);
  assert.equal(fetchCalls.length, 1);
  assert.equal(isOmdbQuotaLocked(), false); // an admin fixing their key gets immediate feedback
  assert.equal(cacheRows.has("omdb:tt0000001"), false); // never negative-cached as not-found
});

test("a genuine not-found returns null, caches the sentinel, and does not lock", async () => {
  script(omdbBody({ Response: "False", Error: "Incorrect IMDb ID." }));
  assert.equal(await getOmdbRatings("tt0000002"), null);
  assert.equal(isOmdbQuotaLocked(), false);
  const row = cacheRows.get("omdb:tt0000002");
  assert.ok(row, "not-found sentinel must be cached");
  assert.deepEqual(JSON.parse(row.data), { _notFound: true });

  // The sentinel short-circuits the next lookup entirely — no second fetch.
  script(null);
  assert.equal(await getOmdbRatings("tt0000002"), null);
  assert.equal(fetchCalls.length, 0);
});

test("a Response=False quota body ('Request limit reached!') throws AND trips the lockout", async () => {
  script(omdbBody({ Response: "False", Error: "Request limit reached!" }));
  await assert.rejects(() => getOmdbRatings("tt0000003"), /transient/i);
  assert.equal(isOmdbQuotaLocked(), true);
  assert.ok(
    warns.some((w) => w.includes("[omdb] Quota lockout tripped")),
    "lockout trip must warn with the [omdb] scope",
  );
  assert.equal(cacheRows.has("omdb:tt0000003"), false); // quota miss never negative-cached
});

test("while locked, a cold-cache getOmdbRatings throws WITHOUT touching the network", async () => {
  script(null); // any fetch fails the test
  await assert.rejects(() => getOmdbRatings("tt0000004"), /quota locked/i);
  assert.equal(fetchCalls.length, 0);
});

test("while locked, a cached value is still served (cache read precedes the lockout check)", async () => {
  const cached: OmdbRatings = {
    imdbId: "tt0000005",
    imdbRating: "8.1",
    imdbVotes: "120,000",
    rottenTomatoes: "92%",
    metacritic: "78/100",
  };
  cacheRows.set("omdb:tt0000005", {
    key: "omdb:tt0000005",
    data: JSON.stringify(cached),
    cachedAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
  });
  script(null);
  assert.deepEqual(await getOmdbRatings("tt0000005"), cached);
  assert.equal(fetchCalls.length, 0);
});

test("while locked, fetchAndCacheOmdbForTmdb short-circuits with quotaExhausted+transient", async () => {
  script(null);
  assert.deepEqual(await fetchAndCacheOmdbForTmdb(550, "movie", "omdb:tmdb:movie:550"), {
    found: false,
    keyConfigured: true,
    quotaExhausted: true,
    transient: true,
  });
  assert.equal(fetchCalls.length, 0); // skips the TMDB external_ids resolve too
});

test("the lockout holds up to (but not at) the 1h boundary — strict-< expiry", async () => {
  mock.timers.setTime(T0 + HOUR_MS - 1);
  assert.equal(isOmdbQuotaLocked(), true);
  mock.timers.setTime(T0 + HOUR_MS);
  assert.equal(isOmdbQuotaLocked(), false);
});

test("after expiry, calls flow again — a Response=True body parses to ratings", async () => {
  script(omdbBody({
    Response: "True",
    imdbID: "tt0000006",
    imdbRating: "7.5",
    imdbVotes: "50,000",
    Ratings: [{ Source: "Rotten Tomatoes", Value: "88%" }],
    Metascore: "70",
  }));
  assert.deepEqual(await getOmdbRatings("tt0000006"), {
    imdbId: "tt0000006",
    imdbRating: "7.5",
    imdbVotes: "50,000",
    rottenTomatoes: "88%",
    metacritic: "70/100",
  });
  assert.equal(fetchCalls.length, 1);
  assert.equal(isOmdbQuotaLocked(), false);
});

test("an HTTP 429 throws AND re-trips the lockout", async () => {
  script(() => new Response("rate limited", { status: 429 }));
  await assert.rejects(() => getOmdbRatings("tt0000007"), /429/);
  assert.equal(isOmdbQuotaLocked(), true);
});

test("the 429 lockout also expires after exactly 1h from the trip", () => {
  // The 429 tripped at T0+1h (time was not advanced since), so it holds until T0+2h.
  mock.timers.setTime(T0 + 2 * HOUR_MS - 1);
  assert.equal(isOmdbQuotaLocked(), true);
  mock.timers.setTime(T0 + 2 * HOUR_MS);
  assert.equal(isOmdbQuotaLocked(), false);
});
