// Route-level unit tests for four unauthenticated / self-authenticating auth
// endpoints. Each route is invoked as a REAL exported handler with a NextRequest;
// the delegates it wires (auth.ts, buildSignInResponse, body-size.ts, ...) are
// OWNED by their own sibling suites — here we pin only the ROUTE's gating/wiring:
//
//   POST /api/auth/register (src/app/api/auth/register/route.ts) — the one-shot
//   first-run bootstrap. Pinned: the first successful sign-up is promoted to
//   ADMIN with the ADMIN permission preset and the returned body is EXACTLY the
//   created user's public columns — NO session token and NO Set-Cookie, even for
//   a native (X-Summonarr-Client) caller (guardrail 6b's token-in-body path is
//   sign-in only; register never signs anyone in); onboarding closes the instant
//   setup_completed_at exists OR any user exists (403 "Registration is closed" —
//   so a "duplicate email" reduces to closed-registration here, not a distinct
//   error); password rules (missing/weak <12/non-string) and email validation
//   (missing/malformed) 400 with zero users created; the email is NFKC/lowercased
//   and the name sanitized on write; the CSRF Origin gate (browser needs a trusted
//   Origin, native is exempt); and the pre-body gates — maintenance 503, disabled
//   local login 403, and the setting-driven per-IP rate cap 429. GUARDRAIL 30:
//   register is the explicitly-named anonymous DoS vector, so the 16 KB body cap
//   (413 header fast-path, 413 chunked post-read, 400 malformed) is pinned hard.
//
//   POST /api/auth/sign-out (src/app/api/auth/sign-out/route.ts) — full
//   server-side revoke. Pinned: a cookie sign-out deletes the AuthSession row and
//   bumps sessionsRevokedAt (via revokeSessionById — internals owned by
//   auth.test.mts) and writes the AUTH_LOGOUT audit; bearer-FIRST resolution (a
//   bearer sign-out revokes the bearer's session, never the cookie's — no
//   fallback); GUARDRAIL 6b — the response appends ONLY cleared cookies (no
//   sliding-refresh token a native client couldn't read) plus no-store headers;
//   an unauthenticated / garbage-token sign-out is an idempotent 200 with no
//   revoke and no audit; and a failed revoke still returns 200 (logged, audit
//   still written) so a DB blip can't strand a user signed-in.
//
//   POST /api/auth/machine-session (src/app/api/auth/machine-session/route.ts) —
//   the admin-impersonating "machine:" session. Pinned: disabled by default
//   (403) and off-allowlist (403) both gate BEFORE the secret; the CRON_SECRET
//   Bearer is required (401) and an unconfigured secret refuses (503); a valid
//   mint returns { ok, expiresAt } only and delivers the machine-provider JWT
//   solely as an HttpOnly cookie (never in the body); and target resolution — no
//   admin → 404, a non-admin requestedUserId → 403.
//
//   GET /api/auth/setup-status (src/app/api/auth/setup-status/route.ts) — the
//   public pre-login probe. Pinned: no auth required, the body is EXACTLY
//   { needsSetup } tracking whether any user exists, and the per-IP rate cap 429.
//
// Owned elsewhere (asserted only at the route seam here, not re-tested):
// revokeSessionById / signInAndMintSession / normalizeEmail (auth.test.mts),
// buildSignInResponse's token-in-body gate (sign-in-response.test.mts), the
// body-size caps (body-size.test.mts), scrypt hashing (password-hash.test.mts),
// parseBearerToken (mobile-auth.test.mts), and the session-JWT crypto
// (session-jwt.test.mts). None of these routes read next/headers cookies()/
// headers() or call after() — register reads req.headers directly and the
// delegates are prisma-only — so (unlike votes/requests route tests) NO synthetic
// workAsyncStorage scope is needed.
//
// No DB or network: globalThis.prisma is pre-seeded with a recording in-memory
// fake BEFORE the module graph loads (the poster-cache / public-routes idiom, so
// prisma.ts hands the fake back un-extended), fetch throws, and every JWT is a
// REAL jose token. TRUST_PROXY=true lets each request carry a unique
// X-Forwarded-For so its rate-limit bucket never collides with another test's.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto
process.env.NEXTAUTH_SECRET = "auth-routes-test-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000"; // insecure context → unprefixed cookie name
process.env.TRUST_PROXY = "true"; // per-request X-Forwarded-For → isolated rate-limit buckets
delete process.env.AUTH_TRUSTED_ORIGIN;
delete process.env.TRUSTED_PROXY_HOPS;
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const CRON_SECRET = "auth-routes-cron-secret-must-be-32-chars-plus-0000";
process.env.CRON_SECRET = CRON_SECRET;

