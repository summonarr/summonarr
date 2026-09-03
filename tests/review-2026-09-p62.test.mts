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
  assert.match(page, /<DesktopIssueThread issueId=\{selectedIssue\.id\} \/>/);
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
  assert.match(desktop, /useMediaQuery\("\(min-width: 1280px\)"\)/);
  assert.match(desktop, /if \(isDesktop !== true\) return null;/);
  assert.match(drawer, /useMediaQuery\("\(max-width: 1279\.98px\)"\) === true/);
  // The drawer no longer keeps its own matchMedia effect — one gate implementation.
  assert.doesNotMatch(drawer, /window\.matchMedia/);
  // Sanity on the pair: same breakpoint, exclusive ranges.
  assert.equal(DESKTOP_QUERY, "(min-width: 1280px)");
  assert.equal(MOBILE_QUERY, "(max-width: 1279.98px)");
});
