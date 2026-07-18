// Route-level unit tests for the self-service profile API — the surface a
// signed-in user has over their OWN account:
//   PATCH  /api/profile/password            — change the local password
//   GET    /api/profile/notifications       — read notification preferences
//   PATCH  /api/profile/notifications       — update notification preferences
//   POST   /api/profile/notification-email  — begin verifying a notify email
//   DELETE /api/profile                     — self-delete (anonymize + disable)
//
// NOTE on scope: /api/profile itself exports ONLY DELETE — there is no GET/PATCH
// profile handler anywhere in the tree (the "profile GET/PATCH" the task brief
// anticipated does not exist), so the fourth route pinned here is the DELETE
// self-delete, which carries its OWN password step-up (the iOS deletion
// regression from project memory). A couple of the routes' defensive branches
// are deliberately NOT tested because a live authenticated session can never
// reach them — session-refresh.ts requires a NON-deactivated user row to
// authenticate at all (`if (!dbUser) return null` / `if (dbUser.deactivatedAt)
// return null`), so DELETE's "already deactivated => ok" idempotent branch and
// notifications' "user row missing => 404" branch both fail auth (401) first.
//
// ── The headline security pins ──────────────────────────────────────────────
//   1. STEP-UP (password + delete): a destructive/credential-changing op REQUIRES
//      the caller to re-supply their current password. The route verifies
//      `verifyPassword(currentPassword ?? "", hash)`, so a WRONG, ABSENT, or
//      NON-STRING current password is rejected with NO write — the exact
//      unmatched-step-up failure a prior iOS build shipped. Pinned hard, both
//      ways (rejection + the correct-password success path).
//   2. SESSION INVALIDATION (password change): on success the route stamps
//      `passwordChangedAt = sessionsRevokedAt = now` AND deletes every AuthSession
//      row AND marks the user force-revalidate. Those two cutoffs are exactly
//      what session-refresh.ts (revokedSec / passwordSec) treats as revoking any
//      still-valid JWT minted before the change — so a password change logs out
//      every other device. We pin the writes + the force-revalidate mark; the
//      cutoff SEMANTICS are owned by tests/session-refresh*.test.mts.
//   3. SSO carve-out: an account with no local passwordHash (Plex/Jellyfin/OIDC)
//      cannot SET a shadow local password (403) — but CAN self-delete without a
//      password (the session itself is the proof).
//   4. Guardrail 30: every JSON body goes through readJsonCapped/readJsonCappedOr
//      — an oversized body is 413'd, never parsed.
//
// Division of labour — this file pins the ROUTES' wiring/gating of shared
// primitives; the primitives' internals are OWNED elsewhere and not re-proven:
//   - tests/password-hash.test.mts       → hashPassword/verifyPassword crypto
//   - tests/session-revocation.test.mts  → the force-revalidate ledger itself
//   - tests/session-refresh*.test.mts    → the passwordChangedAt/sessionsRevokedAt
//                                           cutoff + deactivatedAt auth rejection
//   - tests/notification-email-verify.test.mts → the verify token/identifier crypto
//   - tests/notification-email.test.mts  → resolveUserNotificationEmail precedence
//   - tests/body-size.test.mts           → the readJsonCapped 413/400 boundaries
//   - tests/api-auth.test.mts            → the withAuth 401/403 wrapper semantics
//
// Harness: withAuth-wrapped handlers invoked as real route functions over a
// NextRequest carrying a REAL signed session JWT, against in-memory
// authSession/user prisma stubs (tests/api-auth.test.mts idiom). maintenanceGuard's
// authActive() reads cookies() from a synthetic work/request async-storage scope
// (tests/requests-route.test.mts idiom) — that scope has NO session cookie, so the
// guard falls through to the (unconfigured ⇒ off) maintenance Settings and passes.
// $transaction is a recording stub (array form for the password tx, callback form
// for the delete anonymize tx). dns.lookup is stubbed and globalThis.fetch is a
// recording thrower — the ONLY test that expects a fetch is the notification-email
// happy path, where the scripted Resend 200 IS the send. The current-password
// fixture is scrypt-hashed ONCE at module scope and reused (scrypt is slow).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import dns from "node:dns/promises";

