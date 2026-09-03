// Review 2026-09 package P16 pins.
//
//  - f125: the CACHED details branch's lazy ratings upgrade forwards the row's
//    stored imdbId to fetchUnifiedRatings, so a cold OMDB fallback never
//    re-buys the tmdb→imdb mapping with a TMDB /external_ids call. The fresh
//    path already passed r.external_ids for exactly this reason; the cached
//    path dropped it. Mutation-checked: removing the 4th arg at either site
//    makes the "no /external_ids fetch" assertion fail.
//  - f94 (tmdb half): getPersonDetails dedupes combined_credits per
//    (media_type, id) BEFORE the 40-credit cap, keeps the newest-dated entry,
//    folds the extra roles into `character`, and writes under the bumped
//    `person:v3:` key so a v2 row carrying duplicates never serves.
//
// This lives in its own file (not tests/tmdb.test.mts) on purpose: omdb.ts
// memoizes the OMDB api key per process for 30s, and tmdb.test.mts's harness
// keeps that key null from its first details test onward — a later test in
// that file could not configure a key without waiting out the memo. A fresh
// process lets the setting stub answer with a key before the first read.
//
// No DB or network: prisma.tmdbCache / setting / tmdbMediaCore / $transaction
// are shadowed in-memory, fetch is scripted per URL, and dns.lookup is stubbed
// so safe-fetch's SSRF resolver never issues a real query.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.TMDB_READ_TOKEN = "test-tmdb-read-token";

const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) {
  throw new Error("could not stub dns.lookup — aborting before a real DNS query can leave the process");
}

const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { getMovieDetails, getTVDetails, getPersonDetails } = await import("../src/lib/tmdb.ts");

type CacheRow = { key: string; data: string; cachedAt: Date; expiresAt: Date };
const cacheRows = new Map<string, CacheRow>();
const cacheUpserts: CacheRow[] = [];
shadowPrismaModel(prisma, "tmdbCache", {
  findUnique: async (args: { where: { key: string } }): Promise<CacheRow | null> =>
    cacheRows.get(args.where.key) ?? null,
  findMany: async (): Promise<CacheRow[]> => [],
  upsert: async (args: { where: { key: string }; create: CacheRow }): Promise<CacheRow> => {
    cacheUpserts.push(args.create);
    cacheRows.set(args.where.key, args.create);
    return args.create;
  },
  deleteMany: async (): Promise<{ count: number }> => ({ count: 0 }),
  delete: async (args: { where: { key: string } }): Promise<{ key: string }> => {
    cacheRows.delete(args.where.key);
    return { key: args.where.key };
  },
});

// OMDB configured, MDBList NOT — so fetchUnifiedRatings falls through MDBList
// (keyConfigured:false) straight to the OMDB tier, the only tier that can
// resolve an imdb id via TMDB.
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) =>
    args.where.key === "omdbApiKey" ? { key: "omdbApiKey", value: "omdb-test-key" } : null,
});
shadowPrismaModel(prisma, "tmdbMediaCore", {
  upsert: async (args: unknown) => args,
});
shadowPrismaClientMethod(prisma, "$transaction", async (ops: unknown): Promise<unknown> =>
  Array.isArray(ops) ? Promise.all(ops) : (ops as (tx: unknown) => unknown)(prisma),
);

const fetchCalls: URL[] = [];
let respond: (url: URL) => Response | Promise<Response> = () => {
  throw new Error("unexpected fetch — script a responder for this test");
};
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  fetchCalls.push(url);
  return respond(url);
}) as typeof fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function seedCache(key: string, value: unknown, expiresInMs = 60 * 60 * 1000): void {
  cacheRows.set(key, {
    key,
    data: JSON.stringify(value),
    cachedAt: new Date(Date.now() - 1000),
    expiresAt: new Date(Date.now() + expiresInMs),
  });
}

const OMDB_OK = {
  Response: "True", imdbID: "tt0133093", imdbRating: "8.7", imdbVotes: "2,000,000",
  Ratings: [{ Source: "Rotten Tomatoes", Value: "83%" }], Metascore: "73",
};

