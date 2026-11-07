// Every icon renders through the one shared <svg> (src/components/icons/icon-base.tsx),
// so its attributes and accessibility rule can't drift between the ~100 files.
// The node:test loader can't render .tsx, so this pins the source shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const DIR = "src/components/icons";
const iconFiles = readdirSync(DIR).filter((f) => f.endsWith(".tsx") && f !== "icon-base.tsx");

test("no icon renders its own <svg>; each one goes through IconBase", () => {
  assert.ok(iconFiles.length > 50, `only ${iconFiles.length} icon files found`);
  for (const f of iconFiles) {
    const src = readFileSync(`${DIR}/${f}`, "utf8");
    assert.ok(!src.includes("<svg"), `${f} renders its own <svg>`);
    assert.match(src, /^import \{ IconBase \} from "\.\/icon-base";$/m, `${f} must import IconBase`);
    assert.match(src, /<IconBase \{\.\.\.props\}>/, `${f} must pass every prop to IconBase`);
  }
});

test("IconBase: unlabelled icons are hidden; a labelled one is role=img; the caller's props win", () => {
  const src = readFileSync(`${DIR}/icon-base.tsx`, "utf8");
  assert.match(src, /const labelled = Boolean\(props\["aria-label"\] \|\| props\["aria-labelledby"\]\);/);
  assert.match(src, /role=\{labelled \? "img" : undefined\}/);
  assert.match(src, /aria-hidden=\{labelled \|\| props\.role === "img" \? undefined : true\}/);
  // The spread comes after the defaults so a caller can still override them.
  const svg = src.slice(src.indexOf("<svg"), src.indexOf("{children}"));
  assert.ok(svg.indexOf("{...props}") > svg.indexOf("aria-hidden="), "props must be spread last");
});

test("every barrel line is the `export { X } from` shape the nav tests parse, and nothing shadows next/link", () => {
  const barrel = readFileSync(`${DIR}/index.ts`, "utf8");
  const names = [...barrel.matchAll(/export \{ (\w+)(?: as (\w+))? \} from "\.\/([\w-]+)";/g)].map((m) => m[2] ?? m[1]);
  assert.ok(names.length >= iconFiles.length, "every icon is exported");
  assert.ok(!names.includes("Link"), "the link icon is LinkIcon; `Link` reads as next/link");
  assert.ok(names.includes("LinkIcon"));
  assert.ok(!barrel.includes("icon-base"), "IconBase is internal to the folder");
});
