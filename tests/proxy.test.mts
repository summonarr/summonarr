// Unit tests for proxy() (src/proxy.ts) — THE security chokepoint every
// non-prefetch request crosses before any route handler or page runs. This file
// pins the proxy's own gates, in their coded order, with exact statuses,
// bodies, redirect targets, and headers:
//
//   1. the TRUST_PROXY / local-only Host gate (403 + fail-closed on no Host);
//   2. the 426 force-upgrade gate (guardrail 24: ONLY a positively-identified
//      stale build, ONLY mutating /api/* — fail-soft everywhere else, never an
//      authz input, fires pre-auth/pre-CSRF with zero DB reads);
//   3. the CSRF Origin check on mutating protected /api/* (cross-origin 403
//      BEFORE session resolution; Referer fallback; missing-origin 403; the
//      guardrail-6b skip — `Authorization: Bearer` or X-Summonarr-Client
//      PRESENCE, not validity, is the CORS-sound skip signal, and auth is
//      still enforced after the skip);
//   4. session gating (public paths pass anonymously; protected pages 302 to
//      /login with callbackUrl + cleared cookies; protected APIs get a
//      machine-readable 401; verifyAndRefreshSession is DB-checked so a
//      revoked AuthSession row rejects a still-valid JWT — the guardrail-29
//      "never JWT-only" principle at the proxy layer);
//   5. bearer-FIRST resolution (guardrail 6b: an invalid bearer never falls
//      back to a valid cookie; when both are valid the bearer identity wins)
//      and the sliding-refresh Set-Cookie that rides cookie responses but is
//      NEVER appended for bearer clients;
//   6. the UA-fingerprint cookie binding (mismatch → cleared-cookie login
//      redirect) and its bearer/machine-session skips;
//   7. the /api/admin/* defense-in-depth backstop (403 only for principals
//      with NO admin-surface access; ISSUE_ADMIN and granular MANAGE_* bits
//      pass — the per-route wrapper stays the fine-grained authority) and the
//      /admin page-gate redirects;
//   8. header stamping: the coarse-integer X-Summonarr-Api (guardrail 25) and
//      the per-request CSP nonce (response + propagated request header).
//
// Division of labour — the pure helpers are owned elsewhere and NOT re-tested:
// tests/api-version.test.mts owns parseNativeClient/isClientBelowMinimum
// internals (this file pins only the proxy's USE of them); tests/
// mobile-auth.test.mts owns parseBearerToken; tests/local-only.test.mts owns
// the isLocalHost classifier; tests/session-refresh(-rotation).test.mts own
// verifyAndRefreshSession's internals; tests/ua-fingerprint.test.mts owns the
// UA classifier; tests/session-cookie.test.mts owns cookie serialization.
//
// Module-instance mechanics: trustProxy and the env-origin allowlist are
// captured at MODULE LOAD, so besides the main instance (TRUST_PROXY=true)
// this file imports two query-busted instances — "?local-only" (TRUST_PROXY
// unset → the Host gate is live) and "?self-origin" (no AUTH_URL /
// AUTH_TRUSTED_ORIGIN → the request's own origin is the CSRF fallback). The
// shared dependency graph stays cached, so the in-memory prisma stubs hold
// across all three instances.
//
// NOT covered (Next-applied config, not proxy logic): the matcher's
// prefetch-`missing` clause — the reason page/layout auth must be DB-checked
// per guardrail 29 — and BASE_PATH stripping of nextUrl.pathname (tests hand
// the proxy an already-stripped pathname; the BASE_PATH test pins only the
// redirect-URL prefixing the proxy itself performs).
//
// No DB or network: prisma delegates are shadowed in-memory (tests/
// _helpers.mts), fetch throws, and the JWTs are REAL jose tokens whose claims
// always mirror the stubbed DB row (the rotation path never fires here).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto
process.env.NEXTAUTH_SECRET = "proxy-test-secret-0123456789abcdef-0123456789";
process.env.AUTH_URL = "http://localhost:3000"; // insecure context → unprefixed cookie name
process.env.AUTH_TRUSTED_ORIGIN = "https://alt.example.com"; // extra CSRF-trusted origin
process.env.TRUST_PROXY = "true"; // main instance: Host gate off
delete process.env.BASE_PATH; // pinned per-test; must not leak in from the shell
delete process.env.OIDC_ISSUER; // keeps the CSP connect-src deterministic

// No network, ever.
globalThis.fetch = (() => {
  throw new Error("unexpected network call from proxy tests");
}) as unknown as typeof fetch;

