// A pending notification-email verification is a session foothold (guardrail 6g).
//
// POST /api/profile/notification-email mails a one-time link to a CANDIDATE
// address, and the confirm route that binds it is PUBLIC — it needs only the
// link. For a Jellyfin account (no provider email) the bound address receives
// every notification AND every security email from then on. So:
//
//   1. The owner's compromise response — sign out everywhere (both modes) and a
//      password change — deletes the user's pending `notif-email:<id>:` rows in
//      the SAME transaction as the session revocation, through the shared
//      foothold helpers (session-footholds.ts). Otherwise a hijacker who asked
//      for a link at THEIR address confirms it after the sign-out.
//   2. Planting one needs a step-up, exactly like linking Discord or connecting
//      Trakt: a web session older than 5 minutes (an SSO account) or without the
//      password (a password account) is refused with the shared step-up shapes,
//      BEFORE the send budget is spent, the token write or the mail. A NATIVE
//      session is exempt (the shipped iOS app calls this route and has no
//      prompt), so its wire contract is unchanged — and "native" is the signed
//      sentinel deadline, or a pre-6c 1-year session told by its AuthSession
//      row's span (never the token's iat, which the proxy re-signs to now),
//      never the header.
//   3. A spent send budget refuses BEFORE the step-up, so a loop of correct
//      passwords can't queue a scrypt per request (guardrail 6i).
//
// Harness (tests/profile-routes.test.mts idiom): real signed session JWTs over
// in-memory prisma stubs, a recording $transaction (array AND callback form), a
// recording fetch that only the scripted Resend send may satisfy, and dns.lookup
// stubbed. No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import dns from "node:dns/promises";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "notif-email-foothold-test-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) {
  throw new Error("could not stub dns.lookup — aborting before a real DNS query can leave the process");
}

const errors: string[] = [];
console.warn = () => {};
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

const fetchCalls: URL[] = [];
let fetchImpl: (url: URL) => Response | Promise<Response> = () => {
  throw new Error("unexpected fetch");
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

const { NextRequest } = await import("next/server");
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { signSessionJwt, verifySessionJwt } = await import("../src/lib/session-jwt.ts");
const { verifyAndRefreshSession } = await import("../src/lib/session-refresh.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");
const { hashPassword, scryptWorkDone } = await import("../src/lib/password-hash.ts");
const { NEVER_EXPIRES_AT_SEC, MAX_CONFIGURABLE_SESSION_SECONDS } = await import("../src/lib/session-lifetime.ts");
const { footholdDeletes, clearSessionFootholdsInTx } = await import("../src/lib/session-footholds.ts");
const { buildVerifyIdentifier, verifyIdentifierPrefixFor } = await import("../src/lib/notification-email-verify.ts");

// ── recording op log ────────────────────────────────────────────────────────
// `client` says which client ran the op: "db" (the global client, outside any
// transaction) or "tx" (the interactive transaction's client).
type Op = { op: string; client: "db" | "tx"; args?: unknown };
const ops: Op[] = [];
function opsOf(name: string, client?: "db" | "tx"): Op[] {
  return ops.filter((o) => o.op === name && (client === undefined || o.client === client));
}
// Each array-form $transaction's statements, so a test can prove a delete rode
// in the SAME transaction as the revocation.
const txArrays: unknown[][] = [];
let callbackTxCount = 0;

// A delete marker the array-form $transaction receives as one of its elements.
type Marker = { marker: string; args: unknown };
const isMarker = (v: unknown, name: string): v is Marker =>
  typeof v === "object" && v !== null && (v as Marker).marker === name;

// ── in-memory tables ────────────────────────────────────────────────────────
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
};
type SessionRow = { sessionId: string; userId: string; createdAt: Date; expiresAt: Date };
const usersById = new Map<string, DbUser>();
const sessionRows = new Map<string, SessionRow>();

