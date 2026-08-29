// Unit tests for verifyAndRefreshSession (src/lib/session-refresh.ts) — the
// surfaces its sibling files do NOT cover. Division of labour:
//   - tests/session-refresh-rotation.test.mts owns the ROLE-change rotation's
//     same-second cutoff regression (rotated token survives its own cutoff,
//     the pre-rotation token dies) and the deliberate `iat <= cutoff`
//     inclusivity for sessionsRevokedAt alone;
//   - tests/session-server.test.mts owns the plain rejection paths as seen
//     through the request-aware reader (expired/tampered JWT, deleted
//     AuthSession row, deactivated user, throwing DB) plus a role change
//     surfacing in the claims;
//   - tests/session-revocation.test.mts owns the in-memory force-check ledger
//     itself (marks, namespaces, FIFO bounds);
//   - tests/session-jwt.test.mts owns the crypto layer; tests/
//     plex-membership.test.mts owns getCachedPlexAllowlist's cache/fail-open
//     internals.
// What THIS file adds:
//   - the dbCheckedAt FAST PATH: a recent check skips the DB entirely (pinned
//     with THROWING model stubs) and returns the original claims un-resigned;
//     the 60s USER vs 10s ADMIN/ISSUE_ADMIN window differential (admin
//     revocations propagate faster); the window's deliberate blindness to a
//     revocation — and markSessionForceRevoked overriding it on the issuing
//     replica; an 8-day-old ADMIN session passing the fast path untouched (the
//     former 7d ceiling is gone);
//   - the SESSION-DEADLINE decision (guardrail 6c): a slow-path verify ALWAYS
//     re-signs (the refreshed token carries dbCheckedAt and rides the fast path
//     next time) with exp put EXACTLY at the sign-in `expiresAt` deadline — a
//     long-TTL (rememberMe/mobile) token is never clamped down to an
//     inactivity window, and a token whose JWT exp had drifted below the
//     deadline is re-extended back out to it; the re-sign never reaches past
//     the deadline; a token past the deadline is rejected outright for EVERY
//     role (ADMIN included — no role-specific lifetime rules: no slide skip,
//     no `expiresAt` exemption, no 7d ceiling on either path, pinned with a
//     session born 8 days ago); an idle rememberMe session survives a multi-day
//     gap and dies only at its deadline, walked under a faked Date CLASS (jose
//     reads `new Date()`, not just Date.now); and a NATIVE session — deadline =
//     the never-reached sentinel from session-lifetime.ts — re-signs to the
//     sentinel forever and ends only through revocation (row deleted);
//   - the passwordChangedAt cutoff (before/same-second/after boundaries) and
//     cutoff = max(sessionsRevokedAt, passwordChangedAt);
//   - PERMISSIONS-only privilege change (same role) rotating the sessionId,
//     stamping sessionsRevokedAt, and propagating the new mask into both the
//     returned claims and the re-signed token; a rotation whose transaction
//     loses the row or throws failing CLOSED (null, never a stale session);
//   - mediaServer refresh for credentials tokens vs the sign-in-pinned
//     jellyfin provider; the missing-sessionId guard (null, zero DB);
//   - the plex-provider membership hook failing OPEN when unconfigured (the
//     allowlist returns "no opinion" — an unreachable plex.tv must never mass
//     log out; the allowlist's own semantics live in plex-membership.test);
//   - the multi-instance membership recheck THROUGH the real plex-membership
//     module: a plex USER shared on NO instance is revoked (teeth), and — the
//     accepted Phase-2.5 trade-off — membership on ANY instance keeps the
//     session even when the sign-in-era server dropped the user (the union
//     doesn't know which server a session was signed in against).
//
// No DB or network: the model delegates are shadowed in-memory (tests/
// _helpers.mts), fetch throws, and every JWT is a REAL jose token. Cutoff and
// window boundaries are asserted with ±2s clock-drift margins where "now" is
// re-read inside the function; exact-boundary cases use values this file
// fixes on both sides (iat vs a Date it also chooses), which are drift-free.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto
process.env.NEXTAUTH_SECRET = "session-refresh-slide-test-secret-0123456789";

// No network, ever: the plex fail-open test must fail open WITHOUT plex.tv.
// The two multi-instance membership tests at the bottom temporarily swap in a
// scripted fetch (and restore this throwing default afterwards).
globalThis.fetch = (() => {
  throw new Error("unexpected network call from session-refresh tests");
}) as unknown as typeof fetch;

// The scripted plex.tv hop resolves through safe-fetch's DNS check — stub it so
// no real DNS query leaves the process (the trakt.test rationale).
const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) {
  throw new Error("could not stub dns.lookup — aborting before a real DNS query can leave the process");
}

const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

import type { SessionClaims } from "../src/lib/session-jwt.ts";

