// Unit tests for the parsing/matching logic in scripts/audit-routes.mts — the
// CI gate (`npm run audit:routes`, blocking in ci.yml) that fails the build when
// an API route ships with no recognized auth guard.
//
// Why these exist: the gate had zero unit coverage, and a gate that fails OPEN
// is worse than no gate, because it reads as a passing check. Two fail-open
// paths are pinned here:
//   1. A file mixing one parsed handler with one method exported in a style the
//      parser cannot model. The existing zero-handler check never fires (the
//      count is 1, not 0), so that method shipped unaudited.
//   2. Guard detection is a substring test over a declaration region, so a token
//      merely named in a comment satisfied it — and because a region runs to the
//      next column-0 declaration, a comment documenting the NEXT handler is
//      attributed to the PREVIOUS one.
//
// Fixtures use handler forms that actually occur in this codebase (verified
// across all 157 route files): direct wrapper calls, curried withPermission,
// bare functions with inline isCronAuthorized, local-helper indirection, and the
// two-statement shared alias in cron/trash-diagnostic. Brace re-exports do NOT
// occur today — they are the synthetic case the parser must still refuse to
// pass silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  findUnmodeledMethodExports,
  isAllowlisted,
  parseTopLevelDecls,
  reachesToken,
  stripComments,
} from "../scripts/audit-routes.mts";

const SCRIPT = fileURLToPath(new URL("../scripts/audit-routes.mts", import.meta.url));

/**
 * Run the real CLI against a throwaway route tree.
 *
 * The unit tests below cover the helpers; this covers main(), which is where
 * they are composed. Without it, deleting the stripComments() or
 * findUnmodeledMethodExports() call from main() would reopen a fail-open hole
 * while every helper test stayed green.
 */
function auditFixture(routes: Record<string, string>): { status: number | null; output: string } {
  const root = mkdtempSync(join(tmpdir(), "summonarr-audit-routes-"));
  try {
    for (const [route, source] of Object.entries(routes)) {
      const dir = join(root, "src", "app", "api", route);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "route.ts"), source);
    }
    const res = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: "utf8" });
    return { status: res.status, output: `${res.stdout ?? ""}${res.stderr ?? ""}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Mirrors how main() indexes declarations before calling reachesToken. */
function index(src: string) {
  const decls = parseTopLevelDecls(stripComments(src));
  const byName = new Map<string, ReturnType<typeof parseTopLevelDecls>>();
  for (const d of decls) {
    const list = byName.get(d.name);
    if (list) list.push(d);
    else byName.set(d.name, [d]);
  }
  return { decls, byName };
}

function handler(src: string, name: string) {
  const { decls, byName } = index(src);
  const found = decls.find((d) => d.exported && d.name === name);
  assert.ok(found, `expected an exported ${name} declaration in the fixture`);
  return { decl: found, byName };
}

const ANY_AUTH = ["withAuth", "withAdmin", "withIssueAdmin", "requireAuth", "isCronAuthorized", "withPermission"];

// ── Fail-open 1: methods exported in an unmodeled style ─────────────────────

test("PIN: a method re-exported alongside a parsed handler is reported, not silently skipped", () => {
  // handlers.length is 1 here, never 0, so the zero-handler check cannot catch
  // it — POST would ship completely unaudited.
  const src = [
    'export const GET = withAdmin(async (req, ctx, session) => {',
    '  return NextResponse.json({});',
    '});',
    'export { POST } from "./post-impl";',
  ].join("\n");
  assert.deepEqual(findUnmodeledMethodExports(src), ["POST"]);
});

test("findUnmodeledMethodExports resolves the exported name in an `as` clause", () => {
  assert.deepEqual(findUnmodeledMethodExports('export { handler as POST } from "./impl";'), ["POST"]);
  // The LOCAL name is irrelevant — only what the module exports matters.
  assert.deepEqual(findUnmodeledMethodExports('export { GET as internalOnly };'), []);
});

test("findUnmodeledMethodExports flags a star re-export, whose methods are unknowable", () => {
  assert.deepEqual(findUnmodeledMethodExports('export * from "./impl";'), ["*"]);
});

test("findUnmodeledMethodExports reports nothing for the ordinary wrapper form", () => {
  const src = 'export const GET = withAuth(async (req, ctx, session) => {\n  return NextResponse.json({});\n});\n';
  assert.deepEqual(findUnmodeledMethodExports(src), []);
});

test("a commented-out re-export inside a block comment is not flagged", () => {
  // A `//` line could never match the ^export anchor anyway; a block comment
  // leaves the inner line starting at column 0, so only stripping saves it from
  // being read as a live re-export and failing the route spuriously.
  const src = ['/*', 'export { POST } from "./old-impl";', '*/', "export const GET = withAuth(async () => {});"].join("\n");
  assert.deepEqual(findUnmodeledMethodExports(src), ["POST"], "raw source looks like a live re-export");
  assert.deepEqual(findUnmodeledMethodExports(stripComments(src)), [], "stripping resolves it");
});

// ── Regex literals: the scanner must not mistake one for a string ───────────

