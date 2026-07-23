#!/usr/bin/env node
/**
 * E2E crawl: signs in as the seeded ADMIN user (scripts/e2e-seed.mts), visits a
 * curated route list with headless Chromium, and fails if any page throws an
 * uncaught client error — React #418 hydration mismatches in particular
 * (CLAUDE.md guardrail 16 documents six historical #418 bugs). Run by
 * .github/workflows/e2e.yml.
 *
 * It ALSO drives one mobile INTERACTION the route crawl can't cover: at a 375px
 * viewport it taps the bottom-nav "More" button and asserts the nav drawer opens
 * instead of crashing into the error boundary. The pure route crawl missed a real
 * user-facing regression there — the mobile nav is `lg:hidden` so the button never
 * renders at the crawl's desktop width, and the crash was caught by the React error
 * boundary (rendering "Something went wrong") rather than surfacing as a pageerror.
 *
 * Pass criterion: zero `pageerror` events AND the mobile drawer opens cleanly. HTTP
 * status and console errors are reported but non-fatal — a CI run has no Plex/
 * Jellyfin/Radarr/Sonarr/TMDB backends, so data-dependent pages legitimately render
 * empty/degraded states. Hydration errors, by contrast, fire regardless of data.
 *
 * Usage:
 *   node scripts/e2e-crawl.mts
 */

import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type ConsoleMessage,
} from "playwright";

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
  "/admin/trash-guides",
  "/admin/trash-guides/settings",
  "/admin/trash-guides/quality-profiles",
  "/admin/trash-guides/custom-formats",
  "/admin/trash-guides/naming-sizes",
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

// Mobile-only interaction the route crawl can't reach: the bottom-nav "More"
// button (lg:hidden, so absent at the crawl's desktop width) opens the nav drawer.
// A base-ui MenuRootContext throw from a menu-only component rendered outside a
// <Menu.Root> once crashed the whole app here — the render error was swallowed by
// the error boundary, so the crawl's pageerror listener alone would not catch it.
// We assert on the RESULT: no error-boundary fallback text AND the drawer popup
// present. Shares the signed-in context (its login cookie), just at 375px.
async function checkMobileMore(context: BrowserContext): Promise<{ ok: boolean; detail: string }> {
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  try {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    await page.waitForTimeout(SETTLE_MS);

    const moreBtn = page.locator('button[aria-label="More"]');
    if ((await moreBtn.count()) === 0) {
      return { ok: false, detail: 'the mobile bottom-nav "More" button did not render at 375px' };
    }
    await moreBtn.first().click();
    await page.waitForTimeout(SETTLE_MS);

    const bodyText = (await page.locator("body").innerText().catch(() => "")) || "";
    const suffix = pageErrors.length > 0 ? ` (pageerror: ${pageErrors[0]})` : "";
    if (/Something went wrong|critical error occurred/i.test(bodyText)) {
      return { ok: false, detail: `tapping "More" crashed into the error boundary${suffix}` };
    }
    // data-slot="drawer-popup" is set by the in-repo Drawer wrapper (ui/drawer.tsx).
    if ((await page.locator('[data-slot="drawer-popup"]').count()) === 0) {
      return { ok: false, detail: `the nav drawer did not open after tapping "More"${suffix}` };
    }
    if (pageErrors.length > 0) {
      return { ok: false, detail: `uncaught client error while opening the drawer: ${pageErrors[0]}` };
    }
    return { ok: true, detail: "drawer opened cleanly" };
  } catch (err) {
    return { ok: false, detail: `mobile "More" check threw: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await page.close();
  }
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

    const mobile = await checkMobileMore(context);
    console.log(
      `[e2e-crawl] ${(mobile.ok ? "ok" : "FAIL").padEnd(4)} mobile:tap-More — ${mobile.detail}`,
    );

    const broken = results.filter((r) => r.pageErrors.length > 0);
    const hydration = results.filter((r) => r.hydrationError);
    console.log("\n=== E2E CRAWL SUMMARY ===");
    console.log(`Routes crawled:   ${results.length}`);
    console.log(`Uncaught errors:  ${broken.length}`);
    console.log(`#418 hydration:   ${hydration.length}`);
    console.log(`Mobile More tap:  ${mobile.ok ? "ok" : "FAIL"}`);
    if (broken.length > 0) {
      failed = true;
      console.log("\nRoutes with uncaught client errors:");
      for (const r of broken) {
        console.log(`  ${r.route}${r.hydrationError ? "  [#418 hydration]" : ""}`);
      }
    }
    if (!mobile.ok) {
      failed = true;
      console.log(`\nMobile interaction failed: ${mobile.detail}`);
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
