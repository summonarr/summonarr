// The app shell's two scrollers (<main> and the sidebar <nav>) must be
// positioned. An `sr-only` label is `position: absolute`; inside a scroller
// that is not positioned it is placed against the PAGE at its in-flow offset,
// which on a long list is thousands of pixels below the fold. The scroller's
// overflow does not clip it, so the document itself becomes scrollable and
// the whole app slides up into an empty area. The node:test loader can't
// render .tsx, so this pins the source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function scrollerClass(file: string, tag: string): string {
  const src = readFileSync(file, "utf8");
  const m = new RegExp(`<${tag}\\b[^>]*?className="([^"]*overflow-y-auto[^"]*)"`, "s").exec(src);
  assert.ok(m, `${file}: no <${tag}> scroller found`);
  return m[1];
}

test("the main content scroller contains its sr-only labels", () => {
  assert.match(scrollerClass("src/app/(app)/layout.tsx", "main"), /(^| )relative( |$)/);
});

test("the sidebar nav scroller contains its sr-only labels", () => {
  assert.match(scrollerClass("src/components/layout/sidebar.tsx", "nav"), /(^| )relative( |$)/);
});
