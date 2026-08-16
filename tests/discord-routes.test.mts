// Route-level unit tests for the seven uncovered Discord routes:
//   POST /api/discord/generate-link      mint the /link token
//   POST /api/discord/initiate-merge     DM a verification code
//   POST /api/discord/confirm-merge      redeem it and merge the shadow account
//   POST /api/discord/unlink
//   GET  /api/discord/status
//   POST /api/discord/sync-roles         (admin)
//   POST /api/discord/register-commands  (admin)
//
// tests/discord-merge.test.mts covers the merge lib; these are the identity-
// binding routes around it, which is where a mistake actually costs something.
// Each headline below is a failure mode the route's own comments name:
//
//   1. generate-link FAILS CLOSED ON A MALFORMED SNOWFLAKE. `discordId` is the
//      binding the /link consumer enforces, so a dropped binding silently
//      downgrades the token to BEARER — any Discord account that sees the token
//      can redeem it and pull the victim's request/issue/vote history across.
//      Falling through to null on a JSON number or a stray-whitespace paste did
//      exactly that, behind a 200 telling the caller the token was account-bound.
//      Omitting the field entirely is still valid (the web UI POSTs no body).
//   2. initiate-merge IS NOT AN ENUMERATION ORACLE. It deliberately does NOT
//      return a pendingCount for the target snowflake — that would let any
//      authenticated caller probe arbitrary Discord ids for shadow-account
//      activity before proving control of them. And it is double rate-limited:
//      a per-(user,target) bucket so an attacker iterating victim ids can't
//      share their own bucket, PLUS a global per-user cap, because the per-target
//      bucket alone lets one account DM hundreds of distinct snowflakes.
//   3. confirm-merge COMPARES BYTES, NOT UTF-16 LENGTH. A 12-character multibyte
//      submission passes a `.length` check against the 12-char stored code while
//      producing a 24-byte Buffer, and timingSafeEqual then throws RangeError out
//      of an un-try'd expression — turning "Incorrect code" into a 500 that still
//      burns a rate-limit slot. It also consumes the code only AFTER the merge
//      succeeds (a transient failure must not burn it), and uses deleteMany
//      rather than delete so a concurrent double-submit can't turn a SUCCEEDED
//      link into a 409 via P2025.
//   4. unlink READS THE ID BEFORE CLEARING IT and revokes roles only after the
//      write commits (guardrail 27). Reading after would leave the user holding
//      every role Summonarr granted, admin included, with no way to lose it.
//
// Harness: real wrapped handlers, genuine signed session JWTs, a synthetic Next
// request scope, in-memory prisma stubs, scripted discord.com. No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import dns from "node:dns/promises";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "discord-routes-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// ── scripted discord.com ─────────────────────────────────────────────────────
const fetchCalls: Array<{ url: URL; method: string; body: string | null }> = [];
let dmChannelOk = true;
let dmSendOk = true;
let registerOk = true;
let roleCallsOk = true;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const body = typeof init?.body === "string" ? init.body : null;
  fetchCalls.push({ url, method: init?.method ?? "GET", body });
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
  if (url.pathname.endsWith("/users/@me/channels")) {
    return dmChannelOk ? json({ id: "dm-channel-1" }) : json({ message: "Cannot send messages to this user" }, 403);
  }
  if (/\/channels\/[^/]+\/messages$/.test(url.pathname)) {
    return dmSendOk ? json({ id: "msg-1" }) : json({ message: "DM CLOSED" }, 403);
  }
  if (url.pathname.includes("/commands")) {
    return registerOk ? json([{ id: "cmd-1" }]) : json({ message: "REGISTER SECRET DETAIL" }, 401);
  }
  // Guild member role add/remove.
  return roleCallsOk ? new Response(null, { status: 204 }) : json({ message: "ROLE FAIL" }, 500);
}) as unknown as typeof fetch;

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
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");
const { Permission } = await import("../src/lib/permissions.ts");
const { invalidateFeatureFlagCache } = await import("../src/lib/features.ts");

// ── op log ───────────────────────────────────────────────────────────────────
type Op = { op: string; args?: unknown };
let ops: Op[] = [];
const rec = (op: string, args?: unknown) => { ops.push({ op, args }); };
const opsOf = (name: string) => ops.filter((o) => o.op === name);

// ── stores ───────────────────────────────────────────────────────────────────
type AppUser = Record<string, unknown> & { id: string; email: string; discordId: string | null; role: string };
let appUsers: AppUser[] = [];
const sessionRows = new Set<string>();

shadowPrismaModel(prisma, "authSession", {
  findUnique: async (args: { where: { sessionId: string } }) =>
    sessionRows.has(args.where.sessionId) ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId } : null,
  update: async () => ({}),
});

shadowPrismaModel(prisma, "user", {
  // Reads return DETACHED copies, matching real Prisma. Handing back the live
  // object let a later user.update Object.assign mutate the row a caller was
  // still holding — which silently defeated unlink read-before-write.
  findUnique: async (args: { where: { id?: string; discordId?: string }; select?: unknown }) => {
    rec("user.findUnique", args.where);
    const hit = args.where.id
      ? appUsers.find((u) => u.id === args.where.id)
      : args.where.discordId
        ? appUsers.find((u) => u.discordId === args.where.discordId)
        : undefined;
    return hit ? { ...hit } : null;
  },
  findMany: async (args: { where?: Record<string, unknown> } = {}) => {
    rec("user.findMany", args.where);
    // Models the three filters sync-roles actually uses. Without the email and
    // deactivatedAt halves the stub returned every linked row for both of that
    // route's queries, so its scoping tests passed no matter what the route asked
    // for — the filter has to be honoured here for those pins to mean anything.
    const w = args.where as
      | {
          discordId?: { not?: null };
          deactivatedAt?: null | { not?: null };
          NOT?: { email?: { endsWith?: string } };
        }
      | undefined;
    let rows = appUsers;
    if (w?.discordId?.not === null) rows = rows.filter((u) => u.discordId !== null);
    if (w && "deactivatedAt" in w) {
      rows = w.deactivatedAt === null
        ? rows.filter((u) => u.deactivatedAt === null)
        : rows.filter((u) => u.deactivatedAt !== null);
    }
    const suffix = w?.NOT?.email?.endsWith;
    if (suffix) rows = rows.filter((u) => !u.email.endsWith(suffix));
    return rows.map((u) => ({ ...u }));
  },
  update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
    rec("user.update", args);
    const u = appUsers.find((x) => x.id === args.where.id);
    if (u) Object.assign(u, args.data);
    return u ?? {};
  },
  updateMany: async (args: unknown) => { rec("user.updateMany", args); return { count: 0 }; },
  create: async (args: unknown) => { rec("user.create", args); return { id: "new" }; },
  delete: async (args: unknown) => { rec("user.delete", args); return {}; },
  count: async () => appUsers.length,
});