// Dynamic imports so the env/global stubs above genuinely precede the
// module-graph load (static imports would hoist — the trakt.test pattern).
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { verifyAndRefreshSession } = await import("../src/lib/session-refresh.ts");
const { markSessionForceRevoked } = await import("../src/lib/session-revocation.ts");
const { NEVER_EXPIRES_AT_SEC } = await import("../src/lib/session-lifetime.ts");

const DAY = 86_400;
const SEVEN_DAYS = 7 * DAY;

// ── in-memory DB state ──────────────────────────────────────────────────────
type DbUser = {
  role: string;
  permissions: bigint;
  mediaServer: string | null;
  sessionsRevokedAt: Date | null;
  passwordChangedAt: Date | null;
  deactivatedAt: Date | null;
  email: string | null;
  notificationEmail: string | null;
};

const usersById = new Map<string, DbUser>();
const sessionRows = new Set<string>();
// Backing AuthSession.createdAt per sessionId (session birth; defaults to the
// token's iat in mint()). The former ADMIN 7d ceiling anchored on it — the
// no-ceiling pin below mints a session born 8 days ago to prove it's gone.
const sessionCreatedAt = new Map<string, Date>();
let dbReads = 0;
let settingReads = 0;
let throwOnDb = false; // fast-path proof: any model read throws
let txRowMissing = false; // rotation tx: the AuthSession row vanished mid-flight
let txThrows = false; // rotation tx: the whole transaction rejects

shadowPrismaModel(prisma, "authSession", {
  findUnique: async (args: { where: { sessionId: string } }) => {
    dbReads++;
    if (throwOnDb) throw new Error("unit-test: DB must not be touched on this path");
    return sessionRows.has(args.where.sessionId)
      ? {
          id: `row-${args.where.sessionId}`,
          sessionId: args.where.sessionId,
          createdAt: sessionCreatedAt.get(args.where.sessionId) ?? new Date(),
        }
      : null;
  },
  // lastSeenAt fire-and-forget touch — no-op.
  update: async () => ({}),
});

shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id: string } }) => {
    dbReads++;
    if (throwOnDb) throw new Error("unit-test: DB must not be touched on this path");
    const u = usersById.get(args.where.id);
    return u ? { ...u } : null;
  },
  update: async (args: { where: { id: string }; data: { sessionsRevokedAt?: Date } }) => {
    const u = usersById.get(args.where.id);
    if (u && args.data.sessionsRevokedAt) u.sessionsRevokedAt = args.data.sessionsRevokedAt;
    return {};
  },
});

// getCachedPlexAllowlist reads the plex instance registry plus each instance's
// connection settings + admin email — all via setting.findUnique ONLY (this
// stub deliberately defines nothing else, so a findMany creeping into that
// module's path fails loudly here). Default: empty map → every key reads null
// → unconfigured → the allowlist answers "no opinion" (fail open). The
// multi-instance membership tests at the bottom seed rows.
let membershipSettings: Record<string, string | undefined> = {};
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    settingReads++;
    const value = membershipSettings[args.where.key];
    return value === undefined ? null : { key: args.where.key, value };
  },
});

// The privilege-change rotation runs inside an interactive $transaction — hand
// the callback a tx facade over the same in-memory state, with failure knobs.
const txStub = {
  authSession: {
    findUnique: async (args: { where: { sessionId: string } }) =>
      !txRowMissing && sessionRows.has(args.where.sessionId)
        ? { id: `row-${args.where.sessionId}` }
        : null,
    update: async (args: { where: { sessionId: string }; data: { sessionId: string } }) => {
      // sessionId rotation preserves session identity → carry createdAt forward.
      const born = sessionCreatedAt.get(args.where.sessionId);
      sessionRows.delete(args.where.sessionId);
      sessionCreatedAt.delete(args.where.sessionId);
      sessionRows.add(args.data.sessionId);
      if (born) sessionCreatedAt.set(args.data.sessionId, born);
      return {};
    },
  },
  user: {
    findUnique: async (args: { where: { id: string } }) => {
      const u = usersById.get(args.where.id);
      return u ? { sessionsRevokedAt: u.sessionsRevokedAt } : null;
    },
    update: async (args: { where: { id: string }; data: { sessionsRevokedAt: Date } }) => {
      const u = usersById.get(args.where.id);
      if (u) u.sessionsRevokedAt = args.data.sessionsRevokedAt;
      return {};
    },
  },
};
shadowPrismaClientMethod(prisma, "$transaction", async (fn: (tx: typeof txStub) => Promise<unknown>) => {
  if (txThrows) throw new Error("unit-test: transaction failure");
  return fn(txStub);
});

// ── fixtures ────────────────────────────────────────────────────────────────
let seq = 0;

