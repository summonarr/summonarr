// Review 2026-09, package P9 (f10): the admin title-detail page
// (src/app/(app)/admin/activity/media/[tmdbId]/page.tsx) used to call
// `resolvePosterMap([{ tmdbId }])` with no mediaType and read
// `posterPathKey(tmdbId)` — the MOVIE key — even when it already knew the
// title was TV (`?type=` or the resolved stats.mediaType). This pins the lib
// behaviour that made that a real wrong-poster bug: an UNTYPED lookup with both
// a movie and a TV row for one number files each under its own key, and the
// bare `posterPathKey(id)` therefore hands back the movie's art. The page is a
// .tsx server component the node:test loader cannot import, so the contract is
// pinned here at the lookup it relies on: a caller that knows the type MUST
// pass it, and when it does, the TV key resolves to the show's poster.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto

type CoreRow = { tmdbId: number; mediaType?: string | null; posterPath: string | null };
type CacheRow = { key: string; data: string };

let coreRows: CoreRow[] = [];
let cacheRows: CacheRow[] = [];

(globalThis as unknown as { prisma: unknown }).prisma = {
  tmdbMediaCore: { findMany: async (): Promise<CoreRow[]> => coreRows },
  tmdbCache: { findMany: async (): Promise<CacheRow[]> => cacheRows },
};
const { resolvePosterMap, posterPathKey } = await import("../src/lib/poster-cache.ts");

const W342 = "https://image.tmdb.org/t/p/w342";

test("an UNTYPED single-item lookup with both media cached reads the MOVIE's art off posterPathKey(id)", async () => {
  coreRows = [
    { tmdbId: 1399, mediaType: "MOVIE", posterPath: "/film.jpg" },
    { tmdbId: 1399, mediaType: "TV", posterPath: "/show.jpg" },
  ];
  cacheRows = [];
  // Exactly what the page used to do for /admin/activity/media/1399?type=tv.
  const untyped = await resolvePosterMap([{ tmdbId: 1399 }]);
  assert.equal(untyped[posterPathKey(1399)], `${W342}/film.jpg`);
  assert.equal(posterPathKey(1399), "movie:1399"); // the bare key IS the movie key
});

test("passing the known mediaType resolves the TV key to the show's own poster", async () => {
  coreRows = [
    { tmdbId: 1399, mediaType: "MOVIE", posterPath: "/film.jpg" },
    { tmdbId: 1399, mediaType: "TV", posterPath: "/show.jpg" },
  ];
  cacheRows = [];
  // The page now threads `mediaType ?? stats.mediaType` into both the lookup
  // and the key read — this is the pair it must keep in lockstep.
  for (const mediaType of ["TV", "MOVIE"] as const) {
    const map = await resolvePosterMap([{ tmdbId: 1399, mediaType }]);
    const expected = mediaType === "TV" ? "/show.jpg" : "/film.jpg";
    assert.equal(map[posterPathKey(1399, mediaType)], `${W342}${expected}`);
  }
});

test("a null resolved mediaType (stats could not classify the title) still resolves through the movie key", async () => {
  // `mediaType ?? stats.mediaType` can be null when neither `?type=` was sent
  // nor the stats resolved a type; posterPathKey(id, null) must keep the
  // lenient pre-existing behaviour rather than throw or return nothing.
  coreRows = [{ tmdbId: 550, mediaType: "MOVIE", posterPath: "/fight-club.jpg" }];
  cacheRows = [];
  const map = await resolvePosterMap([{ tmdbId: 550, mediaType: null }]);
  assert.equal(map[posterPathKey(550, null)], `${W342}/fight-club.jpg`);
});
