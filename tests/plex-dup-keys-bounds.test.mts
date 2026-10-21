// Audit fix R6: folding the ratingKeys of a title's copies (guardrail 37c) is
// LINEAR in the number of copies. The section fold used to merge pair by pair
// through withDuplicateRatingKeys, which rebuilt the winner's whole key list
// with `keys.includes` on every copy — cubic, so a hostile, compromised or
// MITM'd Plex server (an admin-configured URL, often plain http on the LAN)
// listing a few thousand items with one tmdb guid froze the event loop for
// minutes inside the unattended hourly / SSE-triggered sync.
//
// What is pinned, without timing — the WORK a fold does is counted while it
// runs (every element Array.prototype includes/indexOf/lastIndexOf/sort/filter
// is asked to visit, plus every Set has/add, which `new Set(iterable)` also
// calls), and must stay under a fixed multiple of the copies folded:
//   1. getPlexSectionTmdbIds over 20k same-tmdb items (the section fold).
//   2. getPlexTmdbIds over 400 sections × 50 copies (the cross-section merge).
//   3. mergeResolvedLegacyItems over 20k legacy copies of one tmdb id.
//   4. plexLibraryRatingKeys / withDuplicateRatingKeys on 20k-key entries.
// A run that blows the budget aborts at once (the counter throws), so the
// quadratic and cubic shapes fail in milliseconds instead of hanging the suite.
//
// And that the change kept every OUTPUT: which entry wins, the canonical key
// first then the sorted duplicates, a conflated item's shared entry never
// mutated — pinned on a small mixed fixture whose expected keys were worked out
// by hand from the pre-fix fold.
//
// No DB and no network: fetch is scripted per URL and dns.lookup is stubbed to
// a public address (as in tests/plex.test.mts); plex-legacy-resolve's prisma
// layer loads against an empty stub and is never called.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
// Type-only: erased at runtime, so the module graph still loads AFTER the stubs.
import type { PlexLibraryItemData } from "../src/lib/plex.ts";

process.env.TOKEN_ENCRYPTION_KEY ??= "ab".repeat(32);
(globalThis as unknown as { prisma: unknown }).prisma = {};

const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) {
  throw new Error("could not stub dns.lookup — aborting before a real DNS query can leave the process");
}

let respond: (url: URL) => Response = (url) => {
  throw new Error(`unexpected fetch ${url} — script a responder for this test`);
};
globalThis.fetch = (async (input: RequestInfo | URL) => respond(new URL(String(input)))) as typeof fetch;
beforeEach(() => {
  respond = (url) => {
    throw new Error(`unexpected fetch ${url} — script a responder for this test`);
  };
});

const okJson = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

// Dynamic imports so the stubs above precede the module-graph load.
const { getPlexSectionTmdbIds, getPlexTmdbIds, plexLibraryRatingKeys, withDuplicateRatingKeys } =
  await import("../src/lib/plex.ts");
const { mergeResolvedLegacyItems } = await import("../src/lib/plex-legacy-resolve.ts");

// ── work counter ────────────────────────────────────────────────────────────

/** Work allowed per copy folded. The fixed code does ~4–10; pairwise folding does thousands. */
const WORK_PER_COPY = 16;

/**
 * Runs `fn` with Array search/sort/filter and Set has/add counted, throwing as
 * soon as the count passes `budget`. Returns the count and fn's result.
 */
async function countWork<R>(budget: number, fn: () => R | Promise<R>): Promise<{ work: number; result: R }> {
  const arrayProto = Array.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  const setProto = Set.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  const arrayNames = ["includes", "indexOf", "lastIndexOf", "sort", "filter"];
  const setNames = ["has", "add"];
  const arrayOriginals = arrayNames.map((n) => arrayProto[n]);
  const setOriginals = setNames.map((n) => setProto[n]);
  let work = 0;
  let tripped = false;
  const charge = (n: number) => {
    work += n;
    if (!tripped && work > budget) {
      tripped = true;
      throw new Error(`fold exceeded its work budget of ${budget}`);
    }
  };
  arrayNames.forEach((name, i) => {
    const original = arrayOriginals[i];
    arrayProto[name] = function (this: unknown[], ...args: unknown[]) {
      charge(this.length);
      return original.apply(this, args);
    };
  });
  setNames.forEach((name, i) => {
    const original = setOriginals[i];
    setProto[name] = function (this: Set<unknown>, ...args: unknown[]) {
      charge(1);
      return original.apply(this, args);
    };
  });
  try {
    const result = await fn();
    return { work, result };
  } catch (err) {
    if (tripped) assert.fail(`work passed the budget of ${budget} (${(err as Error).message})`);
    throw err;
  } finally {
    arrayNames.forEach((name, i) => { arrayProto[name] = arrayOriginals[i]; });
    setNames.forEach((name, i) => { setProto[name] = setOriginals[i]; });
  }
}

