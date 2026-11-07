// Source pins for the browse pages: /movies, /tv, /top, /popular and /for-you.
// They are server components that import .tsx, so the loader cannot mount them
// (same idiom as tests/detail-page-invariants.test.mts). Each pin names the
// defect it stops coming back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const APP = join(process.cwd(), "src", "app", "(app)");
const read = (rel: string) => readFileSync(join(APP, rel), "utf-8");

const PAGES = ["movies/page.tsx", "tv/page.tsx", "top/page.tsx", "popular/page.tsx", "for-you/page.tsx"];
// Other pages that read their query through the same shared helper.
const SHARED_READERS = ["page.tsx", "upcoming/page.tsx", "settings/page.tsx", "votes/page.tsx"];

test("searchParams is typed the way Next delivers it, and repeated keys take their first value", () => {
  // `?page=2&page=3` arrives as an ARRAY; a Record<string, string> type hid
  // that and let arrays reach parsers that expect a string.
  for (const rel of PAGES) {
    const src = read(rel);
    assert.doesNotMatch(src, /searchParams: Promise<Record<string, string>>/, `${rel} still declares string-only values`);
    assert.match(src, /searchParams: Promise<PageSearchParams>/, `${rel} must use the shared PageSearchParams type`);
    assert.match(src, /from "@\/lib\/search-params"/, `${rel} must normalise through src/lib/search-params.ts`);
    assert.doesNotMatch(src, /parseInt\(sp\.page/, `${rel} parses a raw (possibly array) page value`);
    assert.doesNotMatch(src, /new URLSearchParams\(sp\)/, `${rel} rebuilds a URL from the raw params`);
  }
});

test("no page declares string-only searchParams, and the other readers use the shared helper", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : e.name === "page.tsx" ? [join(dir, e.name)] : [],
    );
  const offenders = walk(join(process.cwd(), "src", "app")).filter((f) =>
    /searchParams: Promise<Record<string, string>>/.test(readFileSync(f, "utf-8")),
  );
  assert.deepEqual(offenders, [], "a repeated key arrives as an array; type the prop as PageSearchParams");
  for (const rel of SHARED_READERS) {
    const src = read(rel);
    assert.match(src, /searchParams: Promise<PageSearchParams>/, `${rel} must use the shared PageSearchParams type`);
    assert.match(src, /import \{ first, type PageSearchParams \} from "@\/lib\/search-params"/, `${rel} reads through the shared first()`);
    assert.doesNotMatch(src, /const first = /, `${rel} keeps a private copy of first()`);
    assert.doesNotMatch(src, /parseInt\(sp\.page/, `${rel} parses a raw (possibly array) page value`);
  }
});

test("the gated pages carry no dead nullable-session branches", () => {
  // requireAppSession() returns a session or redirects; an `if (!session)`
  // after it is unreachable and the `session?.` reads it forced were noise.
  for (const rel of ["popular/page.tsx", "top/page.tsx"]) {
    const src = read(rel);
    assert.match(src, /requireAppSession\(\)/);
    assert.doesNotMatch(src, /if \(!session\)/, `${rel}: unreachable null-session check`);
    assert.doesNotMatch(src, /session\?\./, `${rel}: nullable session read`);
  }
});

test("/popular logs a dropped title and validates its media type", () => {
  const src = read("popular/page.tsx");
  // A rejected TMDB resolve still drops the title (its rank was taken up
  // front), but no longer silently — the same line /api/popular logs.
  assert.match(src, /if \(r\.status === "rejected"\) \{\s*console\.error\(`\[popular\] \$\{type\} detail resolve failed:`/);
  // ?mediaType=foo showed both sections with no tab marked and was copied into
  // every link.
  assert.match(src, /rawMediaType === "movies" \|\| rawMediaType === "tv" \? rawMediaType : undefined/);
  assert.doesNotMatch(src, /sp\.mediaType \|\| undefined/);
});

test("/popular and /api/popular take attachAllAvailability's typed result without a cast", () => {
  for (const file of [join(APP, "popular/page.tsx"), join(process.cwd(), "src/app/api/popular/route.ts")]) {
    const src = readFileSync(file, "utf-8");
    assert.match(src, /attachAllAvailability\(items, session\.user\.id, \{ show4k \}\)/);
    assert.doesNotMatch(src, /as EnrichedMedia\[\]/, `${file}: the enrichment result is cast`);
  }
});

test("/popular's two segmented controls share the design-system styling", () => {
  // Both were hand-copied link tracks whose bg-3 active fill was ~1.07:1
  // against the bg-1 track in light mode.
  const src = read("popular/page.tsx");
  assert.equal(src.split("<SegmentedLinks").length - 1, 2);
  assert.doesNotMatch(src, /var\(--ds-bg-3\)/);
  const control = readFileSync(join(process.cwd(), "src/components/ui/design/segmented-links.tsx"), "utf-8");
  assert.match(control, /inset 0 0 0 1px var\(--ds-border-strong\)/);
  assert.match(control, /aria-current=\{isActive \? "page" : undefined\}/);
});

for (const [rel, genres] of [["movies/page.tsx", "getMovieGenres"], ["tv/page.tsx", "getTVGenres"]] as const) {
  test(`${rel}: genre names follow the viewer's language and failures are logged`, () => {
    const src = read(rel);
    // A language-keyed genre list has its own cache key; the English one the
    // warm cron fills is untouched (guardrail 40a).
    assert.match(src, new RegExp(`${genres}\\(tmdbLanguageFor\\(locale\\)\\)`));
    // A TMDB outage on SSR used to leave no server-side trace at all.
    assert.match(src, /\.catch\(\(err: unknown\) => \{\s*console\.error\("\[browse\] \w+ page query failed:"/);
    assert.match(src, /console\.warn\("\[browse\] \w+ genre list failed:"/);
    assert.match(src, /console\.warn\("\[browse\] \w+ watch-provider list failed:"/);
    // One filter parser and one "any filter?" predicate (browse-filters.ts).
    assert.match(src, /parseBrowseFilters\(searchParamGetter\(sp\)\)/);
    assert.match(src, /hasActiveFilters\(browseFilters\)/);
  });
}