type LinkToken = { userId: string; token: string; expiresAt: Date; discordId: string | null };
let linkTokens: LinkToken[] = [];
shadowPrismaModel(prisma, "discordLinkToken", {
  findUnique: async (args: { where: { userId?: string; token?: string } }) => {
    rec("discordLinkToken.findUnique", args.where);
    return linkTokens.find((t) => (args.where.userId ? t.userId === args.where.userId : t.token === args.where.token)) ?? null;
  },
  upsert: async (args: { where: { userId: string }; create: LinkToken; update: Partial<LinkToken> }) => {
    rec("discordLinkToken.upsert", { where: args.where, update: args.update });
    const existing = linkTokens.find((t) => t.userId === args.where.userId);
    if (existing) Object.assign(existing, args.update);
    else linkTokens.push({ ...args.create });
    return linkTokens.find((t) => t.userId === args.where.userId)!;
  },
  deleteMany: async (args: { where: { userId?: string } }) => {
    rec("discordLinkToken.deleteMany", args.where);
    const before = linkTokens.length;
    linkTokens = linkTokens.filter((t) => t.userId !== args.where.userId);
    return { count: before - linkTokens.length };
  },
});

type MergeCode = { userId: string; discordId: string; code: string; expiresAt: Date };
let mergeCodes: MergeCode[] = [];
let mergeThrows = false;
shadowPrismaModel(prisma, "discordMergeCode", {
  findUnique: async (args: { where: { userId: string } }) => {
    rec("discordMergeCode.findUnique", args.where);
    return mergeCodes.find((c) => c.userId === args.where.userId) ?? null;
  },
  upsert: async (args: { where: { userId: string }; create: MergeCode; update: Partial<MergeCode> }) => {
    rec("discordMergeCode.upsert", { where: args.where, update: args.update });
    const existing = mergeCodes.find((c) => c.userId === args.where.userId);
    if (existing) Object.assign(existing, args.update);
    else mergeCodes.push({ ...args.create });
    return mergeCodes.find((c) => c.userId === args.where.userId)!;
  },
  delete: async (args: unknown) => { rec("discordMergeCode.delete", args); return {}; },
  deleteMany: async (args: { where: { userId?: string } }) => {
    rec("discordMergeCode.deleteMany", args.where);
    const before = mergeCodes.length;
    mergeCodes = mergeCodes.filter((c) => c.userId !== args.where.userId);
    return { count: before - mergeCodes.length };
  },
});

const settings = new Map<string, string>();
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    rec("setting.findUnique", args.where.key);
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
  findMany: async (args: { where?: { key?: { in?: string[] } } } = {}) => {
    rec("setting.findMany", args.where?.key?.in);
    const keys = args.where?.key?.in;
    const all = [...settings.entries()].map(([key, value]) => ({ key, value }));
    return keys ? all.filter((r) => keys.includes(r.key)) : all;
  },
  upsert: async () => ({}), create: async () => ({}), update: async () => ({}), deleteMany: async () => ({ count: 0 }),
});

shadowPrismaModel(prisma, "auditLog", { create: async (args: unknown) => { rec("auditLog.create", args); return { id: "a1" }; } });
for (const m of ["mediaRequest", "issue", "deletionVote", "notification", "issueMessage", "hiddenItem", "watchlistItem"]) {
  shadowPrismaModel(prisma, m, {
    findMany: async () => [], findUnique: async () => null, findFirst: async () => null, count: async () => 0,
    updateMany: async (args: unknown) => { rec(`${m}.updateMany`, args); return { count: 0 }; },
    deleteMany: async () => ({ count: 0 }), create: async () => ({}), update: async () => ({}),
  });
}
shadowPrismaClientMethod(prisma, "$transaction", async (arg: unknown) => {
  rec("$transaction");
  if (mergeThrows) throw new Error("simulated merge failure");
  if (Array.isArray(arg)) return Promise.all(arg);
  return (arg as (tx: unknown) => Promise<unknown>)(prisma);
});
shadowPrismaClientMethod(prisma, "$queryRaw", async () => []);
shadowPrismaClientMethod(prisma, "$queryRawUnsafe", async () => []);
// mergeDiscordIntoWebAccount opens its transaction with a pg_advisory_xact_lock
// via tx.$executeRawUnsafe; leaving it unstubbed throws inside the merge and the
// route's catch turns every success case into a 409.
shadowPrismaClientMethod(prisma, "$executeRaw", async () => 1);
shadowPrismaClientMethod(prisma, "$executeRawUnsafe", async () => 1);

const generateLink = await import("../src/app/api/discord/generate-link/route.ts");
const initiateMerge = await import("../src/app/api/discord/initiate-merge/route.ts");
const confirmMerge = await import("../src/app/api/discord/confirm-merge/route.ts");
const unlink = await import("../src/app/api/discord/unlink/route.ts");
const status = await import("../src/app/api/discord/status/route.ts");
const syncRoles = await import("../src/app/api/discord/sync-roles/route.ts");
const registerCommands = await import("../src/app/api/discord/register-commands/route.ts");

