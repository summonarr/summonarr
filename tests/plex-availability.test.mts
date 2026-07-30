// Unit tests for attachPlexAvailability (src/lib/plex-availability.ts) — the
// "in your Plex library" badge attachment used by every discovery grid. The
// contracts pinned here:
//
//   - the query shape IS the perf contract: items are split by mediaType into
//     one `tmdbId IN (…)` findMany per type (the composite
//     (tmdbId, mediaType, serverInstance) PK serves it on its leading columns),
//     replacing the old wide `OR: items.map(...)` the planner couldn't optimize.
//     A regression back to per-item OR terms — or a merged single query — would
//     be silent but slow on 100+-row rails;
//   - every query is scoped to the caller's visible server instances
//     (`serverInstance: { in: [...] }`): a Plex server marked `restricted`
//     contributes availability ONLY to users granted `view` on it. Dropping that
//     clause leaks a restricted library to every viewer — enforced in the DATA
//     layer, not masked in the UI, so the raw API payload never carries it;
//   - an empty side issues NO query (movie-only input never touches the TV
//     branch and vice versa), and empty input short-circuits with zero queries;
//   - every returned item carries an explicit `plexAvailable` boolean — false
//     for absent ids, never undefined — because tmdb-types documents undefined
//     as "not yet attached" and callers key badge rendering off that;
//   - availability is type-scoped: a MOVIE library row must never mark the TV
//     item that happens to share the same TMDB id (movie and tv are
//     independent TMDB id spaces);
//   - input order and unrelated fields survive, and the input objects are not
//     mutated (the map builds copies).
//
// The module's sole impurity is prisma.plexLibraryItem.findMany (availability
// is derived purely from the local sync cache — no live Plex call). The tests
// shadow that delegate in-memory (tests/_helpers.mts). TOKEN_ENCRYPTION_KEY is
// set before the module graph loads (prisma.ts pulls in token-crypto), so the
// source imports are dynamic — static imports would hoist above the env
// assignment.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const { attachPlexAvailability } = await import("../src/lib/plex-availability.ts");
type TmdbMedia = import("../src/lib/tmdb-types.ts").TmdbMedia;

function media(id: number, mediaType: string): TmdbMedia {
  return { id, mediaType } as unknown as TmdbMedia;
}

type FindManyArgs = {
  where: { mediaType: "MOVIE" | "TV"; tmdbId: { in: number[] }; serverInstance: { in: string[] } };
  select: { tmdbId: boolean };
};

// The single-server deployment every existing pin below runs as: only the
// default ("") instance exists, so its allowlist is the one every caller passes.
const DEFAULT_ONLY = [""];
// A second, restricted server ("remote") the viewer HAS been granted.
const WITH_REMOTE = ["", "remote"];

// Library rows present per media type; the stub dispatches on where.mediaType.
// The *Remote lists live on the "remote" server instance, so the stub can honour
// the serverInstance allowlist exactly as Postgres would.
let movieLib: number[] = [];
let tvLib: number[] = [];
let movieLibRemote: number[] = [];
let tvLibRemote: number[] = [];
const calls: FindManyArgs[] = [];

shadowPrismaModel(prisma, "plexLibraryItem", {
  findMany: async (args: FindManyArgs): Promise<Array<{ tmdbId: number }>> => {
    calls.push(args);
    const isMovie = args.where.mediaType === "MOVIE";
    const rows = [
      ...(isMovie ? movieLib : tvLib).map((tmdbId) => ({ tmdbId, serverInstance: "" })),
      ...(isMovie ? movieLibRemote : tvLibRemote).map((tmdbId) => ({ tmdbId, serverInstance: "remote" })),
    ];
    // Echo back only the rows the query actually asked for, like the real table.
    return rows
      .filter((r) => args.where.tmdbId.in.includes(r.tmdbId) && args.where.serverInstance.in.includes(r.serverInstance))
      .map((r) => ({ tmdbId: r.tmdbId }));
  },
});

beforeEach(() => {
  movieLib = [];
  tvLib = [];
  movieLibRemote = [];
  tvLibRemote = [];
  calls.length = 0;
});

test("empty input returns the same array with zero queries", async () => {
  const items: TmdbMedia[] = [];
  const out = await attachPlexAvailability(items, DEFAULT_ONLY);
  assert.equal(out, items); // identity short-circuit, not a copy
  assert.equal(calls.length, 0);
});

test("movie-only input issues exactly one MOVIE IN-query — the TV branch never runs", async () => {
  await attachPlexAvailability([media(603, "movie"), media(604, "movie")], DEFAULT_ONLY);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    where: { mediaType: "MOVIE", tmdbId: { in: [603, 604] }, serverInstance: { in: [""] } },
    select: { tmdbId: true },
  });
});

test("tv-only input issues exactly one TV IN-query — the MOVIE branch never runs", async () => {
  await attachPlexAvailability([media(1399, "tv")], DEFAULT_ONLY);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    where: { mediaType: "TV", tmdbId: { in: [1399] }, serverInstance: { in: [""] } },
    select: { tmdbId: true },
  });
});

test("mixed input partitions ids into one query per mediaType, preserving item order within each", async () => {
  await attachPlexAvailability(
    [media(603, "movie"), media(1399, "tv"), media(604, "movie"), media(66732, "tv")],
    DEFAULT_ONLY,
  );
  assert.equal(calls.length, 2);
  const movieCall = calls.find((c) => c.where.mediaType === "MOVIE");
  const tvCall = calls.find((c) => c.where.mediaType === "TV");
  assert.deepEqual(movieCall?.where.tmdbId.in, [603, 604]);
  assert.deepEqual(tvCall?.where.tmdbId.in, [1399, 66732]);
});