const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// Dynamic imports so the env/global stubs above genuinely precede the
// module-graph load (static imports would hoist — the trakt.test pattern).
const { NextRequest } = await import("next/server");
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { signSessionJwt, verifySessionJwt } = await import("../src/lib/session-jwt.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");
const { Permission } = await import("../src/lib/permissions.ts");
const { API_VERSION, MIN_CLIENT } = await import("../src/lib/api-version.ts");

type Req = InstanceType<typeof NextRequest>;

// ── in-memory DB state (the api-auth.test fixture shape) ────────────────────
type DbUser = {
  role: string;
  permissions: bigint;
  mediaServer: string | null;
  sessionsRevokedAt: Date | null;
  passwordChangedAt: Date | null;
  deactivatedAt: Date | null;
  email: string | null;
  notificationEmail: string | null;
};

const usersById = new Map<string, DbUser>();
const sessionRows = new Set<string>(); // sessionIds with a live AuthSession row
let dbReads = 0;

shadowPrismaModel(prisma, "authSession", {
  findUnique: async (args: { where: { sessionId: string } }) => {
    dbReads++;
    return sessionRows.has(args.where.sessionId)
      ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId }
      : null;
  },
  // lastSeenAt fire-and-forget touch — no-op.
  update: async () => ({}),
});

shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id: string } }) => {
    dbReads++;
    const u = usersById.get(args.where.id);
    return u ? { ...u } : null;
  },
  update: async () => ({}),
});

// Rotation never fires in this file (claims always mirror the stubbed DB row),
// but a functional $transaction stub keeps an accidental trigger off a real
// client. Mirrors api-auth.test.mts.
const txStub = {
  authSession: {
    findUnique: async (args: { where: { sessionId: string } }) =>
      sessionRows.has(args.where.sessionId) ? { id: `row-${args.where.sessionId}` } : null,
    update: async (args: { where: { sessionId: string }; data: { sessionId: string } }) => {
      sessionRows.delete(args.where.sessionId);
      sessionRows.add(args.data.sessionId);
      return {};
    },
  },
  user: {
    findUnique: async (args: { where: { id: string } }) => {
      const u = usersById.get(args.where.id);
      return u ? { sessionsRevokedAt: u.sessionsRevokedAt } : null;
    },
    update: async (args: { where: { id: string }; data: { sessionsRevokedAt: Date } }) => {
      const u = usersById.get(args.where.id);
      if (u) u.sessionsRevokedAt = args.data.sessionsRevokedAt;
      return {};
    },
  },
};
shadowPrismaClientMethod(prisma, "$transaction", async (fn: (tx: typeof txStub) => Promise<unknown>) =>
  fn(txStub),
);

// ── the three proxy instances ───────────────────────────────────────────────
// Env is read at module load, so each instance is a query-busted fresh
// evaluation of proxy.ts under different env; the import graph below it stays
// cached (same prisma stubs, same session machinery).
const { proxy } = await import("../src/proxy.ts");

const bustedProxyHref = (tag: string): string =>
  new URL(`../src/proxy.ts?${tag}`, import.meta.url).href;

process.env.TRUST_PROXY = ""; // NOT "true" → the local-only Host gate is live
const { proxy: proxyLocalOnly } = (await import(
  bustedProxyHref("local-only")
)) as typeof import("../src/proxy.ts");
process.env.TRUST_PROXY = "true";

const savedAuthUrl = process.env.AUTH_URL;
const savedAltOrigin = process.env.AUTH_TRUSTED_ORIGIN;
delete process.env.AUTH_URL;
delete process.env.AUTH_TRUSTED_ORIGIN;
const { proxy: proxySelfOrigin } = (await import(
  bustedProxyHref("self-origin")
)) as typeof import("../src/proxy.ts");
process.env.AUTH_URL = savedAuthUrl;
process.env.AUTH_TRUSTED_ORIGIN = savedAltOrigin;

// ── fixtures ────────────────────────────────────────────────────────────────
const SELF = "http://localhost:3000";
const EVIL = "https://evil.example";
const COOKIE = getSessionCookieName(); // "summonarr-session" under the http AUTH_URL above
const STALE_BUILD = MIN_CLIENT.ios - 1; // positively below the iOS floor

const CHROME_WIN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const FIREFOX_MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:120.0) Gecko/20100101 Firefox/120.0";

let seq = 0;

