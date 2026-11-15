// The one abortable wait shared by the bulk search, chunked upload and fix-match
// polling: it resolves on time, early on abort, and at once for a spent signal
// or a non-positive wait. It never rejects.
import { test } from "node:test";

const { abortableSleep } = await import("../src/lib/abortable-sleep.ts");

test("resolves early when the signal aborts", async () => {
  const ctrl = new AbortController();
  const waiting = abortableSleep(60_000, ctrl.signal);
  ctrl.abort();
  await waiting;
});

test("resolves at once for an already-aborted signal or a non-positive wait", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  await abortableSleep(60_000, ctrl.signal);
  await abortableSleep(0, undefined);
  await abortableSleep(-5, null);
});

test("resolves after the wait with no signal", async () => {
  await abortableSleep(5, undefined);
});
