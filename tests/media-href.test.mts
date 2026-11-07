// The play-history detail link (src/lib/media-href.ts) shared by the watch
// history list, Wrapped and My Stats: only a known media type gets a link, so a
// typeless row never points at an unrelated movie sharing its TMDB id.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mediaHref } from "../src/lib/media-href.ts";

test("a movie and a show link to their own detail pages", () => {
  assert.equal(mediaHref(603, "MOVIE"), "/movie/603");
  assert.equal(mediaHref(1399, "TV"), "/tv/1399");
});

test("no TMDB id, or no/unknown media type, means no link", () => {
  assert.equal(mediaHref(null, "MOVIE"), null);
  assert.equal(mediaHref(undefined, "TV"), null);
  assert.equal(mediaHref(603, null), null);
  assert.equal(mediaHref(603, undefined), null);
  assert.equal(mediaHref(603, "movie"), null);
  assert.equal(mediaHref(603, "MUSIC"), null);
});

test("the personal-history views use the shared helper instead of their own copies", () => {
  for (const path of [
    "src/components/watch-history/watch-history-list.tsx",
    "src/components/watch-history/wrapped-view.tsx",
    "src/components/watch-history/my-stats-view.tsx",
  ]) {
    const src = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    assert.match(src, /import \{ mediaHref \} from "@\/lib\/media-href";/, path);
    assert.doesNotMatch(src, /function mediaHref\(/, path);
    assert.doesNotMatch(src, /`\/movie\/\$\{/, `${path} builds no movie link of its own`);
  }
});
