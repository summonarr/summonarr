// Unit tests for src/lib/sonarr-completion.ts — the ONE definition of "Sonarr
// has finished downloading this series" (guardrail 14a), shared by the sync
// cache writer (getSonarrWantedTmdbIds) and the webhook gate
// (isSeriesDownloadedInSonarr). Pure and zero-import, so every branch is
// exercised directly with hand-built /api/v3/series row shapes.
//
// What is pinned:
//   - "complete" = every aired, monitored, REGULAR-season episode has a file.
//     A continuing series with a partial season is NOT complete (the old rule
//     called any single file "available" for a non-ended series).
//   - Specials never count. Sonarr's series-level statistics block sums season
//     0 too, so the per-season blocks are the source of truth whenever present.
//   - The series-level block is only a fallback for payloads that carry no
//     per-season statistics — and a seasons list with NO stats must not read
//     as 0/0 ("no files") over a series block that says otherwise.
//   - A shrinking denominator (an episode unmonitored after its file landed)
//     still reads complete; a zero-episode series never does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sonarrSeriesCompletion } from "../src/lib/sonarr-completion.ts";

const season = (seasonNumber: number, episodeFileCount: number, episodeCount: number) =>
  ({ seasonNumber, statistics: { episodeFileCount, episodeCount } });

test("a continuing series with a partial season is INCOMPLETE — one file no longer means available", () => {
  // Season 2 has aired 10 episodes; only 3 are on disk (a season pack mid-import).
  const row = { status: "continuing", seasons: [season(1, 10, 10), season(2, 3, 10)] };
  const c = sonarrSeriesCompletion(row);
  assert.equal(c.complete, false);
  assert.equal(c.episodeFileCount, 13);
  assert.equal(c.episodeCount, 20);
  assert.equal(c.basis, "seasons");
});

test("every aired regular-season episode on disk is COMPLETE, whatever the series status", () => {
  for (const status of ["continuing", "ended", "upcoming", undefined]) {
    const c = sonarrSeriesCompletion({ status, seasons: [season(1, 10, 10), season(2, 10, 10)] });
    assert.equal(c.complete, true, `status=${status}`);
    assert.equal(c.episodeFileCount, 20);
    assert.equal(c.episodeCount, 20);
  }
});

test("unaired episodes of a continuing series do not count against completeness", () => {
  // Sonarr's per-season episodeCount already excludes unaired episodes (it is
  // "(monitored AND aired) OR has-file"), so a season with 4 of 12 aired and all
  // 4 on disk reports 4/4. The helper must not reach for any other total.
  const row = {
    status: "continuing",
    seasons: [{ seasonNumber: 1, statistics: { episodeFileCount: 4, episodeCount: 4, totalEpisodeCount: 12 } }],
  };
  assert.equal(sonarrSeriesCompletion(row).complete, true);
});

test("specials are EXCLUDED: a season-0 gap never holds a complete series back", () => {
  // The series-level block Sonarr ships sums season 0 too (24 files / 30
  // counted here). Reading it would leave this series incomplete forever over
  // six specials nobody can find.
  const row = {
    statistics: { episodeFileCount: 24, episodeCount: 30 },
    seasons: [season(0, 0, 6), season(1, 12, 12), season(2, 12, 12)],
  };
  const c = sonarrSeriesCompletion(row);
  assert.equal(c.complete, true);
  assert.equal(c.episodeFileCount, 24);
  assert.equal(c.episodeCount, 24);
  assert.equal(c.basis, "seasons");
});

test("specials are excluded in the OTHER direction too: files in season 0 cannot make an incomplete series read complete", () => {
  // 10 special files, 0/10 regular episodes on disk. Summing across seasons
  // would give 10/10 = complete; the regular seasons alone give 0/10.
  const row = { seasons: [season(0, 10, 10), season(1, 0, 10)] };
  const c = sonarrSeriesCompletion(row);
  assert.equal(c.complete, false);
  assert.equal(c.episodeFileCount, 0);
  assert.equal(c.episodeCount, 10);
});

test("a shrinking denominator (episode unmonitored after its file landed) still reads complete", () => {
  // Sonarr counts a file-bearing episode in both numbers, so equality is the
  // steady state — but the operator's escape hatch for an unobtainable episode
  // is to unmonitor it, and the numbers can then cross. `>=`, never `===`.
  const c = sonarrSeriesCompletion({ seasons: [season(1, 9, 8)] });
  assert.equal(c.complete, true);
});

test("a series with nothing aired and nothing on disk is NOT complete (0/0 is 'awaiting release', not 'done')", () => {
  assert.equal(sonarrSeriesCompletion({ seasons: [season(1, 0, 0)] }).complete, false);
  assert.equal(sonarrSeriesCompletion({ statistics: { episodeFileCount: 0, episodeCount: 0 } }).complete, false);
  assert.equal(sonarrSeriesCompletion({}).complete, false);
  assert.equal(sonarrSeriesCompletion(null).complete, false);
  assert.equal(sonarrSeriesCompletion(undefined).complete, false);
});

test("falls back to the series-level block ONLY when no regular season carries statistics", () => {
  // No seasons at all → series block.
  const noSeasons = sonarrSeriesCompletion({ statistics: { episodeFileCount: 5, episodeCount: 5 } });
  assert.equal(noSeasons.complete, true);
  assert.equal(noSeasons.basis, "series");

  // Seasons listed but WITHOUT statistics (older payload / stats omitted) → the
  // series block still decides; the bare season list must not read as 0/0.
  const bareSeasons = sonarrSeriesCompletion({
    statistics: { episodeFileCount: 5, episodeCount: 5 },
    seasons: [{ seasonNumber: 1, monitored: true }, { seasonNumber: 2, monitored: true }],
  });
  assert.equal(bareSeasons.complete, true);
  assert.equal(bareSeasons.basis, "series");

  // Only season 0 carries stats → no REGULAR season has them → series block.
  const specialsOnly = sonarrSeriesCompletion({
    statistics: { episodeFileCount: 5, episodeCount: 5 },
    seasons: [season(0, 1, 1), { seasonNumber: 1 }],
  });
  assert.equal(specialsOnly.basis, "series");

  // But ONE regular season with stats is enough to switch to the per-season
  // basis, and a sibling season without stats then simply contributes nothing.
  const mixed = sonarrSeriesCompletion({
    statistics: { episodeFileCount: 99, episodeCount: 99 },
    seasons: [season(1, 2, 4), { seasonNumber: 2 }],
  });
  assert.equal(mixed.basis, "seasons");
  assert.equal(mixed.complete, false);
  assert.equal(mixed.episodeCount, 4);
});

test("malformed counts (negative, fractional, strings, null) read as zero rather than throwing or matching", () => {
  const row = {
    seasons: [
      { seasonNumber: 1, statistics: { episodeFileCount: -3, episodeCount: 2.5 } },
      { seasonNumber: 2, statistics: { episodeFileCount: "7" as unknown as number, episodeCount: null } },
      { seasonNumber: "3" as unknown as number, statistics: { episodeFileCount: 9, episodeCount: 9 } }, // non-numeric seasonNumber: skipped
      { seasonNumber: 4, statistics: null },
    ],
  };
  const c = sonarrSeriesCompletion(row);
  assert.equal(c.episodeFileCount, 0);
  assert.equal(c.episodeCount, 0);
  assert.equal(c.complete, false);
});
