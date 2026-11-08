// The toast stack keeps only the newest few (src/components/ui/toast-queue.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_TOASTS, pushCapped } from "../src/components/ui/toast-queue.ts";

const item = (id: number) => ({ id, title: `t${id}` });

test("below the cap a toast is appended and nothing is evicted", () => {
  const { kept, evicted } = pushCapped([item(1), item(2)], item(3), 5);
  assert.deepEqual(kept.map((t) => t.id), [1, 2, 3]);
  assert.deepEqual(evicted, []);
});

test("at the cap the oldest is evicted and its id returned for timer cleanup", () => {
  const full = [1, 2, 3, 4, 5].map(item);
  const { kept, evicted } = pushCapped(full, item(6), 5);
  assert.deepEqual(kept.map((t) => t.id), [2, 3, 4, 5, 6]);
  assert.deepEqual(evicted, [1]);
});

test("a burst never grows the stack past the cap", () => {
  let list: Array<{ id: number; title: string }> = [];
  const allEvicted: number[] = [];
  for (let id = 1; id <= 40; id++) {
    const r = pushCapped(list, item(id));
    list = r.kept;
    allEvicted.push(...r.evicted);
    assert.ok(list.length <= MAX_TOASTS);
  }
  assert.deepEqual(list.map((t) => t.id), [36, 37, 38, 39, 40]);
  assert.equal(allEvicted.length, 40 - MAX_TOASTS);
  assert.deepEqual(allEvicted.slice(0, 3), [1, 2, 3]);
});

test("the input list is not mutated", () => {
  const list = [1, 2, 3, 4, 5].map(item);
  pushCapped(list, item(6), 5);
  assert.equal(list.length, 5);
});