type MintOpts = {
  role?: string; // claim role; DB mirrors it unless dbRole is set
  dbRole?: string;
  permissions?: string; // decimal claim; DB mirrors it unless dbPermissions is set
  dbPermissions?: bigint;
  provider?: string;
  mediaServer?: string | null; // claim; omitted when undefined
  dbMediaServer?: string | null;
  sessionsRevokedAt?: Date | null;
  passwordChangedAt?: Date | null;
  iat?: number; // absolute seconds; default now
  createdAt?: Date; // AuthSession row birth; default new Date(iat * 1000)
  expiresInSeconds?: number; // JWT exp − iat; default 7200
  expiresAt?: number; // absolute session deadline claim; default iat + 1d
  dbCheckedAt?: number; // absolute; embedded as the fast-path claim when set
  omitSessionId?: boolean;
};

// Mint a REAL signed session JWT with a backing user + AuthSession row.
async function mint(opts: MintOpts = {}): Promise<{
  userId: string;
  sessionId: string;
  token: string;
  iat: number;
  expiresAt: number;
}> {
  seq++;
  const userId = `user-${seq}`;
  const sessionId = `sess-${seq}`;
  const permissions = opts.permissions ?? "0";
  usersById.set(userId, {
    role: opts.dbRole ?? opts.role ?? "USER",
    permissions: opts.dbPermissions ?? BigInt(permissions),
    mediaServer: opts.dbMediaServer ?? null,
    sessionsRevokedAt: opts.sessionsRevokedAt ?? null,
    passwordChangedAt: opts.passwordChangedAt ?? null,
    deactivatedAt: null,
    email: "u@example.com",
    notificationEmail: null,
  });
  sessionRows.add(sessionId);
  const iat = opts.iat ?? Math.floor(Date.now() / 1000);
  // AuthSession.createdAt defaults to the token's iat, so a token minted with an
  // old iat models an old session (the no-ceiling pin overrides it explicitly).
  sessionCreatedAt.set(sessionId, opts.createdAt ?? new Date(iat * 1000));
  const expiresAt = opts.expiresAt ?? iat + DAY;
  const token = await signSessionJwt(
    {
      id: userId,
      role: opts.role ?? "USER",
      permissions,
      provider: opts.provider ?? "credentials",
      ...(opts.mediaServer !== undefined ? { mediaServer: opts.mediaServer } : {}),
      ...(opts.omitSessionId ? {} : { sessionId }),
      expiresAt,
      ...(typeof opts.dbCheckedAt === "number" ? { dbCheckedAt: opts.dbCheckedAt } : {}),
    } as Omit<SessionClaims, "iat" | "exp">,
    { expiresInSeconds: opts.expiresInSeconds ?? 7_200, iat },
  );
  return { userId, sessionId, token, iat, expiresAt };
}

function decodePayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

beforeEach(() => {
  dbReads = 0;
  settingReads = 0;
  throwOnDb = false;
  txRowMissing = false;
  txThrows = false;
});

// ── guards ──────────────────────────────────────────────────────────────────

test("a token without a sessionId claim is rejected before any DB read", async () => {
  const { token } = await mint({ omitSessionId: true });
  assert.equal(await verifyAndRefreshSession(token), null);
  assert.equal(dbReads, 0);
});

// ── the dbCheckedAt fast path ───────────────────────────────────────────────

test("a fresh dbCheckedAt skips the DB entirely: throwing stubs, original claims back, no re-sign", async () => {
  const now0 = nowSec();
  const { userId, sessionId, token } = await mint({ dbCheckedAt: now0 - 5 });
  throwOnDb = true; // any model read on this path would reject the whole call
  const result = await verifyAndRefreshSession(token);
  assert.ok(result, "the cached check must be honored without a DB round trip");
  assert.equal(result.claims.id, userId);
  assert.equal(result.claims.sessionId, sessionId);
  assert.equal(result.refreshed, undefined, "the fast path must NOT mint a new token");
  assert.equal(dbReads, 0);
});

test("a stale dbCheckedAt (past the 60s USER window) hits the DB and always re-signs; the fresh token rides the fast path", async () => {
  const now0 = nowSec();
  const { userId, sessionId, token } = await mint({ dbCheckedAt: now0 - 65 });
  const result = await verifyAndRefreshSession(token);
  assert.ok(result);
  assert.ok(dbReads >= 2, "the stale window must force the AuthSession + User reads");
  assert.equal(result.claims.sessionId, sessionId, "no privilege change ⇒ sessionId unrotated");
  // Even with nothing changed, the slow path re-signs so dbCheckedAt advances.
  assert.ok(result.refreshed, "a DB-checked verify must hand back a re-signed token");
  const payload = decodePayload(result.refreshed.token);
  assert.equal(typeof payload.dbCheckedAt, "number");
  assert.ok((payload.dbCheckedAt as number) >= now0 - 2, "dbCheckedAt must be stamped 'now'");
  assert.equal(payload.id, userId);

  // The re-signed token is immediately fast-path eligible: DB unavailable, yet
  // it verifies — this is the optimization keeping the hot path off the DB.
  throwOnDb = true;
  const second = await verifyAndRefreshSession(result.refreshed.token);
  assert.ok(second, "the refreshed token must ride the fast path");
  assert.equal(second.refreshed, undefined);
});

