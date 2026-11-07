// The request blacklist manager (blacklist-manager.tsx). The page ships only the
// newest 1000 blocked rows, so whether a search result is already blocked comes
// from /api/search's own `blacklisted` flag too, and the blocked count follows
// the POST's `created` answer (tests/blacklist-route.test.mts pins the route
// side). Every row has its own in-flight slot, so one request finishing never
// re-enables another row's button mid-request. Structural pins: the component
// is client .tsx the unit loader can't render.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/components/admin/blacklist-manager.tsx", import.meta.url), "utf8");
const fn = (name: string, next: string) => {
  const a = src.indexOf(name);
  assert.ok(a >= 0, name);
  return src.slice(a, src.indexOf(next, a));
};

test("a search result keeps /api/search's blacklisted flag, and 'blocked' reads it beside the loaded rows", () => {
  const search = fn("async function runSearch", "async function add(");
  assert.match(search, /blacklisted: d\.blacklisted === true,/);
  assert.match(src, /const isBlocked = \(r: SearchResult, k: string\) => blocked\.has\(k\) \|\| r\.blacklisted;/);
  assert.match(fn("async function add(", "async function remove("), /if \(isBlocked\(r, k\) \|\| busy\.has\(k\)\) return;/);
  assert.match(src, /const rowBlocked = isBlocked\(r, k\);/);
  assert.match(src, /disabled=\{rowBlocked \|\| rowBusy\}/);
});

test("unblocking a title clears the search's stale flag for it", () => {
  const remove = fn("async function remove(", "return (\n");
  assert.match(remove, /setResults\(\(prev\) =>[\s\S]*?\{ \.\.\.r, blacklisted: false \}/);
});

test("the blocked count goes up only when the server says it added a row", () => {
  const add = fn("async function add(", "async function remove(");
  assert.match(add, /if \(d\?\.created === true\) setBlockedTotal\(\(n\) => n \+ 1\);/);
  assert.doesNotMatch(add, /items\.some\(/, "never judged from this call's stale `items` closure");
});

test("each row has its own in-flight slot, and a request clears only its own", () => {
  assert.match(src, /const \[busy, setBusy\] = useState<ReadonlySet<string>>\(\(\) => new Set\(\)\);/);
  assert.doesNotMatch(src, /setBusy\(null\)/);
  assert.doesNotMatch(src, /setBusy\(k\)/);
  for (const name of ["async function add(", "async function remove("]) {
    const body = fn(name, name === "async function add(" ? "async function remove(" : "return (\n");
    assert.match(body, /markBusy\(k, true\);/, name);
    assert.match(body, /\} finally \{\s*markBusy\(k, false\);\s*\}/, `${name} clears its own key`);
  }
  assert.match(src, /if \(on\) next\.add\(k\);\s*else next\.delete\(k\);/);
  assert.equal(src.match(/busy === k/g), null, "no single-slot comparison left");
});
