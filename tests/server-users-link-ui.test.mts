// Guardrail 34d, the UI half: linking a media-server identity to an account is
// ADMIN-only (PATCH /api/admin/server-users/[id] refuses a MANAGE_USERS delegate
// — tests/admin-routes.test.mts pins the route). The Users page admits
// delegates, so the server-user table must not hand them a link picker whose
// every change would 403. The suite renders no React DOM, so these pins are
// structural: the page derives `canLink` from the ADMIN bit, sends a delegate no
// account list, and the table mounts the picker only behind `canLink`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const page = readFileSync(new URL("../src/app/(app)/admin/users/page.tsx", import.meta.url), "utf8");
const table = readFileSync(new URL("../src/components/admin/server-user-table.tsx", import.meta.url), "utf8");

test("the Users page derives canLink from the ADMIN bit and passes it to the table", () => {
  assert.match(
    page,
    /const canLinkServerUsers = hasPermission\(session\.user\.permissions, Permission\.ADMIN\);/,
  );
  assert.match(page, /<ServerUserTable[\s\S]*?canLink=\{canLinkServerUsers\}[\s\S]*?\/>/);
});

test("a delegate is sent no link-target account list", () => {
  assert.match(page, /accounts=\{canLinkServerUsers\s*\?[\s\S]*?:\s*\[\]\}/);
});

test("every LinkPicker in the table is mounted behind canLink, with a read-only label otherwise", () => {
  const mounts = table.match(/<LinkPicker\b[^>]*\/>/g) ?? [];
  assert.equal(mounts.length, 1, "one control per row, placed by viewport");
  const gated = table.match(
    /canLink \? <LinkPicker row=\{u\} accounts=\{accounts\} \/> : <LinkedAccountLabel row=\{u\} \/>/g,
  ) ?? [];
  assert.equal(gated.length, mounts.length, "an ungated LinkPicker would show delegates a control the route refuses");
});

test("the account control renders in ONE place per row: the mobile stack or the desktop column", () => {
  // Both mounted kept two copies of every account <option> per row.
  assert.match(table, /const mdUp = useMediaQuery\("\(min-width: 48rem\)"\);/);
  assert.match(table, /<div className="md:hidden[^"]*">[\s\S]*?\{mdUp === false && linkControl\}[\s\S]*?<\/div>/);
  assert.match(table, /<td className="[^"]*hidden md:table-cell">\s*\{mdUp !== false && linkControl\}\s*<\/td>/);
});

// ── the write results the controls must read ─────────────────────────────────

const fn = (name: string) => {
  const start = table.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  const next = table.indexOf("\nfunction ", start + 1);
  const nextExport = table.indexOf("\nexport function ", start + 1);
  const ends = [next, nextExport].filter((i) => i > start);
  return table.slice(start, ends.length > 0 ? Math.min(...ends) : undefined);
};

test("a 401 reads as 'requires an administrator' like a 403 (the cron route answers 401 to a delegate)", () => {
  assert.match(fn("failureMessage"), /status === 401 \|\| status === 403/);
});

test("every control writes through the one shared path", () => {
  assert.equal((table.match(/\bfetch\(/g) ?? []).length, 1, "only sendWrite calls fetch");
  for (const name of ["LinkPicker", "DownloadToggle", "SyncUsersButton", "BulkBar", "AutoDisableToggle"]) {
    assert.match(fn(name), /sendWrite\b/, name);
  }
});

test("Sync users reads the 200 body: a held lock and a partial failure are not a silent success", () => {
  const sync = fn("SyncUsersButton");
  assert.match(sync, /result\.data\?\.skipped === true[\s\S]*?adminManage\.serverUsers\.syncSkipped/);
  assert.match(sync, /result\.data\?\.ok === false[\s\S]*?adminManage\.serverUsers\.syncErrors/);
  assert.match(sync, /role="status"[^>]*>\{notice\}/);
});

test("Bulk enable/disable warns when some users' policy never reached Jellyfin", () => {
  const bulk = fn("BulkBar");
  assert.match(bulk, /result\.data\?\.errors \?\? 0/);
  assert.match(bulk, /adminManage\.serverUsers\.bulk\.notPushed/);
  assert.match(bulk, /role="status"[^>]*>\{warning\}/);
});

// ── the Users page ───────────────────────────────────────────────────────────

test("the server-user list is bounded, and a capped list says so", () => {
  assert.match(page, /prisma\.mediaServerUser\.findMany\(\{[\s\S]*?take: SERVER_USER_LIST_CAP,[\s\S]*?\}\)/);
  // The count reads the SAME where as the list, or the notice would lie.
  assert.match(page, /prisma\.mediaServerUser\.count\(\{ where: SERVER_USER_WHERE \}\)/);
  assert.match(page, /where: SERVER_USER_WHERE,/);
  assert.match(page, /serverUserCount > serverUsers\.length && \([\s\S]*?adminManage\.serverUsers\.capped/);
});

test("a departed identity that still holds history stays listed (guardrail 28)", () => {
  assert.match(page, /SERVER_USER_WHERE[^=]*= \{ OR: \[\{ active: true \}, \{ playHistory: \{ some: \{\} \} \}\] \}/);
});

test("a blank display name falls back to the email on every surface the page feeds", () => {
  assert.match(page, /const displayName = \(name: string \| null\): string \| null => name\?\.trim\(\) \|\| null;/);
  assert.match(page, /name: displayName\(u\.name\),\n\s*email: u\.email,\n\s*role: u\.role,/);
  assert.match(page, /\.map\(\(u\) => \(\{ id: u\.id, name: displayName\(u\.name\), email: u\.email \}\)\)/);
  assert.match(page, /user: \{ \.\.\.u\.user, name: displayName\(u\.user\.name\) \}/);
});

test("the grant editor's named instances go through the shared both-twins-open merge", () => {
  assert.match(page, /mergeNamedInstanceAccess\(\s*\[\.\.\.sonarrInstances, \.\.\.radarrInstances\]/);
});
