// Keyed async actions for client components (src/hooks/use-async-action.ts).
// The state machine (createAsyncActions) is driven directly: per-key busy
// state, the sequence guard that drops a superseded run's result, abort on a
// re-run, `ifBusy: "skip"`, unmount (dispose) and the Strict Mode remount
// (activate). The hook itself renders once through react-dom/server to pin
// its server snapshot. Every wait here is on a promise the test settles.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement, useState } from "react";
import { renderToString } from "react-dom/server";
import { createAsyncActions, useAsyncAction } from "../src/hooks/use-async-action.ts";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A run body the test answers by hand, recording the signal it was given. */
function scripted<T>() {
  const answer = deferred<T>();
  let signal: AbortSignal | undefined;
  let calls = 0;
  return {
    fn: (s: AbortSignal) => { signal = s; calls++; return answer.promise; },
    answer,
    signal: () => signal,
    calls: () => calls,
  };
}

type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends (<X>() => X extends B ? 1 : 2) ? true : false;
const assertType = <T extends true>(_: T) => {};

test("run resolves to fn's result type, or undefined when the run was dropped", async () => {
  const actions = createAsyncActions();
  const r = await actions.run("k", async () => ({ ok: true as const }));
  assertType<Equal<typeof r, { ok: true } | undefined>>(true);
  assert.deepEqual(r, { ok: true });
});

test("busy is per key: one key's run neither sets nor clears another's", async () => {
  const actions = createAsyncActions();
  const a = scripted<string>();
  const b = scripted<string>();
  const runA = actions.run("approve:1", a.fn);
  const runB = actions.run("approve:2", b.fn);
  assert.equal(actions.busy("approve:1"), true);
  assert.equal(actions.busy("approve:2"), true);
  assert.equal(actions.busy("approve:3"), false);
  assert.equal(actions.anyBusy, true);

  a.answer.resolve("A");
  assert.equal(await runA, "A");
  assert.equal(actions.busy("approve:1"), false);
  assert.equal(actions.busy("approve:2"), true, "the other row is still running");
  assert.equal(actions.anyBusy, true);

  b.answer.resolve("B");
  assert.equal(await runB, "B");
  assert.equal(actions.anyBusy, false);
});

test("re-running a key aborts the run in flight and drops its result, even when it answers last", async () => {
  const actions = createAsyncActions();
  const first = scripted<string>();
  const second = scripted<string>();
  const run1 = actions.run("load", first.fn);
  const run2 = actions.run("load", second.fn);
  assert.equal(first.signal()?.aborted, true, "the superseded run is told to stop");
  assert.equal(second.signal()?.aborted, false);

  second.answer.resolve("fresh");
  assert.equal(await run2, "fresh");
  assert.equal(actions.busy("load"), false);
  // The stale answer arrives after the fresh one: dropped, and the key stays idle.
  first.answer.resolve("stale");
  assert.equal(await run1, undefined);
  assert.equal(actions.busy("load"), false);
});

test("a superseded run that answers first neither returns its value nor ends the newer run's busy state", async () => {
  const actions = createAsyncActions();
  const first = scripted<string>();
  const second = scripted<string>();
  const run1 = actions.run("load", first.fn);
  const run2 = actions.run("load", second.fn);
  first.answer.resolve("stale");
  assert.equal(await run1, undefined);
  assert.equal(actions.busy("load"), true, "the newer run is still in flight");
  second.answer.resolve("fresh");
  assert.equal(await run2, "fresh");
  assert.equal(actions.busy("load"), false);
});

test("ifBusy skip leaves the run in flight alone and runs nothing", async () => {
  const actions = createAsyncActions();
  const first = scripted<string>();
  const second = scripted<string>();
  const run1 = actions.run("submit", first.fn);
  const skipped = actions.run("submit", second.fn, { ifBusy: "skip" });
  assert.equal(second.calls(), 0);
  assert.equal(first.signal()?.aborted, false);
  second.answer.resolve("never sent");
  assert.equal(await skipped, undefined);
  first.answer.resolve("sent once");
  assert.equal(await run1, "sent once");
  // Idle again: skip runs.
  const third = scripted<string>();
  const run3 = actions.run("submit", third.fn, { ifBusy: "skip" });
  assert.equal(third.calls(), 1);
  third.answer.resolve("again");
  assert.equal(await run3, "again");
});

