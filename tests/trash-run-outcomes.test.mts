// How the TRaSH admin cards read a Refresh Catalog and a Sync Now answer
// (src/components/admin/trash-guides/outcomes.ts). Both routes answer a partial
// failure with a 2xx: the cron's degraded run is 200 ok:false with errors[] and
// applied[].ok=false, and the refresh route's `ok` only counts thrown errors,
// so per-file failures sit in results[].errors. A card that read only the
// status showed both as a green success.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  refreshOutcome,
  syncOutcome,
  TRASH_DISABLED_SKIP_REASON,
} from "../src/components/admin/trash-guides/outcomes.ts";

const STOPPED = "stopped early";

const okApply = { specId: "s1", kind: "CUSTOM_FORMAT", trashId: "aaa", name: "x265", ok: true, remoteId: 3 };
const failedApply = { specId: "s2", kind: "QUALITY_PROFILE", trashId: "bbb", name: "HD Bluray", ok: false, error: "cutoff not found" };

// ---- Sync Now (POST /api/cron/trash-sync) ----

test("sync: a degraded 200 (ok:false) is a failure, not 'Sync complete'", () => {
  const out = syncOutcome(200, {
    ok: false,
    refreshed: [],
    applied: [okApply, failedApply],
    errors: ["apply bbb: cutoff not found", "SONARR (anime) apply: connect ECONNREFUSED"],
    error: "2 TRaSH sync error(s)",
  }, STOPPED);
  assert.equal(out.kind, "done");
  if (out.kind !== "done") return;
  assert.equal(out.failed, true);
  // The spec's own failure is shown by name in the apply log; the run-level
  // line stays for the banner.
  assert.deepEqual(out.errors, ["SONARR (anime) apply: connect ECONNREFUSED"]);
  assert.deepEqual(out.applied.map((r) => r.specId), ["s1", "s2"]);
});

test("sync: a failed apply alone fails the run even when ok and errors say otherwise", () => {
  const out = syncOutcome(200, { ok: true, refreshed: [], applied: [failedApply], errors: [] }, STOPPED);
  assert.equal(out.kind === "done" && out.failed, true);
});

test("sync: run errors with no failed apply fail the run", () => {
  const out = syncOutcome(200, { ok: true, refreshed: [], applied: [], errors: ["RADARR refresh: GitHub 403"] }, STOPPED);
  assert.equal(out.kind === "done" && out.failed, true);
  assert.deepEqual(out.kind === "done" && out.errors, ["RADARR refresh: GitHub 403"]);
});

test("sync: a clean run is ok and reports how many services refreshed", () => {
  const out = syncOutcome(200, {
    ok: true,
    refreshed: [{ service: "RADARR", errors: [] }, { service: "SONARR", errors: [] }],
    applied: [okApply],
    errors: [],
  }, STOPPED);
  assert.deepEqual(out, { kind: "done", failed: false, errors: [], applied: [okApply], refreshed: 2 });
});

test("sync: a refresh the lock cut short is reported, not shown as complete", () => {
  const out = syncOutcome(200, {
    ok: true,
    refreshed: [{ service: "RADARR", errors: [], aborted: true }],
    applied: [],
    errors: [],
  }, STOPPED);
  assert.equal(out.kind === "done" && out.failed, true);
  assert.deepEqual(out.kind === "done" && out.errors, [`RADARR: ${STOPPED}`]);
});

test("sync: a non-2xx answer fails with the route's own error", () => {
  const out = syncOutcome(401, { error: "Unauthorized" }, STOPPED);
  assert.deepEqual(out, { kind: "done", failed: true, errors: ["Unauthorized"], applied: [], refreshed: 0 });
  const unreadable = syncOutcome(200, null, STOPPED);
  assert.equal(unreadable.kind === "done" && unreadable.failed, true);
  assert.deepEqual(unreadable.kind === "done" && unreadable.errors, ["HTTP 200"]);
});

test("sync: the skip reason decides between 'disabled on the server' and 'already running'", () => {
  assert.deepEqual(syncOutcome(200, { skipped: true, reason: TRASH_DISABLED_SKIP_REASON }, STOPPED), { kind: "skipped", reason: "disabled" });
  assert.deepEqual(syncOutcome(200, { skipped: true, reason: "already running" }, STOPPED), { kind: "skipped", reason: "running" });
});

test("sync: the disabled reason is the exact one the trash-sync route sends", () => {
  const route = readFileSync(new URL("../src/app/api/cron/trash-sync/route.ts", import.meta.url), "utf8");
  assert.ok(
    route.includes(`cronSkippedResponse(${JSON.stringify(TRASH_DISABLED_SKIP_REASON)})`),
    "the card would show a disabled feature as 'already running' again",
  );
});

// ---- Refresh Catalog (POST /api/admin/trash-guides/refresh) ----

test("refresh: 409 is a skip (the trash lock is held)", () => {
  assert.deepEqual(refreshOutcome(409, { error: "already running" }, STOPPED), { kind: "skipped" });
});

test("refresh: per-file failures inside an ok:true answer are failures", () => {
  const out = refreshOutcome(200, {
    ok: true,
    errors: [],
    results: [
      { service: "RADARR", errors: ["cf: payload shape mismatch: docs/json/radarr/cf/x.json"] },
      { service: "SONARR", errors: [] },
    ],
  }, STOPPED);
  assert.deepEqual(out, { kind: "done", failures: ["RADARR: cf: payload shape mismatch: docs/json/radarr/cf/x.json"] });
});

test("refresh: a pass the lock cut short is a failure", () => {
  const out = refreshOutcome(200, { ok: true, errors: [], results: [{ service: "SONARR", errors: [], aborted: true }] }, STOPPED);
  assert.deepEqual(out, { kind: "done", failures: [`SONARR: ${STOPPED}`] });
});

test("refresh: a clean answer has no failures", () => {
  const out = refreshOutcome(200, {
    ok: true,
    errors: [],
    results: [{ service: "RADARR", errors: [], removedUpstream: { deleted: 2, disabled: 0 } }],
  }, STOPPED);
  assert.deepEqual(out, { kind: "done", failures: [] });
});

test("refresh: route errors keep the schema diagnostic, and a line is listed once", () => {
  const out = refreshOutcome(200, {
    ok: false,
    errors: ["RADARR: relation \"TrashSpec\" does not exist"],
    results: [{ service: "RADARR", errors: ["relation \"TrashSpec\" does not exist"] }],
    schemaDiagnostic: "run prisma db push",
  }, STOPPED);
  assert.deepEqual(out, {
    kind: "done",
    failures: ["RADARR: relation \"TrashSpec\" does not exist"],
    schemaDiagnostic: "run prisma db push",
  });
});

test("refresh: a bare { error } or an unreadable body is a failure", () => {
  assert.deepEqual(refreshOutcome(403, { error: "TRaSH Guides is disabled" }, STOPPED), { kind: "done", failures: ["TRaSH Guides is disabled"] });
  assert.deepEqual(refreshOutcome(200, null, STOPPED), { kind: "done", failures: ["HTTP 200"] });
  assert.deepEqual(refreshOutcome(200, { ok: false }, STOPPED), { kind: "done", failures: ["HTTP 200"] });
});
