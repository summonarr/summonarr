// resolvePlexLegacyGuidsDetailed (src/lib/plex-legacy-resolve.ts): legacy
// thetvdb:// and imdb:// refs resolved through the TmdbCache and TMDB /find.
// Pins: a show TVDB resolved is never asked again by imdb id; a failed or
// malformed /find answer is not cached and marks the result incomplete; a
// stage that throws keeps what resolved before it.
import { test } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.TMDB_READ_TOKEN = "test-read-token";

const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");
console.warn = () => {};

const FAR = new Date(Date.now() + 365 * 86_400_000);
let cacheRows = new Map<string, string>();
const upserts: string[] = [];
let findManyThrows = false;
(globalThis as unknown as { prisma: unknown }).prisma = {
  tmdbCache: {
    findMany: async (args: { where: { key: { in: string[] } } }) => {
      if (findManyThrows) throw new Error("db down");
      return args.where.key.in
        .filter((k) => cacheRows.has(k))
        .map((key) => ({ key, data: cacheRows.get(key)!, expiresAt: FAR }));
    },
    upsert: async (args: { where: { key: string } }) => {
      upserts.push(args.where.key);
      return {};
    },
    deleteMany: async () => ({ count: 0 }),
  },
  mediaRequest: { findMany: async () => [] },
};

const findCalls: string[] = [];
let findResponder: (imdbId: string) => Response = () => {
  throw new Error("unexpected /find");
};
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  const m = /\/3\/find\/([^?]+)/.exec(url);
  if (!m) throw new Error(`unexpected fetch ${url}`);
  findCalls.push(m[1]);
  return findResponder(m[1]);
}) as typeof fetch;

const { resolvePlexLegacyGuidsDetailed } = await import("../src/lib/plex-legacy-resolve.ts");
type Ref = Parameters<typeof resolvePlexLegacyGuidsDetailed>[0] extends Map<string, infer R> ? R : never;

const data = (ratingKey: string) => ({
  filePath: null, ratingKey, title: "T", year: null, overview: null, contentRating: null, addedAt: null,
}) as Ref["data"];
const refs = (...list: Ref[]) => new Map(list.map((r) => [r.ratingKey, r]));
const reset = () => {
  cacheRows = new Map();
  upserts.length = 0;
  findCalls.length = 0;
  findManyThrows = false;
};

test("a TV show TVDB resolved is not looked up again by its imdb id", async () => {
  reset();
  cacheRows.set("tvdb-to-tmdb:100", JSON.stringify({ tmdbId: 7 }));
  findResponder = () => new Response(JSON.stringify({ tv_results: [{ id: 99 }] }), { status: 200 });
  const res = await resolvePlexLegacyGuidsDetailed(refs(
    { ratingKey: "1", tvdbId: 100, imdbId: "tt100", data: data("1") },
    { ratingKey: "2", imdbId: "tt200", data: data("2") },
  ), "TV");
  assert.deepEqual(findCalls, ["tt200"], "only the show TVDB couldn't place is asked by imdb id");
  assert.deepEqual(res.items.map((i) => [i.ratingKey, i.tmdbId]).sort(), [["1", 7], ["2", 99]]);
  assert.equal(res.complete, true);
});

test("a non-OK or malformed /find answer is not cached and marks the result incomplete", async () => {
  reset();
  findResponder = (id) =>
    id === "tt1"
      ? new Response("busy", { status: 503 })
      : new Response(JSON.stringify({ movie_results: [{ id: "not-a-number" }] }), { status: 200 });
  const res = await resolvePlexLegacyGuidsDetailed(refs(
    { ratingKey: "1", imdbId: "tt1", data: data("1") },
    { ratingKey: "2", imdbId: "tt2", data: data("2") },
  ), "MOVIE");
  assert.equal(res.complete, false);
  assert.deepEqual(res.items, []);
  assert.deepEqual(upserts, [], "a failed lookup must never be cached as 'no match'");
  // The malformed answer alone is incomplete too, not a clean "no match".
  reset();
  const alone = await resolvePlexLegacyGuidsDetailed(refs({ ratingKey: "2", imdbId: "tt2", data: data("2") }), "MOVIE");
  assert.equal(alone.complete, false);
  assert.deepEqual(upserts, []);
});

test("a good /find answer is cached and the result is complete; copies sharing an imdb id cost one lookup", async () => {
  reset();
  findResponder = () => new Response(JSON.stringify({ movie_results: [{ id: 55 }], tv_results: [] }), { status: 200 });
  const res = await resolvePlexLegacyGuidsDetailed(refs(
    { ratingKey: "1", imdbId: "tt9", data: data("1") },
    { ratingKey: "2", imdbId: "tt9", data: data("2") },
  ), "MOVIE");
  assert.equal(res.complete, true);
  assert.deepEqual(findCalls, ["tt9"]);
  assert.deepEqual(upserts, ["imdb-to-tmdb:tt9"]);
  assert.deepEqual(res.items.map((i) => i.tmdbId), [55, 55]);
});

test("a cache read that throws is reported incomplete, never thrown", async () => {
  reset();
  findManyThrows = true;
  const res = await resolvePlexLegacyGuidsDetailed(refs({ ratingKey: "1", imdbId: "tt1", data: data("1") }), "MOVIE");
  assert.deepEqual(res, { items: [], complete: false });
});

test("a cached imdb mapping of the wrong shape is a miss: the id is asked again, never put on a library row", async () => {
  reset();
  cacheRows.set("imdb-to-tmdb:tt5", JSON.stringify({ movie: "55", tv: null }));
  findResponder = () => new Response(JSON.stringify({ movie_results: [{ id: 56 }] }), { status: 200 });
  const res = await resolvePlexLegacyGuidsDetailed(refs({ ratingKey: "1", imdbId: "tt5", data: data("1") }), "MOVIE");
  assert.deepEqual(findCalls, ["tt5"]);
  assert.deepEqual(res.items.map((i) => i.tmdbId), [56]);
  assert.equal(res.complete, true);
});
