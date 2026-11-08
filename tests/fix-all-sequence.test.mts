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
