// src/lib/cron-route.ts — the one wrapper every /api/cron/* route is built on:
// the cron gate (guardrail 6), the pre-lock skip and the busy skip through
// cronSkippedResponse (7b), the run ledger, the advisory lock and its signal
// (41), the CACHE_WARM audit for admin-run warms, and the run answer (200
// either way; ok:false + `error` + a numeric X-Cron-Degraded on problems).
//
// tests/cron-routes.test.mts drives every real route through it; this file pins
// the wrapper itself. Harness: in-memory prisma stubs and a stubbed pg Client
// prototype (the withAdvisoryLock seam). No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "pg";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "cron-route-test-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000";
process.env.DATABASE_URL = "postgres://u:p@127.0.0.1:5432/db"; // Client.prototype is stubbed; never dialed
const CRON_SECRET = "cron-route-cron-secret-0123456789abcdef";
process.env.CRON_SECRET = CRON_SECRET;
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

console.warn = () => {};
console.error = () => {};

let lockCalls: string[] = [];
let lockFree = true;
const pgProto = Client.prototype as unknown as {
  connect: () => Promise<void>;
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
  end: () => Promise<void>;
};
pgProto.connect = async () => { lockCalls.push("connect"); };
pgProto.query = async (text) => {
  if (text.includes("pg_try_advisory_lock")) {
    lockCalls.push("try");
    return { rows: [{ acquired: lockFree }] };
  }
  if (text.includes("pg_advisory_unlock")) lockCalls.push("unlock");
  return { rows: [] };
};
pgProto.end = async () => {};

const { NextRequest } = await import("next/server");
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const { defineCronRoute, runCronRoute, cronRunResponse } = await import("../src/lib/cron-route.ts");
const { CRON_SYSTEM_ACTOR } = await import("../src/lib/cron-auth.ts");
const { CRON_DEGRADED_HEADER, CRON_SKIPPED_HEADER } = await import("../src/lib/cron-run-outcome.ts");
const { WARM_ACTIVITY_LOCK_ID } = await import("../src/lib/advisory-lock.ts");
type CronRouteConfig = import("../src/lib/cron-route.ts").CronRouteConfig;
type CronActor = import("../src/lib/cron-auth.ts").CronActor;

const ledger = new Map<string, string>();
const audits: Array<{ data: Record<string, unknown> }> = [];
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    const value = ledger.get(args.where.key);
    return value === undefined ? null : { value };
  },
  upsert: async (args: { where: { key: string }; create: { value: string } }) => {
    ledger.set(args.where.key, args.create.value);
    return {};
  },
});
shadowPrismaModel(prisma, "auditLog", {
  create: async (args: { data: Record<string, unknown> }) => { audits.push(args); return { id: "a" }; },
});

const ADMIN: CronActor = { userId: "admin-1", userName: "Ada", trigger: "admin" };

function ledgerEntry(target: string): { ok: boolean; durationMs: number } | null {
  const raw = ledger.get(`cron:lastRun:${target}`);
  return raw ? JSON.parse(raw) as { ok: boolean; durationMs: number } : null;
}

function config(over: Partial<CronRouteConfig> = {}): CronRouteConfig {
  return {
    target: "unit-test-job",
    lockId: WARM_ACTIVITY_LOCK_ID,
    run: async () => ({ body: { warmed: 3 } }),
    ...over,
  };
}

beforeEach(() => {
  lockCalls = [];
  lockFree = true;
  ledger.clear();
  audits.length = 0;
});

