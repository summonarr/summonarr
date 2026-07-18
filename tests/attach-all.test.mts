// Unit tests for attachAllAvailability (src/lib/attach-all.ts) — the single
// chokepoint every discovery list route/page funnels through. It fans out to
// five enrichment passes (Plex, Jellyfin, ARR pending, requested status,
// unified ratings) plus the admin blacklist and the per-user hidden set, then
// merges by the composite `${id}:${mediaType}` key. The contracts pinned here:
//
//   - empty input short-circuits before ANY query (blacklist included);
//   - every item leaves with explicit defaults: plexAvailable /
//     jellyfinAvailable / arrPending / requested / requestedByMe are real
//     false booleans for absent ids, while arr4kPending/arr4kAvailable are
//     key-present-but-undefined unless show4k was passed (tmdb-types:
//     undefined = "the UI shows nothing");
//   - the merge is composite-keyed: a movie hit never marks the tv item that
//     shares its TMDB id, and each source lights only its own flag;
//   - blacklisted titles stay VISIBLE (marked `blacklisted: true`, absent key
//     otherwise — the request POST is the authoritative block), whereas the
//     caller's hidden titles are REMOVED after enrichment; anonymous callers
//     and includeHidden callers are never filtered, and neither even issues
//     the hidden query;
//   - without a userId the per-user request query is skipped entirely;
//   - the ratings-pass output is the MERGE BASE (`...(ratingsMap.get(k) ??
//     item)`), so warm-cache rating fields survive into the final objects
//     with the flags overlaid; skipRatings bypasses the ratings pass without
//     touching the ratings cache;
//   - PINS CURRENT BEHAVIOR: `arrInstances` (built by attachArrPending) is
//     dropped by the merge — only arrPending/arr4k* survive.
//
// No DB or network: every delegate the composition touches (plex/jellyfin
// library items, the four ARR cache tables, mediaRequest, blacklistItem,
// hiddenItem, tmdbCache for the ratings warm cache) is shadowed in-memory via
// tests/_helpers.mts. The ratings tests seed FRESH warm-cache rows for every
// item so attachRatingsUnified never reaches its miss/stale paths — those
// schedule work via next/server's after(), which has no request scope here.
// The blacklist module keeps a 30s module-global cache, so beforeEach calls
// its exported invalidateBlacklistCache(). TOKEN_ENCRYPTION_KEY is set before
// prisma.ts enters the module graph, so source imports are dynamic (static
// imports would hoist above the env assignment).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const { invalidateBlacklistCache } = await import("../src/lib/blacklist.ts");
const { attachAllAvailability } = await import("../src/lib/attach-all.ts");
type TmdbMedia = import("../src/lib/tmdb-types.ts").TmdbMedia;

function media(id: number, mediaType: string): TmdbMedia {
  return { id, mediaType } as unknown as TmdbMedia;
}

// Full interface shape for the exact-output pin (deepEqual needs every key).
function fullMedia(id: number, mediaType: "movie" | "tv"): TmdbMedia {
  return {
    id,
    mediaType,
    title: `T${id}`,
    overview: "",
    posterPath: null,
    backdropPath: null,
    releaseDate: null,
    releaseYear: null,
    voteAverage: 0,
  };
}

// ── in-memory delegates ─────────────────────────────────────────────────────

type LibArgs = { where: { mediaType: "MOVIE" | "TV"; tmdbId: { in: number[] } } };
function makeLibrary() {
  const state = { movie: [] as number[], tv: [] as number[], calls: 0 };
  const stub = {
    findMany: async (args: LibArgs): Promise<Array<{ tmdbId: number }>> => {
      state.calls += 1;
      const lib = args.where.mediaType === "MOVIE" ? state.movie : state.tv;
      return lib.filter((id) => args.where.tmdbId.in.includes(id)).map((tmdbId) => ({ tmdbId }));
    },
  };
  return { state, stub };
}
const plexLib = makeLibrary();
const jellyfinLib = makeLibrary();

type ArrRow = { tmdbId: number; arrInstance: string };
function makeArrTable() {
  const state = { rows: [] as ArrRow[], calls: 0 };
  const stub = {
    findMany: async (args: { where: { tmdbId: { in: number[] } } }): Promise<ArrRow[]> => {
      state.calls += 1;
      return state.rows.filter((r) => args.where.tmdbId.in.includes(r.tmdbId));
    },
  };
  return { state, stub };
}
const radarrWanted = makeArrTable();
const sonarrWanted = makeArrTable();
const radarrAvail = makeArrTable();
const sonarrAvail = makeArrTable();

