// Unit tests for resolveMediaMeta (src/lib/request-meta.ts) — the title/poster/
// releaseYear resolver behind POST /api/requests and /api/requests/bulk. Every
// MediaRequest row's display metadata is minted through this three-tier chain,
// so the tier ORDER and the exact fallback triggers are the contract:
//   1. TmdbMediaCore (cheap pre-warmed column read) wins when it has a title;
//   2. the `movie:/tv:<id>:details` TmdbCache blob is consulted ONLY for core
//      misses, and ONLY while unexpired — an expired or unparseable blob must
//      fall through, never be served;
//   3. a live TMDB verification (verifyTmdbMedia) is the last resort, and its
//      null (id doesn't exist on TMDB) is what lets the request routes 404
//      instead of minting a row for a fabricated tmdbId.
// Also pinned: the exact core/cache query shapes (composite tmdbId_mediaType
// key; MOVIE→movie:/TV→tv: cache-key casing), the null/"" normalization of
// optional fields (posterPath ?? null, releaseYear ?? ""), that a throwing
// core/cache read degrades to the next tier instead of failing the request,
// and the live tier's wire shape (GET /3/movie|tv/<id> with the TMDB v4
// bearer header).
//
// No DB or network: src/lib/prisma.ts caches its client on globalThis, so a
// fake client is pre-seeded BEFORE the module graph loads (the
// poster-cache.test pattern); globalThis.fetch is scripted per URL and
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

// ── fake prisma, pre-seeded before the module graph loads ───────────────────
type CoreRow = { title: string | null; posterPath: string | null; releaseYear: string | null };
type CacheRow = { data: string; expiresAt: Date };
type CoreArgs = {
  where: { tmdbId_mediaType: { tmdbId: number; mediaType: string } };
  select: Record<string, boolean>;
};
type CacheArgs = { where: { key: string }; select: Record<string, boolean> };

const coreCalls: CoreArgs[] = [];
const cacheCalls: CacheArgs[] = [];
let coreRow: CoreRow | null = null;
let coreThrows = false;
let cacheRow: CacheRow | null = null;
let cacheThrows = false;

const fakePrisma = {
  tmdbMediaCore: {
    findUnique: async (args: CoreArgs): Promise<CoreRow | null> => {
      coreCalls.push(args);
      if (coreThrows) throw new Error("unit-test core read failure");
      return coreRow;
    },
  },
  tmdbCache: {
    findUnique: async (args: CacheArgs): Promise<CacheRow | null> => {
      cacheCalls.push(args);
      if (cacheThrows) throw new Error("unit-test cache read failure");
      return cacheRow;
    },
  },
};

(globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;

// ── scripted fetch (the live verifyTmdbMedia tier) ──────────────────────────
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

// Dynamic import so the stubs above genuinely precede the module-graph load
// (static imports would hoist — the poster-cache.test pattern).
const { resolveMediaMeta } = await import("../src/lib/request-meta.ts");

const HOUR = 3_600_000;
const freshCache = (blob: unknown): CacheRow => ({
  data: JSON.stringify(blob),
  expiresAt: new Date(Date.now() + HOUR),
});

beforeEach(() => {
  coreCalls.length = 0;
  cacheCalls.length = 0;
  fetchCalls.length = 0;
  coreRow = null;
  coreThrows = false;
  cacheRow = null;
  cacheThrows = false;
  respond = () => {
    throw new Error("unexpected fetch — script a responder for this test");
  };
});

// ── tier 1: TmdbMediaCore ───────────────────────────────────────────────────

test("core hit wins: mapped verbatim, cache and live tiers never consulted", async () => {
  coreRow = { title: "Dune", posterPath: "/dune.jpg", releaseYear: "2021" };
  const result = await resolveMediaMeta(438631, "MOVIE");
  assert.deepEqual(result, { title: "Dune", posterPath: "/dune.jpg", releaseYear: "2021" });
  assert.equal(cacheCalls.length, 0);
  assert.equal(fetchCalls.length, 0);
  // The exact query shape: composite key + the three projected columns.
  assert.equal(coreCalls.length, 1);
  assert.deepEqual(coreCalls[0].where, { tmdbId_mediaType: { tmdbId: 438631, mediaType: "MOVIE" } });
  assert.deepEqual(coreCalls[0].select, { title: true, posterPath: true, releaseYear: true });
});

test("core nulls normalize: posterPath null stays null, releaseYear null becomes ''", async () => {
  coreRow = { title: "Obscure Film", posterPath: null, releaseYear: null };
  assert.deepEqual(await resolveMediaMeta(7, "MOVIE"), {
    title: "Obscure Film",
    posterPath: null,
    releaseYear: "",
  });
});

test("a core row WITHOUT a title is a miss — falls through to the cache tier", async () => {
  coreRow = { title: null, posterPath: "/stale.jpg", releaseYear: "1999" };
  cacheRow = freshCache({ title: "From Cache", posterPath: "/cache.jpg", releaseYear: "1999" });
  const result = await resolveMediaMeta(550, "MOVIE");
  assert.deepEqual(result, { title: "From Cache", posterPath: "/cache.jpg", releaseYear: "1999" });
  assert.equal(cacheCalls.length, 1);
});

test("a throwing core read degrades to the cache tier instead of failing the request", async () => {
  coreThrows = true;
  cacheRow = freshCache({ title: "Survived", posterPath: null, releaseYear: "2001" });
  const result = await resolveMediaMeta(11, "MOVIE");
  assert.deepEqual(result, { title: "Survived", posterPath: null, releaseYear: "2001" });
});

// ── tier 2: the TmdbCache details blob ──────────────────────────────────────

test("cache keys are exactly movie:<id>:details / tv:<id>:details per media type", async () => {
  cacheRow = freshCache({ title: "Whatever" });
  await resolveMediaMeta(603, "MOVIE");
  await resolveMediaMeta(1399, "TV");
  assert.deepEqual(
    cacheCalls.map((c) => c.where.key),
    ["movie:603:details", "tv:1399:details"],
  );
  assert.deepEqual(cacheCalls[0].select, { data: true, expiresAt: true });
});

test("fresh cache blob is served with optional fields normalized (?? null / ?? '')", async () => {
  cacheRow = freshCache({ title: "Cache Only" }); // no posterPath, no releaseYear
  const result = await resolveMediaMeta(42, "TV");
  assert.deepEqual(result, { title: "Cache Only", posterPath: null, releaseYear: "" });
  assert.equal(fetchCalls.length, 0); // fresh + titled ⇒ live tier untouched
});

test("an EXPIRED cache blob is never served — falls through to the live tier", async () => {
  cacheRow = {
    data: JSON.stringify({ title: "Stale Title", posterPath: "/stale.jpg", releaseYear: "1980" }),
    expiresAt: new Date(Date.now() - 1), // just past its TTL
  };
  respond = () => jsonResponse({ title: "Fresh Title", poster_path: "/fresh.jpg", release_date: "2024-05-01" });
  const result = await resolveMediaMeta(77, "MOVIE");
  assert.deepEqual(result, { title: "Fresh Title", posterPath: "/fresh.jpg", releaseYear: "2024" });
  assert.equal(fetchCalls.length, 1);
});

test("an unparseable cache blob is swallowed and the live tier answers", async () => {
  cacheRow = { data: "{not json at all", expiresAt: new Date(Date.now() + HOUR) };
  respond = () => jsonResponse({ title: "Live Rescue", poster_path: null, release_date: "2020-01-01" });
  const result = await resolveMediaMeta(88, "MOVIE");
  assert.deepEqual(result, { title: "Live Rescue", posterPath: null, releaseYear: "2020" });
});

test("a parseable cache blob WITHOUT a title falls through to the live tier", async () => {
  cacheRow = freshCache({ posterPath: "/orphan.jpg", releaseYear: "2010" }); // no title
  respond = () => jsonResponse({ title: "Titled Live", poster_path: "/live.jpg", release_date: "2010-03-03" });
  const result = await resolveMediaMeta(99, "MOVIE");
  assert.deepEqual(result, { title: "Titled Live", posterPath: "/live.jpg", releaseYear: "2010" });
});

// ── tier 3: live TMDB verification ──────────────────────────────────────────

test("live movie wire shape: GET /3/movie/<id> with the v4 bearer header; date → 4-char year", async () => {
  respond = () => jsonResponse({ title: "The Matrix", poster_path: "/matrix.jpg", release_date: "1999-03-31" });
  const result = await resolveMediaMeta(603, "MOVIE");
  assert.deepEqual(result, { title: "The Matrix", posterPath: "/matrix.jpg", releaseYear: "1999" });
  assert.equal(fetchCalls.length, 1);
  const call = fetchCalls[0];
  assert.equal(call.url.origin + call.url.pathname, "https://api.themoviedb.org/3/movie/603");
  assert.equal(call.headers.get("authorization"), "Bearer test-tmdb-read-token");
});

test("live TV maps name/first_air_date and hits /3/tv/<id>; a missing date → ''", async () => {
  respond = () => jsonResponse({ name: "Game of Thrones", poster_path: "/got.jpg" }); // no first_air_date
  const result = await resolveMediaMeta(1399, "TV");
  assert.deepEqual(result, { title: "Game of Thrones", posterPath: "/got.jpg", releaseYear: "" });
  assert.equal(fetchCalls[0].url.pathname, "/3/tv/1399");
});

test("live 404 (id doesn't exist on TMDB) → null, after exactly one attempt", async () => {
  respond = () => jsonResponse({ status_message: "not found" }, 404);
  assert.equal(await resolveMediaMeta(999999999, "MOVIE"), null);
  assert.equal(fetchCalls.length, 1); // non-socket errors are not retried
});

test("live 200 without a usable title field → null (verification, not blind trust)", async () => {
  respond = () => jsonResponse({ poster_path: "/x.jpg", release_date: "2020-01-01" }); // no title
  assert.equal(await resolveMediaMeta(123, "MOVIE"), null);
});

test("all three tiers empty/missing → null (the request routes' 404 signal)", async () => {
  // core miss (null row), cache miss (null row), live network failure.
  respond = () => {
    throw new Error("ECONNRESET");
  };
  assert.equal(await resolveMediaMeta(456, "TV"), null);
  assert.equal(coreCalls.length, 1);
  assert.equal(cacheCalls.length, 1);
});
