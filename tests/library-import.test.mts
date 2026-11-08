// The Plex/Jellyfin settings forms' full import button (src/lib/client/library-import.ts):
// it runs as a background job (async: true, then ?job= polls), so a reverse
// proxy's hold can't turn a running sync into "failed", and an answer it never
// sends reads as a failure, not as "undefined marked available".
import { test } from "node:test";
import assert from "node:assert/strict";
import { libraryImportOutcome, runLibraryImport } from "../src/lib/client/library-import.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("a finished sync reports what it marked and scanned", () => {
  assert.deepEqual(
    libraryImportOutcome({ status: 200, data: { marked: 3, scanned: { movies: 10, tv: 4 }, checked: 9, full: true } }),
    { kind: "done", marked: 3, scanned: { movies: 10, tv: 4 } },
  );
});

test("an already-running sync is busy, not a failure", () => {
  assert.deepEqual(libraryImportOutcome({ status: 200, data: { skipped: true } }), { kind: "busy" });
});

test("a 200 without the counts is a failure, never undefined counts", () => {
  assert.deepEqual(libraryImportOutcome({ status: 200, data: { marked: "3" } }), { kind: "error", error: "" });
  assert.deepEqual(libraryImportOutcome({ status: 200, data: null }), { kind: "error", error: "" });
});

test("the route's refusal carries its reason; no answer is not a failure", () => {
  assert.deepEqual(libraryImportOutcome({ status: 400, data: { error: "Plex is not configured" } }), { kind: "error", error: "Plex is not configured" });
  assert.deepEqual(libraryImportOutcome({ status: 429, data: {} }), { kind: "error", error: "" });
  assert.deepEqual(libraryImportOutcome({ status: 0, data: null }), { kind: "noAnswer" });
  assert.deepEqual(libraryImportOutcome({ status: 504, data: {} }), { kind: "noAnswer" });
});

test("the import starts a background job and polls it to the sync's answer", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const answers = [json({ job: "j1" }, 202), new Response(null, { status: 202 }), json({ marked: 1, scanned: { movies: 2, tv: 3 } })];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return answers.shift()!;
  }) as unknown as typeof fetch;
  const outcome = await runLibraryImport("/api/sync/plex", new AbortController().signal, { fetchFn, sleep: async () => {} });
  assert.deepEqual(outcome, { kind: "done", marked: 1, scanned: { movies: 2, tv: 3 } });
  assert.equal(calls[0].url, "/api/sync/plex");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { full: true, async: true });
  assert.equal(calls[1].url, "/api/sync/plex?job=j1");
  assert.ok(calls.every((c) => c.init?.signal instanceof AbortSignal), "every request carries the run's signal");
});

test("a start request that never answered is no answer; an aborted run resolves null", async () => {
  const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  assert.deepEqual(await runLibraryImport("/api/sync/jellyfin", new AbortController().signal, { fetchFn: down }), { kind: "noAnswer" });

  const ctrl = new AbortController();
  const fetchFn = (async () => {
    ctrl.abort();
    return json({ job: "j1" }, 202);
  }) as unknown as typeof fetch;
  assert.equal(await runLibraryImport("/api/sync/jellyfin", ctrl.signal, { fetchFn, sleep: async () => {} }), null);
});
