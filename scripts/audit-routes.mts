#!/usr/bin/env node
/**
 * API route authorization auditor.
 *
 * Static (grep-style) check that every API route handler carries an auth
 * guard. It does NOT validate the guard is logically correct — `tsc` and the
 * `withAdmin`/`withAuth` wrappers (CLAUDE.md guardrail 6a) cover that. This
 * catches the dangerous, common mistake: a route shipped with NO guard at all,
 * or an `/api/admin/*` route guarded only as any-authenticated-user.
 *
 * Detection is PER HTTP-METHOD EXPORT, not per file: a file whose GET is
 * `withAuth(...)` but whose POST is a bare `export async function POST` fails
 * on the POST. Each exported handler's own region (its wrapped expression or
 * function body, plus any same-file helpers it references — e.g. a local
 * `getAuthContext` that calls `isCronAuthorized`, or a shared `handle` alias)
 * must reach a recognized guard token.
 *
 * Exit code is non-zero when any route fails, so this is wired into CI.
 *
 * Usage:
 *   node scripts/audit-routes.mts          # human report, fails build on any miss
 *   node scripts/audit-routes.mts --json   # machine-readable
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const COLORS = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

function color(text: string, c: string): string {
  if (!process.stdout.isTTY) return text;
  return `${c}${text}${COLORS.reset}`;
}

const API_ROOT = join(process.cwd(), "src", "app", "api");

/**
 * Route prefixes that are intentionally public or carry their own audited auth
 * mechanism that this grep does not model. Each entry needs a reason — adding
 * to this list is a security decision, not a convenience.
 */
const ALLOWLIST: Array<{ prefix: string; reason: string }> = [
  { prefix: "auth/", reason: "login/register/setup-status/plex-pin — public or first-run gated" },
  { prefix: "setup/", reason: "first-run import — gated on userCount===0 / advisory lock" },
  { prefix: "discord/", reason: "Discord-signed or requireAuth per-route; mixed, hand-audited" },
  { prefix: "interactions", reason: "Discord Ed25519 signature verification" },
  { prefix: "health", reason: "public liveness probe" },
];

/**
 * Exact routes that legitimately do NOT match the grep but are hand-audited
 * SECURE. Unlike ALLOWLIST (whole public subtrees), these are individual
 * inline-auth or intentionally-public endpoints. guardrail 6a exempts
 * plain-text/binary responses (SSE, thumbnails) from the wrapper. Each entry
 * needs a reason — adding here is a security decision.
 */
const ROUTE_EXCEPTIONS: Array<{ route: string; reason: string }> = [
  // fix-match/thumb and /api/events both call requireAuth inline, so the token
  // grep already passes them — they need no exception entry.
  {
    route: "/api/config/compat",
    reason: "intentionally public, coarse API-version descriptor (no secrets/DB) — native clients gate BEFORE sign-in; pre-auth via isPublicPath in proxy.ts",
  },
  {
    route: "/api/profile/notification-email/confirm",
    reason: "public email-verification landing (clicked from email, possibly logged-out); the one-time hashed token in the query IS the credential — pre-auth via isPublicPath in proxy.ts",
  },
];

/**
 * /api/admin/* routes whose handlers are deliberately guarded by
 * `withPermission(...)` (a delegated capability bit) instead of a role
 * wrapper. The proxy backstop still 403s any role with no admin access at all
 * hitting /api/admin/*, and the capability bit gates the specific action, so
 * these are hand-audited SECURE without an ADMIN_TOKENS match. (The old
 * file-level grep passed them only by accident — comment mentions of
 * "withAdmin".) Every handler in the file must still be wrapped per-export.
 * Adding here is a security decision.
 */
const PERMISSION_GUARDED_ADMIN_ROUTES: Array<{ route: string; reason: string }> = [
  { route: "/api/admin/users", reason: "user management delegated via withPermission(Permission.MANAGE_USERS)" },
  { route: "/api/admin/users/[id]", reason: "user management delegated via withPermission(Permission.MANAGE_USERS)" },
];

