// The admin audit-log viewer's pure helpers (src/lib/audit-log-view.ts) and a
// few source pins on the client table, which this suite cannot render.
//
//   - parseDetails returns an object or null: a scalar or array payload (a
//     restored backup, a hand edit) reached `"before" in parsed`, which throws
//     on a scalar, and the whole page fell to the error boundary.
//   - The saved Table/Timeline choice is a cookie the page reads, so the first
//     paint is already in that view.
//   - After a successful PII scrub the rows on screen are read again, or they
//     keep showing what the scrub removed — every loaded page, not just the
//     first (a server refresh used to drop the rest, and the scroll).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { parseDetails, parseAuditViewMode, formatDiffSide } = await import("../src/lib/audit-log-view.ts");

const read = (file: string) => readFileSync(new URL(`../src/components/admin/${file}`, import.meta.url), "utf8");
// The viewer (audit-log-table.tsx), its filter bar and its rows.
const tableSrc = [read("audit-log-table.tsx"), read("audit-log-filters.tsx"), read("audit-log-rows.tsx")].join("\n");

// The body of a top-level function in the viewer's sources, up to the next one.
function fnBody(name: string): string {
  const start = tableSrc.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} is in the viewer's source`);
  const next = tableSrc.slice(start + 1).search(/\n(?:export )?(?:async )?function /);
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

test("a successful PII scrub re-reads every loaded row; a re-render with the same filters keeps them", () => {
  const body = fnBody("ScrubPiiButton");
  const ok = body.indexOf("if (res.ok)");
  const scrubbed = body.indexOf("onScrubbed()");
  assert.ok(ok >= 0 && scrubbed > ok, "the list is told on the success branch");
  assert.ok(scrubbed < body.indexOf("} else {", ok), "…and only there");
  const list = fnBody("AuditLogList");
  assert.match(list, /reads\.run\("reread", \(signal\) => rereadRows\(current, count, signal\)\)/);
  assert.match(fnBody("rereadRows"), /pages < Math\.ceil\(count \/ PAGE_SIZE\)/, "as many pages as were loaded");
  // A new filter result is a new list (a fresh mount); the same one keeps its pages.
  assert.match(fnBody("AuditLogView"), /const listKey = `\$\{filtersToParams\(filters\)\.toString\(\)\}\|\$\{initialLogs\[0\]\?\.id \?\? ""\}`;/);
  assert.match(fnBody("AuditLogView"), /<AuditLogList\s+key=\{listKey\}/);
  assert.doesNotMatch(list, /setLogs\(initialLogs\)/, "props are never copied into state in an effect");
});

test("the scrub's confirm moves focus onto Cancel, and back to its trigger when it closes; the result counts cleared details", () => {
  const body = fnBody("ScrubPiiButton");
  assert.match(body, /if \(confirming\) \{\s*cancelRef\.current\?\.focus\(\);/);
  assert.match(body, /if \(!busy && \(!active \|\| active === document\.body\)\) triggerRef\.current\?\.focus\(\);/);
  assert.match(body, /ref=\{cancelRef\}\s+onClick=\{\(\) => step\(false\)\}/);
  assert.match(body, /ref=\{triggerRef\}\s+onClick=\{\(\) => step\(true\)\}/);
  assert.match(body, /t\("adminManage\.audit\.scrubDetailsCleared", \{ count: details \}\)/);
});

test("a new filter result starts without the old list's load-more error, and a load for the old one can't land", () => {
  // The list is keyed by its filters: a new result is a fresh mount, and the
  // unmount aborts a load still out (useAsyncAction).
  const list = fnBody("AuditLogList");
  assert.match(list, /const \[loadError, setLoadError\] = useState\(false\);/);
  assert.match(list, /const res = await reads\.run\("more", \(signal\) => fetchAuditPage\(filters, nextCursor, signal\)\);\s*if \(!res\) return;/);
  // A page is checked before it is appended (audit-log-client.ts' AuditPageSchema).
  assert.match(fnBody("fetchAuditPage"), /\{ schema: AuditPageSchema, signal \}/);
});

test("the export menu takes focus on its first item, gives it back to its button on close, and moves with the arrows", () => {
  const menu = fnBody("ExportButton");
  assert.match(
    menu,
    /useEffect\(\(\) => \{\s*if \(open\) \{\s*wasOpen\.current = true;\s*itemRefs\.current\[0\]\?\.focus\(\);\s*\} else if \(wasOpen\.current\) \{\s*wasOpen\.current = false;\s*triggerRef\.current\?\.focus\(\);\s*\}\s*\}, \[open\]\);/,
  );
  assert.match(menu, /<button\s+ref=\{triggerRef\}/);
  assert.match(menu, /<div role="menu" onKeyDown=\{onMenuKey\}/);
  assert.match(menu, /ref=\{\(el\) => \{ itemRefs\.current\[0\] = el; \}\} role="menuitem"/);
  assert.match(menu, /ref=\{\(el\) => \{ itemRefs\.current\[1\] = el; \}\} role="menuitem"/);
  assert.match(menu, /if \(e\.key !== "ArrowDown" && e\.key !== "ArrowUp"\) return;/);
});

test("every audit action has a summary rule; an unknown one and a malformed number never render NaN", async () => {
  const { formatSummary } = await import("../src/lib/audit-log-view.ts");
  const { AUDIT_ACTIONS } = await import("../src/lib/audit-actions.ts");
  const t = ((key: string, vars: Record<string, unknown> = {}) => `${key}${JSON.stringify(vars)}`) as unknown as Parameters<typeof formatSummary>[2];
  for (const action of AUDIT_ACTIONS) assert.doesNotThrow(() => formatSummary(action, {}, t), action);
  assert.equal(formatSummary("NOT_AN_ACTION", { title: "x" }, t), null);
  assert.equal(formatSummary("constructor", {}, t), null, "an inherited key is not a rule");
  const sync = formatSummary("LIBRARY_SYNC", { durationMs: "soon" }, t);
  assert.ok(sync && !sync.includes("NaN") && sync.includes('"seconds":0'), String(sync));
});
