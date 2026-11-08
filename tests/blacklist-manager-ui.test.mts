// The request blacklist manager (blacklist-manager.tsx, pure halves in
// blacklist-rows.ts). The page ships only the newest 1000 blocked rows, so
// whether a search result is already blocked comes from /api/search's own
// `blacklisted` flag too, the blocked count follows the POST's `created` and
// the DELETE's `removed` answers (tests/blacklist-route.test.mts pins the route
// side), and a blocked search hit can be unblocked — the only way to reach a
// title past the first 1000. Every row has its own in-flight slot, so one
// request finishing never re-enables another row's button mid-request.
// Structural pins for the .tsx (the unit loader can't render it), direct tests
// for the pure module.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { addAnswerFrom, filterRows, removedCountFrom, searchResultsFrom } from "../src/components/admin/blacklist-rows.ts";

const src = readFileSync(new URL("../src/components/admin/blacklist-manager.tsx", import.meta.url), "utf8");
const fn = (name: string, next: string) => {
  const a = src.indexOf(name);
  assert.ok(a >= 0, name);
  return src.slice(a, src.indexOf(next, a));
};

test("search results keep /api/search's blacklisted flag; only movie and TV items, each checked, at most 8", () => {
  const data = [
    { id: 1, mediaType: "movie", title: "A", releaseYear: "2001", blacklisted: true, overview: "…" },
    { id: 2, mediaType: "person", title: "Someone" },
    { id: "3", mediaType: "tv", title: "Bad id" },
    { id: 4, mediaType: "tv", title: "D", releaseYear: null },
    ...Array.from({ length: 10 }, (_, i) => ({ id: 10 + i, mediaType: "movie", title: `M${i}` })),
  ];
  const out = searchResultsFrom(data);
  assert.equal(out.length, 8);
  assert.deepEqual(out[0], { id: 1, mediaType: "movie", title: "A", releaseYear: "2001", blacklisted: true });
  assert.deepEqual(out[1], { id: 4, mediaType: "tv", title: "D", releaseYear: null, blacklisted: false });
  assert.deepEqual(searchResultsFrom({ error: "rate limited" }), [], "an error body is no result list");
  assert.match(src, /const isBlocked = \(r: SearchResult, k: string\) => blocked\.has\(k\) \|\| r\.blacklisted;/);
  assert.match(fn("async function add(", "async function remove("), /if \(isBlocked\(r, k\)\) return;/);
});

test("a blocked search hit offers Unblock (the only way to reach a title past the first 1000)", () => {
  const row = fn("function SearchResultRow(", "function BlockedList(");
  assert.match(row, /\{rowBlocked \? \(/);
  assert.match(row, /onClick=\{\(\) => void bl\.remove\(\{ tmdbId: r\.id, mediaType \}\)\}/);
  assert.match(row, /disabled=\{rowBusy\}/);
});

test("unblocking a title clears the search's stale flag for it", () => {
  const remove = fn("async function remove(", "\n  return {\n");
  assert.match(remove, /setResults\(\(prev\) =>[\s\S]*?\{ \.\.\.r, blacklisted: false \}/);
});

test("the blocked count follows the server: up only when it added a row, down only by what it removed", () => {
  const add = fn("async function add(", "async function remove(");
  assert.match(add, /if \(d\.created\) setBlockedTotal\(\(n\) => n \+ 1\);/);
  assert.doesNotMatch(add, /items\.some\(/, "never judged from this call's stale `items` closure");
  const remove = fn("async function remove(", "\n  return {\n");
  assert.match(remove, /if \(removed > 0\) setBlockedTotal\(\(n\) => Math\.max\(0, n - removed\)\);/);
  assert.equal(removedCountFrom({ ok: true, removed: 1 }), 1);
  assert.equal(removedCountFrom({ ok: true, removed: 0 }), 0, "another admin removed it first");
  assert.equal(removedCountFrom(null), 0, "an unreadable answer moves nothing");
  assert.deepEqual(addAnswerFrom({ item: { title: "A", reason: null, createdAt: "2026-01-01T00:00:00.000Z" }, created: true }), {
    item: { title: "A", reason: null, createdAt: "2026-01-01T00:00:00.000Z" }, created: true,
  });
  assert.deepEqual(addAnswerFrom({ created: "yes" }), { item: null, created: false });
});

test("each row has its own in-flight slot; a busy row is skipped, never sent twice", () => {
  for (const name of ["async function add(", "async function remove("]) {
    const body = fn(name, name === "async function add(" ? "async function remove(" : "\n  return {\n");
    assert.match(body, /await actions\.run\(k, \(signal\) =>/, `${name} runs under the row's own key`);
    assert.match(body, /\{ ifBusy: "skip" \}\);/, `${name} is never sent twice`);
  }
  assert.match(src, /busy: \(k: string\) => actions\.busy\(k\)/);
  assert.equal(src.match(/busy === k/g), null, "no single-slot comparison left");
});

test("an error is announced, and it is the route's own text or a network line — never a raw body", () => {
  assert.match(src, /\{bl\.error && \(\s*<p role="alert"/);
  assert.match(src, /const failureText = \(res: \{ kind: string; error: string \}\) => \(res\.kind === "http" \? res\.error : t\("shared\.thread\.networkError"\)\);/);
  assert.doesNotMatch(src, /d\.error \?\?/);
});

test("the client filter: title, reason, or the exact id", () => {
  const rows = [
    { tmdbId: 12, mediaType: "MOVIE" as const, title: "Alpha", reason: "spam", createdAt: "" },
    { tmdbId: 3, mediaType: "TV" as const, title: null, reason: null, createdAt: "" },
  ];
  assert.equal(filterRows(rows, "  ").length, 2);
  assert.deepEqual(filterRows(rows, "SPAM").map((r) => r.tmdbId), [12]);
  assert.deepEqual(filterRows(rows, "tmdb #3").map((r) => r.tmdbId), [3]);
  assert.deepEqual(filterRows(rows, "1").map((r) => r.tmdbId), [], "an id matches exactly, never as a substring");
});