// ── scope ────────────────────────────────────────────────────────────────────
const afterTasks: Array<() => Promise<unknown>> = [];
function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = {
    route: "/discord-routes.test", forceStatic: false, dynamicShouldError: false,
    afterContext: {
      after: (task: unknown) => {
        afterTasks.push(typeof task === "function" ? (task as () => Promise<unknown>) : async () => task);
      },
    },
  };
  const reqHeaders = new Headers();
  const requestStore = {
    type: "request", phase: "render",
    headers: HeadersAdapter.seal(reqHeaders),
    cookies: RequestCookiesAdapter.seal(new RequestCookies(reqHeaders)),
    usedDynamic: false,
  };
  return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, fn));
}

let seq = 0;
async function mintSession(opts: { role?: string; permissions?: bigint; discordId?: string | null } = {}): Promise<{ userId: string; token: string }> {
  seq++;
  const userId = `member-${seq}`;
  const sessionId = `sess-${seq}`;
  const role = opts.role ?? "USER";
  const permissions = (opts.permissions ?? 0n).toString();
  appUsers.push({
    id: userId, name: `Member ${seq}`, email: `member-${seq}@example.com`, role,
    permissions: BigInt(permissions), mediaServer: null, sessionsRevokedAt: null,
    passwordChangedAt: null, deactivatedAt: null, notificationEmail: null,
    discordId: opts.discordId ?? null,
  });
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000);
  const token = await signSessionJwt(
    { id: userId, role, permissions, provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
  return { userId, token };
}
const COOKIE = getSessionCookieName();

function mk(path: string, token: string | null, init: { method: string; body?: string } = { method: "POST" }) {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: init.method,
    headers: { ...(token ? { cookie: `${COOKIE}=${token}` } : {}), "content-type": "application/json" },
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
}
const doGenerate = (t: string | null, body?: unknown, raw?: string) =>
  inScope(() => generateLink.POST(mk("/api/discord/generate-link", t, { method: "POST", body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) }), undefined));
const doInitiate = (t: string | null, body: unknown, raw?: string) =>
  inScope(() => initiateMerge.POST(mk("/api/discord/initiate-merge", t, { method: "POST", body: raw ?? JSON.stringify(body) }), undefined));
const doConfirm = (t: string | null, body: unknown, raw?: string) =>
  inScope(() => confirmMerge.POST(mk("/api/discord/confirm-merge", t, { method: "POST", body: raw ?? JSON.stringify(body) }), undefined));
const doUnlink = (t: string | null) => inScope(() => unlink.POST(mk("/api/discord/unlink", t), undefined));
const doStatus = (t: string | null) => inScope(() => status.GET(mk("/api/discord/status", t, { method: "GET" }), undefined));
const doSyncRoles = (t: string | null) => inScope(() => syncRoles.POST(mk("/api/discord/sync-roles", t), undefined));
const doRegister = (t: string | null) => inScope(() => registerCommands.POST(mk("/api/discord/register-commands", t), undefined));

const VALID_SNOWFLAKE = "123456789012345678";

// The unlink revoke is fire-and-forget and several awaits deep (feature-flag
// read, then a Setting read, then the Discord calls), so a single setImmediate
// is not enough to observe it. Poll a bounded number of macrotask turns.
async function waitForDiscordCall(timeoutTurns = 50): Promise<void> {
  for (let i = 0; i < timeoutTurns; i++) {
    if (fetchCalls.some((c) => c.url.hostname === "discord.com")) return;
    await new Promise((r) => setTimeout(r, 0));
  }
}

// The unlink revoke is deliberately fire-and-forget, so a previous test's
// in-flight Discord call can land DURING the next one — after its beforeEach has
// already cleared the log — and read as a spurious call. Drain a few macrotask
// turns before resetting so no test inherits another's unawaited work.
beforeEach(async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  ops = [];
  appUsers = [];
  linkTokens = [];
  mergeCodes = [];
  settings.clear();
  settings.set("discordBotToken", "a-bot-token");
  settings.set("discordClientId", "999888777");
  // revokeDiscordRolesOnUnlink / assignDiscordRolesOnLink no-op unless a guild
  // AND at least one managed role id are configured — without these the role
  // calls silently never happen and the ordering assertions below pass
  // vacuously. (feature.integration.discord defaults ON, so it needs no row.)
  // Both must be REAL snowflakes (17-20 digits): revokeDiscordRolesOnUnlink
  // runs isValidSnowflake on the guild id and every managed role, and a short
  // placeholder makes it return early — the role calls then never happen and the
  // ordering assertions pass vacuously.
  settings.set("discordGuildId", "555444333222111000");
  settings.set("discordLinkedRoleId", "111222333444555666");
  invalidateFeatureFlagCache();
  fetchCalls.length = 0;
  afterTasks.length = 0;
  warns.length = 0;
  errors.length = 0;
  dmChannelOk = true;
  dmSendOk = true;
  registerOk = true;
  roleCallsOk = true;
  mergeThrows = false;
});

// ── gating ───────────────────────────────────────────────────────────────────

test("every discord route refuses an anonymous caller with 401", async () => {
  assert.equal((await doGenerate(null)).status, 401);
  assert.equal((await doInitiate(null, { discordId: VALID_SNOWFLAKE })).status, 401);
  assert.equal((await doConfirm(null, { code: "ABC" })).status, 401);
  assert.equal((await doUnlink(null)).status, 401);
  assert.equal((await doStatus(null)).status, 401);
  assert.equal((await doSyncRoles(null)).status, 401);
  assert.equal((await doRegister(null)).status, 401);
  assert.deepEqual(fetchCalls, []);
});

