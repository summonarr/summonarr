// The browser's check of a release search's answer (release-search-schema.ts)
// against what the server actually sends: every release toArrRelease projects
// passes it, so a valid search is never shown as a failure, and a body that is
// not a release list is refused instead of rendered from a guess.
import { test } from "node:test";
import assert from "node:assert/strict";

const { toArrRelease } = await import("../src/lib/arr-releases.ts");
const { ReleasesAnswer, SeasonsAnswer } = await import("../src/components/admin/release-search-schema.ts");
const { check } = await import("../src/lib/validate.ts");

const full = {
  guid: "g1", title: "Movie.2024.1080p", size: 1_500_000_000, indexerId: 3, indexer: "Idx",
  quality: { quality: { id: 7, name: "Bluray-1080p" }, revision: { version: 2 } },
  qualityWeight: 10, releaseWeight: 0, customFormatScore: 150, customFormats: [{ name: "HDR" }],
  languages: [{ name: "English" }], protocol: "torrent", seeders: 12, leechers: 1, age: 4,
  rejected: true, rejections: ["Not wanted"], downloadAllowed: true, downloadUrl: "http://idx/?apikey=secret",
};
// The bare minimum an older arr sends: every display field missing.
const bare = { guid: "g2", indexerId: 1, downloadAllowed: false, quality: { quality: { id: 1 } } };

test("every release the server projects passes the browser's check", () => {
  const releases = [full, bare].map(toArrRelease);
  assert.ok(releases.every((r) => r !== null));
  const parsed = check(ReleasesAnswer, { releases });
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  assert.equal(parsed.value.releases[1].protocol, "usenet");
  assert.ok(!JSON.stringify(parsed.value).includes("apikey"), "nothing but the declared fields");
});

test("a body that isn't a release list is refused, never rendered", () => {
  for (const body of [null, {}, { releases: null }, { releases: [{ guid: "x" }] }, { error: "Sonarr isn't configured" }]) {
    assert.equal(check(ReleasesAnswer, body).ok, false, JSON.stringify(body));
  }
});

test("a series' season list", () => {
  const seasons = [{ seasonNumber: 1, aired: 10, missing: 2, monitored: true }];
  const parsed = check(SeasonsAnswer, { seasons });
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value.seasons, seasons);
  assert.equal(check(SeasonsAnswer, { seasons: [{ seasonNumber: "1" }] }).ok, false);
});

test("the dialog shows the route's own reason for a refusal and checks every answer instead of casting it", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/components/admin/release-search-dialog.tsx", import.meta.url), "utf8");
  // A 422 "not configured" or a 429 with its wait is the route's text, not "search failed".
  assert.match(src, /if \(answer\.status < 200 \|\| answer\.status >= 300\) \{\s*setError\(apiErrorText\(answer\.data, failed\)\);/);
  assert.match(src, /const parsed = check\(ReleasesAnswer, answer\.data\);/);
  assert.match(src, /schema: SeasonsAnswer,/);
  assert.match(src, /setError\(failureText\(res, t\)\);/, "the seasons read and the grab say the route's reason too");
  assert.doesNotMatch(src, /as \{ (releases|seasons|error)\?/, "no cast of an answer");
  assert.doesNotMatch(src, /JSON\.parse\(targetKey\)/, "the target is never round-tripped through JSON");
});
