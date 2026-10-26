// Pins for the three UI bugs: action buttons that kept the previous title's
// client state across /movie/A → /movie/B (and /tv), the HD Request CTA that
// rendered without canRequest, and Hidden/Watchlist empty-states that hid a
// drained 500-cap slice. These are "use client" modules Node cannot import,
// so the suite reads source the way request-button-on-behalf.test.mts does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const src = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

test("RequestButton treats `requested` as live and resets when tmdbId changes", () => {
  const body = src("src/components/media/request-button.tsx");
  assert.match(body, /seenTmdbId !== tmdbId/);
  assert.match(body, /state === "requested" \|\| state === "duplicate" \|\| !!requested/);
  assert.match(body, /canRequest && \(/);
});

test("Request4kButton and RequestInstanceButton treat `requested` as live", () => {
  for (const file of [
    "src/components/media/request-4k-button.tsx",
    "src/components/media/request-instance-button.tsx",
  ]) {
    const body = src(file);
    assert.match(body, /seenTmdbId !== tmdbId/, file);
    assert.match(body, /state === "requested" \|\| requested/, file);
  }
});

test("WatchlistButton refreshes after a successful auto-request and resets on tmdbId", () => {
  const body = src("src/components/media/watchlist-button.tsx");
  assert.match(body, /seenTmdbId !== tmdbId/);
  assert.match(body, /override \?\? initialOnWatchlist/);
  assert.match(body, /ar\?\.requested/);
  assert.match(body, /router\.refresh\(\)/);
});

test("HideButton and WatchlistButton roll a failed toggle back to the PRE-CLICK state, never the stale prop", () => {
  // After one successful toggle the prop still holds the page-load value, so
  // rolling back to it (setOverride(null)) showed the wrong state.
  for (const file of ["src/components/media/hide-button.tsx", "src/components/media/watchlist-button.tsx"]) {
    const body = src(file);
    assert.doesNotMatch(body, /setOverride\(null\);?\s*\/\/ rollback/, file);
    const rollbacks = body.match(/setOverride\(!next\)/g) ?? [];
    assert.equal(rollbacks.length, 2, `${file}: both the HTTP-error and network-error paths roll back to !next`);
  }
});

test("HideButton and VoteDeleteButton reset when tmdbId changes", () => {
  const hide = src("src/components/media/hide-button.tsx");
  assert.match(hide, /seenTmdbId !== tmdbId/);
  assert.match(hide, /override \?\? initialHidden/);
  const vote = src("src/components/votes/vote-delete-button.tsx");
  assert.match(vote, /seenTmdbId !== tmdbId/);
  assert.match(vote, /alreadyVoted \? "voted" : "idle"/);
});

test("movie and TV detail pages key action buttons and gate HD Request on canRequest", () => {
  const movie = src("src/app/(app)/movie/[id]/page.tsx");
  const tv = src("src/app/(app)/tv/[id]/page.tsx");
  assert.match(movie, /canRequestMovies = canRequest\(session\.user\.permissions, "MOVIE", false\)/);
  assert.match(movie, /canRequest=\{canRequestMovies\}/);
  assert.match(movie, /<RequestButton\n\s+key=\{media\.id\}/);
  assert.match(movie, /key=\{`watchlist-\$\{media\.id\}`\}/);
  assert.match(movie, /key=\{`\$\{media\.id\}:\$\{t\.slug\}`\}/);

  assert.match(tv, /canRequestTv = canRequest\(session\.user\.permissions, "TV", false\)/);
  assert.match(tv, /canRequest=\{canRequestTv\}/);
  assert.match(tv, /<RequestButton\n\s+key=\{media\.id\}/);
  assert.match(tv, /key=\{`watchlist-\$\{media\.id\}`\}/);
  assert.match(tv, /key=\{`\$\{media\.id\}:\$\{t\.slug\}`\}/);
});

test("MediaCard hides the HD Request overlay when canRequest is false", () => {
  const body = src("src/components/media/media-card.tsx");
  assert.match(body, /canRequest\?: boolean/);
  assert.match(body, /const showRequestOverlay =/);
  assert.match(body, /showRequestOverlay &&/);
  assert.match(body, /else if \(!canRequest\) \{\s*return;/);
});

test("Hidden and Watchlist grids do not empty-state a drained capped list", () => {
  for (const file of [
    "src/components/hidden/hidden-grid.tsx",
    "src/components/watchlist/watchlist-grid.tsx",
  ]) {
    const body = src(file);
    const emptyIdx = body.indexOf("<EmptyState");
    const cappedIdx = body.indexOf("personal.common.cappedEmpty");
    assert.ok(cappedIdx !== -1, `${file} must show the capped-empty copy`);
    assert.ok(emptyIdx !== -1, `${file} still has a true empty state`);
    assert.ok(cappedIdx < emptyIdx, `${file}: capped-empty must win over EmptyState`);
    assert.match(body, /router\.refresh\(\)/, file);
    assert.match(body, /personal\.common\.reload/, file);
  }
});
