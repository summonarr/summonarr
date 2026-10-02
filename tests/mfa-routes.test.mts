// Route-level tests for two-factor authentication (guardrail 6d):
//
//   POST /api/auth/sign-in/credentials   — the password step's 2FA branch
//   POST /api/auth/sign-in/mfa           — the second step
//   /api/profile/mfa/**                  — enrollment (password step-up)
//   DELETE /api/admin/users/[id]/mfa     — admin reset
//
// The invariants, each pinned below and mutation-checked:
//   1. An account WITHOUT 2FA gets a byte-identical password response
//      (deepEqual) — the iOS app depends on it.
//   2. For an account WITH 2FA the password alone mints NOTHING: no AuthSession
//      row, no Set-Cookie, no token — only the challenge.
//   3. The session is minted only after a valid second factor, through the
//      same signInAndMintSession + buildSignInResponse as the password path
//      (cookie for web, body token only for X-Summonarr-Client; rememberMe and
//      the native flag carried in the challenge token).
//   4. TOTP codes and recovery codes are single-use; WebAuthn assertions are
//      bound to the challenge; challenge tokens are single-use, burn after
//      repeated failures and die when the password changes.
//   5. Attempts are rate-limited per account and per IP.
//   6. Enrollment changes need the current password; the admin reset needs
//      MANAGE_USERS (ADMIN for an admin target) and never the caller's own.
//
// Harness: real handlers, genuine signed session JWTs, a synthetic Next request
// scope, in-memory prisma stubs that implement the conditional-update (CAS)
// semantics the code relies on. No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac } from "node:crypto";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "cd".repeat(32);
process.env.NEXTAUTH_SECRET = "mfa-routes-test-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const errors: string[] = [];
const warns: string[] = [];
console.error = (...a: unknown[]) => { errors.push(a.map(String).join(" ")); };
console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };

const cjsRequire = createRequire(import.meta.url);
type RunStore = { run<T>(store: unknown, fn: () => T): T };
const { workAsyncStorage } = cjsRequire("next/dist/server/app-render/work-async-storage.external.js") as { workAsyncStorage: RunStore };
const { workUnitAsyncStorage } = cjsRequire("next/dist/server/app-render/work-unit-async-storage.external.js") as { workUnitAsyncStorage: RunStore };
const { RequestCookies } = cjsRequire("next/dist/server/web/spec-extension/cookies.js") as { RequestCookies: new (h: Headers) => unknown };
const { RequestCookiesAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/request-cookies.js") as { RequestCookiesAdapter: { seal(c: unknown): unknown } };
const { HeadersAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/headers.js") as { HeadersAdapter: { seal(h: Headers): unknown } };

const { NextRequest } = await import("next/server");
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { signSessionJwt, verifySessionJwt } = await import("../src/lib/session-jwt.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");
const { Permission } = await import("../src/lib/permissions.ts");
const { hashPassword } = await import("../src/lib/password-hash.ts");
const { base32Decode, generateTotpSecret, hotp, totpStep } = await import("../src/lib/mfa/totp.ts");
const { hashRecoveryCode, normalizeRecoveryCode } = await import("../src/lib/mfa/recovery-codes.ts");
const { webAuthnUserHandle, passwordVersion, ensureRecoveryCodesInTx, MFA_USER_LOCK_NAMESPACE, mfaUserLockKey } = await import("../src/lib/mfa/mfa-store.ts");
const { resetMfaTokenLedgerForTests, MAX_TOKEN_FAILURES } = await import("../src/lib/mfa/mfa-token.ts");
const { MFA_LOCKOUT_THRESHOLD, MFA_LOCKED_MESSAGE, lockoutDurationMs } = await import("../src/lib/mfa/lockout.ts");
const { refundHit } = await import("../src/lib/rate-limit.ts");
const { assertionResponse, makeAuthenticator, registrationResponse } = await import("./_webauthn-fixtures.mts");

// ── in-memory store ─────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

// Enough of Prisma's filter language for these routes: equality, { not },
// { lt / gt / gte } (numbers and Dates), { in }, OR.
function matches(row: Row, where: Where | undefined): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    if (k === "OR") {
      if (!(cond as Where[]).some((w) => matches(row, w))) return false;
      continue;
    }
    const v = row[k];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as { not?: unknown; lt?: number | Date; gt?: number | Date; gte?: number | Date; in?: unknown[] };
      if ("not" in c) {
        if (c.not === null ? v == null : v === c.not) return false;
      }
      const num = (x: unknown) => (x instanceof Date ? x.getTime() : typeof x === "number" ? x : NaN);
      if ("lt" in c && !(v != null && num(v) < num(c.lt))) return false;
      if ("gt" in c && !(v != null && num(v) > num(c.gt))) return false;
      if ("gte" in c && !(v != null && num(v) >= num(c.gte))) return false;
      if ("in" in c && !c.in!.includes(v)) return false;
      continue;
    }
    if (cond instanceof Date) {
      if (!(v instanceof Date) || v.getTime() !== cond.getTime()) return false;
      continue;
    }
    if (v !== cond && !(cond === null && v == null)) return false;
  }
  return true;
}

let users: Row[] = [];
let totps: Row[] = [];
let codes: Row[] = [];
let passkeys: Row[] = [];
let sessions: Row[] = [];
let settings = new Map<string, string>();
let audit: Row[] = [];
let sessionWrites = 0;
let seq = 0;

// Applies Prisma update data, including atomic { increment } operations.
function applyData(row: Row, data: Row): void {
  for (const [k, v] of Object.entries(data)) {
    if (v !== null && typeof v === "object" && !(v instanceof Date) && "increment" in (v as Row)) {
      row[k] = (row[k] as number) + ((v as { increment: number }).increment);
    } else {
      row[k] = v;
    }
  }
}

shadowPrismaModel(prisma, "user", {
  // A snapshot, like a real read: a later write must not show through an
  // object the route already holds (the L2 re-read test depends on it).
  findUnique: async ({ where }: { where: Where }) => {
    const u = users.find((x) => matches(x, where));
    return u ? { ...u } : null;
  },
  findFirst: async ({ where }: { where?: Where } = {}) => users.find((u) => matches(u, where)) ?? null,
  update: async ({ where, data }: { where: Where; data: Row }) => {
    const u = users.find((x) => matches(x, where));
    if (!u) throw Object.assign(new Error("Record not found"), { code: "P2025" });
    applyData(u, data);
    return u;
  },
  updateMany: async ({ where, data }: { where: Where; data: Row }) => {
    const hit = users.filter((u) => matches(u, where));
    for (const u of hit) applyData(u, data);
    return { count: hit.length };
  },
  findMany: async () => [],
  count: async () => users.length,
});
shadowPrismaModel(prisma, "userTotp", {
  findUnique: async ({ where }: { where: Where }) => totps.find((t) => matches(t, where)) ?? null,
  create: async ({ data }: { data: Row }) => {
    const row = { lastUsedStep: null, enabledAt: null, updatedAt: new Date(Date.now() + ++seq), ...data };
    totps.push(row);
    return row;
  },
  updateMany: async ({ where, data }: { where: Where; data: Row }) => {
    const hit = totps.filter((t) => matches(t, where));
    for (const t of hit) Object.assign(t, data, { updatedAt: new Date(Date.now() + ++seq) });
    return { count: hit.length };
  },
  deleteMany: async ({ where }: { where: Where }) => {
    const before = totps.length;
    totps = totps.filter((t) => !matches(t, where));
    return { count: before - totps.length };
  },
});
// A test can hold every recovery-code lookup at a gate to force two requests
// to overlap inside the factor verifier.
let codeGate: Promise<void> | null = null;
shadowPrismaModel(prisma, "mfaRecoveryCode", {
  findMany: async ({ where }: { where: Where }) => {
    if (codeGate) await codeGate;
    return codes.filter((c) => matches(c, where));
  },
  count: async ({ where }: { where: Where }) => codes.filter((c) => matches(c, where)).length,
  createMany: async ({ data }: { data: Row[] }) => {
    for (const d of data) codes.push({ id: `rc-${++seq}`, usedAt: null, ...d });
    return { count: data.length };
  },
  updateMany: async ({ where, data }: { where: Where; data: Row }) => {
    const hit = codes.filter((c) => matches(c, where));
    for (const c of hit) Object.assign(c, data);
    return { count: hit.length };
  },
  deleteMany: async ({ where }: { where: Where }) => {
    const before = codes.length;
    codes = codes.filter((c) => !matches(c, where));
    return { count: before - codes.length };
  },
});
shadowPrismaModel(prisma, "webAuthnCredential", {
  findMany: async ({ where }: { where?: Where } = {}) => passkeys.filter((p) => matches(p, where)),
  findFirst: async ({ where }: { where: Where }) => passkeys.find((p) => matches(p, where)) ?? null,
  count: async ({ where }: { where: Where }) => passkeys.filter((p) => matches(p, where)).length,
  create: async ({ data }: { data: Row }) => {
    if (passkeys.some((p) => p.credentialId === data.credentialId)) {
      throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    }
    const row = { id: `pk-${++seq}`, createdAt: new Date(), lastUsedAt: null, ...data };
    passkeys.push(row);
    return row;
  },
  updateMany: async ({ where, data }: { where: Where; data: Row }) => {
    const hit = passkeys.filter((p) => matches(p, where));
    for (const p of hit) Object.assign(p, data);
    return { count: hit.length };
  },
  deleteMany: async ({ where }: { where: Where }) => {
    const before = passkeys.length;
    passkeys = passkeys.filter((p) => !matches(p, where));
    return { count: before - passkeys.length };
  },
});
shadowPrismaModel(prisma, "authSession", {
  findUnique: async ({ where }: { where: Where }) => sessions.find((s) => matches(s, where)) ?? null,
  findMany: async ({ where }: { where: Where }) => sessions.filter((s) => matches(s, where)),
  upsert: async ({ create }: { create: Row }) => {
    sessionWrites++;
    sessions.push({ ...create });
    return create;
  },
  update: async () => ({}),
  deleteMany: async ({ where }: { where: Where }) => {
    const before = sessions.length;
    sessions = sessions.filter((s) => !matches(s, where));
    return { count: before - sessions.length };
  },
});
shadowPrismaModel(prisma, "setting", {
  findUnique: async ({ where }: { where: { key: string } }) =>
    settings.has(where.key) ? { key: where.key, value: settings.get(where.key)! } : null,
  findMany: async () => [],
  upsert: async () => ({}),
});
shadowPrismaModel(prisma, "auditLog", {
  create: async ({ data }: { data: Row }) => {
    audit.push(data);
    return data;
  },
});
shadowPrismaClientMethod(prisma, "$transaction", async (arg: unknown) =>
  Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => Promise<unknown>)(prisma));
