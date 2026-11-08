// Structural pin for the Votes page's query shape. The page is a `.tsx` server
// component the test loader cannot import, so its source is read.
//
// The page used to keep its own copy of the list: a Prisma filter and a raw
// SQL COUNT built twice over, and a findMany of EVERY vote row on the page's
// titles (with names and reasons) to derive a count, a poster and three
// reasons. It now reads the list GET /api/votes answers (votes-list-data.ts,
// which reads at most a few reasons per title) and adds only the reason
// authors' names, in one bounded read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(process.cwd(), "src/app/(app)/votes/page.tsx"), "utf-8");

test("the votes page reads the shared list instead of its own copy of the queries", () => {
  assert.match(src, /from "@\/lib\/votes-list-data"/);
  assert.match(src, /await loadVotesList\(session, \{ page, mine, sort, q \}\)/);
  assert.doesNotMatch(src, /\$queryRaw|Prisma\.sql|deletionVote\.groupBy|hiddenVoteTitles|myVotesByCountScope/, "a private copy of the list's queries");
});

test("the votes page's only own query is the reason authors' names, by vote id", () => {
  assert.equal((src.match(/prisma\.deletionVote\.findMany\(/g) ?? []).length, 1);
  assert.match(src, /where: \{ id: \{ in: ids \} \},\s*select: \{ id: true, user: \{ select: \{ name: true \} \} \},/);
  assert.match(src, /if \(ids\.length === 0\) return new Map\(\);/);
});
