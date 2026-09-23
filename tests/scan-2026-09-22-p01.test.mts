import { test } from "node:test";
import assert from "node:assert/strict";
import { stripComments } from "../scripts/audit-routes.mts";

// The keyword check ran against the emitted text, which still carries the space
// between `return` and the `/`, so a bare `$` anchor never matched. A
// keyword-led regex literal holding a quote then opened a phantom string, and
// the comment after it survived — a prose mention of a guard read as a guard.
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