// Raw statements are recorded; a test can hook them (e.g. to land a concurrent
// write "while" the advisory lock is being acquired).
let rawSql: string[] = [];
let onRaw: ((sql: string) => void) | null = null;
shadowPrismaClientMethod(prisma, "$executeRawUnsafe", async (sql: string) => {
  rawSql.push(sql);
  onRaw?.(sql);
  return 1;
});

const credentialsRoute = await import("../src/app/api/auth/sign-in/credentials/route.ts");
const mfaRoute = await import("../src/app/api/auth/sign-in/mfa/route.ts");
const profileMfa = await import("../src/app/api/profile/mfa/route.ts");
const totpSetup = await import("../src/app/api/profile/mfa/totp/setup/route.ts");
const totpEnable = await import("../src/app/api/profile/mfa/totp/enable/route.ts");
const recoveryRoute = await import("../src/app/api/profile/mfa/recovery-codes/route.ts");
const passkeyOptions = await import("../src/app/api/profile/mfa/passkeys/options/route.ts");
const passkeyRegister = await import("../src/app/api/profile/mfa/passkeys/route.ts");
const passkeyItem = await import("../src/app/api/profile/mfa/passkeys/[id]/route.ts");
const totpRoute = await import("../src/app/api/profile/mfa/totp/route.ts");
const stepUpChallenge = await import("../src/app/api/profile/mfa/challenge/route.ts");
const adminReset = await import("../src/app/api/admin/users/[id]/mfa/route.ts");

// ── request plumbing ────────────────────────────────────────────────────────

function inScope<T>(headers: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const workStore = { route: "/mfa.test", forceStatic: false, dynamicShouldError: false, afterContext: { after: () => {} } };
  const reqHeaders = new Headers(headers);
  const requestStore = {
    type: "request", phase: "render",
    headers: HeadersAdapter.seal(reqHeaders),
    cookies: RequestCookiesAdapter.seal(new RequestCookies(reqHeaders)),
    usedDynamic: false,
  };
  return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, fn));
}

let ipSeq = 0;
// Each test gets its own client IP so the per-IP limiters never bleed across tests.
let IP = "203.0.113.1";

async function call(
  handler: (req: InstanceType<typeof NextRequest>, ctx: unknown) => Promise<Response>,
  path: string,
  opts: { method?: string; body?: unknown; headers?: Record<string, string>; ctx?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": IP, "user-agent": "Mozilla/5.0 test", ...opts.headers };
  const req = new NextRequest(`http://localhost:3000${path}`, {
    method: opts.method ?? "POST",
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  return inScope(headers, () => handler(req, opts.ctx));
}

const COOKIE = getSessionCookieName();
const setCookies = (res: Response) => res.headers.getSetCookie?.() ?? [];
const NATIVE = { "x-summonarr-client": "ios; build=10; api=3" };
const PASSWORD = "correct-horse-battery";

async function seedUser(over: Row = {}): Promise<Row> {
  const id = `user-${++seq}`;
  const u: Row = {
    id, email: `${id}@example.com`, name: `User ${seq}`, role: "USER", permissions: 0n,
    passwordHash: await hashPassword(PASSWORD), mediaServer: null,
    sessionsRevokedAt: null, passwordChangedAt: null, deactivatedAt: null, notificationEmail: null,
    mfaFailedAttempts: 0, mfaLockoutCount: 0, mfaLockedUntil: null,
    ...over,
  };
  users.push(u);
  return u;
}

function seedTotp(userId: string): Buffer {
  const secret = generateTotpSecret();
  totps.push({ userId, secret, enabledAt: new Date(), lastUsedStep: null, updatedAt: new Date() });
  return base32Decode(secret)!;
}
const currentCode = (key: Buffer, offset = 0) => hotp(key, totpStep(Date.now()) + offset);

function seedRecoveryCodes(userId: string, plain: string[]): void {
  for (const c of plain) codes.push({ id: `rc-${++seq}`, userId, codeHash: hashRecoveryCode(normalizeRecoveryCode(c)!), usedAt: null });
}

async function credentialsSignInStep(user: Row, headers: Record<string, string> = {}, extra: Row = {}) {
  return call(credentialsRoute.POST as never, "/api/auth/sign-in/credentials", {
    body: { email: user.email, password: PASSWORD, ...extra },
    headers,
  });
}

async function challengeFor(user: Row, headers: Record<string, string> = {}, extra: Row = {}) {
  const res = await credentialsSignInStep(user, headers, extra);
  assert.equal(res.status, 401);
  return (await res.json()) as {
    mfaRequired: boolean; methods: string[]; mfaToken: string; expiresInSeconds: number;
    webauthn?: { challenge: string; rpId: string; allowCredentials: { id: string }[] };
  };
}

function mfa(body: Row, headers: Record<string, string> = {}) {
  return call(mfaRoute.POST as never, "/api/auth/sign-in/mfa", { body, headers });
}

async function sessionFor(user: Row): Promise<string> {
  const sessionId = `sess-${++seq}`;
  sessions.push({ sessionId, userId: user.id, expiresAt: new Date(Date.now() + 86_400_000) });
  const iat = Math.floor(Date.now() / 1000);
  const jwt = await signSessionJwt(
    {
      id: user.id as string, role: user.role as string,
      permissions: (user.role === "ADMIN" ? Permission.ADMIN : (user.permissions as bigint)).toString(),
      provider: "credentials", sessionId, expiresAt: iat + 86_400,
    },
    { expiresInSeconds: 7_200, iat },
  );
  return jwt;
}
const bearer = (jwt: string) => ({ authorization: `Bearer ${jwt}` });

beforeEach(() => {
  users = []; totps = []; codes = []; passkeys = []; sessions = []; audit = []; rawSql = []; onRaw = null;
  settings = new Map([["setup_completed_at", "2026-01-01T00:00:00.000Z"]]);
  sessionWrites = 0;
  errors.length = 0;
  IP = `203.0.113.${(++ipSeq % 250) + 1}`;
  resetMfaTokenLedgerForTests();
});

// ── 1. the non-2FA path is unchanged ────────────────────────────────────────

test("an account WITHOUT 2FA gets the byte-identical password response (web): 200 + cookie, body deepEqual", async () => {
  const u = await seedUser();
  const res = await credentialsSignInStep(u);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    ok: true,
    user: { id: u.id, role: "USER", email: u.email, name: u.name, provider: "credentials", mediaServer: null },
  });
  assert.equal(setCookies(res).filter((c) => c.startsWith(`${COOKIE}=`)).length, 1);
  assert.equal(sessionWrites, 1);
});

test("an account WITHOUT 2FA gets the byte-identical password response (native): token fields, same key set", async () => {
  const u = await seedUser();
  const res = await credentialsSignInStep(u, NATIVE);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ["expiresInSeconds", "ok", "token", "tokenType", "user"]);
  assert.equal(body.tokenType, "Bearer");
  assert.ok(await verifySessionJwt(body.token));
});

