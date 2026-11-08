// The mobile bottom tab bar (src/components/layout/mobile-tabs.ts) and the
// admin-item list it shares with the sidebar (src/components/layout/nav-visibility.ts).
//
//   - The fourth slot follows what the viewer may open: the admin area (its
//     first visible item), the issue queue for an issues-only delegate, or
//     Profile — and never a page whose feature flag is off.
//   - Browse always lands on /movies (it carries no feature flag).
//   - Every tab matches through isNavItemActive, so a sub-route of a tab's page
//     lights that tab — the Profile tab included.
//   - The sidebar and the tab bar read one helper, so their admin lists agree.
//
// The icons are stubbed the way tests/nav-items.test.mts stubs them: the barrel
// re-exports .tsx files Node can't parse, and only the references matter here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ICONS_BARREL = resolve(HERE, "../src/components/icons/index.ts");
const VIRTUAL_ICONS = "summonarr-test:mobile-tabs-icons";
const iconNames = [...readFileSync(ICONS_BARREL, "utf8").matchAll(/export \{ (\w+) \} from/g)].map((m) => m[1]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/components/icons") return { url: VIRTUAL_ICONS, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === VIRTUAL_ICONS) {
      return { format: "module", shortCircuit: true, source: iconNames.map((n) => `export const ${n} = () => null;`).join("\n") };
    }
    return nextLoad(url, context);
  },
});

const { buildMobileTabs, fourthTab, PROFILE_TAB_HREFS } = await import("../src/components/layout/mobile-tabs.ts");
const { visibleAdminNavItems } = await import("../src/components/layout/nav-visibility.ts");
const { Permission } = await import("../src/lib/permissions.ts");

const t = (key: string) => key;
const active = (tabs: { href: string; match: (p: string) => boolean }[], path: string) =>
  tabs.filter((tab) => tab.match(path)).map((tab) => tab.href);

test("a viewer with no admin access gets Profile in the fourth slot", () => {
  const tabs = buildMobileTabs(visibleAdminNavItems({ role: "USER" }), t);
  assert.deepEqual(tabs.map((x) => x.href), ["/", "/movies", "/requests", "/profile"]);
  assert.equal(tabs[3].label, "nav.profile");
});

test("Browse always lands on /movies, whatever the feature flags hide", () => {
  const off = { "feature.page.popular": false, "feature.page.top": false, "feature.page.forYou": false };
  assert.equal(buildMobileTabs(visibleAdminNavItems({ role: "USER" }, off), t)[1].href, "/movies");
});

test("the Profile tab owns /profile, /donate and their sub-routes; Requests never lights with it", () => {
  const tabs = buildMobileTabs([], t);
  for (const p of ["/profile", "/donate", "/profile/security", "/donate/thanks"]) {
    assert.deepEqual(active(tabs, p), ["/profile"], p);
  }
  for (const p of ["/requests", "/watchlist", "/my-stats"]) assert.deepEqual(active(tabs, p), ["/requests"], p);
  assert.deepEqual(active(tabs, "/movie/603"), ["/movies"]);
  assert.deepEqual(active(tabs, "/"), ["/"]);
  assert.ok(PROFILE_TAB_HREFS.has("/profile") && PROFILE_TAB_HREFS.has("/donate"));
});

test("an admin's fourth tab opens their first visible admin page and claims the admin area", () => {
  const items = visibleAdminNavItems({ role: "ADMIN" });
  assert.equal(fourthTab(items), "admin");
  const tabs = buildMobileTabs(items, t);
  assert.equal(tabs[3].href, "/admin");
  assert.deepEqual(active(tabs, "/admin/queue"), ["/admin"]);
  assert.deepEqual(active(tabs, "/settings"), ["/admin"]);
  // With an admin tab there is no Profile tab: /profile lights nothing ("More" takes the accent).
  assert.deepEqual(active(tabs, "/profile"), []);
});

test("an issues-only delegate gets the issue queue under its own name", () => {
  const items = visibleAdminNavItems({ role: "USER", permissions: Permission.MANAGE_ISSUES.toString() });
  assert.deepEqual(items.map((i) => i.href), ["/admin/issues"]);
  const tabs = buildMobileTabs(items, t);
  assert.equal(tabs[3].href, "/admin/issues");
  assert.equal(tabs[3].label, "nav.tab.issues");
  assert.deepEqual(active(tabs, "/admin/issues/abc"), ["/admin/issues"]);
});

test("the fourth slot never targets a page whose feature flag is off", () => {
  // Issues off: the issues-only delegate has nothing left, so Profile it is.
  const items = visibleAdminNavItems({ role: "USER", permissions: Permission.MANAGE_ISSUES.toString() }, { "feature.page.issues": false });
  assert.deepEqual(items, []);
  assert.equal(buildMobileTabs(items, t)[3].href, "/profile");
  // A requests manager plus issues: two items, so the admin tab (on the queue).
  const both = visibleAdminNavItems({ role: "USER", permissions: (Permission.MANAGE_REQUESTS | Permission.MANAGE_ISSUES).toString() });
  assert.equal(fourthTab(both), "admin");
  assert.equal(buildMobileTabs(both, t)[3].href, "/admin");
});

test("the sidebar and the tab bar share one admin-item helper", () => {
  for (const rel of ["../src/components/layout/sidebar.tsx", "../src/components/layout/mobile-nav.tsx"]) {
    const src = readFileSync(resolve(HERE, rel), "utf8");
    assert.match(src, /visibleAdminNavItems\(session\?\.user, featureFlags\)/, rel);
    assert.doesNotMatch(src, /getVisibleAdminItems\(/, `${rel}: a private copy of the admin-item rule`);
  }
});