test("the two admin routes refuse a plain USER with 403", async () => {
  const { token } = await mintSession();
  assert.equal((await doSyncRoles(token)).status, 403);
  assert.equal((await doRegister(token)).status, 403);
  assert.deepEqual(fetchCalls, []);
});

test("the user-facing routes admit a plain USER", async () => {
  const { token } = await mintSession();
  assert.equal((await doStatus(token)).status, 200);
  assert.equal((await doGenerate(token)).status, 200);
  assert.equal((await doUnlink(token)).status, 200);
});

// ── 1: generate-link fails CLOSED on a malformed snowflake ───────────────────

test("generate-link with NO body mints an unbound token — the web UI flow", async () => {
  const { token } = await mintSession();
  const res = await doGenerate(token);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.token, /^[0-9A-F]{32}$/, "128 bits of entropy, uppercase hex");
  const stored = (opsOf("discordLinkToken.upsert")[0].args as { update: { discordId: string | null } }).update;
  assert.equal(stored.discordId, null, "omitting the field keeps the null binding");
});

test("generate-link with a VALID snowflake binds the token to it", async () => {
  const { token } = await mintSession();
  const res = await doGenerate(token, { discordId: VALID_SNOWFLAKE });
  assert.equal(res.status, 200);
  const stored = (opsOf("discordLinkToken.upsert")[0].args as { update: { discordId: string | null } }).update;
  assert.equal(stored.discordId, VALID_SNOWFLAKE);
});

// The load-bearing rule is NOT "reject anything unusual" — it is "never fall
// through to a NULL binding". A malformed value must 400 (minting nothing)
// rather than quietly producing a bearer token that any Discord account can
// redeem. Values that normalize cleanly are bound, which is the fix working.
for (const [label, discordId] of [
  ["a stray-whitespace paste with trailing junk", " 123456789012345678 x"],
  ["too few digits", "1234567890123456"],
  ["too many digits", "123456789012345678901"],
  ["non-numeric", "not-a-snowflake"],
  ["an object", { nope: true }],
  ["a boolean", true],
  ["a float", 1.5],
] as const) {
  test(`generate-link with ${label} is 400 and mints NOTHING`, async () => {
    const { token } = await mintSession();
    const res = await doGenerate(token, { discordId });
    assert.equal(res.status, 400, `${label} should be rejected`);
    assert.equal((await res.json()).error, "Invalid discordId");
    assert.equal(opsOf("discordLinkToken.upsert").length, 0, "no token may be minted for a bad binding");
  });
}

test("NO malformed input can ever mint an UNBOUND token", async () => {
  // The actual failure mode: falling through to discordId:null on bad input
  // returns a 200 telling the caller the token is account-bound while it is
  // really a bearer credential. Every rejected shape must mint nothing at all.
  // A fresh caller per case: generate-link allows only 5 mints per 10 minutes,
  // so reusing one session would 429 partway through and mask a real acceptance.
  for (const discordId of [" 1234 x", "nope", {}, true, 1.5, "12345678901234567890123"]) {
    ops = [];
    const { token } = await mintSession();
    const res = await doGenerate(token, { discordId });
    assert.equal(res.status, 400, `${JSON.stringify(discordId)} should be rejected`);
    assert.equal(opsOf("discordLinkToken.upsert").length, 0, `${JSON.stringify(discordId)} minted a token`);
  }
  assert.equal(linkTokens.length, 0, "no token row should exist at all");
});

for (const [label, discordId] of [
  ["a whitespace-padded paste", "  123456789012345678  "],
  ["a trailing newline", "123456789012345678\n"],
] as const) {
  test(`generate-link NORMALIZES ${label} and binds it rather than dropping the binding`, async () => {
    // These are inputs the old code fell through to null on. The fix
    // String()-and-trims first, so they now bind correctly — which is the point:
    // a usable paste must not silently become a bearer token.
    const { token } = await mintSession();
    const res = await doGenerate(token, { discordId });
    assert.equal(res.status, 200, `${label} should normalize cleanly`);
    const stored = (opsOf("discordLinkToken.upsert")[0].args as { update: { discordId: string | null } }).update;
    assert.equal(stored.discordId, VALID_SNOWFLAKE, `${label} must BIND, not fall through to null`);
  });
}

test("a JSON-NUMBER snowflake still binds (never null), but cannot round-trip exactly", async () => {
  // Documented rather than asserted-as-correct: every Discord snowflake exceeds
  // Number.MAX_SAFE_INTEGER, so JSON.parse has ALREADY lost precision before the
  // route sees the value — 123456789012345678 arrives as 123456789012345680.
  // It still passes the 17–20 digit check and binds, so the security property
  // holds (no bearer downgrade); the practical effect is a link token bound to a
  // neighbouring id, which simply fails to redeem. Clients send strings, so this
  // is a latent sharp edge, not a live defect — pinned so a future "accept
  // numbers properly" change has to confront it.
  const { token } = await mintSession();
  const res = await doGenerate(token, { discordId: 123456789012345678 });
  assert.equal(res.status, 200);
  const stored = (opsOf("discordLinkToken.upsert")[0].args as { update: { discordId: string | null } }).update;
  assert.notEqual(stored.discordId, null, "the binding must never be dropped");
  assert.match(String(stored.discordId), /^\d{17,20}$/);
  assert.notEqual(stored.discordId, VALID_SNOWFLAKE, "precision was lost in JSON.parse, before the route ran");
});

test("generate-link tokens expire within ten minutes", async () => {
  const { token } = await mintSession();
  const res = await doGenerate(token);
  const { expiresAt } = await res.json();
  const ms = new Date(expiresAt).getTime() - Date.now();
  assert.ok(ms > 8 * 60_000 && ms <= 10 * 60_000, `TTL was ${Math.round(ms / 1000)}s`);
});

test("generate-link is rate-limited per caller", async () => {
  const { token } = await mintSession();
  for (let i = 0; i < 5; i++) assert.equal((await doGenerate(token)).status, 200, `mint ${i + 1}`);
  assert.equal((await doGenerate(token)).status, 429);
});

