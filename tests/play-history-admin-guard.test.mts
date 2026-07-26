// Security regression guard: NO non-admin may read another user's watch
// history. The only history surface open to a normal user is /api/play-history/
// mine (self-scoped, pinned by tests/watch-history-mine-route.test.mts). EVERY
// other play-history read route exposes ALL users' history — the list route
// even binds a raw `?userId=` filter straight into `mediaServerUserId = ?` —
// so each MUST require the full ADMIN permission bit.
//
// Why this test exists separately from tests/api-auth.test.mts (which proves
// the withPermission wrapper itself 403s a non-admin): scripts/audit-routes.mts
// only enforces ADMIN-level guards on `/api/admin/*` PATHS. These routes live
// under `/api/play-history/*`, so CI would NOT catch a downgrade of, say, the
// list route from `withPermission(Permission.ADMIN)` to `withAuth` — and that
// single downgrade would let any signed-in user read anyone's history via
// `?userId=`. This test pins the ADMIN requirement at each route so that
// regression fails loudly.
//
// What it asserts, for every admin play-history route:
//   • a plain USER session → 403, and
//   • the data layer (prisma.playHistory / $queryRawUnsafe / activeSession) is
//     NEVER reached — the throwing stubs below fire if the guard is bypassed.
//   • an unauthenticated request → 401.
// Plus the two contrasts that prove the model is "admins yes, users only their
// own": an ADMIN session clears the guard (sessions route returns 200), and a
// USER hits /mine fine (200, self-scoped) — the exact split the requirement asks
// for. The dangerous list route is additionally probed with a forged
// `?userId=<someone-else>` as a USER: still 403, the foreign id never binds.
//
// Harness mirrors tests/watch-history-mine-route.test.mts: real signed session
// JWTs over bearer transport (skips UA-fingerprint binding, guardrail 6b),
// in-memory authSession/user stubs, no DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";

// Next's async-local-storage shim captures globalThis.AsyncLocalStorage at
// module load — assign it BEFORE anything pulls in next/* (the export route's
// requireAuth() reads next/headers headers(), which needs a request scope).
(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "ph-admin-guard-test-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

globalThis.fetch = (() => {
  throw new Error("unexpected network call from play-history-admin-guard tests");
}) as unknown as typeof fetch;

const warns: string[] = [];
const errors: string[] = [];
console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };
console.error = (...a: unknown[]) => { errors.push(a.map(String).join(" ")); };

const { NextRequest } = await import("next/server");
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");

// Synthetic request scope so the export route's requireAuth() → headers() reads
// the bearer (the other routes read it off the passed NextRequest). Standard
// idiom from tests/requests-route.test.mts.
type RunStore = { run<T>(store: unknown, fn: () => T): T };
const cjsRequire = createRequire(import.meta.url);
const { workAsyncStorage } = cjsRequire("next/dist/server/app-render/work-async-storage.external.js") as { workAsyncStorage: RunStore };
const { workUnitAsyncStorage } = cjsRequire("next/dist/server/app-render/work-unit-async-storage.external.js") as { workUnitAsyncStorage: RunStore };
const { RequestCookies } = cjsRequire("next/dist/server/web/spec-extension/cookies.js") as { RequestCookies: new (h: Headers) => unknown };
const { RequestCookiesAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/request-cookies.js") as { RequestCookiesAdapter: { seal(c: unknown): unknown } };
const { HeadersAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/headers.js") as { HeadersAdapter: { seal(h: Headers): unknown } };

function runInScope<T>(token: string | null, fn: () => T): T {
  const reqHeaders = new Headers({ "x-forwarded-for": "203.0.113.5" });
  if (token) reqHeaders.set("authorization", `Bearer ${token}`);
  const workStore = {
    route: "/play-history-admin-guard.test",
    forceStatic: false,
    dynamicShouldError: false,
    afterContext: { after: () => {} },
  };
  const requestStore = {
    type: "request",
    phase: "render",
    headers: HeadersAdapter.seal(reqHeaders),
    cookies: RequestCookiesAdapter.seal(new RequestCookies(reqHeaders)),
    usedDynamic: false,
  };
  return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, fn));
}