// Next's async-local-storage shim captures globalThis.AsyncLocalStorage at module
// load — assign it BEFORE anything pulls in next/*.
(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto
process.env.NEXTAUTH_SECRET = "profile-routes-test-secret-0123456789abcdef"; // session JWT
process.env.AUTH_URL = "http://localhost:3000"; // insecure ctx → unprefixed cookie name; also the notif-email base URL fallback
process.env.TRUST_PROXY = "true"; // silence rate-limit's module-load warning
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

// ── DNS stub — safe-fetch (Resend send path) resolves api.resend.com before
// fetching; no real lookup may leave the process.
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

// ── recording fetch: every wire attempt is logged; default throws ───────────
const fetchCalls: URL[] = [];
let fetchImpl: (url: URL) => Response | Promise<Response> = () => {
  throw new Error("unexpected fetch — this test's flow must be satisfied from stubs");
};
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  fetchCalls.push(url);
  return fetchImpl(url);
}) as typeof fetch;

type RunStore = { run<T>(store: unknown, fn: () => T): T };
const cjsRequire = createRequire(import.meta.url);
const { workAsyncStorage } = cjsRequire("next/dist/server/app-render/work-async-storage.external.js") as { workAsyncStorage: RunStore };
const { workUnitAsyncStorage } = cjsRequire("next/dist/server/app-render/work-unit-async-storage.external.js") as { workUnitAsyncStorage: RunStore };
const { RequestCookies } = cjsRequire("next/dist/server/web/spec-extension/cookies.js") as { RequestCookies: new (h: Headers) => unknown };
const { RequestCookiesAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/request-cookies.js") as { RequestCookiesAdapter: { seal(c: unknown): unknown } };
const { HeadersAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/headers.js") as { HeadersAdapter: { seal(h: Headers): unknown } };

// Dynamic imports so the env/global stubs above genuinely precede the module-graph
// load (static imports would hoist above them).
const { NextRequest } = await import("next/server");
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");
const { hashPassword, verifyPassword } = await import("../src/lib/password-hash.ts");
const { normalizeEmail } = await import("../src/lib/email-normalize.ts");
const { shouldForceDbCheck } = await import("../src/lib/session-revocation.ts");
const { invalidateFeatureFlagCache } = await import("../src/lib/features.ts");
const {
  buildVerifyIdentifier,
  verifyIdentifierPrefixFor,
  VERIFY_TTL_MS,
} = await import("../src/lib/notification-email-verify.ts");

// ── recording op log (writes only — reads are noise) ────────────────────────
type Op = { op: string; args?: unknown };
const ops: Op[] = [];
let txCalls = 0;
const rec = (op: string, args?: unknown) => { ops.push({ op, args }); };
function opsOf(name: string): Op[] {
  return ops.filter((o) => o.op === name);
}

// ── in-memory user table (session-refresh's select shape + every field the
// four routes read; the findUnique stub HONORS `select` so a route that omits
// passwordHash never sees it — this is what lets the GET no-leakage pin hold).
type DbUser = {
  role: string;
  permissions: bigint;
  mediaServer: string | null;
  sessionsRevokedAt: Date | null;
  passwordChangedAt: Date | null;
  deactivatedAt: Date | null;
  email: string | null;
  name: string | null;
  passwordHash: string | null;
  notificationEmail: string | null;
  jellyfinUserId: string | null;
  notifyOnApproved: boolean;
  notifyOnAvailable: boolean;
  notifyOnDeclined: boolean;
  emailOnApproved: boolean;
  emailOnAvailable: boolean;
  emailOnDeclined: boolean;
  pushOnApproved: boolean;
  pushOnAvailable: boolean;
  pushOnDeclined: boolean;
  notifyOnIssue: boolean;
};
const usersById = new Map<string, DbUser>();
const sessionRows = new Set<string>();

function project(row: DbUser, select?: Record<string, unknown>): Record<string, unknown> {
  if (!select) return { ...row };
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(select)) {
    if (select[k]) out[k] = (row as Record<string, unknown>)[k];
  }
  return out;
}

const userModel = {
  findUnique: async (args: { where: { id: string }; select?: Record<string, unknown> }) => {
    const u = usersById.get(args.where.id);
    return u ? project(u, args.select) : null;
  },
  update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
    rec("user.update", args);
    return {};
  },
  updateMany: async (args: unknown) => {
    rec("user.updateMany", args);
    return { count: 1 };
  },
};
shadowPrismaModel(prisma, "user", userModel);

const authSessionModel = {
  findUnique: async (args: { where: { sessionId: string } }) =>
    sessionRows.has(args.where.sessionId)
      ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId }
      : null,
  update: async () => ({}), // lastSeenAt fire-and-forget touch — no-op, unrecorded
  deleteMany: async (args: unknown) => {
    rec("authSession.deleteMany", args);
    return { count: 1 };
  },
};
shadowPrismaModel(prisma, "authSession", authSessionModel);

