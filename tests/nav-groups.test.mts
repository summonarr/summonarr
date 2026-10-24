// The admin nav's groups and its Radarr/Sonarr gate (src/lib/nav-items.ts,
// rendered by src/components/layout/admin-nav-groups.tsx in the sidebar and
// the mobile drawer).
//
// What is pinned:
//   1. Every admin item sits in exactly the group it was placed in, the list is
//      in group order (the mobile tab bar opens the FIRST visible admin item, so
//      the request queue must stay first), and an empty group is never drawn.
//   2. Summonarr's own Blacklist is named "Request Blacklist" — never confusable
//      with Radarr/Sonarr's release Blocklist.
//   3. The Radarr/Sonarr pages need EITHER integration on (an any-of gate), keep
//      the nav's fail-open rule (only an explicit false hides), and each page
//      enforces the same gate in its own source — a hidden link is not a
//      disabled page.
//   4. Both nav surfaces render the groups and pass the badges through.
//
// The icon barrel is stubbed exactly as tests/nav-items.test.mts does (its
// exports generated from the real barrel), so nav-items.ts loads under the
// strip-only TS runner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ICONS_BARREL = resolve(HERE, "../src/components/icons/index.ts");
const VIRTUAL_ICONS = "summonarr-test:icons-nav-groups";
const iconNames = [...readFileSync(ICONS_BARREL, "utf8").matchAll(/export \{ (\w+) \} from/g)].map((m) => m[1]);
if (iconNames.length < 50) throw new Error(`icon barrel parse produced only ${iconNames.length} names`);
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

const {
  adminNavItems,
  ADMIN_NAV_GROUPS,
  NAV_ITEM_ANY_FEATURE_KEYS,
  NAV_BADGE_LABEL_KEYS,
  filterNavByFeatures,
  getVisibleAdminItems,
  groupAdminNavItems,
} = await import("../src/lib/nav-items.ts");
const { Permission } = await import("../src/lib/permissions.ts");

const hrefs = (items: readonly { href: string }[]) => items.map((i) => i.href);
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const ARR_PAGES = ["/admin/queue", "/admin/missing", "/admin/arr-calendar", "/admin/arr-history", "/admin/arr-system"];
const OFF = { "feature.integration.radarr": false, "feature.integration.sonarr": false };

// ── 1: groups ────────────────────────────────────────────────────────────────

test("every admin item is in exactly the group it belongs to", () => {
  const byGroup = Object.fromEntries(groupAdminNavItems(adminNavItems).map((g) => [g.id, hrefs(g.items)]));
  assert.deepEqual(byGroup, {
    requests: ["/admin", "/admin/issues", "/admin/users", "/admin/blacklist"],
    downloads: ["/admin/queue", "/admin/missing", "/admin/arr-calendar", "/admin/arr-history", "/admin/arr-system", "/admin/trash-guides"],
    library: ["/admin/library", "/admin/never-watched", "/admin/cleanup", "/admin/watch-sync"],
    insights: ["/admin/stats", "/admin/activity", "/admin/audit-log"],
    system: ["/admin/backup", "/admin/api-docs", "/settings"],
  });
  for (const item of adminNavItems) assert.ok(item.group, `${item.href} has no group — it would be filed under System by default`);
});

test("the admin list is in GROUP order, so the request queue is the first item (the mobile Admin tab opens it)", () => {
  const order = ADMIN_NAV_GROUPS.map((g) => g.id);
  const seen = adminNavItems.map((i) => order.indexOf(i.group!));
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b), "a group's items are not contiguous / in group order");
  assert.equal(adminNavItems[0].href, "/admin");
});

test("a group with nothing visible is not drawn — a delegated user sees no empty headers", () => {
  assert.deepEqual(groupAdminNavItems(getVisibleAdminItems("ISSUE_ADMIN")).map((g) => [g.id, hrefs(g.items)]), [["requests", ["/admin/issues"]]]);
  const managers = getVisibleAdminItems({ permissions: Permission.MANAGE_USERS | Permission.MANAGE_REQUESTS });
  assert.deepEqual(groupAdminNavItems(managers).map((g) => g.id), ["requests"]);
  assert.deepEqual(groupAdminNavItems([]), []);
});

test("group headers are translated from literal catalog keys", () => {
  const en = JSON.parse(readFileSync(resolve(HERE, "../src/lib/i18n/messages/en/nav.json"), "utf8")) as Record<string, string>;
  for (const g of ADMIN_NAV_GROUPS) assert.ok(en[g.i18nKey], `${g.i18nKey} is missing from en/nav.json`);
});

// ── 2: the rename ────────────────────────────────────────────────────────────

test("Summonarr's own Blacklist reads 'Request Blacklist', never a bare 'Blacklist'", () => {
  assert.equal(adminNavItems.find((i) => i.href === "/admin/blacklist")?.label, "Request Blacklist");
  assert.ok(!adminNavItems.some((i) => i.label === "Blacklist"));
});

