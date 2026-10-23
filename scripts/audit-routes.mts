#!/usr/bin/env node
/**
 * API route authorization auditor.
 *
 * Static (grep-style) check that every API route handler carries an auth
 * guard. It does NOT validate the guard is logically correct — `tsc` and the
 * `withAdmin`/`withAuth` wrappers (CLAUDE.md guardrail 6a) cover that. This
 * catches the dangerous, common mistake: a route shipped with NO guard at all,
 * an `/api/admin/*` route guarded only as any-authenticated-user, or a route
 * under a STRICT_ADMIN_PREFIXES prefix (`/api/settings`) wrapped in anything
 * weaker than `withAdmin`.
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
import { pathToFileURL } from "node:url";

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
  // /api/events calls requireAuth inline, which proves authentication — all a
  // non-admin route needs — so it needs no entry. fix-match/thumb is an
  // /api/admin route, where requireAuth alone is NOT enough; it is listed in
  // INLINE_GUARDED_ADMIN_ROUTES below.
  {
    route: "/api/config/compat",
    reason: "intentionally public, coarse API-version descriptor (no secrets/DB) — native clients gate BEFORE sign-in; pre-auth via isPublicPath in proxy.ts",
  },
  {
    route: "/api/profile/notification-email/confirm",
    reason: "public email-verification landing (clicked from email, possibly logged-out); the one-time hashed token in the query IS the credential — pre-auth via isPublicPath in proxy.ts",
  },
  {
    route: "/api/calendar/feed/[token]",
    reason: "public iCal subscription feed — calendar apps send no cookie/header, so the per-user secret in the path IS the credential (SHA-256-hashed at rest, timing-safe compare, IP + token rate limits, 404 for disabled/purged owners) — pre-auth via isPublicPath in proxy.ts",
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
  { route: "/api/admin/users/[id]/reactivate", reason: "user management delegated via withPermission(Permission.MANAGE_USERS); re-enabling an ADMIN target additionally requires Permission.ADMIN in-handler" },
  { route: "/api/admin/users/[id]/purge", reason: "user management delegated via withPermission(Permission.MANAGE_USERS); purging an ADMIN target additionally requires Permission.ADMIN in-handler, and the target must already be disabled" },
  { route: "/api/admin/users/[id]/mfa", reason: "two-factor reset (lost device) delegated via withPermission(Permission.MANAGE_USERS); resetting an ADMIN target additionally requires Permission.ADMIN in-handler, and the caller's own account is refused (that path must go through the profile step-up)" },
  { route: "/api/admin/users/[id]/watch-grade", reason: "read-only watch grade delegated via withPermission([MANAGE_USERS, MANAGE_REQUESTS]) — the Users page and the request queue both show it" },
  { route: "/api/admin/users/[id]/sessions", reason: "per-device session list/revoke delegated via withPermission(Permission.MANAGE_USERS) — the Users page (MANAGE_USERS) mounts the Sessions modal; an ADMIN target additionally requires Permission.ADMIN in-handler, like mfa/reactivate/purge" },
  { route: "/api/admin/server-users", reason: "media-server identity management (link/auto-disable) delegated via withPermission(Permission.MANAGE_USERS) — the Users page admits MANAGE_USERS and mounts the Server Users table, whose controls 403'd for delegates while these were withAdmin" },
  { route: "/api/admin/server-users/[id]", reason: "per-identity link/downloads policy delegated via withPermission(Permission.MANAGE_USERS) — same surface as /api/admin/server-users" },
  { route: "/api/admin/server-users/bulk", reason: "bulk downloads policy delegated via withPermission(Permission.MANAGE_USERS) — same surface as /api/admin/server-users" },
  { route: "/api/admin/server-users/diagnose", reason: "read-only Jellyfin /Users diagnosis delegated via withPermission(Permission.MANAGE_USERS) — same surface as /api/admin/server-users; emails are masked in the response" },
];

/**
 * /api/admin/* routes that cannot use a wrapper (guardrail 6a: they return an
 * image or a stream) and so call `requireAuth()` inline, then make their own
 * capability check. requireAuth only proves "signed in", so it is not an admin
 * guard on its own: a route listed here must reach BOTH requireAuth and the
 * check named in `check`, and an unlisted admin route guarded only by
 * requireAuth fails. Adding here is a security decision.
 */