// ── fixtures ────────────────────────────────────────────────────────────────

const movie = (ratingKey: string | null, tmdbIds: number[], title = `Copy ${ratingKey}`) => ({
  type: "movie",
  ...(ratingKey === null ? {} : { ratingKey }),
  title,
  Guid: tmdbIds.map((id) => ({ id: `tmdb://${id}` })),
});

/** Serves `items` as /library/sections/<key>/all pages of the requested size. */
function serveSections(sections: Record<string, unknown[]>): (url: URL) => Response {
  return (url) => {
    const m = /^\/library\/sections\/([^/]+)\/all$/.exec(url.pathname);
    const items = m ? sections[m[1]] : undefined;
    if (!items) throw new Error(`unexpected fetch ${url}`);
    const start = Number(url.searchParams.get("X-Plex-Container-Start"));
    const size = Number(url.searchParams.get("X-Plex-Container-Size"));
    return okJson({ MediaContainer: { Metadata: items.slice(start, start + size), totalSize: items.length } });
  };
}

const keyRange = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => String(from + i));
/** The duplicates list a fold must produce: default (string) sort, as the writer stores it. */
const sortedKeys = (keys: string[]) => [...keys].sort();

// ── 1. section fold ─────────────────────────────────────────────────────────

test("a section listing 20k copies of one tmdb id folds in linear work, last copy winning with every other key", async () => {
  const N = 20_000;
  // The LAST copy is a conflated item that also claims tmdb 78, so the winner's
  // entry object is shared — the fold must copy it, never write into it.
  const items = keyRange(1, N).map((k) => movie(k, Number(k) === N ? [77, 78] : [77]));
  respond = serveSections({ "5": items });

  const { work, result } = await countWork(N * WORK_PER_COPY, () =>
    getPlexSectionTmdbIds("http://plex-bounds-section.test:32400", "t", "5", "movie", false),
  );

  const winner = result.get(77)!;
  assert.equal(winner.ratingKey, String(N), "last write still wins inside a section");
  assert.deepEqual(plexLibraryRatingKeys(winner), [String(N), ...sortedKeys(keyRange(1, N - 1))]);
  assert.equal(result.get(78)!.ratingKey, String(N));
  assert.equal(result.get(78)!.duplicateRatingKeys, undefined, "the shared entry was mutated — 78 got 77's copies");
  assert.ok(work <= N * WORK_PER_COPY, `work ${work}`);
});

// ── 2. cross-section merge ──────────────────────────────────────────────────

test("400 sections each holding 50 copies of one tmdb id merge in linear work, first section's winner keeping every key", async () => {
  const SECTIONS = 400;
  const PER = 50;
  const N = SECTIONS * PER;
  const sections: Record<string, unknown[]> = {};
  for (let s = 0; s < SECTIONS; s++) {
    sections[String(s + 1)] = keyRange(s * PER + 1, (s + 1) * PER).map((k) => movie(k, [77]));
  }
  respond = serveSections(sections);
  const list = Object.keys(sections).map((key) => ({ key, title: `Movies ${key}`, type: "movie" as const }));

  const { work, result } = await countWork(N * WORK_PER_COPY, () =>
    getPlexTmdbIds("http://plex-bounds-merge.test:32400", "t", "MOVIE", false, undefined, list),
  );

  const winner = result.get(77)!;
  assert.equal(winner.ratingKey, String(PER), "the first section's own winner (its last copy) owns the row");
  assert.deepEqual(plexLibraryRatingKeys(winner), [String(PER), ...sortedKeys(keyRange(1, N).filter((k) => k !== String(PER)))]);
  assert.ok(work <= N * WORK_PER_COPY, `work ${work}`);
});

// ── 3. legacy merge ─────────────────────────────────────────────────────────

test("20k legacy copies resolving to one tmdb id merge in linear work onto the modern row", async () => {
  const N = 20_000;
  const data = (ratingKey: string): PlexLibraryItemData => ({
    filePath: null, ratingKey, title: `Legacy ${ratingKey}`, year: null, overview: null, contentRating: null, addedAt: null,
  });
  const modern = data("modern");
  const items = new Map<number, PlexLibraryItemData>([[7, modern]]);
  const resolved = keyRange(1, N).map((ratingKey) => ({ tmdbId: 7, ratingKey, data: data(ratingKey) }));

  const { work } = await countWork(N * WORK_PER_COPY, () => mergeResolvedLegacyItems(resolved, items));

  const row = items.get(7)!;
  assert.equal(row.ratingKey, "modern", "the modern-agent row keeps the title");
  assert.deepEqual(plexLibraryRatingKeys(row), ["modern", ...sortedKeys(keyRange(1, N))]);
  assert.equal(modern.duplicateRatingKeys, undefined, "the modern entry was mutated in place");
  assert.ok(work <= N * WORK_PER_COPY, `work ${work}`);
});

