// Unit tests for the activity-view poster resolver (src/lib/poster-cache.ts).
// resolvePosterMap backs the posters on admin activity surfaces: it must (a)
// prefer the cheap TmdbMediaCore posterPath column, (b) fall back to the
// `movie:/tv:<id>:details` TmdbCache blobs only for ids core couldn't resolve,
// (c) OMIT unresolvable ids from the returned map — callers key their
// letter-placeholder fallback off absence, so a null/empty entry would break
// the UI contract — and (d) key on `posterPathKey`, never the bare number, so a
// mixed movie+TV list can't collapse two titles onto one poster.
// There is no local DB in this harness: src/lib/prisma.ts
// caches its client on globalThis (`globalForPrisma.prisma ?? create...`), so
// we pre-seed that slot with an in-memory fake BEFORE the module graph loads —
// no query ever leaves the process.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto

// mediaType is optional here so the pre-existing fixtures (which omit it) keep
// reading as the "movie" namespace, exactly as an unmapped row does in prod.
type CoreRow = { tmdbId: number; mediaType?: string | null; posterPath: string | null };
type CacheRow = { key: string; data: string };
type CoreFindManyArgs = { where: { tmdbId: { in: number[] } } };
type CacheFindManyArgs = { where: { key: { in: string[] } } };

const coreCalls: number[][] = [];
const cacheCalls: string[][] = [];
let coreRows: CoreRow[] = [];
let cacheRows: CacheRow[] = [];

const fakePrisma = {
  tmdbMediaCore: {
    findMany: async (args: CoreFindManyArgs): Promise<CoreRow[]> => {
      coreCalls.push([...args.where.tmdbId.in]);
      return coreRows;
    },
  },
  tmdbCache: {
    findMany: async (args: CacheFindManyArgs): Promise<CacheRow[]> => {
      cacheCalls.push([...args.where.key.in]);
      return cacheRows;
    },
  },
};

(globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;
const { resolvePosterMap, resolvePosterPathMap, posterPathKey } = await import("../src/lib/poster-cache.ts");

function reset(opts: { core?: CoreRow[]; cache?: CacheRow[] } = {}): void {
  coreCalls.length = 0;
  cacheCalls.length = 0;
  coreRows = opts.core ?? [];
  cacheRows = opts.cache ?? [];
}

const W342 = "https://image.tmdb.org/t/p/w342"; // posterUrl(path, "w342") prefix

test("empty input and null-only tmdbIds resolve to {} without touching the DB", async () => {
  reset();
  assert.deepEqual(await resolvePosterMap([]), {});
  assert.deepEqual(await resolvePosterMap([{ tmdbId: null }, { tmdbId: null }]), {});
  assert.equal(coreCalls.length, 0);
  assert.equal(cacheCalls.length, 0);
});

test("core rows resolve to exact w342 URLs and skip the cache query entirely", async () => {
  reset({
    core: [
      { tmdbId: 550, posterPath: "/fight-club.jpg" },
      { tmdbId: 1399, posterPath: "/thrones.jpg" },
    ],
  });
  const map = await resolvePosterMap([{ tmdbId: 550 }, { tmdbId: 1399 }]);
  assert.deepEqual(map, {
    "movie:550": `${W342}/fight-club.jpg`,
    "movie:1399": `${W342}/thrones.jpg`,
  });
  assert.equal(coreCalls.length, 1);
  assert.equal(cacheCalls.length, 0); // all ids resolved — no fallback round-trip
});

test("duplicate and null tmdbIds are deduplicated before the core query", async () => {
  reset();
  await resolvePosterMap([
    { tmdbId: 7 },
    { tmdbId: 7 },
    { tmdbId: null },
    { tmdbId: 42 },
    { tmdbId: 42 },
    { tmdbId: 7 },
  ]);
  assert.deepEqual(coreCalls, [[7, 42]]); // one query, unique ids, insertion order
});

test("ids the core misses fall back to exactly the movie:/tv: :details keys", async () => {
  reset({
    core: [{ tmdbId: 1, posterPath: "/one.jpg" }],
    cache: [{ key: "movie:2:details", data: JSON.stringify({ posterPath: "/two.jpg" }) }],
  });
  const map = await resolvePosterMap([{ tmdbId: 1 }, { tmdbId: 2 }, { tmdbId: 3 }]);
  // Only the core misses (2, 3) hit the fallback, both media-type keys per id.
  assert.deepEqual(cacheCalls, [
    ["movie:2:details", "tv:2:details", "movie:3:details", "tv:3:details"],
  ]);
  assert.deepEqual(map, {
    "movie:1": `${W342}/one.jpg`,
    "movie:2": `${W342}/two.jpg`,
    // 3 is absent — caller falls back to the letter placeholder
  });
});

test("core rows with null or non-slash posterPath fall through to the cache", async () => {
  // posterUrl() rejects paths that don't start with "/" (older cache rows held
  // empty strings), so such a core row must not shadow a usable cache blob.
  reset({
    core: [
      { tmdbId: 10, posterPath: null },
      { tmdbId: 11, posterPath: "no-leading-slash.jpg" },
    ],
    cache: [
      { key: "movie:10:details", data: JSON.stringify({ posterPath: "/ten.jpg" }) },
      { key: "tv:11:details", data: JSON.stringify({ posterPath: "/eleven.jpg" }) },
    ],
  });
  const map = await resolvePosterMap([{ tmdbId: 10 }, { tmdbId: 11 }]);
  assert.deepEqual(cacheCalls, [
    ["movie:10:details", "tv:10:details", "movie:11:details", "tv:11:details"],
  ]);
  assert.deepEqual(map, {
    "movie:10": `${W342}/ten.jpg`,
    "movie:11": `${W342}/eleven.jpg`,
  });
});

test("an UNKNOWN mediaType resolves deterministically (movie namespace), not by row order", async () => {
  // This used to be "first cache row returned wins", i.e. whatever order Postgres
  // happened to hand back — the same heap-order dependence that let a TV title be
  // served a movie's art. With no mediaType to go on the caller gets a stable
  // answer instead: posterPathKey(id, null) spells "movie:<id>", so movie wins.
  const both = [
    { key: "tv:5:details", data: JSON.stringify({ posterPath: "/tv-poster.jpg" }) },
    { key: "movie:5:details", data: JSON.stringify({ posterPath: "/movie-poster.jpg" }) },
  ];
  reset({ cache: both });
  assert.deepEqual(await resolvePosterMap([{ tmdbId: 5 }]), { "movie:5": `${W342}/movie-poster.jpg` });

  // Same answer with the rows returned the other way round.
  reset({ cache: [...both].reverse() });
  assert.deepEqual(await resolvePosterMap([{ tmdbId: 5 }]), { "movie:5": `${W342}/movie-poster.jpg` });

  // And when the caller DOES know the type, it gets that type's art.
  reset({ cache: both });
  assert.deepEqual(
    await resolvePosterMap([{ tmdbId: 5, mediaType: "TV" }]),
    { "tv:5": `${W342}/tv-poster.jpg` },
  );
});

test("unparseable JSON and malformed cache keys are skipped, never thrown", async () => {
  reset({
    cache: [
      { key: "movie:8:details", data: "{not json at all" },
      { key: "movie:not-a-number:details", data: JSON.stringify({ posterPath: "/x.jpg" }) },
      { key: "tv:9:details", data: JSON.stringify({ posterPath: "/nine.jpg" }) },
    ],
  });
  const map = await resolvePosterMap([{ tmdbId: 8 }, { tmdbId: 9 }]);
  assert.deepEqual(map, { "movie:9": `${W342}/nine.jpg` }); // 8 dropped silently, 9 unaffected
});

test("cache blobs without a usable posterPath leave the id out of the map", async () => {
  reset({
    cache: [
      { key: "movie:20:details", data: JSON.stringify({}) },
      { key: "movie:21:details", data: JSON.stringify({ posterPath: null }) },
      { key: "movie:22:details", data: JSON.stringify({ posterPath: "" }) },
      { key: "movie:23:details", data: JSON.stringify({ posterPath: "relative.jpg" }) },
    ],
  });
  const map = await resolvePosterMap([
    { tmdbId: 20 },
    { tmdbId: 21 },
    { tmdbId: 22 },
    { tmdbId: 23 },
  ]);
  assert.deepEqual(map, {}); // absence, not null entries — the placeholder contract
});

test("core poster shadows a conflicting cache blob for the same id", async () => {
  // An id resolved by core must not be re-queried or overwritten by the
  // fallback pass, even if a stale cache row for it were to come back.
  reset({
    core: [{ tmdbId: 30, posterPath: "/core.jpg" }],
    cache: [{ key: "movie:31:details", data: JSON.stringify({ posterPath: "/cache-31.jpg" }) }],
  });
  const map = await resolvePosterMap([{ tmdbId: 30 }, { tmdbId: 31 }]);
  assert.deepEqual(cacheCalls, [["movie:31:details", "tv:31:details"]]); // 30 not re-queried
  assert.deepEqual(map, {
    "movie:30": `${W342}/core.jpg`,
    "movie:31": `${W342}/cache-31.jpg`,
  });
});

test("duplicate core rows: first row wins for the same tmdbId", async () => {
  reset({
    core: [
      { tmdbId: 40, posterPath: "/first.jpg" },
      { tmdbId: 40, posterPath: "/second.jpg" },
    ],
  });
  const map = await resolvePosterMap([{ tmdbId: 40 }]);
  assert.deepEqual(map, { "movie:40": `${W342}/first.jpg` });
});

// ── resolvePosterPathMap ─────────────────────────────────────────────────────
// The raw-path variant native clients read (they append their own size), which
// resolvePosterMap is now defined in terms of. Same lookup and same absence
// contract — only the value shape differs.

test("path variant returns raw TMDB paths, never w342 URLs, from both sources", async () => {
  reset({
    core: [{ tmdbId: 1, posterPath: "/one.jpg" }],
    cache: [{ key: "tv:2:details", data: JSON.stringify({ posterPath: "/two.jpg" }) }],
  });
  const map = await resolvePosterPathMap([{ tmdbId: 1 }, { tmdbId: 2 }, { tmdbId: 3 }]);
  // Keyed "<movie|tv>:<id>", not the bare number. These callers passed no
  // mediaType, so each resolved path is mirrored onto both spellings — that is
  // what preserves the lenient pre-existing behaviour for unmapped rows.
  assert.deepEqual(map, {
    "movie:1": "/one.jpg", "tv:1": "/one.jpg",
    "movie:2": "/two.jpg", "tv:2": "/two.jpg",
  }); // 3 absent, not null
  assert.deepEqual(cacheCalls, [
    ["movie:2:details", "tv:2:details", "movie:3:details", "tv:3:details"],
  ]);
});

test("a movie and a TV title sharing one tmdbId keep their OWN posters", async () => {
  // TMDB namespaces movie and TV ids separately, and TmdbMediaCore is
  // @@id([tmdbId, mediaType]) — so both rows routinely coexist. A bare-numeric
  // key made this first-writer-wins and served one medium's art on the other
  // (the same bug play-history.ts's posterKeysFor already fixed for sessions).
  reset({
    core: [
      { tmdbId: 1399, mediaType: "MOVIE", posterPath: "/film.jpg" },
      { tmdbId: 1399, mediaType: "TV", posterPath: "/show.jpg" },
    ],
  });
  const map = await resolvePosterPathMap([
    { tmdbId: 1399, mediaType: "MOVIE" },
    { tmdbId: 1399, mediaType: "TV" },
  ]);
  assert.equal(map[posterPathKey(1399, "MOVIE")], "/film.jpg");
  assert.equal(map[posterPathKey(1399, "TV")], "/show.jpg");

  // ...and the URL variant keeps them apart per item too.
  const urls = await resolvePosterMap([{ tmdbId: 1399, mediaType: "TV" }]);
  assert.equal(urls[posterPathKey(1399, "TV")], `${W342}/show.jpg`);
});

test("the URL variant survives a MIXED movie+TV list sharing one tmdbId", async () => {
  // The collapse this pins: resolvePosterMap did the namespace-correct per-item
  // lookup and then wrote it under the bare number, so the first item's art was
  // returned for both media. 5 of its 7 call sites pass mixed lists (a watch
  // history page, the wrapped top titles, the two topMedia dashboards, the
  // rewatched leaderboard), so both media routinely arrive in one call.
  reset({
    core: [
      { tmdbId: 1399, mediaType: "MOVIE", posterPath: "/film.jpg" },
      { tmdbId: 1399, mediaType: "TV", posterPath: "/show.jpg" },
    ],
  });
  const urls = await resolvePosterMap([
    { tmdbId: 1399, mediaType: "MOVIE" },
    { tmdbId: 1399, mediaType: "TV" },
  ]);
  assert.deepEqual(urls, {
    "movie:1399": `${W342}/film.jpg`,
    "tv:1399": `${W342}/show.jpg`,
  });
});

test("a NAMED namespace is resolved on its own even when its twin already hit", async () => {
  // `wanted` is a union per numeric id, so a MOVIE item and a TV item sharing
  // one number both mark it as "two namespaces requested". That must not let the
  // movie hit short-circuit the TV lookup: the TV `:details` row has to be
  // queried, or the TV row renders the film's art.
  reset({
    core: [{ tmdbId: 1399, mediaType: "MOVIE", posterPath: "/movie-1399.jpg" }],
    cache: [{ key: "tv:1399:details", data: JSON.stringify({ posterPath: "/tv-1399.jpg" }) }],
  });
  const map = await resolvePosterPathMap([
    { tmdbId: 1399, mediaType: "MOVIE" },
    { tmdbId: 1399, mediaType: "TV" },
  ]);
  assert.deepEqual(cacheCalls, [["tv:1399:details"]]); // the named miss, nothing else
  assert.equal(map[posterPathKey(1399, "MOVIE")], "/movie-1399.jpg");
  assert.equal(map[posterPathKey(1399, "TV")], "/tv-1399.jpg");
});

test("an untyped sibling never mirrors its art onto a NAMED namespace", async () => {
  // One unmapped row (mediaType null) alongside a real TV play of the same
  // number. Only MOVIE data exists, so the TV row must stay absent (letter
  // placeholder) rather than inherit the movie poster; the untyped row still
  // resolves through its "movie:<id>" spelling.
  reset({ core: [{ tmdbId: 1399, mediaType: "MOVIE", posterPath: "/movie-1399.jpg" }] });
  const map = await resolvePosterPathMap([
    { tmdbId: 1399, mediaType: null },
    { tmdbId: 1399, mediaType: "TV" },
  ]);
  assert.equal(map[posterPathKey(1399, null)], "/movie-1399.jpg");
  assert.equal(map[posterPathKey(1399, "TV")], undefined);
});

test("path variant skips paths posterUrl would reject and empties out to {}", async () => {
  reset({
    core: [{ tmdbId: 50, posterPath: "no-leading-slash.jpg" }],
    cache: [{ key: "movie:50:details", data: JSON.stringify({ posterPath: "" }) }],
  });
  assert.deepEqual(await resolvePosterPathMap([{ tmdbId: 50 }]), {});
  reset();
  assert.deepEqual(await resolvePosterPathMap([{ tmdbId: null }]), {});
  assert.equal(coreCalls.length, 0);
});
