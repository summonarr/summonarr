// Architecture drift pins for the three guardrails that had NO test coverage at
// all: 3 (schema-first Prisma, no migrations directory), 9 (no client-state
// library), and 10 (no tRPC / server actions / GraphQL). Plus the stack facts
// CLAUDE.md states as absolutes and the Releasing section's "no version constant
// in src/" rule.
//
// Why these are worth a test rather than trust: every one is a rule about
// something NOT being in the tree, and an absence is exactly what no other check
// can see. `npm run lint`, both typecheck passes and `next build` are all
// perfectly happy with a `zustand` import, a `"use server"` directive, a
// scaffolded `prisma/migrations/` directory, or a fourth copy of the version
// string. They are also the changes most likely to arrive by autocomplete or by
// pattern-matching from a differently-shaped project — CLAUDE.md exists largely
// because this tree does NOT look like the Next/Prisma defaults, and a rule that
// only lives in a markdown file is a rule that drifts.
//
// These are deliberately cheap and deliberately blunt: each failure names the
// guardrail and says what to do instead, so the fix is either "revert" or "have
// the discussion CLAUDE.md asks for and update the pin in the same commit".
//
// Not duplicated here: the TypeScript major-version split (tests/typescript-major-pin.test.mts),
// the feature/audit/backup registry drift pins (tests/features.test.mts,
// tests/backup-schema.test.mts, tests/audit-actions.test.mts), and the bare-fetch /
// bare-req.json() / encryptToken sweeps (tests/security-invariants.test.mts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO = new URL("..", import.meta.url).pathname;
const SRC = join(REPO, "src");
const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
  version: string;
  license: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts: Record<string, string>;
};
const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

function walkSrc(exts: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (p.includes("/generated/")) continue; // Prisma output (guardrail 12)
      if (statSync(p).isDirectory()) walk(p);
      else if (exts.some((e) => p.endsWith(e))) out.push(p);
    }
  };
  walk(SRC);
  return out;
}

const sourceFiles = walkSrc([".ts", ".tsx"]);

test("the source walk found a realistic file set — a broken walk must not pass vacuously", () => {
  assert.ok(sourceFiles.length > 400, `only ${sourceFiles.length} source files found under src/ — the walk is broken`);
});

// ── guardrail 3: schema-first Prisma ────────────────────────────────────────

test("guardrail 3: no prisma/migrations directory — schema changes go through `prisma db push`", () => {
  assert.equal(
    existsSync(join(REPO, "prisma", "migrations")),
    false,
    "prisma/migrations/ exists. This project is schema-first: changes are applied with `prisma db push` then " +
      "`prisma generate`, and docker-entrypoint.sh runs db push at boot. Scaffolding a migrations directory " +
      "splits the source of truth in two and the entrypoint will not run them.",
  );
});

test("guardrail 3: no `prisma migrate` in any npm script or the docker entrypoint", () => {
  const offenders = Object.entries(pkg.scripts).filter(([, cmd]) => /prisma\s+migrate/.test(cmd));
  assert.deepEqual(offenders.map(([k, v]) => `${k}: ${v}`), [], "an npm script scaffolds prisma migrate");

  const entrypoint = readFileSync(join(REPO, "docker-entrypoint.sh"), "utf8");
  assert.ok(!/prisma\s+migrate\s+(deploy|dev)/.test(entrypoint), "docker-entrypoint.sh runs prisma migrate");
  assert.ok(/db\s+push/.test(entrypoint), "docker-entrypoint.sh must still run `db push` — the pin is meaningless otherwise");
});

// ── guardrail 9: client state stays useState + searchParams ─────────────────

const STATE_LIBS = [
  "zustand", "jotai", "recoil", "valtio", "nanostores",
  "redux", "react-redux", "@reduxjs/toolkit",
  "@tanstack/react-query", "@tanstack/query-core", "swr", "react-query",
  "mobx", "mobx-react", "xstate", "@xstate/react",
];

