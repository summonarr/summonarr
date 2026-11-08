// Review 2026-09 / P70 (f101) — the iOS push relay form must re-derive "a key
// is currently set" from the CONFIRMED save, not from the server prop.
//
// The client .tsx cannot be loaded by the node:test loader, so this is a
// structural pin on the source: `keyIsSet` used to be a const derived once
// from `initialRelayKey` (the masked "••••••••" placeholder the settings page
// passes when a key exists). After Remove + Save the route clears the key
// (`apnsRelayKey` is in CLEARABLE_KEYS) and answers ok, yet the hint kept
// saying a key was set and the Remove button stayed visible until a reload —
// no settings form calls router.refresh(). The fix keeps `keyIsSet` in state
// and updates it from `relayKey` inside the success branch of handleSave.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  path.join(here, "..", "src", "components", "settings", "forms", "ios-push-relay-form.tsx"),
  "utf8",
);

test("keyIsSet is React state seeded from the prop, not a frozen const", () => {
  assert.doesNotMatch(src, /const keyIsSet = initialRelayKey\.length > 0;/);
  assert.match(src, /const \[keyIsSet, setKeyIsSet\] = useState\(initialRelayKey\.length > 0\);/);
});

test("a confirmed save re-derives keyIsSet from the value that was persisted", () => {
  // The update must sit inside the ok branch — a failed or rejected save must
  // not flip the hint to a state the server never reached. The save goes
  // through the shared settings helper, whose `ok` is a 2xx that says
  // ok: true (tests/settings-save.test.mts).
  assert.match(src, /const result = await save\(\{/);
  const okBranch = src.match(/if \(result\.ok\) \{([\s\S]*?)\n {4}\}/);
  assert.ok(okBranch, "handleSave success branch not found");
  assert.match(okBranch[1], /setKeyIsSet\(relayKey\.length > 0 \|\| \(keyIsSet && !removeKey\)\);/);
  // Exactly one writer: the success branch. No optimistic update on Remove.
  assert.equal(src.match(/setKeyIsSet\(/g)?.length, 1);
});

// As the field's value, the mask turned an edit into "mask + typed", which the
// route refuses. The field starts empty; Remove is an explicit mark.
test("the key field starts empty over a saved key; Remove marks it for deletion, a blank field keeps it", () => {
  assert.match(src, /const \[relayKey, setRelayKey\] = useState\(""\);/);
  assert.doesNotMatch(src, /useState\(initialRelayKey\)/);
  assert.match(src, /placeholder=\{keyIsSet && !removeKey \? SECRET_MASK_SENTINEL : undefined\}/);
  const field = src.slice(src.indexOf("function relayKeyField("), src.indexOf("export function IosPushRelayForm("));
  assert.match(field, /if \(typed\) return \{ apnsRelayKey: typed \};\s*return remove \? \{ apnsRelayKey: "" \} : \{\};/);
  assert.match(src, /\.\.\.relayKeyField\(relayKey, removeKey\),/);
});
