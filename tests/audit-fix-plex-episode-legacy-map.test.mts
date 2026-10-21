// Structural pin: every whole-table Plex TVEpisodeCache rewrite that does not
// reuse the orchestrator's own show map must build one with legacy-agent
// (thetvdb:// / imdb://) shows resolved. getPlexTVEpisodes' internal fallback
// walk reads modern Guid[] shows only, so feeding a whole-table replace from it
// silently dropped those shows' episodes until the next orchestrator run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("tv-episodes route and the Plex resync's recentOnly path build the show map with legacy shows resolved", () => {
  const tv = read("src/app/api/sync/tv-episodes/route.ts");
  assert.match(tv, /buildPlexShowKeyMap\(/);
  assert.doesNotMatch(tv, /getPlexTVEpisodes\(serverUrl, token, selected, sections\)/);
  const plex = read("src/app/api/sync/plex/route.ts");
  assert.match(plex, /recentOnly\s*\n?[\s\S]{0,400}buildPlexShowKeyMap\(/);
  assert.doesNotMatch(plex, /recentOnly \? undefined : ratingKeyToTmdb/);
});

test("buildPlexShowKeyMap collects AND resolves the legacy channel", () => {
  const src = read("src/lib/plex-legacy-resolve.ts");
  const body = src.slice(src.indexOf("export async function buildPlexShowKeyMap"));
  assert.match(body, /getPlexTmdbIds\([^)]*tvLegacy/);
  assert.match(body, /resolvePlexLegacyGuids\(tvLegacy, "TV"\)/);
  assert.match(body, /mergeResolvedLegacyItems\([\s\S]*ratingKeyToTmdb\)/);
});