test("re-minting replaces the previous token rather than accumulating", async () => {
  const { token, userId } = await mintSession();
  const first = await (await doGenerate(token)).json();
  const second = await (await doGenerate(token)).json();
  assert.notEqual(first.token, second.token);
  assert.equal(linkTokens.filter((t) => t.userId === userId).length, 1);
});

// ── 2: initiate-merge — validation, throttling, no enumeration oracle ────────

for (const bad of [undefined, "", "123", "abcdefghijklmnopqr", "12345678901234567890123"]) {
  test(`initiate-merge rejects the snowflake ${JSON.stringify(bad)} with 400`, async () => {
    const { token } = await mintSession();
    const res = await doInitiate(token, { discordId: bad });
    assert.equal(res.status, 400);
    assert.deepEqual(fetchCalls, [], "a bad id must not reach discord.com");
    assert.equal(opsOf("discordMergeCode.upsert").length, 0);
  });
}

test("initiate-merge does NOT return a pendingCount — that would be an enumeration oracle", async () => {
  // Returning it pre-confirmation lets any authenticated caller probe arbitrary
  // snowflakes for shadow-account activity they have not proven control of.
  const { token } = await mintSession();
  const body = await (await doInitiate(token, { discordId: VALID_SNOWFLAKE })).json();
  assert.deepEqual(body, { ok: true });
  assert.ok(!("pendingCount" in body));
  assert.ok(!("migrated" in body));
});

test("initiate-merge refuses a snowflake already linked to a REAL other account", async () => {
  const { token } = await mintSession();
  appUsers.push({
    id: "other", email: "other@example.com", role: "USER", discordId: VALID_SNOWFLAKE,
    permissions: 0n, deactivatedAt: null,
  });
  const res = await doInitiate(token, { discordId: VALID_SNOWFLAKE });
  assert.equal(res.status, 409);
  assert.deepEqual(fetchCalls, [], "no DM for a taken id");
});

test("the taken-snowflake refusal is deliberately vague — it must not confirm the link", async () => {
  const { token } = await mintSession();
  appUsers.push({ id: "other", email: "other@example.com", role: "USER", discordId: VALID_SNOWFLAKE, permissions: 0n, deactivatedAt: null });
  const body = await (await doInitiate(token, { discordId: VALID_SNOWFLAKE })).json();
  assert.ok(!/already|linked|taken/i.test(body.error), `the error confirms the binding: ${body.error}`);
});

test("a @discord.local SHADOW account does not block the merge — that is the whole point", async () => {
  const { token } = await mintSession();
  appUsers.push({
    id: "shadow", email: "123456789012345678@discord.local", role: "USER",
    discordId: VALID_SNOWFLAKE, permissions: 0n, deactivatedAt: null,
  });
  const res = await doInitiate(token, { discordId: VALID_SNOWFLAKE });
  assert.equal(res.status, 200);
});

test("re-initiating for one's OWN linked id is allowed", async () => {
  const { token, userId } = await mintSession({ discordId: VALID_SNOWFLAKE });
  void userId;
  assert.equal((await doInitiate(token, { discordId: VALID_SNOWFLAKE })).status, 200);
});

test("initiate-merge is 503 when the bot is not configured, and DMs nothing", async () => {
  settings.delete("discordBotToken");
  const { token } = await mintSession();
  const res = await doInitiate(token, { discordId: VALID_SNOWFLAKE });
  assert.equal(res.status, 503);
  assert.deepEqual(fetchCalls, []);
});

test("initiate-merge DMs the code and stores it with a ten-minute TTL", async () => {
  const { token } = await mintSession();
  await doInitiate(token, { discordId: VALID_SNOWFLAKE });
  const dm = fetchCalls.find((c) => /\/channels\/[^/]+\/messages$/.test(c.url.pathname));
  assert.ok(dm, "no DM was sent");
  const stored = mergeCodes[0];
  assert.ok(stored, "no code was stored");
  assert.match(stored.code, /^[0-9A-F]{12}$/, "12 hex chars (~48 bits)");
  assert.ok(dm.body?.includes(stored.code), "the DM must carry the stored code");
  const ttl = stored.expiresAt.getTime() - Date.now();
  assert.ok(ttl > 8 * 60_000 && ttl <= 10 * 60_000);
});

test("a failed DM DELETES the pending code — a code nobody received must not be redeemable", async () => {
  dmSendOk = false;
  const { token } = await mintSession();
  const res = await doInitiate(token, { discordId: VALID_SNOWFLAKE });
  assert.equal(res.status, 502);
  assert.equal(mergeCodes.length, 0, "the unsent code must not survive");
});

test("a failed DM-channel open is also a 502 with no stored code", async () => {
  dmChannelOk = false;
  const { token } = await mintSession();
  assert.equal((await doInitiate(token, { discordId: VALID_SNOWFLAKE })).status, 502);
  assert.equal(mergeCodes.length, 0);
});

test("a DM failure never leaks the Discord response body", async () => {
  dmSendOk = false;
  const { token } = await mintSession();
  const text = await (await doInitiate(token, { discordId: VALID_SNOWFLAKE })).text();
  assert.ok(!text.includes("DM CLOSED"));
});

test("initiate-merge never echoes the bot token", async () => {
  const { token } = await mintSession();
  const text = await (await doInitiate(token, { discordId: VALID_SNOWFLAKE })).text();
  assert.ok(!text.includes("a-bot-token"));
});

test("the PER-TARGET bucket stops an attacker hammering ONE victim id", async () => {
  const { token } = await mintSession();
  for (let i = 0; i < 3; i++) {
    assert.equal((await doInitiate(token, { discordId: VALID_SNOWFLAKE })).status, 200, `attempt ${i + 1}`);
  }
  assert.equal((await doInitiate(token, { discordId: VALID_SNOWFLAKE })).status, 429);
});