test("the wrapper's gate is getCronActor, read before anything else, answering 401", () => {
  // scripts/audit-routes.mts accepts defineCronRoute / withCronActor as the cron
  // guard by NAME (it does not follow imports), so this pin is what keeps that
  // trust honest.
  const src = readFileSync(new URL("../src/lib/cron-route.ts", import.meta.url), "utf8");
  const gate = src.slice(src.indexOf("export function withCronActor"), src.indexOf("export function defineCronRoute"));
  assert.match(
    gate,
    /return async \(request\) => \{\s*const actor = await getCronActor\(request\);\s*if \(!actor\) return NextResponse\.json\(\{ error: "Unauthorized" \}, \{ status: 401 \}\);\s*return handler\(request, actor\);/,
  );
  const define = src.slice(src.indexOf("export function defineCronRoute"), src.indexOf("export async function runCronRoute"));
  assert.match(define, /return withCronActor\(/, "defineCronRoute is built on the gate");
});

test("unauthorized: 401 before the skip check, the lock and the work", async () => {
  let checked = false;
  let ran = false;
  const POST = defineCronRoute(config({
    skipReason: () => { checked = true; return null; },
    run: async () => { ran = true; return { body: {} }; },
  }));
  for (const headers of [{}, { authorization: "Bearer not-the-secret-0123456789abcdefgh" }] as Array<Record<string, string>>) {
    const res = await POST(new NextRequest("http://localhost:3000/api/cron/x", { method: "POST", headers }));
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "Unauthorized" });
  }
  assert.equal(checked, false);
  assert.equal(ran, false);
  assert.deepEqual(lockCalls, []);
  assert.equal(ledger.size, 0);
});

test("the CRON_SECRET bearer runs the job as the system actor", async () => {
  let seen: CronActor | null = null;
  const POST = defineCronRoute(config({ run: async ({ actor }) => { seen = actor; return { body: {} }; } }));
  const res = await POST(new NextRequest("http://localhost:3000/api/cron/x", {
    method: "POST",
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  }));
  assert.equal(res.status, 200);
  assert.deepEqual(seen, CRON_SYSTEM_ACTOR);
});

test("a skip reason answers cronSkippedResponse: no lock connection, no run, no ledger row", async () => {
  let ran = false;
  const res = await runCronRoute(config({
    skipReason: async () => "feature disabled",
    run: async () => { ran = true; return { body: {} }; },
  }), CRON_SYSTEM_ACTOR);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { skipped: true, reason: "feature disabled" });
  assert.equal(res.headers.get(CRON_SKIPPED_HEADER), "1");
  assert.equal(ran, false);
  assert.deepEqual(lockCalls, [], "decided before the lock");
  assert.equal(ledger.size, 0, "no run happened, so none is recorded (guardrail 7b)");
});

test("a busy lock answers the 'already running' skip, never runs and records nothing", async () => {
  lockFree = false;
  let ran = false;
  const res = await runCronRoute(config({ run: async () => { ran = true; return { body: {} }; } }), CRON_SYSTEM_ACTOR);
  assert.deepEqual(await res.json(), { skipped: true, reason: "already running" });
  assert.equal(res.headers.get(CRON_SKIPPED_HEADER), "1");
  assert.equal(ran, false);
  assert.deepEqual(lockCalls, ["connect", "try"], "a lock it never held is never unlocked");
  assert.equal(ledger.size, 0);
});

test("a clean run: 200 { ok: true, ...body, timestamp }, no error, no degraded header, one ok ledger row, lock released", async () => {
  const res = await runCronRoute(config(), CRON_SYSTEM_ACTOR);
  assert.equal(res.status, 200);
  const body = await res.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), ["ok", "warmed", "timestamp"]);
  assert.equal(body.ok, true);
  assert.equal(body.warmed, 3);
  assert.ok(!Number.isNaN(Date.parse(String(body.timestamp))));
  assert.equal(res.headers.get(CRON_DEGRADED_HEADER), null);
  assert.equal(ledgerEntry("unit-test-job")?.ok, true);
  assert.deepEqual(lockCalls, ["connect", "try", "unlock"]);
});

