// The History table pages back to 1 IN THE SAME UPDATE as a filter change, and
// a live refresh re-reads in the background.
//
// Why: with a standalone `useEffect(() => setPage(1), [filters])` beside the
// fetch effect, both ran in the same commit. The fetch effect saw the NEW
// filters with the OLD page and issued `GET /api/play-history?…&page=<old>`;
// the next render aborted it client-side and sent page 1. The abort never
// reaches the server, which had already started the grouped window-function
// query over the whole filtered set. The reset now lives in the query reducer
// (historyQueryReducer, unit-tested in tests/history-table-query.test.mts), so
// the fetch effect only ever sees a consistent (filters, page) pair.
//
// And: the page hands the table a fresh period lower bound on every live
// refresh (a finished play → router.refresh). That re-read must not dim the
// rows and swallow clicks the way a filter change does.
//
// No component harness exists, so these are structural pins over the TSX AST
// (the classic TS 6 in the tree, the same one `next build` loads), mirroring
// tests/client-render-purity.test.mts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const ADMIN = join(here, "..", "src", "components", "admin");
const TABLE = join(ADMIN, "activity-history-table.tsx");
const HOOKS = join(ADMIN, "activity-history", "use-history-table.ts");

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function collectCalls(sf: ts.Node, name: string): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const walk = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) out.push(n);
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return out;
}

// `setPage(1)` or `dispatch({ type: "page", page: 1 })`.
function isPageOneReset(c: ts.CallExpression): boolean {
  if (!ts.isIdentifier(c.expression)) return false;
  if (c.expression.text === "setPage") {
    return c.arguments.length === 1 && ts.isNumericLiteral(c.arguments[0]) && c.arguments[0].text === "1";
  }
  if (c.expression.text === "dispatch" && c.arguments.length === 1) {
    const text = c.arguments[0].getText().replace(/\s+/g, "");
    return /type:"page"/.test(text) && /page:1\b/.test(text);
  }
  return false;
}

test("no effect exists only to reset the page beside the fetch", () => {
  for (const file of [TABLE, HOOKS]) {
    const sf = parse(file);
    const effects = collectCalls(sf, "useEffect");
    for (const eff of effects) {
      const cb = eff.arguments[0];
      if (!cb || !ts.isArrowFunction(cb) || !ts.isBlock(cb.body)) continue;
      const resets = cb.body.statements.filter(
        (s) => ts.isExpressionStatement(s) && ts.isCallExpression(s.expression) && isPageOneReset(s.expression),
      );
      assert.equal(resets.length, 0, `${file}: a page-1 reset in an effect races the fetch effect and issues a wasted request`);
    }
  }
  assert.equal(collectCalls(parse(TABLE), "setPage").length, 0, "the table keeps no page state of its own");
});

test("the query reducer owns the page: every change but a page change starts again from page 1", () => {
  const helpers = readFileSync(join(ADMIN, "activity-history", "helpers.ts"), "utf8");
  const reducer = helpers.slice(helpers.indexOf("export function historyQueryReducer("));
  for (const kind of ["filter", "clearFilters", "grouped", "sort", "limit"]) {
    const branch = reducer.slice(reducer.indexOf(`case "${kind}"`), reducer.indexOf("case ", reducer.indexOf(`case "${kind}"`) + 5));
    assert.match(branch, /page: 1/, `the ${kind} action pages back to 1`);
  }
  assert.match(readFileSync(TABLE, "utf8"), /useHistoryQuery\(/);
  assert.match(readFileSync(HOOKS, "utf8"), /useReducer\(historyQueryReducer,/);
});

test("exactly one effect loads the list, keyed on the request, and a live refresh re-reads in the background", () => {
  const sf = parse(HOOKS);
  const isListFetch = (c: ts.CallExpression) =>
    ts.isIdentifier(c.expression) && c.expression.text === "fetchJson" && /\/api\/play-history\?\$\{requestQuery\}/.test(c.arguments[0]?.getText() ?? "");
  const fetchEffects = collectCalls(sf, "useEffect").filter((e) => collectCalls(e, "fetchJson").some(isListFetch));
  assert.equal(fetchEffects.length, 1, "exactly one effect issues the /api/play-history list fetch");
  const eff = fetchEffects[0];
  const deps = eff.arguments[1];
  assert.ok(deps && ts.isArrayLiteralExpression(deps));
  const depNames = deps.elements.map((d) => d.getText());
  for (const dep of ["requestQuery", "foregroundKey", "startDateIso"]) assert.ok(depNames.includes(dep), `deps carry ${dep}`);

  const body = eff.arguments[0].getText();
  // Only a load the admin asked for dims the rows and clears the error...
  // (beginLoad's rules are unit-tested in tests/history-table-query.test.mts.)
  assert.match(body, /const begun = beginLoad\(loads\.current, foregroundKey\);/);
  assert.match(body, /if \(!background\) \{\s*setLoading\(true\);\s*setError\(null\);\s*\}/);
  assert.equal((body.match(/loads\.current = settleLoad\(loads\.current\);/g) ?? []).length, 2, "both answers settle the load");
  // ...and a failed background re-read keeps the rows on screen.
  assert.match(body, /if \(background\) return;\s*setError\("adminActivity\.history\.loadError"\)/);
  // The period's lower bound is not part of what the admin asked for.
  const hooks = readFileSync(HOOKS, "utf8");
  assert.match(hooks, /params\.delete\("startDate"\);\s*const foregroundKey = `\$\{params\.toString\(\)\}\|\$\{reloadToken\}`;/);
  // A delete or Retry re-reads the CURRENT page through the reload token.
  assert.match(hooks, /const reload = useCallback\(\(\) => setReloadToken\(\(n\) => n \+ 1\), \[\]\);/);
});

// The table writes its filters into the URL with a null history state. Next's
// patched replaceState skips its router sync for a state that carries its own
// marker, and `window.history.state` does: with it, useSearchParams kept the
// old query and the period selector re-pushed a cleared date. The history page
// keys the table on the period filters only, so a live refresh after a filter
// edit (which re-renders the page WITH it) doesn't remount it.
test("the URL sync hands Next a null state, and the page keys the table on the period filters only", () => {
  const hooks = readFileSync(HOOKS, "utf8");
  assert.match(hooks, /window\.history\.replaceState\(null, "", url\)/);
  assert.doesNotMatch(hooks, /replaceState\(window\.history\.state/);
  assert.match(hooks, /applyHistoryUrlEntries\(url, historyUrlEntries\(/, "every mirrored key goes through the one writer");

  const page = readFileSync(join(here, "..", "src", "app", "(app)", "admin", "activity", "history", "page.tsx"), "utf8");
  const key = /<ActivityHistoryTable\s+key=\{`([^`]*)`\}/.exec(page);
  assert.ok(key, "the table is keyed");
  assert.match(key[1], /\$\{days\}/);
  for (const seeded of ["fromDate", "toDate", "initialWatched"]) {
    assert.doesNotMatch(key[1], new RegExp(`\\$\\{${seeded}\\b`), `${seeded} must not remount the table`);
  }
  assert.doesNotMatch(page, /\bdays=\{days\}/, "the table reads no period length (startDateIso carries it)");
});
