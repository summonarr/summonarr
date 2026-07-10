// Unit tests for the DB-free surfaces of src/lib/cron-auth.ts — the guardrails
// 4+6 module every cron/sync route funnels through. Pins:
//
//   - isCronAuthorized's CRON_SECRET Bearer path: exact "Bearer " scheme, the
//     hash-first timing-safe compare (differing lengths never throw), and
//     fail-closed on a wrong/missing/blank secret or an unset env var. The
//     admin-session path needs a DB and is intentionally NOT exercised — with
//     no cookie and a non-JWT bearer, readActiveSummonarrSessionFromRequest
//     resolves null without touching prisma, so these tests stay offline.
//   - batchCreateMany's chunking contract (guardrail 4): CREATE_MANY_BATCH is
//     5000 (pinned via 12001 rows → 5000/5000/2001), chunks run sequentially
//     (never a parallel burst against the pool), skipDuplicates on every call,
//     and a chunk failure stops the loop so the enclosing $transaction rolls
//     back cleanly. BATCH_TX_TIMEOUT itself is pinned at 30_000.
//   - withCronRunRecording's ok-derivation: throw → false, status >= 400 →
//     false, X-Cron-Degraded header presence → false (the docker entrypoint
//     retries any non-2xx every 300s, so degraded runs must return 200 + the
//     header), otherwise true — and the recordCronRun ledger write is
//     observability-only: its upsert failure never breaks the caller.
//   - parseCronLastRun's JSON validation + defaulting (missing durationMs → 0,
//     ok !== false semantics, non-object payloads → null).
//
// There is no local DB in this harness: src/lib/prisma.ts caches its client on
// globalThis, so the fake `setting.upsert` is seeded there BEFORE the module
// graph loads — no query ever leaves the process, and the ledger writes are
// fully observable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

// prisma.ts pulls in token-crypto (lazy key, but set it defensively); the
// session read inside isCronAuthorized runs the bearer value through
// verifySessionJwt, which reads NEXTAUTH_SECRET.
process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "unit-test-nextauth-secret-0123456789abcdef";

type SettingUpsertArgs = {
  where: { key: string };
  create: { key: string; value: string };
  update: { value: string };
};

const upsertCalls: SettingUpsertArgs[] = [];
let failUpserts = false;

const fakePrisma = {
  setting: {
    upsert: async (args: SettingUpsertArgs): Promise<{ key: string; value: string }> => {
      upsertCalls.push(args);
      if (failUpserts) throw new Error("unit-test DB write failure");
      return args.create;
    },
  },
};

(globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;

const {
  BATCH_TX_TIMEOUT,
  batchCreateMany,
  isCronAuthorized,
  parseCronLastRun,
  recordCronRun,
  withCronRunRecording,
} = await import("../src/lib/cron-auth.ts");

function lastLedgerWrite(): { key: string; parsed: ReturnType<typeof parseCronLastRun> } {
  const call = upsertCalls[upsertCalls.length - 1];
  assert.ok(call, "expected a setting.upsert ledger write");
  return { key: call.where.key, parsed: parseCronLastRun(call.create.value) };
}

function resetLedger(): void {
  upsertCalls.length = 0;
  failUpserts = false;
}

// ---------------------------------------------------------------------------
// parseCronLastRun — JSON validation + defaulting
// ---------------------------------------------------------------------------

test("parseCronLastRun: null / undefined / empty string → null", () => {
  assert.equal(parseCronLastRun(null), null);
  assert.equal(parseCronLastRun(undefined), null);
  assert.equal(parseCronLastRun(""), null);
});

test("parseCronLastRun: malformed JSON → null, never throws", () => {
  assert.equal(parseCronLastRun("{not json"), null);
  assert.equal(parseCronLastRun("   "), null);
  assert.equal(parseCronLastRun("{\"at\":"), null);
});

test("parseCronLastRun: happy path returns exactly the three ledger fields", () => {
  const raw = JSON.stringify({
    at: "2026-07-09T12:00:00.000Z",
    durationMs: 1234,
    ok: true,
    extra: "ignored", // unknown fields must not leak into the parsed shape
  });
  assert.deepEqual(parseCronLastRun(raw), {
    at: "2026-07-09T12:00:00.000Z",
    durationMs: 1234,
    ok: true,
  });
});

test("parseCronLastRun: `at` is required and must be a string", () => {
  assert.equal(parseCronLastRun("{}"), null);
  assert.equal(parseCronLastRun(JSON.stringify({ durationMs: 5, ok: true })), null);
  assert.equal(parseCronLastRun(JSON.stringify({ at: 42, durationMs: 5 })), null);
  assert.equal(parseCronLastRun(JSON.stringify({ at: null, durationMs: 5 })), null);
});

test("parseCronLastRun: missing or non-number durationMs defaults to 0", () => {
  assert.deepEqual(parseCronLastRun(JSON.stringify({ at: "t" })), {
    at: "t",
    durationMs: 0,
    ok: true,
  });
  assert.deepEqual(parseCronLastRun(JSON.stringify({ at: "t", durationMs: "99" })), {
    at: "t",
    durationMs: 0,
    ok: true,
  });
});

test("parseCronLastRun: ok defaults via `!== false` (pre-ok ledger rows read as ok)", () => {
  // Older ledger rows were written without `ok`; they must read as successful.
  assert.equal(parseCronLastRun(JSON.stringify({ at: "t" }))?.ok, true);
  assert.equal(parseCronLastRun(JSON.stringify({ at: "t", ok: true }))?.ok, true);
  assert.equal(parseCronLastRun(JSON.stringify({ at: "t", ok: false }))?.ok, false);
  // Current behavior: only the literal false reads as a failure — recordCronRun
  // is the single writer and only ever writes booleans, so non-boolean values
  // fall on the "ok" side of the `!== false` check.
  assert.equal(parseCronLastRun(JSON.stringify({ at: "t", ok: 0 }))?.ok, true);
});

test("parseCronLastRun: non-object JSON payloads → null", () => {
  assert.equal(parseCronLastRun("null"), null);
  assert.equal(parseCronLastRun("42"), null);
  // Strings and arrays expose a built-in `.at` FUNCTION — the typeof guard
  // must reject them rather than treat the method as the timestamp.
  assert.equal(parseCronLastRun('"2026-07-09"'), null);
  assert.equal(parseCronLastRun("[]"), null);
});

// ---------------------------------------------------------------------------
// batchCreateMany + BATCH_TX_TIMEOUT — guardrail 4
// ---------------------------------------------------------------------------

test("BATCH_TX_TIMEOUT is pinned at 30_000ms", () => {
  assert.equal(BATCH_TX_TIMEOUT, 30_000);
});

type Row = { i: number };
type CreateManyCall = { data: Row[]; skipDuplicates?: boolean };

function makeFakeTx(opts: { failOnCall?: number } = {}) {
  const calls: CreateManyCall[] = [];
  let active = 0;
  let maxActive = 0;
  const tx = {
    createMany: async (args: CreateManyCall): Promise<{ count: number }> => {
      calls.push(args);
      if (opts.failOnCall === calls.length) throw new Error("chunk write failed");
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return { count: args.data.length };
    },
  };
  return { tx, calls, maxConcurrent: () => maxActive };
}

test("batchCreateMany: 12001 rows chunk into 5000/5000/2001 in order", async () => {
  const rows: Row[] = Array.from({ length: 12_001 }, (_, i) => ({ i }));
  const { tx, calls } = makeFakeTx();
  await batchCreateMany(tx, rows);

  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((c) => c.data.length), [5000, 5000, 2001]);
  // slice() boundaries: no row lost, duplicated, or reordered across chunks.
  assert.equal(calls[0].data[0], rows[0]);
  assert.equal(calls[0].data[4999], rows[4999]);
  assert.equal(calls[1].data[0], rows[5000]);
  assert.equal(calls[1].data[4999], rows[9999]);
  assert.equal(calls[2].data[0], rows[10_000]);
  assert.equal(calls[2].data[2000], rows[12_000]);
});

