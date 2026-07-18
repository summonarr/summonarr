// Route-level unit tests for the two PUBLIC (proxy-exempt, isPublicPath)
// authentication-adjacent routes:
//
//   GET /api/config/compat (src/app/api/config/compat/route.ts) — guardrail 25:
//   the pre-auth capability descriptor a native client probes BEFORE sending
//   its Keychain token anywhere. Pinned: exactly the three coarse fields
//   (apiVersion / minApiVersion / minClient), every leaf an integer — no
//   marketing version string, no URLs, no secrets — and ZERO DB/network work,
//   proven by a prisma fake that THROWS on any model access while the handler
//   runs (a scanner-facing route must never be a load amplifier).
//
//   GET /api/auth/me (src/app/api/auth/me/route.ts) — the session source for
//   the client SummonarrSessionProvider and the one authenticated surface the
//   proxy never gates. Pinned: bearer-FIRST resolution (guardrail 6b — a
//   parsed-but-invalid bearer NEVER falls back to a valid cookie; when both
//   are valid the bearer identity wins), the DB-checked revocation contract
//   (guardrail 29 — a validly-signed JWT whose AuthSession row is gone reads
//   401), the route's OWN UA-fingerprint re-check for cookie sessions (the
//   proxy skips public paths, so this route enforces the device binding
//   itself; bearer sessions skip it by design), the serialized public shape
//   (sessionId deliberately omitted), the no-store privacy headers on every
//   response, and the refreshed-JWT Set-Cookie threaded ONLY on the cookie
//   transport (native clients can't read Set-Cookie — guardrail 6b).
//
// Division of labour: tests/api-version.test.mts owns the constants/parser,
// tests/mobile-auth.test.mts owns parseBearerToken, tests/session-refresh*.mts
// own verifyAndRefreshSession internals, tests/ua-fingerprint.test.mts owns
// the matcher. This file pins the ROUTE wiring of those pieces.
//
// No DB and no network: globalThis.prisma is pre-seeded BEFORE the module
// graph loads with in-memory AuthSession/User stubs behind a lockable proxy
// (locked ⇒ any model access throws — the compat DB-free proof), fetch always
// throws, and the session JWTs are REAL jose tokens whose claims mirror the
// stubbed DB rows (no rotation path — session-refresh tests own that).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto
process.env.NEXTAUTH_SECRET = "public-routes-test-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000"; // insecure context → unprefixed cookie name
process.env.TRUST_PROXY = "true"; // silence rate-limit's module-load warning

// ── console capture ─────────────────────────────────────────────────────────
const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// ── no network, ever ────────────────────────────────────────────────────────
let fetchAttempts = 0;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  fetchAttempts++;
  throw new Error(`unexpected network call ${String(input)} from public-routes tests`);
}) as typeof fetch;

// ── in-memory session DB behind a lockable prisma fake ──────────────────────
type DbUser = {
  role: string; permissions: bigint; mediaServer: string | null;
  sessionsRevokedAt: Date | null; passwordChangedAt: Date | null; deactivatedAt: Date | null;
  email: string | null; notificationEmail: string | null;
};
const usersById = new Map<string, DbUser>();
const sessionRows = new Set<string>();

const stubs = {
  authSession: {
    findUnique: async (args: { where: { sessionId: string } }) =>
      sessionRows.has(args.where.sessionId)
        ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId }
        : null,
    update: async () => ({}), // lastSeenAt fire-and-forget touch
  },
  user: {
    findUnique: async (args: { where: { id: string } }) => {
      const u = usersById.get(args.where.id);
      return u ? { ...u } : null;
    },
    update: async () => ({}),
  },
  // Rotation never fires here (claims always mirror the DB row), but a
  // functional stub keeps an accidental trigger loud instead of hanging.
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(stubs),
};

