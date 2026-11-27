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
  plexLibraryItem: {
    count: async (args: { where: { serverInstance: string; OR: [{ plexRatingKey: { in: string[] } }, { plexRatingKeys: { hasSome: string[] } }] } }) => {
      rowCountWheres.push(args.where);
      const [canonical, any] = args.where.OR;
      return storedRows.filter((r) =>
        r.serverInstance === args.where.serverInstance &&
        (canonical.plexRatingKey.in.includes(r.plexRatingKey) || r.plexRatingKeys.some((k) => any.plexRatingKeys.hasSome.includes(k))),
      ).length;
    },
  },
};
let storedRows: Array<{ serverInstance: string; plexRatingKey: string; plexRatingKeys: string[] }> = [];
const rowCountWheres: unknown[] = [];

const PLEX = "http://plex.test:32400";
let plexShows: Array<Record<string, unknown>> = [];
const findCalls: string[] = [];
let findResponder: (imdbId: string) => Response = () => {
  throw new Error("unexpected /find");
};
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.startsWith(PLEX)) {
    return new Response(JSON.stringify({ MediaContainer: { totalSize: plexShows.length, size: plexShows.length, Metadata: plexShows } }), { status: 200 });
  }
  const m = /\/3\/find\/([^?]+)/.exec(url);
  if (!m) throw new Error(`unexpected fetch ${url}`);
  findCalls.push(m[1]);
  return findResponder(m[1]);
}) as typeof fetch;

const { resolvePlexLegacyGuidsDetailed, storedRowsLostToLegacyShortfall, buildPlexShowKeyMap } = await import("../src/lib/plex-legacy-resolve.ts");
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

test("an incomplete resolution counts the stored rows a full replace would delete — and nothing else", async () => {
  reset();
  rowCountWheres.length = 0;
  storedRows = [
    { serverInstance: "", plexRatingKey: "1", plexRatingKeys: ["1"] },        // resolved on an earlier run
    { serverInstance: "", plexRatingKey: "90", plexRatingKeys: ["90", "3"] }, // held as a duplicate copy
    { serverInstance: "other", plexRatingKey: "2", plexRatingKeys: ["2"] },   // another server's row
    { serverInstance: "", plexRatingKey: "4", plexRatingKeys: ["4"] },        // answered this run: rewritten, not lost
  ];
  const legacy = refs(
    { ratingKey: "1", imdbId: "tt1", data: data("1") },
    { ratingKey: "2", imdbId: "tt2", data: data("2") }, // never resolved here: no row on this server
    { ratingKey: "3", imdbId: "tt3", data: data("3") },
    { ratingKey: "4", imdbId: "tt4", data: data("4") }, // answered this run
  );
  const incomplete = { items: [{ tmdbId: 44, ratingKey: "4", data: data("4") }], complete: false };
  assert.equal(await storedRowsLostToLegacyShortfall("", [{ refs: legacy, resolution: incomplete }]), 2);
  // A ref that has never resolved holds no row: nothing is lost, so nothing holds.
  assert.equal(await storedRowsLostToLegacyShortfall("", [{ refs: refs({ ratingKey: "2", imdbId: "tt2", data: data("2") }), resolution: { items: [], complete: false } }]), 0);
  // A complete resolution is never a shortfall, and costs no read.
  rowCountWheres.length = 0;
  assert.equal(await storedRowsLostToLegacyShortfall("", [{ refs: legacy, resolution: { items: [], complete: true } }]), 0);
  assert.equal(rowCountWheres.length, 0);
});

// The show map feeds a whole-namespace episode-cache replace: a legacy show
// that resolved earlier and is left out of it would lose its cached episodes.
test("the show map rejects when a legacy lookup fell short of a show the server already stores, and only then", async () => {
  const sections = [{ key: "2", title: "TV", type: "show" }] as Parameters<typeof buildPlexShowKeyMap>[3];
  plexShows = [
    { type: "show", ratingKey: "10", title: "Modern", guid: "plex://show/abc", Guid: [{ id: "tmdb://500" }] },
    { type: "show", ratingKey: "11", title: "Legacy", guid: "com.plexapp.agents.imdb://tt11?lang=en" },
  ];

  // The cache read fails, so the legacy show gets no answer; it holds a row.
  reset();
  findManyThrows = true;
  storedRows = [{ serverInstance: "", plexRatingKey: "11", plexRatingKeys: ["11"] }];
  await assert.rejects(buildPlexShowKeyMap(PLEX, "t", undefined, sections, ""), /legacy-agent lookups did not all answer and 1 stored row/);

  // Same shortfall, but the show has never resolved on THIS server: nothing
  // stored depends on it, so the map is built without it.
  storedRows = [{ serverInstance: "other", plexRatingKey: "11", plexRatingKeys: ["11"] }];
  const short = await buildPlexShowKeyMap(PLEX, "t", undefined, sections, "");
  assert.deepEqual([...short.keys()], ["10"]);

  // Every lookup answered: the legacy show is in the map.
  reset();
  cacheRows.set("imdb-to-tmdb:tt11", JSON.stringify({ movie: null, tv: 611 }));
  storedRows = [{ serverInstance: "", plexRatingKey: "11", plexRatingKeys: ["11"] }];
  const full = await buildPlexShowKeyMap(PLEX, "t", undefined, sections, "");
  assert.deepEqual(full.get("11"), [611]);
  assert.deepEqual(full.get("10"), [500]);
  storedRows = [];
  plexShows = [];
});
