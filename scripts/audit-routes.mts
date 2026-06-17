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
  {
    route: "/api/admin/fix-match/thumb",
    reason: "binary image stream; inline DB-checked requireAuth({role:'ISSUE_ADMIN'}) (guardrail 6a)",
  },
  {
    route: "/api/events",
    reason: "SSE stream; inline DB-checked requireAuth() + per-role event filtering (guardrail 6a)",
  },
  {
    route: "/api/config/compat",
    reason: "intentionally public, coarse API-version descriptor (no secrets/DB) — native clients gate BEFORE sign-in; pre-auth via isPublicPath in proxy.ts",
  },
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

interface Finding {
  route: string;
  file: string;
  reason: string;
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

    const isCronSync =
      rel.startsWith("cron/") || rel === "sync" || rel.startsWith("sync/");
    const isWebhook = rel.startsWith("webhooks/");
    const isAdmin = rel.startsWith("admin/");

    if (isCronSync) {
      if (!src.includes("isCronAuthorized")) {
        failures.push({ route, file, reason: "cron/sync route missing isCronAuthorized" });
      }
      continue;
    }
    if (isWebhook) {
      if (!src.includes("timingSafeEqual")) {
        failures.push({ route, file, reason: "webhook route missing timingSafeEqual secret compare" });
      }
      continue;
    }
    if (isAdmin) {
      if (!ADMIN_TOKENS.some((t) => src.includes(t))) {
        failures.push({
          route,
          file,
          reason: "admin route missing an ADMIN-capable guard (withAdmin/withIssueAdmin/requireAuth)",
        });
      }
      continue;
    }
    // Any other route: must carry some recognized auth guard.
    if (!ANY_AUTH_TOKENS.some((t) => src.includes(t))) {
      failures.push({ route, file, reason: "route has no recognized auth guard" });
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
    console.log(color("  ✓ Every audited route carries an auth guard.\n", COLORS.green));
    process.exit(0);
  }

  console.log(color(`  ✗ ${failures.length} route(s) missing an auth guard:\n`, COLORS.red + COLORS.bold));
  for (const f of failures) {
    console.log(`  ${color("[FAIL]", COLORS.red)} ${color(f.route, COLORS.bold)}`);
    console.log(color(`         ${f.reason}`, COLORS.yellow));
    console.log(color(`         ${relative(process.cwd(), f.file)}`, COLORS.dim));
  }
  console.log();
  process.exit(1);
}

main();
