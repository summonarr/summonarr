// The audit-log viewer's pure halves (src/lib/audit-log-client.ts) and the
// filter bar's wiring (src/components/admin/audit-log-filters.tsx).
//
//   - A date box only reaches the URL with a whole date: Chrome reports a year
//     still being typed ("0002-03-04"), which `new Date(2, …)` read as 1902 and
//     wrote back into the box mid-typing — one navigation per keystroke.
//   - `dateTo` ends the range at the viewer's NEXT local midnight even across a
//     DST change (the server adds 24 h; local midnight + 24 h was an hour off on
//     a 23- or 25-hour day), and the box reads it back as the day typed.
//   - A "Load more" page is checked before it is appended.
//   - Typed filters replace the history entry; clicks push one.
process.env.TZ = "America/New_York";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { actionInfo, auditPageFrom, dateFromParam, dateInputValue, dateToParam } = await import("../src/lib/audit-log-client.ts");
const bar = readFileSync(new URL("../src/components/admin/audit-log-filters.tsx", import.meta.url), "utf8");

const DAY = 86_400_000;

test("a date still being typed is not a date: the URL is left alone", () => {
  for (const partial of ["0002-03-04", "0020-03-04", "0202-03-04", "999-03-04", "2026-3-4", "garbage"]) {
    assert.equal(dateFromParam(partial), null, partial);
    assert.equal(dateToParam(partial), null, partial);
  }
  assert.equal(dateFromParam(""), "", "an emptied box clears the filter");
  assert.equal(dateToParam(""), "");
});

test("dateFrom is the viewer's local midnight", () => {
  assert.equal(dateFromParam("2026-10-05"), "2026-10-05T04:00:00.000Z");
  assert.equal(dateFromParam("1999-01-01"), "1999-01-01T05:00:00.000Z");
});

test("dateTo + the server's 24 h is the next local midnight, on DST days too", () => {
  for (const [day, nextMidnight] of [
    ["2026-10-05", "2026-10-06T04:00:00.000Z"], // an ordinary day
    ["2026-11-01", "2026-11-02T05:00:00.000Z"], // 25 hours: clocks go back
    ["2026-03-08", "2026-03-09T04:00:00.000Z"], // 23 hours: clocks go forward
  ] as const) {
    const sent = dateToParam(day);
    assert.ok(sent);
    assert.equal(new Date(Date.parse(sent) + DAY).toISOString(), nextMidnight, day);
    assert.equal(dateInputValue(sent), day, `${day} reads back as itself`);
  }
});

test("the box's value: a param's nearest local day; an old link's plain date or local midnight still reads right", () => {
  assert.equal(dateInputValue("2026-11-01"), "2026-11-01", "a bare date passes through");
  assert.equal(dateInputValue("2026-11-01T04:00:00.000Z"), "2026-11-01", "an older local-midnight dateTo");
  assert.equal(dateInputValue(dateFromParam("2026-03-08")!), "2026-03-08");
  assert.equal(dateInputValue("not a date"), "");
});

test("a Load more page is checked: rows keep their declared fields, a malformed page is none", () => {
  const row = { id: "a", createdAt: "2026-10-05T00:00:00.000Z", userId: "u", sessionId: null, userName: "alice", action: "REQUEST_APPROVE", target: "request:1", details: null, ipAddress: null, userAgent: null, provider: null };
  const page = auditPageFrom({ logs: [row], nextCursor: "a", hasMore: true });
  assert.ok(page);
  assert.equal("userId" in page.logs[0], false);
  assert.equal(auditPageFrom({ logs: [{ ...row, userName: null }], nextCursor: null, hasMore: false }), null);
  assert.equal(auditPageFrom({ logs: [row] }), null);
  assert.equal(auditPageFrom("<html>"), null);
});

test("an unknown action gets the neutral chip", () => {
  assert.deepEqual(actionInfo("SOMETHING_NEWER"), { color: "bg-zinc-800 text-zinc-400" });
  assert.notEqual(actionInfo("REQUEST_APPROVE").color, "bg-zinc-800 text-zinc-400");
});

test("the date boxes hold their own value and commit whole dates only, like the text searches", () => {
  assert.match(bar, /const dateFrom = useUrlField\(currentDateFrom, dateInputValue, dateFromParam, /);
  assert.match(bar, /const dateTo = useUrlField\(currentDateTo, dateInputValue, dateToParam, /);
  assert.match(bar, /onChange=\{\(e\) => dateFrom\.setInput\(e\.target\.value\)\}/);
  assert.doesNotMatch(bar, /onChange=\{\(e\) => navigate\(/, "no box navigates on a keystroke");
  const field = bar.slice(bar.indexOf("function useUrlField("), bar.indexOf("const sameText"));
  assert.match(field, /const next = toUrl\(input\);\s*if \(next === null\) return;/);
});

test("typed filters replace the history entry; a click (pill, toggle, Clear) pushes one", () => {
  assert.match(bar, /if \(opts\?\.replace\) router\.replace\(href\);\s*else router\.push\(href\);/);
  for (const field of ["user", "target", "dateFrom", "dateTo"]) {
    assert.match(bar, new RegExp(`navigate\\(\\{ ${field}: value \\}, \\{ replace: true \\}\\)`), field);
  }
  assert.match(bar, /<GroupTabs currentGroup=\{currentGroup\} onPick=\{\(group\) => navigate\(\{ group, action: "" \}\)\} \/>/);
  assert.match(bar, /onPick=\{\(action\) => navigate\(\{ action \}\)\}/);
});