test("batchCreateMany: every chunk passes skipDuplicates: true", async () => {
  const rows: Row[] = Array.from({ length: 10_001 }, (_, i) => ({ i }));
  const { tx, calls } = makeFakeTx();
  await batchCreateMany(tx, rows);
  assert.equal(calls.length, 3);
  for (const call of calls) assert.equal(call.skipDuplicates, true);
});

test("batchCreateMany: chunks run sequentially, never as a parallel burst", async () => {
  // A parallel fan-out over library-sized inserts is exactly what the chunking
  // exists to avoid — each createMany must be awaited before the next starts.
  const rows: Row[] = Array.from({ length: 12_001 }, (_, i) => ({ i }));
  const { tx, calls, maxConcurrent } = makeFakeTx();
  await batchCreateMany(tx, rows);
  assert.equal(calls.length, 3);
  assert.equal(maxConcurrent(), 1);
});

test("batchCreateMany: empty input issues zero createMany calls", async () => {
  const { tx, calls } = makeFakeTx();
  await batchCreateMany(tx, []);
  assert.equal(calls.length, 0);
});

test("batchCreateMany: exact-multiple boundaries (5000 → one call, 5001 → 5000+1)", async () => {
  const exact = makeFakeTx();
  await batchCreateMany(exact.tx, Array.from({ length: 5000 }, (_, i) => ({ i })));
  assert.deepEqual(exact.calls.map((c) => c.data.length), [5000]);

  const overByOne = makeFakeTx();
  await batchCreateMany(overByOne.tx, Array.from({ length: 5001 }, (_, i) => ({ i })));
  assert.deepEqual(overByOne.calls.map((c) => c.data.length), [5000, 1]);

  const single = makeFakeTx();
  await batchCreateMany(single.tx, [{ i: 0 }]);
  assert.deepEqual(single.calls.map((c) => c.data.length), [1]);
});

test("batchCreateMany: a failed chunk propagates and stops later chunks", async () => {
  // Inside a $transaction the throw must reach the caller so Prisma rolls the
  // whole write back — swallowing it would violate guardrail 23.
  const rows: Row[] = Array.from({ length: 12_001 }, (_, i) => ({ i }));
  const { tx, calls } = makeFakeTx({ failOnCall: 2 });
  await assert.rejects(batchCreateMany(tx, rows), /chunk write failed/);
  assert.equal(calls.length, 2); // third chunk never issued
});

// ---------------------------------------------------------------------------
// isCronAuthorized — CRON_SECRET Bearer path (guardrail 6)
// ---------------------------------------------------------------------------

// ≥32 chars, matching the boot-time enforcement the no-throttle comment relies on.
const CRON_SECRET = "unit-test-cron-secret-0123456789abcdef";

function cronRequest(headers?: Record<string, string>, path = "/api/sync"): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, { method: "POST", headers });
}

test("isCronAuthorized: correct Bearer CRON_SECRET → authorized", async () => {
  process.env.CRON_SECRET = CRON_SECRET;
  const ok = await isCronAuthorized(cronRequest({ authorization: `Bearer ${CRON_SECRET}` }));
  assert.equal(ok, true);
});

test("isCronAuthorized: wrong secret fails closed", async () => {
  process.env.CRON_SECRET = CRON_SECRET;
  const ok = await isCronAuthorized(
    cronRequest({ authorization: "Bearer definitely-not-the-secret-0123456789" }),
  );
  assert.equal(ok, false);
});