// Mint a REAL signed session JWT with a backing user + AuthSession row. Claim
// role/permissions and the DB row always agree, so every verify takes the
// plain slow path (DB-checked, no rotation).
async function mintSession(opts: {
  role?: string;
  permissions?: string; // decimal mask, mirrored into the DB row
  uaFingerprint?: string;
  iatOffset?: number;
  expiresInSeconds?: number;
} = {}): Promise<{ userId: string; sessionId: string; token: string }> {
  seq++;
  const userId = `user-${seq}`;
  const sessionId = `sess-${seq}`;
  const permissions = opts.permissions ?? "0";
  usersById.set(userId, {
    role: opts.role ?? "USER",
    permissions: BigInt(permissions),
    mediaServer: null,
    sessionsRevokedAt: null,
    passwordChangedAt: null,
    deactivatedAt: null,
    email: "u@example.com",
    notificationEmail: null,
  });
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000) + (opts.iatOffset ?? 0);
  const token = await signSessionJwt(
    {
      id: userId,
      role: opts.role ?? "USER",
      permissions,
      provider: "credentials",
      sessionId,
      expiresAt: iat + 86_400,
      ...(opts.uaFingerprint ? { uaFingerprint: opts.uaFingerprint } : {}),
    },
    { expiresInSeconds: opts.expiresInSeconds ?? 7_200, iat },
  );
  return { userId, sessionId, token };
}

function req(
  path: string,
  opts: { method?: string; headers?: Record<string, string> } = {},
): Req {
  return new NextRequest(`${SELF}${path}`, {
    method: opts.method ?? "GET",
    headers: opts.headers ?? {},
  });
}

function asCookie(token: string): Record<string, string> {
  return { cookie: `${COOKIE}=${token}` };
}

function asBearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

// A pass-through is NextResponse.next(): 200 + the x-middleware-next marker.
// Distinguishes "the proxy let the request reach the app" from any JSON 200.
function assertPassedThrough(res: Response, msg?: string): void {
  const label = msg ?? "expected the proxy to pass the request through to the app";
  assert.equal(res.status, 200, label);
  assert.equal(res.headers.get("x-middleware-next"), "1", label);
}

async function bodyOf(res: Response): Promise<unknown> {
  return res.json();
}

function setCookies(res: Response): string[] {
  return res.headers.getSetCookie();
}

beforeEach(() => {
  dbReads = 0;
});

// ── the TRUST_PROXY / local-only Host gate ──────────────────────────────────

test("local-only mode fails closed: a missing or public Host header → 403 before any session/DB work", async () => {
  // NextRequest carries no implicit Host header, so the bare request IS the
  // no-Host case — isLocalHost(null) must deny, not crash or allow.
  const noHost = await proxyLocalOnly(req("/login"));
  assert.equal(noHost.status, 403);
  assert.match(
    (await bodyOf(noHost) as { error: string }).error,
    /TRUST_PROXY/,
    "the refusal must tell the operator which knob to set",
  );

  const publicHost = await proxyLocalOnly(
    req("/login", { headers: { host: "summonarr.example.com" } }),
  );
  assert.equal(publicHost.status, 403);
  assert.equal(dbReads, 0, "the Host gate must reject before any session resolution");
});

test("local-only mode serves loopback and RFC1918 Hosts — the pipeline continues past the gate", async () => {
  for (const host of ["localhost:3000", "192.168.1.50:3001"]) {
    const res = await proxyLocalOnly(req("/login", { headers: { host } }));
    assertPassedThrough(res, `Host ${host} must pass the local-only gate`);
  }
});

test("TRUST_PROXY=true disables the Host gate entirely (reverse-proxy deployments serve public Hosts)", async () => {
  const res = await proxy(req("/login", { headers: { host: "summonarr.example.com" } }));
  assertPassedThrough(res);
});

// ── the 426 force-upgrade gate (guardrail 24) ───────────────────────────────

test("a positively-stale native build is refused with 426 on mutating /api — even with a VALID bearer session, pre-auth, zero DB reads", async () => {
  // The gate is not an authz input in either direction: a perfectly
  // authenticated stale build is still refused (it fires before session
  // resolution), and — pinned in the tests below — no version value ever
  // relaxes auth or CSRF.
  const { token } = await mintSession();
  dbReads = 0;
  const res = await proxy(
    req("/api/requests", {
      method: "POST",
      headers: {
        ...asBearer(token),
        "x-summonarr-client": `ios; build=${STALE_BUILD}; api=${API_VERSION}`,
      },
    }),
  );
  assert.equal(res.status, 426);
  assert.match((await bodyOf(res) as { error: string }).error, /no longer supported/);
  assert.equal(dbReads, 0, "the 426 gate must fire before any session/DB work");
});

test("reads are NEVER 426-blocked: a stale build still GETs data, and the anonymous compat probe serves", async () => {
  // A blocked read would leave the stale app unable to fetch the data it needs
  // to render a graceful "update" screen (guardrail 24).
  const { token } = await mintSession();
  const read = await proxy(
    req("/api/requests", {
      headers: { ...asBearer(token), "x-summonarr-client": `ios; build=${STALE_BUILD}` },
    }),
  );
  assertPassedThrough(read, "an authenticated stale-build GET must pass");

  // The pre-sign-in probe surface (guardrail 25): public, no auth, no gate.
  const probe = await proxy(
    req("/api/config/compat", {
      headers: { "x-summonarr-client": `ios; build=${STALE_BUILD}` },
    }),
  );
  assertPassedThrough(probe, "GET /api/config/compat must serve a stale anonymous client");
});

