// Unit tests for the blacklist module (src/lib/blacklist.ts) — the hard-block
// list consulted by the request chokepoint and by discovery-list marking.
//
// Two keyspaces MUST agree or the feature splits in half: isBlacklisted()
// checks `${tmdbId}:${MediaType}` with the Prisma enum casing (MOVIE/TV),
// while discovery marks titles via blacklistKey() fed the TMDB-layer casing
// ("movie"/"tv"). If the normalization drifts, a blacklisted title is either
// flagged-but-still-requestable or requestable-but-flagged. The exact key
// strings are pinned here for both casings.
//
// The resolved key set is cached for 30s with in-flight coalescing (discovery
// renders hit it on every list) and an invalidation token so an admin
// add/remove propagates immediately — a cold read that started BEFORE the
// invalidation must not repopulate the cache with pre-change data, even when
// its query resolves after a post-change read (the out-of-order race).
//
// The module's sole impurity is prisma.blacklistItem.findMany. There is no
// local DB in this harness, so the tests shadow the delegate on the shared
// extended client with an in-memory stub (same pattern as
// tests/jellyfin-config.test.mts), with a hard-abort guard so a real query
// can never be issued and hang. No DB or network is touched.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { MediaType } from "@/generated/prisma";
import { prisma } from "../src/lib/prisma.ts";
import {
  blacklistKey,
  getBlacklistSet,
  invalidateBlacklistCache,
  isBlacklisted,
} from "../src/lib/blacklist.ts";
import { shadowPrismaModel } from "./_helpers.mts";

type BlacklistRow = { tmdbId: number; mediaType: "MOVIE" | "TV" };
type FindManyArgs = { select: { tmdbId: boolean; mediaType: boolean } };
type Deferred = {
  resolve: (rows: BlacklistRow[]) => void;
  reject: (err: Error) => void;
};

let nextRows: BlacklistRow[] = [];
let findManyCalls = 0;
let lastFindManyArgs: FindManyArgs | null = null;
// When > 0, the next findMany call(s) return a manually-controlled promise
// (pushed onto `pendingReads`) instead of resolving immediately — this is how
// the coalescing and invalidation-race tests hold a query "in flight".
let deferNextReads = 0;
const pendingReads: Deferred[] = [];

const blacklistItemStub = {
  findMany: (args: FindManyArgs): Promise<BlacklistRow[]> => {
    findManyCalls += 1;
    lastFindManyArgs = args;
    if (deferNextReads > 0) {
      deferNextReads -= 1;
      return new Promise<BlacklistRow[]>((resolve, reject) => {
        pendingReads.push({ resolve, reject });
      });
    }
    return Promise.resolve(nextRows);
  },
};

// Shadow the delegate BEFORE any test runs; the helper fails fast and loudly
// if a Prisma upgrade ever stops the shadow from taking effect — otherwise the
// first cold read would issue a real query against a DB that doesn't exist.
shadowPrismaModel(prisma, "blacklistItem", blacklistItemStub);

function takePendingRead(): Deferred {
  const d = pendingReads.shift();
  if (!d) throw new Error("test bug: no pending deferred findMany to settle");
  return d;
}

beforeEach(() => {
  // The cache/inflight/token state is module-level; reset it so every test
  // starts from a cold cache regardless of what the previous test did.
  invalidateBlacklistCache();
  nextRows = [];
  findManyCalls = 0;
  lastFindManyArgs = null;
  deferNextReads = 0;
  pendingReads.length = 0;
});

// ---------------------------------------------------------------------------
// blacklistKey — pure key normalization
// ---------------------------------------------------------------------------

test("blacklistKey: TMDB-layer casing normalizes to the Prisma enum keyspace (exact pins)", () => {
  assert.equal(blacklistKey(550, "movie"), "550:MOVIE");
  assert.equal(blacklistKey(1399, "tv"), "1399:TV");
});

test("blacklistKey: Prisma enum casing passes through unchanged (exact pins)", () => {
  assert.equal(blacklistKey(550, "MOVIE"), "550:MOVIE");
  assert.equal(blacklistKey(1399, "TV"), "1399:TV");
});

test("blacklistKey: same title in both casings yields ONE key — the shared-keyspace contract", () => {
  assert.equal(blacklistKey(603, "movie"), blacklistKey(603, "MOVIE"));
  assert.equal(blacklistKey(603, "tv"), blacklistKey(603, "TV"));
  // ...and movie/tv keys for the same tmdbId never collide.
  assert.notEqual(blacklistKey(603, "movie"), blacklistKey(603, "tv"));
});