// ── in-memory auth state ──────────────────────────────────────────────────────
type DbUser = {
  role: string;
  permissions: bigint;
  mediaServer: string | null;
  sessionsRevokedAt: Date | null;
  passwordChangedAt: Date | null;
  deactivatedAt: Date | null;
  email: string | null;
  notificationEmail: string | null;
  passwordHash: string | null;
  plexUserId: string | null;
  jellyfinUserId: string | null;
};
const usersById = new Map<string, DbUser>();
const authSessions = new Map<string, { sessionId: string; userId: string; expiresAt: Date }>();

// The tripwire: if the ADMIN guard is ever bypassed for a non-admin, one of
// these fires and the test fails with a clear message.
let dataLayerHits = 0;
function tripwire(label: string): never {
  dataLayerHits++;
  throw new Error(`SECURITY: play-history data layer reached without ADMIN (${label})`);
}

shadowPrismaModel(prisma, "authSession", {
  findUnique: async (a: { where: { sessionId: string } }) => authSessions.get(a.where.sessionId) ?? null,
  update: async () => ({}),
});
shadowPrismaModel(prisma, "user", {
  findUnique: async (a: { where: { id: string } }) => {
    const u = usersById.get(a.where.id);
    return u ? { ...u } : null;
  },
  update: async () => ({}),
});
// Every ALL-USERS read path throws — a non-admin must never reach any of them.
shadowPrismaModel(prisma, "playHistory", {
  findMany: async () => tripwire("playHistory.findMany"),
  findUnique: async () => tripwire("playHistory.findUnique"),
  findFirst: async () => tripwire("playHistory.findFirst"),
  count: async () => tripwire("playHistory.count"),
  aggregate: async () => tripwire("playHistory.aggregate"),
  delete: async () => tripwire("playHistory.delete"),
});
shadowPrismaClientMethod(prisma, "$queryRawUnsafe", async () => tripwire("$queryRawUnsafe"));
// activeSession backs the /sessions route; return [] so the ADMIN-pass check can
// run one route to green (proving the guard admits admins, not just rejects).
shadowPrismaModel(prisma, "activeSession", {
  findMany: async () => [],
});
// /mine's scope resolution for the USER contrast: no linked server user → the
// self endpoint returns linked:false WITHOUT touching playHistory.
shadowPrismaModel(prisma, "mediaServerUser", {
  findMany: async () => [],
});

// ── session minting ───────────────────────────────────────────────────────────
let seq = 0;
async function mintSession(role: string): Promise<string> {
  seq++;
  const userId = `user-${seq}`;
  const sessionId = `sess-${seq}`;
  usersById.set(userId, {
    role, permissions: 0n, mediaServer: null,
    sessionsRevokedAt: null, passwordChangedAt: null, deactivatedAt: null,
    email: `user-${seq}@example.com`, notificationEmail: null, passwordHash: null,
    plexUserId: null, jellyfinUserId: null,
  });
  authSessions.set(sessionId, { sessionId, userId, expiresAt: new Date(Date.now() + 86_400_000) });
  const iat = Math.floor(Date.now() / 1000);
  return signSessionJwt(
    { id: userId, role, permissions: "0", provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
}

type Req = InstanceType<typeof NextRequest>;
function req(path: string, token: string | null, method = "GET"): Req {
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "x-forwarded-for": "203.0.113.5",
    },
  });
}

// Route handlers — imported AFTER the stubs are in place.
const list = (await import("../src/app/api/play-history/route.ts")).GET;
const idMod = await import("../src/app/api/play-history/[id]/route.ts");
const stats = (await import("../src/app/api/play-history/stats/route.ts")).GET;
const calendar = (await import("../src/app/api/play-history/calendar/route.ts")).GET;
const sessions = (await import("../src/app/api/play-history/sessions/route.ts")).GET;
const offenders = (await import("../src/app/api/play-history/transcode-offenders/route.ts")).GET;
const exportRoute = (await import("../src/app/api/play-history/export/route.ts")).GET;
const mine = (await import("../src/app/api/play-history/mine/route.ts")).GET;

const idCtx = { params: Promise.resolve({ id: "some-play-id" }) };

