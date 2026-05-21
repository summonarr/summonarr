#!/usr/bin/env node
/**
 * E2E crawl: signs in as the seeded ADMIN user (scripts/e2e-seed.mts), visits a
 * curated route list with headless Chromium, and fails if any page throws an
 * uncaught client error — React #418 hydration mismatches in particular
 * (CLAUDE.md guardrail 16 documents six historical #418 bugs). Run by
 * .github/workflows/e2e.yml.
 *
 * Pass criterion: zero `pageerror` events. HTTP status and console errors are
 * reported but non-fatal — a CI run has no Plex/Jellyfin/Radarr/Sonarr/TMDB
 * backends, so data-dependent pages legitimately render empty/degraded states.
 * Hydration errors, by contrast, fire regardless of data.
 *
 * Usage:
 *   node scripts/e2e-crawl.mts
 */

import { chromium, type Browser, type Page, type ConsoleMessage } from "playwright";

const BASE_URL = process.env.E2E_BASE_URL || "http://localhost:3000";
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL || "e2e-admin@summonarr.local";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD || "e2e-admin-password-not-for-production";
const SETTLE_MS = Number(process.env.E2E_SETTLE_MS || 2000);
const NAV_TIMEOUT_MS = Number(process.env.E2E_NAV_TIMEOUT_MS || 30_000);

// Curated crawl set — the routes touched by the hydration-sensitive commits on
// this branch plus the components named in CLAUDE.md guardrail 16. Dynamic
// routes needing a real id (e.g. /admin/activity/play/[id]) are omitted: a
// fresh CI database has no rows to address them.
const ROUTES = [
  "/",
  "/movies",
  "/tv",
  "/popular",
  "/top",
  "/upcoming",
  "/requests",
  "/issues",
  "/votes",
  "/profile",
  "/settings",
  "/donate",
  "/admin/activity",
  "/admin/activity/recent",
  "/admin/activity/users",
  "/admin/users",
  "/admin/audit-log",
  "/admin/api-docs",
  "/admin/issues",
  "/admin/backup",
  "/admin/stats",
  "/admin/library",
];

interface PageResult {
  route: string;
  status: number | null;
  hydrationError: boolean;
  pageErrors: string[];
  consoleErrors: string[];
}

async function login(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  if (new URL(page.url()).pathname.startsWith("/setup")) {
    throw new Error("/login redirected to /setup — the seed step did not create the admin user");
  }
  await page.fill("#email", ADMIN_EMAIL);
  await page.fill("#password", ADMIN_PASSWORD);
  await page.click('button[type="submit"]');
  try {
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: NAV_TIMEOUT_MS });
  } catch {
    throw new Error(
      "login did not navigate away from /login — check the seeded E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD",
    );
  }
}

async function visit(page: Page, route: string): Promise<PageResult> {
  const result: PageResult = {
    route,
    status: null,
    hydrationError: false,
    pageErrors: [],
    consoleErrors: [],
  };
  const onPageError = (err: Error) => {
    result.pageErrors.push(err.message);
    if (/#418/.test(err.message)) result.hydrationError = true;
  };
  const onConsole = (msg: ConsoleMessage) => {
    if (msg.type() === "error") result.consoleErrors.push(msg.text());
  };
  page.on("pageerror", onPageError);
  page.on("console", onConsole);
  try {
    const resp = await page.goto(`${BASE_URL}${route}`, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
    });
    result.status = resp ? resp.status() : null;
  } catch (err) {
    result.pageErrors.push(
      `navigation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // Hydration runs shortly after DOMContentLoaded; settle so React #418 has a
  // chance to surface as a pageerror before listeners are detached.
  await page.waitForTimeout(SETTLE_MS);
  page.off("pageerror", onPageError);
  page.off("console", onConsole);
  return result;
}

async function main(): Promise<void> {
  const browser: Browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  let failed = false;
  try {
    const loginPage = await context.newPage();
    await login(loginPage);
    console.log(`[e2e-crawl] signed in as ${ADMIN_EMAIL}`);
    await loginPage.close();

    const results: PageResult[] = [];
    for (const route of ROUTES) {
      const page = await context.newPage();
      const r = await visit(page, route);
      await page.close();
      results.push(r);
      console.log(
        `[e2e-crawl] ${(r.pageErrors.length > 0 ? "FAIL" : "ok").padEnd(4)} ${route} ` +
          `(status=${r.status ?? "?"}, pageErrors=${r.pageErrors.length}, ` +
          `consoleErrors=${r.consoleErrors.length})`,
      );
      for (const e of r.pageErrors) console.log(`             pageerror: ${e}`);
    }

    const broken = results.filter((r) => r.pageErrors.length > 0);
    const hydration = results.filter((r) => r.hydrationError);
    console.log("\n=== E2E CRAWL SUMMARY ===");
    console.log(`Routes crawled:   ${results.length}`);
    console.log(`Uncaught errors:  ${broken.length}`);
    console.log(`#418 hydration:   ${hydration.length}`);
    if (broken.length > 0) {
      failed = true;
      console.log("\nRoutes with uncaught client errors:");
      for (const r of broken) {
        console.log(`  ${r.route}${r.hydrationError ? "  [#418 hydration]" : ""}`);
      }
    }
  } finally {
    await browser.close();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("[e2e-crawl]", err);
  process.exit(1);
});
