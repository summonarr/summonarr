// /admin/issues (a server component, so pinned from source):
//
// - The list reads ONE row past ISSUE_LIST_CAP to tell "exactly the cap" from
//   "more". Checking `length >= cap` on a capped read said older issues were
//   missing from a tab holding exactly 500.
// - The reporter name is read through the typed `user` include, never through
//   an `as unknown as` cast that hides an include change from the compiler.
// - One IssueActions builder serves the card, the mobile detail and the aside,
//   so a prop change can't land in one copy and miss the others.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const page = readFileSync(new URL("../src/app/(app)/admin/issues/page.tsx", import.meta.url), "utf8");

test("the cap notice shows only when rows past the cap exist", () => {
  assert.match(page, /take: ISSUE_LIST_CAP \+ 1,/);
  assert.match(page, /const capped = issueRows\.length > ISSUE_LIST_CAP;/);
  assert.match(page, /const allIssues = capped \? issueRows\.slice\(0, ISSUE_LIST_CAP\) : issueRows;/);
  assert.match(page, /\{capped && \(/);
  assert.doesNotMatch(page, />= ISSUE_LIST_CAP/, "exactly the cap is not capped");
});

test("reporter names come from the typed user include", () => {
  // The grouping lives in src/lib/issue-groups.ts (tests/issue-groups.test.mts).
  const groups = readFileSync(new URL("../src/lib/issue-groups.ts", import.meta.url), "utf8");
  assert.doesNotMatch(page, /as unknown as/);
  assert.doesNotMatch(groups, /as unknown as/);
  assert.match(page, /const groups = groupIssues\(allIssues\);/);
  assert.match(groups, /user: \{ name: string \| null; email: string \};/, "groupIssues' constraint names the include");
  // A blank display name falls back to the email (display-name.ts).
  assert.match(groups, /reporterNames: \[\.\.\.new Set\(group\.map\(\(i\) => nameOrEmail\(i\.user\)\)\)\]/);
});

test("IssueActions and its claim are built in one place each", () => {
  assert.equal(page.match(/<IssueActions\b/g)?.length, 1);
  assert.equal(page.match(/<IssueFixMatchButton\b/g)?.length, 1);
  assert.equal(page.match(/<IssueClaimButton\b/g)?.length, 1);
  // The card passes nothing; the mobile detail and the aside pass their key, alignment and claim.
  assert.match(page, /\{issueActionsFor\(issue\)\}/);
  assert.match(page, /issueActionsFor\(sel, \{ key: `actions-\$\{sel\.id\}`, align: "start", claim: claimFor\(sel\) \}\)/);
  assert.match(page, /issueActionsFor\(selectedIssue, \{\s*key: `actions-\$\{selectedIssue\.id\}`,\s*align: "start",\s*claim: claimFor\(selectedIssue\),\s*\}\)/);
});