// Settings drive maintenanceGuard (maintenance keys), isNotificationEmailEnabled
// (EMAIL_KEYS), and the feature-flag read. Map-based like requests-route.test.mts.
const settings = new Map<string, string>();
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
  findMany: async (args: { where: { key: { in: string[] } } }) =>
    args.where.key.in
      .filter((k) => settings.has(k))
      .map((k) => ({ key: k, value: settings.get(k) })),
});

// logAudit is void-fired (guardrail 26) — a no-op create keeps its floated
// promise from touching a real DB.
shadowPrismaModel(prisma, "auditLog", { create: async () => ({}) });

// notification-email verification-token writes.
const verificationTokenModel = {
  deleteMany: async (args: unknown) => {
    rec("verificationToken.deleteMany", args);
    return { count: 0 };
  },
  create: async (args: { data: Record<string, unknown> }) => {
    rec("verificationToken.create", args);
    return args.data;
  },
};
shadowPrismaModel(prisma, "verificationToken", verificationTokenModel);

// Models the delete-anonymize tx touches (guardrail 28: MediaServerUser is
// updateMany userId:null, never deleted). Recorded no-ops.
const accountModel = { deleteMany: async (a: unknown) => { rec("account.deleteMany", a); return { count: 0 }; } };
const pushSubscriptionModel = { deleteMany: async (a: unknown) => { rec("pushSubscription.deleteMany", a); return { count: 0 }; } };
const discordLinkTokenModel = { deleteMany: async (a: unknown) => { rec("discordLinkToken.deleteMany", a); return { count: 0 }; } };
const discordMergeCodeModel = { deleteMany: async (a: unknown) => { rec("discordMergeCode.deleteMany", a); return { count: 0 }; } };
const mediaServerUserModel = { updateMany: async (a: unknown) => { rec("mediaServerUser.updateMany", a); return { count: 0 }; } };
shadowPrismaModel(prisma, "account", accountModel);
shadowPrismaModel(prisma, "pushSubscription", pushSubscriptionModel);
shadowPrismaModel(prisma, "discordLinkToken", discordLinkTokenModel);
shadowPrismaModel(prisma, "discordMergeCode", discordMergeCodeModel);
shadowPrismaModel(prisma, "mediaServerUser", mediaServerUserModel);

// $transaction: ARRAY form (the password update+deleteMany) → Promise.all; CALLBACK
// form (the delete anonymize) → run against a tx client carrying every anonymize
// model + no-op raw executors (the ADMIN last-admin path is never exercised here
// — every delete test uses a USER-role target).
const txObj = {
  user: userModel,
  authSession: authSessionModel,
  account: accountModel,
  pushSubscription: pushSubscriptionModel,
  discordLinkToken: discordLinkTokenModel,
  discordMergeCode: discordMergeCodeModel,
  mediaServerUser: mediaServerUserModel,
  $executeRawUnsafe: async () => 0,
  $executeRaw: async () => 1,
};
shadowPrismaClientMethod(prisma, "$transaction", async (arg: unknown) => {
  txCalls++;
  if (Array.isArray(arg)) return Promise.all(arg);
  return (arg as (tx: typeof txObj) => Promise<unknown>)(txObj);
});

// ── the shared current-password fixture: scrypt ONCE, reused everywhere ──────
const CURRENT_PW = "current-password-abc123";
const CURRENT_PW_HASH = await hashPassword(CURRENT_PW);
const NEW_PW = "brand-new-password-xyz789"; // ≥12, ≠ current so the re-hash differs

// ── session mint (api-auth.test.mts idiom): real signed JWT + backing rows ───
let seq = 0;
async function mintSession(opts: {
  role?: string;
  provider?: string;
  passwordHash?: string | null;
  notificationEmail?: string | null;
  jellyfinUserId?: string | null;
} = {}): Promise<{ userId: string; sessionId: string; token: string }> {
  seq++;
  const userId = `user-${seq}`;
  const sessionId = `sess-${seq}`;
  usersById.set(userId, {
    role: opts.role ?? "USER",
    permissions: 0n, // unseeded ⇒ USER preset; claim mirrors ⇒ no rotation
    mediaServer: null,
    sessionsRevokedAt: null,
    passwordChangedAt: null,
    deactivatedAt: null,
    email: `user-${seq}@example.com`,
    name: `User ${seq}`,
    passwordHash: opts.passwordHash === undefined ? CURRENT_PW_HASH : opts.passwordHash,
    notificationEmail: opts.notificationEmail ?? null,
    jellyfinUserId: opts.jellyfinUserId ?? null,
    notifyOnApproved: true,
    notifyOnAvailable: false,
    notifyOnDeclined: true,
    emailOnApproved: false,
    emailOnAvailable: true,
    emailOnDeclined: false,
    pushOnApproved: true,
    pushOnAvailable: false,
    pushOnDeclined: true,
    notifyOnIssue: true,
  });
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000);
  const token = await signSessionJwt(
    {
      id: userId,
      role: opts.role ?? "USER",
      permissions: "0",
      provider: opts.provider ?? "credentials",
      sessionId,
      expiresAt: iat + 86_400,
    },
    { expiresInSeconds: 7_200, iat },
  );
  return { userId, sessionId, token };
}

