// The in-memory registries behind interactive release search
// (src/lib/release-handles.ts, src/lib/release-search-jobs.ts): a handle is
// claimed by exactly one grab, and a finished search's answer is readable by
// its owner only until it expires — swept, not left to fill the map.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_RELEASE_HANDLES,
  MAX_RELEASE_HANDLES_PER_OWNER,
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
  const [issued] = issueReleaseHandles("radarr::11", [RELEASE], { owner: "u1", now });
  assert.match(issued.guid, /^[0-9a-f]{32}$/);
  assert.equal(issued.title, RELEASE.title);
  assert.deepEqual(redeemReleaseHandle("radarr::11", issued.guid, now), { guid: RELEASE.guid, indexerId: 3, title: RELEASE.title });
  assert.equal(redeemReleaseHandle("radarr::12", issued.guid, now), null, "another search's handle");
  assert.equal(redeemReleaseHandle("radarr::11", issued.guid, now + RELEASE_HANDLE_TTL_MS), null, "expired");
});

test("a claim is exclusive: the second claim is busy until the first is handed back, and a spent handle is unknown", () => {
  _resetReleaseHandlesForTests();
  const [issued] = issueReleaseHandles("radarr::11", [RELEASE], { owner: "u1" });
  const first = claimReleaseHandle("radarr::11", issued.guid);
  assert.equal(typeof first, "object");
  assert.equal(claimReleaseHandle("radarr::11", issued.guid), "busy");
  releaseReleaseHandle(issued.guid);
  assert.equal(typeof claimReleaseHandle("radarr::11", issued.guid), "object", "handed back after a refusal");
  forgetReleaseHandle(issued.guid);
  assert.equal(claimReleaseHandle("radarr::11", issued.guid), "unknown");
  assert.equal(claimReleaseHandle("radarr::12", "f".repeat(32)), "unknown");
});

const batch = (n: number, tag: string) => Array.from({ length: n }, (_, i) => ({ guid: `${tag}-${i}`, indexerId: 1, title: `${tag}.${i}` }));

test("past one user's share, a new search of theirs drops THEIR oldest handles — never another user's", () => {
  _resetReleaseHandlesForTests();
  const now = 2_000_000;
  const b = issueReleaseHandles("s", batch(10, "b"), { owner: "B", now });
  const a1 = issueReleaseHandles("s", batch(MAX_RELEASE_HANDLES_PER_OWNER, "a1"), { owner: "A", now });
  const a2 = issueReleaseHandles("s", batch(3, "a2"), { owner: "A", now });
  for (const h of b) assert.ok(redeemReleaseHandle("s", h.guid, now), "B's handles all survive A's searches");
  for (const h of a1.slice(0, 3)) assert.equal(redeemReleaseHandle("s", h.guid, now), null, "A's own oldest go first");
  assert.ok(redeemReleaseHandle("s", a1[3].guid, now));
  for (const h of a2) assert.ok(redeemReleaseHandle("s", h.guid, now));
});

test("past the whole map's bound, the oldest live handles go and the newest stay", () => {
  _resetReleaseHandlesForTests();
  const t0 = 3_000_000;
  // One handle that will have expired by the time the map fills.
  const [old] = issueReleaseHandles("s", batch(1, "old"), { owner: "Z", now: t0 });
  const later = t0 + RELEASE_HANDLE_TTL_MS + 1;
  // Fill the map exactly, each owner within their share.
  const owners = MAX_RELEASE_HANDLES / MAX_RELEASE_HANDLES_PER_OWNER;
  const first = issueReleaseHandles("s", batch(MAX_RELEASE_HANDLES_PER_OWNER, "o0"), { owner: "o0", now: later });
  for (let i = 1; i < owners; i++) issueReleaseHandles("s", batch(MAX_RELEASE_HANDLES_PER_OWNER, `o${i}`), { owner: `o${i}`, now: later });
  assert.equal(redeemReleaseHandle("s", old.guid, later), null);
  // A full map: the next search evicts the single oldest live handle and then
  // overshoots by its own size (bounded by one list)…
  issueReleaseHandles("s", batch(6, "x"), { owner: "X", now: later });
  assert.equal(redeemReleaseHandle("s", first[0].guid, later), null);
  assert.ok(redeemReleaseHandle("s", first[1].guid, later));
  // …and the one after that evicts back BELOW the bound, oldest first.
  const [newest] = issueReleaseHandles("s", batch(1, "y"), { owner: "Y", now: later });
  for (const h of first.slice(0, 7)) assert.equal(redeemReleaseHandle("s", h.guid, later), null, h.title);
  assert.ok(redeemReleaseHandle("s", first[7].guid, later));
  assert.ok(redeemReleaseHandle("s", newest.guid, later));
  _resetReleaseHandlesForTests();
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
