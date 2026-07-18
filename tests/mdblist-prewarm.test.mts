// Unit tests for src/lib/mdblist-prewarm.ts — prewarmMdblistCache, the cron
// pass that refreshes the mdblist:tmdb:* ratings rows for every library item
// via the MDBList BATCH endpoint. Pinned here are the ORCHESTRATION contracts:
//   - counter correctness of the returned { total, fetched, skipped, failed,
//     purged, quotaExhausted? } — deepEqual pins the exact key set, including
//     that the early no-key/empty-library returns carry NO quotaExhausted key
//     while a completed run always carries it (undefined when no quota hit);
//   - the { force?: boolean } purge semantics: the default run deleteMany's
//     ONLY rows whose data is exactly the NOT_FOUND sentinel serialization
//     (second chance for sentinels), force:true drops the data filter and
//     purges valid rows too, forcing a full refetch;
//   - batch usage: cold items go out as ONE chunked POST per media type via
//     fetchMdblistBatch — never per-item — with the details-blob releaseDate
//     passed through per item (witnessed via the written rows' TTL buckets);
//   - movie/TV page INTERLEAVING: page 0 of both types completes before page 1
//     of either, so quota drains evenly instead of movies-first;
//   - `fetched` counts the ids MDBList actually returned: a partial response
//     is neither fetched nor failed; a REJECTED fetchMdblistBatch marks its
//     whole page failed while the run still returns counters;
//   - the ordered short-circuits and quota stops: locked-at-start aborts
//     BEFORE the mdblistApiKey Setting read with quotaExhausted:true; a 429
//     mid-run trips the lockout, later pages are never issued, and the result
//     reports quotaExhausted:true.
//
// Sibling ownership: tests/mdblist.test.mts owns fetchMdblistBatch itself
// (wire shape, id matching, negative-cache coverage rules, 503 retry, lockout
// trip mechanics — this file drives the REAL module with scripted fetch and
// asserts only what the orchestrator does around it); tests/library-iterator
// .test.mts owns collectAllLibraryItems' paging; tests/tmdb-cache-ttl.test.mts
// owns the TTL bucket values used as pass-through witnesses here.
//
// Ordering notes: the MDBList quota lockout and the 30s API-key memo are
// module-global. The lockout tests run LAST (trip, then ride); the
// batch-rejection test busts the key memo with the mocked clock and restores
// its Setting resolver in a finally.
//
// No DB or network: setting/tmdbCache and the library delegates are shadowed
// in-memory (tests/_helpers.mts), globalThis.fetch is scripted with POST-body
// capture, and dns/promises.lookup is stubbed so the safe-fetch SSRF resolver
// never issues a real lookup for api.mdblist.com.
import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto

// Freeze the clock BEFORE the module graph loads (imports below are DYNAMIC —
// static imports would hoist above this): lockout arithmetic, cache TTLs, and
// the 30s API-key memo all read the mocked Date. setTimeout stays REAL.
const T0 = Date.UTC(2026, 0, 15, 12, 0, 0);
mock.timers.enable({ apis: ["Date"], now: T0 });
let clockNow = T0;
function advanceClock(ms: number): void {
  clockNow += ms;
  mock.timers.setTime(clockNow);
}
const API_KEY_TTL_MS = 30_000; // mirrors src/lib/mdblist.ts
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
const { isMdblistQuotaLocked } = await import("../src/lib/mdblist.ts");
const { prewarmMdblistCache } = await import("../src/lib/mdblist-prewarm.ts");

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
// The prewarm reads the mdblistApiKey Setting directly; mdblist.ts's memoized
// getApiKey reads the same row. `settingRead` is swappable so one test can
// fail the batches' key read while the prewarm's own gate read succeeds.
const DEFAULT_KEY = "test-mdblist-key";
let mdblistApiKeyValue: string | null = DEFAULT_KEY;
const defaultSettingRead = async (key: string): Promise<{ key: string; value: string } | null> =>
  key === "mdblistApiKey" && mdblistApiKeyValue !== null ? { key, value: mdblistApiKeyValue } : null;
