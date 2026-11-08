// The play-history JSON export's truncation signal and its audit-before-read
// rule (guardrail 26):
//   • the JSON answer stays a bare array, and X-Export-Truncated says "true" only
//     when more rows existed past X-Export-Max-Rows — an export of exactly the cap
//     is complete;
//   • the paper-trail row is written BEFORE the first page of viewer history is
//     read, and a non-admin reaches neither.
// Harness mirrors tests/play-history-admin-ops.test.mts: a signed bearer session,
// in-memory auth/audit stubs, a raw-SQL dispatcher, no DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "ph-export-route-test-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

globalThis.fetch = (() => {
  throw new Error("unexpected network call from play-history-export-route tests");
}) as unknown as typeof fetch;

console.warn = () => {};
console.error = () => {};

const { NextRequest } = await import("next/server");
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");

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
  const workStore = { route: "/play-history-export-route.test", forceStatic: false, dynamicShouldError: false, afterContext: { after: () => {} } };
  const requestStore = {
    type: "request",
    phase: "render",
    headers: HeadersAdapter.seal(reqHeaders),
    cookies: RequestCookiesAdapter.seal(new RequestCookies(reqHeaders)),
    usedDynamic: false,
  };
  return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, fn));
}

type DbUser = {
  role: string; permissions: bigint; mediaServer: string | null;
  sessionsRevokedAt: Date | null; passwordChangedAt: Date | null; deactivatedAt: Date | null;
  email: string | null; notificationEmail: string | null; passwordHash: string | null;
  plexUserId: string | null; jellyfinUserId: string | null;
};
const usersById = new Map<string, DbUser>();
const authSessions = new Map<string, { sessionId: string; userId: string; expiresAt: Date }>();

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

// getStatsTimeZone reads the zone setting; none stored ⇒ the process zone.
shadowPrismaModel(prisma, "setting", { findUnique: async () => null });

// One ordered event log, so "audit before read" is an assertion on order.
const events: string[] = [];
shadowPrismaModel(prisma, "auditLog", {
  create: async (a: { data: unknown }) => {
    events.push("audit");
    return a.data;
  },
});

const startedAt = new Date("2026-10-01T20:00:00.000Z");
function exportRow(i: number): Record<string, unknown> {
  return {
    id: `ph-${i}`, title: "Amélie", mediaType: "MOVIE", year: "2001", seasonNumber: null, episodeNumber: null,
    episodeTitle: null, source: "plex", startedAt: new Date(startedAt.getTime() - i * 1000), stoppedAt: startedAt,
    duration: 5400, playDuration: 5300, pausedDuration: 0, watched: true, platform: "Roku", player: "Plex for Roku",
    device: "Roku", playMethod: "DirectPlay", videoCodec: "h264", audioCodec: "aac", resolution: "1080",
    bitrate: 8000, videoDecision: "directplay", audioDecision: "directplay", container: "mkv", username: "alice",
  };
}

// The export's page queries share `rowsAvailable` rows in all.
let rowsAvailable = 0;
let served = 0;
shadowPrismaClientMethod(prisma, "$queryRawUnsafe", async (sql: string, ...binds: unknown[]) => {
  if (!sql.includes('LEFT JOIN "MediaServerUser" msu')) return [];
  events.push("read");
  const take = Math.min(Number(binds[binds.length - 1]), rowsAvailable - served);
  const out = Array.from({ length: Math.max(0, take) }, (_, i) => exportRow(served + i));
  served += out.length;
  return out;
});

let seq = 0;
async function mint(role: "ADMIN" | "USER"): Promise<string> {
  seq++;
  const userId = `u-${seq}`;
  const sessionId = `sess-${seq}`;
  usersById.set(userId, {
    role, permissions: 0n, mediaServer: null,
    sessionsRevokedAt: null, passwordChangedAt: null, deactivatedAt: null,
    email: `u-${seq}@example.com`, notificationEmail: null, passwordHash: null,
    plexUserId: null, jellyfinUserId: null,
  });
  authSessions.set(sessionId, { sessionId, userId, expiresAt: new Date(Date.now() + 86_400_000) });
  const iat = Math.floor(Date.now() / 1000);
  return signSessionJwt(
    { id: userId, role, permissions: "0", provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
}

function req(token: string) {
  return new NextRequest("http://localhost:3000/api/play-history/export?format=json", {
    headers: { authorization: `Bearer ${token}`, "x-forwarded-for": "203.0.113.5" },
  });
}

const exportRoute = (await import("../src/app/api/play-history/export/route.ts")).GET;

beforeEach(() => {
  rowsAvailable = 0;
  served = 0;
  events.length = 0;
});

test("a JSON export of exactly the cap is complete: X-Export-Truncated is false and every row is present", async () => {
  rowsAvailable = 10_000;
  const token = await mint("ADMIN");
  const res = await runInScope(token, () => exportRoute(req(token)));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-export-truncated"), "false");
  assert.equal(res.headers.get("x-export-max-rows"), "10000");
  const body = (await res.json()) as unknown[];
  assert.ok(Array.isArray(body));
  assert.equal(body.length, 10_000);
});

test("a JSON export with one row past the cap is cut to the cap and says so; the probe row is never written", async () => {
  rowsAvailable = 10_001;
  const token = await mint("ADMIN");
  const res = await runInScope(token, () => exportRoute(req(token)));
  assert.equal(res.headers.get("x-export-truncated"), "true");
  assert.equal(res.headers.get("x-export-max-rows"), "10000");
  const body = (await res.json()) as Array<{ id: string }>;
  assert.equal(body.length, 10_000);
  assert.equal(body.at(-1)!.id, "ph-9999", "the row past the cap is the one dropped");
});

test("a small JSON export reports not truncated", async () => {
  rowsAvailable = 3;
  const token = await mint("ADMIN");
  const res = await runInScope(token, () => exportRoute(req(token)));
  assert.equal(res.headers.get("x-export-truncated"), "false");
  assert.equal(((await res.json()) as unknown[]).length, 3);
});

test("the export's audit row is written before the first page of history is read", async () => {
  rowsAvailable = 2;
  const token = await mint("ADMIN");
  await runInScope(token, () => exportRoute(req(token)));
  assert.deepEqual(events.slice(0, 2), ["audit", "read"]);
});

test("a non-admin is refused before any audit write or history read", async () => {
  rowsAvailable = 2;
  const token = await mint("USER");
  const res = await runInScope(token, () => exportRoute(req(token)));
  assert.equal(res.status, 403);
  assert.deepEqual(events, []);
});
