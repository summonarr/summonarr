// Unit tests for the webhook replay guard (src/lib/webhook-replay.ts) — the
// dedup layer in front of the Sonarr/Radarr webhook handlers. The digest IS
// the identity of a delivery, so its construction is a wire contract:
//   - source + secret + body are bound with NUL separators, so a replay aimed
//     at a different endpoint (or recorded under a rotated secret) is a
//     distinct key, and ("ab","c") can never collide with ("a","bc");
//   - the JSON variant canonicalizes key order recursively (arrays keep
//     order), so a source-side retry that serializes the same payload with
//     reordered fields still hits the same key instead of double-processing.
// The record path must be atomic: create-or-P2002, then a GUARDED updateMany
// (WHERE expiresAt <= now) so two deliveries racing on an expired row can't
// both claim it — count===1 owns the delivery, count===0 is a replay. The
// clear path is the rollback that reopens Sonarr/Radarr's source-side retry
// window after a handler failure; it must be idempotent on P2025 and must
// never throw (a throw would mask the handler's own error).
//
// There is no local DB in this harness, so prisma.webhookReplay is shadowed
// with a stateful in-memory stub (the tests/jellyfin-config.test.mts pattern —
// Prisma 7's $extends result exposes model delegates as own writable data
// properties). Prisma errors are REAL PrismaClientKnownRequestError instances
// from the generated client so the module's instanceof+code gates are
// exercised faithfully. Math.random is pinned so the 1-in-100 cleanup lottery
// is deterministic, and mock timers pin the 24h TTL arithmetic exactly.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Prisma } from "@/generated/prisma";
import { prisma } from "../src/lib/prisma.ts";
import {
  checkAndRecordWebhook,
  checkAndRecordWebhookJson,
  clearWebhookReplayDigestJson,
  __resetWebhookReplayCacheForTests,
} from "../src/lib/webhook-replay.ts";
import { shadowPrismaModel } from "./_helpers.mts";

const TTL_MS = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 15, 12, 0, 0);

type ReplayRow = { digest: string; expiresAt: Date };
type CreateArgs = { data: ReplayRow };
type UpdateManyArgs = {
  where: { digest: string; expiresAt: { lte: Date } };
  data: { expiresAt: Date };
};
type DeleteArgs = { where: { digest: string } };
type DeleteManyArgs = { where: { expiresAt: { lt: Date } } };

function knownError(code: string, message = `prisma error ${code}`): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(message, {
    code,
    clientVersion: "0.0.0-test",
  });
}

// In-memory table: digest → expiresAt. The stub mirrors Postgres semantics the
// module depends on: the unique constraint fires on ANY existing row (expired
// or not), and updateMany matches only when the row satisfies the lte guard.
const rows = new Map<string, Date>();
const calls = {
  create: [] as CreateArgs[],
  updateMany: [] as UpdateManyArgs[],
  delete: [] as DeleteArgs[],
  deleteMany: [] as DeleteManyArgs[],
};
let createError: Error | null = null;
let deleteError: Error | null = null;
let deleteManyError: Error | null = null;

const replayStub = {
  create: async (args: CreateArgs): Promise<ReplayRow> => {
    calls.create.push(args);
    if (createError) throw createError;
    if (rows.has(args.data.digest)) {
      throw new Prisma.PrismaClientKnownRequestError(
        "Unique constraint failed on the fields: (`digest`)",
        { code: "P2002", clientVersion: "0.0.0-test", meta: { target: ["digest"] } },
      );
    }
    rows.set(args.data.digest, args.data.expiresAt);
    return args.data;
  },
  updateMany: async (args: UpdateManyArgs): Promise<{ count: number }> => {
    calls.updateMany.push(args);
    const expiry = rows.get(args.where.digest);
    if (expiry !== undefined && expiry.getTime() <= args.where.expiresAt.lte.getTime()) {
      rows.set(args.where.digest, args.data.expiresAt);
      return { count: 1 };
    }
    return { count: 0 };
  },
  delete: async (args: DeleteArgs): Promise<ReplayRow> => {
    calls.delete.push(args);
    if (deleteError) throw deleteError;
    const expiry = rows.get(args.where.digest);
    if (expiry === undefined) throw knownError("P2025", "Record to delete does not exist.");
    rows.delete(args.where.digest);
    return { digest: args.where.digest, expiresAt: expiry };
  },
  deleteMany: async (args: DeleteManyArgs): Promise<{ count: number }> => {
    calls.deleteMany.push(args);
    if (deleteManyError) throw deleteManyError;
    let count = 0;
    for (const [digest, expiry] of rows) {
      if (expiry.getTime() < args.where.expiresAt.lt.getTime()) {
        rows.delete(digest);
        count++;
      }
    }
    return { count };
  },
};

