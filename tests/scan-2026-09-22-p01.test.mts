import { test } from "node:test";
import assert from "node:assert/strict";
import { stripComments } from "../scripts/audit-routes.mts";

// stripComments must tell a regex literal (`return /x/`) apart from a division.
// It used to check for a keyword right before the `/` with a `$` anchor, but the
// text it checked still had the space after `return`, so the check never matched.
// A quote inside that regex was then read as the start of a string, and the
// `//` comment after it was kept — so a comment merely mentioning a guard like
// withAdmin( was counted as a real guard by the route audit.
test("a regex literal after `return ` is recognised, so the trailing comment is stripped", () => {
  const src = 'function f(x) {\n  return /[\'"]/.test(x); // withAdmin(\n}\n';
  const out = stripComments(src);
  assert.doesNotMatch(out, /withAdmin/, "the comment after the regex must be removed");
  assert.match(out, /return \/\['"\]\/\.test\(x\);/, "the regex literal itself must survive");
});

test("a regex after `typeof`-style keywords with extra whitespace is still a regex", () => {
  const out = stripComments("const ok = x instanceof   /a'b/.constructor; // requireAuth(\n");
  assert.doesNotMatch(out, /requireAuth/);
});