test("a PENDING (unconfirmed) authenticator setup is not a second factor — sign-in is unchanged", async () => {
  const u = await seedUser();
  totps.push({ userId: u.id, secret: generateTotpSecret(), enabledAt: null, lastUsedStep: null, updatedAt: new Date() });
  const res = await credentialsSignInStep(u);
  assert.equal(res.status, 200);
});

// ── 2. the password alone mints nothing for a 2FA account ───────────────────

test("2FA account: the password step returns the challenge and mints NOTHING (no row, no cookie, no token)", async () => {
  const u = await seedUser();
  seedTotp(u.id as string);
  seedRecoveryCodes(u.id as string, ["AAAA-BBBB-CCCC-DDDD"]);
  for (const headers of [{}, NATIVE]) {
    const res = await credentialsSignInStep(u, headers);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(setCookies(res), [], "no Set-Cookie of any kind");
    const body = await res.json();
    assert.equal(body.mfaRequired, true);
    assert.equal(body.error, "Two-factor authentication required");
    assert.deepEqual(body.methods, ["totp", "recovery"]);
    assert.equal(body.expiresInSeconds, 300);
    assert.ok(!("token" in body) && !("user" in body), "no session token or user in the challenge");
    assert.equal(await verifySessionJwt(body.mfaToken), null, "the challenge token is not a session");
  }
  assert.equal(sessionWrites, 0);
});

test("a wrong password on a 2FA account is the ordinary 401 — no challenge is disclosed", async () => {
  const u = await seedUser();
  seedTotp(u.id as string);
  const res = await call(credentialsRoute.POST as never, "/api/auth/sign-in/credentials", { body: { email: u.email, password: "wrong-password-here" } });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "Invalid credentials" });
});

test("a DISABLED 2FA account gets the disabled answer at the password step, never a challenge", async () => {
  const u = await seedUser({ deactivatedAt: new Date() });
  seedTotp(u.id as string);
  const res = await credentialsSignInStep(u);
  assert.equal(res.status, 403);
  assert.ok(!("mfaToken" in (await res.json())));
});

// ── 3. minting after the second factor ──────────────────────────────────────

test("TOTP: a valid code mints exactly one session, cookie only for web, audited with the factor", async () => {
  const u = await seedUser();
  const key = seedTotp(u.id as string);
  const ch = await challengeFor(u);
  const res = await mfa({ mfaToken: ch.mfaToken, method: "totp", code: currentCode(key) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { ok: true, user: { id: u.id, role: "USER", email: u.email, name: u.name, provider: "credentials", mediaServer: null } });
  assert.equal(setCookies(res).filter((c) => c.startsWith(`${COOKIE}=`) && /HttpOnly/i.test(c)).length, 1);
  assert.equal(sessionWrites, 1);
  await new Promise((r) => setImmediate(r));
  const login = audit.find((a) => a.action === "AUTH_LOGIN");
  assert.ok(login, "the AUTH_LOGIN row is written by the shared mint path");
  assert.equal(JSON.parse(login.details as string).secondFactor, "totp");
});

test("native: the challenge carries the native flag — token in the body only for the native MFA step, mismatch refused", async () => {
  const u = await seedUser();
  const key = seedTotp(u.id as string);
  const nativeCh = await challengeFor(u, NATIVE);
  const mismatch = await mfa({ mfaToken: nativeCh.mfaToken, method: "totp", code: currentCode(key) });
  assert.equal(mismatch.status, 400, "a native challenge completed by a web client is refused");
  assert.equal(sessionWrites, 0);
  const ok = await mfa({ mfaToken: nativeCh.mfaToken, method: "totp", code: currentCode(key) }, NATIVE);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.tokenType, "Bearer");
  const claims = await verifySessionJwt(body.token);
  assert.ok(claims && claims.expiresAt! > Math.floor(Date.now() / 1000) + 10 * 365 * 86_400, "native ⇒ the never-expiring deadline (guardrail 6c)");

  const webCh = await challengeFor(u);
  const res = await mfa({ mfaToken: webCh.mfaToken, method: "totp", code: currentCode(key, 1) }, NATIVE);
  assert.equal(res.status, 400, "a web challenge can't be upgraded to a native session");
});

test("rememberMe from the password step is carried to the session minted after the second factor", async () => {
  const u = await seedUser();
  const key = seedTotp(u.id as string);
  const ch = await challengeFor(u, {}, { rememberMe: "true" });
  const res = await mfa({ mfaToken: ch.mfaToken, method: "totp", code: currentCode(key) });
  assert.equal(res.status, 200);
  const minted = sessions.at(-1)!;
  const ttl = ((minted.expiresAt as Date).getTime() - Date.now()) / 1000;
  assert.ok(ttl > 29 * 86_400, `remember-me ⇒ the 30-day max duration, got ${Math.round(ttl / 3600)}h`);
});

// ── 4. single use, replay, binding ──────────────────────────────────────────

test("TOTP replay: the same code can't sign in twice, and a wrong code mints nothing", async () => {
  const u = await seedUser();
  const key = seedTotp(u.id as string);
  const code = currentCode(key);
  const first = await mfa({ mfaToken: (await challengeFor(u)).mfaToken, method: "totp", code });
  assert.equal(first.status, 200);
  const replay = await mfa({ mfaToken: (await challengeFor(u)).mfaToken, method: "totp", code });
  assert.equal(replay.status, 401);
  assert.deepEqual(await replay.json(), { error: "Invalid verification code." });
  const wrong = await mfa({ mfaToken: (await challengeFor(u)).mfaToken, method: "totp", code: code === "000000" ? "111111" : "000000" });
  assert.equal(wrong.status, 401);
  assert.equal(sessionWrites, 1, "only the first redemption minted");
});

test("a challenge token is single-use: after a success it is dead even with a fresh valid code", async () => {
  const u = await seedUser();
  const key = seedTotp(u.id as string);
  const ch = await challengeFor(u);
  assert.equal((await mfa({ mfaToken: ch.mfaToken, method: "totp", code: currentCode(key) })).status, 200);
  const again = await mfa({ mfaToken: ch.mfaToken, method: "totp", code: currentCode(key, 1) });
  assert.equal(again.status, 401);
  assert.equal((await again.json()).mfaExpired, true);
  assert.equal(sessionWrites, 1);
});

test("a challenge token burns after repeated wrong answers — then even the right code is refused", async () => {
  const u = await seedUser();
  const key = seedTotp(u.id as string);
  const ch = await challengeFor(u);
  for (let i = 0; i < MAX_TOKEN_FAILURES; i++) {
    assert.equal((await mfa({ mfaToken: ch.mfaToken, method: "totp", code: "000000" })).status, 401);
  }
  const res = await mfa({ mfaToken: ch.mfaToken, method: "totp", code: currentCode(key) });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).mfaExpired, true);
  assert.equal(sessionWrites, 0);
});

test("a password change between the two steps kills the challenge", async () => {
  const u = await seedUser();
  const key = seedTotp(u.id as string);
  const ch = await challengeFor(u);
  u.passwordHash = await hashPassword("a-brand-new-password");
  const res = await mfa({ mfaToken: ch.mfaToken, method: "totp", code: currentCode(key) });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).mfaExpired, true);
  assert.equal(sessionWrites, 0);
});

test("an account disabled between the two steps is refused at the mint chokepoint (guardrail 33)", async () => {
  const u = await seedUser();
  const key = seedTotp(u.id as string);
  const ch = await challengeFor(u);
  u.deactivatedAt = new Date();
  const res = await mfa({ mfaToken: ch.mfaToken, method: "totp", code: currentCode(key) });
  assert.equal(res.status, 403);
  assert.equal(sessionWrites, 0);
});