// Shadow the delegate BEFORE any test runs. The helper fails fast and loudly
// if a Prisma upgrade ever stops this from taking effect — otherwise the first
// call would issue a real query against a DB that doesn't exist and hang.
shadowPrismaModel(prisma, "webhookReplay", replayStub);

// Pin the 1-in-100 cleanup lottery. Default 0.5 = never fires, so unrelated
// tests can't flake on a lucky roll; lottery tests set it explicitly.
let nextRandom = 0.5;
Math.random = () => nextRandom;

beforeEach(() => {
  rows.clear();
  calls.create.length = 0;
  calls.updateMany.length = 0;
  calls.delete.length = 0;
  calls.deleteMany.length = 0;
  createError = null;
  deleteError = null;
  deleteManyError = null;
  nextRandom = 0.5;
});

function lastCreateDigest(): string {
  const last = calls.create[calls.create.length - 1];
  assert.ok(last, "expected at least one webhookReplay.create call");
  return last.data.digest;
}

// ---------------------------------------------------------------------------
// Digest identity (observable through create/replay behavior + captured keys)
// ---------------------------------------------------------------------------

test("first delivery records a 64-char lowercase hex sha256 digest and returns true", async () => {
  assert.equal(await checkAndRecordWebhookJson("sonarr", "secret", { eventType: "Download" }), true);
  const digest = lastCreateDigest();
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.ok(rows.has(digest));
});

test("EXACT-VALUE PIN: digest = sha256(source \\0 secret \\0 canonical-JSON)", async () => {
  // Any change to this construction (separator, hash, canonical form) makes
  // every digest recorded before a deploy unmatchable after it — a silent
  // 24h window where genuine replays double-process. The input's keys are
  // deliberately scrambled at both levels; the expected string is the
  // recursively key-sorted serialization.
  await checkAndRecordWebhookJson("sonarr", "super-secret", {
    movie: { tmdbId: 603, id: 1 },
    eventType: "Download",
  });
  const expected = createHash("sha256")
    .update("sonarr")
    .update("\0")
    .update("super-secret")
    .update("\0")
    .update('{"eventType":"Download","movie":{"id":1,"tmdbId":603}}', "utf8")
    .digest("hex");
  assert.equal(lastCreateDigest(), expected);
});

test("same JSON with reordered top-level keys is detected as a replay", async () => {
  assert.equal(await checkAndRecordWebhookJson("sonarr", "s", { a: 1, b: 2, c: 3 }), true);
  const first = lastCreateDigest();
  assert.equal(await checkAndRecordWebhookJson("sonarr", "s", { c: 3, a: 1, b: 2 }), false);
  assert.equal(lastCreateDigest(), first); // identical key → the unique constraint fired
});

test("canonicalization is recursive — deeply nested reordering still dedupes", async () => {
  const original = { series: { title: "T", ids: { tvdb: 1, tmdb: 2 } }, eventType: "Grab" };
  const reordered = { eventType: "Grab", series: { ids: { tmdb: 2, tvdb: 1 }, title: "T" } };
  assert.equal(await checkAndRecordWebhookJson("sonarr", "s", original), true);
  assert.equal(await checkAndRecordWebhookJson("sonarr", "s", reordered), false);
});

test("reordered keys INSIDE array elements dedupe (elements are canonicalized)", async () => {
  assert.equal(
    await checkAndRecordWebhookJson("sonarr", "s", { episodes: [{ id: 1, season: 2 }] }),
    true,
  );
  assert.equal(
    await checkAndRecordWebhookJson("sonarr", "s", { episodes: [{ season: 2, id: 1 }] }),
    false,
  );
});