test("isCronAuthorized: truncated and extended secrets fail (length-safe compare)", async () => {
  // safeCompareStrings hashes both sides first, so mismatched lengths must
  // compare false rather than throw out of timingSafeEqual.
  process.env.CRON_SECRET = CRON_SECRET;
  assert.equal(
    await isCronAuthorized(cronRequest({ authorization: `Bearer ${CRON_SECRET.slice(0, -1)}` })),
    false,
  );
  assert.equal(
    await isCronAuthorized(cronRequest({ authorization: `Bearer ${CRON_SECRET}x` })),
    false,
  );
  assert.equal(await isCronAuthorized(cronRequest({ authorization: "Bearer x" })), false);
});

test("isCronAuthorized: no Authorization header → unauthorized", async () => {
  process.env.CRON_SECRET = CRON_SECRET;
  assert.equal(await isCronAuthorized(cronRequest()), false);
});

test("isCronAuthorized: the CRON path requires the exact 'Bearer ' scheme", async () => {
  process.env.CRON_SECRET = CRON_SECRET;
  // Lowercase scheme: the session-bearer parser is case-insensitive, but the
  // CRON_SECRET compare deliberately keys off startsWith("Bearer ") — a
  // lowercase header must not authorize the cron path.
  assert.equal(
    await isCronAuthorized(cronRequest({ authorization: `bearer ${CRON_SECRET}` })),
    false,
  );
  assert.equal(
    await isCronAuthorized(cronRequest({ authorization: `Basic ${CRON_SECRET}` })),
    false,
  );
  // Double space: slice(7) keeps the second space, so the compare fails.
  assert.equal(
    await isCronAuthorized(cronRequest({ authorization: `Bearer  ${CRON_SECRET}` })),
    false,
  );
});

test("isCronAuthorized: webhook-style ?token= query param is NOT accepted here", async () => {
  // The query-string fallback is a webhook-route affordance (guardrail 2);
  // cron/sync routes accept only the Authorization header or an admin session.
  process.env.CRON_SECRET = CRON_SECRET;
  const ok = await isCronAuthorized(
    cronRequest(undefined, `/api/sync?token=${encodeURIComponent(CRON_SECRET)}`),
  );
  assert.equal(ok, false);
});

test("isCronAuthorized: unset or empty CRON_SECRET fails closed", async () => {
  delete process.env.CRON_SECRET;
  assert.equal(
    await isCronAuthorized(cronRequest({ authorization: `Bearer ${CRON_SECRET}` })),
    false,
  );
  // Empty string is falsy — the Bearer branch must not even run the compare
  // (a "Bearer" header with an empty token must never match an empty secret).
  process.env.CRON_SECRET = "";
  assert.equal(
    await isCronAuthorized(cronRequest({ authorization: "Bearer anything" })),
    false,
  );
  process.env.CRON_SECRET = CRON_SECRET;
});

// ---------------------------------------------------------------------------
// recordCronRun — the Setting-table ledger write
// ---------------------------------------------------------------------------

test("recordCronRun: upserts cron:lastRun:<target> with a parseable ledger value", async () => {
  resetLedger();
  await recordCronRun("sync", 1234);

  assert.equal(upsertCalls.length, 1);
  const call = upsertCalls[0];
  assert.equal(call.where.key, "cron:lastRun:sync");
  assert.equal(call.create.key, "cron:lastRun:sync");
  // create and update must carry the same payload so both upsert arms agree.
  assert.equal(call.create.value, call.update.value);

  const parsed = parseCronLastRun(call.create.value);
  assert.ok(parsed);
  assert.equal(parsed.durationMs, 1234);
  assert.equal(parsed.ok, true); // ok defaults to true
  assert.ok(!Number.isNaN(Date.parse(parsed.at)), "at must be a parseable timestamp");
});

test("recordCronRun: ok=false round-trips through parseCronLastRun", async () => {
  resetLedger();
  await recordCronRun("play-history", 55, false);
  const { key, parsed } = lastLedgerWrite();
  assert.equal(key, "cron:lastRun:play-history");
  assert.deepEqual({ durationMs: parsed?.durationMs, ok: parsed?.ok }, { durationMs: 55, ok: false });
});