test("the fast window is role-tiered: 30s-old check is fresh for USER but stale for ADMIN and ISSUE_ADMIN", async () => {
  const now0 = nowSec();
  // USER: 30s < 60s window — no DB needed even with throwing stubs.
  const user = await mint({ role: "USER", dbCheckedAt: now0 - 30 });
  throwOnDb = true;
  assert.ok(await verifyAndRefreshSession(user.token), "USER must still be inside the 60s window");
  throwOnDb = false;

  // ADMIN: 30s > 10s window — the DB IS consulted, so a revoked admin session
  // dies within ~10s instead of ~60s (demotions/revocations propagate faster).
  const admin = await mint({ role: "ADMIN", dbCheckedAt: now0 - 30 });
  sessionRows.delete(admin.sessionId);
  assert.equal(
    await verifyAndRefreshSession(admin.token),
    null,
    "a revoked ADMIN session must be caught once the 10s window lapses",
  );

  // ISSUE_ADMIN shares the fast 10s interval.
  const issueAdmin = await mint({ role: "ISSUE_ADMIN", dbCheckedAt: now0 - 30 });
  const before = dbReads;
  const result = await verifyAndRefreshSession(issueAdmin.token);
  assert.ok(result);
  assert.ok(dbReads > before, "ISSUE_ADMIN at 30s must take the slow (DB-checked) path");
});

test("the cache window is deliberately blind to a revocation — and markSessionForceRevoked closes it on the issuing replica", async () => {
  const now0 = nowSec();
  const { sessionId, token } = await mint({ dbCheckedAt: now0 - 5 });
  sessionRows.delete(sessionId); // "revoke this device" lands on another surface

  // Within the window and unmarked, the replica honors the cached check: the
  // revocation is NOT seen yet (the documented ≤60s propagation trade-off).
  const blind = await verifyAndRefreshSession(token);
  assert.ok(blind, "inside the window an unmarked replica serves the cached validation");
  assert.equal(dbReads, 0);

  // The issuing replica marks the session; the very next verify must bypass
  // the window, hit the DB, and see the deleted row.
  markSessionForceRevoked(sessionId);
  const after = await verifyAndRefreshSession(token);
  assert.equal(after, null, "a locally-marked session must be re-checked and rejected");
  assert.ok(dbReads > 0, "the mark must force the DB read despite the fresh dbCheckedAt");
});

test("an 8-day-old ADMIN session with a live exp passes the fast path untouched — there is no 7d ceiling", async () => {
  // The ceiling used to fire here off `iat`, with zero DB reads. Guardrail 6c
  // removed it: an admin's session lives to its configured deadline like
  // everyone else's. Mutation-proof both ways — an iat-based re-add rejects
  // this token; a DB-based re-add trips the throwing stubs.
  const now0 = nowSec();
  const { userId, token } = await mint({
    role: "ADMIN",
    iat: now0 - (SEVEN_DAYS + DAY),
    expiresInSeconds: 9 * DAY, // exp still ~a day in the future — JWT verifies
    expiresAt: now0 + DAY,
    dbCheckedAt: now0 - 5, // inside the admin fast window
  });
  throwOnDb = true;
  const result = await verifyAndRefreshSession(token);
  assert.ok(result, "an old-but-unexpired ADMIN token must still ride the fast path");
  assert.equal(result.claims.id, userId);
  assert.equal(dbReads, 0);
});

// ── the session deadline (slow path) — guardrail 6c ─────────────────────────

test("a long-TTL (rememberMe/mobile) token is re-signed out to EXACTLY its sign-in deadline — never clamped to an inactivity window", async () => {
  // This is what makes "remember me" actually last sessionMaxDuration. The
  // re-sign used to clamp exp to min(now + 3600, deadline), so the cookie's
  // Max-Age was ≤1h and any hour-long gap ended the session regardless of the
  // 30-day deadline the settings form promised.
  const now0 = nowSec();
  const { token } = await mint({
    expiresInSeconds: 30 * DAY,
    expiresAt: now0 + 30 * DAY,
  });
  const result = await verifyAndRefreshSession(token);
  assert.ok(result?.refreshed);
  assert.ok(
    Math.abs(result.refreshed.expiresInSeconds - 30 * DAY) <= 2,
    `the re-sign must cover the whole remaining deadline (~${30 * DAY}s), got ${result.refreshed.expiresInSeconds}`,
  );
  const payload = decodePayload(result.refreshed.token);
  assert.ok(
    Math.abs((payload.exp as number) - (now0 + 30 * DAY)) <= 2,
    "the JWT exp must sit at the deadline, not an hour out",
  );
  assert.equal(payload.expiresAt, now0 + 30 * DAY, "the deadline claim itself never moves");
});

