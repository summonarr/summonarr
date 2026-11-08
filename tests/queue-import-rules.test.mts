// The Download Queue Import dialog's pure half (src/components/admin/queue-import-rules.ts):
// the routes' answers as the browser checks them, and the per-file editor's
// draft and the correction it sends.
import { test } from "node:test";
import assert from "node:assert/strict";

const rules = await import("../src/components/admin/queue-import-rules.ts");
const { importCandidates } = await import("../src/lib/arr-queue.ts");
const { check } = await import("../src/lib/validate.ts");

const sonarrRow = {
  path: "/downloads/Show.S01/Show.S01E01.mkv",
  relativePath: "Show.S01E01.mkv",
  size: 1_000_000,
  quality: { quality: { id: 4, name: "HDTV-720p" } },
  languages: [{ id: 1, name: "English" }],
  releaseGroup: "GRP",
  releaseType: "singleEpisode",
  series: { id: 9, title: "Show" },
  episodes: [{ id: 101, seasonNumber: 1, episodeNumber: 1 }],
  rejections: [{ reason: "Not an upgrade" }],
};
const radarrRow = { path: "/downloads/Movie/Movie.mkv", size: 0, movie: { id: 3, title: "Movie", year: 2020 } };

test("every file the server projects passes the browser's check", () => {
  const files = [...importCandidates("sonarr", [sonarrRow]), ...importCandidates("radarr", [radarrRow, { path: "/x/bare.mkv" }])];
  assert.equal(files.length, 3);
  const parsed = check(rules.ImportListAnswer, { files, qualities: [{ id: 4, name: "HDTV-720p" }], languages: [] });
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  assert.ok(check(rules.ImportPreviewAnswer, { files, rechecked: true }).ok);
});

test("a body that isn't a file list is refused, never rendered", () => {
  for (const body of [null, { error: "Radarr failed" }, { files: [{ path: "/a" }] }, { files: "nope" }]) {
    assert.equal(check(rules.ImportListAnswer, body).ok, false, JSON.stringify(body));
  }
  assert.equal(check(rules.ImportEpisodesAnswer, { episodes: [{ id: 1, seasonNumber: 1 }] }).ok, false);
  assert.ok(check(rules.ImportTargetsAnswer, { results: [{ id: 1, title: "A", year: null }] }).ok);
});

test("the draft starts from the file, and a release type the dialog doesn't offer is no choice", () => {
  const [file] = importCandidates("sonarr", [sonarrRow]);
  const d = rules.initialDraft("sonarr", file);
  assert.deepEqual(d.series, { id: 9, title: "Show", year: null });
  assert.equal(d.movie, null);
  assert.deepEqual(d.episodeIds, [101]);
  assert.equal(d.season, 1);
  assert.equal(d.releaseType, "singleEpisode");
  assert.equal(rules.initialDraft("sonarr", { ...file, releaseType: "weird" }).releaseType, null);
  assert.equal(rules.isSonarrReleaseType("seasonPack"), true);
  assert.equal(rules.isSonarrReleaseType("SeasonPack"), false);
});

test("only what the admin changed goes back as a correction", () => {
  const [file] = importCandidates("sonarr", [sonarrRow]);
  const d = rules.initialDraft("sonarr", file);
  assert.deepEqual(rules.overrideFrom(file, d, "sonarr"), {}, "nothing changed, nothing sent");
  assert.deepEqual(rules.overrideFrom(file, { ...d, episodeIds: [102, 101] }, "sonarr"), { episodeIds: [102, 101] });
  assert.deepEqual(rules.overrideFrom(file, { ...d, series: { id: 10, title: "Other", year: null }, episodeIds: [5] }, "sonarr"), { seriesId: 10, episodeIds: [5] });
  assert.deepEqual(rules.overrideFrom(file, { ...d, releaseType: "seasonPack", releaseGroup: " NEW " }, "sonarr"), { releaseGroup: "NEW", releaseType: "seasonPack" });
  assert.deepEqual(rules.overrideFrom(file, { ...d, episodeIds: [] }, "sonarr"), {}, "no episodes: no series correction");
});

test("the episodes chosen in every season are named, not only the season on screen", () => {
  const eps = [
    { id: 1, seasonNumber: 2, episodeNumber: 3, title: "c", hasFile: false },
    { id: 2, seasonNumber: 1, episodeNumber: 1, title: "a", hasFile: true },
    { id: 3, seasonNumber: 1, episodeNumber: 2, title: "b", hasFile: false },
  ];
  assert.deepEqual(rules.chosenEpisodes(eps, [1, 2]).map((e) => e.id), [2, 1], "season, then episode");
  assert.deepEqual(rules.chosenEpisodes(eps, []), []);
  assert.deepEqual(rules.toggleId([1, 2], 2), [1]);
  assert.deepEqual(rules.toggleId([1], 2), [1, 2]);
});
