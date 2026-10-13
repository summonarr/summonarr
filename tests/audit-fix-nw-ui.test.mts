// Audit fixes (unit nw-ui) — the never-watched surfaces outside the report:
//   - C002: the /admin/stats "Never watched" line said "Everything in the
//     library has been played at least once" whenever the report counted zero
//     never-watched titles and seasons — which is ALSO what it counts when
//     nothing could be judged (tracking off, a fresh install, a server with no
//     recorded history, only soft matches). `neverWatchedLine` decides.
//   - C003: the line was pluralized on the TITLE count only, so its seasons
//     clause read "plus 1 unwatched seasons" and "plus 0 unwatched seasons
//     (0 B)". Each clause now has its own plural key and is left out at zero.
//   - C066: never-watched-report.tsx's reload ran the loader captured at click
//     time, so a slow action (upstream check, protect, delete) re-fetched the
//     old tab/page with a newer loadSeq and painted it over the view on screen.
//   - C072: the table cast the previous tab's rows to the current tab's row
//     type during a tab switch ("Season undefined").
// No DB, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pure = await import("../src/lib/admin-stats.ts");
const { createTranslator } = await import("../src/lib/i18n/translate.ts");
const { CATALOGS, FALLBACK_MESSAGES } = await import("../src/lib/i18n/catalogs.ts");

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const base = { titles: 0, seasons: 0, unknown: 0, possible: 0, trackingOn: true };

// ── C002 ────────────────────────────────────────────────────────────────────

test("C002: zero never-watched with unjudged titles is not 'everything was played'", () => {
  assert.deepEqual(pure.neverWatchedLine({ ...base, unknown: 40 }), { kind: "unjudged" });
  assert.deepEqual(pure.neverWatchedLine({ ...base, possible: 3 }), { kind: "unjudged" });
});

test("C002: tracking off is said as such, never as 'everything was played'", () => {
  assert.deepEqual(pure.neverWatchedLine({ ...base, trackingOn: false }), { kind: "trackingOff" });
  assert.deepEqual(pure.neverWatchedLine({ ...base, trackingOn: false, unknown: 12 }), { kind: "trackingOff" });
});

test("C002: 'none' only when tracking is on and every title and season was judged", () => {
  assert.deepEqual(pure.neverWatchedLine(base), { kind: "none" });
});

test("C002: a never-watched count is reported whatever else is unjudged", () => {
  assert.deepEqual(pure.neverWatchedLine({ ...base, titles: 2, unknown: 9 }), { kind: "value", showTitles: true, showSeasons: false });
});

test("C002: the data layer passes the unjudged counts and the tracking switch to the page", () => {
  const src = read("src/lib/admin-stats-data.ts");
  assert.match(src, /const \{ totals, seasons, trackingOn \} = await getNeverWatchedReport\(\);/);
  assert.match(src, /unknown: totals\.unknown \+ seasons\.filter\(\(s\) => s\.state === "unobservable"\)\.length,/);
  assert.match(src, /possible: totals\.possible \+ seasons\.filter\(\(s\) => s\.state === "possiblyWatched"\)\.length,/);
  assert.match(src, /\n\s+trackingOn,\n/);
  const page = read("src/app/(app)/admin/stats/page.tsx");
  assert.match(page, /const line = neverWatchedLine\(nw\);/);
  assert.doesNotMatch(page, /neverWatched\.titles === 0 && storage\.neverWatched\.seasons === 0/);
});

// ── C003 ────────────────────────────────────────────────────────────────────

test("C003: each clause is shown only when it has something to count", () => {
  assert.deepEqual(pure.neverWatchedLine({ ...base, titles: 3 }), { kind: "value", showTitles: true, showSeasons: false });
  assert.deepEqual(pure.neverWatchedLine({ ...base, seasons: 4 }), { kind: "value", showTitles: false, showSeasons: true });
  assert.deepEqual(pure.neverWatchedLine({ ...base, titles: 1, seasons: 1 }), { kind: "value", showTitles: true, showSeasons: true });
});