test("guardrail 9: no client-state library is installed — useState + URL searchParams is the house style", () => {
  const present = STATE_LIBS.filter((n) => n in allDeps);
  assert.deepEqual(
    present,
    [],
    `client-state libraries in package.json: ${present.join(", ")}. Guardrail 9 keeps state management minimal — ` +
      "plain useState plus URL search params. Adding one to 'clean up' a component is exactly what the rule forbids.",
  );
});

test("guardrail 9: nothing in src/ imports a client-state library", () => {
  // A dependency can also arrive transitively and be imported without ever
  // landing in package.json, so check the import sites too.
  const pattern = new RegExp(`from\\s+["'](${STATE_LIBS.map((s) => s.replace(/[/@]/g, "\\$&")).join("|")})(/|["'])`);
  const offenders = sourceFiles.filter((f) => pattern.test(readFileSync(f, "utf8")));
  assert.deepEqual(offenders.map((f) => relative(REPO, f)), []);
});

// ── guardrail 10: REST + server components only ────────────────────────────

test("guardrail 10: no tRPC or GraphQL dependency", () => {
  const present = Object.keys(allDeps).filter((n) =>
    n.startsWith("@trpc/") || n === "graphql" || n.startsWith("@apollo/") || n === "urql" || n.startsWith("@urql/"),
  );
  assert.deepEqual(
    present,
    [],
    `tRPC/GraphQL packages in package.json: ${present.join(", ")}. Data fetching is REST routes + fetch on the ` +
      "client, or server components calling Prisma directly. CLAUDE.md asks for a discussion before this changes.",
  );
});

