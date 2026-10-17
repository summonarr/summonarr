// Guardrail 34e, OIDC half — who an OIDC sign-in may become, end to end:
//
//   GET  /api/auth/oidc/start         the flow cookie (`__Host-` on HTTPS), the
//                                     allowlist's opt-in "groups" scope
//   GET  /api/auth/oidc/callback      web completion
//   POST /api/auth/sign-in/oidc       native completion (the iOS app)
//   GET/PATCH /api/admin/oidc-allowlist  the admin allowlist setting
//
// What is pinned:
//   1. ONE set of rules on both transports. The allowlist (groups, verified
//      email domains, existing users only) refuses on the web callback AND the
//      native route, every refusal is audited AUTH_LOGIN_FAILED with its
//      specific reason, and each transport answers with a coarse code
//      (/login?error=…) or status + message. A stored allowlist that doesn't
//      parse refuses everyone (fail closed).
//   2. The account binds on (issuer, sub): the issuer comes from the ID token's
//      `iss` and is stored on the Account row at create.
//   3. notificationEmail follows the IdP's address ONLY when email_verified.
//   4. A sibling subdomain can't plant the flow cookie: on HTTPS it is
//      `__Host-summonarr-oidc-flow` (Secure, Path=/, no Domain) and the callback
//      never falls back to the unprefixed name.
//   5. The pure pieces: validation (a wrong field refuses the whole policy),
//      parsing, evaluation, the groups-claim reader, and the refusal → code /
//      status maps (every web code is worded on the login page; every native
//      message exists in the catalog).
//
// The IdP is real enough for openid-client: discovery, a JWKS, a token
// endpoint issuing RS256-signed ID tokens (jose), and userinfo — all behind a
// scripted fetch. No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import dns from "node:dns/promises";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

const HTTP_AUTH_URL = "http://localhost:3000";
const HTTPS_AUTH_URL = "https://summonarr.example.com";
const ISSUER = "https://idp.example.com";
const CLIENT_ID = "summonarr-test";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "oidc-identity-test-secret-0123456789abcdef";
process.env.AUTH_URL = HTTP_AUTH_URL;
process.env.TRUST_PROXY = "true";
process.env.OIDC_ISSUER = ISSUER;
process.env.OIDC_CLIENT_ID = CLIENT_ID;
process.env.OIDC_CLIENT_SECRET = "s3cret";
delete process.env.SUMMONARR_ALLOW_OAUTH_FIRST_ADMIN;
delete process.env.SUMMONARR_DEFAULT_LOCALE;
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// ── the fake IdP ─────────────────────────────────────────────────────────────
const { privateKey, publicKey } = await generateKeyPair("RS256");
const JWK = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
const idp = {
  // Extra ID-token claims for the next exchange (sub/email/groups/…).
  claims: {} as Record<string, unknown>,
  // What /userinfo answers (null ⇒ 404).
  userinfo: null as Record<string, unknown> | null,
  // The nonce the ID token must echo — the one signed into the flow state.
  nonce: "",
  userinfoCalls: 0,
  authorizeScope: "" as string | null,
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== ISSUER) throw new Error(`unexpected fetch to ${url}`);
  switch (url.pathname) {
    case "/.well-known/openid-configuration":
      return json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
        userinfo_endpoint: `${ISSUER}/userinfo`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
      });
    case "/jwks":
      return json({ keys: [JWK] });
    case "/token": {
      const now = Math.floor(Date.now() / 1000);
      const idToken = await new SignJWT({ nonce: idp.nonce, ...idp.claims })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(ISSUER)
        .setAudience(CLIENT_ID)
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .setSubject(String(idp.claims.sub ?? "sub-default"))
        .sign(privateKey);
      return json({ access_token: "idp-access-token", token_type: "Bearer", expires_in: 3600, id_token: idToken });
    }
    case "/userinfo":
      idp.userinfoCalls++;
      return idp.userinfo ? json(idp.userinfo) : json({ error: "not_found" }, 404);
  }
  throw new Error(`unexpected IdP path ${url.pathname}`);
}) as typeof fetch;

