// Audit fix g-docs#1 (wave B2, nw-data): the never-watched report's 2-minute
// cache (never-watched-report.ts) is dropped by every Summonarr write that
// changes one of its inputs from outside the report's own admin actions:
//   - PATCH /api/settings flipping a tracking switch (on OR off), retention, or
//     the cleanup / never-watched feature flag — after the commit, never before
//     (a failed transaction drops nothing);
//   - the title manager's Add (the report's copies and "eligible" read the arr
//     index the Add changes — its sibling Remove already did this).
// Harness: tests/settings-route.test.mts's recording fake prisma, seeded on
// globalThis before the module graph loads. No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto at load
process.env.NEXTAUTH_SECRET = "settings-route-test-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000"; // unprefixed cookie name + trusted origin
process.env.TRUST_PROXY = "true"; // silence rate-limit's module-load warning

// ── console capture (guardrail 7: warn/error only; no console.log in tests) ───
const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// ── scripted fetch (connection-test paths only) ──────────────────────────────
type FetchCall = { url: URL; method: string };
const fetchCalls: FetchCall[] = [];
const respond: (url: URL) => Response | Promise<Response> = (url) => {
  throw new Error(`unexpected fetch ${url} — script a responder for this test`);
};
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  fetchCalls.push({ url, method: init?.method ?? "GET" });
  return respond(url);
}) as typeof fetch;


// ── recording fake prisma (seeded on globalThis before the module graph) ─────
// One shared in-memory Setting store: top-level reads (findMany/findUnique) and
// in-tx writes (upsert/deleteMany) all go through it, so a connection-test read
// AFTER the write observes the freshly-written value — exactly like the real DB.
const settings = new Map<string, string>();

// Every tx.setting.upsert arg, in order — THE guardrail-7a surface. `create.value`
// / `update.value` here are whatever the route produced; the assertions demand
// they equal the submitted plaintext (never `enc:v1:…`).
type UpsertArgs = { where: { key: string }; update: { value: string }; create: { key: string; value: string } };
const upsertCalls: UpsertArgs[] = [];
const deleteManyCalls: Array<{ where: { key: string } }> = [];
const auditAttempts: Array<Record<string, unknown>> = [];
const auditRows: Array<Record<string, unknown>> = [];
let auditThrows = false;
// Every top-level setting.findMany key filter, in order. The Discord slash-command
// re-registration task's FIRST step is a findMany over exactly the three
// registration keys, so its presence/absence here pins whether the (fire-and-
// forget) task was launched at all — without seeding a bot token, so it returns
// before safeFetchTrusted would touch DNS.
const findManyKeys: Array<string[] | null> = [];

type DbUser = {
  id: string; role: string; permissions: bigint; name: string | null; email: string | null;
  mediaServer: string | null; notificationEmail: string | null;
  sessionsRevokedAt: Date | null; passwordChangedAt: Date | null; deactivatedAt: Date | null;
};
const usersById = new Map<string, DbUser>();
const authSessionsById = new Map<string, { userId: string }>();

function makeTx() {
  return {
    setting: {
      upsert: async (args: UpsertArgs) => {
        upsertCalls.push(args);
        // create.value === update.value in this route; store either so a later
        // connection-test findMany sees the written value.
        settings.set(args.where.key, args.create.value);
        return { key: args.where.key, value: args.create.value };
      },
      deleteMany: async (args: { where: { key: string } }) => {
        deleteManyCalls.push(args);
        settings.delete(args.where.key);
        return { count: 1 };
      },
    },
    auditLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        auditAttempts.push(args.data);
        if (auditThrows) throw new Error("audit insert exploded (unit test)");
        auditRows.push(args.data);
        return args.data;
      },
    },
  };
}

