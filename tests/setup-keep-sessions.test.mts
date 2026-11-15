// The first-run "keep sessions" opt-in's wiring (guardrail 6g): which routes
// read it, what the audit records, what the setup panel does with it. The
// restore engine's own behaviour is pinned in tests/backup-import.test.mts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { importAuditDetails } from "../src/lib/backup-routes.ts";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const OK = {
  ok: true as const,
  status: 200 as const,
  warning: null,
  summary: { total: 1, executed: 1, skipped: 0, errors: 0, conflictSkippedByTable: {}, conflictSkippedTotal: 0 },
};

test("the audit row records keepSessions, defaulting to false, on success and failure", () => {
  assert.equal(importAuditDetails(OK, "setup").keepSessions, false);
  assert.equal(importAuditDetails(OK, "setup-chunked", true).keepSessions, true);
  assert.equal(importAuditDetails({ ok: false, status: 500, error: "x" }, "setup", true).keepSessions, true);
});

test("both setup routes read the header and pass it to the import and the audit", () => {
  for (const f of ["src/app/api/setup/import/route.ts", "src/app/api/setup/import-chunk/route.ts"]) {
    const src = read(f);
    assert.match(src, /parseKeepSessionsHeader\(req\.headers\)/, f);
    assert.match(src, /processBackupImport\([^)]*"setup", \{ keepSessions \}\)/, f);
    assert.match(src, /auditSetupImport\(req, result, "setup(-chunked)?", keepSessions\)/, f);
  }
});

test("no admin restore route reads the header or passes the option", () => {
  for (const f of ["src/app/api/admin/backup/db-import/route.ts", "src/app/api/admin/backup/db-import-chunk/route.ts"]) {
    const src = read(f);
    assert.doesNotMatch(src, /keepSessions|KeepSessions|keep-sessions/i, f);
  }
});

test("the setup panel: off by default, sent only when ticked AND acknowledged, gated, reset with the file", () => {
  const src = read("src/app/setup/setup-import-panel.tsx");
  assert.match(src, /useState\(false\);\s*\n\s*const \[keepAck, setKeepAck\] = useState\(false\)/);
  assert.match(src, /const keep = keepSessions && keepAck;/);
  assert.match(src, /extraHeaders: keep \? \{ "X-Restore-Keep-Sessions": "true" \} : undefined/);
  assert.match(src, /disabled=\{!file \|\| !encrypted \|\| importing \|\| \(keepSessions && !keepAck\)\}/);
  // The tick and its acknowledgement reset when the file changes or is cleared.
  assert.equal((src.match(/setKeepSessions\(false\)/g) ?? []).length >= 2, true);
  assert.doesNotMatch(src, /localStorage|sessionStorage/);
});

test("the admin Backup page has no such option", () => {
  assert.doesNotMatch(read("src/components/admin/backup-ui.tsx"), /keepSessions|Restore-Keep-Sessions/);
});
