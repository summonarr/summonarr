// Unit tests for the never-watched VERDICT (src/lib/never-watched.ts) — pure,
// no DB, no network. Guardrail 14d.
//
// This list is used to DELETE media, so every pin below is about a way the
// label could lie. Each test names the mutation it catches.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_EVIDENCE,
  idleAnchor,
  isNeverWatchedState,
  judgeSeason,
  judgeTitle,
  normalizeTitleKey,
  observedWindow,
  parseNwQuery,
  seasonSizeIfAgreed,
  stateMatchesFilter,
  trackingStampsFor,
  upstreamHealth,
  UPSTREAM_MIN_SAMPLES,
  type NwContext,
  type NwCoverage,
  type NwEvidence,
  type NwHolder,
  type NwUpstreamStatus,
} from "../src/lib/never-watched.ts";

const NOW = new Date("2026-10-01T00:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

const PLEX: NwHolder = { server: "plex", source: "plex" };
const JF: NwHolder = { server: "jellyfin", source: "jellyfin" };
const JF_REMOTE: NwHolder = { server: "jellyfin:remote", source: "jellyfin" };

function ctx(cov: Array<Partial<NwCoverage> & { server: string }>, over: Partial<NwContext> = {}): NwContext {
  const map = new Map<string, NwCoverage>();
  for (const c of cov) {
    map.set(c.server, {
      source: c.server.startsWith("plex") ? "plex" : "jellyfin",
      tracked: true,
      since: daysAgo(1000),
      ...c,
    } as NwCoverage);
  }
  return { now: NOW, trackingOn: true, coverage: map, ...over };
}
const ev = (over: Partial<NwEvidence> = {}): NwEvidence => ({ ...EMPTY_EVIDENCE, ...over });

// ── the window ──────────────────────────────────────────────────────────────

test("the window is the INTERSECTION of holders: it opens when the last holder began recording (catches the global start date)", () => {
  // Plex recorded for 1000 days, the remote Jellyfin only 30: a play on the
  // Jellyfin copy 200 days ago would have gone unseen.
  const c = ctx([{ server: "plex", since: daysAgo(1000) }, { server: "jellyfin:remote", since: daysAgo(30) }]);
  const w = observedWindow([PLEX, JF_REMOTE], daysAgo(400), c);
  assert.equal(w.start?.getTime(), daysAgo(30).getTime());
  assert.equal(w.fullyObserved, false);
});

test("a title that arrived after every holder began recording is fully observed (catches max/min swapped)", () => {
  const c = ctx([{ server: "plex", since: daysAgo(1000) }, { server: "jellyfin", since: daysAgo(500) }]);
  const w = observedWindow([PLEX, JF], daysAgo(100), c);
  assert.equal(w.start?.getTime(), daysAgo(100).getTime());
  assert.equal(w.fullyObserved, true);
});

test("an untracked holder makes the title unobservable, naming the server (catches ignoring per-source flags)", () => {
  const c = ctx([{ server: "plex" }, { server: "jellyfin:remote", tracked: false }]);
  const v = judgeTitle([PLEX, JF_REMOTE], daysAgo(400), ev(), c);
  assert.equal(v.state, "unobservable");
  assert.equal(v.reason, "sourceUntracked");
  assert.deepEqual(v.reasonServers, ["jellyfin:remote"]);
  assert.equal(v.windowStart, null);
});

test("a holder with no coverage entry at all reads as untracked, never as observed", () => {
  const v = judgeTitle([PLEX, JF], daysAgo(400), ev(), ctx([{ server: "plex" }]));
  assert.equal(v.state, "unobservable");
  assert.equal(v.reason, "sourceUntracked");
});

test("a tracked holder that has recorded nothing is 'no history', not 'observed forever' (catches since=null treated as the epoch)", () => {
  const v = judgeTitle([PLEX], daysAgo(400), ev(), ctx([{ server: "plex", since: null }]));
  assert.equal(v.state, "unobservable");
  assert.equal(v.reason, "noHistory");
  assert.deepEqual(v.reasonServers, ["plex"]);
});

test("tracking switched off globally: everything is unobservable", () => {
  const v = judgeTitle([PLEX], daysAgo(400), ev(), ctx([{ server: "plex" }], { trackingOn: false }));
  assert.equal(v.state, "unobservable");
  assert.equal(v.reason, "trackingOff");
});

test("an unknown arrival is unobservable — never silently dropped and never judged (catches a null shelfStart treated as old)", () => {
  const v = judgeTitle([PLEX], null, ev(), ctx([{ server: "plex" }]));
  assert.equal(v.state, "unobservable");
  assert.equal(v.reason, "addedUnknown");
});

// ── the states ──────────────────────────────────────────────────────────────

test("never watched since added vs no plays since recording began", () => {
  const c = ctx([{ server: "plex", since: daysAgo(300) }]);
  const after = judgeTitle([PLEX], daysAgo(100), ev(), c);
  assert.equal(after.state, "neverWatched");
  assert.equal(after.days, 100);
  const before = judgeTitle([PLEX], daysAgo(900), ev(), c);
  assert.equal(before.state, "noPlaysSince", "a title on the shelf before recording began can only claim 'since recording began'");
  assert.equal(before.windowStart?.getTime(), daysAgo(300).getTime());
  assert.equal(before.days, 300);
  assert.ok(isNeverWatchedState("neverWatched") && isNeverWatchedState("noPlaysSince"));
  assert.ok(!isNeverWatchedState("possiblyWatched") && !isNeverWatchedState("unobservable") && !isNeverWatchedState("watched"));
});

test("hard evidence wins over EVERYTHING — even an untracked holder proves use (catches evidence gated on observability)", () => {
  const c = ctx([{ server: "plex", tracked: false }]);
  const v = judgeTitle([PLEX], daysAgo(400), ev({ plays: 1, lastPlayedAt: daysAgo(500) }), c);
  assert.equal(v.state, "watched");
  assert.equal(v.reason, null);
});

test("soft evidence makes a title possibly watched; hard evidence beats soft (catches wrong precedence)", () => {
  const c = ctx([{ server: "plex" }]);
  assert.equal(judgeTitle([PLEX], daysAgo(400), ev({ softPlays: 2, softServers: ["plex"] }), c).state, "possiblyWatched");
  assert.equal(judgeTitle([PLEX], daysAgo(400), ev({ plays: 1, softPlays: 2 }), c).state, "watched");
  // Unobservable beats soft: nothing about the window is known either way.
  assert.equal(judgeTitle([PLEX], null, ev({ softPlays: 2 }), c).state, "unobservable");
});

test("idleAnchor: latest dated play (soft included) or the window start; null when unmeasurable", () => {
  const c = ctx([{ server: "plex", since: daysAgo(300) }]);
  const v = judgeTitle([PLEX], daysAgo(900), ev(), c);
  assert.equal(idleAnchor(v, ev())?.getTime(), daysAgo(300).getTime(), "never played → the window start");
  const played = ev({ plays: 1, lastPlayedAt: daysAgo(50) });
  assert.equal(idleAnchor(judgeTitle([PLEX], daysAgo(900), played, c), played)?.getTime(), daysAgo(50).getTime());
  const soft = ev({ softPlays: 1, softLastPlayedAt: daysAgo(5) });
  assert.equal(idleAnchor(judgeTitle([PLEX], daysAgo(900), soft, c), soft)?.getTime(), daysAgo(5).getTime());
  const undated = ev({ plays: 1, undated: true });
  assert.equal(idleAnchor(judgeTitle([PLEX], daysAgo(900), undated, c), undated), null, "an undated play could be yesterday");
  assert.equal(idleAnchor(judgeTitle([PLEX], null, ev(), c), ev()), null, "unobservable");
});

// ── seasons ─────────────────────────────────────────────────────────────────

test("a season's window opens at its first episode, its age counts from its NEWEST (catches the show's arrival used for a season)", () => {
  const c = ctx([{ server: "plex", since: daysAgo(1000) }]);
  const s = judgeSeason([PLEX], { seasonNumber: 3, episodes: 10, firstAddedAt: daysAgo(200), lastAddedAt: daysAgo(20) }, ev(), c);
  assert.equal(s.state, "neverWatched");
  assert.equal(s.windowStart?.getTime(), daysAgo(200).getTime());
  assert.equal(s.days, 20, "a season still gaining episodes is only as old as its latest one");
  assert.equal(s.seasonNumber, 3);
  assert.equal(s.episodes, 10);
});

test("a season with an undated episode is unobservable, never guessed", () => {
  const c = ctx([{ server: "plex" }]);
  const s = judgeSeason([PLEX], { seasonNumber: 1, episodes: 8, firstAddedAt: null, lastAddedAt: null }, ev(), c);
  assert.equal(s.state, "unobservable");
  assert.equal(s.reason, "addedUnknown");
});

test("seasonSizeIfAgreed: sizes add across instances only when every instance agrees on the episode count", () => {
  const hd = [{ seasonNumber: 1, sizeOnDisk: 10, episodeFileCount: 8 }, { seasonNumber: 2, sizeOnDisk: 20, episodeFileCount: 6 }];
  const uhd = [{ seasonNumber: 1, sizeOnDisk: 40, episodeFileCount: 8 }];
  assert.deepEqual(seasonSizeIfAgreed([hd, uhd], 1, 8), { bytes: 50, mismatch: false }, "HD + 4K are separate files");
  assert.deepEqual(seasonSizeIfAgreed([hd, uhd], 2, 7), { bytes: null, mismatch: true }, "a numbering disagreement attaches nothing");
  assert.deepEqual(seasonSizeIfAgreed([hd], 5, 4), { bytes: null, mismatch: false }, "no arr holds it");
  assert.deepEqual(seasonSizeIfAgreed([[{ seasonNumber: 1, sizeOnDisk: 0, episodeFileCount: 0 }]], 1, 8), { bytes: null, mismatch: false });
});

// ── upstream health ─────────────────────────────────────────────────────────

const status = (over: Partial<NwUpstreamStatus> = {}): NwUpstreamStatus => ({
  fetchedAt: daysAgo(1).toISOString(), attemptedAt: daysAgo(1).toISOString(), ok: true,
  entries: 100, matched: 90, samples: 50, agreed: 48, error: null, ...over,
});

test("upstream health: ok / failed / unreliable / stale / never", () => {
  assert.equal(upstreamHealth(status(), NOW), "ok");
  assert.equal(upstreamHealth(null, NOW), "never");
  assert.equal(upstreamHealth(status({ fetchedAt: null }), NOW), "never");
  assert.equal(upstreamHealth(status({ ok: false }), NOW), "failed");
  assert.equal(upstreamHealth(status({ matched: 0 }), NOW), "failed", "a parser that understands nothing is broken, not 'no plays'");
  assert.equal(upstreamHealth(status({ samples: UPSTREAM_MIN_SAMPLES, agreed: 5 }), NOW), "unreliable");
  assert.equal(upstreamHealth(status({ samples: UPSTREAM_MIN_SAMPLES - 1, agreed: 0 }), NOW), "ok", "too few samples say nothing");
  assert.equal(upstreamHealth(status({ fetchedAt: daysAgo(8).toISOString() }), NOW), "stale");
  assert.equal(upstreamHealth(status({ entries: 0, matched: 0, samples: 0, agreed: 0 }), NOW), "ok", "an empty history is a valid answer");
});

// ── tracking stamps ─────────────────────────────────────────────────────────

test("trackingStampsFor stamps only an off → on flip of a tracking switch", () => {
  const before = new Map<string, string | null>([["playHistoryPlexEnabled", "false"], ["playHistoryJellyfinEnabled", "true"]]);
  const out = trackingStampsFor(
    [["playHistoryPlexEnabled", "true"], ["playHistoryJellyfinEnabled", "true"], ["playHistoryEnabled", "false"], ["siteTitle", "x"]],
    before,
    NOW,
  );
  assert.deepEqual(out, [["playHistoryPlexTrackedSince", NOW.toISOString()]]);
  assert.deepEqual(trackingStampsFor([["playHistoryEnabled", "true"]], new Map(), NOW), [["playHistoryTrackedSince", NOW.toISOString()]], "absent counts as off");
});

// ── query parsing ───────────────────────────────────────────────────────────

test("parseNwQuery whitelists every parameter and clamps the page", () => {
  const q = (s: string) => parseNwQuery(new URLSearchParams(s));
  assert.deepEqual(q(""), {
    level: "title", state: "never", type: "all", q: "", eligibleOnly: false,
    sortBy: "size", sortDir: "desc", page: 1, limit: 50,
  });
  const injected = q("sortBy=size;DROP&sortDir=sideways&level=x&state=y&type=z&page=-3&limit=9999");
  assert.equal(injected.sortBy, "size");
  assert.equal(injected.sortDir, "desc");
  assert.equal(injected.level, "title");
  assert.equal(injected.state, "never");
  assert.equal(injected.type, "all");
  assert.equal(injected.page, 1);
  assert.equal(injected.limit, 200);
  assert.equal(q("sortBy=title").sortDir, "asc", "titles sort A→Z by default");
  assert.equal(q(`q=${"x".repeat(300)}`).q.length, 100);
});

test("state filter: 'never' is both never states, 'all' is everything but watched", () => {
  assert.ok(stateMatchesFilter("neverWatched", "never") && stateMatchesFilter("noPlaysSince", "never"));
  assert.ok(!stateMatchesFilter("possiblyWatched", "never"));
  assert.ok(stateMatchesFilter("possiblyWatched", "possible"));
  assert.ok(stateMatchesFilter("unobservable", "unknown"));
  assert.ok(stateMatchesFilter("unobservable", "all") && !stateMatchesFilter("watched", "all"));
});

test("normalizeTitleKey is trim + lower-case only", () => {
  assert.equal(normalizeTitleKey("  The Office  "), "the office");
  assert.equal(normalizeTitleKey(null), "");
  assert.notEqual(normalizeTitleKey("The Office (US)"), normalizeTitleKey("The Office"), "no fuzzy matching — a looser key only widens 'possibly'");
});