test("a run with problems: still 200, ok:false + error, X-Cron-Degraded is the count, the ledger records a failure", async () => {
  const res = await runCronRoute(config({
    run: async () => ({ body: { failed: 2 }, problems: 2, error: "2 items failed" }),
  }), CRON_SYSTEM_ACTOR);
  assert.equal(res.status, 200, "the entrypoint fast-retries any non-2xx");
  const body = await res.json() as Record<string, unknown>;
  assert.equal(body.ok, false);
  assert.equal(body.error, "2 items failed");
  assert.equal(body.failed, 2);
  assert.equal(res.headers.get(CRON_DEGRADED_HEADER), "2");
  assert.equal(ledgerEntry("unit-test-job")?.ok, false);
});

test("an `error` on a clean run is not sent: the admin badge reads any `error` as a failure", async () => {
  const res = await runCronRoute(config({
    run: async () => ({ body: {}, problems: 0, error: "0 items failed" }),
  }), CRON_SYSTEM_ACTOR);
  const body = await res.json() as Record<string, unknown>;
  assert.equal(body.ok, true);
  assert.equal("error" in body, false);
});

test("problems with no message still carry an `error`", () => {
  const res = cronRunResponse({ body: {}, problems: 3 });
  assert.equal(res.headers.get(CRON_DEGRADED_HEADER), "3");
  return res.json().then((b: { error?: unknown }) => assert.equal(typeof b.error, "string"));
});

test("a Response from the run passes through unchanged, and a 5xx is recorded as a failed run", async () => {
  const res = await runCronRoute(config({
    run: async () => Response.json({ ok: false, error: "purge failed" }, { status: 500 }),
  }), CRON_SYSTEM_ACTOR);
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { ok: false, error: "purge failed" });
  assert.equal(ledgerEntry("unit-test-job")?.ok, false);
  assert.deepEqual(lockCalls, ["connect", "try", "unlock"]);
});

test("a run that throws is recorded once as failed, rethrown, and releases the lock", async () => {
  await assert.rejects(
    runCronRoute(config({ run: async () => { throw new Error("warm exploded"); } }), CRON_SYSTEM_ACTOR),
    /warm exploded/,
  );
  assert.equal(ledgerEntry("unit-test-job")?.ok, false);
  assert.ok(lockCalls.includes("unlock"));
});

test("a cache warm writes ONE CACHE_WARM audit for an admin run — with the body, durationMs and trigger — and none for the scheduler", async () => {
  const warm = config({ cacheWarm: true, run: async () => ({ body: { warmed: 7, total: 9 } }) });
  await runCronRoute(warm, CRON_SYSTEM_ACTOR);
  assert.equal(audits.length, 0, "scheduled runs stay out of the audit log");

  await runCronRoute(warm, ADMIN);
  assert.equal(audits.length, 1);
  const row = audits[0].data;
  assert.equal(row.action, "CACHE_WARM");
  assert.equal(row.target, "unit-test-job");
  assert.equal(row.userId, "admin-1");
  const details = JSON.parse(String(row.details)) as Record<string, unknown>;
  assert.equal(details.warmed, 7);
  assert.equal(details.total, 9);
  assert.equal(details.trigger, "admin");
  assert.equal(typeof details.durationMs, "number");

  audits.length = 0;
  await runCronRoute(config({ run: async () => ({ body: {} }) }), ADMIN);
  assert.equal(audits.length, 0, "only routes marked cacheWarm audit");
});

test("the run gets the lock's signal and the job's own work timeout", async () => {
  // timeoutMs reaches withAdvisoryLock: the signal aborts, the caller gets the
  // timeout error, and the run is recorded as failed.
  let seen: AbortSignal | null = null;
  await assert.rejects(
    runCronRoute(config({
      timeoutMs: 20,
      run: ({ signal }) => {
        seen = signal;
        return new Promise((resolve) => signal.addEventListener("abort", () => resolve({ body: {} }), { once: true }));
      },
    }), CRON_SYSTEM_ACTOR),
    (err: unknown) => (err as Error).name === "AdvisoryLockTimeoutError",
  );
  assert.equal((seen as AbortSignal | null)?.aborted, true);
  assert.equal(ledgerEntry("unit-test-job")?.ok, false);
});