test("array ORDER is significant — swapped elements are a different delivery", async () => {
  assert.equal(await checkAndRecordWebhookJson("sonarr", "s", { episodes: [1, 2] }), true);
  const first = lastCreateDigest();
  assert.equal(await checkAndRecordWebhookJson("sonarr", "s", { episodes: [2, 1] }), true);
  assert.notEqual(lastCreateDigest(), first);
});

test("different values under the same keys are a different delivery", async () => {
  assert.equal(await checkAndRecordWebhookJson("radarr", "s", { movieId: 1 }), true);
  const first = lastCreateDigest();
  assert.equal(await checkAndRecordWebhookJson("radarr", "s", { movieId: 2 }), true);
  assert.notEqual(lastCreateDigest(), first);
});

test("same body under a different source is a distinct key (cross-endpoint replay)", async () => {
  const payload = { eventType: "Download", id: 7 };
  assert.equal(await checkAndRecordWebhookJson("sonarr", "shared", payload), true);
  const sonarrDigest = lastCreateDigest();
  assert.equal(await checkAndRecordWebhookJson("radarr", "shared", payload), true);
  assert.notEqual(lastCreateDigest(), sonarrDigest);
});

test("same body under a different secret is a distinct key (secret rotation)", async () => {
  const payload = { eventType: "Download", id: 7 };
  assert.equal(await checkAndRecordWebhookJson("sonarr", "old-secret", payload), true);
  const oldDigest = lastCreateDigest();
  assert.equal(await checkAndRecordWebhookJson("sonarr", "new-secret", payload), true);
  assert.notEqual(lastCreateDigest(), oldDigest);
});

test("NUL separator pins the source/secret boundary — ('ab','c') never collides with ('a','bc')", async () => {
  // Without the \0 separators both would hash the same "abc"+body stream.
  const payload = { id: 1 };
  assert.equal(await checkAndRecordWebhookJson("ab", "c", payload), true);
  const d1 = lastCreateDigest();
  assert.equal(await checkAndRecordWebhookJson("a", "bc", payload), true);
  assert.notEqual(lastCreateDigest(), d1);
});

test("NUL separator pins the secret/body boundary on the raw variant", async () => {
  assert.equal(await checkAndRecordWebhook("radarr", "sx", "y"), true);
  const d1 = lastCreateDigest();
  assert.equal(await checkAndRecordWebhook("radarr", "s", "xy"), true);
  assert.notEqual(lastCreateDigest(), d1);
});

test("raw variant: string and Uint8Array of the same utf8 bytes hit the same key", async () => {
  const body = '{"title":"Amélie"}'; // non-ASCII pins the utf8 encoding of the string path
  assert.equal(await checkAndRecordWebhook("radarr", "s", body), true);
  const first = lastCreateDigest();
  assert.equal(await checkAndRecordWebhook("radarr", "s", new TextEncoder().encode(body)), false);
  assert.equal(lastCreateDigest(), first);
});

test("raw variant does NOT canonicalize — reordered JSON text is a distinct key", async () => {
  // checkAndRecordWebhook hashes the bytes as-received; only the Json variant
  // normalizes. Pins the split so nobody 'unifies' them and breaks either
  // signature-bound raw bodies or reorder-tolerant JSON dedup.
  assert.equal(await checkAndRecordWebhook("radarr", "s", '{"a":1,"b":2}'), true);
  const first = lastCreateDigest();
  assert.equal(await checkAndRecordWebhook("radarr", "s", '{"b":2,"a":1}'), true);
  assert.notEqual(lastCreateDigest(), first);
});

test("non-object JSON payloads (null, numbers) pass through canonicalization and dedupe", async () => {
  assert.equal(await checkAndRecordWebhookJson("sonarr", "s", null), true);
  assert.equal(await checkAndRecordWebhookJson("sonarr", "s", null), false);
  assert.equal(await checkAndRecordWebhookJson("sonarr", "s", 42), true);
  assert.equal(await checkAndRecordWebhookJson("sonarr", "s", 42), false);
});

