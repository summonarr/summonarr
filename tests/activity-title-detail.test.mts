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