function project(row: object, select?: Record<string, unknown>): Record<string, unknown> {
  if (!select) return { ...row };
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(select)) if (select[k]) out[k] = (row as Record<string, unknown>)[k];
  return out;
}

function makeClient(client: "db" | "tx") {
  const recDelete = (model: string) => async (args: unknown) => {
    ops.push({ op: `${model}.deleteMany`, client, args });
    return { count: 0 };
  };
  // Array-form statements are built eagerly by the route and handed to
  // $transaction; returning a marker (instead of a promise) lets the stub see
  // exactly which statements were in the array.
  const markDelete = (model: string) => (args: unknown): Marker => {
    ops.push({ op: `${model}.deleteMany`, client, args });
    return { marker: `${model}.deleteMany`, args };
  };
  const del = client === "db" ? markDelete : recDelete;
  return {
    user: {
      findUnique: async (args: { where: { id: string }; select?: Record<string, unknown> }) => {
        const u = usersById.get(args.where.id);
        return u ? project(u, args.select) : null;
      },
      update: client === "db"
        ? (args: unknown): Marker => { ops.push({ op: "user.update", client, args }); return { marker: "user.update", args }; }
        : async (args: unknown) => { ops.push({ op: "user.update", client, args }); return {}; },
      updateMany: async () => ({ count: 1 }),
    },
    authSession: {
      findUnique: async (args: { where: { sessionId: string }; select?: Record<string, unknown> }) => {
        const row = sessionRows.get(args.where.sessionId);
        return row ? project({ id: `row-${row.sessionId}`, ...row }, args.select) : null;
      },
      update: async () => ({}),
      deleteMany: client === "db"
        ? markDelete("authSession")
        : async (args: unknown) => { ops.push({ op: "authSession.deleteMany", client, args }); return { count: 1 }; },
    },
    pushSubscription: { deleteMany: del("pushSubscription") },
    discordLinkToken: { deleteMany: del("discordLinkToken") },
    discordMergeCode: { deleteMany: del("discordMergeCode") },
    verificationToken: {
      // The notification-email route itself runs these outside any transaction.
      deleteMany: client === "db"
        ? (args: unknown) => {
            ops.push({ op: "verificationToken.deleteMany", client, args });
            const m: Marker & PromiseLike<{ count: number }> = {
              marker: "verificationToken.deleteMany",
              args,
              then: (ok, bad) => Promise.resolve({ count: 0 }).then(ok, bad),
            };
            return m;
          }
        : recDelete("verificationToken"),
      create: async (args: unknown) => { ops.push({ op: "verificationToken.create", client, args }); return {}; },
    },
  };
}

const db = makeClient("db");
const txObj = makeClient("tx");
for (const model of ["user", "authSession", "pushSubscription", "discordLinkToken", "discordMergeCode", "verificationToken"] as const) {
  shadowPrismaModel(prisma, model, db[model]);
}
shadowPrismaModel(prisma, "userTotp", { findUnique: async () => null });
shadowPrismaModel(prisma, "webAuthnCredential", { findMany: async () => [] });
shadowPrismaModel(prisma, "mfaRecoveryCode", { count: async () => 0 });
shadowPrismaModel(prisma, "auditLog", { create: async () => ({}) });
const settings = new Map<string, string>();
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
  findMany: async (args: { where?: { key?: { in?: string[] } } } = {}) =>
    (args.where?.key?.in ?? [...settings.keys()])
      .filter((k) => settings.has(k))
      .map((k) => ({ key: k, value: settings.get(k) })),
});
shadowPrismaClientMethod(prisma, "$transaction", async (arg: unknown) => {
  if (Array.isArray(arg)) {
    txArrays.push(arg);
    return Promise.all(arg);
  }
  callbackTxCount++;
  return (arg as (tx: typeof txObj) => Promise<unknown>)(txObj);
});

// ── fixtures ────────────────────────────────────────────────────────────────
const CURRENT_PW = "current-password-abc123";
const CURRENT_PW_HASH = await hashPassword(CURRENT_PW);
const NEW_PW = "brand-new-password-xyz789";