type RequestRow = { tmdbId: number; mediaType: "MOVIE" | "TV" };
type RequestArgs = { where: { requestedBy?: string; arrInstance?: string; status?: unknown } };
const requests = {
  globalRows: [] as RequestRow[],
  mineRows: [] as RequestRow[],
  calls: [] as RequestArgs[],
};

type EnumRow = { tmdbId: number; mediaType: "MOVIE" | "TV" };
const blacklist = { rows: [] as EnumRow[], calls: 0 };
const hidden = { rows: [] as EnumRow[], calls: [] as Array<{ where: { userId: string } }> };

type CacheRow = { key: string; data: string; cachedAt: Date; expiresAt: Date };
const ratingsCache = { rows: [] as CacheRow[], calls: [] as string[][] };

shadowPrismaModel(prisma, "plexLibraryItem", plexLib.stub);
shadowPrismaModel(prisma, "jellyfinLibraryItem", jellyfinLib.stub);
shadowPrismaModel(prisma, "radarrWantedItem", radarrWanted.stub);
shadowPrismaModel(prisma, "sonarrWantedItem", sonarrWanted.stub);
shadowPrismaModel(prisma, "radarrAvailableItem", radarrAvail.stub);
shadowPrismaModel(prisma, "sonarrAvailableItem", sonarrAvail.stub);
shadowPrismaModel(prisma, "mediaRequest", {
  findMany: async (args: RequestArgs): Promise<RequestRow[]> => {
    requests.calls.push(args);
    return args.where.requestedBy ? requests.mineRows : requests.globalRows;
  },
});
shadowPrismaModel(prisma, "blacklistItem", {
  findMany: async (): Promise<EnumRow[]> => {
    blacklist.calls += 1;
    return blacklist.rows;
  },
});
shadowPrismaModel(prisma, "hiddenItem", {
  findMany: async (args: { where: { userId: string } }): Promise<EnumRow[]> => {
    hidden.calls.push(args);
    return hidden.rows;
  },
});
shadowPrismaModel(prisma, "tmdbCache", {
  findMany: async (args: { where: { key: { in: string[] } } }): Promise<CacheRow[]> => {
    ratingsCache.calls.push([...args.where.key.in]);
    return ratingsCache.rows.filter((r) => args.where.key.in.includes(r.key));
  },
});

const FRESH = () => new Date(Date.now() + 60 * 60 * 1000);
// A full MdblistRatings-shaped blob, as fetchMdblistBatch would have cached it.
const MDBLIST_603 = {
  imdbId: "tt0133093",
  imdbRating: "8.7",
  imdbVotes: "2100000",
  rottenTomatoes: "83",
  rtAudienceScore: "85",
  metacritic: "73",
  traktRating: "87",
  letterboxdRating: "4.3",
  mdblistScore: "84",
  malRating: null,
  rogerEbertRating: null,
  releasedDigital: null,
  trailerUrl: "https://youtu.be/m8e-FF8MsqU",
};

beforeEach(() => {
  plexLib.state.movie = [];
  plexLib.state.tv = [];
  plexLib.state.calls = 0;
  jellyfinLib.state.movie = [];
  jellyfinLib.state.tv = [];
  jellyfinLib.state.calls = 0;
  for (const t of [radarrWanted, sonarrWanted, radarrAvail, sonarrAvail]) {
    t.state.rows = [];
    t.state.calls = 0;
  }
  requests.globalRows = [];
  requests.mineRows = [];
  requests.calls.length = 0;
  blacklist.rows = [];
  blacklist.calls = 0;
  hidden.rows = [];
  hidden.calls.length = 0;
  ratingsCache.rows = [];
  ratingsCache.calls.length = 0;
  invalidateBlacklistCache(); // the 30s module-global cache must not leak across tests
});

const SKIP = { skipRatings: true } as const;

test("empty input returns the same array before ANY query — blacklist and hidden included", async () => {
  const items: TmdbMedia[] = [];
  const out = await attachAllAvailability(items, "u_1");
  assert.equal(out, items);
  assert.equal(blacklist.calls, 0);
  assert.equal(hidden.calls.length, 0);
  assert.equal(plexLib.state.calls + jellyfinLib.state.calls, 0);
  assert.equal(requests.calls.length, 0);
  assert.equal(ratingsCache.calls.length, 0);
});