/** Tokens that prove an ADMIN-capable guard is present. */
const ADMIN_TOKENS = ["withAdmin", "withIssueAdmin", "requireAuth", "isCronAuthorized"];
/** Tokens that prove SOME auth guard is present (superset of ADMIN_TOKENS). */
// `withPermission` wraps withAuth and gates on a capability bit — it proves
// authentication but not a specific role, so it stays out of ADMIN_TOKENS
// (/api/admin/* routes still need a role wrapper or the proxy backstop).
//
// `timingSafeEqual` is deliberately NOT here: it's the webhook-token compare and
// is already required in the `isWebhook` branch below. Accepting it as a generic
// guard would let a future non-webhook route that imports it for an unrelated
// string compare pass with no session guard at all.
const ANY_AUTH_TOKENS = [...ADMIN_TOKENS, "withAuth", "withPermission"];

/** The handler names Next.js recognizes as HTTP method exports on a route file. */
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

interface Finding {
  route: string;
  file: string;
  reason: string;
}

interface TopLevelDecl {
  name: string;
  exported: boolean;
  /** Region text: from this declaration's start up to the next top-level declaration. */
  text: string;
}

/**
 * Split a route file into top-level declaration regions. Anchors on column-0
 * declaration keywords — the codebase is Prettier-formatted, so nested
 * declarations are always indented and never create false boundaries. Each
 * region runs to the next column-0 declaration (or EOF), so an export's region
 * contains its own handler body and, for `export const X = wrapper(handler)`,
 * the entire wrapped expression — including compositions like
 * `withCronRunRecording("x", withAdmin(...))` whose guard sits deeper in.
 */
function parseTopLevelDecls(src: string): TopLevelDecl[] {
  const declRe =
    /^(export\s+)?(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)|(?:class|interface|type|enum)\s+([A-Za-z_$][\w$]*))/gm;
  const marks: Array<{ index: number; name: string; exported: boolean }> = [];
  for (let m = declRe.exec(src); m !== null; m = declRe.exec(src)) {
    marks.push({ index: m.index, name: m[2] ?? m[3] ?? m[4], exported: m[1] !== undefined });
  }
  return marks.map((mark, i) => ({
    name: mark.name,
    exported: mark.exported,
    text: src.slice(mark.index, i + 1 < marks.length ? marks[i + 1].index : src.length),
  }));
}

/**
 * True when `decl`'s own region contains one of `tokens`, or transitively
 * references another top-level declaration in the same file whose region does.
 * The transitive hop covers the two legitimate indirection patterns in this
 * codebase: a local helper that performs the check (`getAuthContext` →
 * `isCronAuthorized` in the cron warm routes) and a shared handler alias
 * (`export const GET = handle` in cron/trash-diagnostic). Cross-FILE
 * indirection is intentionally not followed — a guard hidden in an import is
 * exactly the opacity this audit exists to reject.
 */
function reachesToken(
  decl: TopLevelDecl,
  tokens: string[],
  byName: Map<string, TopLevelDecl[]>,
  visited: Set<string> = new Set([decl.name]),
): boolean {
  if (tokens.some((t) => decl.text.includes(t))) return true;
  for (const [name, candidates] of byName) {
    if (visited.has(name)) continue;
    // Never satisfy a handler's guard by hopping into a SIBLING HTTP-method
    // handler's region: an unguarded `export async function POST` that merely
    // references (or even mentions) a guarded `GET` must still fail the audit.
    // Shared logic must live in a non-handler helper, which this hop still follows.
    if (HTTP_METHODS.has(name)) continue;
    // Escape backslash AND $ before building the RegExp (js/incomplete-sanitization).
    // Route decl names only ever contain [\w$], but escape defensively regardless.
    const ref = new RegExp(`\\b${name.replace(/[\\$]/g, "\\$&")}\\b`);
    if (!ref.test(decl.text)) continue;
    visited.add(name);
    for (const candidate of candidates) {
      if (reachesToken(candidate, tokens, byName, visited)) return true;
    }
  }
  return false;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry === "route.ts" || entry === "route.tsx") out.push(full);
  }
}

function routePath(file: string): string {
  const rel = relative(API_ROOT, file).split(sep).slice(0, -1).join("/");
  return `/api/${rel}`;
}

