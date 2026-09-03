// Review 2026-09 / P48 (f53): GET /api/play-history/calendar must WHITELIST
// `source` / `mediaType` before they reach getActivityCalendar.
//
// Why: getActivityCalendar keys its 30-minute cache on the RAW strings
// (getCacheKey pushes `s=<raw>` / `m=<raw>` for any truthy value) while the
// SQL filter (appendPlayHistoryFilter) honours only plex/jellyfin and
// MOVIE/TV. Passed through raw, every distinct junk value ran the full
// uncached 365-day GROUP BY scan under a key nothing would ever reuse and
// occupied a slot in the shared 500-entry activity cache. The sibling
// /api/play-history/stats and /transcode-offenders routes already whitelist;
// this pins the calendar route to the same contract.
//
// Harness mirrors tests/play-history-admin-guard.test.mts: a real signed
// ADMIN session over bearer transport, in-memory authSession/user stubs, a
// recording $queryRawUnsafe that returns []. No DB, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "review-p48-calendar-test-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

globalThis.fetch = (() => {
  throw new Error("unexpected network call from review-2026-09-p48 tests");
}) as unknown as typeof fetch;

console.warn = () => {};
console.error = () => {};

const { NextRequest } = await import("next/server");
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { getActivityCalendar } = await import("../src/lib/play-history.ts");

// ── in-memory auth state ──────────────────────────────────────────────────────
const usersById = new Map<string, Record<string, unknown>>();
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

// ── query capture ─────────────────────────────────────────────────────────────
interface Captured { sql: string; params: unknown[] }
const captured: Captured[] = [];
shadowPrismaClientMethod(prisma, "$queryRawUnsafe", async (sql: string, ...params: unknown[]) => {
  captured.push({ sql, params });
  return [];
});

let seq = 0;
async function mintAdmin(): Promise<string> {
  seq++;
  const userId = `user-${seq}`;
  const sessionId = `sess-${seq}`;
  usersById.set(userId, {
    role: "ADMIN", permissions: 0n, mediaServer: null,
    sessionsRevokedAt: null, passwordChangedAt: null, deactivatedAt: null,
    email: `user-${seq}@example.com`, notificationEmail: null, passwordHash: null,
    plexUserId: null, jellyfinUserId: null,
  });
  authSessions.set(sessionId, { sessionId, userId, expiresAt: new Date(Date.now() + 86_400_000) });
  const iat = Math.floor(Date.now() / 1000);
  return signSessionJwt(
    { id: userId, role: "ADMIN", permissions: "0", provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
}

const calendar = (await import("../src/app/api/play-history/calendar/route.ts")).GET;

function req(path: string, token: string) {
  return new NextRequest(`http://localhost:3000${path}`, {
    headers: { authorization: `Bearer ${token}`, "x-forwarded-for": "203.0.113.5" },
  });
}

test("calendar route: junk ?source/?mediaType are dropped BEFORE the lib — the unfiltered query runs once and every junk variant is a cache hit", async () => {
  const token = await mintAdmin();

  // Reference: the lib's own unfiltered query (fresh cache key → 1 query).
  captured.length = 0;
  await getActivityCalendar();
  assert.equal(captured.length, 1, "reference unfiltered call issues exactly one query");
  const reference = captured[0];
  assert.deepEqual(reference.params, [], "unfiltered calendar binds no params");

  // (a) A junk source must produce the SAME query (no bound source param) —
  //     and, because the whitelist collapses it onto the bare `calendar` key,
  //     it is served from the entry the reference call just populated.
  captured.length = 0;
  const first = await calendar(req("/api/play-history/calendar?source=junk1", token), undefined);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), []);
  assert.equal(captured.length, 0, "?source=junk1 must be a cache hit on the bare `calendar` key, not a fresh `calendar:s=junk1` scan");

  // (b) A second, different junk value issues ZERO queries too — before the fix
  //     each distinct value minted its own never-reused key and ran the scan.
  captured.length = 0;
  const second = await calendar(req("/api/play-history/calendar?source=junk2&mediaType=junk3", token), undefined);
  assert.equal(second.status, 200);
  assert.equal(captured.length, 0, "?source=junk2&mediaType=junk3 must issue zero queries");
});

test("calendar route: recognised filters still reach the lib as bound params", async () => {
  const token = await mintAdmin();

  captured.length = 0;
  const res = await calendar(req("/api/play-history/calendar?source=jellyfin&mediaType=TV", token), undefined);
  assert.equal(res.status, 200);
  assert.equal(captured.length, 1, "a legitimate filter set is a fresh key → one query");
  assert.deepEqual(captured[0].params, ["jellyfin", "TV"], "recognised values are bound, in filter order");
  assert.match(captured[0].sql, /"source" = \$1/);
  assert.match(captured[0].sql, /"mediaType"::text = \$2/);
});
