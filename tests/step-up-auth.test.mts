// Unit tests for src/lib/step-up-auth.ts and the account security notice
// wording (src/lib/account-security-notify.ts) — guardrail 6g.
//
// The property that matters most: every step-up PASSWORD check (sign out
// another device, sign out everywhere, delete the account, change the password,
// a two-factor enrollment change, link Discord, connect Trakt) draws on ONE
// per-account budget of failed guesses. Before, each route had its own bucket,
// so a stolen session could test passwords at ~11 a minute across them and no
// failure was audited. Route-level wiring is pinned in sessions-routes,
// discord-routes and profile-routes; this file pins the budget itself, and the
// owner notice raised by the failure that fills it (the 6i sign-in notice's
// twin): a hijacked session trickling wrong passwords keeps the owner's own
// sign-out and password change refused, so the owner is told.
//
// No DB or network: prisma models are shadowed in-memory, the password hashes
// are real scrypt (one hash, reused), DNS is stubbed and the only fetch that
// answers is Resend's (the notice's transport), recorded.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import dns from "node:dns/promises";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "step-up-auth-test-secret-0123456789abcdef";
process.env.TRUST_PROXY = "true";
console.warn = () => {};
const errors: string[] = [];
console.error = (...a: unknown[]) => { errors.push(a.map(String).join(" ")); };

const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) {
  throw new Error("could not stub dns.lookup — aborting before a real DNS query can leave the process");
}
const sent: Array<{ to: string; subject: string; html: string }> = [];
// When set, every Resend send waits on it before answering — a hung mail
// backend. `resendStarted` counts the sends that reached the stub.
let resendGate: Promise<void> | null = null;
let resendStarted = 0;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname !== "api.resend.com") throw new Error(`unexpected network call to ${url.hostname}`);
  resendStarted++;
  if (resendGate) await resendGate;
  sent.push(JSON.parse(String(init?.body ?? "{}")));
  return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
}) as typeof fetch;

const { NextRequest } = await import("next/server");
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const { hashPassword } = await import("../src/lib/password-hash.ts");
const { verifyStepUpPassword, requireStepUp, isNativeSessionForStepUp, STEP_UP_PASSWORD_LIMIT, STEP_UP_MAX_AGE_MS } =
  await import("../src/lib/step-up-auth.ts");
const { accountSecurityMessage, resetSignInLockoutNoticesForTests } = await import("../src/lib/account-security-notify.ts");
const { NEVER_EXPIRES_AT_SEC, MAX_CONFIGURABLE_SESSION_SECONDS } = await import("../src/lib/session-lifetime.ts");

const EN_NOTIFY = JSON.parse(readFileSync(new URL("../src/lib/i18n/messages/en/notify.json", import.meta.url), "utf8")) as Record<string, string>;

const PASSWORD = "correct-horse-battery";
const HASH = await hashPassword(PASSWORD);

let audits: Array<{ action: string; target: string; details: string | null }> = [];
shadowPrismaModel(prisma, "auditLog", {
  create: async (args: { data: { action: string; target: string; details: string | null } }) => {
    audits.push(args.data);
    return args.data;
  },
});
type UserRow = { passwordHash: string | null; email?: string; notificationEmail?: string | null; locale?: string | null };
const users = new Map<string, UserRow>();
// AuthSession rows by sessionId. `expiresAt` is optional so the SSO tests can
// keep setting createdAt alone.
const sessions = new Map<string, { createdAt: Date; expiresAt?: Date }>();
let authSessionReads: string[] = [];
// Every user lookup, by id — verifyStepUpPassword itself reads none, so these
// are the notice's.
let userReads: string[] = [];
shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id: string } }) => {
    userReads.push(args.where.id);
    const u = users.get(args.where.id);
    return u ? { email: `${args.where.id}@example.com`, notificationEmail: null, locale: null, discordId: null, traktConnection: null, ...u } : null;
  },
});
// Notification email on, through Resend.
const settings = new Map([
  ["enableUserEmails", "true"],
  ["emailBackend", "resend"],
  ["resendApiKey", "re_test_key"],
  ["resendFrom", "Summonarr <noreply@example.com>"],
  ["siteUrl", "https://summonarr.example.com"],
]);
shadowPrismaModel(prisma, "setting", {
  findUnique: async ({ where }: { where: { key: string } }) =>
    settings.has(where.key) ? { key: where.key, value: settings.get(where.key)! } : null,
  findMany: async ({ where }: { where?: { key?: { in?: string[] } } } = {}) =>
    (where?.key?.in ?? [...settings.keys()])
      .filter((k) => settings.has(k))
      .map((k) => ({ key: k, value: settings.get(k)! })),
});
shadowPrismaModel(prisma, "authSession", {
  findUnique: async (args: { where: { sessionId: string } }) => {
    authSessionReads.push(args.where.sessionId);
    const row = sessions.get(args.where.sessionId);
    return row ? { ...row } : null;
  },
});

