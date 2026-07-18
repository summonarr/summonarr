// Unit tests for the prisma-bound surface of src/lib/tmdb-cache.ts — the
// read/write helpers every TMDB consumer (tmdb.ts, ratings, arr path maps,
// trakt lists) funnels through. tests/tmdb-cache-ttl.test.mts already covers
// libraryDetailsTtl; this file deliberately does NOT touch it and instead pins
// the cache-row lifecycle contracts:
//
//  - getCache/getCacheMany treat an expired row as a MISS and lazily delete it
//    (there is no scheduled purge for reads — the sync's bulk purge is
//    separate), and the delete is fire-and-forget with an `expiresAt < now`
//    guard so a concurrent setCache upsert that just refreshed the row is
//    never clobbered by a stale reader's cleanup;
//  - a failed lazy delete is swallowed — the read path must keep serving
//    misses, never surface a cleanup error to the caller;
//  - malformed JSON is a miss everywhere but NEVER triggers deletion (only
//    expiry does) — a corrupt row is left for the next setCache to repair;
//  - the serve-stale variants (getCacheStale/getCacheStaleMany) return expired
//    rows with isStale=true and NEVER delete — callers serve the old value
//    while revalidating async, so destroying it would defeat the point;
//  - getCacheMany batches: one findMany for N keys, one deleteMany for all
//    expired keys (not N point deletes) — the tvdb→tmdb resolver hits this on
//    every sync run;
//  - setCache upserts with identical data on both branches and an expiry of
//    now + ttlSeconds;
//  - the TTL registry values are drift-pinned: callers pass TTL.X straight
//    into setCache, so a silent edit changes cache economics repo-wide.
//
// No DB or network: the tmdbCache delegate is shadowed in-memory on the shared
// extended client (tests/_helpers.mts). Faithful bypass of the crypto
// extension — TmdbCache is not a table the extension wraps.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto

// Dynamic imports so the env stub above genuinely precedes the module-graph
// load (static imports would hoist above it).
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const { TTL, getCache, getCacheMany, getCacheStale, getCacheStaleMany, setCache } =
  await import("../src/lib/tmdb-cache.ts");

// ── in-memory tmdbCache delegate ────────────────────────────────────────────
type CacheRow = { key: string; data: string; cachedAt: Date; expiresAt: Date };
type DeleteWhere = { key?: string | { in: string[] }; expiresAt?: { lt: Date } };
type UpsertArgs = {
  where: { key: string };
  update: { data: string; cachedAt: Date; expiresAt: Date };
  create: CacheRow;
};

const rows = new Map<string, CacheRow>();
const findManyCalls: string[][] = [];
const deleteManyCalls: { where: DeleteWhere }[] = [];
const upsertCalls: UpsertArgs[] = [];
let deleteManyRejection: Error | null = null;

shadowPrismaModel(prisma, "tmdbCache", {
  findUnique: async (args: { where: { key: string } }): Promise<CacheRow | null> =>
    rows.get(args.where.key) ?? null,
  findMany: async (args: { where: { key: { in: string[] } } }): Promise<CacheRow[]> => {
    findManyCalls.push([...args.where.key.in]);
    return args.where.key.in
      .map((k) => rows.get(k))
      .filter((r): r is CacheRow => r !== undefined);
  },
  deleteMany: (args: { where: DeleteWhere }): Promise<{ count: number }> => {
    deleteManyCalls.push(args);
    return deleteManyRejection ? Promise.reject(deleteManyRejection) : Promise.resolve({ count: 0 });
  },
  upsert: async (args: UpsertArgs): Promise<CacheRow> => {
    upsertCalls.push(args);
    rows.set(args.where.key, args.create);
    return args.create;
  },
});

function seed(key: string, data: string, expiresInMs: number): void {
  rows.set(key, {
    key,
    data,
    cachedAt: new Date(Date.now() - 1000),
    expiresAt: new Date(Date.now() + expiresInMs),
  });
}

beforeEach(() => {
  rows.clear();
  findManyCalls.length = 0;
  deleteManyCalls.length = 0;
  upsertCalls.length = 0;
  deleteManyRejection = null;
});

const HOUR = 3600;
const DAY = 24 * HOUR;

