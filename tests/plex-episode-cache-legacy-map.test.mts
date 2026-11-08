// Structural pin: every whole-table Plex TVEpisodeCache rewrite that does not
// reuse a library walk's own show map must build one with legacy-agent
// (thetvdb:// / imdb://) shows resolved. getPlexTVEpisodes' internal fallback
// walk reads modern Guid[] shows only, so feeding a whole-table replace from it
// silently dropped those shows' episodes until the next orchestrator run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("the tv-episodes route builds its whole-table show map with legacy shows resolved", () => {
  const tv = read("src/app/api/sync/tv-episodes/route.ts");
  assert.match(tv, /buildPlexShowKeyMap\(/);
  assert.doesNotMatch(tv, /getPlexTVEpisodes\(serverUrl, token, selected, sections\)/);
});

// The Plex resync never rewrites the whole table from a partial map: recentOnly
// MERGES only the window's shows in, and both modes walk the library walk's own
// map, which has the legacy-agent shows merged into it.
test("the Plex resync's episode walk reuses its legacy-resolved map, and recentOnly merges instead of rewriting", () => {
  const plex = read("src/app/api/sync/plex/route.ts");
  assert.match(plex, /mergeResolvedLegacyItems\(resolvedTv, tvIds, ratingKeyToTmdb\)/);
  assert.match(plex, /walkPlexEpisodes\(server, fetched\.sections, async \(\) => fetched\.ratingKeyToTmdb/);
  assert.match(plex, /recentOnly \? mergeRecentEpisodesForSource\("plex", episodes\) : replaceEpisodeCacheForSource\("plex", episodes\)/);
  assert.doesNotMatch(plex, /recentOnly \? undefined : ratingKeyToTmdb/);
});

test("buildPlexShowKeyMap collects AND resolves the legacy channel", () => {
  const src = read("src/lib/plex-legacy-resolve.ts");
  const body = src.slice(src.indexOf("export async function buildPlexShowKeyMap"));
  assert.match(body, /getPlexTmdbIds\([^)]*tvLegacy/);
  assert.match(body, /resolvePlexLegacyGuids\(tvLegacy, "TV"\)/);
  assert.match(body, /mergeResolvedLegacyItems\([\s\S]*ratingKeyToTmdb\)/);
});
