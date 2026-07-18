// Unit tests for src/lib/omdb-prewarm.ts — prewarmOmdbCache, the cron pass
// that refreshes the omdb:tmdb:* ratings rows for every library item. Pinned
// here are the ORCHESTRATION contracts:
//   - counter correctness of the returned { total, fetched, notFound, skipped,
//     failed } — including that `fetched` counts found:true results only and
//     that items never attempted after an early stop appear in NO counter;
//   - the ordered short-circuits: quota-locked-at-start aborts BEFORE the
//     omdbApiKey Setting read and the library scan; no-API-key aborts before
//     the scan; an empty library returns zeros after it;
//   - the skip-vs-fetch triage on the 25%-of-original-TTL freshness threshold,
//     and — PINS CURRENT BEHAVIOR — that a sub-threshold-but-UNEXPIRED row is
//     "re-fetched" through getOmdbRatingsForTmdb, which serves it warm: the
//     counter says fetched (or notFound for a sentinel) with zero network;
//   - the details-blob releaseDate pass-through (witnessed via the written
//     rows' age-scaled TTLs) and cross-source dedup of the item list;
//   - per-item failure isolation: one rejected chain counts failed without
//     aborting batch-mates or the run;
//   - the mid-run quota stop: once a batch trips the OMDB lockout, the
//     post-batch check breaks the loop and later batches are never issued.
//
// Sibling ownership: tests/omdb.test.mts + tests/omdb-quota.test.mts own the
// getOmdbRatingsForTmdb chain itself (wire shapes, parsing, sentinel/lockout
// semantics — this file drives the REAL chain with scripted fetch and asserts
// only what the orchestrator does with its results); tests/library-iterator
// .test.mts owns collectAllLibraryItems' paging; tests/tmdb-cache-ttl.test.mts
// owns the TTL bucket values used as pass-through witnesses here.
//
// Ordering notes: the OMDB quota lockout is module-global with no reset
// export, and this file's clock (Date-only mock timers) is never advanced —
// so the two lockout tests run LAST: the mid-run-stop test trips the lockout
// and the locked-at-start test rides it.
//
// No DB or network: setting/tmdbCache and the library delegates are shadowed
// in-memory (tests/_helpers.mts), globalThis.fetch is scripted per host, and
// dns/promises.lookup is stubbed so the safe-fetch SSRF resolver never issues
// a real lookup for api.themoviedb.org / www.omdbapi.com.
import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto
const TMDB_TOKEN = "test-tmdb-token";
process.env.TMDB_READ_TOKEN = TMDB_TOKEN; // the external_ids resolve reads this per call

// Freeze the clock BEFORE the module graph loads (imports below are DYNAMIC —
// static imports would hoist above this): lockout arithmetic, cache TTLs, and
// the 30s API-key memo all read the mocked Date. setTimeout stays REAL — the
// prewarm's ~250ms inter-batch delay genuinely sleeps.
const T0 = Date.UTC(2026, 0, 15, 12, 0, 0);
mock.timers.enable({ apis: ["Date"], now: T0 });
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

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

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const { isOmdbQuotaLocked } = await import("../src/lib/omdb.ts");
const { prewarmOmdbCache } = await import("../src/lib/omdb-prewarm.ts");

// ── in-memory library delegates (cursor-aware findMany) ─────────────────────
// Paging contracts are owned by tests/library-iterator.test.mts — this is only
// the faithful where/orderBy/cursor/skip/take subset the iterator uses.
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

// ── prisma stubs ────────────────────────────────────────────────────────────
// The prewarm reads the omdbApiKey Setting directly; omdb.ts's memoized
// getApiKey reads the same row. One stub serves both, with read tracking so
// the "lockout precedes the key read" ordering pin is possible.
const DEFAULT_KEY = "test-omdb-key";
let omdbApiKeyValue: string | null = DEFAULT_KEY;
const settingReads: string[] = [];
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    settingReads.push(args.where.key);
    return args.where.key === "omdbApiKey" && omdbApiKeyValue !== null
      ? { key: "omdbApiKey", value: omdbApiKeyValue }
      : null;
  },
});

