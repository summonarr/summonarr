// Review 2026-09, P53 / f66 — the History table's page-1 reset on a filter
// change is folded INTO the fetch effect, not a separate effect.
//
// Why: with a standalone `useEffect(() => setPage(1), [filters])` beside the
// fetch effect, both run in the same commit (declaration order). The fetch
// effect saw the NEW filters with the OLD page and issued
// `GET /api/play-history?…&page=<old>`; the next render aborted it client-side
// and sent page 1. The abort never reaches the server, which had already
// started the grouped window-function query over the whole filtered set — one
// full history query wasted per filter change from any page other than 1.
//
// No component harness exists, so this is a structural pin over the TSX AST
// (the classic TS 6 in the tree, the same one `next build` loads), mirroring
// tests/client-render-purity.test.mts. It checks the shape that matters:
//   1. no useEffect whose body is nothing but `setPage(1)` (the two-effect
//      shape that races the fetch), and
//   2. the effect that issues the `/api/play-history?` fetch is the one that
//      calls `setPage(1)`, and it does so BEFORE the fetch call in source
//      order, guarded by an early `return` — so a filter change from page N
//      issues exactly one request.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const FILE = join(here, "..", "src", "components", "admin", "activity-history-table.tsx");

function collectUseEffects(sf: ts.SourceFile): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const walk = (n: ts.Node) => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "useEffect"
    ) {
      out.push(n);
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return out;
}

function containsCall(node: ts.Node, pred: (c: ts.CallExpression) => boolean): ts.CallExpression | null {
  let hit: ts.CallExpression | null = null;
  const walk = (n: ts.Node) => {
    if (hit) return;
    if (ts.isCallExpression(n) && pred(n)) {
      hit = n;
      return;
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return hit;
}

const isSetPageOne = (c: ts.CallExpression) =>
  ts.isIdentifier(c.expression) &&
  c.expression.text === "setPage" &&
  c.arguments.length === 1 &&
  ts.isNumericLiteral(c.arguments[0]) &&
  c.arguments[0].text === "1";

const isHistoryFetch = (c: ts.CallExpression) =>
  ts.isIdentifier(c.expression) &&
  c.expression.text === "fetch" &&
  c.arguments.length > 0 &&
  /\/api\/play-history\?\$\{/.test(c.arguments[0].getText());

test("f66: no standalone `useEffect(() => setPage(1), [filters])` beside the fetch effect", () => {
  const text = readFileSync(FILE, "utf8");
  const sf = ts.createSourceFile(FILE, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const effects = collectUseEffects(sf);
  assert.ok(effects.length >= 2, "expected the debounce + fetch effects at minimum");

  for (const eff of effects) {
    const cb = eff.arguments[0];
    if (!cb || !ts.isArrowFunction(cb)) continue;
    const body = cb.body;
    // The racing shape: an effect body that is ONLY `setPage(1)`.
    const onlySetPage =
      ts.isBlock(body) &&
      body.statements.length === 1 &&
      ts.isExpressionStatement(body.statements[0]) &&
      ts.isCallExpression(body.statements[0].expression) &&
      isSetPageOne(body.statements[0].expression);
    assert.equal(
      onlySetPage,
      false,
      "a standalone page-1 reset effect races the fetch effect and issues a wasted `page=<old>` request",
    );
  }
});

test("f66: the fetch effect decides the page-1 reset itself, before fetching, with an early return", () => {
  const text = readFileSync(FILE, "utf8");
  const sf = ts.createSourceFile(FILE, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const effects = collectUseEffects(sf);

  const fetchEffects = effects.filter((e) => containsCall(e, isHistoryFetch));
  assert.equal(fetchEffects.length, 1, "exactly one effect issues the /api/play-history list fetch");
  const eff = fetchEffects[0];

  const setPageCall = containsCall(eff, isSetPageOne);
  assert.ok(setPageCall, "the fetch effect must own the `setPage(1)` reset");
  const fetchCall = containsCall(eff, isHistoryFetch);
  assert.ok(fetchCall);
  assert.ok(
    setPageCall.getStart() < fetchCall.getStart(),
    "the reset must be decided before the request is issued",
  );

  // The reset sits in a guarded branch that returns without fetching.
  let guard: ts.IfStatement | null = null;
  for (let n: ts.Node | undefined = setPageCall; n; n = n.parent) {
    if (ts.isIfStatement(n)) {
      guard = n;
      break;
    }
  }
  assert.ok(guard, "`setPage(1)` must be inside an `if` guard");
  const thenBlock = guard.thenStatement;
  const hasReturn = ts.isBlock(thenBlock)
    ? thenBlock.statements.some((s) => ts.isReturnStatement(s))
    : ts.isReturnStatement(thenBlock);
  assert.ok(hasReturn, "the reset branch must `return` before the fetch runs");
  // The guard must be keyed on page !== 1, or a filter change on page 1 would
  // loop through a no-op reset instead of fetching.
  assert.match(guard.expression.getText(), /page\s*!==\s*1/);

  // Dependency list still carries `reloadToken` (delete refetches the CURRENT
  // page) and `page` (the reset re-fires the effect at page 1).
  const deps = eff.arguments[1];
  assert.ok(deps && ts.isArrayLiteralExpression(deps));
  const depNames = deps.elements.map((d) => d.getText());
  assert.ok(depNames.includes("page"));
  assert.ok(depNames.includes("reloadToken"));
  assert.ok(depNames.includes("buildFilterParams"));
});