test("library hits flag true, misses flag an explicit false — never undefined", async () => {
  movieLib = [603];
  tvLib = [1399];
  const out = await attachPlexAvailability(
    [media(603, "movie"), media(605, "movie"), media(1399, "tv"), media(999, "tv")],
    DEFAULT_ONLY,
  );
  assert.deepEqual(
    out.map((i) => [i.id, i.plexAvailable]),
    [
      [603, true],
      [605, false], // explicit false: undefined means "not attached yet" to callers
      [1399, true],
      [999, false],
    ],
  );
  for (const i of out) assert.equal(typeof i.plexAvailable, "boolean");
});

test("a MOVIE library row never marks the TV item sharing the same tmdbId (and vice versa)", async () => {
  // movie and tv are independent TMDB id spaces — id 80 exists in both.
  movieLib = [80];
  tvLib = [81];
  const out = await attachPlexAvailability(
    [media(80, "movie"), media(80, "tv"), media(81, "movie"), media(81, "tv")],
    DEFAULT_ONLY,
  );
  assert.deepEqual(
    out.map((i) => [i.id, i.mediaType, i.plexAvailable]),
    [
      [80, "movie", true],
      [80, "tv", false],
      [81, "movie", false],
      [81, "tv", true],
    ],
  );
});

test("input objects are not mutated; output copies keep order and unrelated fields", async () => {
  movieLib = [550];
  const items = [
    { id: 550, mediaType: "movie", title: "Fight Club", voteAverage: 8.4 } as unknown as TmdbMedia,
    { id: 551, mediaType: "movie", title: "Other", voteAverage: 5 } as unknown as TmdbMedia,
  ];
  const out = await attachPlexAvailability(items, DEFAULT_ONLY);
  assert.notEqual(out[0], items[0]); // spread copy, not in-place write
  assert.equal(items[0].plexAvailable, undefined); // originals untouched
  assert.deepEqual(
    out.map((i) => [i.id, i.title, i.voteAverage, i.plexAvailable]),
    [
      [550, "Fight Club", 8.4, true],
      [551, "Other", 5, false],
    ],
  );
});

test("PINS CURRENT BEHAVIOR: duplicate ids are not deduplicated before the IN-clause", async () => {
  // The id list is a bare filter+map — duplicates ride into the query verbatim.
  // Harmless (IN dedups server-side) but pinned so an intentional future dedup
  // shows up as a deliberate flip, not silent drift. Both duplicates get flagged.
  movieLib = [7];
  const out = await attachPlexAvailability([media(7, "movie"), media(7, "movie")], DEFAULT_ONLY);
  assert.deepEqual(calls[0].where.tmdbId.in, [7, 7]);
  assert.deepEqual(out.map((i) => i.plexAvailable), [true, true]);
});

test("an item that is neither movie nor tv joins no query and reads false via the tv branch", async () => {
  // Defensive: TmdbMedia.mediaType is typed "movie" | "tv", but multi-search
  // shapes have leaked other strings before. Such an item must never widen a
  // query — it falls through to the tv-set lookup and reads false.
  movieLib = [42];
  tvLib = [42];
  const out = await attachPlexAvailability([media(42, "person"), media(42, "movie")], DEFAULT_ONLY);
  assert.equal(calls.length, 1); // only the MOVIE query — "person" joined neither id list
  assert.deepEqual(calls[0].where.tmdbId.in, [42]);
  assert.deepEqual(
    out.map((i) => [i.mediaType, i.plexAvailable]),
    [
      ["person", false],
      ["movie", true],
    ],
  );
});

// ── per-user server visibility ──────────────────────────────────────────────

test("BOTH queries carry the serverInstance allowlist — the whole enforcement point", async () => {
  // The headline structural pin. Delete either clause and a restricted server's
  // library silently becomes global; nothing else in the module notices.
  await attachPlexAvailability([media(603, "movie"), media(1399, "tv")], WITH_REMOTE);
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.deepEqual(c.where.serverInstance, { in: ["", "remote"] }, `${c.where.mediaType} query lost its scope`);
  }
});

test("a granted and an ungranted viewer get DIFFERENT availability for the same tmdbId", async () => {
  // 603 exists only on the restricted "remote" server. Telling the ungranted
  // viewer it's available leaves them no way to get a copy they can watch.
  movieLibRemote = [603];
  const granted = await attachPlexAvailability([media(603, "movie")], WITH_REMOTE);
  const ungranted = await attachPlexAvailability([media(603, "movie")], DEFAULT_ONLY);
  assert.equal(granted[0].plexAvailable, true);
  assert.equal(ungranted[0].plexAvailable, false);
});

test("a copy on ANY visible instance still counts — visibility narrows, it never dedups", async () => {
  // Same title on the default AND the restricted server: both viewers see it,
  // because the default server is visible to everyone.
  movieLib = [603];
  movieLibRemote = [603];
  const ungranted = await attachPlexAvailability([media(603, "movie")], DEFAULT_ONLY);
  assert.equal(ungranted[0].plexAvailable, true);
});

test("an empty allowlist yields no availability at all (fail-closed)", async () => {
  // Not reachable through media-visibility.ts (the default instance is never
  // restricted, so the list always holds ""), but pinned because `{ in: [] }`
  // must read as "sees nothing" rather than degrade to "sees everything".
  movieLib = [603];
  movieLibRemote = [603];
  const out = await attachPlexAvailability([media(603, "movie")], []);
  assert.equal(out[0].plexAvailable, false);
});
