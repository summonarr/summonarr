// The availability chips' one set of rules (src/components/media/availability-rules.ts),
// shared by the detail page's badges, the cards and the Discover hero, plus the
// media links (src/components/media/media-links.ts).
//
//   - Only the servers the viewer sees count as "available", and that reading
//     suppresses Queued and Requested.
//   - 4K chips show beside the HD ones; the detail page gates them on 4K access.
//   - Queued supersedes Requested.
//   - A TMDB trailer key is one query value in the YouTube URL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { availabilityChips, isVisiblyAvailable } = await import("../src/components/media/availability-rules.ts");
const { mediaDetailPath, youtubeTrailerUrl } = await import("../src/components/media/media-links.ts");

const all = { showPlex: true, showJellyfin: true, isAvailable: false };

test("available to the viewer means on a server whose badges they see", () => {
  assert.equal(isVisiblyAvailable({ plexAvailable: true }, true, false), true);
  assert.equal(isVisiblyAvailable({ plexAvailable: true }, false, true), false);
  assert.equal(isVisiblyAvailable({ jellyfinAvailable: true }, false, true), true);
  assert.equal(isVisiblyAvailable({}, true, true), false);
});

test("the server chips follow what the viewer sees", () => {
  assert.deepEqual(availabilityChips({ plexAvailable: true, jellyfinAvailable: true }, { ...all, isAvailable: true }), ["plex", "jellyfin"]);
  assert.deepEqual(availabilityChips({ plexAvailable: true }, { ...all, showPlex: false }), []);
});

test("available suppresses Queued and Requested; Queued supersedes Requested", () => {
  const f = { arrPending: true, requested: true };
  assert.deepEqual(availabilityChips(f, { ...all, showRequested: true }), ["queued"]);
  assert.deepEqual(availabilityChips(f, { ...all, isAvailable: true, showRequested: true }), []);
  assert.deepEqual(availabilityChips({ requested: true }, { ...all, showRequested: true }), ["requested"]);
  assert.deepEqual(availabilityChips({ requested: true }, all), [], "Requested only where the caller shows it");
});

test("4K chips sit beside the HD state, in the caller's order, and need 4K access", () => {
  const f = { arrPending: true, arr4kAvailable: true };
  assert.deepEqual(availabilityChips(f, all), ["fourK", "queued"]);
  assert.deepEqual(availabilityChips(f, { ...all, queuedBefore4k: true }), ["queued", "fourK"]);
  assert.deepEqual(availabilityChips({ arr4kPending: true }, all), ["queued4k"]);
  assert.deepEqual(availabilityChips({ arr4kPending: true, arr4kAvailable: true }, all), ["fourK"]);
  assert.deepEqual(availabilityChips(f, { ...all, show4k: false }), ["queued"]);
  assert.deepEqual(availabilityChips({ arr4kPending: true }, { ...all, show4k: false }), []);
});

test("the badges, the cards and the hero draw from these rules", () => {
  const chips = readFileSync(new URL("../src/components/media/availability-chips.tsx", import.meta.url), "utf8");
  const badges = readFileSync(new URL("../src/components/media/availability-badges.tsx", import.meta.url), "utf8");
  assert.match(chips, /availabilityChips\(flags, options\)\.map/);
  assert.match(badges, /<AvailabilityChipList flags=\{flags\} variant="full"/);
  assert.match(badges, /isAvailable: isVisiblyAvailable\(flags, showPlex, showJellyfin\)/);
  for (const p of ["media-card-state.ts", "discover-hero.tsx"]) {
    const src = readFileSync(new URL(`../src/components/media/${p}`, import.meta.url), "utf8");
    assert.match(src, /isVisiblyAvailable\(media, (o\.)?showPlex, (o\.)?showJellyfin\)/, p);
  }
});

test("links: the detail page and an encoded YouTube key", () => {
  assert.equal(mediaDetailPath({ id: 603, mediaType: "movie" }), "/movie/603");
  assert.equal(mediaDetailPath({ id: 1399, mediaType: "tv" }), "/tv/1399");
  assert.equal(youtubeTrailerUrl("dQw4w9WgXcQ"), "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(youtubeTrailerUrl("a_b-c"), "https://www.youtube.com/watch?v=a_b-c");
  const odd = new URL(youtubeTrailerUrl("abc&list=x#t=9"));
  assert.equal(odd.searchParams.get("v"), "abc&list=x#t=9");
  assert.equal(odd.searchParams.get("list"), null);
  assert.equal(odd.hash, "");
});