test("no rows anywhere → the exact enriched shape: false flags, undefined 4k keys, no blacklisted key", async () => {
  const out = await attachAllAvailability([fullMedia(603, "movie")], undefined, SKIP);
  // arr4kPending/arr4kAvailable are PRESENT-but-undefined (show4k off), and
  // `blacklisted` is wholly absent — both distinctions are load-bearing for the UI.
  assert.deepEqual(out, [
    {
      ...fullMedia(603, "movie"),
      plexAvailable: false,
      jellyfinAvailable: false,
      arrPending: false,
      arr4kPending: undefined,
      arr4kAvailable: undefined,
      requested: false,
      requestedByMe: false,
    },
  ]);
  assert.equal("blacklisted" in out[0], false);
});

test("each source lights only its own flag — Plex and Jellyfin never bleed into each other", async () => {
  plexLib.state.movie = [603];
  jellyfinLib.state.tv = [1399];
  const out = await attachAllAvailability(
    [media(603, "movie"), media(1399, "tv"), media(999, "movie")],
    undefined,
    SKIP,
  );
  assert.deepEqual(
    out.map((i) => [i.id, i.plexAvailable, i.jellyfinAvailable]),
    [
      [603, true, false],
      [1399, false, true],
      [999, false, false],
    ],
  );
});

test("the merge is composite-keyed: a movie hit never marks the tv item sharing the id", async () => {
  plexLib.state.movie = [80];
  const out = await attachAllAvailability([media(80, "movie"), media(80, "tv")], undefined, SKIP);
  assert.deepEqual(
    out.map((i) => [i.mediaType, i.plexAvailable]),
    [
      ["movie", true],
      ["tv", false],
    ],
  );
});

test("arrPending stays default-instance scoped through the composition; show4k gates the 4k fields", async () => {
  radarrWanted.state.rows = [
    { tmdbId: 603, arrInstance: "" },
    { tmdbId: 603, arrInstance: "4k" },
    { tmdbId: 604, arrInstance: "4k" }, // 4k-only: must NOT read as default-pending
  ];
  radarrAvail.state.rows = [{ tmdbId: 604, arrInstance: "4k" }];

  const off = await attachAllAvailability([media(603, "movie"), media(604, "movie")], undefined, SKIP);
  assert.deepEqual(off.map((i) => [i.arrPending, i.arr4kPending, i.arr4kAvailable]), [
    [true, undefined, undefined],
    [false, undefined, undefined], // 4k rows exist but show4k is off → UI shows nothing
  ]);

  const on = await attachAllAvailability([media(603, "movie"), media(604, "movie")], undefined, {
    ...SKIP,
    show4k: true,
  });
  assert.deepEqual(on.map((i) => [i.arrPending, i.arr4kPending, i.arr4kAvailable]), [
    [true, true, false],
    [false, true, true],
  ]);
});

test("requested/requestedByMe flow through per item from the global and per-user queries", async () => {
  requests.globalRows = [{ tmdbId: 603, mediaType: "MOVIE" }];
  requests.mineRows = [{ tmdbId: 1399, mediaType: "TV" }];
  const out = await attachAllAvailability(
    [media(603, "movie"), media(1399, "tv"), media(999, "movie")],
    "u_1",
    SKIP,
  );
  assert.deepEqual(
    out.map((i) => [i.id, i.requested, i.requestedByMe]),
    [
      [603, true, false],
      [1399, false, true],
      [999, false, false],
    ],
  );
});

test("without a userId: the per-user request query and the hidden query never run, nothing is filtered", async () => {
  hidden.rows = [{ tmdbId: 603, mediaType: "MOVIE" }]; // would hide 603 if a user were attached
  const out = await attachAllAvailability([media(603, "movie")], undefined, SKIP);
  assert.equal(out.length, 1); // anonymous callers are never hidden-filtered
  assert.equal(hidden.calls.length, 0);
  assert.equal(requests.calls.length, 1); // global only
  assert.equal(requests.calls[0].where.requestedBy, undefined);
  assert.equal(out[0].requestedByMe, false);
});

test("blacklisted titles stay visible with blacklisted:true; non-matches get NO blacklisted key", async () => {
  blacklist.rows = [{ tmdbId: 603, mediaType: "MOVIE" }];
  const out = await attachAllAvailability(
    [media(603, "movie"), media(604, "movie"), media(603, "tv")],
    "u_1",
    SKIP,
  );
  assert.equal(out.length, 3); // marked, never removed — the request POST is the real block
  assert.equal(out[0].blacklisted, true); // enum-vs-tmdb casing bridged by blacklistKey
  assert.equal("blacklisted" in out[1], false); // absent ⇒ requestable, not false
  assert.equal("blacklisted" in out[2], false); // MOVIE row must not mark the tv sibling
});

