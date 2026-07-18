// Unit tests for the auth ORCHESTRATION layer (src/lib/auth.ts) — the module
// that wires the owned-elsewhere primitives into sign-in flows, session mints,
// and revocation. The contracts pinned here:
//
//   auth() — the JWT-only session read (guardrail 29's personalization side):
//   a valid cookie maps to the exact SummonarrSession shape (role-preset
//   permission fallback, ADMIN superbit OR-in), absent/expired/tampered all
//   read null, and the WHOLE read runs with the DB stub LOCKED (every prisma
//   access throws) — proving auth() never touches the DB, the distinction
//   authActive() exists to close.
//
//   authorizeWithCredentials — every refusal is as load-bearing as the accept:
//   guard clauses (missing fields, oversized password) refuse with ZERO DB
//   reads; disableLocalLogin refuses VALID credentials; unknown account and
//   wrong password refuse identically (audit reason invalid_credentials) and
//   only a genuine failed verify records an account-bucket hit (the
//   peek/record split — a success records nothing); a tripped account bucket
//   refuses BEFORE the user lookup and is keyed on the NORMALIZED email (a
//   case-variant spray can't dodge it); a tripped per-IP bucket refuses even
//   correct credentials; the accept returns the full DeviceMeta payload and
//   finds the user under the NFKC/lowercase/trim-normalized email.
//
//   authorizeWithPlex — fail-closed matrix on one scripted plex.tv wire:
//   unconfigured plexServerUrl refuses outright (no fetch — the unscoped
//   friend-list hole), a friend on THIS server's allowlist is provisioned
//   (numeric plex id coerced to a string sub, token cache bound, notification
//   email synced), and a stranger with a VALID plex token but no share on this
//   machineIdentifier is refused with no row minted.
//
//   findOrCreate{Plex,Jellyfin,Oidc}User — provider-subject binding is the
//   only identity anchor: an existing sub match returns that row's identity
//   (role preserved) regardless of the reported email; an email collision with
//   an unbound row returns PROVIDER_REBIND_REQUIRED and mutates nothing (the
//   account-takeover guard); the pre-setup bootstrap gate returns
//   PROVIDER_SETUP_REQUIRED from all three creators until setup completes, an
//   admin exists, or SUMMONARR_ALLOW_OAUTH_FIRST_ADMIN=true (which mints a
//   plain USER — never an ADMIN); creates seed role USER + the USER preset
//   bitmask with sanitized names and normalized emails; the OIDC create issues
//   a TOP-LEVEL account.create inside the $transaction (the shape guardrail 7a
//   depends on) with the raw tokens passed through for the extension.
//
//   authorizeWithJellyfin(+QuickConnect) — the fail-closed membership gate:
//   valid Jellyfin credentials alone do NOT sign in (unknown and
//   inactive-MediaServerUser accounts refuse with reason not_authorized); an
//   active synced member and a returning bound user pass (the latter with a
//   name refresh); jellyfinRestrictSignIn="false" opens the gate; an
//   unconfigured URL and a 401 wire both refuse; the QuickConnect per-secret
//   bucket (hashed into the limiter key) refuses before any fetch.
//
//   signInAndMintSession — the mint: SignInResult/JWT claim shape (permissions
//   claim read from the DB row, uaFingerprint/deviceLabel carried), the
//   AuthSession row upsert (deviceType/label/ip), the AUTH_LOGIN audit row
//   carrying an emailHash and never the raw email, mediaServer provider-pinned
//   for plex vs DB-resolved for credentials, the TTL decision table
//   (desktop/mobile/rememberMe/native) where the 1-year native TTL requires
//   the X-Summonarr-Client header — a spoofed mobile UA + rememberMe alone
//   stays at maxDuration (guardrail 6b) — and first-admin promotion firing for
//   credentials only (OIDC pre-setup stays USER; the env flag opts in).
//
//   revokeSessionById / revokeAllUserSessions — DB write FIRST, in-memory mark
//   AFTER commit (guardrail 27: a failed transaction propagates and leaves NO
//   mark), the sessionsRevokedAt cutoff bumped forward-only to the revoked
//   row's createdAt, and revoke-all marking every session plus the user.
//
// Owned elsewhere (not re-tested here): scrypt verify matrix
// (password-hash.test), JWT sign/verify + alg pinning (session-jwt.test),
// cookie naming (session-cookie.test), DB-checked refresh/rotation
// (session-refresh-rotation.test, session-server.test), the force-revalidate
// ledger internals (session-revocation.test), the token-in-body gate
// (sign-in-response.test), limiter + getClientIp anti-spoof (rate-limit.test),
// audit writer field mapping (audit.test), fingerprint classification
// (ua-fingerprint.test), permission bit math (permissions.test), email NFKC
// rules (email-normalize.test), sanitize matrix (sanitize.test), the
// Plex/Jellyfin wire clients (plex.test, jellyfin.test), the membership-cache
// slow path (plex-membership.test), and authActive()'s full request path
// (maintenance.test drives it end-to-end through maintenanceGuard).
// initializeTokenOnSignIn is exercised through signInAndMintSession (its only
// production caller path here); invalidateUserSession is a one-line delegate
// to the ledger owned by session-revocation.test.
//
// No DB or network: globalThis.prisma is pre-seeded with a recording,
// lockable in-memory fake BEFORE the module graph loads (poster-cache.test
// pattern), globalThis.fetch is scripted per URL, and dns/promises.lookup is
// stubbed for the plex.tv SSRF resolve (admin-configured base URLs are IP
// literals, which skip DNS entirely). Flows that reach next/headers
// cookies()/headers() run inside a synthetic Next request scope built from
// Next's real workAsyncStorage singletons (the maintenance.test technique).
// Rate-limit buckets are per-UA-hash under TRUST_PROXY-unset, so every test
// uses a unique UA tag for isolation.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import dns from "node:dns/promises";

// Next's async-local-storage shim captures globalThis.AsyncLocalStorage at
// module load — assign it BEFORE anything pulls in next/headers.
(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto
process.env.NEXTAUTH_SECRET = "auth-orchestration-test-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000"; // insecure context → unprefixed cookie name
delete process.env.TRUST_PROXY; // untrusted → per-UA-hash "unknown:" buckets
delete process.env.TRUSTED_PROXY_HOPS;
delete process.env.SUMMONARR_ALLOW_OAUTH_FIRST_ADMIN;
// Keep next/headers off its dev-warnings wrappers (they expect richer store
// shapes). Cast: next/types marks NODE_ENV readonly at the type level.
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

// ── console capture (rate-limit warns at import; auth paths warn/error) ─────
const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// ── DNS stub (see tests/trakt.test.mts for the rationale) ───────────────────
const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) {
  throw new Error("could not stub dns.lookup — aborting before a real DNS query can leave the process");
}

// ── in-memory DB state ──────────────────────────────────────────────────────
type UserRow = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  permissions: bigint;
  passwordHash: string | null;
  plexUserId: string | null;
  jellyfinUserId: string | null;
  image: string | null;
  notificationEmail: string | null;
  mediaServer: string | null;
  plexClientId: string | null;
  sessionsRevokedAt: Date | null;
};
type AccountRow = {
  id: string;
  userId: string;
  type: string;
  provider: string;
  providerAccountId: string;
  access_token: string | null;
  refresh_token: string | null;
  id_token: string | null;
  expires_at: number | null;
};
type AuthSessionRow = {
  sessionId: string;
  userId: string;
  deviceType: string | null;
  deviceLabel: string | null;
  ipAddress: string | null;
  expiresAt: Date;
  createdAt: Date;
  lastSeenAt: Date;
};
type PlexCacheRow = {
  tokenHash: string;
  email: string;
  plexUserId: string | null;
  verifiedAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
};
type MsuRow = { id: string; source: string; sourceUserId: string; active: boolean };
type AuditRow = {
  userId: string | null;
  userName: string;
  action: string;
  target: string;
  details: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  provider: string | null;
  sessionId: string | null;
};

const users: UserRow[] = [];
const settings = new Map<string, string>();
const accounts: AccountRow[] = [];
const authSessions = new Map<string, AuthSessionRow>();
const plexCacheRows = new Map<string, PlexCacheRow>();
const mediaServerUsers: MsuRow[] = [];
const auditRows: AuditRow[] = [];
let userSeq = 0;
let accountSeq = 0;

// Every fake model method funnels through dbOp: it records the call for
// zero-DB-read assertions and THROWS while dbLocked — the mechanism that
// proves auth() is JWT-only.
const dbCalls: string[] = [];
let dbLocked = false;
let failTransactions = false;
function dbOp(name: string): void {
  if (dbLocked) throw new Error(`DB access (${name}) while locked — this path must be DB-free`);
  dbCalls.push(name);
}

function applySelect(
  row: Record<string, unknown>,
  select?: Record<string, boolean>,
): Record<string, unknown> {
  if (!select) return { ...row };
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(select)) if (select[key]) out[key] = row[key];
  return out;
}

