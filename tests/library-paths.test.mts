// The library path rules shared by the bad-match join (src/lib/bad-matches.ts),
// the admin library page and the strip-prefix preview in the settings form
// (src/lib/library-paths.ts). The form is a client component, so it imports the
// SAME rule rather than keeping a copy that could drift from the server's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isMediaFileName,
  isSeasonFolderName,
  stripMountPoint,
  stripRelPrefix,
  toMatchKey,
  tvShowFolderPath,
} from "../src/lib/library-paths.ts";

test("stripRelPrefix: an empty prefix is a no-op, a trailing '/' is optional, a non-matching prefix changes nothing", () => {
  assert.equal(stripRelPrefix("tv/Show A", ""), "tv/Show A");
  assert.equal(stripRelPrefix("tv/Show A", "tv"), "Show A");
  assert.equal(stripRelPrefix("tv/Show A", "tv/"), "Show A");
  assert.equal(stripRelPrefix("movies/Film (2020)/f.mkv", "tv/"), "movies/Film (2020)/f.mkv");
  // Whole segments only: "tv" must not eat the start of "tvshows/…".
  assert.equal(stripRelPrefix("tvshows/Show A", "tv"), "tvshows/Show A");
});

test("toMatchKey: a show keys on its first folder, a movie on its whole relative path", () => {
  assert.equal(toMatchKey("Show A/Season 1/e1.mkv", "TV"), "Show A");
  assert.equal(toMatchKey("Film (2020)/f.mkv", "MOVIE"), "Film (2020)/f.mkv");
  assert.equal(stripMountPoint("C:\\Media\\Film\\f.mkv", "C:/Media/"), "Film/f.mkv");
  assert.equal(stripMountPoint(null, "/data/"), null);
});

test("a season folder is recognised by its whole name, never by a show name that starts like one", () => {
  for (const name of ["Season 1", "Season 01", "season.02", "Series 3", "S01", "Specials", "Season 1 (2010)"]) {
    assert.equal(isSeasonFolderName(name), true, name);
  }
  for (const name of ["Series of Unfortunate Events", "Seasonal Affective", "Specialist (2001)", "Season", "Show A"]) {
    assert.equal(isSeasonFolderName(name), false, name);
  }
});

test("a file is a known video extension, so a dotted folder name stays a folder", () => {
  for (const name of ["e01.mkv", "Film.2020.1080p.MP4", "disc.iso", "show.m2ts", "link.strm"]) {
    assert.equal(isMediaFileName(name), true, name);
  }
  for (const name of ["Agents of S.H.I.E.L.D", "M.A.S.H", "Film (2020)", "Mr.Robot"]) {
    assert.equal(isMediaFileName(name), false, name);
  }
});

test("tvShowFolderPath keeps every folder above the show and drops the episode and season", () => {
  assert.equal(tvShowFolderPath("tv/Show A/Season 1/e1.mkv"), "tv/Show A");
  assert.equal(tvShowFolderPath("Show A/e1.mkv"), "Show A");
  assert.equal(tvShowFolderPath("tv/Agents of S.H.I.E.L.D"), "tv/Agents of S.H.I.E.L.D", "a Jellyfin series folder is kept whole");
  assert.equal(tvShowFolderPath("tv/Series of Unfortunate Events/e1.mkv"), "tv/Series of Unfortunate Events");
});

test("the settings form previews with the shared rule, not a copy of it", () => {
  const form = readFileSync(new URL("../src/components/settings/forms/library-match-form.tsx", import.meta.url), "utf8");
  assert.match(form, /import \{[^}]*\bstripRelPrefix\b[^}]*\} from "@\/lib\/library-paths"/);
  assert.doesNotMatch(form, /startsWith\(p\) \? \w+\.slice\(p\.length\)/, "a local copy of the strip rule");
});

test("stripMountPoint matches the mount on whole segments only, and normalises a backslashed mount like the path", () => {
  assert.equal(stripMountPoint("/data/movies-4k/X/x.mkv", "/data/movies"), "/data/movies-4k/X/x.mkv");
  assert.equal(stripMountPoint("/data/movies/X/x.mkv", "/data/movies"), "/X/x.mkv");
  assert.equal(stripMountPoint("/data/movies/X/x.mkv", "/data/movies/"), "X/x.mkv");
  assert.equal(stripMountPoint("C:\\Media\\Film\\f.mkv", "C:\\Media\\"), "Film/f.mkv");
});
