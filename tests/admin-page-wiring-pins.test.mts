// Source pins for admin and personal pages that are server components the unit
// loader can't render: each names the defect the wiring fixed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

test("the Users page offers Sync Roles only to the ADMIN role its route admits", () => {
  const page = read("src/app/(app)/admin/users/page.tsx");
  assert.match(page, /const canSyncRoles = session\.user\.role === "ADMIN";/);
  assert.match(page, /\{canSyncRoles && <SyncRolesButton \/>\}/);
  assert.doesNotMatch(page, /^\s*<SyncRolesButton \/>$/m, "an ungated button 403s for a MANAGE_USERS delegate");
  const route = read("src/app/api/discord/sync-roles/route.ts");
  assert.match(route, /withAdmin\(/, "the route this gate mirrors");
});

test("the Users page narrows User.mediaServer instead of casting it", () => {
  const page = read("src/app/(app)/admin/users/page.tsx");
  assert.match(page, /mediaServer: mediaServerOf\(u\.mediaServer\),/);
  assert.doesNotMatch(page, /as "plex" \| "jellyfin" \| null/);
});

test("the Hidden page tells the grid it was cut only when a row past the cap exists", () => {
  const page = read("src/app/(app)/hidden/page.tsx");
  assert.match(page, /take: LIST_CAP \+ 1,/);
  assert.match(page, /const truncated = rows\.length > LIST_CAP;/);
  assert.match(page, /<HiddenGrid initialItems=\{items\} cap=\{LIST_CAP\} truncated=\{truncated\} \/>/);
  const grid = read("src/components/hidden/hidden-grid.tsx");
  assert.match(grid, /const capped = cap != null && truncated;/);
  assert.doesNotMatch(grid, /initialItems\.length >= cap/, "a list of exactly the cap is not cut");
});

test("Library: a TV title's Radarr/Sonarr lookup uses its match key, after the strip prefix", () => {
  const page = read("src/app/(app)/admin/library/page.tsx");
  assert.match(page, /\? \(matchKey \? \(tvArrByName\.get\(matchKey\) \?\? null\) : null\)/);
  assert.doesNotMatch(page, /mediaRelPath\.split\("\/"\)\[0\]/, "the first segment was the prefix itself");
});

test("Library: past the row cap the differences and the stat tiles come from the whole tables", () => {
  const page = read("src/app/(app)/admin/library/page.tsx");
  assert.match(page, /const wholeKeys = libraryCapped \? await wholeLibraryTitleKeys\(\) : null;/);
  assert.match(page, /const jellyfinSet = wholeKeys\?\.jellyfin \?\?/);
  assert.match(page, /const plexSet\s+= wholeKeys\?\.plex\s+\?\?/);
  assert.match(page, /SELECT DISTINCT "tmdbId", "mediaType"::text AS "mediaType" FROM "PlexLibraryItem"/);
  assert.match(page, /SELECT DISTINCT "tmdbId", "mediaType"::text AS "mediaType" FROM "JellyfinLibraryItem"/);
  assert.match(page, /key: \{ endsWith: "PathStripPrefix" \}/, "one read for every server's strip prefixes");
});

test("Stats: the fulfillment rate leaves out requests created already available", () => {
  const page = read("src/app/(app)/admin/stats/page.tsx");
  assert.match(page, /const fulfilled = Math\.max\(0, s\.AVAILABLE - overview\.mirrored\);/);
  assert.match(page, /value: f\.pct\(share\(fulfilled, greenlit\)\)/);
  assert.match(page, /STUCK_REASONS\.reduce\(/, "the total covers every reason");
  assert.doesNotMatch(page, /requests\.status\.\$\{/, "status labels come from REQUEST_STATUS_LABEL_KEY");
});

test("Issues: a grouped card links every other report it stands for", () => {
  const page = read("src/app/(app)/admin/issues/page.tsx");
  assert.match(page, /\{count > 1 && <OtherReports t=\{t\} members=\{members\.slice\(1\)\} hrefFor=\{issueHref\} \/>\}/);
});

test("the TRaSH header places its link through SLOT, never a hand-split placeholder", () => {
  const layout = read("src/app/(app)/admin/trash-guides/layout.tsx");
  assert.match(layout, /<SlotText text=\{t\("trash\.header\.subtitle", \{ link: SLOT \}\)\}>/);
  assert.doesNotMatch(layout, /\\u0000/);
});

test("Users: the table pages through every account with ?page=, clamped to the last page", () => {
  const page = read("src/app/(app)/admin/users/page.tsx");
  assert.match(page, /const requestedPage = parsePageNumber\(first\(sp\.page\)\);/);
  assert.match(page, /skip: \(page - 1\) \* USER_LIST_CAP,/);
  assert.match(page, /const page = Math\.min\(requestedPage, lastPage\);/);
  assert.match(page, /<PaginationBar currentPage=\{page\} totalPages=\{lastPage\} \/>/);
});
