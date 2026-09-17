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
//   5. A SAMPLE IS NOT A START. Half credit needs a quarter of the runtime (and
//      15 minutes; half the runtime for a short). With a five-minute floor a
//      requester who sampled everything could never score below a C.
//   6. TV IS PER SEASON, BEST SEASON. Full credit at the configured share of ONE
//      season's regular-season library episodes (specials excluded, integer
//      ceil), partial below it — and a finished season's credit never decays as
//      the library gains later seasons, which a whole-show denominator did.
//   7. ONE TITLE, ONE UNIT. The same title requested on two instances is folded
//      into one, so a watch or a miss is never counted twice.
//   8. OTHER VIEWERS. A request the requester skipped counts as watched once
//      enough OTHER people watched it — a movie play flagged watched, or a season
//      to the same share — one person counted once however many rows they left.
//      It can only raise a scored request's credit, and 0 must mean off.
//   9. CUTOFFS ARE SETTINGS, AND ALWAYS DESCENDING. The letter follows the
//      admin's cutoffs and "requests needed" count; an out-of-order set is
//      refused on write (validated RAW, so the read-side repair can't hide it)
//      and falls back to the defaults — all four together — on read.
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
  parseWatchGradeFields,
  parseWatchGradeSettings,
  requiredEpisodes,
  startedFloorSeconds,
  WATCH_GRADE_DEFAULTS,
  WATCH_GRADE_SETTING_KEYS,
  watchGradeBands,
  watchGradeCrossFieldError,
  watchGradeSettingError,
  watchGradeSpread,
  watchGradeVolume,
  type GradableRequest,
  type GradeUserInput,
  type OtherViewerWatch,
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
// tmdbId → season → library episodes.
function lib(...shows: [number, Record<number, number>][]): Map<number, Map<number, number>> {
  return new Map(shows.map(([tmdbId, seasons]) => [tmdbId, new Map(Object.entries(seasons).map(([s, n]) => [Number(s), n]))]));
}
// What one other person watched: a movie (watched 1) or a season's episode count.
function by(viewer: string, requestId: string, watched = 1, seasonNumber: number | null = null): OtherViewerWatch {
  return { requestId, viewer, seasonNumber, watched };
}

