// On-behalf request status line — the bulk route answers 2xx with `created: 0`
// for outcomes that are NEITHER "already requested" NOR "already available":
// `no-permission` (target user lacks the instance grant), `rating-blocked`,
// `blacklisted` and `error`. request-button.tsx used to read only `created`
// and told the requester "Already requested or available for that user" for
// every one of them. It now maps `results[0].result` through ON_BEHALF_MESSAGES.
//
// request-button.tsx is a "use client" JSX module Node cannot import, so the
// two pure declarations are lifted out of the file with the TypeScript
// compiler (the classic TS 6 in the tree, same as client-render-purity),
// transpiled and imported from a data: URL — the REAL helper is executed, not
// a copy of it. The `ItemResult` union is lifted from the bulk route the same
// way so the map can never silently fall behind a new outcome.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const COMPONENT = resolve(ROOT, "src/components/media/request-button.tsx");
const BULK_ROUTE = resolve(ROOT, "src/app/api/requests/bulk/route.ts");

const componentSource = readFileSync(COMPONENT, "utf8");
const componentSf = ts.createSourceFile(COMPONENT, componentSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function topLevelText(sf: ts.SourceFile, predicate: (node: ts.Statement) => boolean): string {
  const stmt = sf.statements.find(predicate);
  assert.ok(stmt, "declaration not found in request-button.tsx");
  return stmt.getText(sf);
}

const mapText = topLevelText(
  componentSf,
  (s) =>
    ts.isVariableStatement(s) &&
    s.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === "ON_BEHALF_MESSAGES"),
);
const fnText = topLevelText(
  componentSf,
  (s) => ts.isFunctionDeclaration(s) && s.name?.text === "onBehalfMessage",
);

const js = ts.transpileModule(`${mapText}\n${fnText}\n`, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = (await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`)) as {
  ON_BEHALF_MESSAGES: Record<string, string>;
  onBehalfMessage: (result: string | undefined, created: number | undefined) => string;
};
const { ON_BEHALF_MESSAGES, onBehalfMessage } = mod;

const COLLAPSED = "Already requested or available for that user";

function bulkItemResultMembers(): string[] {
  const src = readFileSync(BULK_ROUTE, "utf8");
  const sf = ts.createSourceFile(BULK_ROUTE, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const alias = sf.statements.find(
    (s): s is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(s) && s.name.text === "ItemResult",
  );
  assert.ok(alias, "ItemResult union not found in bulk route");
  assert.ok(ts.isUnionTypeNode(alias.type));
  return alias.type.types.map((t) => {
    assert.ok(ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal));
    return t.literal.text;
  });
}

test("every bulk ItemResult outcome has its own on-behalf message", () => {
  const members = bulkItemResultMembers();
  assert.ok(members.length >= 9, `expected the full union, got ${members.join(",")}`);
  for (const m of members) {
    assert.ok(Object.hasOwn(ON_BEHALF_MESSAGES, m), `ON_BEHALF_MESSAGES lacks "${m}"`);
    assert.notEqual(ON_BEHALF_MESSAGES[m], COLLAPSED, `"${m}" still collapses into the generic line`);
  }
  // The map has no stray keys the route can never produce.
  for (const k of Object.keys(ON_BEHALF_MESSAGES)) {
    assert.ok(members.includes(k), `ON_BEHALF_MESSAGES has unknown outcome "${k}"`);
  }
});

test("non-created outcomes are NOT reported as 'already requested or available'", () => {
  for (const r of ["no-permission", "rating-blocked", "blacklisted", "error", "skipped-declined"]) {
    const msg = onBehalfMessage(r, 0);
    assert.notEqual(msg, COLLAPSED, `${r} collapsed`);
    assert.notEqual(msg, ON_BEHALF_MESSAGES.created, `${r} read as a success`);
  }
  assert.equal(onBehalfMessage("no-permission", 0), ON_BEHALF_MESSAGES["no-permission"]);
  assert.equal(onBehalfMessage("rating-blocked", 0), ON_BEHALF_MESSAGES["rating-blocked"]);
  assert.equal(onBehalfMessage("error", 0), ON_BEHALF_MESSAGES.error);
});

test("created / auto-approved read as success; already-* keep their own lines", () => {
  assert.equal(onBehalfMessage("created", 1), "Requested for user ✓");
  assert.match(onBehalfMessage("auto-approved", 1), /✓$/);
  assert.equal(onBehalfMessage("already-requested", 0), ON_BEHALF_MESSAGES["already-requested"]);
  assert.equal(onBehalfMessage("already-available", 0), ON_BEHALF_MESSAGES["already-available"]);
});

test("older server without `results` falls back to the created-based line", () => {
  assert.equal(onBehalfMessage(undefined, 1), "Requested for user ✓");
  assert.equal(onBehalfMessage(undefined, 0), COLLAPSED);
  assert.equal(onBehalfMessage(undefined, undefined), COLLAPSED);
  // An outcome this build does not know (a newer server) also falls back
  // rather than reading a prototype key or throwing.
  assert.equal(onBehalfMessage("constructor", 0), COLLAPSED);
  assert.equal(onBehalfMessage("some-future-outcome", 1), "Requested for user ✓");
});

test("submitOnBehalf actually reads results[0].result off the bulk response", () => {
  const fn = componentSf.statements
    .find((s) => ts.isFunctionDeclaration(s) && s.name?.text === "RequestButton")
    ?.getText(componentSf);
  assert.ok(fn);
  assert.match(fn, /onBehalfMessage\(data\.results\?\.\[0\]\?\.result, data\.created\)/);
  assert.doesNotMatch(fn, /data\.created \? "Requested for user/);
});
