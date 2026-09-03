// Structural drift pins for the two media detail pages — movie/[id] and tv/[id].
//
// Why SOURCE-level tests: both pages import .tsx components, so the node:test
// loader cannot load them (see tests/_loader.mjs), and the things pinned here
// are exactly the kind that compile, lint and render fine while being wrong.
// Same idiom as tests/app-page-auth-guard.test.mts.
//
// Three rules are pinned:
//   1. Every attachAllAvailability() call on a detail page passes `show4k`.
//      attach-all.ts gates attachArrPending on `options?.show4k ?? false` and
//      leaves arr4kAvailable/arr4kPending undefined otherwise, so a call that
//      omits it renders MediaCard rows (Similar, Collection) with no 4K chips
//      while the hero beside them shows the 4K badge for the same titles. The
//      movie page's Similar + Collection rows shipped that way.
//   2. A TMDB details failure is a 404 ONLY when TMDB itself said 404. tmdbFetch
//      throws a plain `TMDB <path> failed: <status>` for every non-2xx (5xx
//      included), plus a missing-credentials Error and 429 exhaustion; a bare
//      `catch { notFound() }` mapped all of them to the "might have been
//      removed" page for a title that exists, instead of the (app)/error.tsx
//      boundary with its retry. The person page's `/failed: 404\b/` shape is
//      the established policy; both detail pages must match it.
//   3. The requireAppSession() gate still precedes the TMDB fetch (the RSC
//      layout-skip ordering the in-page comment explains), and no nullable
//      `session ?` / `session?.` / `session &&` leftovers remain — the gate
//      returns a non-null SummonarrSession or redirects, and the dead branches
//      obscured that guarantee (one of them minted a request token for the
//      empty user id).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APP_DIR = join(process.cwd(), "src", "app", "(app)");
const PAGES = {
  "movie/[id]/page.tsx": { detailsFn: "getMovieDetails" },
  "tv/[id]/page.tsx": { detailsFn: "getTVDetails" },
} as const;

const read = (rel: string) => readFileSync(join(APP_DIR, rel), "utf-8");

// Grab every `attachAllAvailability(` call up to its closing `)` at the same
// nesting depth, so the options object is inspected per call rather than by a
// file-wide substring (which would pass if ONE call carried show4k).
function attachCalls(src: string): string[] {
  const calls: string[] = [];
  const marker = "attachAllAvailability(";
  let from = src.indexOf(marker);
  while (from !== -1) {
    let depth = 0;
    let i = from + marker.length - 1;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === "(" || ch === "{" || ch === "[") depth++;
      else if (ch === ")" || ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) break;
      }
    }
    calls.push(src.slice(from, i + 1));
    from = src.indexOf(marker, i);
  }
  return calls;
}

test("every attachAllAvailability call on a detail page passes show4k", () => {
  for (const rel of Object.keys(PAGES)) {
    const src = read(rel);
    // Both pages import the helper; a zero count means the scan is broken, not clean.
    assert.ok(src.includes('from "@/lib/attach-all"'), `${rel} should import attachAllAvailability`);
    const calls = attachCalls(src);
    assert.ok(calls.length >= 1, `${rel}: expected at least one attachAllAvailability() call`);
    for (const call of calls) {
      assert.match(
        call,
        /\bshow4k\b/,
        `${rel}: ${call.split("\n")[0]} omits show4k — attach-all.ts leaves arr4kAvailable/arr4kPending ` +
          `undefined without it, so this row's MediaCards never show 4K chips`,
      );
    }
  }
  // The movie page is the one that shipped without it, on two calls (Similar + Collection).
  assert.ok(attachCalls(read("movie/[id]/page.tsx")).length >= 2, "movie page should enrich both suggestions and the collection");
});

test("a TMDB details failure maps to notFound() ONLY on a genuine 404", () => {
  for (const [rel, { detailsFn }] of Object.entries(PAGES)) {
    const src = read(rel);
    assert.doesNotMatch(
      src,
      /catch\s*(\([^)]*\))?\s*\{\s*notFound\(\);?\s*\}/,
      `${rel}: a bare catch → notFound() renders the 404 page for a TMDB outage/timeout/5xx ` +
        `on a title that exists; only a "failed: 404" message may map to notFound()`,
    );
    assert.match(
      src,
      /failed: 404\\b/,
      `${rel}: expected the person-page shape — \`if (/failed: 404\\b/.test(message)) notFound(); throw err;\``,
    );
    // The rethrow is what reaches (app)/error.tsx; without it every failure is swallowed.
    const fetchAt = src.indexOf(`${detailsFn}(`);
    assert.ok(fetchAt > 0, `${rel}: expected a ${detailsFn}() call`);
    const catchBlock = src.slice(fetchAt, src.indexOf("});", fetchAt));
    assert.match(catchBlock, /throw err;/, `${rel}: the non-404 branch must rethrow to the error boundary`);
    // Number(id) on "abc" is NaN and on "" is 0 — neither should reach TMDB.
    assert.match(src, /Number\.isFinite\(tmdbId\)\s*\|\|\s*tmdbId <= 0\)\s*notFound\(\)/, `${rel}: malformed ids short-circuit to notFound()`);
  }
});

test("requireAppSession() precedes the TMDB fetch and leaves no nullable-session dead code", () => {
  for (const [rel, { detailsFn }] of Object.entries(PAGES)) {
    const src = read(rel);
    const gateAt = src.indexOf("await requireAppSession()");
    const fetchAt = src.indexOf(`await ${detailsFn}(`);
    assert.ok(gateAt > 0 && fetchAt > 0, `${rel}: expected both the gate and the fetch`);
    assert.ok(gateAt < fetchAt, `${rel}: the login gate must run before the TMDB fetch (quota + cache-write burn on the layout-skip path)`);
    for (const dead of [/\bsession\s*\?\s/, /\bsession\?\./, /\bsession\s*&&/, /session\?\.user\.id \?\? ""/]) {
      assert.doesNotMatch(
        src,
        dead,
        `${rel}: requireAppSession() returns a non-null SummonarrSession or redirects — a \`${dead.source}\` branch is unreachable`,
      );
    }
  }
});

test("the notifications page always reads the caller's own rows (no nullable-session fallback)", () => {
  const src = read("notifications/page.tsx");
  assert.ok(src.includes("await requireAppSession()"));
  assert.doesNotMatch(src, /\bsession\s*\?\s/, "the `session ? … : [[], 0]` branch is unreachable after requireAppSession()");
  assert.match(src, /prisma\.notification\.findMany\(\{\s*where: \{ userId: session\.user\.id \}/);
});