const fakePrisma = {
  user: {
    findUnique: async (args: { where: { id: string } }) => {
      const u = usersById.get(args.where.id);
      return u ? { ...u } : null;
    },
    update: async () => ({}),
  },
  authSession: {
    findUnique: async (args: { where: { sessionId: string } }) =>
      authSessionsById.has(args.where.sessionId)
        ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId }
        : null,
    update: async () => ({}), // lastSeenAt fire-and-forget touch
  },
  setting: {
    findMany: async (args?: { where?: { key?: { in?: string[] } } }) => {
      const only = args?.where?.key?.in;
      findManyKeys.push(only ?? null);
      const rows = [...settings.entries()].map(([key, value]) => ({ key, value }));
      return only ? rows.filter((r) => only.includes(r.key)) : rows;
    },
    findUnique: async (args: { where: { key: string } }) => {
      const value = settings.get(args.where.key);
      return value === undefined ? null : { key: args.where.key, value };
    },
  },
  $transaction: async (arg: unknown, _opts?: { timeout?: number }) => {
    if (typeof arg === "function") return (arg as (t: ReturnType<typeof makeTx>) => Promise<unknown>)(makeTx());
    return Promise.all(arg as Promise<unknown>[]);
  },
};
(globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;

const { NextRequest } = await import("next/server");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { PATCH } = await import("../src/app/api/settings/route.ts");
const { processSingleton } = await import("../src/lib/process-singleton.ts");
const { readFileSync } = await import("node:fs");

// The same process-wide object never-watched-report.ts caches the report in.
const reportCache = processSingleton("never-watched:report", () => ({ value: null as unknown, at: 0, generation: -1, version: 0 }));

let seq = 0;
async function mintSession(role: string): Promise<Record<string, string>> {
  seq++;
  const userId = `actor-${seq}`;
  const sessionId = `actor-sess-${seq}`;
  usersById.set(userId, {
    id: userId, role, permissions: 0n, name: `Actor ${seq}`, email: "admin@example.com",
    mediaServer: null, notificationEmail: null,
    sessionsRevokedAt: null, passwordChangedAt: null, deactivatedAt: null,
  });
  authSessionsById.set(sessionId, { userId });
  const token = await signSessionJwt(
    { id: userId, role, permissions: "0", provider: "credentials", sessionId, expiresAt: Math.floor(Date.now() / 1000) + 86_400 },
    { expiresInSeconds: 7_200 },
  );
  return { authorization: `Bearer ${token}` };
}
const patch = async (body: Record<string, string>) =>
  PATCH(new NextRequest("http://localhost:3000/api/settings", {
    method: "PATCH", headers: { "content-type": "application/json", ...(await mintSession("ADMIN")) }, body: JSON.stringify(body),
  }), undefined);

beforeEach(() => {
  auditThrows = false;
  upsertCalls.length = 0;
  deleteManyCalls.length = 0;
  auditAttempts.length = 0;
  auditRows.length = 0;
  fetchCalls.length = 0;
  findManyKeys.length = 0;
  settings.clear();
  reportCache.value = { stale: true };
});

// Each key is written once (the route's per-key 10 s cooldown is module-private).
for (const [label, body] of [
  ["a tracking switch turned ON", { playHistoryPlexEnabled: "true" }],
  ["a tracking switch turned OFF", { playHistoryEnabled: "false" }],
  ["the play-history retention", { playHistoryRetentionDays: "30" }],
  ["the cleanup feature flag", { "feature.admin.cleanup": "true" }],
  ["the never-watched feature flag", { "feature.admin.neverWatched": "false" }],
] as const) {
  test(`settings PATCH of ${label} drops the cached never-watched report after the commit`, async () => {
    const before = reportCache.version;
    const res = await patch(body);
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(reportCache.version, before + 1);
    assert.equal(reportCache.value, null);
  });
}

test("settings PATCH of an unrelated key leaves the report cache alone", async () => {
  const before = reportCache.version;
  assert.equal((await patch({ siteTitle: "Renamed" })).status, 200);
  assert.equal(reportCache.version, before);
  assert.notEqual(reportCache.value, null);
});

test("a settings transaction that fails drops nothing — the invalidation is after the commit", async () => {
  auditThrows = true;
  const before = reportCache.version;
  const res = await patch({ playHistoryJellyfinEnabled: "true" });
  assert.equal(res.status, 500);
  assert.equal(reportCache.version, before);
  assert.notEqual(reportCache.value, null);
});

test("the title manager's Add drops the report right after the arr accepted it (structural: beside the arr index invalidation, past every refusal)", () => {
  const src = readFileSync(new URL("../src/app/api/admin/arr/title/add/route.ts", import.meta.url), "utf8");
  const post = src.slice(src.indexOf("export const POST"));
  const accepted = post.indexOf("result = await addTitle(");
  const lastRefusal = post.lastIndexOf("return arrFailure(err, target, t, \"title add\");");
  const call = post.indexOf("invalidateNeverWatchedReport();");
  assert.ok(accepted > 0 && lastRefusal > accepted, "the add and its refusals are where this test expects them");
  assert.ok(call > lastRefusal, "invalidated only once the arr accepted the add");
  assert.ok(call < post.indexOf("void logAudit("), "beside the index invalidation, before the audit");
  assert.match(src, /import \{ invalidateNeverWatchedReport \} from "@\/lib\/never-watched-report";/);
});
