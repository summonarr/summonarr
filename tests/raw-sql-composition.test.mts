// Guardrail 23a (CLAUDE.md): a raw query that interpolates an SQL FRAGMENT (Prisma.sql /
// Prisma.empty / Prisma.join / Prisma.raw, or a helper returning one) is built
// with Prisma.sql and handed to $queryRaw / $executeRaw as ONE value — never
// written as a tagged template.
//
// Inside the Next bundle the client's tagged-template path did not recognise a
// fragment imported from "@/generated/prisma" as SQL and bound it as a
// parameter: Postgres answered "syntax error at or near $1" and /admin/stats
// 500'd. The unit loader shares one module instance, so every unit test passed
// — only a live `next dev` render showed it. This scan is the only thing that
// can catch a regression before a deploy does.
//
// Static and conservative: a span is flagged when its expression names a
// Prisma.* fragment builder directly, or is an identifier / call whose
// declaration in the same file builds or returns one. Plain values (a Date, a
// number, String(now)) are what tagged templates are for and pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const FRAGMENT = /\bPrisma\.(sql|empty|join|raw|Sql)\b/;

function walkSrc(dir = "src", out: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (rel.includes("/generated/")) continue;
    if (entry.isDirectory()) walkSrc(rel, out);
    else if (rel.endsWith(".ts") || rel.endsWith(".tsx")) out.push(rel);
  }
  return out;
}

// Names declared in this file whose initializer / body produces a fragment:
// `const cond = Prisma.sql\`…\``, `function sinceClause(): Prisma.Sql {…}`,
// `const x = since ? Prisma.sql\`…\` : Prisma.empty`.
function fragmentNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && FRAGMENT.test(node.initializer.getText(sf))) {
      names.add(node.name.text);
    }
    if (ts.isFunctionDeclaration(node) && node.name && FRAGMENT.test(node.getText(sf))) names.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

export function findTaggedFragmentInterpolations(rel: string, text: string): string[] {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const fragments = fragmentNames(sf);
  const hits: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isTaggedTemplateExpression(node) &&
      ts.isPropertyAccessExpression(node.tag) &&
      /^\$(queryRaw|executeRaw)$/.test(node.tag.name.text) &&
      ts.isTemplateExpression(node.template)
    ) {
      for (const span of node.template.templateSpans) {
        const e = span.expression;
        const head = ts.isCallExpression(e) ? e.expression : e;
        const named = ts.isIdentifier(head) && fragments.has(head.text);
        if (named || FRAGMENT.test(e.getText(sf))) {
          const line = sf.getLineAndCharacterOfPosition(e.getStart(sf)).line + 1;
          hits.push(`${rel}:${line} \${${e.getText(sf)}}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

test("no tagged $queryRaw/$executeRaw interpolates an SQL fragment (guardrail 23a)", () => {
  const hits = walkSrc().flatMap((rel) => findTaggedFragmentInterpolations(rel, readFileSync(join(ROOT, rel), "utf8")));
  assert.deepEqual(hits, [], "build the query with Prisma.sql and pass it as one value: prisma.$queryRaw(Prisma.sql`…${fragment}…`)");
});

test("the scan flags every fragment shape and passes plain values", () => {
  const src = `
    import { Prisma } from "@/generated/prisma";
    const cond = since ? Prisma.sql\`AND x >= \${since}\` : Prisma.empty;
    function clause(): Prisma.Sql { return Prisma.empty; }
    async function f(now: Date, ids: string[]) {
      await prisma.$queryRaw\`SELECT 1 WHERE TRUE \${cond}\`;
      await prisma.$queryRaw\`SELECT 1 WHERE TRUE \${clause()}\`;
      await prisma.$queryRaw\`SELECT 1 \${Prisma.empty}\`;
      await prisma.$executeRaw\`DELETE FROM t WHERE id IN (\${Prisma.join(ids)})\`;
      await prisma.$queryRaw\`SELECT \${String(now)}, \${now}, \${ids.length}\`;
      await prisma.$queryRaw(Prisma.sql\`SELECT 1 WHERE TRUE \${cond}\`);
    }`;
  const hits = findTaggedFragmentInterpolations("fixture.ts", src).map((h) => h.replace(/^fixture\.ts:\d+ /, ""));
  assert.deepEqual(hits, ["${cond}", "${clause()}", "${Prisma.empty}", "${Prisma.join(ids)}"]);
});
