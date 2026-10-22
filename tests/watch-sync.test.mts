// Watch sync, Plex → Jellyfin — the pure rules (src/lib/watch-sync.ts,
// guardrail 19e): owner-id rewrite, the history read bound, per-pair play
// selection, episode indexing and the mark plan.

import { test } from "node:test";
import assert from "node:assert/strict";

const W = await import("../src/lib/watch-sync.ts");
type Entry = import("../src/lib/upstream-watch.ts").PlexHistoryEntry;

const H = 3_600_000;
const T = (h: number) => new Date(Date.UTC(2025, 0, 1) + h * H);
const movie = (key: string, account: string | null, at: Date | null): Entry =>
  ({ kind: "movie", itemKey: key, showKey: null, seasonNumber: null, episodeNumber: null, viewedAt: at, accountId: account });
const ep = (show: string, s: number | null, e: number | null, account: string, at: Date | null): Entry =>
  ({ kind: "episode", itemKey: `${show}-${s}-${e}`, showKey: show, seasonNumber: s, episodeNumber: e, viewedAt: at, accountId: account });

const titles: Record<string, { tmdbId: number; mediaType: "MOVIE" | "TV" }> = {
  m1: { tmdbId: 100, mediaType: "MOVIE" },
  m2: { tmdbId: 200, mediaType: "MOVIE" },
  show: { tmdbId: 900, mediaType: "TV" },
};
const lookup = (k: string) => titles[k] ?? null;

test("normalizePlexAccountId: the owner's local id '1' becomes their plex.tv id; anything else, or an unknown owner, is left alone", () => {
  assert.equal(W.normalizePlexAccountId("1", "555"), "555");
  assert.equal(W.normalizePlexAccountId("42", "555"), "42");
  assert.equal(W.normalizePlexAccountId("1", null), "1");
  assert.equal(W.normalizePlexAccountId(null, "555"), null);
});

test("historyStopBefore: any never-read pair ⇒ the whole history; otherwise the OLDEST read point minus the overlap", () => {
  assert.equal(W.historyStopBefore([{ id: "a", plexAccountId: "1", historyReadTo: T(10) }, { id: "b", plexAccountId: "2", historyReadTo: null }]), undefined);
  assert.equal(W.historyStopBefore([]), undefined);
  const b = W.historyStopBefore([{ id: "a", plexAccountId: "1", historyReadTo: T(10) }, { id: "b", plexAccountId: "2", historyReadTo: T(5) }]);
  assert.deepEqual(b, new Date(T(5).getTime() - W.WATCH_SYNC_HISTORY_OVERLAP_MS));
});

test("newestViewedAt: the latest dated entry; null with none dated", () => {
  assert.deepEqual(W.newestViewedAt([movie("m1", "1", T(2)), movie("m2", "1", null), movie("m1", "2", T(7))]), T(7));
  assert.equal(W.newestViewedAt([movie("m1", "1", null)]), null);
});

test("playsForPair: only this account (owner rewritten), resolved through the Plex cache; unknown keys and episodes without numbers count as unresolved", () => {
  const entries = [
    movie("m1", "1", T(1)),            // owner → 555
    movie("m2", "42", T(2)),           // someone else
    movie("nope", "555", T(3)),        // not in the cache
    ep("show", 1, 2, "555", T(4)),
    ep("show", 1, null, "555", T(5)),  // no episode number
    movie("show", "555", T(6)),        // a movie entry resolving to a TV row
  ];
  const r = W.playsForPair(entries, { id: "p", plexAccountId: "555", historyReadTo: null }, "555", lookup);
  assert.deepEqual(r.plays.map((p) => [p.tmdbId, p.mediaType, p.seasonNumber, p.episodeNumber]), [[100, "MOVIE", null, null], [900, "TV", 1, 2]]);
  assert.equal(r.unresolved, 3);
});

test("playsForPair: an incremental pair takes plays on/after its read point minus the overlap; undated plays only on the first (full) run", () => {
  const readTo = T(10);
  const entries = [movie("m1", "7", T(9)), movie("m2", "7", T(7)), movie("m1", "7", null)];
  const inc = W.playsForPair(entries, { id: "p", plexAccountId: "7", historyReadTo: readTo }, null, lookup);
  assert.deepEqual(inc.plays.map((p) => p.tmdbId), [100], "T(9) is inside the 2h overlap; T(7) and the undated one are not");
  const full = W.playsForPair(entries, { id: "p", plexAccountId: "7", historyReadTo: null }, null, lookup);
  assert.equal(full.plays.length, 3);
});

