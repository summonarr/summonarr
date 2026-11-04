// Review 2026-09, package P41 (f26): the /requests page's empty state keys on
// the PAGED slice (`requests.length === 0`), not the unpaged `total`, and a
// past-the-end page offers a way back to page 1.
//
// `?page=9` with 3 requests gives total=3, requests=[], totalPages=1: the old
// `total === 0` branch rendered an empty list div under a "3 requests" header
// and the pager (gated on `totalPages > 1`) was hidden too, so the only way
// back was editing the URL. /popular already handles the same state with a
// "No more results" empty state + "Back to page 1" CTA.
//
// The page is an async server component that reads the DB, so this is a
// structural pin on the source rather than a render test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  path.join(here, "..", "src", "app", "(app)", "requests", "page.tsx"),
  "utf8",
);

test("requests page: empty state keys on the paged slice, not the unpaged total", () => {
  assert.match(
    src,
    /\{requests\.length === 0 \? \(/,
    "the empty-state branch must key on `requests.length === 0`",
  );
  assert.doesNotMatch(
    src,
    /\{total === 0 \? \(/,
    "keying on `total === 0` renders an empty list on a past-the-end page",
  );
});

// The copy now lives in the i18n catalog, so each pin checks both halves: the
// page uses the key, and the English catalog still carries the original text.
const en: Record<string, string> = JSON.parse(
  readFileSync(path.join(here, "..", "src", "lib", "i18n", "messages", "en", "requests.json"), "utf8"),
);
function assertCopy(key: string, text: RegExp): void {
  assert.ok(src.includes(`t("${key}")`), `page must render ${key}`);
  assert.match(en[key] ?? "", text);
}

test("requests page: a past-the-end page offers a link back to page 1", () => {
  assertCopy("requests.empty.pageDescription", /No more requests on this page\./);
  // The CTA is built from the same href helper the pager uses so status/sort/q
  // filters survive the jump back — now through EmptyState's cta slot, like
  // /votes and /issues, instead of an inline link in the description.
  assert.match(src, /href: pageHref\(1\)/);
  assertCopy("requests.empty.backToFirst", /Back to page 1/);
});

test("requests page: the original no-requests copy is retained for total === 0", () => {
  assertCopy("requests.empty.filteredDescription", /No requests match these filters\./);
  // The design EmptyState splits the sentence into a title ("No requests yet")
  // and a description, so the two halves are pinned separately.
  assertCopy("requests.empty.noneTitle", /No requests yet/);
  assertCopy("requests.empty.noneDescription", /Find something on Discover/);
});
