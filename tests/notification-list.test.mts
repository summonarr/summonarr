// The /notifications page's list (src/components/notifications/notification-list.tsx)
// and the shared store's read helper. "use client" .tsx modules the loader
// can't import, so the one pure helper is cut out of the source and the
// handlers are pinned in it (the detail-action-state idiom).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript") as typeof import("typescript");
const list = readFileSync(new URL("../src/components/notifications/notification-list.tsx", import.meta.url), "utf8");
const store = readFileSync(new URL("../src/components/notifications/notification-store.tsx", import.meta.url), "utf8");

type Row = { id: string; readAt: string | null };
const m = /export function withReadAt\([\s\S]*?\n\}\n/.exec(store);
assert.ok(m, "withReadAt must exist in notification-store.tsx");
const js = ts.transpileModule(m[0], { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const withReadAt = new Function(`${js.replace("export ", "")}\nreturn withReadAt;`)() as (items: Row[], ids: ReadonlySet<string>, at: string | null) => Row[];

function handler(name: string): string {
  const start = list.indexOf(`async function ${name}(`);
  assert.ok(start > 0, `${name} not found`);
  const end = list.indexOf("\n  }\n", start);
  return list.slice(start, end);
}

test("withReadAt flips only the named rows, and returns the list untouched when there are none", () => {
  const rows: Row[] = [{ id: "a", readAt: null }, { id: "b", readAt: null }];
  assert.deepEqual(withReadAt(rows, new Set(["a"]), "t"), [{ id: "a", readAt: "t" }, { id: "b", readAt: null }]);
  assert.equal(withReadAt(rows, new Set(), "t"), rows);
});

test("a failed clear-all merges the old rows back under any that arrived meanwhile, never replaces the list", () => {
  // A notification the store delivered during the DELETE is already in `seen`,
  // so replacing the list with the snapshot dropped it until a reload.
  const body = handler("clearAll");
  assert.doesNotMatch(body, /setItems\(prevItems\)/);
  assert.match(body, /setItems\(\(cur\) => \[\.\.\.cur\.filter\(\(n\) => !prevIds\.has\(n\.id\)\), \.\.\.prevItems\]\)/);
  assert.match(body, /setTotal\(\(n\) => n \+ prevTotal\)/);
});

test("Mark all read goes through the store's request, rolling back only its own rows", () => {
  const body = handler("markAllRead");
  assert.match(body, /await markAllReadInStore\(\)/);
  assert.doesNotMatch(body, /\/api\/notifications/, "a second copy of the mark-all request");
  assert.match(list, /markAllReadConfirmed: markAllReadInStore/);
  assert.match(body, /withReadAt\(cur, flipped, null\)/);
});

test("relative times keep moving on a page left open", () => {
  assert.match(list, /useMinuteTick\(\);/);
});
