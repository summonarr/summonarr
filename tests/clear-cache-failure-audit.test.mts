// DELETE /api/admin/clear-cache runs several separate statements (TmdbCache,
// TmdbMediaCore, the suggestion-graph transaction, the verdict reset). A failure
// part-way leaves the earlier ones committed, so a destructive half-clear must
// still leave an audit row — with the counts it actually reached and a failure
// marker — and the error must still reach the caller (no 200 on a failed clear).
//
// Harness: an in-memory prisma stub seeded on globalThis before the module graph
// loads and a real signed bearer session, the same shape as
// tests/clear-cache-tmdb-prefixes.test.mts. No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "clear-cache-failure-audit-test-secret-0123456789";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";

console.warn = () => {};
console.error = () => {};

type DbUser = {
  id: string; role: string; permissions: bigint; name: string | null; email: string | null;
  mediaServer: string | null; notificationEmail: string | null;
  sessionsRevokedAt: Date | null; passwordChangedAt: Date | null; deactivatedAt: Date | null;
  purgedAt: Date | null;
};
const usersById = new Map<string, DbUser>();
const authSessionsById = new Map<string, { userId: string; deviceLabel: string | null; createdAt: Date }>();

let ops: string[] = [];
let auditRows: Array<Record<string, unknown>> = [];
let coreThrows = false;
let verdictThrows = false;

const fakePrisma = {
  user: {
    findUnique: async (args: { where: { id: string } }) => {
      const u = usersById.get(args.where.id);
      return u ? { ...u } : null;
    },
    findMany: async () => [],
  },
  authSession: {
    findUnique: async (args: { where: { sessionId: string } }) => {
      const row = authSessionsById.get(args.where.sessionId);
      return row
        ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId, userId: row.userId, deviceLabel: row.deviceLabel }
        : null;
    },
    update: async () => ({}),
    findMany: async () => [],
  },
  setting: { findUnique: async () => null },
  tmdbCache: { deleteMany: async () => { ops.push("tmdbCache.deleteMany"); return { count: 9 }; } },
  tmdbMediaCore: {
    deleteMany: async () => {
      ops.push("tmdbMediaCore.deleteMany");
      if (coreThrows) throw new Error("connection reset (unit test)");
      return { count: 5 };
    },
  },
  recommendationTitle: {
    updateMany: async () => {
      ops.push("recommendationTitle.updateMany");
      if (verdictThrows) throw new Error("statement timeout (unit test)");
      return { count: 2 };
    },
  },
  titleSuggestion: { deleteMany: async () => { ops.push("titleSuggestion.deleteMany"); return { count: 7 }; } },
  coWatchSuggestion: { deleteMany: async () => { ops.push("coWatchSuggestion.deleteMany"); return { count: 1 }; } },
  auditLog: {
    create: async (args: { data: Record<string, unknown> }) => {
      auditRows.push(args.data);
      return args.data;
    },
  },
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    ops.push("$transaction");
    return fn(fakePrisma);
  },
};
(globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;

const { NextRequest } = await import("next/server");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { DELETE: clearCache } = await import("../src/app/api/admin/clear-cache/route.ts");

let seq = 0;
async function mintAdmin(): Promise<Record<string, string>> {
  seq++;
  const userId = `cc-admin-${seq}`;
  const sessionId = `cc-sess-${seq}`;
  usersById.set(userId, {
    id: userId, role: "ADMIN", permissions: 0n, name: `Admin ${seq}`, email: "admin@example.com",
    mediaServer: null, notificationEmail: null,
    sessionsRevokedAt: null, passwordChangedAt: null, deactivatedAt: null, purgedAt: null,
  });
  authSessionsById.set(sessionId, { userId, deviceLabel: "cc-device", createdAt: new Date() });
  const token = await signSessionJwt(
    { id: userId, role: "ADMIN", permissions: "0", provider: "credentials", sessionId, expiresAt: Math.floor(Date.now() / 1000) + 86_400 },
    { expiresInSeconds: 7_200 },
  );
  return { authorization: `Bearer ${token}` };
}

async function clear(source: string) {
  const headers = await mintAdmin();
  return clearCache(
    new NextRequest(`http://localhost:3000/api/admin/clear-cache?source=${source}`, { method: "DELETE", headers }),
    undefined,
  );
}

// logAudit is fire-and-forget; let it settle.
const flush = () => new Promise((r) => setTimeout(r, 5));
const clearRows = () => auditRows.filter((r) => r.action === "RATINGS_CACHE_CLEAR");

beforeEach(() => {
  ops = [];
  auditRows = [];
  coreThrows = false;
  verdictThrows = false;
});

test("a clear that fails after the TmdbCache wipe still writes one audit row with what it reached, and the error propagates", async () => {
  coreThrows = true;
  await assert.rejects(clear("tmdb"), /connection reset/, "a failed clear must not answer 200");
  await flush();

  const rows = clearRows();
  assert.equal(rows.length, 1, "the half-applied destructive clear must leave exactly one audit row");
  const details = JSON.parse(String(rows[0].details)) as Record<string, unknown>;
  assert.equal(details.source, "tmdb");
  assert.equal(details.cleared, 9, "the TmdbCache rows were already deleted when the next step failed");
  assert.equal(details.coreCleared, 0, "the failed step removed nothing");
  assert.equal(details.edgesCleared, 0);
  assert.equal(details.failed, true);
  assert.match(String(details.error), /connection reset/);
  assert.ok(!ops.includes("$transaction"), "the graph reset never ran after the earlier failure");
});

test("a ratings clear failing on the verdict reset audits the cache rows it had already removed", async () => {
  verdictThrows = true;
  await assert.rejects(clear("mdblist"), /statement timeout/);
  await flush();

  const rows = clearRows();
  assert.equal(rows.length, 1);
  const details = JSON.parse(String(rows[0].details)) as Record<string, unknown>;
  assert.equal(details.cleared, 9);
  assert.equal(details.verdictsCleared, 0);
  assert.equal(details.failed, true);
});

test("a successful clear audits once, with no failure marker", async () => {
  const res = await clear("all");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { source: "all", cleared: 9, coreCleared: 5, edgesCleared: 8, verdictsCleared: 2 });
  await flush();

  const rows = clearRows();
  assert.equal(rows.length, 1);
  const details = JSON.parse(String(rows[0].details)) as Record<string, unknown>;
  assert.equal(details.failed, undefined);
  assert.equal(details.edgesCleared, 8);
});
