// Unit tests for the library cleanup rule engine (src/lib/library-cleanup.ts) —
// pure, no DB, no network.
//
// What these pin, and why each matters for a feature that deletes media:
//   1. EACH RULE matches exactly its own condition, and only when enabled.
//   2. EACH EXCLUSION holds a title back on its own, whatever rule matched.
//   3. COMBINATION is "any enabled rule, minus every exclusion", and BOTH lists
//      are reported in full — the admin sees every reason, not the first one.
//   4. The watch rules only judge what play history actually OBSERVED: a title
//      added before tracking began is measured from the first recorded play, and
//      with tracking off (or no history at all) they never match. Without this
//      an install that just enabled tracking would see its whole library as
//      "never watched".
//   5. The settings write path refuses instead of repairing; the read path
//      falls back per field.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLEANUP_SETTING_DEFAULTS,
  CLEANUP_SETTING_KEYS,
  evaluateCleanupTitle,
  parseCleanupSettings,
  sonarrStatusIsAiring,
  tmdbStatusIsAiring,
  validateCleanupSettingsPatch,
  type CleanupContext,
  type CleanupSettings,
  type CleanupTitleFacts,
} from "../src/lib/library-cleanup.ts";

const NOW = new Date("2026-10-01T00:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

// Every rule on, every exclusion off — each test turns on what it is about.
const ALL_RULES: CleanupSettings = {
  ...CLEANUP_SETTING_DEFAULTS,
  unwatchedEnabled: true,
  unwatchedDays: 180,
  neverWatchedEnabled: true,
  neverWatchedDays: 90,
  votesEnabled: true,
  votesMin: 3,
  minAgeDays: 0,
  recentRequestDays: 0,
  excludeAiring: false,
};
const CTX: CleanupContext = { now: NOW, playHistoryTracked: true, historyStart: daysAgo(1000) };

function title(over: Partial<CleanupTitleFacts> = {}): CleanupTitleFacts {
  return {
    tmdbId: 1, mediaType: "MOVIE", addedAt: daysAgo(400), playCount: 5, lastPlayedAt: daysAgo(10),
    votes: 0, requests: [], watchlisted: false, playingNow: false, airing: null, protected: false,
    ...over,
  };
}
const judge = (t: CleanupTitleFacts, s: CleanupSettings = ALL_RULES, ctx: CleanupContext = CTX) => evaluateCleanupTitle(t, s, ctx);

// ── the rules ───────────────────────────────────────────────────────────────

test("a recently watched, unvoted title matches nothing", () => {
  const v = judge(title());
  assert.deepEqual(v.matched, []);
  assert.equal(v.candidate, false);
});

test("unwatched: no play for N days matches; a play inside the window does not", () => {
  assert.deepEqual(judge(title({ lastPlayedAt: daysAgo(181) })).matched, ["unwatched"]);
  assert.deepEqual(judge(title({ lastPlayedAt: daysAgo(180) })).matched, ["unwatched"], "exactly N days is unwatched for N days");
  assert.deepEqual(judge(title({ lastPlayedAt: daysAgo(179) })).matched, []);
});

test("unwatched: a never-played title counts from when it was added", () => {
  assert.ok(judge(title({ playCount: 0, lastPlayedAt: null, addedAt: daysAgo(200) })).matched.includes("unwatched"));
  assert.ok(!judge(title({ playCount: 0, lastPlayedAt: null, addedAt: daysAgo(100) }), { ...ALL_RULES, neverWatchedEnabled: false }).matched.includes("unwatched"));
});

test("neverWatched: zero plays AND in the library N days; any play at all clears it", () => {
  assert.deepEqual(judge(title({ playCount: 0, lastPlayedAt: null, addedAt: daysAgo(91) }), { ...ALL_RULES, unwatchedEnabled: false }).matched, ["neverWatched"]);
  assert.deepEqual(judge(title({ playCount: 0, lastPlayedAt: null, addedAt: daysAgo(89) }), { ...ALL_RULES, unwatchedEnabled: false }).matched, []);
  assert.deepEqual(judge(title({ playCount: 1, lastPlayedAt: daysAgo(500), addedAt: daysAgo(600) }), { ...ALL_RULES, unwatchedEnabled: false }).matched, []);
});

test("votes: at least N deletion votes", () => {
  const s = { ...ALL_RULES, unwatchedEnabled: false, neverWatchedEnabled: false };
  assert.deepEqual(judge(title({ votes: 3 }), s).matched, ["votes"]);
  assert.deepEqual(judge(title({ votes: 2 }), s).matched, []);
});

test("a disabled rule never matches, however strongly its condition holds", () => {
  const off = { ...CLEANUP_SETTING_DEFAULTS, minAgeDays: 0, recentRequestDays: 0 };
  const v = judge(title({ playCount: 0, lastPlayedAt: null, addedAt: daysAgo(5000), votes: 99 }), off);
  assert.deepEqual(v.matched, []);
  assert.equal(v.candidate, false);
});

test("every matching rule is reported, in a stable order", () => {
  const v = judge(title({ playCount: 0, lastPlayedAt: null, addedAt: daysAgo(400), votes: 5 }));
  assert.deepEqual(v.matched, ["unwatched", "neverWatched", "votes"]);
  assert.equal(v.candidate, true);
});

// ── the observed window ─────────────────────────────────────────────────────

test("a title added before tracking began is measured from the first recorded play, not its addedAt", () => {
  // Added 5 years ago, but play history only started 30 days ago: we have seen
  // 30 days of it, which proves nothing about a 90- or 180-day rule.
  const ctx = { ...CTX, historyStart: daysAgo(30) };
  const v = judge(title({ playCount: 0, lastPlayedAt: null, addedAt: daysAgo(1800) }), ALL_RULES, ctx);
  assert.deepEqual(v.matched, []);
  assert.equal(v.observedSince?.getTime(), daysAgo(30).getTime());
  // Once history has run long enough, the same title matches.
  const later = { ...CTX, historyStart: daysAgo(200) };
  assert.deepEqual(judge(title({ playCount: 0, lastPlayedAt: null, addedAt: daysAgo(1800) }), ALL_RULES, later).matched, ["unwatched", "neverWatched"]);
});

test("with play history tracking OFF the watch rules never match — votes still do", () => {
  const ctx = { ...CTX, playHistoryTracked: false };
  const v = judge(title({ playCount: 0, lastPlayedAt: null, addedAt: daysAgo(5000), votes: 4 }), ALL_RULES, ctx);
  assert.deepEqual(v.matched, ["votes"]);
});

test("with NO history at all the watch rules never match", () => {
  const ctx = { ...CTX, historyStart: null };
  assert.deepEqual(judge(title({ playCount: 0, lastPlayedAt: null, addedAt: daysAgo(5000) }), ALL_RULES, ctx).matched, []);
});

test("an unknown addedAt can't satisfy a watch rule", () => {
  assert.deepEqual(judge(title({ playCount: 0, lastPlayedAt: null, addedAt: null })).matched, []);
});

// ── the exclusions ──────────────────────────────────────────────────────────

// A title every rule matches; each exclusion below must hold it back on its own.
const DOOMED = title({ playCount: 0, lastPlayedAt: null, addedAt: daysAgo(400), votes: 9 });

test("baseline: the doomed title is a candidate with nothing excluding it", () => {
  const v = judge(DOOMED);
  assert.equal(v.candidate, true);
  assert.deepEqual(v.excludedBy, []);
});

test("recentlyAdded: added less than minAgeDays ago (votes can match a brand-new title)", () => {
  const v = judge({ ...DOOMED, addedAt: daysAgo(5) }, { ...ALL_RULES, minAgeDays: 30 });
  assert.deepEqual(v.matched, ["votes"]);
  assert.deepEqual(v.excludedBy, ["recentlyAdded"]);
  assert.equal(v.candidate, false);
  assert.deepEqual(judge({ ...DOOMED, addedAt: daysAgo(5) }, { ...ALL_RULES, minAgeDays: 0 }).excludedBy, [], "0 turns it off");
});

test("activeRequest: a PENDING or APPROVED request for the title, whoever made it", () => {
  for (const status of ["PENDING", "APPROVED"] as const) {
    assert.deepEqual(judge({ ...DOOMED, requests: [{ status, availableAt: null }] }).excludedBy, ["activeRequest"], status);
  }
  assert.deepEqual(judge({ ...DOOMED, requests: [{ status: "DECLINED", availableAt: null }] }).excludedBy, []);
});

test("recentlyFulfilled: an AVAILABLE request fulfilled inside the window; an old one does not hold", () => {
  const s = { ...ALL_RULES, recentRequestDays: 30 };
  assert.deepEqual(judge({ ...DOOMED, requests: [{ status: "AVAILABLE", availableAt: daysAgo(10) }] }, s).excludedBy, ["recentlyFulfilled"]);
  assert.deepEqual(judge({ ...DOOMED, requests: [{ status: "AVAILABLE", availableAt: daysAgo(40) }] }, s).excludedBy, []);
  assert.deepEqual(judge({ ...DOOMED, requests: [{ status: "AVAILABLE", availableAt: daysAgo(10) }] }, { ...s, recentRequestDays: 0 }).excludedBy, [], "0 turns it off");
});

test("watchlisted, playingNow and protected each hold a title back alone", () => {
  assert.deepEqual(judge({ ...DOOMED, watchlisted: true }).excludedBy, ["watchlisted"]);
  assert.deepEqual(judge({ ...DOOMED, playingNow: true }).excludedBy, ["playingNow"]);
  assert.deepEqual(judge({ ...DOOMED, protected: true }).excludedBy, ["protected"]);
});

test("airing: only TV, only when known to be airing, and only while the exclusion is on", () => {
  const s = { ...ALL_RULES, excludeAiring: true };
  assert.deepEqual(judge({ ...DOOMED, mediaType: "TV", airing: true }, s).excludedBy, ["airing"]);
  assert.deepEqual(judge({ ...DOOMED, mediaType: "TV", airing: false }, s).excludedBy, []);
  assert.deepEqual(judge({ ...DOOMED, mediaType: "TV", airing: null }, s).excludedBy, [], "unknown is not airing");
  assert.deepEqual(judge({ ...DOOMED, mediaType: "TV", airing: true }, { ...s, excludeAiring: false }).excludedBy, []);
  assert.deepEqual(judge({ ...DOOMED, mediaType: "MOVIE", airing: true }, s).excludedBy, []);
});

test("every applying exclusion is reported, not just the first", () => {
  const v = judge(
    { ...DOOMED, mediaType: "TV", airing: true, watchlisted: true, playingNow: true, protected: true, requests: [{ status: "APPROVED", availableAt: null }] },
    { ...ALL_RULES, excludeAiring: true },
  );
  assert.deepEqual(v.excludedBy, ["activeRequest", "watchlisted", "playingNow", "airing", "protected"]);
  assert.deepEqual(v.matched, ["unwatched", "neverWatched", "votes"], "the matched rules are still shown beside the exclusions");
  assert.equal(v.candidate, false);
});

// ── status helpers ──────────────────────────────────────────────────────────

test("Sonarr and TMDB airing statuses", () => {
  assert.equal(sonarrStatusIsAiring("continuing"), true);
  assert.equal(sonarrStatusIsAiring("upcoming"), true);
  assert.equal(sonarrStatusIsAiring("ended"), false);
  assert.equal(sonarrStatusIsAiring(undefined), null);
  assert.equal(tmdbStatusIsAiring("Returning Series", false), true);
  assert.equal(tmdbStatusIsAiring("Ended", false), false);
  assert.equal(tmdbStatusIsAiring("Canceled", undefined), false);
  assert.equal(tmdbStatusIsAiring(undefined, true), true);
  assert.equal(tmdbStatusIsAiring(undefined, undefined), null);
});

// ── settings ────────────────────────────────────────────────────────────────

test("read path: missing or malformed rows fall back per field; valid rows apply", () => {
  assert.deepEqual(parseCleanupSettings({}), CLEANUP_SETTING_DEFAULTS);
  const s = parseCleanupSettings({
    [CLEANUP_SETTING_KEYS.unwatchedEnabled]: "true",
    [CLEANUP_SETTING_KEYS.unwatchedDays]: "200",
    [CLEANUP_SETTING_KEYS.votesMin]: "0", // below its minimum → default
    [CLEANUP_SETTING_KEYS.neverWatchedDays]: "12.5", // not an integer → default
    [CLEANUP_SETTING_KEYS.excludeAiring]: "yes", // not "true"/"false" → default
    [CLEANUP_SETTING_KEYS.minAgeDays]: "0",
  });
  assert.equal(s.unwatchedEnabled, true);
  assert.equal(s.unwatchedDays, 200);
  assert.equal(s.votesMin, CLEANUP_SETTING_DEFAULTS.votesMin);
  assert.equal(s.neverWatchedDays, CLEANUP_SETTING_DEFAULTS.neverWatchedDays);
  assert.equal(s.excludeAiring, CLEANUP_SETTING_DEFAULTS.excludeAiring);
  assert.equal(s.minAgeDays, 0);
});

test("rules default OFF — enabling the page must not make anything a candidate by itself", () => {
  assert.equal(CLEANUP_SETTING_DEFAULTS.unwatchedEnabled, false);
  assert.equal(CLEANUP_SETTING_DEFAULTS.neverWatchedEnabled, false);
  assert.equal(CLEANUP_SETTING_DEFAULTS.votesEnabled, false);
});

test("write path: valid fields map to their Setting keys", () => {
  const r = validateCleanupSettingsPatch({ unwatchedEnabled: true, unwatchedDays: 365, minAgeDays: 0 });
  assert.ok("rows" in r);
  assert.deepEqual(r.rows, [
    { key: "cleanupUnwatchedEnabled", value: "true" },
    { key: "cleanupUnwatchedDays", value: "365" },
    { key: "cleanupMinAgeDays", value: "0" },
  ]);
});

test("write path: refuses the whole patch on any bad value — never repairs", () => {
  for (const bad of [
    { unwatchedDays: 0 },
    { unwatchedDays: 3651 },
    { unwatchedDays: 1.5 },
    { unwatchedDays: "30" },
    { votesMin: 0 },
    { unwatchedEnabled: "true" },
    { somethingElse: true },
    {},
    null,
    [],
  ]) {
    assert.ok("error" in validateCleanupSettingsPatch(bad), JSON.stringify(bad));
  }
  assert.ok("error" in validateCleanupSettingsPatch({ unwatchedDays: 30, votesMin: -1 }), "one bad field sinks the patch");
});
