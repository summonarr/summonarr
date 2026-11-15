// The shared rate-limit / join / background tail of the admin actions that take
// an advisory lock (match check, upstream watch refresh).
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextResponse } from "next/server";
import { runLockedAdminJob, wantsBackgroundJob } from "../src/lib/admin-locked-job.ts";
import { _resetReleaseSearchJobsForTests } from "../src/lib/release-search-jobs.ts";

let seq = 0;
const base = () => {
  const n = ++seq;
  return { owner: `admin-${n}`, jobKey: "locked-test", rateKey: `locked-test:${n}`, limit: 2, windowMs: 60_000, background: false, tooManyMessage: "slow down" };
};
const busy = () => NextResponse.json({ ok: false }, { status: 409 });
const ok = () => NextResponse.json({ ok: true });

test("wantsBackgroundJob is true only for an object with async: true", () => {
  assert.equal(wantsBackgroundJob({ async: true }), true);
  for (const v of [null, undefined, [], {}, { async: "true" }, "x", 1]) assert.equal(wantsBackgroundJob(v), false);
});

test("a busy lock (409) hands its rate token back, so retrying never locks the admin out", async () => {
  const job = base();
  for (let i = 0; i < 5; i++) assert.equal((await runLockedAdminJob({ ...job, run: busy })).status, 409);
  assert.equal((await runLockedAdminJob({ ...job, run: ok })).status, 200);
});

test("a run that did work spends its token: the call past the limit is 429 and runs nothing", async () => {
  const job = base();
  assert.equal((await runLockedAdminJob({ ...job, run: ok })).status, 200);
  assert.equal((await runLockedAdminJob({ ...job, run: ok })).status, 200);
  let ran = false;
  const res = await runLockedAdminJob({ ...job, run: async () => { ran = true; return ok(); } });
  assert.equal(res.status, 429);
  assert.equal(ran, false);
});

test("background: answers 202 with a job id, and the same admin asking again joins it without a token", async () => {
  _resetReleaseSearchJobsForTests();
  const job = { ...base(), background: true, limit: 1 };
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const first = await runLockedAdminJob({ ...job, run: async () => { await gate; return ok(); } });
  assert.equal(first.status, 202);
  const { job: id } = await first.json();
  const again = await runLockedAdminJob({ ...job, run: ok });
  assert.equal(again.status, 202);
  assert.equal((await again.json()).job, id);
  release();
});
