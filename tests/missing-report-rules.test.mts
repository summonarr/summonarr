// Admin → Missing's pure rules (src/components/admin/missing-report-rules.ts):
// the instance filter that applies to the list on screen, the unmonitored
// card's population, the list key's parts and the episodes answer's check.
import { test } from "node:test";
import assert from "node:assert/strict";

const rules = await import("../src/components/admin/missing-report-rules.ts");
const { check } = await import("../src/lib/validate.ts");

const two = [{ slug: "" }, { slug: "4k" }];

test("a picked instance applies only while the list still has it and offers the picker", () => {
  assert.equal(rules.shownInstance("4k", two), "4k");
  assert.equal(rules.shownInstance("all", two), "all");
  assert.equal(rules.shownInstance("anime", two), "all", "an instance a refresh dropped (removed, renamed) no longer filters every row out");
  assert.equal(rules.shownInstance("4k", [{ slug: "4k" }]), "all", "one instance left: no picker, so no hidden filter");
  assert.equal(rules.shownInstance("4k", undefined), "all", "no list yet");
});

test("the unmonitored card counts under the same instance and title filters as its siblings", () => {
  const rows = [
    { title: "Alpha", instance: "", monitored: false },
    { title: "Beta", instance: "4k", monitored: false },
    { title: "Alpine", instance: "", monitored: true },
    { title: "Gamma", instance: "", monitored: false },
  ];
  assert.equal(rules.unmonitoredCount(rows, { instance: "all", query: "" }), 3);
  assert.equal(rules.unmonitoredCount(rows, { instance: "", query: "" }), 2);
  assert.equal(rules.unmonitoredCount(rows, { instance: "all", query: "al" }), 1, "the title filter too");
  // The list itself hides them unless the switch is on.
  assert.equal(rules.applyFilters(rows, { showUnmonitored: false, instance: "all", query: "" }).length, 1);
});

test("a list key's service and mode, without string surgery", () => {
  assert.equal(rules.serviceOf("sonarr:cutoff"), "sonarr");
  assert.equal(rules.serviceOf("radarr:missing"), "radarr");
  assert.equal(rules.modeOf("sonarr:cutoff"), "cutoff");
  assert.equal(rules.modeOf("radarr:missing"), "missing");
});

test("the orders the admin can pick", () => {
  const movies = [{ title: "b", releasedAt: "2024-02-01" }, { title: "a", releasedAt: "2023-01-01" }];
  assert.deepEqual(rules.sortMovies([...movies], "oldest", "en").map((m) => m.title), ["a", "b"]);
  assert.deepEqual(rules.sortMovies([...movies], "recent", "en").map((m) => m.title), ["b", "a"], "the server's order");
  const series = [{ title: "b", missing: 1 }, { title: "a", missing: 1 }, { title: "c", missing: 5 }];
  assert.deepEqual(rules.sortSeries([...series], "most", "en").map((s) => s.title), ["c", "a", "b"]);
});

test("an episodes answer is checked before it is listed", () => {
  const ep = { seasonNumber: 1, episodeNumber: 2, title: "Pilot", airDateUtc: "2024-01-01T00:00:00.000Z" };
  assert.ok(check(rules.MissingEpisodesAnswer, { episodes: [ep] }).ok);
  for (const body of [null, {}, { episodes: null }, { episodes: [{ ...ep, seasonNumber: "1" }] }, "<html>"]) {
    assert.equal(check(rules.MissingEpisodesAnswer, body).ok, false, JSON.stringify(body));
  }
});

test("the page filters every list, and counts its cards, through those rules", async () => {
  const { readFileSync } = await import("node:fs");
  const page = readFileSync(new URL("../src/components/admin/missing-report.tsx", import.meta.url), "utf8");
  assert.match(page, /const instanceShown = shownInstance\(instance, report\?\.instances\);/);
  assert.equal((page.match(/instance: instanceShown, query: deferredQuery/g) ?? []).length, 5, "four lists and the unmonitored count");
  assert.doesNotMatch(page, /instance, query: deferredQuery/, "no list filters on the raw pick");
  assert.match(page, /instance=\{instanceShown\}/, "the picker shows the filter that applies");
  assert.match(page, /unmonitoredCount\(report\.items, \{ instance: instanceShown, query: deferredQuery \}\)/);
  assert.match(page, /schema: MissingEpisodesAnswer,/, "an expanded series' episodes are checked, not cast");
  assert.doesNotMatch(page, /split\(":"\)\[0\] as Service/, "a list key's service comes from serviceOf");
});