type CacheRow = { key: string; data: string; cachedAt: Date; expiresAt: Date };
const cacheRows = new Map<string, CacheRow>();
const cacheUpserts: CacheRow[] = [];
const cacheFindManyCalls: string[][] = [];
const cacheFindUniqueRejectKeys = new Set<string>();
shadowPrismaModel(prisma, "tmdbCache", {
  // Point reads back getCache/getCacheStale inside the omdb chain; a scripted
  // per-key rejection is the deterministic way to make one item's chain reject.
  findUnique: async (args: { where: { key: string } }) => {
    if (cacheFindUniqueRejectKeys.has(args.where.key)) {
      throw new Error(`cache read exploded for ${args.where.key}`);
    }
    return cacheRows.get(args.where.key) ?? null;
  },
  // Batch reads back the prewarm's freshness pass and its details-blob pass.
  findMany: async (args: { where: { key: { in: string[] } } }) => {
    cacheFindManyCalls.push([...args.where.key.in]);
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
  deleteMany: async (args: { where: { key?: string } }) => {
    // getCache's lazy expiry cleanup — not expected here, but a faithful no-op
    // beats an exploding stub.
    if (args.where.key) cacheRows.delete(args.where.key);
    return { count: 0 };
  },
});

// ── scripted fetch (routed per upstream host) ───────────────────────────────
type FetchCall = { url: URL };
const fetchCalls: FetchCall[] = [];
let respond: (url: URL) => Response | Promise<Response> = () => {
  throw new Error("unexpected fetch — script a responder for this test");
};

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  fetchCalls.push({ url });
  return respond(url);
}) as typeof fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ── helpers ─────────────────────────────────────────────────────────────────
// Seed a cache row with `remainingMs` of a 24h original TTL left. The prewarm's
// freshness rule is "more than 25% of the ORIGINAL TTL remaining" — with a 24h
// TTL the threshold sits at 6h. All times read the mocked clock.
function seedCacheRow(key: string, remainingMs: number, data = "{}"): void {
  const expiresAt = new Date(Date.now() + remainingMs);
  const cachedAt = new Date(expiresAt.getTime() - DAY_MS);
  cacheRows.set(key, { key, data, cachedAt, expiresAt });
}

const ratingsRow = (imdbId: string, rating: string) =>
  JSON.stringify({ imdbId, imdbRating: rating, imdbVotes: null, rottenTomatoes: null, metacritic: null });

const ZERO = { total: 0, fetched: 0, notFound: 0, skipped: 0, failed: 0 };

beforeEach(() => {
  tables.plex = [];
  tables.jellyfin = [];
  libCalls.length = 0;
  settingReads.length = 0;
  cacheRows.clear();
  cacheUpserts.length = 0;
  cacheFindManyCalls.length = 0;
  cacheFindUniqueRejectKeys.clear();
  fetchCalls.length = 0;
  warns.length = 0;
  errors.length = 0;
  respond = () => {
    throw new Error("unexpected fetch — script a responder for this test");
  };
});

// ── short-circuits ──────────────────────────────────────────────────────────

test("no OMDB API key: the zero-counter shape without a library scan or a fetch", async () => {
  omdbApiKeyValue = null;
  tables.plex = [{ tmdbId: 1, mediaType: "MOVIE" }];
  try {
    assert.deepEqual(await prewarmOmdbCache(), ZERO);
    assert.equal(libCalls.length, 0); // the key gate precedes collectAllLibraryItems
    assert.equal(fetchCalls.length, 0);
    assert.deepEqual(settingReads, ["omdbApiKey"]); // the prewarm's own direct read
  } finally {
    omdbApiKeyValue = DEFAULT_KEY;
  }
});

test("empty library: zero counters after the scan — no cache reads, no fetches", async () => {
  assert.deepEqual(await prewarmOmdbCache(), ZERO);
  assert.equal(libCalls.length, 4); // plex MOVIE/TV + jellyfin MOVIE/TV, one empty page each
  assert.equal(cacheFindManyCalls.length, 0); // no items ⇒ neither batch-read loop runs
  assert.equal(fetchCalls.length, 0);
});

// ── cold chain + triage ─────────────────────────────────────────────────────

