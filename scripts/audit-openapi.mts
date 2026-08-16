#!/usr/bin/env node
/**
 * OpenAPI ↔ route parity auditor.
 *
 * The OpenAPI document in src/app/api/openapi/route.ts is hand-maintained, so it
 * silently drifts from the real route tree. This check fails CI when:
 *   1. a NEW API route ships that is neither documented in the spec nor listed
 *      in EXCEPTIONS below (the common drift — a route added without a doc);
 *   2. the spec documents a path that has no route file (a phantom/stale entry);
 *   3. an EXCEPTIONS entry is stale — the route was deleted, or it's now
 *      documented (so the exception should be removed).
 *
 * It also compares METHODS per path (4), because path-level parity alone made a
 * whole class of drift invisible: a path counts as documented the instant ONE
 * method under it is, so `/admin/audit-log` documenting only `get` fully
 * satisfied the check while its DELETE shipped undocumented. Six operations had
 * accumulated that way. Paths are compared in the spec's own keyspace: no `/api`
 * prefix, and `[seg]` → `{seg}`.
 *
 * Usage:
 *   node scripts/audit-openapi.mts          # human report, non-zero exit on drift
 *   node scripts/audit-openapi.mts --json   # machine-readable
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { stripComments, parseTopLevelDecls, findUnmodeledMethodExports } from "./audit-routes.mts";

/** Every method with a handler anywhere in this tree. No PUT/HEAD/OPTIONS exists. */
const HTTP_METHODS = new Set(["GET", "POST", "PATCH", "PUT", "DELETE", "HEAD", "OPTIONS"]);

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
const SPEC_FILE = join(API_ROOT, "openapi", "route.ts");

/**
 * Routes intentionally absent from the public OpenAPI document. Each needs a
 * reason — adding here is a deliberate "this stays undocumented" decision, not a
 * way to silence the check. Grouped by why. Paths are in the spec keyspace
 * (no `/api`, `[x]` → `{x}`).
 */
const EXCEPTIONS: Array<{ route: string; reason: string }> = [
  // Auth mechanics — sign-in/OIDC/PIN handshakes; documented behaviourally in
  // the auth guide, not as callable client operations.
  { route: "/auth/sign-in/credentials", reason: "credential sign-in handshake" },
  { route: "/auth/sign-in/jellyfin", reason: "Jellyfin sign-in handshake" },
  { route: "/auth/sign-in/jellyfin-quickconnect", reason: "Jellyfin QuickConnect redemption" },
  { route: "/auth/sign-in/plex", reason: "Plex sign-in handshake" },
  { route: "/auth/plex/pin", reason: "Plex OAuth PIN poll" },
  { route: "/auth/plex/start", reason: "Plex OAuth start" },
  { route: "/auth/oidc/start", reason: "OIDC redirect start" },
  { route: "/auth/oidc/callback", reason: "OIDC redirect callback" },
  { route: "/auth/machine-session", reason: "machine/session bootstrap" },
  // Discord bot / interactions — Ed25519-signed or bot-flow, not a REST client surface.
  { route: "/interactions", reason: "Discord Ed25519 interactions webhook" },
  // Internal / infra endpoints.
  { route: "/openapi", reason: "the spec document itself (ADMIN)" },
  { route: "/push/announce-update", reason: "admin broadcast trigger" },
  // Setup / import — first-run + chunked upload internals.
  { route: "/setup/import", reason: "first-run import (userCount===0 gated)" },
  { route: "/setup/import-chunk", reason: "first-run chunked import" },
  { route: "/admin/backup/db-import-chunk", reason: "chunked backup upload internal" },
  // Admin-internal actions not part of the documented client surface.
  { route: "/admin/activity-warm", reason: "admin cache warm trigger" },
  { route: "/admin/blacklist", reason: "admin blacklist management" },
  { route: "/admin/ip-lookup", reason: "admin IP geolocation lookup" },
  { route: "/admin/mdblist-warm", reason: "admin cache warm trigger" },
  { route: "/admin/omdb-warm", reason: "admin cache warm trigger" },
  { route: "/admin/play-history/heatmap-cell", reason: "admin activity drill-down" },
  { route: "/admin/play-history/terminate-session", reason: "admin terminate Plex session" },
  { route: "/admin/play-history/terminate-jellyfin-session", reason: "admin terminate Jellyfin session" },
  { route: "/admin/server-users", reason: "admin media-server user list" },
  { route: "/admin/server-users/bulk", reason: "admin bulk server-user action" },
  { route: "/admin/server-users/diagnose", reason: "admin diagnostic (no UI)" },
  { route: "/admin/server-users/{id}", reason: "admin server-user detail" },
  { route: "/admin/trash-guides/apply", reason: "admin TRaSH-guides apply" },
  { route: "/admin/trash-guides/refresh", reason: "admin TRaSH-guides refresh" },
  { route: "/admin/trash-guides/status", reason: "admin TRaSH-guides status" },
  { route: "/admin/trash-guides/starter-pack", reason: "admin TRaSH-guides starter pack" },
  { route: "/admin/trash-guides/applications/{id}", reason: "admin TRaSH-guides application" },
  { route: "/admin/trash-guides/spec/{id}", reason: "admin TRaSH-guides spec" },
  // Settings sub-routes — admin config surface.
  { route: "/settings/plex", reason: "admin Plex settings" },
  { route: "/settings/webhook-urls", reason: "admin webhook URL settings" },
  // Jellyfin self-service notification-email verification (send + public confirm).
  { route: "/profile/notification-email", reason: "start email verification (Jellyfin self-service)" },
  { route: "/profile/notification-email/confirm", reason: "public email-verification confirm landing" },
  // Cron — CRON_SECRET jobs; the documented cron set is representative, these are the rest.
  { route: "/cron/sync-download-policies", reason: "cron job (CRON_SECRET)" },
  { route: "/cron/trash-sync", reason: "cron job (CRON_SECRET)" },
  { route: "/cron/trash-diagnostic", reason: "cron diagnostic (CRON_SECRET)" },
  { route: "/cron/warm-list-cache", reason: "cron job (CRON_SECRET)" },
];