const INLINE_GUARDED_ADMIN_ROUTES: Array<{ route: string; check: string; reason: string }> = [
  {
    route: "/api/admin/fix-match/thumb",
    check: "hasPermission",
    reason: "returns an image, so it can't use withIssueAdmin; requireAuth (DB-checked) then hasPermission(MANAGE_ISSUES) — the same bit withIssueAdmin gates its sibling fix-match routes on, so clearing it revokes thumbnail access too",
  },
];

/**
 * Prefixes OUTSIDE /api/admin/ whose every route is ADMIN-only, and where the
 * proxy (src/proxy.ts) 403s every non-ADMIN role before the handler runs. The
 * entry covers the bare route AND its subtree (`settings` ⇒ /api/settings and
 * /api/settings/*). Each handler there must be `withAdmin` — exactly the check
 * the proxy backstop mirrors (hasRole: the role label, never the ADMIN bit) —
 * so a weaker wrapper (withAuth, withPermission, withIssueAdmin, requireAuth) is
 * refused: it would admit a caller the proxy is meant to refuse on the path the
 * proxy's matcher skips (prefetch-headed requests), and the two layers would
 * disagree about who may reach the route. Admitting a delegate here means
 * changing the proxy's backstop, this list and both tests together, on
 * purpose. Adding or removing an entry is a security decision.
 */
const STRICT_ADMIN_PREFIXES: Array<{ prefix: string; reason: string }> = [
  {
    prefix: "settings",
    reason:
      "instance configuration — Radarr/Sonarr/Plex/Jellyfin URLs and API keys, webhook secrets, auth policy; every route is withAdmin and the proxy 403s every non-ADMIN role on /api/settings and /api/settings/*",
  },
];

/** Tokens that prove an ADMIN-capable guard is present. */
// `requireAuth` is deliberately NOT here: without a role option it admits any
// signed-in user, so an /api/admin route guarded by it alone is guarded as
// any-authenticated-user. Inline-auth admin routes go in
// INLINE_GUARDED_ADMIN_ROUTES, which also demands their capability check.
const ADMIN_TOKENS = ["withAdmin", "withIssueAdmin", "isCronAuthorized", "getCronActor"];
/** Tokens that prove SOME auth guard is present (superset of ADMIN_TOKENS). */
// `withPermission` wraps withAuth and gates on a capability bit — it proves
// authentication but not a specific role, so it stays out of ADMIN_TOKENS
// (/api/admin/* routes still need a role wrapper or the proxy backstop).
// `requireAuth` proves authentication, which is all a non-admin route needs.
//
// `timingSafeEqual` is deliberately NOT here: it's the webhook-token compare and
// is already required in the `isWebhook` branch below. Accepting it as a generic
// guard would let a future non-webhook route that imports it for an unrelated
// string compare pass with no session guard at all.
const ANY_AUTH_TOKENS = [...ADMIN_TOKENS, "withAuth", "withPermission", "requireAuth"];

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

/** Characters after which a `/` opens a regex literal rather than dividing. */
const REGEX_MAY_FOLLOW = new Set([
  "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "~", "^", "<", ">",
]);
// `\s*` before the anchor is load-bearing: `out` carries the whitespace between
// the keyword and the `/` (`return /x/`), so a bare `$` never matched and every
// keyword-led regex fell through to the quote branch.
const KEYWORD_BEFORE_REGEX = /(?:^|[^\w$])(?:return|typeof|case|in|of|new|delete|void|instanceof|do|else|yield|await)\s*$/;

