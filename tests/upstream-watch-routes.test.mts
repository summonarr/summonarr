// Route-level tests for the two entry points of the upstream watch-record
// refresh (src/lib/upstream-watch-data.ts):
//
//   POST /api/admin/never-watched/refresh — the never-watched page's "Refresh":
//     1. ADMIN only (guardrail 6a): anonymous 401, a non-admin 403, neither
//        reaches a media server or the lock.
//     2. 404 while feature.admin.neverWatched is off.
//     3. Rate-limited per admin (3 per 10 minutes) — 429 with no lock taken.
//     4. Same advisory lock as the cron: a busy lock is a 409, never a second
//        walk of every server's history beside the first (guardrail 41).
//     5. Success returns the UpstreamRefreshResult JSON and releases the lock.
//
//   POST /api/cron/refresh-upstream-watch — the daily cron:
//     6. A no-op (skipped, no lock, no upstream traffic, no ledger row) while
//        BOTH feature.admin.neverWatched and feature.admin.cleanup are off;
//        either one on makes it run.
//     7. A server that fails degrades the run (200 + X-Cron-Degraded) instead of
//        a non-2xx the entrypoint would fast-retry.
// (The shared cron invariants — 401 matrix, busy-lock shape, lock release,
// distinct lock ids — are pinned for this route in tests/cron-routes.test.mts.)
//
// Harness: real handlers with a signed session JWT inside a synthetic request
// scope (the tests/library-cleanup-routes.test.mts idiom), in-memory prisma
// stubs, a patched pg Client.prototype for the advisory lock (the
// tests/cron-routes.test.mts seam) and a scripted fetch. No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import { Client } from "pg";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "upstream-routes-test-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
process.env.DATABASE_URL = "postgres://u:p@127.0.0.1:5432/db"; // Client.prototype is stubbed; never dialed
const CRON_SECRET = "upstream-routes-cron-secret-0123456789abcdef";
process.env.CRON_SECRET = CRON_SECRET;
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

console.warn = () => {};
console.error = () => {};

// ── pg advisory-lock seam ────────────────────────────────────────────────────
let lockCalls: Array<{ op: "try" | "unlock"; lockId: number }> = [];
let lockFree = true;
const pgProto = Client.prototype as unknown as {
  connect: () => Promise<void>;
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
  end: () => Promise<void>;
};
pgProto.connect = async () => {};
pgProto.query = async (text, values) => {
  if (text.includes("pg_try_advisory_lock")) {
    lockCalls.push({ op: "try", lockId: Number((values ?? [])[0]) });
    return { rows: [{ acquired: lockFree }] };
  }
  if (text.includes("pg_advisory_unlock")) {
    lockCalls.push({ op: "unlock", lockId: Number((values ?? [])[0]) });
    return { rows: [] };
  }
  return { rows: [] };
};
pgProto.end = async () => {};

// ── scripted upstream ────────────────────────────────────────────────────────
const PLEX = "http://10.73.0.1:32400";
let fetches: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  fetches.push(String(input));
  return new Response("unauthorized", { status: 401 });
}) as typeof fetch;

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
const { UPSTREAM_WATCH_LOCK_ID } = await import("../src/lib/advisory-lock.ts");