test("the GLOBAL bucket stops one account DMing MANY distinct snowflakes", async () => {
  // Without it, the per-target bucket alone gives every new victim id a fresh
  // budget — one account could DM hundreds of people.
  const { token } = await mintSession();
  let sent = 0;
  for (let i = 0; i < 20; i++) {
    const id = String(100000000000000000n + BigInt(i));
    const res = await doInitiate(token, { discordId: id });
    if (res.status === 200) sent++;
    else { assert.equal(res.status, 429); break; }
  }
  assert.ok(sent <= 10, `global cap should stop at ~10 DMs, sent ${sent}`);
});

test("the per-target bucket is scoped per (user, target) — a second user is unaffected", async () => {
  const a = await mintSession();
  for (let i = 0; i < 4; i++) await doInitiate(a.token, { discordId: VALID_SNOWFLAKE });
  assert.equal((await doInitiate(a.token, { discordId: VALID_SNOWFLAKE })).status, 429);
  const b = await mintSession();
  assert.equal((await doInitiate(b.token, { discordId: VALID_SNOWFLAKE })).status, 200);
});

// ── 3: confirm-merge — byte compare, code lifecycle ──────────────────────────

function seedCode(userId: string, code = "ABCDEF123456", ttlMs = 10 * 60_000): void {
  mergeCodes.push({ userId, discordId: VALID_SNOWFLAKE, code, expiresAt: new Date(Date.now() + ttlMs) });
}

test("confirm-merge with no pending code is a 400", async () => {
  const { token } = await mintSession();
  const res = await doConfirm(token, { code: "ABCDEF123456" });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /request a code/i);
});

test("an EXPIRED code is a 400 and is deleted", async () => {
  const { token, userId } = await mintSession();
  seedCode(userId, "ABCDEF123456", -1000);
  const res = await doConfirm(token, { code: "ABCDEF123456" });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /expired/i);
  assert.equal(mergeCodes.length, 0);
});

test("the expired-code cleanup uses deleteMany so a concurrent double-submit can't 500", async () => {
  const { token, userId } = await mintSession();
  seedCode(userId, "ABCDEF123456", -1000);
  await doConfirm(token, { code: "ABCDEF123456" });
  assert.ok(opsOf("discordMergeCode.deleteMany").length > 0);
  assert.equal(opsOf("discordMergeCode.delete").length, 0, "a bare delete would throw P2025 on the loser");
});

test("a WRONG code is 400 and leaves the pending code intact for a retry", async () => {
  const { token, userId } = await mintSession();
  seedCode(userId);
  const res = await doConfirm(token, { code: "000000000000" });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "Incorrect code.");
  assert.equal(mergeCodes.length, 1, "a typo must not burn the code");
});

for (const [label, supplied] of [
  ["a 12-CHARACTER multibyte string", "ÄÄÄÄÄÄÄÄÄÄÄÄ"],
  ["emoji padding to 12 units", "🙂🙂🙂🙂🙂🙂"],
  ["a mixed multibyte code", "ABCDEF12345Ä"],
] as const) {
  test(`confirm-merge with ${label} is a clean 400, NOT a 500`, async () => {
    // The bug: a .length comparison passes for 12 UTF-16 units while the Buffer
    // is 24 bytes, and timingSafeEqual then throws RangeError out of an un-try'd
    // expression — a 500 that still burns a rate-limit slot.
    const { token, userId } = await mintSession();
    seedCode(userId);
    const res = await doConfirm(token, { code: supplied });
    assert.equal(res.status, 400, `${label} produced ${res.status}`);
    assert.equal((await res.json()).error, "Incorrect code.");
  });
}

test("a shorter and a longer code are both clean 400s", async () => {
  const { token, userId } = await mintSession();
  seedCode(userId);
  for (const code of ["A", "ABCDEF1234567890"]) {
    const res = await doConfirm(token, { code });
    assert.equal(res.status, 400);
  }
});

test("the code comparison is case-insensitive on input (uppercased before compare)", async () => {
  const { token, userId } = await mintSession();
  seedCode(userId, "ABCDEF123456");
  const res = await doConfirm(token, { code: "  abcdef123456  " });
  assert.equal(res.status, 200, "a lower-case paste with whitespace should still verify");
});