// ── TTL registry drift pin ──────────────────────────────────────────────────

test("TTL registry: exact seconds per class, no keys added or removed silently", () => {
  // deepEqual on the whole object catches value drift AND key add/remove —
  // every entry here is passed verbatim into setCache somewhere in src/lib.
  assert.deepEqual(TTL, {
    DETAILS: 7 * DAY,
    PERSON: 7 * DAY,
    GENRES: 30 * DAY,
    DISCOVER: 12 * HOUR,
    SEARCH: 12 * HOUR,
    ARR_PATHS: 6 * HOUR,
  });
});

// ── getCache ────────────────────────────────────────────────────────────────

test("getCache: missing key is a miss (null), nothing deleted", async () => {
  assert.equal(await getCache("absent"), null);
  assert.equal(deleteManyCalls.length, 0);
});

test("getCache: a fresh row round-trips its JSON payload and is not deleted", async () => {
  const value = { results: [1, 2, 3], nested: { page: 2, ok: true } };
  seed("k", JSON.stringify(value), 60_000);
  assert.deepEqual(await getCache("k"), value);
  assert.equal(deleteManyCalls.length, 0);
});

test("getCache: an expired row is a miss AND fires the guarded lazy delete", async () => {
  seed("stale", JSON.stringify({ old: true }), -1_000); // expired 1s ago
  assert.equal(await getCache("stale"), null);

  // The cleanup is issued before getCache returns (fire-and-forget, but the
  // call itself is synchronous within the expired branch).
  assert.equal(deleteManyCalls.length, 1);
  const where = deleteManyCalls[0].where;
  assert.equal(where.key, "stale");
  // The expiresAt guard is the load-bearing part: a plain { key } delete would
  // race a concurrent setCache upsert and destroy the value it just wrote.
  assert.ok(where.expiresAt?.lt instanceof Date, "delete must carry the expiresAt < now guard");
  assert.ok(Math.abs(where.expiresAt.lt.getTime() - Date.now()) < 5_000);
});

test("getCache: malformed JSON in a FRESH row is a miss but is NOT deleted", async () => {
  seed("corrupt", "{not json", 60_000);
  assert.equal(await getCache("corrupt"), null);
  assert.equal(deleteManyCalls.length, 0); // only expiry deletes; corruption waits for the next setCache
});

test("getCache: a failing lazy delete is swallowed — the read still resolves null", async () => {
  deleteManyRejection = new Error("connection reset");
  seed("stale", JSON.stringify(1), -1_000);
  assert.equal(await getCache("stale"), null); // caller never sees the cleanup failure
  assert.equal(deleteManyCalls.length, 1);
  // Let the rejected fire-and-forget promise settle inside this test so a
  // regression (dropped .catch) would surface as an unhandled rejection here.
  await new Promise((resolve) => setImmediate(resolve));
});

// ── getCacheMany ────────────────────────────────────────────────────────────

test("getCacheMany: empty key list resolves to an empty Map without touching the DB", async () => {
  const out = await getCacheMany([]);
  assert.equal(out.size, 0);
  assert.equal(findManyCalls.length, 0);
});

test("getCacheMany: one findMany; fresh hit, expired miss (batch-deleted), corrupt miss (kept), absent miss", async () => {
  seed("fresh", JSON.stringify({ v: 1 }), 60_000);
  seed("expired-a", JSON.stringify({ v: 2 }), -1_000);
  seed("expired-b", JSON.stringify({ v: 3 }), -60_000);
  seed("corrupt", "!!!", 60_000);
  // Frozen input pins that the helper defensively copies (`[...keys]`) rather
  // than handing its readonly parameter to prisma.
  const keys = Object.freeze(["fresh", "expired-a", "expired-b", "corrupt", "absent"]) as readonly string[];

  const out = await getCacheMany<{ v: number }>(keys);
  assert.deepEqual([...out.entries()], [["fresh", { v: 1 }]]);

  assert.equal(findManyCalls.length, 1); // ONE batch read, not N point reads
  assert.deepEqual(findManyCalls[0], [...keys]);

  // Exactly ONE batch delete covering both expired keys — corrupt/absent keys
  // must not appear in it, and the expiresAt guard rides along.
  assert.equal(deleteManyCalls.length, 1);
  const where = deleteManyCalls[0].where as { key: { in: string[] }; expiresAt: { lt: Date } };
  assert.deepEqual([...where.key.in].sort(), ["expired-a", "expired-b"]);
  assert.ok(where.expiresAt.lt instanceof Date);
});