test("recovery codes: each works exactly once, any case/spacing, and a used one is refused", async () => {
  const u = await seedUser();
  seedTotp(u.id as string);
  seedRecoveryCodes(u.id as string, ["ABCD-EFGH-JKLM-NPQR", "STUV-WXYZ-2345-6789"]);
  const ok = await mfa({ mfaToken: (await challengeFor(u)).mfaToken, method: "recovery", code: "abcd efgh jklm npqr" });
  assert.equal(ok.status, 200);
  const reuse = await mfa({ mfaToken: (await challengeFor(u)).mfaToken, method: "recovery", code: "ABCD-EFGH-JKLM-NPQR" });
  assert.equal(reuse.status, 401);
  assert.equal(codes.filter((c) => c.usedAt == null).length, 1);
  // A code belonging to ANOTHER account never works here.
  const other = await seedUser();
  seedRecoveryCodes(other.id as string, ["2222-3333-4444-5555"]);
  const foreign = await mfa({ mfaToken: (await challengeFor(u)).mfaToken, method: "recovery", code: "2222-3333-4444-5555" });
  assert.equal(foreign.status, 401);
});

test("passkey: the challenge offers webauthn; a genuine assertion mints, a replay against a new challenge fails", async () => {
  const u = await seedUser();
  const auth = makeAuthenticator("ES256");
  passkeys.push({
    id: "pk-1", userId: u.id, credentialId: auth.credentialId.toString("base64url"),
    publicKey: auth.coseKey.toString("base64url"), signCount: 0n, transports: ["usb"], name: "Key",
    createdAt: new Date(), lastUsedAt: null, backedUp: false,
  });
  const ch = await challengeFor(u);
  assert.deepEqual(ch.methods, ["webauthn"]);
  assert.equal(ch.webauthn!.rpId, "localhost");
  assert.deepEqual(ch.webauthn!.allowCredentials.map((c) => c.id), [auth.credentialId.toString("base64url")]);

  const credential = assertionResponse({
    auth, rpId: "localhost", origin: "http://localhost:3000", challenge: ch.webauthn!.challenge, signCount: 1,
    userHandle: webAuthnUserHandle(u.id as string),
  });
  const res = await mfa({ mfaToken: ch.mfaToken, method: "webauthn", credential });
  assert.equal(res.status, 200);
  assert.equal(passkeys[0].signCount, 1n, "counter advanced");

  // Replaying the same signed assertion against a fresh challenge must fail.
  const ch2 = await challengeFor(u);
  const replay = await mfa({ mfaToken: ch2.mfaToken, method: "webauthn", credential });
  assert.equal(replay.status, 401);
  assert.equal(sessionWrites, 1);
});

test("passkey: an assertion from another user's credential is refused (credential must belong to the user)", async () => {
  const victim = await seedUser();
  const attacker = await seedUser();
  const victimKey = makeAuthenticator();
  const attackerKey = makeAuthenticator();
  for (const [owner, a] of [[victim, victimKey], [attacker, attackerKey]] as const) {
    passkeys.push({
      id: `pk-${++seq}`, userId: owner.id, credentialId: a.credentialId.toString("base64url"),
      publicKey: a.coseKey.toString("base64url"), signCount: 0n, transports: [], name: "k", createdAt: new Date(), lastUsedAt: null, backedUp: false,
    });
  }
  const ch = await challengeFor(victim);
  const credential = assertionResponse({ auth: attackerKey, rpId: "localhost", origin: "http://localhost:3000", challenge: ch.webauthn!.challenge, signCount: 1 });
  const res = await mfa({ mfaToken: ch.mfaToken, method: "webauthn", credential });
  assert.equal(res.status, 401);
  assert.equal(sessionWrites, 0);
});

// ── 5. rate limiting ────────────────────────────────────────────────────────

test("rate limit per ACCOUNT (in-memory): the 11th second-factor attempt in 15 minutes is 429, across tokens and IPs", async () => {
  const u = await seedUser();
  const key = seedTotp(u.id as string);
  let attempts = 0;
  for (let t = 0; t < 2; t++) {
    const ch = await challengeFor(u);
    for (let i = 0; i < 5; i++) {
      IP = `198.51.100.${++attempts}`; // a fresh IP each time — only the account bucket can trip
      // Keep the PERSISTENT lockout (which also trips at 10) out of this test.
      u.mfaFailedAttempts = 0;
      assert.equal((await mfa({ mfaToken: ch.mfaToken, method: "totp", code: "000000" })).status, 401);
    }
  }
  IP = "198.51.100.200";
  const ch = await challengeFor(u);
  const res = await mfa({ mfaToken: ch.mfaToken, method: "totp", code: currentCode(key) });
  assert.equal(res.status, 429, "the account bucket is exhausted — even the right code waits");
  assert.equal(sessionWrites, 0);
});

test("rate limit per IP: the 31st attempt from one address in 5 minutes is 429 before any token work", async () => {
  for (let i = 0; i < 30; i++) {
    const res = await mfa({ mfaToken: "garbage", method: "totp", code: "000000" });
    assert.equal(res.status, 401);
  }
  const res = await mfa({ mfaToken: "garbage", method: "totp", code: "000000" });
  assert.equal(res.status, 429);
});

test("malformed second-step input is a 400, never a mint", async () => {
  const u = await seedUser();
  seedTotp(u.id as string);
  const ch = await challengeFor(u);
  for (const body of [{ mfaToken: ch.mfaToken }, { mfaToken: ch.mfaToken, method: "sms", code: "1" }, { mfaToken: ch.mfaToken, method: "webauthn", credential: "x" }]) {
    assert.equal((await mfa(body)).status, 400);
  }
  assert.equal(sessionWrites, 0);
});

// ── 6. enrollment (password step-up) ────────────────────────────────────────

test("TOTP enrollment: setup needs the password; enable returns ten recovery codes once and signs out OTHER sessions", async () => {
  const u = await seedUser();
  const jwt = await sessionFor(u);
  const otherJwt = await sessionFor(u);
  void otherJwt;
  assert.equal(sessions.length, 2);

  const noPw = await call(totpSetup.POST as never, "/api/profile/mfa/totp/setup", { body: {}, headers: bearer(jwt) });
  assert.equal(noPw.status, 400);
  const badPw = await call(totpSetup.POST as never, "/api/profile/mfa/totp/setup", { body: { password: "nope-nope-nope" }, headers: bearer(jwt) });
  assert.equal(badPw.status, 400);
  assert.equal(totps.length, 0, "no secret is issued without the password");

  const setup = await call(totpSetup.POST as never, "/api/profile/mfa/totp/setup", { body: { password: PASSWORD }, headers: bearer(jwt) });
  assert.equal(setup.status, 200);
  const { secret, otpauthUri } = await setup.json();
  assert.match(otpauthUri, /^otpauth:\/\/totp\//);
  assert.equal(totps[0].enabledAt, null, "pending until confirmed");

  const wrong = await call(totpEnable.POST as never, "/api/profile/mfa/totp/enable", { body: { code: "000000" }, headers: bearer(jwt) });
  assert.equal(wrong.status, 400);

  const code = hotp(base32Decode(secret)!, totpStep(Date.now()));
  const enable = await call(totpEnable.POST as never, "/api/profile/mfa/totp/enable", { body: { code }, headers: bearer(jwt) });
  assert.equal(enable.status, 200);
  const body = await enable.json();
  assert.equal(body.recoveryCodes.length, 10);
  assert.ok((totps[0].enabledAt as unknown) instanceof Date);
  assert.equal(codes.length, 10);
  assert.equal(sessions.length, 1, "the other session was revoked; this one survives");
  await new Promise((r) => setImmediate(r));
  assert.ok(audit.some((a) => a.action === "MFA_CHANGE" && JSON.parse(a.details as string).kind === "totp-enabled"));

  // The confirming code can't then be replayed at sign-in.
  const ch = await challengeFor(u);
  assert.equal((await mfa({ mfaToken: ch.mfaToken, method: "totp", code })).status, 401);
});

test("enrollment is refused for an account that doesn't sign in with a password (403)", async () => {
  const u = await seedUser({ passwordHash: null });
  const jwt = await sessionFor(u);
  const res = await call(totpSetup.POST as never, "/api/profile/mfa/totp/setup", { body: { password: "anything-at-all" }, headers: bearer(jwt) });
  assert.equal(res.status, 403);
});

test("passkey enrollment: options need the password; the registration token is single-use and session-bound", async () => {
  const u = await seedUser();
  const jwt = await sessionFor(u);
  const opts = await call(passkeyOptions.POST as never, "/api/profile/mfa/passkeys/options", { body: { password: PASSWORD }, headers: bearer(jwt) });
  assert.equal(opts.status, 200);
  const { registrationToken, publicKey } = await opts.json();
  assert.equal(publicKey.rp.id, "localhost");
  assert.equal(publicKey.attestation, "none");
  assert.equal(publicKey.user.id, webAuthnUserHandle(u.id as string));

  const auth = makeAuthenticator("EdDSA");
  const credential = registrationResponse({ auth, rpId: "localhost", origin: "http://localhost:3000", challenge: publicKey.challenge });

  // Another session of the same user can't complete it.
  const otherJwt = await sessionFor(u);
  const foreign = await call(passkeyRegister.POST as never, "/api/profile/mfa/passkeys", { body: { registrationToken, name: "x", credential }, headers: bearer(otherJwt) });
  assert.equal(foreign.status, 400);

  const ok = await call(passkeyRegister.POST as never, "/api/profile/mfa/passkeys", { body: { registrationToken, name: "My <b>Key</b>", credential }, headers: bearer(jwt) });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).recoveryCodes.length, 10, "first factor ⇒ recovery codes");
  assert.equal(passkeys.length, 1);
  assert.equal(passkeys[0].name, "My bKey/b", "markup characters are stripped from the label");

  const replay = await call(passkeyRegister.POST as never, "/api/profile/mfa/passkeys", { body: { registrationToken, name: "x", credential }, headers: bearer(jwt) });
  assert.equal(replay.status, 400, "the registration token is single-use");

  // The new passkey is now the account's second factor.
  const ch = await challengeFor(u);
  assert.ok(ch.methods.includes("webauthn"));
});

