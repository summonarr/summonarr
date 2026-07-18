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
//     replica; the ADMIN 7d ceiling enforced even on the fast path;
//   - the SLIDING-WINDOW decision: a slow-path verify ALWAYS re-signs (the
//     refreshed token carries dbCheckedAt and rides the fast path next time);
//     a long-TTL (rememberMe/mobile) non-admin token slides down to exactly
//     3600s; a token inside its final hour is NOT extended; the slide is
//     capped at the sign-in `expiresAt` deadline; a non-admin past that
//     deadline is rejected outright; ADMIN skips the slide entirely (and —
//     pinned as CURRENT behavior — ignores `expiresAt`, being governed by the
//     7d iat ceiling instead, enforced here on the slow path too);
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
//     log out; the allowlist's own semantics live in plex-membership.test).
//
// No DB or network: the model delegates are shadowed in-memory (tests/
// _helpers.mts), fetch throws, and every JWT is a REAL jose token. Cutoff and
// window boundaries are asserted with ±2s clock-drift margins where "now" is
// re-read inside the function; exact-boundary cases use values this file
// fixes on both sides (iat vs a Date it also chooses), which are drift-free.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto
process.env.NEXTAUTH_SECRET = "session-refresh-slide-test-secret-0123456789";

// No network, ever: the plex fail-open test must fail open WITHOUT plex.tv.
globalThis.fetch = (() => {
  throw new Error("unexpected network call from session-refresh tests");
}) as unknown as typeof fetch;

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
      ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId }
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

// getCachedPlexAllowlist reads plexAdminToken/plexAdminEmail/plexServerUrl.
// Always unconfigured here → the allowlist answers "no opinion" (fail open).
shadowPrismaModel(prisma, "setting", {
  findUnique: async () => {
    settingReads++;
    return null;
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
      sessionRows.delete(args.where.sessionId);
      sessionRows.add(args.data.sessionId);
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

test("the ADMIN 7d hard ceiling is enforced even on the fast path, with zero DB reads", async () => {
  const now0 = nowSec();
  const { token } = await mint({
    role: "ADMIN",
    iat: now0 - (SEVEN_DAYS + 120),
    expiresInSeconds: 8 * DAY, // exp still ~a day in the future — JWT verifies
    dbCheckedAt: now0 - 5, // inside the admin fast window
  });
  throwOnDb = true; // the ceiling must not need the DB
  assert.equal(await verifyAndRefreshSession(token), null);
  assert.equal(dbReads, 0);
});

// ── the sliding window (slow path) ──────────────────────────────────────────

test("a long-TTL (rememberMe/mobile) non-admin token slides down to exactly the 3600s inactivity window", async () => {
  const now0 = nowSec();
  const { token } = await mint({
    expiresInSeconds: 30 * DAY,
    expiresAt: now0 + 30 * DAY,
  });
  const result = await verifyAndRefreshSession(token);
  assert.ok(result?.refreshed);
  // newExp = min(now + 3600, deadline) with the deadline far out ⇒ exactly
  // 3600 regardless of sub-second drift (both terms share the function's now).
  assert.equal(result.refreshed.expiresInSeconds, 3600);
});

test("a non-admin token inside its final hour is NOT slid forward — remaining life is preserved", async () => {
  const now0 = nowSec();
  const { token } = await mint({
    expiresInSeconds: 1800, // already below the 3600s window
    expiresAt: now0 + DAY, // deadline is not the limiting factor
  });
  const result = await verifyAndRefreshSession(token);
  assert.ok(result?.refreshed);
  assert.ok(
    result.refreshed.expiresInSeconds <= 1800 && result.refreshed.expiresInSeconds >= 1700,
    `the re-sign must keep the remaining ~1800s, got ${result.refreshed.expiresInSeconds}`,
  );
});

test("the slide never extends past the sign-in session deadline (expiresAt cap)", async () => {
  const now0 = nowSec();
  const { token } = await mint({
    expiresInSeconds: DAY, // exp alone would allow a full 3600s slide
    expiresAt: now0 + 600, // …but the device session deadline is 10 min away
  });
  const result = await verifyAndRefreshSession(token);
  assert.ok(result?.refreshed);
  assert.ok(
    result.refreshed.expiresInSeconds <= 600 && result.refreshed.expiresInSeconds >= 500,
    `the slide must cap at the ~600s deadline, got ${result.refreshed.expiresInSeconds}`,
  );
});

test("a non-admin session past its expiresAt deadline is rejected even though the JWT exp is still valid", async () => {
  const now0 = nowSec();
  const { token } = await mint({
    expiresInSeconds: 7_200, // exp two hours out — signature/exp verify fine
    expiresAt: now0 - 10, // …but the sign-in deadline already passed
  });
  assert.equal(await verifyAndRefreshSession(token), null);
});

test("ADMIN skips the inactivity slide and — pinned CURRENT behavior — ignores the expiresAt deadline", async () => {
  // Admin lifetime is governed by the 7d iat ceiling, not the sliding window:
  // the deadline/slide block is inside the `role !== "ADMIN"` branch. An
  // admin token with a lapsed expiresAt therefore still verifies, and its
  // re-sign keeps the full remaining exp instead of shrinking to 3600.
  const now0 = nowSec();
  const { token } = await mint({
    role: "ADMIN",
    expiresInSeconds: 7_200,
    expiresAt: now0 - 100,
  });
  const result = await verifyAndRefreshSession(token);
  assert.ok(result, "an ADMIN token is not subject to the expiresAt deadline");
  assert.ok(result.refreshed);
  assert.ok(
    result.refreshed.expiresInSeconds > 3600,
    `ADMIN must keep ~7200s, not slide to 3600 — got ${result.refreshed.expiresInSeconds}`,
  );
});

test("the ADMIN 7d hard ceiling rejects on the slow path even with a future exp and live session row", async () => {
  const now0 = nowSec();
  const { token } = await mint({
    role: "ADMIN",
    iat: now0 - (SEVEN_DAYS + 120),
    expiresInSeconds: 8 * DAY,
    expiresAt: now0 + DAY,
  });
  assert.equal(await verifyAndRefreshSession(token), null);
  assert.ok(dbReads >= 2, "the slow-path ceiling fires after the DB reconciliation");
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