test("recordCronRun: a failed upsert is swallowed — observability never fails the caller", async () => {
  resetLedger();
  failUpserts = true;
  await recordCronRun("sync", 10); // must resolve, not reject
  assert.equal(upsertCalls.length, 1);
});

// ---------------------------------------------------------------------------
// withCronRunRecording — ok derivation (throw / status>=400 / X-Cron-Degraded)
// ---------------------------------------------------------------------------

test("withCronRunRecording: 2xx response → ok:true, response returned unchanged", async () => {
  resetLedger();
  const res = new Response(null, { status: 200 });
  const returned = await withCronRunRecording("sync", async () => res);

  assert.equal(returned, res); // identity — the wrapper never rebuilds the response
  const { key, parsed } = lastLedgerWrite();
  assert.equal(key, "cron:lastRun:sync");
  assert.equal(parsed?.ok, true);
  assert.ok(Number.isInteger(parsed?.durationMs));
  assert.ok((parsed?.durationMs ?? -1) >= 0);
});

test("withCronRunRecording: status >= 400 records ok:false but still returns the response", async () => {
  for (const status of [400, 500, 502]) {
    resetLedger();
    const res = new Response(null, { status });
    const returned = await withCronRunRecording("sync", async () => res);
    assert.equal(returned, res);
    assert.equal(lastLedgerWrite().parsed?.ok, false, `status ${status} must record ok:false`);
  }
});

test("withCronRunRecording: status 399 is below the failure boundary → ok:true", async () => {
  resetLedger();
  await withCronRunRecording("sync", async () => new Response(null, { status: 399 }));
  assert.equal(lastLedgerWrite().parsed?.ok, true);
});

test("withCronRunRecording: X-Cron-Degraded on a 200 records ok:false (presence, any casing)", async () => {
  // Degraded-but-completed runs return 200 so the docker entrypoint keeps the
  // normal cron cadence, while the ledger still surfaces the failure.
  resetLedger();
  const res = new Response(null, { status: 200, headers: { "X-Cron-Degraded": "plex" } });
  const returned = await withCronRunRecording("sync", async () => res);
  assert.equal(returned.status, 200);
  assert.equal(lastLedgerWrite().parsed?.ok, false);

  // Presence alone flips ok — even an empty header value.
  resetLedger();
  await withCronRunRecording(
    "sync",
    async () => new Response(null, { status: 200, headers: { "x-cron-degraded": "" } }),
  );
  assert.equal(lastLedgerWrite().parsed?.ok, false);
});

test("withCronRunRecording: a thrown body records ok:false and rethrows the original error", async () => {
  resetLedger();
  const boom = new Error("sync exploded");
  await assert.rejects(
    withCronRunRecording("sync", async () => {
      throw boom;
    }),
    (err: unknown) => err === boom,
  );
  const { key, parsed } = lastLedgerWrite();
  assert.equal(key, "cron:lastRun:sync");
  assert.equal(parsed?.ok, false);
});

test("withCronRunRecording: a failing ledger write neither blocks success nor masks a throw", async () => {
  resetLedger();
  failUpserts = true;

  const res = new Response(null, { status: 200 });
  assert.equal(await withCronRunRecording("sync", async () => res), res);

  const boom = new Error("body failure");
  await assert.rejects(
    withCronRunRecording("sync", async () => {
      throw boom;
    }),
    (err: unknown) => err === boom, // the upsert error must never replace the body's
  );
  assert.equal(upsertCalls.length, 2); // both runs still attempted the ledger write
});

test("withCronRunRecording: records exactly one ledger write per run, keyed by target", async () => {
  resetLedger();
  await withCronRunRecording("upcoming", async () => new Response(null, { status: 200 }));
  await withCronRunRecording("ratings", async () => new Response(null, { status: 200 }));
  assert.deepEqual(
    upsertCalls.map((c) => c.where.key),
    ["cron:lastRun:upcoming", "cron:lastRun:ratings"],
  );
});
