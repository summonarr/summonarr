// The title manager's Settings form, the pure half (src/components/admin/arr-title/settings-draft.ts):
// - the form shows the base with the admin's edits over it (tags as a delta);
// - only changed fields are sent, never a value outside the arr's vocabulary,
//   never a null, and each service only its own fields;
// - a save whose re-read failed (`title: null`) keeps showing what it saved
//   until the manager's re-read hands in a new title — not the pre-save values.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdits, draftOf, formBase, titleChanges, type Draft } from "../src/components/admin/arr-title/settings-draft.ts";
import type { ArrTitle } from "../src/lib/arr-title.ts";

const title = (over: Partial<ArrTitle> = {}): ArrTitle => ({
  service: "sonarr", instance: "", arrId: 1, title: "T", year: null, tmdbId: null, tvdbId: null, imdbId: null, status: null,
  monitored: true, qualityProfileId: 4, rootFolderPath: "/tv/", path: "/tv/T", tags: [3, 1], sizeOnDisk: 0, added: null, hasFile: false,
  minimumAvailability: null, inCinemas: null, physicalRelease: null, digitalRelease: null, isAvailable: null, studio: null,
  seriesType: "standard", seasonFolder: true, monitorNewItems: "all", network: null, episodeCount: 0, episodeFileCount: 0,
  nextAiring: null, previousAiring: null, seasons: [], ...over,
});

test("the form shows the base with the edits over it, tags as a delta", () => {
  const base = draftOf(title());
  assert.deepEqual(base.tags, [1, 3], "ascending");
  const draft = applyEdits(base, { monitored: false, tags: { add: [2], remove: [3] } });
  assert.equal(draft.monitored, false);
  assert.deepEqual(draft.tags, [1, 2]);
  assert.equal(draft.qualityProfileId, 4, "an untouched field shows the base");
});

test("only changed fields are sent; a flip back sends nothing", () => {
  const base = draftOf(title());
  assert.deepEqual(titleChanges(base, {}, false), {});
  assert.deepEqual(titleChanges(base, { monitored: true }, false), {}, "the base's own value");
  assert.deepEqual(titleChanges(base, { monitored: false, qualityProfileId: 5, tags: { add: [2], remove: [] } }, false), { monitored: false, qualityProfileId: 5, tags: [1, 2, 3] });
});

test("never a value outside the arr's vocabulary, never a null, each service only its own fields", () => {
  const series = draftOf(title({ seriesType: "weird", monitorNewItems: "odd" }));
  assert.deepEqual(titleChanges(series, { seriesType: "weird2" }, false), {}, "an unknown series type is never sent");
  assert.deepEqual(titleChanges(series, { seriesType: "anime", monitorNewItems: "none", seasonFolder: false }, false), { seriesType: "anime", monitorNewItems: "none", seasonFolder: false });
  assert.deepEqual(titleChanges(series, { minimumAvailability: "released" }, false), {}, "a series sends no movie field");
  const movie = draftOf(title({ service: "radarr", minimumAvailability: "announced", seriesType: null, seasonFolder: null, monitorNewItems: null }));
  assert.deepEqual(titleChanges(movie, { minimumAvailability: "released", seriesType: "anime" }, true), { minimumAvailability: "released" });
  assert.deepEqual(titleChanges(movie, { qualityProfileId: null, rootFolderPath: null }, true), {}, "a cleared choice is never sent");
});

test("a save whose re-read failed keeps showing what it saved until a new title arrives", () => {
  const shown = title();
  const reported = draftOf(shown);
  const saved: Draft = applyEdits(reported, { monitored: false });
  // The PATCH answered title: null: the form's base is what was saved…
  const base = formBase(shown, reported, { on: shown, draft: saved });
  assert.equal(base.monitored, false);
  assert.deepEqual(titleChanges(base, {}, false), {}, "nothing left to save");
  // …until the manager's re-read hands in a new title object: its own values.
  const reread = title({ monitored: false, qualityProfileId: 9 }); // the arr changed something else meanwhile
  assert.deepEqual(formBase(reread, draftOf(reread), { on: shown, draft: saved }), draftOf(reread));
  assert.equal(formBase(shown, reported, null), reported);
});
