// Unit tests for src/lib/tmdb-core-sync.ts — the two writers of TmdbMediaCore,
// the cheap poster/title/year column store that discovery grids, poster-cache,
// and bad-matches read instead of parsing `:details` blobs. Contracts pinned:
//
//  - syncTmdbMediaCore (batch, list pages):
//     · empty input is a no-op — no transaction, no upserts;
//     · items are sorted (tmdbId asc, then mediaType) BEFORE the batch so two
//       concurrent transactions writing overlapping sets acquire row locks in
//       the same order — the documented deadlock guard — and the caller's
//       array is not mutated by the sort;
//     · one shared expiresAt = now + 12h (LIST_TTL) for the whole batch;
//       update stamps lastSyncedAt, create leaves it to the column default;
//     · field normalisation: "movie"/"tv" → "MOVIE"/"TV" in the composite key,
//       posterPath??null, releaseYear ""→null (`||`, not `??`), voteAverage??0,
//       and certification??NULL on BOTH branches (the batch writer overwrites);
//     · the transaction runs with { timeout: BATCH_TX_TIMEOUT } (guardrail 4)
//       and a failure is logged with the [tmdb-core-sync] scope AND re-thrown;
//  - upsertTmdbMediaCore (single, detail pages):
//     · expiry uses the age-aware libraryDetailsTtl (fresh release ≈ 3d,
//       unknown date ≈ 30d), not the fixed list TTL;
//     · certification??UNDEFINED on update — the update must SKIP the column
//       when the media object has no cert, so a lean prewarm write can never
//       erase the value a full details fetch stored (the regression the inline
//       source comment guards); create still defaults it to null;
//     · failures log the tmdbId with the [tmdb-core-sync] scope and re-throw.
//
// No DB: the tmdbMediaCore delegate and $transaction are shadowed in-memory
// (tests/_helpers.mts); console.error is captured (guardrail 7 — errors only).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { TmdbMedia } from "../src/lib/tmdb-types.ts";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto

// ── console capture (before imports so no load-time noise escapes) ──────────
const errors: string[] = [];
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// Dynamic imports so the env/console stubs precede the module-graph load.
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { BATCH_TX_TIMEOUT } = await import("../src/lib/cron-auth.ts");
const { syncTmdbMediaCore, upsertTmdbMediaCore } = await import("../src/lib/tmdb-core-sync.ts");

// ── prisma stubs ────────────────────────────────────────────────────────────
type UpsertBranch = {
  title: string;
  posterPath: string | null;
  releaseYear: string | null;
  voteAverage: number;
  certification?: string | null;
  expiresAt: Date;
  lastSyncedAt?: Date;
  tmdbId?: number;
  mediaType?: "MOVIE" | "TV";
};
type UpsertArgs = {
  where: { tmdbId_mediaType: { tmdbId: number; mediaType: "MOVIE" | "TV" } };
  create: UpsertBranch;
  update: UpsertBranch;
};

const upsertCalls: UpsertArgs[] = [];
let upsertRejection: Error | null = null;
shadowPrismaModel(prisma, "tmdbMediaCore", {
  upsert: (args: UpsertArgs): Promise<UpsertArgs> => {
    upsertCalls.push(args);
    return upsertRejection ? Promise.reject(upsertRejection) : Promise.resolve(args);
  },
});

const txCalls: { size: number; opts: { timeout?: number } | undefined }[] = [];
let txRejection: Error | null = null;
shadowPrismaClientMethod(
  prisma,
  "$transaction",
  (ops: Promise<unknown>[], opts?: { timeout?: number }): Promise<unknown[]> => {
    txCalls.push({ size: ops.length, opts });
    return txRejection ? Promise.reject(txRejection) : Promise.all(ops);
  },
);

beforeEach(() => {
  upsertCalls.length = 0;
  txCalls.length = 0;
  errors.length = 0;
  upsertRejection = null;
  txRejection = null;
});