const COOKIE = getSessionCookieName();

// ── synthetic request scope (maintenanceGuard → authActive → cookies()) ──────
// The scope's cookies are EMPTY, so authActive() finds no session and the guard
// falls through to the (off) maintenance settings. All calls run inside it for
// uniformity even though only password/delete need it.
function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = { route: "/profile-routes.test", forceStatic: false, dynamicShouldError: false };
  const reqHeaders = new Headers();
  const requestStore = {
    type: "request",
    phase: "render",
    headers: HeadersAdapter.seal(reqHeaders),
    cookies: RequestCookiesAdapter.seal(new RequestCookies(reqHeaders)),
    usedDynamic: false,
  };
  return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, fn));
}

function makeReq(
  path: string,
  init: { method: string; token?: string | null; body?: string },
): InstanceType<typeof NextRequest> {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: init.method,
    headers: {
      ...(init.token ? { cookie: `${COOKIE}=${init.token}` } : {}),
      "content-type": "application/json",
    },
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
}

// bodyOr: JSON.stringify a value, pass a raw string through, or omit entirely.
function bodyOr(value: unknown, raw?: string): string | undefined {
  if (raw !== undefined) return raw;
  if (value === undefined) return undefined;
  return JSON.stringify(value);
}

// Routes under test (imported AFTER every stub is in place).
const { PATCH: passwordPATCH } = await import("../src/app/api/profile/password/route.ts");
const { GET: notificationsGET, PATCH: notificationsPATCH } = await import("../src/app/api/profile/notifications/route.ts");
const { POST: notifEmailPOST } = await import("../src/app/api/profile/notification-email/route.ts");
const { DELETE: profileDELETE } = await import("../src/app/api/profile/route.ts");

async function changePassword(token: string | null, body: unknown, raw?: string): Promise<Response> {
  const req = makeReq("/api/profile/password", { method: "PATCH", token, body: bodyOr(body, raw) });
  return inScope(() => passwordPATCH(req, undefined));
}
async function getNotifications(token: string | null): Promise<Response> {
  const req = makeReq("/api/profile/notifications", { method: "GET", token });
  return inScope(() => notificationsGET(req, undefined));
}
async function patchNotifications(token: string | null, body: unknown, raw?: string): Promise<Response> {
  const req = makeReq("/api/profile/notifications", { method: "PATCH", token, body: bodyOr(body, raw) });
  return inScope(() => notificationsPATCH(req, undefined));
}
async function postNotifEmail(token: string | null, body: unknown, raw?: string): Promise<Response> {
  const req = makeReq("/api/profile/notification-email", { method: "POST", token, body: bodyOr(body, raw) });
  return inScope(() => notifEmailPOST(req, undefined));
}
async function deleteProfile(token: string | null, body?: unknown, raw?: string): Promise<Response> {
  const req = makeReq("/api/profile", { method: "DELETE", token, body: bodyOr(body, raw) });
  return inScope(() => profileDELETE(req, undefined));
}

function passwordUpdateData(): Record<string, unknown> {
  return (opsOf("user.update")[0].args as { data: Record<string, unknown> }).data;
}

beforeEach(() => {
  ops.length = 0;
  txCalls = 0;
  fetchCalls.length = 0;
  warns.length = 0;
  errors.length = 0;
  settings.clear();
  usersById.clear();
  sessionRows.clear();
  invalidateFeatureFlagCache();
  fetchImpl = () => { throw new Error("unexpected fetch — this test's flow must be satisfied from stubs"); };
});

// ═══ PATCH /api/profile/password ════════════════════════════════════════════

