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
// start signal is dropped. The URL half of the click filter is a pure module
// (navigation-progress-rules.ts), tested directly below.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(process.cwd(), "src/components/layout/navigation-progress.tsx"),
  "utf8",
);
const RULES = readFileSync(
  resolve(process.cwd(), "src/components/layout/navigation-progress-rules.ts"),
  "utf8",
);
const { startsAppNavigation } = await import("../src/components/layout/navigation-progress-rules.ts");

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
    /startsAppNavigation\(anchor\.href, window\.location\)/,
  ]) {
    assert.match(SRC, guard, `missing guard: ${guard}`);
  }
  assert.match(RULES, /next\.origin !== here\.origin/);
  assert.match(RULES, /next\.href === here\.href/);
});

test("only a link to another page of this app starts the bar", () => {
  const here = { href: "https://app.example/movies?genreId=28", origin: "https://app.example", pathname: "/movies", search: "?genreId=28" };
  assert.equal(startsAppNavigation("/tv", here), true);
  assert.equal(startsAppNavigation("/movies?genreId=12", here), true, "a query-only change is a navigation");
  assert.equal(startsAppNavigation("https://app.example/movie/603", here), true);
  assert.equal(startsAppNavigation("https://elsewhere.example/tv", here), false, "another origin leaves the app");
  assert.equal(startsAppNavigation("/movies?genreId=28", here), false, "the same URL commits nothing");
  assert.equal(startsAppNavigation("#cast", here), false, "a hash-only link commits nothing");
  assert.equal(startsAppNavigation("/movies?genreId=28#top", here), false);
  assert.equal(startsAppNavigation("http://[bad", here), false, "an unparseable href starts nothing");
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
  assert.match(SRC, /\}, \[url, finish\]\)/, "the completion effect must depend on the full url");
});
