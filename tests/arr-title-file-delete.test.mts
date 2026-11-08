// The title manager's file delete, from the browser (src/lib/client/title-file-delete.ts):
// a background job on the server, polled at `&job=` through the shared
// counted loop. What is pinned:
// - the ids go in the body with `async: true`; a synchronous answer is a count;
// - the poll names the files route with its title query AND the job;
// - a few failed polls in a row (or running out of polls) are "still running"
//   — never "failed": the delete keeps running there;
// - an answer from something in between (no JSON object) is "still running" too;
// - the delete's own refusal is "failed", with its text; a refused start too;
// - the manager closing ends the wait with nothing to show;
// - the tab's controls wait about three minutes at most.
// globalThis.fetch is stubbed; the waits are immediate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DELETE_FAILED_POLLS, DELETE_MAX_POLLS, DELETE_POLL_MS, runTitleFileDelete } from "../src/lib/client/title-file-delete.ts";

type Step = Response | Error;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const html = (status: number) => new Response("<html>x</html>", { status, headers: { "content-type": "text/html" } });
const URL_ = "/base/api/admin/arr/title/files?service=sonarr&instance=&id=7";

async function run(steps: Step[], opts: { signal?: AbortSignal } = {}) {
  const realFetch = globalThis.fetch;
  const seen: Array<{ url: string; method: string; body: unknown }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    const step = steps.shift();
    if (!step) throw new Error(`no scripted answer for ${String(input)}`);
    if (step instanceof Error) throw step;
    return step;
  }) as typeof fetch;
  const waits: number[] = [];
  try {
    const result = await runTitleFileDelete(URL_, [1, 2], "Couldn't delete", { signal: opts.signal, sleep: async (ms) => { waits.push(ms); } });
    return { result, seen, waits };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const started = () => json({ job: "j1" }, 202);
const running = () => json({ job: "j1", running: true }, 202);

test("the ids go in the body, with async; a synchronous answer is its count", async () => {
  const { result, seen } = await run([json({ deleted: 2 })]);
  assert.deepEqual(result, { kind: "deleted", deleted: 2 });
  assert.deepEqual(seen, [{ url: URL_, method: "DELETE", body: { fileIds: [1, 2], async: true } }]);
});

test("a job is polled at the files route's own query with &job=, at its interval, until the delete answers", async () => {
  const { result, seen, waits } = await run([started(), running(), json({ deleted: 1 })]);
  assert.deepEqual(result, { kind: "deleted", deleted: 1 });
  assert.deepEqual(seen.slice(1).map((s) => s.url), [`${URL_}&job=j1`, `${URL_}&job=j1`]);
  assert.deepEqual(waits, [DELETE_POLL_MS, DELETE_POLL_MS]);
});

test("failed polls in a row, or no polls left, are 'still running' — never 'failed'", async () => {
  const blips = Array.from({ length: DELETE_FAILED_POLLS }, () => new Error("offline"));
  assert.deepEqual((await run([started(), ...blips])).result, { kind: "running" });
  const proxy = Array.from({ length: DELETE_FAILED_POLLS }, () => html(502));
  assert.deepEqual((await run([started(), ...proxy])).result, { kind: "running" });
  const forever = Array.from({ length: DELETE_MAX_POLLS }, running);
  const out = await run([started(), ...forever]);
  assert.deepEqual(out.result, { kind: "running" });
  assert.equal(out.seen.length - 1, DELETE_MAX_POLLS);
});

test("an answer that is not the delete's own (no JSON object) is 'still running' too", async () => {
  assert.deepEqual((await run([started(), html(200)])).result, { kind: "running" }, "a sign-in page");
  assert.deepEqual((await run([started(), json(null, 500)])).result, { kind: "running" });
  assert.deepEqual((await run([started(), json([1], 200)])).result, { kind: "running" });
});

test("the delete's own refusal, and a refused start, are 'failed' with their text", async () => {
  assert.deepEqual((await run([started(), json({ error: "Radarr refused" }, 502)])).result, { kind: "failed", error: "Radarr refused" });
  assert.deepEqual((await run([started(), json({}, 404)])).result, { kind: "failed", error: "Couldn't delete" });
  assert.deepEqual((await run([json({ error: "Those files aren't this title's" }, 400)])).result, { kind: "failed", error: "Those files aren't this title's" });
});

test("the manager closing ends the wait with nothing to show", async () => {
  const ctl = new AbortController();
  ctl.abort();
  const { result, seen } = await run([started()], { signal: ctl.signal });
  assert.equal(result, null);
  assert.equal(seen.length, 0);
});

test("the Files tab's controls wait about three minutes at most", () => {
  assert.equal(DELETE_POLL_MS * DELETE_MAX_POLLS, 180_000);
});
