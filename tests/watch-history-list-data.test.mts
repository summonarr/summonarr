// The /watch-history list's data layer: one page read and shape-checked
// (src/components/watch-history/history-page-fetch.ts), the query each piece of
// state is tagged with and the Load more merge (use-watch-history.ts), and the
// list's wiring (source pins: the .tsx can't be rendered under node:test).
// globalThis.fetch is stubbed; nothing touches the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fetchHistoryPage, historyQuery } from "../src/components/watch-history/history-page-fetch.ts";
import { appendPage, queryKey } from "../src/components/watch-history/use-watch-history.ts";

const item = (id: string) => ({
  id,
  source: "plex",
  startedAt: "2026-11-01T20:00:00.000Z",
  stoppedAt: "2026-11-01T21:00:00.000Z",
  duration: 3600,
  playDuration: 3500,
  watched: true,
  completed: true,
  tmdbId: 603,
  mediaType: "MOVIE" as const,
  title: "The Matrix",
  year: "1999",
  posterPath: null,
  seasonNumber: null,
  episodeNumber: null,
  episodeTitle: null,
  platform: null,
  player: null,
  device: null,
  playMethod: null,
  posterUrl: null,
  playCount: 1,
  totalPlaySeconds: 3500,
});

async function withFetch<T>(answer: (url: string, init?: RequestInit) => Promise<Response>, run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = ((url: string, init?: RequestInit) => answer(url, init)) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

test("a well-formed page comes back checked", async () => {
  const res = await withFetch(
    async () => json({ items: [item("a")], total: 1, nextCursor: null, linked: true, extra: 1 }),
    () => fetchHistoryPage("/api/play-history/mine"),
  );
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.deepEqual(res.page.items.map((i) => i.id), ["a"]);
    assert.equal(res.page.total, 1);
    assert.equal(res.page.nextCursor, null);
  }
});

test("a 200 that is not the page shape is a failure, never a crash on data.items", async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    for (const body of [{ error: "nope" }, { items: "x", total: 1, nextCursor: null }, { items: [{ id: 1 }], total: 1, nextCursor: null }]) {
      const res = await withFetch(async () => json(body), () => fetchHistoryPage("/x"));
      assert.deepEqual(res, { ok: false, aborted: false, rateLimited: false, retryAfterSeconds: null }, JSON.stringify(body));
    }
    const html = await withFetch(async () => new Response("<html>", { status: 200 }), () => fetchHistoryPage("/x"));
    assert.equal(html.ok, false);
  } finally {
    console.warn = warn;
  }
});

test("a 429 says it was rate-limited and how long to wait", async () => {
  const named = await withFetch(async () => json({ error: "slow down" }, 429, { "Retry-After": "60" }), () => fetchHistoryPage("/x"));
  assert.deepEqual(named, { ok: false, aborted: false, rateLimited: true, retryAfterSeconds: 60 });
  const unnamed = await withFetch(async () => json({ error: "slow down" }, 429), () => fetchHistoryPage("/x"));
  assert.deepEqual(unnamed, { ok: false, aborted: false, rateLimited: true, retryAfterSeconds: null });
  const other = await withFetch(async () => json({ error: "boom" }, 500), () => fetchHistoryPage("/x"));
  assert.deepEqual(other, { ok: false, aborted: false, rateLimited: false, retryAfterSeconds: null });
});

test("an aborted read is reported as aborted, a network failure as a plain failure", async () => {
  const ac = new AbortController();
  const aborted = await withFetch(
    async () => {
      ac.abort();
      throw new DOMException("The operation was aborted.", "AbortError");
    },
    () => fetchHistoryPage("/x", ac.signal),
  );
  assert.deepEqual(aborted, { ok: false, aborted: true });
  const down = await withFetch(async () => {
    throw new TypeError("fetch failed");
  }, () => fetchHistoryPage("/x"));
  assert.deepEqual(down, { ok: false, aborted: false, rateLimited: false, retryAfterSeconds: null });
});

test("historyQuery sends only the set filters, trimmed, and the cursor", () => {
  assert.equal(historyQuery("", "  "), "");
  assert.equal(historyQuery("TV", " dune "), "mediaType=TV&search=dune");
  assert.equal(historyQuery("MOVIE", "", "2026-11-01T00:00:00.000Z|abc"), "mediaType=MOVIE&cursor=2026-11-01T00%3A00%3A00.000Z%7Cabc");
});

test("queryKey tells queries apart and ignores surrounding whitespace", () => {
  assert.equal(queryKey("", " dune ", 0), queryKey("", "dune", 0));
  assert.notEqual(queryKey("", "dune", 0), queryKey("TV", "dune", 0));
  assert.notEqual(queryKey("", "", 0), queryKey("", "", 1), "a Retry is a new query");
});

test("Load more appends only rows not already shown", () => {
  const merged = appendPage([item("a"), item("b")], [item("b"), item("c")]);
  assert.deepEqual(merged.map((i) => i.id), ["a", "b", "c"]);
});

test("the list keeps typing, rows and the URL apart", () => {
  const list = readFileSync("src/components/watch-history/watch-history-list.tsx", "utf8");
  // The text being typed lives in HistoryFilters; the list holds the debounced value.
  const main = list.slice(list.indexOf("export function WatchHistoryList"), list.indexOf("function HistoryFilters"));
  assert.doesNotMatch(main, /setText|type="search"/);
  assert.match(list, /const HistoryRow = memo\(function HistoryRow\(/);
  assert.match(main, /<HistoryRow key=\{item\.id\} item=\{item\} issuesEnabled=\{issuesEnabled\} \/>/);
  assert.match(list, /window\.history\.replaceState\(/);
  // No mount-skip ref: the first page is matched by its query instead.
  const hook = readFileSync("src/components/watch-history/use-watch-history.ts", "utf8");
  assert.doesNotMatch(hook, /firstRender/);
  assert.match(hook, /if \(page\.key === key\) return;/);
  // The server page reads the same filters the list writes.
  const page = readFileSync("src/app/(app)/watch-history/page.tsx", "utf8");
  assert.match(page, /get\("type"\)/);
  assert.match(page, /get\("q"\)/);
  assert.match(page, /initialType=\{initialType\}/);
});
