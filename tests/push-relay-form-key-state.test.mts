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
  // not flip the hint to a state the server never reached.
  const okBranch = src.match(/if \(res\.ok && data\.ok !== false\) \{([\s\S]*?)\} else \{/);
  assert.ok(okBranch, "handleSave success branch not found");
  assert.match(okBranch[1], /setKeyIsSet\(relayKey\.length > 0\);/);
  // Exactly one writer: the success branch. No optimistic update on Remove.
  assert.equal(src.match(/setKeyIsSet\(/g)?.length, 1);
});
