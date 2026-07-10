// Unit tests for the shared SSE emitter (src/lib/sse-emitter.ts). One "event"
// listener is registered per open SSE connection in /api/events, and the route's
// concurrent-connection cap is defined AS the emitter's max-listener cap
// (MAX_TOTAL_CONNECTIONS = SSE_MAX_LISTENERS) — so the exported constant, the
// applied emitter cap, and the env knob must agree, and subscribe/unsubscribe
// bookkeeping must be exact or connection slots leak. The globalThis persistence
// is what keeps live connections alive across Next.js hot reloads.
//
// The module reads SSE_MAX_LISTENERS once at evaluation, so each configuration
// is exercised via a cache-busted dynamic re-import (`?bust=N`). Re-imports
// deliberately reuse the same global emitter — that is itself the behavior
// under test.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SSEEvent } from "../src/lib/sse-emitter.ts";

type SseModule = typeof import("../src/lib/sse-emitter.ts");

let bust = 0;
async function loadWithEnv(envValue: string | undefined): Promise<SseModule> {
  if (envValue === undefined) delete process.env.SSE_MAX_LISTENERS;
  else process.env.SSE_MAX_LISTENERS = envValue;
  bust += 1;
  return (await import(`../src/lib/sse-emitter.ts?bust=${bust}`)) as SseModule;
}

// First evaluation: a small, valid cap so the over-cap warning test below can
// actually exceed it without registering 500 listeners.
const mod = await loadWithEnv("7");
const { sseEmitter, emitSSE } = mod;

test("a valid SSE_MAX_LISTENERS env knob sets both the export and the emitter cap", () => {
  assert.equal(mod.SSE_MAX_LISTENERS, 7);
  // The exported constant and the applied cap must move together — /api/events
  // derives its total-connection limit from the export while Node enforces the
  // warning threshold from the applied cap.
  assert.equal(sseEmitter.getMaxListeners(), 7);
});

test("emitSSE fans out synchronously to every 'event' listener with the exact event object", () => {
  const seenA: SSEEvent[] = [];
  const seenB: SSEEvent[] = [];
  const seenOther: SSEEvent[] = [];
  const a = (e: SSEEvent) => void seenA.push(e);
  const b = (e: SSEEvent) => void seenB.push(e);
  const other = (e: SSEEvent) => void seenOther.push(e);
  sseEmitter.on("event", a);
  sseEmitter.on("event", b);
  sseEmitter.on("not-the-sse-channel", other);
  try {
    const evt: SSEEvent = { type: "request:new", requestId: "req_1", userId: "u_1" };
    emitSSE(evt);
    // No await: /api/events relies on delivery completing during emit (its
    // back-pressure check runs inside the listener call).
    assert.equal(seenA.length, 1);
    assert.equal(seenB.length, 1);
    assert.equal(seenA[0], evt); // same reference, not a copy
    assert.equal(seenB[0], evt);
    // emitSSE publishes on the "event" channel only — the channel name is the
    // contract /api/events subscribes to.
    assert.equal(seenOther.length, 0);
  } finally {
    sseEmitter.off("event", a);
    sseEmitter.off("event", b);
    sseEmitter.off("not-the-sse-channel", other);
  }
});

test("unsubscribe releases the slot: listenerCount drops and the removed listener goes silent", () => {
  const seenA: SSEEvent[] = [];
  const seenB: SSEEvent[] = [];
  const a = (e: SSEEvent) => void seenA.push(e);
  const b = (e: SSEEvent) => void seenB.push(e);
  const before = sseEmitter.listenerCount("event");
  sseEmitter.on("event", a);
  sseEmitter.on("event", b);
  assert.equal(sseEmitter.listenerCount("event"), before + 2);

  emitSSE({ type: "activity:history-updated" });
  assert.equal(seenA.length, 1);
  assert.equal(seenB.length, 1);

  // Mirrors /api/events cleanup(): sseEmitter.off("event", listener).
  sseEmitter.off("event", a);
  assert.equal(sseEmitter.listenerCount("event"), before + 1);

  emitSSE({ type: "plex:reachability", reachable: false });
  assert.equal(seenA.length, 1); // removed listener received nothing further
  assert.equal(seenB.length, 2); // surviving listener still receives
  assert.deepEqual(seenB[1], { type: "plex:reachability", reachable: false });

  sseEmitter.off("event", b);
  assert.equal(sseEmitter.listenerCount("event"), before);
});