test("a token whose JWT exp drifted below its deadline is re-extended back out to the deadline", async () => {
  // A cookie minted by the pre-6c code carries exp ≤ 1h out. Its first
  // DB-checked verify after the upgrade must hand back a token good for the
  // full remaining session, not preserve the short exp.
  const now0 = nowSec();
  const { token } = await mint({
    expiresInSeconds: 1800, // the old inactivity-window exp
    expiresAt: now0 + DAY, // the deadline is a day out
  });
  const result = await verifyAndRefreshSession(token);
  assert.ok(result?.refreshed);
  assert.ok(
    Math.abs(result.refreshed.expiresInSeconds - DAY) <= 2,
    `the remaining life must be pushed back out to the deadline (~${DAY}s), got ${result.refreshed.expiresInSeconds}`,
  );
});

test("the re-sign never reaches past the sign-in session deadline (expiresAt cap)", async () => {
  const now0 = nowSec();
  const { token } = await mint({
    expiresInSeconds: DAY, // exp alone would allow a day
    expiresAt: now0 + 600, // …but the device session deadline is 10 min away
  });
  const result = await verifyAndRefreshSession(token);
  assert.ok(result?.refreshed);
  assert.ok(
    result.refreshed.expiresInSeconds <= 600 && result.refreshed.expiresInSeconds >= 500,
    `the re-sign must cap at the ~600s deadline, got ${result.refreshed.expiresInSeconds}`,
  );
});

test("a session past its expiresAt deadline is rejected for EVERY role, even though the JWT exp is still valid", async () => {
  const now0 = nowSec();
  for (const role of ["USER", "ISSUE_ADMIN", "ADMIN"]) {
    const { token } = await mint({
      role,
      expiresInSeconds: 7_200, // exp two hours out — signature/exp verify fine
      expiresAt: now0 - 10, // …but the sign-in deadline already passed
    });
    assert.equal(await verifyAndRefreshSession(token), null, `${role} must honour the deadline`);
  }
});

test("an IDLE rememberMe session survives a multi-day gap and dies only at its deadline — no inactivity timeout", async () => {
  // The compound outcome the single-step pins above cannot see: a 30-day
  // remember-me session is left alone for days at a time and must still be
  // there, with each DB-checked verify handing back a token good for the
  // whole remaining deadline; one second past the deadline it is gone.
  //
  // jose reads the clock via `new Date()`, not Date.now, so walking a token
  // across days needs the whole Date CLASS faked.
  const RealDate = Date;
  let fakeNowMs = RealDate.now();
  class FakeDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(fakeNowMs);
      else super(...(args as [number]));
    }
    static now(): number {
      return fakeNowMs;
    }
  }
  globalThis.Date = FakeDate as unknown as DateConstructor;
  try {
    const start = Math.floor(fakeNowMs / 1000);
    const deadline = start + 30 * DAY;
    const { token } = await mint({
      iat: start,
      expiresInSeconds: 30 * DAY, // the rememberMe TTL as minted at sign-in
      expiresAt: deadline,
    });

    // Visit at t+2h, t+3d, t+12d, t+29d — gaps far beyond the former 1h window.
    let current = token;
    for (const elapsed of [2 * 3600, 3 * DAY, 12 * DAY, 29 * DAY]) {
      fakeNowMs = (start + elapsed) * 1000;
      const step = await verifyAndRefreshSession(current);
      assert.ok(step?.refreshed, `an idle remember-me session must still verify at t+${elapsed}s`);
      assert.ok(
        Math.abs(step.refreshed.expiresInSeconds - (deadline - (start + elapsed))) <= 2,
        `each DB check must re-sign out to the deadline, at t+${elapsed}s (got ${step.refreshed.expiresInSeconds})`,
      );
      current = step.refreshed.token;
    }

    // …and the deadline keeps its teeth: one second past it the JWT exp (which
    // the re-sign pinned to the deadline) has lapsed, and verifySessionJwt
    // rejects the token outright.
    fakeNowMs = (deadline + 1) * 1000;
    assert.equal(
      await verifyAndRefreshSession(current),
      null,
      "past the sign-in deadline the session must end",
    );
  } finally {
    globalThis.Date = RealDate;
  }
});