let seq = 0;
async function mintSession(opts: {
  provider?: string;
  passwordHash?: string | null;
  // How long ago the caller signed in: its AuthSession.createdAt (the SSO
  // step-up proof), and what a finite deadline is measured from.
  ageMs?: number;
  native?: boolean;
  // A native sign-in from before guardrail 6c: a fixed 1-year deadline (not the
  // sentinel), no transport claim, its sign-in iat (the app never re-signs).
  // Implies `native`.
  legacyNative?: boolean;
  // A web session's deadline, seconds past its sign-in (default one day).
  webDeadlineSec?: number;
  // A web token minted before the transport claim, iat at sign-in, presented
  // as a BEARER — a stolen browser token replayed on the native transport.
  preClaimWebAsBearer?: boolean;
  // A web session that ALSO sends X-Summonarr-Client — a stolen cookie replayed
  // with the native header (guardrail 6g).
  clientHeader?: boolean;
} = {}): Promise<{ userId: string; sessionId: string; token: string; bearer: boolean; clientHeader?: boolean }> {
  seq++;
  const userId = `user-${seq}`;
  const sessionId = `sess-${seq}`;
  usersById.set(userId, {
    role: "USER",
    permissions: 0n,
    mediaServer: null,
    sessionsRevokedAt: null,
    passwordChangedAt: null,
    deactivatedAt: null,
    email: `user-${seq}@example.com`,
    name: `User ${seq}`,
    passwordHash: opts.passwordHash === undefined ? null : opts.passwordHash,
    notificationEmail: null,
  });
  const now = Math.floor(Date.now() / 1000);
  const signedInAt = Math.floor((Date.now() - (opts.ageMs ?? 0)) / 1000);
  const legacy = opts.legacyNative === true;
  const preClaim = legacy || opts.preClaimWebAsBearer === true;
  const native = opts.native === true || legacy;
  // A pre-claim token keeps its sign-in iat; a current web one stands for a
  // cookie re-signed just now.
  const iat = preClaim ? signedInAt : now;
  const expiresAt = legacy
    ? signedInAt + 365 * 86_400
    : native
      ? NEVER_EXPIRES_AT_SEC
      : signedInAt + (opts.webDeadlineSec ?? 86_400);
  // As initializeTokenOnSignIn writes it: created at sign-in, expiring at the
  // deadline, neither ever moved.
  sessionRows.set(sessionId, { sessionId, userId, createdAt: new Date(signedInAt * 1000), expiresAt: new Date(expiresAt * 1000) });
  const token = await signSessionJwt(
    {
      id: userId,
      role: "USER",
      permissions: "0",
      provider: opts.provider ?? "jellyfin",
      sessionId,
      expiresAt,
      // A pre-claim token: boundTransport infers bearer for one whose deadline
      // is over 90 days past its iat, and either transport otherwise.
      ...(preClaim ? {} : { transport: native ? ("bearer" as const) : ("cookie" as const) }),
    },
    { expiresInSeconds: preClaim ? expiresAt - iat : 7_200, iat },
  );
  return { userId, sessionId, token, bearer: native || opts.preClaimWebAsBearer === true, clientHeader: opts.clientHeader === true };
}

const COOKIE = getSessionCookieName();

function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = { route: "/notification-email-foothold.test", forceStatic: false, dynamicShouldError: false };
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

type Caller = { token: string; bearer: boolean; clientHeader?: boolean };

function makeReq(path: string, s: Caller, method: string, body: unknown) {
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: {
      ...(s.bearer
        ? { authorization: `Bearer ${s.token}`, "x-summonarr-client": "ios; build=100" }
        : { cookie: `${COOKIE}=${s.token}`, ...(s.clientHeader ? { "x-summonarr-client": "ios; build=100" } : {}) }),
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.7",
    },
    body: JSON.stringify(body),
  });
}