test("password step-up is MANDATORY: a wrong, absent, or non-string current password is rejected with NO write", async () => {
  // The headline pin. All three shapes must fail closed — the iOS regression was
  // an unmatched step-up where an ABSENT current password slipped through.
  const wrong = await mintSession();
  const wrongRes = await changePassword(wrong.token, { currentPassword: "not-the-password", newPassword: NEW_PW });
  assert.equal(wrongRes.status, 400);
  assert.deepEqual(await wrongRes.json(), { error: "Invalid password" });

  const absent = await mintSession();
  // No currentPassword key at all → verifyPassword("" , hash) → false.
  const absentRes = await changePassword(absent.token, { newPassword: NEW_PW });
  assert.equal(absentRes.status, 400);
  assert.deepEqual(await absentRes.json(), { error: "Invalid password" });

  const wrongType = await mintSession();
  const typeRes = await changePassword(wrongType.token, { currentPassword: 12345, newPassword: NEW_PW });
  assert.equal(typeRes.status, 400);
  assert.deepEqual(await typeRes.json(), { error: "Invalid request" });

  // Not one of the three touched the DB write path.
  assert.equal(opsOf("user.update").length, 0, "a failed step-up must never write the new hash");
  assert.equal(opsOf("authSession.deleteMany").length, 0, "a failed step-up must never revoke sessions");
  assert.equal(txCalls, 0, "a failed step-up must never open the write transaction");
});

test("password change with the CORRECT current password re-hashes, stamps the invalidation cutoffs, revokes every session, and force-revalidates the user", async () => {
  // The session-invalidation contract: passwordChangedAt = sessionsRevokedAt = now
  // (the session-refresh cutoffs), the AuthSession rows deleted, and the in-memory
  // force-revalidate mark set — together these log out every OTHER device.
  const { userId, token } = await mintSession();
  const before = Date.now();
  const res = await changePassword(token, { currentPassword: CURRENT_PW, newPassword: NEW_PW });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, requiresRelogin: true });

  const data = passwordUpdateData();
  assert.ok(typeof data.passwordHash === "string" && data.passwordHash !== CURRENT_PW_HASH, "a fresh hash must be written");
  assert.equal(await verifyPassword(NEW_PW, data.passwordHash as string), true, "the stored hash must verify the NEW password");
  assert.equal(await verifyPassword(CURRENT_PW, data.passwordHash as string), false, "the old password must no longer verify");

  const changedAt = data.passwordChangedAt as Date;
  const revokedAt = data.sessionsRevokedAt as Date;
  assert.ok(changedAt instanceof Date && revokedAt instanceof Date, "both invalidation cutoffs must be stamped");
  assert.ok(changedAt.getTime() >= before && changedAt.getTime() <= Date.now(), "passwordChangedAt must be ~now");
  assert.equal(changedAt.getTime(), revokedAt.getTime(), "both cutoffs are stamped from the same instant");

  // Every device session removed, and the caller marked force-revalidate so the
  // dbCheckedAt fast-path window closes immediately on the issuing replica.
  const del = opsOf("authSession.deleteMany")[0].args as { where: { userId: string } };
  assert.equal(del.where.userId, userId, "all of the user's AuthSession rows are deleted");
  assert.equal(shouldForceDbCheck(userId, "any-session"), true, "invalidateUserSession must mark the user force-revalidate");
});

test("new-password validation rejects a missing, too-short, or too-long password before any DB read", async () => {
  const { token } = await mintSession();

  const missing = await changePassword(token, { currentPassword: CURRENT_PW });
  assert.equal(missing.status, 400);
  assert.deepEqual(await missing.json(), { error: "New password is required" });

  const shortPw = await mintSession();
  const short = await changePassword(shortPw.token, { currentPassword: CURRENT_PW, newPassword: "short" });
  assert.equal(short.status, 400);
  assert.deepEqual(await short.json(), { error: "New password must be at least 12 characters" });

  const longPw = await mintSession();
  const long = await changePassword(longPw.token, { currentPassword: CURRENT_PW, newPassword: "x".repeat(1025) });
  assert.equal(long.status, 400);
  assert.deepEqual(await long.json(), { error: "New password must be at most 1024 characters" });

  // These guards precede the passwordHash read, so the step-up never even runs.
  assert.equal(opsOf("user.update").length, 0);
  assert.equal(txCalls, 0);
});