test("fail-soft: legacy bare 'ios', an unparseable build, and ungated platforms are never 426ed — auth still gates them", async () => {
  // Guardrail 24: only a POSITIVELY-identified stale build is gated. Every
  // uncertain shape falls through to normal auth, which (with no session)
  // is a 401 — proving the version gate neither blocked nor authenticated.
  for (const header of ["ios", "ios; build=abc", `android; build=${STALE_BUILD}`]) {
    const res = await proxy(
      req("/api/requests", { method: "POST", headers: { "x-summonarr-client": header } }),
    );
    assert.equal(res.status, 401, `header "${header}" must fail soft into the auth gate`);
    assert.deepEqual(await bodyOf(res), { error: "Unauthorized" });
  }
});

test("the gate arms only strictly below the floor, and only for /api/* mutations", async () => {
  // build == MIN_CLIENT floor is accepted (the range is [floor, ∞), not a pin).
  const { token } = await mintSession();
  const atFloor = await proxy(
    req("/api/requests", {
      method: "POST",
      headers: { ...asBearer(token), "x-summonarr-client": `ios; build=${MIN_CLIENT.ios}` },
    }),
  );
  assertPassedThrough(atFloor, "a build exactly at the floor must not be gated");

  // A stale-build mutation OUTSIDE /api/* is not the gate's business.
  const pagePost = await proxy(
    req("/login", {
      method: "POST",
      headers: { "x-summonarr-client": `ios; build=${STALE_BUILD}` },
    }),
  );
  assertPassedThrough(pagePost, "non-API paths are never 426ed");
});

// ── the CSRF Origin check ───────────────────────────────────────────────────

test("a cross-site Origin on mutating /api → 403 for every mutating method, BEFORE auth: a valid session cookie is ignored and the DB never touched", async () => {
  const { token } = await mintSession();
  dbReads = 0;
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const res = await proxy(
      req("/api/requests", { method, headers: { origin: EVIL, ...asCookie(token) } }),
    );
    assert.equal(res.status, 403, `${method} with a cross-site Origin must be blocked`);
    assert.deepEqual(await bodyOf(res), { error: "Forbidden" });
  }
  assert.equal(dbReads, 0, "a CSRF rejection must never resolve the session");
});

test("same-origin mutations pass CSRF, and AUTH_TRUSTED_ORIGIN extends the allowlist", async () => {
  const { token } = await mintSession();
  const sameOrigin = await proxy(
    req("/api/requests", { method: "POST", headers: { origin: SELF, ...asCookie(token) } }),
  );
  assertPassedThrough(sameOrigin, "the AUTH_URL origin must be trusted");

  // The extra env origin passes CSRF; with no session the request then hits
  // the auth gate — 401 (not 403) proves the Origin check accepted it.
  const altOrigin = await proxy(
    req("/api/requests", { method: "POST", headers: { origin: "https://alt.example.com" } }),
  );
  assert.equal(altOrigin.status, 401);
  assert.deepEqual(await bodyOf(altOrigin), { error: "Unauthorized" });
});

test("a mutation with NO Origin and NO Referer → 403 'missing origin', even with a valid session", async () => {
  const { token } = await mintSession();
  const res = await proxy(
    req("/api/requests", { method: "POST", headers: asCookie(token) }),
  );
  assert.equal(res.status, 403);
  assert.deepEqual(await bodyOf(res), { error: "Forbidden — missing origin" });
});

test("Referer is the Origin fallback: trusted referer passes, cross-site referer 403s, malformed referer counts as missing", async () => {
  const { token } = await mintSession();
  const trusted = await proxy(
    req("/api/requests", {
      method: "POST",
      headers: { referer: `${SELF}/requests`, ...asCookie(token) },
    }),
  );
  assertPassedThrough(trusted, "a same-origin Referer must satisfy the check");

  const evil = await proxy(
    req("/api/requests", {
      method: "POST",
      headers: { referer: `${EVIL}/attack.html`, ...asCookie(token) },
    }),
  );
  assert.equal(evil.status, 403);
  assert.deepEqual(await bodyOf(evil), { error: "Forbidden" });

  const malformed = await proxy(
    req("/api/requests", {
      method: "POST",
      headers: { referer: "not a url", ...asCookie(token) },
    }),
  );
  assert.equal(malformed.status, 403);
  assert.deepEqual(await bodyOf(malformed), { error: "Forbidden — missing origin" });
});

