// Unit tests for src/lib/arr-missing.ts — the pure rules behind Admin → Missing.
//
// What is pinned, each in both directions:
//   - A MOVIE is listed only with no file AND a physical or digital release date
//     at or before now. Cinema-only, undated and future-dated movies are never
//     listed — they are expected to be missing.
//   - A SERIES is listed only when an AIRED, MONITORED, REGULAR-SEASON episode
//     has no file, read from Sonarr's per-season statistics through the shared
//     completion rule (guardrail 14a): specials never count, a show with nothing
//     aired yet is not missing, unaired episodes of a continuing show are not.
//   - Episode detail applies the same set to /api/v3/episode rows.
//   - `monitored` is reported, never filtered on.
//   - The Search plan asks for exactly the missing episodes: a season search
//     only where the season has no file at all (season packs, nothing to
//     upgrade), episode searches everywhere else — never a whole-series search.
//
// No DB, no network.
import { test } from "node:test";
import assert from "node:assert/strict";

const { missingMovie, missingSeries, missingEpisodes, planSeriesSearch, tmdbPosterPathFromImages, arrDateMs } = await import("../src/lib/arr-missing.ts");

const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
const ahead = (days: number) => new Date(NOW + days * DAY).toISOString();

const movie = (over: Record<string, unknown> = {}) => ({ id: 7, tmdbId: 700, title: "Seven", year: 2026, monitored: true, hasFile: false, ...over });

// ── movies ───────────────────────────────────────────────────────────────────

test("a movie with no file whose physical release has passed is missing, dated from that release", () => {
  const m = missingMovie(movie({ physicalRelease: ago(10), inCinemas: ago(90) }), "", NOW);
  assert.ok(m);
  assert.equal(m.releasedAt, ago(10));
  assert.equal(m.daysMissing, 10);
  assert.equal(m.physicalRelease, ago(10));
  assert.equal(m.digitalRelease, null);
  assert.equal(m.inCinemas, ago(90));
  assert.equal(m.instance, "");
  assert.equal(m.arrId, 7);
  assert.equal(m.tmdbId, 700);
});

test("a digital release alone is enough", () => {
  const m = missingMovie(movie({ digitalRelease: ago(3), physicalRelease: ahead(30) }), "4k", NOW);
  assert.ok(m);
  assert.equal(m.releasedAt, ago(3), "the future physical date plays no part");
  assert.equal(m.instance, "4k");
});

test("with both home releases past, the EARLIER one dates it", () => {
  const m = missingMovie(movie({ digitalRelease: ago(40), physicalRelease: ago(12) }), "", NOW);
  assert.equal(m?.releasedAt, ago(40));
  assert.equal(m?.daysMissing, 40);
});

test("a release dated exactly now counts as past", () => {
  assert.ok(missingMovie(movie({ digitalRelease: new Date(NOW).toISOString() }), "", NOW));
  assert.equal(missingMovie(movie({ digitalRelease: new Date(NOW + 1).toISOString() }), "", NOW), null);
});

test("a movie only in cinemas, or with every home release in the future, is NOT missing", () => {
  assert.equal(missingMovie(movie({ inCinemas: ago(20) }), "", NOW), null);
  assert.equal(missingMovie(movie({ inCinemas: ago(20), physicalRelease: ahead(5), digitalRelease: ahead(1) }), "", NOW), null);
});

test("a movie with no dates at all, or unparseable ones, is NOT missing", () => {
  assert.equal(missingMovie(movie(), "", NOW), null);
  assert.equal(missingMovie(movie({ physicalRelease: "soon", digitalRelease: "" }), "", NOW), null);
});

test("a movie WITH a file is never missing, however old its release", () => {
  assert.equal(missingMovie(movie({ hasFile: true, physicalRelease: ago(400) }), "", NOW), null);
});

test("an unmonitored movie is reported, flagged — never dropped", () => {
  const m = missingMovie(movie({ monitored: false, digitalRelease: ago(1) }), "", NOW);
  assert.equal(m?.monitored, false);
});

test("a row without a usable Radarr id is skipped; a missing tmdbId is reported as null", () => {
  assert.equal(missingMovie(movie({ id: 0, digitalRelease: ago(1) }), "", NOW), null);
  assert.equal(missingMovie(movie({ tmdbId: undefined, digitalRelease: ago(1) }), "", NOW)?.tmdbId, null);
});

