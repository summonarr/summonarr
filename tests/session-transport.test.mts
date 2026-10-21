// Guardrail 6h, part 1: a session token is bound to the transport it was
// minted for — the HttpOnly cookie (browser) or `Authorization: Bearer`
// (native, the never-expiring session) — and every reader refuses it on the
// other one. Before this a stolen browser cookie replayed as a bearer skipped
// the cookie-only defences (the CSRF Origin check, the cron same-origin gate,
// privilege-change rotation), and a native token could be planted in a browser.
//
// Pinned here (the per-reader wiring is pinned in each reader's own file:
// proxy, api-auth, public-routes (/me), auth-routes (sign-out, machine-session),
// cron-auth, require-app-session, auth-signin-routes (the mint)):
//   - boundTransport / isTransportAllowed: the claim wins; a pre-claim token's
//     transport is read off what its shape proves (dbCheckedAt ⇒ cookie, a
//     deadline past the 90-day browser ceiling ⇒ bearer, otherwise either);
//   - the 90-day ceiling the inference relies on is the same number the
//     session-duration settings enforce;
//   - verifyAndRefreshSession refuses a mismatch on the FAST path with zero DB
//     reads and on the slow path; a pre-claim token is re-signed bound to the
//     transport it arrived on; the coalescing key separates the transports;
//   - a token signed with anything but the current session key (the previous
//     secret, the legacy raw secret) never takes the fast path, so it is
//     re-signed with the current key on its next request; a legacy native
//     token keeps working as a bearer forever and never as a cookie;
//   - the server-component readers (auth(), authActive(), the session-server
//     reads) refuse a bearer-bound token in the cookie, and none of them looks
//     at the User-Agent.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { SignJWT } from "jose";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto
const SECRET = "session-transport-test-secret-0123456789abcdef";
const OLD = "session-transport-OLD-secret-0123456789abcdef";
process.env.NEXTAUTH_SECRET = SECRET;
delete process.env.NEXTAUTH_SECRET_PREVIOUS;
process.env.AUTH_URL = "http://localhost:3000"; // insecure context → unprefixed cookie name

globalThis.fetch = (() => {
  throw new Error("unexpected network call from session-transport tests");
}) as unknown as typeof fetch;
console.warn = () => {};
console.error = () => {};

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const {
  signSessionJwt,
  boundTransport,
  isTransportAllowed,
  SESSION_JWT_TYP,
} = await import("../src/lib/session-jwt.ts");
const { verifyAndRefreshSession } = await import("../src/lib/session-refresh.ts");
const { keyIdFor } = await import("../src/lib/signing-keys.ts");
const { MAX_CONFIGURABLE_SESSION_SECONDS, NEVER_EXPIRES_AT_SEC } = await import("../src/lib/session-lifetime.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");
const {
  readSummonarrSession,
  readActiveSummonarrSession,
  readActiveSummonarrSessionFromRequest,
} = await import("../src/lib/session-server.ts");
const { auth, authActive } = await import("../src/lib/auth.ts");
const { NextRequest } = await import("next/server");

type Claims = import("../src/lib/session-jwt.ts").SessionClaims;

// ── in-memory DB ─────────────────────────────────────────────────────────────
const users = new Map<string, { role: string; permissions: bigint }>();
const rows = new Set<string>();
let dbReads = 0;
let holdRead: Promise<void> | null = null;

shadowPrismaModel(prisma, "authSession", {
  findUnique: async (args: { where: { sessionId: string } }) => {
    dbReads++;
    if (holdRead) await holdRead;
    return rows.has(args.where.sessionId) ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId } : null;
  },
  update: async () => ({}),
});
shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id: string } }) => {
    dbReads++;
    const u = users.get(args.where.id);
    return u
      ? {
          role: u.role, permissions: u.permissions, mediaServer: null, sessionsRevokedAt: null,
          passwordChangedAt: null, deactivatedAt: null, email: "u@example.com", notificationEmail: null, plexUserId: null,
        }
      : null;
  },
  update: async () => ({}),
});
shadowPrismaClientMethod(prisma, "$transaction", async () => {
  throw new Error("no rotation expected in these tests");
});

