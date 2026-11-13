// The vote-to-delete reason box (src/components/votes/vote-delete-button.tsx)
// submits on Enter. An Enter that commits an IME composition is part of typing
// the reason, not a submit: voting on it posted a half-written reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/components/votes/vote-delete-button.tsx", import.meta.url), "utf8");

test("Enter and Escape are ignored while an IME composition is open", () => {
  const start = src.indexOf("onKeyDown={(e) => {");
  assert.ok(start > 0);
  const body = src.slice(start, src.indexOf("}}", start));
  const guard = body.indexOf("if (e.nativeEvent.isComposing || e.keyCode === 229) return;");
  assert.ok(guard > 0, "the composition guard");
  assert.ok(guard < body.indexOf('if (e.key === "Enter") handleVote();'), "the guard runs before the submit");
  assert.ok(guard < body.indexOf('if (e.key === "Escape") closeReason();'));
});