// Scripts OMDB only. Any TMDB call (an /external_ids resolve in particular)
// is recorded in fetchCalls and answered so the assertion — not a throw —
// is what reports the regression.
function omdbOnly(): void {
  respond = (url) => {
    if (url.hostname === "www.omdbapi.com") return jsonResponse(OMDB_OK);
    if (url.pathname.endsWith("/external_ids")) return jsonResponse({ imdb_id: "tt0133093" });
    throw new Error(`unexpected fetch: ${url}`);
  };
}

const externalIdCalls = () => fetchCalls.filter((u) => u.pathname.endsWith("/external_ids"));

beforeEach(() => {
  cacheRows.clear();
  cacheUpserts.length = 0;
  fetchCalls.length = 0;
  warns.length = 0;
  errors.length = 0;
  respond = () => {
    throw new Error("unexpected fetch — script a responder for this test");
  };
});

// ── f125: cached-branch lazy upgrade forwards the stored imdbId ────────────

test("movie details cached: the lazy ratings upgrade forwards the row's imdbId — no TMDB /external_ids resolve on the cold OMDB path", async () => {
  seedCache("movie:603:details", {
    id: 603, mediaType: "movie", title: "The Matrix", overview: "o",
    posterPath: "/m.jpg", backdropPath: null, releaseDate: "1999-03-31", releaseYear: "1999",
    voteAverage: 8.2, voteCount: 24_000, trailerKey: null,
    imdbId: "tt0133093",
    // imdbRating undefined ⇒ lazy upgrade fires (prewarm-written rows without a
    // prior carry NO ratings fields at all — this is that shape).
    keywords: [], keywordList: [],
  });
  omdbOnly();
  const result = await getMovieDetails(603);
  assert.equal(result.imdbRating, "8.7", `ratings not applied: ${JSON.stringify(result)}`);
  assert.equal(externalIdCalls().length, 0, `imdbId was dropped — TMDB re-resolved it: ${fetchCalls.map(String).join(", ")}`);
  assert.equal(fetchCalls.length, 1, "exactly one upstream call: the OMDB lookup");
  assert.equal(fetchCalls[0].hostname, "www.omdbapi.com");
  assert.equal(fetchCalls[0].searchParams.get("i"), "tt0133093");
});

test("tv details cached: the lazy ratings upgrade forwards the row's imdbId the same way", async () => {
  seedCache("tv:1399:details", {
    id: 1399, mediaType: "tv", title: "Game of Thrones", overview: "o",
    posterPath: "/got.jpg", backdropPath: null, releaseDate: "2011-04-17", releaseYear: "2011",
    voteAverage: 8.4, voteCount: 21_000, trailerKey: null,
    imdbId: "tt0944947",
    seasons: [{ seasonNumber: 1, name: "Season 1", episodeCount: 10, airDate: "2011-04-17", posterPath: null }],
    keywords: [], keywordList: [],
  });
  respond = (url) => {
    if (url.hostname === "www.omdbapi.com") return jsonResponse({ ...OMDB_OK, imdbID: "tt0944947" });
    if (url.pathname.endsWith("/external_ids")) return jsonResponse({ imdb_id: "tt0944947" });
    throw new Error(`unexpected fetch: ${url}`);
  };
  const result = await getTVDetails(1399);
  assert.equal(result.imdbRating, "8.7");
  assert.equal(externalIdCalls().length, 0, `imdbId was dropped — TMDB re-resolved it: ${fetchCalls.map(String).join(", ")}`);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].searchParams.get("i"), "tt0944947");
});

test("movie details cached: a row with NO stored imdbId still resolves via TMDB (the hint is optional, not required)", async () => {
  // Guards the other direction: forwarding `cached.imdbId ?? null` must not
  // turn an id-less row into a silent "no ratings" — OMDB still gets its id.
  seedCache("movie:604:details", {
    id: 604, mediaType: "movie", title: "Reloaded", overview: "o",
    posterPath: "/m2.jpg", backdropPath: null, releaseDate: "2003-05-15", releaseYear: "2003",
    voteAverage: 7, voteCount: 12_000, trailerKey: null,
    keywords: [], keywordList: [],
  });
  respond = (url) => {
    if (url.hostname === "www.omdbapi.com") return jsonResponse({ ...OMDB_OK, imdbID: "tt0234215" });
    if (url.pathname.endsWith("/external_ids")) return jsonResponse({ imdb_id: "tt0234215" });
    throw new Error(`unexpected fetch: ${url}`);
  };
  const result = await getMovieDetails(604);
  assert.equal(result.imdbRating, "8.7");
  assert.equal(externalIdCalls().length, 1);
});