test("removing the last factor removes the recovery codes and signs out OTHER sessions; rename/remove stay owner-scoped", async () => {
  const u = await seedUser();
  const other = await seedUser();
  const jwt = await sessionFor(u);
  await sessionFor(u); // a second device
  const key = seedTotp(u.id as string);
  passkeys.push({ id: "pk-mine", userId: u.id, credentialId: "AAAA", publicKey: "x", signCount: 0n, transports: [], name: "Mine", createdAt: new Date(), lastUsedAt: null, backedUp: false });
  passkeys.push({ id: "pk-theirs", userId: other.id, credentialId: "BBBB", publicKey: "x", signCount: 0n, transports: [], name: "Theirs", createdAt: new Date(), lastUsedAt: null, backedUp: false });
  seedRecoveryCodes(u.id as string, ["AAAA-BBBB-CCCC-DDDD"]);
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  let step = -1;
  const sf = () => ({ method: "totp", code: currentCode(key, ++step) });

  const renameNoPw = await call(passkeyItem.PATCH as never, "/api/profile/mfa/passkeys/pk-mine", { method: "PATCH", body: { name: "New", secondFactor: sf() }, headers: bearer(jwt), ctx: ctx("pk-mine") });
  assert.equal(renameNoPw.status, 400);
  step = -1; // that code was never checked (the password failed first), so it is still fresh
  const renameTheirs = await call(passkeyItem.PATCH as never, "/api/profile/mfa/passkeys/pk-theirs", { method: "PATCH", body: { name: "Pwned", password: PASSWORD, secondFactor: sf() }, headers: bearer(jwt), ctx: ctx("pk-theirs") });
  assert.equal(renameTheirs.status, 404);
  assert.equal(passkeys.find((p) => p.id === "pk-theirs")!.name, "Theirs");

  // Removing the authenticator app while a passkey remains: 2FA is still on,
  // nobody is signed out.
  const removeTotp = await call(totpRoute.DELETE as never, "/api/profile/mfa/totp", { method: "DELETE", body: { password: PASSWORD, secondFactor: sf() }, headers: bearer(jwt) });
  assert.equal(removeTotp.status, 200);
  assert.equal(sessions.filter((s) => s.userId === u.id).length, 2, "a factor remains ⇒ no session is revoked");
  assert.equal(codes.filter((c) => c.userId === u.id).length, 1);

  const recovery = () => ({ method: "recovery", code: "AAAA-BBBB-CCCC-DDDD" });
  const removeTheirs = await call(passkeyItem.DELETE as never, "/api/profile/mfa/passkeys/pk-theirs", { method: "DELETE", body: { password: PASSWORD, secondFactor: recovery() }, headers: bearer(jwt), ctx: ctx("pk-theirs") });
  assert.equal(removeTheirs.status, 404);
  assert.equal(codes.find((c) => c.userId === u.id)!.usedAt instanceof Date, true, "the proof was consumed even though the target was not found");
  seedRecoveryCodes(u.id as string, ["EEEE-FFFF-GGGG-HHHH"]);
  const remove = await call(passkeyItem.DELETE as never, "/api/profile/mfa/passkeys/pk-mine", { method: "DELETE", body: { password: PASSWORD, secondFactor: { method: "recovery", code: "EEEE-FFFF-GGGG-HHHH" } }, headers: bearer(jwt), ctx: ctx("pk-mine") });
  assert.equal(remove.status, 200);
  assert.equal(codes.filter((c) => c.userId === u.id).length, 0, "no factor left ⇒ recovery codes go too");
  assert.equal(passkeys.length, 1);
  assert.equal(sessions.filter((s) => s.userId === u.id).length, 1, "the LAST factor went ⇒ the other session is signed out");
});

test("recovery-code regeneration needs the password AND a fresh second factor, and replaces every old code", async () => {
  const u = await seedUser();
  const jwt = await sessionFor(u);
  const key = seedTotp(u.id as string);
  seedRecoveryCodes(u.id as string, ["AAAA-BBBB-CCCC-DDDD"]);
  assert.equal((await call(recoveryRoute.POST as never, "/api/profile/mfa/recovery-codes", { body: {}, headers: bearer(jwt) })).status, 400);
  const pwOnly = await call(recoveryRoute.POST as never, "/api/profile/mfa/recovery-codes", { body: { password: PASSWORD }, headers: bearer(jwt) });
  assert.equal(pwOnly.status, 400);
  assert.equal((await pwOnly.json()).secondFactorRequired, true);
  assert.equal(codes.length, 1, "nothing replaced on the password alone");
  const res = await call(recoveryRoute.POST as never, "/api/profile/mfa/recovery-codes", { body: { password: PASSWORD, secondFactor: { method: "totp", code: currentCode(key) } }, headers: bearer(jwt) });
  assert.equal(res.status, 200);
  const { recoveryCodes } = await res.json();
  assert.equal(recoveryCodes.length, 10);
  assert.equal(codes.length, 10);
  assert.ok(!codes.some((c) => c.codeHash === hashRecoveryCode("AAAABBBBCCCCDDDD")), "the old code is gone");
});

test("turning 2FA off needs the password AND a fresh second factor, and the next sign-in is password-only", async () => {
  const u = await seedUser();
  const jwt = await sessionFor(u);
  const key = seedTotp(u.id as string);
  seedRecoveryCodes(u.id as string, ["AAAA-BBBB-CCCC-DDDD"]);
  assert.equal((await call(profileMfa.DELETE as never, "/api/profile/mfa", { method: "DELETE", body: { password: "wrong-one-here", secondFactor: { method: "totp", code: currentCode(key) } }, headers: bearer(jwt) })).status, 400);
  assert.equal((await call(profileMfa.DELETE as never, "/api/profile/mfa", { method: "DELETE", body: { password: PASSWORD }, headers: bearer(jwt) })).status, 400);
  assert.equal(totps.length, 1);
  const res = await call(profileMfa.DELETE as never, "/api/profile/mfa", { method: "DELETE", body: { password: PASSWORD, secondFactor: { method: "totp", code: currentCode(key) } }, headers: bearer(jwt) });
  assert.equal(res.status, 200);
  assert.deepEqual([totps.length, codes.length, passkeys.length], [0, 0, 0]);
  assert.equal((await credentialsSignInStep(u)).status, 200);
});

// ── M1: every enrollment change on an account WITH 2FA needs a fresh factor ──

function seedPasskey(userId: unknown, auth = makeAuthenticator("ES256"), id = `pk-${++seq}`): ReturnType<typeof makeAuthenticator> {
  passkeys.push({
    id, userId, credentialId: auth.credentialId.toString("base64url"),
    publicKey: auth.coseKey.toString("base64url"), signCount: 0n, transports: ["usb"], name: "Key",
    createdAt: new Date(), lastUsedAt: null, backedUp: false,
  });
  return auth;
}