test("an SSO account (no local passwordHash) cannot set a shadow local password — 403, no write", async () => {
  // Allowing this would create a local credential that bypasses the IdP entirely.
  const { token } = await mintSession({ provider: "jellyfin", passwordHash: null });
  const res = await changePassword(token, { currentPassword: "anything", newPassword: NEW_PW });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), {
    error: "Local passwords are not available for SSO accounts. Sign in with your provider.",
  });
  assert.equal(opsOf("user.update").length, 0);
  assert.equal(txCalls, 0);
});

test("password route caps the request body (guardrail 30): an oversized body is 413'd, never parsed", async () => {
  const { token } = await mintSession();
  const huge = JSON.stringify({ currentPassword: CURRENT_PW, newPassword: "x".repeat(20_000) });
  const res = await changePassword(token, undefined, huge);
  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), { error: "Request body too large (max 16KB)" });
  assert.equal(opsOf("user.update").length, 0);
});

test("password route rate-limits repeated attempts per user (6th within the window → 429)", async () => {
  const { token } = await mintSession();
  // The first five calls consume the 5/15min bucket (each fails fast at body
  // validation); the sixth is refused before any work.
  for (let i = 0; i < 5; i++) {
    const r = await changePassword(token, {});
    assert.equal(r.status, 400, "each in-budget attempt reaches ordinary validation");
  }
  const sixth = await changePassword(token, { currentPassword: CURRENT_PW, newPassword: NEW_PW });
  assert.equal(sixth.status, 429);
  assert.deepEqual(await sixth.json(), {
    error: "Too many attempts — please wait 15 minutes before trying again.",
  });
  assert.equal(opsOf("user.update").length, 0, "the throttled attempt never reaches the write");
});

// ═══ GET / PATCH /api/profile/notifications ═════════════════════════════════

test("GET notifications returns exactly the preference columns + emailEnabled — no passwordHash or login email leaks", async () => {
  const { token } = await mintSession(); // mint seeds a distinct value per pref
  const res = await getNotifications(token);
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(body, {
    notifyOnApproved: true, notifyOnAvailable: false, notifyOnDeclined: true,
    emailOnApproved: false, emailOnAvailable: true, emailOnDeclined: false,
    pushOnApproved: true, pushOnAvailable: false, pushOnDeclined: true,
    notifyOnIssue: true, notificationEmail: null,
    emailEnabled: false, // unconfigured transport ⇒ the channel can never send
  });
  assert.ok(!("passwordHash" in body), "the select must never surface the password hash");
  assert.ok(!("email" in body), "the login email is not part of the notification-prefs projection");
});

test("GET notifications' emailEnabled mirrors the send gate: true once a transport is configured", async () => {
  // The field exists so a native client can hide its email-preference section
  // when the channel can never send; it must track isNotificationEmailEnabled()
  // exactly (the =false case is pinned in the leakage test above).
  settings.set("enableUserEmails", "true");
  settings.set("emailBackend", "resend");
  settings.set("resendApiKey", "re_test_key");
  const { token } = await mintSession();
  const res = await getNotifications(token);
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.emailEnabled, true, "a configured transport must flip emailEnabled on");
  assert.equal(body.notifyOnApproved, true, "the preference columns still come through");
  assert.ok(!("passwordHash" in body));
});

test("PATCH notifications writes ONLY the boolean preference columns present; non-boolean and unknown keys are ignored", async () => {
  const { token } = await mintSession();
  const res = await patchNotifications(token, {
    notifyOnApproved: false,
    emailOnAvailable: true,
    pushOnDeclined: false,
    notifyOnIssue: true,
    notifyOnDeclined: "yes",       // non-boolean → ignored
    emailOnApproved: 1,            // non-boolean → ignored
    somethingElse: true,          // unknown column → ignored
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  const data = (opsOf("user.update")[0].args as { data: Record<string, unknown> }).data;
  assert.deepEqual(data, {
    notifyOnApproved: false,
    emailOnAvailable: true,
    pushOnDeclined: false,
    notifyOnIssue: true,
  });
});

test("PATCH notifications with no valid boolean fields writes nothing and 400s", async () => {
  const { token } = await mintSession();
  const res = await patchNotifications(token, { notifyOnApproved: "true", bogus: 1 });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "No valid fields provided" });
  assert.equal(opsOf("user.update").length, 0);
});

test("PATCH notifications refuses a notificationEmail from a non-Jellyfin sign-in (provider-owned) with 403, no write", async () => {
  const { token } = await mintSession({ provider: "credentials" });
  const res = await patchNotifications(token, { notificationEmail: "attacker@evil.example" });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "notificationEmail is read-only for this sign-in method" });
  assert.equal(opsOf("user.update").length, 0);
});

// ═══ POST /api/profile/notification-email ═══════════════════════════════════