function isAllowlisted(rel: string): boolean {
  return ALLOWLIST.some((a) => rel === a.prefix || rel.startsWith(a.prefix));
}

function main(): void {
  const json = process.argv.includes("--json");
  const files: string[] = [];
  walk(API_ROOT, files);
  files.sort();

  const failures: Finding[] = [];
  let audited = 0;

  for (const file of files) {
    const route = routePath(file);
    const rel = route.replace(/^\/api\//, "");

    // NextAuth catch-all handler — exported handlers come from the library.
    if (rel.startsWith("auth/") && file.includes("[...nextauth]")) continue;
    if (isAllowlisted(rel)) continue;
    if (ROUTE_EXCEPTIONS.some((e) => e.route === route)) continue;

    audited++;
    const src = readFileSync(file, "utf8");

    const decls = parseTopLevelDecls(src);
    const byName = new Map<string, TopLevelDecl[]>();
    for (const d of decls) {
      const list = byName.get(d.name);
      if (list) list.push(d);
      else byName.set(d.name, [d]);
    }
    const handlers = decls.filter((d) => d.exported && HTTP_METHODS.has(d.name));

    // Zero recognized handlers means an export style the parser doesn't model
    // (e.g. `export { GET } from "..."`) — fail loudly rather than pass unaudited.
    if (handlers.length === 0) {
      failures.push({
        route,
        file,
        reason: "no exported HTTP method handlers recognized — unsupported export style, extend the parser or hand-audit",
      });
      continue;
    }

    const isCronSync =
      rel.startsWith("cron/") || rel === "sync" || rel.startsWith("sync/");
    const isWebhook = rel.startsWith("webhooks/");
    const isAdmin = rel.startsWith("admin/");

    for (const handler of handlers) {
      if (isCronSync) {
        if (!reachesToken(handler, ["isCronAuthorized"], byName)) {
          failures.push({ route, file, reason: `${handler.name}: cron/sync handler missing isCronAuthorized` });
        }
      } else if (isWebhook) {
        if (!reachesToken(handler, ["timingSafeEqual"], byName)) {
          failures.push({ route, file, reason: `${handler.name}: webhook handler missing timingSafeEqual secret compare` });
        }
      } else if (isAdmin) {
        const permissionGuarded = PERMISSION_GUARDED_ADMIN_ROUTES.some((e) => e.route === route);
        const adminTokens = permissionGuarded ? [...ADMIN_TOKENS, "withPermission"] : ADMIN_TOKENS;
        if (!reachesToken(handler, adminTokens, byName)) {
          failures.push({
            route,
            file,
            reason: `${handler.name}: admin handler missing an ADMIN-capable guard (withAdmin/withIssueAdmin/requireAuth)`,
          });
        }
      } else if (!reachesToken(handler, ANY_AUTH_TOKENS, byName)) {
        // Any other route: each handler must carry some recognized auth guard.
        failures.push({ route, file, reason: `${handler.name}: handler has no recognized auth guard` });
      }
    }
  }

  if (json) {
    console.log(JSON.stringify({ audited, failures }, null, 2));
    process.exit(failures.length > 0 ? 1 : 0);
  }

  console.log(color("\n  API Route Authorization Audit", COLORS.bold + COLORS.cyan));
  console.log(color("  ─────────────────────────────", COLORS.dim));
  console.log(
    `\n  ${color(String(audited), COLORS.bold)} routes audited` +
      ` ${color(`(${ALLOWLIST.length} prefixes allowlisted as public/self-auth)`, COLORS.dim)}\n`,
  );

  if (failures.length === 0) {
    console.log(color("  ✓ Every audited route handler carries an auth guard.\n", COLORS.green));
    process.exit(0);
  }

  console.log(color(`  ✗ ${failures.length} handler(s) missing an auth guard:\n`, COLORS.red + COLORS.bold));
  for (const f of failures) {
    console.log(`  ${color("[FAIL]", COLORS.red)} ${color(f.route, COLORS.bold)}`);
    console.log(color(`         ${f.reason}`, COLORS.yellow));
    console.log(color(`         ${relative(process.cwd(), f.file)}`, COLORS.dim));
  }
  console.log();
  process.exit(1);
}

main();
