// episodeMetadataUpdates (src/lib/tv-season-warm.ts): the season view's cache
// warm writes only what changed, from TMDB's English list (guardrail 40a).
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY ??= "ab".repeat(32);
process.env.DATABASE_URL ??= "postgresql://unit:unit@127.0.0.1:9/never_connects";

const { episodeMetadataUpdates } = await import("../src/lib/tv-season-warm.ts");

const ep = (episodeNumber: number, over: Record<string, unknown> = {}) => ({
  episodeNumber, seasonNumber: 1, name: `Ep ${episodeNumber}`, overview: "text", airDate: "2020-01-01",
  stillPath: "/s.jpg", runtime: 50, voteAverage: 7, ...over,
});
const row = (episodeNumber: number, over: Record<string, unknown> = {}) => ({
  source: "plex", episodeNumber, episodeName: `Ep ${episodeNumber}`, airDate: "2020-01-01",
  stillPath: "/s.jpg", runtime: 50, overview: "text", ...over,
});

test("a row already holding TMDB's metadata needs no write", () => {
  assert.deepEqual(episodeMetadataUpdates([row(1)], [ep(1)]), []);
});

test("a changed field writes the whole metadata set; an empty overview is stored as null", () => {
  assert.deepEqual(episodeMetadataUpdates([row(1, { episodeName: "Old" })], [ep(1, { overview: "" })]), [
    { source: "plex", episodeNumber: 1, data: { episodeName: "Ep 1", airDate: "2020-01-01", stillPath: "/s.jpg", runtime: 50, overview: null } },
  ]);
});

test("an owned episode TMDB no longer lists is skipped, and each source's row is its own write", () => {
  const updates = episodeMetadataUpdates([row(9), row(2, { source: "plex", runtime: 1 }), row(2, { source: "jellyfin", runtime: 1 })], [ep(2)]);
  assert.deepEqual(updates.map((u) => [u.source, u.episodeNumber]), [["plex", 2], ["jellyfin", 2]]);
});