// Minimal full-shape TmdbMedia; overrides layer per-test fields.
function media(overrides: Partial<TmdbMedia> & { id: number }): TmdbMedia {
  return {
    mediaType: "movie",
    title: `Title ${overrides.id}`,
    overview: "",
    posterPath: null,
    backdropPath: null,
    releaseDate: null,
    releaseYear: "2020",
    voteAverage: 5,
    ...overrides,
  };
}

const DAY_MS = 24 * 3600 * 1000;
const LIST_TTL_MS = 12 * 3600 * 1000;

function assertExpiry(expiresAt: Date, before: number, after: number, ttlMs: number): void {
  assert.ok(
    expiresAt.getTime() >= before + ttlMs && expiresAt.getTime() <= after + ttlMs,
    `expiresAt ${expiresAt.toISOString()} not within now+${ttlMs}ms window`,
  );
}

// ── syncTmdbMediaCore (batch) ───────────────────────────────────────────────

test("batch: empty input is a no-op — no transaction, no upserts", async () => {
  await syncTmdbMediaCore([]);
  assert.equal(txCalls.length, 0);
  assert.equal(upsertCalls.length, 0);
});

test("batch: deadlock guard — upserts sorted by tmdbId then mediaType, caller's array untouched", async () => {
  const input = [
    media({ id: 20, mediaType: "tv" }),
    media({ id: 10, mediaType: "movie" }),
    media({ id: 20, mediaType: "movie" }),
  ];
  const originalOrder = input.map((m) => [m.id, m.mediaType]);

  await syncTmdbMediaCore(input);

  // Sorted order: id asc, then "movie" < "tv" — every concurrent writer locks
  // rows in this same sequence, which is the whole point of the sort.
  assert.deepEqual(
    upsertCalls.map((c) => [c.where.tmdbId_mediaType.tmdbId, c.where.tmdbId_mediaType.mediaType]),
    [[10, "MOVIE"], [20, "MOVIE"], [20, "TV"]],
  );
  // `[...items].sort` — the sort must not reorder the caller's array.
  assert.deepEqual(input.map((m) => [m.id, m.mediaType]), originalOrder);
});

test("batch: field normalisation — enum mapping, poster??null, releaseYear ''→null, vote??0, cert null on BOTH branches", async () => {
  // A lean list row: TMDB list payloads legitimately lack poster/vote/cert.
  const lean = {
    id: 7,
    mediaType: "tv",
    title: "Lean Show",
    overview: "",
    backdropPath: null,
    releaseDate: null,
    releaseYear: "", // empty string, not null — the `||` must coerce it
    posterPath: undefined,
    voteAverage: undefined,
  } as unknown as TmdbMedia;

  await syncTmdbMediaCore([lean]);

  const c = upsertCalls[0];
  assert.deepEqual(c.where, { tmdbId_mediaType: { tmdbId: 7, mediaType: "TV" } });
  for (const branch of [c.create, c.update]) {
    assert.equal(branch.title, "Lean Show");
    assert.equal(branch.posterPath, null);
    assert.equal(branch.releaseYear, null); // "" || null
    assert.equal(branch.voteAverage, 0);
    // The BATCH writer overwrites certification with null when absent — the
    // deliberate contrast with upsertTmdbMediaCore's skip (tested below).
    assert.equal(branch.certification, null);
  }
  assert.equal(c.create.tmdbId, 7);
  assert.equal(c.create.mediaType, "TV");
});

test("batch: one shared 12h expiresAt for the whole batch; update stamps lastSyncedAt, create does not", async () => {
  const before = Date.now();
  await syncTmdbMediaCore([media({ id: 1 }), media({ id: 2 })]);
  const after = Date.now();

  const [a, b] = upsertCalls;
  // Same instant for every item — the batch is one list snapshot, one expiry.
  assert.equal(a.create.expiresAt.getTime(), b.create.expiresAt.getTime());
  assert.equal(a.update.expiresAt.getTime(), a.create.expiresAt.getTime());
  assertExpiry(a.create.expiresAt, before, after, LIST_TTL_MS);

  assert.ok(a.update.lastSyncedAt instanceof Date);
  assert.ok(!("lastSyncedAt" in a.create), "create must leave lastSyncedAt to the column default");
});