// ── auth fixture ─────────────────────────────────────────────────────────────
const usersById = new Map<string, Record<string, unknown>>();
const sessionRows = new Set<string>();
shadowPrismaModel(prisma, "authSession", {
  findUnique: async (args: { where: { sessionId: string } }) =>
    sessionRows.has(args.where.sessionId) ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId } : null,
  update: async () => ({}),
});
shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id: string } }) => {
    const u = usersById.get(args.where.id);
    return u ? { ...u } : null;
  },
  update: async () => ({}),
});
let sessionSeq = 0;
async function mintSession(role = "ADMIN", permissions: bigint = Permission.ADMIN): Promise<string> {
  sessionSeq++;
  const userId = `user-${sessionSeq}`;
  const sessionId = `sess-${sessionSeq}`;
  usersById.set(userId, {
    role, permissions, mediaServer: null, sessionsRevokedAt: null,
    passwordChangedAt: null, deactivatedAt: null, email: `u${sessionSeq}@example.com`, notificationEmail: null,
  });
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000);
  return signSessionJwt(
    { id: userId, role, permissions: permissions.toString(), provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
}
const COOKIE = getSessionCookieName();

// ── data stubs ───────────────────────────────────────────────────────────────
const settings = new Map<string, string>();
let ledgerWrites: string[] = [];
shadowPrismaModel(prisma, "setting", {
  findMany: async (args?: { where?: { key?: { in?: string[] } } }) => {
    const keys = args?.where?.key?.in;
    return [...settings.entries()].filter(([k]) => !keys || keys.includes(k)).map(([key, value]) => ({ key, value }));
  },
  findUnique: async (args: { where: { key: string } }) => {
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
  upsert: async (args: { where: { key: string }; update: { value: string } }) => {
    if (args.where.key.startsWith("cron:lastRun:")) ledgerWrites.push(args.where.key);
    settings.set(args.where.key, args.update.value);
    return { key: args.where.key, value: args.update.value };
  },
});
let evidenceWrites = 0;
shadowPrismaModel(prisma, "upstreamWatchEvidence", {
  findMany: async () => [],
  deleteMany: async () => { evidenceWrites++; return { count: 0 }; },
  createMany: async () => { evidenceWrites++; return { count: 0 }; },
});
shadowPrismaModel(prisma, "plexLibraryItem", { findMany: async () => [] });
shadowPrismaModel(prisma, "jellyfinLibraryItem", { findMany: async () => [] });
shadowPrismaModel(prisma, "playHistory", { findMany: async () => [] });
shadowPrismaClientMethod(prisma, "$transaction", async (fn: unknown) => (fn as (tx: unknown) => Promise<unknown>)(prisma));

const refreshRoute = await import("../src/app/api/admin/never-watched/refresh/route.ts");
const cronRoute = await import("../src/app/api/cron/refresh-upstream-watch/route.ts");

// ── request scope ────────────────────────────────────────────────────────────
function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = {
    route: "/upstream-watch-routes.test",
    forceStatic: false,
    dynamicShouldError: false,
    afterContext: { after: () => {} },
  };
  const h = new Headers();
  const requestStore = {
    type: "request", phase: "render",
    headers: HeadersAdapter.seal(h),
    cookies: RequestCookiesAdapter.seal(new RequestCookies(h)),
    usedDynamic: false,
  };
  return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, fn));
}
const refresh = (token: string | null) =>
  inScope(() => (refreshRoute.POST as unknown as (r: unknown, c: unknown) => Promise<Response>)(
    new NextRequest("http://localhost:3000/api/admin/never-watched/refresh", {
      method: "POST",
      headers: token ? { cookie: `${COOKIE}=${token}` } : {},
    }),
    undefined,
  ));
const cron = (authorized = true) =>
  cronRoute.POST(new NextRequest("http://localhost:3000/api/cron/refresh-upstream-watch", {
    method: "POST",
    headers: authorized ? { authorization: `Bearer ${CRON_SECRET}` } : {},
  }));

beforeEach(() => {
  settings.clear();
  settings.set("feature.admin.neverWatched", "true");
  invalidateFeatureFlagCache();
  lockCalls = [];
  lockFree = true;
  fetches = [];
  ledgerWrites = [];
  evidenceWrites = 0;
});

// ── admin refresh ────────────────────────────────────────────────────────────

test("refresh: anonymous is 401 and a non-admin is 403 — neither takes the lock nor reaches a media server", async () => {
  settings.set("plexServerUrl", PLEX);
  settings.set("plexAdminToken", "t");
  assert.equal((await refresh(null)).status, 401);
  assert.equal((await refresh(await mintSession("USER", Permission.REQUEST))).status, 403);
  assert.equal((await refresh(await mintSession("ISSUE_ADMIN", Permission.MANAGE_ISSUES))).status, 403);
  assert.deepEqual(lockCalls, []);
  assert.deepEqual(fetches, []);
});

