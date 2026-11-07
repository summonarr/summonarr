// The one counted `?job=` poll loop the browser runs for every background job
// (src/lib/client/job-poll.ts — the guardrail-37a pattern), and the release
// search that now runs through it (src/lib/client/release-search-job.ts).
//
// Pinned: a poll that failed on the WAY (the fetch threw, a 5xx whose body is
// not JSON — a proxy's own page) is retried and never reported as the job's
// answer (guardrail 37a); failLimit
// of them in a row, or running out of polls, is "no answer" (status 0); every
// answer of the job itself — JSON 5xx and a thrown job's 500 included — is
// returned as it came; once the caller is gone the loop stops. A release
// search survives one dropped poll instead of rejecting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { pollJob, jobIdOf } = await import("../src/lib/client/job-poll.ts");
const { runReleaseSearchJob } = await import("../src/lib/client/release-search-job.ts");
const { JOB_MAX_FAILED_POLLS } = await import("../src/lib/arr-system.ts");

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const page = (status: number) => new Response("<html>Bad Gateway</html>", { status, headers: { "content-type": "text/html" } });
const running = () => json({ job: "j", running: true }, 202);
const noSleep = async () => {};

type Step = Response | Error;
function scripted(steps: Step[]) {
  const seen: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    const step = steps.shift();
    if (!step) throw new Error("no more scripted answers");
    if (step instanceof Error) throw step;
    return step;
  }) as typeof fetch;
  return { fetchFn, seen };
}
const opts = (extra: Record<string, unknown> = {}) => ({ sleep: noSleep, intervalMs: 1, maxPolls: 50, ...extra });

test("a 202 keeps polling; the job's own answer comes back as it came", async () => {
  const s = scripted([running(), running(), json({ deleted: 2 })]);
  assert.deepEqual(await pollJob(s.fetchFn, "/x?job=j", opts()), { status: 200, data: { deleted: 2 } });
  assert.equal(s.seen.length, 3);
});

test("a poll that failed on the way (a throw, a proxy's non-JSON 5xx page, Cloudflare's 520–524 included) is retried, not answered", async () => {
  const s = scripted([new Error("offline"), page(500), page(502), page(503), page(504), page(520), page(524), json({ deleted: 1 })]);
  assert.deepEqual(await pollJob(s.fetchFn, "/x?job=j", opts({ failLimit: 10 })), { status: 200, data: { deleted: 1 } });
});

test("the job's own 5xx is terminal: a JSON 502 and a thrown job's JSON-null 500", async () => {
  let s = scripted([json({ error: "Sonarr refused" }, 502)]);
  assert.deepEqual(await pollJob(s.fetchFn, "/x?job=j", opts()), { status: 502, data: { error: "Sonarr refused" } });
  s = scripted([json(null, 500)]);
  assert.deepEqual(await pollJob(s.fetchFn, "/x?job=j", opts()), { status: 500, data: null });
  s = scripted([json({ error: "gone" }, 404)]);
  assert.deepEqual(await pollJob(s.fetchFn, "/x?job=j", opts()), { status: 404, data: { error: "gone" } });
});

test("failLimit failed polls IN A ROW are 'no answer' (status 0); a 202 between them starts the count again", async () => {
  let s = scripted([new Error("a"), page(502), new Error("b")]);
  assert.deepEqual(await pollJob(s.fetchFn, "/x?job=j", opts({ failLimit: 3 })), { status: 0, data: null });
  assert.equal(s.seen.length, 3);
  s = scripted(Array.from({ length: JOB_MAX_FAILED_POLLS }, () => page(504)));
  assert.deepEqual(await pollJob(s.fetchFn, "/x?job=j", opts()), { status: 0, data: null }, "the default limit");
  s = scripted([new Error("a"), new Error("b"), running(), new Error("c"), new Error("d"), json({ ok: true })]);
  assert.deepEqual(await pollJob(s.fetchFn, "/x?job=j", opts({ failLimit: 3 })), { status: 200, data: { ok: true } });
});

test("counted, never forever: out of polls is status 0 after exactly maxPolls polls, each announced before its wait", async () => {
  const s = scripted(Array.from({ length: 10 }, running));
  const announced: number[] = [];
  assert.deepEqual(await pollJob(s.fetchFn, "/x?job=j", opts({ maxPolls: 3, onPoll: (n: number) => announced.push(n) })), { status: 0, data: null });
  assert.equal(s.seen.length, 3);
  assert.deepEqual(announced, [0, 1, 2]);
});

