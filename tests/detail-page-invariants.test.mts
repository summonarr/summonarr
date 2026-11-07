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
//
// The last test applies rule 3's "no nullable session" check to the
// notifications page too, which had the same dead fallback branch.
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
    // A malformed or non-canonical id ("abc", "", "1.5", "1e3", " 12 ") is a
    // not-found BEFORE TMDB is asked — parseTmdbIdParam accepts canonical
    // digits only (tests/tmdb-id.test.mts pins the parser itself).
    const guard = /const tmdbId = parseTmdbIdParam\(id\);\s*if \(tmdbId === null \|\| !isTmdbIdInRange\(tmdbId\)\) notFound\(\);/.exec(src);
    assert.ok(guard, `${rel}: malformed ids short-circuit to notFound() through parseTmdbIdParam`);
    assert.ok(guard.index < fetchAt, `${rel}: the id guard must run before ${detailsFn}()`);
    assert.doesNotMatch(src, /Number\(id\)/, `${rel}: Number(id) accepts "1e3", "0x3E8" and " 12 "`);
  }
});

test("the person page and GET /api/person/[id] parse the id the same strict way", () => {
  const page = read("person/[id]/page.tsx");
  const guard = /const personId = parseTmdbIdParam\(id\);\s*if \(personId === null \|\| !isTmdbIdInRange\(personId\)\) notFound\(\);/.exec(page);
  assert.ok(guard, "person page: malformed ids short-circuit to notFound() through parseTmdbIdParam");
  assert.ok(guard.index < page.indexOf("getEnrichedPerson(personId"), "the guard precedes the TMDB-backed read");
  assert.ok(page.indexOf("await requireAppSession()") < guard.index, "the login gate still runs first");
  // The 404-by-message policy is unchanged.
  assert.match(page, /failed: 404\\b/);
  const route = readFileSync(join(process.cwd(), "src", "app", "api", "person", "[id]", "route.ts"), "utf-8");
  assert.match(route, /const personId = parseTmdbIdParam\(id\);/);
  assert.doesNotMatch(route, /Number\(id\)/);
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

// Both pages read their viewer-scoped state through ONE loader
// (src/lib/detail-page-data.ts), so the rules below are pinned there once.
const LOADER = readFileSync(join(process.cwd(), "src", "lib", "detail-page-data.ts"), "utf-8");

test("both detail pages load their state through the shared loader, after the gate-first details read", () => {
  for (const [rel, loader, type] of [["movie/[id]/page.tsx", "loadMovie", "MOVIE"], ["tv/[id]/page.tsx", "loadShow", "TV"]] as const) {
    const src = read(rel);
    const detailsAt = src.indexOf(`await ${loader}(id)`);
    const stateAt = src.indexOf(`loadDetailPageState(session, media, "${type}")`);
    assert.ok(detailsAt > 0 && stateAt > 0, `${rel}: expected the details read and the shared loader`);
    // Keyed on media.id, after TMDB's 404 check — never on the URL id.
    assert.ok(detailsAt < stateAt, `${rel}: the state read must follow the gate + details read`);
    // No positional tuple in the page body: a swapped boolean slot compiles
    // and mis-gates the UI. (The details loader's two-slot localize read is fine.)
    const body = src.slice(src.indexOf("export default async function"));
    assert.ok(!/\] = await Promise\.all\(\[/.test(body), `${rel}: a positional Promise.all destructure is back`);
  }
  assert.ok(!/\] = await Promise\.all\(\[/.test(LOADER), "the loader reads by name");
});

test("the 4K gate is getShow4kVisibility, not a page-local copy of it", () => {
  assert.match(LOADER, /show4k: getShow4kVisibility\(session, isMovie \? "movie" : "tv"\)/);
  for (const src of [LOADER, read("movie/[id]/page.tsx"), read("tv/[id]/page.tsx")]) {
    assert.doesNotMatch(src, /request4kAll/, "the server-wide 4K flag is read inside getShow4kVisibility only");
    assert.doesNotMatch(src, /isArrConfigured\(/, "'configured' is decided inside getShow4kVisibility only");
  }
  // 4K availability/queue state is shown only with the gate.
  assert.match(LOADER, /arr4kAvailable: reads\.show4k && /);
  assert.match(LOADER, /arr4kPending: reads\.show4k && /);
});

test("the library reads are scoped to the viewer's visible servers and never load the on-disk path", () => {
  for (const [model, scope, select] of [
    ["plexLibraryItem", "v.plex", "{ tmdbId: true }"],
    ["jellyfinLibraryItem", "v.jellyfin", "{ communityRating: true }"],
  ] as const) {
    const at = LOADER.indexOf(`prisma.${model}.findFirst({`);
    assert.ok(at > 0, `expected the ${model} read`);
    const call = LOADER.slice(at, LOADER.indexOf("}),", at));
    assert.ok(call.includes(`serverInstance: { in: ${scope} }`), `${model}: scoped to the visible instances (guardrail 35)`);
    assert.ok(call.includes(`select: ${select}`), `${model}: a narrow select keeps filePath (guardrail 37f) out of the page`);
  }
});

test("one request token per title, shared by every request action", () => {
  assert.equal((LOADER.match(/generateRequestToken\(/g) ?? []).length, 1);
  assert.match(LOADER, /requestToken: generateRequestToken\(tmdbId, mediaType, userId\)/);
  const row = readFileSync(join(process.cwd(), "src", "components", "media", "detail-actions.tsx"), "utf-8");
  assert.doesNotMatch(row, /generateRequestToken/);
  assert.equal((row.match(/requestToken=\{state\.requestToken\}/g) ?? []).length, 4, "RequestButton, 4K, each named instance, and the vote");
  for (const rel of Object.keys(PAGES)) assert.doesNotMatch(read(rel), /generateRequestToken/);
});

test("a failed side read on either detail page is logged under its source, then degrades to empty", () => {
  const movie = read("movie/[id]/page.tsx");
  assert.doesNotMatch(movie, /\.catch\(\(\) => \[\]\)/, "a silent swallow is back");
  for (const source of ["credits", "suggestions", "collection", "genres"]) {
    assert.ok(movie.includes(`.catch(warnEmpty("${source}"))`), `the ${source} read logs its failure`);
  }
  assert.match(movie, /emptyOnFailure\("movie-page", source, media\.id\)/);
  const tv = read("tv/[id]/page.tsx");
  assert.doesNotMatch(tv, /\.catch\(\(\) => \[\]\)/, "a silent swallow is back on the TV page");
  for (const source of ["credits", "suggestions", "genres"]) {
    assert.ok(tv.includes(`.catch(warnEmpty("${source}"))`), `the TV ${source} read logs its failure`);
  }
  assert.match(tv, /emptyOnFailure\("tv-page", source, media\.id\)/);
  // The admin arr links log under each page's own scope.
  assert.match(LOADER, /arrInstancesForTitle\(service, tmdbId\)\.catch\(emptyOnFailure\(isMovie \? "movie-page" : "tv-page", "arr-links", tmdbId\)\)/);
});
