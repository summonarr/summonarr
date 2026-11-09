// Users page client wiring. The suite renders no React DOM, so these pins are
// structural: each names the behaviour a regression would silently drop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const createUser = read("src/components/admin/create-user-button.tsx");
const permModal = read("src/components/admin/user-modals/permissions-modal.tsx");
const permEdits = read("src/components/admin/user-modals/use-permission-edits.ts");
const userTable = read("src/components/admin/user-table.tsx");

test("Create user: the dialog can't be dismissed mid-submit, so a failure is never shown on a closed dialog", () => {
  assert.match(createUser, /onOpenChange=\{\(o\) => \{[\s\S]*?if \(!o && loading\) return;[\s\S]*?setOpen\(o\);/);
});

test("Create user: the role list is every role the user model knows, labelled from the shared keys", () => {
  assert.match(createUser, /const ROLE_RANK: Record<Role, number> = \{/, "a Record over the role type: a new role must be placed");
  assert.match(createUser, /\{ROLES\.map\(\(r\) => \(\s*<option key=\{r\} value=\{r\}>\{t\(roleLabelKey\[r\]\)\}<\/option>/);
  assert.doesNotMatch(createUser, /<option value="(USER|ISSUE_ADMIN|ADMIN)">/, "no hand-typed role option");
  assert.match(createUser, /const \[role, setRole\] = useState<Role>\("USER"\);/);
});

test("Create user: one create at a time, and the 'created' note clears itself", () => {
  assert.match(createUser, /action\.run\("create", [\s\S]*?\{ ifBusy: "skip" \}\);/);
  assert.match(createUser, /const loading = action\.busy\("create"\);/);
  assert.match(createUser, /setTimeout\(\(\) => setCreated\(null\), CREATED_NOTICE_MS\);/);
});

test("Permissions: closing saves typed quota text, waits on EVERY field's saves, and closes only once all landed", () => {
  assert.match(permModal, /const handleClose = useCallback\(async \(\) => \{\s*if \(await flushRef\.current\(\)\) onClose\(\);\s*\}, \[onClose\]\);/);
  const flush = /async function flush\(\): Promise<boolean> \{([\s\S]*?)\n  \}/.exec(permEdits)?.[1] ?? "";
  assert.ok(flush, "flush not found");
  // Text typed but not blurred is saved first, then every field is waited on —
  // the switches, grants and cap too, not only the quotas.
  assert.match(flush, /QUOTA_FIELDS\.map\(\(field\) => saveQuota\(field, quotaRef\.current\[field\]\)\)/);
  assert.match(flush, /const others = \[permissions, instanceGrants, mediaServerGrants, maxContentRating\];/);
  assert.match(flush, /Promise\.all\(\[\.\.\.started, \.\.\.others\.map\(\(f\) => f\.settled\(\)\)\]\)/);
  assert.match(flush, /if \(!results\.every\(Boolean\)\) return false;/);
  // The page is re-read once, on a close after something was saved — never per switch.
  assert.match(flush, /if \(savedAny\.current\) \{\s*savedAny\.current = false;\s*router\.refresh\(\);/);
  assert.equal(permEdits.split("router.refresh()").length - 1, 1, "router.refresh only in flush");
});

test("Permissions: a change made while a save is out is queued (FieldSave), never dropped, and the Saving line counts every PATCH", () => {
  assert.match(permEdits, /const saving = pending > 0;/);
  assert.match(permEdits, /setPending\(\(n\) => n \+ 1\);/);
  assert.match(permEdits, /setPending\(\(n\) => n - 1\);/);
  assert.doesNotMatch(permEdits, /setSaving\(/);
  // Every field saves through its FieldSave (field-save.ts), one field per PATCH.
  for (const field of ["permissions", "instanceGrants", "mediaServerGrants", "maxContentRating"]) {
    assert.match(permEdits, new RegExp(`savers\\(\\)\\.${field}\\.set\\(`), `${field} saves through its FieldSave`);
  }
  assert.match(permEdits, /return saver\.set\(value\);/, "quota fields too");
  // The editor's switches pass no `busy`, so a click mid-save is never ignored.
  assert.doesNotMatch(permModal, /busy=\{/);
  assert.doesNotMatch(permModal, /if \(!saving\)/);
});

test("Permissions: a quota field shows the value that was saved, and junk is refused out loud", () => {
  assert.match(permEdits, /setQuota\(\(q\) => \(\{ \.\.\.q, \[field\]: formatQuota\(value\) \}\)\);/);
  assert.match(permEdits, /!Number\.isFinite\(value\)\) \{[\s\S]*?setFailure\(\{ field, text: t\("adminManage\.perm\.quota\.invalid"\) \}\);/);
});

test("Users table: busy and error state are per row, and a finishing action clears only its own row", () => {
  // Busy is one async-action key per row: two rows' actions never clear each
  // other, and a row runs one action at a time.
  assert.match(userTable, /const rowKey = \(id: string\) => `row:\$\{id\}`;/);
  assert.match(userTable, /const res = await action\.run\(rowKey\(id\), \(signal\) => fetchJson\(withBasePath\(path\), \{ init, signal \}\), \{ ifBusy: "skip" \}\);/);
  assert.match(userTable, /const isBusy = action\.busy\(rowKey\(u\.id\)\);/);
  assert.match(userTable, /const \[errors, setErrors\] = useState<Record<string, string>>\(\{\}\);/);
  assert.match(userTable, /setErrors\(\(e\) => withoutKey\(e, id\)\);/);
  assert.doesNotMatch(userTable, /setBusy\(|setError\(null\)/);
  // A refusal shows the route's own reason (request-failure-text.ts).
  assert.match(userTable, /requestFailureText\(res, t, \{ status: "adminManage\.users\.error\.requestFailed", network: "adminManage\.users\.error\.network" \}\)/);
});

test("Users table: focus returns to the row's actions menu after a cancel or a finished action", () => {
  assert.match(userTable, /onCancel=\{\(\) => \{ setConfirming\(null\); setRefocusId\(u\.id\); \}\}/);
  assert.match(userTable, /if \(res === undefined\) return;\s*setRefocusId\(id\);/);
  assert.match(userTable, /refocus=\{refocusId === u\.id\}/);
  // Only when nothing else holds focus: an admin who moved on keeps their place.
  assert.match(userTable, /if \(!active \|\| active === document\.body\) triggerRef\.current\?\.focus\(\);/);
});

test("Watch Sync: Run now is off while a run is already going on the server", () => {
  const panel = read("src/components/admin/watch-sync-panel.tsx");
  assert.match(panel, /disabled=\{running \|\| serverRunning \|\| data\.pairs\.length === 0\}/);
});

test("Users table: demoting an ADMIN asks first, like promoting to ADMIN", () => {
  assert.match(userTable, /u\.role === "ADMIN" \? onDemote\("USER"\) : onPatch\(\{ role: "USER" \}\)/);
  assert.match(userTable, /u\.role === "ADMIN" \? onDemote\("ISSUE_ADMIN"\) : onPatch\(\{ role: "ISSUE_ADMIN" \}\)/);
  assert.match(userTable, /demote:\s+\{ hintKey: "adminManage\.users\.confirm\.demoteHint"/);
});

test("Permissions: a later save of another field does not clear a refused field's error", () => {
  assert.match(permEdits, /setFailure\(\(f\) => \(f\?\.field === field \? null : f\)\)/);
  assert.doesNotMatch(permEdits, /setError\(null\)/);
});