// ── Next request scope ───────────────────────────────────────────────────────
const cjsRequire = createRequire(import.meta.url);
type RunStore = { run<T>(store: unknown, fn: () => T): T };
const { workAsyncStorage } = cjsRequire("next/dist/server/app-render/work-async-storage.external.js") as { workAsyncStorage: RunStore };
const { workUnitAsyncStorage } = cjsRequire("next/dist/server/app-render/work-unit-async-storage.external.js") as { workUnitAsyncStorage: RunStore };
const { RequestCookies } = cjsRequire("next/dist/server/web/spec-extension/cookies.js") as { RequestCookies: new (h: Headers) => unknown };
const { RequestCookiesAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/request-cookies.js") as { RequestCookiesAdapter: { seal(c: unknown): unknown } };
const { HeadersAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/headers.js") as { HeadersAdapter: { seal(h: Headers): unknown } };

function inScope<T>(fn: () => Promise<T>, cookieHeader = ""): Promise<T> {
  const workStore = { route: "/oidc-identity.test", forceStatic: false, dynamicShouldError: false, afterContext: { after: () => {} } };
  const reqHeaders = new Headers(cookieHeader ? { cookie: cookieHeader } : {});
  const requestStore = {
    type: "request",
    phase: "render",
    headers: HeadersAdapter.seal(reqHeaders),
    cookies: RequestCookiesAdapter.seal(new RequestCookies(reqHeaders)),
    usedDynamic: false,
  };
  return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, fn));
}

// ── in-memory DB ─────────────────────────────────────────────────────────────
const { NextRequest } = await import("next/server");
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");

type UserRow = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  permissions: bigint;
  image: string | null;
  notificationEmail: string | null;
  mediaServer: string | null;
  deactivatedAt: Date | null;
  sessionsRevokedAt: Date | null;
  passwordChangedAt: Date | null;
  purgedAt: Date | null;
};
type AccountRow = {
  id: string;
  userId: string;
  type: string;
  provider: string;
  providerAccountId: string;
  issuer: string | null;
  access_token: string | null;
  refresh_token: string | null;
  id_token: string | null;
  expires_at: number | null;
};
type AuditRow = { action: string; provider: string | null; details: string | null; target: string };

let users: UserRow[] = [];
let accounts: AccountRow[] = [];
const settings = new Map<string, string>();
const sessionRows = new Set<string>();
let audits: AuditRow[] = [];
let seq = 0;

function pick(row: Record<string, unknown>, select?: Record<string, boolean>): Record<string, unknown> {
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]]));
}
function seedUser(overrides: Partial<UserRow> & { id: string; email: string }): UserRow {
  const row: UserRow = {
    name: null, role: "USER", permissions: 0n, image: null, notificationEmail: null, mediaServer: null,
    deactivatedAt: null, sessionsRevokedAt: null, passwordChangedAt: null, purgedAt: null,
    ...overrides,
  };
  users.push(row);
  return row;
}

shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id?: string; email?: string }; select?: Record<string, boolean> }) => {
    const row = users.find((u) => (args.where.id !== undefined ? u.id === args.where.id : u.email === args.where.email));
    return row ? pick(row, args.select) : null;
  },
  findFirst: async (args: { where?: { role?: string }; select?: Record<string, boolean> } = {}) => {
    const row = users.find((u) => args.where?.role === undefined || u.role === args.where.role);
    return row ? pick(row, args.select) : null;
  },
  create: async (args: { data: Record<string, unknown>; select?: Record<string, boolean> }) => {
    const row = seedUser({ id: `u-new-${++seq}`, ...(args.data as Partial<UserRow> & { email: string }) });
    return pick(row, args.select);
  },
  update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
    const row = users.find((u) => u.id === args.where.id);
    if (!row) throw new Error("user.update: no row");
    Object.assign(row, args.data);
    return { ...row };
  },
  updateMany: async () => ({ count: 0 }),
  count: async () => users.length,
});
shadowPrismaModel(prisma, "account", {
  findUnique: async (args: {
    where: { id?: string; provider_providerAccountId?: { provider: string; providerAccountId: string } };
    include?: { user?: boolean };
    select?: Record<string, boolean>;
  }) => {
    const w = args.where.provider_providerAccountId;
    const row = w
      ? accounts.find((a) => a.provider === w.provider && a.providerAccountId === w.providerAccountId)
      : accounts.find((a) => a.id === args.where.id);
    if (!row) return null;
    if (args.select) return pick(row, args.select);
    return args.include?.user ? { ...row, user: users.find((u) => u.id === row.userId) ?? null } : { ...row };
  },
  update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
    const row = accounts.find((a) => a.id === args.where.id);
    if (!row) throw new Error("account.update: no row");
    Object.assign(row, args.data);
    return { ...row };
  },
  updateMany: async (args: { where: { id: string; issuer?: null }; data: Record<string, unknown> }) => {
    const row = accounts.find((a) => a.id === args.where.id && (!("issuer" in args.where) || a.issuer === args.where.issuer));
    if (row) Object.assign(row, args.data);
    return { count: row ? 1 : 0 };
  },
  create: async (args: { data: Record<string, unknown> }) => {
    const row: AccountRow = {
      id: `acc-${++seq}`, issuer: null, access_token: null, refresh_token: null, id_token: null, expires_at: null,
      ...(args.data as Omit<AccountRow, "id" | "issuer" | "access_token" | "refresh_token" | "id_token" | "expires_at">),
    };
    accounts.push(row);
    return { ...row };
  },
});
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    const value = settings.get(args.where.key);
    return value === undefined ? null : { key: args.where.key, value };
  },
  findMany: async (args: { where?: { key?: { in?: string[] } } } = {}) =>
    (args.where?.key?.in ?? [...settings.keys()]).filter((k) => settings.has(k)).map((k) => ({ key: k, value: settings.get(k)! })),
  upsert: async (args: { where: { key: string }; create: { value: string }; update: { value?: string } }) => {
    const value = settings.has(args.where.key) ? (args.update.value ?? settings.get(args.where.key)!) : args.create.value;
    settings.set(args.where.key, value);
    return { key: args.where.key, value };
  },
});
shadowPrismaModel(prisma, "authSession", {
  findUnique: async (args: { where: { sessionId: string } }) =>
    sessionRows.has(args.where.sessionId) ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId } : null,
  upsert: async (args: { create: { sessionId: string } }) => {
    sessionRows.add(args.create.sessionId);
    return { id: "as" };
  },
  update: async () => ({}),
  updateMany: async () => ({ count: 0 }),
});
shadowPrismaModel(prisma, "auditLog", {
  create: async (args: { data: AuditRow }) => {
    audits.push(args.data);
    return { id: audits.length };
  },
});
shadowPrismaClientMethod(prisma, "$transaction", async (arg: unknown) =>
  Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => Promise<unknown>)(prisma));