test("abort(key) stops that run, clears its busy state and drops its result; abort() stops them all", async () => {
  const actions = createAsyncActions();
  const a = scripted<string>();
  const b = scripted<string>();
  const c = scripted<string>();
  const runA = actions.run("a", a.fn);
  const runB = actions.run("b", b.fn);
  const runC = actions.run("c", c.fn);
  actions.abort("a");
  assert.equal(a.signal()?.aborted, true);
  assert.equal(actions.busy("a"), false);
  assert.equal(actions.busy("b"), true);
  a.answer.resolve("late");
  assert.equal(await runA, undefined);

  actions.abort("nothing-running");
  actions.abort();
  assert.equal(b.signal()?.aborted, true);
  assert.equal(c.signal()?.aborted, true);
  assert.equal(actions.anyBusy, false);
  b.answer.resolve("late");
  c.answer.reject(new DOMException("aborted", "AbortError"));
  assert.equal(await runB, undefined);
  assert.equal(await runC, undefined, "an aborted run's rejection is swallowed with its result");
});

test("a current run's error is rethrown and its busy state cleared; a dropped run's error is swallowed", async () => {
  const actions = createAsyncActions();
  await assert.rejects(actions.run("save", async () => { throw new Error("bug in fn"); }), /bug in fn/);
  assert.equal(actions.busy("save"), false);
  // A synchronous throw from a non-async fn is caught the same way.
  await assert.rejects(actions.run("save", () => { throw new Error("sync bug"); }), /sync bug/);
  assert.equal(actions.busy("save"), false);

  const first = scripted<string>();
  const run1 = actions.run("save", first.fn);
  const second = scripted<string>();
  const run2 = actions.run("save", second.fn);
  first.answer.reject(new Error("stale failure"));
  assert.equal(await run1, undefined);
  second.answer.resolve("ok");
  assert.equal(await run2, "ok");
});

test("dispose (unmount) aborts every run, drops their results, refuses new runs and notifies no one", async () => {
  const actions = createAsyncActions();
  let notified = 0;
  actions.subscribe(() => { notified++; });
  const a = scripted<string>();
  const runA = actions.run("a", a.fn);
  const before = notified;
  actions.dispose();
  assert.equal(notified, before, "no state update for a component that is going away");
  assert.equal(a.signal()?.aborted, true);
  assert.equal(actions.anyBusy, false);
  a.answer.resolve("after unmount");
  assert.equal(await runA, undefined);

  const b = scripted<string>();
  const afterUnmount = actions.run("b", b.fn);
  assert.equal(b.calls(), 0, "a run after unmount never starts");
  b.answer.resolve("never");
  assert.equal(await afterUnmount, undefined);
});

test("activate after dispose (Strict Mode's remount) accepts runs again, and the old run stays dropped", async () => {
  const actions = createAsyncActions();
  const old = scripted<string>();
  const runOld = actions.run("load", old.fn);
  actions.dispose();
  actions.activate();
  const fresh = scripted<string>();
  const runFresh = actions.run("load", fresh.fn);
  assert.equal(fresh.calls(), 1);
  assert.equal(actions.busy("load"), true);
  old.answer.resolve("from before the remount");
  assert.equal(await runOld, undefined);
  assert.equal(actions.busy("load"), true, "the old run can't end the new one");
  fresh.answer.resolve("after");
  assert.equal(await runFresh, "after");
});

test("the snapshot changes only when the set of busy keys does, and every change notifies", async () => {
  const actions = createAsyncActions();
  let notified = 0;
  const unsubscribe = actions.subscribe(() => { notified++; });
  const idle = actions.snapshot();
  assert.equal(idle.size, 0);

  const first = scripted<string>();
  const run1 = actions.run("load", first.fn);
  const busy = actions.snapshot();
  assert.deepEqual([...busy], ["load"]);
  assert.equal(notified, 1);
  assert.notEqual(busy, idle);

  // A restart of the same key: still busy, same snapshot, no re-render.
  const second = scripted<string>();
  const run2 = actions.run("load", second.fn);
  assert.equal(actions.snapshot(), busy);
  assert.equal(notified, 1);

  second.answer.resolve("x");
  await run2;
  assert.equal(notified, 2);
  assert.equal(actions.snapshot().size, 0);
  first.answer.resolve("y");
  await run1;
  assert.equal(notified, 2, "a dropped run publishes nothing");

  unsubscribe();
  await actions.run("other", async () => "z");
  assert.equal(notified, 2, "an unsubscribed listener hears nothing");
});

test("the hook renders on the server with nothing busy, and hands back the same object on a re-render", () => {
  const seen: unknown[] = [];
  function Row() {
    const action = useAsyncAction();
    // A render-phase update makes React render this component again at once,
    // with its state kept: the second render must see the same action object.
    const [pass, setPass] = useState(0);
    if (pass === 0) setPass(1);
    seen.push(action);
    return createElement("button", { disabled: action.busy("approve:1") }, action.anyBusy ? "busy" : "idle");
  }
  const html = renderToString(createElement(Row));
  assert.equal(html, "<button>idle</button>");
  assert.equal(seen.length, 2);
  assert.equal(seen[0], seen[1]);
  const action = seen[0] as Record<string, unknown>;
  assert.equal(typeof action.run, "function");
  assert.equal(typeof action.abort, "function");
});
