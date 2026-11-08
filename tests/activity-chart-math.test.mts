// The Activity charts' pure half (src/components/admin/activity-chart-math.ts)
// and the directive-free format helpers (activity-format.ts): which point a
// pointer or key lands on, what the tooltip says, where it fits on screen, the
// heatmap fold and keys, the source labels and the poster gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const math = await import("../src/components/admin/activity-chart-math.ts");
const fmt = await import("../src/components/admin/activity-format.ts");

// ── pointer, keys ────────────────────────────────────────────────────────────

test("a pointer snaps to the nearest point and clamps at both ends", () => {
  assert.equal(math.nearestIndex(100, 100, 400, 5), 0);
  assert.equal(math.nearestIndex(500, 100, 400, 5), 4);
  assert.equal(math.nearestIndex(240, 100, 400, 5), 1, "35% of the way is nearer point 1 than point 2");
  assert.equal(math.nearestIndex(260, 100, 400, 5), 2);
  assert.equal(math.nearestIndex(-50, 100, 400, 5), 0, "left of the chart");
  assert.equal(math.nearestIndex(9999, 100, 400, 5), 4, "right of the chart");
  assert.equal(math.nearestIndex(200, 100, 0, 5), 0, "a zero-width box can't divide by zero");
});

test("the tooltip follows the snapped point, not the cursor", () => {
  // Five points over 400px: point 1 sits at 25% whatever the cursor's 35%.
  const i = math.nearestIndex(240, 100, 400, 5);
  assert.equal(100 + math.indexFraction(i, 5) * 400, 200);
  assert.equal(math.indexFraction(0, 1), 0);
});

test("arrow keys step through the points, Home/End jump, other keys do nothing", () => {
  assert.equal(math.keyedIndex("ArrowRight", null, 5), 0, "first press from nothing starts at the left");
  assert.equal(math.keyedIndex("ArrowLeft", null, 5), 4, "or at the right");
  assert.equal(math.keyedIndex("ArrowRight", 2, 5), 3);
  assert.equal(math.keyedIndex("ArrowRight", 4, 5), 4, "clamped at the end");
  assert.equal(math.keyedIndex("ArrowLeft", 0, 5), 0, "clamped at the start");
  assert.equal(math.keyedIndex("Home", 3, 5), 0);
  assert.equal(math.keyedIndex("End", 0, 5), 4);
  assert.equal(math.keyedIndex("Enter", 2, 5), null);
  assert.equal(math.keyedIndex("ArrowRight", null, 0), null, "an empty series has no point");
});

// ── tooltip content ──────────────────────────────────────────────────────────

test("a point's detail: share of the total, distance from the mean and from the previous point", () => {
  const data = [2, 4, 6, 0];
  const stats = math.seriesStats(data);
  assert.deepEqual(stats, { total: 12, min: 0, max: 6, avg: 3 });
  const d = math.pointDetail(data, 2, stats);
  assert.equal(d.share, 0.5);
  assert.equal(d.vsAvg, 1, "6 is twice the mean");
  assert.equal(d.delta, 2);
  assert.equal(d.vsPrev, 0.5);
  const first = math.pointDetail(data, 0, stats);
  assert.equal(first.delta, null, "nothing before the first point");
  assert.equal(first.vsPrev, null);
  const afterZero = math.pointDetail([0, 3], 1, math.seriesStats([0, 3]));
  assert.equal(afterZero.delta, 3);
  assert.equal(afterZero.vsPrev, null, "no percentage change from zero");
  const flat = math.pointDetail([0, 0], 1, math.seriesStats([0, 0]));
  assert.equal(flat.share, 0, "an all-zero series divides by nothing");
  assert.equal(flat.vsAvg, null);
  assert.deepEqual(math.seriesStats([]), { total: 0, min: 0, max: 0, avg: 0 });
});

