// PATCH /api/admin/watch-sync/[id] { rescan: true } forgets both read points. A
// run in flight writes its newer read point back as it advances, so a reset
// written beside one was silently lost. The reset is now written under the
// watch-sync advisory lock (the one the cron and "Run now" hold): a busy lock
// answers the run route's 409 and changes nothing. Edits without a rescan never
// touch the lock.
//
// Harness: the real handler with a signed session JWT inside a synthetic request
// scope, in-memory prisma stubs and a patched pg Client.prototype for the
// advisory lock. No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import { Client } from "pg";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "watch-sync-pair-route-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
process.env.DATABASE_URL = "postgres://u:p@127.0.0.1:5432/db"; // Client.prototype is stubbed; never dialed
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

console.warn = () => {};
console.error = () => {};

// ── pg advisory-lock seam ────────────────────────────────────────────────────
let lockFree = true;
const lockEvents: string[] = [];
const pgProto = Client.prototype as unknown as {
  connect: () => Promise<void>;
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
  end: () => Promise<void>;
};
pgProto.connect = async () => {};
pgProto.query = async (text, values) => {
  if (text.includes("pg_try_advisory_lock")) {
    lockEvents.push(`try:${String(values?.[0])}`);
    return { rows: [{ acquired: lockFree }] };
  }
  if (text.includes("pg_advisory_unlock")) lockEvents.push("unlock");
  return { rows: [] };
};
pgProto.end = async () => {};

const cjsRequire = createRequire(import.meta.url);
type RunStore = { run<T>(store: unknown, fn: () => T): T };
const { workAsyncStorage } = cjsRequire("next/dist/server/app-render/work-async-storage.external.js") as { workAsyncStorage: RunStore };
const { workUnitAsyncStorage } = cjsRequire("next/dist/server/app-render/work-unit-async-storage.external.js") as { workUnitAsyncStorage: RunStore };
const { RequestCookies } = cjsRequire("next/dist/server/web/spec-extension/cookies.js") as { RequestCookies: new (h: Headers) => unknown };
const { RequestCookiesAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/request-cookies.js") as { RequestCookiesAdapter: { seal(c: unknown): unknown } };
const { HeadersAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/headers.js") as { HeadersAdapter: { seal(h: Headers): unknown } };

const { NextRequest } = await import("next/server");
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");
const { Permission } = await import("../src/lib/permissions.ts");
const { invalidateFeatureFlagCache } = await import("../src/lib/features.ts");
const { WATCH_SYNC_LOCK_ID } = await import("../src/lib/advisory-lock.ts");

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
async function mintSession(): Promise<string> {
  sessionSeq++;
  const userId = `wsp-user-${sessionSeq}`;
  const sessionId = `wsp-sess-${sessionSeq}`;
  usersById.set(userId, {
    role: "ADMIN", permissions: Permission.ADMIN, mediaServer: null, sessionsRevokedAt: null,
    passwordChangedAt: null, deactivatedAt: null, email: `wsp${sessionSeq}@example.com`, notificationEmail: null,
  });
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000);
  return signSessionJwt(
    { id: userId, role: "ADMIN", permissions: Permission.ADMIN.toString(), provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
}
const COOKIE = getSessionCookieName();

// ── data stubs ───────────────────────────────────────────────────────────────
const settings = new Map<string, string>();
shadowPrismaModel(prisma, "setting", {
  findMany: async (args?: { where?: { key?: { in?: string[] } } }) => {
    const keys = args?.where?.key?.in;
    return [...settings.entries()].filter(([k]) => !keys || keys.includes(k)).map(([key, value]) => ({ key, value }));
  },
  findUnique: async (args: { where: { key: string } }) => {
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
});
shadowPrismaModel(prisma, "auditLog", { create: async () => ({}) });
type PairWrite = { where: { id: string }; data: Record<string, unknown> };
const pairWrites: PairWrite[] = [];
shadowPrismaModel(prisma, "watchSyncPair", {
  updateMany: async (args: PairWrite) => {
    lockEvents.push("write");
    pairWrites.push(args);
    return { count: args.where.id === "pair-1" ? 1 : 0 };
  },
});

const route = await import("../src/app/api/admin/watch-sync/[id]/route.ts");

function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = { route: "/watch-sync-pair-route.test", forceStatic: false, dynamicShouldError: false, afterContext: { after: () => {} } };
  const h = new Headers();
  const requestStore = {
    type: "request", phase: "render",
    headers: HeadersAdapter.seal(h),
    cookies: RequestCookiesAdapter.seal(new RequestCookies(h)),
    usedDynamic: false,
  };
  return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, fn));
}
const patch = (token: string, id: string, body: unknown) =>
  inScope(() => (route.PATCH as unknown as (r: unknown, c: unknown) => Promise<Response>)(
    new NextRequest(`http://localhost:3000/api/admin/watch-sync/${id}`, {
      method: "PATCH",
      headers: { cookie: `${COOKIE}=${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  ));

beforeEach(() => {
  settings.clear();
  settings.set("feature.admin.watchSync", "true");
  invalidateFeatureFlagCache();
  lockFree = true;
  lockEvents.length = 0;
  pairWrites.length = 0;
});

test("rescan resets both read points UNDER the watch-sync lock: try, write, unlock", { timeout: 5_000 }, async () => {
  const res = await patch(await mintSession(), "pair-1", { rescan: true, direction: "toPlex" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.deepEqual(lockEvents, [`try:${WATCH_SYNC_LOCK_ID}`, "write", "unlock"]);
  assert.deepEqual(pairWrites, [{ where: { id: "pair-1" }, data: { direction: "toPlex", historyReadTo: null, jellyfinReadTo: null } }]);
});

test("rescan while a run holds the lock answers the run route's 409 and writes NOTHING — a run would write its read point back over the reset", { timeout: 5_000 }, async () => {
  lockFree = false;
  const res = await patch(await mintSession(), "pair-1", { rescan: true, enabled: false });
  assert.equal(res.status, 409);
  assert.equal(res.headers.get("Retry-After"), "30");
  const body = await res.json() as { ok: boolean; error: string; retryAfter: number };
  assert.equal(body.ok, false);
  assert.equal(body.retryAfter, 30);
  assert.ok(body.error.length > 0);
  assert.deepEqual(pairWrites, []);
});

test("rescan of a pair that is gone is still a 404, under the lock", { timeout: 5_000 }, async () => {
  const res = await patch(await mintSession(), "pair-gone", { rescan: true });
  assert.equal(res.status, 404);
  assert.deepEqual(lockEvents, [`try:${WATCH_SYNC_LOCK_ID}`, "write", "unlock"]);
});

test("an edit without rescan never touches the lock — it saves while a run is going", { timeout: 5_000 }, async () => {
  lockFree = false;
  const res = await patch(await mintSession(), "pair-1", { enabled: false, syncProgress: true });
  assert.equal(res.status, 200);
  assert.deepEqual(lockEvents, ["write"]);
  assert.deepEqual(pairWrites, [{ where: { id: "pair-1" }, data: { enabled: false, syncProgress: true } }]);
});
