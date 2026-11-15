// Small UI rules for the shared primitives and personal pages: the appearance
// picker's radio keys, a StatCard delta's tone, the toast regions, the theme's
// cross-tab sync, the watchlist cap, EmptyState's slots and the filter groups'
// names. The pure helpers are imported; the .tsx files are read as source,
// since node:test can't render them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { radioKeyTarget } from "../src/components/theme/radio-keys.ts";
import { deltaToneOf } from "../src/components/ui/design/delta-tone.ts";
import { isTheme } from "../src/lib/theme-constants.ts";

const src = (p: string) => readFileSync(p, "utf8");

test("the radio keys move and wrap the way the ARIA radio group pattern does", () => {
  assert.equal(radioKeyTarget("ArrowRight", 0, 3), 1);
  assert.equal(radioKeyTarget("ArrowDown", 2, 3), 0, "wraps forward");
  assert.equal(radioKeyTarget("ArrowLeft", 0, 3), 2, "wraps back");
  assert.equal(radioKeyTarget("ArrowUp", 1, 3), 0);
  assert.equal(radioKeyTarget("Home", 2, 3), 0);
  assert.equal(radioKeyTarget("End", 0, 3), 2);
  assert.equal(radioKeyTarget("Tab", 0, 3), null, "Tab leaves the group");
  assert.equal(radioKeyTarget("ArrowRight", 0, 0), null);
});

test("the standalone picker has one tab stop and answers the arrow keys", () => {
  const menu = src("src/components/theme/appearance-menu.tsx");
  assert.match(menu, /tabIndex=\{tabbable \? 0 : -1\}/);
  assert.match(menu, /onKeyDown=\{\(e\) => onKeyDown\(e, i\)\}/);
  // The menu form checks base-ui's untyped value before a setter sees it.
  assert.doesNotMatch(menu, /as Theme\)|as Accent\)/);
  assert.match(menu, /if \(isTheme\(v\)\) setTheme\(v\)/);
  assert.match(menu, /if \(isAccent\(v\)\) setAccent\(v\)/);
  assert.equal(isTheme("light"), true);
  assert.equal(isTheme("sepia"), false);
});

test("a delta's tone reads ASCII and Unicode signs and arrows", () => {
  assert.equal(deltaToneOf("+12%"), "up");
  assert.equal(deltaToneOf("-3"), "down");
  assert.equal(deltaToneOf("−4%"), "down", "Intl's signDisplay minus");
  assert.equal(deltaToneOf("▲ 2"), "up");
  assert.equal(deltaToneOf("↓ 2"), "down");
  assert.equal(deltaToneOf("0%"), "neutral");
  assert.equal(deltaToneOf(""), "neutral");
});

test("errors are announced assertively, the rest politely, and no timer is touched inside a state updater", () => {
  const toast = src("src/components/ui/toast.tsx");
  assert.match(toast, /<div aria-live="polite" className=\{STACK_CLASS\}>/);
  assert.match(toast, /aria-live="assertive"/);
  assert.match(toast, /const errors = toasts\.filter\(\(t\) => t\.variant === "error"\)/);
  assert.doesNotMatch(toast, /setToasts\(\(cur\)/, "the list is computed outside the updater");
  assert.match(toast, /pushCapped\(listRef\.current,/);
  // Removing a focused toast hands focus back.
  assert.match(toast, /if \(node && node\.contains\(document\.activeElement\) && back\?\.isConnected\) back\.focus\(\);/);
});

test("the theme follows another tab's change and reads <html> as its store", () => {
  const provider = src("src/components/theme/theme-provider.tsx");
  assert.match(provider, /window\.addEventListener\("storage", onStorage\)/);
  // One subscription serves both values: a second would apply each storage event twice.
  assert.match(provider, /useSyncExternalStore\(subscribeAppearance, readAppearance, \(\) => SERVER_APPEARANCE\)/);
  assert.equal(provider.match(/useSyncExternalStore\(/g)?.length, 1);
  assert.doesNotMatch(provider, /setThemeState|setAccentState/);
});

test("the watchlist page reads one row past the cap, so exactly the cap is not 'truncated'", () => {
  const page = src("src/app/(app)/watchlist/page.tsx");
  assert.match(page, /take: LIST_CAP \+ 1,/);
  assert.match(page, /const truncated = rows\.length > LIST_CAP;/);
  const grid = src("src/components/watchlist/watchlist-grid.tsx");
  assert.match(grid, /const capped = cap != null && truncated;/);
  assert.doesNotMatch(grid, /initialItems\.length >= cap/);
  // The grid is the server's latest list minus this page's own removes.
  assert.match(grid, /const visible = initialItems\.filter\(\(x\) => !removed\.has\(itemKey\(x\)\)\);/);
  assert.match(grid, /import \{ mediaHref \} from "@\/lib\/media-href";/);
  assert.doesNotMatch(grid, /`\/movie\/\$\{/);
});

test("EmptyState has one description slot, renders a numeric 0 and takes memo/forwardRef icons", () => {
  const es = src("src/components/ui/design/empty-state.tsx");
  assert.doesNotMatch(es, /subtitle/);
  assert.match(es, /\{hasContent\(title\) && \(/);
  assert.match(es, /"\$\$typeof" in icon && !isValidElement\(icon\)/);
});

test("pill and segment groups carry a name for screen readers; the clear button hovers in CSS", () => {
  const pills = src("src/components/user-list-filters.tsx");
  assert.match(pills, /role="group"\s+aria-label=\{label\}/);
  assert.doesNotMatch(pills, /onMouseEnter|currentTarget\.style/);
  assert.match(src("src/components/ui/design/filter-bar.tsx"), /role="group"\s+aria-label=\{label\}/);
  // FilterBar and SegmentedLinks share one segmented look.
  for (const f of ["src/components/ui/design/filter-bar.tsx", "src/components/ui/design/segmented-links.tsx"]) {
    assert.match(src(f), /segmentedItemStyle\(isActive\)/, f);
    assert.match(src(f), /SEGMENTED_TRACK_STYLE/, f);
  }
});