test("the caller's hidden titles are removed AFTER enrichment; survivors keep flags and order", async () => {
  hidden.rows = [{ tmdbId: 604, mediaType: "MOVIE" }]; // stored enum-cased, matched lowercased
  plexLib.state.movie = [603, 605];
  const out = await attachAllAvailability(
    [media(603, "movie"), media(604, "movie"), media(605, "movie")],
    "u_1",
    SKIP,
  );
  assert.deepEqual(
    out.map((i) => [i.id, i.plexAvailable]),
    [
      [603, true],
      [605, true], // 604 gone, order preserved, enrichment intact
    ],
  );
  assert.equal(hidden.calls.length, 1);
  assert.equal(hidden.calls[0].where.userId, "u_1");
});

test("includeHidden keeps the title AND skips the hidden query entirely", async () => {
  hidden.rows = [{ tmdbId: 603, mediaType: "MOVIE" }];
  const out = await attachAllAvailability([media(603, "movie")], "u_1", {
    ...SKIP,
    includeHidden: true,
  });
  assert.equal(out.length, 1);
  assert.equal(hidden.calls.length, 0); // opt-out means no query, not query-and-ignore
});

test("warm ratings are the merge base: rating fields survive with flags overlaid; sentinels stay bare", async () => {
  // Every item must be warm (value row or _notFound sentinel) — a miss would
  // send attachRatingsUnified into after(), which has no request scope here.
  ratingsCache.rows = [
    { key: "mdblist:tmdb:movie:603", data: JSON.stringify(MDBLIST_603), cachedAt: new Date(), expiresAt: FRESH() },
    { key: "mdblist:tmdb:movie:604", data: JSON.stringify({ _notFound: true }), cachedAt: new Date(), expiresAt: FRESH() },
  ];
  plexLib.state.movie = [604];
  const out = await attachAllAvailability([media(603, "movie"), media(604, "movie")], "u_1");

  // 603: mdblist warm row merged in, flags overlaid on top of it.
  assert.equal(out[0].imdbRating, "8.7");
  assert.equal(out[0].imdbId, "tt0133093");
  assert.equal(out[0].letterboxdRating, "4.3");
  assert.equal(out[0].plexAvailable, false);
  assert.equal(out[0].requested, false);
  // 604: fresh _notFound sentinel → no rating fields, but every flag still lands.
  assert.equal("imdbRating" in out[1], false);
  assert.equal(out[1].plexAvailable, true);

  // The warm read asks for exactly the two provider keyspaces, one query each.
  assert.deepEqual(ratingsCache.calls, [
    ["mdblist:tmdb:movie:603", "mdblist:tmdb:movie:604"],
    ["omdb:tmdb:movie:603", "omdb:tmdb:movie:604"],
  ]);
});

test("skipRatings bypasses the ratings pass — the ratings cache is never queried", async () => {
  ratingsCache.rows = [
    { key: "mdblist:tmdb:movie:603", data: JSON.stringify(MDBLIST_603), cachedAt: new Date(), expiresAt: FRESH() },
  ];
  const out = await attachAllAvailability([media(603, "movie")], "u_1", SKIP);
  assert.equal(ratingsCache.calls.length, 0);
  assert.equal("imdbRating" in out[0], false); // base is the raw item, not a ratings merge
});

test("PINS CURRENT BEHAVIOR: arrInstances from the arr pass is dropped by the merge", async () => {
  // attachArrPending builds the per-slug map, but attachAllAvailability's merge
  // only carries arrPending/arr4k* forward — named-instance UIs must call
  // attachArrPending directly. If attach-all is ever taught to propagate the
  // map, flip this pin deliberately (and audit the response shapes of every
  // list route that funnels through here — they would all start emitting it).
  radarrWanted.state.rows = [
    { tmdbId: 603, arrInstance: "" },
    { tmdbId: 603, arrInstance: "anime" },
  ];
  const out = await attachAllAvailability([media(603, "movie")], undefined, SKIP);
  assert.equal(out[0].arrPending, true); // the default-slug signal DOES survive
  assert.equal("arrInstances" in out[0], false); // the per-slug map does not
});
