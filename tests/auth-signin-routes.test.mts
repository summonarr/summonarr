// Route-level unit tests for the seven uncovered authentication routes:
//   POST /api/auth/sign-in/credentials
//   POST /api/auth/sign-in/plex
//   POST /api/auth/plex/start
//   GET/POST /api/auth/plex/pin
//   GET  /api/auth/plex/client-id
//   GET  /api/auth/oidc/start
//   GET  /api/auth/oidc/callback
//
// tests/auth.test.mts covers the lib orchestration (authorizeWith*,
// signInAndMintSession, the revocation ledger); these are the HTTP handlers
// around it, and they are the app's unauthenticated front door. Two of the
// invariants below are prior security-audit findings, so they get the most
// attention:
//
//   1. THE PLEX PIN IS BOUND TO THIS SERVER AND THIS BROWSER. /start mints a
//      signed flow cookie carrying (pinId, clientId); sign-in refuses any
//      submission whose body pinId or clientId disagrees with it. Without that
//      binding, an attacker who phishes a Plex user into approving an
//      ATTACKER-created PIN can submit the resulting token from their own
//      browser and walk away with a Summonarr session as that user. Every leg of
//      the binding is tested from the attacker's side.
//   2. THE OIDC RETURN TARGET IS AN OPEN-REDIRECT SURFACE. /start validates
//      ?callbackUrl through safeInternalPath before signing it into the state
//      cookie, and the callback re-validates on the way out — that second
//      redirect carries the freshly-minted session cookie, so an off-origin
//      target there is a post-authentication phishing hand-off. The old
//      hand-rolled `startsWith("/") && !startsWith("//")` test let `/\t/evil.com`
//      through, which is exactly what is probed here.
//
//   3. Guardrail 6b: the session JWT reaches a body ONLY for a client sending
//      X-Summonarr-Client. A web caller must get the HttpOnly cookie and nothing
//      else, or the token is readable by page JS and HttpOnly bought nothing.
//   4. Unauthenticated surfaces are body-capped and IP-rate-limited (guardrail
//      30), and a disabled account is refused at the mint chokepoint rather than
//      by scrubbing identity (guardrail 33).
//   5. /api/auth/plex/client-id deliberately answers { clientId: null } instead
//      of 401 when signed out — it is polled by the login page, and a 401 there
//      would surface as a spurious error.
//
// Harness: real handlers, genuine signed session JWTs where a session is needed,
// a synthetic Next request scope, in-memory prisma stubs, and a scripted fetch
// for plex.tv. The OIDC discovery/token-exchange leg needs a live IdP, so the
// callback's SUCCESS path is out of scope here (tests/oidc.test.mts covers the
// lib); every failure and gating path is covered. No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import dns from "node:dns/promises";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "auth-signin-routes-secret-0123456789abc";
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

// ── scripted plex.tv ─────────────────────────────────────────────────────────
const fetchCalls: Array<{ url: URL; method: string; headers: Headers }> = [];
let plexPinCreate: { id?: number; code?: string } | null = { id: 4242, code: "ABCD" };
let plexPinStatus = 200;
let plexPinToken: string | null = null;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  fetchCalls.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers) });
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
  if (url.hostname === "plex.tv" && url.pathname === "/api/v2/pins") {
    return plexPinStatus === 200 ? json(plexPinCreate ?? {}) : json({ error: "nope" }, plexPinStatus);
  }
  if (url.hostname === "plex.tv" && /^\/api\/v2\/pins\/\d+$/.test(url.pathname)) {
    return plexPinStatus === 200 ? json({ authToken: plexPinToken }) : json({ error: "nope" }, plexPinStatus);
  }
  // Everything else (plex.tv user lookup, OIDC discovery) fails — the routes'
  // error paths are what this file exercises.
  return json({ error: "unavailable" }, 503);
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
const { signPlexFlowCookie, PLEX_FLOW_COOKIE } = await import("../src/lib/plex-flow-state.ts");
const { OIDC_STATE_COOKIE, OIDC_STATE_COOKIE_PATH, verifyOidcStateCookie, signOidcStateCookie } =
  await import("../src/lib/oidc.ts");
const { NATIVE_CLIENT_HEADER } = await import("../src/lib/mobile-auth.ts");
const { hashPassword } = await import("../src/lib/password-hash.ts");

// ── op log ───────────────────────────────────────────────────────────────────
type Op = { op: string; args?: unknown };
let ops: Op[] = [];
const rec = (op: string, args?: unknown) => { ops.push({ op, args }); };
// initializeTokenOnSignIn writes the AuthSession row via upsert; create exists
// on the stub too, so "no session was minted" has to watch BOTH.
const sessionWrites = () => ops.filter((o) => o.op === "authSession.upsert" || o.op === "authSession.create").length;

// ── user store ───────────────────────────────────────────────────────────────
type DbUser = Record<string, unknown> & { id: string; email: string | null };
let dbUsers: DbUser[] = [];
const sessionRows = new Set<string>();