let settingRead = defaultSettingRead;
const settingReads: string[] = [];
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    settingReads.push(args.where.key);
    return settingRead(args.where.key);
  },
});

type CacheRow = { key: string; data: string; cachedAt: Date; expiresAt: Date };
const cacheRows = new Map<string, CacheRow>();
type DeleteManyCall = { keys: string[]; data?: string };
const deleteManyCalls: DeleteManyCall[] = [];
shadowPrismaModel(prisma, "tmdbCache", {
  findMany: async (args: { where: { key: { in: string[] } } }) =>
    args.where.key.in.flatMap((k) => {
      const r = cacheRows.get(k);
      return r ? [{ ...r }] : [];
    }),
  upsert: async (args: { where: { key: string }; create: CacheRow }) => {
    cacheRows.set(args.where.key, args.create);
    return args.create;
  },
  // The purge pass. Models the data-equality filter faithfully: with
  // where.data present only rows whose serialized data matches are deleted.
  deleteMany: async (args: { where: { key: { in: string[] }; data?: string } }) => {
    deleteManyCalls.push({
      keys: [...args.where.key.in],
      ...(args.where.data !== undefined ? { data: args.where.data } : {}),
    });
    let count = 0;
    for (const k of args.where.key.in) {
      const row = cacheRows.get(k);
      if (!row) continue;
      if (args.where.data !== undefined && row.data !== args.where.data) continue;
      cacheRows.delete(k);
      count++;
    }
    return { count };
  },
});

// ── scripted fetch (captures the POST body for batch-shape pins) ────────────
type FetchCall = { url: URL; method: string; body: string | null };
const fetchCalls: FetchCall[] = [];
let respond: (url: URL, call: FetchCall) => Response | Promise<Response> = () => {
  throw new Error("unexpected fetch — script a responder for this test");
};

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const call: FetchCall = {
    url,
    method: init?.method ?? "GET",
    body: typeof init?.body === "string" ? init.body : null,
  };
  fetchCalls.push(call);
  return respond(url, call);
}) as typeof fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bodyIds(call: FetchCall): number[] {
  return (JSON.parse(call.body ?? "{}") as { ids: number[] }).ids;
}

// Echo responder: one parseable row per requested id.
const echo = (call: FetchCall) =>
  jsonResponse(bodyIds(call).map((id) => ({ id, ratings: [{ source: "imdb", value: 6 }] })));

// ── helpers ─────────────────────────────────────────────────────────────────
// Seed a cache row with `remainingMs` of a 24h original TTL left (the
// prewarm's freshness threshold sits at 6h). All times read the mocked clock.
function seedCacheRow(key: string, remainingMs: number, data = "{}"): void {
  const expiresAt = new Date(Date.now() + remainingMs);
  const cachedAt = new Date(expiresAt.getTime() - DAY_MS);
  cacheRows.set(key, { key, data, cachedAt, expiresAt });
}

// The early no-key/empty-library returns — note: NO quotaExhausted key at all
// (deepEqual distinguishes an absent key from an undefined-valued one).
const ZERO_EARLY = { total: 0, fetched: 0, skipped: 0, failed: 0, purged: 0 };

beforeEach(() => {
  tables.plex = [];
  tables.jellyfin = [];
  libCalls.length = 0;
  settingRead = defaultSettingRead;
  settingReads.length = 0;
  cacheRows.clear();
  deleteManyCalls.length = 0;
  fetchCalls.length = 0;
  warns.length = 0;
  errors.length = 0;
  respond = () => {
    throw new Error("unexpected fetch — script a responder for this test");
  };
});

// ── short-circuits ──────────────────────────────────────────────────────────

test("no MDBList API key: the zero-counter shape (quotaExhausted key ABSENT) without a library scan", async () => {
  mdblistApiKeyValue = null;
  tables.plex = [{ tmdbId: 1, mediaType: "MOVIE" }];
  try {
    assert.deepEqual(await prewarmMdblistCache(), ZERO_EARLY);
    assert.equal(libCalls.length, 0); // the key gate precedes collectAllLibraryItems
    assert.equal(fetchCalls.length, 0);
  } finally {
    mdblistApiKeyValue = DEFAULT_KEY;
  }
});

