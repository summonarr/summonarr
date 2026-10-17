// Unit tests for src/lib/step-up-auth.ts and the account security notice
// wording (src/lib/account-security-notify.ts) — guardrail 6g.
//
// The property that matters most: every step-up PASSWORD check (sign out
// another device, sign out everywhere, delete the account, change the password,
// a two-factor enrollment change, link Discord, connect Trakt) draws on ONE
// per-account budget of failed guesses. Before, each route had its own bucket,
// so a stolen session could test passwords at ~11 a minute across them and no
// failure was audited. Route-level wiring is pinned in sessions-routes,
// discord-routes and profile-routes; this file pins the budget itself.
//
// No DB or network: prisma models are shadowed in-memory, the password hashes
// are real scrypt (one hash, reused).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "step-up-auth-test-secret-0123456789abcdef";
process.env.TRUST_PROXY = "true";
globalThis.fetch = (() => { throw new Error("unexpected network call"); }) as unknown as typeof fetch;
console.warn = () => {};

const { NextRequest } = await import("next/server");
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const { hashPassword } = await import("../src/lib/password-hash.ts");
const { verifyStepUpPassword, requireStepUp, isNativeSession, STEP_UP_PASSWORD_LIMIT, STEP_UP_MAX_AGE_MS } =
  await import("../src/lib/step-up-auth.ts");
const { accountSecurityMessage } = await import("../src/lib/account-security-notify.ts");
const { NEVER_EXPIRES_AT_SEC } = await import("../src/lib/session-lifetime.ts");

const PASSWORD = "correct-horse-battery";
const HASH = await hashPassword(PASSWORD);

let audits: Array<{ action: string; target: string; details: string | null }> = [];
shadowPrismaModel(prisma, "auditLog", {
  create: async (args: { data: { action: string; target: string; details: string | null } }) => {
    audits.push(args.data);
    return args.data;
  },
});
const users = new Map<string, { passwordHash: string | null }>();
const sessions = new Map<string, Date>();
shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id: string } }) => users.get(args.where.id) ?? null,
});
shadowPrismaModel(prisma, "authSession", {
  findUnique: async (args: { where: { sessionId: string } }) => {
    const createdAt = sessions.get(args.where.sessionId);
    return createdAt ? { createdAt } : null;
  },
});

