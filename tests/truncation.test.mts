import { test } from "node:test";
import assert from "node:assert/strict";
import { splitAtCap, truncationHeaders, TRUNCATED_HEADER, TRUNCATED_CAP_HEADER } from "../src/lib/truncation.ts";

test("splitAtCap keeps the cap and flags an overflow row", () => {
  assert.deepEqual(splitAtCap([1, 2, 3], 2), { rows: [1, 2], truncated: true });
});

test("splitAtCap does not flag a list that exactly fits", () => {
  assert.deepEqual(splitAtCap([1, 2], 2), { rows: [1, 2], truncated: false });
  assert.deepEqual(splitAtCap([], 2), { rows: [], truncated: false });
});

test("truncationHeaders names the cut and the cap", () => {
  assert.deepEqual(truncationHeaders(true, 1000), { [TRUNCATED_HEADER]: "true", [TRUNCATED_CAP_HEADER]: "1000" });
  assert.equal(truncationHeaders(false, 5)[TRUNCATED_HEADER], "false");
});
