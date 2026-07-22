// Unit tests for src/lib/tmdb-prewarm.ts — prewarmLibraryCache, the cron-driven
// walk of the Plex+Jellyfin libraries that fills the `:details` TmdbCache blobs
// and the TmdbMediaCore column store ahead of user traffic. Pinned here are the
// ORCHESTRATION contracts:
//   - counter correctness of the returned { total, fetched, backfilled,
//     skipped, failed } across every decision the run can make;
//   - the no-TMDB-auth and empty-library short-circuits (zero work, zero
//     fetches);
//   - the skip/backfill/fetch triage: a fresh cache row (>25% of its original
//     TTL remaining) WITH a TmdbMediaCore row skips outright; a fresh row
//     WITHOUT a core row is backfilled from the cached JSON with no live
//     fetch; a missing or sub-threshold row is re-fetched from TMDB;
//   - the cold-miss wire shape — per-type path, the per-type append_to_response
//     list (release_dates/content_ratings ride along for the certification,
//     videos for the trailerKey — the drop-on-rewrite regressions the source
//     comments guard), bearer-only auth — and the cache + core writes it
//     produces (US cert extraction, trailerKey/collection/voteCount
//     preservation, TV season filtering);
//   - per-item failure isolation: a rejected item counts failed and neither
//     its batch-mates nor later batches abort; a corrupt cached blob on the
//     backfill path counts failed the same way;
//   - the CONCURRENCY=5 bound: the sixth stale item's fetch is not issued
//     until the first batch of five has settled;
//   - PINS CURRENT BEHAVIOR: fetch-level misses (404 / non-2xx / unparseable
//     body) resolve, so they count as `fetched` even though nothing was
//     written;
//   - cross-source dedup on tmdbId:mediaType and the LIBRARY_PAGE_SIZE page
//     buffer (a >500-item walk is processed in two flushes).
//
// Sibling ownership: tests/library-iterator.test.mts owns the iterator's
// paging contracts (this file only feeds it in-memory library rows);
// tests/tmdb-core-sync.test.mts owns upsertTmdbMediaCore's branch shapes;
// tests/tmdb-cache-ttl.test.mts owns the TTL bucket values (asserted here only
// as loose windows witnessing the releaseDate pass-through).
//
// No DB or network: the library delegates, tmdbCache, and tmdbMediaCore are
// shadowed in-memory (tests/_helpers.mts), globalThis.fetch is scripted, and
// dns/promises.lookup is stubbed so the safe-fetch SSRF resolver never issues
// a real lookup for api.themoviedb.org.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto
const TMDB_TOKEN = "test-tmdb-token";
process.env.TMDB_READ_TOKEN = TMDB_TOKEN; // tmdbAuth() reads this per call

// ── DNS stub (see tests/omdb-quota.test.mts for the rationale) ──────────────
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

// Dynamic imports so the stubs above genuinely precede the module-graph load.
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const { LIBRARY_PAGE_SIZE } = await import("../src/lib/library-iterator.ts");
const { prewarmLibraryCache } = await import("../src/lib/tmdb-prewarm.ts");

// ── in-memory library delegates (cursor-aware findMany) ─────────────────────
// Minimal faithful model of the where/orderBy/cursor/skip/take subset the
// iterator uses — its paging contracts are owned by library-iterator.test.mts.
type MediaType = "MOVIE" | "TV";
type Row = { tmdbId: number; mediaType: MediaType };
type LibFindManyArgs = {
  where: { mediaType: MediaType };
  take: number;
  skip?: number;
  cursor?: { tmdbId_mediaType: { tmdbId: number; mediaType: MediaType } };
};

const libCalls: { source: "plex" | "jellyfin" }[] = [];
const tables: Record<"plex" | "jellyfin", Row[]> = { plex: [], jellyfin: [] };