test("ADMIN follows the same deadline rule as every other role: re-signed out to the deadline, no exemption, no 7d ceiling", async () => {
  // Admin lifetime used to be governed by a 7d ceiling anchored on the
  // AuthSession row's createdAt (with an iat-based twin on the fast path), and
  // the deadline/slide block was skipped for ADMIN entirely. Guardrail 6c:
  // one rule for everyone. This session was born 8 days ago AND its token's
  // iat is 8 days old, so re-adding either ceiling variant rejects it.
  const now0 = nowSec();
  const { token } = await mint({
    role: "ADMIN",
    iat: now0 - (SEVEN_DAYS + DAY),
    createdAt: new Date((now0 - (SEVEN_DAYS + DAY)) * 1000),
    expiresInSeconds: 9 * DAY,
    expiresAt: now0 + 20 * DAY,
  });
  const result = await verifyAndRefreshSession(token);
  assert.ok(result, "an 8-day-old ADMIN session with a live deadline must survive the slow path");
  assert.ok(dbReads >= 2, "…after the full DB reconciliation");
  assert.ok(result.refreshed);
  assert.ok(
    Math.abs(result.refreshed.expiresInSeconds - 20 * DAY) <= 2,
    `ADMIN must be re-signed out to its deadline (~${20 * DAY}s), got ${result.refreshed.expiresInSeconds}`,
  );
});

test("a NATIVE session (deadline = the never-expires sentinel) re-signs to the sentinel and ends only through revocation", async () => {
  // initializeTokenOnSignIn mints a native (X-Summonarr-Client) session with
  // expiresAt = NEVER_EXPIRES_AT_SEC and exp at the same instant. Nothing
  // time-based may end it: the deadline check passes, the re-sign keeps exp at
  // the sentinel, and a bearer client — which is handed no refreshed token —
  // keeps presenting the original forever. Deleting the AuthSession row (a
  // per-device revoke) is what ends it.
  const now0 = nowSec();
  const { sessionId, token } = await mint({
    expiresInSeconds: NEVER_EXPIRES_AT_SEC - now0,
    expiresAt: NEVER_EXPIRES_AT_SEC,
  });
  const result = await verifyAndRefreshSession(token);
  assert.ok(result?.refreshed, "a native session must verify on the slow path");
  assert.ok(
    Math.abs(result.refreshed.expiresInSeconds - (NEVER_EXPIRES_AT_SEC - now0)) <= 2,
    "the re-sign must cover the whole (indefinite) remaining life",
  );
  const payload = decodePayload(result.refreshed.token);
  assert.equal(payload.expiresAt, NEVER_EXPIRES_AT_SEC, "the sentinel deadline is carried forward unchanged");
  assert.ok(
    Math.abs((payload.exp as number) - NEVER_EXPIRES_AT_SEC) <= 2,
    "the re-signed JWT exp sits at the sentinel",
  );

  // The ORIGINAL token (what a bearer client keeps presenting) still verifies
  // on a later slow-path check…
  const again = await verifyAndRefreshSession(token);
  assert.ok(again, "the original never-expiring token must keep verifying");

  // …until the device is revoked.
  sessionRows.delete(sessionId);
  assert.equal(await verifyAndRefreshSession(token), null, "revocation is the only end of a native session");
});

// ── sessionsRevokedAt / passwordChangedAt cutoffs ───────────────────────────

test("passwordChangedAt cutoff: tokens minted before or in the same second die; a later mint survives", async () => {
  const now0 = nowSec();
  const changedAt = new Date((now0 - 50) * 1000); // cutoff = now0 − 50 exactly

  const before = await mint({ iat: now0 - 100, passwordChangedAt: changedAt });
  assert.equal(
    await verifyAndRefreshSession(before.token),
    null,
    "a token minted before the password change must be rejected",
  );

  const sameSecond = await mint({ iat: now0 - 50, passwordChangedAt: changedAt });
  assert.equal(
    await verifyAndRefreshSession(sameSecond.token),
    null,
    "iat == cutoff must be rejected (the deliberately inclusive <=)",
  );

  const after = await mint({ iat: now0 - 49, passwordChangedAt: changedAt });
  const result = await verifyAndRefreshSession(after.token);
  assert.ok(result, "iat == cutoff + 1 is the smallest accepted iat");
  assert.equal(result.claims.id, after.userId);
});

test("the cutoff is max(sessionsRevokedAt, passwordChangedAt) — a newer password change catches tokens an older revoke missed", async () => {
  const now0 = nowSec();
  const revokedAt = new Date((now0 - 500) * 1000); // old revoke-all
  const changedAt = new Date((now0 - 50) * 1000); // newer password change

  // iat = now0−100: strictly after the revoke cutoff (would survive it alone),
  // but at/below the password cutoff — max() must reject it.
  const caught = await mint({
    iat: now0 - 100,
    sessionsRevokedAt: revokedAt,
    passwordChangedAt: changedAt,
  });
  assert.equal(await verifyAndRefreshSession(caught.token), null);

  // Control: minted after BOTH cutoffs → accepted.
  const fresh = await mint({
    iat: now0 - 49,
    sessionsRevokedAt: revokedAt,
    passwordChangedAt: changedAt,
  });
  assert.ok(await verifyAndRefreshSession(fresh.token));
});

