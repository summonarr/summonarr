// Unit tests for the request watch grade RULES (src/lib/watch-grade.ts) — the
// pure half of the feature; the prisma half is tests/watch-grade-data.test.mts.
//
// The pins that matter most, because each is a way to produce a confidently
// WRONG letter rather than a crash:
//
//   1. GRACE IS NOT SCORED, EVEN WHEN WATCHED. Counting a promptly-watched request
//      early while its unwatched sibling waits out the same grace period biases
//      every recent requester upward. The score averages matured requests only.
//   2. COVERAGE. A request fulfilled before play history covered the user's
//      servers is never scored — watched or not — for the same symmetry reason:
//      scoring only the ones we happened to see watched is survivorship bias.
//   3. UNOBSERVABLE ≠ UNWATCHED. An unlinked or untracked user gets NO letter and
//      a null watch state, never an F built from data that was never collected.
//   4. CHUNKED VIEWING COUNTS. A movie watched across sittings that never cross
//      the per-session threshold still earns full credit from the summed plays.
//   5. TV SHARE. Full credit at the configured share of REGULAR-season library
//      episodes (specials excluded, integer ceil), partial credit below it.
//
// Zero-import module, so no stubs: every input is constructed here.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeWatchGrade,
  emptyWatchGradeSummary,
  gradeUser,
  hasWatchGradeSignal,
  letterForScore,
  MIN_GRADED_REQUESTS,
  parseWatchGradeSettings,
  requiredEpisodes,
  WATCH_GRADE_DEFAULTS,
  WATCH_GRADE_SETTING_KEYS,
  watchGradeSettingError,
  type GradableRequest,
  type GradeUserInput,
  type RequestPlayUnit,
  type WatchGradeIdentity,
} from "../src/lib/watch-grade.ts";

