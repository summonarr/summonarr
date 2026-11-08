// The client half of an issue's background Replace file
// (src/lib/client/replace-file-job.ts — the guardrail-37a pattern).
//
// Why: the replace runs one Mark failed after another, each re-reading the
// title's history; a long series outlasted a reverse proxy's hold and the
// admin saw a 502 on a replace that had deleted the files. The browser now
// starts it with `async: true` and polls `?job=`.
//
// Pinned: the POST carries `async: true`; a non-202 answer (a refusal before
// the job) is returned as is; the poll loop is one request at a time, COUNTED
// (out of polls ⇒ status 0, never forever), stops on unmount, retries a
// network blip or a proxy's own body-less 5xx a bounded number of times (and
// running out on either is status 0, "no answer"), and returns the replace's
// own answer — its 502 with counts included — and the route's 404 "gone"
// unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { runReplaceFileJob } = await import("../src/lib/client/replace-file-job.ts");
const { functionBody } = await import("./structural-pin-source-scan.mts");

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const JOB = "0123456789abcdef0123456789abcdef";
const URL_ = "/api/issues/i1/files";
const noSleep = async () => {};

type Step = Response | Error;
function scripted(steps: Step[]) {
  const seen: Array<{ url: string; method: string; body: unknown }> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    seen.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    await Promise.resolve();
    inFlight--;
    const step = steps.shift();
    if (!step) throw new Error("no more scripted answers");
    if (step instanceof Error) throw step;
    return step;
  }) as typeof fetch;
  return { fetchFn, seen, maxInFlight: () => maxInFlight };
}

const RESULT = { deleted: 2, requested: 2, marked: 1, unmarked: 0, searched: false, redownload: true, redownloading: 1, remonitored: 0, remonitorFailed: false, nothingMissing: false };

test("starts the replace with async: true, polls ?job= one at a time, and returns the replace's own answer", async () => {
  const s = scripted([json({ job: JOB }, 202), json({ job: JOB, running: true }, 202), json({ job: JOB, running: true }, 202), json(RESULT)]);
  const answer = await runReplaceFileJob(s.fetchFn, URL_, { instance: "", fileIds: [1, 2], then: "markFailed" }, { sleep: noSleep });
  assert.deepEqual(answer, { status: 200, data: RESULT });
  assert.deepEqual(s.seen[0], { url: URL_, method: "POST", body: { instance: "", fileIds: [1, 2], then: "markFailed", async: true } });
  assert.deepEqual(s.seen.slice(1).map((x) => [x.method, x.url]), Array(3).fill(["GET", `${URL_}?job=${JOB}`]));
  assert.equal(s.maxInFlight(), 1, "never two requests at once");
});

test("a refusal before the job (409, 400, 429) is returned as is — no poll", async () => {
  const s = scripted([json({ error: "already running" }, 409)]);
  assert.deepEqual(await runReplaceFileJob(s.fetchFn, URL_, {}, { sleep: noSleep }), { status: 409, data: { error: "already running" } });
  assert.equal(s.seen.length, 1);
});

test("the replace's own 502 (counts + error) and the route's 404 'gone' come back unchanged", async () => {
  const partial = { ...RESULT, error: "Deleted 2 files, but Sonarr didn't queue the search" };
  let s = scripted([json({ job: JOB }, 202), json(partial, 502)]);
  assert.deepEqual(await runReplaceFileJob(s.fetchFn, URL_, {}, { sleep: noSleep }), { status: 502, data: partial });
  s = scripted([json({ job: JOB }, 202), json({ error: "reload the issue" }, 404)]);
  assert.deepEqual(await runReplaceFileJob(s.fetchFn, URL_, {}, { sleep: noSleep }), { status: 404, data: { error: "reload the issue" } });
});

test("a network blip or a proxy's body-less 5xx on a POLL is retried — boundedly", async () => {
  const proxy502 = () => new Response("<html>Bad Gateway</html>", { status: 502 });
  let s = scripted([json({ job: JOB }, 202), new Error("offline"), proxy502(), json(RESULT)]);
  assert.deepEqual(await runReplaceFileJob(s.fetchFn, URL_, {}, { sleep: noSleep }), { status: 200, data: RESULT });
  s = scripted([json({ job: JOB }, 202), new Error("a"), new Error("b"), new Error("c")]);
  assert.deepEqual(await runReplaceFileJob(s.fetchFn, URL_, {}, { sleep: noSleep, failLimit: 3 }), { status: 0, data: null });
});

// Running out on a proxy's own body-less 5xx answered that 502 as
// the job's answer, and every caller read it as a definite failure ("Replacing
// the file failed", re-offering a delete that may have run). It is "no answer"
// exactly like running out on network failures.
test("running out on body-less proxy 5xx polls is 'no answer' (status 0), never the proxy's status", async () => {
  const proxy = (status: number) => new Response("<html>Bad Gateway</html>", { status });
  let s = scripted([json({ job: JOB }, 202), proxy(502), proxy(504), proxy(502)]);
  assert.deepEqual(await runReplaceFileJob(s.fetchFn, URL_, {}, { sleep: noSleep, failLimit: 3 }), { status: 0, data: null });
  // The default limit (5), and a mix of network and proxy failures in a row.
  s = scripted([json({ job: JOB }, 202), ...Array.from({ length: 5 }, () => proxy(502))]);
  assert.deepEqual(await runReplaceFileJob(s.fetchFn, URL_, {}, { sleep: noSleep }), { status: 0, data: null });
  s = scripted([json({ job: JOB }, 202), new Error("a"), proxy(503), new Error("b")]);
  assert.deepEqual(await runReplaceFileJob(s.fetchFn, URL_, {}, { sleep: noSleep, failLimit: 3 }), { status: 0, data: null });
});

