// POST /api/cron/purge-notifications + src/lib/notification-retention.ts.
// Notification rows are never removed otherwise, so the cron deletes READ rows
// past NOTIFICATION_READ_RETENTION_DAYS (90) and ANY row past
// NOTIFICATION_RETENTION_DAYS (365), by createdAt, in id batches.
//
// Harness: the real handler over an in-memory notification table that
// evaluates the where-shape the lib builds, and a stubbed pg Client (the
// withAdvisoryLock seam) — no DB, no network. The real-Postgres twin is
// tests/db/notification-retention.test.mts.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "pg";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "purge-notif-test-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
process.env.DATABASE_URL = "postgres://u:p@127.0.0.1:5432/db";
const CRON_SECRET = "purge-notif-cron-secret-0123456789abcdef";
process.env.CRON_SECRET = CRON_SECRET;
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const errors: string[] = [];
console.warn = () => {};
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

let lockCalls: Array<{ op: string; lockId: number }> = [];
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
  }
  return { rows: [] };
};
pgProto.end = async () => {};

globalThis.fetch = (() => { throw new Error("unexpected network call"); }) as unknown as typeof fetch;

const { NextRequest } = await import("next/server");
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const AL = await import("../src/lib/advisory-lock.ts");
const lib = await import("../src/lib/notification-retention.ts");
const { POST } = await import("../src/app/api/cron/purge-notifications/route.ts");

type Row = { id: string; createdAt: Date; readAt: Date | null };
let rows: Row[] = [];
let findManyCalls = 0;
let deleteWheres: unknown[] = [];

type Clause = { createdAt?: { lt: Date }; readAt?: { not: null } };
function matches(r: Row, c: Clause): boolean {
  if (c.createdAt && !(r.createdAt < c.createdAt.lt)) return false;
  if (c.readAt && r.readAt === null) return false;
  return true;
}
shadowPrismaModel(prisma, "notification", {
  findMany: async (args: { where: { OR: Clause[] }; take: number }) => {
    findManyCalls++;
    return rows.filter((r) => args.where.OR.some((c) => matches(r, c))).slice(0, args.take).map((r) => ({ id: r.id }));
  },
  deleteMany: async (args: { where: { id: { in: string[] } } }) => {
    deleteWheres.push(args.where);
    const ids = new Set(args.where.id.in);
    const before = rows.length;
    rows = rows.filter((r) => !ids.has(r.id));
    return { count: before - rows.length };
  },
});
shadowPrismaModel(prisma, "setting", {
  findUnique: async () => null,
  upsert: async () => ({}),
  update: async () => ({}),
  create: async () => ({}),
  createMany: async () => ({ count: 1 }),
});
const audits: unknown[] = [];
shadowPrismaModel(prisma, "auditLog", { create: async (a: unknown) => { audits.push(a); return {}; } });
shadowPrismaModel(prisma, "cronRun", { create: async () => ({}), upsert: async () => ({}), findMany: async () => [] });
shadowPrismaModel(prisma, "user", { findUnique: async () => null, findFirst: async () => null });

const DAY = 86_400_000;
const now = new Date("2026-06-01T00:00:00Z");
const ago = (days: number) => new Date(now.getTime() - days * DAY);
function authed(secret = CRON_SECRET) {
  return new NextRequest("http://localhost:3000/api/cron/purge-notifications", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
  });
}

beforeEach(() => {
  rows = []; findManyCalls = 0; deleteWheres = []; lockCalls = []; lockFree = true; errors.length = 0; audits.length = 0;
  delete process.env.NOTIFICATION_READ_RETENTION_DAYS;
  delete process.env.NOTIFICATION_RETENTION_DAYS;
});

test("Notification declares an index led by createdAt — the purge reads across every user by createdAt", () => {
  // The only other indexes lead with userId, which the purge's where-shape never
  // names, so each batch was a sequential scan plus a sort.
  const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
  const model = /^model Notification \{([\s\S]*?)^\}/m.exec(schema);
  assert.ok(model, "Notification model did not parse");
  const leads = [...model[1].matchAll(/^\s*@@index\(\[([^\]]*)\]/gm)].map((m) => m[1].split(",")[0].trim().replace(/\(.*\)$/, ""));
  assert.ok(leads.length >= 2, `Notification's @@index lines did not parse: ${JSON.stringify(leads)}`);
  assert.ok(leads.includes("createdAt"), `no Notification index leads with createdAt: ${JSON.stringify(leads)}`);
});

test("lock id is its own: distinct from every other cron lock", () => {
  const ids = Object.entries(AL).filter(([k, v]) => k.endsWith("_LOCK_ID") && typeof v === "number").map(([, v]) => v as number);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(AL.PURGE_NOTIFICATIONS_LOCK_ID, 2091);
});

