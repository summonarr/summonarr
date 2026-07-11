// Unit tests for the bounded-concurrency runners (src/lib/concurrency.ts).
// Guardrail 31 routes every user/library-sized async fan-out through these, so
// the load-bearing properties are: the in-flight cap is NEVER exceeded (the
// whole point — Prisma pool / TMDB / OMDB protection), results preserve input
// order regardless of completion order, mapLimit mirrors Promise.all rejection
// semantics, and settleLimit never rejects and returns real settled shapes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapLimit, settleLimit } from "../src/lib/concurrency.ts";

/** Defer a tick so worker interleaving actually happens (no timers → no flake). */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Wraps a task fn with a live in-flight counter so tests can assert the
 * concurrency bound. `ticks` controls how many event-loop turns each task
 * spans, forcing overlap between workers.
 */
function instrumented<T, R>(fn: (item: T, index: number) => R, ticks = 2) {
  let inFlight = 0;
  let maxInFlight = 0;
  const task = async (item: T, index: number): Promise<R> => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    for (let t = 0; t < ticks; t++) await tick();
    inFlight--;
    return fn(item, index);
  };
  return { task, max: () => maxInFlight, live: () => inFlight };
}

// ---------------------------------------------------------------------------
// mapLimit
// ---------------------------------------------------------------------------

test("mapLimit: results preserve input order even when completion order is reversed", async () => {
  const items = [0, 1, 2, 3, 4, 5];
  // Later items resolve sooner: item i waits (n - i) ticks.
  const results = await mapLimit(items, 3, async (item) => {
    for (let t = 0; t < items.length - item; t++) await tick();
    return `r${item}`;
  });
  assert.deepEqual(results, ["r0", "r1", "r2", "r3", "r4", "r5"]);
});

test("mapLimit: never exceeds the concurrency limit", async () => {
  const items = Array.from({ length: 20 }, (_, i) => i);
  const { task, max, live } = instrumented<number, number>((item) => item * 2, 3);
  const results = await mapLimit(items, 4, task);
  assert.equal(max(), 4); // fully utilizes the cap on a 20-item list...
  assert.ok(max() <= 4); // ...and never exceeds it
  assert.equal(live(), 0); // everything drained before the promise resolved
  assert.deepEqual(
    results,
    items.map((i) => i * 2),
  );
});

test("mapLimit: limit=1 runs tasks strictly sequentially", async () => {
  const startOrder: number[] = [];
  const { task, max } = instrumented<number, number>((item, index) => {
    void item;
    return index;
  }, 2);
  const sequential = async (item: number, index: number): Promise<number> => {
    startOrder.push(index);
    return task(item, index);
  };
  const results = await mapLimit([10, 20, 30, 40], 1, sequential);
  assert.equal(max(), 1);
  assert.deepEqual(startOrder, [0, 1, 2, 3]); // no task starts before the prior finishes
  assert.deepEqual(results, [0, 1, 2, 3]);
});

test("mapLimit: limit >= items.length behaves like Promise.all (all in flight at once)", async () => {
  const items = [1, 2, 3];
  const { task, max } = instrumented<number, string>((item) => `v${item}`, 2);
  const results = await mapLimit(items, 100, task);
  assert.equal(max(), 3); // workers are clamped to items.length, all overlap
  assert.deepEqual(results, ["v1", "v2", "v3"]);
});

test("mapLimit: empty input resolves to [] without invoking fn", async () => {
  let calls = 0;
  const results = await mapLimit([], 5, async () => {
    calls++;
    return 1;
  });
  assert.deepEqual(results, []);
  assert.equal(calls, 0);
});

test("mapLimit: passes the correct index alongside each item", async () => {
  const seen: Array<[string, number]> = [];
  await mapLimit(["a", "b", "c"], 2, async (item, index) => {
    seen.push([item, index]);
    await tick();
  });
  seen.sort((x, y) => x[1] - y[1]);
  assert.deepEqual(seen, [
    ["a", 0],
    ["b", 1],
    ["c", 2],
  ]);
});

test("mapLimit: rejects when any task rejects (Promise.all semantics)", async () => {
  const boom = new Error("task 2 failed");
  await assert.rejects(
    mapLimit([0, 1, 2, 3], 2, async (item) => {
      await tick();
      if (item === 2) throw boom;
      return item;
    }),
    boom,
  );
});

