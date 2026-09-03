// Unit tests for the DB-free surfaces of src/lib/cron-auth.ts — the guardrails
// 4+6 module every cron/sync route funnels through. Pins:
//
//   - isCronAuthorized's CRON_SECRET Bearer path: exact "Bearer " scheme, the
//     hash-first timing-safe compare (differing lengths never throw), and
//     fail-closed on a wrong/missing/blank secret or an unset env var.
//   - getCronActor: the SAME single session read answers both "authorized?"
//     and "who?" — an admin actor carries the DB-checked claims, a CRON_SECRET
//     caller is the system/cron actor, and isCronAuthorized is exactly
//     `getCronActor(...) !== null`. Every cron/sync route used to re-run the
//     DB-checked read a second time just for attribution.
//   - isCronAuthorized's admin-session path, per transport (guardrail 6b): a
//     COOKIE admin session must pass BOTH the same-origin check and the
//     UA-fingerprint check (load-bearing CSRF defenses — cron/sync routes are
//     exempt from the proxy's Origin gate), while a BEARER admin session skips
//     both (a cross-origin page cannot attach a custom Authorization header to
//     a credentialed request, and native clients send no Origin/Referer at
//     all). The DB reads behind verifyAndRefreshSession run against the fake
//     prisma's authSession/user models below, so these tests stay offline.
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
// Backing store for the ledger read recordCronRun now performs. Empty by
// default, so every pre-existing case still sees "no prior history".
const settingRows = new Map<string, string>();
let failFindUnique = false;

// In-memory backing for the admin-session transport tests: session rows by
// sessionId, users by id. Empty by default so the CRON_SECRET tests never see
// a session even if a stray cookie/bearer header were present.
const sessionRows = new Set<string>();
const usersById = new Map<
  string,
  {
    role: string;
    permissions: bigint;
    mediaServer: string | null;
    sessionsRevokedAt: Date | null;
    passwordChangedAt: Date | null;
    deactivatedAt: Date | null;
    email: string | null;
    notificationEmail: string | null;
  }
>();

const fakePrisma = {
  setting: {
    upsert: async (args: SettingUpsertArgs): Promise<{ key: string; value: string }> => {
      upsertCalls.push(args);
      if (failUpserts) throw new Error("unit-test DB write failure");
      settingRows.set(args.where.key, args.create.value);
      return args.create;
    },
    findUnique: async (args: { where: { key: string } }): Promise<{ value: string } | null> => {
      if (failFindUnique) throw new Error("unit-test DB read failure");
      const value = settingRows.get(args.where.key);
      return value === undefined ? null : { value };
    },
  },
  authSession: {
    findUnique: async (args: { where: { sessionId: string } }) =>
      sessionRows.has(args.where.sessionId)
        ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId }
        : null,
    // lastSeenAt fire-and-forget touch — no-op.
    update: async () => ({}),
  },
  user: {
    findUnique: async (args: { where: { id: string } }) => {
      const u = usersById.get(args.where.id);
      return u ? { ...u } : null;
    },
  },
};

(globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;

const {
  BATCH_TX_TIMEOUT,
  batchCreateMany,
  isCronAuthorized,
  getCronActor,
  CRON_SYSTEM_ACTOR,
  parseCronLastRun,
  parseCronRunHistory,
  countCronRunsSince,
  CRON_RUN_HISTORY_LIMIT,
  recordCronRun,
  withCronRunRecording,
} = await import("../src/lib/cron-auth.ts");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { extractUaFingerprint, serializeFingerprint } = await import(
  "../src/lib/ua-fingerprint.ts"
);

function lastLedgerWrite(): { key: string; parsed: ReturnType<typeof parseCronLastRun> } {
  const call = upsertCalls[upsertCalls.length - 1];
  assert.ok(call, "expected a setting.upsert ledger write");
  return { key: call.where.key, parsed: parseCronLastRun(call.create.value) };
}

function resetLedger(): void {
  upsertCalls.length = 0;
  failUpserts = false;
  failFindUnique = false;
  settingRows.clear();
}

/** The `recent` array actually persisted by the most recent ledger write. */
function lastLedgerHistory(): ReturnType<typeof parseCronRunHistory> {
  const call = upsertCalls[upsertCalls.length - 1];
  assert.ok(call, "expected a setting.upsert ledger write");
  return parseCronRunHistory(call.create.value);
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

// ---------------------------------------------------------------------------
// isCronAuthorized — admin-session path, per transport (guardrail 6b)
// ---------------------------------------------------------------------------

// With neither env set, buildSessionTrustedOrigins falls back to the request's
// own origin (http://localhost:3000) — deterministic for these tests.
delete process.env.AUTH_URL;
delete process.env.AUTH_TRUSTED_ORIGIN;

const ADMIN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Mints a REAL session JWT whose AuthSession row + User row exist in the fake
// prisma, so readActiveSummonarrSessionFromRequest's DB-checked slow path
// resolves it. Claim permissions mirror the DB mask so no sessionId rotation
// (which would need $transaction) is triggered.
async function mintSession(sessionId: string, role: "ADMIN" | "USER"): Promise<string> {
  const userId = `user-${sessionId}`;
  sessionRows.add(sessionId);
  usersById.set(userId, {
    role,
    permissions: role === "ADMIN" ? 1n : 0n,
    mediaServer: null,
    sessionsRevokedAt: null,
    passwordChangedAt: null,
    deactivatedAt: null,
    email: "admin@example.com",
    notificationEmail: null,
  });
  return signSessionJwt(
    {
      id: userId,
      role,
      permissions: role === "ADMIN" ? "1" : "0",
      email: "admin@example.com",
      name: null,
      provider: "credentials",
      mediaServer: null,
      sessionId,
      uaFingerprint: serializeFingerprint(extractUaFingerprint(ADMIN_UA)),
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    },
    { expiresInSeconds: 3600 },
  );
}

test("isCronAuthorized: cookie admin session + same-origin + matching UA → authorized", async () => {
  const jwt = await mintSession("sess-cookie-ok", "ADMIN");
  const ok = await isCronAuthorized(
    cronRequest({
      cookie: `summonarr-session=${jwt}`,
      origin: "http://localhost:3000",
      "user-agent": ADMIN_UA,
    }),
  );
  assert.equal(ok, true);
});

test("isCronAuthorized: cookie admin session WITHOUT Origin/Referer fails closed (CSRF gate is load-bearing for cookies)", async () => {
  const jwt = await mintSession("sess-cookie-no-origin", "ADMIN");
  const ok = await isCronAuthorized(
    cronRequest({
      cookie: `summonarr-session=${jwt}`,
      "user-agent": ADMIN_UA,
    }),
  );
  assert.equal(ok, false);
});

test("isCronAuthorized: cookie admin session with a mismatched UA fingerprint fails closed", async () => {
  const jwt = await mintSession("sess-cookie-bad-ua", "ADMIN");
  const ok = await isCronAuthorized(
    cronRequest({
      cookie: `summonarr-session=${jwt}`,
      origin: "http://localhost:3000",
      "user-agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    }),
  );
  assert.equal(ok, false);
});

test("isCronAuthorized: BEARER admin session authorizes with no Origin and an arbitrary UA (guardrail 6b)", async () => {
  // A native client sends no Origin/Referer and its own UA; the custom
  // Authorization header is the CSRF-sound signal, so neither browser-shaped
  // gate applies to this transport.
  const jwt = await mintSession("sess-bearer-ok", "ADMIN");
  const ok = await isCronAuthorized(
    cronRequest({
      authorization: `Bearer ${jwt}`,
      "user-agent": "Summonarr-iOS/42",
    }),
  );
  assert.equal(ok, true);
});

test("isCronAuthorized: a bearer NON-admin session is still refused (role gate unchanged)", async () => {
  process.env.CRON_SECRET = CRON_SECRET;
  const jwt = await mintSession("sess-bearer-user", "USER");
  const ok = await isCronAuthorized(
    cronRequest({
      authorization: `Bearer ${jwt}`,
      "user-agent": "Summonarr-iOS/42",
    }),
  );
  // Not ADMIN → the session branch declines; the JWT then fails the
  // CRON_SECRET compare, so the request is unauthorized.
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
// getCronActor — one session read for BOTH the gate and the attribution
// ---------------------------------------------------------------------------

test("getCronActor: Bearer CRON_SECRET → the system/cron actor (no session to attribute)", async () => {
  process.env.CRON_SECRET = CRON_SECRET;
  const actor = await getCronActor(cronRequest({ authorization: `Bearer ${CRON_SECRET}` }));
  assert.deepEqual(actor, { userId: "system", userName: "cron", trigger: "cron" });
  assert.equal(actor, CRON_SYSTEM_ACTOR);
});

test("getCronActor: cookie admin session (same-origin + matching UA) → admin actor carrying the DB-checked claims", async () => {
  const jwt = await mintSession("actor-cookie-ok", "ADMIN");
  const actor = await getCronActor(
    cronRequest({
      cookie: `summonarr-session=${jwt}`,
      origin: "http://localhost:3000",
      "user-agent": ADMIN_UA,
    }),
  );
  // name is null in the minted claims → the "admin" fallback every cron route used.
  assert.deepEqual(actor, { userId: "user-actor-cookie-ok", userName: "admin", trigger: "admin" });
});

test("getCronActor: BEARER admin session → admin actor with no Origin and an arbitrary UA (guardrail 6b)", async () => {
  const jwt = await mintSession("actor-bearer-ok", "ADMIN");
  const actor = await getCronActor(
    cronRequest({ authorization: `Bearer ${jwt}`, "user-agent": "Summonarr-iOS/42" }),
  );
  assert.deepEqual(actor, { userId: "user-actor-bearer-ok", userName: "admin", trigger: "admin" });
});

test("getCronActor: the cookie gates still bite — no Origin, or a mismatched UA, → null (never a cron actor)", async () => {
  process.env.CRON_SECRET = CRON_SECRET;
  const jwt = await mintSession("actor-cookie-gated", "ADMIN");
  assert.equal(
    await getCronActor(cronRequest({ cookie: `summonarr-session=${jwt}`, "user-agent": ADMIN_UA })),
    null,
  );
  assert.equal(
    await getCronActor(cronRequest({
      cookie: `summonarr-session=${jwt}`,
      origin: "http://localhost:3000",
      "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1",
    })),
    null,
  );
});

test("getCronActor: a non-admin bearer session and an absent credential → null", async () => {
  process.env.CRON_SECRET = CRON_SECRET;
  const jwt = await mintSession("actor-bearer-user", "USER");
  assert.equal(await getCronActor(cronRequest({ authorization: `Bearer ${jwt}` })), null);
  assert.equal(await getCronActor(cronRequest()), null);
  assert.equal(await getCronActor(cronRequest({ authorization: "Bearer nope-0123456789abcdefghijklmnop" })), null);
});

test("getCronActor and isCronAuthorized agree on every transport — the gate IS the actor read", async () => {
  process.env.CRON_SECRET = CRON_SECRET;
  const adminJwt = await mintSession("actor-agree-admin", "ADMIN");
  const userJwt = await mintSession("actor-agree-user", "USER");
  const cases: Array<Record<string, string> | undefined> = [
    { authorization: `Bearer ${CRON_SECRET}` },
    { authorization: `Bearer ${CRON_SECRET}x` },
    { authorization: `Bearer ${adminJwt}` },
    { authorization: `Bearer ${userJwt}` },
    { cookie: `summonarr-session=${adminJwt}`, origin: "http://localhost:3000", "user-agent": ADMIN_UA },
    { cookie: `summonarr-session=${adminJwt}`, "user-agent": ADMIN_UA },
    undefined,
  ];
  for (const headers of cases) {
    const actor = await getCronActor(cronRequest(headers));
    assert.equal(await isCronAuthorized(cronRequest(headers)), actor !== null, JSON.stringify(headers));
  }
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

// ---------------------------------------------------------------------------
// parseCronRunHistory / countCronRunsSince / the recordCronRun run history
//
// Why this exists at all: the ledger used to keep only the newest run, so it
// could not distinguish "this job ran once" from "this job ran four hundred
// times" — which is exactly the question an operator has when a job misbehaves,
// and exactly what the `[internal-trigger] … see the sync:full entry` warning
// points them at. These pin the history that makes that answerable.
// ---------------------------------------------------------------------------

test("parseCronRunHistory: null / empty / malformed / non-object → [] and never throws", () => {
  assert.deepEqual(parseCronRunHistory(null), []);
  assert.deepEqual(parseCronRunHistory(undefined), []);
  assert.deepEqual(parseCronRunHistory(""), []);
  assert.deepEqual(parseCronRunHistory("{not json"), []);
  assert.deepEqual(parseCronRunHistory("null"), []);
  assert.deepEqual(parseCronRunHistory("42"), []);
  assert.deepEqual(parseCronRunHistory("[]"), []);
});

test("parseCronRunHistory: a PRE-HISTORY ledger row degrades to its single run, not to nothing", () => {
  // Rows written before `recent` shipped carry only the three top-level fields.
  // Reading those as an empty history would silently drop the last known run on
  // upgrade and make the first post-upgrade rate read as 1 instead of 2.
  const legacy = JSON.stringify({ at: "2026-09-01T00:00:00.000Z", durationMs: 91, ok: true });
  assert.deepEqual(parseCronRunHistory(legacy), [
    { at: "2026-09-01T00:00:00.000Z", durationMs: 91, ok: true },
  ]);
});

test("parseCronRunHistory: entries without a string `at` are dropped; defaults match parseCronLastRun", () => {
  const raw = JSON.stringify({
    at: "t0", durationMs: 1, ok: true,
    recent: [
      { at: "t0", durationMs: 1, ok: true },
      { at: 42, durationMs: 1 },            // non-string at → dropped
      { durationMs: 5 },                    // missing at → dropped
      null,                                 // not an object → dropped
      ["t1"],                               // array → dropped
      { at: "t2" },                         // durationMs → 0, ok → true
      { at: "t3", durationMs: "9", ok: 0 }, // non-number duration → 0; only literal false is a failure
      { at: "t4", ok: false },
    ],
  });
  assert.deepEqual(parseCronRunHistory(raw), [
    { at: "t0", durationMs: 1, ok: true },
    { at: "t2", durationMs: 0, ok: true },
    { at: "t3", durationMs: 0, ok: true },
    { at: "t4", durationMs: 0, ok: false },
  ]);
});

test("parseCronRunHistory: a row claiming more entries than the cap is truncated on READ too", () => {
  // The write caps, but a hand-edited or future-written row must not be able to
  // make a page render an unbounded list.
  const recent = Array.from({ length: CRON_RUN_HISTORY_LIMIT + 25 }, (_, i) => ({
    at: `t${i}`, durationMs: 0, ok: true,
  }));
  const parsed = parseCronRunHistory(JSON.stringify({ at: "t0", durationMs: 0, ok: true, recent }));
  assert.equal(parsed.length, CRON_RUN_HISTORY_LIMIT);
});

test("countCronRunsSince: counts at-or-after the cutoff and ignores unparseable timestamps", () => {
  const cutoff = Date.parse("2026-09-01T12:00:00.000Z");
  const entries = [
    { at: "2026-09-01T12:30:00.000Z", durationMs: 0, ok: true }, // after
    { at: "2026-09-01T12:00:00.000Z", durationMs: 0, ok: true }, // exactly at → counts
    { at: "2026-09-01T11:59:59.999Z", durationMs: 0, ok: true }, // before
    { at: "not-a-date", durationMs: 0, ok: true },               // unparseable → ignored
  ];
  assert.equal(countCronRunsSince(entries, cutoff), 2);
  assert.equal(countCronRunsSince([], cutoff), 0);
});

test("recordCronRun: the new run is PREPENDED and prior history is preserved", async () => {
  resetLedger();
  await recordCronRun("sync:full", 10);
  await recordCronRun("sync:full", 20);
  await recordCronRun("sync:full", 30);

  const history = lastLedgerHistory();
  assert.equal(history.length, 3, "each run must add an entry, not replace the row");
  assert.deepEqual(history.map((e) => e.durationMs), [30, 20, 10], "most-recent-first");
  // The top-level fields still describe the newest run — the contract every
  // pre-existing reader (parseCronLastRun, the settings page) depends on.
  assert.equal(lastLedgerWrite().parsed?.durationMs, 30);
});

test("recordCronRun: history is capped at CRON_RUN_HISTORY_LIMIT and drops the OLDEST", async () => {
  resetLedger();
  for (let i = 0; i < CRON_RUN_HISTORY_LIMIT + 5; i++) await recordCronRun("sync:full", i);

  // Assert on the RAW persisted array, not the parsed view: parseCronRunHistory
  // truncates on read too, so reading through it would mask an uncapped WRITE
  // entirely and this pin would pass against a row growing without bound.
  const raw = JSON.parse(upsertCalls[upsertCalls.length - 1].create.value) as { recent: unknown[] };
  assert.equal(raw.recent.length, CRON_RUN_HISTORY_LIMIT, "the stored ledger row must not grow without bound");

  const history = lastLedgerHistory();
  assert.equal(history.length, CRON_RUN_HISTORY_LIMIT);
  assert.equal(history[0].durationMs, CRON_RUN_HISTORY_LIMIT + 4, "newest survives");
  assert.equal(
    history.at(-1)!.durationMs,
    5,
    "the window slides — runs 0-4 are evicted, not the recent ones",
  );
});

test("recordCronRun: ok=false runs are recorded in the history like any other", async () => {
  resetLedger();
  await recordCronRun("sync:full", 1, true);
  await recordCronRun("sync:full", 2, false);
  assert.deepEqual(lastLedgerHistory().map((e) => e.ok), [false, true]);
});

test("recordCronRun: per-target ledgers are independent", async () => {
  resetLedger();
  await recordCronRun("sync:full", 1);
  await recordCronRun("ratings-sync", 2);
  await recordCronRun("sync:full", 3);

  assert.deepEqual(parseCronRunHistory(settingRows.get("cron:lastRun:sync:full")).map((e) => e.durationMs), [3, 1]);
  assert.deepEqual(parseCronRunHistory(settingRows.get("cron:lastRun:ratings-sync")).map((e) => e.durationMs), [2]);
});

test("recordCronRun: a FAILING history read still records the run — observability degrades, never breaks", async () => {
  resetLedger();
  await recordCronRun("sync:full", 10);
  failFindUnique = true;
  await recordCronRun("sync:full", 20); // must resolve, not reject

  const history = lastLedgerHistory();
  assert.equal(history.length, 1, "history is lost for this write, but the run is still recorded");
  assert.equal(history[0].durationMs, 20);
  assert.equal(lastLedgerWrite().parsed?.durationMs, 20, "the last-run contract survives a read failure");
});

test("recordCronRun: a Prisma surface with NO setting.findUnique still records the run", async () => {
  // Guards the real degradation path — several suites stub `prisma.setting`
  // with `upsert` alone, and a hard TypeError there would turn an observability
  // write into a route failure.
  resetLedger();
  const settings = (globalThis as unknown as { prisma: { setting: Record<string, unknown> } }).prisma.setting;
  const saved = settings.findUnique;
  delete settings.findUnique;
  try {
    await recordCronRun("sync:full", 42);
  } finally {
    settings.findUnique = saved;
  }
  assert.equal(lastLedgerWrite().parsed?.durationMs, 42);
  assert.deepEqual(lastLedgerHistory().map((e) => e.durationMs), [42]);
});
