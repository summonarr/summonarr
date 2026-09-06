// Structural pins for the two places every For You surface exists TWICE: the web
// page and its native mirror. Neither pair is reachable from the unit suite —
// they are server components and route handlers whose bodies never run here — so
// what is pinned is the shape of the call, not its result.
//
// Both pairs have drifted or under-delivered before, and in both cases the two
// halves are explicitly documented as "keep the two in sync" while nothing
// enforced it:
//   - the home rail sliced the recommendation list to RAIL_OVERFETCH (20) BEFORE
//     project() dropped available titles. Every other rail is handed a ~20-item
//     TMDB page, but For You is handed up to 200, so a hideAvailable viewer whose
//     top 20 picks were all on the server got an EMPTY rail while ~180 missing
//     picks sat unread behind the slice;
//   - the /for-you enrichment re-read HiddenItem that getUserRecommendations had
//     already applied, and attached ratings non-blocking even when the reader had
//     asked to sort BY rating — so "Highest rated" ordered IMDb figures for
//     whatever happened to be cached against TMDB averages for the rest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const HOME_SURFACES = ["src/app/(app)/page.tsx", "src/app/api/home/route.ts"];
const RECOMMENDATION_SURFACES = ["src/app/(app)/for-you/page.tsx", "src/app/api/recommendations/route.ts"];

test("home: BOTH surfaces widen the For You window when hideAvailable is on", () => {
  for (const file of HOME_SURFACES) {
    const src = readFileSync(file, "utf8");
    assert.match(
      src,
      /const forYouOverfetch = hideAvailable \? FOR_YOU_RAIL_OVERFETCH_HIDDEN : RAIL_OVERFETCH;/,
      `${file} must choose the For You window from hideAvailable`,
    );
    // Both the initial slice AND the enrichment window have to use it. Widening
    // only the first re-truncates to 20 in the candidate list; widening only the
    // second enriches titles the rail can never reach.
    assert.equal(
      src.match(/forYouOverfetch/g)?.length,
      3,
      `${file} must use forYouOverfetch for the declaration, the slice AND the enrichment window`,
    );
    assert.doesNotMatch(
      src,
      /forYou(?:Res\)\)?)?\s*\.slice\(0, RAIL_OVERFETCH\)/,
      `${file} must not re-truncate the For You list to the generic rail window`,
    );
  }
});

test("for-you: BOTH surfaces skip the duplicate hidden read and block ratings only for the rating sort", () => {
  for (const file of RECOMMENDATION_SURFACES) {
    const src = readFileSync(file, "utf8");
    assert.match(
      src,
      /includeHidden: true/,
      `${file} must not re-read HiddenItem — getUserRecommendations already filtered it`,
    );
    // Keyed on the sort, never hardcoded: `true` would pay a blocking ratings
    // fan-out on every render, `false` would leave the rating sort mixing IMDb
    // and TMDB scales.
    assert.match(
      src,
      /blockRatings: sort === "rating"/,
      `${file} must block ratings exactly when the reader sorts by rating`,
    );
  }
});
