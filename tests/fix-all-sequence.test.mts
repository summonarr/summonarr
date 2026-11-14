// The bulk "Fix all" loop (src/lib/client/fix-all-sequence.ts) shared by the
// library diff and the library match check: one remap at a time, stoppable
// between titles, quiet on an abort, and every title's outcome kept.
import { test } from "node:test";
import assert from "node:assert/strict";

const { runFixAllSequence, fixAllProgress } = await import("../src/lib/client/fix-all-sequence.ts");

const entry = (key: string) => ({ key, title: `T ${key}`, request: { server: "plex" as const, mediaType: "MOVIE" as const, correctTmdbId: 2, tmdbId: Number(key) } });
const abortError = () => new DOMException("aborted", "AbortError");

function deps(script: Record<string, "ok" | "warn" | "fail" | "abort">, extra: { stopAfter?: number } = {}) {
  const started: string[] = [];
  const results: string[] = [];
  let answered = 0;
  return {
    started,
    results,
    deps: {
      fix: async (request: { tmdbId?: number }) => {
        const key = String(request.tmdbId);
        started.push(key);
        const what = script[key];
        if (what === "fail") throw new Error(`boom ${key}`);
        if (what === "abort") throw abortError();
        return what === "warn" ? { ok: true as const, warning: "partial" } : { ok: true as const };
      },
      warningOf: (o: { warning?: string }) => o.warning ?? null,
      errorOf: (err: unknown) => (err as Error).message,
      stopped: () => extra.stopAfter !== undefined && answered >= extra.stopAfter,
      onResult: (r: { key: string; kind: string }) => { answered++; results.push(`${r.key}:${r.kind}`); },
    },
  };
}

test("every title runs in order, one at a time, and each outcome is kept with its text", async () => {
  const d = deps({ 1: "ok", 2: "warn", 3: "fail", 4: "ok" });
  const { results, aborted } = await runFixAllSequence([entry("1"), entry("2"), entry("3"), entry("4")], d.deps);
  assert.equal(aborted, false);
  assert.deepEqual(d.started, ["1", "2", "3", "4"]);
  assert.deepEqual(results, [
    { key: "1", title: "T 1", kind: "ok" },
    { key: "2", title: "T 2", kind: "warn", text: "partial" },
    { key: "3", title: "T 3", kind: "error", text: "boom 3" },
    { key: "4", title: "T 4", kind: "ok" },
  ], "a failure doesn't stop the run");
  assert.deepEqual(fixAllProgress(results, 4, true), { handled: 4, total: 4, fixed: 3, failed: 1, partial: 1, stopped: false });
});

test("a stop ends the run between titles: the one running finishes, no further one starts", async () => {
  const d = deps({ 1: "ok", 2: "ok", 3: "ok" }, { stopAfter: 1 });
  const { results, aborted } = await runFixAllSequence([entry("1"), entry("2"), entry("3")], d.deps);
  assert.equal(aborted, false);
  assert.deepEqual(d.started, ["1"]);
  assert.equal(fixAllProgress(results, 3, true).stopped, true, "the run reads as stopped, not done");
  assert.equal(fixAllProgress(results, 3, false).stopped, false, "never 'stopped' while it is still running");
});

test("an abort (the page went away) ends the run quietly: not a failure, and nothing after it", async () => {
  const d = deps({ 1: "ok", 2: "abort", 3: "ok" });
  const { results, aborted } = await runFixAllSequence([entry("1"), entry("2"), entry("3")], d.deps);
  assert.equal(aborted, true);
  assert.deepEqual(d.started, ["1", "2"]);
  assert.deepEqual(d.results, ["1:ok"], "the aborted title is not reported");
  assert.equal(fixAllProgress(results, 3, true).failed, 0);
});

test("each title gets its own controller, handed over before its remap starts", async () => {
  const controllers: AbortController[] = [];
  const signals: AbortSignal[] = [];
  const d = deps({ 1: "ok", 2: "ok" });
  await runFixAllSequence([entry("1"), entry("2")], {
    ...d.deps,
    fix: async (request, signal) => { signals.push(signal); return d.deps.fix(request); },
    onTitleStart: (ac) => { controllers.push(ac); },
  });
  assert.equal(controllers.length, 2);
  assert.deepEqual(signals, controllers.map((c) => c.signal), "the poll an unmount aborts is the one running");
});

const { MAX_START_RETRIES } = await import("../src/lib/client/fix-all-sequence.ts");

function limited(failuresBeforeOk: Record<string, number>) {
  const calls: string[] = [];
  const waits: number[] = [];
  const left = { ...failuresBeforeOk };
  const rateLimited = new Error("too many");
  return {
    calls,
    waits,
    rateLimited,
    deps: {
      fix: async (request: { tmdbId?: number }) => {
        const key = String(request.tmdbId);
        calls.push(key);
        if ((left[key] ?? 0) > 0) { left[key]--; throw rateLimited; }
        if (key === "9") throw new Error("server down");
        return { ok: true as const };
      },
      warningOf: () => null,
      errorOf: (err: unknown) => (err as Error).message,
      stopped: () => false,
      retryAfterMs: (err: unknown) => (err === rateLimited ? 15_000 : null),
      sleep: async (ms: number) => { waits.push(ms); },
    },
  };
}

test("a rate-limited start is waited out and tried again; the titles after it still run", async () => {
  const d = limited({ "2": 2 });
  const { results, aborted } = await runFixAllSequence([entry("1"), entry("2"), entry("3")], d.deps);
  assert.equal(aborted, false);
  assert.deepEqual(d.calls, ["1", "2", "2", "2", "3"]);
  assert.deepEqual(d.waits, [15_000, 15_000]);
  assert.deepEqual(results.map((r) => r.kind), ["ok", "ok", "ok"]);
});

test("only a rate-limited start is retried, and only a bounded number of times", async () => {
  const other = limited({});
  const failed = await runFixAllSequence([entry("9")], other.deps);
  assert.deepEqual(other.calls, ["9"], "a real failure is kept at once");
  assert.deepEqual(failed.results.map((r) => `${r.kind}:${r.text}`), ["error:server down"]);

  const stuck = limited({ "1": 1000 });
  const { results } = await runFixAllSequence([entry("1"), entry("2")], stuck.deps);
  assert.equal(stuck.calls.filter((k) => k === "1").length, MAX_START_RETRIES + 1);
  assert.deepEqual(results.map((r) => `${r.key}:${r.kind}`), ["1:error", "2:ok"]);
});

test("a Stop or an unmount during the wait ends the run without naming a title as in flight", async () => {
  for (const stop of [true, false]) {
    const d = limited({ "1": 5 });
    let controller: AbortController | undefined;
    let stopped = false;
    const out = await runFixAllSequence([entry("1"), entry("2")], {
      ...d.deps,
      stopped: () => stopped,
      onTitleStart: (ac: AbortController) => { controller = ac; },
      sleep: async () => { stopped = stop; controller?.abort(); },
    });
    assert.deepEqual(d.calls, ["1"], "nothing more starts");
    assert.equal(out.abortedEntry, undefined, "its remap never began");
    assert.equal(out.aborted, !stop, "a Stop ends the run as stopped; an unmount ends it quietly");
    assert.deepEqual(out.results, []);
  }
});