/**
 * Individual operations left undocumented on a path that IS otherwise
 * documented. Deliberately separate from EXCEPTIONS: that list excepts a whole
 * path, and several of its 41 entries cover paths carrying two or three methods
 * each, so folding methods into it would inflate it to ~55 entries and lose the
 * "this entire surface is undocumented" meaning it currently carries.
 *
 * Empty today, and that is the point — all six operations this check was
 * written to find have been documented rather than excepted.
 */
const METHOD_EXCEPTIONS: Array<{ op: string; reason: string }> = [];

const HTTP_FILES = new Set(["route.ts", "route.tsx"]);

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (HTTP_FILES.has(entry)) out.push(full);
  }
}

/** Derive the spec-keyspace path for a route file (no `/api`, `[x]` → `{x}`). */
function specPath(file: string): string {
  const rel = relative(API_ROOT, file).split(sep).slice(0, -1).join("/");
  return "/" + rel.replace(/\[([^\]]+)\]/g, "{$1}");
}

/**
 * Extract documented paths AND the methods under each, from the hand-maintained
 * spec source.
 *
 * Structural, not evaluated. The spec is a plain object literal, so `eval`-ing
 * it would be more robust against reformatting — but this script runs in CI on
 * every push, and executing a source file to lint it is a bargain worth
 * declining. Path keys sit at 4-space indent and method keys at 6, so each
 * path's window runs to the next 4-space key.
 */
function documentedOps(): Map<string, Set<string>> {
  const src = readFileSync(SPEC_FILE, "utf8");
  const pathRe = /^ {4}"(\/[^"]+)"\s*:\s*\{/gm;
  const hits: Array<{ path: string; from: number }> = [];
  for (let m = pathRe.exec(src); m !== null; m = pathRe.exec(src)) {
    hits.push({ path: m[1], from: m.index + m[0].length });
  }
  const out = new Map<string, Set<string>>();
  for (let i = 0; i < hits.length; i++) {
    const window = src.slice(hits[i].from, i + 1 < hits.length ? hits[i + 1].from : src.length);
    const methods = new Set<string>();
    const methodRe = /^ {6}(get|post|patch|put|delete|head|options)\s*:\s*\{/gm;
    for (let m = methodRe.exec(window); m !== null; m = methodRe.exec(window)) {
      methods.add(m[1].toUpperCase());
    }
    out.set(hits[i].path, methods);
  }
  return out;
}

/**
 * The HTTP methods a route file actually exports.
 *
 * Reuses audit-routes.mts's parsers rather than re-deriving them — that file
 * already handles every export shape in this tree (wrapper, curried wrapper,
 * bare async function, non-async function, and a bare alias), and it is the
 * one with the test suite. `findUnmodeledMethodExports` is carried over too, so
 * a future `export { handler as PUT }` fails loudly instead of silently reading
 * as "no PUT exported".
 */
function exportedMethods(file: string): Set<string> {
  const src = stripComments(readFileSync(file, "utf8"));
  const found = new Set<string>();
  for (const decl of parseTopLevelDecls(src)) {
    if (decl.exported && HTTP_METHODS.has(decl.name)) found.add(decl.name);
  }
  for (const name of findUnmodeledMethodExports(src)) {
    if (HTTP_METHODS.has(name)) found.add(name);
  }
  return found;
}