// ── console capture (no happy-path logging; sign-out warns/errors on failure) ─
const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// ── no network, ever ────────────────────────────────────────────────────────
globalThis.fetch = (() => {
  throw new Error("unexpected network call from auth-routes tests");
}) as unknown as typeof fetch;

// ── in-memory DB state ──────────────────────────────────────────────────────
type UserRow = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  permissions: bigint;
  passwordHash: string | null;
  sessionsRevokedAt: Date | null;
  mediaServer: string | null;
  createdAt: Date;
};
type AuthSessionRow = {
  sessionId: string;
  userId: string;
  deviceType: string | null;
  deviceLabel: string | null;
  ipAddress: string | null;
  expiresAt: Date;
  createdAt: Date;
};

const settings = new Map<string, string>();
const users: UserRow[] = [];
const authSessions = new Map<string, AuthSessionRow>();
const auditRows: Array<Record<string, unknown>> = [];
const userCreates: Array<Record<string, unknown>> = [];
let userSeq = 0;
let failTransactions = false;

function applySelect(
  row: Record<string, unknown>,
  select?: Record<string, boolean>,
): Record<string, unknown> {
  if (!select) return { ...row };
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(select)) if (select[key]) out[key] = row[key];
  return out;
}

const settingModel = {
  findUnique: async (args: { where: { key: string } }) =>
    settings.has(args.where.key) ? { key: args.where.key, value: settings.get(args.where.key)! } : null,
  findMany: async (args: { where?: { key?: { in?: string[] } } }) => {
    const keys = args.where?.key?.in ?? [...settings.keys()];
    return keys.filter((k) => settings.has(k)).map((k) => ({ key: k, value: settings.get(k)! }));
  },
  create: async (args: { data: { key: string; value: string } }) => {
    settings.set(args.data.key, args.data.value);
    return { key: args.data.key, value: args.data.value };
  },
  createMany: async (args: { data: Array<{ key: string; value: string }>; skipDuplicates?: boolean }) => {
    let count = 0;
    for (const row of args.data) {
      if (!settings.has(row.key)) { settings.set(row.key, row.value); count++; }
    }
    return { count };
  },
};

const userModel = {
  count: async () => users.length,
  findUnique: async (args: { where: { id: string }; select?: Record<string, boolean> }) => {
    const u = users.find((x) => x.id === args.where.id);
    return u ? applySelect(u as unknown as Record<string, unknown>, args.select) : null;
  },
  findFirst: async (args: {
    where?: { role?: string };
    select?: Record<string, boolean>;
    orderBy?: { createdAt?: "asc" | "desc" };
  }) => {
    let list = users.filter((u) => args.where?.role === undefined || u.role === args.where.role);
    if (args.orderBy?.createdAt === "asc") {
      list = [...list].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    }
    const u = list[0];
    return u ? applySelect(u as unknown as Record<string, unknown>, args.select) : null;
  },
  create: async (args: { data: Record<string, unknown>; select?: Record<string, boolean> }) => {
    const d = args.data;
    const row: UserRow = {
      id: (d.id as string | undefined) ?? `u-${++userSeq}`,
      email: d.email as string,
      name: (d.name as string | null | undefined) ?? null,
      role: (d.role as string | undefined) ?? "USER",
      permissions: (d.permissions as bigint | undefined) ?? 0n,
      passwordHash: (d.passwordHash as string | null | undefined) ?? null,
      sessionsRevokedAt: null,
      mediaServer: null,
      createdAt: new Date(),
    };
    users.push(row);
    userCreates.push(d);
    return applySelect(row as unknown as Record<string, unknown>, args.select);
  },
  update: async (args: { where: { id: string }; data: Record<string, unknown>; select?: Record<string, boolean> }) => {
    const u = users.find((x) => x.id === args.where.id);
    if (!u) throw new Error("user.update: row not found");
    Object.assign(u, args.data);
    return applySelect(u as unknown as Record<string, unknown>, args.select);
  },
};

