#!/usr/bin/env node
// Patch eslint-plugin-react for ESLint 10 compatibility.
//
// Why: eslint-plugin-react@7.37.5 calls context.getFilename() in
// lib/util/version.js (the React-version auto-detect path that every rule
// loads at startup) and lib/rules/jsx-filename-extension.js. ESLint 10
// removed that method — use context.filename. Without this patch, lint
// crashes at load with "contextOrFilename.getFilename is not a function".
// Upstream fix: https://github.com/jsx-eslint/eslint-plugin-react/pull/3979
// (unmerged as of writing). Every `npm install` drops the broken file back,
// so this patch runs from the postinstall hook to re-apply the fix.
//
// Remove this script + the postinstall entry once eslint-plugin-react ships
// a release with the upstream patch and eslint-config-next bumps to it.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MARKER = "/* summonarr:eslint10-getFilename-shim */";

const TARGETS = [
  "node_modules/eslint-plugin-react/lib/util/version.js",
  "node_modules/eslint-plugin-react/lib/rules/jsx-filename-extension.js",
];

let patched = 0;
let skipped = 0;

for (const rel of TARGETS) {
  const path = resolve(ROOT, rel);
  if (!existsSync(path)) {
    skipped += 1;
    continue;
  }
  const src = readFileSync(path, "utf8");
  if (src.includes(MARKER)) {
    skipped += 1;
    continue;
  }
  const next = src.replaceAll(
    /\b(\w+)\.getFilename\(\)/g,
    "($1.filename ?? $1.getFilename?.())",
  );
  if (next === src) {
    console.warn(
      `[patch-eslint-plugin-react] no getFilename() calls found in ${rel} — has upstream changed?`,
    );
    skipped += 1;
    continue;
  }
  writeFileSync(path, `${MARKER}\n${next}`);
  patched += 1;
}

if (patched === 0 && skipped === TARGETS.length) {
  // Nothing to do (production install without eslint-plugin-react, or
  // already patched, or upstream shipped a fix and the regex no longer
  // matches). Exit silently to avoid noisy CI logs.
  process.exit(0);
}
console.warn(
  `[patch-eslint-plugin-react] patched ${patched}/${TARGETS.length} file(s) for ESLint 10 compat`,
);
