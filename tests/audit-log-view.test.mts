// The admin audit-log viewer's pure helpers (src/lib/audit-log-view.ts) and a
// few source pins on the client table, which this suite cannot render.
//
//   - parseDetails returns an object or null: a scalar or array payload (a
//     restored backup, a hand edit) reached `"before" in parsed`, which throws
//     on a scalar, and the whole page fell to the error boundary.
//   - The saved Table/Timeline choice is a cookie the page reads, so the first
//     paint is already in that view.
//   - After a successful PII scrub the table re-renders from the server, or the
//     rows on screen keep showing what the scrub removed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { parseDetails, parseAuditViewMode, formatDiffSide } = await import("../src/lib/audit-log-view.ts");

const tableSrc = readFileSync(new URL("../src/components/admin/audit-log-table.tsx", import.meta.url), "utf8");

// The body of a top-level function in the table source, up to the next one.
function fnBody(name: string): string {
  const start = tableSrc.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} is in the table source`);
  const next = tableSrc.slice(start + 1).search(/\n(?:export )?function /);
  return next < 0 ? tableSrc.slice(start) : tableSrc.slice(start, start + 1 + next);
}

test("parseDetails: a plain object or null — never a scalar or an array", () => {
  assert.deepEqual(parseDetails('{"a":1}'), { a: 1 });
  for (const raw of ["123", '"x"', "true", "null", "[1,2]", "[]", "not json", ""]) {
    assert.equal(parseDetails(raw), null, raw);
  }
  assert.equal(parseDetails(null), null);
});

test("formatDiffSide: an object spreads into key: value pairs, a scalar is labelled by its field", () => {
  const t = (k: string) => (k === "adminManage.audit.none" ? "none" : k);
  assert.equal(formatDiffSide({ role: "USER", quota: null }, undefined, t), "role: USER, quota: none");
  assert.equal(formatDiffSide({}, undefined, t), null);
  assert.equal(formatDiffSide("16", "permissions", t), "permissions: 16");
  assert.equal(formatDiffSide(null, undefined, t), "none");
});

test("parseAuditViewMode: only the two views, anything else is no saved choice", () => {
  assert.equal(parseAuditViewMode("table"), "table");
  assert.equal(parseAuditViewMode("timeline"), "timeline");
  for (const v of [undefined, null, "", "Timeline", "grid"]) assert.equal(parseAuditViewMode(v), null);
});

test("the view starts in the mode of the cookie the page reads", () => {
  const page = readFileSync(new URL("../src/app/(app)/admin/audit-log/page.tsx", import.meta.url), "utf8");
  assert.match(page, /cookies\(\)\)\.get\(AUDIT_VIEW_COOKIE\)/);
  assert.match(page, /initialViewMode=\{initialViewMode\}/);
  const view = fnBody("AuditLogView");
  assert.match(view, /useState<AuditViewMode>\(initialViewMode \?\? "table"\)/);
  assert.match(fnBody("saveViewMode"), /document\.cookie = `\$\{AUDIT_VIEW_COOKIE\}=/);
});

test("a successful PII scrub refreshes the server page", () => {
  const body = fnBody("ScrubPiiButton");
  const ok = body.indexOf("if (res.ok)");
  const refresh = body.indexOf("router.refresh()");
  assert.ok(ok >= 0 && refresh > ok, "router.refresh() runs on the success branch");
  assert.ok(refresh < body.indexOf("} else {", ok), "…and only there");
});

test("a new filter result starts without the old list's load-more error", () => {
  const view = fnBody("AuditLogView");
  const reset = view.slice(view.indexOf("filterGen.current += 1;"));
  assert.match(reset.slice(0, reset.indexOf("}, [")), /setLoadError\(false\)/);
});
