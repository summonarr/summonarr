// The permissions editor's per-field save queue
// (src/components/admin/user-modals/field-save.ts). PATCH /api/admin/users/[id]
// takes one field per request, and the editor saves each field through one of
// these:
//
// - a change made while a save is out is never dropped: it goes next, and
//   several changes in that window go as ONE request with the latest value;
// - two saves of one field are never in flight together;
// - a refusal puts the field back to the server's value only while it still
//   shows the refused value — a newer change is kept and sent instead;
// - settled() is what closing waits on.
//
// Each send is a promise the test resolves by hand: no timers, no sleeps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFieldSave } from "../src/components/admin/user-modals/field-save.ts";

function harness(initial: number | null) {
  const sends: { value: number | null; resolve: (ok: boolean) => void; reject: (err: Error) => void }[] = [];
  const reverts: [number | null, number | null][] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const field = createFieldSave<number | null>({
    initial,
    send: (value) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise<boolean>((resolve, reject) => {
        sends.push({
          value,
          resolve: (ok) => { inFlight--; resolve(ok); },
          reject: (err) => { inFlight--; reject(err); },
        });
      });
    },
    revert: (sent, saved) => reverts.push([sent, saved]),
  });
  // Lets the queue reach its next send (it hands each send over on a microtask).
  const tick = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  return { field, sends, reverts, tick, maxInFlight: () => maxInFlight };
}

test("an unchanged value sends nothing", async () => {
  const h = harness(5);
  assert.equal(await h.field.set(5), true);
  await h.tick();
  assert.equal(h.sends.length, 0);
});

test("an unchanged value, then a change: the change is still sent", async () => {
  const h = harness(5);
  await h.field.set(5);
  const run = h.field.set(6);
  await h.tick();
  assert.deepEqual(h.sends.map((s) => s.value), [6]);
  h.sends[0].resolve(true);
  assert.equal(await run, true);
});

test("changes made while a save is out wait for it, then go as ONE request with the latest value", async () => {
  const h = harness(null);
  const first = h.field.set(1);
  await h.tick();
  assert.deepEqual(h.sends.map((s) => s.value), [1]);
  const second = h.field.set(2);
  const third = h.field.set(3);
  assert.equal(second, first, "joins the run in flight");
  assert.equal(third, first);
  await h.tick();
  assert.equal(h.sends.length, 1, "nothing goes beside the save in flight");
  h.sends[0].resolve(true);
  await h.tick();
  assert.deepEqual(h.sends.map((s) => s.value), [1, 3], "the newest value, once");
  h.sends[1].resolve(true);
  assert.equal(await first, true);
  assert.equal(h.maxInFlight(), 1);
  assert.equal(h.field.value, 3);
  assert.deepEqual(h.reverts, []);
});

test("a refusal puts the field back to the server's value while it still shows the refused one", async () => {
  const h = harness(4);
  const run = h.field.set(0);
  await h.tick();
  h.sends[0].resolve(false);
  assert.equal(await run, false);
  assert.deepEqual(h.reverts, [[0, 4]]);
  assert.equal(h.field.value, 4);
  // Nothing left to send: the field shows what the server holds.
  await h.tick();
  assert.equal(h.sends.length, 1);
});

test("a refusal does NOT roll back a newer change: the newer value is sent instead", async () => {
  const h = harness(4);
  const run = h.field.set(0);
  await h.tick();
  h.field.set(5);
  h.sends[0].resolve(false);
  await h.tick();
  assert.deepEqual(h.reverts, [], "the field shows 5, not the refused 0");
  assert.deepEqual(h.sends.map((s) => s.value), [0, 5]);
  h.sends[1].resolve(true);
  assert.equal(await run, true, "the latest value landed");
  assert.equal(h.field.value, 5);
});

test("a later refusal rolls back to the LAST value the server took, not the one the field opened with", async () => {
  const h = harness(1);
  const run = h.field.set(2);
  await h.tick();
  h.field.set(3);
  h.sends[0].resolve(true);
  await h.tick();
  h.sends[1].resolve(false);
  assert.equal(await run, false);
  assert.deepEqual(h.reverts, [[3, 2]]);
  assert.equal(h.field.value, 2);
});

test("a send that throws counts as refused", async () => {
  const h = harness(1);
  const run = h.field.set(2);
  await h.tick();
  h.sends[0].reject(new Error("network"));
  assert.equal(await run, false);
  assert.deepEqual(h.reverts, [[2, 1]]);
});

test("settled() waits on the run in flight and reports its outcome; idle is settled", async () => {
  const h = harness(1);
  assert.equal(await h.field.settled(), true, "nothing in flight");
  h.field.set(2);
  const settled = h.field.settled();
  await h.tick();
  h.sends[0].resolve(false);
  assert.equal(await settled, false, "closing stays open on a refusal");
  // The refusal was already shown: a later close is not held by it.
  assert.equal(await h.field.settled(), true);
});

test("a new change after a run ended starts a new run", async () => {
  const h = harness(1);
  const a = h.field.set(2);
  await h.tick();
  h.sends[0].resolve(true);
  assert.equal(await a, true);
  const b = h.field.set(3);
  assert.notEqual(b, a);
  await h.tick();
  assert.deepEqual(h.sends.map((s) => s.value), [2, 3]);
  h.sends[1].resolve(true);
  assert.equal(await b, true);
});

test("a send that throws at once counts as refused, and the next change is still sent", async () => {
  const sent: number[] = [];
  let calls = 0;
  const field = createFieldSave<number>({
    initial: 1,
    send: (value) => {
      calls++;
      sent.push(value);
      if (calls === 1) throw new Error("bad request body");
      return Promise.resolve(true);
    },
    revert: () => {},
  });
  assert.equal(await field.set(2), false);
  assert.equal(await field.set(3), true, "a run that ended at once must not leave a stale run behind");
  assert.deepEqual(sent, [2, 3]);
});

test("`saved` is what the server holds: the initial value, then each save it took, never a refused one", async () => {
  const answers = [true, false];
  const field = createFieldSave<number>({
    initial: 1,
    send: () => Promise.resolve(answers.shift() ?? true),
    revert: () => {},
  });
  assert.equal(field.saved, 1);
  assert.equal(await field.set(2), true);
  assert.equal(field.saved, 2);
  assert.equal(await field.set(3), false);
  assert.equal(field.saved, 2, "a refusal leaves the server's value");
});