const { POST: revokeAllPOST } = await import("../src/app/api/sessions/revoke-all/route.ts");
const { PATCH: passwordPATCH } = await import("../src/app/api/profile/password/route.ts");
const { POST: notifEmailPOST } = await import("../src/app/api/profile/notification-email/route.ts");

const revokeAll = (s: Caller, body: unknown) =>
  inScope(() => revokeAllPOST(makeReq("/api/sessions/revoke-all", s, "POST", body), undefined));
const changePassword = (s: Caller, body: unknown) =>
  inScope(() => passwordPATCH(makeReq("/api/profile/password", s, "PATCH", body), undefined));
const postNotifEmail = (s: Caller, body: unknown) =>
  inScope(() => notifEmailPOST(makeReq("/api/profile/notification-email", s, "POST", body), undefined));

function configureEmail(): void {
  settings.set("enableUserEmails", "true");
  settings.set("emailBackend", "resend");
  settings.set("resendApiKey", "re_test_key");
  settings.set("resendFrom", "Summonarr <noreply@example.com>");
  fetchImpl = () => new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
}

beforeEach(() => {
  ops.length = 0;
  txArrays.length = 0;
  callbackTxCount = 0;
  fetchCalls.length = 0;
  errors.length = 0;
  settings.clear();
  fetchImpl = () => { throw new Error("unexpected fetch"); };
});

function pendingWhere(op: Op): string | undefined {
  return (op.args as { where?: { identifier?: { startsWith?: string } } }).where?.identifier?.startsWith;
}

// ═══ 1. the foothold helpers ════════════════════════════════════════════════

test("both foothold helpers delete exactly the user's pending notification-email verifications", async () => {
  const seen: Array<{ model: string; args: unknown }> = [];
  const client = Object.fromEntries(
    ["pushSubscription", "discordLinkToken", "discordMergeCode", "verificationToken"].map((model) => [
      model,
      { deleteMany: async (args: unknown) => { seen.push({ model, args }); return { count: 0 }; } },
    ]),
  ) as unknown as Parameters<typeof footholdDeletes>[0];

  await Promise.all(footholdDeletes(client, "u-1"));
  await clearSessionFootholdsInTx(client, "u-2");
  const verifications = seen.filter((s) => s.model === "verificationToken").map((s) => s.args);
  assert.deepEqual(verifications, [
    { where: { identifier: { startsWith: verifyIdentifierPrefixFor("u-1") } } },
    { where: { identifier: { startsWith: verifyIdentifierPrefixFor("u-2") } } },
  ]);
  // The prefix carries the user id AND its separator, so it can't match another
  // user whose id merely starts with this one's.
  assert.ok(buildVerifyIdentifier("u-1", "a@example.com").startsWith(verifyIdentifierPrefixFor("u-1")));
  assert.ok(!buildVerifyIdentifier("u-10", "a@example.com").startsWith(verifyIdentifierPrefixFor("u-1")));
});

test("sign out everywhere (includeCurrent) deletes the pending notification-email verification INSIDE its transaction", async () => {
  const s = await mintSession({ ageMs: 0 }); // fresh SSO session passes the step-up
  const res = await revokeAll(s, { includeCurrent: true });
  assert.equal(res.status, 200);
  assert.equal(callbackTxCount, 1);
  const inTx = opsOf("verificationToken.deleteMany", "tx");
  assert.equal(inTx.length, 1, "the verification delete runs on the transaction's client");
  assert.equal(pendingWhere(inTx[0]), verifyIdentifierPrefixFor(s.userId));
  assert.equal(opsOf("verificationToken.deleteMany", "db").length, 0, "never outside the transaction");
  assert.equal(opsOf("authSession.deleteMany", "tx").length, 1, "same transaction as the session revocation");
});