test("empty library: zero counters — no purge, no fetch", async () => {
  assert.deepEqual(await prewarmMdblistCache(), ZERO_EARLY);
  assert.equal(libCalls.length, 4); // plex MOVIE/TV + jellyfin MOVIE/TV, one empty page each
  assert.equal(deleteManyCalls.length, 0);
  assert.equal(fetchCalls.length, 0);
});

// ── purge semantics ─────────────────────────────────────────────────────────

test("default run: ONLY NOT_FOUND sentinels are purged (data-filtered deleteMany) and get refetched; fresh rows survive and skip", async () => {
  tables.plex = [
    { tmdbId: 1, mediaType: "MOVIE" }, // sentinel row → purged + refetched
    { tmdbId: 2, mediaType: "MOVIE" }, // fresh ratings row → survives, skipped
    { tmdbId: 3, mediaType: "MOVIE" }, // no row → fetched
  ];
  seedCacheRow("mdblist:tmdb:movie:1", 20 * HOUR_MS, JSON.stringify({ _notFound: true }));
  seedCacheRow("mdblist:tmdb:movie:2", 20 * HOUR_MS, JSON.stringify({ imdbRating: "7.2" }));
  respond = (_url, call) => echo(call);

  assert.deepEqual(await prewarmMdblistCache(), {
    total: 3, fetched: 2, skipped: 1, failed: 0, purged: 1, quotaExhausted: undefined,
  });

  // The purge is data-filtered to the exact sentinel serialization.
  assert.equal(deleteManyCalls.length, 1);
  assert.equal(deleteManyCalls[0].data, '{"_notFound":true}');
  assert.deepEqual(deleteManyCalls[0].keys, [
    "mdblist:tmdb:movie:1", "mdblist:tmdb:movie:2", "mdblist:tmdb:movie:3",
  ]);

  // One chunked POST for the two non-fresh ids — the sentinel got its second
  // chance and now holds a real row; the fresh row survived untouched.
  assert.equal(fetchCalls.length, 1);
  assert.deepEqual(bodyIds(fetchCalls[0]), [1, 3]);
  const refreshed = cacheRows.get("mdblist:tmdb:movie:1");
  assert.ok(refreshed && !refreshed.data.includes("_notFound"), "the purged sentinel must be replaced by a real row");
  assert.ok(cacheRows.get("mdblist:tmdb:movie:2")?.data.includes("7.2"), "the fresh row must survive untouched");
});

test("force:true purges valid rows too (no data filter) and forces a full refetch", async () => {
  tables.plex = [
    { tmdbId: 1, mediaType: "MOVIE" },
    { tmdbId: 2, mediaType: "MOVIE" },
  ];
  seedCacheRow("mdblist:tmdb:movie:1", 20 * HOUR_MS, JSON.stringify({ imdbRating: "8.0" }));
  seedCacheRow("mdblist:tmdb:movie:2", 20 * HOUR_MS, JSON.stringify({ imdbRating: "6.5" }));
  respond = (_url, call) => echo(call);

  assert.deepEqual(await prewarmMdblistCache({ force: true }), {
    total: 2, fetched: 2, skipped: 0, failed: 0, purged: 2, quotaExhausted: undefined,
  });
  assert.equal(deleteManyCalls.length, 1);
  assert.equal("data" in deleteManyCalls[0], false); // force drops the sentinel filter
  assert.deepEqual(bodyIds(fetchCalls[0]), [1, 2]); // nothing is fresh any more
});

// ── batch usage ─────────────────────────────────────────────────────────────