test("a CORRECT code merges, consumes the code and reports the migration count", async () => {
  const { token, userId } = await mintSession();
  seedCode(userId);
  const res = await doConfirm(token, { code: "ABCDEF123456" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.discordId, VALID_SNOWFLAKE);
  assert.equal(mergeCodes.length, 0, "the code is consumed on success");
});

test("a FAILED merge does NOT burn the code — the user must be able to retry", async () => {
  mergeThrows = true;
  const { token, userId } = await mintSession();
  seedCode(userId);
  const res = await doConfirm(token, { code: "ABCDEF123456" });
  assert.equal(res.status, 409);
  assert.equal(mergeCodes.length, 1, "a transient merge failure must leave the code redeemable");
});

test("the success path consumes the code with deleteMany, not delete", async () => {
  // A concurrent duplicate submit races both callers past the merge; the loser's
  // bare delete would throw P2025 and turn a SUCCEEDED link into a 409.
  const { token, userId } = await mintSession();
  seedCode(userId);
  await doConfirm(token, { code: "ABCDEF123456" });
  assert.ok(opsOf("discordMergeCode.deleteMany").length > 0);
  assert.equal(opsOf("discordMergeCode.delete").length, 0);
});

test("confirm-merge is rate-limited, and hitting the limit WIPES the pending code", async () => {
  const { token, userId } = await mintSession();
  for (let i = 0; i < 5; i++) {
    seedCode(userId);
    await doConfirm(token, { code: "000000000000" });
    mergeCodes = mergeCodes.filter((c) => c.userId !== userId);
  }
  seedCode(userId);
  const res = await doConfirm(token, { code: "000000000000" });
  assert.equal(res.status, 429);
  assert.equal(mergeCodes.length, 0, "the pending code is wiped when the limiter trips");
});

test("confirm-merge caps its body (guardrail 30)", async () => {
  const { token } = await mintSession();
  const huge = JSON.stringify({ code: "z".repeat(32 * 1024) });
  const res = await doConfirm(token, undefined, huge);
  assert.ok(res.status === 400 || res.status === 413);
});

// ── 4: unlink reads before clearing, revokes after committing ────────────────

test("unlink clears discordId and reports ok", async () => {
  const { token, userId } = await mintSession({ discordId: VALID_SNOWFLAKE });
  const res = await doUnlink(token);
  assert.equal(res.status, 200);
  assert.equal(appUsers.find((u) => u.id === userId)!.discordId, null);
});

test("unlink READS the id before clearing it — proven by the revoke actually firing", async () => {
  // Asserted through the CONSEQUENCE rather than op ordering: session resolution
  // also issues a user.findUnique, so an index comparison matches that one and
  // passes even when the route reads after its own write. What a read-after-write
  // actually produces is prev.discordId === null and therefore NO revoke — which
  // is the failure that matters, because the user keeps every role Summonarr
  // granted them, admin included, with no way to lose it.
  const { token } = await mintSession({ discordId: VALID_SNOWFLAKE });
  await doUnlink(token);
  await waitForDiscordCall();
  const revoke = fetchCalls.filter((c) => c.url.hostname === "discord.com");
  assert.ok(revoke.length > 0, "unlinking a linked account must trigger a role revoke");
  assert.ok(
    revoke.some((c) => c.url.pathname.includes(VALID_SNOWFLAKE)),
    `the revoke must target the previously-linked id: ${revoke.map((c) => c.url.pathname).join(", ")}`,
  );
});

test("unlink revokes roles only AFTER the clearing write commits (guardrail 27)", async () => {
  const { token, userId } = await mintSession({ discordId: VALID_SNOWFLAKE });
  await doUnlink(token);
  // The DB write is durable before the fire-and-forget revoke is awaited.
  assert.equal(appUsers.find((u) => u.id === userId)?.discordId, null);
  await waitForDiscordCall();
  assert.ok(fetchCalls.some((c) => c.url.hostname === "discord.com"));
});

test("unlinking an account with NO discord link is a harmless no-op", async () => {
  const { token } = await mintSession({ discordId: null });
  const res = await doUnlink(token);
  assert.equal(res.status, 200);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(fetchCalls, [], "nothing to revoke, so no Discord call");
});

test("a failing role revoke never fails the unlink — the account is already unlinked", async () => {
  roleCallsOk = false;
  const { token, userId } = await mintSession({ discordId: VALID_SNOWFLAKE });
  const res = await doUnlink(token);
  assert.equal(res.status, 200);
  await new Promise((r) => setImmediate(r));
  assert.equal(appUsers.find((u) => u.id === userId)!.discordId, null);
});

test("unlink only ever touches the CALLER's row", async () => {
  const me = await mintSession({ discordId: VALID_SNOWFLAKE });
  const them = await mintSession({ discordId: "987654321098765432" });
  await doUnlink(me.token);
  assert.equal(appUsers.find((u) => u.id === them.userId)!.discordId, "987654321098765432");
  const where = (opsOf("user.update")[0].args as { where: { id: string } }).where;
  assert.equal(where.id, me.userId);
});

test("unlink is audited", async () => {
  const { token } = await mintSession({ discordId: VALID_SNOWFLAKE });
  await doUnlink(token);
  for (const t of afterTasks.splice(0)) await t();
  assert.equal(opsOf("auditLog.create").length, 1);
});

// ── status ───────────────────────────────────────────────────────────────────

test("status reports the caller's own link state", async () => {
  const linked = await mintSession({ discordId: VALID_SNOWFLAKE });
  assert.deepEqual(await (await doStatus(linked.token)).json(), { discordId: VALID_SNOWFLAKE, linked: true });
  const unlinked = await mintSession({ discordId: null });
  assert.deepEqual(await (await doStatus(unlinked.token)).json(), { discordId: null, linked: false });
});

test("status is scoped to the caller — it cannot report another user's link", async () => {
  const me = await mintSession({ discordId: null });
  await mintSession({ discordId: VALID_SNOWFLAKE });
  const body = await (await doStatus(me.token)).json();
  assert.equal(body.discordId, null);
  const where = (opsOf("user.findUnique")[0].args as { id: string });
  assert.equal(where.id, me.userId);
});

// ── admin routes ─────────────────────────────────────────────────────────────

test("sync-roles is a no-op when nobody is linked", async () => {
  const { token } = await mintSession({ role: "ADMIN", permissions: Permission.ADMIN });
  const res = await doSyncRoles(token);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { synced: 0 });
  assert.deepEqual(fetchCalls, []);
});

test("sync-roles only selects users that actually have a discordId", async () => {
  const { token } = await mintSession({ role: "ADMIN", permissions: Permission.ADMIN });
  appUsers.push(
    { id: "l1", email: "l1@example.com", role: "USER", discordId: VALID_SNOWFLAKE, permissions: 0n, deactivatedAt: null },
    { id: "u1", email: "u1@example.com", role: "USER", discordId: null, permissions: 0n, deactivatedAt: null },
  );
  const body = await (await doSyncRoles(token)).json();
  assert.equal(body.synced, 1);
  const where = opsOf("user.findMany")[0].args as { discordId?: { not?: null } };
  assert.deepEqual(where.discordId, { not: null });
});

