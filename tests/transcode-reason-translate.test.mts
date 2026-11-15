import { test } from "node:test";
import assert from "node:assert/strict";
import { translateTranscodeReason } from "../src/lib/transcode-reasons.ts";

test("a reason part named like an Object.prototype member is shown as stored", () => {
  const t = (k: string) => `T(${k})`;
  assert.equal(translateTranscodeReason("constructor, toString", t), "constructor, toString");
  assert.equal(translateTranscodeReason("Direct play error", t), "T(adminActivity.reason.directPlayError)");
});
