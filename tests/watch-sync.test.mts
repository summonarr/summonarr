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
  assert.deepEqual(plan.marks.sort((a, b) => a.targetId.localeCompare(b.targetId)), [
    { targetId: "je12", datePlayed: T(3) },
    { targetId: "jm1", datePlayed: T(5) },
    { targetId: "jm1-4k", datePlayed: T(5) },
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

// ── bidirectional ────────────────────────────────────────────────────────────

test("syncsToward / parseWatchSyncDirection: 'both' covers each side; an unknown stored value covers NEITHER (fail closed)", () => {
  assert.equal(W.syncsToward("both", "toJellyfin"), true);
  assert.equal(W.syncsToward("both", "toPlex"), true);
  assert.equal(W.syncsToward("toJellyfin", "toPlex"), false);
  assert.equal(W.syncsToward("toPlex", "toPlex"), true);
  assert.equal(W.syncsToward("", "toJellyfin"), false);
  assert.equal(W.syncsToward("BOTH", "toPlex"), false);
  assert.equal(W.parseWatchSyncDirection("toPlex"), "toPlex");
  assert.equal(W.parseWatchSyncDirection("sideways"), null);
  assert.equal(W.parseWatchSyncDirection(1), null);
});

test("playsFromJellyfin: movies by item id, episodes by series id; our own marks (echo) and unplaceable items are skipped", () => {
  const titles: Record<string, { tmdbId: number; mediaType: "MOVIE" | "TV" }> = { jm1: { tmdbId: 100, mediaType: "MOVIE" }, ser: { tmdbId: 900, mediaType: "TV" } };
  const items = [
    { kind: "movie" as const, itemKey: "jm1", showKey: null, seasonNumber: null, episodeNumber: null, lastPlayedAt: T(1) },
    { kind: "movie" as const, itemKey: "echo", showKey: null, seasonNumber: null, episodeNumber: null, lastPlayedAt: T(2) },
    { kind: "episode" as const, itemKey: "e1", showKey: "ser", seasonNumber: 2, episodeNumber: 3, lastPlayedAt: T(3) },
    { kind: "episode" as const, itemKey: "e2", showKey: "ser", seasonNumber: 2, episodeNumber: null, lastPlayedAt: T(4) },
    { kind: "movie" as const, itemKey: "nope", showKey: null, seasonNumber: null, episodeNumber: null, lastPlayedAt: T(5) },
  ];
  const r = W.playsFromJellyfin(items, (id) => titles[id] ?? null, new Set(["echo"]));
  assert.deepEqual(r.plays.map((p) => [p.tmdbId, p.mediaType, p.seasonNumber, p.episodeNumber]), [[100, "MOVIE", null, null], [900, "TV", 2, 3]]);
  assert.equal(r.unresolved, 2, "the episode with no number and the unknown movie; the echo is not even counted");
});

test("playsForPair: a Plex history entry for an item we scrobbled (echo) is skipped", () => {
  const r = W.playsForPair([movie("m1", "7", T(1)), movie("m2", "7", T(2))], { id: "p", plexAccountId: "7", historyReadTo: null }, null, lookup, new Set(["m2"]));
  assert.deepEqual(r.plays.map((p) => p.tmdbId), [100]);
});

test("jellyfinStopBefore / newestPlayedAt", () => {
  assert.equal(W.jellyfinStopBefore(null), undefined);
  assert.deepEqual(W.jellyfinStopBefore(T(10)), new Date(T(10).getTime() - W.WATCH_SYNC_HISTORY_OVERLAP_MS));
  assert.deepEqual(W.newestPlayedAt([
    { kind: "movie", itemKey: "a", showKey: null, seasonNumber: null, episodeNumber: null, lastPlayedAt: T(3) },
    { kind: "movie", itemKey: "b", showKey: null, seasonNumber: null, episodeNumber: null, lastPlayedAt: null },
  ]), T(3));
});

// ── resume points ────────────────────────────────────────────────────────────

const st = (positionMs: number, hoursAgo: number | null, extra: Partial<{ durationMs: number; played: boolean }> = {}) => ({
  positionMs, durationMs: extra.durationMs ?? 6_000_000, lastActivity: hoursAgo === null ? null : T(100 - hoursAgo), played: extra.played ?? false,
});

test("isResumePoint: at least 60 s in and short of 95% of the runtime", () => {
  assert.equal(W.isResumePoint(st(59_000, 1)), false);
  assert.equal(W.isResumePoint(st(60_000, 1)), true);
  assert.equal(W.isResumePoint(st(5_700_000, 1)), false, "95% of 6,000,000 ms");
  assert.equal(W.isResumePoint(st(5_699_000, 1)), true);
  assert.equal(W.isResumePoint({ ...st(120_000, 1), durationMs: null }), true);
  assert.equal(W.isResumePoint(null), false);
});

test("decideProgress: the newer resume point wins and is copied to the other side", () => {
  assert.deepEqual(W.decideProgress(st(720_000, 1), st(0, 24), "both"), { target: "toJellyfin", positionMs: 720_000 });
  assert.deepEqual(W.decideProgress(st(0, 24), st(1_800_000, 1), "both"), { target: "toPlex", positionMs: 1_800_000 });
  assert.deepEqual(W.decideProgress(st(720_000, 5), st(1_800_000, 1), "both"), { target: "toPlex", positionMs: 1_800_000 }, "both in progress: newer wins");
  assert.deepEqual(W.decideProgress(st(720_000, 1), st(1_800_000, 5), "both"), { target: "toJellyfin", positionMs: 720_000 });
});

test("decideProgress: no write within the tolerance, on a tie, without a target, or against the direction", () => {
  assert.equal(W.decideProgress(st(720_000, 1), st(740_000, 24), "both"), null, "20 s apart");
  assert.equal(W.decideProgress(st(720_000, 1), st(1_800_000, 1), "both"), null, "same instant: can't tell");
  assert.equal(W.decideProgress(st(720_000, null), st(1_800_000, 1), "both"), null, "both in progress, one undated: can't tell which is newer");
  assert.deepEqual(W.decideProgress(st(720_000, null), st(0, null), "both"), { target: "toJellyfin", positionMs: 720_000 }, "one side in progress and neither dated: copy it");
});

test("decideProgress: the target moved on, or is watched ⇒ left alone; an unknown direction writes nothing", () => {
  assert.equal(W.decideProgress(st(720_000, 24), st(0, 1), "both"), null, "Jellyfin activity is newer than the Plex pause");
  assert.equal(W.decideProgress(st(720_000, 1), st(0, 24, { played: true }), "both"), null, "watched beats in-progress");
  assert.equal(W.decideProgress(st(720_000, 1), null, "both"), null, "title not on Jellyfin");
  assert.equal(W.decideProgress(st(720_000, 1), st(0, 24), "toPlex"), null);
  assert.equal(W.decideProgress(st(720_000, 1), st(0, 24), "sideways"), null);
  assert.equal(W.decideProgress(st(30_000, 1), st(0, 24), "both"), null, "under a minute is not a resume point");
});

test("latestState / progressUnitKey / targetIdsFor", () => {
  assert.equal(W.latestState([st(1, 5), st(2, 1), st(3, 9)])?.positionMs, 2);
  assert.equal(W.latestState([]), null);
  assert.equal(W.progressUnitKey({ tmdbId: 1, mediaType: "MOVIE", seasonNumber: null, episodeNumber: null }), "m:1");
  assert.equal(W.progressUnitKey({ tmdbId: 1, mediaType: "TV", seasonNumber: 0, episodeNumber: 1 }), null, "specials never");
  const targets = { movies: new Map([[1, ["a", "b"]]]), episodes: new Map([[9, new Map([["2:3", ["e"]]])]]) };
  assert.deepEqual(W.targetIdsFor({ tmdbId: 1, mediaType: "MOVIE", seasonNumber: null, episodeNumber: null, viewedAt: null }, targets), ["a", "b"]);
  assert.deepEqual(W.targetIdsFor({ tmdbId: 9, mediaType: "TV", seasonNumber: 2, episodeNumber: 3, viewedAt: null }, targets), ["e"]);
  assert.deepEqual(W.targetIdsFor({ tmdbId: 9, mediaType: "TV", seasonNumber: 2, episodeNumber: 4, viewedAt: null }, targets), []);
});

test("compareServerUsers: A–Z by user name ignoring case and accents, numbers in natural order, then server and id", () => {
  const u = (username: string, serverInstance = "", id = username) => ({ username, serverInstance, id });
  const sorted = [u("zoe"), u("GuestRoom"), u("alice"), u("Émile"), u("user10"), u("user2"), u("Bob")].sort(W.compareServerUsers);
  assert.deepEqual(sorted.map((x) => x.username), ["alice", "Bob", "Émile", "GuestRoom", "user2", "user10", "zoe"]);
  const tie = [u("sam", "remote", "b"), u("Sam", "", "z"), u("sam", "", "a")].sort(W.compareServerUsers);
  assert.deepEqual(tie.map((x) => `${x.serverInstance}/${x.id}`), ["/a", "/z", "remote/b"]);
  assert.ok(W.compareNames("alice", "Bob") < 0);
});
