// Module-resolution hooks for the unit suite, registered via `--import` in the
// npm test script. Plain `node --test` has no bundler, so several things the
// app source legitimately uses don't resolve without help:
//
//   1. The tsconfig "@/*" path alias (→ ./src/*) — Node knows nothing about
//      tsconfig paths.
//   2. Extensionless relative imports (`./prisma`) — valid TS, but Node ESM
//      requires explicit extensions.
//   3. "server-only" / "client-only" — bundler-provided marker packages that
//      are not installed; mapped to an empty stub. (The stub obviously does
//      NOT enforce the boundary — tests run on the server side by definition.)
//   4. "next/server", "next/headers", "next/navigation" — next's package.json
//      has no exports entries for them (the bundler resolves them); the real
//      files are the .js siblings, so the specifiers are rewritten. Tests get
//      the REAL NextRequest/NextResponse.
//
// This file must stay dependency-free and side-effect-free beyond hook
// registration: every test child process loads it.
import { registerHooks } from "node:module";
import { statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../src");
const STUB = pathToFileURL(resolve(HERE, "_server-only-stub.mjs")).href;

const NEXT_REWRITES = new Map([
  ["next/server", "next/server.js"],
  ["next/headers", "next/headers.js"],
  ["next/navigation", "next/navigation.js"],
]);

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

// Try TS-style resolution for an extensionless path: exact file, .ts/.tsx,
// then directory index (generated Prisma client resolves via index.js).
function resolveTsPath(base) {
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    base,
    `${base}/index.ts`,
    `${base}/index.js`,
  ]) {
    if (isFile(candidate)) return pathToFileURL(candidate).href;
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only" || specifier === "client-only") {
      return { url: STUB, shortCircuit: true };
    }
    const rewrite = NEXT_REWRITES.get(specifier);
    if (rewrite) {
      return nextResolve(rewrite, context);
    }
    if (specifier.startsWith("@/")) {
      const url = resolveTsPath(resolve(SRC, specifier.slice(2)));
      if (url) return { url, shortCircuit: true };
    }
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
      try {
        return nextResolve(specifier, context);
      } catch (err) {
        if (err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
        const base = resolve(dirname(fileURLToPath(context.parentURL)), specifier);
        const url = resolveTsPath(base);
        if (url) return { url, shortCircuit: true };
        throw err;
      }
    }
    return nextResolve(specifier, context);
  },
});