test("sign out other devices deletes the pending notification-email verification INSIDE its transaction", async () => {
  const s = await mintSession({ ageMs: 0 });
  const res = await revokeAll(s, { includeCurrent: false });
  assert.equal(res.status, 200);
  assert.equal(callbackTxCount, 1);
  const inTx = opsOf("verificationToken.deleteMany", "tx");
  assert.equal(inTx.length, 1);
  assert.equal(pendingWhere(inTx[0]), verifyIdentifierPrefixFor(s.userId));
  assert.equal(opsOf("verificationToken.deleteMany", "db").length, 0);
  assert.equal(opsOf("authSession.deleteMany", "tx").length, 1);
});

test("a password change deletes the pending notification-email verification in the SAME transaction as the revocation", async () => {
  const s = await mintSession({ provider: "credentials", passwordHash: CURRENT_PW_HASH });
  const res = await changePassword(s, { currentPassword: CURRENT_PW, newPassword: NEW_PW });
  assert.equal(res.status, 200);
  assert.equal(txArrays.length, 1, "one array-form transaction");
  const stmts = txArrays[0];
  const verification = stmts.find((x) => isMarker(x, "verificationToken.deleteMany"));
  assert.ok(verification, "the verification delete is a statement of the password transaction");
  assert.deepEqual(verification.args, { where: { identifier: { startsWith: verifyIdentifierPrefixFor(s.userId) } } });
  assert.ok(stmts.some((x) => isMarker(x, "authSession.deleteMany")), "beside the AuthSession delete");
  assert.ok(stmts.some((x) => isMarker(x, "user.update")), "beside the cutoff stamp");
});

// ═══ 2. planting one needs a step-up (web) ══════════════════════════════════

test("a web SSO session older than 5 minutes is refused session-too-old: no budget spent, no token, no mail", async () => {
  configureEmail();
  const s = await mintSession({ ageMs: 10 * 60_000 });
  const res = await postNotifEmail(s, { email: "attacker@evil.example" });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), {
    error: "session-too-old",
    message: "For your security, sign out and sign in again, then try this within 5 minutes.",
  });
  assert.equal(opsOf("verificationToken.create").length, 0, "no verification token stored");
  assert.equal(opsOf("verificationToken.deleteMany").length, 0, "the owner's own pending link is untouched");
  assert.equal(fetchCalls.length, 0, "no verification mail sent");

  // The refusal came BEFORE the 3-per-15-minutes send budget: once the session
  // is young, all three sends still go out.
  sessionRows.get(s.sessionId)!.createdAt = new Date();
  for (let i = 0; i < 3; i++) {
    assert.equal((await postNotifEmail(s, { email: "me@example.com" })).status, 200, `send ${i + 1}`);
  }
});

test("a web password account must confirm its password before a link is minted", async () => {
  configureEmail();
  const s = await mintSession({ passwordHash: CURRENT_PW_HASH });
  const res = await postNotifEmail(s, { email: "attacker@evil.example" });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "password-required", message: "Confirm your password to continue." });
  assert.equal(opsOf("verificationToken.create").length, 0);
  assert.equal(fetchCalls.length, 0);

  const ok = await postNotifEmail(s, { email: "me@example.com", confirmPassword: CURRENT_PW });
  assert.equal(ok.status, 200);
  assert.equal(opsOf("verificationToken.create").length, 1);
});

test("a fresh web SSO session passes the step-up and the link is minted and mailed", async () => {
  configureEmail();
  const s = await mintSession({ ageMs: 30_000 });
  const res = await postNotifEmail(s, { email: "me@example.com" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, email: "me@example.com" });
  const created = opsOf("verificationToken.create");
  assert.equal(created.length, 1);
  assert.equal(
    (created[0].args as { data: { identifier: string } }).data.identifier,
    buildVerifyIdentifier(s.userId, "me@example.com"),
  );
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].hostname, "api.resend.com");
});