test("structural: every caller reads status 0 as 'may still be running' BEFORE its non-2xx failure branch", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const [file, stillRunning] of [
    ["src/components/admin/issue-fix-options.tsx", "adminQueue.issueActions.replaceFileNoAnswer"],
    ["src/components/admin/never-watched-report.tsx", "adminManage.neverWatched.checkStillRunning"],
    ["src/components/admin/watch-sync-panel.tsx", "adminManage.watchSync.runStillRunning"],
    ["src/components/admin/library-match-check.tsx", "adminManage.library.match.stillRunning"],
  ] as const) {
    const src = readFileSync(join(here, "..", file), "utf8");
    const call = src.indexOf("await runReplaceFileJob(");
    assert.ok(call > 0, `${file}: calls runReplaceFileJob`);
    const after = src.slice(call);
    // `isNoAnswer(answer)` (library-sync.ts) is status 0 plus a proxy's own
    // 502/503/504 that carries no error of ours — the wider no-answer rule.
    const zero = after.search(/answer\.status === 0|isNoAnswer\(answer\)/);
    assert.ok(zero > 0, `${file}: handles status 0`);
    assert.ok(after.indexOf(stillRunning) > zero, `${file}: status 0 says it may still be running`);
    const failure = after.search(/answer\.status < 200 \|\| answer\.status >= 300|ok: answer\.status >= 200 && answer\.status < 300/);
    assert.ok(failure > after.indexOf(stillRunning), `${file}: the failure branch comes after the no-answer branch`);
  }
});

test("counted, never forever: out of polls answers status 0", async () => {
  const s = scripted([json({ job: JOB }, 202), ...Array.from({ length: 5 }, () => json({ job: JOB, running: true }, 202))]);
  assert.deepEqual(await runReplaceFileJob(s.fetchFn, URL_, {}, { sleep: noSleep, maxPolls: 5 }), { status: 0, data: null });
  assert.equal(s.seen.length, 6);
});

test("the dialog unmounting stops the loop", async () => {
  let alive = true;
  const s = scripted([json({ job: JOB }, 202), json({ job: JOB, running: true }, 202), json(RESULT)]);
  const answer = await runReplaceFileJob(s.fetchFn, URL_, {}, {
    sleep: async () => { if (s.seen.length >= 2) alive = false; },
    isAlive: () => alive,
  });
  assert.equal(answer, null);
  assert.equal(s.seen.length, 2, "no poll after unmount");
});

test("structural: the Fix file window runs the delete through the job, and stops polling on unmount", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  // The delete is the options view's (one instance's view inside the window).
  const src = readFileSync(join(here, "../src/components/admin/issue-fix-options.tsx"), "utf8");
  assert.ok(src.includes("export function FixFileOptions("));
  const dialog = functionBody(src, "export function FixFileOptions(");
  // The WHOLE function, cut at its closing brace — a fixed window stopped short
  // of the !res.ok branch, the catch and the reload tail, so a synchronous
  // POST added there passed the doesNotMatch below unseen.
  const replaceFn = functionBody(dialog, "async function replace(");
  assert.match(replaceFn, /void load\(instance\);\s*\}\s*$/, "the cut reaches the function's own tail");
  assert.match(replaceFn, /runReplaceFileJob\(\s*fetch,\s*withBasePath\(`\/api\/issues\/\$\{issueId\}\/files`\)/);
  assert.match(replaceFn, /isAlive: \(\) => aliveRef\.current/);
  assert.doesNotMatch(replaceFn, /method: "POST"/, "no synchronous POST left in the dialog");
  assert.match(dialog, /return \(\) => \{ aliveRef\.current = false; \};/);
});

test("the poll URL keeps a query the start URL already had", async () => {
  const { jobPollUrl } = await import("../src/lib/client/replace-file-job.ts");
  assert.equal(jobPollUrl("/api/issues/1/files", "a b"), "/api/issues/1/files?job=a%20b");
  assert.equal(jobPollUrl("/api/x?instance=uhd", "j1"), "/api/x?instance=uhd&job=j1");
});

test("onGiveUp passes through: an unreachable server and a job still running at the poll budget are told apart", async () => {
  const reasons: string[] = [];
  const onGiveUp = (r: string) => { reasons.push(r); };
  const down = scripted([json({ job: JOB }, 202), ...Array.from({ length: 2 }, () => new TypeError("fetch failed"))]);
  assert.deepEqual(await runReplaceFileJob(down.fetchFn, URL_, {}, { sleep: noSleep, failLimit: 2, onGiveUp }), { status: 0, data: null });
  const slow = scripted([json({ job: JOB }, 202), ...Array.from({ length: 2 }, () => json({ job: JOB, running: true }, 202))]);
  assert.deepEqual(await runReplaceFileJob(slow.fetchFn, URL_, {}, { sleep: noSleep, maxPolls: 2, onGiveUp }), { status: 0, data: null });
  assert.deepEqual(reasons, ["unreachable", "outOfPolls"]);
});