type UserWhere = { id?: string; email?: string; plexUserId?: string; jellyfinUserId?: string; role?: string };
function findUserRow(where: UserWhere): UserRow | undefined {
  return users.find((u) =>
    where.id !== undefined ? u.id === where.id
    : where.email !== undefined ? u.email === where.email
    : where.plexUserId !== undefined ? u.plexUserId === where.plexUserId
    : where.jellyfinUserId !== undefined ? u.jellyfinUserId === where.jellyfinUserId
    : false,
  );
}

const models = {
  setting: {
    findUnique: async (args: { where: { key: string } }) => {
      dbOp("setting.findUnique");
      const value = settings.get(args.where.key);
      return value === undefined ? null : { key: args.where.key, value };
    },
    findMany: async (args: { where?: { key?: { in?: string[] } } }) => {
      dbOp("setting.findMany");
      const keys = args.where?.key?.in ?? [...settings.keys()];
      return keys.filter((k) => settings.has(k)).map((k) => ({ key: k, value: settings.get(k)! }));
    },
    upsert: async (args: { where: { key: string }; create: { key: string; value: string } }) => {
      dbOp("setting.upsert");
      if (!settings.has(args.where.key)) settings.set(args.where.key, args.create.value);
      return { key: args.where.key, value: settings.get(args.where.key)! };
    },
  },
  user: {
    findUnique: async (args: { where: UserWhere; select?: Record<string, boolean> }) => {
      dbOp("user.findUnique");
      const row = findUserRow(args.where);
      return row ? applySelect(row as unknown as Record<string, unknown>, args.select) : null;
    },
    findFirst: async (args: { where?: { role?: string }; select?: Record<string, boolean> }) => {
      dbOp("user.findFirst");
      const row = users.find((u) => (args.where?.role === undefined ? true : u.role === args.where.role));
      return row ? applySelect(row as unknown as Record<string, unknown>, args.select) : null;
    },
    create: async (args: { data: Record<string, unknown>; select?: Record<string, boolean> }) => {
      dbOp("user.create");
      const d = args.data;
      const row: UserRow = {
        id: (d.id as string | undefined) ?? `u-auto-${++userSeq}`,
        email: d.email as string,
        name: (d.name as string | null | undefined) ?? null,
        role: (d.role as string | undefined) ?? "USER",
        permissions: (d.permissions as bigint | undefined) ?? 0n,
        passwordHash: null,
        plexUserId: (d.plexUserId as string | undefined) ?? null,
        jellyfinUserId: (d.jellyfinUserId as string | undefined) ?? null,
        image: (d.image as string | null | undefined) ?? null,
        notificationEmail: (d.notificationEmail as string | null | undefined) ?? null,
        mediaServer: null,
        plexClientId: null,
        sessionsRevokedAt: null,
      };
      users.push(row);
      return applySelect(row as unknown as Record<string, unknown>, args.select);
    },
    update: async (args: { where: UserWhere; data: Record<string, unknown>; select?: Record<string, boolean> }) => {
      dbOp("user.update");
      const row = findUserRow(args.where);
      if (!row) throw new Error("user.update: row not found");
      Object.assign(row, args.data);
      return applySelect(row as unknown as Record<string, unknown>, args.select);
    },
    updateMany: async (args: { where: UserWhere; data: Record<string, unknown> }) => {
      dbOp("user.updateMany");
      const row = findUserRow(args.where);
      if (row) Object.assign(row, args.data);
      return { count: row ? 1 : 0 };
    },
  },
  account: {
    findUnique: async (args: {
      where: { id?: string; provider_providerAccountId?: { provider: string; providerAccountId: string } };
      include?: { user?: boolean };
    }) => {
      dbOp("account.findUnique");
      const w = args.where.provider_providerAccountId;
      const row = w
        ? accounts.find((a) => a.provider === w.provider && a.providerAccountId === w.providerAccountId)
        : accounts.find((a) => a.id === args.where.id);
      if (!row) return null;
      const out: Record<string, unknown> = { ...row };
      if (args.include?.user) {
        const u = users.find((x) => x.id === row.userId);
        out.user = u ? { ...u } : null;
      }
      return out;
    },
    update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      dbOp("account.update");
      const row = accounts.find((a) => a.id === args.where.id);
      if (!row) throw new Error("account.update: row not found");
      Object.assign(row, args.data);
      return { ...row };
    },
    create: async (args: { data: Record<string, unknown> }) => {
      dbOp("account.create");
      const row: AccountRow = {
        id: `acc-auto-${++accountSeq}`,
        access_token: null,
        refresh_token: null,
        id_token: null,
        expires_at: null,
        ...(args.data as Partial<AccountRow> & { userId: string; type: string; provider: string; providerAccountId: string }),
      };
      accounts.push(row);
      return { ...row };
    },
  },
  authSession: {
    upsert: async (args: {
      where: { sessionId: string };
      update: Record<string, unknown>;
      create: Record<string, unknown>;
    }) => {
      dbOp("authSession.upsert");
      const existing = authSessions.get(args.where.sessionId);
      if (existing) {
        Object.assign(existing, args.update);
        return { ...existing };
      }
      const row: AuthSessionRow = {
        deviceType: null,
        deviceLabel: null,
        ipAddress: null,
        createdAt: new Date(),
        lastSeenAt: new Date(),
        ...(args.create as Partial<AuthSessionRow> & { sessionId: string; userId: string; expiresAt: Date }),
      };
      authSessions.set(row.sessionId, row);
      return { ...row };
    },
    findUnique: async (args: { where: { sessionId: string }; select?: Record<string, boolean> }) => {
      dbOp("authSession.findUnique");
      const row = authSessions.get(args.where.sessionId);
      return row ? applySelect(row as unknown as Record<string, unknown>, args.select) : null;
    },
    findMany: async (args: { where: { userId: string }; select?: Record<string, boolean> }) => {
      dbOp("authSession.findMany");
      return [...authSessions.values()]
        .filter((r) => r.userId === args.where.userId)
        .map((r) => applySelect(r as unknown as Record<string, unknown>, args.select));
    },
    delete: async (args: { where: { sessionId: string } }) => {
      dbOp("authSession.delete");
      const row = authSessions.get(args.where.sessionId);
      if (!row) throw new Error("authSession.delete: row not found");
      authSessions.delete(args.where.sessionId);
      return { ...row };
    },
    deleteMany: async (args: { where: { userId: string } }) => {
      dbOp("authSession.deleteMany");
      let count = 0;
      for (const [key, row] of authSessions) {
        if (row.userId === args.where.userId) {
          authSessions.delete(key);
          count++;
        }
      }
      return { count };
    },
  },
  plexTokenCache: {
    findUnique: async (args: { where: { tokenHash: string } }) => {
      dbOp("plexTokenCache.findUnique");
      const row = plexCacheRows.get(args.where.tokenHash);
      return row ? { ...row } : null;
    },
    upsert: async (args: {
      where: { tokenHash: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => {
      dbOp("plexTokenCache.upsert");
      const existing = plexCacheRows.get(args.where.tokenHash);
      if (existing) {
        Object.assign(existing, args.update);
        return { ...existing };
      }
      const row: PlexCacheRow = {
        plexUserId: null,
        verifiedAt: new Date(),
        lastUsedAt: new Date(),
        ...(args.create as Partial<PlexCacheRow> & { tokenHash: string; email: string; expiresAt: Date }),
      };
      plexCacheRows.set(row.tokenHash, row);
      return { ...row };
    },
    update: async (args: { where: { tokenHash: string }; data: Record<string, unknown> }) => {
      dbOp("plexTokenCache.update");
      const row = plexCacheRows.get(args.where.tokenHash);
      if (!row) throw new Error("plexTokenCache.update: row not found");
      Object.assign(row, args.data);
      return { ...row };
    },
    delete: async (args: { where: { tokenHash: string } }) => {
      dbOp("plexTokenCache.delete");
      plexCacheRows.delete(args.where.tokenHash);
      return {};
    },
  },
  mediaServerUser: {
    findFirst: async (args: {
      where?: { source?: string; sourceUserId?: string; active?: boolean };
      select?: Record<string, boolean>;
    }) => {
      dbOp("mediaServerUser.findFirst");
      const w = args.where ?? {};
      const row = mediaServerUsers.find(
        (m) =>
          (w.source === undefined || m.source === w.source) &&
          (w.sourceUserId === undefined || m.sourceUserId === w.sourceUserId) &&
          (w.active === undefined || m.active === w.active),
      );
      return row ? applySelect(row as unknown as Record<string, unknown>, args.select) : null;
    },
  },
  auditLog: {
    create: async (args: { data: AuditRow }) => {
      dbOp("auditLog.create");
      auditRows.push(args.data);
      return { id: auditRows.length, ...args.data };
    },
  },
};

const txFacade = {
  ...models,
  $executeRawUnsafe: async (..._args: unknown[]) => {
    dbOp("$executeRawUnsafe");
    return 0; // advisory lock — a no-op in a single-process harness
  },
};

const fakePrisma = {
  ...models,
  $transaction: async (fn: unknown) => {
    dbOp("$transaction");
    if (failTransactions) throw new Error("unit-test transaction failure");
    if (typeof fn === "function") {
      return (fn as (tx: typeof txFacade) => Promise<unknown>)(txFacade);
    }
    return Promise.all(fn as Promise<unknown>[]);
  },
};
(globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;

// ── scripted fetch ──────────────────────────────────────────────────────────
type FetchCall = { url: URL; init?: RequestInit };
const fetchCalls: FetchCall[] = [];
let respond: (url: URL, init?: RequestInit) => Response | Promise<Response> = () => {
  throw new Error("unexpected fetch — script a responder for this test");
};
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  fetchCalls.push({ url, init });
  return respond(url, init);
}) as typeof fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ── synthetic Next request scope (the maintenance.test technique) ───────────
type RunStore = { run<T>(store: unknown, fn: () => T): T };
const cjsRequire = createRequire(import.meta.url);
const { workAsyncStorage } = cjsRequire("next/dist/server/app-render/work-async-storage.external.js") as { workAsyncStorage: RunStore };
const { workUnitAsyncStorage } = cjsRequire("next/dist/server/app-render/work-unit-async-storage.external.js") as { workUnitAsyncStorage: RunStore };
const { RequestCookies } = cjsRequire("next/dist/server/web/spec-extension/cookies.js") as { RequestCookies: new (h: Headers) => unknown };
const { RequestCookiesAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/request-cookies.js") as { RequestCookiesAdapter: { seal(c: unknown): unknown } };
const { HeadersAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/headers.js") as { HeadersAdapter: { seal(h: Headers): unknown } };

function withRequestContext<T>(
  opts: { cookies?: Record<string, string>; headers?: Record<string, string> },
  fn: () => Promise<T>,
): Promise<T> {
  const reqHeaders = new Headers(opts.headers ?? {});
  const cookiePairs = Object.entries(opts.cookies ?? {});
  if (cookiePairs.length > 0) {
    reqHeaders.set("cookie", cookiePairs.map(([k, v]) => `${k}=${v}`).join("; "));
  }
  const workStore = { route: "/auth.test", forceStatic: false, dynamicShouldError: false };
  const requestStore = {
    type: "request",
    phase: "render",
    headers: HeadersAdapter.seal(reqHeaders),
    cookies: RequestCookiesAdapter.seal(new RequestCookies(reqHeaders)),
    usedDynamic: false,
  };
  return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, fn));
}

// ── module under test + owned primitives (dynamic: stubs must precede) ──────
const {
  hashAuditEmail,
  isTokenExpired,
  buildDeviceMeta,
  auth,
  getSessionDurations,
  invalidateSessionDurationsCache,
  authorizeWithCredentials,
  authorizeWithPlex,
  authorizeWithJellyfin,
  authorizeWithJellyfinQuickConnect,
  findOrCreatePlexUser,
  findOrCreateJellyfinUser,
  findOrCreateOidcUser,
  signInAndMintSession,
  revokeSessionById,
  revokeAllUserSessions,
  PROVIDER_REBIND_REQUIRED,
  PROVIDER_SETUP_REQUIRED,
  normalizeEmail,
} = await import("../src/lib/auth.ts");
const { signSessionJwt, verifySessionJwt } = await import("../src/lib/session-jwt.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");
const { shouldForceDbCheck } = await import("../src/lib/session-revocation.ts");
const { checkRateLimit, peekRateLimit, recordFailure } = await import("../src/lib/rate-limit.ts");
const { PRESETS, Permission } = await import("../src/lib/permissions.ts");
const { hashPassword } = await import("../src/lib/password-hash.ts");

// ── fixtures / helpers ──────────────────────────────────────────────────────
const COOKIE = getSessionCookieName(); // "summonarr-session" under the http AUTH_URL
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACCOUNT_WINDOW_MS = 15 * 60 * 1000; // authorizeWithCredentials' account bucket window

const UA_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const UA_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
// Unique-per-test UA tags: TRUST_PROXY is unset, so every rate-limit bucket is
// keyed on a UA hash — a fresh tag gives each test its own buckets. The suffix
// does not change the fingerprint classification.
function chromeUa(tag: string): string {
  return `${UA_CHROME} uniq/${tag}`;
}
function iphoneUa(tag: string): string {
  return `${UA_IPHONE} uniq/${tag}`;
}
function untrustedBucketFor(ua: string): string {
  return "unknown:" + createHash("sha256").update(ua).digest("hex").slice(0, 12);
}
function makeReq(ua: string): Request {
  return new Request("http://localhost:3000/api/auth/sign-in", {
    method: "POST",
    headers: { "user-agent": ua },
  });
}

function seedUser(overrides: Partial<UserRow> & { id: string; email: string }): UserRow {
  const row: UserRow = {
    name: null,
    role: "USER",
    permissions: PRESETS.USER,
    passwordHash: null,
    plexUserId: null,
    jellyfinUserId: null,
    image: null,
    notificationEmail: null,
    mediaServer: null,
    plexClientId: null,
    sessionsRevokedAt: null,
    ...overrides,
  };
  users.push(row);
  return row;
}
function userById(id: string): UserRow {
  const row = users.find((u) => u.id === id);
  if (!row) throw new Error(`no seeded user ${id}`);
  return row;
}

// `void logAudit(...)` is fire-and-forget — flush the microtask/macrotask
// queue before asserting on audit rows.
function flushAsync(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
function lastAudit(): AuditRow {
  const row = auditRows.at(-1);
  if (!row) throw new Error("no audit rows recorded");
  return row;
}
function auditDetails(row: AuditRow = lastAudit()): Record<string, unknown> {
  return JSON.parse(row.details ?? "{}") as Record<string, unknown>;
}

type FocUser = { id: string; email: string; name: string | null; role: string };
function asUser(result: FocUser | symbol): FocUser {
  if (typeof result === "symbol") throw new Error(`expected a user, got sentinel ${String(result)}`);
  return result;
}

function assertApprox(actual: number, expected: number, label: string, slackSeconds = 5): void {
  assert.ok(
    Math.abs(actual - expected) <= slackSeconds,
    `${label}: expected ~${expected}, got ${actual}`,
  );
}

const PASSWORD = "correct horse battery staple";
const PASSWORD_HASH = await hashPassword(PASSWORD);

beforeEach(() => {
  users.length = 0;
  accounts.length = 0;
  authSessions.clear();
  plexCacheRows.clear();
  mediaServerUsers.length = 0;
  auditRows.length = 0;
  settings.clear();
  // Default: setup already completed, so the pre-setup bootstrap gate stays
  // out of the way except in the tests that exercise it.
  settings.set("setup_completed_at", "2026-01-01T00:00:00.000Z");
  dbCalls.length = 0;
  dbLocked = false;
  failTransactions = false;
  fetchCalls.length = 0;
  respond = () => {
    throw new Error("unexpected fetch — script a responder for this test");
  };
  warns.length = 0;
  errors.length = 0;
  invalidateSessionDurationsCache();
  delete process.env.SUMMONARR_ALLOW_OAUTH_FIRST_ADMIN;
});

// ── pure helpers ────────────────────────────────────────────────────────────

test("hashAuditEmail is a 16-hex-char sha256 truncation — deterministic, input-sensitive", () => {
  const h = hashAuditEmail("alice@example.com");
  assert.match(h, /^[0-9a-f]{16}$/);
  assert.equal(h, createHash("sha256").update("alice@example.com").digest("hex").slice(0, 16));
  assert.equal(hashAuditEmail("alice@example.com"), h); // stable for correlation
  assert.notEqual(hashAuditEmail("bob@example.com"), h);
});

test("isTokenExpired: null session reads expired; a missing deadline reads NOT expired (current behavior)", () => {
  type S = NonNullable<Parameters<typeof isTokenExpired>[0]>;
  const base = { user: { id: "u" }, sessionId: "s" };
  const now = Math.floor(Date.now() / 1000);
  assert.equal(isTokenExpired(null), true); // hardens `if (!isTokenExpired(s)) allow()` callers
  assert.equal(isTokenExpired({ ...base, tokenExpiresAt: now + 60 } as unknown as S), false);
  assert.equal(isTokenExpired({ ...base, tokenExpiresAt: now - 60 } as unknown as S), true);
  // No tokenExpiresAt claim ⇒ treated as non-expiring here — real expiry is
  // enforced by the JWT exp at verify time (signSessionJwt always sets both).
  assert.equal(isTokenExpired(base as unknown as S), false);
});

test("buildDeviceMeta derives the per-device payload: UUID sessionId, fingerprint, label, mobile flag, capped UA, spoof-proof IP bucket", () => {
  const desktop = buildDeviceMeta(new Headers({ "user-agent": UA_CHROME }));
  assert.match(desktop._sessionId, UUID_RE);
  assert.equal(desktop._uaFingerprint, "chrome:windows:desktop");
  assert.equal(desktop._isMobile, false);
  assert.equal(desktop._deviceLabel, "Chrome on Windows");
  // TRUST_PROXY unset ⇒ the audit IP is the UA-hash bucket, never a forgeable
  // X-Forwarded-For value (rate-limit.test owns the full matrix).
  assert.equal(desktop._auditIp, untrustedBucketFor(UA_CHROME));
  assert.equal(desktop._auditUa, UA_CHROME);

  const mobile = buildDeviceMeta(new Headers({ "user-agent": UA_IPHONE }));
  assert.equal(mobile._isMobile, true);
  assert.equal(mobile._uaFingerprint, "safari:ios:mobile");
  assert.equal(mobile._deviceLabel, "Safari on iPhone");
  assert.notEqual(mobile._sessionId, desktop._sessionId); // fresh id per call

  const long = buildDeviceMeta(new Headers({ "user-agent": "x".repeat(600) }));
  assert.equal(long._auditUa.length, 512); // VarChar guard
});

// ── auth() — the JWT-only read (guardrail 29) ───────────────────────────────

test("auth(): a valid cookie maps to the exact SummonarrSession shape WITHOUT any DB access", async () => {
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const token = await signSessionJwt(
    {
      id: "u-auth",
      role: "USER",
      permissions: "0",
      email: "alice@example.com",
      name: "Alice",
      provider: "credentials",
      sessionId: "sess-auth",
      expiresAt,
    },
    { expiresInSeconds: 3600 },
  );
  const adminToken = await signSessionJwt(
    { id: "u-admin", role: "ADMIN", permissions: "0", provider: "credentials", sessionId: "sess-admin", expiresAt },
    { expiresInSeconds: 3600 },
  );

  // Lock the DB: any prisma access now throws. auth() must still resolve —
  // this is the JWT-only/no-DB distinction authActive() exists to close.
  dbLocked = true;
  try {
    const session = await withRequestContext({ cookies: { [COOKIE]: token } }, () => auth());
    assert.deepEqual(session, {
      user: {
        id: "u-auth",
        role: "USER",
        // permissions claim "0" ⇒ effectivePermissions falls back to the role preset
        permissions: PRESETS.USER,
        email: "alice@example.com",
        name: "Alice",
        provider: "credentials",
        mediaServer: null,
      },
      sessionId: "sess-auth",
      tokenExpiresAt: expiresAt,
    });

    // ADMIN role always resolves the superbit (claims omit email/name → null).
    const admin = await withRequestContext({ cookies: { [COOKIE]: adminToken } }, () => auth());
    assert.ok(admin);
    assert.equal(admin.user.permissions, Permission.ADMIN);
    assert.equal(admin.user.email, null);
  } finally {
    dbLocked = false;
  }
  assert.equal(dbCalls.length, 0);
});

test("auth(): absent, expired, and tampered cookies all read null — still with the DB locked", async () => {
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const good = await signSessionJwt(
    { id: "u-x", role: "USER", permissions: "0", provider: "credentials", sessionId: "s-x", expiresAt },
    { expiresInSeconds: 3600 },
  );
  const expired = await signSessionJwt(
    { id: "u-x", role: "USER", permissions: "0", provider: "credentials", sessionId: "s-x", expiresAt },
    { expiresInSeconds: -10 },
  );
  const [h, p, sig] = good.split(".");
  const tampered = `${h}.${p}.${sig.slice(0, -2)}${sig.endsWith("AA") ? "BB" : "AA"}`;

  dbLocked = true;
  try {
    assert.equal(await withRequestContext({}, () => auth()), null);
    assert.equal(await withRequestContext({ cookies: { [COOKIE]: expired } }, () => auth()), null);
    assert.equal(await withRequestContext({ cookies: { [COOKIE]: tampered } }, () => auth()), null);
    // A near-miss cookie name is not the session cookie.
    assert.equal(await withRequestContext({ cookies: { [`x${COOKIE}`]: good } }, () => auth()), null);
  } finally {
    dbLocked = false;
  }
  assert.equal(dbCalls.length, 0);
});

// ── getSessionDurations ─────────────────────────────────────────────────────

test("getSessionDurations: defaults, 5-min cache, explicit invalidation, the 90-day admin cap, and garbage fallback", async () => {
  // Empty settings ⇒ the DEFAULT_* constants.
  const defaults = await getSessionDurations();
  assert.deepEqual(defaults, { desktopDuration: 3600, mobileDuration: 604_800, maxDuration: 2_592_000 });
  const queriesAfterFirst = dbCalls.filter((c) => c === "setting.findMany").length;

  // Changed settings are NOT visible until the cache is invalidated.
  settings.set("sessionDefaultDuration", "1800");
  settings.set("sessionMobileDuration", "not-a-number"); // garbage → default
  settings.set("sessionMaxDuration", "999999999"); // over the ceiling → capped
  assert.deepEqual(await getSessionDurations(), defaults);
  assert.equal(dbCalls.filter((c) => c === "setting.findMany").length, queriesAfterFirst, "cached read must not re-query");

  invalidateSessionDurationsCache();
  assert.deepEqual(await getSessionDurations(), {
    desktopDuration: 1800,
    mobileDuration: 604_800, // unparseable value falls back to the default
    maxDuration: 90 * 24 * 60 * 60, // admin-configured durations are hard-capped at 90d
  });
});

// ── authorizeWithCredentials ────────────────────────────────────────────────

test("credentials: pre-verify refusals — missing fields and oversized password (zero DB), disabled local login (valid creds)", async () => {
  const req = makeReq(chromeUa("guards"));
  assert.equal(await authorizeWithCredentials({}, req), null);
  assert.equal(await authorizeWithCredentials({ email: "a@b.co" }, req), null);
  assert.equal(await authorizeWithCredentials({ password: "x" }, req), null);
  assert.equal(await authorizeWithCredentials({ email: "a@b.co", password: "p".repeat(1025) }, req), null);
  assert.equal(dbCalls.length, 0, "guard-clause refusals must precede every DB read");

  // disableLocalLogin refuses even a CORRECT password, before the user lookup.
  seedUser({ id: "u-d", email: "d@example.com", passwordHash: PASSWORD_HASH });
  settings.set("disableLocalLogin", "true");
  assert.equal(await authorizeWithCredentials({ email: "d@example.com", password: PASSWORD }, req), null);
  assert.ok(!dbCalls.includes("user.findUnique"), "refusal must happen before the user lookup");
});

test("credentials: unknown account and wrong password refuse identically; ONLY a failed verify records an account-bucket hit", async () => {
  const ua = chromeUa("badcreds");

  // Unknown account — the dummy-verify branch still records a failure.
  const ghostKey = `login-email:${hashAuditEmail("ghost@example.com")}`;
  assert.equal(peekRateLimit(ghostKey, 1, ACCOUNT_WINDOW_MS), true);
  assert.equal(
    await authorizeWithCredentials({ email: "ghost@example.com", password: "whatever" }, makeReq(ua)),
    null,
  );
  await flushAsync();
  assert.equal(lastAudit().action, "AUTH_LOGIN_FAILED");
  assert.equal(auditDetails().reason, "invalid_credentials");
  assert.equal(auditDetails().emailHash, hashAuditEmail("ghost@example.com"));
  assert.equal(peekRateLimit(ghostKey, 1, ACCOUNT_WINDOW_MS), false, "unknown-account attempt must count as a failure");

  // Wrong password on a real account.
  seedUser({ id: "u-w", email: "wrong@example.com", passwordHash: PASSWORD_HASH });
  const wrongKey = `login-email:${hashAuditEmail("wrong@example.com")}`;
  assert.equal(peekRateLimit(wrongKey, 1, ACCOUNT_WINDOW_MS), true);
  assert.equal(
    await authorizeWithCredentials({ email: "wrong@example.com", password: "not-it" }, makeReq(ua)),
    null,
  );
  await flushAsync();
  assert.equal(auditDetails().reason, "invalid_credentials");
  assert.equal(peekRateLimit(wrongKey, 1, ACCOUNT_WINDOW_MS), false, "a failed verify must record exactly one hit");
});

test("credentials: correct password authenticates under the NORMALIZED email and returns the full device payload; success records no bucket hit", async () => {
  const ua = chromeUa("happy");
  seedUser({ id: "u-h", email: "alice@example.com", name: "Alice", role: "ISSUE_ADMIN", passwordHash: PASSWORD_HASH });

  // Mixed case + padding: lookup must go through normalizeEmail.
  const result = await authorizeWithCredentials(
    { email: "  ALICE@Example.COM  ", password: PASSWORD, rememberMe: "true" },
    makeReq(ua),
  );
  assert.ok(result, "valid credentials must authorize");
  assert.equal(result.id, "u-h");
  assert.equal(result.email, "alice@example.com");
  assert.equal(result.name, "Alice");
  assert.equal(result.role, "ISSUE_ADMIN");
  assert.equal(result.rememberMe, "true");
  assert.match(result._sessionId as string, UUID_RE);
  assert.equal(result._uaFingerprint, "chrome:windows:desktop");
  assert.equal(result._isMobile, false);
  assert.equal(result._deviceLabel, "Chrome on Windows");
  assert.equal(result._auditIp, untrustedBucketFor(ua));
  assert.equal(result._auditUa, ua);

  // The peek/record split: a successful sign-in leaves the account bucket empty.
  assert.equal(peekRateLimit(`login-email:${hashAuditEmail("alice@example.com")}`, 1, ACCOUNT_WINDOW_MS), true);
});

test("credentials: a tripped ACCOUNT bucket refuses before the user lookup, keyed on the normalized email", async () => {
  const email = "sprayed@example.com";
  seedUser({ id: "u-s", email, passwordHash: PASSWORD_HASH });
  // Simulate a distributed password spray: 50 failed verifies recorded against
  // the lowercase form.
  const key = `login-email:${hashAuditEmail(email)}`;
  for (let i = 0; i < 50; i++) recordFailure(key, ACCOUNT_WINDOW_MS);

  // The attacker retries with a case variant — normalization maps it onto the
  // same bucket, and the peek gate refuses BEFORE the password check.
  const result = await authorizeWithCredentials(
    { email: "  SPRAYED@EXAMPLE.COM  ", password: PASSWORD },
    makeReq(chromeUa("spray")),
  );
  assert.equal(result, null, "even the CORRECT password must be refused while locked out");
  assert.ok(!dbCalls.includes("user.findUnique"), "lockout must precede the user lookup");
  await flushAsync();
  assert.equal(auditDetails().reason, "rate_limited");
});

test("credentials: a tripped PER-IP bucket refuses valid credentials before the user lookup", async () => {
  const ua = chromeUa("ipflood");
  seedUser({ id: "u-i", email: "ip@example.com", passwordHash: PASSWORD_HASH });
  // Exhaust this client's IP bucket (limit 20 per 5 min under the UA-hash key).
  const ipKey = `login-ip:${untrustedBucketFor(ua)}`;
  for (let i = 0; i < 20; i++) checkRateLimit(ipKey, 20, 5 * 60 * 1000);

  assert.equal(
    await authorizeWithCredentials({ email: "ip@example.com", password: PASSWORD }, makeReq(ua)),
    null,
  );
  assert.ok(!dbCalls.includes("user.findUnique"));
  await flushAsync();
  assert.equal(auditDetails().reason, "rate_limited");
});

// ── authorizeWithPlex ───────────────────────────────────────────────────────

test("plex sign-in: unconfigured server fails closed; a friend on THIS server provisions; a stranger with a valid token is refused", async () => {
  const ua = chromeUa("plex-wire");
  settings.set("plexAdminToken", "admin-plex-token");

  // Phase 1 — no plexServerUrl: refuse BEFORE any plex.tv call (an unscoped
  // friend list would widen sign-in to anyone the admin ever shared with).
  assert.equal(
    await authorizeWithPlex({ plexToken: "plex-tok-unconfigured" }, makeReq(ua)),
    null,
  );
  assert.equal(fetchCalls.length, 0, "the fail-closed refusal must not touch the network");
  await flushAsync();
  assert.equal(auditDetails().reason, "plex_server_not_configured");
  assert.ok(warns.some((w) => w.includes("plexServerUrl is not configured")));

  // Phase 2 — configured server, friend shared on OUR machineIdentifier.
  settings.set("plexServerUrl", "http://203.0.113.10:32400");
  let plexAccount: Record<string, unknown> = {
    id: 777, // numeric on the wire — must be coerced to the string sub "777"
    email: "friend@example.com",
    username: "Friend",
    thumb: "https://plex.tv/thumb.png",
  };
  const FRIENDS_XML =
    '<?xml version="1.0"?><MediaContainer size="2">' +
    '<User id="1" email="friend@example.com"><Server id="1" machineIdentifier="machine-1"/></User>' +
    '<User id="2" email="stranger@example.com"><Server id="2" machineIdentifier="other-machine"/></User>' +
    "</MediaContainer>";
  respond = (url) => {
    if (url.hostname === "plex.tv" && url.pathname === "/api/v2/user") return jsonResponse(plexAccount);
    if (url.hostname === "203.0.113.10" && url.pathname === "/identity") {
      return jsonResponse({ MediaContainer: { machineIdentifier: "machine-1" } });
    }
    if (url.hostname === "plex.tv" && url.pathname === "/api/users") {
      return new Response(FRIENDS_XML, { status: 200, headers: { "content-type": "application/xml" } });
    }
    throw new Error(`unexpected fetch to ${url}`);
  };

  const friend = await authorizeWithPlex(
    { plexToken: "plex-tok-friend", rememberMe: "true" },
    makeReq(ua),
  );
  assert.ok(friend, "a friend shared on this server must sign in");
  assert.equal(friend.email, "friend@example.com");
  assert.equal(friend.name, "Friend");
  assert.equal(friend.role, "USER");
  assert.equal(friend.rememberMe, "true");
  assert.match(friend._sessionId as string, UUID_RE);
  const friendRow = users.find((u) => u.email === "friend@example.com");
  assert.ok(friendRow, "sign-in must have minted the user row");
  assert.equal(friendRow.plexUserId, "777", "the numeric plex id must be bound as a string sub");
  assert.equal(friendRow.notificationEmail, "friend@example.com");
  const cacheRow = [...plexCacheRows.values()][0];
  assert.ok(cacheRow, "the verified token must be cached");
  assert.equal(cacheRow.plexUserId, "777");
  assert.equal(cacheRow.email, "friend@example.com");

  // Phase 3 — a VALID plex account with no share on this machine is refused.
  plexAccount = { id: 888, email: "stranger@example.com", username: "Stranger", thumb: "" };
  const stranger = await authorizeWithPlex({ plexToken: "plex-tok-stranger" }, makeReq(ua));
  assert.equal(stranger, null, "a valid plex token without membership must NOT sign in");
  await flushAsync();
  assert.equal(auditDetails().reason, "invalid_credentials");
  assert.ok(!users.some((u) => u.email === "stranger@example.com"), "no row may be minted for a refused stranger");
});

test("provider-subject binding: an existing plex sub returns that identity (role preserved); an email match alone is REFUSED", async () => {
  // (a) Sub match wins — even when the provider now reports a different email.
  seedUser({
    id: "u-bound",
    email: "bound@example.com",
    name: "Bound",
    role: "ISSUE_ADMIN",
    plexUserId: "px-1",
  });
  const bySub = asUser(
    await findOrCreatePlexUser({ plexUserId: "px-1", email: "Rotated@New.email", name: "NewName" }),
  );
  assert.deepEqual(bySub, { id: "u-bound", email: "bound@example.com", name: "NewName", role: "ISSUE_ADMIN" });
  assert.equal(userById("u-bound").notificationEmail, "rotated@new.email", "notification email follows the verified address");
  assert.equal(users.length, 1);

  // (b) Email collision with an UNBOUND row (here: an admin) — the
  // account-takeover surface. Must refuse, mutate nothing, and log the rebind.
  seedUser({ id: "u-victim", email: "victim@example.com", name: "Victim", role: "ADMIN" });
  const collision = await findOrCreatePlexUser({ plexUserId: "px-evil", email: "Victim@Example.com" });
  assert.equal(collision, PROVIDER_REBIND_REQUIRED);
  assert.equal(userById("u-victim").plexUserId, null, "the admin row must not be hijacked");
  assert.equal(userById("u-victim").role, "ADMIN");
  assert.equal(users.length, 2, "no new row may be minted on a collision");
  assert.ok(warns.some((w) => w.includes("Manual rebind required")));
});

test("pre-setup bootstrap gate: all three providers refuse to mint the first user; env flag / existing admin open it (as plain USER)", async () => {
  settings.delete("setup_completed_at"); // pre-setup state, no admin exists
  assert.equal(
    await findOrCreatePlexUser({ plexUserId: "px-gate", email: "gate@example.com" }),
    PROVIDER_SETUP_REQUIRED,
  );
  assert.equal(await findOrCreateJellyfinUser("jf-gate", "Gate"), PROVIDER_SETUP_REQUIRED);
  assert.equal(
    await findOrCreateOidcUser({
      sub: "oidc-gate",
      email: "oidc-gate@example.com",
      emailVerified: true,
      name: null,
      preferredUsername: null,
      picture: null,
      accessToken: null,
      refreshToken: null,
      idToken: "idt",
      expiresAt: null,
    }),
    PROVIDER_SETUP_REQUIRED,
  );
  assert.equal(users.length, 0, "the gate must not mint any row");

  // SUMMONARR_ALLOW_OAUTH_FIRST_ADMIN=true opts OAuth-only deployments in —
  // but the create itself still mints a plain USER (ADMIN only ever comes from
  // runFirstAdminPromotion during the mint).
  process.env.SUMMONARR_ALLOW_OAUTH_FIRST_ADMIN = "true";
  const bootstrap = asUser(await findOrCreatePlexUser({ plexUserId: "px-boot", email: "boot@example.com" }));
  assert.equal(bootstrap.role, "USER");

  // Once ANY admin exists, ordinary onboarding proceeds without the flag even
  // though setup_completed_at is still absent.
  delete process.env.SUMMONARR_ALLOW_OAUTH_FIRST_ADMIN;
  users.length = 0;
  seedUser({ id: "u-adm", email: "admin@example.com", role: "ADMIN" });
  const onboarded = asUser(await findOrCreatePlexUser({ plexUserId: "px-later", email: "later@example.com" }));
  assert.equal(onboarded.role, "USER");
});

test("findOrCreatePlexUser create: role USER, USER-preset bitmask, sanitized name, normalized emails, sub bound", async () => {
  const created = asUser(
    await findOrCreatePlexUser({
      plexUserId: "px-new",
      email: "  New.User@Example.COM ",
      name: " <Eve> ",
      image: "https://plex.tv/avatar.png",
    }),
  );
  const row = userById(created.id);
  assert.equal(row.email, "new.user@example.com");
  assert.equal(row.notificationEmail, "new.user@example.com");
  assert.equal(row.name, "Eve", "provider display names must be sanitized before storage");
  assert.equal(row.role, "USER");
  assert.equal(row.permissions, PRESETS.USER);
  assert.equal(row.plexUserId, "px-new");
  assert.equal(row.image, "https://plex.tv/avatar.png");
});

// ── authorizeWithJellyfin ───────────────────────────────────────────────────

test("jellyfin: unconfigured URL refuses without fetching; a 401 wire refuses with an invalid_credentials audit", async () => {
  // (a) No jellyfinUrl Setting.
  assert.equal(
    await authorizeWithJellyfin({ username: "user", password: "pw" }, makeReq(chromeUa("jf-nourl"))),
    null,
  );
  assert.equal(fetchCalls.length, 0);
  assert.ok(errors.some((e) => e.includes("Jellyfin URL is not configured")));

  // (b) Configured URL, server rejects the credentials.
  settings.set("jellyfinUrl", "http://10.77.0.1:8096");
  respond = () => new Response("Unauthorized", { status: 401 });
  assert.equal(
    await authorizeWithJellyfin({ username: "user", password: "bad-pw" }, makeReq(chromeUa("jf-401"))),
    null,
  );
  await flushAsync();
  assert.equal(lastAudit().provider, "jellyfin");
  assert.equal(auditDetails().reason, "invalid_credentials");
  assert.equal(users.length, 0);
});

test("jellyfin membership gate: VALID credentials refuse when the account is unknown or its MediaServerUser is inactive", async () => {
  settings.set("jellyfinUrl", "http://10.77.0.2:8096");
  respond = (url) => {
    if (url.pathname === "/Users/AuthenticateByName") {
      return jsonResponse({ User: { Id: "jf-unknown", Name: "Unknown Account" } });
    }
    throw new Error(`unexpected fetch to ${url}`);
  };

  // Unknown account: no MediaServerUser row, no bound User.
  assert.equal(
    await authorizeWithJellyfin({ username: "unknown", password: "pw" }, makeReq(chromeUa("jf-gate"))),
    null,
  );
  await flushAsync();
  assert.equal(auditDetails().reason, "not_authorized");
  assert.ok(warns.some((w) => w.includes("not an authorized member")));
  assert.equal(users.length, 0, "a refused account must not be provisioned");

  // A soft-deleted (inactive) member is NOT a member — the gate filters active:true.
  mediaServerUsers.push({ id: "msu-1", source: "jellyfin", sourceUserId: "jf-unknown", active: false });
  assert.equal(
    await authorizeWithJellyfin({ username: "unknown", password: "pw" }, makeReq(chromeUa("jf-gate"))),
    null,
  );
  await flushAsync();
  assert.equal(auditDetails().reason, "not_authorized");
});

test("jellyfin: an ACTIVE synced member is provisioned with the synthetic @jellyfin.local email and device payload", async () => {
  settings.set("jellyfinUrl", "http://10.77.0.3:8096");
  mediaServerUsers.push({ id: "msu-2", source: "jellyfin", sourceUserId: "jf-1", active: true });
  respond = (url) => {
    if (url.pathname === "/Users/AuthenticateByName") {
      return jsonResponse({ User: { Id: "jf-1", Name: "Jelly User" } });
    }
    throw new Error(`unexpected fetch to ${url}`);
  };

  const result = await authorizeWithJellyfin(
    { username: "jelly", password: "pw", rememberMe: "true" },
    makeReq(chromeUa("jf-member")),
  );
  assert.ok(result, "an active synced member must sign in");
  assert.equal(result.email, "jellyfin-jf-1@jellyfin.local");
  assert.equal(result.name, "Jelly User");
  assert.equal(result.role, "USER");
  assert.equal(result.rememberMe, "true");
  assert.match(result._sessionId as string, UUID_RE);
  const row = users.find((u) => u.jellyfinUserId === "jf-1");
  assert.ok(row, "the member must be provisioned");
  assert.equal(row.email, "jellyfin-jf-1@jellyfin.local");
  assert.equal(row.permissions, PRESETS.USER);
});

test("jellyfin gate bypasses: a returning BOUND user passes without a member row (name refreshed); restrict=\"false\" opens the gate", async () => {
  settings.set("jellyfinUrl", "http://10.77.0.4:8096");

  // (a) Returning user: bound jellyfinUserId, no MediaServerUser row — an
  // upgrade must not lock out anyone who has already signed in.
  seedUser({
    id: "u-jf",
    email: "jellyfin-jf-2@jellyfin.local",
    name: "Old Name",
    jellyfinUserId: "jf-2",
  });
  respond = (url) => {
    if (url.pathname === "/Users/AuthenticateByName") {
      return jsonResponse({ User: { Id: "jf-2", Name: "New Name" } });
    }
    throw new Error(`unexpected fetch to ${url}`);
  };
  const returning = await authorizeWithJellyfin(
    { username: "jelly2", password: "pw" },
    makeReq(chromeUa("jf-return")),
  );
  assert.ok(returning);
  assert.equal(returning.id, "u-jf");
  assert.equal(returning.name, "New Name");
  assert.equal(userById("u-jf").name, "New Name", "a changed display name is refreshed on sign-in");

  // (b) jellyfinRestrictSignIn="false" disables the gate: a brand-new account
  // is provisioned with no member row and no binding.
  settings.set("jellyfinRestrictSignIn", "false");
  respond = (url) => {
    if (url.pathname === "/Users/AuthenticateByName") {
      return jsonResponse({ User: { Id: "jf-3", Name: "Open Door" } });
    }
    throw new Error(`unexpected fetch to ${url}`);
  };
  const open = await authorizeWithJellyfin(
    { username: "jelly3", password: "pw" },
    makeReq(chromeUa("jf-open")),
  );
  assert.ok(open, "with the gate explicitly disabled, any valid server credential signs in");
  assert.ok(users.some((u) => u.jellyfinUserId === "jf-3"));
});

test("jellyfin legacy anchor: a pre-binding row keyed only by the synthetic email is re-used and gets jellyfinUserId backfilled", async () => {
  settings.set("jellyfinUrl", "http://10.77.0.5:8096");
  // A row created before the (provider, sub) columns existed: synthetic email,
  // no jellyfinUserId. It is NOT a "returning bound user" for the membership
  // gate, so it needs its active MediaServerUser row to sign in.
  seedUser({ id: "u-legacy", email: "jellyfin-jf-4@jellyfin.local", name: "Legacy" });
  mediaServerUsers.push({ id: "msu-4", source: "jellyfin", sourceUserId: "jf-4", active: true });
  respond = (url) => {
    if (url.pathname === "/Users/AuthenticateByName") {
      return jsonResponse({ User: { Id: "jf-4", Name: "Legacy" } });
    }
    throw new Error(`unexpected fetch to ${url}`);
  };

  const result = await authorizeWithJellyfin(
    { username: "legacy", password: "pw" },
    makeReq(chromeUa("jf-legacy")),
  );
  assert.ok(result, "the legacy member must sign in");
  assert.equal(result.id, "u-legacy", "the existing row must be re-used, not duplicated");
  assert.equal(users.length, 1);
  assert.equal(userById("u-legacy").jellyfinUserId, "jf-4", "the sub must be backfilled so future sign-ins bind on it");
});

test("jellyfin QuickConnect: the per-secret bucket (hashed key) refuses brute redemption before any fetch", async () => {
  // Trip the per-secret bucket exactly as rotating-IP redemption would.
  const secret = "qc-secret-locked";
  const secretKey = `jellyfin-qc-secret:${createHash("sha256").update(secret).digest("hex").slice(0, 16)}`;
  for (let i = 0; i < 10; i++) checkRateLimit(secretKey, 10, 5 * 60 * 1000);

  assert.equal(
    await authorizeWithJellyfinQuickConnect({ secret }, makeReq(chromeUa("qc"))),
    null,
  );
  assert.equal(fetchCalls.length, 0, "a rate-limited secret must never reach the server");
  await flushAsync();
  assert.equal(lastAudit().provider, "jellyfin-quickconnect");
  assert.equal(auditDetails().reason, "rate_limited");
});

// ── findOrCreateOidcUser ────────────────────────────────────────────────────

function oidcClaims(overrides: Partial<{
  sub: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  preferredUsername: string | null;
  picture: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  idToken: string;
  expiresAt: number | null;
}> = {}) {
  return {
    sub: "sub-1",
    email: "Oidc.User@Example.com",
    emailVerified: true,
    name: "OIDC User",
    preferredUsername: "oidcuser",
    picture: "https://idp.example.com/pic.png",
    accessToken: "at-raw",
    refreshToken: "rt-raw",
    idToken: "idt-raw",
    expiresAt: 1_234_567_890,
    ...overrides,
  };
}

test("oidc: an unverified or missing email throws — the IdP's word is required before any row is touched", async () => {
  await assert.rejects(() => findOrCreateOidcUser(oidcClaims({ emailVerified: false })), /not verified/);
  await assert.rejects(() => findOrCreateOidcUser(oidcClaims({ email: null })), /no email/);
  assert.equal(users.length, 0);
  assert.equal(accounts.length, 0);
});

test("oidc: an existing (provider, sub) account returns THAT identity regardless of the reported email, and refreshes the stored tokens", async () => {
  seedUser({ id: "u-oidc", email: "linked@example.com", name: "Linked", role: "ISSUE_ADMIN" });
  accounts.push({
    id: "acc-1",
    userId: "u-oidc",
    type: "oidc",
    provider: "oidc",
    providerAccountId: "sub-1",
    access_token: "old-at",
    refresh_token: "old-rt",
    id_token: "old-idt",
    expires_at: 1,
  });

  // The IdP now reports a completely different email — the sub binding wins.
  const result = await findOrCreateOidcUser(oidcClaims({ sub: "sub-1", email: "totally@different.example" }));
  assert.deepEqual(result, { id: "u-oidc", email: "linked@example.com", name: "Linked", role: "ISSUE_ADMIN" });
  assert.equal(users.length, 1, "no second row may be minted");
  assert.equal(accounts[0].access_token, "at-raw");
  assert.equal(accounts[0].refresh_token, "rt-raw");
  assert.equal(accounts[0].id_token, "idt-raw");
  assert.equal(accounts[0].expires_at, 1_234_567_890);
});

test("oidc: email collision with an unbound row is REFUSED (SSO-takeover guard); the create path issues a TOP-LEVEL account.create in one tx", async () => {
  // (a) Collision: an attacker-controlled IdP vouching the victim's email must
  // not inherit the victim's row — even with email_verified=true.
  seedUser({ id: "u-vic2", email: "victim2@example.com", role: "ADMIN" });
  assert.equal(
    await findOrCreateOidcUser(oidcClaims({ sub: "sub-evil", email: "Victim2@Example.com" })),
    PROVIDER_REBIND_REQUIRED,
  );
  assert.equal(users.length, 1);
  assert.equal(accounts.length, 0);
  assert.ok(warns.some((w) => w.includes("Manual rebind required")));

  // (b) Create: user + account in one $transaction, the account as a TOP-LEVEL
  // account.create (the shape the prisma.ts encryption extension hooks — a
  // nested relation write would bypass it, guardrail 7a) with the RAW tokens
  // passed through for the extension to encrypt.
  const txCountBefore = dbCalls.filter((c) => c === "$transaction").length;
  const created = asUser(
    await findOrCreateOidcUser(
      oidcClaims({ sub: "sub-new", email: "  OIDC.New@Example.COM ", name: " <O> New " }),
    ),
  );
  assert.equal(dbCalls.filter((c) => c === "$transaction").length, txCountBefore + 1);
  const row = userById(created.id);
  assert.equal(row.email, "oidc.new@example.com");
  assert.equal(row.notificationEmail, "oidc.new@example.com");
  assert.equal(row.name, "O New", "IdP display names must be sanitized");
  assert.equal(row.role, "USER");
  assert.equal(row.permissions, PRESETS.USER);
  const account = accounts.at(-1);
  assert.ok(account, "the tx must create the account row");
  assert.equal(account.userId, row.id);
  assert.equal(account.type, "oidc");
  assert.equal(account.provider, "oidc");
  assert.equal(account.providerAccountId, "sub-new");
  assert.equal(account.access_token, "at-raw");
  assert.equal(account.refresh_token, "rt-raw");
  assert.equal(account.id_token, "idt-raw");
  assert.equal(account.expires_at, 1_234_567_890);
});

// ── signInAndMintSession ────────────────────────────────────────────────────

function mintableUser(id: string, opts: { ua?: string; rememberMe?: string } = {}): Record<string, unknown> {
  const row = userById(id);
  const device = buildDeviceMeta(new Headers({ "user-agent": opts.ua ?? chromeUa(`mint-${id}`) }));
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    ...(opts.rememberMe !== undefined ? { rememberMe: opts.rememberMe } : {}),
    ...device,
  };
}

test("mint (credentials): SignInResult + JWT claims, the AuthSession row, an emailHash-only audit, and the DB-resolved vs provider-pinned mediaServer", async () => {
  seedUser({
    id: "u-mint",
    email: "mint@example.com",
    name: "Minty",
    role: "USER",
    permissions: PRESETS.USER,
    mediaServer: "jellyfin",
  });
  const ua = chromeUa("mint-main");
  const user = mintableUser("u-mint", { ua });
  const result = await signInAndMintSession({ user, providerId: "credentials" });

  // Result shape.
  assert.deepEqual(result.user, {
    id: "u-mint",
    role: "USER",
    email: "mint@example.com",
    name: "Minty",
    provider: "credentials",
    mediaServer: "jellyfin", // credentials/oidc resolve the DB column
  });
  assert.equal(result.sessionId, user._sessionId);
  assertApprox(result.expiresInSeconds, 3600, "desktop default TTL");

  // The JWT round-trips with the full claim set.
  const claims = await verifySessionJwt(result.token);
  assert.ok(claims, "the minted JWT must verify");
  assert.equal(claims.id, "u-mint");
  assert.equal(claims.role, "USER");
  assert.equal(claims.permissions, PRESETS.USER.toString(), "the permissions claim is read from the DB row");
  assert.equal(claims.provider, "credentials");
  assert.equal(claims.mediaServer, "jellyfin");
  assert.equal(claims.sessionId, user._sessionId);
  assert.equal(claims.uaFingerprint, "chrome:windows:desktop");
  assert.equal(claims.deviceLabel, "Chrome on Windows");
  assert.equal(claims.isMobile, false);

  // The backing AuthSession row carries the device metadata.
  const sessionRow = authSessions.get(result.sessionId);
  assert.ok(sessionRow, "the mint must upsert the AuthSession row");
  assert.equal(sessionRow.userId, "u-mint");
  assert.equal(sessionRow.deviceType, "desktop");
  assert.equal(sessionRow.deviceLabel, "Chrome on Windows");
  assert.equal(sessionRow.ipAddress, untrustedBucketFor(ua));

  // Audit: AUTH_LOGIN with a hash, never the raw email.
  await flushAsync();
  const audit = lastAudit();
  assert.equal(audit.action, "AUTH_LOGIN");
  assert.equal(audit.userId, "u-mint");
  assert.equal(audit.provider, "credentials");
  assert.equal(auditDetails(audit).emailHash, hashAuditEmail("mint@example.com"));
  assert.ok(!JSON.stringify(audit).includes("mint@example.com"), "the raw email must never land in the audit row");

  // Provider-pinned mediaServer: a plex mint for the SAME user reports "plex"
  // even though the DB column says "jellyfin".
  const plexResult = await signInAndMintSession({ user: mintableUser("u-mint"), providerId: "plex" });
  assert.equal(plexResult.user.mediaServer, "plex");
  const plexClaims = await verifySessionJwt(plexResult.token);
  assert.equal(plexClaims?.mediaServer, "plex");
});

test("mint TTL table: desktop/mobile/rememberMe pick their configured windows; the 1-year native TTL requires the X-Summonarr-Client header", async () => {
  seedUser({ id: "u-ttl", email: "ttl@example.com", name: "T" });

  // Outside any request scope headers() throws inside the native check and the
  // catch treats the caller as non-native — the safe default.
  const desktop = await signInAndMintSession({
    user: mintableUser("u-ttl", { ua: chromeUa("ttl-a") }),
    providerId: "credentials",
  });
  assertApprox(desktop.expiresInSeconds, 3600, "desktop, no rememberMe");

  const mobile = await signInAndMintSession({
    user: mintableUser("u-ttl", { ua: iphoneUa("ttl-b") }),
    providerId: "credentials",
  });
  assertApprox(mobile.expiresInSeconds, 604_800, "mobile, no rememberMe");

  const remembered = await signInAndMintSession({
    user: mintableUser("u-ttl", { ua: chromeUa("ttl-c"), rememberMe: "true" }),
    providerId: "credentials",
  });
  assertApprox(remembered.expiresInSeconds, 2_592_000, "web rememberMe → maxDuration");

  // Native app: rememberMe + mobile device + the X-Summonarr-Client header —
  // a custom header a cross-origin page cannot attach (guardrail 6b).
  const native = await withRequestContext(
    { headers: { "x-summonarr-client": "ios; build=42", "user-agent": iphoneUa("ttl-d") } },
    () =>
      signInAndMintSession({
        user: mintableUser("u-ttl", { ua: iphoneUa("ttl-d"), rememberMe: "true" }),
        providerId: "credentials",
      }),
  );
  assertApprox(native.expiresInSeconds, 365 * 24 * 60 * 60, "native client → 1-year fixed TTL");

  // The spoof pin: a mobile UA + rememberMe WITHOUT the native header must NOT
  // mint the 1-year ceiling — any browser can lie about its UA.
  const spoofed = await withRequestContext(
    { headers: { "user-agent": iphoneUa("ttl-e") } },
    () =>
      signInAndMintSession({
        user: mintableUser("u-ttl", { ua: iphoneUa("ttl-e"), rememberMe: "true" }),
        providerId: "credentials",
      }),
  );
  assertApprox(spoofed.expiresInSeconds, 2_592_000, "spoofed mobile UA stays at maxDuration");
});

test("first-admin promotion: fires for credentials pre-setup, is refused for OIDC, and the env flag opts OAuth in", async () => {
  // (a) Credentials sign-in before setup, no admin: promote + close setup.
  settings.delete("setup_completed_at");
  seedUser({ id: "boot-1", email: "boot1@example.com", role: "USER", permissions: PRESETS.USER });
  const promoted = await signInAndMintSession({ user: mintableUser("boot-1"), providerId: "credentials" });
  assert.equal(promoted.user.role, "ADMIN");
  assert.equal(userById("boot-1").role, "ADMIN");
  assert.equal(userById("boot-1").permissions, Permission.ADMIN, "promotion re-seeds the ADMIN preset");
  assert.ok(settings.has("setup_completed_at"), "promotion must close setup");
  const promotedClaims = await verifySessionJwt(promoted.token);
  assert.equal(promotedClaims?.role, "ADMIN", "the minted JWT must already carry the promoted role");
  assert.equal(promotedClaims?.permissions, Permission.ADMIN.toString());

  // (b) OIDC first sign-in pre-setup must NOT self-promote (an attacker
  // completing an IdP flow before the operator runs setup would inherit ADMIN).
  users.length = 0;
  settings.delete("setup_completed_at");
  seedUser({ id: "boot-2", email: "boot2@example.com", role: "USER" });
  const oidcMint = await signInAndMintSession({ user: mintableUser("boot-2"), providerId: "oidc" });
  assert.equal(oidcMint.user.role, "USER");
  assert.equal(userById("boot-2").role, "USER");
  assert.ok(!settings.has("setup_completed_at"), "a refused promotion must not close setup");

  // (c) The documented escape hatch for OAuth-only deployments.
  process.env.SUMMONARR_ALLOW_OAUTH_FIRST_ADMIN = "true";
  users.length = 0;
  seedUser({ id: "boot-3", email: "boot3@example.com", role: "USER" });
  const optedIn = await signInAndMintSession({ user: mintableUser("boot-3"), providerId: "oidc" });
  assert.equal(optedIn.user.role, "ADMIN");
  assert.ok(settings.has("setup_completed_at"));
});

// ── revocation orchestration ────────────────────────────────────────────────

test("revokeSessionById: deletes the row, bumps the cutoff FORWARD-ONLY to the row's createdAt, and marks in-memory only AFTER the commit", async () => {
  const T1 = new Date("2026-07-01T00:00:00.000Z");
  const T2 = new Date("2026-07-02T00:00:00.000Z");

  // (a) Normal revoke: cutoff lands on the revoked row's createdAt (so newer
  // sessions with iat > createdAt survive), and the ledger mark follows.
  seedUser({ id: "u-r1", email: "r1@example.com" });
  authSessions.set("sess-r1", {
    sessionId: "sess-r1", userId: "u-r1", deviceType: "desktop", deviceLabel: null,
    ipAddress: null, expiresAt: new Date(Date.now() + 3_600_000), createdAt: T1, lastSeenAt: T1,
  });
  await revokeSessionById("sess-r1");
  assert.equal(authSessions.has("sess-r1"), false);
  assert.equal(userById("u-r1").sessionsRevokedAt?.getTime(), T1.getTime());
  assert.equal(shouldForceDbCheck("anyone", "sess-r1"), true, "the revoked session must be ledger-marked");

  // (b) Forward-only: a LATER cutoff from a prior revoke-all must not be
  // weakened back to this row's older createdAt.
  seedUser({ id: "u-r2", email: "r2@example.com", sessionsRevokedAt: T2 });
  authSessions.set("sess-r2", {
    sessionId: "sess-r2", userId: "u-r2", deviceType: "desktop", deviceLabel: null,
    ipAddress: null, expiresAt: new Date(Date.now() + 3_600_000), createdAt: T1, lastSeenAt: T1,
  });
  await revokeSessionById("sess-r2");
  assert.equal(userById("u-r2").sessionsRevokedAt?.getTime(), T2.getTime(), "the cutoff must never decrease");

  // (c) Guardrail 27: a failed transaction PROPAGATES and leaves NO in-memory
  // mark — a phantom mark on a still-live row would lie until restart.
  seedUser({ id: "u-r3", email: "r3@example.com" });
  authSessions.set("sess-r3", {
    sessionId: "sess-r3", userId: "u-r3", deviceType: "desktop", deviceLabel: null,
    ipAddress: null, expiresAt: new Date(Date.now() + 3_600_000), createdAt: T1, lastSeenAt: T1,
  });
  failTransactions = true;
  await assert.rejects(() => revokeSessionById("sess-r3"), /transaction failure/);
  failTransactions = false;
  assert.equal(authSessions.has("sess-r3"), true, "the row must survive the failed revoke");
  assert.equal(shouldForceDbCheck("anyone", "sess-r3"), false, "no mark may precede a successful commit");
});

test("revokeAllUserSessions: deletes every row of the user, stamps a fresh cutoff, and marks each session plus the user", async () => {
  const past = new Date(Date.now() - 60_000);
  seedUser({ id: "u-all", email: "all@example.com" });
  seedUser({ id: "u-other", email: "other@example.com" });
  for (const [sid, uid] of [["sess-a1", "u-all"], ["sess-a2", "u-all"], ["sess-b1", "u-other"]] as const) {
    authSessions.set(sid, {
      sessionId: sid, userId: uid, deviceType: "desktop", deviceLabel: null,
      ipAddress: null, expiresAt: new Date(Date.now() + 3_600_000), createdAt: past, lastSeenAt: past,
    });
  }

  const before = Date.now();
  await revokeAllUserSessions("u-all");

  assert.equal(authSessions.has("sess-a1"), false);
  assert.equal(authSessions.has("sess-a2"), false);
  assert.equal(authSessions.has("sess-b1"), true, "other users' sessions must be untouched");
  const cutoff = userById("u-all").sessionsRevokedAt;
  assert.ok(cutoff && cutoff.getTime() >= before && cutoff.getTime() <= Date.now() + 1, "revoke-all stamps a fresh cutoff");
  assert.equal(userById("u-other").sessionsRevokedAt, null);

  // Ledger: both revoked sessions AND the user are marked; the bystander is not.
  assert.equal(shouldForceDbCheck("x", "sess-a1"), true);
  assert.equal(shouldForceDbCheck("x", "sess-a2"), true);
  assert.equal(shouldForceDbCheck("u-all", "sess-fresh"), true, "the user-level mark covers future replays");
  assert.equal(shouldForceDbCheck("u-other", "sess-b1"), false);
});

// Consumed but unasserted: normalizeEmail is re-exported from this module for
// legacy importers — pin that the re-export stays wired to the real impl.
test("normalizeEmail re-export stays wired to the NFKC/lowercase/trim canonicalizer", () => {
  assert.equal(normalizeEmail("  Ｕser@Example.COM "), "user@example.com"); // fullwidth U folds via NFKC
});