test("getCacheMany: an all-fresh batch issues no delete at all", async () => {
  seed("a", JSON.stringify("A"), 60_000);
  seed("b", JSON.stringify("B"), 60_000);
  const out = await getCacheMany<string>(["a", "b"]);
  assert.deepEqual([...out.entries()], [["a", "A"], ["b", "B"]]);
  assert.equal(deleteManyCalls.length, 0);
});

// ── serve-stale variants ────────────────────────────────────────────────────

test("getCacheStale: missing → {null,false}; fresh → {value,false}; expired → {value,true} and NEVER deleted", async () => {
  assert.deepEqual(await getCacheStale("absent"), { value: null, isStale: false });

  seed("fresh", JSON.stringify({ v: "live" }), 60_000);
  assert.deepEqual(await getCacheStale("fresh"), { value: { v: "live" }, isStale: false });

  seed("old", JSON.stringify({ v: "stale" }), -1_000);
  assert.deepEqual(await getCacheStale("old"), { value: { v: "stale" }, isStale: true });
  // Serve-stale exists so callers can revalidate async — deleting the row
  // here would leave them nothing to serve.
  assert.equal(deleteManyCalls.length, 0);
});

test("getCacheStale: malformed JSON is a hard miss even when expired ({null, isStale:false})", async () => {
  // The parse throws before isStale is computed, so a corrupt-and-expired row
  // reads as "nothing cached", not "stale value available".
  seed("corrupt", "{oops", -1_000);
  assert.deepEqual(await getCacheStale("corrupt"), { value: null, isStale: false });
  assert.equal(deleteManyCalls.length, 0);
});

test("getCacheStaleMany: batch read, per-row staleness, corrupt/absent keys omitted, zero deletes", async () => {
  seed("fresh", JSON.stringify(10), 60_000);
  seed("old", JSON.stringify(20), -1_000);
  seed("corrupt", "nope{", 60_000);

  const empty = await getCacheStaleMany<number>([]);
  assert.equal(empty.size, 0);
  assert.equal(findManyCalls.length, 0); // empty input short-circuits

  const out = await getCacheStaleMany<number>(["fresh", "old", "corrupt", "absent"]);
  assert.equal(findManyCalls.length, 1);
  assert.deepEqual(
    [...out.entries()],
    [
      ["fresh", { value: 10, isStale: false }],
      ["old", { value: 20, isStale: true }], // expired rows are SERVED, flagged
    ],
  );
  assert.equal(deleteManyCalls.length, 0);
});

// ── setCache ────────────────────────────────────────────────────────────────

test("setCache: upsert keyed on `key`, identical serialised data on both branches, expiry = now + ttl", async () => {
  const value = { list: ["x", "y"], n: 7 };
  const before = Date.now();
  await setCache("sc", value, HOUR);
  const after = Date.now();

  assert.equal(upsertCalls.length, 1);
  const args = upsertCalls[0];
  assert.deepEqual(args.where, { key: "sc" });
  assert.equal(args.create.key, "sc");
  assert.equal(args.create.data, JSON.stringify(value));
  assert.equal(args.update.data, args.create.data); // no create/update drift

  for (const branch of [args.create, args.update]) {
    assert.ok(
      branch.expiresAt.getTime() >= before + HOUR * 1000 &&
        branch.expiresAt.getTime() <= after + HOUR * 1000,
      "expiresAt must be now + ttlSeconds",
    );
    assert.ok(branch.cachedAt.getTime() >= before && branch.cachedAt.getTime() <= after);
  }
});

test("setCache then getCache round-trips through the row store", async () => {
  await setCache("rt", { hello: "world" }, HOUR);
  assert.deepEqual(await getCache("rt"), { hello: "world" });
  assert.equal(deleteManyCalls.length, 0); // freshly written row is not expired
});