test("GET is never CSRF-checked: a cross-site Origin on a read passes straight through", async () => {
  const { token } = await mintSession();
  const res = await proxy(
    req("/api/requests", { headers: { origin: EVIL, ...asCookie(token) } }),
  );
  assertPassedThrough(res);
});

test("bearer PRESENCE skips CSRF but never auth: a garbage bearer + cross-site Origin → 401, not 403; a valid bearer → 200", async () => {
  // Guardrail 6b: the skip signal is the CORS-soundness of the custom header
  // (a cross-origin page can't attach Authorization to a credentialed
  // request), NOT the token's validity — so a garbage bearer skips the Origin
  // check and then fails authentication.
  const garbage = await proxy(
    req("/api/requests", {
      method: "POST",
      headers: { origin: EVIL, authorization: "Bearer definitely-not-a-jwt" },
    }),
  );
  assert.equal(garbage.status, 401, "the CSRF skip must not become an auth bypass");
  assert.deepEqual(await bodyOf(garbage), { error: "Unauthorized" });

  const { token } = await mintSession();
  const valid = await proxy(
    req("/api/requests", { method: "POST", headers: { origin: EVIL, ...asBearer(token) } }),
  );
  assertPassedThrough(valid, "a valid bearer mutation needs no acceptable Origin");
});

test("X-Summonarr-Client presence skips CSRF for a cookie session, and the native no-Origin sign-in POST passes", async () => {
  // A native webview/hybrid request rides the cookie but tags itself with the
  // custom header — CORS-preflight-protected, so no forged-cookie CSRF risk.
  const { token } = await mintSession();
  const tagged = await proxy(
    req("/api/requests", {
      method: "POST",
      headers: { origin: EVIL, "x-summonarr-client": "ios; build=42; api=1", ...asCookie(token) },
    }),
  );
  assertPassedThrough(tagged, "the native tag must skip the Origin check; the cookie still authenticates");

  // The native sign-in flow: no Origin header at all, no session yet — the
  // native tag is what lets the POST reach the (public) sign-in route.
  const signIn = await proxy(
    req("/api/auth/sign-in", {
      method: "POST",
      headers: { "x-summonarr-client": "ios; build=42; api=1" },
    }),
  );
  assertPassedThrough(signIn, "the tagged anonymous sign-in POST must pass");
});

test("browser sign-in is Origin-checked even though the path is public (login-CSRF defense)", async () => {
  const res = await proxy(
    req("/api/auth/sign-in", { method: "POST", headers: { origin: EVIL } }),
  );
  assert.equal(res.status, 403);
  assert.deepEqual(await bodyOf(res), { error: "Forbidden" });
});

test("own-auth routes are CSRF-exempt: webhooks, sync, cron, oidc-callback, and interactions accept cross-origin POSTs", async () => {
  // These callers (Radarr/Sonarr, external cron, the IdP redirect, Discord)
  // are not browsers and authenticate inside their handlers (webhook secret,
  // CRON_SECRET, OIDC state, Ed25519) — the proxy must not demand an Origin.
  for (const path of [
    "/api/webhooks/radarr",
    "/api/sync",
    "/api/sync/plex",
    "/api/cron/warm-activity",
    "/api/auth/oidc/callback",
    "/api/interactions",
  ]) {
    const res = await proxy(req(path, { method: "POST", headers: { origin: EVIL } }));
    assertPassedThrough(res, `${path} must be exempt from the Origin check`);
  }
});

// ── public paths and unauthenticated gating ─────────────────────────────────

test("public paths serve anonymously, stamped with the coarse-integer X-Summonarr-Api (guardrail 25)", async () => {
  for (const path of ["/login", "/register", "/api/config/compat", "/api/health"]) {
    const res = await proxy(req(path));
    assertPassedThrough(res, `${path} must be public`);
    assert.equal(
      res.headers.get("x-summonarr-api"),
      String(API_VERSION),
      "clients learn the contract version passively from any pass-through",
    );
  }
  assert.equal(dbReads, 0, "anonymous public requests must not touch the DB");
});

test("an unauthenticated protected PAGE → 302 to /login with callbackUrl, session cookies cleared", async () => {
  const res = await proxy(req("/movies"));
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), `${SELF}/login?callbackUrl=%2Fmovies`);
  const cleared = setCookies(res);
  assert.ok(
    cleared.some((c) => c.startsWith(`${COOKIE}=;`) && c.includes("Max-Age=0")),
    "the (possibly garbage) session cookie must be cleared on the way to login",
  );
  assert.ok(
    cleared.some((c) => c.startsWith("__Host-summonarr-session=;")),
    "the secure-context cookie variant is cleared too (AUTH_URL flips between deploys)",
  );

  // The full request path rides along so login can bounce back.
  const deep = await proxy(req("/requests/123"));
  assert.equal(deep.headers.get("location"), `${SELF}/login?callbackUrl=%2Frequests%2F123`);
});