test("the poster path is taken only from a TMDB poster URL — the only image host the CSP allows", () => {
  assert.equal(
    tmdbPosterPathFromImages([
      { coverType: "fanart", remoteUrl: "https://image.tmdb.org/t/p/original/fan.jpg" },
      { coverType: "poster", remoteUrl: "https://image.tmdb.org/t/p/original/abc123.jpg" },
    ]),
    "/abc123.jpg",
  );
  assert.equal(tmdbPosterPathFromImages([{ coverType: "poster", remoteUrl: "https://artworks.thetvdb.com/banners/p.jpg" }]), null);
  assert.equal(tmdbPosterPathFromImages([{ coverType: "poster", remoteUrl: "https://image.tmdb.org.evil.example/t/p/original/a.jpg" }]), null);
  assert.equal(tmdbPosterPathFromImages(null), null);
});

test("arrDateMs: ISO strings parse, anything else is null", () => {
  assert.equal(arrDateMs("2026-01-01T00:00:00Z"), Date.parse("2026-01-01T00:00:00Z"));
  for (const v of [null, undefined, "", "not a date", 12345]) assert.equal(arrDateMs(v), null);
});

// ── series ───────────────────────────────────────────────────────────────────

const season = (seasonNumber: number, episodeCount: number, episodeFileCount: number, previousAiring?: string) => ({
  seasonNumber,
  monitored: true,
  statistics: { episodeCount, episodeFileCount, totalEpisodeCount: episodeCount + 4, ...(previousAiring ? { previousAiring } : {}) },
});
const show = (seasons: unknown[], over: Record<string, unknown> = {}) => ({
  id: 31, tmdbId: 300, tvdbId: 3000, title: "Show", year: 2024, status: "continuing", monitored: true,
  previousAiring: ago(2), seasons, ...over,
});

test("a series with aired, monitored episodes missing in a regular season is missing, with a per-season breakdown", () => {
  const s = missingSeries(show([season(1, 10, 10), season(2, 8, 5, ago(2)), season(3, 2, 0, ago(9))]), "");
  assert.ok(s);
  assert.equal(s.missing, 5);
  assert.equal(s.aired, 20);
  assert.deepEqual(s.seasons, [
    { seasonNumber: 2, missing: 3, aired: 8, lastAired: ago(2) },
    { seasonNumber: 3, missing: 2, aired: 2, lastAired: ago(9) },
  ]);
  assert.equal(s.lastAired, ago(2));
  assert.equal(s.status, "continuing");
  assert.equal(s.tvdbId, 3000);
});

test("a COMPLETE series is not missing, even with unaired episodes still to come", () => {
  // episodeCount counts only aired (or file-bearing) episodes, so the four
  // unaired ones in totalEpisodeCount must not register.
  assert.equal(missingSeries(show([season(1, 10, 10), season(2, 3, 3)]), ""), null);
});

test("a series with nothing aired yet is not missing", () => {
  assert.equal(missingSeries(show([season(1, 0, 0)], { status: "upcoming", previousAiring: undefined }), ""), null);
});

test("specials never count: a missing special alone does not list a series, nor add to its count", () => {
  assert.equal(missingSeries(show([season(0, 5, 0), season(1, 10, 10)]), ""), null);
  const s = missingSeries(show([season(0, 5, 0), season(1, 10, 9)]), "");
  assert.equal(s?.missing, 1);
  assert.deepEqual(s?.seasons.map((x) => x.seasonNumber), [1]);
});

test("without per-season statistics the series-level block is used, and no season breakdown is invented", () => {
  const s = missingSeries({ id: 9, title: "Old", statistics: { episodeCount: 12, episodeFileCount: 4 }, seasons: [{ seasonNumber: 1 }] }, "");
  assert.equal(s?.missing, 8);
  assert.deepEqual(s?.seasons, []);
});

test("an unmonitored series is reported, flagged — never dropped", () => {
  assert.equal(missingSeries(show([season(1, 4, 1)], { monitored: false }), "")?.monitored, false);
});

