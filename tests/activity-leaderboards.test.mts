// Unit tests for the poster source of the activity leaderboards
// (getMostRewatched → getMostRewatchedUncached → withLivePosterPaths, the same
// tail getTopWatchedUncached uses for the Top Watched board).
//
// The leaderboard SQL carries `MAX("posterPath")` — the finalize-time snapshot
// off PlayHistory, which is null for any title whose `:details` TmdbCache row
// didn't exist when it was watched. Both consumers render that field directly
// (the admin Statistics page via posterUrl(), the iOS Admin Activity rows via
// PosterImage), so shipping the snapshot alone left them on placeholder tiles.
// The live TmdbMediaCore/TmdbCache path must win, with the snapshot kept as the
// fallback for titles the caches no longer hold.
//
// Harness: the poster-cache idiom — pre-seed `globalThis.prisma` with an
// in-memory fake BEFORE the module graph loads, so no query can leave the
// process. getMostRewatched memoizes per (filters, limit), so every test uses a
// distinct `days` to get a real query rather than a cache hit.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto

type Row = {
  tmdbId: number;
  mediaType: string;
  title: string;
  posterPath: string | null; // the PlayHistory snapshot, MAX()'d per group
  plays: bigint;
  viewers: bigint;
};

let rows: Row[] = [];
let coreRows: { tmdbId: number; mediaType?: string; posterPath: string | null }[] = [];
let cacheRows: { key: string; data: string }[] = [];
const rawSql: string[] = [];

const fakePrisma = {
  $queryRawUnsafe: async (sql: string): Promise<Row[]> => {
    rawSql.push(sql);
    return rows;
  },
  tmdbMediaCore: {
    findMany: async (args: { where: { tmdbId: { in: number[] } } }) =>
      coreRows.filter((r) => args.where.tmdbId.in.includes(r.tmdbId)),
  },
  tmdbCache: {
    findMany: async (args: { where: { key: { in: string[] } } }) =>
      cacheRows.filter((r) => args.where.key.in.includes(r.key)),
  },
};

(globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;
const { getMostRewatched } = await import("../src/lib/play-history.ts");

function row(over: Partial<Row> = {}): Row {
  return { tmdbId: 550, mediaType: "MOVIE", title: "Fight Club", posterPath: null, plays: 4n, viewers: 2n, ...over };
}

test("a null snapshot resolves to the live core path (and stays a raw path)", async () => {
  rows = [row({ tmdbId: 550, posterPath: null }), row({ tmdbId: 1399, mediaType: "TV", posterPath: null })];
  coreRows = [
    { tmdbId: 550, posterPath: "/fight-club.jpg" },
    { tmdbId: 1399, mediaType: "TV", posterPath: "/thrones.jpg" },
  ];
  cacheRows = [];

  const out = await getMostRewatched({ days: 11 }, 10);
  assert.deepEqual(out.map((r) => r.posterPath), ["/fight-club.jpg", "/thrones.jpg"]);
  // The rest of the row shape is untouched (bigints narrowed to numbers).
  assert.deepEqual(out[0], {
    tmdbId: 550, mediaType: "MOVIE", title: "Fight Club",
    posterPath: "/fight-club.jpg", plays: 4, viewers: 2,
  });
});

test("live art wins over a stale snapshot; the TmdbCache blob covers a core miss", async () => {
  rows = [row({ tmdbId: 550, posterPath: "/stale.jpg" }), row({ tmdbId: 603, posterPath: null })];
  coreRows = [{ tmdbId: 550, posterPath: "/current.jpg" }];
  cacheRows = [{ key: "movie:603:details", data: JSON.stringify({ posterPath: "/matrix.jpg" }) }];

  const out = await getMostRewatched({ days: 12 }, 10);
  assert.deepEqual(out.map((r) => r.posterPath), ["/current.jpg", "/matrix.jpg"]);
});

test("the snapshot is the fallback when neither cache holds the title", async () => {
  rows = [row({ tmdbId: 9999, posterPath: "/snapshot-only.jpg" }), row({ tmdbId: 4242, posterPath: null })];
  coreRows = [];
  cacheRows = [];

  const out = await getMostRewatched({ days: 13 }, 10);
  assert.deepEqual(out.map((r) => r.posterPath), ["/snapshot-only.jpg", null]);
});

test("an empty leaderboard resolves without issuing a poster query", async () => {
  rows = [];
  coreRows = [{ tmdbId: 550, posterPath: "/never-read.jpg" }];
  let coreQueried = false;
  const core = fakePrisma.tmdbMediaCore.findMany;
  fakePrisma.tmdbMediaCore.findMany = async (args) => { coreQueried = true; return core(args); };

  assert.deepEqual(await getMostRewatched({ days: 14 }, 10), []);
  assert.equal(coreQueried, false); // resolvePosterPathMap short-circuits on zero ids
  fakePrisma.tmdbMediaCore.findMany = core;
});

test("the memoized wrapper is still a memo — a repeat call issues no second query", async () => {
  rows = [row({ tmdbId: 550, posterPath: null })];
  coreRows = [{ tmdbId: 550, posterPath: "/cached.jpg" }];
  rawSql.length = 0;

  const first = await getMostRewatched({ days: 15 }, 10);
  const second = await getMostRewatched({ days: 15 }, 10);
  assert.equal(rawSql.length, 1);
  assert.deepEqual(second, first);
});