shadowPrismaClientMethod(prisma, "$executeRawUnsafe", async () => 1);

const oidcStart = await import("../src/app/api/auth/oidc/start/route.ts");
const oidcCallback = await import("../src/app/api/auth/oidc/callback/route.ts");
const nativeSignIn = await import("../src/app/api/auth/sign-in/oidc/route.ts");
const allowlistRoute = await import("../src/app/api/admin/oidc-allowlist/route.ts");
const {
  OIDC_STATE_COOKIE,
  OIDC_STATE_COOKIE_SECURE,
  signOidcStateCookie,
} = await import("../src/lib/oidc.ts");
const { oidcNativeRefusal, oidcWebErrorCode } = await import("../src/lib/oidc-signin.ts");
const {
  DEFAULT_OIDC_ALLOWLIST,
  OIDC_ALLOWLIST_SETTING_KEY,
  evaluateOidcAllowlist,
  parseOidcAllowlist,
  readGroupsClaim,
  validateOidcAllowlist,
} = await import("../src/lib/oidc-allowlist.ts");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");
const { Permission } = await import("../src/lib/permissions.ts");

// ── helpers ──────────────────────────────────────────────────────────────────
function flushAsync(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
function failedAudits(): Array<Record<string, unknown>> {
  return audits
    .filter((a) => a.action === "AUTH_LOGIN_FAILED" && a.provider === "oidc")
    .map((a) => JSON.parse(a.details ?? "{}") as Record<string, unknown>);
}
function setAllowlist(policy: Partial<typeof DEFAULT_OIDC_ALLOWLIST>): void {
  settings.set(OIDC_ALLOWLIST_SETTING_KEY, JSON.stringify({ ...DEFAULT_OIDC_ALLOWLIST, ...policy }));
}
function redirectError(res: Response): string | null {
  const loc = res.headers.get("location");
  return loc ? new URL(loc).searchParams.get("error") : null;
}

let ipSeq = 0;
function nextIp(): string {
  return `198.51.100.${(++ipSeq % 250) + 1}`;
}

// A whole web completion: a signed flow cookie (as /start would set) carried
// to the callback, which exchanges the code with the fake IdP.
async function webSignIn(claims: Record<string, unknown>, opts: { cookieName?: string } = {}): Promise<Response> {
  idp.claims = claims;
  idp.nonce = `nonce-${++seq}`;
  const state = `state-${seq}`;
  const base = process.env.AUTH_URL!;
  const flow = await signOidcStateCookie({
    state, nonce: idp.nonce, codeVerifier: "v".repeat(43), redirectUri: `${base}/api/auth/oidc/callback`, returnTo: "/requests",
  });
  const cookieName = opts.cookieName ?? (base.startsWith("https://") ? OIDC_STATE_COOKIE_SECURE : OIDC_STATE_COOKIE);
  const cookie = `${cookieName}=${flow}`;
  const req = new NextRequest(`${base}/api/auth/oidc/callback?code=code-${seq}&state=${state}`, {
    method: "GET",
    headers: { cookie, "x-forwarded-for": nextIp() },
  });
  return inScope(() => oidcCallback.GET(req), cookie);
}

// A whole native completion, as the iOS app drives it.
async function nativeSignInWith(claims: Record<string, unknown>): Promise<Response> {
  idp.claims = claims;
  idp.nonce = `nonce-${++seq}`;
  const state = `nat.state-${seq}`;
  const flowState = await signOidcStateCookie({
    state, nonce: idp.nonce, codeVerifier: "v".repeat(43), redirectUri: `${process.env.AUTH_URL}/api/auth/oidc/callback`,
  });
  const req = new NextRequest(`${process.env.AUTH_URL}/api/auth/sign-in/oidc`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-summonarr-client": "ios; build=60", "x-forwarded-for": nextIp() },
    body: JSON.stringify({ code: `code-${seq}`, state, flowState }),
  });
  return inScope(() => nativeSignIn.POST(req));
}