test("a NATIVE session is exempt: the iOS app's unchanged request (no password, old session) still mints and mails", async () => {
  configureEmail();
  // Old AuthSession AND a local password: either would refuse a web session.
  const s = await mintSession({ native: true, ageMs: 30 * 24 * 60 * 60_000, passwordHash: CURRENT_PW_HASH });
  const res = await postNotifEmail(s, { email: "me@example.com" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, email: "me@example.com" }, "the wire reply is unchanged");
  assert.equal(opsOf("verificationToken.create").length, 1);
  assert.equal(fetchCalls.length, 1);
  assert.deepEqual(errors, []);
});

const SESSION_TOO_OLD = {
  error: "session-too-old",
  message: "For your security, sign out and sign in again, then try this within 5 minutes.",
};

test("a NATIVE token minted before guardrail 6c (1-year deadline) is exempt too: the iOS app isn't sent a 401 that signs it out", async () => {
  configureEmail();
  // The reviewer's case: a Jellyfin user with no password and a 60-day-old
  // AuthSession, which a web session would answer session-too-old; then the same
  // with a local password, which would be password-required.
  for (const passwordHash of [null, CURRENT_PW_HASH]) {
    const s = await mintSession({ legacyNative: true, ageMs: 60 * 24 * 60 * 60_000, passwordHash });
    const res = await postNotifEmail(s, { email: "me@example.com" });
    assert.equal(res.status, 200, `passwordHash=${passwordHash === null ? "none" : "set"}`);
    assert.deepEqual(await res.json(), { ok: true, email: "me@example.com" }, "the wire reply is unchanged");
  }
  assert.equal(opsOf("verificationToken.create").length, 2);
  assert.equal(fetchCalls.length, 2);
  assert.deepEqual(errors, []);
});

const DAY_MS = 24 * 60 * 60_000;

// What proxy.ts does to every request before the route runs: a DB-checked
// verify on the transport the token arrived on, then the FORWARDED header
// rewritten with the re-signed token — iat = now, the deadline unchanged.
async function throughProxy(s: Caller): Promise<Caller> {
  const result = await verifyAndRefreshSession(s.token, { transport: s.bearer ? "bearer" : "cookie", allowRotation: !s.bearer });
  assert.ok(result?.refreshed, "the proxy re-signs on its DB-checked verify");
  return { ...s, token: result.refreshed.token };
}

test("a pre-6c NATIVE token in its last 90 days is still exempt AFTER the proxy's re-sign: the AuthSession row decides, not the iat", async () => {
  configureEmail();
  for (const passwordHash of [null, CURRENT_PW_HASH]) {
    // Signed in 300 days ago on a 1-year deadline: 65 days left.
    const s = await mintSession({ legacyNative: true, ageMs: 300 * DAY_MS, passwordHash });
    const forwarded = await throughProxy(s);
    const claims = await verifySessionJwt(forwarded.token, "bearer");
    assert.ok(claims && typeof claims.expiresAt === "number" && typeof claims.iat === "number");
    assert.ok(
      claims.expiresAt - claims.iat < MAX_CONFIGURABLE_SESSION_SECONDS,
      "the forwarded token's deadline - iat is what a browser's could be",
    );
    const res = await postNotifEmail(forwarded, { email: "me@example.com" });
    assert.equal(res.status, 200, `passwordHash=${passwordHash === null ? "none" : "set"}`);
    assert.deepEqual(await res.json(), { ok: true, email: "me@example.com" }, "the wire reply is unchanged");
  }
  assert.equal(opsOf("verificationToken.create").length, 2);
  assert.equal(fetchCalls.length, 2);
  assert.deepEqual(errors, []);
});

test("a browser token at the longest deadline (90 days) replayed as a bearer is NOT native after the proxy's re-sign: session-too-old", async () => {
  configureEmail();
  // Pre-claim, so the bearer transport accepts it; its row spans exactly 90 days.
  const s = await mintSession({ preClaimWebAsBearer: true, ageMs: 89 * DAY_MS, webDeadlineSec: MAX_CONFIGURABLE_SESSION_SECONDS });
  const res = await postNotifEmail(await throughProxy(s), { email: "attacker@evil.example" });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), SESSION_TOO_OLD);
  assert.equal(opsOf("verificationToken.create").length, 0, "no verification token stored");
  assert.equal(fetchCalls.length, 0, "no verification mail sent");
});