// ── 3: the any-of Radarr/Sonarr gate ─────────────────────────────────────────

test("the Radarr/Sonarr pages hide when BOTH integrations are off, and only those", () => {
  const out = hrefs(filterNavByFeatures(adminNavItems, OFF));
  for (const href of ARR_PAGES) assert.ok(!out.includes(href), `${href} survived both integrations being off`);
  assert.deepEqual(out, hrefs(adminNavItems).filter((h) => !ARR_PAGES.includes(h)), "an unrelated item was hidden (TRaSH Guides keeps its own flag)");
});

test("EITHER integration is enough — a Sonarr-only install keeps its download pages", () => {
  for (const flags of [
    { "feature.integration.radarr": false, "feature.integration.sonarr": true },
    { "feature.integration.radarr": true, "feature.integration.sonarr": false },
  ]) {
    const out = hrefs(filterNavByFeatures(adminNavItems, flags));
    for (const href of ARR_PAGES) assert.ok(out.includes(href), `${href} hidden with ${JSON.stringify(flags)}`);
  }
});

test("the any-of gate keeps the nav's fail-open rule: absent flags (or no flag map at all) show the pages", () => {
  assert.deepEqual(hrefs(filterNavByFeatures(adminNavItems, {})), hrefs(adminNavItems));
  assert.deepEqual(hrefs(filterNavByFeatures(adminNavItems, { "feature.integration.radarr": false })), hrefs(adminNavItems));
  assert.deepEqual(hrefs(filterNavByFeatures(adminNavItems, undefined)), hrefs(adminNavItems));
});