const COOKIE = getSessionCookieName();
const now = () => Math.floor(Date.now() / 1000);
let seq = 0;

type MintOpts = {
  transport?: "cookie" | "bearer";
  dbCheckedAt?: number;
  expiresAt?: number;
  ttl?: number;
  key?: "current" | "previous" | "legacy-raw" | "legacy-raw-previous";
};

async function mint(opts: MintOpts = {}): Promise<{ token: string; sessionId: string; userId: string }> {
  seq++;
  const userId = `u-${seq}`;
  const sessionId = `s-${seq}`;
  users.set(userId, { role: "USER", permissions: 0n });
  rows.add(sessionId);
  const iat = now();
  const ttl = opts.ttl ?? 7_200;
  const claims = {
    id: userId, role: "USER", permissions: "0", provider: "credentials", sessionId,
    expiresAt: opts.expiresAt ?? iat + 86_400,
    ...(opts.transport ? { transport: opts.transport } : {}),
    ...(typeof opts.dbCheckedAt === "number" ? { dbCheckedAt: opts.dbCheckedAt } : {}),
  };
  const key = opts.key ?? "current";
  let token: string;
  if (key === "legacy-raw" || key === "legacy-raw-previous") {
    // The pre-subkey format: HMAC'd with the raw secret, typ JWT, no kid/aud.
    token = await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt(iat)
      .setExpirationTime(iat + ttl)
      .sign(new TextEncoder().encode(key === "legacy-raw" ? SECRET : OLD));
  } else if (key === "previous") {
    process.env.NEXTAUTH_SECRET = OLD;
    try {
      token = await signSessionJwt(claims, { expiresInSeconds: ttl, iat });
    } finally {
      process.env.NEXTAUTH_SECRET = SECRET;
    }
  } else {
    token = await signSessionJwt(claims, { expiresInSeconds: ttl, iat });
  }
  return { token, sessionId, userId };
}

function decode(token: string, part: 0 | 1): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[part], "base64url").toString("utf8"));
}

beforeEach(() => {
  dbReads = 0;
  holdRead = null;
});
afterEach(() => {
  process.env.NEXTAUTH_SECRET = SECRET;
  delete process.env.NEXTAUTH_SECRET_PREVIOUS;
});

// ── the pure rules ───────────────────────────────────────────────────────────

const base: Claims = { id: "u", role: "USER", iat: 1_800_000_000 };

test("boundTransport: the claim wins; a pre-claim token's shape decides; otherwise either", () => {
  const iat = base.iat as number;
  assert.equal(boundTransport({ ...base, transport: "cookie" }), "cookie");
  assert.equal(boundTransport({ ...base, transport: "bearer", dbCheckedAt: iat }), "bearer", "the claim beats the inference");
  // dbCheckedAt: only a re-signed token has it, and only Set-Cookie delivers one.
  assert.equal(boundTransport({ ...base, dbCheckedAt: iat }), "cookie");
  assert.equal(boundTransport({ ...base, dbCheckedAt: iat, expiresAt: NEVER_EXPIRES_AT_SEC }), "cookie");
  // A deadline past the browser ceiling: the native sentinel, or the old 1-year native TTL.
  assert.equal(boundTransport({ ...base, expiresAt: NEVER_EXPIRES_AT_SEC }), "bearer");
  assert.equal(boundTransport({ ...base, expiresAt: iat + 365 * 86_400 }), "bearer");
  assert.equal(boundTransport({ ...base, expiresAt: iat + MAX_CONFIGURABLE_SESSION_SECONDS + 1 }), "bearer");
  // At or under the ceiling, never re-signed: either transport.
  assert.equal(boundTransport({ ...base, expiresAt: iat + MAX_CONFIGURABLE_SESSION_SECONDS }), null);
  assert.equal(boundTransport({ ...base, expiresAt: iat + 3600 }), null);
  assert.equal(boundTransport({ ...base }), null);
});

