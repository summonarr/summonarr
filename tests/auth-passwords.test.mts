// Route-level tests for the password half of the 2026-10-17 auth audit's Wave 3
// (guardrail 6i):
//
//   1. REHASH — a successful credentials sign-in upgrades a hash written with
//      older parameters (legacy scrypt:1) to the current scrypt:2 cost, AWAITED
//      before the two-factor challenge is minted (its `pwv` fingerprints the
//      stored hash), as a CAS on the verified hash, revoking nothing.
//   2. LOCKOUT NOTICE — when the per-account sign-in bucket (`login-email:`) is
//      exhausted, the owner is mailed ONCE per window however many attempts
//      follow, and the caller's response is exactly what it was.
//   3. PASSWORD CHANGE ON A 2FA ACCOUNT — PATCH /api/profile/password needs a
//      fresh second factor (`secondFactor`, the enrollment routes' shape and
//      400 contract), checked only after the password verified; an account
//      without 2FA is byte-identical; a native session gets no exemption.
//
// Harness (the tests/mfa-routes.test.mts idiom): real handlers, genuine signed
// session JWTs, a synthetic Next request scope, in-memory prisma stubs with the
// conditional-update semantics the code relies on, a DNS stub and a recording
// fetch that answers for Resend (the lockout notice's transport). No DB, no
// network. Password hashes are real scrypt.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { scrypt as scryptCb, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import dns from "node:dns/promises";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ef".repeat(32);
process.env.NEXTAUTH_SECRET = "auth-passwords-test-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const errors: string[] = [];
const warns: string[] = [];
console.error = (...a: unknown[]) => { errors.push(a.map(String).join(" ")); };
console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };

const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) {
  throw new Error("could not stub dns.lookup — aborting before a real DNS query can leave the process");
}

// Every outbound call is recorded; only api.resend.com answers.
const sent: Array<{ host: string; body: { to: string; subject: string; html: string } }> = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname !== "api.resend.com") throw new Error(`unexpected fetch to ${url.hostname}`);
  sent.push({ host: url.hostname, body: JSON.parse(String(init?.body ?? "{}")) });
  return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
}) as typeof fetch;

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
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { hashPassword, verifyPassword, needsRehash, LEGACY_V1_PARAMS } = await import("../src/lib/password-hash.ts");
const { base32Decode, generateTotpSecret, hotp, totpStep } = await import("../src/lib/mfa/totp.ts");
const { hashRecoveryCode, normalizeRecoveryCode } = await import("../src/lib/mfa/recovery-codes.ts");
const { webAuthnUserHandle } = await import("../src/lib/mfa/mfa-store.ts");
const { resetMfaTokenLedgerForTests } = await import("../src/lib/mfa/mfa-token.ts");
const { reserveRateLimit, ipBucketKey } = await import("../src/lib/rate-limit.ts");
const { hashAuditEmail } = await import("../src/lib/auth.ts");
const {
  accountSecurityMessage,
  claimSignInLockoutNotice,
  resetSignInLockoutNoticesForTests,
  MAX_LOCKOUT_NOTICES,
} = await import("../src/lib/account-security-notify.ts");
const { NEVER_EXPIRES_AT_SEC } = await import("../src/lib/session-lifetime.ts");
const { assertionResponse, makeAuthenticator } = await import("./_webauthn-fixtures.mts");

const EN_API_AUTH = JSON.parse(readFileSync(new URL("../src/lib/i18n/messages/en/apiAuth.json", import.meta.url), "utf8")) as Record<string, string>;
const EN_NOTIFY = JSON.parse(readFileSync(new URL("../src/lib/i18n/messages/en/notify.json", import.meta.url), "utf8")) as Record<string, string>;

// ── in-memory store ─────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

function matches(row: Row, where: Where | undefined): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    const v = row[k];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as { not?: unknown; lt?: number | Date; gt?: number | Date; gte?: number | Date };
      if ("not" in c && (c.not === null ? v == null : v === c.not)) return false;
      const num = (x: unknown) => (x instanceof Date ? x.getTime() : typeof x === "number" ? x : NaN);
      if ("lt" in c && !(v != null && num(v) < num(c.lt))) return false;
      if ("gt" in c && !(v != null && num(v) > num(c.gt))) return false;
      if ("gte" in c && !(v != null && num(v) >= num(c.gte))) return false;
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

