// The admin per-title Activity page's helpers (src/lib/activity-title-detail.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dominantMediaType, parseTitleMediaType, sampleDistributions } from "@/lib/activity-title-detail.ts";

test("an untyped id with plays as a film AND a show names the busier type for a redirect", () => {
  assert.equal(dominantMediaType([{ mediaType: "MOVIE", count: 2 }, { mediaType: "TV", count: 5 }]), "TV");
  assert.equal(dominantMediaType([{ mediaType: "MOVIE", count: 5 }, { mediaType: "TV", count: 5 }]), "MOVIE", "a tie is the movie");
  assert.equal(dominantMediaType([{ mediaType: "TV", count: 5 }]), null, "one type needs no choice");
  assert.equal(dominantMediaType([]), null);
});

test("the page redirects an ambiguous untyped id to its typed URL before reading the stats", () => {
  const page = readFileSync(new URL("../src/app/(app)/admin/activity/media/[tmdbId]/page.tsx", import.meta.url), "utf8");
  const at = page.indexOf("if (dominant) redirect(`/admin/activity/media/${tmdbId}?type=${dominant}`);");
  assert.ok(at > 0);
  assert.ok(at < page.indexOf("getMediaPlayStats(tmdbId, mediaType)"));
  assert.match(page, /parseTmdbIdParam\(tmdbIdStr\)/);
});

test("?type= is read in either case", () => {
  assert.equal(parseTitleMediaType("tv"), "TV");
  assert.equal(parseTitleMediaType("MOVIE"), "MOVIE");
  assert.equal(parseTitleMediaType("Tv"), undefined);
});

test("sampleDistributions buckets completion and ranks platforms", () => {
  const d = sampleDistributions([
    { watched: true, platform: "iOS", playDuration: 96, duration: 100 },
    { watched: false, platform: "iOS", playDuration: 10, duration: 100 },
    { watched: false, platform: "Web", playDuration: 5, duration: 0 },
  ]);
  assert.equal(d.watchedCount, 1);
  assert.deepEqual(d.completionHist.map((b) => b.count), [2, 0, 0, 0, 1]);
  assert.deepEqual(d.platforms, [{ label: "iOS", count: 2 }, { label: "Web", count: 1 }]);
});

test("a library title with no plays renders; only an id in neither plays nor a library is a 404", () => {
  const page = readFileSync(new URL("../src/app/(app)/admin/activity/media/[tmdbId]/page.tsx", import.meta.url), "utf8");
  assert.match(page, /stats\.totalPlays === 0 && stats\.recentPlays\.length === 0 && !stats\.inLibrary\) notFound\(\)/);
  const lib = readFileSync(new URL("../src/lib/play-history-media-stats.ts", import.meta.url), "utf8");
  assert.match(lib, /inLibrary: r\.mediaInfo === null && resolvedMedia !== null,/, "named from the library cache, not from a play row");
});

test("the play page shows its times in the statistics zone the history table uses", () => {
  const page = readFileSync(new URL("../src/app/(app)/admin/activity/play/[id]/page.tsx", import.meta.url), "utf8");
  assert.match(page, /const timeZone = await getStatsTimeZone\(\);/);
  assert.equal(page.match(/<PlayTimestamp [^>]*timeZone=\{timeZone\}/g)?.length, 2);
  const cell = readFileSync(new URL("../src/app/(app)/admin/activity/play/[id]/play-timestamp.tsx", import.meta.url), "utf8");
  assert.match(cell, /fmtTimestamp\(iso, mounted, locale, timeZone\)/);
});

test("a session or play with no media type is not labelled a movie", () => {
  const card = readFileSync(new URL("../src/components/admin/now-playing/session-card.tsx", import.meta.url), "utf8");
  const row = readFileSync(new URL("../src/components/admin/recent-plays/row.tsx", import.meta.url), "utf8");
  assert.match(card, /mediaTypeLabel\(t, s\.mediaType\?\.toUpperCase\(\)\)/);
  assert.match(row, /: mediaTypeLabel\(t, p\.mediaType\);/);
});

test("the Users list and the user page compute Direct % over all of the user's plays", () => {
  const list = readFileSync(new URL("../src/lib/play-history-leaderboards.ts", import.meta.url), "utf8");
  assert.match(list, /COUNT\(p\."id"\)::bigint AS "allPlays"/);
  assert.match(list, /directPct: allPlays > 0 \? sharePct\(direct, allPlays\) : null,/);
  assert.match(list, /transcodePct: allPlays > 0 \? sharePct\(transcodes, allPlays\) : null,/);
  const page = readFileSync(new URL("../src/app/(app)/admin/activity/user/[id]/page.tsx", import.meta.url), "utf8");
  assert.match(page, /return total > 0 \? sharePct\(direct, total\) : null;/);
});

test("the Statistics tab's deltas go through kpiDelta on unrounded hours", () => {
  const ui = readFileSync(new URL("../src/components/admin/activity-stats-redesign.tsx", import.meta.url), "utf8");
  assert.match(ui, /return kpiDelta\(t\("adminActivity\.kpi\.new"\), current, previous, complete\);/);
  assert.match(ui, /delta\(t, stats\.totalWatchTimeHours, stats\.prevPeriod\.totalWatchTimeHours, prevComplete\)/);
});