function libraryDelegate(source: "plex" | "jellyfin") {
  return {
    findMany: async (args: LibFindManyArgs): Promise<Row[]> => {
      libCalls.push({ source });
      const all = tables[source]
        .filter((r) => r.mediaType === args.where.mediaType)
        .sort((a, b) => a.tmdbId - b.tmdbId);
      let start = 0;
      if (args.cursor) {
        const { tmdbId, mediaType } = args.cursor.tmdbId_mediaType;
        const idx = all.findIndex((r) => r.tmdbId === tmdbId && r.mediaType === mediaType);
        if (idx === -1) throw new Error(`cursor row ${tmdbId}:${mediaType} not found`);
        start = idx + (args.skip ?? 0);
      }
      return all.slice(start, start + args.take).map((r) => ({ ...r }));
    },
  };
}

shadowPrismaModel(prisma, "plexLibraryItem", libraryDelegate("plex"));
shadowPrismaModel(prisma, "jellyfinLibraryItem", libraryDelegate("jellyfin"));

// ── tmdbCache stub (freshness reads, backfill reads, setCache writes) ───────
type CacheRow = { key: string; data: string; cachedAt: Date; expiresAt: Date };
const cacheRows = new Map<string, CacheRow>();
const cacheUpserts: CacheRow[] = [];
const cacheFindManyCalls: { keys: string[]; select: Record<string, true> }[] = [];
shadowPrismaModel(prisma, "tmdbCache", {
  findMany: async (args: { where: { key: { in: string[] } }; select: Record<string, true> }) => {
    cacheFindManyCalls.push({ keys: [...args.where.key.in], select: { ...args.select } });
    return args.where.key.in.flatMap((k) => {
      const r = cacheRows.get(k);
      return r ? [{ ...r }] : [];
    });
  },
  upsert: async (args: { where: { key: string }; create: CacheRow }) => {
    cacheUpserts.push(args.create);
    cacheRows.set(args.where.key, args.create);
    return args.create;
  },
});

// ── tmdbMediaCore stub (existence checks + upserts, per-id rejection) ───────
type CoreKey = { tmdbId: number; mediaType: MediaType };
type CoreUpsertArgs = {
  where: { tmdbId_mediaType: CoreKey };
  create: Record<string, unknown> & CoreKey;
  update: Record<string, unknown>;
};
const coreRows = new Set<string>(); // "tmdbId:mediaType"
const coreUpserts: CoreUpsertArgs[] = [];
let coreRejectIds = new Set<number>();
shadowPrismaModel(prisma, "tmdbMediaCore", {
  findMany: async (args: { where: { OR: CoreKey[] } }) =>
    args.where.OR
      .filter((k) => coreRows.has(`${k.tmdbId}:${k.mediaType}`))
      .map((k) => ({ ...k })),
  upsert: async (args: CoreUpsertArgs) => {
    coreUpserts.push(args);
    const k = args.where.tmdbId_mediaType;
    if (coreRejectIds.has(k.tmdbId)) throw new Error(`core store rejected ${k.tmdbId}`);
    coreRows.add(`${k.tmdbId}:${k.mediaType}`);
    return args;
  },
});

// ── scripted fetch ──────────────────────────────────────────────────────────
type FetchCall = { url: URL; headers: Headers };
const fetchCalls: FetchCall[] = [];
let respond: (url: URL) => Response | Promise<Response> = () => {
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

// ── helpers ─────────────────────────────────────────────────────────────────
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Seed a cache row with `remainingMs` of a 24h original TTL left. The prewarm's
// freshness rule is "more than 25% of the ORIGINAL TTL remaining" — with a 24h
// TTL the threshold sits at 6h.
function seedCacheRow(key: string, remainingMs: number, data = "{}"): void {
  const expiresAt = new Date(Date.now() + remainingMs);
  const cachedAt = new Date(expiresAt.getTime() - DAY_MS);
  cacheRows.set(key, { key, data, cachedAt, expiresAt });
}

async function flushTasks(rounds: number): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

async function settleUntil(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`condition never settled: ${what}`);
}

const ZERO = { total: 0, fetched: 0, backfilled: 0, skipped: 0, failed: 0 };

beforeEach(() => {
  tables.plex = [];
  tables.jellyfin = [];
  libCalls.length = 0;
  cacheRows.clear();
  cacheUpserts.length = 0;
  cacheFindManyCalls.length = 0;
  coreRows.clear();
  coreUpserts.length = 0;
  coreRejectIds = new Set();
  fetchCalls.length = 0;
  warns.length = 0;
  errors.length = 0;
  process.env.TMDB_READ_TOKEN = TMDB_TOKEN;
  respond = () => {
    throw new Error("unexpected fetch — script a responder for this test");
  };
});