/**
 * Blank out comments, preserving line structure and string contents.
 *
 * Guard detection searches the text of a declaration's region, so a token
 * merely *named* in prose ("TODO: wrap this in withAdmin") would satisfy it with
 * no guard present. A region also runs to the next column-0 declaration, which
 * means a comment written to document the NEXT handler is attributed to the
 * PREVIOUS one — so an unguarded handler can inherit a mention it does not own.
 * Quotes are tracked so `//` inside a URL literal is not read as a comment.
 */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  // Last non-whitespace character emitted, used to tell a regex literal from a
  // division. Without it, `/['"]/g` opens a phantom string that runs to the next
  // quote in the file and swallows every comment in between — which silently
  // restores the prose-mention hole this function exists to close.
  let prev = "";

  const takeEscape = () => {
    out += src[i] + (src[i + 1] ?? "");
    i += 2;
  };

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    if (ch === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        // Keep newlines so column-0 anchoring still sees real declarations.
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    if (ch === "/" && (prev === "" || REGEX_MAY_FOLLOW.has(prev) || KEYWORD_BEFORE_REGEX.test(out))) {
      out += ch;
      i++;
      let inClass = false;
      // A newline ends the scan: regex literals cannot span lines, so anything
      // else means this `/` was not one and we stop rather than eat the file.
      while (i < src.length && src[i] !== "\n") {
        if (src[i] === "\\") {
          takeEscape();
          continue;
        }
        const c = src[i];
        out += c;
        i++;
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break;
      }
      prev = "/";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      out += ch;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") {
          takeEscape();
          continue;
        }
        const c = src[i];
        // An unterminated quote must not consume the rest of the file. Template
        // literals legitimately span lines; the others do not.
        if (c === "\n" && ch !== "`") break;
        out += c;
        i++;
        if (c === ch) break;
      }
      prev = ch;
      continue;
    }

    out += ch;
    i++;
    if (!/\s/.test(ch)) prev = ch;
  }
  return out;
}

/**
 * HTTP methods exported through a form `parseTopLevelDecls` cannot model: brace
 * re-exports (`export { GET }`, `export { handler as POST } from "./impl"`) and
 * star re-exports.
 *
 * The zero-handler check in main() only fires when EVERY handler in a file is
 * unmodeled. A file pairing one parsed handler with one re-exported method keeps
 * a non-zero count, so that method would ship completely unaudited.
 */