test("an unauthenticated protected API → machine-readable 401 JSON, never an HTML login redirect", async () => {
  const res = await proxy(req("/api/requests"));
  assert.equal(res.status, 401);
  assert.deepEqual(await bodyOf(res), { error: "Unauthorized" });
});

// ── session validation and the sliding refresh (guardrail 6b) ───────────────

test("a valid cookie session passes and the slid session JWT rides back on Set-Cookie", async () => {
  const { userId, token } = await mintSession();
  const res = await proxy(req("/movies", { headers: asCookie(token) }));
  assertPassedThrough(res);

  const setCookie = res.headers.get("set-cookie");
  assert.ok(setCookie, "the DB-checked verify re-signs; the fresh JWT must ride back");
  assert.ok(setCookie.startsWith(`${COOKIE}=`));
  assert.ok(setCookie.includes("HttpOnly"), "the refreshed cookie must stay HttpOnly");
  const refreshed = setCookie.slice(COOKIE.length + 1).split(";")[0];
  assert.notEqual(refreshed, token, "the threaded token must be the re-signed one");
  const claims = await verifySessionJwt(refreshed);
  assert.ok(claims, "the threaded token must be a genuine signed session JWT");
  assert.equal(claims.id, userId);
});

test("a valid bearer session passes with NO Set-Cookie — native clients ride their fixed-lifetime token", async () => {
  const { token } = await mintSession();
  const res = await proxy(req("/movies", { headers: asBearer(token) }));
  assertPassedThrough(res);
  assert.equal(
    res.headers.get("set-cookie"),
    null,
    "a bearer client can't read Set-Cookie — the slid token must be withheld (guardrail 6b)",
  );
});

test("the slide happens on public paths too: /login with a live cookie still refreshes", async () => {
  // Keeps the sliding window alive while a logged-in user navigates the
  // public surface — the coded rationale for resolving sessions pre-gating.
  const { token } = await mintSession();
  const res = await proxy(req("/login", { headers: asCookie(token) }));
  assertPassedThrough(res);
  const setCookie = res.headers.get("set-cookie");
  assert.ok(setCookie?.startsWith(`${COOKIE}=`));
});

test("an expired session token → 401 on APIs and a login redirect on pages, with zero DB reads", async () => {
  // iat two hours ago with a one-hour lifetime: exp is an hour in the past.
  const { token } = await mintSession({ iatOffset: -7_200, expiresInSeconds: 3_600 });
  dbReads = 0;
  const api = await proxy(req("/api/requests", { headers: asCookie(token) }));
  assert.equal(api.status, 401);
  const page = await proxy(req("/movies", { headers: asCookie(token) }));
  assert.equal(page.status, 302);
  assert.equal(dbReads, 0, "signature/exp rejection must fail closed without touching the DB");
});

test("a revoked session (AuthSession row deleted) is rejected even though the JWT still verifies — DB-checked, never JWT-only", async () => {
  const { sessionId, token } = await mintSession();
  sessionRows.delete(sessionId); // "log out this device" on any replica
  dbReads = 0;
  const res = await proxy(req("/api/requests", { headers: asCookie(token) }));
  assert.equal(res.status, 401);
  assert.ok(dbReads > 0, "the revocation must have been read from the DB");
});

test("bearer-first: an INVALID bearer + a VALID cookie → 401; the cookie is never consulted", async () => {
  // Guardrail 6b's load-bearing ordering: once an Authorization header parses
  // as Bearer, a forged cookie must not ride the request that the bearer made
  // CSRF-exempt.
  const { token } = await mintSession();
  const res = await proxy(
    req("/api/requests", {
      headers: { authorization: "Bearer not-a-real-jwt", ...asCookie(token) },
    }),
  );
  assert.equal(res.status, 401);
});

// ── the /api/admin/* defense-in-depth backstop ──────────────────────────────

test("a plain USER hitting /api/admin/* gets the JSON 403 backstop; ADMIN passes", async () => {
  const user = await mintSession({ role: "USER" });
  const denied = await proxy(req("/api/admin/users", { headers: asCookie(user.token) }));
  assert.equal(denied.status, 403);
  assert.deepEqual(await bodyOf(denied), { error: "Forbidden" });

  const admin = await mintSession({ role: "ADMIN" });
  const allowed = await proxy(req("/api/admin/users", { headers: asCookie(admin.token) }));
  assertPassedThrough(allowed);
});