test("cold items go out as ONE chunked POST per media type — never per-item — and details releaseDates drive per-row TTLs", async () => {
  tables.plex = [
    { tmdbId: 10, mediaType: "MOVIE" },
    { tmdbId: 11, mediaType: "MOVIE" },
    { tmdbId: 12, mediaType: "MOVIE" },
    { tmdbId: 20, mediaType: "TV" },
    { tmdbId: 21, mediaType: "TV" },
  ];
  seedCacheRow("movie:10:details", 20 * HOUR_MS, JSON.stringify({ releaseDate: "2026-01-01" })); // this-year → 3d
  seedCacheRow("movie:11:details", 20 * HOUR_MS, JSON.stringify({ releaseDate: "1994-06-15" })); // back-catalog → 30d
  respond = (_url, call) => echo(call);

  assert.deepEqual(await prewarmMdblistCache(), {
    total: 5, fetched: 5, skipped: 0, failed: 0, purged: 0, quotaExhausted: undefined,
  });

  assert.equal(fetchCalls.length, 2); // one movie POST + one show POST — not five singles
  const movieCall = fetchCalls.find((c) => c.url.pathname === "/tmdb/movie/");
  const showCall = fetchCalls.find((c) => c.url.pathname === "/tmdb/show/");
  assert.ok(movieCall && showCall, "each media type must go out as its own batch");
  assert.equal(movieCall.method, "POST");
  assert.deepEqual(bodyIds(movieCall), [10, 11, 12]);
  assert.deepEqual(bodyIds(showCall), [20, 21]);

  // releaseDate pass-through, witnessed via the written rows' TTL buckets
  // (bucket values owned by tests/tmdb-cache-ttl.test.mts): this-year → 3d,
  // 1994 → 30d, and no details row (12) degrades to the null-date 30d bucket.
  assert.equal(cacheRows.get("mdblist:tmdb:movie:10")?.expiresAt.getTime(), Date.now() + 3 * DAY_MS);
  assert.equal(cacheRows.get("mdblist:tmdb:movie:11")?.expiresAt.getTime(), Date.now() + 30 * DAY_MS);
  assert.equal(cacheRows.get("mdblist:tmdb:movie:12")?.expiresAt.getTime(), Date.now() + 30 * DAY_MS);
});

test("pages interleave across media types: page 0 (200 movie + 200 tv) completes before page 1 (1 + 1)", async () => {
  tables.plex = [
    ...Array.from({ length: 201 }, (_, i): Row => ({ tmdbId: i + 1, mediaType: "MOVIE" })),
    ...Array.from({ length: 201 }, (_, i): Row => ({ tmdbId: 1001 + i, mediaType: "TV" })),
  ];
  respond = (_url, call) => echo(call);

  assert.deepEqual(await prewarmMdblistCache(), {
    total: 402, fetched: 402, skipped: 0, failed: 0, purged: 0, quotaExhausted: undefined,
  });

  // 4 calls: the two 200-id page-0 batches (movie+tv run concurrently — order
  // BETWEEN them unpinned) strictly before the two 1-id tails. A movies-first
  // drain would read [200, 1, 200, 1] instead.
  assert.equal(fetchCalls.length, 4);
  const sizes = fetchCalls.map((c) => bodyIds(c).length);
  assert.deepEqual([...sizes.slice(0, 2)].sort((a, b) => a - b), [200, 200]);
  assert.deepEqual(sizes.slice(2), [1, 1]);
  const page0Movie = fetchCalls.slice(0, 2).find((c) => c.url.pathname === "/tmdb/movie/");
  const page0Show = fetchCalls.slice(0, 2).find((c) => c.url.pathname === "/tmdb/show/");
  assert.ok(page0Movie && page0Show, "page 0 must carry one movie and one tv batch");
  assert.deepEqual([bodyIds(page0Movie)[0], bodyIds(page0Movie)[199]], [1, 200]);
  assert.deepEqual([bodyIds(page0Show)[0], bodyIds(page0Show)[199]], [1001, 1200]);
  assert.deepEqual(
    bodyIds(fetchCalls[2]).concat(bodyIds(fetchCalls[3])).sort((a, b) => a - b),
    [201, 1201],
  );
});

// ── counter semantics ───────────────────────────────────────────────────────

