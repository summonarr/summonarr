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
  assert.equal(mounts.length, 2, "the mobile stack and the desktop column");
  const gated = table.match(
    /\{canLink \? <LinkPicker row=\{u\} accounts=\{accounts\} \/> : <LinkedAccountLabel row=\{u\} \/>\}/g,
  ) ?? [];
  assert.equal(gated.length, mounts.length, "an ungated LinkPicker would show delegates a control the route refuses");
});