test("ISSUE_ADMIN passes the backstop — the per-route wrapper stays the fine-grained ADMIN-vs-ISSUE_ADMIN authority", async () => {
  // The backstop denies only principals with NO admin-surface access at all;
  // it must never wrongly deny a privileged caller (guardrail 6a).
  const { token } = await mintSession({ role: "ISSUE_ADMIN" });
  const res = await proxy(req("/api/admin/users", { headers: asCookie(token) }));
  assertPassedThrough(res);
});

test("a USER granted a MANAGE_* bit passes the backstop (management bits honored, not just role labels)", async () => {
  const { token } = await mintSession({
    role: "USER",
    permissions: String(Permission.MANAGE_ISSUES),
  });
  const res = await proxy(req("/api/admin/fix-match/search", { headers: asCookie(token) }));
  assertPassedThrough(res, "a granular grant must reach its per-route guard, not die at the backstop");
});

test("when bearer and cookie are BOTH valid, the bearer identity drives the backstop decision", async () => {
  // bearer = plain USER, cookie = ADMIN. If the cookie could win, this would
  // pass — the 403 proves bearer-first resolution feeds the role checks.
  const bearerUser = await mintSession({ role: "USER" });
  const cookieAdmin = await mintSession({ role: "ADMIN" });
  const res = await proxy(
    req("/api/admin/users", {
      headers: { ...asBearer(bearerUser.token), ...asCookie(cookieAdmin.token) },
    }),
  );
  assert.equal(res.status, 403);
  assert.deepEqual(await bodyOf(res), { error: "Forbidden" });
});

// ── the /admin page gate ────────────────────────────────────────────────────

test("a USER on /admin pages is 307-redirected to the app root; the path match is case-insensitive", async () => {
  const { token } = await mintSession({ role: "USER" });
  const res = await proxy(req("/admin", { headers: asCookie(token) }));
  assert.equal(res.status, 307);
  assert.equal(res.headers.get("location"), `${SELF}/`);

  // /Admin must not slip past a case-sensitive prefix match.
  const mixedCase = await proxy(req("/Admin/users", { headers: asCookie(token) }));
  assert.equal(mixedCase.status, 307);
  assert.equal(mixedCase.headers.get("location"), `${SELF}/`);
});

test("the /admin page matrix honors granular bits: ISSUE_ADMIN reaches /admin/issues but not /admin/users; ADMIN reaches everything", async () => {
  const issueAdmin = await mintSession({ role: "ISSUE_ADMIN" });
  const issues = await proxy(req("/admin/issues", { headers: asCookie(issueAdmin.token) }));
  assertPassedThrough(issues, "the MANAGE_ISSUES preset must open /admin/issues");

  const users = await proxy(req("/admin/users", { headers: asCookie(issueAdmin.token) }));
  assert.equal(users.status, 307, "no MANAGE_USERS bit ⇒ /admin/users redirects");
  assert.equal(users.headers.get("location"), `${SELF}/`);

  const admin = await mintSession({ role: "ADMIN" });
  const full = await proxy(req("/admin/users", { headers: asCookie(admin.token) }));
  assertPassedThrough(full);
});

// ── the UA-fingerprint cookie binding ───────────────────────────────────────

test("a cookie session bound to a UA fingerprint is bounced to login (cookies cleared) from a different browser family; the matching family passes", async () => {
  const bound = await mintSession({ uaFingerprint: "chrome:windows:desktop" });

  const mismatch = await proxy(
    req("/movies", { headers: { ...asCookie(bound.token), "user-agent": FIREFOX_MAC_UA } }),
  );
  assert.equal(mismatch.status, 302);
  assert.ok(
    mismatch.headers.get("location")?.startsWith(`${SELF}/login`),
    "a fingerprint mismatch is treated as a stolen-cookie replay → re-authenticate",
  );
  assert.ok(
    setCookies(mismatch).some((c) => c.startsWith(`${COOKIE}=;`)),
    "the suspect cookie must be cleared, not left to retry forever",
  );

  const match = await proxy(
    req("/movies", { headers: { ...asCookie(bound.token), "user-agent": CHROME_WIN_UA } }),
  );
  assertPassedThrough(match, "the matching browser family must still pass");
});

test("the fingerprint binding skips bearer transport and machine: sessions (guardrail 6b)", async () => {
  // A bearer JWT lives in app-secure storage, not an ambiently-replayed
  // cookie, so the device-class binding doesn't apply — same fingerprinted
  // token, 'wrong' UA, bearer transport: passes.
  const bound = await mintSession({ uaFingerprint: "chrome:windows:desktop" });
  const bearer = await proxy(
    req("/movies", { headers: { ...asBearer(bound.token), "user-agent": FIREFOX_MAC_UA } }),
  );
  assertPassedThrough(bearer, "bearer sessions deliberately drop UA-binding");

  // machine: fingerprints are CRON_SECRET-bound, not browser-bound.
  const machine = await mintSession({ uaFingerprint: "machine:cron" });
  const viaCookie = await proxy(
    req("/movies", { headers: { ...asCookie(machine.token), "user-agent": FIREFOX_MAC_UA } }),
  );
  assertPassedThrough(viaCookie, "machine sessions are exempt from the UA binding");
});

