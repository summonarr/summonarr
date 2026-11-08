// A Button's size variants carry `px-*`, and tw-merge never lets a shorthand
// evict a longhand: `p-0` beside the variant's `px-2.5` kept the 10px side
// padding (Tailwind emits padding before padding-inline, so px wins). An icon
// Button zeroes its padding with `px-0`, the same group as the variant's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "generated") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

test("no <Button> passes p-0 (it cannot override the size variant's px-*)", () => {
  const offenders: string[] = [];
  for (const file of walk("src")) {
    const src = readFileSync(file, "utf8");
    if (!src.includes("<Button")) continue;
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(sf) === "Button") {
        for (const attr of node.attributes.properties) {
          if (!ts.isJsxAttribute(attr) || attr.name.getText(sf) !== "className" || !attr.initializer) continue;
          const text = attr.initializer.getText(sf);
          if (/(^|[\s"'`])p-0(?=[\s"'`]|$)/.test(text)) {
            offenders.push(`${file}:${sf.getLineAndCharacterOfPosition(attr.getStart(sf)).line + 1}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  assert.deepEqual(offenders, [], "use px-0 on an icon Button");
});