// The full set of routes that expose ANY user's history. `invoke` returns the
// Response; dynamic-route handlers get the `[id]` ctx.
const ADMIN_ROUTES: { name: string; invoke: (token: string | null) => Promise<Response> }[] = [
  { name: "GET /api/play-history (list, has ?userId filter)", invoke: (t) => list(req("/api/play-history", t), undefined) },
  { name: "GET /api/play-history/[id]", invoke: (t) => idMod.GET(req("/api/play-history/some-play-id", t), idCtx) },
  { name: "DELETE /api/play-history/[id]", invoke: (t) => idMod.DELETE(req("/api/play-history/some-play-id", t, "DELETE"), idCtx) },
  { name: "GET /api/play-history/stats", invoke: (t) => stats(req("/api/play-history/stats", t), undefined) },
  { name: "GET /api/play-history/calendar", invoke: (t) => calendar(req("/api/play-history/calendar", t), undefined) },
  { name: "GET /api/play-history/sessions", invoke: (t) => sessions(req("/api/play-history/sessions", t), undefined) },
  { name: "GET /api/play-history/transcode-offenders", invoke: (t) => offenders(req("/api/play-history/transcode-offenders", t), undefined) },
  // export authenticates via requireAuth() → next/headers, so its bearer must
  // live in the request scope, not (only) on the passed NextRequest.
  { name: "GET /api/play-history/export", invoke: (t) => runInScope(t, () => exportRoute(req("/api/play-history/export", t))) },
];

beforeEach(() => {
  dataLayerHits = 0;
  warns.length = 0;
  errors.length = 0;
});

test("a plain USER is 403 on EVERY all-users play-history route, and never reaches the data layer", async () => {
  const userToken = await mintSession("USER");
  for (const route of ADMIN_ROUTES) {
    const res = await route.invoke(userToken);
    assert.equal(res.status, 403, `${route.name} must 403 a non-admin (got ${res.status})`);
  }
  assert.equal(dataLayerHits, 0, "no admin play-history query may run for a non-admin");
});

test("an ISSUE_ADMIN (partial admin, no ADMIN bit) is ALSO 403 — only the full admin sees others' history", async () => {
  const issueAdminToken = await mintSession("ISSUE_ADMIN");
  for (const route of ADMIN_ROUTES) {
    const res = await route.invoke(issueAdminToken);
    assert.equal(res.status, 403, `${route.name} must 403 an ISSUE_ADMIN (got ${res.status})`);
  }
  assert.equal(dataLayerHits, 0, "no admin play-history query may run for a partial admin");
});

test("unauthenticated requests are 401 on every all-users route (and never reach the data layer)", async () => {
  for (const route of ADMIN_ROUTES) {
    const res = await route.invoke(null);
    assert.equal(res.status, 401, `${route.name} must 401 an anonymous caller (got ${res.status})`);
  }
  assert.equal(dataLayerHits, 0);
});

test("the list route's ?userId filter is unreachable to a non-admin — a forged userId still 403s, never binds", async () => {
  const userToken = await mintSession("USER");
  // A non-admin trying to read a SPECIFIC other user's history by id.
  const res = await list(req("/api/play-history?userId=someone-elses-msu-id", userToken), undefined);
  assert.equal(res.status, 403);
  assert.equal(dataLayerHits, 0, "the userId-filtered query must never run for a non-admin");
});

test("contrast: an ADMIN clears the guard (sessions route → 200), and a USER can still read ONLY /mine (200)", async () => {
  // Admin passes the permission gate — proves the guard admits admins, not just
  // rejects everyone. The sessions route only reads activeSession (stubbed []).
  const adminToken = await mintSession("ADMIN");
  const adminRes = await sessions(req("/api/play-history/sessions", adminToken), undefined);
  assert.equal(adminRes.status, 200, "an ADMIN must pass the guard");

  // A USER's OWN history endpoint stays open — self-scoped, no linked server
  // user here so it returns linked:false without touching the all-users layer.
  const userToken = await mintSession("USER");
  const mineRes = await mine(req("/api/play-history/mine", userToken), undefined);
  assert.equal(mineRes.status, 200, "a USER may read their own /mine history");
  const body = (await mineRes.json()) as { linked: boolean; items: unknown[] };
  assert.equal(body.linked, false);
  assert.deepEqual(body.items, []);
  assert.equal(dataLayerHits, 0, "/mine with no linked user must not touch the all-users data layer");
});
