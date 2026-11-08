// Review 2026-09 P62 / f86: the /issues desktop pane is hidden below `xl` with
// CSS only, so the <IssueThread> inside it used to mount on every viewport and
// double the messages GET + SSE refetch alongside the mobile drawer's thread.
// The fix gates both threads on complementary media queries through
// useMediaQuery. The suite renders no React DOM, so these pins cover the two
// things a unit can: the hook's SSR contract (null — the guardrail-16 shape
// that keeps the server HTML and the hydration render identical) and the
// structural wiring (the page routes through the gated wrapper, the drawer
// through the shared hook, and the two queries are exact complements).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { useMediaQuery } from "@/hooks/use-media-query.ts";

function Probe() {
  const v = useMediaQuery("(min-width: 1280px)");
  return createElement("span", null, v === null ? "null" : String(v));
}

test("useMediaQuery renders null on the server (no viewport-dependent SSR output)", () => {
  const html = renderToString(createElement(Probe));
  assert.equal(html, "<span>null</span>");
});

test("useMediaQuery reports null when matchMedia is unavailable at snapshot time", () => {
  // Simulate a client environment with no matchMedia (thumbnail capture,
  // jsdom-less runtimes): the hook must degrade to null, never throw.
  const g = globalThis as { window?: unknown };
  const had = Object.prototype.hasOwnProperty.call(g, "window");
  const prev = g.window;
  g.window = {};
  try {
    const html = renderToString(createElement(Probe));
    assert.equal(html, "<span>null</span>");
  } finally {
    if (had) g.window = prev;
    else delete g.window;
  }
});

const DESKTOP_QUERY = "(min-width: 1280px)";
const MOBILE_QUERY = "(max-width: 1279.98px)";

test("/issues page mounts the thread through DesktopIssueThread, never IssueThread directly", () => {
  const page = readFileSync(new URL("../src/app/(app)/issues/page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(page, /from "@\/components\/issues\/issue-thread"/);
  assert.doesNotMatch(page, /<IssueThread\b/);
  assert.match(page, /<DesktopIssueThread key=\{selectedIssue\.id\} issueId=\{selectedIssue\.id\} \/>/);
});

test("desktop wrapper and mobile drawer gate on complementary media queries via useMediaQuery", () => {
  const desktop = readFileSync(
    new URL("../src/components/issues/desktop-issue-thread.tsx", import.meta.url),
    "utf8",
  );
  const drawer = readFileSync(
    new URL("../src/components/issues/issue-detail-mobile-drawer.tsx", import.meta.url),
    "utf8",
  );
  // The two queries are ONE pair of constants, beside the desktop wrapper.
  const constant = (name: string) => new RegExp(`export const ${name} = "([^"]+)";`).exec(desktop)?.[1];
  assert.equal(constant("ISSUE_DESKTOP_QUERY"), DESKTOP_QUERY);
  assert.equal(constant("ISSUE_MOBILE_QUERY"), MOBILE_QUERY);
  assert.match(desktop, /useMediaQuery\(ISSUE_DESKTOP_QUERY\)/);
  assert.match(desktop, /if \(isDesktop !== true\) return null;/);
  assert.match(drawer, /import \{ ISSUE_MOBILE_QUERY \} from "@\/components\/issues\/desktop-issue-thread";/);
  assert.match(drawer, /useMediaQuery\(ISSUE_MOBILE_QUERY\) === true/);
  assert.doesNotMatch(drawer, /useMediaQuery\("/, "no second copy of the breakpoint");
  // The drawer no longer keeps its own matchMedia effect — one gate implementation.
  assert.doesNotMatch(drawer, /window\.matchMedia/);
  // Sanity on the pair: same breakpoint, exclusive ranges.
  assert.equal(DESKTOP_QUERY, "(min-width: 1280px)");
  assert.equal(MOBILE_QUERY, "(max-width: 1279.98px)");
});

// /admin/issues had the same double mount: the selected card's thread (below
// xl, CSS only) or the standalone mobile detail's, plus the aside's (xl and up,
// CSS only) — two messages GETs and two live reloads per viewport.
test("/admin/issues mounts each thread through a media-query wrapper, never IssueThread directly", () => {
  const page = readFileSync(new URL("../src/app/(app)/admin/issues/page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(page, /from "@\/components\/issues\/issue-thread"/);
  assert.doesNotMatch(page, /<IssueThread\b/);
  assert.match(page, /<DesktopIssueThread key=\{selectedIssue\.id\} issueId=\{selectedIssue\.id\} \/>/, "the aside");
  assert.match(page, /<MobileIssueThread key=\{sel\.id\} issueId=\{sel\.id\} \/>/, "the standalone mobile detail");

  const shell = readFileSync(new URL("../src/components/admin/issue-card-shell.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(shell, /<IssueThread\b/);
  assert.match(shell, /<MobileIssueThread issueId=\{issueId\} \/>/, "the card's thread");

  const wrappers = readFileSync(new URL("../src/components/issues/desktop-issue-thread.tsx", import.meta.url), "utf8");
  const mobile = wrappers.slice(wrappers.indexOf("export function MobileIssueThread("));
  assert.match(mobile, /useMediaQuery\(ISSUE_MOBILE_QUERY\) === true/, "null (SSR/hydration) is 'not mounted'");
  assert.match(mobile, /if \(!isMobile\) return null;/);
});

test("/issues keeps the desktop pane when the page's list is empty but an issue is selected", () => {
  const page = readFileSync(new URL("../src/app/(app)/issues/page.tsx", import.meta.url), "utf8");
  // Only an empty list WITH nothing selected skips the grid (and its <aside>).
  assert.match(page, /\{issues\.length === 0 && !selectedIssue \? \(\s*emptyState\s*\) : \(\s*<div className="xl:grid/);
  assert.doesNotMatch(page, /\{issues\.length === 0 \? \(/, "the old gate dropped the aside with the list");
  assert.match(page, /\{issues\.length === 0 && emptyState\}/, "the empty state sits in the list column instead");
});

test("/issues marks the selected row for assistive tech, not only with its border", () => {
  const page = readFileSync(new URL("../src/app/(app)/issues/page.tsx", import.meta.url), "utf8");
  assert.match(page, /href=\{issueHref\(issue\.id\)\}\s*isSelected=\{issue\.id === selectedId\}/);
  assert.match(page, /href=\{href\}\s*scroll=\{false\}\s*aria-current=\{isSelected \? "true" : undefined\}/);
});

// A huge or repeated ?page= used to reach Prisma's skip unclamped (a number
// Postgres refuses, so the page 500'd). /issues clamps it like every paged list.
test("/issues clamps ?page= through the shared parsePageNumber", () => {
  const page = readFileSync(new URL("../src/app/(app)/issues/page.tsx", import.meta.url), "utf8");
  assert.match(page, /const page = parsePageNumber\(pageParam\);/);
  assert.doesNotMatch(page, /parseInt\(pageParam/, "no unclamped page parse");
});