test("isTransportAllowed: refuses the other transport and an unknown claim value; an unbound token passes both", () => {
  assert.equal(isTransportAllowed({ ...base, transport: "cookie" }, "cookie"), true);
  assert.equal(isTransportAllowed({ ...base, transport: "cookie" }, "bearer"), false);
  assert.equal(isTransportAllowed({ ...base, transport: "bearer" }, "cookie"), false);
  assert.equal(isTransportAllowed({ ...base, transport: "bearer" }, "bearer"), true);
  const bogus = { ...base, transport: "both" } as unknown as Claims;
  assert.equal(isTransportAllowed(bogus, "cookie"), false);
  assert.equal(isTransportAllowed(bogus, "bearer"), false);
  assert.equal(isTransportAllowed({ ...base, expiresAt: (base.iat as number) + 3600 }, "cookie"), true);
  assert.equal(isTransportAllowed({ ...base, expiresAt: (base.iat as number) + 3600 }, "bearer"), true);
});

test("the inference's 90-day ceiling IS the configurable-duration ceiling (settings route, form, getSessionDurations)", () => {
  assert.equal(MAX_CONFIGURABLE_SESSION_SECONDS, 7_776_000);
  const settingsRoute = readFileSync(new URL("../src/app/api/settings/route.ts", import.meta.url), "utf8");
  assert.match(settingsRoute, /const MAX_SESSION_SECONDS = 7_776_000;/);
  const form = readFileSync(new URL("../src/components/settings/forms/session-form.tsx", import.meta.url), "utf8");
  assert.match(form, /const MAX_SESSION_SECONDS = 7_776_000;/);
  const authSrc = readFileSync(new URL("../src/lib/auth.ts", import.meta.url), "utf8");
  assert.match(authSrc, /const MAX_ALLOWED_SESSION_SECONDS = MAX_CONFIGURABLE_SESSION_SECONDS;/);
});

// ── verifyAndRefreshSession ──────────────────────────────────────────────────

test("a mismatch is refused BEFORE the DB, even on a fast-path-eligible token", async () => {
  const browser = await mint({ transport: "cookie", dbCheckedAt: now() });
  assert.ok(await verifyAndRefreshSession(browser.token, { transport: "cookie" }), "control: fast path");
  assert.equal(dbReads, 0);
  assert.equal(await verifyAndRefreshSession(browser.token, { transport: "bearer" }), null);
  assert.equal(dbReads, 0, "refused on the claim alone");

  const native = await mint({ transport: "bearer" });
  assert.equal(await verifyAndRefreshSession(native.token, { transport: "cookie" }), null);
  assert.equal(dbReads, 0);
  assert.ok(await verifyAndRefreshSession(native.token, { transport: "bearer" }));
});

test("a pre-claim browser cookie (it has dbCheckedAt) replayed as a bearer is refused — the attack this closes", async () => {
  const stolen = await mint({ dbCheckedAt: now() - 3600 });
  assert.ok(await verifyAndRefreshSession(stolen.token, { transport: "cookie" }));
  assert.equal(await verifyAndRefreshSession(stolen.token, { transport: "bearer" }), null);
});

test("a pre-claim token that is still unbound is re-signed BOUND to the transport it arrived on", async () => {
  const fresh = await mint();
  const asBearer = await verifyAndRefreshSession(fresh.token, { transport: "bearer", allowRotation: false });
  assert.equal(decode(asBearer!.refreshed!.token, 1).transport, "bearer");
  const asCookie = await verifyAndRefreshSession(fresh.token, { transport: "cookie" });
  const replacement = asCookie!.refreshed!.token;
  assert.equal(decode(replacement, 1).transport, "cookie");
  // …and the replacement is now refused on the other transport.
  assert.equal(await verifyAndRefreshSession(replacement, { transport: "bearer" }), null);
  assert.ok(await verifyAndRefreshSession(replacement, { transport: "cookie" }));
});

test("a bound token's re-sign keeps its own binding", async () => {
  const native = await mint({ transport: "bearer", expiresAt: NEVER_EXPIRES_AT_SEC, ttl: NEVER_EXPIRES_AT_SEC - now() });
  const r = await verifyAndRefreshSession(native.token, { transport: "bearer", allowRotation: false });
  assert.equal(decode(r!.refreshed!.token, 1).transport, "bearer");
});