// ---------------------------------------------------------------------------
// Record path: TTL, the guarded CAS refresh, error propagation
// ---------------------------------------------------------------------------

test("TTL PIN: a fresh row expires exactly 24h from now", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  await checkAndRecordWebhookJson("sonarr", "s", { a: 1 });
  const created = calls.create[0];
  assert.ok(created);
  assert.equal(created.data.expiresAt.getTime(), T0 + TTL_MS);
});

test("live-row replay: guarded updateMany shape is pinned, count 0 → false", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  assert.equal(await checkAndRecordWebhookJson("sonarr", "s", { a: 1 }), true);
  const digest = lastCreateDigest();

  assert.equal(await checkAndRecordWebhookJson("sonarr", "s", { a: 1 }), false);
  assert.equal(calls.updateMany.length, 1);
  const refresh = calls.updateMany[0];
  assert.equal(refresh.where.digest, digest);
  // The CAS guard: only rows already expired as-of "now" are claimable.
  assert.equal(refresh.where.expiresAt.lte.getTime(), T0);
  assert.equal(refresh.data.expiresAt.getTime(), T0 + TTL_MS);
  // The live row's expiry was NOT touched by the losing replay.
  const stored = rows.get(digest);
  assert.ok(stored);
  assert.equal(stored.getTime(), T0 + TTL_MS);
});

test("expired-row race: exactly one delivery wins the CAS (lte boundary inclusive)", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  assert.equal(await checkAndRecordWebhookJson("sonarr", "s", { a: 1 }), true);
  const digest = lastCreateDigest();

  // Advance to the exact expiry instant: expiresAt <= now holds (lte, not lt),
  // so the first redelivery flips the row and owns the delivery...
  t.mock.timers.setTime(T0 + TTL_MS);
  assert.equal(await checkAndRecordWebhookJson("sonarr", "s", { a: 1 }), true);
  const refreshed = rows.get(digest);
  assert.ok(refreshed);
  assert.equal(refreshed.getTime(), T0 + TTL_MS + TTL_MS); // TTL re-anchored to the new now

  // ...and the loser arriving at the same instant sees a future-dated row.
  assert.equal(await checkAndRecordWebhookJson("sonarr", "s", { a: 1 }), false);
});

test("1ms before expiry is still inside the replay window", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  assert.equal(await checkAndRecordWebhookJson("sonarr", "s", { a: 1 }), true);
  t.mock.timers.setTime(T0 + TTL_MS - 1);
  assert.equal(await checkAndRecordWebhookJson("sonarr", "s", { a: 1 }), false);
});

test("a non-P2002 create failure propagates (fail closed — the handler 500s, the source retries)", async () => {
  createError = knownError("P1001", "can't reach database");
  await assert.rejects(
    checkAndRecordWebhookJson("sonarr", "s", { a: 1 }),
    (thrown: unknown) => thrown === createError,
  );
  assert.equal(calls.updateMany.length, 0); // never treated as a replay
});

test("FAIL-CLOSED PIN: a duck-typed { code: 'P2002' } plain Error propagates (instanceof gate)", async () => {
  createError = Object.assign(new Error("unique violation"), { code: "P2002" });
  await assert.rejects(
    checkAndRecordWebhookJson("sonarr", "s", { a: 1 }),
    (thrown: unknown) => thrown === createError,
  );
  assert.equal(calls.updateMany.length, 0);
});

// ---------------------------------------------------------------------------
// The 1-in-100 cleanup lottery
// ---------------------------------------------------------------------------

test("cleanup lottery boundary: fires strictly below 0.01, pruning rows expired before now", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  nextRandom = 0.01; // Math.random() < 0.01 is false at the boundary
  await checkAndRecordWebhookJson("sonarr", "s", { a: 1 });
  assert.equal(calls.deleteMany.length, 0);

  nextRandom = 0.0099;
  await checkAndRecordWebhookJson("sonarr", "s", { b: 2 });
  assert.equal(calls.deleteMany.length, 1);
  // Strictly-less-than now: a row expiring exactly at now survives cleanup so
  // the CAS refresh path (lte) can still claim it.
  assert.equal(calls.deleteMany[0].where.expiresAt.lt.getTime(), T0);
});