shadowPrismaModel(prisma, "authSession", {
  findUnique: async (args: { where: { sessionId: string } }) =>
    sessionRows.has(args.where.sessionId) ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId } : null,
  create: async (args: { data: { sessionId: string } }) => {
    rec("authSession.create", args.data);
    sessionRows.add(args.data.sessionId);
    return { id: "as1", ...args.data };
  },
  update: async () => ({}),
  upsert: async (args: { create?: { sessionId?: string }; update?: unknown }) => {
    rec("authSession.upsert", args);
    if (args.create?.sessionId) sessionRows.add(args.create.sessionId);
    return { id: "as1" };
  },
  updateMany: async () => ({ count: 0 }),
  deleteMany: async () => ({ count: 0 }),
  count: async () => 0,
  findMany: async () => [],
});

shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id?: string; email?: string } }) => {
    rec("user.findUnique", args.where);
    if (args.where.id) return dbUsers.find((u) => u.id === args.where.id) ?? null;
    if (args.where.email) return dbUsers.find((u) => u.email === args.where.email) ?? null;
    return null;
  },
  findFirst: async (args: { where?: Record<string, unknown> } = {}) => {
    rec("user.findFirst", args.where);
    return dbUsers[0] ?? null;
  },
  findMany: async () => [],
  count: async () => dbUsers.length,
  update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
    rec("user.update", args);
    const u = dbUsers.find((x) => x.id === args.where.id);
    if (u) Object.assign(u, args.data);
    return u ?? {};
  },
  create: async (args: { data: Record<string, unknown> }) => { rec("user.create", args.data); return { id: "new", ...args.data }; },
  upsert: async (args: unknown) => { rec("user.upsert", args); return { id: "new" }; },
});

for (const m of ["account", "setting", "auditLog", "mediaServerUser", "plexTokenCache"]) {
  shadowPrismaModel(prisma, m, {
    findUnique: async () => null, findFirst: async () => null, findMany: async () => [],
    count: async () => 0,
    create: async (args: unknown) => { rec(`${m}.create`, args); return { id: "x" }; },
    update: async (args: unknown) => { rec(`${m}.update`, args); return {}; },
    upsert: async (args: unknown) => { rec(`${m}.upsert`, args); return {}; },
    updateMany: async () => ({ count: 0 }), deleteMany: async () => ({ count: 0 }),
  });
}
shadowPrismaClientMethod(prisma, "$transaction", async (arg: unknown) =>
  Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => Promise<unknown>)(prisma));
shadowPrismaClientMethod(prisma, "$queryRaw", async () => []);
shadowPrismaClientMethod(prisma, "$queryRawUnsafe", async () => []);
shadowPrismaClientMethod(prisma, "$executeRaw", async () => 1);
shadowPrismaClientMethod(prisma, "$executeRawUnsafe", async () => 1);

const credentials = await import("../src/app/api/auth/sign-in/credentials/route.ts");
const plexSignIn = await import("../src/app/api/auth/sign-in/plex/route.ts");
const plexStart = await import("../src/app/api/auth/plex/start/route.ts");
const plexPin = await import("../src/app/api/auth/plex/pin/route.ts");
const plexClientId = await import("../src/app/api/auth/plex/client-id/route.ts");
const oidcStart = await import("../src/app/api/auth/oidc/start/route.ts");
const oidcCallback = await import("../src/app/api/auth/oidc/callback/route.ts");

