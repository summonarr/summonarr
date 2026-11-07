// The deletion-votes list's paging scope (src/lib/votes-visibility.ts) and how
// the /votes page uses it.
//
// - scopeVotesWhere subtracts the titles hidden from the viewer BEFORE paging
//   (guardrail 35a). It must never drop an exclusion the caller's `where`
//   already carries: spreading `NOT` over it silently replaced that filter.
// - "My votes" sorted by vote count pages over EVERY voter's rows on the
//   caller's titles. Scoped to the caller, each group holds just their one row,
//   so `_count` tied at 1 and the order fell through to tmdbId.
// - The page clamps ?page= through parsePageNumber, like the request queues.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto
process.env.NEXTAUTH_SECRET = "votes-visibility-test-secret-0123456789abcdef";

const { scopeVotesWhere, votesOnTitlesWhere } = await import("../src/lib/votes-visibility.ts");

const hidden = [
  { tmdbId: 7, mediaType: "MOVIE" as const },
  { tmdbId: 9, mediaType: "TV" as const },
];
const hiddenKeys = {
  OR: [
    { mediaType: "MOVIE", tmdbId: { in: [7] } },
    { mediaType: "TV", tmdbId: { in: [9] } },
  ],
};

test("scopeVotesWhere leaves the where untouched when nothing is hidden", () => {
  const where = { userId: "u1" };
  assert.equal(scopeVotesWhere(where, []), where);
});

test("scopeVotesWhere puts the hidden titles in a top-level NOT beside the caller's filters", () => {
  const where = { title: { contains: "matrix", mode: "insensitive" as const } };
  assert.deepEqual(scopeVotesWhere(where, hidden), { ...where, NOT: hiddenKeys });
});

test("scopeVotesWhere keeps a NOT the caller already set: both exclusions apply", () => {
  const where = { NOT: { userId: "x" } };
  assert.deepEqual(scopeVotesWhere(where, hidden), { AND: [where, { NOT: hiddenKeys }] });
});

test("votesOnTitlesWhere selects every voter's rows on the given titles, minus the hidden ones", () => {
  const voted = [
    { tmdbId: 7, mediaType: "MOVIE" as const },
    { tmdbId: 8, mediaType: "MOVIE" as const },
  ];
  const where = votesOnTitlesWhere(voted, [hidden[0]]);
  assert.deepEqual(where, {
    OR: [{ mediaType: "MOVIE", tmdbId: { in: [7, 8] } }],
    NOT: { OR: [{ mediaType: "MOVIE", tmdbId: { in: [7] } }] },
  });
  assert.equal((where as { userId?: unknown }).userId, undefined, "no caller scope on the counted rows");
  // No voted title selects nothing (`OR: []` is false in Prisma).
  assert.deepEqual(votesOnTitlesWhere([], []), { OR: [] });
});

const page = readFileSync(new URL("../src/app/(app)/votes/page.tsx", import.meta.url), "utf8");

test("the /votes page clamps ?page= through parsePageNumber", () => {
  assert.match(page, /const page = parsePageNumber\(sp\.page\);/);
  assert.doesNotMatch(page, /parseInt\(first\(sp\.page\)/, "the unclamped parse is gone");
});

test("the /votes page pages 'my votes by count' over every voter's rows on the caller's titles", () => {
  const branch = /if \(mine && sort === "votes"\) \{([\s\S]*?)\} else \{/.exec(page);
  assert.ok(branch, "the mine-by-count branch is missing");
  assert.match(branch[1], /myVotesByCountScope\(session, where\)/);
  assert.match(branch[1], /scopedWhere = scope\.where;/);
});