test("once the caller is gone the loop stops and answers null — no poll after", async () => {
  let alive = true;
  const s = scripted(Array.from({ length: 10 }, running));
  const answer = await pollJob(s.fetchFn, "/x?job=j", opts({ sleep: async () => { if (s.seen.length >= 2) alive = false; }, isAlive: () => alive }));
  assert.equal(answer, null);
  assert.equal(s.seen.length, 2);
});

test("a caller gone while a poll was out drops that poll's answer", async () => {
  let alive = true;
  const fetchFn = (async () => {
    alive = false; // closed while the poll was in flight
    return json({ deleted: 3 });
  }) as unknown as typeof fetch;
  assert.equal(await pollJob(fetchFn, "/x?job=j", opts({ isAlive: () => alive })), null);
});

test("jobIdOf reads a 202's job id, nothing else", () => {
  assert.equal(jobIdOf({ job: "abc" }), "abc");
  for (const bad of [null, {}, { job: "" }, { job: 3 }, "abc"]) assert.equal(jobIdOf(bad), null);
});

// ── the release search, through the shared loop ─────────────────────────────

test("a release search survives a dropped poll and a proxy's body-less 502, and returns the search's answer", async () => {
  const s = scripted([json({ job: "j1" }, 202), new Error("offline"), page(502), json({ releases: [{ guid: "h" }] })]);
  const answer = await runReleaseSearchJob(s.fetchFn, "/api/requests/r/releases?season=1", { sleep: noSleep });
  assert.deepEqual(answer, { status: 200, data: { releases: [{ guid: "h" }] } });
  assert.deepEqual(s.seen.slice(1), Array(3).fill("/api/requests/r/releases?job=j1"));
});

test("a release search gives up as 'no answer' after failLimit failed polls in a row; the route's JSON 502 stays its answer", async () => {
  let s = scripted([json({ job: "j1" }, 202), ...Array.from({ length: JOB_MAX_FAILED_POLLS }, () => new Error("offline"))]);
  assert.deepEqual(await runReleaseSearchJob(s.fetchFn, "/x", { sleep: noSleep }), { status: 0, data: null });
  s = scripted([json({ job: "j1" }, 202), json({ error: "Radarr didn't answer" }, 502)]);
  assert.deepEqual(await runReleaseSearchJob(s.fetchFn, "/x", { sleep: noSleep }), { status: 502, data: { error: "Radarr didn't answer" } });
});

test("a network failure on the release search's FIRST request still rejects, as a bare fetch would", async () => {
  const s = scripted([new Error("offline")]);
  await assert.rejects(runReleaseSearchJob(s.fetchFn, "/x", { sleep: noSleep }), /offline/);
});

// ── structural: every poller runs the shared loop ───────────────────────────

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

test("the release search, Replace file, the title manager's file delete and Arr System's provider jobs poll through job-poll.ts, with no private loop", () => {
  for (const file of ["lib/client/release-search-job.ts", "lib/client/replace-file-job.ts", "components/admin/arr-title/files-tab.tsx", "components/admin/arr-system.tsx"]) {
    const text = src(file);
    assert.match(text, /await pollJob\(|return pollJob\(/, `${file} polls through pollJob`);
    assert.doesNotMatch(text, /for \(let i = 0; i < [A-Z_a-z.?()]+; i\+\+\)|while \(res\.status === 202\)/, `${file} keeps no loop of its own`);
  }
  const files = src("components/admin/arr-title/files-tab.tsx");
  assert.match(files, /pollJob\(fetch, withBasePath\(`\$\{path\}&job=\$\{encodeURIComponent\(start\.data\.job\)\}`\), \{\s*isAlive: alive,\s*intervalMs: DELETE_POLL_MS,\s*maxPolls: DELETE_MAX_POLLS,\s*failLimit: DELETE_FAILED_POLLS,/);
  // A delete with no answer is "still running", never "failed".
  assert.match(files, /if \(answer\.status === 0 \|\| data === null \|\| typeof data !== "object"\) return \{ ok: false, running: true \};/);
  // Arr System: no counter of its own; no answer is "still running", never the change's failure.
  const system = src("components/admin/arr-system.tsx");
  assert.doesNotMatch(system, /polls\+\+|failedPolls|isTransientJobPollFailure/);
  assert.match(system, /if \(answer\.status === 0\) return \{ error: stillRunning, status: 0, body: \{ stillRunning: true \} \};/);
});
