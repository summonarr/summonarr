// A play's season/episode label. A missing episode number shows the season
// alone — "E00" read as a real episode 0 — and a missing season gives null so
// each caller keeps its own placeholder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { episodeLabel, formatSeasonEpisode } from "../src/lib/episode-label.ts";

test("season and episode are zero-padded and joined", () => {
  assert.equal(episodeLabel(1, 5), "S01 · E05");
  assert.equal(episodeLabel(12, 103), "S12 · E103");
  assert.equal(episodeLabel(0, 0), "S00 · E00", "a real special numbered 0 still shows");
});

test("a missing episode shows the season alone, never E00", () => {
  assert.equal(episodeLabel(1, null), "S01");
  assert.equal(episodeLabel(1, undefined), "S01");
});

test("a missing season gives null", () => {
  assert.equal(episodeLabel(null, 3), null);
  assert.equal(episodeLabel(undefined, null), null);
});

test("no activity or watch-history view pads a missing episode to 0 any more", () => {
  for (const rel of [
    "components/admin/activity-title-detail.tsx",
    "components/admin/activity-history/table-row.tsx",
    "components/admin/activity-user-detail.tsx",
    "components/admin/activity-history/detail-row.tsx",
    "components/watch-history/watch-history-list.tsx",
    "app/(app)/admin/activity/play/[id]/page.tsx",
  ]) {
    const src = readFileSync(new URL(`../src/${rel}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /episodeNumber \?\? 0/, rel);
    assert.match(src, /episodeLabel\(/, `${rel} uses the shared label`);
  }
});

test("the live-session form drops each unknown part on its own, never S00 or E00", () => {
  assert.equal(formatSeasonEpisode(1, 5), "S01 · E05");
  assert.equal(formatSeasonEpisode(null, 5), "E05", "a missing season still shows the episode");
  assert.equal(formatSeasonEpisode(2, null), "S02");
  assert.equal(formatSeasonEpisode(null, undefined), "");
  assert.equal(formatSeasonEpisode(0, 0), "S00 · E00", "a real special numbered 0 still shows");
});

test("Now playing and Recent plays build their season/episode text through the shared helper", () => {
  for (const rel of ["now-playing/session-card.tsx", "recent-plays/row.tsx"]) {
    const src = readFileSync(new URL(`../src/components/admin/${rel}`, import.meta.url), "utf8");
    assert.match(src, /import \{ formatSeasonEpisode \} from "@\/lib\/episode-label";/, rel);
    assert.match(src, /formatSeasonEpisode\((s|p)\.seasonNumber, \1\.episodeNumber\)/, rel);
    assert.doesNotMatch(src, /padStart\(2, "0"\)/, `${rel} keeps no private S/E builder`);
  }
});
