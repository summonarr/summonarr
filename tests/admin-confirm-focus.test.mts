// Inline confirms that take the place of the button that opened them (library
// Resync, the server-user bulk switches, a TRaSH spec's Forget) keep keyboard
// focus: the confirm takes it, Cancel hands it back to the trigger, a confirmed
// Forget hands it to the row (useFocusReturn, src/hooks/use-focus-return.ts).
// Source pins: the suite renders no DOM (docs/testing.md); the scratch browser
// harness checked the focused element after each step.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

test("the focus helper moves focus only to the element named, once, and steals nothing on a confirmed run's end", () => {
  const hook = read("hooks/use-focus-return.ts");
  assert.match(hook, /if \(el && pending\.current === key\) \{\s*pending\.current = null;\s*el\.focus\(\);/);
  assert.match(hook, /if \(active === null \|\| active === document\.body\) pending\.current = key;/, "returnToIfLost only when focus fell to <body>");
});

test("library Resync: the prompt is a labelled group, Cancel takes focus and hands it back", () => {
  const src = read("components/admin/resync-library-button.tsx");
  assert.match(src, /role="group"\s*aria-labelledby=\{promptId\}/);
  assert.match(src, /autoFocus\s*onClick=\{\(\) => \{\s*focus\.returnTo\("trigger"\);\s*run\.cancel\(\);/);
  assert.match(src, /ref=\{focus\.refFor\("trigger"\)\}/);
  assert.match(src, /focus\.returnToIfLost\("trigger"\);\s*run\.finish\(/);
});

test("server users: a bulk confirm takes focus on Cancel and hands it back to the button that opened it", () => {
  const src = read("components/admin/server-user-table.tsx");
  const confirm = src.slice(src.indexOf("function BulkConfirm("), src.indexOf("function AutoDisableToggle("));
  assert.match(confirm, /role="group" aria-labelledby=\{promptId\}/);
  assert.match(confirm, /autoFocus\s*onClick=\{onCancel\}/);
  assert.match(src, /onCancel=\{\(\) => \{\s*focus\.returnTo\(confirming\);\s*setConfirming\(null\);/);
  assert.match(src, /ref=\{focus\.refFor\(kind\)\}/);
  assert.match(src, /focus\.returnToIfLost\(kind\);\s*if \(!result\?\.ok\) return;/);
});

test("server users: the auto-disable switch follows the server value, like the per-user switches", () => {
  const src = read("components/admin/server-user-table.tsx");
  const toggle = src.slice(src.indexOf("function AutoDisableToggle("), src.indexOf("export function ServerUserTable("));
  assert.match(toggle, /const on = override && override\.over === initial \? override\.value : initial;/);
  assert.ok(!/useEffect/.test(toggle), "no prop-to-state effect");
});

test("a TRaSH spec's Forget: Cancel returns focus to Forget, a confirmed Forget to the row's expand button", () => {
  const src = read("components/admin/trash-guides/spec-section.tsx");
  assert.match(src, /onForget=\{\(appId\) => \{\s*(?:\/\/[^\n]*\n\s*)*focus\.returnTo\("expand"\);\s*void onForget\(appId\);/);
  assert.match(src, /onClick=\{\(\) => \{\s*setConfirmingForget\(false\);\s*onForget\(app\.id\);/);
  assert.match(src, /onClick=\{\(\) => \{\s*focus\.returnTo\("forget"\);\s*setConfirmingForget\(false\);\s*\}\}/);
  assert.match(src, /ref=\{focus\.refFor\("expand"\)\}/);
  assert.match(src, /ref=\{focus\.refFor\("forget"\)\}/);
});

test("a spec's detail is read once per version, a collapsed row drops its read, and no read starts twice", () => {
  const src = read("components/admin/trash-guides/spec-section.tsx");
  const hook = src.slice(src.indexOf("function useSpecDetails("), src.indexOf("// Literal keys (the i18n dead-key check"));
  assert.match(hook, /if \(!expanded\.has\(spec\.id\)\) \{\s*if \(action\.busy\(key\)\) action\.abort\(key\);/);
  assert.match(hook, /if \(read\.get\(spec\.id\)\?\.version === spec\.fetchedAt \|\| action\.busy\(key\)\) continue;/);
  assert.match(hook, /\{ ifBusy: "skip" \}/);
  assert.match(hook, /if \(r && r\.version === spec\.fetchedAt\) current\.set\(spec\.id, r\.detail\);/, "an outdated payload is never shown");
});

test("closing the notifications modal mid-save still re-reads the page once the save lands", () => {
  const src = read("components/admin/user-modals/notifications-modal.tsx");
  assert.match(src, /const pending = \[\.\.\.inFlight\.current\];\s*if \(pending\.length > 0\) \{\s*void Promise\.allSettled\(pending\)\.then\(\(\) => router\.refresh\(\)\);/);
  assert.match(src, /inFlight\.current\.add\(save\);\s*try \{/);
  assert.match(src, /finally \{\s*inFlight\.current\.delete\(save\);/);
});