test("mapLimit: a rejection stops workers from claiming further items", async () => {
  // With limit=1 the single worker dies on item 0; items 1+ must never run.
  const started: number[] = [];
  await assert.rejects(
    mapLimit([0, 1, 2], 1, async (item) => {
      started.push(item);
      throw new Error("first task fails");
    }),
    /first task fails/,
  );
  assert.deepEqual(started, [0]);
});

test("mapLimit: garbage limits (0, negative, NaN, fractional) clamp to a sane worker count", async () => {
  for (const limit of [0, -3, Number.NaN, 0.4]) {
    const { task, max } = instrumented<number, number>((item) => item, 2);
    const results = await mapLimit([1, 2, 3], limit, task);
    assert.equal(max(), 1, `limit=${limit} should clamp to 1 worker`);
    assert.deepEqual(results, [1, 2, 3]);
  }
  // Fractional limits floor: 2.9 → 2 workers.
  const { task, max } = instrumented<number, number>((item) => item, 2);
  await mapLimit([1, 2, 3, 4, 5, 6], 2.9, task);
  assert.equal(max(), 2);
});

// ---------------------------------------------------------------------------
// settleLimit
// ---------------------------------------------------------------------------

test("settleLimit: mixed outcomes return settled shapes in input order, promise never rejects", async () => {
  const err1 = new Error("fail-1");
  const results = await settleLimit([0, 1, 2, 3], 2, async (item) => {
    await tick();
    if (item % 2 === 1) throw err1;
    return item * 10;
  });
  assert.deepEqual(results, [
    { status: "fulfilled", value: 0 },
    { status: "rejected", reason: err1 },
    { status: "fulfilled", value: 20 },
    { status: "rejected", reason: err1 },
  ]);
});

test("settleLimit: all tasks run even when every one rejects", async () => {
  let calls = 0;
  const results = await settleLimit([1, 2, 3, 4, 5], 2, async (item) => {
    calls++;
    await tick();
    throw new Error(`e${item}`);
  });
  assert.equal(calls, 5);
  assert.equal(results.length, 5);
  for (const [i, r] of results.entries()) {
    assert.equal(r.status, "rejected");
    if (r.status === "rejected") {
      assert.ok(r.reason instanceof Error);
      assert.equal(r.reason.message, `e${i + 1}`);
    }
  }
});

test("settleLimit: non-Error throw values are preserved as the rejection reason", async () => {
  const results = await settleLimit(["x"], 1, async () => {
    throw "a string reason";
  });
  assert.deepEqual(results, [{ status: "rejected", reason: "a string reason" }]);
});

test("settleLimit: respects the concurrency limit", async () => {
  const items = Array.from({ length: 12 }, (_, i) => i);
  const { task, max } = instrumented<number, number>((item) => item, 3);
  const results = await settleLimit(items, 3, task);
  assert.equal(max(), 3);
  assert.deepEqual(
    results,
    items.map((i) => ({ status: "fulfilled" as const, value: i })),
  );
});

test("settleLimit: empty input resolves to []", async () => {
  const results = await settleLimit([], 4, async () => 1);
  assert.deepEqual(results, []);
});

test("settleLimit: matches Promise.allSettled output for the same tasks", async () => {
  const run = async (item: number): Promise<number> => {
    await tick();
    if (item === 1) throw new Error("nope");
    return item + 100;
  };
  const items = [0, 1, 2];
  const viaSettleLimit = await settleLimit(items, 2, run);
  const viaAllSettled = await Promise.allSettled(items.map((i) => run(i)));
  // Reasons are distinct Error instances per invocation; compare shape/message.
  assert.equal(viaSettleLimit.length, viaAllSettled.length);
  for (let i = 0; i < items.length; i++) {
    const a = viaSettleLimit[i];
    const b = viaAllSettled[i];
    assert.equal(a.status, b.status);
    if (a.status === "fulfilled" && b.status === "fulfilled") {
      assert.equal(a.value, b.value);
    }
    if (a.status === "rejected" && b.status === "rejected") {
      assert.equal((a.reason as Error).message, (b.reason as Error).message);
    }
  }
});