// ── short-circuits ──────────────────────────────────────────────────────────

test("no TMDB auth: the zero-counter shape with no library scan and no fetch", async () => {
  tables.plex = [{ tmdbId: 1, mediaType: "MOVIE" }];
  delete process.env.TMDB_READ_TOKEN;
  try {
    assert.deepEqual(await prewarmLibraryCache(), ZERO);
    assert.equal(libCalls.length, 0); // the auth gate precedes the library walk
    assert.equal(fetchCalls.length, 0);
  } finally {
    process.env.TMDB_READ_TOKEN = TMDB_TOKEN;
  }
});

test("empty libraries: all four source/type walks run, zero counters, no cache queries, no fetch", async () => {
  assert.deepEqual(await prewarmLibraryCache(), ZERO);
  assert.equal(libCalls.length, 4); // plex MOVIE/TV + jellyfin MOVIE/TV, one empty page each
  assert.equal(cacheFindManyCalls.length, 0); // flushPage no-ops on an empty buffer
  assert.equal(fetchCalls.length, 0);
});

// ── cold-miss wire + writes ─────────────────────────────────────────────────

test("movie cold miss: exact TMDB wire shape, :details cache write with US cert extraction, core upsert — counted fetched", async () => {
  tables.plex = [{ tmdbId: 550, mediaType: "MOVIE" }];
  respond = () => jsonResponse({
    id: 550,
    title: "Fight Club",
    overview: "An insomniac office worker…",
    poster_path: "/fight-club.jpg",
    backdrop_path: "/fc-backdrop.jpg",
    release_date: "1999-10-15",
    vote_average: 8.4,
    vote_count: 27000,
    genres: [{ id: 18, name: "Drama" }],
    belongs_to_collection: { id: 9999, name: "Fight Club Collection" },
    videos: {
      results: [
        { key: "teaser-key", site: "YouTube", type: "Teaser", official: true },
        { key: "unofficial-key", site: "YouTube", type: "Trailer", official: false },
        { key: "official-key", site: "YouTube", type: "Trailer", official: true },
      ],
    },
    release_dates: {
      results: [
        { iso_3166_1: "DE", release_dates: [{ certification: "18" }] },
        { iso_3166_1: "US", release_dates: [{ certification: "" }, { certification: "R" }] },
      ],
    },
  });

  const before = Date.now();
  assert.deepEqual(await prewarmLibraryCache(), { total: 1, fetched: 1, backfilled: 0, skipped: 0, failed: 0 });
  const after = Date.now();

  // Wire: the per-type path, the movie append list (release_dates rides along
  // for the certification), bearer auth, and NO api_key query param.
  assert.equal(fetchCalls.length, 1);
  const call = fetchCalls[0];
  assert.equal(call.url.origin + call.url.pathname, "https://api.themoviedb.org/3/movie/550");
  assert.equal(call.url.searchParams.get("append_to_response"), "keywords,watch/providers,external_ids,release_dates,videos");
  assert.equal(call.url.searchParams.get("api_key"), null);
  assert.equal(call.headers.get("authorization"), `Bearer ${TMDB_TOKEN}`);

  // Cache write: the shared :details key with the normalized essentials. The
  // US certification is the first non-empty release_dates entry.
  assert.equal(cacheUpserts.length, 1);
  const row = cacheUpserts[0];
  assert.equal(row.key, "movie:550:details");
  const blob = JSON.parse(row.data) as Record<string, unknown>;
  assert.equal(blob.id, 550);
  assert.equal(blob.mediaType, "movie");
  assert.equal(blob.title, "Fight Club");
  assert.equal(blob.posterPath, "/fight-club.jpg");
  assert.equal(blob.releaseDate, "1999-10-15");
  assert.equal(blob.releaseYear, "1999");
  assert.equal(blob.certification, "R");
  assert.deepEqual(blob.genres, ["Drama"]);
  assert.equal(blob.voteCount, 27000);
  // The rewrite must preserve the detail-page extras: the official YouTube
  // trailer wins over the unofficial trailer and the teaser, and the movie's
  // collection linkage survives.
  assert.equal(blob.trailerKey, "official-key");
  assert.equal(blob.collectionId, 9999);
  assert.equal(blob.collectionName, "Fight Club Collection");
  assert.equal("seasons" in blob, false); // movies never carry a seasons array
  // A 1999 release lands in the 30-day back-catalog TTL bucket (loose window —
  // the bucket values are owned by tests/tmdb-cache-ttl.test.mts).
  assert.ok(
    row.expiresAt.getTime() >= before + 30 * DAY_MS && row.expiresAt.getTime() <= after + 30 * DAY_MS,
    "the :details row must carry the releaseDate-derived TTL",
  );

  // Core write mirrors the blob essentials under the MOVIE composite key.
  assert.equal(coreUpserts.length, 1);
  assert.deepEqual(coreUpserts[0].where, { tmdbId_mediaType: { tmdbId: 550, mediaType: "MOVIE" } });
  assert.equal(coreUpserts[0].create.title, "Fight Club");
  assert.equal(coreUpserts[0].create.certification, "R");
});