const DAY = 86_400_000;
const NOW = new Date("2026-09-16T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);
const TRACKED: WatchGradeIdentity = { kind: "tracked", coverageStart: daysAgo(1000) };

let seq = 0;
function movie(fulfilledDaysAgo: number, over: Partial<GradableRequest> = {}): GradableRequest {
  seq++;
  return {
    id: `req-${seq}`,
    tmdbId: 1000 + seq,
    mediaType: "MOVIE",
    title: `Movie ${seq}`,
    releaseYear: "2024",
    posterPath: null,
    createdAt: daysAgo(fulfilledDaysAgo + 2),
    fulfilledAt: daysAgo(fulfilledDaysAgo),
    ...over,
  };
}
function show(fulfilledDaysAgo: number, over: Partial<GradableRequest> = {}): GradableRequest {
  return movie(fulfilledDaysAgo, { mediaType: "TV", title: `Show ${seq + 1}`, ...over });
}
function watchedUnit(requestId: string, over: Partial<RequestPlayUnit> = {}): RequestPlayUnit {
  return {
    requestId,
    seasonNumber: null,
    episodeNumber: null,
    anyWatched: true,
    playSeconds: 6000,
    durationSeconds: 6000,
    ...over,
  };
}
function episode(requestId: string, season: number, ep: number, over: Partial<RequestPlayUnit> = {}): RequestPlayUnit {
  return watchedUnit(requestId, { seasonNumber: season, episodeNumber: ep, playSeconds: 1400, durationSeconds: 1400, ...over });
}

function grade(over: Partial<GradeUserInput>) {
  return gradeUser({
    requests: [],
    units: [],
    libraryEpisodes: new Map(),
    identity: TRACKED,
    watchedThresholdPercent: 80,
    settings: WATCH_GRADE_DEFAULTS,
    now: NOW,
    ...over,
  });
}

// ── letters ─────────────────────────────────────────────────────────────────

test("letter bands: A 80+, B 60+, C 40+, D 20+, F below — boundaries land on the higher letter", () => {
  assert.equal(letterForScore(100), "A");
  assert.equal(letterForScore(80), "A");
  assert.equal(letterForScore(79), "B");
  assert.equal(letterForScore(60), "B");
  assert.equal(letterForScore(59), "C");
  assert.equal(letterForScore(40), "C");
  assert.equal(letterForScore(39), "D");
  assert.equal(letterForScore(20), "D");
  assert.equal(letterForScore(19), "F");
  assert.equal(letterForScore(0), "F");
});

test(`a letter needs ${MIN_GRADED_REQUESTS} scored requests; below it the rate is reported without one`, () => {
  const two = [movie(60), movie(61)];
  const below = grade({ requests: two, units: [watchedUnit(two[0].id)] });
  assert.equal(below.summary.status, "insufficient");
  assert.equal(below.summary.letter, null);
  assert.equal(below.summary.score, 50);
  assert.equal(below.summary.graded, 2);

  const three = [movie(60), movie(61), movie(62)];
  const at = grade({ requests: three, units: [watchedUnit(three[0].id), watchedUnit(three[1].id)] });
  assert.equal(at.summary.status, "graded");
  assert.equal(at.summary.score, 67);
  assert.equal(at.summary.letter, "B");
  assert.deepEqual(
    { watched: at.summary.watched, partial: at.summary.partial, unwatched: at.summary.unwatched },
    { watched: 2, partial: 0, unwatched: 1 },
  );
});

// ── scoring eligibility ─────────────────────────────────────────────────────

test("grace period: a request inside it is listed but NOT scored — even one already watched", () => {
  const matured = [movie(40), movie(41), movie(42)]; // all unwatched, past the 30-day grace
  const fresh = movie(5); // watched promptly, still inside grace
  const out = grade({ requests: [...matured, fresh], units: [watchedUnit(fresh.id)] });

  assert.equal(out.summary.graded, 3);
  assert.equal(out.summary.inGrace, 1);
  assert.equal(out.summary.score, 0, "the prompt watch must not lift the score while its siblings are judged");
  assert.equal(out.summary.letter, "F");
  const v = out.verdicts.find((x) => x.requestId === fresh.id)!;
  assert.equal(v.scoring, "grace");
  assert.equal(v.watch, "watched"); // progress is still shown
  assert.equal(v.graceDaysLeft, 25);
});

test("grace boundary: exactly graceDays after fulfilment the request is scored", () => {
  const exact = movie(30);
  const out = grade({ requests: [exact] });
  assert.equal(out.verdicts[0].scoring, "scored");
  const almost = movie(29.5);
  const out2 = grade({ requests: [almost] });
  assert.equal(out2.verdicts[0].scoring, "grace");
  assert.equal(out2.verdicts[0].graceDaysLeft, 1); // ceil of half a day
});

test("coverage: a request fulfilled before tracking began is never scored, watched or not", () => {
  const identity: WatchGradeIdentity = { kind: "tracked", coverageStart: daysAgo(100) };
  const before = movie(150);
  const beforeWatched = movie(160);
  const after = [movie(50), movie(60), movie(70)];
  const out = grade({
    identity,
    requests: [before, beforeWatched, ...after],
    units: [watchedUnit(beforeWatched.id)],
  });
  assert.equal(out.summary.untracked, 2);
  assert.equal(out.summary.graded, 3);
  assert.equal(out.summary.score, 0, "the pre-coverage watch must not be scored either");
  assert.equal(out.verdicts.find((v) => v.requestId === beforeWatched.id)!.scoring, "untracked");
});

test("window: requests fulfilled before it are dropped entirely; windowDays 0 keeps everything", () => {
  const old = movie(400);
  const recent = [movie(40), movie(50), movie(60)];
  const windowed = grade({ requests: [old, ...recent] });
  assert.equal(windowed.verdicts.length, 3);
  assert.ok(!windowed.verdicts.some((v) => v.requestId === old.id));

  const unlimited = grade({ requests: [old, ...recent], settings: { ...WATCH_GRADE_DEFAULTS, windowDays: 0 } });
  assert.equal(unlimited.verdicts.length, 4);
  assert.equal(unlimited.summary.graded, 4);
});

// ── observability ───────────────────────────────────────────────────────────

test("unlinked: no letter, no watch states, nothing scored — never an F from absent data", () => {
  const reqs = [movie(40), movie(50), movie(60)];
  const out = grade({ identity: { kind: "unlinked" }, requests: reqs, units: reqs.map((r) => watchedUnit(r.id)) });
  assert.equal(out.summary.status, "unlinked");
  assert.equal(out.summary.letter, null);
  assert.equal(out.summary.score, null);
  assert.equal(out.summary.graded, 0);
  assert.equal(out.summary.untracked, 3);
  assert.ok(out.verdicts.every((v) => v.watch === null && v.scoring === "untracked" && v.credit === 0));
});

test("untracked (identity, or no history recorded yet): status untracked, nothing scored", () => {
  const reqs = [movie(40), movie(50), movie(60)];
  for (const identity of [{ kind: "untracked" }, { kind: "tracked", coverageStart: null }] as WatchGradeIdentity[]) {
    const out = grade({ identity, requests: reqs });
    assert.equal(out.summary.status, "untracked", JSON.stringify(identity));
    assert.equal(out.summary.letter, null);
    assert.equal(out.summary.graded, 0);
  }
});

// ── movie credit ────────────────────────────────────────────────────────────

test("movie: a watched/completed play earns full credit", () => {
  const r = movie(40);
  const out = grade({ requests: [r], units: [watchedUnit(r.id, { playSeconds: 10 })] });
  assert.equal(out.verdicts[0].credit, 1);
  assert.equal(out.verdicts[0].watch, "watched");
});

test("movie: chunked sittings that never crossed the per-session threshold still count once summed", () => {
  const r = movie(40);
  // 3 × 35 min of a 2 h film, each session unwatched on its own: 105/120 = 87.5% ≥ 80%.
  const out = grade({ requests: [r], units: [watchedUnit(r.id, { anyWatched: false, playSeconds: 6300, durationSeconds: 7200 })] });
  assert.equal(out.verdicts[0].credit, 1);

  const short = movie(41);
  // 79% summed — one second under the bar → only "started".
  const under = grade({ requests: [short], units: [watchedUnit(short.id, { anyWatched: false, playSeconds: 5688, durationSeconds: 7200 })] });
  assert.equal(under.verdicts[0].credit, 0.5);
  assert.equal(under.verdicts[0].watch, "partial");
});

test("movie: a real start (≥5 min, or a quarter of a short runtime) is half credit; a mis-click is nothing", () => {
  const started = movie(40);
  const misclick = movie(41);
  const shortFilm = movie(42);
  const out = grade({
    requests: [started, misclick, shortFilm],
    units: [
      watchedUnit(started.id, { anyWatched: false, playSeconds: 300, durationSeconds: 7200 }),
      watchedUnit(misclick.id, { anyWatched: false, playSeconds: 299, durationSeconds: 7200 }),
      // 8-minute short: the floor is 2 min (25%), not 5.
      watchedUnit(shortFilm.id, { anyWatched: false, playSeconds: 120, durationSeconds: 480 }),
    ],
  });
  const credit = (id: string) => out.verdicts.find((v) => v.requestId === id)!.credit;
  assert.equal(credit(started.id), 0.5);
  assert.equal(credit(misclick.id), 0);
  assert.equal(credit(shortFilm.id), 0.5);
});

// ── TV credit ───────────────────────────────────────────────────────────────

test("TV: full credit at the configured share of library episodes, proportional below it", () => {
  const full = show(40);
  const partial = show(41);
  const library = new Map([
    [full.tmdbId, 10],
    [partial.tmdbId, 10],
  ]);
  const out = grade({
    requests: [full, partial],
    libraryEpisodes: library,
    units: [
      ...[1, 2, 3, 4, 5].map((e) => episode(full.id, 1, e)),
      ...[1, 2, 3, 4].map((e) => episode(partial.id, 1, e)),
      episode(partial.id, 1, 5, { anyWatched: false, playSeconds: 400 }), // started only → half
    ],
  });
  const vFull = out.verdicts.find((v) => v.requestId === full.id)!;
  assert.equal(vFull.credit, 1);
  assert.deepEqual(vFull.episodes, { watched: 5, started: 0, library: 10, required: 5 });
  const vPartial = out.verdicts.find((v) => v.requestId === partial.id)!;
  assert.equal(vPartial.credit, 0.9);
  assert.equal(vPartial.watch, "partial");
  assert.deepEqual(vPartial.episodes, { watched: 4, started: 1, library: 10, required: 5 });
});

test("TV: specials and plays with no episode identity don't count", () => {
  const r = show(40);
  const out = grade({
    requests: [r],
    libraryEpisodes: new Map([[r.tmdbId, 2]]),
    units: [episode(r.id, 0, 1), episode(r.id, 0, 2), episode(r.id, 1, 1, { episodeNumber: null }), watchedUnit(r.id)],
  });
  assert.equal(out.verdicts[0].credit, 0);
  assert.equal(out.verdicts[0].episodes!.watched, 0);
});

test("TV: unknown library size needs one watched episode; a larger share is honoured", () => {
  const unknown = show(40);
  const strict = show(41);
  const out = grade({
    requests: [unknown, strict],
    libraryEpisodes: new Map([[strict.tmdbId, 8]]),
    settings: { ...WATCH_GRADE_DEFAULTS, tvEpisodePercent: 100 },
    units: [episode(unknown.id, 1, 1), ...[1, 2, 3, 4, 5, 6].map((e) => episode(strict.id, 1, e))],
  });
  const vUnknown = out.verdicts.find((v) => v.requestId === unknown.id)!;
  assert.equal(vUnknown.credit, 1);
  assert.deepEqual(vUnknown.episodes, { watched: 1, started: 0, library: 0, required: 1 });
  assert.equal(out.verdicts.find((v) => v.requestId === strict.id)!.credit, 0.75);
});

test("requiredEpisodes: integer ceil — exact multiples don't overshoot, remainders round up", () => {
  // Float traps: 100 * 0.07 === 7.000000000000001 and 25 * 0.28 === 7.000000000000001,
  // so a `ceil(n * (p / 100))` asks for an episode more than the share on exact multiples.
  assert.equal(requiredEpisodes(100, 7), 7);
  assert.equal(requiredEpisodes(25, 28), 7);
  assert.equal(requiredEpisodes(100, 55), 55);
  assert.equal(requiredEpisodes(10, 70), 7);
  assert.equal(requiredEpisodes(10, 50), 5);
  assert.equal(requiredEpisodes(7, 50), 4);
  assert.equal(requiredEpisodes(3, 1), 1);
  assert.equal(requiredEpisodes(1000, 33), 330);
  assert.equal(requiredEpisodes(0, 50), 1);
  assert.equal(requiredEpisodes(-5, 50), 1);
});

// ── output shape ────────────────────────────────────────────────────────────

test("verdicts are newest fulfilment first, credit rounded to two decimals", () => {
  const a = movie(90);
  const b = movie(40);
  const c = show(60);
  const out = grade({
    requests: [a, b, c],
    libraryEpisodes: new Map([[c.tmdbId, 9]]),
    units: [episode(c.id, 1, 1)],
  });
  assert.deepEqual(out.verdicts.map((v) => v.requestId), [b.id, c.id, a.id]);
  assert.equal(out.verdicts[1].credit, 0.2); // 1 of 5 required
});

test("score averages raw credits before rounding (no per-request rounding drift)", () => {
  // Two 16-episode shows need 8 each: 1 watched = 0.125, 3 watched = 0.375. The raw
  // mean is exactly 25%. Averaging the DISPLAYED credits (0.13 + 0.38) would read 26%.
  const reqs = [show(40), show(41)];
  const library = new Map(reqs.map((r) => [r.tmdbId, 16] as [number, number]));
  const units = [episode(reqs[0].id, 1, 1), episode(reqs[1].id, 1, 1), episode(reqs[1].id, 1, 2), episode(reqs[1].id, 1, 3)];
  const out = grade({ requests: reqs, libraryEpisodes: library, units });
  assert.deepEqual(out.verdicts.map((v) => v.credit).sort(), [0.13, 0.38]);
  assert.equal(out.summary.score, 25);
});

// ── settings ────────────────────────────────────────────────────────────────

test("parseWatchGradeSettings: defaults for missing/garbage/out-of-range rows; windowDays accepts 0", () => {
  assert.deepEqual(parseWatchGradeSettings({}), WATCH_GRADE_DEFAULTS);
  assert.deepEqual(
    parseWatchGradeSettings({
      [WATCH_GRADE_SETTING_KEYS.graceDays]: "abc",
      [WATCH_GRADE_SETTING_KEYS.windowDays]: "29",
      [WATCH_GRADE_SETTING_KEYS.tvEpisodePercent]: "101",
    }),
    WATCH_GRADE_DEFAULTS,
  );
  assert.deepEqual(
    parseWatchGradeSettings({
      [WATCH_GRADE_SETTING_KEYS.graceDays]: "14",
      [WATCH_GRADE_SETTING_KEYS.windowDays]: "0",
      [WATCH_GRADE_SETTING_KEYS.tvEpisodePercent]: "100",
    }),
    { graceDays: 14, windowDays: 0, tvEpisodePercent: 100 },
  );
  // Grace 0 would score every request the moment it lands — rejected.
  assert.equal(parseWatchGradeSettings({ [WATCH_GRADE_SETTING_KEYS.graceDays]: "0" }).graceDays, 30);
  // Non-integers never partially parse ("7.5" is not 7).
  assert.equal(parseWatchGradeSettings({ [WATCH_GRADE_SETTING_KEYS.graceDays]: "7.5" }).graceDays, 30);
});

test("watchGradeSettingError: the write-side validator agrees with the parser on every bound", () => {
  const cases: [string, string, boolean][] = [
    ["watchGradeGraceDays", "1", true],
    ["watchGradeGraceDays", "365", true],
    ["watchGradeGraceDays", "0", false],
    ["watchGradeGraceDays", "366", false],
    ["watchGradeWindowDays", "0", true],
    ["watchGradeWindowDays", "30", true],
    ["watchGradeWindowDays", "29", false],
    ["watchGradeWindowDays", "3651", false],
    ["watchGradeTvPercent", "1", true],
    ["watchGradeTvPercent", "100", true],
    ["watchGradeTvPercent", "-1", false],
    ["watchGradeTvPercent", "50%", false],
  ];
  for (const [key, value, ok] of cases) {
    assert.equal(watchGradeSettingError(key, value) === null, ok, `${key}=${value}`);
    const field = (Object.keys(WATCH_GRADE_SETTING_KEYS) as (keyof typeof WATCH_GRADE_SETTING_KEYS)[]).find(
      (f) => WATCH_GRADE_SETTING_KEYS[f] === key,
    )!;
    const parsed = parseWatchGradeSettings({ [key]: value })[field];
    assert.equal(ok ? parsed === Number(value) : parsed === WATCH_GRADE_DEFAULTS[field], true, `parse ${key}=${value}`);
  }
  // Any other key is not this validator's business.
  assert.equal(watchGradeSettingError("quotaLimit", "not a number"), null);
});

// ── display helpers ─────────────────────────────────────────────────────────

test("hasWatchGradeSignal: nothing to show for null or an all-zero summary", () => {
  assert.equal(hasWatchGradeSignal(null), false);
  assert.equal(hasWatchGradeSignal(emptyWatchGradeSummary()), false);
  assert.equal(hasWatchGradeSignal({ ...emptyWatchGradeSummary("unlinked"), untracked: 1 }), true);
  assert.equal(hasWatchGradeSignal({ ...emptyWatchGradeSummary(), inGrace: 2 }), true);
});

test("describeWatchGrade: every status explains itself", () => {
  const reqs = [movie(40), movie(50), movie(60)];
  const graded = grade({ requests: reqs, units: [watchedUnit(reqs[0].id)] }).summary;
  assert.match(describeWatchGrade(graded), /^Watch grade D — 33% across 3 fulfilled requests \(1 watched, 0 partly, 2 not watched\)$/);
  assert.match(
    describeWatchGrade({ ...emptyWatchGradeSummary(), inGrace: 2 }, WATCH_GRADE_DEFAULTS),
    /2 fulfilled requests still inside the 30-day grace period/,
  );
  assert.match(describeWatchGrade({ ...emptyWatchGradeSummary(), inGrace: 1 }), /still inside the grace period/);
  assert.match(describeWatchGrade({ ...emptyWatchGradeSummary(), untracked: 1 }), /1 fulfilled request predates play history tracking/);
  assert.match(describeWatchGrade({ ...emptyWatchGradeSummary(), graded: 2 }), /needs 3 scored requests, has 2/);
  assert.match(describeWatchGrade(emptyWatchGradeSummary("unlinked")), /no Plex or Jellyfin account is linked/);
  assert.match(describeWatchGrade(emptyWatchGradeSummary("untracked")), /isn't recording/);
});