test("notification-email verification is Jellyfin-only: a non-Jellyfin caller gets 403, no token stored, no send", async () => {
  const { token } = await mintSession({ provider: "credentials" });
  const res = await postNotifEmail(token, { email: "notify@example.com" });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "notificationEmail is read-only for this sign-in method" });
  assert.equal(opsOf("verificationToken.create").length, 0);
  assert.equal(fetchCalls.length, 0);
});

test("notification-email validates the address and requires a configured transport before storing anything", async () => {
  const bad = await mintSession({ provider: "jellyfin" });
  const invalid = await postNotifEmail(bad.token, { email: "not-an-email" });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "Invalid email address" });

  // Valid address, but no email transport configured (feature default-on but the
  // send master switch/backend are absent) → the enabled gate 400s before storing.
  const unconfigured = await mintSession({ provider: "jellyfin" });
  const res = await postNotifEmail(unconfigured.token, { email: "notify@example.com" });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "Email notifications aren't configured on this server." });

  assert.equal(opsOf("verificationToken.create").length, 0, "nothing is persisted until validation + config pass");
  assert.equal(fetchCalls.length, 0);
});

test("notification-email happy path stores a PENDING (unverified) hashed token and reaches the verification send", async () => {
  // Configure a Resend transport so isNotificationEmailEnabled() is true and the
  // send goes out. The address is bound only after the mailed link is confirmed —
  // here we pin the pending-token write + that the send was actually attempted.
  settings.set("enableUserEmails", "true");
  settings.set("emailBackend", "resend");
  settings.set("resendApiKey", "re_test_key");
  settings.set("resendFrom", "Summonarr <noreply@example.com>");
  fetchImpl = () => new Response(JSON.stringify({ id: "email_123" }), { status: 200 });

  const { userId, token } = await mintSession({ provider: "jellyfin" });
  const before = Date.now();
  const res = await postNotifEmail(token, { email: "Notify@Example.com" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, email: normalizeEmail("Notify@Example.com") });

  // Prior pending verifications for this user are cleared first (one active link).
  const del = opsOf("verificationToken.deleteMany")[0].args as { where: { identifier: { startsWith: string } } };
  assert.equal(del.where.identifier.startsWith, verifyIdentifierPrefixFor(userId));

  // The stored row binds THIS user + the normalized candidate, holds only a HASH
  // (never the raw token), and expires on the verify TTL — i.e. pending/unverified.
  const created = (opsOf("verificationToken.create")[0].args as { data: { identifier: string; token: string; expires: Date } }).data;
  assert.equal(created.identifier, buildVerifyIdentifier(userId, normalizeEmail("Notify@Example.com")));
  assert.match(created.token, /^[0-9a-f]{64}$/, "the persisted token is a sha256 hash, not the raw link token");
  const ttl = created.expires.getTime() - before;
  assert.ok(ttl > VERIFY_TTL_MS - 5_000 && ttl <= VERIFY_TTL_MS + 1_000, `expiry must ride the verify TTL (got ${ttl}ms)`);

  // The send was reached — exactly one call, to the Resend API host.
  assert.equal(fetchCalls.length, 1, "the verification email must be sent");
  assert.equal(fetchCalls[0].hostname, "api.resend.com");
  assert.deepEqual(errors, []);
});

test("notification-email: the pending token is persisted even when the send fails (502) — store precedes send", async () => {
  settings.set("enableUserEmails", "true");
  settings.set("emailBackend", "resend");
  settings.set("resendApiKey", "re_test_key");
  fetchImpl = () => { throw new Error("resend unreachable"); };

  const { userId, token } = await mintSession({ provider: "jellyfin" });
  const res = await postNotifEmail(token, { email: "notify@example.com" });
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "Couldn't send the verification email — contact the server owner." });

  // The deleteMany + create ran BEFORE the failing send.
  assert.equal(opsOf("verificationToken.create").length, 1);
  const created = (opsOf("verificationToken.create")[0].args as { data: { identifier: string } }).data;
  assert.equal(created.identifier, buildVerifyIdentifier(userId, "notify@example.com"));
  assert.ok(errors.some((e) => e.includes("[notif-email] verification send failed")), "the send failure is logged");
});

