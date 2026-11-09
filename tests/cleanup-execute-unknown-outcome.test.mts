// An execute whose outcome is unknown. The Library cleanup execute is one
// synchronous request; behind a reverse proxy the browser can get the PROXY's
// 502/504 after ~60 s while the route keeps deleting (guardrail 37a). Read as
// "the delete failed", the plan stayed on screen and "Delete N now" started a
// second run over the same titles. The pure classification lives in
// src/lib/cleanup-execute-outcome.ts and src/lib/cleanup-plan-answer.ts and is
// tested directly; the hook wiring in src/components/admin/cleanup-delete.tsx
// (.tsx — the runner can't load it) is pinned by a structural scan, the repo's
// pattern for client components.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cleanupExecuteFailure } from "../src/lib/cleanup-execute-outcome.ts";
import { NOT_JSON, readExecuteAnswer } from "../src/lib/cleanup-plan-answer.ts";

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

test("every non-OK execute answer is classified: the route's refusal keeps the plan, anything else is outcome-unknown", () => {
  assert.deepEqual(readExecuteAnswer(400, { error: "Bad body" }), { kind: "refused", error: "Bad body" });
  assert.deepEqual(readExecuteAnswer(502, { error: "gateway" }), { kind: "unknown", messageKey: "adminManage.cleanup.error.deleteUnknown" });
  assert.deepEqual(readExecuteAnswer(500, NOT_JSON), { kind: "unknown", messageKey: "adminManage.cleanup.error.deleteUnknown" }, "a framework 500 page mid-run");
  // A 2xx that isn't the route's results is no proof the deletes ran either way.
  assert.deepEqual(readExecuteAnswer(200, NOT_JSON), { kind: "unknown", messageKey: "adminManage.cleanup.error.deleteNetwork" });
  assert.deepEqual(readExecuteAnswer(200, { deletedCount: 1 }), { kind: "unknown", messageKey: "adminManage.cleanup.error.deleteNetwork" });
});

test("the hook's execute settles an unknown one instead of keeping the plan, and a thrown fetch is unknown too", () => {
  const exec = callbackBody(deleteSrc, "execute");
  assert.match(exec, /const answer = await sendExecute\(plan, blacklist\);/);
  assert.match(exec, /else if \(answer\.kind === "refused"\) \{\s*\n(\s*\/\/[^\n]*\n)*\s*setError\(answer\.error\);/);
  assert.match(exec, /else if \(answer\.kind === "unknown"\) \{\s*\n(\s*\/\/[^\n]*\n)*\s*await settleUnknownOutcome\(t\(answer\.messageKey\)\);/);
  assert.doesNotMatch(exec, /readApiError/, "a proxy's 5xx is never worded as a definite failure");
  const send = deleteSrc.slice(deleteSrc.indexOf("async function sendExecute("), deleteSrc.indexOf("export function useCleanupDelete("));
  assert.match(send, /return readExecuteAnswer\(res\.status, await res\.json\(\)\.catch\(\(\) => NOT_JSON\)\);/);
  assert.match(send, /\} catch \{\s*(\/\/[^\n]*\n\s*)*return \{ kind: "unknown", messageKey: "adminManage\.cleanup\.error\.deleteNetwork" \};/);
});

test("only the request is inside the transport's try: a reload that throws after a delete never reads as the delete's failure", () => {
  const exec = callbackBody(deleteSrc, "execute");
  // The answer is settled first; the reload after a success is its own swallowed step.
  assert.ok(exec.indexOf("await sendExecute(") < exec.indexOf("await reloadAfter()"));
  assert.doesNotMatch(exec, /\} catch \{/, "execute itself catches nothing: a refresh error can't become 'outcome unknown'");
  const reload = callbackBody(deleteSrc, "reloadAfter");
  assert.match(reload, /try \{\s*await onDeleted\(\);\s*\} catch \{/);
});

test("settling an unknown outcome drops the plan through clearPlan, shows the message and reloads", () => {
  const settle = callbackBody(deleteSrc, "settleUnknownOutcome");
  assert.match(settle, /clearPlan\(\);/, "the plan (and its generation) goes — no second 'Delete N now'");
  assert.match(settle, /setError\(message\);/);
  assert.match(settle, /await onDeleted\(\);/, "the page reloads and drops the selection");
  assert.ok(settle.indexOf("clearPlan()") < settle.indexOf("await onDeleted()"), "the plan is gone before the reload is awaited");
});
