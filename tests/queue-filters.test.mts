// Admin → Download Queue's filtering (src/components/admin/queue-filters.ts,
// use-queue-filters.ts) and its Remove dialog (queue-remove-dialog.tsx).
//
//   - A tab or instance whose control is gone applies nothing: an instance
//     dropped from the report (with one instance left there is no picker at
//     all) kept hiding every row behind a control the admin couldn't see.
//   - Counts and stats are one pass each, memoised on the rows, not four filters
//     and three passes per render (every keystroke, every poll).
//   - Clearing the exact-title filter records the URL it leaves behind — the tab
//     included — so a later link to that same URL isn't mistaken for a new one.
//   - The Remove dialog keeps its last row while it animates out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { effectiveQueueFilters, filterQueueRows, queueStats, queueTabCounts } from "../src/components/admin/queue-filters.ts";

const code = (file: string) => readFileSync(new URL(`../src/components/admin/${file}`, import.meta.url), "utf8");

const two = [{ service: "radarr" as const, slug: "" }, { service: "sonarr" as const, slug: "" }];
const three = [...two, { service: "radarr" as const, slug: "4k" }];

test("a chosen instance applies only while it is listed and there is a picker to undo it", () => {
  assert.deepEqual(effectiveQueueFilters({ filter: "all", instance: "radarr:4k" }, three), { filter: "all", instance: "radarr:4k" });
  assert.equal(effectiveQueueFilters({ filter: "all", instance: "radarr:4k" }, two).instance, "all", "the instance left the report");
  assert.equal(effectiveQueueFilters({ filter: "all", instance: "radarr:" }, [two[0]]).instance, "all", "one instance: no picker");
});

test("a service tab applies only while that service has an instance", () => {
  assert.equal(effectiveQueueFilters({ filter: "sonarr", instance: "all" }, two).filter, "sonarr");
  assert.equal(effectiveQueueFilters({ filter: "sonarr", instance: "all" }, [two[0]]).filter, "all");
  assert.equal(effectiveQueueFilters({ filter: "attention", instance: "all" }, []).filter, "attention", "attention and all always have their tabs");
});

const rows = [
  { service: "radarr" as const, instance: "", attention: true, mediaTitle: "Dune", title: "Dune.2021.mkv", phase: "downloading" as const, sizeLeft: 10 },
  { service: "sonarr" as const, instance: "", attention: false, mediaTitle: "Severance", title: "Sev.S01", phase: "queued" as const, sizeLeft: 5 },
  { service: "radarr" as const, instance: "4k", attention: false, mediaTitle: "", title: "Arrival.4K", phase: "downloading" as const, sizeLeft: 0 },
];

test("rows: tab, instance and title text (the media title or the release's own)", () => {
  assert.deepEqual(filterQueueRows(rows, { filter: "radarr", instance: "all", query: "" }).map((r) => r.title), ["Dune.2021.mkv", "Arrival.4K"]);
  assert.deepEqual(filterQueueRows(rows, { filter: "all", instance: "radarr:4k", query: "" }).map((r) => r.title), ["Arrival.4K"]);
  assert.deepEqual(filterQueueRows(rows, { filter: "attention", instance: "all", query: "" }).map((r) => r.title), ["Dune.2021.mkv"]);
  assert.deepEqual(filterQueueRows(rows, { filter: "all", instance: "all", query: " ARRIVAL " }).map((r) => r.title), ["Arrival.4K"]);
});

test("tab counts and stats, one pass each", () => {
  assert.deepEqual(queueTabCounts(rows), { all: 3, attention: 1, radarr: 2, sonarr: 1 });
  assert.deepEqual(queueStats(rows), { total: 3, downloading: 2, attention: 1, sizeLeft: 15 });
});

test("the page filters, counts and labels through the hook; counts are memoised on the rows", () => {
  const hook = code("use-queue-filters.ts");
  assert.match(hook, /const applied = effectiveQueueFilters\(\{ filter, instance \}, instances\);/);
  assert.match(hook, /const counts = useMemo\(\(\) => \(items \? queueTabCounts\(titleRows\) : null\), \[items, titleRows\]\);/);
  assert.match(code("download-queue.tsx"), /const stats = useMemo\(\(\) => queueStats\(report\.items\), \[report\.items\]\);/);
});

test("clearing the title filter records the whole URL it leaves, the tab included", () => {
  const hook = code("use-queue-filters.ts");
  const clear = hook.slice(hook.indexOf("function clearTitleFilter("), hook.indexOf("const items = report?.items;"));
  assert.match(clear, /setLinked\(queueLinkKey\(\{ \.\.\.initialFilters, title: null \}\)\);/);
});

test("the Remove dialog renders its last row until the next open, so the close animation keeps its body", () => {
  const dialog = code("queue-remove-dialog.tsx");
  assert.match(dialog, /if \(target\) \{\s*setShown\(target\);/);
  assert.match(dialog, /const removing = shown\?\.row \?\? null;/);
  assert.match(dialog, /<Dialog open=\{target !== null\}/, "open still follows the page's target");
});
