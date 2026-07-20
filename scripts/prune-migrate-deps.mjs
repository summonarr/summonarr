// Prune the migrate-deps node_modules tree down to what `prisma db push`
// (the only Prisma CLI command the docker-entrypoint runs) plus the operator
// scripts (pg, dotenv) actually need at runtime.
//
// Why this exists: the Prisma 7 CLI declares hard dependencies on its whole
// interactive tooling surface — `@prisma/studio-core` (browser UI bundle),
// `@prisma/dev` (local-dev PGlite runtime), `mysql2`/`postgres` drivers,
// `typescript`, `react`/`react-dom`, `chart.js`, `@electric-sql/pglite`, …
// npm installs all of it (~250 MB), but a traced run of every entrypoint
// db-push code path (fresh init, no-op push, additive drift, data-loss
// refusal + --accept-data-loss retry, DB-unreachable P1001) loads none of
// those packages. The CLI bundle does require() a handful of thin entry
// files from studio-core/dev at module load, so those two packages are
// kept as skeletons (heavy asset subtrees removed) instead of deleted.
//
// KEPT on purpose (verified load-bearing):
//   - @prisma/engines and its native schema-engine binary: `db push` runs the
//     native engine and, if the binary is missing, tries to DOWNLOAD it at
//     runtime (boot-time internet dependency — unacceptable). Never prune it.
//   - @prisma/fetch-engine, @prisma/get-platform: required at CLI module load.
//   - effect (cjs half): hard-required by @prisma/config at module load.
//   - fast-check, valibot, remeda, zeptomatch(+graphmatch/grammex), jiti,
//     pathe, c12 closure: loaded for prisma.config.ts parsing/validation.
//
// Safety net: the Dockerfile runs a smoke test AFTER this script (a real
// `db push` against an unreachable DB must fail with P1001, proving the
// full module graph — config load, engine resolution, error formatting —
// still loads). If a future Prisma bump starts loading a pruned package,
// the image build fails loudly there instead of user containers crashing
// at boot. When that happens, remove the offending entry below.
import { rmSync, existsSync, globSync } from "node:fs";
import { join } from "node:path";

const nm = join(process.cwd(), "node_modules");
if (!existsSync(join(nm, "prisma"))) {
  console.error("[prune-migrate-deps] node_modules/prisma not found — run from the migrate-deps stage root");
  process.exit(1);
}

// Entire packages never loaded by any db-push code path.
const packages = [
  // interactive/dev tooling surfaces of the prisma CLI
  "@clack",
  "@electric-sql",
  "@prisma/query-plan-executor",
  "@prisma/streams-local",
  "mysql2",
  "postgres",
  "typescript",
  // prisma studio UI dependency tree
  "@hono",
  "@kurkle",
  "@radix-ui",
  "@standard-schema",
  "@types",
  "better-result",
  "chart.js",
  "csstype",
  "fast-deep-equal",
  "fast-uri",
  "hono",
  "http-status-codes",
  "react",
  "react-dom",
  "require-from-string",
  "scheduler",
  // process-spawn helpers only used by `prisma dev`/studio launchers
  "cross-spawn",
  "foreground-child",
  "isexe",
  "path-key",
  "picocolors",
  "shebang-command",
  "shebang-regex",
  "sisteransi",
  "which",
];

// Heavy subtrees of packages whose entry files ARE required at CLI load.
const subtrees = [
  "@prisma/studio-core/dist/ui", // browser UI bundle (25 MB)
  "@prisma/dev/dist/runtime-assets", // PGlite wasm runtime (14 MB)
  "effect/src", // TS sources; runtime uses dist/cjs
  "effect/dist/esm", // CLI is CJS; the esm half never loads
  // Wasm engines the CLI ships but db push doesn't use (it runs the native
  // schema-engine binary from @prisma/engines — verified: deleting these and
  // pushing succeeds; deleting the native binary triggers a runtime download).
  "prisma/build/schema_engine_bg.wasm",
  "prisma/build/studio.js",
];

let freed = 0;
const rm = (p) => {
  const full = join(nm, p);
  if (existsSync(full)) {
    rmSync(full, { recursive: true, force: true });
    freed++;
  }
};

packages.forEach(rm);
subtrees.forEach(rm);

// Per-database query-compiler wasms (client-side compilers, unused by db push).
for (const f of globSync("prisma/build/query_compiler_*_bg.*.wasm", { cwd: nm })) rm(f);
// studio-core build metafiles + type declarations across the kept skeletons.
for (const f of globSync("@prisma/studio-core/dist/metafile*.json", { cwd: nm })) rm(f);
for (const f of globSync("effect/**/*.{d.ts,d.cts,d.mts,ts.map,js.map,cjs.map,mjs.map}", { cwd: nm })) rm(f);

// The native schema engine must still be present — refuse to continue without it.
const engines = globSync("@prisma/engines/schema-engine-*", { cwd: nm });
if (engines.length === 0) {
  console.error("[prune-migrate-deps] FATAL: no @prisma/engines/schema-engine-* binary found after prune");
  process.exit(1);
}

console.error(`[prune-migrate-deps] pruned ${freed} paths; kept schema engine: ${engines.join(", ")}`);
