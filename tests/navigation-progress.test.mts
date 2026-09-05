// Structural pins for src/components/layout/navigation-progress.tsx.
//
// The bar used to start by monkey-patching history.pushState. That cannot work
// on the App Router: pushState is called from a useInsertionEffect keyed on the
// router state, i.e. in the commit that ALREADY carries the new URL — the same
// commit in which usePathname()/useSearchParams() return it. Start and completion
// therefore fired together, so the bar never covered the RSC fetch it exists for
// and only flashed 0→100 after the navigation had already landed.
//
// The component is a .tsx client module, so the node:test loader cannot import
// it; these read the source. They fail loudly if the patch returns or if either
// start signal is dropped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(process.cwd(), "src/components/layout/navigation-progress.tsx"),
  "utf8",
);

test("the bar does not patch history.pushState", () => {
  assert.doesNotMatch(
    SRC,
    /history\.pushState\s*=/,
    "assigning to history.pushState reinstates a start signal that only fires after the navigation commits",
  );
});

test("navigation start comes from a capture-phase click plus popstate", () => {
  // Capture phase specifically: the router handles the click too, and a bubble
  // listener can be beaten by a handler that stops propagation.
  assert.match(
    SRC,
    /addEventListener\(\s*"click"\s*,\s*\w+\s*,\s*true\s*\)/,
    "the click listener must be registered in the capture phase",
  );
  assert.match(SRC, /addEventListener\("popstate"/, "back/forward emits no click");
  assert.match(SRC, /removeEventListener\(\s*"click"\s*,\s*\w+\s*,\s*true\s*\)/);
  assert.match(SRC, /removeEventListener\("popstate"/);
});

test("clicks the browser handles itself never start the bar", () => {
  // Each of these commits no in-app navigation, so the completion effect would
  // never fire and the bar would ride its stall timeout for nothing.
  for (const guard of [
    /defaultPrevented/,
    /e\.button !== 0/,
    /metaKey/,
    /ctrlKey/,
    /shiftKey/,
    /altKey/,
    /hasAttribute\("download"\)/,
    /target && target !== "_self"/,
    /next\.origin !== window\.location\.origin/,
    /next\.href === window\.location\.href/,
  ]) {
    assert.match(SRC, guard, `missing guard: ${guard}`);
  }
});

test("an SVG anchor is rejected by type, not by truthiness", () => {
  // closest("a") also matches SVGAElement, whose href is an SVGAnimatedString —
  // `new URL(anchor.href)` would throw or resolve nonsense.
  assert.match(SRC, /instanceof HTMLAnchorElement/);
});

test("a navigation that never commits cannot leave the bar pinned", () => {
  assert.match(SRC, /STALL_TIMEOUT_MS/, "a started bar needs a give-up timer");
  assert.match(SRC, /const STALL_TIMEOUT_MS = \d+/);
});

test("completion is keyed on the full URL, not the pathname alone", () => {
  // A query-only navigation (every filter surface in this app) changes no
  // pathname; keying on it left the bar pinned across the viewport.
  assert.match(SRC, /useSearchParams\(\)/);
  assert.match(SRC, /const url = `\$\{pathname\}\?\$\{searchParams\.toString\(\)\}`/);
  assert.match(SRC, /\}, \[url, stop\]\)/, "the completion effect must depend on the full url");
});
