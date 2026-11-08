// The list-page SearchBox and FilterPills URL rules (src/lib/list-filter-url.ts,
// used by src/components/user-list-filters.tsx). The .tsx can't be rendered
// under node:test, so the decisions it makes live in the pure module pinned here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildParamHref,
  sameListHref,
  searchEcho,
  shouldResyncSearch,
} from "../src/lib/list-filter-url.ts";

test("the server's normalised echo of our own search does not resync the box", () => {
  // The box pushed "star " (a pause after a space); the page renders
  // initial = sanitizeContainsSearch(q.trim()) = "star".
  const lastPushed = searchEcho("star ");
  assert.equal(shouldResyncSearch("star", lastPushed, false), false);
  // LIKE wildcards the page strips count as the same search too.
  assert.equal(shouldResyncSearch("50", searchEcho("50%"), false), false);
  assert.equal(shouldResyncSearch("johndoe", searchEcho("john_doe"), false), false);
  assert.equal(shouldResyncSearch("ab", searchEcho("a\\b"), false), false);
});

test("a change from outside the box (back/forward, a link) does resync it", () => {
  assert.equal(shouldResyncSearch("foo", searchEcho("star "), false), true);
  assert.equal(shouldResyncSearch("", searchEcho("star"), false), true);
});

test("never resync while the user's own search is still waiting to be sent", () => {
  assert.equal(shouldResyncSearch("foo", searchEcho("star "), true), false);
});

test("searchEcho matches what the list pages compute for `initial`", () => {
  for (const page of ["votes", "requests", "issues"]) {
    const src = readFileSync(`src/app/(app)/${page}/page.tsx`, "utf8");
    assert.match(src, /sanitizeContainsSearch\(\([^;]*\?\? ""\)\.trim\(\)\)/, `${page}/page.tsx no longer echoes q as sanitizeContainsSearch(q.trim())`);
  }
  assert.equal(searchEcho("  star wars  "), "star wars");
  assert.equal(searchEcho("x".repeat(500)).length, 100);
});

test("buildParamHref keeps only the preserved keys, then sets or drops the param", () => {
  const current = new URLSearchParams("status=PENDING&page=3&q=old&sort=new");
  assert.equal(buildParamHref("/requests", current, "q", "dune", ["status", "sort"]), "/requests?status=PENDING&sort=new&q=dune");
  // An empty value drops the param; the page number never survives.
  assert.equal(buildParamHref("/requests", current, "q", "", ["status"]), "/requests?status=PENDING");
  assert.equal(buildParamHref("/votes", current, "mine", "1"), "/votes?mine=1");
});

test("sameListHref ignores param order but not values or paths", () => {
  assert.equal(sameListHref("/r?a=1&b=2", "/r?b=2&a=1"), true);
  assert.equal(sameListHref("/r?a=1", "/r?a=2"), false);
  assert.equal(sameListHref("/r?a=1", "/s?a=1"), false);
  assert.equal(sameListHref("/r?", "/r"), true);
});

test("the SearchBox navigates with replace and FilterPills skip a no-op click", () => {
  const src = readFileSync("src/components/user-list-filters.tsx", "utf8");
  const searchBox = src.slice(src.indexOf("export function SearchBox"));
  assert.match(searchBox, /router\.replace\(/, "typing must not add a history entry per pause");
  assert.doesNotMatch(searchBox, /router\.push\(/);
  assert.match(searchBox, /setLastPushed\(searchEcho\(next\)\)/, "lastPushed must be the server's normalised echo");
  const pills = src.slice(src.indexOf("export function FilterPills"), src.indexOf("export function SearchBox"));
  assert.match(pills, /sameListHref\(/);
  // The light-mode contrast fix from FilterBar: the active pill is not a bare bg-3 fill.
  assert.doesNotMatch(pills, /background: isActive \? "var\(--ds-bg-3\)"/);
});