const VERIFIED = { email: "member@example.com", email_verified: true, name: "Member" };

beforeEach(() => {
  users = [];
  accounts = [];
  settings.clear();
  settings.set("setup_completed_at", "2026-01-01T00:00:00.000Z");
  sessionRows.clear();
  audits = [];
  warns.length = 0;
  errors.length = 0;
  idp.claims = {};
  idp.userinfo = null;
  idp.userinfoCalls = 0;
  process.env.AUTH_URL = HTTP_AUTH_URL;
  // An admin exists, so first-admin promotion stays out of the way.
  seedUser({ id: "u-admin", email: "admin@example.com", role: "ADMIN" });
});

// ── 1. one set of rules on both transports ──────────────────────────────────

test("no allowlist: a verified OIDC user signs in on both transports, bound to (issuer, sub)", async () => {
  const web = await webSignIn({ sub: "sub-web", ...VERIFIED });
  assert.equal(web.status, 307);
  assert.equal(new URL(web.headers.get("location")!).pathname, "/requests", `got ${web.headers.get("location")}`);
  const created = accounts.find((a) => a.providerAccountId === "sub-web");
  assert.ok(created, "the account row is created");
  assert.equal(created.issuer, ISSUER, "the issuer is the ID token's iss");

  const native = await nativeSignInWith({ sub: "sub-native", email: "native@example.com", email_verified: true });
  assert.equal(native.status, 200);
  assert.ok(((await native.json()) as { token?: string }).token, "the native client gets its token in the body");
  assert.equal(accounts.find((a) => a.providerAccountId === "sub-native")?.issuer, ISSUER);
  await flushAsync();
  assert.equal(failedAudits().length, 0);
});

test("allowlist groups: refused on BOTH transports when the claim lacks every allowed group, audited not_in_allowed_group", async () => {
  setAllowlist({ groups: ["summonarr-users"] });
  const web = await webSignIn({ sub: "sub-g1", ...VERIFIED, groups: ["other", "Summonarr-Users"] });
  assert.equal(redirectError(web), "oidc_not_allowed", "group names match exactly — case included");
  const native = await nativeSignInWith({ sub: "sub-g2", ...VERIFIED, groups: ["other"] });
  assert.equal(native.status, 403);
  assert.equal(((await native.json()) as { error: string }).error, "This account isn't allowed to sign in here. Contact the server owner.");
  await flushAsync();
  assert.deepEqual(failedAudits().map((d) => d.reason), ["not_in_allowed_group", "not_in_allowed_group"]);
  assert.equal(accounts.length, 0, "a refused sign-in mints nothing");
  assert.equal(sessionRows.size, 0);
});

test("allowlist groups: a member of an allowed group is admitted — from the ID token, or from userinfo when the token lacks the claim", async () => {
  setAllowlist({ groups: ["summonarr-users"], groupsClaim: "roles" });
  const fromToken = await webSignIn({ sub: "sub-g3", ...VERIFIED, roles: ["summonarr-users"] });
  assert.equal(new URL(fromToken.headers.get("location")!).pathname, "/requests");
  assert.equal(idp.userinfoCalls, 0, "no userinfo round-trip when the ID token carries the claim");

  idp.userinfo = { sub: "sub-g4", roles: "summonarr-users" };
  const fromUserinfo = await nativeSignInWith({ sub: "sub-g4", email: "g4@example.com", email_verified: true });
  assert.equal(fromUserinfo.status, 200);
  assert.equal(idp.userinfoCalls, 1);
});