test("a 1-year mobile BROWSER session (v0.13.7/v0.13.8 'remember me') is NOT native: it arrives on the cookie", async () => {
  configureEmail();
  const s = await mintSession({ ageMs: 100 * DAY_MS, webDeadlineSec: 365 * 86_400 });
  const res = await postNotifEmail(await throughProxy(s), { email: "attacker@evil.example" });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), SESSION_TOO_OLD);
  assert.equal(opsOf("verificationToken.create").length, 0, "no verification token stored");
  assert.equal(fetchCalls.length, 0, "no verification mail sent");
});

test("a pre-6c native token whose AuthSession row is gone is NOT native: session-too-old, nothing minted", async () => {
  configureEmail();
  const s = await mintSession({ legacyNative: true, ageMs: 300 * DAY_MS });
  const forwarded = await throughProxy(s);
  // Revoked between the proxy's check and the route (the forwarded token rides
  // the fast path, which reads no row).
  sessionRows.delete(s.sessionId);
  const res = await postNotifEmail(forwarded, { email: "attacker@evil.example" });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), SESSION_TOO_OLD);
  assert.equal(opsOf("verificationToken.create").length, 0, "no verification token stored");
  assert.equal(fetchCalls.length, 0, "no verification mail sent");
});

test("a web cookie at the longest browser deadline (90 days past sign-in) is NOT native: still session-too-old", async () => {
  configureEmail();
  const s = await mintSession({ ageMs: 10 * 60_000, webDeadlineSec: MAX_CONFIGURABLE_SESSION_SECONDS });
  const res = await postNotifEmail(s, { email: "attacker@evil.example" });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), SESSION_TOO_OLD);
  assert.equal(opsOf("verificationToken.create").length, 0, "no verification token stored");
  assert.equal(fetchCalls.length, 0, "no verification mail sent");
});

test("a web cookie replayed WITH X-Summonarr-Client is still a web session: session-too-old, no token, no mail", async () => {
  configureEmail();
  // Finite deadline, old AuthSession, cookie transport — plus the native header,
  // which is the client's to write and so never decides the exemption (6g).
  const s = await mintSession({ ageMs: 10 * 60_000, clientHeader: true });
  const res = await postNotifEmail(s, { email: "attacker@evil.example" });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), SESSION_TOO_OLD);
  assert.equal(opsOf("verificationToken.create").length, 0, "no verification token stored");
  assert.equal(opsOf("verificationToken.deleteMany").length, 0, "the owner's own pending link is untouched");
  assert.equal(fetchCalls.length, 0, "no verification mail sent");
});

test("once the send budget is spent, a correct-password POST is refused 429 BEFORE the step-up: no scrypt derivation", async () => {
  configureEmail();
  const s = await mintSession({ passwordHash: CURRENT_PW_HASH });
  for (let i = 0; i < 3; i++) {
    const ok = await postNotifEmail(s, { email: "me@example.com", confirmPassword: CURRENT_PW });
    assert.equal(ok.status, 200, `send ${i + 1}`);
  }
  for (let i = 0; i < 3; i++) {
    const before = scryptWorkDone();
    const res = await postNotifEmail(s, { email: "me@example.com", confirmPassword: CURRENT_PW });
    assert.equal(res.status, 429, `refusal ${i + 1}`);
    assert.equal(res.headers.get("retry-after"), "900");
    assert.deepEqual(await res.json(), {
      error: "Too many verification emails — try again later.",
    });
    assert.equal(scryptWorkDone() - before, 0, "a spent budget runs no password verify");
  }
  assert.equal(opsOf("verificationToken.create").length, 3, "only the three budgeted sends minted a link");
  assert.equal(fetchCalls.length, 3);
});