// ── privilege-change rotation (the permissions leg + failure modes) ─────────

test("a permissions-only change (same role) rotates the sessionId and propagates the new mask", async () => {
  // The DB mask moved 0 → 8 (MANAGE_ISSUES) after sign-in; the role did not
  // change. Rotation must fire exactly as for a role change: new sessionId,
  // sessionsRevokedAt stamped, and BOTH the returned claims and the re-signed
  // token carrying the DB mask (a leaked pre-grant token must not replay).
  const { userId, sessionId, token } = await mint({
    role: "USER",
    permissions: "0",
    dbPermissions: 8n,
  });
  const result = await verifyAndRefreshSession(token);
  assert.ok(result, "the permissions change must not reject the live session");
  assert.equal(result.claims.role, "USER");
  assert.equal(result.claims.permissions, "8", "the claims must carry the DB mask");
  assert.notEqual(result.claims.sessionId, sessionId, "a privilege change must rotate the sessionId");
  assert.ok(result.refreshed);
  const payload = decodePayload(result.refreshed.token);
  assert.equal(payload.sessionId, result.claims.sessionId);
  assert.equal(payload.permissions, "8");
  assert.ok(
    usersById.get(userId)?.sessionsRevokedAt instanceof Date,
    "rotation must stamp sessionsRevokedAt so other replicas reject the old token",
  );
  assert.ok(sessionRows.has(result.claims.sessionId as string), "the AuthSession row follows the new id");
  assert.ok(!sessionRows.has(sessionId), "the old sessionId row must be gone");
});

test("a rotation that cannot complete fails CLOSED: missing row mid-transaction and a throwing transaction both yield null", async () => {
  // The rotation is the security response to a privilege change — if it can't
  // land, the request must NOT proceed with stale privileges.
  txRowMissing = true;
  const lostRow = await mint({ role: "USER", permissions: "0", dbPermissions: 8n });
  assert.equal(
    await verifyAndRefreshSession(lostRow.token),
    null,
    "the row vanishing inside the tx must reject the request",
  );

  txRowMissing = false;
  txThrows = true;
  const txFail = await mint({ role: "USER", permissions: "0", dbPermissions: 8n });
  assert.equal(
    await verifyAndRefreshSession(txFail.token),
    null,
    "a thrown transaction must be swallowed into a rejection, not a stale session",
  );
});

// ── mediaServer refresh + the plex membership hook ──────────────────────────

test("credentials sessions refresh mediaServer from the DB in both directions", async () => {
  // Claim says "plex", the DB link was removed → the claim must be cleared.
  const cleared = await mint({ mediaServer: "plex", dbMediaServer: null });
  const clearedResult = await verifyAndRefreshSession(cleared.token);
  assert.ok(clearedResult?.refreshed);
  assert.equal(clearedResult.claims.mediaServer, null);
  assert.equal(decodePayload(clearedResult.refreshed.token).mediaServer, null);

  // No claim, the DB gained a link → the claim must pick it up.
  const gained = await mint({ dbMediaServer: "jellyfin" });
  const gainedResult = await verifyAndRefreshSession(gained.token);
  assert.ok(gainedResult);
  assert.equal(gainedResult.claims.mediaServer, "jellyfin");
});

test("jellyfin-provider sessions keep the mediaServer pinned at sign-in, ignoring the DB", async () => {
  // plex / jellyfin / jellyfin-quickconnect providers pin mediaServer at
  // sign-in; only credentials/oidc tokens track the DB column.
  const { token } = await mint({
    provider: "jellyfin",
    mediaServer: "jellyfin",
    dbMediaServer: "plex",
  });
  const result = await verifyAndRefreshSession(token);
  assert.ok(result);
  assert.equal(result.claims.mediaServer, "jellyfin");
});

test("a plex-provider session fails OPEN when membership can't be determined (unconfigured plex settings)", async () => {
  // getCachedPlexAllowlist returns null with nothing configured ("no
  // opinion"); the caller must NOT lock the user out — an unreachable or
  // unconfigured plex.tv must never mass-revoke sessions. The throwing fetch
  // stub proves no network is attempted on this path.
  const { userId, token } = await mint({
    provider: "plex",
    role: "USER",
    mediaServer: "plex",
    dbMediaServer: "plex",
  });
  const result = await verifyAndRefreshSession(token);
  assert.ok(result, "an indeterminate allowlist must fail open");
  assert.equal(result.claims.id, userId);
  assert.ok(settingReads > 0, "the membership hook must actually have been consulted");
});