test("every any-of entry is a real nav item gated on REGISTERED flags", () => {
  const featuresSrc = readFileSync(resolve(HERE, "../src/lib/features.ts"), "utf8");
  const registered = new Set([...featuresSrc.matchAll(/key: "([^"]+)"/g)].map((m) => m[1]));
  assert.deepEqual(Object.keys(NAV_ITEM_ANY_FEATURE_KEYS).sort(), [...ARR_PAGES].sort());
  for (const [href, keys] of Object.entries(NAV_ITEM_ANY_FEATURE_KEYS)) {
    assert.ok(hrefs(adminNavItems).includes(href), `${href} is not an admin nav item`);
    assert.ok(keys.length > 1, `${href}: an any-of gate with one flag belongs in NAV_ITEM_FEATURE_KEY`);
    for (const k of keys) assert.ok(registered.has(k), `${href} is gated on unregistered "${k}" — it could never hide`);
  }
});

test("each gated page enforces the same gate in its own source — the link is hidden AND the page reads nothing", () => {
  // The arr pages render their "nothing configured" state through
  // enabledArrInstances (which skips a switched-off integration) or an inline
  // feature.integration.<service> check — not requireFeature, which takes one flag.
  // Live code only: comments are stripped (the `[^:]` guard keeps a `https://`
  // in a string), and the gate must be an AWAITED call — a comment or a string
  // naming enabledArrInstances() is not a gate.
  const appDir = resolve(HERE, "../src/app/(app)");
  for (const href of Object.keys(NAV_ITEM_ANY_FEATURE_KEYS)) {
    const file = resolve(appDir, `.${href}`, "page.tsx");
    assert.ok(existsSync(file), `${href} has no page`);
    const code = stripComments(readFileSync(file, "utf8"));
    assert.ok(
      /await\s+enabledArrInstances\(/.test(code) || /await\s+isFeatureEnabled\(`feature\.integration\.\$\{service\}`\)/.test(code),
      `${href} is hidden by the Radarr/Sonarr gate in the nav but its page never checks the integrations ` +
        "(if it gates through a new helper, extend this pattern — don't loosen it to a substring)",
    );
  }
  const admin = readFileSync(resolve(HERE, "../src/lib/arr-admin.ts"), "utf8");
  assert.ok(admin.includes("isFeatureEnabled(`feature.integration.${service}`)"), "enabledArrInstances no longer honours the integration flags");
});

test("a NEW Radarr/Sonarr page can't ship ungated — the registry is checked from BOTH sides", () => {
  // The tests above only visit Object.keys(NAV_ITEM_ANY_FEATURE_KEYS): a sixth
  // arr page added to the nav without an entry trips nothing but the group
  // list (which its author then extends), and its page is never asked for a
  // gate. So every downloads-group item (TRaSH Guides keeps its own single
  // flag) and every admin page BUILT ON the arr libs — the five page
  // components, enabledArrInstances, or a page's own arr data module — must be
  // in the registry. The issues and users pages import the instance registry
  // for per-instance icons and grants; they are not arr pages and stay out.
  const gated = new Set(Object.keys(NAV_ITEM_ANY_FEATURE_KEYS));
  for (const item of adminNavItems) {
    if (item.group === "downloads" && item.href !== "/admin/trash-guides") {
      assert.ok(gated.has(item.href), `${item.href} sits in the downloads group but is not in NAV_ITEM_ANY_FEATURE_KEYS`);
    }
  }
  const ARR_PAGE_IMPORT =
    /from "@\/(components\/admin\/(download-queue|missing-report|arr-calendar|arr-download-history|arr-system)|lib\/(arr-admin|arr-missing-data|arr-calendar-days|arr-history|arr-queue-data|arr-system-data))"/;
  const adminDir = resolve(HERE, "../src/app/(app)/admin");
  let found = 0;
  for (const entry of readdirSync(adminDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = resolve(adminDir, entry.name, "page.tsx");
    if (!existsSync(file)) continue;
    if (!ARR_PAGE_IMPORT.test(stripComments(readFileSync(file, "utf8")))) continue;
    found++;
    assert.ok(gated.has(`/admin/${entry.name}`), `/admin/${entry.name} is built on the Radarr/Sonarr libs but is not in NAV_ITEM_ANY_FEATURE_KEYS`);
  }
  assert.equal(found, ARR_PAGES.length, "the import scan must find exactly the registered arr pages — extend ARR_PAGE_IMPORT if a page gates through a new module");
});

// ── 4: the renderers ─────────────────────────────────────────────────────────

test("badge labels are keyed by real admin hrefs and have plural forms", () => {
  const en = JSON.parse(readFileSync(resolve(HERE, "../src/lib/i18n/messages/en/nav.json"), "utf8")) as Record<string, string>;
  for (const [href, key] of Object.entries(NAV_BADGE_LABEL_KEYS)) {
    assert.ok(hrefs(adminNavItems).includes(href), href);
    assert.ok(en[`${key}_one`] && en[`${key}_other`], `${key} needs _one/_other`);
  }
});

test("the sidebar and the drawer both draw the groups and pass the badges to the items", () => {
  for (const rel of ["../src/components/layout/sidebar.tsx", "../src/components/layout/mobile-nav-drawer.tsx"]) {
    const src = readFileSync(resolve(HERE, rel), "utf8");
    assert.ok(/<AdminNavGroupList[\s\S]*?badges=\{navBadges\}/.test(src), `${rel} does not render AdminNavGroupList with the badges`);
    assert.ok(/badge=\{navBadges\?\.\[item\.href\]\}/.test(src), `${rel} does not pass an item its badge`);
  }
  const mobile = readFileSync(resolve(HERE, "../src/components/layout/mobile-nav.tsx"), "utf8");
  assert.ok(/<MobileNavDrawer[\s\S]*?navBadges=\{navBadges\}/.test(mobile), "MobileNav drops the badges on the way to the drawer");
});

test("a group header is a real disclosure button, and collapsing never hides the current page", () => {
  const src = readFileSync(resolve(HERE, "../src/components/layout/admin-nav-groups.tsx"), "utf8");
  assert.match(src, /<button[\s\S]*?aria-expanded=\{!isCollapsed\}[\s\S]*?aria-controls=\{listId\}/);
  assert.match(src, /isCollapsed \? g\.items\.filter\(isActive\) : g\.items/);
  // Collapsed state is read after mount (guardrail 16): the server render has every group open.
  assert.match(src, /useState<ReadonlySet<AdminNavGroup>>\(\(\) => new Set\(\)\)/);
  assert.match(src, /useEffect\(\(\) => \{\s*const apply = \(\) => \{\s*const stored = readStoredCollapsed\(\);/);
});

test("the sidebar and the drawer stay in step on ONE storage key: a toggle re-reads storage, writes, and tells every mounted instance", () => {
  const src = stripComments(readFileSync(resolve(HERE, "../src/components/layout/admin-nav-groups.tsx"), "utf8"));
  const toggle = /function toggle\(id: AdminNavGroup\) \{([\s\S]*?)\n  \}/.exec(src)?.[1] ?? "";
  assert.ok(toggle, "toggle not found");
  // Built from what is stored, not this instance's possibly stale copy.
  assert.match(toggle, /new Set\(readStoredCollapsed\(\) \?\? collapsed\)/);
  // The write is announced, AFTER it lands.
  assert.match(toggle, /localStorage\.setItem\(STORAGE_KEY,[\s\S]*?\);\s*window\.dispatchEvent\(new Event\(SYNC_EVENT\)\)/);
  // Every instance listens (and stops listening when the drawer unmounts).
  const effect = /useEffect\(\(\) => \{([\s\S]*?)\n  \}, \[\]\);/.exec(src)?.[1] ?? "";
  assert.match(effect, /window\.addEventListener\(SYNC_EVENT, apply\)/);
  assert.match(effect, /window\.removeEventListener\(SYNC_EVENT, apply\)/);
  assert.match(effect, /window\.addEventListener\("storage", apply\)/);
  assert.match(effect, /window\.removeEventListener\("storage", apply\)/);
});