test("unauthorized: 401 and no lock, no query", async () => {
  const res = await POST(new NextRequest("http://localhost:3000/api/cron/purge-notifications", { method: "POST", headers: { authorization: "Bearer wrong" } }));
  assert.equal(res.status, 401);
  assert.equal(lockCalls.length, 0);
  assert.equal(findManyCalls, 0);
});

test("retention rules: old read and ancient rows go; recent, unread-under-365 survive", async () => {
  rows = [
    { id: "read-old", createdAt: ago(100), readAt: ago(99) },       // read, >90d  -> delete
    { id: "read-new", createdAt: ago(30), readAt: ago(29) },        // read, <90d  -> keep
    { id: "unread-old", createdAt: ago(200), readAt: null },        // unread <365 -> keep
    { id: "unread-ancient", createdAt: ago(400), readAt: null },    // >365        -> delete
    { id: "read-ancient", createdAt: ago(400), readAt: ago(10) },   // >365        -> delete
    { id: "unread-new", createdAt: ago(1), readAt: null },          // keep
  ];
  const out = await lib.purgeOldNotifications({ now });
  assert.equal(out.deleted, 3);
  assert.deepEqual(rows.map((r) => r.id).sort(), ["read-new", "unread-new", "unread-old"]);
});

test("env configures both windows; the ceiling is never below the read window; floor is 7 days", () => {
  assert.deepEqual(lib.notificationRetentionDays({} as NodeJS.ProcessEnv), { readDays: 90, maxDays: 365 });
  assert.deepEqual(
    lib.notificationRetentionDays({ NOTIFICATION_READ_RETENTION_DAYS: "30", NOTIFICATION_RETENTION_DAYS: "60" } as unknown as NodeJS.ProcessEnv),
    { readDays: 30, maxDays: 60 },
  );
  assert.deepEqual(
    lib.notificationRetentionDays({ NOTIFICATION_READ_RETENTION_DAYS: "200", NOTIFICATION_RETENTION_DAYS: "100" } as unknown as NodeJS.ProcessEnv),
    { readDays: 200, maxDays: 200 },
  );
  assert.deepEqual(
    lib.notificationRetentionDays({ NOTIFICATION_READ_RETENTION_DAYS: "0", NOTIFICATION_RETENTION_DAYS: "abc" } as unknown as NodeJS.ProcessEnv),
    { readDays: 7, maxDays: 365 },
  );
});

test("deletes run in bounded id batches", async () => {
  const n = lib.NOTIFICATION_DELETE_BATCH * 2 + 5;
  rows = Array.from({ length: n }, (_, i) => ({ id: `n${i}`, createdAt: ago(500), readAt: null }));
  const out = await lib.purgeOldNotifications({ now });
  assert.equal(out.deleted, n);
  assert.equal(deleteWheres.length, 3);
  assert.ok(deleteWheres.every((w) => (w as { id: { in: string[] } }).id.in.length <= lib.NOTIFICATION_DELETE_BATCH));
});

test("an aborted signal stops before the next batch (guardrail 41)", async () => {
  rows = Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, createdAt: ago(500), readAt: null }));
  const ac = new AbortController();
  ac.abort();
  const out = await lib.purgeOldNotifications({ now, signal: ac.signal });
  assert.equal(out.aborted, true);
  assert.equal(out.deleted, 0);
  assert.equal(rows.length, 10);
});

test("route: authorized run purges, takes and releases its lock, audits", async () => {
  process.env.NOTIFICATION_READ_RETENTION_DAYS = "90";
  rows = [
    { id: "a", createdAt: new Date(Date.now() - 100 * DAY), readAt: new Date() },
    { id: "b", createdAt: new Date(), readAt: null },
  ];
  const res = await POST(authed());
  assert.equal(res.status, 200);
  const body = await res.json() as { ok: boolean; deleted: number };
  assert.equal(body.ok, true);
  assert.equal(body.deleted, 1);
  assert.deepEqual(rows.map((r) => r.id), ["b"]);
  assert.deepEqual(lockCalls, [
    { op: "try", lockId: AL.PURGE_NOTIFICATIONS_LOCK_ID },
    { op: "unlock", lockId: AL.PURGE_NOTIFICATIONS_LOCK_ID },
  ]);
  assert.equal(audits.length, 1);
});

test("route: a busy lock skips without touching the table", async () => {
  lockFree = false;
  rows = [{ id: "a", createdAt: ago(900), readAt: null }];
  const res = await POST(authed());
  const body = await res.json() as { skipped?: boolean };
  assert.equal(body.skipped, true);
  assert.equal(findManyCalls, 0);
  assert.equal(rows.length, 1);
});
