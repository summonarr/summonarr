// The header search keeps the previous query's results on screen while a new
// search is pending (src/components/layout/search-bar.tsx). Enter inside that
// window must not open one of those rows: a highlight counts only once the
// shown results answer the query and filter that are typed now.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/components/layout/search-bar.tsx", import.meta.url), "utf8");

test("the results remember which query and filter they answer", () => {
  assert.match(src, /setResults\(hits \?\? \[\]\);\s*setAnswered\(\{ query, filter \}\);/);
  assert.match(src, /setResults\(\[\]\);\s*setAnswered\(null\);/);
  assert.match(src, /const current = answered !== null && answered\.query === query && answered\.filter === filter;/);
});

test("no row is highlighted, announced or opened by Enter while the results belong to another query", () => {
  assert.match(src, /const liveIndex = current \? activeIndex : -1;/);
  assert.match(src, /e\.key === "Enter" && open && liveIndex >= 0 && liveIndex < results\.length\) \{\s*e\.preventDefault\(\);\s*handleSelect\(results\[liveIndex\]\);/);
  assert.doesNotMatch(src, /handleSelect\(results\[activeIndex\]\)/);
  assert.match(src, /\$\{optionIdBase\}-option-\$\{liveIndex\}/);
  assert.match(src, /active=\{liveIndex === i\}/);
});
