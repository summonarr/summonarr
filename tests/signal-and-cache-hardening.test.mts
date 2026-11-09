import test from "node:test";
import assert from "node:assert/strict";
import { anySignal } from "../src/lib/client/plex-done-flow.ts";
import { clearCandidateCache, getCachedCandidates, setCachedCandidates } from "../src/lib/fix-match-candidate-cache.ts";

test("the fallback signal combiner detaches its listeners once it aborts", () => {
  const original = (AbortSignal as { any?: unknown }).any;
  (AbortSignal as { any?: unknown }).any = undefined;
  try {
    const a = new AbortController();
    const b = new AbortController();
    let removed = 0;
    const realRemove = b.signal.removeEventListener.bind(b.signal);
    b.signal.removeEventListener = ((...args: Parameters<typeof realRemove>) => { removed++; return realRemove(...args); }) as typeof realRemove;
    const combined = anySignal(a.signal, b.signal);
    a.abort("stop");
    assert.equal(combined.aborted, true);
    assert.equal(removed, 1, "the listener on the other input is removed");
  } finally {
    (AbortSignal as { any?: unknown }).any = original;
  }
});

test("a cached candidates body handed out is a copy the caller can edit", () => {
  clearCandidateCache();
  setCachedCandidates("k", { list: [1] }, 0);
  const first = getCachedCandidates<{ list: number[] }>("k", 1);
  first!.list.push(2);
  assert.deepEqual(getCachedCandidates("k", 2), { list: [1] });
});
