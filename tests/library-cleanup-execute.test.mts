// Which of a cleanup delete's own stamps come off again (guardrail 14b) — the
// one rule, requestsToUnstamp in src/lib/library-cleanup-execute.ts, that the
// all-failed and the partial paths both use. The route-level behaviour around
// it is pinned in tests/library-cleanup-routes.test.mts and
// tests/cleanup-delete-unknown-outcome-stamps.test.mts.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
const { requestsToUnstamp } = await import("../src/lib/library-cleanup-execute.ts");

const stamped = [
  { id: "default", arrInstance: "" },
  { id: "fourk", arrInstance: "4k" },
  { id: "elsewhere", arrInstance: "anime" },
];
const outcome = (o: { deleted?: string[]; refusedOn?: string[]; uncertain?: boolean }) => ({
  deleted: o.deleted ?? [],
  stillHeldOn: new Set(o.refusedOn ?? []),
  uncertain: o.uncertain ?? false,
});

test("every instance definitely refused: every stamp this call wrote comes off — the title is still fully there", () => {
  assert.deepEqual(requestsToUnstamp(stamped, outcome({ refusedOn: ["", "4k"] })), ["default", "fourk", "elsewhere"]);
});

test("nothing deleted but an outcome unknown: only the requests on an instance that definitely refused lose theirs", () => {
  assert.deepEqual(requestsToUnstamp(stamped, outcome({ refusedOn: [""], uncertain: true })), ["default"]);
  assert.deepEqual(requestsToUnstamp(stamped, outcome({ uncertain: true })), [], "maybe-deleted keeps every stamp");
});

test("a partial delete unstamps only the instances that still hold the title", () => {
  assert.deepEqual(requestsToUnstamp(stamped, outcome({ deleted: ["radarr:default"], refusedOn: ["4k"] })), ["fourk"]);
  assert.deepEqual(requestsToUnstamp(stamped, outcome({ deleted: ["radarr:default", "radarr:4k"] })), [], "a complete delete keeps them all");
});
