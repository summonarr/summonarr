// The browser's session has two sources: the root layout's server-rendered
// initial session (src/app/layout.tsx) and GET /api/auth/me. The session
// provider fetches /me ONLY when the initial session is null, so on every full
// page load the layout's object is the whole client session. A field /me sends
// but the layout leaves out is therefore missing after any reload: `permissions`
// was, so the nav fell back to the role preset and a role=USER delegate holding
// MANAGE_* bits lost the Admin menu (and the issue thread put a MANAGE_ISSUES
// delegate's own replies on the wrong side).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const code = (f: string) =>
  readFileSync(join(ROOT, f), "utf8").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");

// The keys of the first `user: { … }` object literal after `anchor`.
function userKeys(src: string, anchor: string): string[] {
  const at = src.indexOf(anchor);
  assert.ok(at >= 0, `anchor not found: ${anchor}`);
  const open = src.indexOf("user: {", at);
  assert.ok(open >= 0, `no user object after ${anchor}`);
  const close = src.indexOf("}", open);
  const body = src.slice(open + "user: {".length, close);
  return [...body.matchAll(/(\w+)\s*:/g)].map((m) => m[1]).sort();
}

test("the root layout's initial session carries every user field /api/auth/me returns", () => {
  const me = userKeys(code("src/app/api/auth/me/route.ts"), "function serialize(");
  const layout = userKeys(code("src/app/layout.tsx"), "const summonarrInitialSession =");
  assert.ok(me.includes("permissions"), "the /me shape moved — update this pin");
  for (const k of me) assert.ok(layout.includes(k), `layout.tsx initial session is missing \`${k}\` (it has: ${layout.join(", ")})`);
});