// ── scope ────────────────────────────────────────────────────────────────────
function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = {
    route: "/auth-signin.test", forceStatic: false, dynamicShouldError: false,
    afterContext: { after: () => {} },
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

function post(path: string, body: string | undefined, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    ...(body !== undefined ? { body } : {}),
  });
}
function get(path: string, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost:3000${path}`, { method: "GET", headers });
}

const setCookies = (res: Response): string[] => res.headers.getSetCookie?.() ?? [];
const COOKIE = getSessionCookieName();

let seq = 0;
async function mintAdminSession(): Promise<string> {
  seq++;
  const userId = `admin-${seq}`;
  const sessionId = `sess-admin-${seq}`;
  dbUsers.push({
    id: userId, name: "Admin", email: `admin-${seq}@example.com`, role: "ADMIN",
    permissions: Permission.ADMIN, mediaServer: null, sessionsRevokedAt: null,
    passwordChangedAt: null, deactivatedAt: null, notificationEmail: null, plexClientId: "abcdef01-2345-4678-9abc-def012345678",
  });
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000);
  return signSessionJwt(
    { id: userId, role: "ADMIN", permissions: Permission.ADMIN.toString(), provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
}

const VALID_CLIENT_ID = "abcdef01-2345-4678-9abc-def012345678";

beforeEach(() => {
  ops = [];
  dbUsers = [];
  sessionRows.clear();
  fetchCalls.length = 0;
  warns.length = 0;
  errors.length = 0;
  plexPinCreate = { id: 4242, code: "ABCD" };
  plexPinStatus = 200;
  plexPinToken = null;
  delete process.env.OIDC_ISSUER;
  delete process.env.OIDC_CLIENT_ID;
  delete process.env.OIDC_CLIENT_SECRET;
  process.env.AUTH_URL = "http://localhost:3000";
});

// ── credentials sign-in ──────────────────────────────────────────────────────

for (const [label, body] of [
  ["a missing email", { password: "hunter2hunter2" }],
  ["a missing password", { email: "a@b.com" }],
  ["a non-string email", { email: 1, password: "hunter2hunter2" }],
  ["a non-string password", { email: "a@b.com", password: 1 }],
  ["an empty body", {}],
] as const) {
  test(`credentials sign-in with ${label} is 400`, async () => {
    const res = await inScope(() => credentials.POST(post("/api/auth/sign-in/credentials", JSON.stringify(body))));
    assert.equal(res.status, 400);
    assert.equal(sessionWrites(), 0, "no session may be minted");
  });
}

test("credentials sign-in with a malformed body is 400, not a 500", async () => {
  const res = await inScope(() => credentials.POST(post("/api/auth/sign-in/credentials", "{nope")));
  assert.equal(res.status, 400);
});

test("credentials sign-in caps its body — this is an unauthenticated surface (guardrail 30)", async () => {
  const huge = JSON.stringify({ email: "a@b.com", password: "p".repeat(32 * 1024) });
  const res = await inScope(() => credentials.POST(post("/api/auth/sign-in/credentials", huge)));
  assert.ok(res.status === 400 || res.status === 413, `expected a cap rejection, got ${res.status}`);
  assert.equal(sessionWrites(), 0);
});

test("credentials sign-in with unknown credentials is 401 and mints nothing", async () => {
  const res = await inScope(() =>
    credentials.POST(post("/api/auth/sign-in/credentials", JSON.stringify({ email: "nobody@example.com", password: "wrongpassword" }))),
  );
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, "Invalid credentials");
  assert.equal(sessionWrites(), 0);
});

test("credentials sign-in with a wrong password is 401 — same message as an unknown user", async () => {
  // Identical wording either way: distinguishing them is a user-enumeration oracle.
  dbUsers.push({
    id: "u1", email: "real@example.com", name: "Real", role: "USER", permissions: 0n,
    passwordHash: await hashPassword("correct-password"), mediaServer: null,
    sessionsRevokedAt: null, passwordChangedAt: null, deactivatedAt: null, notificationEmail: null,
  });
  const res = await inScope(() =>
    credentials.POST(post("/api/auth/sign-in/credentials", JSON.stringify({ email: "real@example.com", password: "wrong-password" }))),
  );
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, "Invalid credentials");
});

test("a successful web sign-in sets an HttpOnly session cookie and returns NO token in the body", async () => {
  // Guardrail 6b: the JWT reaches a body only for an X-Summonarr-Client caller.
  // Returning it unconditionally would expose it to page JS and defeat HttpOnly.
  dbUsers.push({
    id: "u1", email: "real@example.com", name: "Real", role: "USER", permissions: 0n,
    passwordHash: await hashPassword("correct-password"), mediaServer: null,
    sessionsRevokedAt: null, passwordChangedAt: null, deactivatedAt: null, notificationEmail: null,
  });
  const res = await inScope(() =>
    credentials.POST(post("/api/auth/sign-in/credentials", JSON.stringify({ email: "real@example.com", password: "correct-password" }))),
  );
  assert.equal(res.status, 200);
  const cookies = setCookies(res);
  assert.ok(cookies.some((c) => c.startsWith(`${COOKIE}=`)), `no session cookie: ${cookies.join(" | ")}`);
  assert.ok(cookies.some((c) => /HttpOnly/i.test(c)), "the session cookie must be HttpOnly");
  const body = await res.json();
  assert.ok(!("token" in body), "a web caller must not receive the raw JWT");
});

test("a NATIVE sign-in receives the token in the body as well as the cookie", async () => {
  dbUsers.push({
    id: "u1", email: "real@example.com", name: "Real", role: "USER", permissions: 0n,
    passwordHash: await hashPassword("correct-password"), mediaServer: null,
    sessionsRevokedAt: null, passwordChangedAt: null, deactivatedAt: null, notificationEmail: null,
  });
  const res = await inScope(() =>
    credentials.POST(
      post("/api/auth/sign-in/credentials", JSON.stringify({ email: "real@example.com", password: "correct-password" }), {
        [NATIVE_CLIENT_HEADER]: "ios; build=42",
      }),
    ),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.token, "string", "a native client needs the JWT for its Keychain");
});

test("a DISABLED account is refused at the mint chokepoint, not by identity scrubbing", async () => {
  // Guardrail 33: removal disables rather than scrubs, so the row still matches
  // and must be turned away at signInAndMintSession.
  dbUsers.push({
    id: "u1", email: "gone@example.com", name: "Gone", role: "USER", permissions: 0n,
    passwordHash: await hashPassword("correct-password"), mediaServer: null,
    sessionsRevokedAt: null, passwordChangedAt: null, deactivatedAt: new Date(), notificationEmail: null,
  });
  const res = await inScope(() =>
    credentials.POST(post("/api/auth/sign-in/credentials", JSON.stringify({ email: "gone@example.com", password: "correct-password" }))),
  );
  assert.ok(res.status === 401 || res.status === 403, `expected a refusal, got ${res.status}`);
  assert.equal(sessionWrites(), 0, "a disabled account must never get a session row");
  assert.ok(!setCookies(res).some((c) => c.startsWith(`${COOKIE}=`)), "no session cookie for a disabled account");
});

// ── 1: the Plex flow-state binding (anti-phishing) ───────────────────────────

async function flowCookie(pinId: number, clientId = VALID_CLIENT_ID): Promise<string> {
  return signPlexFlowCookie({ pinId, clientId });
}

test("plex sign-in requires a plexToken and a numeric pinId", async () => {
  for (const body of [{}, { plexToken: "t" }, { pinId: 1 }, { plexToken: "t", pinId: "1" }, { plexToken: 1, pinId: 1 }]) {
    const res = await inScope(() => plexSignIn.POST(post("/api/auth/sign-in/plex", JSON.stringify(body))));
    assert.equal(res.status, 400, `body ${JSON.stringify(body)} should be rejected`);
  }
});

test("plex sign-in with NO flow cookie is refused — an unbound PIN is the phishing vector", async () => {
  const res = await inScope(() =>
    plexSignIn.POST(post("/api/auth/sign-in/plex", JSON.stringify({ plexToken: "phished-token", pinId: 4242 }))),
  );
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /flow expired/i);
  assert.equal(sessionWrites(), 0);
});

test("plex sign-in with a FORGED flow cookie is refused", async () => {
  const res = await inScope(() =>
    plexSignIn.POST(
      post("/api/auth/sign-in/plex", JSON.stringify({ plexToken: "t", pinId: 4242 }), {
        cookie: `${PLEX_FLOW_COOKIE}=not-a-valid-signed-value`,
      }),
    ),
  );
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /flow expired/i);
});

test("plex sign-in refuses a pinId that does not match the cookie — THE anti-phishing pin", async () => {
  // The attack: phish a Plex user into approving an ATTACKER-created PIN, then
  // submit the resulting token from the attacker's own browser. Their browser
  // holds a flow cookie for a DIFFERENT pinId, so the mismatch stops it.
  const cookie = await flowCookie(1111);
  const res = await inScope(() =>
    plexSignIn.POST(
      post("/api/auth/sign-in/plex", JSON.stringify({ plexToken: "phished-token", pinId: 4242 }), {
        cookie: `${PLEX_FLOW_COOKIE}=${cookie}`,
      }),
    ),
  );
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /mismatch/i);
  assert.equal(sessionWrites(), 0);
});

test("plex sign-in refuses a clientId that does not match the cookie", async () => {
  const cookie = await flowCookie(4242, VALID_CLIENT_ID);
  const res = await inScope(() =>
    plexSignIn.POST(
      post("/api/auth/sign-in/plex", JSON.stringify({
        plexToken: "t", pinId: 4242, plexClientId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      }), { cookie: `${PLEX_FLOW_COOKIE}=${cookie}` }),
    ),
  );
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /mismatch/i);
});

test("plex sign-in uses the COOKIE's clientId, never a body-supplied one", async () => {
  // The body value is only ever compared; the value actually handed to
  // authorizeWithPlex comes from the signed cookie.
  const cookie = await flowCookie(4242, VALID_CLIENT_ID);
  const res = await inScope(() =>
    plexSignIn.POST(
      post("/api/auth/sign-in/plex", JSON.stringify({ plexToken: "t", pinId: 4242 }), {
        cookie: `${PLEX_FLOW_COOKIE}=${cookie}`,
      }),
    ),
  );
  // plex.tv user lookup is scripted to fail ⇒ 401, but the flow binding passed.
  assert.equal(res.status, 401);
});

test("a native client may submit the flow state in the BODY instead of a cookie", async () => {
  // Native clients can't carry the HttpOnly cookie set at /start.
  const flow = await flowCookie(4242);
  const res = await inScope(() =>
    plexSignIn.POST(post("/api/auth/sign-in/plex", JSON.stringify({ plexToken: "t", pinId: 4242, flowState: flow }))),
  );
  assert.equal(res.status, 401, "the binding passed; only the plex.tv lookup failed");
});

test("a body flowState is subject to the SAME pinId binding", async () => {
  const flow = await flowCookie(1111);
  const res = await inScope(() =>
    plexSignIn.POST(post("/api/auth/sign-in/plex", JSON.stringify({ plexToken: "t", pinId: 4242, flowState: flow }))),
  );
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /mismatch/i);
});

test("a failed plex sign-in CLEARS the flow cookie", async () => {
  const cookie = await flowCookie(4242);
  const res = await inScope(() =>
    plexSignIn.POST(
      post("/api/auth/sign-in/plex", JSON.stringify({ plexToken: "bad", pinId: 4242 }), {
        cookie: `${PLEX_FLOW_COOKIE}=${cookie}`,
      }),
    ),
  );
  assert.equal(res.status, 401);
  const cleared = setCookies(res).find((c) => c.startsWith(`${PLEX_FLOW_COOKIE}=`));
  assert.ok(cleared, "the flow cookie should be cleared on failure");
  assert.match(cleared, /Max-Age=0|Expires=/i);
});

test("plex sign-in caps its body (guardrail 30)", async () => {
  const huge = JSON.stringify({ plexToken: "t".repeat(32 * 1024), pinId: 1 });
  const res = await inScope(() => plexSignIn.POST(post("/api/auth/sign-in/plex", huge)));
  assert.ok(res.status === 400 || res.status === 413);
});

// ── /api/auth/plex/start ─────────────────────────────────────────────────────

test("plex start requires a well-formed clientId", async () => {
  for (const clientId of [undefined, "", "short", "not a uuid!", "../etc/passwd", "x".repeat(80)]) {
    const res = await inScope(() => plexStart.POST(post("/api/auth/plex/start", JSON.stringify({ clientId }))));
    assert.equal(res.status, 400, `clientId ${JSON.stringify(clientId)} should be rejected`);
  }
  assert.deepEqual(fetchCalls, [], "a bad clientId must not reach plex.tv");
});

test("plex start mints a flow cookie binding the pin to this browser", async () => {
  const res = await inScope(() => plexStart.POST(post("/api/auth/plex/start", JSON.stringify({ clientId: VALID_CLIENT_ID }))));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.pinId, 4242);
  assert.equal(body.code, "ABCD");
  const cookie = setCookies(res).find((c) => c.startsWith(`${PLEX_FLOW_COOKIE}=`));
  assert.ok(cookie, "no flow cookie was set");
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
});

test("plex start does NOT hand the flow state to a web caller's body", async () => {
  // Only the HttpOnly cookie for a browser; putting it in the body would make it
  // readable by page JS and defeat the binding.
  const res = await inScope(() => plexStart.POST(post("/api/auth/plex/start", JSON.stringify({ clientId: VALID_CLIENT_ID }))));
  assert.ok(!("flowState" in (await res.json())));
});

test("plex start DOES hand the flow state to a native caller's body", async () => {
  const res = await inScope(() =>
    plexStart.POST(post("/api/auth/plex/start", JSON.stringify({ clientId: VALID_CLIENT_ID }), { [NATIVE_CLIENT_HEADER]: "ios; build=42" })),
  );
  const body = await res.json();
  assert.equal(typeof body.flowState, "string");
});

test("plex start only ever talks to plex.tv", async () => {
  await inScope(() => plexStart.POST(post("/api/auth/plex/start", JSON.stringify({ clientId: VALID_CLIENT_ID }))));
  assert.ok(fetchCalls.length > 0);
  for (const c of fetchCalls) assert.equal(c.url.hostname, "plex.tv");
});

test("plex start forwards the caller's clientId to plex.tv", async () => {
  await inScope(() => plexStart.POST(post("/api/auth/plex/start", JSON.stringify({ clientId: VALID_CLIENT_ID }))));
  assert.equal(fetchCalls[0].headers.get("X-Plex-Client-Identifier"), VALID_CLIENT_ID);
});

test("plex start bounds the caller-supplied device strings", async () => {
  await inScope(() =>
    plexStart.POST(post("/api/auth/plex/start", JSON.stringify({
      clientId: VALID_CLIENT_ID, platform: "p".repeat(200), device: "d".repeat(200), model: "m".repeat(200),
    }))),
  );
  for (const h of ["X-Plex-Platform", "X-Plex-Device", "X-Plex-Model"]) {
    assert.ok((fetchCalls[0].headers.get(h) ?? "").length <= 32, `${h} was not bounded`);
  }
});

test("plex start maps an upstream failure to 502 and sets no cookie", async () => {
  plexPinStatus = 500;
  const res = await inScope(() => plexStart.POST(post("/api/auth/plex/start", JSON.stringify({ clientId: VALID_CLIENT_ID }))));
  assert.equal(res.status, 502);
  assert.ok(!setCookies(res).some((c) => c.startsWith(`${PLEX_FLOW_COOKIE}=`)));
});

test("plex start maps a malformed upstream response to 502", async () => {
  plexPinCreate = { id: undefined, code: "ABCD" };
  const res = await inScope(() => plexStart.POST(post("/api/auth/plex/start", JSON.stringify({ clientId: VALID_CLIENT_ID }))));
  assert.equal(res.status, 502);
});

test("plex start is IP rate-limited", async () => {
  const ip = "203.0.113.77";
  for (let i = 0; i < 20; i++) {
    const res = await inScope(() =>
      plexStart.POST(post("/api/auth/plex/start", JSON.stringify({ clientId: VALID_CLIENT_ID }), { "x-forwarded-for": ip })),
    );
    assert.notEqual(res.status, 429, `request ${i + 1} should pass`);
  }
  const limited = await inScope(() =>
    plexStart.POST(post("/api/auth/plex/start", JSON.stringify({ clientId: VALID_CLIENT_ID }), { "x-forwarded-for": ip })),
  );
  assert.equal(limited.status, 429);
});

test("plex start rejects an oversized body before reaching plex.tv", async () => {
  const res = await inScope(() =>
    plexStart.POST(post("/api/auth/plex/start", JSON.stringify({ clientId: VALID_CLIENT_ID, pad: "z".repeat(8 * 1024) }))),
  );
  assert.ok(res.status === 400 || res.status === 413);
  assert.deepEqual(fetchCalls, []);
});

test("plex start rejects malformed JSON", async () => {
  const res = await inScope(() => plexStart.POST(post("/api/auth/plex/start", "{nope")));
  assert.equal(res.status, 400);
});

// ── /api/auth/plex/pin (admin-only) ──────────────────────────────────────────

test("plex pin is admin-only on both verbs", async () => {
  const anonPost = await inScope(() => plexPin.POST(post("/api/auth/plex/pin", undefined), undefined));
  const anonGet = await inScope(() => plexPin.GET(get("/api/auth/plex/pin?id=1"), undefined));
  assert.equal(anonPost.status, 401);
  assert.equal(anonGet.status, 401);
  assert.deepEqual(fetchCalls, []);
});

test("plex pin GET validates its id", async () => {
  const t = await mintAdminSession();
  for (const q of ["", "?id=", "?id=abc", "?id=0", "?id=-4"]) {
    const res = await inScope(() => plexPin.GET(get(`/api/auth/plex/pin${q}`, { cookie: `${COOKIE}=${t}` }), undefined));
    assert.equal(res.status, 400, `id ${q} should be rejected`);
  }
  assert.deepEqual(fetchCalls, []);
});

test("plex pin GET marks the token response no-store", async () => {
  // The poll returns a real Plex authToken once the user claims the PIN; it must
  // not land in any cache.
  const t = await mintAdminSession();
  plexPinToken = "a-real-plex-token";
  const res = await inScope(() => plexPin.GET(get("/api/auth/plex/pin?id=4242", { cookie: `${COOKIE}=${t}` }), undefined));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal((await res.json()).authToken, "a-real-plex-token");
});

test("plex pin GET returns a null token before the PIN is claimed", async () => {
  const t = await mintAdminSession();
  const res = await inScope(() => plexPin.GET(get("/api/auth/plex/pin?id=4242", { cookie: `${COOKIE}=${t}` }), undefined));
  assert.equal((await res.json()).authToken, null);
});

test("plex pin maps upstream failures to 502", async () => {
  const t = await mintAdminSession();
  plexPinStatus = 503;
  const p = await inScope(() => plexPin.POST(post("/api/auth/plex/pin", undefined, { cookie: `${COOKIE}=${t}` }), undefined));
  const g = await inScope(() => plexPin.GET(get("/api/auth/plex/pin?id=1", { cookie: `${COOKIE}=${t}` }), undefined));
  assert.equal(p.status, 502);
  assert.equal(g.status, 502);
});

// ── /api/auth/plex/client-id ─────────────────────────────────────────────────

test("client-id answers { clientId: null } when signed out — NOT a 401", async () => {
  // The login page polls this; a 401 would surface as a spurious error.
  const res = await inScope(() => plexClientId.GET());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { clientId: null });
});

test("client-id returns the stored id for a signed-in caller", async () => {
  const t = await mintAdminSession();
  const store = (globalThis as { __authCookie?: string });
  store.__authCookie = t;
  // requireAuth() reads cookies() from the request scope, so drive it through a
  // scope carrying the session cookie.
  const reqHeaders = new Headers({ cookie: `${COOKIE}=${t}` });
  const res = await workAsyncStorage.run(
    { route: "/client-id.test", forceStatic: false, dynamicShouldError: false, afterContext: { after: () => {} } },
    () =>
      workUnitAsyncStorage.run(
        {
          type: "request", phase: "render",
          headers: HeadersAdapter.seal(reqHeaders),
          cookies: RequestCookiesAdapter.seal(new RequestCookies(reqHeaders)),
          usedDynamic: false,
        },
        () => plexClientId.GET(),
      ),
  );
  assert.equal(res.status, 200);
  assert.equal((await res.json()).clientId, VALID_CLIENT_ID);
});

// ── 2: OIDC — configuration, throttling, and the open-redirect guard ─────────

test("oidc start is 503 when OIDC is not configured", async () => {
  const res = await inScope(() => oidcStart.GET(get("/api/auth/oidc/start")));
  assert.equal(res.status, 503);
});

test("oidc start is 503 when only PART of the OIDC config is present", async () => {
  process.env.OIDC_ISSUER = "https://idp.example.com";
  const res = await inScope(() => oidcStart.GET(get("/api/auth/oidc/start")));
  assert.equal(res.status, 503);
});

test("oidc start is IP rate-limited BEFORE the configuration check", async () => {
  const ip = "203.0.113.90";
  for (let i = 0; i < 20; i++) {
    const res = await inScope(() => oidcStart.GET(get("/api/auth/oidc/start", { "x-forwarded-for": ip })));
    assert.notEqual(res.status, 429, `request ${i + 1} should pass`);
  }
  assert.equal((await inScope(() => oidcStart.GET(get("/api/auth/oidc/start", { "x-forwarded-for": ip })))).status, 429);
});

test("oidc start is 503 when discovery fails, not a 500", async () => {
  process.env.OIDC_ISSUER = "https://idp.example.com";
  process.env.OIDC_CLIENT_ID = "cid";
  process.env.OIDC_CLIENT_SECRET = "secret";
  const res = await inScope(() => oidcStart.GET(get("/api/auth/oidc/start", { "x-forwarded-for": "203.0.113.91" })));
  assert.equal(res.status, 503);
  assert.ok(errors.some((e) => e.includes("[oidc/start]")), "the failure should be logged for the operator");
});

test("the OIDC state cookie path includes BASE_PATH so the callback can read it", () => {
  // A cookie scoped to "/api/auth/oidc" is never sent back to
  // `${BASE_PATH}/api/auth/oidc/callback`, and every OIDC sign-in fails.
  assert.equal(OIDC_STATE_COOKIE_PATH, `${process.env.BASE_PATH ?? ""}/api/auth/oidc`);
  assert.ok(OIDC_STATE_COOKIE_PATH.endsWith("/api/auth/oidc"));
});

// The open-redirect guard, probed at the layer this harness can reach: the
// state cookie is what carries returnTo from /start to the callback, so a value
// that survives signing is a value the callback would redirect to.
for (const [label, candidate] of [
  ["an absolute off-origin URL", "https://evil.example.com/steal"],
  ["a protocol-relative URL", "//evil.example.com/steal"],
  ["a backslash-prefixed URL", "\\\\evil.example.com"],
  ["a TAB-smuggled path", "/\tevil.example.com"],
  ["a LF-smuggled path", "/\nevil.example.com"],
  ["a CR-smuggled path", "/\revil.example.com"],
  ["a javascript: scheme", "javascript:alert(1)"],
  ["a data: scheme", "data:text/html,<script>alert(1)</script>"],
] as const) {
  test(`the OIDC returnTo validator rejects ${label}`, async () => {
    // safeInternalPath is the shared validator both /start and the callback use;
    // the old startsWith("/") && !startsWith("//") test let the TAB/LF/CR forms
    // through, and the callback redirect carries a fresh session cookie — so an
    // off-origin target there is a post-authentication phishing hand-off.
    const { safeInternalPath } = await import("../src/lib/safe-url.ts");
    const out = safeInternalPath(candidate);
    if (out === undefined) return; // rejected outright — the strongest outcome
    // Otherwise the ONLY requirement is that the surviving value can never
    // navigate off-origin. Checked by resolution, not by substring: the WHATWG
    // parser strips TAB/LF/CR before parsing, so "/<TAB>evil.example.com"
    // legitimately becomes the SAME-ORIGIN path "/evil.example.com" — the host
    // name appearing in a local path is harmless, and a substring assertion
    // would wrongly flag it.
    assert.ok(out.startsWith("/"), `${label} produced ${JSON.stringify(out)}`);
    assert.ok(!out.startsWith("//"), `${label} produced a protocol-relative path`);
    for (const ch of ["\t", "\n", "\r"]) {
      assert.ok(!out.includes(ch), `${label} left a control character in the path`);
    }
    assert.ok(!/^[a-z]+:/i.test(out), `${label} produced a scheme-bearing target`);
    const base = "https://summonarr.test";
    assert.equal(new URL(out, base).origin, base, `${label} resolved off-origin: ${out}`);
  });
}

test("a legitimate in-app returnTo survives validation", async () => {
  const { safeInternalPath } = await import("../src/lib/safe-url.ts");
  assert.equal(safeInternalPath("/requests"), "/requests");
  assert.equal(safeInternalPath("/movies?page=2"), "/movies?page=2");
});

// ── oidc callback: every failure path redirects to /login with a code ────────

async function callbackRes(headers: Record<string, string> = {}, query = "?code=abc&state=xyz"): Promise<Response> {
  return inScope(() => oidcCallback.GET(get(`/api/auth/oidc/callback${query}`, headers)));
}
function redirectError(res: Response): string | null {
  const loc = res.headers.get("location");
  return loc ? new URL(loc).searchParams.get("error") : null;
}

test("oidc callback with no state cookie redirects to login with oidc_no_state", async () => {
  process.env.OIDC_ISSUER = "https://idp.example.com";
  process.env.OIDC_CLIENT_ID = "cid";
  process.env.OIDC_CLIENT_SECRET = "secret";
  const res = await callbackRes({ "x-forwarded-for": "203.0.113.10" });
  assert.equal(res.status, 307);
  assert.equal(redirectError(res), "oidc_no_state");
});

test("oidc callback with a FORGED state cookie redirects with oidc_state_invalid", async () => {
  process.env.OIDC_ISSUER = "https://idp.example.com";
  process.env.OIDC_CLIENT_ID = "cid";
  process.env.OIDC_CLIENT_SECRET = "secret";
  const res = await callbackRes({
    "x-forwarded-for": "203.0.113.11",
    cookie: `${OIDC_STATE_COOKIE}=forged-value`,
  });
  assert.equal(redirectError(res), "oidc_state_invalid");
});

test("oidc callback with a VALID state but a failing exchange redirects with oidc_exchange_failed", async () => {
  process.env.OIDC_ISSUER = "https://idp.example.com";
  process.env.OIDC_CLIENT_ID = "cid";
  process.env.OIDC_CLIENT_SECRET = "secret";
  const state = await signOidcStateCookie({
    state: "s", nonce: "n", codeVerifier: "v",
    redirectUri: "http://localhost:3000/api/auth/oidc/callback", returnTo: "/requests",
  });
  const res = await callbackRes({ "x-forwarded-for": "203.0.113.12", cookie: `${OIDC_STATE_COOKIE}=${state}` });
  assert.equal(redirectError(res), "oidc_exchange_failed");
  assert.equal(sessionWrites(), 0, "a failed exchange must mint nothing");
});

test("oidc callback is unconfigured-gated", async () => {
  const res = await callbackRes({ "x-forwarded-for": "203.0.113.13" });
  assert.equal(redirectError(res), "oidc_not_configured");
});

test("oidc callback is IP rate-limited", async () => {
  const ip = "203.0.113.14";
  for (let i = 0; i < 20; i++) await callbackRes({ "x-forwarded-for": ip });
  assert.equal(redirectError(await callbackRes({ "x-forwarded-for": ip })), "rate_limited");
});

test("every oidc callback failure CLEARS the state cookie", async () => {
  const res = await callbackRes({ "x-forwarded-for": "203.0.113.15", cookie: `${OIDC_STATE_COOKIE}=forged` });
  const cleared = setCookies(res).find((c) => c.startsWith(`${OIDC_STATE_COOKIE}=`));
  assert.ok(cleared, "the state cookie should be cleared");
  assert.match(cleared, /Max-Age=0/);
});

test("oidc callback redirects to AUTH_URL, never a caller-supplied Host", async () => {
  // Deriving the base from the request Host would let an attacker aim the error
  // redirect (and, on the success path, the session-bearing redirect) off-origin.
  const res = await callbackRes({
    "x-forwarded-for": "203.0.113.16",
    host: "evil.example.com",
    "x-forwarded-host": "evil.example.com",
  });
  const loc = res.headers.get("location") ?? "";
  assert.ok(loc.startsWith("http://localhost:3000"), `redirect escaped AUTH_URL: ${loc}`);
});

test("oidc callback with no AUTH_URL fails closed with a 500", async () => {
  delete process.env.AUTH_URL;
  const res = await callbackRes({ "x-forwarded-for": "203.0.113.17" });
  assert.equal(res.status, 500);
  process.env.AUTH_URL = "http://localhost:3000";
});

test("no oidc callback failure path ever mints a session", async () => {
  const cases: Record<string, string>[] = [
    { "x-forwarded-for": "203.0.113.20" },
    { "x-forwarded-for": "203.0.113.21", cookie: `${OIDC_STATE_COOKIE}=forged` },
  ];
  for (const headers of cases) {
    ops = [];
    await callbackRes(headers);
    assert.equal(sessionWrites(), 0);
  }
});

test("a signed OIDC state round-trips its returnTo", async () => {
  // Confirms the cookie really is the carrier the callback re-validates.
  const signed = await signOidcStateCookie({
    state: "s", nonce: "n", codeVerifier: "v",
    redirectUri: "http://localhost:3000/api/auth/oidc/callback", returnTo: "/requests",
  });
  const back = await verifyOidcStateCookie(signed);
  assert.ok(back);
  assert.equal(back.returnTo, "/requests");
});
