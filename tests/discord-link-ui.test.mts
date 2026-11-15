// Profile → Discord "Link from Discord": the server's link token lives 10
// minutes (generate-link). Past its expiresAt the card must stop offering it —
// no copy button, no `/link token:…` command — and say it expired, or the user
// copies and runs a dead code. The component is a .tsx client module the unit
// loader can't import, so the wiring is pinned by a structural scan; the
// render-purity scan (tests/client-render-purity.test.mts) separately keeps
// Date.now() out of its render path (guardrail 16).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/components/discord-link-ui.tsx", import.meta.url), "utf8");
const flow = src.slice(src.indexOf("function TokenLinkFlow("), src.indexOf("function WebMergeFlow("));

test("the token's expiry is a timer in an effect keyed on expiresAt, cleared on change and unmount", () => {
  assert.match(
    flow,
    /useEffect\(\(\) => \{\s*if \(!expiresAt\) return;\s*const id = setTimeout\(\(\) => setExpired\(true\), Math\.max\(0, expiresAt\.getTime\(\) - Date\.now\(\)\)\);\s*return \(\) => clearTimeout\(id\);\s*\}, \[expiresAt\]\);/,
  );
  // Only that effect reads the clock (comment lines aside).
  const code = flow.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.equal(code.split("Date.now()").length - 1, 1);
});

test("a freshly generated token is live again, and an expired one is neither copyable nor shown with its command", () => {
  assert.match(flow, /setExpiresAt\(new Date\(data\.expiresAt\)\);\s*setExpired\(false\);/);
  assert.match(flow, /if \(!token \|\| expired\) return;/);
  assert.match(flow, /\{!expired && \(\s*<Button[\s\S]*?onClick=\{copyToken\}/);
  const expiredBranch = flow.slice(flow.indexOf("{expired ? ("), flow.indexOf(") : (", flow.indexOf("{expired ? (")));
  assert.match(expiredBranch, /profile\.discord\.expired/);
  assert.doesNotMatch(expiredBranch, /\/link token:/);
});
