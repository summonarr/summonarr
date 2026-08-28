// Unit tests for the in-memory fix-match job registry (src/lib/fix-match-jobs.ts,
// guardrail 37a): a started job is readable at once, settles to done/failed
// with the runner's outcome, an identical key still running is never started
// twice, and finished jobs expire after the TTL while running ones never do.
// Pure module state — no DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const errors: string[] = [];
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

const {
  startFixMatchJob, getFixMatchJob, findRunningFixMatchJob, fixMatchJobKey, FixMatchError, _resetFixMatchJobsForTests,
} = await import("../src/lib/fix-match-jobs.ts");

const settle = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => {
  _resetFixMatchJobsForTests();
  errors.length = 0;
});

test("a started job is running immediately, then done with the runner's result", async () => {
  const job = startFixMatchJob("k1", async () => ({ ok: true, warning: "partial" }));
  assert.equal(job.status, "running");
  assert.match(job.id, /^[0-9a-f-]{36}$/);
  assert.equal(getFixMatchJob(job.id)?.status, "running");
  await settle();
  const done = getFixMatchJob(job.id);
  assert.equal(done?.status, "done");
  assert.deepEqual(done?.result, { ok: true, warning: "partial" });
  assert.ok(done?.finishedAt);
});

test("a FixMatchError settles as failed with its client-safe message + status; an unmapped error degrades to the generic message", async () => {
  const mapped = startFixMatchJob("k-mapped", async () => { throw new FixMatchError("Plex rating key not found — re-sync first", 404); });
  const unmapped = startFixMatchJob("k-unmapped", async () => { throw new Error("http://10.0.0.5:8096 said something internal"); });
  await settle();
  assert.equal(getFixMatchJob(mapped.id)?.status, "failed");
  assert.equal(getFixMatchJob(mapped.id)?.error, "Plex rating key not found — re-sync first");
  assert.equal(getFixMatchJob(mapped.id)?.errorStatus, 404);
  assert.equal(getFixMatchJob(unmapped.id)?.status, "failed");
  assert.equal(getFixMatchJob(unmapped.id)?.error, "Fix-match operation failed", "internal detail must never reach the client-facing error");
  assert.equal(getFixMatchJob(unmapped.id)?.errorStatus, 502);
  assert.ok(errors.some((e) => e.includes("unmapped error")), "the internal detail is logged server-side instead");
});

test("the same key still running is returned instead of started twice; a different key, or a finished one, starts fresh", async () => {
  let runs = 0;
  const never = () => { runs++; return new Promise<{ ok: true }>(() => {}); };
  const first = startFixMatchJob("same", never);
  const second = startFixMatchJob("same", never);
  assert.equal(second.id, first.id, "an identical remap in flight must be deduped");
  await settle();
  assert.equal(runs, 1, "the runner ran once");
  const other = startFixMatchJob("other", async () => ({ ok: true }));
  assert.notEqual(other.id, first.id);
  await settle();
  const after = startFixMatchJob("other", async () => ({ ok: true }));
  assert.notEqual(after.id, other.id, "a finished job does not dedupe a new request");
});

test("finished jobs expire after the TTL; running jobs never do", async () => {
  const done = startFixMatchJob("ttl-done", async () => ({ ok: true }));
  const running = startFixMatchJob("ttl-running", () => new Promise(() => {}));
  await settle();
  const later = Date.now() + 2 * 60 * 60_000;
  assert.equal(getFixMatchJob(done.id, later), null, "a finished job is pruned after the TTL");
  assert.equal(getFixMatchJob(running.id, later)?.status, "running", "a running job is never evicted");
});

test("a runner's report() lands on job.progress with an updatedAt stamp, readable while running", async () => {
  // Holder object rather than a bare `let`: TS narrows a closure-assigned
  // variable to `never` at the later call site.
  const gate: { release?: () => void } = {};
  const job = startFixMatchJob("progress", async (report) => {
    report({ phase: "confirming", remoteApplied: true, attempt: 3, attempts: 120, readFailures: 1 });
    await new Promise<void>((r) => { gate.release = r; });
    return { ok: true };
  });
  await settle();
  const mid = getFixMatchJob(job.id);
  assert.equal(mid?.status, "running");
  assert.equal(mid?.progress?.phase, "confirming");
  assert.equal(mid?.progress?.remoteApplied, true);
  assert.equal(mid?.progress?.attempt, 3);
  assert.equal(mid?.progress?.readFailures, 1);
  assert.ok((mid?.progress?.updatedAt ?? 0) > 0, "the registry stamps when the report arrived");
  gate.release?.();
  await settle();
  assert.equal(getFixMatchJob(job.id)?.status, "done");
});

test("fixMatchJobKey identifies the remap by server, instance, type and the from→to pair", () => {
  assert.equal(fixMatchJobKey({ server: "jellyfin", serverInstance: "", mediaType: "TV", tmdbId: 1, correctTmdbId: 2 }), "jellyfin::TV:1->2");
  assert.notEqual(
    fixMatchJobKey({ server: "jellyfin", serverInstance: "remote", mediaType: "TV", tmdbId: 1, correctTmdbId: 2 }),
    fixMatchJobKey({ server: "jellyfin", serverInstance: "", mediaType: "TV", tmdbId: 1, correctTmdbId: 2 }),
    "two servers holding the same title are two different remaps",
  );
});

test("the concurrent-running cap refuses admission beyond MAX_RUNNING_JOBS with a 429", async () => {
  const never = () => new Promise<never>(() => {});
  // Four distinct keys start and stay running.
  for (let i = 0; i < 4; i++) startFixMatchJob(`run-${i}`, never);
  // The fifth distinct key is refused — parallel metadata refreshes are how
  // these calls start timing out (guardrail 37).
  let thrown: unknown = null;
  try { startFixMatchJob("run-5", never); } catch (e) { thrown = e; }
  assert.ok(thrown instanceof FixMatchError, "the cap throws a FixMatchError");
  assert.equal((thrown as InstanceType<typeof FixMatchError>).status, 429);
  // An already-running key is still JOINED, not counted as a new admission.
  const joined = startFixMatchJob("run-0", never);
  assert.equal(joined.status, "running");
});

test("findRunningFixMatchJob returns the running job for a key, null otherwise", async () => {
  assert.equal(findRunningFixMatchJob("k"), null);
  const job = startFixMatchJob("k", () => new Promise<never>(() => {}));
  assert.equal(findRunningFixMatchJob("k")?.id, job.id);
  // A finished key no longer counts as running.
  const done = startFixMatchJob("kd", async () => ({ ok: true }));
  await settle();
  assert.equal(findRunningFixMatchJob("kd"), null, "a settled job is not 'running'");
  void done;
});