const authSessionModel = {
  create: async (args: { data: Record<string, unknown> }) => {
    const d = args.data;
    const row: AuthSessionRow = {
      sessionId: d.sessionId as string,
      userId: d.userId as string,
      deviceType: (d.deviceType as string | null | undefined) ?? null,
      deviceLabel: (d.deviceLabel as string | null | undefined) ?? null,
      ipAddress: (d.ipAddress as string | null | undefined) ?? null,
      expiresAt: (d.expiresAt as Date | undefined) ?? new Date(),
      createdAt: new Date(),
    };
    authSessions.set(row.sessionId, row);
    return { ...row };
  },
  findUnique: async (args: { where: { sessionId: string }; select?: Record<string, boolean> }) => {
    const r = authSessions.get(args.where.sessionId);
    return r ? applySelect(r as unknown as Record<string, unknown>, args.select) : null;
  },
  delete: async (args: { where: { sessionId: string } }) => {
    const r = authSessions.get(args.where.sessionId);
    if (!r) throw new Error("authSession.delete: row not found");
    authSessions.delete(args.where.sessionId);
    return { ...r };
  },
};

const auditLogModel = {
  create: async (args: { data: Record<string, unknown> }) => {
    auditRows.push(args.data);
    return { id: auditRows.length, ...args.data };
  },
};

// The $transaction facade: register's callback uses $executeRawUnsafe (advisory
// lock — a no-op here) + setting/user; revokeSessionById's callback uses
// authSession/user. A single facade covers both.
const txFacade = {
  setting: settingModel,
  user: userModel,
  authSession: authSessionModel,
  auditLog: auditLogModel,
  $executeRawUnsafe: async (..._a: unknown[]) => 0,
};