test("indexEpisodes: every copy's item answers for its (season, episode); a multi-episode file answers for each number, capped", () => {
  const idx = W.indexEpisodes([
    { seasonNumber: 1, episodeNumber: 1, episodeNumberEnd: null, itemId: "a" },
    { seasonNumber: 1, episodeNumber: 1, episodeNumberEnd: null, itemId: "b" },
    { seasonNumber: 1, episodeNumber: 2, episodeNumberEnd: 3, itemId: "c" },
    { seasonNumber: 2, episodeNumber: 1, episodeNumberEnd: 1_000_000, itemId: "huge" },
  ]);
  assert.deepEqual(idx.get("1:1"), ["a", "b"]);
  assert.deepEqual(idx.get("1:2"), ["c"]);
  assert.deepEqual(idx.get("1:3"), ["c"]);
  assert.equal([...idx.keys()].filter((k) => k.startsWith("2:")).length, W.WATCH_SYNC_MAX_EPISODE_SPAN);
});

test("planMarks: every Jellyfin copy is marked once, with the LATEST play date; specials and absent titles are unmatched, never guessed", () => {
  const targets = {
    movies: new Map([[100, ["jm1", "jm1-4k"]]]),
    episodes: new Map([[900, new Map([["1:2", ["je12"]], ["0:1", ["special"]]])]]),
  };
  const plays = [
    { tmdbId: 100, mediaType: "MOVIE" as const, seasonNumber: null, episodeNumber: null, viewedAt: T(1) },
    { tmdbId: 100, mediaType: "MOVIE" as const, seasonNumber: null, episodeNumber: null, viewedAt: T(5) },
    { tmdbId: 100, mediaType: "MOVIE" as const, seasonNumber: null, episodeNumber: null, viewedAt: null },
    { tmdbId: 900, mediaType: "TV" as const, seasonNumber: 1, episodeNumber: 2, viewedAt: T(3) },
    { tmdbId: 900, mediaType: "TV" as const, seasonNumber: 0, episodeNumber: 1, viewedAt: T(3) },
    { tmdbId: 900, mediaType: "TV" as const, seasonNumber: 1, episodeNumber: 9, viewedAt: T(3) },
    { tmdbId: 200, mediaType: "MOVIE" as const, seasonNumber: null, episodeNumber: null, viewedAt: T(3) },
  ];
  const plan = W.planMarks(plays, targets);
  assert.deepEqual(plan.marks.sort((a, b) => a.jellyfinItemId.localeCompare(b.jellyfinItemId)), [
    { jellyfinItemId: "je12", datePlayed: T(3) },
    { jellyfinItemId: "jm1", datePlayed: T(5) },
    { jellyfinItemId: "jm1-4k", datePlayed: T(5) },
  ]);
  assert.equal(plan.unmatched, 3, "the special, the missing episode and the missing movie");
});

test("seriesNeeded: TV titles with a regular-season play only", () => {
  assert.deepEqual(W.seriesNeeded([
    { tmdbId: 1, mediaType: "TV", seasonNumber: 1, episodeNumber: 1, viewedAt: null },
    { tmdbId: 1, mediaType: "TV", seasonNumber: 2, episodeNumber: 1, viewedAt: null },
    { tmdbId: 2, mediaType: "TV", seasonNumber: 0, episodeNumber: 1, viewedAt: null },
    { tmdbId: 3, mediaType: "MOVIE", seasonNumber: null, episodeNumber: null, viewedAt: null },
  ]), [1]);
});

test("safeWatchSyncError: no URL or token survives, single line, bounded", () => {
  const msg = W.safeWatchSyncError(new Error("fetch http://10.0.0.5:8096/Users/x?api_key=SECRET failed\n token=abc " + "x".repeat(500)));
  assert.ok(!msg.includes("10.0.0.5") && !msg.includes("SECRET") && !msg.includes("abc"));
  assert.ok(!msg.includes("\n"));
  assert.ok(msg.length <= 300);
});