// Every mutating enrollment route, driven on an account that has an active
// authenticator app AND a passkey. Each case: the password alone is refused
// (400, secondFactorRequired, nothing changes) and the same body plus a valid
// TOTP code succeeds.
const M1_CASES: { name: string; run: (jwt: string, extra: Row) => Promise<Response>; changed: () => boolean }[] = [
  {
    name: "DELETE /api/profile/mfa (turn off)",
    run: (jwt, extra) => call(profileMfa.DELETE as never, "/api/profile/mfa", { method: "DELETE", body: { password: PASSWORD, ...extra }, headers: bearer(jwt) }),
    changed: () => totps.length === 0,
  },
  {
    name: "DELETE /api/profile/mfa/totp",
    run: (jwt, extra) => call(totpRoute.DELETE as never, "/api/profile/mfa/totp", { method: "DELETE", body: { password: PASSWORD, ...extra }, headers: bearer(jwt) }),
    changed: () => totps.length === 0,
  },
  {
    name: "POST /api/profile/mfa/recovery-codes",
    run: (jwt, extra) => call(recoveryRoute.POST as never, "/api/profile/mfa/recovery-codes", { body: { password: PASSWORD, ...extra }, headers: bearer(jwt) }),
    changed: () => codes.length === 10,
  },
  {
    name: "POST /api/profile/mfa/passkeys/options",
    run: (jwt, extra) => call(passkeyOptions.POST as never, "/api/profile/mfa/passkeys/options", { body: { password: PASSWORD, ...extra }, headers: bearer(jwt) }),
    changed: () => true, // issues a registration token; the 200 is the change
  },
  {
    name: "PATCH /api/profile/mfa/passkeys/[id] (rename)",
    run: (jwt, extra) => call(passkeyItem.PATCH as never, "/api/profile/mfa/passkeys/pk-m1", { method: "PATCH", body: { password: PASSWORD, name: "Renamed", ...extra }, headers: bearer(jwt), ctx: { params: Promise.resolve({ id: "pk-m1" }) } }),
    changed: () => passkeys.find((p) => p.id === "pk-m1")?.name === "Renamed",
  },
  {
    name: "DELETE /api/profile/mfa/passkeys/[id]",
    run: (jwt, extra) => call(passkeyItem.DELETE as never, "/api/profile/mfa/passkeys/pk-m1", { method: "DELETE", body: { password: PASSWORD, ...extra }, headers: bearer(jwt), ctx: { params: Promise.resolve({ id: "pk-m1" }) } }),
    changed: () => !passkeys.some((p) => p.id === "pk-m1"),
  },
];

for (const c of M1_CASES) {
  test(`M1 ${c.name}: the password alone is refused once a factor exists; a fresh TOTP code makes it pass`, async () => {
    const u = await seedUser();
    const jwt = await sessionFor(u);
    const key = seedTotp(u.id as string);
    seedPasskey(u.id, undefined, "pk-m1");
    seedRecoveryCodes(u.id as string, ["AAAA-BBBB-CCCC-DDDD"]);

    const pwOnly = await c.run(jwt, {});
    assert.equal(pwOnly.status, 400, "password-only must be refused");
    const body = await pwOnly.json();
    assert.equal(body.secondFactorRequired, true);
    assert.deepEqual(body.methods, ["totp", "webauthn", "recovery"]);
    assert.ok(!(c.name.includes("options")) || !("registrationToken" in body));
    assert.deepEqual([totps.length, passkeys.length, codes.length], [1, 1, 1], "nothing changed");

    const wrong = await c.run(jwt, { secondFactor: { method: "totp", code: currentCode(key) === "000000" ? "111111" : "000000" } });
    assert.equal(wrong.status, 400);
    assert.deepEqual([totps.length, passkeys.length, codes.length], [1, 1, 1], "nothing changed on a wrong code");

    const ok = await c.run(jwt, { secondFactor: { method: "totp", code: currentCode(key) } });
    assert.equal(ok.status, 200, await ok.clone().text());
    assert.ok(c.changed());
  });
}

test("M1: TOTP setup on an account whose only factor is a passkey needs a second factor (a recovery code — consumed)", async () => {
  const u = await seedUser();
  const jwt = await sessionFor(u);
  seedPasskey(u.id);
  seedRecoveryCodes(u.id as string, ["AAAA-BBBB-CCCC-DDDD"]);
  const pwOnly = await call(totpSetup.POST as never, "/api/profile/mfa/totp/setup", { body: { password: PASSWORD }, headers: bearer(jwt) });
  assert.equal(pwOnly.status, 400);
  assert.equal(totps.length, 0, "no secret issued on the password alone");
  const ok = await call(totpSetup.POST as never, "/api/profile/mfa/totp/setup", { body: { password: PASSWORD, secondFactor: { method: "recovery", code: "aaaa bbbb cccc dddd" } }, headers: bearer(jwt) });
  assert.equal(ok.status, 200);
  assert.equal(totps.length, 1);
  assert.ok(codes[0].usedAt instanceof Date, "the recovery code was spent");
  const reuse = await call(totpSetup.POST as never, "/api/profile/mfa/totp/setup", { body: { password: PASSWORD, secondFactor: { method: "recovery", code: "AAAA-BBBB-CCCC-DDDD" } }, headers: bearer(jwt) });
  assert.equal(reuse.status, 400, "a recovery code proves a change once");
});

test("M1: a PASSKEY assertion over a fresh /challenge confirms a change; the challenge is single-use and session-bound", async () => {
  const u = await seedUser();
  const jwt = await sessionFor(u);
  const otherJwt = await sessionFor(u);
  const auth = seedPasskey(u.id);
  seedRecoveryCodes(u.id as string, ["AAAA-BBBB-CCCC-DDDD"]);

  const chRes = await call(stepUpChallenge.POST as never, "/api/profile/mfa/challenge", { body: {}, headers: bearer(jwt) });
  assert.equal(chRes.status, 200);
  const { challengeToken, publicKey } = await chRes.json();
  assert.equal(publicKey.rpId, "localhost");
  const credential = assertionResponse({
    auth, rpId: "localhost", origin: "http://localhost:3000", challenge: publicKey.challenge, signCount: 1,
    userHandle: webAuthnUserHandle(u.id as string),
  });
  const sf = { method: "webauthn", credential, challengeToken };

  const foreign = await call(recoveryRoute.POST as never, "/api/profile/mfa/recovery-codes", { body: { password: PASSWORD, secondFactor: sf }, headers: bearer(otherJwt) });
  assert.equal(foreign.status, 400, "another session can't use this session's challenge");
  const ok = await call(recoveryRoute.POST as never, "/api/profile/mfa/recovery-codes", { body: { password: PASSWORD, secondFactor: sf }, headers: bearer(jwt) });
  assert.equal(ok.status, 200);
  assert.equal(passkeys[0].signCount, 1n);
  const replay = await call(recoveryRoute.POST as never, "/api/profile/mfa/recovery-codes", { body: { password: PASSWORD, secondFactor: sf }, headers: bearer(jwt) });
  assert.equal(replay.status, 400, "the step-up challenge is single-use");
});

test("M1: a passkey registration token minted on the password alone is refused once the account has gained a factor", async () => {
  const u = await seedUser();
  const jwt = await sessionFor(u);
  const opts = await call(passkeyOptions.POST as never, "/api/profile/mfa/passkeys/options", { body: { password: PASSWORD }, headers: bearer(jwt) });
  assert.equal(opts.status, 200, "first factor: password-only");
  const { registrationToken, publicKey } = await opts.json();
  seedTotp(u.id as string); // meanwhile, 2FA appears
  const credential = registrationResponse({ auth: makeAuthenticator("EdDSA"), rpId: "localhost", origin: "http://localhost:3000", challenge: publicKey.challenge });
  const res = await call(passkeyRegister.POST as never, "/api/profile/mfa/passkeys", { body: { registrationToken, name: "x", credential }, headers: bearer(jwt) });
  assert.equal(res.status, 400);
  assert.equal(passkeys.length, 0);
});

