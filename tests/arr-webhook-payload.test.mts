// The webhook payload views (src/lib/arr-webhook-payload.ts): every field of an
// attacker-shaped payload narrowed once, so a handler never reads an unchecked one.
import { test } from "node:test";
import assert from "node:assert/strict";

const { readRadarrPayload, readSonarrPayload, sonarrEpisodeScope, grabMatchesDelivery } = await import("../src/lib/arr-webhook-payload.ts");

test("a Radarr movie's tmdbId is a number in INT4 range or null; the raw value stays for the Download path's 400", () => {
  assert.deepEqual(readRadarrPayload({ movie: { tmdbId: 603, title: "The Matrix" } }).movie, { rawTmdbId: 603, tmdbId: 603, title: "The Matrix" });
  for (const raw of ["603", 1.5, -1, 2_147_483_648, { id: 1 }]) {
    const movie = readRadarrPayload({ movie: { tmdbId: raw } }).movie;
    assert.equal(movie?.tmdbId, null, JSON.stringify(raw));
    assert.equal(movie?.rawTmdbId, raw);
  }
  assert.equal(readRadarrPayload({}).movie, null);
  assert.equal(readRadarrPayload({ movie: { tmdbId: 1, title: { evil: true } } }).movie?.title, null, "a non-string title is no title");
});

test("a Sonarr series' ids: tvdbId any positive integer, tmdbId within INT4; a null episode entry is dropped", () => {
  const view = readSonarrPayload({ series: { tvdbId: 42, tmdbId: 3_000_000_000, title: 7 }, episodes: [null, { seasonNumber: 1, episodeNumber: 2 }, 5] });
  assert.deepEqual(view.series, { tvdbId: 42, tmdbId: null, tmdbIdKey: 3_000_000_000, title: null });
  assert.deepEqual(view.episodes, [{ seasonNumber: 1, episodeNumber: 2 }]);
  assert.deepEqual(readSonarrPayload({ episodes: "nope" }).episodes, []);
  assert.deepEqual(readSonarrPayload({ series: "x" }).series, { tvdbId: null, tmdbId: null, tmdbIdKey: null, title: null }, "a truthy non-object still names a series, with no ids");
});

test("the manual-interaction scope names one episode, or counts several", () => {
  assert.equal(sonarrEpisodeScope([{ seasonNumber: 1, episodeNumber: 5 }]), " S01E05");
  assert.equal(sonarrEpisodeScope([{ seasonNumber: 1, episodeNumber: 5 }, { seasonNumber: 1, episodeNumber: 6 }]), " (2 episodes)");
  assert.equal(sonarrEpisodeScope([]), "");
});

test("a grab is claimed only by its own delivery: EPISODE by season and episode, SEASON by season, FULL by any", () => {
  const delivered = [{ seasonNumber: 3, episodeNumber: 2 }];
  assert.equal(grabMatchesDelivery({ scope: "EPISODE", seasonNumber: 1, episodeNumber: 5 }, delivered), false);
  assert.equal(grabMatchesDelivery({ scope: "EPISODE", seasonNumber: 3, episodeNumber: 2 }, delivered), true);
  assert.equal(grabMatchesDelivery({ scope: "SEASON", seasonNumber: 1, episodeNumber: null }, delivered), false);
  assert.equal(grabMatchesDelivery({ scope: "SEASON", seasonNumber: 3, episodeNumber: null }, delivered), true);
  assert.equal(grabMatchesDelivery({ scope: "FULL", seasonNumber: null, episodeNumber: null }, delivered), true);
  assert.equal(grabMatchesDelivery({ scope: "EPISODE", seasonNumber: null, episodeNumber: null }, []), true, "nothing to match on keeps any-delivery");
});
