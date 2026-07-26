// Drift pin for the dual-compiler setup (CLAUDE.md "Commands").
//
// The root `typescript` MUST stay on 6 and the `tsgo` alias MUST stay on 7:
//   - `next build` and typescript-eslint both `require('typescript')` and probe
//     `typescript/lib/typescript.js` / `ts.Extension`, neither of which exists
//     in TS 7. Bumping the root to 7 makes `npm run lint` die with
//     "TypeError: Cannot read properties of undefined (reading 'Cjs')" and
//     breaks the build.
//   - `npm run typecheck` runs the native TS 7 compiler via the `tsgo` alias
//     (npm:typescript@7), so dropping that alias silently downgrades the
//     native-compiler half of the dual typecheck to nothing.
//
// .github/dependabot.yml carries two `ignore` rules plus a group
// `exclude-patterns` for this, but a grouped "across 1 directory" PR bypassed
// the ignores twice already (#165, #173, and again in #189, which bumped
// "typescript": "^6" -> "^7" and failed CI). Config alone has not held, so this
// makes the constraint a `npm test` failure that no dependency PR can merge past.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const pkg = JSON.parse(
  readFileSync(join(process.cwd(), "package.json"), "utf-8"),
) as { devDependencies: Record<string, string> };

test("root `typescript` devDependency stays on major 6", () => {
  const range = pkg.devDependencies.typescript;
  assert.ok(range, "package.json devDependencies.typescript is missing");
  assert.match(
    range,
    /^\^?6(\.|$)/,
    `root typescript must stay on 6 until Next and typescript-eslint support the TS 7 JS API (got "${range}")`,
  );
});

test("`tsgo` stays aliased to typescript major 7", () => {
  const range = pkg.devDependencies.tsgo;
  assert.ok(range, "package.json devDependencies.tsgo is missing");
  assert.match(
    range,
    /^npm:typescript@\^?7(\.|$)/,
    `tsgo must stay aliased to npm:typescript@7 — it powers \`npm run typecheck\` (got "${range}")`,
  );
});

test("the installed compilers match the two ranges", () => {
  const read = (p: string) =>
    (JSON.parse(readFileSync(join(process.cwd(), "node_modules", p, "package.json"), "utf-8")) as { version: string })
      .version;
  assert.match(read("typescript"), /^6\./, "node_modules/typescript resolved off major 6");
  assert.match(read("tsgo"), /^7\./, "node_modules/tsgo resolved off major 7");
});