test("M1: a passkey becoming the FIRST factor discards a pending authenticator secret issued on the password alone", async () => {
  const u = await seedUser();
  const jwt = await sessionFor(u);
  const setup = await call(totpSetup.POST as never, "/api/profile/mfa/totp/setup", { body: { password: PASSWORD }, headers: bearer(jwt) });
  assert.equal(setup.status, 200);
  const { secret } = await setup.json();
  const opts = await (await call(passkeyOptions.POST as never, "/api/profile/mfa/passkeys/options", { body: { password: PASSWORD }, headers: bearer(jwt) })).json();
  const credential = registrationResponse({ auth: makeAuthenticator("EdDSA"), rpId: "localhost", origin: "http://localhost:3000", challenge: opts.publicKey.challenge });
  assert.equal((await call(passkeyRegister.POST as never, "/api/profile/mfa/passkeys", { body: { registrationToken: opts.registrationToken, name: "k", credential }, headers: bearer(jwt) })).status, 200);
  assert.equal(totps.length, 0, "the password-only pending secret is gone");
  const code = hotp(base32Decode(secret)!, totpStep(Date.now()));
  const enable = await call(totpEnable.POST as never, "/api/profile/mfa/totp/enable", { body: { code }, headers: bearer(jwt) });
  assert.equal(enable.status, 400, "it can't be confirmed onto the now-2FA account without a step-up'd setup");
});

// ── M2: persistent second-factor lockout ────────────────────────────────────

// What a process restart does to the in-memory state: the per-account bucket
// and the challenge-token ledger are gone; the DB counter is not.
function simulateRestart(u: Row): void {
  for (let i = 0; i < 50; i++) refundHit(`mfa-user:${u.id}`);
  resetMfaTokenLedgerForTests();
}

async function wrongCodes(u: Row, n: number, wrong = "000000"): Promise<number[]> {
  const statuses: number[] = [];
  let ch = await challengeFor(u);
  for (let i = 0; i < n; i++) {
    if (i > 0 && i % 4 === 0) ch = await challengeFor(u); // stay under the per-token burn
    IP = `192.0.2.${(++ipSeq % 250) + 1}`;
    statuses.push((await mfa({ mfaToken: ch.mfaToken, method: "totp", code: wrong })).status);
  }
  return statuses;
}

test("M2: the 10th consecutive wrong code locks code sign-in; a correct code is then refused (429) WITHOUT being consumed", async () => {
  const u = await seedUser();
  const key = seedTotp(u.id as string);
  seedRecoveryCodes(u.id as string, ["AAAA-BBBB-CCCC-DDDD"]);
  const wrong = currentCode(key) === "000000" ? "111111" : "000000";
  const statuses = await wrongCodes(u, MFA_LOCKOUT_THRESHOLD, wrong);
  assert.deepEqual(statuses, [...Array(MFA_LOCKOUT_THRESHOLD - 1).fill(401), 429]);
  assert.ok(u.mfaLockedUntil instanceof Date);
  const ms = (u.mfaLockedUntil as Date).getTime() - Date.now();
  assert.ok(ms > 14 * 60_000 && ms <= 15 * 60_000, `first lockout is 15 minutes, got ${ms}`);
  assert.equal(u.mfaLockoutCount, 1);
  assert.equal(u.mfaFailedAttempts, 0, "the counter restarts after imposing");

  simulateRestart(u); // the lockout lives in the DB, not the process
  IP = "192.0.2.251";
  const right = await mfa({ mfaToken: (await challengeFor(u)).mfaToken, method: "totp", code: currentCode(key) });
  assert.equal(right.status, 429, "even the correct code is refused while locked");
  assert.deepEqual(await right.json(), { error: MFA_LOCKED_MESSAGE });
  assert.equal(totps[0].lastUsedStep, null, "the correct code was not checked, so it was not burned");
  const rec = await mfa({ mfaToken: (await challengeFor(u)).mfaToken, method: "recovery", code: "AAAA-BBBB-CCCC-DDDD" });
  assert.equal(rec.status, 429);
  assert.equal(codes[0].usedAt, null, "the recovery code was not spent");
  assert.equal(sessionWrites, 0);
  await new Promise((r) => setImmediate(r));
  const lockouts = audit.filter((a) => a.action === "AUTH_LOGIN_FAILED" && JSON.parse(a.details as string).reason === "mfa_lockout");
  assert.equal(lockouts.length, 1, "the lockout is audited exactly once");

  // Lockout over ⇒ codes work again.
  u.mfaLockedUntil = new Date(Date.now() - 1000);
  const after = await mfa({ mfaToken: (await challengeFor(u)).mfaToken, method: "totp", code: currentCode(key) });
  assert.equal(after.status, 200);
});

test("M2: a correct code resets the consecutive-failure counter", async () => {
  const u = await seedUser();
  const key = seedTotp(u.id as string);
  const wrong = currentCode(key) === "000000" ? "111111" : "000000";
  await wrongCodes(u, MFA_LOCKOUT_THRESHOLD - 1, wrong);
  assert.equal(u.mfaFailedAttempts, MFA_LOCKOUT_THRESHOLD - 1);
  simulateRestart(u);
  IP = "192.0.2.252";
  assert.equal((await mfa({ mfaToken: (await challengeFor(u)).mfaToken, method: "totp", code: currentCode(key) })).status, 200);
  assert.equal(u.mfaFailedAttempts, 0);
  simulateRestart(u);
  const statuses = await wrongCodes(u, MFA_LOCKOUT_THRESHOLD - 1, wrong);
  assert.ok(statuses.every((s) => s === 401), "nine more misses do not lock — the count started over");
  assert.equal(u.mfaLockedUntil, null);
});

test("M2: lockouts escalate (15 min, doubling, capped at 24 h) and a second lockout lasts 30 minutes", async () => {
  assert.deepEqual([0, 1, 2, 3, 6, 7, 30].map((n) => lockoutDurationMs(n) / 60_000), [15, 30, 60, 120, 960, 1440, 1440]);
  const u = await seedUser({ mfaLockoutCount: 1, mfaLockedUntil: new Date(Date.now() - 60_000) });
  const key = seedTotp(u.id as string);
  await wrongCodes(u, MFA_LOCKOUT_THRESHOLD, currentCode(key) === "000000" ? "111111" : "000000");
  const ms = (u.mfaLockedUntil as Date).getTime() - Date.now();
  assert.ok(ms > 29 * 60_000 && ms <= 30 * 60_000, `second lockout is 30 minutes, got ${ms}`);
  assert.equal(u.mfaLockoutCount, 2);
});

test("M2: passkeys are exempt — a failed assertion never counts, a passkey still signs in DURING a lockout, and does not lift it", async () => {
  const u = await seedUser({ mfaLockedUntil: new Date(Date.now() + 10 * 60_000), mfaLockoutCount: 1 });
  const auth = seedPasskey(u.id);
  const ch = await challengeFor(u);
  const bad = assertionResponse({ auth: makeAuthenticator(), rpId: "localhost", origin: "http://localhost:3000", challenge: ch.webauthn!.challenge, signCount: 1 });
  assert.equal((await mfa({ mfaToken: ch.mfaToken, method: "webauthn", credential: bad })).status, 401);
  assert.equal(u.mfaFailedAttempts, 0, "a failed assertion is not a guess");
  const good = assertionResponse({
    auth, rpId: "localhost", origin: "http://localhost:3000", challenge: ch.webauthn!.challenge, signCount: 1,
    userHandle: webAuthnUserHandle(u.id as string),
  });
  assert.equal((await mfa({ mfaToken: ch.mfaToken, method: "webauthn", credential: good })).status, 200);
  assert.ok((u.mfaLockedUntil as Date).getTime() > Date.now(), "the code lockout still stands");
  assert.equal(u.mfaLockoutCount, 1);
});

test("M2: a wrong code at the ENROLLMENT step-up spends the same persistent budget, and a lockout refuses it there too", async () => {
  const u = await seedUser();
  const jwt = await sessionFor(u);
  const key = seedTotp(u.id as string);
  const wrong = currentCode(key) === "000000" ? "111111" : "000000";
  const res = await call(recoveryRoute.POST as never, "/api/profile/mfa/recovery-codes", { body: { password: PASSWORD, secondFactor: { method: "totp", code: wrong } }, headers: bearer(jwt) });
  assert.equal(res.status, 400);
  assert.equal(u.mfaFailedAttempts, 1);
  u.mfaLockedUntil = new Date(Date.now() + 60_000);
  const locked = await call(recoveryRoute.POST as never, "/api/profile/mfa/recovery-codes", { body: { password: PASSWORD, secondFactor: { method: "totp", code: currentCode(key) } }, headers: bearer(jwt) });
  assert.equal(locked.status, 429);
});

// ── L6: one challenge, one factor spend ─────────────────────────────────────

