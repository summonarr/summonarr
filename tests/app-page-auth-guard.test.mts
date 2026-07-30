// Structural drift pin for guardrail 29 — "page/layout authorization is
// DB-checked, NEVER the proxy alone and NEVER JWT-only auth()".
//
// Why a SOURCE-level test rather than a behavioural one: the thing that breaks
// this invariant is *adding a new page*, and nothing else can catch that. The
// types compile fine, eslint is happy, and the page renders correctly for a
// logged-in developer — the hole only shows up for an unauthenticated attacker.
// A second audit of this codebase found exactly that bug and it was real: Next
// 16 skips a LAYOUT's render when the client supplies a matching
// Next-Router-State-Tree, and proxy.ts's matcher separately skips any request
// carrying `purpose: prefetch`, so composing the two let an UNAUTHENTICATED
//
//   GET /votes -H 'RSC: 1' -H 'purpose: prefetch' -H 'Next-Router-State-Tree: …'
//
// skip the proxy AND the (app) layout gate and full-render the page. The fix was
// a guard on every page; this test is what keeps it that way. See
// src/lib/require-app-session.ts for the full derivation.
//
// Two rules are pinned:
//   1. Every (app) page.tsx and layout.tsx performs a DB-CHECKED session read.
//   2. No (app) page/layout imports the JWT-only `auth` — it verifies signature
//      and expiry ONLY, so it cannot see a revoked AuthSession, a
//      sessionsRevokedAt/passwordChangedAt cutoff, or a role demotion. On the
//      prefetch path (proxy skipped) it would be the sole check, so a demoted-
//      but-unexpired admin token would still read admin pages.
//
// No DB, no network, no module graph — this reads the source files directly, the
// same idiom as tests/backup-schema.test.mts's schema-vs-manifest drift pin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const APP_DIR = join(process.cwd(), "src", "app", "(app)");

// The DB-checked session readers. Each ultimately runs verifyAndRefreshSession
// against the AuthSession row (revocation, cutoffs, role refresh, UA
// fingerprint) rather than trusting the JWT alone:
//   requireAppSession           — authActive() + redirect("/login")
//   authActive                  — the drop-in DB-checked auth()
//   readActiveSummonarrSession  — the admin-layout variant
//   loadTrashPageContext        — the trash-guides pages' shared loader, which
//                                 performs the admin session read internally
const DB_CHECKED = [
  "requireAppSession",
  "authActive",
  "readActiveSummonarrSession",
  "loadTrashPageContext",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name === "page.tsx" || entry.name === "layout.tsx") out.push(full);
  }
  return out;
}

const guardedFiles = walk(APP_DIR);
const rel = (f: string) => relative(process.cwd(), f);

// Pull the named specifiers out of every `import { … } from "@/lib/auth"` in a
// file, so `auth` can be distinguished from `authActive` (a substring match on
// "auth" would find both, and every page imports the latter).
function authImportSpecifiers(src: string): string[] {
  const names: string[] = [];
  const re = /import\s*\{([^}]*)\}\s*from\s*["']@\/lib\/auth["']/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name) names.push(name);
    }
  }
  return names;
}

test("the (app) file set is non-empty and contains the known pages — a broken walk must not pass vacuously", () => {
  assert.ok(
    guardedFiles.length >= 40,
    `expected the (app) subtree to yield 40+ page/layout files, got ${guardedFiles.length} — the walk or the path is wrong`,
  );
  const names = guardedFiles.map(rel);
  for (const expected of [
    "src/app/(app)/layout.tsx",
    "src/app/(app)/votes/page.tsx", // the page named in the original exploit
    "src/app/(app)/admin/layout.tsx",
  ]) {
    assert.ok(names.includes(expected), `${expected} must be part of the audited set`);
  }
});

test("guardrail 29: EVERY (app) page and layout performs a DB-checked session read", () => {
  const unguarded: string[] = [];
  for (const file of guardedFiles) {
    const src = readFileSync(file, "utf-8");
    if (!DB_CHECKED.some((fn) => src.includes(fn))) unguarded.push(rel(file));
  }
  assert.deepEqual(
    unguarded,
    [],
    `these (app) files have no DB-checked session read — an unauthenticated RSC prefetch ` +
      `skips both proxy.ts and the (app) layout, so a page without its OWN guard renders ` +
      `for anyone. Add requireAppSession() (see src/lib/require-app-session.ts).`,
  );
});

test("guardrail 29: no (app) page or layout imports the JWT-only `auth` for its gate", () => {
  const offenders: string[] = [];
  for (const file of guardedFiles) {
    const specifiers = authImportSpecifiers(readFileSync(file, "utf-8"));
    if (specifiers.includes("auth")) offenders.push(rel(file));
  }
  assert.deepEqual(
    offenders,
    [],
    `auth() verifies only the JWT signature + expiry: it cannot see a revoked AuthSession, ` +
      `a sessionsRevokedAt/passwordChangedAt cutoff, or a role demotion. Use authActive() ` +
      `(drop-in, identical SummonarrSession shape) or requireAppSession().`,
  );
});

test("the (app) root layout's login gate is not swallowed by its try/catch", () => {
  // redirect() works by THROWING NEXT_REDIRECT. The layout wraps its body in a
  // try/catch for render errors, so the gate has to sit before/outside it —
  // otherwise the catch eats the redirect and the subtree renders anyway.
  const file = readFileSync(join(APP_DIR, "layout.tsx"), "utf-8");
  // Scope to the LAYOUT COMPONENT body. generateMetadata above it has its own
  // unrelated try/catch around a siteTitle read; comparing against that one
  // would measure the wrong thing.
  const bodyAt = file.search(/export default async function AppLayout\b/);
  assert.ok(bodyAt > 0, "expected an `export default async function AppLayout` component");
  const body = file.slice(bodyAt);

  const gateAt = body.search(/redirect\(\s*["']\/login["']\s*\)/);
  assert.ok(gateAt > 0, "the (app) layout must still redirect unauthenticated visitors to /login");
  const tryAt = body.indexOf("try {");
  if (tryAt !== -1) {
    assert.ok(
      gateAt < tryAt,
      "the /login redirect must precede the layout's try/catch — a catch around it swallows " +
        "the NEXT_REDIRECT throw and renders the subtree for an unauthenticated visitor",
    );
  }
});