export function findUnmodeledMethodExports(src: string): string[] {
  const found = new Set<string>();
  const braceRe = /^export\s*\{([^}]*)\}/gm;
  for (let m = braceRe.exec(src); m !== null; m = braceRe.exec(src)) {
    for (const clause of m[1].split(",")) {
      // `handler as GET` exports GET; a bare `GET` exports GET.
      const exported = clause.split(/\s+as\s+/).pop()?.trim();
      if (exported && HTTP_METHODS.has(exported)) found.add(exported);
    }
  }
  // `export * from "./impl"` may re-export any method, and which ones is not
  // knowable without following the import — which this audit deliberately won't.
  if (/^export\s*\*/m.test(src)) found.add("*");
  return [...found];
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
export function parseTopLevelDecls(src: string): TopLevelDecl[] {
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
 * True when `text` CALLS `token`, not merely mentions it.
 *
 * A guard is an invocation, so requiring the call shape is both more accurate
 * and the durable defence against prose: "wrap this in withAdmin" cannot satisfy
 * it even if comment stripping misses the comment entirely. Every guard form in
 * this codebase is a call — `withAuth(`, `withPermission(x)(`, `requireAuth()`,
 * `isCronAuthorized(`, `timingSafeEqual(` — so nothing legitimate is lost.
 */
export function callsToken(text: string, token: string): boolean {
  // Guard tokens are plain identifiers, but escape `\` and `$` defensively anyway.
  return new RegExp(`\\b${token.replace(/[\\$]/g, "\\$&")}\\s*\\(`).test(text);
}

/**
 * True when `decl`'s own region calls one of `tokens`, or transitively
 * references another top-level declaration in the same file whose region does.
 * The transitive hop covers the two legitimate indirection patterns in this
 * codebase: a local helper that performs the check (`getAuthContext` →
 * `isCronAuthorized` in the cron warm routes) and a shared handler alias
 * (`export const GET = handle` in cron/trash-diagnostic). Cross-FILE
 * indirection is intentionally not followed — a guard hidden in an import is
 * exactly the opacity this audit exists to reject.
 */
export function reachesToken(
  decl: TopLevelDecl,
  tokens: string[],
  byName: Map<string, TopLevelDecl[]>,
  visited: Set<string> = new Set([decl.name]),
): boolean {
  if (tokens.some((t) => callsToken(decl.text, t))) return true;
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

// A subtree match must stop at a path separator. `rel.startsWith("health")`
// also matched a sibling like `health-internal/…`, silently exempting a brand
// new route from the CI auth gate — the one thing this script exists to stop.
// Exact matches still pass (the bare `health` / `interactions` / `settings`
// routes). Shared by the public allowlist and the strict-admin prefixes so the
// two boundaries can never drift apart.
function matchesPrefix(rel: string, prefix: string): boolean {
  return rel === prefix || rel.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
}

export function isAllowlisted(rel: string): boolean {
  return ALLOWLIST.some((a) => matchesPrefix(rel, a.prefix));
}

/** True for a route under STRICT_ADMIN_PREFIXES (the bare route or its subtree). */
export function isStrictAdminPrefixed(rel: string): boolean {
  return STRICT_ADMIN_PREFIXES.some((p) => matchesPrefix(rel, p.prefix));
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

    if (isAllowlisted(rel)) continue;
    if (ROUTE_EXCEPTIONS.some((e) => e.route === route)) continue;

    audited++;
    // Comments are removed before any guard matching: a token named in prose is
    // not a guard, and region boundaries would otherwise hand one handler's
    // documentation to the handler declared above it.
    const src = stripComments(readFileSync(file, "utf8"));

    // Checked even when other handlers parse — a mixed file keeps a non-zero
    // handler count, so the zero-handler check below would never see it.
    const unmodeled = findUnmodeledMethodExports(src);
    if (unmodeled.length > 0) {
      failures.push({
        route,
        file,
        reason: `HTTP method(s) exported in a style the parser cannot audit: ${unmodeled.join(", ")} — extend the parser or hand-audit`,
      });
      continue;
    }

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
    const strictAdmin = STRICT_ADMIN_PREFIXES.find((p) => matchesPrefix(rel, p.prefix));

    for (const handler of handlers) {
      if (isCronSync) {
        if (!reachesToken(handler, ["isCronAuthorized", "getCronActor"], byName)) {
          failures.push({ route, file, reason: `${handler.name}: cron/sync handler missing isCronAuthorized / getCronActor` });
        }
      } else if (isWebhook) {
        if (!reachesToken(handler, ["timingSafeEqual"], byName)) {
          failures.push({ route, file, reason: `${handler.name}: webhook handler missing timingSafeEqual secret compare` });
        }
      } else if (isAdmin) {
        const permissionGuarded = PERMISSION_GUARDED_ADMIN_ROUTES.some((e) => e.route === route);
        const adminTokens = permissionGuarded ? [...ADMIN_TOKENS, "withPermission"] : ADMIN_TOKENS;
        const inline = INLINE_GUARDED_ADMIN_ROUTES.find((e) => e.route === route);
        const inlineGuarded =
          inline !== undefined &&
          reachesToken(handler, ["requireAuth"], byName) &&
          reachesToken(handler, [inline.check], byName);
        if (!inlineGuarded && !reachesToken(handler, adminTokens, byName)) {
          failures.push({
            route,
            file,
            reason: inline
              ? `${handler.name}: inline-guarded admin handler must call both requireAuth and ${inline.check}`
              : `${handler.name}: admin handler missing an ADMIN-capable guard (withAdmin/withIssueAdmin; requireAuth alone is authentication only)`,
          });
        }
      } else if (strictAdmin) {
        // Exactly withAdmin, no inline or permission-guarded exceptions: the
        // proxy refuses every non-ADMIN role on this prefix, and this is what
        // keeps the route's own gate saying the same thing.
        if (!reachesToken(handler, ["withAdmin"], byName)) {
          failures.push({
            route,
            file,
            reason: `${handler.name}: /api/${strictAdmin.prefix} handler must be withAdmin — the proxy 403s every non-ADMIN role on this prefix, so a weaker wrapper (withAuth/withPermission/withIssueAdmin/requireAuth) would disagree with the backstop; see STRICT_ADMIN_PREFIXES`,
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

// Only run the CLI when invoked directly. Tests import the parser helpers above,
// and an unguarded main() would walk src/app/api and exit the test runner.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