test("PIN: a regex literal containing a quote does not swallow the comment after it", () => {
  // Without regex-literal tracking the `'` opens a phantom string that runs to
  // the next quote in the file, so the comment below survives and its prose
  // mention of a guard token reads as a guard.
  const src = [
    "export async function POST(req: NextRequest) {",
    "  const re = /['\"]/g;",
    "  // TODO: wrap this in withAdmin before shipping",
    "  return handle(req, re);",
    "}",
  ].join("\n");
  const stripped = stripComments(src);
  assert.doesNotMatch(stripped, /TODO/, "comment must be stripped");
  assert.match(stripped, /const re = /, "the regex line itself must survive");
  const { decl, byName } = handler(src, "POST");
  assert.equal(reachesToken(decl, ANY_AUTH, byName), false);
});

test("PIN: a comment on the SAME line as a quote-bearing regex is still stripped", () => {
  // Isolates the regex-literal branch. An unterminated quote bails at the
  // newline, so a desync only ever damages its own line — which is exactly the
  // line this comment is on.
  const src = "const re = /['\"]/g; // wrap in withAdmin(req)\n";
  assert.doesNotMatch(stripComments(src), /wrap in withAdmin/);
});

test("a regex literal is distinguished from division", () => {
  assert.match(stripComments("const half = total / count; // note"), /total \/ count;/);
  assert.doesNotMatch(stripComments("const half = total / count; // note"), /note/);
  // A `/` inside a character class does not close the literal.
  assert.match(stripComments('const re = /[/]/g; // note'), /\[\/\]/);
});

test("an escaped quote in a string does not desynchronise the scanner", () => {
  const src = 'const msg = "she said \\"hi\\""; // note\nconst withAdmin = 1;\n';
  const out = stripComments(src);
  assert.doesNotMatch(out, /note/);
  assert.match(out, /const withAdmin = 1;/);
});

// ── Fail-open 2: guard tokens named in comments ─────────────────────────────

test("PIN: a guard named only in a comment does not satisfy the audit", () => {
  const src = [
    'export async function POST(req: NextRequest) {',
    '  // TODO: wrap this in withAdmin before shipping',
    '  return NextResponse.json({ ok: true });',
    '}',
  ].join("\n");
  const { decl, byName } = handler(src, "POST");
  assert.equal(reachesToken(decl, ANY_AUTH, byName), false);
});

test("PIN: a comment documenting the next handler does not arm the handler declared above it", () => {
  // A region runs to the next column-0 declaration, so this comment lands
  // inside GET's region even though it describes POST.
  const src = [
    'export async function GET(req: NextRequest) {',
    '  return NextResponse.json({});',
    '}',
    '',
    '// Guarded by withAdmin at the layer above.',
    'export async function POST(req: NextRequest) {',
    '  return NextResponse.json({});',
    '}',
  ].join("\n");
  const { decl: get, byName } = handler(src, "GET");
  assert.equal(reachesToken(get, ANY_AUTH, byName), false);
  const { decl: post } = handler(src, "POST");
  assert.equal(reachesToken(post, ANY_AUTH, byName), false);
});

test("stripComments preserves `//` inside string literals", () => {
  const src = 'const url = "https://example.com/x"; // trailing note\nconst withAdmin = 1;\n';
  const out = stripComments(src);
  assert.match(out, /https:\/\/example\.com\/x/);
  assert.doesNotMatch(out, /trailing note/);
});

test("stripComments keeps line structure so column-0 anchoring still works", () => {
  const src = '/*\n * banner\n */\nexport const GET = withAuth(async () => {});\n';
  const decls = parseTopLevelDecls(stripComments(src));
  assert.equal(decls.length, 1);
  assert.equal(decls[0].name, "GET");
  assert.equal(decls[0].exported, true);
});

// ── Recognized handler forms (all observed in this codebase) ────────────────

test("parseTopLevelDecls recognizes the wrapper, bare-function and non-async export forms", () => {
  const src = [
    'export const GET = withAuth(async (req, ctx, session) => {',
    '  return NextResponse.json({});',
    '});',
    'export async function POST(request: NextRequest) {',
    '  return NextResponse.json({});',
    '}',
    'export function DELETE() {',
    '  return NextResponse.json({});',
    '}',
  ].join("\n");
  const names = parseTopLevelDecls(src)
    .filter((d) => d.exported)
    .map((d) => d.name);
  assert.deepEqual(names, ["GET", "POST", "DELETE"]);
});

test("a curried withPermission wrapper is recognized as guarded", () => {
  const src = [
    'export const POST = withPermission(Permission.MANAGE_USERS)(async (req, ctx, session) => {',
    '  return NextResponse.json({});',
    '});',
  ].join("\n");
  const { decl, byName } = handler(src, "POST");
  assert.equal(reachesToken(decl, [...ANY_AUTH], byName), true);
});