test("tv cold miss: tv path + tv append list, zero/empty seasons filtered, content_ratings cert, TV core key", async () => {
  tables.jellyfin = [{ tmdbId: 1399, mediaType: "TV" }];
  respond = () => jsonResponse({
    id: 1399,
    name: "Game of Thrones",
    first_air_date: "2011-04-17",
    vote_average: 8.4,
    seasons: [
      { season_number: 0, episode_count: 10 }, // specials — filtered out
      { season_number: 1, episode_count: 10, air_date: "2011-04-17", poster_path: "/s1.jpg", name: "Season 1", overview: "Winter." },
      { season_number: 2, episode_count: 0 }, // no episodes — filtered out
    ],
    videos: {
      results: [
        { key: "vimeo-key", site: "Vimeo", type: "Trailer", official: true }, // non-YouTube — ignored
        { key: "got-teaser", site: "YouTube", type: "Teaser", official: true },
      ],
    },
    content_ratings: {
      results: [
        { iso_3166_1: "GB", rating: "15" },
        { iso_3166_1: "US", rating: "TV-MA" },
      ],
    },
  });

  assert.deepEqual(await prewarmLibraryCache(), { total: 1, fetched: 1, backfilled: 0, skipped: 0, failed: 0 });

  const call = fetchCalls[0];
  assert.equal(call.url.origin + call.url.pathname, "https://api.themoviedb.org/3/tv/1399");
  assert.equal(call.url.searchParams.get("append_to_response"), "seasons,keywords,watch/providers,external_ids,content_ratings,videos");

  assert.equal(cacheUpserts[0].key, "tv:1399:details");
  const blob = JSON.parse(cacheUpserts[0].data) as Record<string, unknown>;
  assert.equal(blob.title, "Game of Thrones");
  assert.equal(blob.releaseYear, "2011");
  assert.equal(blob.certification, "TV-MA"); // the US content_ratings entry, not GB
  assert.equal(blob.trailerKey, "got-teaser"); // YouTube teaser fallback; non-YouTube ignored
  assert.deepEqual(blob.seasons, [
    { seasonNumber: 1, episodeCount: 10, airDate: "2011-04-17", posterPath: "/s1.jpg", name: "Season 1", overview: "Winter." },
  ]);

  assert.deepEqual(coreUpserts[0].where, { tmdbId_mediaType: { tmdbId: 1399, mediaType: "TV" } });
});

// ── skip / backfill / fetch triage ──────────────────────────────────────────