const req = () => new NextRequest("http://localhost:3000/api/x", { method: "POST", headers: { "x-forwarded-for": "198.51.100.7" } });
const t = (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}(${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(",")})` : key;
const flush = () => new Promise((r) => setImmediate(r));

let seq = 0;
const freshUser = () => `user-${++seq}`;

beforeEach(() => { audits = []; });

test("ONE failed-guess budget per account across every step-up context — the 11th guess is refused even with the right password", async () => {
  const userId = freshUser();
  const contexts = ["session-revoke", "revoke-all", "account-delete", "password-change", "mfa-change", "discord-link", "trakt-connect"];
  for (let i = 0; i < STEP_UP_PASSWORD_LIMIT; i++) {
    const verdict = await verifyStepUpPassword({
      userId, userName: "u", passwordHash: HASH, password: `wrong-${i}`, context: contexts[i % contexts.length], req: req(),
    });
    assert.equal(verdict, "invalid");
  }
  const after = await verifyStepUpPassword({ userId, userName: "u", passwordHash: HASH, password: PASSWORD, context: "trakt-connect", req: req() });
  assert.equal(after, "rate-limited", "the budget is shared, so no route grants extra guesses");
  // Another account is unaffected.
  assert.equal(
    await verifyStepUpPassword({ userId: freshUser(), userName: "v", passwordHash: HASH, password: PASSWORD, context: "x", req: req() }),
    "ok",
  );
});

test("a CORRECT step-up password refunds its own hit — only failures spend the budget", async () => {
  const userId = freshUser();
  for (let i = 0; i < STEP_UP_PASSWORD_LIMIT + 5; i++) {
    const v = await verifyStepUpPassword({ userId, userName: "u", passwordHash: HASH, password: PASSWORD, context: "x", req: req() });
    assert.equal(v, "ok", `correct attempt ${i + 1}`);
  }
});

test("every failed step-up password is audited as AUTH_LOGIN_FAILED with its context; a success is not", async () => {
  const userId = freshUser();
  await verifyStepUpPassword({ userId, userName: "u", passwordHash: HASH, password: "nope", context: "discord-link", req: req() });
  await verifyStepUpPassword({ userId, userName: "u", passwordHash: HASH, password: PASSWORD, context: "discord-link", req: req() });
  await flush();
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "AUTH_LOGIN_FAILED");
  assert.equal(audits[0].target, "auth:step-up");
  assert.deepEqual(JSON.parse(audits[0].details ?? "{}"), { reason: "step_up_password", context: "discord-link" });
});

const session = (id: string, sessionId: string, tokenExpiresAt?: number) => ({
  user: { id, role: "USER", permissions: 0n, name: "u", email: "u@example.com" },
  sessionId,
  tokenExpiresAt,
});
const MSGS = { passwordRequired: "need-password", recentSignInRequired: "need-recent" };

test("requireStepUp: a password account gets password-required / invalid-password / pass", async () => {
  const id = freshUser();
  users.set(id, { passwordHash: HASH });
  const missing = await requireStepUp({ req: req(), session: session(id, "s"), confirmPassword: undefined, context: "c", messages: MSGS, t });
  assert.equal(missing?.status, 401);
  assert.deepEqual(await missing?.json(), { error: "password-required", message: "need-password" });
  const wrong = await requireStepUp({ req: req(), session: session(id, "s"), confirmPassword: "bad", context: "c", messages: MSGS, t });
  assert.equal(wrong?.status, 401);
  assert.deepEqual(await wrong?.json(), { error: "invalid-password" });
  assert.equal(await requireStepUp({ req: req(), session: session(id, "s"), confirmPassword: PASSWORD, context: "c", messages: MSGS, t }), null);
});

test("requireStepUp: an SSO account passes only with a sign-in younger than STEP_UP_MAX_AGE_MS", async () => {
  const id = freshUser();
  users.set(id, { passwordHash: null });
  sessions.set("fresh", new Date());
  sessions.set("stale", new Date(Date.now() - STEP_UP_MAX_AGE_MS - 1_000));
  assert.equal(await requireStepUp({ req: req(), session: session(id, "fresh"), confirmPassword: undefined, context: "c", messages: MSGS, t }), null);
  const stale = await requireStepUp({ req: req(), session: session(id, "stale"), confirmPassword: undefined, context: "c", messages: MSGS, t });
  assert.equal(stale?.status, 401);
  assert.deepEqual(await stale?.json(), { error: "session-too-old", message: "need-recent" });
});

test("isNativeSession keys on the session's never-expiring deadline, not on how the token arrived", () => {
  assert.equal(isNativeSession(session("a", "s", NEVER_EXPIRES_AT_SEC)), true);
  assert.equal(isNativeSession(session("a", "s", Math.floor(Date.now() / 1000) + 30 * 86_400)), false);
  assert.equal(isNativeSession(session("a", "s")), false);
});

test("the security notice lists what is still connected — for a password change or sign-out, never for the link itself", () => {
  const linked = { discordId: "123456789012345678", traktUsername: "alice" };
  assert.equal(
    accountSecurityMessage(t, "password-changed", linked),
    "notify.account.event.password-changed notify.account.stillLinked(list=notify.account.linked.discord(id=123456789012345678), notify.account.linked.trakt(name=alice))",
  );
  assert.equal(accountSecurityMessage(t, "signed-out-others", { discordId: null, traktUsername: null }), "notify.account.event.signed-out-others");
  assert.equal(accountSecurityMessage(t, "discord-linked", linked), "notify.account.event.discord-linked");
});

// Structural pin: a step-up route that called verifyPassword directly would get
// its own, unaudited guess budget again. Only the sign-in path (auth.ts — its
// own login-email/login-ip limiter) and this module may call it.
test("no route verifies a step-up password except through verifyStepUpPassword", async () => {
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const allowed = new Set(["src/lib/password-hash.ts", "src/lib/step-up-auth.ts", "src/lib/auth.ts"]);
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (p.startsWith(join("src", "generated"))) continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(p) && !allowed.has(p) && /\bverifyPassword\(/.test(readFileSync(p, "utf-8"))) offenders.push(p);
    }
  };
  walk("src");
  assert.deepEqual(offenders, []);
});
