// The Settings side nav's scroll-spy rule (src/lib/client/section-spy.ts, used
// by settings-nav.tsx). It highlighted the last section whose top reached 80px
// of <main>'s top, so a short section at the end of the page — one whose top can
// never scroll that far — could never become active: clicking it highlighted
// it for a moment, then the anchor scroll's own scroll event moved the pill back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { activeSectionId, SECTION_SPY_THRESHOLD_PX } from "../src/lib/client/section-spy.ts";

const NAV = readFileSync(new URL("../src/components/settings/settings-nav.tsx", import.meta.url), "utf8");

// A 1000px viewport over a 3000px page.
const scrolledTo = (scrollTop: number) => ({ scrollTop, clientHeight: 1000, scrollHeight: 3000 });

test("mid-page: the last section whose top reached the threshold", () => {
  const sections = [
    { id: "a", top: -900 },
    { id: "b", top: SECTION_SPY_THRESHOLD_PX },
    { id: "c", top: SECTION_SPY_THRESHOLD_PX + 1 },
  ];
  assert.equal(activeSectionId(sections, scrolledTo(500)), "b");
});

test("before any section reaches the threshold, the first one", () => {
  assert.equal(activeSectionId([{ id: "a", top: 200 }, { id: "b", top: 900 }], scrolledTo(0)), "a");
});

test("at the end of the page, a short last section that can't reach the threshold is active", () => {
  const sections = [
    { id: "a", top: -1500 },
    { id: "b", top: 40 },
    { id: "short", top: 700 },
  ];
  assert.equal(activeSectionId(sections, scrolledTo(2000)), "short");
  // Within the 2px slack of the end counts as the end.
  assert.equal(activeSectionId(sections, scrolledTo(1998)), "short");
  // One more pixel to go is not the end yet.
  assert.equal(activeSectionId(sections, scrolledTo(1997)), "b");
});

test("at the end, a clicked entry that is on screen stays highlighted", () => {
  const sections = [
    { id: "a", top: -1500 },
    { id: "clicked", top: 500 },
    { id: "last", top: 700 },
  ];
  assert.equal(activeSectionId(sections, scrolledTo(2000), "clicked"), "clicked");
  // Off screen, or not on the page, the last section wins as before.
  assert.equal(activeSectionId(sections, scrolledTo(2000), "a"), "last");
  assert.equal(activeSectionId(sections, scrolledTo(2000), "gone"), "last");
});

test("a section that isn't rendered is skipped, and a page that doesn't scroll keeps its first section", () => {
  const sections = [
    { id: "a", top: 100 },
    { id: "b", top: 300 },
    { id: "missing", top: null },
  ];
  assert.equal(activeSectionId(sections, scrolledTo(2000)), "b");
  assert.equal(activeSectionId(sections, { scrollTop: 0, clientHeight: 1000, scrollHeight: 1000 }), "a");
  assert.equal(activeSectionId([], scrolledTo(0)), "");
});

test("the nav measures through the shared rule, at most once a frame, and remembers the clicked entry", () => {
  assert.match(NAV, /setActiveId\(activeSectionId\(sections, scroller, clickedRef\.current\)\)/);
  assert.match(NAV, /if \(frame === 0\) frame = requestAnimationFrame\(update\);/);
  assert.match(NAV, /if \(frame !== 0\) cancelAnimationFrame\(frame\);/);
  assert.match(NAV, /onClick=\{\(\) => \{ clickedRef\.current = id; setActiveId\(id\); \}\}/);
  // Plain #id links and the passive listener on <main> stay.
  assert.match(NAV, /href=\{`#\$\{id\}`\}/);
  assert.match(NAV, /scroller\.addEventListener\("scroll", onScroll, \{ passive: true \}\)/);
});
