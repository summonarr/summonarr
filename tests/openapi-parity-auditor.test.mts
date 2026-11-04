// The OpenAPI parity auditor is a CI step, not part of `npm test`; run it here so
// a stale EXCEPTIONS entry (e.g. /settings/webhook-urls, now documented) or an
// undocumented route fails the unit suite too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("scripts/audit-openapi.mts passes: every route documented or excepted, no stale exceptions", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const r = spawnSync(process.execPath, ["scripts/audit-openapi.mts"], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
});
