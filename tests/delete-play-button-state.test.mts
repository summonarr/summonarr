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

test("a successful delete leaves the buttons disabled; only the failure path re-enables them", () => {
  assert.ok(handler.length > 0);
  assert.doesNotMatch(handler, /finally/, "a finally re-enabled the buttons mid-navigation");
  const success = handler.slice(handler.indexOf("router.push("));
  assert.doesNotMatch(success, /setDeleting\(false\)/);
  assert.equal((handler.match(/setDeleting\(false\)/g) ?? []).length, 1, "the !ok branch (fetchJson never throws)");
  assert.ok(handler.indexOf("setDeleting(false)") < handler.indexOf("router.push("), "…and it returns before the navigation");
});

test("the error state holds the message to show, preferring the route's own, and is announced", () => {
  assert.match(src, /useState<string \| null>\(null\)/);
  // fetchJson's `error` is the route's own message, else the fallback.
  assert.match(handler, /fallbackError: t\("adminActivity\.deletePlay\.failed"\)/);
  assert.match(handler, /setError\(res\.error\);/);
  assert.match(src, /\{error && <span role="alert" className="text-xs text-red-400">\{error\}<\/span>\}/);
});

test("the row id is encoded into the path, and a step (Cancel, a new confirm) clears the last failure", () => {
  assert.match(handler, /\/api\/play-history\/\$\{encodeURIComponent\(id\)\}/);
  const step = src.slice(src.indexOf("function step("), src.indexOf("async function handleDelete()"));
  assert.match(step, /setError\(null\);\s*setConfirming\(next\);/);
});