test("lastAired falls back to lastAired when previousAiring is absent", () => {
  assert.equal(missingSeries(show([season(1, 4, 1)], { previousAiring: undefined, lastAired: ago(30) }), "")?.lastAired, ago(30));
});

// ── episodes ─────────────────────────────────────────────────────────────────

const ep = (over: Record<string, unknown>) => ({ seasonNumber: 1, episodeNumber: 1, title: "E", airDateUtc: ago(5), monitored: true, hasFile: false, ...over });

test("missing episodes: aired, monitored, regular season, no file — sorted by season then episode", () => {
  const out = missingEpisodes([
    ep({ seasonNumber: 2, episodeNumber: 1, title: "B" }),
    ep({ seasonNumber: 1, episodeNumber: 3, title: "A3" }),
    ep({ seasonNumber: 1, episodeNumber: 2, hasFile: true }),
    ep({ seasonNumber: 1, episodeNumber: 4, monitored: false }),
    ep({ seasonNumber: 1, episodeNumber: 5, airDateUtc: ahead(1) }),
    ep({ seasonNumber: 1, episodeNumber: 6, airDateUtc: undefined }),
    ep({ seasonNumber: 0, episodeNumber: 1, title: "Special" }),
  ], NOW);
  assert.deepEqual(out.map((e) => `${e.seasonNumber}x${e.episodeNumber}`), ["1x3", "2x1"]);
  assert.equal(out[0].title, "A3");
  assert.equal(out[0].airDateUtc, ago(5));
});

// ── search plan ──────────────────────────────────────────────────────────────

test("search plan: a season with no file at all is searched whole; a season with files gets its missing episodes one by one", () => {
  const plan = planSeriesSearch([
    // Season 1: has files, two missing → episodes, never a season search (it would hunt upgrades).
    ep({ id: 101, seasonNumber: 1, episodeNumber: 1, hasFile: true }),
    ep({ id: 102, seasonNumber: 1, episodeNumber: 2 }),
    ep({ id: 103, seasonNumber: 1, episodeNumber: 3 }),
    // Season 3: nothing on disk, three missing → one season search.
    ep({ id: 301, seasonNumber: 3, episodeNumber: 1 }),
    ep({ id: 302, seasonNumber: 3, episodeNumber: 2 }),
    ep({ id: 303, seasonNumber: 3, episodeNumber: 3 }),
    // Season 2: nothing on disk but only one missing → an episode search.
    ep({ id: 201, seasonNumber: 2, episodeNumber: 1 }),
  ], NOW);
  assert.deepEqual(plan, { seasons: [3], episodeIds: [102, 103, 201] });
});

test("search plan: only missing episodes are ever named — specials, unmonitored, unaired and file-bearing ones are left alone", () => {
  const plan = planSeriesSearch([
    ep({ id: 1, seasonNumber: 0, episodeNumber: 1 }),
    ep({ id: 2, seasonNumber: 1, episodeNumber: 1, monitored: false }),
    ep({ id: 3, seasonNumber: 1, episodeNumber: 2, airDateUtc: ahead(2) }),
    ep({ id: 4, seasonNumber: 1, episodeNumber: 3, hasFile: true }),
    ep({ id: 5, seasonNumber: 1, episodeNumber: 4 }),
  ], NOW);
  assert.deepEqual(plan, { seasons: [], episodeIds: [5] });
});

test("search plan: a season whose only file is on an unaired or unmonitored episode still counts as having a file", () => {
  // Any file in the season means a season search could chase an upgrade.
  const plan = planSeriesSearch([
    ep({ id: 1, seasonNumber: 2, episodeNumber: 1 }),
    ep({ id: 2, seasonNumber: 2, episodeNumber: 2 }),
    ep({ id: 3, seasonNumber: 2, episodeNumber: 3, monitored: false, hasFile: true }),
  ], NOW);
  assert.deepEqual(plan, { seasons: [], episodeIds: [1, 2] });
});

test("search plan: nothing missing (or rows without a usable id) plans nothing", () => {
  assert.deepEqual(planSeriesSearch([], NOW), { seasons: [], episodeIds: [] });
  assert.deepEqual(planSeriesSearch([ep({ id: 0 }), ep({ id: "7" })], NOW), { seasons: [], episodeIds: [] });
});