test("the series stats are read once per series, not per hovered point", () => {
  const src = readFileSync(new URL("../src/components/admin/activity-charts.tsx", import.meta.url), "utf8");
  assert.match(src, /const stats = useMemo\(\(\) => seriesStats\(data\), \[data\]\);/);
  assert.doesNotMatch(src, /data\.reduce\(/, "no per-render total in the tooltip");
  // A move that stays on the same point keeps the same state object (no re-render).
  assert.match(src, /prev && prev\.i === next\.i && prev\.x === next\.x && prev\.top === next\.top && prev\.keyboard === next\.keyboard\s*\? prev/);
});

// ── tooltip placement ────────────────────────────────────────────────────────

const VIEW = { w: 800, h: 600 };

test("the tooltip is centred on the point and kept inside the viewport by its real width", () => {
  const mid = math.placeTooltip({ x: 400, top: 300, bottom: 300 }, { w: 200, h: 60 }, VIEW, 12);
  assert.deepEqual(mid, { left: 300, top: 228, below: false });
  const left = math.placeTooltip({ x: 10, top: 300, bottom: 300 }, { w: 200, h: 60 }, VIEW, 12);
  assert.equal(left.left, 8, "a wide tooltip near the left edge stops at the margin");
  const right = math.placeTooltip({ x: 795, top: 300, bottom: 300 }, { w: 300, h: 60 }, VIEW, 12);
  assert.equal(right.left + 300, 792, "and at the right edge by its own width, not a fixed 90px");
});

test("the tooltip flips below a point near the top, and stays above when below doesn't fit either", () => {
  const top = math.placeTooltip({ x: 400, top: 40, bottom: 62 }, { w: 120, h: 80 }, VIEW, 6);
  assert.equal(top.below, true);
  assert.equal(top.top, 68);
  const tiny = math.placeTooltip({ x: 400, top: 40, bottom: 62 }, { w: 120, h: 80 }, { w: 800, h: 120 }, 6);
  assert.equal(tiny.below, false, "no room either way: above, as before");
});

test("polyline points step evenly across the width", () => {
  assert.equal(math.polylinePoints([0, 10], 100, (v) => 10 - v), "0.00,10.00 100.00,0.00");
  assert.equal(math.polylinePoints([5], 100, (v) => v), "0.00,5.00");
});

// ── the heatmap ──────────────────────────────────────────────────────────────

test("the heatmap fold puts Sunday last and drops cells outside the 7 × 24 grid", () => {
  const m = fmt.toHeatmapMatrix([
    { dow: 0, hour: 20, count: 3 }, // Sunday → row 6
    { dow: 1, hour: 9, count: 1 }, // Monday → row 0
    { dow: 7, hour: 1, count: 9 },
    { dow: 2, hour: 24, count: 9 },
    { dow: -1, hour: 1, count: 9 },
  ]);
  assert.equal(m.length, 7);
  assert.ok(m.every((row) => row.length === 24));
  assert.equal(m[6][20], 3);
  assert.equal(m[0][9], 1);
  assert.equal(m.flat().reduce((a, b) => a + b, 0), 4, "nothing out of range landed");
});

test("the three heatmap callers share the one fold", () => {
  const read = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
  for (const p of ["components/admin/activity-user-detail.tsx", "components/watch-history/my-stats-view.tsx", "app/(app)/admin/activity/page.tsx"]) {
    const src = read(p);
    assert.match(src, /toHeatmapMatrix\(/, p);
    assert.doesNotMatch(src, /\(\w+\.dow \+ 6\) % 7/, `${p} keeps no private copy`);
  }
});

test("a short or ragged heatmap matrix draws as 7 × 24 zeros where it has nothing", () => {
  const m = fmt.normalizeHeatmapMatrix([[1, 2], [], [Number.NaN, -3, 4]]);
  assert.equal(m.length, 7);
  assert.ok(m.every((row) => row.length === 24));
  assert.deepEqual(m[0].slice(0, 3), [1, 2, 0]);
  assert.deepEqual(m[2].slice(0, 3), [0, 0, 4], "NaN and negative counts read as none");
  assert.deepEqual(m[6], new Array(24).fill(0));
});

test("heatmap keys move one cell and stop at the edges; Home/End go to the row's ends", () => {
  assert.deepEqual(math.heatmapKeyTarget("ArrowRight", 0, 23), { r: 0, c: 23 });
  assert.deepEqual(math.heatmapKeyTarget("ArrowLeft", 3, 0), { r: 3, c: 0 });
  assert.deepEqual(math.heatmapKeyTarget("ArrowDown", 6, 4), { r: 6, c: 4 });
  assert.deepEqual(math.heatmapKeyTarget("ArrowUp", 0, 4), { r: 0, c: 4 });
  assert.deepEqual(math.heatmapKeyTarget("ArrowDown", 2, 4), { r: 3, c: 4 });
  assert.deepEqual(math.heatmapKeyTarget("Home", 2, 9), { r: 2, c: 0 });
  assert.deepEqual(math.heatmapKeyTarget("End", 2, 9), { r: 2, c: 23 });
  assert.equal(math.heatmapKeyTarget("Tab", 2, 9), null, "Tab leaves the grid");
});

test("a heatmap cell's drill-down names the Postgres weekday its row was folded from", () => {
  // Row 0 is Monday (dow 1) and row 6 Sunday (dow 0): the inverse of toHeatmapMatrix.
  assert.equal(math.heatmapDetailQuery({ days: 30 }, 0, 21), "mode=hour&dow=1&hour=21&days=30");
  assert.equal(math.heatmapDetailQuery({ userId: "u1" }, 6, 0), "mode=hour&dow=0&hour=0&userId=u1");
  const m = fmt.toHeatmapMatrix([{ dow: 0, hour: 5, count: 1 }]);
  const row = m.findIndex((r) => r[5] === 1);
  assert.match(math.heatmapDetailQuery({}, row, 5), /dow=0&/, "the round trip lands on the day it came from");
  assert.equal(math.heatmapDetailQuery({ source: "plex", mediaType: "TV" }, 2, 3), "mode=hour&dow=3&hour=3&source=plex&mediaType=TV");
});

test("the heatmap is one tab stop with every cell named, and the hour axis is hidden from the tree", () => {
  const src = readFileSync(new URL("../src/components/admin/activity-heatmap.tsx", import.meta.url), "utf8");
  assert.match(src, /role="grid"/);
  assert.match(src, /role="gridcell"/);
  assert.match(src, /tabIndex=\{focusCell\.r === r && focusCell\.c === c \? 0 : -1\}/, "roving tabindex");
  assert.match(src, /aria-label=\{t\("adminActivity\.heatmap\.cellAria", \{ day, hour: hourText\(c\), zone, count: v \}\)\}/, "every cell, not just the clickable ones");
  assert.doesNotMatch(src, /tabIndex=\{(clickable|canOpen) \? 0/, "no tab stop per clickable cell");
});

// ── source, poster, slot ─────────────────────────────────────────────────────

test("a source no server type names is shown as itself, never as Jellyfin", () => {
  assert.deepEqual(fmt.sourceMeta("plex"), { label: "Plex", color: "var(--ds-plex)", tone: "plex" });
  assert.deepEqual(fmt.sourceMeta("jellyfin"), { label: "Jellyfin", color: "var(--ds-jellyfin)", tone: "jellyfin" });
  const other = fmt.sourceMeta("emby");
  assert.equal(other.label, "emby");
  assert.equal(other.tone, "neutral");
  assert.notEqual(other.color, "var(--ds-jellyfin)");
  assert.equal(fmt.sourceDotColor("emby"), other.color);
  assert.equal(fmt.sourceMeta("").label, "—");
});

test("only TMDB's image path reaches next/image", () => {
  assert.equal(fmt.isLoadablePoster("https://image.tmdb.org/t/p/w92/abc.jpg"), true);
  assert.equal(fmt.isLoadablePoster("http://image.tmdb.org/t/p/w92/abc.jpg"), false, "plain http");
  assert.equal(fmt.isLoadablePoster("https://example.com/poster.jpg"), false, "another host");
  assert.equal(fmt.isLoadablePoster("https://image.tmdb.org/t/p/"), false, "no file");
  assert.equal(fmt.isLoadablePoster(null), false);
  assert.equal(fmt.isLoadablePoster(undefined), false);
});

test("a translated sentence splits around its slot, and a sentence without one says so", () => {
  assert.deepEqual(fmt.splitAtSlot(`Most common: ${fmt.SLOT_MARK} (40%)`), { before: "Most common: ", after: " (40%)" });
  assert.equal(fmt.splitAtSlot("Most common reason (40%)"), null);
  assert.equal(fmt.splitAtSlot(`${fmt.SLOT_MARK}${fmt.SLOT_MARK}`), null);
});

test("the UTC short-day formatter prints a day key and an instant the same way everywhere", () => {
  const day = fmt.utcShortDayFormatter("en");
  assert.equal(day("2026-10-01"), "Oct 1");
  assert.equal(day("2026-10-01T23:30:00.000Z"), "Oct 1", "an instant late in the UTC day stays on its UTC date");
  assert.equal(fmt.utcShortDayFormatter("de")("2026-10-01"), "1. Okt.");
});

test("the server play page calls its formatters from the directive-free module", () => {
  const page = readFileSync(new URL("../src/app/(app)/admin/activity/play/[id]/page.tsx", import.meta.url), "utf8");
  assert.match(page, /import \{ fmtBitrate, methodLabel \} from "@\/components\/admin\/activity-format";/);
  const fromUi = /import \{([^}]*)\} from "@\/components\/admin\/activity-ui";/.exec(page)?.[1] ?? "";
  assert.doesNotMatch(fromUi, /fmtBitrate|methodLabel/, "a function called on the server must not come through a \"use client\" module");
  const format = readFileSync(new URL("../src/components/admin/activity-format.ts", import.meta.url), "utf8");
  assert.doesNotMatch(format, /^"use client"/m);
  assert.doesNotMatch(format, /from "react"/);
});
