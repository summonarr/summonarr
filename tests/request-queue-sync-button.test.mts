// The request queue (/admin) admits MANAGE_REQUESTS delegates, but its Sync
// button POSTs /api/sync, which getCronActor admits for the ADMIN role only (a
// delegate's click is a 403 every time). The button is rendered on that same
// condition, so the page and the route can't disagree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf-8");

test("the queue renders the Sync button only for the ADMIN role", () => {
  const src = read("app/(app)/admin/page.tsx");
  assert.match(src, /right=\{session\.user\.role === "ADMIN" \? <SyncButton \/> : undefined\}/);
  assert.doesNotMatch(src, /right=\{<SyncButton \/>\}/, "the Sync button is offered to delegates again");
  // The page itself still admits delegates — that's why the gate is needed.
  assert.match(src, /hasPermission\(session\.user\.permissions, Permission\.MANAGE_REQUESTS\)/);
});

test("the gate mirrors what /api/sync admits: getCronActor's ADMIN role check", () => {
  const cron = read("lib/cron-auth.ts");
  const body = cron.slice(cron.indexOf("export async function getCronActor"));
  assert.match(body, /const claims = await readActiveSummonarrSessionFromRequest\(request\);\s*if \(claims\?\.role === "ADMIN"\) \{/);
  assert.match(read("app/api/sync/route.ts"), /getCronActor\(/);
});