test("the 25% threshold: a fresh row with a core row skips (zero writes); a sub-threshold row is re-fetched", async () => {
  tables.plex = [
    { tmdbId: 20, mediaType: "MOVIE" },
    { tmdbId: 21, mediaType: "MOVIE" },
  ];
  // 24h original TTL: 23h remaining (>6h = 25%) ⇒ fresh; 5h remaining ⇒ refetch.
  seedCacheRow("movie:20:details", 23 * HOUR_MS, JSON.stringify({ id: 20 }));
  seedCacheRow("movie:21:details", 5 * HOUR_MS, JSON.stringify({ id: 21 }));
  coreRows.add("20:MOVIE"); // fresh + core-backed ⇒ skipped, never backfilled

  respond = (url) => {
    assert.equal(url.pathname, "/3/movie/21"); // 20 must never be fetched
    return jsonResponse({ id: 21, title: "Refetched", release_date: "2001-01-01" });
  };

  assert.deepEqual(await prewarmLibraryCache(), { total: 2, fetched: 1, backfilled: 0, skipped: 1, failed: 0 });
  assert.equal(fetchCalls.length, 1);
  // The fresh+core item produced no writes; the refetched one rewrote its blob.
  assert.deepEqual(cacheUpserts.map((u) => u.key), ["movie:21:details"]);
  assert.deepEqual(coreUpserts.map((u) => u.where.tmdbId_mediaType.tmdbId), [21]);
});

test("fresh cache without a core row backfills from the cached JSON — no live fetch; a corrupt blob counts failed", async () => {
  tables.plex = [
    { tmdbId: 30, mediaType: "MOVIE" },
    { tmdbId: 31, mediaType: "MOVIE" },
  ];
  seedCacheRow(
    "movie:30:details",
    20 * HOUR_MS,
    JSON.stringify({
      id: 30, mediaType: "movie", title: "Cached Blob", overview: "",
      posterPath: "/c.jpg", backdropPath: null, releaseDate: "2015-05-05",
      releaseYear: "2015", voteAverage: 6,
    }),
  );
  seedCacheRow("movie:31:details", 20 * HOUR_MS, "{corrupt json"); // fresh but unparseable
  // no core rows for either ⇒ both are backfill candidates

  assert.deepEqual(await prewarmLibraryCache(), { total: 2, fetched: 0, backfilled: 1, skipped: 0, failed: 1 });
  assert.equal(fetchCalls.length, 0); // the whole point of the backfill path
  assert.equal(coreUpserts.length, 1);
  assert.deepEqual(coreUpserts[0].where, { tmdbId_mediaType: { tmdbId: 30, mediaType: "MOVIE" } });
  assert.equal(coreUpserts[0].create.title, "Cached Blob"); // parsed from the row, not fetched
  assert.ok(
    warns.some((w) => w.includes("[prewarm] TmdbMediaCore backfill from cache failed:")),
    "the corrupt blob must be warned with the [prewarm] scope",
  );
});

// ── failure isolation + batching ────────────────────────────────────────────

test("a failing item counts failed without aborting its batch or the next batch", async () => {
  tables.plex = Array.from({ length: 6 }, (_, i): Row => ({ tmdbId: i + 1, mediaType: "MOVIE" }));
  coreRejectIds = new Set([3]); // item 3's core upsert rejects ⇒ its chain rejects
  respond = (url) => {
    const id = Number(url.pathname.split("/").pop());
    return jsonResponse({ id, title: `M${id}`, release_date: "2010-01-01" });
  };

  // 6 stale items = one full CONCURRENCY batch + a single-item batch; the
  // second batch running at all proves the failure did not abort the loop.
  assert.deepEqual(await prewarmLibraryCache(), { total: 6, fetched: 5, backfilled: 0, skipped: 0, failed: 1 });
  assert.equal(fetchCalls.length, 6); // every item was still attempted
  assert.ok(warns.some((w) => w.includes("[prewarm] item failed:")));
  // Batch-mates of the failed item (1,2,4,5) and the next batch (6) all wrote
  // their :details blob — and so did 3 itself (setCache precedes the core
  // upsert that rejected).
  assert.deepEqual(
    cacheUpserts.map((u) => u.key).sort(),
    ["movie:1:details", "movie:2:details", "movie:3:details", "movie:4:details", "movie:5:details", "movie:6:details"],
  );
});