test("a partial batch response yields fetched < toFetch without counting failed (transient shortfall, retried next run)", async () => {
  tables.plex = [
    { tmdbId: 31, mediaType: "MOVIE" },
    { tmdbId: 32, mediaType: "MOVIE" },
    { tmdbId: 33, mediaType: "MOVIE" },
  ];
  respond = () => jsonResponse([
    { id: 31, ratings: [{ source: "imdb", value: 6 }] },
    { id: 32, ratings: [{ source: "imdb", value: 7 }] },
  ]);

  // `fetched` counts the ids MDBList actually returned (the batch map size);
  // the omitted id is neither fetched nor failed — and (sibling-owned) a short
  // response never writes it a sentinel, so the next run retries it.
  assert.deepEqual(await prewarmMdblistCache(), {
    total: 3, fetched: 2, skipped: 0, failed: 0, purged: 0, quotaExhausted: undefined,
  });
});

test("a rejected fetchMdblistBatch marks the whole page failed for BOTH types and the run still returns counters", async () => {
  tables.plex = [
    { tmdbId: 41, mediaType: "MOVIE" },
    { tmdbId: 42, mediaType: "MOVIE" },
    { tmdbId: 43, mediaType: "TV" },
  ];
  // Bust the module-global 30s API-key memo so the batches must re-read the
  // Setting — then fail that read. The prewarm's own gate read (the FIRST
  // Setting read of this test) still succeeds, and the two concurrent batches
  // coalesce onto the single rejecting read.
  advanceClock(API_KEY_TTL_MS + 1_000);
  let gateRead = true;
  settingRead = async (key) => {
    if (key !== "mdblistApiKey") return null;
    if (gateRead) {
      gateRead = false;
      return { key, value: DEFAULT_KEY };
    }
    throw new Error("settings table on fire");
  };
  try {
    assert.deepEqual(await prewarmMdblistCache(), {
      total: 3, fetched: 0, skipped: 0, failed: 3, purged: 0, quotaExhausted: undefined,
    });
    assert.equal(fetchCalls.length, 0); // the rejection precedes any wire call
    assert.ok(warns.some((w) => w.includes("[mdblist-prewarm] movie batch failed:")));
    assert.ok(warns.some((w) => w.includes("[mdblist-prewarm] tv batch failed:")));
  } finally {
    settingRead = defaultSettingRead;
  }
});

// ── quota lockout (LAST — module-global state) ──────────────────────────────

test("a 429 mid-run trips the lockout and stops the page loop: page 1 is never issued and quotaExhausted is reported", async () => {
  tables.plex = Array.from({ length: 201 }, (_, i): Row => ({ tmdbId: i + 1, mediaType: "MOVIE" }));
  respond = () => new Response("slow down", { status: 429 });

  // Page 0's movie batch 429s: fetchMdblistBatch trips the lockout, breaks its
  // own loop, and FULFILLS with an empty map (so failed stays 0). The prewarm's
  // post-page check then breaks — page 1 (id 201) is never issued. The 201
  // unattempted-or-unanswered items appear in no counter.
  assert.deepEqual(await prewarmMdblistCache(), {
    total: 201, fetched: 0, skipped: 0, failed: 0, purged: 0, quotaExhausted: true,
  });
  assert.equal(fetchCalls.length, 1); // page 0's single movie POST only
  assert.deepEqual(bodyIds(fetchCalls[0]).length, 200);
  assert.equal(isMdblistQuotaLocked(), true);
  assert.ok(warns.some((w) => w.includes("[mdblist] Quota lockout tripped")));
  assert.ok(warns.some((w) => w.includes("[mdblist-prewarm] Quota hit mid-batch after 0 fetches — stopping early")));
});

test("already locked at start: aborts before the key read and the library scan with quotaExhausted:true (runs LAST — rides the previous trip)", async () => {
  assert.equal(isMdblistQuotaLocked(), true); // the previous test's trip, clock not advanced past it
  tables.plex = [{ tmdbId: 7, mediaType: "MOVIE" }];
  assert.deepEqual(await prewarmMdblistCache(), {
    total: 0, fetched: 0, skipped: 0, failed: 0, purged: 0, quotaExhausted: true,
  });
  assert.deepEqual(settingReads, []); // the lockout check precedes the key read
  assert.equal(libCalls.length, 0);
  assert.equal(fetchCalls.length, 0);
  assert.ok(warns.some((w) => w.includes("[mdblist-prewarm] MDBList quota locked — aborting before any calls")));
});
