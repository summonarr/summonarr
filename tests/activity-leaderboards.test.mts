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
const rawParams: unknown[][] = [];

const fakePrisma = {
  $queryRawUnsafe: async (sql: string, ...params: unknown[]): Promise<Row[]> => {
    rawSql.push(sql);
    rawParams.push(params);
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

// "Rewatched" is a PER-EPISODE verdict. PlayHistory holds one row per episode
// under the show's tmdbId, so a title-level `HAVING COUNT(*) > 1` ranked any
// show with two different episodes watched once each as a rewatch, and every
// multi-episode show outranked a genuinely rewatched movie. The query must
// count plays inside a (tmdbId, mediaType, season, episode) partition — the
// same COALESCE(…, -1) key the arc CTEs use — and only then roll up per title.
test("the rewatch verdict is keyed per episode, and the limit stays the last bound param", async () => {
  rows = [];
  rawSql.length = 0;
  rawParams.length = 0;
  await getMostRewatched({ days: 16, source: "plex", mediaType: "TV" }, 7);

  assert.equal(rawSql.length, 1, "one leaderboard query, no poster lookup on an empty board");
  const sql = rawSql[0]!.replace(/\s+/g, " ");
  const params = rawParams[0]!;

  const partition = sql.match(/PARTITION BY (.+?) \) AS episode_plays/)?.[1] ?? "";
  assert.ok(partition.includes(`"tmdbId"`) && partition.includes(`"mediaType"`), `partition carries the title key: ${partition}`);
  assert.ok(partition.includes(`COALESCE("seasonNumber", -1)`), `partition carries the season: ${partition}`);
  assert.ok(partition.includes(`COALESCE("episodeNumber", -1)`), `partition carries the episode: ${partition}`);
  assert.ok(/WHERE episode_plays > 1/.test(sql), "rows survive only when THEIR episode was played more than once");
  assert.ok(
    !/HAVING COUNT\(\*\) > 1/.test(sql),
    "no title-level HAVING COUNT(*) > 1 — that is the 'two episodes once each = rewatch' bug",
  );
  assert.ok(/GROUP BY "tmdbId", "mediaType" ORDER BY plays DESC/.test(sql), "the roll-up is still per title");

  // Push-then-read-length: the limit is the last param and its $-index points at it.
  assert.equal(params.at(-1), 7);
  assert.ok(sql.endsWith(`LIMIT $${params.length}`), `limit binds the last placeholder: ${sql.slice(-40)}`);
  assert.deepEqual(params.slice(1), ["plex", "TV", 7], "cutoff, then the whitelisted filters, then the limit");
});