// ── CSP nonce stamping ──────────────────────────────────────────────────────

test("the CSP nonce is stamped on the response AND propagated to the request the app sees, and is unique per request", async () => {
  const res = await proxy(req("/login"));
  assertPassedThrough(res);
  const csp = res.headers.get("content-security-policy");
  assert.ok(csp, "every pass-through must carry the CSP");
  assert.ok(csp.includes("default-src 'self'"));
  assert.ok(csp.includes("frame-ancestors 'none'"));
  assert.ok(csp.includes("object-src 'none'"));

  const nonceMatch = /'nonce-([A-Za-z0-9+/=]+)'/.exec(csp);
  assert.ok(nonceMatch, "script-src must carry a per-request nonce");
  const nonce = nonceMatch[1];
  assert.ok(
    csp.includes(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`),
    "the nonce must gate script-src alongside strict-dynamic",
  );
  // The nonce is base64(randomUUID()) — decode and check the UUID shape so a
  // regression to a static/predictable nonce can't slip through as "present".
  const decoded = Buffer.from(nonce, "base64").toString("utf8");
  assert.match(decoded, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

  // Server components read the nonce (and CSP) off the REQUEST headers, which
  // NextResponse.next() encodes as x-middleware-request-*.
  assert.equal(res.headers.get("x-middleware-request-x-nonce"), nonce);
  assert.equal(res.headers.get("x-middleware-request-content-security-policy"), csp);

  const res2 = await proxy(req("/login"));
  const nonce2 = /'nonce-([A-Za-z0-9+/=]+)'/.exec(
    res2.headers.get("content-security-policy") ?? "",
  )?.[1];
  assert.ok(nonce2);
  assert.notEqual(nonce2, nonce, "the nonce must be fresh per request, never static");
});

// ── BASE_PATH interplay ─────────────────────────────────────────────────────

test("BASE_PATH prefixes both the login redirect and the admin-denial redirect", async () => {
  process.env.BASE_PATH = "/summonarr";
  try {
    const unauth = await proxy(req("/movies"));
    assert.equal(unauth.status, 302);
    assert.equal(
      unauth.headers.get("location"),
      `${SELF}/summonarr/login?callbackUrl=%2Fmovies`,
    );

    const { token } = await mintSession({ role: "USER" });
    const denied = await proxy(req("/admin", { headers: asCookie(token) }));
    assert.equal(denied.status, 307);
    assert.equal(denied.headers.get("location"), `${SELF}/summonarr/`);
  } finally {
    delete process.env.BASE_PATH;
  }
});

// ── CSRF trusted-origin fallback when no env origins are configured ─────────

test("with no configured origins, the request's own origin is the only CSRF-trusted one; configured env origins stay authoritative", async () => {
  // The ?self-origin instance loaded with AUTH_URL/AUTH_TRUSTED_ORIGIN unset:
  // buildTrustedOrigins falls back to the request's own origin, so a
  // misconfigured deployment still rejects cross-site mutations. A LAN origin
  // outside the main instance's env allowlist keeps this DISTINGUISHING: the
  // fallback trusts it, the env-configured instance must not.
  const LAN = "http://192.168.1.9:3000";
  const lanPost = (): Req =>
    new NextRequest(`${LAN}/api/requests`, {
      method: "POST",
      headers: { origin: LAN },
    });

  const fallback = await proxySelfOrigin(lanPost());
  assert.equal(fallback.status, 401, "own-origin passes the fallback CSRF check, then hits the auth gate");
  assert.deepEqual(await bodyOf(fallback), { error: "Unauthorized" });

  const crossOrigin = await proxySelfOrigin(
    new NextRequest(`${LAN}/api/requests`, { method: "POST", headers: { origin: EVIL } }),
  );
  assert.equal(crossOrigin.status, 403);
  assert.deepEqual(await bodyOf(crossOrigin), { error: "Forbidden" });

  // With env origins CONFIGURED (the main instance), the self-origin fallback
  // never applies — the same own-origin LAN mutation is refused.
  const envAuthoritative = await proxy(lanPost());
  assert.equal(envAuthoritative.status, 403, "configured AUTH_URL origins are the whole allowlist");
  assert.deepEqual(await bodyOf(envAuthoritative), { error: "Forbidden" });
});
