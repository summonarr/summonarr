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

test("Request4kButton and RequestInstanceButton share one request flow that treats `requested` as live", () => {
  // Both are thin wrappers over VariantRequestButton: only the POST extras and
  // the wording differ, so the flow (and its fixes) can't drift between them.
  const shared = src("src/components/media/variant-request-button.tsx");
  assert.match(shared, /seenTmdbId !== tmdbId/);
  assert.match(shared, /state === "requested" \|\| requested/);
  // A 429 shows the Retry-After hint, as RequestButton's does.
  assert.match(shared, /setMsg\(rateLimitMessage\(res, t\) \?\? data\.error \?\? t\("request\.somethingWrong"\)\)/);
  assert.match(shared, /postMediaRequest\(\{ tmdbId, mediaType, \.\.\.extras \}, requestToken\)/);

  const fourK = src("src/components/media/request-4k-button.tsx");
  assert.match(fourK, /<VariantRequestButton\b/);
  // The API keeps the is4k shorthand for the 4K instance (guardrail 32).
  assert.match(fourK, /extras=\{\{ is4k: true \}\}/);
  const named = src("src/components/media/request-instance-button.tsx");
  assert.match(named, /<VariantRequestButton\b/);
  assert.match(named, /extras=\{\{ arrInstance: instance \}\}/);
  for (const [file, body] of [["request-4k-button", fourK], ["request-instance-button", named]] as const) {
    assert.doesNotMatch(body, /useState|postMediaRequest/, `${file}: a private copy of the request flow is back`);
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

test("VoteActions resyncs `voted` from the live prop and rolls a failed unvote back to voted", () => {
  // The /votes rows are keyed by title, so a router.refresh() reuses the
  // instance: a state seeded once from userVoted ignored a vote cast elsewhere.
  const body = src("src/components/votes/vote-actions.tsx");
  assert.match(body, /const voted = override \?\? userVoted;/);
  assert.match(body, /if \(userVoted !== seenUserVoted && !loading\) \{\s*setSeenUserVoted\(userVoted\);\s*setOverride\(null\);/);
  assert.doesNotMatch(body, /useState\(userVoted\);\s*const \[dismissed/, "voted must not be a one-time copy of the prop");
  const rollbacks = body.match(/setOverride\(true\)/g) ?? [];
  assert.equal(rollbacks.length, 2, "both the HTTP-error and network-error paths roll back to the pre-click state");
});

test("VoteDeleteButton: unvote shows the rate-limit hint, a vote clears its reason, and focus survives the state change", () => {
  const body = src("src/components/votes/vote-delete-button.tsx");
  assert.match(body, /rateLimitMessage\(res, t\) \?\? t\("request\.vote\.removeFailed"\)/);
  assert.match(body, /setState\("voted"\);\s*setReason\(""\);\s*router\.refresh\(\)/, "a recorded vote clears the reason");
  assert.match(body, /if \(e\.key === "Escape"\) closeReason\(\)/);
  // The loading button is the SAME <button> as idle/voted: `disabled` dropped
  // its focus to <body> on every vote and unvote.
  const loading = body.slice(body.indexOf('displayState === "loading"'));
  const button = loading.slice(loading.indexOf("<DetailActionButton"), loading.indexOf("</DetailActionButton>"));
  assert.doesNotMatch(button, /\sdisabled\b/);
  assert.match(button, /aria-disabled/);
});

test("movie and TV detail pages key action buttons and gate HD Request on canRequest", () => {
  const movie = src("src/app/(app)/movie/[id]/page.tsx");
  const tv = src("src/app/(app)/tv/[id]/page.tsx");
  assert.match(movie, /canRequestMovies = canRequest\(session\.user\.permissions, "MOVIE", false\)/);
  assert.match(movie, /<DetailActions\n\s+media=\{media\}\n\s+mediaType="MOVIE"\n\s+state=\{state\}\n\s+canRequest=\{canRequestMovies\}/);
  assert.match(tv, /canRequestTv = canRequest\(session\.user\.permissions, "TV", false\)/);
  assert.match(tv, /<DetailActions\n\s+media=\{media\}\n\s+mediaType="TV"\n\s+state=\{state\}\n\s+canRequest=\{canRequestTv\}/);

  // Both pages render the one action row, which keys every button on the title.
  const row = src("src/components/media/detail-actions.tsx");
  assert.match(row, /<RequestButton\n\s+key=\{media\.id\}/);
  assert.match(row, /canRequest=\{canRequest\}/);
  assert.match(row, /key=\{`4k-\$\{media\.id\}`\}/);
  assert.match(row, /key=\{`watchlist-\$\{media\.id\}`\}/);
  assert.match(row, /key=\{`hide-\$\{media\.id\}`\}/);
  assert.match(row, /key=\{`vote-\$\{media\.id\}`\}/);
  assert.match(row, /key=\{`\$\{media\.id\}:\$\{target\.slug\}`\}/);
  // The map callback is `target`, never `t`: `t` is the translator here.
  assert.doesNotMatch(row, /\.map\(\(t\) =>/);
  for (const [name, body] of [["movie", movie], ["tv", tv]] as const) {
    assert.doesNotMatch(body, /<RequestButton\b/, `${name}: an inline copy of the action row is back`);
  }
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

test("RequestButton drops a View-request state when `requested` goes true → false", () => {
  // State was seeded from `requested` at mount only; a request declined or
  // deleted elsewhere kept "View request" until a remount.
  const body = src("src/components/media/request-button.tsx");
  const block = /const \[prevRequested, setPrevRequested\] = useState\(!!requested\);\n\s*if \(!titleChanged && prevRequested !== !!requested\) \{([\s\S]*?)\n  \}/.exec(body);
  assert.ok(block, "the requested-prop reconcile block is missing");
  assert.match(block[1], /setPrevRequested\(!!requested\)/);
  assert.match(block[1], /if \(!requested && \(state === "duplicate" \|\| state === "requested"\)\) setState\("idle"\)/);
});

test("every client request POST goes through postMediaRequest (token fetch failure + expired page token)", () => {
  // A page-minted token expires after one to two hours; the token-less paths
  // used to post `_token: undefined` when the token fetch failed. Both are
  // handled once, in src/lib/client/media-request.ts (tests/media-request-client.test.mts).
  for (const file of [
    "src/components/media/media-card.tsx",
    "src/components/media/request-button.tsx",
    // Request4kButton and RequestInstanceButton post through this one.
    "src/components/media/variant-request-button.tsx",
    "src/components/admin/issue-fix-match-button.tsx",
  ]) {
    const body = src(file);
    assert.match(body, /await postMediaRequest\(/, file);
    assert.doesNotMatch(body, /_token:/, `${file}: builds its own request body with a token`);
    assert.doesNotMatch(body, /\/api\/requests\/token/, `${file}: fetches its own token`);
  }
});