test("blacklistKey PINS CURRENT BEHAVIOR: only exact 'movie'/'tv' are mapped — other casings pass through verbatim", () => {
  // The normalization is an exact-string match, not a case-insensitive one.
  // A mixed-case input would produce a key outside the enum keyspace and
  // silently never match a blacklist row; pin that so an accidental widening
  // (or a new caller passing "Movie") is caught deliberately, not silently.
  assert.equal(blacklistKey(1, "Movie"), "1:Movie");
  assert.equal(blacklistKey(1, "Tv"), "1:Tv");
  assert.equal(blacklistKey(1, ""), "1:");
});

// ---------------------------------------------------------------------------
// getBlacklistSet — cold read, key shape, warm cache, TTL boundary
// ---------------------------------------------------------------------------

test("cold read queries once and builds keys in the Prisma enum keyspace", async () => {
  nextRows = [
    { tmdbId: 550, mediaType: "MOVIE" },
    { tmdbId: 1399, mediaType: "TV" },
  ];
  const set = await getBlacklistSet();
  assert.equal(findManyCalls, 1);
  assert.equal(set.size, 2);
  assert.ok(set.has("550:MOVIE"));
  assert.ok(set.has("1399:TV"));
  // Keyspace agreement: what discovery computes via blacklistKey (TMDB casing)
  // is exactly what the DB-derived set contains (Prisma enum casing).
  assert.ok(set.has(blacklistKey(550, "movie")));
  assert.ok(set.has(blacklistKey(1399, "tv")));
  // The query reads only the two key columns.
  assert.deepEqual(lastFindManyArgs, { select: { tmdbId: true, mediaType: true } });
});

test("empty table resolves to an empty set (nothing blocked)", async () => {
  nextRows = [];
  const set = await getBlacklistSet();
  assert.equal(set.size, 0);
  assert.equal(await isBlacklisted(550, "MOVIE" as MediaType), false);
});

test("warm reads within the TTL return the SAME set instance with no extra query", async () => {
  nextRows = [{ tmdbId: 550, mediaType: "MOVIE" }];
  const first = await getBlacklistSet();
  const second = await getBlacklistSet();
  const third = await getBlacklistSet();
  assert.equal(findManyCalls, 1);
  assert.equal(second, first); // identity, not just deep equality
  assert.equal(third, first);
});

test("TTL boundary is exact: fresh at 29,999ms, refetches at 30,000ms", async () => {
  const realNow = Date.now;
  try {
    const T0 = 1_800_000_000_000; // fixed epoch so cache.at is deterministic
    Date.now = () => T0;
    nextRows = [{ tmdbId: 1, mediaType: "MOVIE" }];
    await getBlacklistSet(); // populate; cache.at = T0
    assert.equal(findManyCalls, 1);

    Date.now = () => T0 + 29_999; // strictly inside the window (elapsed < TTL)
    const warm = await getBlacklistSet();
    assert.equal(findManyCalls, 1);
    assert.ok(warm.has("1:MOVIE"));

    nextRows = [{ tmdbId: 2, mediaType: "TV" }]; // DB changed meanwhile
    Date.now = () => T0 + 30_000; // exactly TTL → stale (the check is strict <)
    const refetched = await getBlacklistSet();
    assert.equal(findManyCalls, 2);
    assert.ok(refetched.has("2:TV"));
    assert.ok(!refetched.has("1:MOVIE"));
  } finally {
    Date.now = realNow;
    // cache.at now sits in the future relative to real time; drop it so it
    // cannot leak a forever-fresh cache into later tests.
    invalidateBlacklistCache();
  }
});

// ---------------------------------------------------------------------------
// In-flight coalescing
// ---------------------------------------------------------------------------

test("N concurrent cold readers coalesce into ONE query and share one set instance", async () => {
  deferNextReads = 1;
  const p1 = getBlacklistSet();
  const p2 = getBlacklistSet();
  const p3 = getBlacklistSet();
  assert.equal(findManyCalls, 1); // all three joined the single in-flight read

  takePendingRead().resolve([{ tmdbId: 550, mediaType: "MOVIE" }]);
  const [s1, s2, s3] = await Promise.all([p1, p2, p3]);
  assert.equal(s2, s1);
  assert.equal(s3, s1);
  assert.ok(s1.has("550:MOVIE"));
  assert.equal(findManyCalls, 1);

  // The coalesced read populated the cache: a later call is a warm hit.
  const warm = await getBlacklistSet();
  assert.equal(findManyCalls, 1);
  assert.equal(warm, s1);
});

// ---------------------------------------------------------------------------
// Invalidation
// ---------------------------------------------------------------------------

test("invalidateBlacklistCache drops a warm cache: the next read re-queries", async () => {
  nextRows = [{ tmdbId: 550, mediaType: "MOVIE" }];
  await getBlacklistSet();
  assert.equal(findManyCalls, 1);

  invalidateBlacklistCache(); // admin added/removed a row
  nextRows = [{ tmdbId: 550, mediaType: "MOVIE" }, { tmdbId: 7, mediaType: "TV" }];
  const fresh = await getBlacklistSet();
  assert.equal(findManyCalls, 2);
  assert.ok(fresh.has("7:TV"));
});