test("stale fetches are bounded at CONCURRENCY=5 — the sixth is issued only after the first batch settles", async () => {
  tables.plex = Array.from({ length: 6 }, (_, i): Row => ({ tmdbId: 100 + i, mediaType: "MOVIE" }));
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  respond = async (url) => {
    await gate; // hold every response until the test releases the batch
    const id = Number(url.pathname.split("/").pop());
    return jsonResponse({ id, title: `M${id}` });
  };

  const run = prewarmLibraryCache();
  await settleUntil(() => fetchCalls.length === 5, "the first batch of five is issued");
  await flushTasks(50); // give a sixth fetch every chance to (wrongly) appear
  assert.equal(fetchCalls.length, 5); // bounded — batch 2 waits on batch 1

  release();
  // NOTE: awaiting the run spans the real ~250ms BATCH_DELAY_MS between batches.
  assert.deepEqual(await run, { total: 6, fetched: 6, backfilled: 0, skipped: 0, failed: 0 });
  assert.equal(fetchCalls.length, 6);
});

test("PINS CURRENT BEHAVIOR: 404, non-2xx, and unparseable bodies count as fetched (not failed) and write nothing", async () => {
  tables.plex = [
    { tmdbId: 40, mediaType: "MOVIE" },
    { tmdbId: 41, mediaType: "MOVIE" },
    { tmdbId: 42, mediaType: "MOVIE" },
  ];
  respond = (url) => {
    const id = Number(url.pathname.split("/").pop());
    if (id === 40) return new Response("gone", { status: 404 });
    if (id === 41) return new Response("boom", { status: 500 });
    return new Response("<html>not json</html>", { status: 200 });
  };

  // fetchAndStore swallows HTTP-level misses (warn + return), so the settled
  // promise is FULFILLED: `fetched` counts attempts, not successes — a run
  // that hit only errors still reports fetched=3. Flip these pins if
  // failed-counting is ever wanted for HTTP-level misses.
  assert.deepEqual(await prewarmLibraryCache(), { total: 3, fetched: 3, backfilled: 0, skipped: 0, failed: 0 });
  assert.equal(cacheUpserts.length, 0);
  assert.equal(coreUpserts.length, 0);
  assert.ok(warns.some((w) => w.includes("[prewarm] TMDB movie:41 → HTTP 500")));
  assert.ok(warns.some((w) => w.includes("JSON.parse failed")));
  assert.ok(!warns.some((w) => w.includes("movie:40")), "a 404 is silent — the title simply isn't on TMDB");
});

// ── dedup + page buffering ──────────────────────────────────────────────────

test("cross-source dedup on tmdbId:mediaType and the 500-item page buffer: a 521-title walk processes in two flushes", async () => {
  // plex: movies 1..500 (exactly one full iterator page). jellyfin: movies
  // 481..520 (481..500 are cross-source dups) plus TV 5 (same id as movie 5 —
  // a DISTINCT identity). Everything fresh + core-backed so the test is pure
  // walk/triage with zero fetches.
  tables.plex = Array.from({ length: 500 }, (_, i): Row => ({ tmdbId: i + 1, mediaType: "MOVIE" }));
  tables.jellyfin = [
    ...Array.from({ length: 40 }, (_, i): Row => ({ tmdbId: 481 + i, mediaType: "MOVIE" })),
    { tmdbId: 5, mediaType: "TV" },
  ];
  for (let id = 1; id <= 520; id++) {
    seedCacheRow(`movie:${id}:details`, 20 * HOUR_MS);
    coreRows.add(`${id}:MOVIE`);
  }
  seedCacheRow("tv:5:details", 20 * HOUR_MS);
  coreRows.add("5:TV");

  assert.deepEqual(await prewarmLibraryCache(), { total: 521, fetched: 0, backfilled: 0, skipped: 521, failed: 0 });
  assert.equal(fetchCalls.length, 0);

  // The page buffer flushed once at LIBRARY_PAGE_SIZE and once for the tail:
  // freshness queries of 500 keys, then 21 (20 new jellyfin movies + the TV
  // row). The freshness read is the one selecting cachedAt.
  const freshnessCalls = cacheFindManyCalls.filter((c) => "cachedAt" in c.select);
  assert.deepEqual(freshnessCalls.map((c) => c.keys.length), [LIBRARY_PAGE_SIZE, 21]);
  assert.equal(freshnessCalls[0].keys[0], "movie:1:details");
  assert.ok(freshnessCalls[1].keys.includes("tv:5:details"));
});
