// Structural pin for the Settings page side nav — src/app/(app)/settings/page.tsx.
//
// Each tab renders its cards as `<div id="…">` sections, and TAB_SECTIONS is the
// hand-maintained list the sticky side nav (SettingsNav) links to. Nothing tied
// the two together, so a card could ship without a nav entry: it rendered, but
// nobody using the nav could find it. Four had — Watch Grades, Radarr 4K and
// Sonarr 4K (Media) and IP Geolocation (Integrations).
//
// Order is pinned as well as membership. SettingsNav's scroll-spy marks the LAST
// nav item whose section has scrolled past the top, walking the nav in its own
// order, so a nav listed out of page order highlights the wrong entry.
//
// Source-level because the page imports .tsx components, which the node:test
// loader cannot load (see tests/_loader.mjs) — same idiom as
// tests/detail-page-invariants.test.mts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(process.cwd(), "src", "app", "(app)", "settings", "page.tsx"), "utf-8");

// TAB_SECTIONS: `  media: [ { id: "plex", … }, … ],` per tab.
function navByTab(): Map<string, string[]> {
  const start = source.indexOf("const TAB_SECTIONS");
  assert.ok(start >= 0, "TAB_SECTIONS not found");
  const end = source.indexOf("\n};", start);
  const block = source.slice(start, end);
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

// The card ids each `{tab === "<id>" … && (` block renders, in page order.
function cardsByTab(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const openers = [...source.matchAll(/\{tab === "([a-z]+)"[^(]*&& \(/g)];
  assert.ok(openers.length > 0, "no tab blocks found");
  openers.forEach((m, i) => {
    const from = m.index! + m[0].length;
    const to = i + 1 < openers.length ? openers[i + 1].index! : source.length;
    const ids = [...source.slice(from, to).matchAll(/<div id="([a-z0-9-]+)" style=\{\{padding:22/g)].map((c) => c[1]);
    out.set(m[1], ids);
  });
  return out;
}

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
  for (const id of ["watch-grades", "radarr4k", "sonarr4k"]) assert.ok(nav.get("media")!.includes(id), id);
  assert.ok(nav.get("integrations")!.includes("ip-geolocation"));
});
