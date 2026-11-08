// manualRunOutcome — how the admin cron table reads the answer to a manual
// "Run": a skipped run (busy lock, unconfigured job) is neither a success nor a
// failure, and is not counted as a run, because the run ledger records nothing
// for it either (withCronRunRecording). Plus structural pins on the table that
// uses it (a "use client" .tsx the node runner cannot load).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { manualRunOutcome, CRON_SKIPPED_HEADER } from "../src/lib/cron-run-outcome.ts";
import { CRON_SKIPPED_HEADER as LEDGER_HEADER, cronSkippedResponse } from "../src/lib/cron-history.ts";

const h = (entries: Record<string, string> = {}) => new Headers(entries);

test("the X-Cron-Skipped header is a skip", () => {
  assert.equal(manualRunOutcome(200, h({ "X-Cron-Skipped": "1" }), { skipped: true, reason: "already running" }), "skipped");
  // The header alone decides, whatever the body says.
  assert.equal(manualRunOutcome(200, h({ "x-cron-skipped": "1" }), {}), "skipped");
});

test("a literal skipped: true is a skip; a COUNT of skipped items is not", () => {
  assert.equal(manualRunOutcome(200, h(), { skipped: true, reason: "no MDBList API key configured" }), "skipped");
  // /api/sync/ratings answers `skipped` as a count: its best run says 0.
  assert.equal(manualRunOutcome(200, h(), { skipped: 0, warmed: 120 }), "ok");
  assert.equal(manualRunOutcome(200, h(), { skipped: 3, warmed: 120 }), "ok");
});

test("an error field on a 2xx is a run that finished with failures", () => {
  assert.equal(manualRunOutcome(200, h(), { ok: false, error: "3 of 17 list fetches failed" }), "error");
  assert.equal(manualRunOutcome(200, h(), { checked: 10, marked: 2 }), "ok");
  assert.equal(manualRunOutcome(200, h(), null), "ok");
});

test("any non-2xx is an error, even one that says skipped", () => {
  assert.equal(manualRunOutcome(502, h(), { skipped: true, reason: "arr-unavailable" }), "error");
  assert.equal(manualRunOutcome(500, h({ "X-Cron-Skipped": "1" }), {}), "error");
  assert.equal(manualRunOutcome(401, h(), { error: "Unauthorized" }), "error");
});

test("the server's skipped answer is what the table reads as a skip — one header, shared", () => {
  assert.equal(LEDGER_HEADER, CRON_SKIPPED_HEADER);
  const res = cronSkippedResponse("no TMDB credentials configured");
  assert.equal(manualRunOutcome(res.status, res.headers, { skipped: true, reason: "no TMDB credentials configured" }), "skipped");
});

const TABLE = readFileSync(new URL("../src/components/settings/cron-job-table.tsx", import.meta.url), "utf8");
const EN = JSON.parse(readFileSync(new URL("../src/lib/i18n/messages/en/settings.json", import.meta.url), "utf8")) as Record<string, string>;

test("the cron table decides through manualRunOutcome and leaves a skipped row's run fields alone", () => {
  assert.match(TABLE, /const outcome = manualRunOutcome\(res\.status, res\.headers, data\);/);
  // The skip branch returns before setJobs, so lastRun / lastStatus / runsLastHour
  // stay as the server rendered them.
  const skip = TABLE.slice(TABLE.indexOf('if (outcome === "skipped")'), TABLE.indexOf("setSkipNote(null);"));
  assert.ok(skip.length > 0, "the skip branch is missing");
  assert.match(skip, /return;/);
  assert.doesNotMatch(skip, /setJobs/);
  assert.doesNotMatch(TABLE, /const succeeded = res\.ok && !data\.error/, "the old verdict read a skip as a success");
  assert.ok(EN["settings.cron.skipped"]?.includes("{reason}"));
  assert.ok(EN["settings.cron.skippedNoReason"]);
});

test("every Run button carries the job's name as its accessible name", () => {
  assert.match(TABLE, /aria-label=\{isRunning \? t\("settings\.cron\.runningNamed", \{ name: job\.name \}\) : t\("settings\.cron\.runNamed", \{ name: job\.name \}\)\}/);
  assert.equal(EN["settings.cron.runNamed"], "Run {name}");
  assert.ok(EN["settings.cron.runningNamed"]?.includes("{name}"));
  // The job name is the row header, so each cell is announced with it.
  assert.match(TABLE, /<th scope="row"[^>]*>\s*<div[^>]*>\{job\.name\}<\/div>/);
});

// A long job showed a later "last run" than the server recorded (its start).
test("a manual run's row shows when it was sent, through the one row update", () => {
  const trigger = TABLE.slice(TABLE.indexOf("async function handleTriggerJob("));
  const started = trigger.indexOf("const startedAt = new Date().toISOString();");
  assert.ok(started > 0 && started < trigger.indexOf("await fetch("), "captured before the request");
  assert.equal((TABLE.match(/lastRun: startedAt/g) ?? []).length, 1, "one row update for success, failure and network error");
  assert.equal((trigger.match(/markRun\(name, /g) ?? []).length, 2);
  assert.doesNotMatch(TABLE, /lastRun: new Date\(\)/);
});