function grade(over: Partial<GradeUserInput>) {
  return gradeUser({
    requests: [],
    units: [],
    otherWatches: [],
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

test(`by default a letter needs ${WATCH_GRADE_DEFAULTS.minGradedRequests} scored requests; below it the rate is reported without one`, () => {
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

test("letter cutoffs are settings: the letter follows them, boundaries landing on the higher letter", () => {
  const strict = { ...WATCH_GRADE_DEFAULTS, bandA: 95, bandB: 85, bandC: 70, bandD: 50 };
  assert.equal(letterForScore(95, strict), "A");
  assert.equal(letterForScore(94, strict), "B");
  assert.equal(letterForScore(85, strict), "B");
  assert.equal(letterForScore(84, strict), "C");
  assert.equal(letterForScore(70, strict), "C");
  assert.equal(letterForScore(69, strict), "D");
  assert.equal(letterForScore(50, strict), "D");
  assert.equal(letterForScore(49, strict), "F");
  assert.deepEqual(watchGradeBands(strict).map((b) => `${b.letter}${b.min}`), ["A95", "B85", "C70", "D50", "F0"]);

  // Through gradeUser: 4 of 5 watched is 80% — an A by default, a C under the strict cutoffs.
  const reqs = [movie(40), movie(41), movie(42), movie(43), movie(44)];
  const units = reqs.slice(0, 4).map((r) => watchedUnit(r.id));
  assert.equal(grade({ requests: reqs, units }).summary.letter, "A");
  assert.equal(grade({ requests: reqs, units, settings: strict }).summary.letter, "C");
});

test("requests needed for a letter is a setting, carried on the summary for list surfaces", () => {
  const two = [movie(40), movie(41)];
  const one = grade({ requests: two, units: [watchedUnit(two[0].id)], settings: { ...WATCH_GRADE_DEFAULTS, minGradedRequests: 1 } }).summary;
  assert.deepEqual({ status: one.status, letter: one.letter, min: one.minGradedRequests }, { status: "graded", letter: "C", min: 1 });

  const four = [movie(40), movie(41), movie(42), movie(43)];
  const five = grade({ requests: four, units: four.map((r) => watchedUnit(r.id)), settings: { ...WATCH_GRADE_DEFAULTS, minGradedRequests: 5 } }).summary;
  assert.deepEqual({ status: five.status, letter: five.letter, score: five.score, min: five.minGradedRequests }, { status: "insufficient", letter: null, score: 100, min: 5 });
  assert.match(describeWatchGrade(five), /needs 5 scored requests, has 4/);
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
  assert.ok(out.verdicts.every((v) => v.watch === null && v.scoring === "untracked" && v.credit === 0 && v.otherViewers === null));
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

test("startedFloorSeconds: a quarter of the runtime, never under 15 minutes, half of a short; 15 minutes when unknown", () => {
  assert.equal(startedFloorSeconds(7200), 1800); // 2 h → 30 min
  assert.equal(startedFloorSeconds(5400), 1350); // 90 min → 22.5 min
  assert.equal(startedFloorSeconds(3600), 900); // 60 min → the 15-minute floor
  assert.equal(startedFloorSeconds(2640), 900); // 44 min → still the floor (34%)
  assert.equal(startedFloorSeconds(1320), 660); // 22 min → half of it
  assert.equal(startedFloorSeconds(600), 300); // 10 min → half of it
  assert.equal(startedFloorSeconds(0), 900);
});

test("movie: half credit needs a real start — a five-minute sample of a feature is nothing", () => {
  const feature = movie(40);
  const sample = movie(41);
  const hour = movie(42);
  const hourShort = movie(43);
  const short = movie(44);
  const unknown = movie(45);
  const out = grade({
    requests: [feature, sample, hour, hourShort, short, unknown],
    units: [
      watchedUnit(feature.id, { anyWatched: false, playSeconds: 1800, durationSeconds: 7200 }), // 25% of 2 h
      watchedUnit(sample.id, { anyWatched: false, playSeconds: 300, durationSeconds: 7200 }), // the old 5-minute floor
      watchedUnit(hour.id, { anyWatched: false, playSeconds: 900, durationSeconds: 3600 }), // 15 of 60 min
      watchedUnit(hourShort.id, { anyWatched: false, playSeconds: 899, durationSeconds: 3600 }),
      watchedUnit(short.id, { anyWatched: false, playSeconds: 660, durationSeconds: 1320 }), // half of 22 min
      watchedUnit(unknown.id, { anyWatched: false, playSeconds: 900, durationSeconds: 0 }),
    ],
  });
  const credit = (id: string) => out.verdicts.find((v) => v.requestId === id)!.credit;
  assert.equal(credit(feature.id), 0.5);
  assert.equal(credit(sample.id), 0, "a sample is not a start");
  assert.equal(credit(hour.id), 0.5);
  assert.equal(credit(hourShort.id), 0);
  assert.equal(credit(short.id), 0.5);
  assert.equal(credit(unknown.id), 0.5);
});

// ── TV credit ───────────────────────────────────────────────────────────────

test("TV: full credit at the configured share of ONE season's library episodes, proportional below it", () => {
  const full = show(40);
  const partial = show(41);
  const out = grade({
    requests: [full, partial],
    libraryEpisodes: lib([full.tmdbId, { 1: 10, 2: 10 }], [partial.tmdbId, { 1: 10 }]),
    units: [
      ...[1, 2, 3, 4, 5].map((e) => episode(full.id, 1, e)),
      ...[1, 2, 3, 4].map((e) => episode(partial.id, 1, e)),
      episode(partial.id, 1, 5, { anyWatched: false, playSeconds: 700 }), // half of a 23-min episode → started → half
    ],
  });
  const vFull = out.verdicts.find((v) => v.requestId === full.id)!;
  assert.equal(vFull.credit, 1, "half of season 1 is enough — season 2 is not part of the bar");
  assert.deepEqual(vFull.episodes, { season: 1, watched: 5, started: 0, library: 10, required: 5 });
  const vPartial = out.verdicts.find((v) => v.requestId === partial.id)!;
  assert.equal(vPartial.credit, 0.9);
  assert.equal(vPartial.watch, "partial");
  assert.deepEqual(vPartial.episodes, { season: 1, watched: 4, started: 1, library: 10, required: 5 });
});

test("TV: the best season counts, an exact tie reports the earliest, and a finished season never decays", () => {
  const r = show(40);
  const units = [...[1, 2, 3].map((e) => episode(r.id, 1, e)), ...[1, 2, 3, 4].map((e) => episode(r.id, 2, e))];
  const best = grade({ requests: [r], libraryEpisodes: lib([r.tmdbId, { 1: 10, 2: 10 }]), units }).verdicts[0];
  assert.equal(best.credit, 0.8);
  assert.equal(best.episodes!.season, 2);

  const tie = grade({
    requests: [r],
    libraryEpisodes: lib([r.tmdbId, { 1: 10, 2: 10 }]),
    units: [...[1, 2, 3, 4, 5].map((e) => episode(r.id, 1, e)), ...[1, 2, 3, 4, 5].map((e) => episode(r.id, 2, e))],
  }).verdicts[0];
  assert.equal(tie.credit, 1);
  assert.equal(tie.episodes!.season, 1);

  // Season 1 fully watched when it was all there was. Two more seasons land later:
  // under a whole-show denominator this would read 8 of 12 required and DROP to
  // partial with no action by the user. Per season it stays exactly where it was.
  const finished = [1, 2, 3, 4, 5, 6, 7, 8].map((e) => episode(r.id, 1, e));
  const later: Record<number, number>[] = [{ 1: 8 }, { 1: 8, 2: 8 }, { 1: 8, 2: 8, 3: 8 }];
  for (const library of later) {
    const v = grade({ requests: [r], libraryEpisodes: lib([r.tmdbId, library]), units: finished }).verdicts[0];
    assert.equal(v.credit, 1, JSON.stringify(library));
    assert.deepEqual(v.episodes, { season: 1, watched: 8, started: 0, library: 8, required: 4 });
  }
});

test("TV: with no plays the earliest library season is reported; with nothing known at all, season null", () => {
  const known = show(40);
  const unknown = show(41);
  const out = grade({ requests: [known, unknown], libraryEpisodes: lib([known.tmdbId, { 2: 6, 1: 10 }]) });
  const vKnown = out.verdicts.find((v) => v.requestId === known.id)!;
  assert.equal(vKnown.credit, 0);
  assert.deepEqual(vKnown.episodes, { season: 1, watched: 0, started: 0, library: 10, required: 5 });
  const vUnknown = out.verdicts.find((v) => v.requestId === unknown.id)!;
  assert.deepEqual(vUnknown.episodes, { season: null, watched: 0, started: 0, library: 0, required: 1 });
});

test("TV: specials and plays with no episode identity don't count toward any season", () => {
  const r = show(40);
  const out = grade({
    requests: [r],
    libraryEpisodes: lib([r.tmdbId, { 1: 2 }]),
    units: [episode(r.id, 0, 1), episode(r.id, 0, 2), episode(r.id, 1, 1, { episodeNumber: null }), watchedUnit(r.id)],
  });
  assert.equal(out.verdicts[0].credit, 0);
  assert.deepEqual(out.verdicts[0].episodes, { season: 1, watched: 0, started: 0, library: 2, required: 1 });
});

test("TV: a season the library doesn't know needs one watched episode; a larger share is honoured", () => {
  const unknownSeason = show(40);
  const strict = show(41);
  const out = grade({
    requests: [unknownSeason, strict],
    libraryEpisodes: lib([unknownSeason.tmdbId, { 1: 10 }], [strict.tmdbId, { 1: 8 }]),
    settings: { ...WATCH_GRADE_DEFAULTS, tvEpisodePercent: 100 },
    units: [episode(unknownSeason.id, 3, 1), ...[1, 2, 3, 4, 5, 6].map((e) => episode(strict.id, 1, e))],
  });
  const vUnknown = out.verdicts.find((v) => v.requestId === unknownSeason.id)!;
  assert.equal(vUnknown.credit, 1);
  assert.deepEqual(vUnknown.episodes, { season: 3, watched: 1, started: 0, library: 0, required: 1 });
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

// ── one title, one unit ─────────────────────────────────────────────────────

test("duplicates: the same title on two instances is one unit — the earliest request, the first fulfilment", () => {
  const hd = movie(60, { createdAt: daysAgo(100) });
  const fourK = movie(20, { tmdbId: hd.tmdbId, createdAt: daysAgo(50) }); // still inside grace on its own
  const out = grade({ requests: [fourK, hd], units: [watchedUnit(hd.id)] });
  assert.equal(out.verdicts.length, 1);
  const v = out.verdicts[0];
  assert.equal(v.requestId, hd.id, "the earliest request is the unit");
  assert.equal(v.duplicates, 1);
  assert.equal(v.requestedAt, hd.createdAt.toISOString());
  assert.equal(v.fulfilledAt, hd.fulfilledAt.toISOString(), "fulfilled when it FIRST became available");
  assert.equal(v.scoring, "scored");
  assert.equal(v.watch, "watched");
  assert.equal(out.summary.graded, 1);

  // Fulfilment is the earliest across the group even when the LATER request got it first.
  const late = movie(80, { createdAt: daysAgo(30) });
  const early = movie(10, { tmdbId: late.tmdbId, createdAt: daysAgo(90) });
  const v2 = grade({ requests: [early, late] }).verdicts[0];
  assert.equal(v2.requestId, early.id);
  assert.equal(v2.fulfilledAt, late.fulfilledAt.toISOString());

  // Units are read by the unit's own id — the data layer reads the earliest
  // request's plays, which are the superset. Plays keyed to the duplicate are ignored.
  const onlyOnDuplicate = grade({ requests: [fourK, hd], units: [watchedUnit(fourK.id)] }).verdicts[0];
  assert.equal(onlyOnDuplicate.watch, "unwatched");

  // A movie and a show sharing a TMDB id are different titles.
  const film = movie(40);
  const series = show(41, { tmdbId: film.tmdbId });
  assert.equal(grade({ requests: [film, series] }).verdicts.length, 2);
});

// ── other viewers ───────────────────────────────────────────────────────────

test("others: a request the requester skipped counts as watched once 2 other people watched it; 1 is not enough", () => {
  const two = movie(40);
  const one = movie(41);
  const out = grade({
    requests: [two, one],
    otherWatches: [
      by("user:a", two.id),
      by("user:b", two.id),
      // Two rows from ONE person (their Plex and their Jellyfin login): one viewer.
      by("user:a", one.id),
      by("user:a", one.id),
    ],
  });
  const vTwo = out.verdicts.find((v) => v.requestId === two.id)!;
  assert.deepEqual(
    { watch: vTwo.watch, otherViewers: vTwo.otherViewers, watchedByOthers: vTwo.watchedByOthers, credit: vTwo.credit },
    { watch: "unwatched", otherViewers: 2, watchedByOthers: true, credit: 1 },
  );
  const vOne = out.verdicts.find((v) => v.requestId === one.id)!;
  assert.deepEqual(
    { otherViewers: vOne.otherViewers, watchedByOthers: vOne.watchedByOthers, credit: vOne.credit },
    { otherViewers: 1, watchedByOthers: false, credit: 0 },
  );
  assert.equal(out.summary.score, 50);
  assert.deepEqual(
    { byOthers: out.summary.byOthers, unwatched: out.summary.unwatched, watched: out.summary.watched },
    { byOthers: 1, unwatched: 1, watched: 0 },
  );
});

test("others: a show needs a season to the same share; a person's rows merge by max, never by sum", () => {
  const r = show(40);
  const library = lib([r.tmdbId, { 1: 10, 2: 6 }]); // 5 and 3 needed
  const verdict = (otherWatches: OtherViewerWatch[]) =>
    grade({ requests: [r], libraryEpisodes: library, otherWatches, settings: { ...WATCH_GRADE_DEFAULTS, otherViewers: 1 } }).verdicts[0];

  assert.equal(verdict([by("user:a", r.id, 4, 1)]).otherViewers, 0, "4 of 10 is short of the share");
  assert.equal(verdict([by("user:a", r.id, 5, 1)]).otherViewers, 1);
  // Two rows for one season from one person: the larger count stands, they are not added.
  assert.equal(verdict([by("user:a", r.id, 3, 1), by("user:a", r.id, 4, 1)]).otherViewers, 0);
  // Any one season reaching its share is enough.
  assert.equal(verdict([by("user:a", r.id, 2, 1), by("user:a", r.id, 3, 2)]).otherViewers, 1);
  // A movie row with nothing watched is not a viewer; specials never count.
  assert.equal(verdict([by("user:a", r.id, 0, 1), by("user:b", r.id, 9, 0)]).otherViewers, 0);
  const film = movie(41);
  assert.equal(grade({ requests: [film], otherWatches: [by("user:a", film.id, 0)] }).verdicts[0].otherViewers, 0);
});

test("others: partial credit rises to full; an own full watch stays 'watched' with the count left unread (null)", () => {
  const partlyWatched = show(40);
  const watched = movie(41);
  const out = grade({
    requests: [partlyWatched, watched],
    libraryEpisodes: lib([partlyWatched.tmdbId, { 1: 4 }]),
    units: [episode(partlyWatched.id, 1, 1), watchedUnit(watched.id)],
    otherWatches: [
      by("identity:plex:p-1", partlyWatched.id, 4, 1),
      by("user:z", partlyWatched.id, 2, 1),
      by("user:a", watched.id),
      by("user:b", watched.id),
      by("user:c", watched.id),
    ],
  });
  const vPartly = out.verdicts.find((v) => v.requestId === partlyWatched.id)!;
  assert.equal(vPartly.watch, "partial");
  assert.equal(vPartly.otherViewers, 2);
  assert.equal(vPartly.watchedByOthers, true);
  assert.equal(vPartly.credit, 1);
  assert.deepEqual(vPartly.episodes, { season: 1, watched: 1, started: 0, library: 4, required: 2 }, "episodes stay the requester's own");
  const vWatched = out.verdicts.find((v) => v.requestId === watched.id)!;
  assert.equal(vWatched.watch, "watched");
  assert.equal(vWatched.otherViewers, null, "not counted — it could change nothing, and the data layer never reads it");
  assert.equal(vWatched.watchedByOthers, false, "the requester watched it themselves");
  assert.deepEqual({ watched: out.summary.watched, byOthers: out.summary.byOthers, partial: out.summary.partial }, { watched: 1, byOthers: 1, partial: 0 });
});

test("others: 0 turns the rule off; the threshold is configurable; grace and unobservable requesters are untouched", () => {
  const r = movie(40);
  const watches = [by("user:a", r.id), by("user:b", r.id), by("user:c", r.id)];

  const off = grade({ requests: [r], otherWatches: watches, settings: { ...WATCH_GRADE_DEFAULTS, otherViewers: 0 } }).verdicts[0];
  assert.deepEqual({ otherViewers: off.otherViewers, watchedByOthers: off.watchedByOthers, credit: off.credit }, { otherViewers: null, watchedByOthers: false, credit: 0 });

  const needFour = grade({ requests: [r], otherWatches: watches, settings: { ...WATCH_GRADE_DEFAULTS, otherViewers: 4 } }).verdicts[0];
  assert.equal(needFour.watchedByOthers, false);
  const needThree = grade({ requests: [r], otherWatches: watches, settings: { ...WATCH_GRADE_DEFAULTS, otherViewers: 3 } }).verdicts[0];
  assert.equal(needThree.watchedByOthers, true);

  const fresh = movie(5); // inside grace
  const graceOut = grade({ requests: [fresh], otherWatches: watches.map((w) => ({ ...w, requestId: fresh.id })) });
  assert.equal(graceOut.verdicts[0].scoring, "grace");
  assert.equal(graceOut.verdicts[0].otherViewers, null);
  assert.equal(graceOut.verdicts[0].credit, 0, "others don't credit a request early");
  assert.equal(graceOut.summary.graded, 0, "others don't score a request early");

  const unlinked = grade({ requests: [r], otherWatches: watches, identity: { kind: "unlinked" } });
  assert.deepEqual({ otherViewers: unlinked.verdicts[0].otherViewers, credit: unlinked.verdicts[0].credit }, { otherViewers: null, credit: 0 });
  assert.equal(unlinked.summary.letter, null);
});

test("others: summary buckets still add up to the scored count", () => {
  const reqs = [movie(40), movie(41), movie(42), movie(43)];
  const out = grade({
    requests: reqs,
    units: [watchedUnit(reqs[0].id), watchedUnit(reqs[1].id, { anyWatched: false, playSeconds: 1800, durationSeconds: 7200 })],
    otherWatches: [by("user:a", reqs[2].id), by("user:b", reqs[2].id)],
  });
  const s = out.summary;
  assert.deepEqual({ watched: s.watched, byOthers: s.byOthers, partial: s.partial, unwatched: s.unwatched }, { watched: 1, byOthers: 1, partial: 1, unwatched: 1 });
  assert.equal(s.watched + s.byOthers + s.partial + s.unwatched, s.graded);
  assert.equal(s.score, 63); // (1 + 1 + 0.5 + 0) / 4
});

// ── output shape ────────────────────────────────────────────────────────────

test("verdicts are newest fulfilment first, credit rounded to two decimals", () => {
  const a = movie(90);
  const b = movie(40);
  const c = show(60);
  const out = grade({
    requests: [a, b, c],
    libraryEpisodes: lib([c.tmdbId, { 1: 9 }]),
    units: [episode(c.id, 1, 1)],
  });
  assert.deepEqual(out.verdicts.map((v) => v.requestId), [b.id, c.id, a.id]);
  assert.equal(out.verdicts[1].credit, 0.2); // 1 of 5 required
});

test("score averages raw credits before rounding (no per-request rounding drift)", () => {
  // Two 16-episode seasons need 8 each: 1 watched = 0.125, 3 watched = 0.375. The raw
  // mean is exactly 25%. Averaging the DISPLAYED credits (0.13 + 0.38) would read 26%.
  const reqs = [show(40), show(41)];
  const library = lib(...reqs.map((r): [number, Record<number, number>] => [r.tmdbId, { 1: 16 }]));
  const units = [episode(reqs[0].id, 1, 1), episode(reqs[1].id, 1, 1), episode(reqs[1].id, 1, 2), episode(reqs[1].id, 1, 3)];
  const out = grade({ requests: reqs, libraryEpisodes: library, units });
  assert.deepEqual(out.verdicts.map((v) => v.credit).sort(), [0.13, 0.38]);
  assert.equal(out.summary.score, 25);
});

// ── settings ────────────────────────────────────────────────────────────────

test("parseWatchGradeSettings: defaults for missing/garbage/out-of-range rows; windowDays and otherViewers accept 0", () => {
  assert.deepEqual(parseWatchGradeSettings({}), WATCH_GRADE_DEFAULTS);
  assert.deepEqual(
    parseWatchGradeSettings({
      [WATCH_GRADE_SETTING_KEYS.graceDays]: "abc",
      [WATCH_GRADE_SETTING_KEYS.windowDays]: "29",
      [WATCH_GRADE_SETTING_KEYS.tvEpisodePercent]: "101",
      [WATCH_GRADE_SETTING_KEYS.otherViewers]: "101",
      [WATCH_GRADE_SETTING_KEYS.bandA]: "0",
      [WATCH_GRADE_SETTING_KEYS.minGradedRequests]: "0",
    }),
    WATCH_GRADE_DEFAULTS,
  );
  assert.deepEqual(
    parseWatchGradeSettings({
      [WATCH_GRADE_SETTING_KEYS.graceDays]: "14",
      [WATCH_GRADE_SETTING_KEYS.windowDays]: "0",
      [WATCH_GRADE_SETTING_KEYS.tvEpisodePercent]: "100",
      [WATCH_GRADE_SETTING_KEYS.otherViewers]: "0",
      [WATCH_GRADE_SETTING_KEYS.bandA]: "90",
      [WATCH_GRADE_SETTING_KEYS.bandB]: "75",
      [WATCH_GRADE_SETTING_KEYS.bandC]: "50",
      [WATCH_GRADE_SETTING_KEYS.bandD]: "25",
      [WATCH_GRADE_SETTING_KEYS.minGradedRequests]: "5",
    }),
    { graceDays: 14, windowDays: 0, tvEpisodePercent: 100, otherViewers: 0, bandA: 90, bandB: 75, bandC: 50, bandD: 25, minGradedRequests: 5 },
  );
  // Grace 0 would score every request the moment it lands — rejected.
  assert.equal(parseWatchGradeSettings({ [WATCH_GRADE_SETTING_KEYS.graceDays]: "0" }).graceDays, 30);
  // Non-integers never partially parse ("7.5" is not 7).
  assert.equal(parseWatchGradeSettings({ [WATCH_GRADE_SETTING_KEYS.graceDays]: "7.5" }).graceDays, 30);
});

test("out-of-order cutoffs: the read side falls back to ALL FOUR defaults; the field parse the write path uses does not", () => {
  const raw = {
    [WATCH_GRADE_SETTING_KEYS.bandA]: "90",
    [WATCH_GRADE_SETTING_KEYS.bandB]: "95", // above A
    [WATCH_GRADE_SETTING_KEYS.bandC]: "50",
    [WATCH_GRADE_SETTING_KEYS.bandD]: "25",
  };
  const read = parseWatchGradeSettings(raw);
  assert.deepEqual(
    [read.bandA, read.bandB, read.bandC, read.bandD],
    [WATCH_GRADE_DEFAULTS.bandA, WATCH_GRADE_DEFAULTS.bandB, WATCH_GRADE_DEFAULTS.bandC, WATCH_GRADE_DEFAULTS.bandD],
    "restoring only B (to 60) would leave 90/60/50/25 — fine here, but not in general; all four go back together",
  );
  const fields = parseWatchGradeFields(raw);
  assert.deepEqual([fields.bandA, fields.bandB, fields.bandC, fields.bandD], [90, 95, 50, 25], "the write path must see the raw values");
  // Equal cutoffs are out of order too — a tie would make one letter unreachable.
  const tie = parseWatchGradeSettings({ ...raw, [WATCH_GRADE_SETTING_KEYS.bandB]: "50" });
  assert.equal(tie.bandB, WATCH_GRADE_DEFAULTS.bandB);
  // A descending set is kept as is, and other fields are untouched by the repair.
  const kept = parseWatchGradeSettings({ ...raw, [WATCH_GRADE_SETTING_KEYS.bandB]: "70", [WATCH_GRADE_SETTING_KEYS.graceDays]: "10" });
  assert.deepEqual([kept.bandA, kept.bandB, kept.bandC, kept.bandD, kept.graceDays], [90, 70, 50, 25, 10]);
  const repaired = parseWatchGradeSettings({ ...raw, [WATCH_GRADE_SETTING_KEYS.graceDays]: "10" });
  assert.equal(repaired.graceDays, 10);
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
    ["watchGradeOtherViewers", "0", true],
    ["watchGradeOtherViewers", "1", true],
    ["watchGradeOtherViewers", "100", true],
    ["watchGradeOtherViewers", "101", false],
    ["watchGradeOtherViewers", "two", false],
    ["watchGradeBandA", "100", true],
    ["watchGradeBandA", "101", false],
    ["watchGradeBandB", "1", true],
    ["watchGradeBandC", "0", false],
    ["watchGradeBandD", "0", false],
    ["watchGradeBandD", "1", true],
    ["watchGradeMinRequests", "1", true],
    ["watchGradeMinRequests", "100", true],
    ["watchGradeMinRequests", "0", false],
    ["watchGradeMinRequests", "101", false],
  ];
  for (const [key, value, ok] of cases) {
    assert.equal(watchGradeSettingError(key, value) === null, ok, `${key}=${value}`);
    const field = (Object.keys(WATCH_GRADE_SETTING_KEYS) as (keyof typeof WATCH_GRADE_SETTING_KEYS)[]).find(
      (f) => WATCH_GRADE_SETTING_KEYS[f] === key,
    )!;
    const parsed = parseWatchGradeFields({ [key]: value })[field];
    assert.equal(ok ? parsed === Number(value) : parsed === WATCH_GRADE_DEFAULTS[field], true, `parse ${key}=${value}`);
  }
  // What 0 means is spelled out per field.
  assert.match(watchGradeSettingError("watchGradeWindowDays", "1")!, /between 30 and 3650, or 0 for no limit$/);
  assert.match(watchGradeSettingError("watchGradeOtherViewers", "101")!, /between 1 and 100, or 0 to turn it off$/);
  assert.match(watchGradeSettingError("watchGradeGraceDays", "0")!, /between 1 and 365$/);
  // Any other key is not this validator's business.
  assert.equal(watchGradeSettingError("quotaLimit", "not a number"), null);
});

test("watchGradeCrossFieldError: a window no longer than the grace period is refused; 0 (no limit) never is", () => {
  const at = (over: Partial<typeof WATCH_GRADE_DEFAULTS>) => watchGradeCrossFieldError({ ...WATCH_GRADE_DEFAULTS, ...over });
  assert.match(at({ graceDays: 30, windowDays: 30 })!, /must be longer than the grace period/);
  assert.match(at({ graceDays: 365, windowDays: 90 })!, /\(90 days\) must be longer than the grace period \(365 days\)/);
  assert.equal(at({ graceDays: 30, windowDays: 31 }), null);
  assert.equal(at({ graceDays: 365, windowDays: 0 }), null);
  assert.equal(watchGradeCrossFieldError(WATCH_GRADE_DEFAULTS), null);
});

test("watchGradeCrossFieldError: cutoffs must be strictly descending, and the message names the pair", () => {
  const at = (over: Partial<typeof WATCH_GRADE_DEFAULTS>) => watchGradeCrossFieldError({ ...WATCH_GRADE_DEFAULTS, ...over });
  assert.equal(at({ bandA: 99, bandB: 98, bandC: 97, bandD: 96 }), null);
  assert.equal(at({ bandA: 4, bandB: 3, bandC: 2, bandD: 1 }), null);
  assert.match(at({ bandA: 60, bandB: 60 })!, /^The A cutoff \(60%\) must be higher than the B cutoff \(60%\)$/);
  assert.match(at({ bandB: 30 })!, /^The B cutoff \(30%\) must be higher than the C cutoff \(40%\)$/);
  assert.match(at({ bandD: 45 })!, /^The C cutoff \(40%\) must be higher than the D cutoff \(45%\)$/);
});

// ── display helpers ─────────────────────────────────────────────────────────

test("hasWatchGradeSignal: nothing to show for null or an all-zero summary", () => {
  assert.equal(hasWatchGradeSignal(null), false);
  assert.equal(hasWatchGradeSignal(emptyWatchGradeSummary()), false);
  assert.equal(hasWatchGradeSignal({ ...emptyWatchGradeSummary("unlinked"), untracked: 1 }), true);
  assert.equal(hasWatchGradeSignal({ ...emptyWatchGradeSummary(), inGrace: 2 }), true);
});

test("watchGradeSpread: users per letter, the not-yet-graded counted apart, empty summaries ignored", () => {
  const graded = (letter: "A" | "B" | "C" | "D" | "F") => ({ ...emptyWatchGradeSummary("graded"), letter, graded: 3 });
  const spread = watchGradeSpread([
    graded("A"), graded("A"), graded("C"), graded("F"),
    { ...emptyWatchGradeSummary(), graded: 2 }, // not enough for a letter
    { ...emptyWatchGradeSummary("unlinked"), untracked: 1 },
    emptyWatchGradeSummary(), // nothing fulfilled — no chip, not counted
  ]);
  assert.deepEqual(spread, { A: 2, B: 0, C: 1, D: 0, F: 1, notGraded: 2 });
});

test("watchGradeVolume: full-credit requests over scored ones — own watches plus those others watched", () => {
  assert.equal(watchGradeVolume({ ...emptyWatchGradeSummary(), graded: 60, watched: 17, byOthers: 3, partial: 5, unwatched: 35 }), "20/60");
  assert.equal(watchGradeVolume(emptyWatchGradeSummary()), "0/0");
});

test("describeWatchGrade: every status explains itself", () => {
  const reqs = [movie(40), movie(50), movie(60)];
  const graded = grade({ requests: reqs, units: [watchedUnit(reqs[0].id)] }).summary;
  assert.match(describeWatchGrade(graded), /^Watch grade D — 33% across 3 fulfilled requests \(1 watched, 0 partly, 2 not watched\)$/);
  const withOthers = grade({
    requests: reqs,
    units: [watchedUnit(reqs[0].id)],
    otherWatches: [by("user:a", reqs[1].id), by("user:b", reqs[1].id)],
  }).summary;
  assert.match(describeWatchGrade(withOthers), /\(1 watched, 1 watched by others, 0 partly, 1 not watched\)$/);
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
