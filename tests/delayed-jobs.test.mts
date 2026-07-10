// Unit tests for the delayed-job scheduler (src/lib/delayed-jobs.ts) — the
// bounded, best-effort timer + worker pool behind post-sync follow-ups. Its
// safety properties are the caps: DELAYED_JOBS_MAX_PENDING rejects at schedule
// time (caller gets `false`), DELAYED_JOBS_MAX_QUEUE drops at fire time (the
// caller already got `true` — the loss is logged at error level), and
// DELAYED_JOBS_MAX_CONCURRENCY bounds simultaneous workers. Invalid knob
// values (garbage, zero, negative, unset) must fall back to the defaults
// (500/100/4), and a failing job must release its worker slot instead of
// poisoning the pool. The knobs are read once at module evaluation, so each
// configuration is exercised via a cache-busted dynamic re-import (`?bust=N`),
// mirroring sse-emitter.test.mts.
import { test } from "node:test";
import assert from "node:assert/strict";

type DelayedJobsModule = typeof import("../src/lib/delayed-jobs.ts");

let bust = 0;
async function loadWithEnv(knobs: {
  pending?: string;
  queue?: string;
  concurrency?: string;
}): Promise<DelayedJobsModule> {
  const set = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  set("DELAYED_JOBS_MAX_PENDING", knobs.pending);
  set("DELAYED_JOBS_MAX_QUEUE", knobs.queue);
  set("DELAYED_JOBS_MAX_CONCURRENCY", knobs.concurrency);
  bust += 1;
  return (await import(`../src/lib/delayed-jobs.ts?bust=${bust}`)) as DelayedJobsModule;
}

// Silences and records console.warn/console.error so cap-drop messages can be
// asserted exactly (they carry the effective cap value — the only way to
// observe what the knob parsed to).
function capture(method: "warn" | "error"): { messages: string[]; restore: () => void } {
  const original = console[method];
  const messages: string[] = [];
  console[method] = (...args: unknown[]) => {
    messages.push(args.map(String).join(" "));
  };
  return {
    messages,
    restore: () => {
      console[method] = original;
    },
  };
}

// A manually-opened latch: jobs awaiting it stay "running" and hold their
// worker slot until the test releases them.
function gate(): { promise: Promise<void>; open: () => void } {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, open: () => release?.() };
}

