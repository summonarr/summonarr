import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Next 16.3 renamed the error-boundary prop `unstable_retry` → `retry`
// (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md,
// version history). The runtime ErrorBoundary passes ONLY `retry`, so a
// boundary still destructuring `unstable_retry` gets `undefined` and its
// "Try again" button throws a TypeError on click. All three boundaries shipped
// that way once; pin the prop name structurally.
const BOUNDARIES = [
  "src/app/global-error.tsx",
  "src/app/(app)/error.tsx",
  "src/app/(app)/admin/error.tsx",
];

for (const rel of BOUNDARIES) {
  test(`error boundary ${rel} destructures the stable \`retry\` prop`, () => {
    const src = readFileSync(resolve(process.cwd(), rel), "utf8");
    assert.doesNotMatch(src, /unstable_retry/, `${rel} still references unstable_retry`);
    assert.match(src, /\bretry\s*:\s*\(\)\s*=>\s*void/, `${rel} must type a \`retry: () => void\` prop`);
    assert.match(src, /retry\(\)/, `${rel} must invoke retry() from its Try-again control`);
  });
}