test("concurrent verifies of ONE unbound token on the two transports don't share a result (the coalescing key carries the transport)", async () => {
  const fresh = await mint();
  let release!: () => void;
  holdRead = new Promise<void>((r) => { release = r; });
  const a = verifyAndRefreshSession(fresh.token, { transport: "bearer", allowRotation: false });
  const b = verifyAndRefreshSession(fresh.token, { transport: "cookie", allowRotation: false });
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 2));
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(decode(ra!.refreshed!.token, 1).transport, "bearer");
  assert.equal(decode(rb!.refreshed!.token, 1).transport, "cookie");
});

// ── key status: previous / legacy keys never take the fast path ─────────────

test("a current-key token inside its dbCheckedAt window takes the fast path (control)", async () => {
  const t = await mint({ transport: "cookie", dbCheckedAt: now() });
  const r = await verifyAndRefreshSession(t.token, { transport: "cookie" });
  assert.ok(r);
  assert.equal(dbReads, 0);
  assert.equal(r.refreshed, undefined);
});

test("a LEGACY raw-key cookie inside its dbCheckedAt window goes to the slow path and comes back signed with the current key", async () => {
  const t = await mint({ dbCheckedAt: now(), key: "legacy-raw" });
  const r = await verifyAndRefreshSession(t.token, { transport: "cookie" });
  assert.ok(r?.refreshed, "a browser migrates on its very next request");
  assert.ok(dbReads > 0, "never the fast path");
  const h = decode(r.refreshed.token, 0);
  assert.equal(h.kid, keyIdFor(SECRET));
  assert.equal(h.typ, SESSION_JWT_TYP);
});

test("a PREVIOUS-key token goes to the slow path too, and its replacement outlives the rotation", async () => {
  process.env.NEXTAUTH_SECRET_PREVIOUS = OLD;
  const t = await mint({ transport: "cookie", dbCheckedAt: now(), key: "previous" });
  const r = await verifyAndRefreshSession(t.token, { transport: "cookie" });
  assert.ok(r?.refreshed);
  assert.ok(dbReads > 0);
  assert.equal(decode(r.refreshed.token, 0).kid, keyIdFor(SECRET));
  delete process.env.NEXTAUTH_SECRET_PREVIOUS;
  assert.equal(await verifyAndRefreshSession(t.token, { transport: "cookie" }), null, "the old token dies with PREVIOUS");
  assert.ok(await verifyAndRefreshSession(r.refreshed.token, { transport: "cookie" }), "the replacement doesn't");
});

test("a LEGACY native token (raw key, never-expiring, no claim) works as a bearer on every request and never as a cookie", async () => {
  // The shape every iOS device signed in before guardrail 6h still holds — it
  // is never handed a replacement.
  const t = await mint({ key: "legacy-raw", expiresAt: NEVER_EXPIRES_AT_SEC, ttl: NEVER_EXPIRES_AT_SEC - now() });
  for (let i = 0; i < 3; i++) {
    assert.ok(await verifyAndRefreshSession(t.token, { transport: "bearer", allowRotation: false }), `request ${i}`);
  }
  assert.equal(await verifyAndRefreshSession(t.token, { transport: "cookie" }), null);
  // Through a rotation too, while the old raw secret is kept as PREVIOUS.
  const fromOld = await mint({ key: "legacy-raw-previous", expiresAt: NEVER_EXPIRES_AT_SEC, ttl: NEVER_EXPIRES_AT_SEC - now() });
  assert.equal(await verifyAndRefreshSession(fromOld.token, { transport: "bearer", allowRotation: false }), null);
  process.env.NEXTAUTH_SECRET_PREVIOUS = OLD;
  assert.ok(await verifyAndRefreshSession(fromOld.token, { transport: "bearer", allowRotation: false }));
});

// ── the server-component readers ─────────────────────────────────────────────