test("cold items run the external_ids→OMDB chain: found counts fetched, a null imdb_id counts notFound, cross-source dups collapse, and the details releaseDate drives the written TTL", async () => {
  tables.plex = [
    { tmdbId: 550, mediaType: "MOVIE" },
    { tmdbId: 603, mediaType: "MOVIE" },
  ];
  tables.jellyfin = [
    { tmdbId: 550, mediaType: "MOVIE" }, // cross-source dup — one item, not two
    { tmdbId: 1399, mediaType: "TV" },
  ];
  // 550 has a details blob with a this-year release; 1399 has none (null date).
  seedCacheRow("movie:550:details", 20 * HOUR_MS, JSON.stringify({ releaseDate: "2026-01-01" }));

  respond = (url) => {
    if (url.hostname === "api.themoviedb.org") {
      if (url.pathname === "/3/movie/550/external_ids") return jsonResponse({ imdb_id: "tt0000550" });
      if (url.pathname === "/3/movie/603/external_ids") return jsonResponse({ imdb_id: null });
      if (url.pathname === "/3/tv/1399/external_ids") return jsonResponse({ imdb_id: "tt0001399" });
    }
    if (url.hostname === "www.omdbapi.com") {
      return jsonResponse({ Response: "True", imdbRating: "8.8" });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  assert.deepEqual(await prewarmOmdbCache(), { total: 3, fetched: 2, notFound: 1, skipped: 0, failed: 0 });
  // 3 external_ids resolves + 2 OMDB calls (603 short-circuits on the null id).
  assert.equal(fetchCalls.filter((c) => c.url.hostname === "api.themoviedb.org").length, 3);
  assert.equal(fetchCalls.filter((c) => c.url.hostname === "www.omdbapi.com").length, 2);

  // releaseDate flowed from the details blob into the written rows' TTLs:
  // this-year 550 → the 3d bucket, date-less 1399 → the 30d bucket (bucket
  // values owned by tests/tmdb-cache-ttl.test.mts — here they only witness
  // the pass-through).
  assert.equal(cacheRows.get("omdb:tmdb:movie:550")?.expiresAt.getTime(), Date.now() + 3 * DAY_MS);
  assert.equal(cacheRows.get("omdb:tmdb:tv:1399")?.expiresAt.getTime(), Date.now() + 30 * DAY_MS);
});

test("triage: a fresh row skips; sub-threshold-but-UNEXPIRED rows count fetched/notFound with ZERO network (PINS CURRENT BEHAVIOR); only absent rows fetch", async () => {
  tables.plex = [
    { tmdbId: 700, mediaType: "MOVIE" }, // fresh ratings row → skipped
    { tmdbId: 701, mediaType: "MOVIE" }, // <25% left but unexpired → "fetched", served warm
    { tmdbId: 702, mediaType: "MOVIE" }, // no row → the real chain
    { tmdbId: 703, mediaType: "MOVIE" }, // <25% left, sentinel → notFound, no network
  ];
  seedCacheRow("omdb:tmdb:movie:700", 20 * HOUR_MS, ratingsRow("tt700", "7.0"));
  seedCacheRow("omdb:tmdb:movie:701", 1 * HOUR_MS, ratingsRow("tt701", "7.1"));
  seedCacheRow("omdb:tmdb:movie:703", 1 * HOUR_MS, JSON.stringify({ _notFound: true }));

  // Any fetch for 700/701/703 falls through to the throwing default and would
  // reject that item's chain — the counters below would show it as failed.
  respond = (url) => {
    if (url.pathname === "/3/movie/702/external_ids") return jsonResponse({ imdb_id: "tt0000702" });
    if (url.hostname === "www.omdbapi.com") return jsonResponse({ Response: "True", imdbRating: "5.0" });
    throw new Error(`unexpected fetch ${url}`);
  };

  // 701 is below the prewarm's 25% threshold so it is "re-fetched" — but the
  // underlying getOmdbRatingsForTmdb serves any UNEXPIRED row from cache, so
  // no request leaves the process and the near-expiry row stays until it truly
  // expires. The counter still reports it as fetched (703's sentinel as
  // notFound). Flip this pin if the prewarm ever purges near-expiry rows the
  // way mdblist-prewarm purges sentinels.
  assert.deepEqual(await prewarmOmdbCache(), { total: 4, fetched: 2, notFound: 1, skipped: 1, failed: 0 });
  assert.equal(fetchCalls.length, 2); // 702's external_ids + OMDB — nothing else
});

test("no TMDB read token: cold items degrade to notFound with zero fetches and zero cache writes", async () => {
  tables.plex = [{ tmdbId: 720, mediaType: "MOVIE" }];
  delete process.env.TMDB_READ_TOKEN;
  try {
    // fetchAndCacheOmdbForTmdb returns { found:false, keyConfigured:true }
    // without fetching or caching when the TMDB token is missing (a config
    // gap, not an authoritative absence) — the prewarm counts it notFound.
    assert.deepEqual(await prewarmOmdbCache(), { total: 1, fetched: 0, notFound: 1, skipped: 0, failed: 0 });
    assert.equal(fetchCalls.length, 0);
    assert.equal(cacheUpserts.length, 0);
  } finally {
    process.env.TMDB_READ_TOKEN = TMDB_TOKEN;
  }
});

// ── failure isolation ───────────────────────────────────────────────────────

test("a rejected item counts failed and neither batch-mates nor the run abort", async () => {
  tables.plex = [
    { tmdbId: 730, mediaType: "MOVIE" },
    { tmdbId: 731, mediaType: "MOVIE" },
    { tmdbId: 732, mediaType: "MOVIE" },
  ];
  // Reject the point read getCacheStale makes for 731 — the chain's first await.
  cacheFindUniqueRejectKeys.add("omdb:tmdb:movie:731");
  respond = (url) => {
    const m = url.pathname.match(/^\/3\/movie\/(730|732)\/external_ids$/);
    if (m) return jsonResponse({ imdb_id: `tt0000${m[1]}` });
    if (url.hostname === "www.omdbapi.com") return jsonResponse({ Response: "True", imdbRating: "6.0" });
    throw new Error(`unexpected fetch ${url}`);
  };

  assert.deepEqual(await prewarmOmdbCache(), { total: 3, fetched: 2, notFound: 0, skipped: 0, failed: 1 });
  assert.ok(warns.some((w) => w.includes("[omdb-prewarm] item failed:")));
  // The batch-mates completed their full chains despite the rejection.
  assert.ok(cacheRows.has("omdb:tmdb:movie:730"));
  assert.ok(cacheRows.has("omdb:tmdb:movie:732"));
});

// ── quota lockout (LAST — module-global state, clock never advances) ────────

test("a quota trip mid-run stops the batch loop: later batches are never issued and unattempted items appear in NO counter", async () => {
  tables.plex = Array.from({ length: 15 }, (_, i): Row => ({ tmdbId: 801 + i, mediaType: "MOVIE" }));
  const TRIP_IDS = new Set(["tt0000806", "tt0000807", "tt0000808", "tt0000809", "tt0000810"]);
  respond = (url) => {
    if (url.hostname === "api.themoviedb.org") {
      const m = url.pathname.match(/^\/3\/movie\/(\d+)\/external_ids$/);
      if (m) return jsonResponse({ imdb_id: `tt0000${m[1]}` });
    }
    if (url.hostname === "www.omdbapi.com") {
      const i = url.searchParams.get("i") ?? "";
      return TRIP_IDS.has(i)
        ? new Response("rate limited", { status: 429 })
        : jsonResponse({ Response: "True", imdbRating: "7.7" });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  // Batch 1 (801–805) succeeds; batch 2 (806–810) hits 429s — the first trips
  // the module lockout and every chain in the batch settles found:false
  // (transient) ⇒ notFound. The post-batch check then breaks the loop, so
  // batch 3 (811–815) is never even resolved against TMDB. Those five items
  // land in NO counter — total ≠ fetched+notFound+skipped+failed is the
  // documented signature of an early stop.
  assert.deepEqual(await prewarmOmdbCache(), { total: 15, fetched: 5, notFound: 5, skipped: 0, failed: 0 });
  assert.equal(isOmdbQuotaLocked(), true);
  for (let id = 811; id <= 815; id++) {
    assert.ok(
      !fetchCalls.some((c) => c.url.pathname.includes(String(id))),
      `item ${id} must never be attempted after the stop`,
    );
  }
  assert.ok(warns.some((w) => w.includes("[omdb-prewarm] Quota hit mid-batch after 5 fetches — stopping early")));
});

test("already locked at start: aborts before the key read and the library scan (runs LAST — rides the lockout the previous test tripped)", async () => {
  assert.equal(isOmdbQuotaLocked(), true); // the mocked clock never advances past the trip
  tables.plex = [{ tmdbId: 900, mediaType: "MOVIE" }];
  assert.deepEqual(await prewarmOmdbCache(), ZERO);
  assert.deepEqual(settingReads, []); // the lockout check precedes the key read
  assert.equal(libCalls.length, 0);
  assert.equal(fetchCalls.length, 0);
  assert.ok(warns.some((w) => w.includes("[omdb-prewarm] OMDB quota locked — aborting before any calls")));
});