// ── f94: getPersonDetails dedupes credits per (media_type, id) ─────────────

const CAST = [
  { id: 1399, media_type: "tv", name: "GoT", poster_path: "/got.jpg", first_air_date: "2011-04-17", vote_average: 8.4, vote_count: 21_000, character: "Self" },
  { id: 603, media_type: "movie", title: "The Matrix", poster_path: "/m.jpg", release_date: "1999-03-31", vote_average: 8.2, vote_count: 24_000, character: "Neo" },
  { id: 1399, media_type: "tv", name: "GoT", poster_path: "/got.jpg", first_air_date: "2011-04-17", vote_average: 8.4, vote_count: 21_000, character: "Narrator" },
  // Same role listed twice (TMDB does this for multi-season entries) — must
  // not become "Self / Self".
  { id: 1399, media_type: "tv", name: "GoT", poster_path: "/got.jpg", first_air_date: "2011-04-17", vote_average: 8.4, vote_count: 21_000, character: "Self" },
  // A MOVIE with the same numeric id as the series is a different title.
  { id: 1399, media_type: "movie", title: "Not GoT", poster_path: "/x.jpg", release_date: "2020-01-01", vote_average: 6, vote_count: 500, character: "Guy" },
];

function personResponse(cast: unknown[]) {
  return jsonResponse({
    id: 6384, name: "Keanu Reeves", profile_path: "/k.jpg", known_for_department: "Acting",
    combined_credits: { cast, crew: [] },
  });
}

test("getPersonDetails: one credit per (mediaType, id), roles folded, movie/tv with the same id kept apart", async () => {
  respond = () => personResponse(CAST);
  const p = await getPersonDetails(6384);
  const keys = p.credits.map((c) => `${c.mediaType}-${c.id}`);
  assert.deepEqual(keys, ["movie-1399", "tv-1399", "movie-603"]); // newest-dated first
  assert.equal(p.credits.find((c) => c.mediaType === "tv")!.character, "Self / Narrator");
  assert.equal(p.credits.find((c) => c.id === 603)!.character, "Neo");
});

test("getPersonDetails: the 40-credit cap is applied AFTER dedupe, so repeated roles don't spend it", async () => {
  // 45 distinct movies, each listed twice (two roles) ⇒ 90 raw entries. The
  // old filter/sort/slice kept 40 RAW entries = 20 distinct titles.
  const cast = Array.from({ length: 45 }, (_, i) => {
    const id = 1000 + i;
    const base = { id, media_type: "movie", title: `M${id}`, poster_path: `/p${id}.jpg`, release_date: `20${String(10 + (i % 15)).padStart(2, "0")}-01-01`, vote_average: 7, vote_count: 100 };
    return [{ ...base, character: "A" }, { ...base, character: "B" }];
  }).flat();
  respond = () => personResponse(cast);
  const p = await getPersonDetails(6385);
  assert.equal(p.credits.length, 40);
  assert.equal(new Set(p.credits.map((c) => c.id)).size, 40, "40 DISTINCT titles, not 20 titles × 2 roles");
  assert.ok(p.credits.every((c) => c.character === "A / B"));
});

test("getPersonDetails: writes under person:v3 and a v2 row (duplicates possible) never serves", async () => {
  seedCache("person:v2:6384", { id: 6384, name: "Stale v2", credits: [] });
  respond = () => personResponse(CAST);
  const p = await getPersonDetails(6384);
  assert.equal(p.name, "Keanu Reeves");
  assert.equal(fetchCalls.length, 1, "the v2 row must not serve as a cache hit");
  assert.ok(cacheUpserts.some((u) => u.key === "person:v3:6384"), `no v3 write: ${cacheUpserts.map((u) => u.key).join(", ")}`);
  assert.ok(!cacheUpserts.some((u) => u.key === "person:v2:6384"));
});