test("allowlist groups: a userinfo failure fails CLOSED", async () => {
  setAllowlist({ groups: ["summonarr-users"] });
  const res = await nativeSignInWith({ sub: "sub-g5", ...VERIFIED }); // no claim, userinfo 404
  assert.equal(res.status, 403);
  await flushAsync();
  assert.equal(failedAudits()[0]?.reason, "not_in_allowed_group");
});

test("allowlist email domains: only a VERIFIED address in a listed domain passes; subdomains don't", async () => {
  setAllowlist({ emailDomains: ["example.com"] });
  const unverified = await webSignIn({ sub: "sub-d1", email: "x@example.com", email_verified: false });
  assert.equal(redirectError(unverified), "oidc_email_unverified");
  const sub = await webSignIn({ sub: "sub-d2", email: "x@corp.example.com", email_verified: true });
  assert.equal(redirectError(sub), "oidc_not_allowed");
  const elsewhere = await nativeSignInWith({ sub: "sub-d3", email: "x@evil.test", email_verified: true });
  assert.equal(elsewhere.status, 403);
  const ok = await nativeSignInWith({ sub: "sub-d4", email: "x@EXAMPLE.com", email_verified: true });
  assert.equal(ok.status, 200);
  await flushAsync();
  assert.deepEqual(failedAudits().map((d) => d.reason), ["email_unverified", "email_domain_not_allowed", "email_domain_not_allowed"]);
  assert.ok(failedAudits().every((d) => typeof d.emailHash === "string" && !String(d.emailHash).includes("@")), "the audit carries a hash, never the address");
});

test("allowlist existing-users-only: a NEW account is refused on both transports; a linked one still signs in", async () => {
  setAllowlist({ existingUsersOnly: true });
  assert.equal(redirectError(await webSignIn({ sub: "sub-e1", ...VERIFIED })), "oidc_not_allowed");
  assert.equal((await nativeSignInWith({ sub: "sub-e2", email: "e2@example.com", email_verified: true })).status, 403);
  await flushAsync();
  assert.deepEqual(failedAudits().map((d) => d.reason), ["existing_users_only", "existing_users_only"]);
  assert.equal(users.length, 1, "nothing minted");

  seedUser({ id: "u-linked", email: "linked@example.com" });
  accounts.push({ id: "acc-linked", userId: "u-linked", type: "oidc", provider: "oidc", providerAccountId: "sub-linked", issuer: ISSUER, access_token: null, refresh_token: null, id_token: null, expires_at: null });
  assert.equal((await nativeSignInWith({ sub: "sub-linked", email: "linked@example.com", email_verified: true })).status, 200);
});

test("an UNREADABLE stored allowlist refuses every OIDC sign-in (fail closed), audited allowlist_unreadable", async () => {
  settings.set(OIDC_ALLOWLIST_SETTING_KEY, "{not json");
  assert.equal(redirectError(await webSignIn({ sub: "sub-u1", ...VERIFIED })), "oidc_not_allowed");
  assert.equal((await nativeSignInWith({ sub: "sub-u2", ...VERIFIED })).status, 403);
  await flushAsync();
  assert.deepEqual(failedAudits().map((d) => d.reason), ["allowlist_unreadable", "allowlist_unreadable"]);
});

test("rebind-required and unverified-email refusals are AUDITED on both transports (they used to leave no trace)", async () => {
  seedUser({ id: "u-local", email: "member@example.com" }); // a local account with the IdP's address
  assert.equal(redirectError(await webSignIn({ sub: "sub-r1", ...VERIFIED })), "oidc_rebind_required");
  const native = await nativeSignInWith({ sub: "sub-r2", ...VERIFIED });
  assert.equal(native.status, 409, "the app's existing 409 contract is unchanged");
  assert.equal(redirectError(await webSignIn({ sub: "sub-r3", email: "new@example.com", email_verified: false })), "oidc_email_unverified");
  const nativeUnverified = await nativeSignInWith({ sub: "sub-r4", email: "new2@example.com", email_verified: false });
  assert.equal(nativeUnverified.status, 403, "an unverified email is a refusal, not a 500");
  await flushAsync();
  assert.deepEqual(failedAudits().map((d) => d.reason), ["rebind_required", "rebind_required", "email_unverified", "email_unverified"]);
});

test("a subject bound under a different issuer is refused on both transports, audited issuer_mismatch", async () => {
  seedUser({ id: "u-old", email: "old@example.com", role: "ADMIN" });
  accounts.push({ id: "acc-old", userId: "u-old", type: "oidc", provider: "oidc", providerAccountId: "sub-shared", issuer: "https://old-idp.example.com", access_token: "old", refresh_token: null, id_token: null, expires_at: null });
  assert.equal(redirectError(await webSignIn({ sub: "sub-shared", ...VERIFIED })), "oidc_issuer_mismatch");
  assert.equal((await nativeSignInWith({ sub: "sub-shared", ...VERIFIED })).status, 403);
  await flushAsync();
  assert.deepEqual(failedAudits().map((d) => d.reason), ["issuer_mismatch", "issuer_mismatch"]);
  assert.equal(sessionRows.size, 0);
});