test("notification-email rate-limits verification sends (4th within the window → 429)", async () => {
  settings.set("enableUserEmails", "true");
  settings.set("emailBackend", "resend");
  settings.set("resendApiKey", "re_test_key");
  fetchImpl = () => new Response(JSON.stringify({ id: "ok" }), { status: 200 });

  const { token } = await mintSession({ provider: "jellyfin" });
  for (let i = 0; i < 3; i++) {
    const r = await postNotifEmail(token, { email: "notify@example.com" });
    assert.equal(r.status, 200, "the first three sends are within budget");
  }
  const fourth = await postNotifEmail(token, { email: "notify@example.com" });
  assert.equal(fourth.status, 429);
  assert.deepEqual(await fourth.json(), { error: "Too many verification emails — try again later." });
  assert.equal(fourth.headers.get("retry-after"), "900");
});

// ═══ DELETE /api/profile (self-delete) ══════════════════════════════════════

test("self-delete step-up is MANDATORY for a local account: a wrong or absent password is rejected with NO anonymization", async () => {
  // The delete counterpart of the password step-up — irreversible, so it demands
  // the current password too (the iOS regression touched this path).
  const wrong = await mintSession();
  const wrongRes = await deleteProfile(wrong.token, { password: "not-the-password" });
  assert.equal(wrongRes.status, 400);
  assert.deepEqual(await wrongRes.json(), { error: "Invalid password" });

  const absent = await mintSession();
  const absentRes = await deleteProfile(absent.token); // no body at all
  assert.equal(absentRes.status, 400);
  assert.deepEqual(await absentRes.json(), { error: "Password is required to delete your account" });

  assert.equal(txCalls, 0, "a failed step-up must never open the anonymization tx");
  assert.equal(opsOf("user.update").length, 0, "the account must not be anonymized");
  assert.equal(opsOf("account.deleteMany").length, 0, "no OAuth rows may be deleted on a failed step-up");
});

test("self-delete with the CORRECT password anonymizes + disables the row and force-revalidates the user", async () => {
  const { userId, token } = await mintSession();
  const before = Date.now();
  const res = await deleteProfile(token, { password: CURRENT_PW });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  assert.equal(txCalls, 1, "the anonymization runs inside one transaction");
  // PII scrubbed, credential cleared, account disabled + all JWTs cut off.
  const data = passwordUpdateData();
  assert.equal(data.name, "Deleted user");
  assert.equal(data.passwordHash, null);
  assert.equal(data.notificationEmail, null);
  assert.equal(data.plexUserId, null);
  assert.equal(data.jellyfinUserId, null);
  assert.equal(data.email, `deleted-${userId}@deleted.invalid`);
  assert.ok((data.deactivatedAt as Date) instanceof Date, "the row is marked deactivated");
  assert.ok((data.sessionsRevokedAt as Date).getTime() >= before, "every existing JWT is cut off");
  // OAuth rows + device sessions removed; play-history identity severed (not deleted).
  assert.equal(opsOf("account.deleteMany").length, 1);
  assert.equal(opsOf("authSession.deleteMany").length, 1);
  assert.deepEqual((opsOf("mediaServerUser.updateMany")[0].args as { data: unknown }).data, { userId: null });
  assert.equal(shouldForceDbCheck(userId, "any-session"), true, "invalidateUserSession must mark the user force-revalidate");
});

test("self-delete SKIPS the password step-up for an SSO account (session is the proof) and anonymizes directly", async () => {
  const { userId, token } = await mintSession({ provider: "jellyfin", passwordHash: null });
  const res = await deleteProfile(token); // no password supplied — and none required
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(txCalls, 1, "an SSO delete still runs the anonymization");
  assert.equal(passwordUpdateData().email, `deleted-${userId}@deleted.invalid`);
});

// ═══ shared: every profile route requires an authenticated session ══════════

test("all four profile routes reject an unauthenticated request with 401 (withAuth), handler body never runs", async () => {
  const password = await changePassword(null, { currentPassword: CURRENT_PW, newPassword: NEW_PW });
  assert.equal(password.status, 401);
  assert.deepEqual(await password.json(), { error: "Unauthorized" });

  const notifGet = await getNotifications(null);
  assert.equal(notifGet.status, 401);

  const notifPatch = await patchNotifications(null, { notifyOnApproved: true });
  assert.equal(notifPatch.status, 401);

  const notifEmail = await postNotifEmail(null, { email: "notify@example.com" });
  assert.equal(notifEmail.status, 401);

  const del = await deleteProfile(null, { password: CURRENT_PW });
  assert.equal(del.status, 401);

  // Nothing authenticated ⇒ nothing written or sent by any of them.
  assert.equal(ops.length, 0);
  assert.equal(txCalls, 0);
  assert.equal(fetchCalls.length, 0);
});
