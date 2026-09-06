// Structural pin for the Votes page's query shape (review 2026-09, f30).
//
// Why a SOURCE-level test: the page is a `.tsx` server component that renders
// JSX and calls Prisma directly, so the test loader cannot import it, and the
// defect being pinned is a query-count regression that types, lint and a
// logged-in browser check are all blind to. Two round-trips were avoidable:
//
// 1. A second `deletionVote.findMany` re-read the exact row set the first
//    one had already materialized, filtered to the viewer, only to answer the
//    boolean `userVoted`. The first query now selects `userId` and the flag is
//    derived in memory.
// 2. The paged `groupBy` and the pagination COUNT depend only on the request,
//    not on each other, so they run inside one `Promise.all`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PAGE = join(process.cwd(), "src/app/(app)/votes/page.tsx");
const src = readFileSync(PAGE, "utf-8");

const count = (re: RegExp) => (src.match(re) ?? []).length;

test("votes page issues exactly ONE deletionVote.findMany (userVoted is derived from it, not re-queried)", () => {
  assert.equal(
    count(/prisma\.deletionVote\.findMany\(/g),
    1,
    "a second findMany over the same group set re-reads rows already in memory",
  );
  // The single query must carry the viewer id so the flag can be derived.
  const findManyIdx = src.indexOf("prisma.deletionVote.findMany(");
  const selectBlock = src.slice(findManyIdx, src.indexOf("orderBy", findManyIdx));
  assert.ok(/userId:\s*true/.test(selectBlock), "the findMany select must include userId");
  assert.ok(
    /userVoted:\s*votes\.some\(\(v\)\s*=>\s*v\.userId\s*===\s*session\.user\.id\)/.test(src),
    "userVoted must be derived from the already-fetched rows",
  );
  assert.ok(!src.includes("userVoteSet"), "the userVoteSet Set (fed by the deleted second query) must be gone");
});

test("votes page runs the paged groupBy and the pagination COUNT in one Promise.all", () => {
  const groupByIdx = src.indexOf("prisma.deletionVote.groupBy(");
  const countIdx = src.indexOf("prisma.$queryRaw<{ count: bigint }[]>(");
  assert.ok(groupByIdx > 0 && countIdx > 0, "both queries must still exist");
  // Find the nearest preceding `await Promise.all([` and require that both
  // queries sit inside that same call (no `await` between its opening and
  // either query).
  const promiseAllIdx = src.lastIndexOf("await Promise.all([", groupByIdx);
  assert.ok(promiseAllIdx > 0, "groupBy must be inside a Promise.all");
  const between = src.slice(promiseAllIdx + "await Promise.all([".length, Math.max(groupByIdx, countIdx));
  assert.ok(!/\bawait\b/.test(between), "groupBy and the COUNT must share one Promise.all (no await between them)");
  assert.ok(countIdx > promiseAllIdx, "the COUNT query must sit inside the same Promise.all as the groupBy");
  // The SQL builder feeding the COUNT is pure and must be assembled BEFORE the
  // Promise.all, or the count cannot be issued alongside the groupBy.
  const whereSqlIdx = src.indexOf("const whereSql =");
  assert.ok(whereSqlIdx > 0 && whereSqlIdx < promiseAllIdx, "whereSql must be built before the Promise.all");
});