// ── 3. notificationEmail follows only a verified address ────────────────────

test("notificationEmail is copied from the IdP only when email_verified is true", async () => {
  seedUser({ id: "u-ret", email: "ret@example.com", notificationEmail: "mine@example.com" });
  accounts.push({ id: "acc-ret", userId: "u-ret", type: "oidc", provider: "oidc", providerAccountId: "sub-ret", issuer: ISSUER, access_token: null, refresh_token: null, id_token: null, expires_at: null });

  // A returning user with an UNVERIFIED claim still signs in, but the claim is
  // whatever they typed at the IdP — it must not redirect notifications.
  const unverified = await webSignIn({ sub: "sub-ret", email: "someone-else@example.com", email_verified: false });
  assert.equal(new URL(unverified.headers.get("location")!).pathname, "/requests");
  assert.equal(users.find((u) => u.id === "u-ret")!.notificationEmail, "mine@example.com");

  const verified = await nativeSignInWith({ sub: "sub-ret", email: "Verified@Example.com", email_verified: true });
  assert.equal(verified.status, 200);
  assert.equal(users.find((u) => u.id === "u-ret")!.notificationEmail, "verified@example.com");
});

// ── 4. the flow cookie ──────────────────────────────────────────────────────

test("start on HTTPS sets the `__Host-` flow cookie (Secure, Path=/, no Domain); on http the BASE_PATH-scoped plain one", async () => {
  process.env.AUTH_URL = HTTPS_AUTH_URL;
  const secure = await inScope(() => oidcStart.GET(new NextRequest(`${HTTPS_AUTH_URL}/api/auth/oidc/start`, { headers: { "x-forwarded-for": nextIp() } })));
  assert.equal(secure.status, 307);
  const cookie = secure.headers.getSetCookie().find((c) => c.includes("oidc-flow="));
  assert.ok(cookie, "a flow cookie is set");
  assert.ok(cookie.startsWith(`${OIDC_STATE_COOKIE_SECURE}=`), cookie);
  assert.match(cookie, /; Path=\/;/);
  assert.match(cookie, /; Secure/);
  assert.match(cookie, /; HttpOnly/);
  assert.doesNotMatch(cookie, /Domain=/i);

  process.env.AUTH_URL = HTTP_AUTH_URL;
  const plain = await inScope(() => oidcStart.GET(new NextRequest(`${HTTP_AUTH_URL}/api/auth/oidc/start`, { headers: { "x-forwarded-for": nextIp() } })));
  const plainCookie = plain.headers.getSetCookie().find((c) => c.includes("oidc-flow="));
  assert.ok(plainCookie, "a flow cookie is set on http too");
  assert.ok(plainCookie.startsWith(`${OIDC_STATE_COOKIE}=`), plainCookie);
  assert.match(plainCookie, /; Path=\/api\/auth\/oidc;/);
  assert.doesNotMatch(plainCookie, /Secure/);
});