function waitFor(cond: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      if (cond()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for ${what}`));
      }
    }, 2);
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Instance with tiny, explicitly-valid knobs: pending 2, queue 1, concurrency 1.
const small = await loadWithEnv({ pending: "2", queue: "1", concurrency: "1" });
// Instance where every knob is invalid a different way: garbage, zero, negative
// — all three must fall back to the defaults (500 / 100 / 4).
const defaults = await loadWithEnv({ pending: "abc", queue: "0", concurrency: "-4" });
// Instance pinning parseInt semantics: "1.9" truncates to 1.
const fractional = await loadWithEnv({ pending: "1.9", queue: "10", concurrency: "2" });
// Instance with the knobs entirely unset (the undefined branch of the parser).
const unset = await loadWithEnv({});

test("pending cap: admits exactly MAX_PENDING timers, rejects the overflow at schedule time", async () => {
  const warn = capture("warn");
  let ran = 0;
  const fn = async () => {
    ran += 1;
  };
  try {
    assert.equal(small.scheduleDelayed(1, fn, { name: "p1" }), true);
    assert.equal(small.scheduleDelayed(1, fn, { name: "p2" }), true);
    // Third outstanding timer exceeds the cap of 2 → rejected synchronously.
    assert.equal(small.scheduleDelayed(1, fn, { name: "p3" }), false);
    assert.equal(warn.messages.length, 1);
    assert.match(warn.messages[0], /\[delayed-jobs\] dropping "p3": pending cap reached \(2\)/);
    await waitFor(() => ran === 2, "the two admitted jobs to run");
    // A fired timer frees its pending slot: capacity is restored.
    assert.equal(small.scheduleDelayed(1, fn, { name: "p4" }), true);
    await waitFor(() => ran === 3, "the post-drain job to run");
    assert.equal(ran, 3); // the rejected job never executed
    assert.equal(warn.messages.length, 1); // and warned exactly once
  } finally {
    warn.restore();
  }
});

test("concurrency cap of 1 serializes: the second job waits until the first releases its worker", async () => {
  const g = gate();
  let started = 0;
  let finished = 0;
  const fn = async () => {
    started += 1;
    await g.promise;
    finished += 1;
  };
  assert.equal(small.scheduleDelayed(1, fn, { name: "c1" }), true);
  assert.equal(small.scheduleDelayed(1, fn, { name: "c2" }), true);
  await waitFor(() => started === 1, "the first worker to start");
  await sleep(30); // give a broken pool the chance to (wrongly) start the second
  assert.equal(started, 1); // exactly one concurrent worker
  g.open();
  await waitFor(() => finished === 2, "both jobs to finish");
  assert.equal(started, 2);
});

test("queue cap: a job admitted at schedule time (true) is dropped at fire time when the queue is full", async () => {
  const err = capture("error");
  const g = gate();
  let started = 0;
  let finished = 0;
  let overflowRan = false;
  const blocker = async () => {
    started += 1;
    await g.promise;
    finished += 1;
  };
  try {
    assert.equal(small.scheduleDelayed(1, blocker, { name: "q-active" }), true);
    await waitFor(() => started === 1, "the blocking job to occupy the worker");
    assert.equal(small.scheduleDelayed(1, blocker, { name: "q-queued" }), true);
    await sleep(30); // its timer fires → it now fills the 1-slot queue
    // Admission still succeeds — the pending-timer cap is the only schedule-time
    // check. The drop happens later, at fire time.
    assert.equal(
      small.scheduleDelayed(1, async () => {
        overflowRan = true;
      }, { name: "q-overflow" }),
      true,
    );
    await waitFor(() => err.messages.length === 1, "the fire-time drop to be logged");
    assert.match(
      err.messages[0],
      /\[delayed-jobs\] dropping "q-overflow" at fire time: queue cap reached \(1\)/,
    );
    g.open();
    await waitFor(() => finished === 2, "the two surviving jobs to finish");
    await sleep(30);
    assert.equal(overflowRan, false); // dropped for good — best-effort, no retry
    assert.equal(started, 2);
  } finally {
    err.restore();
  }
});

test("a failing job is logged with its name and releases its worker slot for the next job", async () => {
  const err = capture("error");
  let survivorRan = false;
  // Throws synchronously: the Promise.resolve().then wrapper must still route
  // it to the catch instead of letting it escape the pump.
  const boom = (): Promise<void> => {
    throw new Error("kaboom");
  };
  try {
    assert.equal(small.scheduleDelayed(1, boom, { name: "explodes" }), true);
    assert.equal(
      small.scheduleDelayed(1, async () => {
        survivorRan = true;
      }, { name: "survivor" }),
      true,
    );
    // Concurrency is 1: the survivor can only run if the failed job's .finally
    // decremented activeWorkers and re-pumped.
    await waitFor(() => survivorRan, "the job after the failure to run");
    assert.equal(err.messages.length, 1);
    assert.match(err.messages[0], /\[delayed-jobs\] job "explodes" failed:.*kaboom/);
  } finally {
    err.restore();
  }
});

test("invalid knobs fall back to defaults: unparseable MAX_PENDING becomes 500", async () => {
  const warn = capture("warn");
  let ran = 0;
  const fn = async () => {
    ran += 1;
  };
  try {
    for (let i = 0; i < 500; i++) {
      assert.equal(defaults.scheduleDelayed(1, fn, { name: `bulk-${i}` }), true);
    }
    // The 501st outstanding timer is rejected — pinning the default exactly.
    assert.equal(defaults.scheduleDelayed(1, fn, { name: "bulk-overflow" }), false);
    assert.equal(warn.messages.length, 1);
    assert.match(warn.messages[0], /pending cap reached \(500\)/);
    await waitFor(() => ran === 500, "all 500 admitted jobs to drain");
    assert.equal(ran, 500);
  } finally {
    warn.restore();
  }
});

test("invalid knobs fall back to defaults: zero queue → 100 slots, negative concurrency → 4 workers", async () => {
  const err = capture("error");
  const g = gate();
  let started = 0;
  let finished = 0;
  const fn = async () => {
    started += 1;
    await g.promise;
    finished += 1;
  };
  try {
    // 105 gate-blocked jobs: 4 occupy the default worker pool, 100 fill the
    // default queue, and the 105th is dropped at fire time.
    for (let i = 0; i < 105; i++) {
      assert.equal(defaults.scheduleDelayed(1, fn, { name: `flood-${i}` }), true);
    }
    await waitFor(() => err.messages.length === 1, "the queue-cap drop to be logged");
    assert.match(err.messages[0], /dropping "flood-104" at fire time: queue cap reached \(100\)/);
    assert.equal(started, 4); // default concurrency, not the configured -4
    g.open();
    await waitFor(() => finished === 104, "the 104 surviving jobs to drain");
    assert.equal(started, 104); // 105 admitted, exactly 1 dropped
    assert.equal(err.messages.length, 1);
  } finally {
    err.restore();
  }
});

test("parseInt semantics: MAX_PENDING of '1.9' truncates to a cap of 1", async () => {
  const warn = capture("warn");
  let ran = 0;
  const fn = async () => {
    ran += 1;
  };
  try {
    assert.equal(fractional.scheduleDelayed(1, fn, { name: "f1" }), true);
    assert.equal(fractional.scheduleDelayed(1, fn, { name: "f2" }), false);
    assert.match(warn.messages[0], /pending cap reached \(1\)/);
    await waitFor(() => ran === 1, "the admitted job to run");
    assert.equal(fractional.scheduleDelayed(1, fn, { name: "f3" }), true);
    await waitFor(() => ran === 2, "the follow-up job to run");
  } finally {
    warn.restore();
  }
});

test("unset knobs use the defaults: 4 concurrent workers", async () => {
  const g = gate();
  let started = 0;
  let finished = 0;
  const fn = async () => {
    started += 1;
    await g.promise;
    finished += 1;
  };
  for (let i = 0; i < 6; i++) {
    assert.equal(unset.scheduleDelayed(1, fn, { name: `u-${i}` }), true);
  }
  await waitFor(() => started === 4, "the default-sized worker pool to fill");
  await sleep(30); // a >4 pool would have started the queued jobs by now
  assert.equal(started, 4);
  g.open();
  await waitFor(() => finished === 6, "all six jobs to finish");
  assert.equal(started, 6);
});