// While locked, ANY prisma property access throws — the guardrail-25 proof that
// /api/config/compat does no DB work at all (not even a lazy read).
let dbLocked = false;
const dbTouches: string[] = [];
const fakePrisma = new Proxy(stubs, {
  get(target, prop, receiver) {
    if (typeof prop === "string" && prop !== "then") {
      dbTouches.push(prop);
      if (dbLocked) {
        throw new Error(
          `prisma.${prop} accessed while the DB was locked — /api/config/compat must be DB-free (guardrail 25)`,
        );
      }
    }
    return Reflect.get(target, prop, receiver);
  },
});
(globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;

// Dynamic imports so the env/global stubs above genuinely precede the module
// graph (static imports would hoist past them).
const { NextRequest } = await import("next/server");
const { API_VERSION, MIN_API_VERSION, MIN_CLIENT } = await import("../src/lib/api-version.ts");
const { signSessionJwt, verifySessionJwt } = await import("../src/lib/session-jwt.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");
const { GET: getCompat } = await import("../src/app/api/config/compat/route.ts");
const { GET: getMe } = await import("../src/app/api/auth/me/route.ts");

type Req = InstanceType<typeof NextRequest>;

// ── fixtures ────────────────────────────────────────────────────────────────
const COOKIE = getSessionCookieName(); // "summonarr-session" under the http AUTH_URL

let seq = 0;
async function mintSession(opts: { role?: string; uaFingerprint?: string } = {}): Promise<{
  userId: string;
  sessionId: string;
  token: string;
  expiresAt: number;
}> {
  seq++;
  const userId = `pub-user-${seq}`;
  const sessionId = `pub-sess-${seq}`;
  usersById.set(userId, {
    role: opts.role ?? "USER", permissions: 0n, mediaServer: null,
    sessionsRevokedAt: null, passwordChangedAt: null, deactivatedAt: null,
    email: "u@example.com", notificationEmail: null,
  });
  sessionRows.add(sessionId);
  const expiresAt = Math.floor(Date.now() / 1000) + 86_400;
  const token = await signSessionJwt(
    {
      id: userId, role: opts.role ?? "USER", permissions: "0", provider: "credentials",
      sessionId, expiresAt,
      ...(opts.uaFingerprint ? { uaFingerprint: opts.uaFingerprint } : {}),
    },
    { expiresInSeconds: 7_200 },
  );
  return { userId, sessionId, token, expiresAt };
}

function meReq(headers: Record<string, string> = {}): Req {
  return new NextRequest("http://localhost:3000/api/auth/me", { method: "GET", headers });
}
const asCookie = (token: string): Record<string, string> => ({ cookie: `${COOKIE}=${token}` });
const asBearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

// The serialized session /api/auth/me returns for a session minted above (the
// slow-path verify always writes the DB permissions mask back into the claims).
function expectedSession(userId: string, role: string, expiresAt: number): Record<string, unknown> {
  return {
    user: {
      id: userId,
      role,
      permissions: "0",
      email: null,
      name: null,
      provider: "credentials",
      mediaServer: null,
    },
    expiresAt,
  };
}

beforeEach(() => {
  warns.length = 0;
  errors.length = 0;
  fetchAttempts = 0;
  dbTouches.length = 0;
  dbLocked = false;
});

// ── GET /api/config/compat (guardrail 25) ───────────────────────────────────

test("compat: 200 with EXACTLY the three coarse fields, every leaf an integer — no strings, no URLs, no marketing version", async () => {
  const res = getCompat();
  assert.equal(res.status, 200);
  const body = await bodyOf(res);

  // Deep key-set pin: nothing beyond the negotiation triple may ever ship on
  // this pre-auth surface.
  assert.deepEqual(Object.keys(body).sort(), ["apiVersion", "minApiVersion", "minClient"]);
  assert.equal(body.apiVersion, API_VERSION);
  assert.equal(body.minApiVersion, MIN_API_VERSION);
  assert.deepEqual(body.minClient, { ...MIN_CLIENT });

  // Coarse-integers-only: walk every leaf. A string ANYWHERE (a version like
  // "0.15.0", an upgrade URL) is the CVE-targeting / phishing-vector leak the
  // guardrail forbids.
  const assertIntegerLeaves = (value: unknown, path: string): void => {
    if (value !== null && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) assertIntegerLeaves(v, `${path}.${k}`);
      return;
    }
    assert.equal(typeof value, "number", `${path} must be a number, got ${typeof value}`);
    assert.ok(Number.isInteger(value), `${path} must be a coarse integer`);
  };
  assertIntegerLeaves(body, "compat");
});

test("compat: answers unauthenticated with ZERO DB access (throwing prisma fake) and zero network calls", async () => {
  // GET takes no request at all — there is no auth material to consult, no
  // header read, nothing: the handler must be a pure constant projection.
  dbLocked = true; // any prisma model access now throws
  try {
    const first = getCompat();
    const second = getCompat();
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
  } finally {
    dbLocked = false;
  }
  assert.equal(dbTouches.length, 0, "compat must not touch prisma at all (guardrail 25: no load amplifier)");
  assert.equal(fetchAttempts, 0);
});

// ── GET /api/auth/me ────────────────────────────────────────────────────────

test("me: no auth material → 401 { session: null } with the no-store privacy headers", async () => {
  const res = await getMe(meReq());
  assert.equal(res.status, 401);
  assert.deepEqual(await bodyOf(res), { session: null });
  // The privacy headers ride EVERY response (session payloads must never be
  // servable from a shared cache) — pinned on the 401 shape here, and implied
  // on the 200s below by the same applyPrivacyHeaders funnel.
  assert.equal(res.headers.get("cache-control"), "no-store, private, must-revalidate");
  assert.equal(res.headers.get("pragma"), "no-cache");
  assert.equal(res.headers.get("vary"), "Cookie");
});

