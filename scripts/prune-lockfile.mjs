#!/usr/bin/env node
// Emit a minimal package.json + package-lock.json containing only the given
// top-level dependencies and their full transitive closure, copied verbatim
// from the repo lockfile.
//
// Why: the Docker prisma-gen and migrate-deps stages need a handful of
// packages (prisma CLI, @prisma/client, dotenv, pg), not the full tree.
// They used to synthesize a bare package.json and `npm install` it, which
// re-resolved every transitive dep at build time — unpinned, drifting from
// the vetted lockfile, and flagged by OpenSSF Scorecard
// (Pinned-Dependencies). Pruning the real lockfile instead keeps `npm ci`
// semantics: every package byte-pinned by the integrity hash the repo
// lockfile already carries, including the overrides from package.json.
//
// Usage: node scripts/prune-lockfile.mjs --out <dir> <dep> [<dep>...]

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const outFlag = args.indexOf("--out");
const outDir = outFlag === -1 ? undefined : args[outFlag + 1];
const roots = args.filter((_, i) => i !== outFlag && i !== outFlag + 1);
if (!outDir || roots.length === 0) {
  console.error("usage: node scripts/prune-lockfile.mjs --out <dir> <dep> [<dep>...]");
  process.exit(1);
}

const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
const packages = lock.packages;

// npm resolution: a package at `base` sees dependency `name` at the nearest
// `<ancestor>/node_modules/<name>`, walking up from its own node_modules.
function resolveDep(base, name) {
  for (;;) {
    const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[candidate]) return candidate;
    if (!base) return null;
    const cut = base.lastIndexOf("/node_modules/");
    base = cut === -1 ? "" : base.slice(0, cut);
  }
}

const included = new Map();
const queue = roots.map((name) => {
  const path = resolveDep("", name);
  if (!path) {
    console.error(`[prune-lockfile] "${name}" is not in package-lock.json`);
    process.exit(1);
  }
  return path;
});

while (queue.length > 0) {
  const path = queue.pop();
  if (included.has(path)) continue;
  const entry = packages[path];
  included.set(path, entry);
  const edges = [
    ...Object.keys(entry.dependencies ?? {}).map((name) => [name, true]),
    ...Object.keys(entry.optionalDependencies ?? {}).map((name) => [name, false]),
    ...Object.keys(entry.peerDependencies ?? {}).map((name) => [name, false]),
  ];
  for (const [name, required] of edges) {
    const dep = resolveDep(path, name);
    if (dep) {
      queue.push(dep);
    } else if (required) {
      console.error(`[prune-lockfile] missing hard dependency "${name}" (required by ${path})`);
      process.exit(1);
    }
    // Optional and peer deps may legitimately be absent from the lockfile
    // (platform-gated binaries, unmet-optional peers like pg-native).
  }
}

// Exact-pin the requested roots so package.json and the lockfile root entry
// agree 1:1 with what `npm ci` will lay down.
const dependencies = Object.fromEntries(
  roots
    .map((name) => [name, packages[resolveDep("", name)].version])
    .sort(([a], [b]) => a.localeCompare(b)),
);

const pkg = {
  name: "summonarr-pruned",
  private: true,
  dependencies,
  // Carry overrides verbatim so `npm ci` validates the pruned tree against
  // the same override set the lockfile was resolved with (e.g. hono and
  // @hono/node-server under @prisma/dev).
  ...(rootPkg.overrides ? { overrides: rootPkg.overrides } : {}),
};

const prunedPackages = { "": { name: pkg.name, dependencies } };
for (const path of [...included.keys()].sort()) {
  const entry = { ...included.get(path) };
  // Reachability flags are relative to the original root — recomputed by npm
  // for the pruned tree, so stale values would only confuse validation.
  delete entry.dev;
  delete entry.devOptional;
  delete entry.peer;
  prunedPackages[path] = entry;
}

const prunedLock = {
  name: pkg.name,
  lockfileVersion: lock.lockfileVersion,
  requires: true,
  packages: prunedPackages,
};

mkdirSync(resolve(outDir), { recursive: true });
writeFileSync(join(resolve(outDir), "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
writeFileSync(join(resolve(outDir), "package-lock.json"), `${JSON.stringify(prunedLock, null, 2)}\n`);
