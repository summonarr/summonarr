// Users page client wiring. The suite renders no React DOM, so these pins are
// structural: each names the behaviour a regression would silently drop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const createUser = read("src/components/admin/create-user-button.tsx");
const permModal = read("src/components/admin/user-modals/permissions-modal.tsx");
const userTable = read("src/components/admin/user-table.tsx");

test("Create user: the dialog can't be dismissed mid-submit, so a failure is never shown on a closed dialog", () => {
  assert.match(createUser, /onOpenChange=\{\(o\) => \{[\s\S]*?if \(!o && loading\) return;[\s\S]*?setOpen\(o\);/);
});

test("Permissions: closing flushes quota edits and closes only once every save succeeded", () => {
  assert.match(permModal, /const handleClose = useCallback\(async \(\) => \{\s*if \(await flushQuotaRef\.current\(\)\) onClose\(\);\s*\}, \[onClose\]\);/);
  // Saves already in flight from a blur are awaited too, not only the dirty fields.
  assert.match(permModal, /Promise\.all\(\[\.\.\.started, \.\.\.quotaSavesRef\.current\]\)/);
  assert.match(permModal, /return results\.every\(Boolean\);/);
});

test("Permissions: the busy gate counts PATCHes in flight, so one finishing can't re-enable the toggles", () => {
  assert.match(permModal, /const saving = pending > 0;/);
  assert.match(permModal, /setPending\(\(n\) => n \+ 1\);/);
  assert.match(permModal, /setPending\(\(n\) => n - 1\);/);
  assert.doesNotMatch(permModal, /setSaving\(/);
});

test("Permissions: a quota field shows the value that was saved, and junk is refused out loud", () => {
  assert.match(permModal, /setQuota\(\(q\) => \(\{ \.\.\.q, \[field\]: value\?\.toString\(\) \?\? "" \}\)\);/);
  assert.match(permModal, /!Number\.isFinite\(value\)\) \{[\s\S]*?setError\(t\("adminManage\.perm\.quota\.invalid"\)\);/);
});

test("Users table: busy and error state are per row, and a finishing action clears only its own row", () => {
  assert.match(userTable, /const \[busy, setBusy\] = useState<Record<string, string>>\(\{\}\);/);
  assert.match(userTable, /const \[errors, setErrors\] = useState<Record<string, string>>\(\{\}\);/);
  assert.match(userTable, /setBusy\(\(b\) => \(b\[id\] === token \? withoutKey\(b, id\) : b\)\);/);
  assert.match(userTable, /const isBusy = busy\[u\.id\] !== undefined;/);
  assert.doesNotMatch(userTable, /setBusy\(null\)|setError\(null\)/);
});

test("Users table: focus returns to the row's actions menu after a cancel or a finished action", () => {
  assert.match(userTable, /onClick=\{\(\) => \{ setConfirming\(null\); setRefocusId\(u\.id\); \}\}/);
  assert.match(userTable, /refocus=\{refocusId === u\.id\}/);
  // Only when nothing else holds focus: an admin who moved on keeps their place.
  assert.match(userTable, /if \(!active \|\| active === document\.body\) triggerRef\.current\?\.focus\(\);/);
});
