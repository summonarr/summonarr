import test from "node:test";
import assert from "node:assert/strict";
import { fmtTimestamp } from "../src/components/admin/activity-format.ts";

test("fmtTimestamp shows a dash for an unparsable ISO string", () => {
  assert.equal(fmtTimestamp("not-a-date", true, "en"), "—");
});

test("fmtTimestamp stays empty before mount and dashes a null", () => {
  assert.equal(fmtTimestamp("2026-01-01T00:00:00Z", false, "en"), "");
  assert.equal(fmtTimestamp(null, true, "en"), "—");
});
