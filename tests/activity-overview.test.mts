// The Activity overview's pure builders (src/lib/activity-overview.ts) and the
// Activity pages' relative-date helper.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  axisLabelIndices,
  buildMix,
  calendarTotals,
  heatmapPeak,
  kpiDelta,
  plexReachability,
} from "@/lib/activity-overview.ts";
import { relativeWithDateFallback } from "../src/app/(app)/admin/activity/_relative.ts";

test("kpiDelta compares unrounded values: 0.4h before is not 'new', 1.4h → 1.6h is not +100%", () => {
  assert.deepEqual(kpiDelta("New", 0.3, 0.4, true), { text: "25%", dir: "down" });
  assert.deepEqual(kpiDelta("New", 1.6, 1.4, true), { text: "14%", dir: "up" });
  assert.deepEqual(kpiDelta("New", 2, 0, true), { text: "New", dir: "up" });
  assert.equal(kpiDelta("New", 0, 0, true), null);
  assert.equal(kpiDelta("New", 5, 3, false), null, "an incomplete previous window shows no delta");
  assert.deepEqual(kpiDelta("New", 100, 100.2, true), { text: "0%", dir: "flat" });
});

test("the overview's watch-time KPI passes the unrounded hours to kpiDelta", async () => {
  const { readFileSync } = await import("node:fs");
  const page = readFileSync(new URL("../src/app/(app)/admin/activity/page.tsx", import.meta.url), "utf8");
  assert.match(page, /kpiDelta\(newLabel, stats\.totalWatchTimeHours, prevWatchTimeNum, prevComplete\)/);
  assert.doesNotMatch(page, /Math\.round\(prevWatchTimeNum\)/);
});

test("heatmapPeak finds the busiest cell, first on a tie, null when empty", () => {
  assert.equal(heatmapPeak([[0, 0], [0, 0]]), null);
  assert.deepEqual(heatmapPeak([[1, 3], [3, 2]]), { row: 0, hour: 1, value: 3 });
});

test("axisLabelIndices: up to five evenly spaced, never more than the points, none below two", () => {
  assert.deepEqual(axisLabelIndices(0), []);
  assert.deepEqual(axisLabelIndices(1), []);
  assert.deepEqual(axisLabelIndices(3), [0, 1, 2]);
  assert.deepEqual(axisLabelIndices(30), [0, 7, 15, 22, 29]);
});

test("buildMix sorts largest first and rounds each share of the total", () => {
  const mix = buildMix(
    [{ k: "a", count: 1 }, { k: "b", count: 3 }],
    (r) => ({ label: r.k, color: "c" }),
    (n) => `#${n}`,
  );
  assert.deepEqual(mix, [
    { label: "b", color: "c", value: "#3", pct: 75 },
    { label: "a", color: "c", value: "#1", pct: 25 },
  ]);
  assert.deepEqual(buildMix([{ count: 0 }], () => ({ label: "x", color: "c" }), String), [{ label: "x", color: "c", value: "0", pct: 0 }]);
});

test("calendarTotals sums plays and counts active days", () => {
  assert.deepEqual(calendarTotals([{ count: 2 }, { count: 5 }]), { totalPlays: 7, activeDays: 2 });
});

test("plexReachability: per server, trusted only while tracking runs, malformed reads as unknown", () => {
  const keys = (slug: string) => ({ url: `${slug}:url`, token: `${slug}:tok`, reachable: `${slug}:r` });
  const settings = new Map([
    [":url", "http://a"], [":r", JSON.stringify({ reachable: false })],
    ["b:url", "http://b"], ["b:r", "{not json"],
    ["c:r", JSON.stringify({ reachable: true })], // no url: unconfigured
  ]);
  const tokens = new Set([":tok", "b:tok", "c:tok"]);
  const instances = [{ slug: "", name: "Default" }, { slug: "b", name: "Basement" }, { slug: "c", name: "Cabin" }];
  assert.deepEqual(plexReachability(instances, keys, settings, tokens, true), [
    { instance: "", name: "Plex", reachable: false },
    { instance: "b", name: "Plex (Basement)", reachable: null },
    { instance: "c", name: "Plex (Cabin)", reachable: null },
  ]);
  assert.equal(plexReachability(instances, keys, settings, tokens, false)[0].reachable, null, "stale when the poller is off");
  assert.equal(plexReachability(instances, keys, settings, new Set(), true)[0].reachable, null, "no token: not configured");
});

test("relativeWithDateFallback dates an old item in the given zone, and keeps English compact", () => {
  // 23:30 UTC on 1 Jan 2020 is already 2 Jan in Tokyo.
  const d = new Date(Date.UTC(2020, 0, 1, 23, 30));
  assert.equal(relativeWithDateFallback(d, "en", "UTC"), "Jan 1, 2020");
  assert.equal(relativeWithDateFallback(d, "en", "Asia/Tokyo"), "Jan 2, 2020");
  assert.equal(relativeWithDateFallback(new Date(Date.now() - 3 * 86_400_000), "en", "UTC"), "3d ago");
  assert.equal(relativeWithDateFallback(new Date(Number.NaN), "en"), "");
});
