// Unit tests for attachJellyfinAvailability (src/lib/jellyfin-availability.ts)
// — the "in your Jellyfin library" badge attachment. The module is the verbatim
// sibling of plex-availability.ts (same split-by-mediaType query plan, same
// flag semantics, different table + output field); it is pinned independently
// here so a drift in EITHER copy — e.g. a fix applied to one and not the other
// — fails its own file. Contracts:
//
//   - the query shape IS the perf contract: one `tmdbId IN (…)` findMany per
//     mediaType against jellyfinLibraryItem (served by the composite
//     (tmdbId, mediaType) PK), never the old wide `OR: items.map(...)`;
//   - an empty side issues NO query; empty input short-circuits with zero
//     queries and returns the input array itself;
//   - every returned item carries an explicit `jellyfinAvailable` boolean —
//     false for absent ids, never undefined ("undefined = not attached yet" is
//     the tmdb-types contract callers key badge rendering off);
//   - availability is type-scoped: a MOVIE row never marks the TV item sharing
//     the same TMDB id (independent id spaces);
//   - input order and unrelated fields survive; input objects are not mutated.
//
// Sole impurity: prisma.jellyfinLibraryItem.findMany (availability comes from
// the local sync cache, not a live Jellyfin call) — shadowed in-memory via
// tests/_helpers.mts. TOKEN_ENCRYPTION_KEY is set before prisma.ts enters the
// module graph, so source imports are dynamic (static imports would hoist).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const { attachJellyfinAvailability } = await import("../src/lib/jellyfin-availability.ts");
type TmdbMedia = import("../src/lib/tmdb-types.ts").TmdbMedia;

function media(id: number, mediaType: string): TmdbMedia {
  return { id, mediaType } as unknown as TmdbMedia;
}

type FindManyArgs = {
  where: { mediaType: "MOVIE" | "TV"; tmdbId: { in: number[] } };
  select: { tmdbId: boolean };
};

let movieLib: number[] = [];
let tvLib: number[] = [];
const calls: FindManyArgs[] = [];

shadowPrismaModel(prisma, "jellyfinLibraryItem", {
  findMany: async (args: FindManyArgs): Promise<Array<{ tmdbId: number }>> => {
    calls.push(args);
    const lib = args.where.mediaType === "MOVIE" ? movieLib : tvLib;
    return lib.filter((id) => args.where.tmdbId.in.includes(id)).map((tmdbId) => ({ tmdbId }));
  },
});

beforeEach(() => {
  movieLib = [];
  tvLib = [];
  calls.length = 0;
});

test("empty input returns the same array with zero queries", async () => {
  const items: TmdbMedia[] = [];
  const out = await attachJellyfinAvailability(items);
  assert.equal(out, items);
  assert.equal(calls.length, 0);
});

test("movie-only input issues exactly one MOVIE IN-query — the TV branch never runs", async () => {
  await attachJellyfinAvailability([media(603, "movie"), media(604, "movie")]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    where: { mediaType: "MOVIE", tmdbId: { in: [603, 604] } },
    select: { tmdbId: true },
  });
});

test("tv-only input issues exactly one TV IN-query — the MOVIE branch never runs", async () => {
  await attachJellyfinAvailability([media(1399, "tv")]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    where: { mediaType: "TV", tmdbId: { in: [1399] } },
    select: { tmdbId: true },
  });
});

test("mixed input partitions ids into one query per mediaType, preserving item order within each", async () => {
  await attachJellyfinAvailability([
    media(603, "movie"),
    media(1399, "tv"),
    media(604, "movie"),
    media(66732, "tv"),
  ]);
  assert.equal(calls.length, 2);
  const movieCall = calls.find((c) => c.where.mediaType === "MOVIE");
  const tvCall = calls.find((c) => c.where.mediaType === "TV");
  assert.deepEqual(movieCall?.where.tmdbId.in, [603, 604]);
  assert.deepEqual(tvCall?.where.tmdbId.in, [1399, 66732]);
});

test("library hits flag true, misses flag an explicit false — never undefined", async () => {
  movieLib = [603];
  tvLib = [1399];
  const out = await attachJellyfinAvailability([
    media(603, "movie"),
    media(605, "movie"),
    media(1399, "tv"),
    media(999, "tv"),
  ]);
  assert.deepEqual(
    out.map((i) => [i.id, i.jellyfinAvailable]),
    [
      [603, true],
      [605, false],
      [1399, true],
      [999, false],
    ],
  );
  for (const i of out) assert.equal(typeof i.jellyfinAvailable, "boolean");
});

test("a MOVIE library row never marks the TV item sharing the same tmdbId (and vice versa)", async () => {
  movieLib = [80];
  tvLib = [81];
  const out = await attachJellyfinAvailability([
    media(80, "movie"),
    media(80, "tv"),
    media(81, "movie"),
    media(81, "tv"),
  ]);
  assert.deepEqual(
    out.map((i) => [i.id, i.mediaType, i.jellyfinAvailable]),
    [
      [80, "movie", true],
      [80, "tv", false],
      [81, "movie", false],
      [81, "tv", true],
    ],
  );
});

test("input objects are not mutated; output copies keep order and unrelated fields", async () => {
  tvLib = [1396];
  const items = [
    { id: 1396, mediaType: "tv", title: "Breaking Bad", voteAverage: 8.9 } as unknown as TmdbMedia,
    { id: 1397, mediaType: "tv", title: "Other", voteAverage: 5 } as unknown as TmdbMedia,
  ];
  const out = await attachJellyfinAvailability(items);
  assert.notEqual(out[0], items[0]);
  assert.equal(items[0].jellyfinAvailable, undefined);
  assert.deepEqual(
    out.map((i) => [i.id, i.title, i.voteAverage, i.jellyfinAvailable]),
    [
      [1396, "Breaking Bad", 8.9, true],
      [1397, "Other", 5, false],
    ],
  );
});

test("PINS CURRENT BEHAVIOR: duplicate ids are not deduplicated before the IN-clause", async () => {
  // Mirrors the plex sibling — pinned so a future dedup lands as a deliberate
  // flip in both files, not an accidental divergence between the two copies.
  movieLib = [7];
  const out = await attachJellyfinAvailability([media(7, "movie"), media(7, "movie")]);
  assert.deepEqual(calls[0].where.tmdbId.in, [7, 7]);
  assert.deepEqual(out.map((i) => i.jellyfinAvailable), [true, true]);
});

test("an item that is neither movie nor tv joins no query and reads false via the tv branch", async () => {
  movieLib = [42];
  tvLib = [42];
  const out = await attachJellyfinAvailability([media(42, "person"), media(42, "movie")]);
  assert.equal(calls.length, 1); // "person" joined neither id list
  assert.deepEqual(calls[0].where.tmdbId.in, [42]);
  assert.deepEqual(
    out.map((i) => [i.mediaType, i.jellyfinAvailable]),
    [
      ["person", false],
      ["movie", true],
    ],
  );
});