test("the callback on HTTPS reads ONLY the `__Host-` cookie — an unprefixed one (what a sibling subdomain can plant) is ignored", async () => {
  process.env.AUTH_URL = HTTPS_AUTH_URL;
  const planted = await webSignIn({ sub: "sub-planted", ...VERIFIED }, { cookieName: OIDC_STATE_COOKIE });
  assert.equal(redirectError(planted), "oidc_no_state");
  assert.equal(accounts.length, 0, "the planted flow is never exchanged");

  const genuine = await webSignIn({ sub: "sub-genuine", ...VERIFIED });
  assert.equal(new URL(genuine.headers.get("location")!).pathname, "/requests");
  const cleared = genuine.headers.getSetCookie().find((c) => c.startsWith(`${OIDC_STATE_COOKIE_SECURE}=;`));
  assert.ok(cleared, "the clear uses the same name");
  assert.match(cleared, /Max-Age=0/);
  assert.match(cleared, /Path=\//);
  assert.match(cleared, /Secure/);
});

test("start requests the groups scope only when the allowlist opts in", async () => {
  const scopeOf = async () => {
    const res = await inScope(() => oidcStart.GET(new NextRequest(`${HTTP_AUTH_URL}/api/auth/oidc/start`, { headers: { "x-forwarded-for": nextIp() } })));
    return new URL(res.headers.get("location")!).searchParams.get("scope");
  };
  assert.equal(await scopeOf(), "openid profile email");
  setAllowlist({ groups: ["a"], requestGroupsScope: true });
  assert.equal(await scopeOf(), "openid profile email groups");
});

// ── the admin route ──────────────────────────────────────────────────────────

async function mintSession(role: string, permissions: bigint): Promise<string> {
  const id = `caller-${++seq}`;
  const sessionId = `sess-${seq}`;
  seedUser({ id, email: `${id}@example.com`, role, permissions });
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000);
  return signSessionJwt(
    { id, role, permissions: permissions.toString(), provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
}
function adminReq(method: "GET" | "PATCH", token: string | null, body?: unknown): InstanceType<typeof NextRequest> {
  return new NextRequest(`${HTTP_AUTH_URL}/api/admin/oidc-allowlist`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": nextIp(),
      ...(token ? { cookie: `${getSessionCookieName()}=${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
async function callAllowlist(method: "GET" | "PATCH", token: string | null, body?: unknown): Promise<Response> {
  const req = adminReq(method, token, body);
  const cookie = req.headers.get("cookie") ?? "";
  return inScope(() => (method === "GET" ? allowlistRoute.GET(req, undefined) : allowlistRoute.PATCH(req, undefined)), cookie);
}

test("admin route: ADMIN only — anonymous 401, a MANAGE_USERS delegate 403, nothing written", async () => {
  assert.equal((await callAllowlist("GET", null)).status, 401);
  const delegate = await mintSession("USER", Permission.MANAGE_USERS);
  assert.equal((await callAllowlist("PATCH", delegate, { existingUsersOnly: true })).status, 403);
  assert.equal(settings.has(OIDC_ALLOWLIST_SETTING_KEY), false);
});

test("admin route: GET reports the default and an unreadable value; PATCH saves the normalized policy and audits it", async () => {
  const admin = await mintSession("ADMIN", Permission.ADMIN);
  assert.deepEqual(await (await callAllowlist("GET", admin)).json(), { allowlist: DEFAULT_OIDC_ALLOWLIST, unreadable: false });

  const res = await callAllowlist("PATCH", admin, {
    groups: [" summonarr ", "summonarr", ""],
    groupsClaim: "roles",
    requestGroupsScope: true,
    emailDomains: ["@Example.COM", "corp.example.org"],
    existingUsersOnly: true,
  });
  assert.equal(res.status, 200);
  const saved = { groups: ["summonarr"], groupsClaim: "roles", requestGroupsScope: true, emailDomains: ["example.com", "corp.example.org"], existingUsersOnly: true };
  assert.deepEqual(await res.json(), { allowlist: saved, unreadable: false });
  assert.deepEqual(JSON.parse(settings.get(OIDC_ALLOWLIST_SETTING_KEY)!), saved);
  await flushAsync();
  const audit = audits.find((a) => a.action === "SETTINGS_CHANGE");
  assert.ok(audit);
  assert.equal(audit.target, "oidc-allowlist");

  settings.set(OIDC_ALLOWLIST_SETTING_KEY, "garbage");
  assert.equal(((await (await callAllowlist("GET", admin)).json()) as { unreadable: boolean }).unreadable, true);
});

test("admin route: a wrong field refuses the WHOLE policy (400) and leaves the stored value alone", async () => {
  const admin = await mintSession("ADMIN", Permission.ADMIN);
  setAllowlist({ groups: ["keep"] });
  const before = settings.get(OIDC_ALLOWLIST_SETTING_KEY);
  for (const body of [
    { groups: "not-a-list" },
    { emailDomains: ["not a domain"] },
    { groupsClaim: "has space" },
    { existingUsersOnly: "yes" },
  ]) {
    const res = await callAllowlist("PATCH", admin, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok(((await res.json()) as { error: string }).error.length > 0);
  }
  assert.equal(settings.get(OIDC_ALLOWLIST_SETTING_KEY), before);
});

// ── 5. the pure pieces ───────────────────────────────────────────────────────

test("validateOidcAllowlist: defaults, trimming/dedupe, and every refusal", () => {
  assert.deepEqual(validateOidcAllowlist({}), { ok: true, value: DEFAULT_OIDC_ALLOWLIST });
  assert.deepEqual(validateOidcAllowlist({ groupsClaim: "  " }), { ok: true, value: DEFAULT_OIDC_ALLOWLIST }, "a blank claim name is the default");
  assert.deepEqual(validateOidcAllowlist(null), { ok: false, field: "groups" });
  assert.deepEqual(validateOidcAllowlist({ groups: [1] }), { ok: false, field: "groups" });
  assert.deepEqual(validateOidcAllowlist({ groups: ["a\u0000b"] }), { ok: false, field: "groups" });
  assert.deepEqual(validateOidcAllowlist({ groups: Array.from({ length: 51 }, (_, i) => `g${i}`) }), { ok: false, field: "groups" });
  assert.deepEqual(validateOidcAllowlist({ groupsClaim: "a b" }), { ok: false, field: "groupsClaim" });
  assert.equal(validateOidcAllowlist({ groupsClaim: "https://example.com/claims/groups" }).ok, true);
  assert.deepEqual(validateOidcAllowlist({ emailDomains: ["localhost"] }), { ok: false, field: "emailDomains" });
  assert.deepEqual(validateOidcAllowlist({ requestGroupsScope: 1 }), { ok: false, field: "requestGroupsScope" });
  assert.deepEqual(validateOidcAllowlist({ existingUsersOnly: "true" }), { ok: false, field: "existingUsersOnly" });
});

test("parseOidcAllowlist: no row is the default (off); a row that doesn't parse or validate is null (refuse)", () => {
  assert.deepEqual(parseOidcAllowlist(undefined), DEFAULT_OIDC_ALLOWLIST);
  assert.deepEqual(parseOidcAllowlist(null), DEFAULT_OIDC_ALLOWLIST);
  assert.equal(parseOidcAllowlist("{"), null);
  assert.equal(parseOidcAllowlist(JSON.stringify({ emailDomains: ["bad domain"] })), null);
  assert.equal(parseOidcAllowlist("[]"), null);
});

test("evaluateOidcAllowlist: groups intersect exactly, an absent claim refuses, domains need a verified exact match", () => {
  const p = { ...DEFAULT_OIDC_ALLOWLIST, groups: ["Admins"], emailDomains: ["example.com"] };
  const ok = { email: "a@example.com", emailVerified: true, groups: ["x", "Admins"] };
  assert.equal(evaluateOidcAllowlist(DEFAULT_OIDC_ALLOWLIST, { email: null, emailVerified: false, groups: null }), null);
  assert.equal(evaluateOidcAllowlist(p, ok), null);
  assert.equal(evaluateOidcAllowlist(p, { ...ok, groups: ["admins"] }), "not_in_allowed_group");
  assert.equal(evaluateOidcAllowlist(p, { ...ok, groups: null }), "not_in_allowed_group");
  assert.equal(evaluateOidcAllowlist(p, { ...ok, email: null }), "email_missing");
  assert.equal(evaluateOidcAllowlist(p, { ...ok, emailVerified: false }), "email_unverified");
  assert.equal(evaluateOidcAllowlist(p, { ...ok, email: "a@sub.example.com" }), "email_domain_not_allowed");
});

test("readGroupsClaim: arrays (strings only), a single string, absent → null, and never the prototype", () => {
  assert.deepEqual(readGroupsClaim({ groups: ["a", 1, "b"] }, "groups"), ["a", "b"]);
  assert.deepEqual(readGroupsClaim({ groups: "a" }, "groups"), ["a"]);
  assert.equal(readGroupsClaim({}, "groups"), null);
  assert.equal(readGroupsClaim({ groups: 5 }, "groups"), null);
  assert.equal(readGroupsClaim({}, "constructor"), null);
});

test("every refusal maps to a code the login page words, and a native message that exists", () => {
  const loginForm = readFileSync(new URL("../src/app/login/login-form.tsx", import.meta.url), "utf8");
  const apiAuth = JSON.parse(readFileSync(new URL("../src/lib/i18n/messages/en/apiAuth.json", import.meta.url), "utf8")) as Record<string, string>;
  const reasons = [
    "rebind_required", "setup_required", "instance_mismatch", "issuer_mismatch", "email_unverified", "email_missing",
    "reserved_email", "not_in_allowed_group", "email_domain_not_allowed", "existing_users_only", "allowlist_unreadable",
  ] as const;
  for (const reason of reasons) {
    const code = oidcWebErrorCode(reason);
    assert.ok(loginForm.includes(`  ${code}: "auth.login.error.oidc.${code}",`), `${reason} → ${code} must be in LOGIN_ERROR_CODE_KEYS`);
    const native = oidcNativeRefusal(reason);
    assert.ok(apiAuth[native.messageKey], `${reason} → ${native.messageKey} must exist`);
  }
  // The two refusals the app has always received as 409 still are (guardrail 25).
  assert.equal(oidcNativeRefusal("rebind_required").status, 409);
  assert.equal(oidcNativeRefusal("setup_required").status, 409);
});
