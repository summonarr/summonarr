// The System tab's scheduled-jobs rows (src/app/(app)/settings/_tabs/cron-jobs.ts):
// how a job's last run is read off its run-ledger row or, failing that, its
// newest audit row, and how the table rows are built. Pure — no DB.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);

const { CRON_JOBS, buildCronJobs, formatInterval, lastRunFromAudit, lastRunFromLedger } = await import(
  "../src/app/(app)/settings/_tabs/cron-jobs.ts"
);
const { CRON_RUN_HISTORY_LIMIT } = await import("../src/lib/cron-history.ts");

const t = (key: string, vars?: Record<string, string | number>) => (vars ? `${key} ${JSON.stringify(vars)}` : key);
const at = new Date("2026-11-01T10:00:00.000Z");

test("a ledger row gives the run's time, duration and outcome; an unusable one gives nothing", () => {
  assert.deepEqual(lastRunFromLedger(JSON.stringify({ at: at.toISOString(), durationMs: 120, ok: true })), { at, durationMs: 120, status: "ok" });
  assert.equal(lastRunFromLedger(JSON.stringify({ at: at.toISOString(), durationMs: 5, ok: false }))?.status, "error");
  // An Invalid Date's toISOString() throws and took the whole tab down.
  assert.equal(lastRunFromLedger(JSON.stringify({ at: "not-a-date", durationMs: 5, ok: true })), null);
  assert.equal(lastRunFromLedger("{broken"), null);
});

test("an audit row: no details reads as a success, ok:false as a failure, a non-number duration as none", () => {
  assert.deepEqual(lastRunFromAudit(at, null), { at, durationMs: null, status: "ok" });
  assert.deepEqual(lastRunFromAudit(at, JSON.stringify({ durationMs: 77 })), { at, durationMs: 77, status: "ok" }, "legacy rows carry no ok");
  assert.deepEqual(lastRunFromAudit(at, JSON.stringify({ durationMs: 9, ok: false })), { at, durationMs: 9, status: "error" });
  assert.deepEqual(lastRunFromAudit(at, JSON.stringify({ durationMs: "77", ok: true })), { at, durationMs: null, status: "ok" });
});

test("audit details that don't parse say nothing about the run — unknown, never a success", () => {
  assert.deepEqual(lastRunFromAudit(at, "{nope"), { at, durationMs: null, status: null });
  assert.deepEqual(lastRunFromAudit(at, "5"), { at, durationMs: null, status: null });
  assert.deepEqual(lastRunFromAudit(at, "[]"), { at, durationMs: null, status: null });
});

test("the rows follow CRON_JOBS, with the interval humanised and no rate where there is no history", () => {
  const recent = new Date(Date.now() - 60_000).toISOString();
  const full = Array.from({ length: CRON_RUN_HISTORY_LIMIT }, () => ({ at: recent, durationMs: 1, ok: true }));
  const rows = buildCronJobs(
    t,
    { SYNC_INTERVAL: "7200", WATCH_SYNC_INTERVAL: "1h" },
    new Map([["sync:full", { at, durationMs: 3, status: "error" as const }]]),
    new Map([["sync:full", [{ at: recent, durationMs: 3, ok: false }]], ["watch-sync", full]]),
    Date.now() - 3_600_000,
  );
  assert.deepEqual(rows.map((r) => r.endpoint), CRON_JOBS.map((j) => j.endpoint));
  const sync = rows[0];
  assert.deepEqual(sync, {
    name: "settings.cron.job.librarySync.name",
    description: "settings.cron.job.librarySync.description",
    endpoint: "/api/sync",
    interval: 'settings.cron.interval.hours {"n":2}',
    lastRun: at.toISOString(),
    lastDuration: 3,
    lastStatus: "error",
    runsLastHour: 1,
    runsLastHourCapped: false,
  });
  const upcoming = rows[1];
  assert.equal(upcoming.lastRun, null);
  assert.equal(upcoming.lastStatus, null);
  assert.equal(upcoming.runsLastHour, null, "no history: the rate is unknown, not zero");
  assert.equal(upcoming.interval, "settings.cron.interval.daily", "the container's default");
  const watchSync = rows.find((r) => r.endpoint === "/api/cron/watch-sync")!;
  assert.equal(watchSync.interval, "1h", "an unusable env value is shown as set");
  assert.equal(watchSync.runsLastHourCapped, true, "a full history is a floor");
});

test("formatInterval", () => {
  assert.equal(formatInterval(t, "604800", "1"), "settings.cron.interval.weekly");
  assert.equal(formatInterval(t, "172800", "1"), 'settings.cron.interval.days {"n":2}');
  assert.equal(formatInterval(t, "300", "1"), 'settings.cron.interval.minutes {"n":5}');
  assert.equal(formatInterval(t, "45", "1"), 'settings.cron.interval.seconds {"n":45}');
  assert.equal(formatInterval(t, "0", "1"), "0");
});