test("batch: runs as ONE transaction over all items with { timeout: BATCH_TX_TIMEOUT }", async () => {
  await syncTmdbMediaCore([media({ id: 1 }), media({ id: 2 }), media({ id: 3 })]);
  assert.equal(txCalls.length, 1);
  assert.equal(txCalls[0].size, 3); // one upsert op per item, all in the same tx
  // Guardrail 4: library-sized writes always carry the 30s batch timeout.
  assert.deepEqual(txCalls[0].opts, { timeout: BATCH_TX_TIMEOUT });
});

test("batch: a failed transaction logs with the [tmdb-core-sync] scope and re-throws", async () => {
  txRejection = new Error("deadlock detected");
  await assert.rejects(() => syncTmdbMediaCore([media({ id: 1 }), media({ id: 2 })]), /deadlock detected/);
  assert.ok(
    errors.some((e) => e.includes("[tmdb-core-sync]") && e.includes("2") && e.includes("items")),
    "failure must be logged with scope + item count before propagating",
  );
});

// ── upsertTmdbMediaCore (single) ────────────────────────────────────────────

test("single: expiry is age-aware — a this-year release gets ~3 days, not the 12h list TTL", async () => {
  const thisYear = new Date().getFullYear();
  const before = Date.now();
  await upsertTmdbMediaCore(media({ id: 5, releaseDate: `${thisYear}-06-15` }));
  const after = Date.now();
  assertExpiry(upsertCalls[0].create.expiresAt, before, after, 3 * DAY_MS);
  assert.equal(upsertCalls[0].update.expiresAt.getTime(), upsertCalls[0].create.expiresAt.getTime());
});

test("single: unknown release date falls into the longest bucket (~30 days)", async () => {
  const before = Date.now();
  await upsertTmdbMediaCore(media({ id: 6, releaseDate: null }));
  const after = Date.now();
  assertExpiry(upsertCalls[0].create.expiresAt, before, after, 30 * DAY_MS);
});

test("single: absent certification SKIPS the column on update (never erases a stored cert); create defaults null", async () => {
  await upsertTmdbMediaCore(media({ id: 9 })); // lean prewarm shape — no certification field
  const lean = upsertCalls[0];
  assert.equal(lean.create.certification, null);
  // undefined ⇒ Prisma skips the column — a null here would regress the cert
  // badge every time the prewarm runs after a full details fetch.
  assert.equal(lean.update.certification, undefined);

  await upsertTmdbMediaCore(media({ id: 9, certification: "PG-13" }));
  const full = upsertCalls[1];
  assert.equal(full.create.certification, "PG-13");
  assert.equal(full.update.certification, "PG-13");
});

test("single: normalisation matches the batch writer — enum key, poster??null, ''→null year, vote??0", async () => {
  const lean = {
    id: 3,
    mediaType: "tv",
    title: "Lean",
    overview: "",
    backdropPath: null,
    releaseDate: null,
    releaseYear: "",
    posterPath: undefined,
    voteAverage: undefined,
  } as unknown as TmdbMedia;

  await upsertTmdbMediaCore(lean);
  const c = upsertCalls[0];
  assert.deepEqual(c.where, { tmdbId_mediaType: { tmdbId: 3, mediaType: "TV" } });
  for (const branch of [c.create, c.update]) {
    assert.equal(branch.posterPath, null);
    assert.equal(branch.releaseYear, null);
    assert.equal(branch.voteAverage, 0);
  }
  assert.ok(c.update.lastSyncedAt instanceof Date);
  assert.ok(!("lastSyncedAt" in c.create));
});

test("single: a failed upsert logs the tmdbId with the [tmdb-core-sync] scope and re-throws", async () => {
  upsertRejection = new Error("column store on fire");
  await assert.rejects(() => upsertTmdbMediaCore(media({ id: 424242 })), /column store on fire/);
  assert.ok(
    errors.some((e) => e.includes("[tmdb-core-sync]") && e.includes("424242")),
    "failure must be logged with scope + tmdbId before propagating",
  );
});
