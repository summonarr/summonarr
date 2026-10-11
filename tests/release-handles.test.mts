// The in-memory registries behind interactive release search
// (src/lib/release-handles.ts, src/lib/release-search-jobs.ts): a handle is
// claimed by exactly one grab, and a finished search's answer is readable by
// its owner only until it expires — swept, not left to fill the map.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RELEASE_HANDLE_TTL_MS,
  _resetReleaseHandlesForTests,
  claimReleaseHandle,
  forgetReleaseHandle,
  issueReleaseHandles,
  redeemReleaseHandle,
  releaseReleaseHandle,
} from "../src/lib/release-handles.ts";
import {
  _releaseSearchJobCountForTests,
  _resetReleaseSearchJobsForTests,
  pollReleaseSearchJob,
  runningReleaseSearchJob,
  startReleaseSearchJob,
} from "../src/lib/release-search-jobs.ts";

const RELEASE = { guid: "https://indexer.example/dl?apikey=secret", indexerId: 3, title: "Some.Release.1080p" };

test("a handle hides the guid and redeems only for its own search, until it expires", () => {
  _resetReleaseHandlesForTests();
  const now = 1_000_000;
  const [issued] = issueReleaseHandles("radarr::11", [RELEASE], now);
  assert.match(issued.guid, /^[0-9a-f]{32}$/);
  assert.equal(issued.title, RELEASE.title);
  assert.deepEqual(redeemReleaseHandle("radarr::11", issued.guid, now), { guid: RELEASE.guid, indexerId: 3, title: RELEASE.title });
  assert.equal(redeemReleaseHandle("radarr::12", issued.guid, now), null, "another search's handle");
  assert.equal(redeemReleaseHandle("radarr::11", issued.guid, now + RELEASE_HANDLE_TTL_MS), null, "expired");
});

test("a claim is exclusive: the second claim is busy until the first is handed back, and a spent handle is unknown", () => {
  _resetReleaseHandlesForTests();
  const [issued] = issueReleaseHandles("radarr::11", [RELEASE]);
  const first = claimReleaseHandle("radarr::11", issued.guid);
  assert.equal(typeof first, "object");
  assert.equal(claimReleaseHandle("radarr::11", issued.guid), "busy");
  releaseReleaseHandle(issued.guid);
  assert.equal(typeof claimReleaseHandle("radarr::11", issued.guid), "object", "handed back after a refusal");
  forgetReleaseHandle(issued.guid);
  assert.equal(claimReleaseHandle("radarr::11", issued.guid), "unknown");
  assert.equal(claimReleaseHandle("radarr::12", "f".repeat(32)), "unknown");
});

const settle = () => new Promise((r) => setTimeout(r, 0));

test("a search job answers its owner only, joins a running one, and is swept once its answer expires", async () => {
  _resetReleaseSearchJobsForTests();
  let finish: (() => void) | null = null;
  const done = new Promise<void>((r) => { finish = r; });
  const run = () => done.then(() => ({ status: 200, body: { releases: [] } }));
  const { jobId, joined } = startReleaseSearchJob("u1", "radarr::11", run);
  assert.equal(joined, false);
  assert.deepEqual(startReleaseSearchJob("u1", "radarr::11", run), { jobId, joined: true });
  assert.equal(startReleaseSearchJob("u2", "radarr::11", run).joined, false, "another admin's search is their own");
  assert.equal(runningReleaseSearchJob("u1", "radarr::11"), jobId);
  assert.deepEqual(pollReleaseSearchJob("u1", jobId), { state: "running" });
  assert.deepEqual(pollReleaseSearchJob("u2", jobId), { state: "unknown" });
  assert.deepEqual(pollReleaseSearchJob("u1", "not-a-job"), { state: "unknown" });

  (finish as unknown as () => void)();
  await done;
  await settle();
  assert.deepEqual(pollReleaseSearchJob("u1", jobId), { state: "done", answer: { status: 200, body: { releases: [] } } });
  assert.equal(runningReleaseSearchJob("u1", "radarr::11"), null, "a finished job is never joined");

  // Ten minutes and a bit later the answer is gone — and the map no longer holds it.
  const later = Date.now() + 10 * 60_000 + 1_000;
  assert.equal(_releaseSearchJobCountForTests(), 2);
  assert.deepEqual(pollReleaseSearchJob("u1", jobId, later), { state: "unknown" });
  assert.equal(_releaseSearchJobCountForTests(), 0, "every expired answer swept on the poll, not only the one asked for");
});

test("starting a job sweeps expired answers; a throwing search becomes a 500 answer", async () => {
  _resetReleaseSearchJobsForTests();
  const old = startReleaseSearchJob("u1", "a", async () => ({ status: 200, body: [] }));
  await settle();
  assert.equal(pollReleaseSearchJob("u1", old.jobId).state, "done");
  startReleaseSearchJob("u1", "b", async () => ({ status: 200, body: [] }), Date.now() + 11 * 60_000);
  assert.deepEqual(pollReleaseSearchJob("u1", old.jobId), { state: "unknown" }, "swept by the start");

  const origError = console.error;
  console.error = () => {};
  try {
    const failed = startReleaseSearchJob("u1", "c", async () => { throw new Error("boom"); });
    await settle();
    await settle();
    assert.deepEqual(pollReleaseSearchJob("u1", failed.jobId), { state: "done", answer: { status: 500, body: null } });
  } finally {
    console.error = origError;
  }
});
