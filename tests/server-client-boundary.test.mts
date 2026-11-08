// A server module must never CALL (or read a property of) a value it imports
// from a "use client" module. On the server such an import is a client
// reference: rendering it as a component works, but calling it — a formatter, a
// label helper — or reading a field of an exported object throws at request
// time. Pure helpers a server page needs live in a module without the
// directive (activity-format.ts beside activity-ui.tsx is the pattern).
//
// Scanned: every file under src/app, src/components and src/lib without the
// directive — pages, layouts, route handlers, and any component or helper a
// server page may import. A call to a hook (`useX`) is skipped: a module that
// calls a hook can only run inside a client tree, so it is client by use.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import ts from "typescript";
import { hasUseClientDirective } from "./_use-client.mts";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "generated" && entry.name !== "node_modules") walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

const clientCache = new Map<string, boolean>();
function isClientModule(file: string): boolean {
  let hit = clientCache.get(file);
  if (hit === undefined) {
    const text = readFileSync(file, "utf8");
    hit = hasUseClientDirective(text);
    clientCache.set(file, hit);
  }
  return hit;
}

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = join(dirname(from), spec);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

type Misuse = { file: string; name: string; from: string; how: string };

function misusesIn(file: string): Misuse[] {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const fromClient = new Map<string, string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const clause = stmt.importClause;
    if (!clause || clause.isTypeOnly) continue;
    const target = resolveImport(file, stmt.moduleSpecifier.text);
    if (!target || !isClientModule(target)) continue;
    const from = relative(ROOT, target);
    if (clause.name) fromClient.set(clause.name.text, from);
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) fromClient.set(bindings.name.text, from);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) if (!el.isTypeOnly) fromClient.set(el.name.text, from);
    }
  }
  if (fromClient.size === 0) return [];
  const out: Misuse[] = [];
  const visit = (node: ts.Node) => {
    const flag = (expr: ts.Expression, how: string) => {
      if (ts.isIdentifier(expr) && fromClient.has(expr.text) && !(how === "called" && /^use[A-Z]/.test(expr.text))) {
        out.push({ file: relative(ROOT, file), name: expr.text, from: fromClient.get(expr.text)!, how });
      }
    };
    if (ts.isCallExpression(node)) flag(node.expression, "called");
    else if (ts.isNewExpression(node)) flag(node.expression, "constructed");
    else if (ts.isPropertyAccessExpression(node)) flag(node.expression, "property read");
    else if (ts.isElementAccessExpression(node)) flag(node.expression, "element read");
    else if (ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) flag(node.expression, "spread");
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

test("no server module calls or reads into a value imported from a \"use client\" module", () => {
  const serverFiles = ["app", "components", "lib"].flatMap((d) => walk(join(SRC, d))).filter((f) => !isClientModule(f));
  assert.ok(serverFiles.length > 300, `the scan must see the app's server files (saw ${serverFiles.length})`);
  const misuses = serverFiles.flatMap(misusesIn);
  assert.deepEqual(
    misuses.map((m) => `${m.file}: ${m.name} (${m.how}) from ${m.from}`),
    [],
  );
});
