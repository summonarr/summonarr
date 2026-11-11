// src/lib/arr-watch-trigger.ts — the webhook-driven Radarr/Sonarr monitor run
// that keeps the admin nav's Download Queue count following the queue.
//
// What is pinned:
//   1. Nothing is scheduled until the server's boot arms it.
//   2. A burst of webhooks is ONE run, after the settle time; a request during
//      a run asks for exactly one more; runs start a spacing window apart.
//   3. A run that found the lock busy is asked again, a bounded number of
//      times; "nothing to watch" is not.
//   4. A failed run is swallowed and the schedule keeps working.
//   5. The wiring: the webhook asks only for a first, authenticated delivery;
//      the cron route and the trigger share ONE job config; boot arms it.
//
// Mock timers and a stubbed run: no DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "arr-watch-trigger-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000";
console.warn = () => {};

const {
  requestArrWatchRecount,
  recountDelayMs,
  __resetArrWatchRecountForTests,
  RECOUNT_SETTLE_MS,
  RECOUNT_MIN_SPACING_MS,
  RECOUNT_MAX_BUSY_RETRIES,
} = await import("../src/lib/arr-watch-trigger.ts");
type Outcome = import("../src/lib/arr-watch-trigger.ts").RecountOutcome;

const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
// Let a resolved run's continuation (the `finally` and the re-schedule) land.
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

let runs = 0;
let next: Array<Outcome | Error> = [];
let release: (() => void) | null = null;
let hold = false;
async function run(): Promise<Outcome> {
  runs++;
  if (hold) await new Promise<void>((r) => { release = r; });
  const out = next.shift() ?? "ran";
  if (out instanceof Error) throw out;
  return out;
}

beforeEach(() => {
  runs = 0;
  next = [];
  release = null;
  hold = false;
  __resetArrWatchRecountForTests(run);
});

test("unarmed (no server boot), a request schedules nothing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  __resetArrWatchRecountForTests();
  requestArrWatchRecount();
  t.mock.timers.tick(10 * RECOUNT_MIN_SPACING_MS);
  await settle();
  assert.equal(runs, 0);
});

test("a burst of webhooks is one run, after the settle time", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  for (let i = 0; i < 40; i++) requestArrWatchRecount();
  t.mock.timers.tick(RECOUNT_SETTLE_MS - 1);
  await settle();
  assert.equal(runs, 0, "ran before the arr's queue could settle");
  t.mock.timers.tick(1);
  await settle();
  assert.equal(runs, 1);
  t.mock.timers.tick(10 * RECOUNT_MIN_SPACING_MS);
  await settle();
  assert.equal(runs, 1, "nothing asked again, so nothing ran again");
});

test("runs start a spacing window apart, and requests during a run ask for exactly one more", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  hold = true;
  requestArrWatchRecount();
  t.mock.timers.tick(RECOUNT_SETTLE_MS);
  await settle();
  assert.equal(runs, 1);
  // Mid-run: many requests, one follow-up.
  for (let i = 0; i < 10; i++) requestArrWatchRecount();
  t.mock.timers.tick(1_000);
  hold = false;
  release!();
  await settle();
  // The follow-up waits out the spacing measured from the first run's START.
  t.mock.timers.tick(RECOUNT_MIN_SPACING_MS - 1_000 - 1);
  await settle();
  assert.equal(runs, 1, "a second run started inside the spacing window");
  t.mock.timers.tick(1);
  await settle();
  assert.equal(runs, 2);
  t.mock.timers.tick(10 * RECOUNT_MIN_SPACING_MS);
  await settle();
  assert.equal(runs, 2, "ten requests during a run became more than one follow-up");
});

test("recountDelayMs: the settle time, or what is left of the spacing", () => {
  assert.equal(recountDelayMs(1_000_000, 0), RECOUNT_SETTLE_MS);
  assert.equal(recountDelayMs(1_000_000, 1_000_000 - 1_000), RECOUNT_MIN_SPACING_MS - 1_000);
  assert.equal(recountDelayMs(1_000_000, 1_000_000 - 10 * RECOUNT_MIN_SPACING_MS), RECOUNT_SETTLE_MS);
  assert.ok(RECOUNT_MIN_SPACING_MS >= 30_000, "a monitor run reads disk, history and queue on every instance — not more than twice a minute");
});

test("a busy lock is asked again a bounded number of times; nothing-to-watch is not", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  next = Array.from({ length: 20 }, () => "busy" as const);
  requestArrWatchRecount();
  for (let i = 0; i < 20; i++) {
    t.mock.timers.tick(RECOUNT_MIN_SPACING_MS);
    await settle();
  }
  assert.equal(runs, 1 + RECOUNT_MAX_BUSY_RETRIES, "a lock held for good must not be probed forever");

  runs = 0;
  __resetArrWatchRecountForTests(run);
  next = ["skipped"];
  requestArrWatchRecount();
  for (let i = 0; i < 5; i++) {
    t.mock.timers.tick(RECOUNT_MIN_SPACING_MS);
    await settle();
  }
  assert.equal(runs, 1);
});

test("a failed run is swallowed and the next webhook still schedules one", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  next = [new Error("lock connection refused")];
  requestArrWatchRecount();
  t.mock.timers.tick(RECOUNT_SETTLE_MS);
  await settle();
  assert.equal(runs, 1);
  requestArrWatchRecount();
  t.mock.timers.tick(RECOUNT_MIN_SPACING_MS);
  await settle();
  assert.equal(runs, 2);
});

test("wiring: first authenticated deliveries ask, one job config serves both callers, boot arms it", () => {
  const hook = stripComments(src("../src/lib/arr-webhook.ts"));
  // After the replay check (so a replayed or unauthenticated POST costs nothing) and before dispatch.
  assert.match(hook, /if \(!firstDelivery\) \{[\s\S]*?\}\s*requestArrWatchRecount\(\);[\s\S]*?await dispatch\(/);
  assert.equal(hook.match(/requestArrWatchRecount\(\)/g)?.length, 1);
  assert.match(stripComments(src("../src/app/api/cron/arr-watch/route.ts")), /export const POST = defineCronRoute\(ARR_WATCH_CRON\);/);
  const trigger = stripComments(src("../src/lib/arr-watch-trigger.ts"));
  assert.match(trigger, /runCronRoute\(ARR_WATCH_CRON, CRON_SYSTEM_ACTOR\)/);
  assert.ok(!/\bfetch\(/.test(trigger), "the trigger must stay in-process (guardrail 5b)");
  assert.match(stripComments(src("../src/instrumentation.ts")), /armArrWatchRecount\(\)/);
});
