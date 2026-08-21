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
  startFixMatchJob, getFixMatchJob, fixMatchJobKey, FixMatchError, _resetFixMatchJobsForTests,
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

test("fixMatchJobKey identifies the remap by server, instance, type and the from→to pair", () => {
  assert.equal(fixMatchJobKey({ server: "jellyfin", serverInstance: "", mediaType: "TV", tmdbId: 1, correctTmdbId: 2 }), "jellyfin::TV:1->2");
  assert.notEqual(
    fixMatchJobKey({ server: "jellyfin", serverInstance: "remote", mediaType: "TV", tmdbId: 1, correctTmdbId: 2 }),
    fixMatchJobKey({ server: "jellyfin", serverInstance: "", mediaType: "TV", tmdbId: 1, correctTmdbId: 2 }),
    "two servers holding the same title are two different remaps",
  );
});