function applyData(row: Row, data: Row): void {
  for (const [k, v] of Object.entries(data)) {
    if (v !== null && typeof v === "object" && !(v instanceof Date) && "increment" in (v as Row)) {
      row[k] = (row[k] as number) + (v as { increment: number }).increment;
    } else {
      row[k] = v;
    }
  }
}

let users: Row[] = [];
let totps: Row[] = [];
let codes: Row[] = [];
let passkeys: Row[] = [];
let sessions: Row[] = [];
let settings = new Map<string, string>();
let audit: Row[] = [];
// Every write that sets User.passwordHash, in order.
let hashWrites: Array<{ via: string; where: Where; hash: string }> = [];
// Lets a test land a concurrent write "inside" the rehash, or make it fail.
let beforeUserUpdateMany: ((where: Where, data: Row) => void) | null = null;
// Every user lookup, by its where clause.
let userReads: Where[] = [];
let seq = 0;

shadowPrismaModel(prisma, "user", {
  findUnique: async ({ where }: { where: Where }) => {
    userReads.push(where);
    const u = users.find((x) => matches(x, where));
    return u ? { ...u } : null;
  },
  findFirst: async ({ where }: { where?: Where } = {}) => users.find((u) => matches(u, where)) ?? null,
  update: async ({ where, data }: { where: Where; data: Row }) => {
    const u = users.find((x) => matches(x, where));
    if (!u) throw Object.assign(new Error("Record not found"), { name: "PrismaClientKnownRequestError", code: "P2025" });
    if (typeof data.passwordHash === "string") hashWrites.push({ via: "update", where, hash: data.passwordHash });
    applyData(u, data);
    return u;
  },
  updateMany: async ({ where, data }: { where: Where; data: Row }) => {
    beforeUserUpdateMany?.(where, data);
    const hit = users.filter((u) => matches(u, where));
    if (typeof data.passwordHash === "string") hashWrites.push({ via: "updateMany", where, hash: data.passwordHash });
    for (const u of hit) applyData(u, data);
    return { count: hit.length };
  },
  findMany: async () => [],
  count: async () => users.length,
});
shadowPrismaModel(prisma, "userTotp", {
  findUnique: async ({ where }: { where: Where }) => totps.find((t) => matches(t, where)) ?? null,
  updateMany: async ({ where, data }: { where: Where; data: Row }) => {
    const hit = totps.filter((t) => matches(t, where));
    for (const t of hit) Object.assign(t, data);
    return { count: hit.length };
  },
});
shadowPrismaModel(prisma, "mfaRecoveryCode", {
  findMany: async ({ where }: { where: Where }) => codes.filter((c) => matches(c, where)),
  count: async ({ where }: { where: Where }) => codes.filter((c) => matches(c, where)).length,
  updateMany: async ({ where, data }: { where: Where; data: Row }) => {
    const hit = codes.filter((c) => matches(c, where));
    for (const c of hit) Object.assign(c, data);
    return { count: hit.length };
  },
});
shadowPrismaModel(prisma, "webAuthnCredential", {
  findMany: async ({ where }: { where?: Where } = {}) => passkeys.filter((p) => matches(p, where)),
  findFirst: async ({ where }: { where: Where }) => passkeys.find((p) => matches(p, where)) ?? null,
  updateMany: async ({ where, data }: { where: Where; data: Row }) => {
    const hit = passkeys.filter((p) => matches(p, where));
    for (const p of hit) Object.assign(p, data);
    return { count: hit.length };
  },
});
shadowPrismaModel(prisma, "authSession", {
  findUnique: async ({ where }: { where: Where }) => sessions.find((s) => matches(s, where)) ?? null,
  findMany: async ({ where }: { where: Where }) => sessions.filter((s) => matches(s, where)),
  upsert: async ({ create }: { create: Row }) => {
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
for (const model of ["pushSubscription", "discordLinkToken", "discordMergeCode", "verificationToken"]) {
  shadowPrismaModel(prisma, model, { deleteMany: async () => ({ count: 0 }) });
}
shadowPrismaModel(prisma, "setting", {
  findUnique: async ({ where }: { where: { key: string } }) =>
    settings.has(where.key) ? { key: where.key, value: settings.get(where.key)! } : null,
  findMany: async ({ where }: { where?: { key?: { in?: string[] } } } = {}) =>
    (where?.key?.in ?? [...settings.keys()])
      .filter((k) => settings.has(k))
      .map((k) => ({ key: k, value: settings.get(k)! })),
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
shadowPrismaClientMethod(prisma, "$executeRawUnsafe", async () => 1);

const credentialsRoute = await import("../src/app/api/auth/sign-in/credentials/route.ts");
const mfaRoute = await import("../src/app/api/auth/sign-in/mfa/route.ts");
const passwordRoute = await import("../src/app/api/profile/password/route.ts");
const stepUpChallenge = await import("../src/app/api/profile/mfa/challenge/route.ts");

// ── request plumbing ────────────────────────────────────────────────────────

function inScope<T>(headers: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const workStore = { route: "/auth-passwords.test", forceStatic: false, dynamicShouldError: false, afterContext: { after: () => {} } };
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
let IP = "203.0.113.1";
const nextIp = () => `198.51.${Math.floor(++ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;

async function call(
  handler: (req: InstanceType<typeof NextRequest>, ctx: unknown) => Promise<Response>,
  path: string,
  opts: { method?: string; body?: unknown; headers?: Record<string, string>; ip?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json", "x-forwarded-for": opts.ip ?? IP, "user-agent": "Mozilla/5.0 test", ...opts.headers,
  };
  const req = new NextRequest(`http://localhost:3000${path}`, {
    method: opts.method ?? "POST",
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  return inScope(headers, () => handler(req, undefined));
}

const PASSWORD = "correct-horse-battery";
const NEW_PASSWORD = "an-entirely-new-passphrase";
const HASH = await hashPassword(PASSWORD); // one real scrypt at load, reused

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;
// A hash exactly as a pre-6i build stored it: scrypt:1, 2^15/8/1, no parameters.
async function legacyHash(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64, { N: 2 ** LEGACY_V1_PARAMS.ln, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt:1:${salt.toString("base64")}:${key.toString("base64")}`;
}

async function seedUser(over: Row = {}): Promise<Row> {
  const id = `user-${++seq}`;
  const u: Row = {
    id, email: `${id}@example.com`, name: `User ${seq}`, role: "USER", permissions: 0n,
    passwordHash: HASH, mediaServer: null, locale: null, discordId: null,
    sessionsRevokedAt: null, passwordChangedAt: null, deactivatedAt: null, notificationEmail: null,
    mfaFailedAttempts: 0, mfaLockoutCount: 0, mfaLockedUntil: null,
    ...over,
  };
  users.push(u);
  return u;
}
const row = (u: Row) => users.find((x) => x.id === u.id)!;

function seedTotp(userId: unknown): Buffer {
  const secret = generateTotpSecret();
  totps.push({ userId, secret, enabledAt: new Date(), lastUsedStep: null, updatedAt: new Date() });
  return base32Decode(secret)!;
}
const currentCode = (key: Buffer) => hotp(key, totpStep(Date.now()));
const wrongCode = (key: Buffer) => (currentCode(key) === "000000" ? "111111" : "000000");

function seedRecoveryCodes(userId: unknown, plain: string[]): void {
  for (const c of plain) codes.push({ id: `rc-${++seq}`, userId, codeHash: hashRecoveryCode(normalizeRecoveryCode(c)!), usedAt: null });
}

function seedPasskey(userId: unknown): ReturnType<typeof makeAuthenticator> {
  const auth = makeAuthenticator("ES256");
  passkeys.push({
    id: `pk-${++seq}`, userId, credentialId: auth.credentialId.toString("base64url"),
    publicKey: auth.coseKey.toString("base64url"), signCount: 0n, transports: ["usb"], name: "Key",
    createdAt: new Date(), lastUsedAt: null, backedUp: false,
  });
  return auth;
}

async function sessionFor(user: Row, opts: { native?: boolean } = {}): Promise<string> {
  const sessionId = `sess-${++seq}`;
  sessions.push({ sessionId, userId: user.id, expiresAt: new Date(Date.now() + 86_400_000) });
  const iat = Math.floor(Date.now() / 1000);
  return signSessionJwt(
    {
      id: user.id as string, role: user.role as string, permissions: (user.permissions as bigint).toString(),
      provider: "credentials", sessionId, expiresAt: opts.native ? NEVER_EXPIRES_AT_SEC : iat + 86_400,
    },
    { expiresInSeconds: 7_200, iat },
  );
}
const bearer = (jwt: string) => ({ authorization: `Bearer ${jwt}` });

function signIn(user: Row, password = PASSWORD, ip?: string) {
  return call(credentialsRoute.POST as never, "/api/auth/sign-in/credentials", { body: { email: user.email, password }, ip });
}

function changePassword(jwt: string, extra: Row = {}, current = PASSWORD) {
  return call(passwordRoute.PATCH as never, "/api/profile/password", {
    method: "PATCH",
    body: { currentPassword: current, newPassword: NEW_PASSWORD, ...extra },
    headers: bearer(jwt),
  });
}

function configureEmail(): void {
  settings.set("enableUserEmails", "true");
  settings.set("emailBackend", "resend");
  settings.set("resendApiKey", "re_test_key");
  settings.set("resendFrom", "Summonarr <noreply@example.com>");
}

// The lockout notice is sent detached (`void`); give it every chance to land.
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
}

const LOGIN_LIMIT = 50;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
// Spends `n` of an account's sign-in budget directly (each would otherwise be a
// full scrypt verify of a wrong password).
function spendLoginBudget(email: string, n: number): void {
  for (let i = 0; i < n; i++) {
    assert.notEqual(reserveRateLimit(`login-email:${hashAuditEmail(email)}`, LOGIN_LIMIT, LOGIN_WINDOW_MS), null);
  }
}

beforeEach(() => {
  users = []; totps = []; codes = []; passkeys = []; sessions = []; audit = []; hashWrites = []; userReads = [];
  beforeUserUpdateMany = null;
  settings = new Map([["setup_completed_at", "2026-01-01T00:00:00.000Z"]]);
  sent.length = 0;
  errors.length = 0;
  IP = nextIp();
  resetMfaTokenLedgerForTests();
  resetSignInLockoutNoticesForTests();
});

// ═══ 1. rehash on sign-in ═══════════════════════════════════════════════════

test("a legacy scrypt:1 hash is upgraded to the current format on a successful sign-in, revoking nothing", async () => {
  const u = await seedUser({ passwordHash: await legacyHash(PASSWORD) });
  const res = await signIn(u);
  assert.equal(res.status, 200, await res.clone().text());

  const stored = row(u).passwordHash as string;
  assert.match(stored, /^scrypt:2:17:8:1:/);
  assert.equal(needsRehash(stored), false);
  assert.equal(await verifyPassword(PASSWORD, stored), true, "the SAME password, at the new cost");
  // Not a password change: no cutoffs, the new session survives.
  assert.equal(row(u).passwordChangedAt, null);
  assert.equal(row(u).sessionsRevokedAt, null);
  assert.equal(sessions.filter((s) => s.userId === u.id).length, 1);
  assert.deepEqual(errors, []);
});

test("a current-format hash is never rewritten, and a FAILED sign-in on a legacy hash rehashes nothing", async () => {
  const current = await seedUser();
  assert.equal((await signIn(current)).status, 200);
  const legacy = await seedUser({ passwordHash: await legacyHash(PASSWORD) });
  const before = row(legacy).passwordHash;
  assert.equal((await signIn(legacy, "not-the-password")).status, 401);
  assert.deepEqual(hashWrites, []);
  assert.equal(row(current).passwordHash, HASH);
  assert.equal(row(legacy).passwordHash, before);
});

test("2FA + legacy hash: the rehash lands BEFORE the challenge is minted, so the second step still succeeds", async () => {
  // The challenge carries a fingerprint of the stored hash (pwv). A rehash that
  // landed after it was minted would make the MFA step read as "password
  // changed" and fail the owner's first sign-in after the upgrade.
  const u = await seedUser({ passwordHash: await legacyHash(PASSWORD) });
  const key = seedTotp(u.id);
  const step1 = await signIn(u);
  assert.equal(step1.status, 401);
  const challenge = await step1.json();
  assert.equal(challenge.mfaRequired, true);
  assert.match(row(u).passwordHash as string, /^scrypt:2:/, "upgraded during the password step");

  const step2 = await call(mfaRoute.POST as never, "/api/auth/sign-in/mfa", {
    body: { mfaToken: challenge.mfaToken, method: "totp", code: currentCode(key) },
  });
  assert.equal(step2.status, 200, await step2.clone().text());
});

test("the rehash is a CAS on the verified hash: a password change landing in between is never overwritten", async () => {
  const u = await seedUser({ passwordHash: await legacyHash(PASSWORD) });
  const changedMeanwhile = await hashPassword("set-by-a-concurrent-change");
  beforeUserUpdateMany = (where, data) => {
    if (typeof data.passwordHash === "string" && where.id === u.id) row(u).passwordHash = changedMeanwhile;
  };
  assert.equal((await signIn(u)).status, 200);
  assert.equal(row(u).passwordHash, changedMeanwhile);
});

test("a failed rehash write is logged and the sign-in still succeeds on the old hash", async () => {
  const legacy = await legacyHash(PASSWORD);
  const u = await seedUser({ passwordHash: legacy });
  beforeUserUpdateMany = (_where, data) => {
    if (typeof data.passwordHash === "string") throw new Error("db down");
  };
  const res = await signIn(u);
  assert.equal(res.status, 200);
  assert.equal(row(u).passwordHash, legacy);
  assert.ok(errors.some((e) => e.includes("[auth] password rehash failed") && e.includes("db down")), errors.join("\n"));
});

// ═══ 2. lockout notice ══════════════════════════════════════════════════════

const lockoutMails = () => sent.filter((m) => m.body.subject === EN_NOTIFY["notify.account.subject"] && m.body.html.includes("paused"));

test("the wrong password that EXHAUSTS the account's sign-in budget mails the owner — once, however many attempts follow", async () => {
  configureEmail();
  const u = await seedUser({ notificationEmail: "owner@example.com" });
  spendLoginBudget(u.email as string, LOGIN_LIMIT - 3);

  // A wrong password that leaves budget is an ordinary typo: no mail.
  assert.equal((await signIn(u, "wrong-guess-48", nextIp())).status, 401);
  await settle();
  assert.equal(lockoutMails().length, 0, "not exhausted yet");

  // The last two guesses land together; both fail and both see the bucket full.
  const last = await Promise.all([signIn(u, "wrong-guess-49", nextIp()), signIn(u, "wrong-guess-50", nextIp())]);
  assert.ok(last.every((r) => r.status === 401));
  await settle();
  assert.equal(lockoutMails().length, 1, "mailed as soon as the budget ran out, and only once");
  const mail = lockoutMails()[0].body;
  assert.equal(mail.to, "owner@example.com");
  assert.ok(mail.html.includes(EN_NOTIFY["notify.account.lockedHeading"]));
  assert.ok(mail.html.includes("15 minutes"), "the pause length is filled in");

  // A flood of further attempts from many addresses: each is refused at the
  // gate, none mails again.
  const flood = await Promise.all(Array.from({ length: 25 }, () => signIn(u, "more-guessing", nextIp())));
  assert.ok(flood.every((r) => r.status === 401));
  await settle();
  assert.equal(lockoutMails().length, 1);
});

test("a refused attempt answers exactly as before: same status and body as an unknown account, nothing extra", async () => {
  configureEmail();
  const u = await seedUser();
  spendLoginBudget(u.email as string, LOGIN_LIMIT - 1);
  spendLoginBudget("nobody@example.com", LOGIN_LIMIT);
  assert.equal((await signIn(u, "the-fiftieth-guess", nextIp())).status, 401);
  const known = await signIn(u, "anything", nextIp());
  const unknown = await call(credentialsRoute.POST as never, "/api/auth/sign-in/credentials", {
    body: { email: "nobody@example.com", password: "anything" }, ip: nextIp(),
  });
  assert.equal(known.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(await known.json(), await unknown.json());
  assert.deepEqual([...known.headers.keys()].sort(), [...unknown.headers.keys()].sort());
  await settle();
  assert.equal(lockoutMails().length, 1, "the owner is told; the caller learns nothing");
});

test("no notice for an unknown email, an SSO-only account or a disabled one", async () => {
  configureEmail();
  const sso = await seedUser({ passwordHash: null });
  const disabled = await seedUser({ deactivatedAt: new Date() });
  for (const email of ["ghost@example.com", sso.email as string, disabled.email as string]) {
    spendLoginBudget(email, LOGIN_LIMIT - 1);
    // The attempt that exhausts the budget (a failed verify or the dummy one)…
    await call(credentialsRoute.POST as never, "/api/auth/sign-in/credentials", { body: { email, password: "x" }, ip: nextIp() });
    // …and one refused after it.
    await call(credentialsRoute.POST as never, "/api/auth/sign-in/credentials", { body: { email, password: "x" }, ip: nextIp() });
  }
  await settle();
  assert.equal(sent.length, 0);
});

test("an attempt refused by the PER-IP limit never consulted the account bucket, so it neither mails nor burns the notice", async () => {
  configureEmail();
  const u = await seedUser();
  spendLoginBudget(u.email as string, LOGIN_LIMIT - 1);
  const ip = nextIp();
  for (let i = 0; i < 20; i++) assert.notEqual(reserveRateLimit(`login-ip:${ipBucketKey(ip)}`, 20, 5 * 60 * 1000), null);
  assert.equal((await signIn(u, "x", ip)).status, 401);
  await settle();
  assert.equal(lockoutMails().length, 0);
  // The account still has its last guess, and the notice is still unclaimed.
  assert.equal((await signIn(u, "x", nextIp())).status, 401);
  await settle();
  assert.equal(lockoutMails().length, 1);
});

test("a refused attempt reads nothing from the DB, notice included", async () => {
  // The notice is raised by the failed verify that spends the last guess, where
  // the row is already loaded — never by a refusal, which must stay DB-free.
  configureEmail();
  const u = await seedUser();
  spendLoginBudget(u.email as string, LOGIN_LIMIT);
  const flood = await Promise.all(Array.from({ length: 10 }, () => signIn(u, "x", nextIp())));
  assert.ok(flood.every((r) => r.status === 401));
  await settle();
  assert.deepEqual(userReads, []);
  assert.equal(lockoutMails().length, 0);
});

test("claimSignInLockoutNotice: one claim per key per window, and a full ledger of live claims refuses new keys", () => {
  const t0 = 1_000_000;
  assert.equal(claimSignInLockoutNotice("k", 1000, t0), true);
  assert.equal(claimSignInLockoutNotice("k", 1000, t0 + 999), false, "same window");
  assert.equal(claimSignInLockoutNotice("other", 1000, t0 + 1), true, "keys are independent");
  assert.equal(claimSignInLockoutNotice("k", 1000, t0 + 1000), true, "a new window");

  resetSignInLockoutNoticesForTests();
  for (let i = 0; i < MAX_LOCKOUT_NOTICES; i++) assert.equal(claimSignInLockoutNotice(`fill-${i}`, 1000, t0), true);
  assert.equal(claimSignInLockoutNotice("newcomer", 1000, t0 + 1), false, "full of live claims");
  assert.equal(claimSignInLockoutNotice("newcomer", 1000, t0 + 1000), true, "expired claims are swept to make room");
});

test("the lockout sentence lists no linked accounts (it is not a compromise response)", () => {
  const t = (key: string, vars?: Record<string, string | number>) =>
    vars ? `${key}(${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(",")})` : key;
  assert.equal(
    accountSecurityMessage(t, "sign-in-locked", { discordId: "123", traktUsername: "alice" }, { minutes: 15 }),
    "notify.account.event.sign-in-locked(minutes=15)",
  );
});

// ═══ 3. password change on a 2FA account ════════════════════════════════════

test("2FA account: the current password ALONE no longer changes the password — 400 secondFactorRequired, nothing written", async () => {
  const u = await seedUser();
  seedTotp(u.id);
  seedRecoveryCodes(u.id, ["AAAA-BBBB-CCCC-DDDD"]);
  const jwt = await sessionFor(u);

  const res = await changePassword(jwt);
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), {
    error: EN_API_AUTH["apiAuth.profile.secondFactorRequired"],
    secondFactorRequired: true,
    methods: ["totp", "recovery"],
  });
  assert.equal(row(u).passwordHash, HASH);
  assert.equal(row(u).passwordChangedAt, null);
  assert.equal(sessions.length, 1, "no session revoked");
  assert.deepEqual(hashWrites, []);
});

test("2FA account: password + a fresh TOTP code changes the password and revokes every session", async () => {
  const u = await seedUser();
  const key = seedTotp(u.id);
  const jwt = await sessionFor(u);
  const res = await changePassword(jwt, { secondFactor: { method: "totp", code: currentCode(key) } });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(await res.json(), { ok: true, requiresRelogin: true });
  assert.equal(await verifyPassword(NEW_PASSWORD, row(u).passwordHash as string), true);
  assert.ok(row(u).passwordChangedAt instanceof Date);
  assert.equal(sessions.length, 0);
  assert.notEqual(totps[0].lastUsedStep, null, "the code was spent");
});

test("2FA account: a wrong code is refused, counts toward the code lockout, and writes nothing", async () => {
  const u = await seedUser();
  const key = seedTotp(u.id);
  const jwt = await sessionFor(u);
  const res = await changePassword(jwt, { secondFactor: { method: "totp", code: wrongCode(key) } });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.secondFactorRequired, true);
  assert.equal(body.error, EN_API_AUTH["apiAuth.mfa.invalidCode"]);
  assert.equal(row(u).passwordHash, HASH);
  assert.equal(row(u).mfaFailedAttempts, 1, "the same persistent budget as sign-in");
});

test("2FA account: a WRONG current password is refused before the factor is touched — the code is not burned", async () => {
  const u = await seedUser();
  const key = seedTotp(u.id);
  seedRecoveryCodes(u.id, ["AAAA-BBBB-CCCC-DDDD"]);
  const jwt = await sessionFor(u);

  const badTotp = await changePassword(jwt, { secondFactor: { method: "totp", code: currentCode(key) } }, "wrong-password-here");
  assert.equal(badTotp.status, 400);
  assert.equal((await badTotp.json()).error, EN_API_AUTH["apiAuth.common.invalidPassword"]);
  assert.equal(totps[0].lastUsedStep, null, "TOTP step not consumed");
  const badRecovery = await changePassword(jwt, { secondFactor: { method: "recovery", code: "AAAA-BBBB-CCCC-DDDD" } }, "wrong-password-here");
  assert.equal(badRecovery.status, 400);
  assert.equal(codes[0].usedAt, null, "recovery code not consumed");
  assert.equal(row(u).mfaFailedAttempts, 0);

  const ok = await changePassword(jwt, { secondFactor: { method: "recovery", code: "aaaa bbbb cccc dddd" } });
  assert.equal(ok.status, 200, await ok.clone().text());
  // Re-read: the assert.equal(…, null) above narrowed the property's type.
  const usedAt: unknown = codes[0].usedAt;
  assert.ok(usedAt instanceof Date, "a recovery code used as proof is consumed");
});

test("2FA account: a passkey assertion over a step-up challenge works as the second factor", async () => {
  const u = await seedUser();
  const auth = seedPasskey(u.id);
  const jwt = await sessionFor(u);
  const ch = await call(stepUpChallenge.POST as never, "/api/profile/mfa/challenge", { body: {}, headers: bearer(jwt) });
  assert.equal(ch.status, 200);
  const { challengeToken, publicKey } = await ch.json();
  const credential = assertionResponse({
    auth, rpId: "localhost", origin: "http://localhost:3000", challenge: publicKey.challenge, signCount: 1,
    userHandle: webAuthnUserHandle(u.id as string),
  });
  const pwOnly = await changePassword(jwt);
  assert.deepEqual((await pwOnly.json()).methods, ["webauthn"]);
  const res = await changePassword(jwt, { secondFactor: { method: "webauthn", credential, challengeToken } });
  assert.equal(res.status, 200, await res.clone().text());
});

test("2FA account: a NATIVE (iOS) session gets the same 400 — no exemption, the native kind is the signer's choice", async () => {
  const u = await seedUser();
  seedTotp(u.id);
  const jwt = await sessionFor(u, { native: true });
  const res = await changePassword(jwt);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.secondFactorRequired, true);
  assert.match(body.error, /website/, "the shipped app shows `error`; it says where the change can be made");
  assert.equal(row(u).passwordHash, HASH);
});

test("2FA account under a code lockout: a code is refused with 429 and the password is unchanged", async () => {
  const u = await seedUser({ mfaLockedUntil: new Date(Date.now() + 10 * 60_000) });
  const key = seedTotp(u.id);
  const jwt = await sessionFor(u);
  const res = await changePassword(jwt, { secondFactor: { method: "totp", code: currentCode(key) } });
  assert.equal(res.status, 429);
  assert.equal(row(u).passwordHash, HASH);
});

test("an account WITHOUT 2FA is byte-identical: the password alone suffices and a stray secondFactor is ignored", async () => {
  for (const extra of [{}, { secondFactor: { method: "totp", code: "123456" } }]) {
    const u = await seedUser();
    const jwt = await sessionFor(u);
    const res = await changePassword(jwt, extra);
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(await res.json(), { ok: true, requiresRelogin: true });
    assert.match(row(u).passwordHash as string, /^scrypt:2:17:8:1:/, "a changed password is hashed at the current cost");
  }
});
