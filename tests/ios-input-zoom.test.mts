// iOS Safari zooms the whole page when a text control under 16px takes focus.
// The project's rule (Input, StyledSelect, Textarea): 16px below md. These
// inputs are styled by hand, so they are pinned here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("the list SearchBox input is 16px below md and sets no inline font size", () => {
  const src = readFileSync("src/components/user-list-filters.tsx", "utf8");
  const searchBox = src.slice(src.indexOf("export function SearchBox"));
  const input = searchBox.slice(searchBox.indexOf("<input"), searchBox.indexOf("/>", searchBox.indexOf("<input")));
  assert.match(input, /className="[^"]*\btext-base md:text-\[13px\][^"]*"/);
  assert.doesNotMatch(input, /fontSize/);
});

test("the vote reason input is 16px below md", () => {
  const src = readFileSync("src/components/votes/vote-delete-button.tsx", "utf8");
  const input = src.slice(src.indexOf("<input"), src.indexOf("/>", src.indexOf("<input")));
  assert.match(input, /className="[^"]*\btext-base md:text-\[13px\][^"]*"/);
  assert.doesNotMatch(input, /(?<!md:)text-\[13px\]/);
});

test("the header search input is 16px below md in the mobile sheet and sets no inline font size", () => {
  // The header's SearchBar lives in search-bar.tsx.
  const src = readFileSync("src/components/layout/search-bar.tsx", "utf8");
  const at = src.indexOf('role="combobox"');
  const input = src.slice(src.lastIndexOf("<input", at), src.indexOf("/>", at));
  assert.match(input, /variant === "full" \? "text-base md:text-sm"/);
  assert.doesNotMatch(input, /fontSize/);
});
