// Structural pin for the Settings page side nav — src/app/(app)/settings/.
//
// Each tab renders its cards as `<SettingsCard id="…">` sections (one module
// per tab in _tabs/), and TAB_SECTIONS (_tabs/sections.ts) is the hand-
// maintained list the sticky side nav (SettingsNav) links to. Nothing tied the
// two together, so a card could ship without a nav entry: it rendered, but
// nobody using the nav could find it. Four had — Watch Grades, Radarr 4K and
// Sonarr 4K (Media) and IP Geolocation (Integrations).
//
// Order is pinned as well as membership. SettingsNav's scroll-spy marks the LAST
// nav item whose section has scrolled past the top, walking the nav in its own
// order, so a nav listed out of page order highlights the wrong entry.
//
// Source-level because the tabs import .tsx components, which the node:test
// loader cannot load (see tests/_loader.mjs) — same idiom as
// tests/detail-page-invariants.test.mts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), "src", "app", "(app)", "settings");
const read = (...rel: string[]) => readFileSync(join(DIR, ...rel), "utf-8");
const sections = read("_tabs", "sections.ts");
const page = read("page.tsx");

// TAB_SECTIONS: `  media: [ { id: "plex", … }, … ],` per tab.
function navByTab(): Map<string, string[]> {
  const start = sections.indexOf("export const TAB_SECTIONS");
  assert.ok(start >= 0, "TAB_SECTIONS not found");
  const end = sections.indexOf("\n};", start);
  const block = sections.slice(start, end);
  const out = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of block.split("\n")) {
    const tab = /^ {2}([a-z]+): \[/.exec(line);
    if (tab) {
      current = tab[1];
      out.set(current, []);
    }
    for (const m of line.matchAll(/\{\s*id:\s*"([a-z0-9-]+)"/g)) {
      assert.ok(current, `nav entry ${m[1]} outside a tab`);
      out.get(current)!.push(m[1]);
    }
  }
  return out;
}

// The card ids each tab module renders, in source order. The page picks the
// module per tab in TabPanel (`case "<tab>": return <XTab`), and every card is a
// `<SettingsCard id="…">` (the helper in _tabs/ui.tsx), so a card that
// bypasses the helper is invisible here and fails the membership check below —
// which is the point: the helper is what gives it an anchor.
function cardsByTab(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const cases = [...page.matchAll(/case "([a-z]+)": return <(\w+)Tab\b/g)];
  assert.ok(cases.length > 0, "no tab cases found");
  for (const [, tab, component] of cases) {
    const file = `${component.replace(/[A-Z]/g, (c, i) => (i ? "-" : "") + c.toLowerCase())}-tab.tsx`;
    const src = read("_tabs", file);
    out.set(tab, [...src.matchAll(/<SettingsCard\s+id="([a-z0-9-]+)"/g)].map((c) => c[1]));
  }
  return out;
}

const tabSources = () => [page, ...["site", "media", "notifications", "integrations", "features", "system"].map((t) => read("_tabs", `${t}-tab.tsx`))].join("\n");

test("no card bypasses the SettingsCard helper", () => {
  // The old inline recipe — a bare <div> carrying the card style — is what let
  // descriptions drift between 14px subtle and 12px muted on one tab.
  const source = tabSources();
  assert.doesNotMatch(source, /<div id="[a-z0-9-]+" style=\{\{\s*padding:\s*22/);
  assert.doesNotMatch(source, /<div style=\{\{\s*padding:\s*22/);
});

test("every settings card is listed in its tab's side nav, in page order", () => {
  const nav = navByTab();
  const cards = cardsByTab();
  assert.deepEqual([...nav.keys()].sort(), [...cards.keys()].sort(), "one nav list per rendered tab");
  for (const [tab, ids] of cards) {
    assert.deepEqual(nav.get(tab), ids, `tab "${tab}": side nav must list exactly its cards, in order`);
  }
});

test("the cards that shipped without a nav entry are listed now", () => {
  const nav = navByTab();
  for (const id of ["watch-grades", "radarr4k", "sonarr4k", "request-4k"]) assert.ok(nav.get("media")!.includes(id), id);
  assert.ok(nav.get("integrations")!.includes("ip-geolocation"));
});