test("a detected replay returns false BEFORE the cleanup lottery rolls", async () => {
  await checkAndRecordWebhookJson("sonarr", "s", { a: 1 });
  nextRandom = 0; // would fire on any path that reaches the lottery
  assert.equal(await checkAndRecordWebhookJson("sonarr", "s", { a: 1 }), false);
  assert.equal(calls.deleteMany.length, 0);
});

test("cleanup is fire-and-forget — a rejecting deleteMany never fails the delivery", async () => {
  nextRandom = 0;
  deleteManyError = new Error("db down");
  assert.equal(await checkAndRecordWebhookJson("sonarr", "s", { a: 1 }), true);
  assert.equal(calls.deleteMany.length, 1);
  // Drain a tick so the swallowed rejection settles inside this test; an
  // unhandled rejection here would crash the runner process.
  await new Promise((resolve) => setImmediate(resolve));
});

// ---------------------------------------------------------------------------
// clearWebhookReplayDigestJson — the post-failure rollback
// ---------------------------------------------------------------------------

test("record → clear → record: rollback reopens the source-side retry window", async () => {
  assert.equal(await checkAndRecordWebhookJson("sonarr", "s", { a: 1 }), true);
  const digest = lastCreateDigest();

  await clearWebhookReplayDigestJson("sonarr", "s", { a: 1 });
  assert.equal(calls.delete.length, 1);
  assert.equal(calls.delete[0].where.digest, digest); // same digest construction as the record path

  // Sonarr's retry of the failed delivery is treated as a first delivery again.
  assert.equal(await checkAndRecordWebhookJson("sonarr", "s", { a: 1 }), true);
});

test("clear is key-order independent — a reordered payload clears the original digest", async () => {
  assert.equal(await checkAndRecordWebhookJson("sonarr", "s", { a: 1, b: { x: 1, y: 2 } }), true);
  await clearWebhookReplayDigestJson("sonarr", "s", { b: { y: 2, x: 1 }, a: 1 });
  assert.equal(rows.size, 0);
  assert.equal(await checkAndRecordWebhookJson("sonarr", "s", { a: 1, b: { x: 1, y: 2 } }), true);
});

test("clear on a missing row (P2025) is a silent idempotent no-op", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  await clearWebhookReplayDigestJson("sonarr", "s", { never: "recorded" });
  assert.equal(calls.delete.length, 1);
  assert.equal(warn.mock.callCount(), 0);
});

test("clear swallows other failures but warns with source + TRUNCATED digest", async (t) => {
  assert.equal(await checkAndRecordWebhookJson("sonarr", "s", { a: 1 }), true);
  const digest = lastCreateDigest();
  deleteError = new Error("connection refused");
  const warn = t.mock.method(console, "warn", () => {});

  // Must resolve — a throw here would mask the handler error that triggered the rollback.
  await clearWebhookReplayDigestJson("sonarr", "s", { a: 1 });

  assert.equal(warn.mock.callCount(), 1);
  const [message, detail] = warn.mock.calls[0].arguments as [string, string];
  assert.ok(message.startsWith("[webhook-replay]"));
  assert.ok(message.includes("source=sonarr"));
  assert.ok(message.includes(`digest=${digest.slice(0, 12)}`));
  assert.ok(!message.includes(digest)); // only the 12-char prefix is logged
  assert.equal(detail, "connection refused");
});

test("FAIL-CLOSED PIN: a duck-typed { code: 'P2025' } plain Error still warns (instanceof gate)", async (t) => {
  deleteError = Object.assign(new Error("record not found"), { code: "P2025" });
  const warn = t.mock.method(console, "warn", () => {});
  await clearWebhookReplayDigestJson("sonarr", "s", { a: 1 }); // still resolves
  assert.equal(warn.mock.callCount(), 1);
});

test("__resetWebhookReplayCacheForTests is a callable no-op (interface compatibility)", () => {
  assert.equal(__resetWebhookReplayCacheForTests(), undefined);
});