test("refresh: 404 while feature.admin.neverWatched is off", async () => {
  settings.set("feature.admin.neverWatched", "false"); // defaults ON
  invalidateFeatureFlagCache();
  const res = await refresh(await mintSession());
  assert.equal(res.status, 404);
  assert.deepEqual(lockCalls, []);
});

test("refresh: success returns the result JSON under the shared lock, and releases it", async () => {
  const res = await refresh(await mintSession());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { servers: [], aborted: false });
  assert.deepEqual(lockCalls, [{ op: "try", lockId: UPSTREAM_WATCH_LOCK_ID }, { op: "unlock", lockId: UPSTREAM_WATCH_LOCK_ID }]);
});

test("refresh: a busy lock is 409 — no second walk beside the running one", async () => {
  lockFree = false;
  settings.set("plexServerUrl", PLEX);
  settings.set("plexAdminToken", "t");
  const res = await refresh(await mintSession());
  assert.equal(res.status, 409);
  assert.equal(res.headers.get("retry-after"), "30");
  assert.equal(typeof (await res.json()).error, "string");
  assert.deepEqual(fetches, []);
  assert.deepEqual(lockCalls.filter((c) => c.op === "unlock"), [], "never releases a lock it doesn't hold");
});

test("refresh: rate-limited to 3 per admin per 10 minutes — the 4th is 429 and takes no lock", async () => {
  const token = await mintSession();
  for (let i = 0; i < 3; i++) assert.equal((await refresh(token)).status, 200, `call ${i + 1}`);
  lockCalls = [];
  const res = await refresh(token);
  assert.equal(res.status, 429);
  assert.deepEqual(lockCalls, []);
  // Per admin: another admin is unaffected.
  assert.equal((await refresh(await mintSession())).status, 200);
});

// ── cron ─────────────────────────────────────────────────────────────────────

test("cron: unauthenticated is 401", async () => {
  assert.equal((await cron(false)).status, 401);
  assert.deepEqual(lockCalls, []);
});

test("cron: a no-op while BOTH never-watched and cleanup are off — skipped, no lock, no fetch, no ledger row", async () => {
  settings.set("feature.admin.neverWatched", "false"); // defaults ON
  invalidateFeatureFlagCache();
  settings.set("plexServerUrl", PLEX);
  settings.set("plexAdminToken", "t");
  const res = await cron();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { skipped: true, reason: "feature disabled" });
  assert.equal(res.headers.get("x-cron-skipped"), "1");
  assert.deepEqual(lockCalls, []);
  assert.deepEqual(fetches, []);
  assert.deepEqual(ledgerWrites, []);
});

test("cron: cleanup ON alone is enough to run (the cleanup rules read the same evidence)", async () => {
  settings.set("feature.admin.neverWatched", "false"); // defaults ON
  settings.set("feature.admin.cleanup", "true");
  invalidateFeatureFlagCache();
  const res = await cron();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.servers, []);
  assert.ok(lockCalls.some((c) => c.op === "try" && c.lockId === UPSTREAM_WATCH_LOCK_ID));
  assert.deepEqual(ledgerWrites, ["cron:lastRun:upstream-watch"]);
});

test("cron: a failing server degrades the run (200 + X-Cron-Degraded), never a non-2xx; its rows are not touched", async () => {
  settings.set("plexServerUrl", PLEX);
  settings.set("plexAdminToken", "t");
  const res = await cron();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-cron-degraded"), "1");
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.servers[0].error, "HTTP 401");
  assert.equal(typeof body.error, "string");
  assert.equal(evidenceWrites, 0);
  assert.ok(fetches.every((u) => u.startsWith(`${PLEX}/status/sessions/history/all`)));
});
