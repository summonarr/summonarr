// The appearance storage keys and accent list have ONE definition
// (src/lib/theme-constants.ts). The root layout's pre-paint script and the crash
// page used to carry hand-copied literals, so a new accent would be ignored
// before hydration and flash the wrong colour.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ACCENTS,
  ACCENT_STORAGE_KEY,
  THEME_STORAGE_KEY,
  applyStoredTheme,
  isAccent,
  themeInitScript,
} from "../src/lib/theme-constants.ts";

const COPIES = ["src/app/layout.tsx", "src/app/global-error.tsx", "src/components/theme/theme-provider.tsx"];

test("no hand-copied storage key or accent list outside the shared module", () => {
  for (const file of COPIES) {
    const src = readFileSync(file, "utf8");
    assert.ok(!src.includes(`"${THEME_STORAGE_KEY}"`), `${file} spells the theme storage key`);
    assert.ok(!src.includes(`"${ACCENT_STORAGE_KEY}"`), `${file} spells the accent storage key`);
    assert.doesNotMatch(src, /\[\s*"indigo"\s*,/, `${file} carries its own accent array`);
    assert.match(src, /from "@\/lib\/theme-constants"/, `${file} must read the shared module`);
  }
});

// Runs the generated script (or the in-page restore) against a stub <html> + localStorage.
function stubs(stored: Record<string, string>) {
  const attrs: Record<string, string> = {};
  const classes = new Set<string>(["dark"]);
  const documentElement = {
    setAttribute: (k: string, v: string) => { attrs[k] = v; },
    classList: { toggle: (c: string, on?: boolean) => (on ? classes.add(c) : classes.delete(c)) },
  };
  const localStorage = { getItem: (k: string) => stored[k] ?? null };
  return { attrs, classes, doc: { documentElement }, localStorage };
}
function runScript(stored: Record<string, string>) {
  const s = stubs(stored);
  new Function("document", "localStorage", themeInitScript())(s.doc, s.localStorage);
  return { attrs: s.attrs, classes: s.classes };
}
function runRestore(stored: Record<string, string>) {
  const s = stubs(stored);
  applyStoredTheme(s.doc, s.localStorage);
  return { attrs: s.attrs, classes: s.classes };
}

test("the crash page's restore and the pre-paint script are one function and agree on every input", () => {
  const cases: Array<Record<string, string>> = [
    {}, { [THEME_STORAGE_KEY]: "light" }, { [THEME_STORAGE_KEY]: "dark" }, { [THEME_STORAGE_KEY]: "sepia" },
    { [ACCENT_STORAGE_KEY]: "chartreuse" }, ...ACCENTS.map((a) => ({ [THEME_STORAGE_KEY]: "light", [ACCENT_STORAGE_KEY]: a })),
  ];
  for (const c of cases) {
    const a = runScript(c);
    const b = runRestore(c);
    assert.deepEqual(b.attrs, a.attrs, JSON.stringify(c));
    assert.deepEqual([...b.classes], [...a.classes], JSON.stringify(c));
  }
  assert.doesNotMatch(readFileSync("src/app/global-error.tsx", "utf8"), /localStorage\.getItem/, "the crash page reads storage only through applyStoredTheme");
});

test("the pre-paint script applies every accent and the stored theme", () => {
  for (const accent of ACCENTS) {
    assert.equal(runScript({ [ACCENT_STORAGE_KEY]: accent }).attrs["data-accent"], accent, accent);
  }
  const light = runScript({ [THEME_STORAGE_KEY]: "light" });
  assert.equal(light.attrs["data-theme"], "light");
  assert.equal(light.classes.has("dark"), false);
  assert.equal(runScript({ [THEME_STORAGE_KEY]: "dark" }).classes.has("dark"), true);
});

test("the pre-paint script ignores values it doesn't know", () => {
  const r = runScript({ [THEME_STORAGE_KEY]: "sepia", [ACCENT_STORAGE_KEY]: "chartreuse" });
  assert.deepEqual(r.attrs, {});
  assert.equal(isAccent("chartreuse"), false);
  assert.equal(isAccent("rose"), true);
  assert.equal(isAccent(undefined), false);
});

test("the layout still builds its script once into a module-level constant (guardrail 16a)", () => {
  const src = readFileSync("src/app/layout.tsx", "utf8");
  assert.match(src, /^const THEME_INIT_SCRIPT = themeInitScript\(\);$/m);
  assert.match(src, /suppressHydrationWarning\s+dangerouslySetInnerHTML=\{\{ __html: THEME_INIT_SCRIPT \}\}/);
});
