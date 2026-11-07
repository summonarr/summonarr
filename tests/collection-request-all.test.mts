// The collection "Request all" button (src/components/media/collection-request-all.tsx)
// against the bulk route it posts to. A "use client" JSX module Node can't
// import, so these are source pins, the idiom of detail-action-state.test.mts.
//
//   - One chunk cap, shared: the button chunked by a hand-copied 50 that had to
//     match the route's MAX_ITEMS; a lower server cap would 400 every chunk.
//   - Permanently declined titles are left out (the route skips them on every
//     click, and the button offered them again on every visit), and the
//     per-item `results` are read so the line says how many can't be requested.
//   - The outcome is announced (a live region), not just painted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BULK_REQUEST_MAX_ITEMS } from "../src/lib/request-limits.ts";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const src = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");
const BUTTON = src("src/components/media/collection-request-all.tsx");
const ROUTE = src("src/app/api/requests/bulk/route.ts");

test("the button and the bulk route share one chunk cap", () => {
  assert.equal(BULK_REQUEST_MAX_ITEMS, 50, "the iOS app and other clients rely on the 50-item cap");
  for (const [name, body] of [["button", BUTTON], ["route", ROUTE]] as const) {
    assert.match(body, /import \{ BULK_REQUEST_MAX_ITEMS \} from "@\/lib\/request-limits";/, name);
    assert.doesNotMatch(body, /MAX_ITEMS = \d/, `${name}: a private numeric copy of the cap`);
  }
  assert.match(BUTTON, /payload\.slice\(i, i \+ BULK_REQUEST_MAX_ITEMS\)/);
  assert.match(ROUTE, /body\.items\.length > MAX_ITEMS/);
});

test("permanently declined titles are not counted or sent", () => {
  assert.match(BUTTON, /!declined\.has\(`\$\{m\.mediaType\}:\$\{m\.id\}`\)/);
  const row = src("src/components/media/collection-row.tsx");
  assert.match(row, /declinedKeys=\{declinedKeys\}/);
  const page = src("src/app/(app)/movie/[id]/page.tsx");
  assert.match(page, /permanentlyDeclinedKeys\(rawCollection, session\.user\.id\)/);
  assert.match(page, /declinedKeys=\{collectionDeclined\}/);
});

test("the per-item results are read and the unrequestable ones reported", () => {
  assert.match(BUTTON, /for \(const r of data\.results \?\? \[\]\)/);
  assert.match(BUTTON, /request\.collection\.doneSkipped/);
  // Only outcomes that mean "this title can't be requested" — not the
  // already-* ones (nothing to do) and not created/auto-approved.
  const set = /const UNREQUESTABLE = new Set\(\[([^\]]*)\]\)/.exec(BUTTON);
  assert.ok(set);
  const members = set[1].split(",").map((m) => m.trim().replace(/"/g, ""));
  assert.deepEqual(members.sort(), ["blacklisted", "no-permission", "rating-blocked", "skipped-declined"]);
});

test("the outcome line sits in an always-mounted live region", () => {
  const region = /<span className="sr-only" role="status">\s*\{showMsg \? msg : ""\}\s*<\/span>/.exec(BUTTON);
  assert.ok(region, "an always-mounted role=status region carries the message");
});
