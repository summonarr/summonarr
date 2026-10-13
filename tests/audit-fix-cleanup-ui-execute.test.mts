// An execute whose outcome is unknown (C055). The Library cleanup execute is one
// synchronous request; behind a reverse proxy the browser can get the PROXY's
// 502/504 after ~60 s while the route keeps deleting (guardrail 37a). Read as
// "the delete failed", the plan stayed on screen and "Delete N now" started a
// second run over the same titles. The pure classification lives in
// src/lib/cleanup-execute-outcome.ts and is tested directly; the hook wiring in
// src/components/admin/cleanup-delete.tsx (.tsx — the runner can't load it) is
// pinned by a structural scan, the repo's pattern for client components.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cleanupExecuteFailure } from "../src/lib/cleanup-execute-outcome.ts";

const deleteSrc = readFileSync(new URL("../src/components/admin/cleanup-delete.tsx", import.meta.url), "utf8");

function callbackBody(src: string, name: string): string {
  const start = src.indexOf(`const ${name} = useCallback(`);
  assert.ok(start >= 0, `${name} callback present`);
  const end = src.indexOf("\n  }, [", start);
  assert.ok(end > start, `${name} callback ends`);
  return src.slice(start, end);
}

test("a gateway status is outcome-unknown whatever its body says", () => {
  for (const status of [502, 503, 504]) {
    assert.deepEqual(cleanupExecuteFailure(status, null), { kind: "unknown" }, `${status} with no body`);
    assert.deepEqual(cleanupExecuteFailure(status, { error: "Bad gateway" }), { kind: "unknown" }, `${status} with a JSON error`);
  }
});

test("the route's own JSON refusal is definite — it is answered before any delete", () => {
  for (const status of [400, 401, 403, 404]) {
    assert.deepEqual(cleanupExecuteFailure(status, { error: "nope" }), { kind: "refused", error: "nope" });
  }
});

test("a non-OK answer that isn't the route's JSON (HTML 500 after a throw mid-run, a proxy page) is outcome-unknown", () => {
  assert.deepEqual(cleanupExecuteFailure(500, null), { kind: "unknown" }, "unparseable body");
  assert.deepEqual(cleanupExecuteFailure(500, "<html>"), { kind: "unknown" });
  assert.deepEqual(cleanupExecuteFailure(500, {}), { kind: "unknown" }, "JSON with no error");
  assert.deepEqual(cleanupExecuteFailure(500, { error: "" }), { kind: "unknown" }, "an empty error is no refusal");
  assert.deepEqual(cleanupExecuteFailure(413, { error: 42 }), { kind: "unknown" }, "a non-string error");
});

test("the hook's execute classifies every non-OK answer and settles an unknown one instead of keeping the plan", () => {
  const exec = callbackBody(deleteSrc, "execute");
  const notOk = exec.slice(exec.indexOf("if (!res.ok) {"), exec.indexOf("setResult("));
  assert.match(notOk, /cleanupExecuteFailure\(res\.status, await res\.json\(\)\.catch\(\(\) => null\)\)/);
  assert.match(notOk, /if \(failure\.kind === "refused"\) \{\s*\n(\s*\/\/[^\n]*\n)*\s*setError\(failure\.error\);\s*\n\s*return;/);
  assert.match(notOk, /await settleUnknownOutcome\(t\("adminManage\.cleanup\.error\.deleteUnknown"\)\);/);
  assert.doesNotMatch(notOk, /readApiError/, "a proxy's 5xx is never worded as a definite failure");
  const caught = exec.slice(exec.indexOf("} catch {"), exec.indexOf("} finally {"));
  assert.match(caught, /await settleUnknownOutcome\(t\("adminManage\.cleanup\.error\.deleteNetwork"\)\);/, "a thrown fetch is unknown too");
});

test("settling an unknown outcome drops the plan through clearPlan, shows the message and reloads", () => {
  const settle = callbackBody(deleteSrc, "settleUnknownOutcome");
  assert.match(settle, /clearPlan\(\);/, "the plan (and its generation) goes — no second 'Delete N now'");
  assert.match(settle, /setError\(message\);/);
  assert.match(settle, /await onDeleted\(\);/, "the page reloads and drops the selection");
  assert.ok(settle.indexOf("clearPlan()") < settle.indexOf("await onDeleted()"), "the plan is gone before the reload is awaited");
});