const cjsRequire = createRequire(import.meta.url);
type RunStore = { run<T>(store: unknown, fn: () => T): T };
const { workAsyncStorage } = cjsRequire("next/dist/server/app-render/work-async-storage.external.js") as { workAsyncStorage: RunStore };
const { workUnitAsyncStorage } = cjsRequire("next/dist/server/app-render/work-unit-async-storage.external.js") as { workUnitAsyncStorage: RunStore };
const { RequestCookies } = cjsRequire("next/dist/server/web/spec-extension/cookies.js") as { RequestCookies: new (h: Headers) => unknown };
const { RequestCookiesAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/request-cookies.js") as { RequestCookiesAdapter: { seal(c: unknown): unknown } };
const { HeadersAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/headers.js") as { HeadersAdapter: { seal(h: Headers): unknown } };

function inScope<T>(headers: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const h = new Headers(headers);
  return workAsyncStorage.run(
    { route: "/session-transport.test", forceStatic: false, dynamicShouldError: false, afterContext: { after: () => {} } },
    () => workUnitAsyncStorage.run(
      {
        type: "request", phase: "render",
        headers: HeadersAdapter.seal(h),
        cookies: RequestCookiesAdapter.seal(new RequestCookies(h)),
        usedDynamic: false,
      },
      fn,
    ),
  );
}

const FIREFOX = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:120.0) Gecko/20100101 Firefox/120.0";

test("the cookie readers — auth(), authActive(), readSummonarrSession, readActiveSummonarrSession — refuse a bearer-bound token", async () => {
  const native = await mint({ transport: "bearer" });
  const browser = await mint({ transport: "cookie" });
  const asCookie = (t: string) => ({ cookie: `${COOKIE}=${t}`, "user-agent": FIREFOX });
  const readers: Array<[string, () => Promise<unknown>]> = [
    ["auth", () => auth()],
    ["authActive", () => authActive()],
    ["readSummonarrSession", () => readSummonarrSession()],
    ["readActiveSummonarrSession", () => readActiveSummonarrSession()],
  ];
  for (const [name, read] of readers) {
    assert.equal(await inScope(asCookie(native.token), read), null, `${name} accepted a native token as a cookie`);
    assert.ok(await inScope(asCookie(browser.token), read), `${name} refused a real cookie (or checked the UA)`);
  }
});

test("authActive ignores the User-Agent entirely — a fingerprinted session renders from another browser family", async () => {
  seq++;
  const userId = `u-${seq}`;
  const sessionId = `s-${seq}`;
  users.set(userId, { role: "USER", permissions: 0n });
  rows.add(sessionId);
  const token = await signSessionJwt(
    { id: userId, role: "USER", permissions: "0", provider: "credentials", sessionId, expiresAt: now() + 3600,
      uaFingerprint: "chrome:windows:desktop", transport: "cookie" },
    { expiresInSeconds: 3600 },
  );
  const s = await inScope({ cookie: `${COOKIE}=${token}`, "user-agent": FIREFOX }, () => authActive());
  assert.equal(s?.user.id, userId);
});

test("readActiveSummonarrSessionFromRequest refuses the wrong transport in both directions", async () => {
  const native = await mint({ transport: "bearer" });
  const browser = await mint({ transport: "cookie" });
  const req = (h: Record<string, string>) => new NextRequest("http://localhost:3000/api/sync", { headers: h });
  assert.equal(await readActiveSummonarrSessionFromRequest(req({ authorization: `Bearer ${browser.token}` })), null);
  assert.equal(await readActiveSummonarrSessionFromRequest(req({ cookie: `${COOKIE}=${native.token}` })), null);
  assert.ok(await readActiveSummonarrSessionFromRequest(req({ authorization: `Bearer ${native.token}` })));
  assert.ok(await readActiveSummonarrSessionFromRequest(req({ cookie: `${COOKIE}=${browser.token}` })));
});

test("every src caller of verifySessionJwt / verifyAndRefreshSession names the transport", () => {
  for (const [file, pattern] of [
    ["../src/app/api/auth/sign-out/route.ts", /verifySessionJwt\(token, bearer \? "bearer" : "cookie"\)/],
    ["../src/lib/session-server.ts", /verifySessionJwt\(token, "cookie"\)/],
  ] as const) {
    assert.match(readFileSync(new URL(file, import.meta.url), "utf8"), pattern, file);
  }
  // verifyAndRefreshSession's options type makes `transport` required, so the
  // compiler holds every other caller to it (npm run typecheck).
  const refresh = readFileSync(new URL("../src/lib/session-refresh.ts", import.meta.url), "utf8");
  assert.match(refresh, /^\s+transport: SessionTransport;$/m);
});