test("L6: two PARALLEL requests on one challenge can't both spend a recovery code — the second is refused before verifying", async () => {
  const u = await seedUser();
  seedTotp(u.id as string);
  seedRecoveryCodes(u.id as string, ["ABCD-EFGH-JKLM-NPQR", "STUV-WXYZ-2345-6789"]);
  const ch = await challengeFor(u);
  let open!: () => void;
  let a: Response;
  let b: Response;
  codeGate = new Promise((r) => { open = r; });
  try {
    const pa = mfa({ mfaToken: ch.mfaToken, method: "recovery", code: "ABCD-EFGH-JKLM-NPQR" });
    const pb = mfa({ mfaToken: ch.mfaToken, method: "recovery", code: "STUV-WXYZ-2345-6789" });
    // Both are now in flight; whoever reached the verifier is parked at the gate.
    await new Promise((r) => setTimeout(r, 50));
    open();
    [a, b] = await Promise.all([pa, pb]);
  } finally {
    codeGate = null;
  }
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(codes.filter((c) => c.usedAt != null).length, 1, "exactly one recovery code was spent");
  assert.equal(sessionWrites, 1);
});

test("L6: parallel WRONG answers on one challenge are each counted — the token still burns at MAX_TOKEN_FAILURES", async () => {
  const u = await seedUser();
  const key = seedTotp(u.id as string);
  const wrong = currentCode(key) === "000000" ? "111111" : "000000";
  const ch = await challengeFor(u);
  let counted = 0;
  for (let i = 0; i < MAX_TOKEN_FAILURES; i++) {
    const res = await Promise.all([mfa({ mfaToken: ch.mfaToken, method: "totp", code: wrong }), mfa({ mfaToken: ch.mfaToken, method: "totp", code: wrong })]);
    counted += res.filter((r) => r.status === 401).length;
    if (counted >= MAX_TOKEN_FAILURES) break;
  }
  const res = await mfa({ mfaToken: ch.mfaToken, method: "totp", code: currentCode(key) });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).mfaExpired, true, "burned");
});

// ── L1 / L4 ─────────────────────────────────────────────────────────────────

test("L1: the password fingerprint is keyed by an HKDF subkey, NOT the raw session secret", () => {
  const raw = createHmac("sha256", process.env.NEXTAUTH_SECRET!).update("summonarr-pwv:v1:some-hash").digest("base64url").slice(0, 32);
  assert.notEqual(passwordVersion("some-hash"), raw);
  assert.equal(passwordVersion("some-hash"), passwordVersion("some-hash"));
  assert.notEqual(passwordVersion("some-hash"), passwordVersion("other-hash"));
});

test("L4: recovery-code writes take the per-user MFA advisory lock BEFORE counting", async () => {
  const order: string[] = [];
  const tx = {
    $executeRawUnsafe: async (sql: string) => { order.push(sql); return 1; },
    mfaRecoveryCode: {
      count: async () => { order.push("count"); return 0; },
      deleteMany: async () => { order.push("deleteMany"); return { count: 0 }; },
      createMany: async () => { order.push("createMany"); return { count: 10 }; },
    },
  };
  const out = await ensureRecoveryCodesInTx(tx as never, "user-x");
  assert.equal(out!.length, 10);
  assert.match(order[0], new RegExp(`^SELECT pg_advisory_xact_lock\\(${MFA_USER_LOCK_NAMESPACE}, ${mfaUserLockKey("user-x")}\\)$`));
  assert.equal(order[1], "count", "the count runs under the lock");
  assert.ok(mfaUserLockKey("user-x") >= 0 && mfaUserLockKey("user-x") <= 0x7fffffff, "fits the (int, int) overload");
});

test("GET /api/profile/mfa reports status and never a secret", async () => {
  const u = await seedUser();
  const jwt = await sessionFor(u);
  seedTotp(u.id as string);
  const res = await call(profileMfa.GET as never, "/api/profile/mfa", { method: "GET", headers: bearer(jwt) });
  const body = await res.json();
  assert.equal(body.available, true);
  assert.equal(body.enabled, true);
  assert.equal(body.totpEnabled, true);
  assert.ok(!JSON.stringify(body).includes(totps[0].secret as string));
});

// ── admin reset ─────────────────────────────────────────────────────────────

test("admin reset: removes every factor, signs the target out everywhere, audits MFA_RESET", async () => {
  const admin = await seedUser({ role: "ADMIN" });
  const target = await seedUser();
  const adminJwt = await sessionFor(admin);
  await sessionFor(target);
  seedTotp(target.id as string);
  seedRecoveryCodes(target.id as string, ["AAAA-BBBB-CCCC-DDDD"]);
  const res = await call(adminReset.DELETE as never, `/api/admin/users/${target.id}/mfa`, {
    method: "DELETE", headers: bearer(adminJwt), ctx: { params: Promise.resolve({ id: target.id }) },
  });
  assert.equal(res.status, 200);
  assert.deepEqual([totps.length, codes.length], [0, 0]);
  assert.equal(sessions.filter((s) => s.userId === target.id).length, 0);
  assert.ok((target.sessionsRevokedAt as Date) instanceof Date, "cutoff stamped (revokeAllUserSessions)");
  await new Promise((r) => setImmediate(r));
  assert.ok(audit.some((a) => a.action === "MFA_RESET" && a.target === `user:${target.id}`));
  assert.equal((await credentialsSignInStep(target)).status, 200, "next sign-in is password-only");
});

test("admin reset: needs MANAGE_USERS, an ADMIN target needs the ADMIN bit, and never the caller's own account", async () => {
  const admin = await seedUser({ role: "ADMIN" });
  const manager = await seedUser({ role: "USER", permissions: Permission.MANAGE_USERS });
  const plain = await seedUser();
  const victimAdmin = await seedUser({ role: "ADMIN" });
  seedTotp(victimAdmin.id as string);
  const ctx = (id: unknown) => ({ params: Promise.resolve({ id }) });

  const asPlain = await call(adminReset.DELETE as never, `/api/admin/users/${victimAdmin.id}/mfa`, { method: "DELETE", headers: bearer(await sessionFor(plain)), ctx: ctx(victimAdmin.id) });
  assert.equal(asPlain.status, 403);
  const asManager = await call(adminReset.DELETE as never, `/api/admin/users/${victimAdmin.id}/mfa`, { method: "DELETE", headers: bearer(await sessionFor(manager)), ctx: ctx(victimAdmin.id) });
  assert.equal(asManager.status, 403, "a delegated user manager can't strip an admin's second factor");
  const self = await call(adminReset.DELETE as never, `/api/admin/users/${admin.id}/mfa`, { method: "DELETE", headers: bearer(await sessionFor(admin)), ctx: ctx(admin.id) });
  assert.equal(self.status, 400);
  assert.equal(totps.length, 1, "nothing was removed");
});

test("L2: a target promoted to ADMIN while the reset is in flight is refused — the role is re-read under advisory lock 42", async () => {
  const manager = await seedUser({ role: "USER", permissions: Permission.MANAGE_USERS });
  const target = await seedUser();
  seedTotp(target.id as string);
  // The promotion lands exactly while the reset waits for lock 42.
  onRaw = (sql) => { if (sql === "SELECT pg_advisory_xact_lock(42)") target.role = "ADMIN"; };
  const res = await call(adminReset.DELETE as never, `/api/admin/users/${target.id}/mfa`, {
    method: "DELETE", headers: bearer(await sessionFor(manager)), ctx: { params: Promise.resolve({ id: target.id }) },
  });
  assert.equal(res.status, 403);
  assert.ok(rawSql.includes("SELECT pg_advisory_xact_lock(42)"));
  assert.equal(totps.length, 1, "the admin's factor survives");
});

test("admin reset also clears a persistent code lockout (the lost-phone case)", async () => {
  const admin = await seedUser({ role: "ADMIN" });
  const target = await seedUser({ mfaLockedUntil: new Date(Date.now() + 3_600_000), mfaLockoutCount: 3, mfaFailedAttempts: 4 });
  seedTotp(target.id as string);
  const res = await call(adminReset.DELETE as never, `/api/admin/users/${target.id}/mfa`, {
    method: "DELETE", headers: bearer(await sessionFor(admin)), ctx: { params: Promise.resolve({ id: target.id }) },
  });
  assert.equal(res.status, 200);
  assert.deepEqual([target.mfaLockedUntil, target.mfaLockoutCount, target.mfaFailedAttempts], [null, 0, 0]);
});