const fakePrisma = {
  setting: settingModel,
  user: userModel,
  authSession: authSessionModel,
  auditLog: auditLogModel,
  $transaction: async (fn: unknown) => {
    if (failTransactions) throw new Error("unit-test transaction failure");
    if (typeof fn === "function") return (fn as (tx: typeof txFacade) => Promise<unknown>)(txFacade);
    return Promise.all(fn as Promise<unknown>[]);
  },
};
(globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;

// ── module under test + owned primitives (dynamic: stubs must precede load) ──
const { NextRequest } = await import("next/server");
const { signSessionJwt, verifySessionJwt } = await import("../src/lib/session-jwt.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");
const { checkRateLimit } = await import("../src/lib/rate-limit.ts");
const { defaultPermissionsForRole } = await import("../src/lib/permissions.ts");
const { POST: registerPost } = await import("../src/app/api/auth/register/route.ts");
const { POST: signOutPost } = await import("../src/app/api/auth/sign-out/route.ts");
const { POST: machineSessionPost } = await import("../src/app/api/auth/machine-session/route.ts");
const { GET: setupStatusGet } = await import("../src/app/api/auth/setup-status/route.ts");

type Req = InstanceType<typeof NextRequest>;

// ── fixtures / helpers ──────────────────────────────────────────────────────
const COOKIE = getSessionCookieName(); // "summonarr-session" under the http AUTH_URL
const VALID_ORIGIN = "http://localhost:3000"; // matches AUTH_URL

// A fresh public-shaped IPv4 per request so each rate-limit bucket
// (register:/machine-session:/setup-status:<ip>) is isolated across tests.
let ipSeq = 0;
function freshIp(): string {
  ipSeq++;
  const a = 1 + (Math.floor(ipSeq / 240) % 240);
  const b = 1 + (ipSeq % 240);
  return `203.0.${a}.${b}`;
}

// void logAudit(...) is fire-and-forget — drain the microtask queue before
// asserting on audit rows.
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function mintToken(opts: {
  id: string;
  sessionId: string;
  role?: string;
  name?: string;
  provider?: string;
  expiresInSeconds?: number;
}): Promise<string> {
  const ttl = opts.expiresInSeconds ?? 7_200;
  const expiresAt = Math.floor(Date.now() / 1000) + ttl;
  return signSessionJwt(
    {
      id: opts.id,
      role: opts.role ?? "USER",
      permissions: "0",
      provider: opts.provider ?? "credentials",
      sessionId: opts.sessionId,
      expiresAt,
      ...(opts.name ? { name: opts.name } : {}),
    },
    { expiresInSeconds: ttl },
  );
}

function seedUser(overrides: Partial<UserRow> & { id: string }): void {
  users.push({
    email: `${overrides.id}@example.com`,
    name: null,
    role: "USER",
    permissions: 0n,
    passwordHash: null,
    sessionsRevokedAt: null,
    mediaServer: null,
    createdAt: new Date(),
    ...overrides,
  });
}

function seedSession(sessionId: string, userId: string, createdAt: Date): void {
  authSessions.set(sessionId, {
    sessionId,
    userId,
    deviceType: null,
    deviceLabel: null,
    ipAddress: null,
    expiresAt: new Date(Date.now() + 3_600_000),
    createdAt,
  });
}

function registerReq(
  body: unknown,
  opts: { origin?: string | null; ip?: string; extraHeaders?: Record<string, string> } = {},
): Req {
  const headers: Record<string, string> = {
    "x-forwarded-for": opts.ip ?? freshIp(),
    "content-type": "application/json",
  };
  if (opts.origin === undefined) headers.origin = VALID_ORIGIN;
  else if (opts.origin !== null) headers.origin = opts.origin;
  Object.assign(headers, opts.extraHeaders ?? {});
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  return new NextRequest("http://localhost:3000/api/auth/register", { method: "POST", headers, body: bodyStr });
}

function signOutReq(headers: Record<string, string> = {}): Req {
  return new NextRequest("http://localhost:3000/api/auth/sign-out", { method: "POST", headers });
}

function machineReq(
  opts: { bearer?: string | null; body?: unknown; ip?: string } = {},
): Req {
  const headers: Record<string, string> = { "x-forwarded-for": opts.ip ?? freshIp() };
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const init: { method: string; headers: Record<string, string>; body?: string } = { method: "POST", headers };
  if (opts.body !== undefined) init.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  return new NextRequest("http://localhost:3000/api/auth/machine-session", init);
}

function setupReq(ip?: string): Req {
  return new NextRequest("http://localhost:3000/api/auth/setup-status", {
    method: "GET",
    headers: { "x-forwarded-for": ip ?? freshIp() },
  });
}

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

const STRONG_PASSWORD = "hunter2hunter2"; // 14 chars, no whitespace

beforeEach(() => {
  settings.clear();
  users.length = 0;
  authSessions.clear();
  auditRows.length = 0;
  userCreates.length = 0;
  userSeq = 0;
  failTransactions = false;
  warns.length = 0;
  errors.length = 0;
});

// ── POST /api/auth/register ─────────────────────────────────────────────────

test("register: the first sign-up bootstraps the initial ADMIN and returns the user with NO session token", async () => {
  const res = await registerPost(registerReq({ name: " <Admin> ", email: "Admin@Example.COM", password: STRONG_PASSWORD }));
  assert.equal(res.status, 201);
  const body = await bodyOf(res);

  // First user is promoted to ADMIN with the ADMIN permission preset.
  assert.equal(body.role, "ADMIN");
  assert.equal(userCreates[0].role, "ADMIN");
  assert.equal(userCreates[0].permissions, defaultPermissionsForRole("ADMIN"));

  // Email is NFKC/lowercased on write; the display name is sanitized (angle
  // brackets stripped, trimmed).
  assert.equal(body.email, "admin@example.com");
  assert.equal(body.name, "Admin");

  // The 201 body is EXACTLY the created user's public columns — no token, no cookie.
  assert.deepEqual(Object.keys(body).sort(), ["email", "id", "name", "role"]);
  assert.ok(!("token" in body));
  assert.equal(res.headers.getSetCookie().length, 0, "register must not sign the user in");

  // Setup is now marked complete and the safer Discord default is seeded.
  assert.ok(settings.has("setup_completed_at"));
  assert.equal(settings.get("discordRequireLinkedAccount"), "true");
});

test("register: onboarding is one-shot — a completed setup OR any existing user closes it (403)", async () => {
  // (a) setup_completed_at already present.
  settings.set("setup_completed_at", "2026-01-01T00:00:00.000Z");
  const closed = await registerPost(registerReq({ email: "late@example.com", password: STRONG_PASSWORD }));
  assert.equal(closed.status, 403);
  assert.deepEqual(await bodyOf(closed), { error: "Registration is closed" });
  assert.equal(users.length, 0);

  // (b) no setup row, but a user already exists (this is also where a would-be
  // "duplicate email" lands — closed registration, not a distinct error).
  settings.delete("setup_completed_at");
  seedUser({ id: "u-existing", email: "first@example.com", role: "ADMIN" });
  const closed2 = await registerPost(registerReq({ email: "second@example.com", password: STRONG_PASSWORD }));
  assert.equal(closed2.status, 403);
  assert.deepEqual(await bodyOf(closed2), { error: "Registration is closed" });
  assert.equal(users.length, 1, "no second user may be created");
});

test("register: missing, too-short, and non-string passwords are rejected (400) with no user created", async () => {
  const missing = await registerPost(registerReq({ email: "a@b.co" }));
  assert.equal(missing.status, 400);
  assert.deepEqual(await bodyOf(missing), { error: "Email and password are required" });

  const weak = await registerPost(registerReq({ email: "a@b.co", password: "short" }));
  assert.equal(weak.status, 400);
  assert.deepEqual(await bodyOf(weak), { error: "Password must be at least 12 characters" });

  // A JSON-number password is truthy (slips past !password) but must be rejected
  // before it reaches hashPassword.
  const nonString = await registerPost(registerReq({ email: "a@b.co", password: 123456789012 }));
  assert.equal(nonString.status, 400);
  assert.deepEqual(await bodyOf(nonString), { error: "Invalid password" });

  assert.equal(users.length, 0);
});

test("register: a missing or malformed email is rejected (400) with no user created", async () => {
  const missing = await registerPost(registerReq({ password: STRONG_PASSWORD }));
  assert.equal(missing.status, 400);
  assert.deepEqual(await bodyOf(missing), { error: "Email and password are required" });

  const malformed = ["noatsign", "a@b@c.co", "@example.com", "admin@", "admin@nodot", "admin@example.", "ad min@example.com"];
  for (const email of malformed) {
    const res = await registerPost(registerReq({ email, password: STRONG_PASSWORD }));
    assert.equal(res.status, 400, `${email} must be rejected`);
    assert.deepEqual(await bodyOf(res), { error: "Invalid email address" }, email);
  }
  assert.equal(users.length, 0);
});

test("register (guardrail 30): the anonymous body is capped — oversized → 413, malformed → 400 — before any user exists", async () => {
  // Content-Length fast path: 413 on the header alone, no body parse.
  const viaHeader = await registerPost(registerReq("{}", { extraHeaders: { "content-length": "20000" } }));
  assert.equal(viaHeader.status, 413);
  assert.deepEqual(await bodyOf(viaHeader), { error: "Request body too large (max 16KB)" });

  // Chunked bypass (no Content-Length): caught by the post-read byte check.
  const oversized = JSON.stringify({ pad: "x".repeat(20 * 1024) });
  const viaBody = await registerPost(registerReq(oversized));
  assert.equal(viaBody.status, 413);
  assert.deepEqual(await bodyOf(viaBody), { error: "Request body too large (max 16KB)" });

  // Malformed JSON under the cap → 400.
  const malformed = await registerPost(registerReq("{not json"));
  assert.equal(malformed.status, 400);
  assert.deepEqual(await bodyOf(malformed), { error: "Invalid request body" });

  assert.equal(users.length, 0);
});

test("register CSRF: a browser needs a trusted Origin (403); a native X-Summonarr-Client request is exempt and still gets no token", async () => {
  // Missing Origin (browser) → 403 before any DB work.
  const noOrigin = await registerPost(registerReq({ email: "x@example.com", password: STRONG_PASSWORD }, { origin: null }));
  assert.equal(noOrigin.status, 403);
  assert.deepEqual(await bodyOf(noOrigin), { error: "Forbidden" });

  // Untrusted Origin → 403.
  const badOrigin = await registerPost(
    registerReq({ email: "x@example.com", password: STRONG_PASSWORD }, { origin: "http://evil.example" }),
  );
  assert.equal(badOrigin.status, 403);
  assert.deepEqual(await bodyOf(badOrigin), { error: "Forbidden" });
  assert.equal(users.length, 0, "a rejected-origin request must never reach the create");

  // Native client (a custom header a cross-origin page can't forge) is
  // CSRF-exempt, bootstraps the ADMIN, and STILL returns no session token —
  // register never signs anyone in (guardrail 6b's token-in-body path is
  // sign-in only).
  const native = await registerPost(
    registerReq({ email: "native@example.com", password: STRONG_PASSWORD }, {
      origin: null,
      extraHeaders: { "x-summonarr-client": "ios; build=1" },
    }),
  );
  assert.equal(native.status, 201);
  const body = await bodyOf(native);
  assert.equal(body.role, "ADMIN");
  assert.ok(!("token" in body));
  assert.equal(native.headers.getSetCookie().length, 0);
});

test("register rejects before reading the body: maintenance (503), disabled local login (403), and the per-IP rate cap (429)", async () => {
  const validBody = { email: "gate@example.com", password: STRONG_PASSWORD };

  // (a) maintenance mode.
  settings.clear();
  settings.set("maintenanceEnabled", "true");
  const maint = await registerPost(registerReq(validBody));
  assert.equal(maint.status, 503);
  assert.deepEqual(await bodyOf(maint), { error: "Registration is disabled during maintenance" });

  // (b) local registration disabled.
  settings.clear();
  settings.set("disableLocalLogin", "true");
  const disabled = await registerPost(registerReq(validBody));
  assert.equal(disabled.status, 403);
  assert.deepEqual(await bodyOf(disabled), { error: "Local registration is disabled" });

  // (c) setting-driven per-IP rate cap: pre-fill the bucket to the configured limit.
  settings.clear();
  settings.set("rateLimitRegister", "3");
  const ip = freshIp();
  for (let i = 0; i < 3; i++) checkRateLimit(`register:${ip}`, 3, 15 * 60 * 1000);
  const limited = await registerPost(registerReq(validBody, { ip }));
  assert.equal(limited.status, 429);
  assert.deepEqual(await bodyOf(limited), { error: "Too many requests — try again later" });

  assert.equal(users.length, 0, "no gate-rejected request may create a user");
});

// ── POST /api/auth/sign-out ─────────────────────────────────────────────────

test("sign-out (cookie): fully revokes the session server-side and clears both cookie variants", async () => {
  const created = new Date(Date.now() - 1000);
  seedSession("sess-co", "u-co", created);
  seedUser({ id: "u-co", email: "co@example.com", name: "Cookie User", createdAt: created });
  const token = await mintToken({ id: "u-co", sessionId: "sess-co", name: "Cookie User" });

  const res = await signOutPost(signOutReq({ cookie: `${COOKIE}=${token}` }));
  assert.equal(res.status, 200);
  assert.deepEqual(await bodyOf(res), { ok: true });

  // The server-side revoke actually happened: the AuthSession row is gone and
  // the user's sessionsRevokedAt cutoff was bumped to the revoked row's createdAt.
  assert.equal(authSessions.has("sess-co"), false, "the AuthSession row must be deleted");
  assert.deepEqual(users[0].sessionsRevokedAt, created, "sessionsRevokedAt must bump to the row's createdAt");

  // Both Summonarr cookie variants are cleared (Max-Age=0), plus no-store headers.
  const setCookies = res.headers.getSetCookie();
  assert.ok(setCookies.some((c) => c.startsWith("summonarr-session=;") && c.includes("Max-Age=0")));
  assert.ok(setCookies.some((c) => c.startsWith("__Host-summonarr-session=;")));
  assert.equal(res.headers.get("cache-control"), "no-store, private");

  await flush();
  const audit = auditRows.at(-1);
  assert.equal(audit?.action, "AUTH_LOGOUT");
  assert.equal(audit?.userId, "u-co");
});

test("sign-out is bearer-first: a bearer sign-out revokes the bearer's session, not the cookie's", async () => {
  const t = new Date(Date.now() - 1000);
  seedSession("sess-be", "u-be", t);
  seedSession("sess-ck", "u-ck", t);
  seedUser({ id: "u-be", createdAt: t });
  seedUser({ id: "u-ck", createdAt: t });
  const bearerToken = await mintToken({ id: "u-be", sessionId: "sess-be" });
  const cookieToken = await mintToken({ id: "u-ck", sessionId: "sess-ck" });

  const res = await signOutPost(
    signOutReq({ authorization: `Bearer ${bearerToken}`, cookie: `${COOKIE}=${cookieToken}` }),
  );
  assert.equal(res.status, 200);
  assert.equal(authSessions.has("sess-be"), false, "the bearer's session must be revoked");
  assert.equal(authSessions.has("sess-ck"), true, "the cookie's session must be untouched (bearer-first, no fallback)");
});

test("sign-out (guardrail 6b): appends only cleared cookies — no sliding-refresh token — plus no-store headers", async () => {
  const t = new Date(Date.now() - 1000);
  seedSession("sess-b6", "u-b6", t);
  seedUser({ id: "u-b6", createdAt: t });
  const token = await mintToken({ id: "u-b6", sessionId: "sess-b6" });

  const res = await signOutPost(signOutReq({ authorization: `Bearer ${token}` }));
  const setCookies = res.headers.getSetCookie();
  // Every Set-Cookie is a clearing directive; none re-issues a live session
  // token (a native client can't read Set-Cookie, and a refreshed cookie would
  // leak a fresh JWT into any header-logging intermediary).
  assert.ok(setCookies.length > 0);
  for (const c of setCookies) assert.ok(c.includes("Max-Age=0"), `not a clearing cookie: ${c}`);
  assert.ok(!setCookies.some((c) => c.includes(token)), "no Set-Cookie may carry the live session token");
  assert.equal(res.headers.get("cache-control"), "no-store, private");
});

test("sign-out is idempotent: no token and a garbage token both return 200 with no revoke and no audit", async () => {
  // A live session row that must survive an unauthenticated sign-out.
  seedSession("sess-live", "u-live", new Date());

  const noAuth = await signOutPost(signOutReq());
  assert.equal(noAuth.status, 200);
  assert.deepEqual(await bodyOf(noAuth), { ok: true });
  assert.ok(noAuth.headers.getSetCookie().length > 0, "cookies are cleared even with no session");

  const garbage = await signOutPost(signOutReq({ authorization: "Bearer not-a-real-jwt" }));
  assert.equal(garbage.status, 200);
  assert.deepEqual(await bodyOf(garbage), { ok: true });

  await flush();
  assert.equal(authSessions.has("sess-live"), true, "no unrelated session may be revoked");
  assert.equal(auditRows.length, 0, "no AUTH_LOGOUT is written without a valid session");
});

test("sign-out survives a failed server-side revoke: still 200 + cleared cookies, error logged, audit still written", async () => {
  const t = new Date(Date.now() - 1000);
  seedSession("sess-fail", "u-fail", t);
  seedUser({ id: "u-fail", name: "Fail", createdAt: t });
  const token = await mintToken({ id: "u-fail", sessionId: "sess-fail", name: "Fail" });

  failTransactions = true; // revokeSessionById's $transaction throws
  const res = await signOutPost(signOutReq({ cookie: `${COOKIE}=${token}` }));
  assert.equal(res.status, 200, "a DB revoke failure must not block local sign-out");
  assert.deepEqual(await bodyOf(res), { ok: true });
  assert.ok(res.headers.getSetCookie().length > 0);
  assert.ok(errors.some((e) => e.includes("sign-out revoke failed")), "the revoke failure must be logged");

  await flush();
  assert.equal(auditRows.at(-1)?.action, "AUTH_LOGOUT", "the logout audit is written even when the revoke fails");
});

// ── POST /api/auth/machine-session ──────────────────────────────────────────

test("machine-session is gated: disabled by default (403) and blocked off the IP allowlist (403)", async () => {
  // (a) enableMachineSession unset → disabled, even with the correct secret.
  const disabled = await machineSessionPost(machineReq({ bearer: CRON_SECRET }));
  assert.equal(disabled.status, 403);
  assert.deepEqual(await bodyOf(disabled), { error: "Machine session API is disabled" });

  // (b) enabled, but the caller's IP is off the configured allowlist — gated
  // before the secret compare, so even the correct secret is refused.
  settings.set("enableMachineSession", "true");
  settings.set("machineSessionAllowedIps", "198.51.100.0/24");
  const offList = await machineSessionPost(machineReq({ bearer: CRON_SECRET, ip: "203.0.113.9" }));
  assert.equal(offList.status, 403);
  assert.deepEqual(await bodyOf(offList), { error: "Forbidden" });
});

test("machine-session requires the CRON_SECRET bearer (401) and refuses when the secret is unconfigured (503)", async () => {
  settings.set("enableMachineSession", "true");

  const noHeader = await machineSessionPost(machineReq({}));
  assert.equal(noHeader.status, 401);
  assert.deepEqual(await bodyOf(noHeader), { error: "Unauthorized" });

  const wrong = await machineSessionPost(machineReq({ bearer: "wrong-secret" }));
  assert.equal(wrong.status, 401);

  // CRON_SECRET unset → the route cannot authorize anyone (checked before the
  // header compare, so even a "correct" bearer 503s).
  delete process.env.CRON_SECRET;
  try {
    const unconfigured = await machineSessionPost(machineReq({ bearer: CRON_SECRET }));
    assert.equal(unconfigured.status, 503);
    assert.deepEqual(await bodyOf(unconfigured), { error: "Not configured" });
  } finally {
    process.env.CRON_SECRET = CRON_SECRET;
  }
});

test("machine-session mint: a valid request mints an admin-provider JWT delivered only as an HttpOnly cookie, never in the body", async () => {
  settings.set("enableMachineSession", "true");
  seedUser({ id: "admin-1", email: "admin@example.com", name: "Root Admin", role: "ADMIN" });

  const res = await machineSessionPost(machineReq({ bearer: CRON_SECRET }));
  assert.equal(res.status, 200);
  const body = await bodyOf(res);
  // Body carries ONLY the non-sensitive expiry — the admin-impersonating JWT
  // must never appear in it.
  assert.deepEqual(Object.keys(body).sort(), ["expiresAt", "ok"]);
  assert.equal(body.ok, true);
  assert.equal(typeof body.expiresAt, "number");
  assert.ok(!("token" in body));

  const setCookie = res.headers.getSetCookie()[0];
  assert.ok(setCookie?.startsWith(`${COOKIE}=`));
  assert.ok(setCookie.includes("HttpOnly"));
  assert.ok(setCookie.includes("Max-Age=900"), "default machine-session lifetime is 900s");

  const cookieToken = setCookie.slice(COOKIE.length + 1).split(";")[0];
  assert.equal(JSON.stringify(body).includes(cookieToken), false, "the JWT must not leak into the body");
  const claims = await verifySessionJwt(cookieToken);
  assert.ok(claims, "the cookie must carry a genuine signed session JWT");
  assert.equal(claims.id, "admin-1");
  assert.equal(claims.role, "ADMIN");
  assert.equal(claims.provider, "machine");
  // The AuthSession row was persisted under the minted sessionId.
  assert.ok(claims.sessionId && authSessions.has(claims.sessionId), "the AuthSession row must be created");
});

test("machine-session target resolution: no admin → 404; a non-admin requestedUserId → 403", async () => {
  settings.set("enableMachineSession", "true");

  // (a) no admin exists at all.
  const noAdmin = await machineSessionPost(machineReq({ bearer: CRON_SECRET }));
  assert.equal(noAdmin.status, 404);
  assert.deepEqual(await bodyOf(noAdmin), { error: "No admin user found" });

  // (b) an explicit userId resolving to a non-admin — the machine session may
  // only ever impersonate an ADMIN.
  seedUser({ id: "plain-user", role: "USER" });
  const notAdmin = await machineSessionPost(machineReq({ bearer: CRON_SECRET, body: { userId: "plain-user" } }));
  assert.equal(notAdmin.status, 403);
  assert.deepEqual(await bodyOf(notAdmin), { error: "Requested user is not an admin" });
});

// ── GET /api/auth/setup-status ──────────────────────────────────────────────

test("setup-status is public and returns only needsSetup, tracking whether any user exists", async () => {
  // No auth material at all — the route is public by design.
  const empty = await setupStatusGet(setupReq());
  assert.equal(empty.status, 200);
  const emptyBody = await bodyOf(empty);
  assert.deepEqual(emptyBody, { needsSetup: true });
  assert.deepEqual(Object.keys(emptyBody), ["needsSetup"], "no field beyond needsSetup may leak to anonymous callers");

  seedUser({ id: "u-1", email: "a@example.com", role: "ADMIN" });
  const seeded = await setupStatusGet(setupReq());
  assert.equal(seeded.status, 200);
  assert.deepEqual(await bodyOf(seeded), { needsSetup: false });
});

test("setup-status caps the per-IP probe rate (429)", async () => {
  const ip = freshIp();
  for (let i = 0; i < 30; i++) checkRateLimit(`setup-status:${ip}`, 30, 60_000);
  const limited = await setupStatusGet(setupReq(ip));
  assert.equal(limited.status, 429);
  assert.deepEqual(await bodyOf(limited), { error: "Too many requests" });
});
