// The admin issue controls between a click and the page's refresh.
//
// The page refreshes through ONE debounced timer (refresh-hold.ts, ≥500 ms
// plus a server render), deferred for as long as any dialog holds it. Until
// the new props land, the controls used to describe the issue as it WAS:
//
// - Claim (issue-claim-button.tsx): a second click posted the old
//   `expectedClaimedBy` and drew a 409 naming the admin themself. The button
//   now keeps the claim it last saw — the route's answer — and a new prop
//   from the server always wins.
// - Status / Delete (IssueActions): a second Delete 404'd, and a stale
//   "In progress" after a Resolve passed the server's check against the new
//   status and silently reopened the issue. The buttons stay disabled from a
//   successful change until `currentStatus` moves.
// - Resolve: a sent note stayed in the box and was re-sent on the next
//   Resolve after a Reopen; a failure closed the panel; Enter did nothing.
//
// Structural pins (the unit loader can't mount these client components).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { functionBody, stripComments } = await import("./structural-pin-source-scan.mts");
const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

test("claim: the label and the posted expectation come from the button's own claim, refreshed by each answer", () => {
  const src = stripComments(read("src/components/admin/issue-claim-button.tsx"));
  assert.match(src, /const \[localClaimedBy, setLocalClaimedBy\] = useState\(claimedBy\);/);
  assert.match(src, /if \(claimedBy !== prevClaimedBy\) \{\s*setPrevClaimedBy\(claimedBy\);\s*setLocalClaimedBy\(claimedBy\);\s*\}/, "a new prop from the server wins");
  assert.match(src, /const isClaimedByMe = localClaimedBy === currentUserId;/);
  assert.match(src, /const isClaimedByOther = localClaimedBy !== null && !isClaimedByMe;/);

  const toggle = functionBody(src, "async function performToggle(");
  assert.match(toggle, /const expectedClaimedBy = localClaimedBy;/);
  assert.match(toggle, /body: JSON\.stringify\(\{ expectedClaimedBy \}\)/, "the wire body is unchanged");
  assert.doesNotMatch(toggle, /expectedClaimedBy: claimedBy\b/, "never the raw prop");
  // A 2xx answers the updated row: its claimedBy becomes the button's.
  const ok = toggle.slice(toggle.indexOf("return;\n      }"));
  assert.match(ok, /updated\.claimedBy[\s\S]*?setLocalClaimedBy\(|setLocalClaimedBy\([\s\S]*?updated\.claimedBy/);
  assert.match(ok, /requestPageRefresh\(\(\) => router\.refresh\(\)\);/);
  // A 409 falls back to the server-rendered claim, so a stale local claim can't loop.
  assert.match(toggle, /if \(res\.status === 409\) \{\s*setLocalClaimedBy\(claimedBy\);\s*requestPageRefresh\(\(\) => router\.refresh\(\)\);\s*\}/);
});

test("status and delete: the buttons stay disabled from a successful change until currentStatus moves", () => {
  const src = stripComments(read("src/components/admin/issue-actions.tsx"));
  const actions = functionBody(src, "export function IssueActions(");
  assert.match(actions, /const \[actedFrom, setActedFrom\] = useState<string \| null>\(null\);/);
  assert.match(actions, /if \(actedFrom !== null && actedFrom !== currentStatus\) setActedFrom\(null\);/);
  assert.match(actions, /const busy = loading !== null \|\| actedFrom !== null;/);
  assert.doesNotMatch(actions, /disabled=\{loading !== null\}/, "every action button uses busy");

  for (const name of ["async function updateStatus(", "async function deleteIssue("]) {
    const fn = functionBody(actions, name);
    assert.match(fn, /^\s*if \(busy\) return;/, `${name} refuses while busy`);
    const ok = fn.indexOf("setActedFrom(currentStatus);");
    assert.ok(ok > fn.indexOf("if (!res.ok)"), `${name} locks only after the server said yes`);
    assert.ok(ok < fn.indexOf("requestPageRefresh(() => router.refresh());"), name);
  }
});

test("resolve: a sent note is cleared, a failure keeps the panel open, and Enter submits", () => {
  const src = stripComments(read("src/components/admin/issue-actions.tsx"));
  const actions = functionBody(src, "export function IssueActions(");
  const update = functionBody(actions, "async function updateStatus(");
  const ok = update.slice(update.indexOf("setActedFrom(currentStatus);"));
  assert.match(ok, /setResolution\(""\);\s*setPanel\(null\);/, "success clears the note and closes the panel");
  assert.doesNotMatch(update.slice(update.indexOf("} finally {")), /setPanel\(/, "a failure leaves the panel (and the note) open");

  const panel = actions.slice(actions.indexOf('panel === "resolve" ? ('), actions.indexOf('panel === "delete" ? ('));
  assert.match(panel, /<form[\s\S]*?onSubmit=\{\(e\) => \{\s*e\.preventDefault\(\);\s*void updateStatus\("RESOLVED", resolution \|\| undefined\);\s*\}\}/);
  assert.match(panel, /<Button\s+type="submit"/);
});
