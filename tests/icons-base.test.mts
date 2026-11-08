// Every icon renders through the one shared <svg> (src/components/icons/icon-base.tsx),
// so its attributes and accessibility rule can't drift between the ~100 files.
// The node:test loader can't render .tsx, so this pins the source shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { iconA11y } from "../src/components/icons/icon-a11y.ts";

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

test("IconBase takes role and aria-hidden out of the spread and lets iconA11y decide them; other props are spread last", () => {
  const src = readFileSync(`${DIR}/icon-base.tsx`, "utf8");
  assert.match(src, /\{ size, children, role, "aria-hidden": ariaHidden, \.\.\.props \}/);
  assert.match(src, /iconA11y\(\{ \.\.\.props, role, "aria-hidden": ariaHidden \}\)/);
  assert.match(src, /role=\{a11y\.role\}/);
  assert.match(src, /aria-hidden=\{a11y\["aria-hidden"\]\}/);
  // The spread comes after the defaults so a caller can still override the rest.
  const svg = src.slice(src.indexOf("<svg"), src.indexOf("{children}"));
  assert.ok(svg.indexOf("{...props}") > svg.indexOf("aria-hidden="), "props must be spread last");
});

test("iconA11y: an unlabelled icon is hidden, a labelled one is role=img", () => {
  assert.deepEqual(iconA11y({}), { role: undefined, "aria-hidden": true });
  assert.deepEqual(iconA11y({ "aria-label": "Saved" }), { role: "img", "aria-hidden": undefined });
  assert.deepEqual(iconA11y({ "aria-labelledby": "x" }), { role: "img", "aria-hidden": undefined });
  assert.deepEqual(iconA11y({ role: "img", "aria-label": "Saved" }), { role: "img", "aria-hidden": undefined });
});

test("iconA11y: role=img with no name is dropped and the icon stays hidden", () => {
  assert.deepEqual(iconA11y({ role: "img" }), { role: undefined, "aria-hidden": true });
  assert.deepEqual(iconA11y({ role: "img", "aria-label": "" }), { role: undefined, "aria-hidden": true });
});

test("iconA11y: a caller's other role and explicit aria-hidden are kept", () => {
  assert.deepEqual(iconA11y({ role: "presentation" }), { role: "presentation", "aria-hidden": true });
  assert.deepEqual(iconA11y({ role: "button", "aria-label": "Close" }), { role: "button", "aria-hidden": undefined });
  assert.deepEqual(iconA11y({ "aria-hidden": false }), { role: undefined, "aria-hidden": false });
  assert.deepEqual(iconA11y({ "aria-label": "Saved", "aria-hidden": true }), { role: "img", "aria-hidden": true });
});

test("the icon types live in types.ts, which no icon module reaches back through the barrel for", () => {
  for (const f of [...iconFiles, "icon-base.tsx", "icon-a11y.ts"]) {
    const src = readFileSync(`${DIR}/${f}`, "utf8");
    assert.ok(!/from "\.\/index"/.test(src) && !/from "\.\/?"/.test(src), `${f} imports the barrel`);
  }
  const types = readFileSync(`${DIR}/types.ts`, "utf8");
  assert.match(types, /export type IconProps = /);
  assert.match(types, /export type IconComponent = /);
  assert.ok(!/^import (?!type)/m.test(types), "types.ts holds types only");
  assert.match(readFileSync(`${DIR}/index.ts`, "utf8"), /^export type \{ IconProps, IconComponent \} from "\.\/types";$/m);
});

test("every barrel line is the `export { X } from` shape the nav tests parse, and nothing shadows next/link", () => {
  const barrel = readFileSync(`${DIR}/index.ts`, "utf8");
  const names = [...barrel.matchAll(/export \{ (\w+)(?: as (\w+))? \} from "\.\/([\w-]+)";/g)].map((m) => m[2] ?? m[1]);
  assert.ok(names.length >= iconFiles.length, "every icon is exported");
  assert.ok(!names.includes("Link"), "the link icon is LinkIcon; `Link` reads as next/link");
  assert.ok(names.includes("LinkIcon"));
  assert.ok(!/ as \w+ \}/.test(barrel), "each icon is exported under one name only");
  assert.ok(!barrel.includes("icon-base"), "IconBase is internal to the folder");
});
