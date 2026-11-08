// /admin/stats page wiring. The page is a server component the unit loader
// can't render, so these pins are a structural scan; the figures themselves
// are pinned at the data layer (tests/admin-stats.test.mts and, against a real
// Postgres, tests/db/admin-stats-requests.test.mts).
//
//   - A streamed section catches its own rejection: a transient DB failure in
//     the storage figures drops that section instead of replacing the rendered
//     page with the error boundary.
//   - The auto-request source counts don't need the window's total, so they run
//     inside the main batch rather than after it.
//   - A Trakt watchlist auto-request is shown as its own source, never folded
//     into the in-app watchlist.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const page = read("src/app/(app)/admin/stats/page.tsx");

function body(name: string): string {
  const start = page.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name} is defined`);
  const next = page.indexOf("\nasync function ", start + 1);
  const nextFn = page.indexOf("\nfunction ", start + 1);
  const ends = [next, nextFn].filter((i) => i > 0);
  return page.slice(start, ends.length ? Math.min(...ends) : undefined);
}

test("both streamed sections catch a rejection of their slow read and render nothing", () => {
  assert.match(body("StorageSection"), /const storage = await getStorageStats\(\)\.catch\(\(err\) => \{[\s\S]*?return null;\s*\}\);\s*if \(!storage\) return null;/);
  assert.match(body("WatchGradesSection"), /await getWatchGradeSpreadForStats\(\)\.catch\(/);
});

test("the auto-request source counts run inside the main batch; `other` is derived after it", () => {
  const batch = /overview, fulfillment,[\s\S]*?\] = await Promise\.all\(\[([\s\S]*?)\]\);/.exec(page);
  assert.ok(batch, "the main batch");
  assert.match(batch[1], /getAutoRequestSources\(since\),/);
  assert.match(page, /const sources = requestSources\(autoSources, overview\.total\);/);
  assert.doesNotMatch(page, /await getRequestSources\(/, "no sequential round trip after the batch");
});

test("the sources bar shows Trakt as its own part, coloured from a design token", () => {
  assert.match(
    page,
    /\{ label: t\("adminManage\.stats\.source\.traktWatchlist"\), value: sources\.traktWatchlist, color: "var\(--ds-[a-z-]+\)" \}/,
  );
  for (const locale of ["de", "en", "es", "fr", "it", "pt", "zh"]) {
    const messages = JSON.parse(read(`src/lib/i18n/messages/${locale}/adminManage.json`)) as Record<string, string>;
    assert.ok(messages["adminManage.stats.source.traktWatchlist"], `${locale} names the Trakt source`);
  }
});

test("a service with several servers lists them, whatever the other service holds", () => {
  // The old guard compared the server count to the service count, which an
  // episode-cache-only service could satisfy while Plex had two servers.
  assert.match(page, /\{servers\.length > 1 && \(/);
  assert.doesNotMatch(page, /multiServer/);
});