test("a stale in-flight read must not repopulate the cache after invalidation", async () => {
  deferNextReads = 1;
  const staleP = getBlacklistSet(); // cold read starts; query in flight
  assert.equal(findManyCalls, 1);

  invalidateBlacklistCache(); // admin change lands mid-flight

  // The pre-change result arrives. Its original awaiter still receives what
  // the query returned (pinned — the promise was already handed out)...
  takePendingRead().resolve([{ tmdbId: 999, mediaType: "MOVIE" }]);
  const staleSet = await staleP;
  assert.ok(staleSet.has("999:MOVIE"));

  // ...but the cache was NOT repopulated: the next call issues a fresh query
  // and sees the post-change data, immediately — no 30s window of stale blocks.
  nextRows = [{ tmdbId: 111, mediaType: "TV" }];
  const fresh = await getBlacklistSet();
  assert.equal(findManyCalls, 2);
  assert.ok(fresh.has("111:TV"));
  assert.ok(!fresh.has("999:MOVIE"));

  // And the fresh read DID publish to the cache (its token is current).
  const warm = await getBlacklistSet();
  assert.equal(findManyCalls, 2);
  assert.equal(warm, fresh);
});

test("out-of-order race: a stale read resolving AFTER a post-invalidation read cannot clobber it", async () => {
  deferNextReads = 2;

  const staleP = getBlacklistSet(); // pre-change read starts
  invalidateBlacklistCache(); // admin change
  const freshP = getBlacklistSet(); // post-change reader must NOT join the stale flight
  assert.equal(findManyCalls, 2);
  const staleRead = takePendingRead();
  const freshRead = takePendingRead();

  // Fresh result arrives first, then the slow stale query limps in.
  freshRead.resolve([{ tmdbId: 111, mediaType: "TV" }]);
  staleRead.resolve([{ tmdbId: 999, mediaType: "MOVIE" }]);
  const [staleSet, freshSet] = await Promise.all([staleP, freshP]);
  assert.ok(staleSet.has("999:MOVIE")); // its own awaiter still gets its result
  assert.ok(freshSet.has("111:TV"));

  // The cache must hold the FRESH set — the late stale resolve carried a dead
  // token and must not have overwritten it.
  const warm = await getBlacklistSet();
  assert.equal(findManyCalls, 2);
  assert.equal(warm, freshSet);
  assert.ok(!warm.has("999:MOVIE"));
});

// ---------------------------------------------------------------------------
// Failure path
// ---------------------------------------------------------------------------

test("a failed cold read rejects, poisons nothing, and the next call retries", async () => {
  deferNextReads = 1;
  const p = getBlacklistSet();
  takePendingRead().reject(new Error("db down"));
  await assert.rejects(p, /db down/);

  // The failure cleared the in-flight slot and populated no cache: the very
  // next call issues a new query and succeeds.
  nextRows = [{ tmdbId: 7, mediaType: "TV" }];
  const set = await getBlacklistSet();
  assert.equal(findManyCalls, 2);
  assert.ok(set.has("7:TV"));
});

// ---------------------------------------------------------------------------
// isBlacklisted — the request chokepoint
// ---------------------------------------------------------------------------

test("isBlacklisted matches on exact (tmdbId, MediaType) and shares the cached set", async () => {
  nextRows = [
    { tmdbId: 550, mediaType: "MOVIE" },
    { tmdbId: 1399, mediaType: "TV" },
  ];
  assert.equal(await isBlacklisted(550, "MOVIE" as MediaType), true);
  assert.equal(await isBlacklisted(1399, "TV" as MediaType), true);
  // Same tmdbId, other medium: NOT blocked — the key is the pair, not the id.
  assert.equal(await isBlacklisted(550, "TV" as MediaType), false);
  assert.equal(await isBlacklisted(1399, "MOVIE" as MediaType), false);
  assert.equal(await isBlacklisted(551, "MOVIE" as MediaType), false);
  assert.equal(findManyCalls, 1); // all five checks rode one cached read
});

test("chokepoint and discovery agree end-to-end: blacklistKey(tmdb casing) hits the same rows isBlacklisted blocks", async () => {
  nextRows = [{ tmdbId: 603, mediaType: "MOVIE" }];
  const set = await getBlacklistSet();
  assert.equal(set.has(blacklistKey(603, "movie")), await isBlacklisted(603, "MOVIE" as MediaType));
  assert.equal(set.has(blacklistKey(603, "tv")), await isBlacklisted(603, "TV" as MediaType));
  assert.equal(await isBlacklisted(603, "MOVIE" as MediaType), true);
  assert.equal(await isBlacklisted(603, "TV" as MediaType), false);
});