test("me: a valid bearer session → 200 with the serialized public session — and NO sessionId leak", async () => {
  const { userId, token, expiresAt } = await mintSession();
  const res = await getMe(meReq(asBearer(token)));
  assert.equal(res.status, 200);
  const body = await bodyOf(res);
  // Exact shape: deepEqual pins the full key set, so sessionId's deliberate
  // omission (no client consumer reads it; exposing it widens the JS-visible
  // surface) is enforced structurally.
  assert.deepEqual(body, { session: expectedSession(userId, "USER", expiresAt) });
  assert.equal(res.headers.get("cache-control"), "no-store, private, must-revalidate");
});

test("me: bearer-first never falls back — invalid bearer + valid cookie → 401; both valid → the bearer identity wins (guardrail 6b)", async () => {
  // The coded contract is `bearer ?? cookie`: once the Authorization header
  // parses as Bearer, the cookie is never consulted. A forged cookie must not
  // ride a request whose bearer made it CSRF-exempt upstream.
  const cookieSession = await mintSession();
  const invalidBearer = await getMe(
    meReq({ authorization: "Bearer not-a-real-jwt", ...asCookie(cookieSession.token) }),
  );
  assert.equal(invalidBearer.status, 401);
  assert.deepEqual(await bodyOf(invalidBearer), { session: null });

  const bearerSession = await mintSession();
  const bothValid = await getMe(
    meReq({ ...asBearer(bearerSession.token), ...asCookie(cookieSession.token) }),
  );
  assert.equal(bothValid.status, 200);
  const body = await bodyOf(bothValid);
  const user = (body.session as { user: { id: string } }).user;
  assert.equal(user.id, bearerSession.userId, "with two valid transports the bearer identity must win");
});

test("me: a revoked session (AuthSession row deleted) → 401 even though the JWT still verifies (guardrail 29: DB-checked, never JWT-only)", async () => {
  const { sessionId, token } = await mintSession();
  const live = await getMe(meReq(asCookie(token)));
  assert.equal(live.status, 200);

  sessionRows.delete(sessionId); // "log out this device"
  const revoked = await getMe(meReq(asCookie(token)));
  assert.equal(revoked.status, 401, "a revoked AuthSession row must 401 despite a valid signature");
  assert.deepEqual(await bodyOf(revoked), { session: null });
});

const CHROME_WIN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const FIREFOX_MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:120.0) Gecko/20100101 Firefox/120.0";

test("me: cookie sessions re-check the UA fingerprint (this route is public — the proxy never does it here); bearer skips it", async () => {
  const bound = await mintSession({ uaFingerprint: "chrome:windows:desktop" });

  const mismatch = await getMe(meReq({ ...asCookie(bound.token), "user-agent": FIREFOX_MAC_UA }));
  assert.equal(mismatch.status, 401, "a replayed cookie from another browser family must 401");
  assert.deepEqual(await bodyOf(mismatch), { session: null });

  const match = await getMe(meReq({ ...asCookie(bound.token), "user-agent": CHROME_WIN_UA }));
  assert.equal(match.status, 200, "the matching browser family must still resolve the session");

  // Bearer sessions deliberately drop UA-binding (guardrail 6b: the JWT lives
  // in app-secure storage, not an ambiently-replayed cookie).
  const bearer = await getMe(meReq({ ...asBearer(bound.token), "user-agent": FIREFOX_MAC_UA }));
  assert.equal(bearer.status, 200, "the same fingerprinted token over bearer must skip the UA check");
});

test("me: the refreshed session JWT is threaded back as Set-Cookie ONLY on the cookie transport (guardrail 6b)", async () => {
  const { userId, token } = await mintSession();

  // Cookie transport: the slow-path verify always re-signs (dbCheckedAt
  // advances), and the route must hand the fresh JWT back as an HttpOnly
  // session cookie.
  const viaCookie = await getMe(meReq(asCookie(token)));
  assert.equal(viaCookie.status, 200);
  const setCookie = viaCookie.headers.get("set-cookie");
  assert.ok(setCookie, "the cookie transport must receive the refreshed session cookie");
  assert.ok(setCookie.startsWith(`${COOKIE}=`), "the refresh must target the session cookie name");
  assert.ok(setCookie.includes("HttpOnly"), "the refreshed cookie must stay HttpOnly");
  const refreshedToken = setCookie.slice(COOKIE.length + 1).split(";")[0];
  assert.notEqual(refreshedToken, token, "the threaded token must be the re-signed one");
  const refreshedClaims = await verifySessionJwt(refreshedToken);
  assert.ok(refreshedClaims, "the threaded token must be a genuine signed session JWT");
  assert.equal(refreshedClaims.id, userId);

  // The SAME token over bearer re-signs too, but the route must withhold the
  // Set-Cookie — a native client can't read it, and appending it would leak a
  // fresh token into any intermediary that logs headers.
  const viaBearer = await getMe(meReq(asBearer(token)));
  assert.equal(viaBearer.status, 200);
  assert.equal(viaBearer.headers.get("set-cookie"), null);
});
