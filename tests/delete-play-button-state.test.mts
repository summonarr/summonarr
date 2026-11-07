// The play page's Delete control. After a successful DELETE the buttons stay
// disabled until the navigation lands — re-enabled, a second click sent a
// DELETE for the row already gone and showed "failed" — and a failure shows the
// route's own message (its rate-limit text, say), not a fixed one.
// Structural pin: the runner can't render .tsx.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/components/admin/delete-play-button.tsx", import.meta.url), "utf8");
const handler = src.slice(src.indexOf("async function handleDelete()"), src.indexOf("if (!confirming)"));

test("a successful delete leaves the buttons disabled; only the failure paths re-enable them", () => {
  assert.ok(handler.length > 0);
  assert.doesNotMatch(handler, /finally/, "a finally re-enabled the buttons mid-navigation");
  const success = handler.slice(handler.indexOf("router.push("), handler.indexOf("} catch"));
  assert.doesNotMatch(success, /setDeleting\(false\)/);
  assert.equal((handler.match(/setDeleting\(false\)/g) ?? []).length, 2, "the !ok branch and the catch");
});

test("the error state holds the message to show, preferring the route's own", () => {
  assert.match(src, /useState<string \| null>\(null\)/);
  assert.match(handler, /typeof body\?\.error === "string" \? body\.error : t\("adminActivity\.deletePlay\.failed"\)/);
  assert.match(src, /\{error && <span className="text-xs text-red-400">\{error\}<\/span>\}/);
});