// ── 4. helpers ──────────────────────────────────────────────────────────────

const entry = (ratingKey: string | null, duplicateRatingKeys?: string[]): PlexLibraryItemData => ({
  filePath: null, ratingKey, title: null, year: null, overview: null, contentRating: null, addedAt: null,
  ...(duplicateRatingKeys ? { duplicateRatingKeys } : {}),
});

test("plexLibraryRatingKeys dedupes 20k duplicate keys in linear work, keeping first-seen order", async () => {
  const N = 20_000;
  const dups = keyRange(1, N);
  const data = entry("1", [...dups, ...dups]);
  const { work, result } = await countWork(N * WORK_PER_COPY, () => plexLibraryRatingKeys(data));
  assert.deepEqual(result, dups, "canonical first, then the duplicates in stored order, each once");
  assert.ok(work <= N * WORK_PER_COPY, `work ${work}`);
});

test("withDuplicateRatingKeys merges two 20k-key entries in linear work, without touching either", async () => {
  const N = 20_000;
  const existingDups = sortedKeys(keyRange(1, N));
  const existing = entry("0", existingDups);
  const other = entry(String(N + 1), keyRange(N / 2, N + N / 2));
  const { work, result } = await countWork(N * WORK_PER_COPY, () => withDuplicateRatingKeys(existing, other));
  assert.deepEqual(result.duplicateRatingKeys, sortedKeys(keyRange(1, N + N / 2)));
  assert.equal(result.ratingKey, "0");
  assert.equal(existing.duplicateRatingKeys, existingDups);
  assert.equal(existingDups.length, N, "existing's list was written into");
  assert.ok(work <= N * WORK_PER_COPY, `work ${work}`);
});

// ── output equivalence with the pre-fix fold ────────────────────────────────

test("a small mixed fixture keeps exactly the winners and keys the pre-fix fold produced", async () => {
  // Expected values worked out by hand from the pre-fix pairwise fold:
  //   section 1, tmdb 1: 30 → 5 (dup 30) → 30 again (prev 5 ≠ 30, so dup 5)
  //   section 1, tmdb 2: the conflated item 5, nothing else
  //   section 1, tmdb 3: 12 → 7 (dup 12)
  //   section 1, tmdb 4: 9 → a copy with no ratingKey (dup 9)
  //   section 2 copies: tmdb 1 → 100, tmdb 2 → 200, tmdb 3 → 12 then 8 (dup 12)
  //   merge (first section wins): 1 gains 100, 2 gains 200, 3 gains only 8
  //   (12 is already there), 4 is untouched; duplicates sorted as strings.
  respond = serveSections({
    "1": [
      movie("30", [1], "Thirty"),
      movie("5", [1, 2], "Conflated"),
      movie("12", [3], "Twelve"),
      movie("30", [1], "Thirty again"),
      movie("7", [3], "Seven"),
      movie("9", [4], "Nine"),
      movie(null, [4], "No key"),
    ],
    "2": [
      movie("100", [1], "Hundred"),
      movie("200", [2], "Two hundred"),
      movie("12", [3], "Twelve elsewhere"),
      movie("8", [3], "Eight"),
    ],
  });
  const combined = await getPlexTmdbIds("http://plex-bounds-mixed.test:32400", "t", "MOVIE", false, undefined, [
    { key: "1", title: "Movies", type: "movie" },
    { key: "2", title: "More Movies", type: "movie" },
  ]);
  const view = (id: number) => {
    const d = combined.get(id)!;
    return { title: d.title, ratingKey: d.ratingKey, keys: plexLibraryRatingKeys(d) };
  };
  assert.deepEqual(view(1), { title: "Thirty again", ratingKey: "30", keys: ["30", "100", "5"] });
  assert.deepEqual(view(2), { title: "Conflated", ratingKey: "5", keys: ["5", "200"] });
  assert.deepEqual(view(3), { title: "Seven", ratingKey: "7", keys: ["7", "12", "8"] });
  assert.deepEqual(view(4), { title: "No key", ratingKey: null, keys: ["9"] });
  assert.deepEqual(combined.get(4)!.duplicateRatingKeys, ["9"]);

  // A merge that adds nothing hands back the SAME object, and the pairwise
  // helper still never writes into either side.
  const a = entry("1", ["2"]);
  const b = entry("2", ["1"]);
  assert.equal(withDuplicateRatingKeys(a, b), a);
  const merged = withDuplicateRatingKeys(entry("3"), a);
  assert.deepEqual(merged.duplicateRatingKeys, ["1", "2"]);
  assert.deepEqual(a.duplicateRatingKeys, ["2"]);
  assert.deepEqual(plexLibraryRatingKeys(entry(null, ["b", "a", "b"])), ["b", "a"]);
});