const req = () => new NextRequest("http://localhost:3000/api/x", { method: "POST", headers: { "x-forwarded-for": "198.51.100.7" } });
// A request that carried its session as a bearer token (the app) or a cookie.
const reqOn = (transport: "bearer" | "cookie") =>
  new NextRequest("http://localhost:3000/api/x", {
    method: "POST",
    headers: transport === "bearer" ? { authorization: "Bearer some.session.jwt" } : { cookie: "summonarr-session=some.session.jwt" },
  });
const t = (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}(${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(",")})` : key;
const flush = () => new Promise((r) => setImmediate(r));
// The lockout notice is sent detached (`void`); give it every chance to land.
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
}

let seq = 0;
const freshUser = () => `user-${++seq}`;

beforeEach(() => {
  audits = [];
  userReads = [];
  sent.length = 0;
  errors.length = 0;
  resendGate = null;
  resendStarted = 0;
  resetSignInLockoutNoticesForTests();
  authSessionReads = [];
});

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
  sessions.set("fresh", { createdAt: new Date() });
  sessions.set("stale", { createdAt: new Date(Date.now() - STEP_UP_MAX_AGE_MS - 1_000) });
  assert.equal(await requireStepUp({ req: req(), session: session(id, "fresh"), confirmPassword: undefined, context: "c", messages: MSGS, t }), null);
  const stale = await requireStepUp({ req: req(), session: session(id, "stale"), confirmPassword: undefined, context: "c", messages: MSGS, t });
  assert.equal(stale?.status, 401);
  assert.deepEqual(await stale?.json(), { error: "session-too-old", message: "need-recent" });
});

const DAY = 86_400;
const nowSec = () => Math.floor(Date.now() / 1000);
// An AuthSession row as initializeTokenOnSignIn writes it: created at sign-in,
// expiring at the deadline granted then. Returns the token deadline to match.
function signedIn(sessionId: string, ageSec: number, grantedSec: number): number {
  const createdAt = nowSec() - ageSec;
  sessions.set(sessionId, { createdAt: new Date(createdAt * 1000), expiresAt: new Date((createdAt + grantedSec) * 1000) });
  return createdAt + grantedSec;
}

test("isNativeSessionForStepUp: the never-expiring deadline is native on its own, with no DB read", async () => {
  for (const transport of ["bearer", "cookie"] as const) {
    assert.equal(await isNativeSessionForStepUp(session("a", "no-row", NEVER_EXPIRES_AT_SEC), reqOn(transport)), true);
  }
  assert.deepEqual(authSessionReads, []);
  assert.equal(await isNativeSessionForStepUp(session("a", "no-row"), reqOn("bearer")), false, "no deadline claim");
});

test("isNativeSessionForStepUp: a pre-6c 1-year session is native from its AuthSession row, however little time the TOKEN has left", async () => {
  // Signed in 300 days ago on the 1-year native TTL: 65 days left, which is all
  // a re-signed token's `deadline - iat` would show.
  const deadline = signedIn("legacy-300", 300 * DAY, 365 * DAY);
  assert.ok(deadline - nowSec() < MAX_CONFIGURABLE_SESSION_SECONDS);
  assert.equal(await isNativeSessionForStepUp(session("a", "legacy-300", deadline), reqOn("bearer")), true);
  // And early in its life.
  const fresh = signedIn("legacy-10", 10 * DAY, 365 * DAY);
  assert.equal(await isNativeSessionForStepUp(session("a", "legacy-10", fresh), reqOn("bearer")), true);
  assert.deepEqual(authSessionReads, ["legacy-300", "legacy-10"]);
});

test("isNativeSessionForStepUp: a browser span (at most 90 days) is never native, even presented as a bearer", async () => {
  const atCap = signedIn("web-90", 89 * DAY, MAX_CONFIGURABLE_SESSION_SECONDS);
  assert.equal(await isNativeSessionForStepUp(session("a", "web-90", atCap), reqOn("bearer")), false, "exactly the cap");
  const day = signedIn("web-1", 60, DAY);
  assert.equal(await isNativeSessionForStepUp(session("a", "web-1", day), reqOn("bearer")), false);
  const overCap = signedIn("over-cap", 10 * DAY, MAX_CONFIGURABLE_SESSION_SECONDS + 1);
  assert.equal(await isNativeSessionForStepUp(session("a", "over-cap", overCap), reqOn("bearer")), true, "one second past it is native");
});

test("isNativeSessionForStepUp: a 1-year session on the COOKIE is not native — v0.13.7/v0.13.8 gave mobile browsers that span too", async () => {
  const deadline = signedIn("mobile-web", 100 * DAY, 365 * DAY);
  assert.equal(await isNativeSessionForStepUp(session("a", "mobile-web", deadline), reqOn("cookie")), false);
  assert.deepEqual(authSessionReads, [], "decided before any read");
});

test("isNativeSessionForStepUp: no AuthSession row, no session id, or an unreadable row is not native", async () => {
  const deadline = nowSec() + 65 * DAY;
  assert.equal(await isNativeSessionForStepUp(session("a", "missing", deadline), reqOn("bearer")), false, "no row");
  assert.equal(await isNativeSessionForStepUp({ ...session("a", ""), tokenExpiresAt: deadline }, reqOn("bearer")), false, "no session id");
  sessions.set("no-expiry", { createdAt: new Date(Date.now() - 300 * DAY * 1000) });
  assert.equal(await isNativeSessionForStepUp(session("a", "no-expiry", deadline), reqOn("bearer")), false, "no expiresAt column");
});

// Structural pin: the helper is async, so a call site that dropped its `await`
// would test a Promise — always truthy, so `!promise` would exempt EVERY
// session. Both step-up routes the iOS app calls must use it, awaited.
test("every isNativeSessionForStepUp call is awaited, and both native-exempt routes use it", async () => {
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const callers = new Map<string, { calls: number; awaited: number }>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (p.startsWith(join("src", "generated"))) continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(p) && p !== join("src", "lib", "step-up-auth.ts")) {
        const src = readFileSync(p, "utf-8");
        const calls = src.match(/\bisNativeSessionForStepUp\(/g)?.length ?? 0;
        if (calls > 0) callers.set(p, { calls, awaited: src.match(/\bawait\s+isNativeSessionForStepUp\(/g)?.length ?? 0 });
      }
    }
  };
  walk("src");
  for (const route of ["src/app/api/profile/notification-email/route.ts", "src/app/api/discord/initiate-merge/route.ts"]) {
    assert.ok(callers.has(route), `${route} decides its native exemption through isNativeSessionForStepUp`);
  }
  for (const [file, { calls, awaited }] of callers) assert.equal(awaited, calls, `${file}: every call is awaited`);
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

// ═══ the owner notice when the budget fills ═══════════════════════════════════

const stepUpMails = () => sent.filter((m) => m.html.includes(EN_NOTIFY["notify.account.stepUpLockedHeading"]));
const guess = (userId: string, password: string) =>
  verifyStepUpPassword({ userId, userName: "u", passwordHash: HASH, password, context: "revoke-all", req: req() });
function ownerWithEmail(): string {
  const id = freshUser();
  users.set(id, { passwordHash: HASH, notificationEmail: "owner@example.com" });
  return id;
}

test("the failure that FILLS the step-up budget mails the owner once — the refused attempts after it send nothing and read nothing", async () => {
  const id = ownerWithEmail();
  for (let i = 0; i < STEP_UP_PASSWORD_LIMIT - 1; i++) assert.equal(await guess(id, `wrong-${i}`), "invalid");
  await settle();
  assert.equal(sent.length, 0, "budget left: an ordinary typo, no mail");

  assert.equal(await guess(id, "wrong-last"), "invalid", "the verdict is unchanged");
  await settle();
  assert.equal(stepUpMails().length, 1, "mailed as soon as the budget ran out");
  assert.equal(sent.length, 1);
  const mail = stepUpMails()[0];
  assert.equal(mail.to, "owner@example.com");
  assert.equal(mail.subject, EN_NOTIFY["notify.account.subject"]);
  assert.ok(mail.html.includes("15 minutes"), "the pause length is filled in");
  assert.ok(mail.html.includes("signed-in session"), "the step-up sentence, not the sign-in one");
  assert.ok(mail.html.includes("contact your Summonarr administrator"), "the owner can't sign the guesser out themselves, so: contact an admin");
  assert.ok(mail.html.includes("https://summonarr.example.com/profile#sessions"), "the button opens the session list");

  // Refused attempts (wrong AND right passwords) never reach the notice.
  const reads = userReads.length;
  assert.equal(await guess(id, "wrong-again"), "rate-limited");
  assert.equal(await guess(id, PASSWORD), "rate-limited");
  const flood = await Promise.all(Array.from({ length: 10 }, (_, i) => guess(id, `flood-${i}`)));
  assert.ok(flood.every((v) => v === "rate-limited"));
  await settle();
  assert.equal(stepUpMails().length, 1, "once per window, however many attempts follow");
  assert.equal(userReads.length, reads, "a refused attempt reads nothing more");
  assert.equal(audits.filter((a) => a.target === "auth:step-up").length, STEP_UP_PASSWORD_LIMIT, "only the judged failures are audited");
});

test("the lockout mail is DETACHED: a hung mail backend never holds the verdict of the guess that fills the budget", async () => {
  const id = ownerWithEmail();
  for (let i = 0; i < STEP_UP_PASSWORD_LIMIT - 1; i++) assert.equal(await guess(id, `wrong-${i}`), "invalid");
  let release!: () => void;
  resendGate = new Promise<void>((r) => { release = r; });
  const verdict = await Promise.race([
    guess(id, "wrong-last"),
    new Promise<"timed-out">((r) => setTimeout(() => r("timed-out"), 10_000)),
  ]);
  assert.equal(verdict, "invalid", "answered while the mail is still in flight");
  await settle();
  assert.equal(resendStarted, 1, "the send was started…");
  assert.equal(sent.length, 0, "…and is still hanging");
  release();
  await settle();
  assert.equal(stepUpMails().length, 1, "it lands once released");
});

test("the last two guesses landing together mail ONCE — the claim, not the bucket, decides", async () => {
  const id = ownerWithEmail();
  for (let i = 0; i < STEP_UP_PASSWORD_LIMIT - 2; i++) assert.equal(await guess(id, `wrong-${i}`), "invalid");
  const last = await Promise.all([guess(id, "wrong-a"), guess(id, "wrong-b")]);
  assert.deepEqual(last, ["invalid", "invalid"]);
  await settle();
  assert.equal(stepUpMails().length, 1);
});

test("a CORRECT step-up password never mails, even one short of a full budget", async () => {
  const id = ownerWithEmail();
  for (let i = 0; i < STEP_UP_PASSWORD_LIMIT - 1; i++) assert.equal(await guess(id, `wrong-${i}`), "invalid");
  for (let i = 0; i < 3; i++) assert.equal(await guess(id, PASSWORD), "ok");
  await settle();
  assert.equal(sent.length, 0);
  assert.deepEqual(userReads, [], "a success reads nothing for the notice either");
});

test("requireStepUp answers exactly as before around the lockout: 401 invalid-password, then 429 rate_limit", async () => {
  const id = ownerWithEmail();
  for (let i = 0; i < STEP_UP_PASSWORD_LIMIT - 1; i++) assert.equal(await guess(id, `wrong-${i}`), "invalid");
  const last = await requireStepUp({ req: req(), session: session(id, "s"), confirmPassword: "wrong-last", context: "revoke-all", messages: MSGS, t });
  assert.equal(last?.status, 401);
  assert.deepEqual(await last?.json(), { error: "invalid-password" });
  const refused = await requireStepUp({ req: req(), session: session(id, "s"), confirmPassword: PASSWORD, context: "revoke-all", messages: MSGS, t });
  assert.equal(refused?.status, 429);
  assert.deepEqual(await refused?.json(), { error: "rate_limit", message: "apiAuth.common.tooManyAttemptsWait15" });
  await settle();
  assert.equal(stepUpMails().length, 1);
});

test("an account with no deliverable address gets no mail and no error", async () => {
  const id = freshUser();
  users.set(id, { passwordHash: HASH, email: `jellyfin-${id}@jellyfin.local` });
  for (let i = 0; i < STEP_UP_PASSWORD_LIMIT; i++) assert.equal(await guess(id, `wrong-${i}`), "invalid");
  await settle();
  assert.equal(sent.length, 0);
  assert.deepEqual(userReads, [id], "looked up once, by the notice");
  assert.deepEqual(errors, []);
});

test("the step-up lockout sentence carries the pause length and lists no linked accounts", () => {
  assert.equal(
    accountSecurityMessage(t, "step-up-locked", { discordId: "123", traktUsername: "alice" }, { minutes: 15 }),
    "notify.account.event.step-up-locked(minutes=15)",
  );
});