test("PIN: sync-roles skips SHADOW accounts — a real snowflake is not a real link", async () => {
  // The bot creates a User row for anyone who runs a slash command, with their
  // real discordId and a synthetic discord_<id>@discord.local email. Nobody has
  // linked those to a real account, so granting them the linked/server roles
  // hands out guild perks to people who never linked. discordId alone cannot
  // tell them apart — the email suffix is the only discriminator.
  const { token } = await mintSession({ role: "ADMIN", permissions: Permission.ADMIN });
  appUsers.push(
    { id: "real", email: "real@example.com", role: "USER", discordId: VALID_SNOWFLAKE, permissions: 0n, deactivatedAt: null },
    { id: "shadow", email: `discord_${VALID_SNOWFLAKE}@discord.local`, role: "USER", discordId: "222222222222222222", permissions: 0n, deactivatedAt: null },
  );

  const body = await (await doSyncRoles(token)).json();

  assert.equal(body.synced, 1, "only the genuinely linked account is synced");
  const granted = fetchCalls.filter((c) => c.method === "PUT").map((c) => c.url.pathname);
  assert.ok(
    granted.every((p) => p.includes(VALID_SNOWFLAKE)),
    `no role may be granted to the shadow account: ${granted.join(", ")}`,
  );
});

test("PIN: sync-roles STRIPS Summonarr-managed roles from a deactivated account", async () => {
  // Deactivation leaves role, permissions and discordId intact (guardrail 33
  // disables, it does not scrub), and assignDiscordRolesOnLink's diff only runs
  // while an account is linked — so a banned admin kept the Discord admin role
  // forever. revokeDiscordRolesOnUnlink is otherwise only reachable from an
  // explicit /unlink a banned user never performs. Skipping is not enough.
  const { token } = await mintSession({ role: "ADMIN", permissions: Permission.ADMIN });
  appUsers.push(
    { id: "banned", email: "banned@example.com", role: "ADMIN", discordId: VALID_SNOWFLAKE, permissions: 0n, deactivatedAt: new Date() },
  );

  const body = await (await doSyncRoles(token)).json();

  assert.equal(body.synced, 0, "a deactivated account is never granted roles");
  assert.equal(body.revoked, 1, "…it is actively stripped instead");
  assert.deepEqual(fetchCalls.filter((c) => c.method === "PUT"), [], "no grants for a banned user");
  assert.ok(fetchCalls.some((c) => c.method === "DELETE"), "managed roles are revoked");
});

test("a failing Discord role call does not fail the whole sync", async () => {
  roleCallsOk = false;
  const { token } = await mintSession({ role: "ADMIN", permissions: Permission.ADMIN });
  appUsers.push({ id: "l1", email: "l1@example.com", role: "USER", discordId: VALID_SNOWFLAKE, permissions: 0n, deactivatedAt: null });
  const res = await doSyncRoles(token);
  assert.equal(res.status, 200, "settleLimit isolates per-user failures");
});

test("sync-roles is audited with the count", async () => {
  const { token } = await mintSession({ role: "ADMIN", permissions: Permission.ADMIN });
  appUsers.push({ id: "l1", email: "l1@example.com", role: "USER", discordId: VALID_SNOWFLAKE, permissions: 0n, deactivatedAt: null });
  await doSyncRoles(token);
  for (const t of afterTasks.splice(0)) await t();
  const data = (opsOf("auditLog.create")[0].args as { data: { target: string; details: string } }).data;
  assert.equal(data.target, "discord:sync-roles");
  assert.equal(JSON.parse(data.details).syncedCount, 1);
});

test("register-commands is 400 without a bot token or client id, and calls nothing", async () => {
  const { token } = await mintSession({ role: "ADMIN", permissions: Permission.ADMIN });
  for (const missing of ["discordBotToken", "discordClientId"]) {
    settings.set("discordBotToken", "a-bot-token");
    settings.set("discordClientId", "999888777");
    settings.delete(missing);
    fetchCalls.length = 0;
    const res = await doRegister(token);
    assert.equal(res.status, 400, `missing ${missing} should 400`);
    assert.deepEqual(fetchCalls, []);
  }
});

test("register-commands registers GLOBALLY when no guild is set", async () => {
  settings.delete("discordGuildId"); // the shared fixture configures one
  const { token } = await mintSession({ role: "ADMIN", permissions: Permission.ADMIN });
  const res = await doRegister(token);
  assert.equal(res.status, 200);
  const call = fetchCalls.find((c) => c.url.pathname.includes("/commands"))!;
  assert.ok(!call.url.pathname.includes("/guilds/"), "no guild id ⇒ global registration");
  assert.equal(call.method, "PUT");
});

test("register-commands scopes to the GUILD when one is configured", async () => {
  settings.set("discordGuildId", "555444333");
  const { token } = await mintSession({ role: "ADMIN", permissions: Permission.ADMIN });
  const body = await (await doRegister(token)).json();
  const call = fetchCalls.find((c) => c.url.pathname.includes("/commands"))!;
  assert.match(call.url.pathname, /\/guilds\/555444333\/commands$/);
  assert.match(body.message, /guild 555444333/);
});

test("register-commands maps an upstream failure to 502 without leaking the body", async () => {
  registerOk = false;
  const { token } = await mintSession({ role: "ADMIN", permissions: Permission.ADMIN });
  const res = await doRegister(token);
  assert.equal(res.status, 502);
  const text = await res.text();
  assert.ok(!text.includes("REGISTER SECRET DETAIL"));
  assert.ok(errors.some((e) => e.includes("[discord]")));
});

test("register-commands never echoes the bot token", async () => {
  const { token } = await mintSession({ role: "ADMIN", permissions: Permission.ADMIN });
  const text = await (await doRegister(token)).text();
  assert.ok(!text.includes("a-bot-token"));
});

test("every discord.com call goes to discord.com and nowhere else", async () => {
  const { token } = await mintSession({ role: "ADMIN", permissions: Permission.ADMIN });
  await doRegister(token);
  const user = await mintSession();
  await doInitiate(user.token, { discordId: VALID_SNOWFLAKE });
  assert.ok(fetchCalls.length > 0);
  for (const c of fetchCalls) assert.equal(c.url.hostname, "discord.com");
});

