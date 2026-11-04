// Pins for the 2026-10 audit fixes in the activity/ingest unit that have no
// natural home in an existing suite: the bar-label fold (a pure helper), and
// structural pins for server components the unit suite cannot render (the
// activity page's ratingKey owner map, the admin Issues / request queue arr
// links' integration gate).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { foldBarItems } = await import("../src/lib/activity-bars.ts");
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

// ═══ foldBarItems (C029) ════════════════════════════════════════════════════

test("foldBarItems merges rows that render with the same label, summing counts, labels unique", () => {
  assert.deepEqual(
    foldBarItems([{ label: "Unknown", count: 3 }, { label: "Roku", count: 5 }, { label: "Unknown", count: 4 }]),
    [{ label: "Unknown", count: 7 }, { label: "Roku", count: 5 }],
    "'Unknown' and an upstream 'unknown' both read Unknown — two identical bars and a duplicate React key",
  );
});

test("foldBarItems keeps the caller's order (decades are by decade), and re-sorts only an input that was count-descending", () => {
  assert.deepEqual(
    foldBarItems([{ label: "1990s", count: 3 }, { label: "2000s", count: 9 }, { label: "Unknown", count: 1 }, { label: "Unknown", count: 2 }]),
    [{ label: "1990s", count: 3 }, { label: "2000s", count: 9 }, { label: "Unknown", count: 3 }],
  );
  assert.deepEqual(
    foldBarItems([{ label: "A", count: 10 }, { label: "U", count: 6 }, { label: "B", count: 5 }, { label: "U", count: 5 }]),
    [{ label: "U", count: 11 }, { label: "A", count: 10 }, { label: "B", count: 5 }],
    "a count-desc list stays count-desc after a merge",
  );
});

test("foldBarItems returns the input unchanged when nothing collides, and never mutates it", () => {
  const items = [{ label: "x", count: 2 }, { label: "y", count: 1 }];
  assert.equal(foldBarItems(items), items);
  const dup = [{ label: "x", count: 2 }, { label: "x", count: 1 }];
  foldBarItems(dup);
  assert.deepEqual(dup, [{ label: "x", count: 2 }, { label: "x", count: 1 }]);
});

test("HorizontalBars folds its items before computing the max and keying rows", () => {
  const src = read("../src/components/admin/activity-ui.tsx");
  const body = src.slice(src.indexOf("export function HorizontalBars("));
  assert.match(body, /const items = foldBarItems\(rawItems\);\s*\n\s*const max = Math\.max\(\.\.\.items\.map/);
});

// ═══ the activity page's backfill map (C138 / guardrail 37c) ════════════════

test("the Activity backfill resolves each Plex ratingKey to its ONE owner per instance — never last-write-wins", () => {
  const src = read("../src/app/(app)/admin/activity/page.tsx");
  assert.match(src, /import \{ indexPlexRowsByKey \} from "@\/lib\/plex-dedupe"/);
  assert.match(src, /for \(const \[k, i\] of indexPlexRowsByKey\(rows\)\)/);
  assert.doesNotMatch(src, /for \(const k of i\.plexRatingKeys\)/, "an array entry overwrote another row's canonical key");
});

// ═══ arr links follow the integration switch (C001) ═════════════════════════

test("admin Issues builds its Manage holders only for a switched-on Radarr/Sonarr", () => {
  const src = read("../src/app/(app)/admin/issues/page.tsx");
  assert.match(src, /isFeatureEnabled\("feature\.integration\.radarr"\)/);
  assert.match(src, /isFeatureEnabled\("feature\.integration\.sonarr"\)/);
  assert.match(src, /arrHoldersByTmdbId\(radarrOn \? radarrOptions : \[\]/);
  assert.match(src, /arrHoldersByTmdbId\(sonarrOn \? sonarrOptions : \[\]/);
  assert.match(src, /const readRadarr = isAdmin && radarrOn/);
  assert.match(src, /const readSonarr = isAdmin && sonarrOn/);
});

test("the request queue hides its Open in / Manage icons when both integrations are off", () => {
  const src = read("../src/app/(app)/admin/page.tsx");
  assert.match(src, /canOpenArr=\{hasPermission\(session\.user\.permissions, Permission\.ADMIN\) && \(radarrOn \|\| sonarrOn\)\}/);
});
