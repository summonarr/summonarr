// /api/health's database probe (src/lib/health-probe.ts). The route is
// anonymous and each probe is a query on the small shared pool, so the answer
// is remembered briefly and concurrent requests share one query:
//   - a burst of requests costs ONE `SELECT 1`;
//   - a healthy answer is reused for HEALTH_UP_TTL_MS, a failed one for the
//     shorter HEALTH_DOWN_TTL_MS, so recovery is seen quickly;
//   - the route's wire answers are unchanged: 200 {ok:true,db:"up"} / 503
//     {ok:false,db:"down"}.
//
// No DB: prisma.$queryRaw is shadowed; the clock is injected.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaClientMethod } = await import("./_helpers.mts");
const { probeDatabase, __resetHealthProbeForTests, HEALTH_UP_TTL_MS, HEALTH_DOWN_TTL_MS } = await import("../src/lib/health-probe.ts");
const health = await import("../src/app/api/health/route.ts");

let queries = 0;
let dbUp = true;
let gate: Promise<void> | null = null;
shadowPrismaClientMethod(prisma, "$queryRaw", async () => {
  queries++;
  if (gate) await gate;
  if (!dbUp) throw new Error("connection refused");
  return [{ "?column?": 1 }];
});

const errors: string[] = [];
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

let clock = 1_000_000;
const now = () => clock;

beforeEach(() => {
  __resetHealthProbeForTests();
  queries = 0;
  dbUp = true;
  gate = null;
  errors.length = 0;
});

test("concurrent probes share one query", async () => {
  let release: () => void = () => {};
  gate = new Promise<void>((r) => { release = r; });
  const burst = Array.from({ length: 25 }, () => probeDatabase(now));
  release();
  assert.deepEqual(new Set(await Promise.all(burst)), new Set([true]));
  assert.equal(queries, 1);
});

test("a healthy answer is reused for its short window, then probed again", async () => {
  assert.equal(await probeDatabase(now), true);
  clock += HEALTH_UP_TTL_MS - 1;
  assert.equal(await probeDatabase(now), true);
  assert.equal(queries, 1, "inside the window: no second query");
  clock += 1;
  assert.equal(await probeDatabase(now), true);
  assert.equal(queries, 2, "past it: a fresh probe");
});

test("an outage is reported, logged once per real probe, and kept for less time than a healthy answer", async () => {
  assert.ok(HEALTH_DOWN_TTL_MS < HEALTH_UP_TTL_MS);
  dbUp = false;
  assert.equal(await probeDatabase(now), false);
  assert.equal(await probeDatabase(now), false);
  assert.equal(queries, 1);
  assert.equal(errors.filter((e) => e.includes("[health]")).length, 1);
  // The database comes back: seen as soon as the short failure window ends.
  dbUp = true;
  clock += HEALTH_DOWN_TTL_MS;
  assert.equal(await probeDatabase(now), true);
  assert.equal(queries, 2);
});

test("a healthy answer never outlives its window into an outage", async () => {
  assert.equal(await probeDatabase(now), true);
  dbUp = false;
  clock += HEALTH_UP_TTL_MS;
  assert.equal(await probeDatabase(now), false);
});

test("the route answers exactly as before, and a request loop costs one query", async () => {
  for (let i = 0; i < 50; i++) {
    const res = await health.GET();
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, db: "up" });
  }
  assert.equal(queries, 1);

  __resetHealthProbeForTests();
  dbUp = false;
  const down = await health.GET();
  assert.equal(down.status, 503);
  assert.deepEqual(await down.json(), { ok: false, db: "down" });
});