test("a guard reached through a local helper is recognized", () => {
  const src = [
    'async function getAuthContext(request: NextRequest) {',
    '  if (!(await isCronAuthorized(request))) return null;',
    '  return { trigger: "cron" };',
    '}',
    'export async function POST(request: NextRequest) {',
    '  const ctx = await getAuthContext(request);',
    '  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });',
    '  return NextResponse.json({});',
    '}',
  ].join("\n");
  const { decl, byName } = handler(src, "POST");
  assert.equal(reachesToken(decl, ["isCronAuthorized"], byName), true);
});

test("the two-statement shared alias form resolves to the aliased handler's guard", () => {
  // The real shape in cron/trash-diagnostic: `export const GET = handle;`
  const src = [
    'async function handle(request: NextRequest) {',
    '  if (!(await isCronAuthorized(request))) return NextResponse.json({}, { status: 401 });',
    '  return NextResponse.json({});',
    '}',
    'export const GET = handle;',
    'export const POST = handle;',
  ].join("\n");
  for (const method of ["GET", "POST"]) {
    const { decl, byName } = handler(src, method);
    assert.equal(reachesToken(decl, ["isCronAuthorized"], byName), true, `${method} should reach the guard`);
  }
});

test("PIN: an unguarded handler cannot borrow a sibling HTTP method's guard", () => {
  const src = [
    'export const GET = withAdmin(async (req, ctx, session) => {',
    '  return NextResponse.json({});',
    '});',
    'export async function POST(request: NextRequest) {',
    '  return GET(request);',
    '}',
  ].join("\n");
  const { decl, byName } = handler(src, "POST");
  assert.equal(reachesToken(decl, ANY_AUTH, byName), false);
});

// ── End to end: the CLI itself, not just its helpers ───────────────────────

test("a properly guarded route passes the real CLI", () => {
  // Positive control. Without it, the failure assertions below would also pass
  // if the script simply crashed for an unrelated reason.
  const { status, output } = auditFixture({
    widgets: "export const GET = withAuth(async (req, ctx, session) => {\n  return NextResponse.json({});\n});\n",
  });
  assert.equal(status, 0, output);
  assert.match(output, /carries an auth guard/);
});

test("PIN: the real CLI fails a route whose extra method is exported in an unmodeled style", () => {
  const { status, output } = auditFixture({
    widgets: [
      "export const GET = withAdmin(async (req, ctx, session) => {",
      "  return NextResponse.json({});",
      "});",
      'export { POST } from "./post-impl";',
    ].join("\n"),
  });
  assert.equal(status, 1, output);
  assert.match(output, /cannot audit/);
  assert.match(output, /POST/);
});

test("PIN: the real CLI fails a handler whose only guard is a comment", () => {
  const { status, output } = auditFixture({
    "admin/gadgets": [
      "export async function POST(request: NextRequest) {",
      "  // TODO: wrap this in withAdmin before shipping",
      "  return NextResponse.json({ ok: true });",
      "}",
    ].join("\n"),
  });
  assert.equal(status, 1, output);
  assert.match(output, /missing an ADMIN-capable guard/);
});

test("PIN: the real CLI strips a comment that spells out a guard CALL", () => {
  // Isolates comment stripping in main(). Call-shape matching alone cannot save
  // this one — the comment contains `withAdmin(`, so only removing the comment
  // keeps the handler failing.
  const { status, output } = auditFixture({
    "admin/gadgets": [
      "export async function POST(request: NextRequest) {",
      "  // was: withAdmin(async (req, ctx, session) => handle(req))",
      "  return NextResponse.json({ ok: true });",
      "}",
    ].join("\n"),
  });
  assert.equal(status, 1, output);
  assert.match(output, /missing an ADMIN-capable guard/);
});

test("PIN: the real CLI does not accept a guard named inside a string literal", () => {
  // Isolates call-shape matching. Stripping keeps string contents by design, so
  // only requiring the call shape keeps this handler failing.
  const { status, output } = auditFixture({
    "admin/gadgets": [
      "export async function POST(request: NextRequest) {",
      '  const hint = "this endpoint needs withAdmin";',
      "  return NextResponse.json({ hint });",
      "}",
    ].join("\n"),
  });
  assert.equal(status, 1, output);
  assert.match(output, /missing an ADMIN-capable guard/);
});

test("PIN: the real CLI still distinguishes ADMIN guards from any-auth guards", () => {
  // An /api/admin route guarded only by withAuth must fail: the ADMIN-vs-any
  // distinction is the most consequential check in the script.
  const { status, output } = auditFixture({
    "admin/gadgets": "export const GET = withAuth(async (req, ctx, session) => {\n  return NextResponse.json({});\n});\n",
  });
  assert.equal(status, 1, output);
  assert.match(output, /missing an ADMIN-capable guard/);
});

// ── Allowlist boundary ──────────────────────────────────────────────────────

test("isAllowlisted stops at a path separator", () => {
  // `startsWith("health")` once also matched a sibling like health-internal/…,
  // silently exempting a brand new route from the gate.
  assert.equal(isAllowlisted("health"), true);
  assert.equal(isAllowlisted("health-internal/secrets"), false);
  assert.equal(isAllowlisted("auth/sign-in/credentials"), true);
  assert.equal(isAllowlisted("authorization/admin"), false);
});