test('guardrail 10: no "use server" directive anywhere in src/ — there are no server actions', () => {
  const offenders = sourceFiles.filter((f) => /^\s*["']use server["']/m.test(readFileSync(f, "utf8")));
  assert.deepEqual(
    offenders.map((f) => relative(REPO, f)),
    [],
    'a "use server" directive introduces a server action. This app has none — mutations go through REST handlers ' +
      "under src/app/api, which is where the withAuth/withAdmin guards (guardrail 6a) and the body caps " +
      "(guardrail 30) live. A server action bypasses both.",
  );
});

// ── stack facts CLAUDE.md states as absolutes ──────────────────────────────

test("Next 16: routing middleware is proxy.ts, and no middleware.ts shadows it", () => {
  assert.ok(existsSync(join(SRC, "proxy.ts")), "src/proxy.ts is the request gate — it must exist");
  for (const candidate of ["middleware.ts", "middleware.tsx", "src/middleware.ts"]) {
    assert.equal(
      existsSync(join(REPO, candidate)) || existsSync(join(SRC, candidate)),
      false,
      `${candidate} exists. Next 16 renamed middleware to proxy; two files means the CSRF check, the session ` +
        "validation and the admin backstop silently stop being the only gate.",
    );
  }
});

test("Tailwind v4: no tailwind.config file — the theme lives in globals.css @theme inline", () => {
  for (const ext of ["js", "cjs", "mjs", "ts"]) {
    assert.equal(
      existsSync(join(REPO, `tailwind.config.${ext}`)),
      false,
      `tailwind.config.${ext} exists. Tailwind v4 config is inline in src/app/globals.css under @theme inline; ` +
        "a config file re-splits the theme.",
    );
  }
  const globals = readFileSync(join(SRC, "app", "globals.css"), "utf8");
  assert.ok(globals.includes("@theme inline"), "globals.css must still carry the @theme inline block");
});

test("auth is the in-repo session JWT — next-auth is not a dependency", () => {
  assert.ok(!("next-auth" in allDeps), "the project migrated off NextAuth; there is no next-auth dependency");
  assert.equal(existsSync(join(REPO, "auth.config.ts")), false, "auth.config.ts is a NextAuth artifact");
  assert.ok(existsSync(join(SRC, "lib", "session-jwt.ts")), "src/lib/session-jwt.ts is the session lifecycle");
});

test("cva and tw-merge stay the in-repo reimplementations, not npm packages", () => {
  for (const p of ["class-variance-authority", "tailwind-merge"]) {
    assert.ok(
      !(p in allDeps),
      `${p} is installed. src/lib/cva.ts and src/lib/tw-merge.ts are hand-written equivalents (tests/cva.test.mts, ` +
        "tests/tw-merge.test.mts pin them); installing the package leaves two implementations in the tree.",
    );
  }
  assert.ok(existsSync(join(SRC, "lib", "cva.ts")) && existsSync(join(SRC, "lib", "tw-merge.ts")));
});

test("the unit suite stays on node:test — no vitest/jest runner creeps in", () => {
  for (const p of ["vitest", "jest", "@jest/globals", "mocha", "ava"]) {
    assert.ok(!(p in allDeps), `${p} is installed — the suite runs on Node's built-in runner (npm test)`);
  }
  assert.ok(pkg.scripts.test.includes("--test"), "npm test must still drive node:test");
});

// ── Releasing: exactly one source of truth for the version ─────────────────

test("no marketing-version constant in src/ — package.json plus the git tag is the source of truth", () => {
  // The Releasing section forbids a third copy: "There is no version constant in
  // src/. Don't add one — a third copy is a third place to forget." The
  // deliberate exception is API_VERSION in src/lib/api-version.ts, which is a
  // capability-negotiation integer and NOT the marketing version (guardrail 25).
  const version = pkg.version;
  assert.match(version, /^\d+\.\d+\.\d+$/, "package.json version is bare semver");

  const offenders = sourceFiles.filter((f) => {
    const text = readFileSync(f, "utf8");
    // A string literal holding the exact current version — the drift-prone shape.
    return new RegExp(`["'\`]v?${version.replace(/\./g, "\\.")}["'\`]`).test(text);
  });
  assert.deepEqual(
    offenders.map((f) => relative(REPO, f)),
    [],
    `the version string "${version}" is hardcoded in src/. Releasing already duplicates it across package.json, ` +
      "package-lock.json (two entries), README.md and docker-container/README.md; a copy in src/ is a fifth place " +
      "to forget. Read it from package.json or drop it.",
  );
});

test("API_VERSION stays an integer protocol constant, decoupled from package.json (guardrail 25)", () => {
  const src = readFileSync(join(SRC, "lib", "api-version.ts"), "utf8");
  const match = /export const API_VERSION\s*=\s*(\d+)/.exec(src);
  assert.ok(match, "API_VERSION must be a literal integer — never derived from the marketing version");
  assert.ok(Number.isInteger(Number(match[1])), "API_VERSION is an integer");
  // Comment-stripped: the file's own header states this rule in prose, and the
  // pin is about the CODE never reaching for the marketing version.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[^\n]*?\/\/[^\n]*$/gm, "");
  assert.ok(
    !/require\(\s*["'][^"']*package\.json|from\s+["'][^"']*package\.json|npm_package_version/.test(code),
    "api-version.ts must not read package.json — the contract version bumps only on a breaking wire change, " +
      "never on a release. Guardrail 25 makes it the deliberate exception to 'no version constant in src/'.",
  );
  assert.ok(
    /export const MIN_API_VERSION\s*=\s*\d+/.test(code),
    "MIN_API_VERSION is a hard floor, so the accepted range stays [floor, ∞) — it must stay a literal too",
  );
});

// ── licensing ──────────────────────────────────────────────────────────────

test("the AGPL licence and the third-party notices both still ship", () => {
  // Guardrail 18: the Docker runner COPYs both; a rename here silently ships an
  // image with no attribution, which is a licence violation rather than a lint nit.
  assert.equal(pkg.license, "AGPL-3.0-only");
  for (const f of ["LICENSE", "THIRD_PARTY_LICENSES.txt"]) {
    assert.ok(existsSync(join(REPO, f)), `${f} is missing — the Dockerfile COPYs it into the runner image`);
  }
  const dockerfile = readFileSync(join(REPO, "Dockerfile"), "utf8");
  assert.ok(dockerfile.includes("THIRD_PARTY_LICENSES.txt"), "the Dockerfile must still copy the notices file");
  assert.ok(dockerfile.includes("LICENSE"), "the Dockerfile must still copy LICENSE");
});
