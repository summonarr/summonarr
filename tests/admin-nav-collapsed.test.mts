// The admin nav's collapsed groups ride a cookie (src/lib/admin-nav-collapsed.ts)
// as well as localStorage, so the (app) layout renders them closed on a hard
// load: before, every hard load painted every group open and then collapsed
// the stored ones after hydration, shifting the sidebar.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ADMIN_NAV_COLLAPSED_COOKIE, collapsedGroupsCookie, parseCollapsedGroupsCookie } from "../src/lib/admin-nav-collapsed.ts";

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

test("the cookie value names known groups only, each once", () => {
  assert.deepEqual(parseCollapsedGroupsCookie(undefined), []);
  assert.deepEqual(parseCollapsedGroupsCookie(""), []);
  assert.deepEqual(parseCollapsedGroupsCookie("library.system"), ["library", "system"]);
  assert.deepEqual(parseCollapsedGroupsCookie("library.bogus.library"), ["library"]);
  assert.deepEqual(parseCollapsedGroupsCookie("constructor.__proto__"), []);
});

test("the written cookie round-trips and is site-wide", () => {
  const cookie = collapsedGroupsCookie(["downloads", "insights"]);
  assert.match(cookie, new RegExp(`^${ADMIN_NAV_COLLAPSED_COOKIE}=downloads\\.insights; path=/; max-age=\\d+; samesite=lax$`));
  const value = cookie.slice(cookie.indexOf("=") + 1, cookie.indexOf(";"));
  assert.deepEqual(parseCollapsedGroupsCookie(value), ["downloads", "insights"]);
  assert.match(collapsedGroupsCookie([]), new RegExp(`^${ADMIN_NAV_COLLAPSED_COOKIE}=; `), "nothing collapsed clears the set");
});

test("the layout reads the cookie into the provider, and the nav starts from it and writes it on every change", () => {
  const layout = read("src/app/(app)/layout.tsx");
  assert.match(layout, /parseCollapsedGroupsCookie\(\(await cookies\(\)\)\.get\(ADMIN_NAV_COLLAPSED_COOKIE\)\?\.value\)/);
  assert.match(layout, /<NavBadgesProvider initial=\{navBadges\} enabled=\{isAdmin\} collapsedGroups=\{collapsedNavGroups\}>/);
  const nav = read("src/components/layout/admin-nav-groups.tsx");
  assert.match(nav, /<ServerCollapsedContext\.Provider value=\{collapsedGroups\}>/);
  assert.match(nav, /new Set\(serverCollapsed\)/);
  assert.match(nav, /setCollapsed\(stored\);\s*writeCollapsedCookie\(stored\);/, "a stored choice reaches the cookie");
  assert.match(nav, /setCollapsed\(next\);\s*writeCollapsedCookie\(next\);/, "a toggle writes the cookie");
});