test("the cap admits exactly SSE_MAX_LISTENERS listeners silently; one more warns", async () => {
  sseEmitter.removeAllListeners("event"); // clean slate so the count is exact
  const warnings: Error[] = [];
  const onWarning = (w: Error) => {
    if (w.name === "MaxListenersExceededWarning") warnings.push(w);
  };
  process.on("warning", onWarning);
  const listeners: Array<() => void> = [];
  try {
    for (let i = 0; i < 7; i++) {
      const fn = () => { };
      listeners.push(fn);
      sseEmitter.on("event", fn);
    }
    // Warnings are emitted on a later tick; drain it before asserting.
    await new Promise((r) => setImmediate(r));
    assert.equal(warnings.length, 0); // exactly at the cap: no warning

    const overflow = () => { };
    listeners.push(overflow);
    sseEmitter.on("event", overflow);
    await new Promise((r) => setImmediate(r));
    assert.equal(warnings.length, 1); // cap + 1: MaxListenersExceededWarning
    assert.match(warnings[0].message, /listeners added/);
  } finally {
    process.off("warning", onWarning);
    for (const fn of listeners) sseEmitter.off("event", fn);
  }
  assert.equal(sseEmitter.listenerCount("event"), 0);
});

test("hot-reload persistence: a re-import reuses the same emitter and live listeners survive", async () => {
  const seen: SSEEvent[] = [];
  const listener = (e: SSEEvent) => void seen.push(e);
  sseEmitter.on("event", listener);
  try {
    const mod2 = await loadWithEnv("9");
    // Same instance via globalThis.__sseEmitter — a hot reload must not drop
    // live SSE connections by minting a fresh emitter.
    assert.equal(mod2.sseEmitter, sseEmitter);
    // The re-evaluation re-reads the knob and re-tunes the shared emitter.
    assert.equal(mod2.SSE_MAX_LISTENERS, 9);
    assert.equal(sseEmitter.getMaxListeners(), 9);
    // A listener registered before the reload still receives events emitted
    // through the new module instance.
    mod2.emitSSE({ type: "issue:new", issueId: "i_1", userId: "u_2" });
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], { type: "issue:new", issueId: "i_1", userId: "u_2" });
  } finally {
    sseEmitter.off("event", listener);
  }
});

test("invalid, non-positive, or unset SSE_MAX_LISTENERS falls back to 500", async () => {
  for (const bad of ["0", "-3", "abc", "", undefined]) {
    const fresh = await loadWithEnv(bad);
    assert.equal(fresh.SSE_MAX_LISTENERS, 500, `env=${JSON.stringify(bad)}`);
    assert.equal(sseEmitter.getMaxListeners(), 500, `env=${JSON.stringify(bad)}`);
  }
});

test("pins parseInt prefix semantics: '12.9' → 12 and '1e3' → 1 (NOT the 500 fallback)", async () => {
  // Current behavior: parseInt stops at the first non-digit, so a decimal or
  // scientific-notation value is silently prefix-truncated instead of being
  // treated as invalid. '1e3' yielding a cap of 1 (not 1000) is the sharp edge.
  const decimal = await loadWithEnv("12.9");
  assert.equal(decimal.SSE_MAX_LISTENERS, 12);
  const scientific = await loadWithEnv("1e3");
  assert.equal(scientific.SSE_MAX_LISTENERS, 1);
});