test("C003: the seasons clause is plural on its own count, in every catalog", () => {
  const en = createTranslator("en", CATALOGS.en, FALLBACK_MESSAGES);
  assert.equal(
    en("adminManage.stats.neverWatchedSeasons", { count: 1, value: "1", size: "4 GB" }),
    "1 season of a watched show has never been played (4 GB).",
  );
  assert.equal(
    en("adminManage.stats.neverWatchedSeasons", { count: 3, value: "3", size: "9 GB" }),
    "3 seasons of watched shows have never been played (9 GB).",
  );
  // The titles clause no longer carries a seasons placeholder in any language.
  for (const [locale, messages] of Object.entries(CATALOGS)) {
    for (const form of ["_one", "_other"]) {
      const text = (messages as Record<string, string>)[`adminManage.stats.neverWatchedValue${form}`];
      assert.ok(text, `${locale} neverWatchedValue${form}`);
      assert.doesNotMatch(text, /\{seasons\}|\{seasonSize\}/, `${locale} neverWatchedValue${form}`);
      const seasons = (messages as Record<string, string>)[`adminManage.stats.neverWatchedSeasons${form}`];
      assert.ok(seasons, `${locale} neverWatchedSeasons${form}`);
      assert.match(seasons, /\{value\}/);
      assert.match(seasons, /\{size\}/);
    }
  }
});

test("C003: the page renders each clause behind its own flag", () => {
  const page = read("src/app/(app)/admin/stats/page.tsx");
  assert.match(page, /if \(line\.showTitles\) \{\s*parts\.push\(t\("adminManage\.stats\.neverWatchedValue", \{[^}]*count: nw\.titles/);
  assert.match(page, /if \(line\.showSeasons\) \{\s*parts\.push\(t\("adminManage\.stats\.neverWatchedSeasons", \{[^}]*count: nw\.seasons/);
});

// ── C066 / C072 (the .tsx can't be imported through the loader) ─────────────

const report = read("src/components/admin/never-watched-report.tsx");

test("C066: reload goes through the latest loader, never the click-time one", () => {
  assert.match(report, /const loadRef = useRef\(load\);\s*useEffect\(\(\) => \{\s*loadRef\.current = load;\s*\}, \[load\]\);/);
  const reload = /const reload = useCallback\(async \(fresh = false\) => \{([\s\S]*?)\}, \[([^\]]*)\]\);/.exec(report);
  assert.ok(reload, "reload is a useCallback");
  assert.match(reload[1], /await loadRef\.current\(\);/);
  assert.doesNotMatch(reload[1], /await load\(\)/);
  assert.equal(reload[2].trim(), "", "reload must not depend on load (its identity would capture the click-time view)");
});

test("C072: rows are rendered by their own kind, never cast by the level state", () => {
  assert.doesNotMatch(report, /as NwSeasonRow\[\]/);
  assert.doesNotMatch(report, /as NwTitleRow\[\]/);
  assert.match(report, /const seasonRows = \(data\?\.rows \?\? \[\]\)\.filter\(\(r\): r is NwSeasonRow => r\.kind === "season"\);/);
  assert.match(report, /\{seasonRows\.map\(\(r\) => \(\s*<SeasonRow/);
  assert.match(report, /\{titleRows\.map\(\(r\) => \(\s*<TitleRow/);
  // The empty state reads the CURRENT tab's rows, and the other tab's rows on
  // hand (a switch in flight, or a failed fetch) show the loading line instead.
  assert.match(report, /const levelRows: ReadonlyArray<NwTitleRow \| NwSeasonRow> = level === "title" \? titleRows : seasonRows;/);
  assert.match(report, /\{levelRows\.length === 0 && \(loading \|\| otherLevelRows\) \?/);
  assert.match(report, /\) : levelRows\.length === 0 \? \(\s*<EmptyState/);
  assert.doesNotMatch(report, /data\.rows\.length === 0 \?/);
});