function main(): void {
  const json = process.argv.includes("--json");

  const files: string[] = [];
  walk(API_ROOT, files);
  const actual = new Set(files.map(specPath));
  const documentedByPath = documentedOps();
  const documented = new Set(documentedByPath.keys());
  const exceptionRoutes = new Set(EXCEPTIONS.map((e) => e.route));
  const methodExceptionOps = new Set(METHOD_EXCEPTIONS.map((e) => e.op));

  // 1. New/undocumented routes not grandfathered.
  const undocumented = [...actual].filter((p) => !documented.has(p) && !exceptionRoutes.has(p)).sort();
  // 2. Spec paths with no route file.
  const phantom = [...documented].filter((p) => !actual.has(p)).sort();
  // 3. Stale exceptions — route gone, or now documented.
  const staleExceptions = EXCEPTIONS
    .filter((e) => !actual.has(e.route) || documented.has(e.route))
    .map((e) => e.route)
    .sort();

  // 4. Method-level drift, scoped to paths that ARE documented. A wholly
  //    undocumented path is check 1's business; reporting each of its methods
  //    here too would just duplicate that.
  const undocumentedOps: string[] = [];
  const phantomOps: string[] = [];
  for (const file of files) {
    const p = specPath(file);
    const documentedMethods = documentedByPath.get(p);
    if (!documentedMethods) continue; // path undocumented entirely — check 1 owns it
    const exported = exportedMethods(file);
    for (const m of exported) {
      if (!documentedMethods.has(m) && !methodExceptionOps.has(`${m} ${p}`)) undocumentedOps.push(`${m} ${p}`);
    }
    for (const m of documentedMethods) {
      if (!exported.has(m)) phantomOps.push(`${m} ${p}`);
    }
  }
  undocumentedOps.sort();
  phantomOps.sort();
  // A method exception is stale once the operation is documented, or its path
  // stopped being documented at all (then it belongs in EXCEPTIONS, not here).
  const staleMethodExceptions = METHOD_EXCEPTIONS
    .filter((e) => {
      const [method, ...rest] = e.op.split(" ");
      const p = rest.join(" ");
      const doc = documentedByPath.get(p);
      return !doc || doc.has(method);
    })
    .map((e) => e.op)
    .sort();

  const ok = undocumented.length === 0 && phantom.length === 0 && staleExceptions.length === 0 &&
    undocumentedOps.length === 0 && phantomOps.length === 0 && staleMethodExceptions.length === 0;

  if (json) {
    console.log(JSON.stringify(
      {
        actual: actual.size, documented: documented.size, exceptions: exceptionRoutes.size,
        undocumented, phantom, staleExceptions,
        undocumentedOps, phantomOps, staleMethodExceptions,
      },
      null, 2,
    ));
    process.exit(ok ? 0 : 1);
  }

  console.log(color("\n  OpenAPI ↔ Route Parity Audit", COLORS.bold + COLORS.cyan));
  console.log(color("  ─────────────────────────────", COLORS.dim));
  console.log(
    `\n  ${color(String(actual.size), COLORS.bold)} routes · ` +
      `${color(String(documented.size), COLORS.bold)} documented · ` +
      `${color(String(exceptionRoutes.size), COLORS.bold)} grandfathered · ` +
      `${color(String([...documentedByPath.values()].reduce((n, m) => n + m.size, 0)), COLORS.bold)} operations\n`,
  );

  if (ok) {
    console.log(color("  ✓ Every route and method is documented or explicitly excepted; the spec has no phantom entries.\n", COLORS.green));
    process.exit(0);
  }

  if (undocumented.length > 0) {
    console.log(color(`  ✗ ${undocumented.length} undocumented route(s) — add to the OpenAPI spec or to EXCEPTIONS:`, COLORS.red + COLORS.bold));
    for (const p of undocumented) console.log(color(`      ${p}`, COLORS.yellow));
    console.log();
  }
  if (phantom.length > 0) {
    console.log(color(`  ✗ ${phantom.length} documented path(s) with no route file (stale spec entry):`, COLORS.red + COLORS.bold));
    for (const p of phantom) console.log(color(`      ${p}`, COLORS.yellow));
    console.log();
  }
  if (undocumentedOps.length > 0) {
    console.log(color(`  ✗ ${undocumentedOps.length} undocumented method(s) on an otherwise-documented path:`, COLORS.red + COLORS.bold));
    for (const o of undocumentedOps) console.log(color(`      ${o}`, COLORS.yellow));
    console.log(color("    (path-level parity passes these — one documented method marks the whole path done)", COLORS.dim));
    console.log();
  }
  if (phantomOps.length > 0) {
    console.log(color(`  ✗ ${phantomOps.length} documented method(s) with no exported handler:`, COLORS.red + COLORS.bold));
    for (const o of phantomOps) console.log(color(`      ${o}`, COLORS.yellow));
    console.log();
  }
  if (staleMethodExceptions.length > 0) {
    console.log(color(`  ✗ ${staleMethodExceptions.length} stale METHOD_EXCEPTIONS entr(y/ies) — now documented, or the path left the spec; delete it:`, COLORS.red + COLORS.bold));
    for (const o of staleMethodExceptions) console.log(color(`      ${o}`, COLORS.yellow));
    console.log();
  }
  if (staleExceptions.length > 0) {
    console.log(color(`  ✗ ${staleExceptions.length} stale EXCEPTIONS entr(y/ies) — route removed or now documented; delete the exception:`, COLORS.red + COLORS.bold));
    for (const p of staleExceptions) console.log(color(`      ${p}`, COLORS.yellow));
    console.log();
  }
  process.exit(1);
}

main();