// ── multi-instance membership, through the REAL plex-membership module ──────
// These run AFTER the fail-open test above, whose attempt left the DEFAULT
// instance's slug state cold + unconfigured — so the default is skipped here
// whether or not its 5-min retry backoff has lapsed (its connection keys are
// never seeded). Each test registers its own named instance: the registry is
// re-read per call and a fresh slug starts cold, which is what lets one
// order-dependent module cache serve two different fixtures.

const AWAY_URL = "http://203.0.113.50:32400"; // IP literals: no DNS hop for /identity
const ROAM_URL = "http://203.0.113.60:32400";

// Minimal scripted fetch for one Plex server: its /identity hop plus the
// plex.tv/api/users XML listing `friendEmails` as shared on `machine` (the
// same two hops getPlexFriendEmails really makes — see plex-membership.test).
function plexFixtureFetch(serverUrl: string, machine: string, friendEmails: string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith(`${serverUrl}/identity`)) {
      return new Response(JSON.stringify({ MediaContainer: { machineIdentifier: machine } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.startsWith("https://plex.tv/api/users")) {
      const blocks = friendEmails
        .map(
          (email, i) =>
            `<User id="${i + 1}" title="u${i + 1}" email="${email}">` +
            `<Server id="${i + 1}" machineIdentifier="${machine}"/></User>`,
        )
        .join("");
      return new Response(
        `<?xml version="1.0"?><MediaContainer size="${friendEmails.length}">${blocks}</MediaContainer>`,
        { status: 200, headers: { "content-type": "application/xml" } },
      );
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;
}

test("membership TEETH: a plex USER shared on NO instance is revoked on the slow path (all devices)", async (t) => {
  const throwingFetch = globalThis.fetch;
  membershipSettings = {
    plexInstances: JSON.stringify([{ slug: "away", name: "Away" }]),
    plexAwayServerUrl: AWAY_URL,
    plexAwayAdminToken: "away-admin-token",
  };
  // The "away" instance shares with other@example.com only — never with the
  // minted user's u@example.com.
  globalThis.fetch = plexFixtureFetch(AWAY_URL, "machine-away", ["other@example.com"]);
  t.after(() => {
    globalThis.fetch = throwingFetch;
    membershipSettings = {};
  });

  const { userId, token } = await mint({ provider: "plex", role: "USER" });
  assert.equal(
    await verifyAndRefreshSession(token),
    null,
    "an email absent from every instance's set must be rejected",
  );
  // The revoke firing also proves the allowlist was a real set (a poisoned /
  // unconfigured null would have failed open instead).
  assert.ok(
    usersById.get(userId)?.sessionsRevokedAt instanceof Date,
    "the recheck must revoke ALL the user's sessions by advancing sessionsRevokedAt",
  );
});

test("ACCEPTED TRADE-OFF: membership on ANY instance keeps a plex session — even when the sign-in-era server dropped the user", async (t) => {
  // The allowlist is a UNION and a session doesn't record which server it was
  // signed in against. Stand-ins: "away" (the sign-in-era server) still holds
  // its TTL-fresh cached set from the test above, WITHOUT u@example.com; the
  // new "roam" instance shares with u. Union ∋ u ⇒ the session survives. If
  // the union ever narrowed to the sign-in-era instance (or dropped a sibling
  // instance's contribution), this user would be mass-revoked here.
  const throwingFetch = globalThis.fetch;
  membershipSettings = {
    plexInstances: JSON.stringify([
      { slug: "away", name: "Away" },
      { slug: "roam", name: "Roam" },
    ]),
    plexAwayServerUrl: AWAY_URL,
    plexAwayAdminToken: "away-admin-token",
    plexRoamServerUrl: ROAM_URL,
    plexRoamAdminToken: "roam-admin-token",
  };
  // Only roam's hops are scripted: away is inside its 30-min TTL and must not
  // refetch (an attempted away fetch would throw → poison → a vacuous
  // fail-open pass, which the no-warn assertion below rules out).
  globalThis.fetch = plexFixtureFetch(ROAM_URL, "machine-roam", ["u@example.com", "other@example.com"]);
  t.after(() => {
    globalThis.fetch = throwingFetch;
    membershipSettings = {};
  });

  const warnsBefore = warns.length;
  const { userId, token } = await mint({ provider: "plex", role: "USER" });
  const result = await verifyAndRefreshSession(token);
  assert.ok(result, "membership on a sibling instance must keep the session alive");
  assert.equal(result.claims.id, userId);
  assert.equal(
    usersById.get(userId)?.sessionsRevokedAt,
    null,
    "no revocation may be written when any instance still shares with the user",
  );
  assert.equal(
    warns.slice(warnsBefore).filter((w) => w.includes("[plex-membership]")).length,
    0,
    "no instance fetch may have failed — the survival must come from the union, not a poisoned fail-open",
  );
});
