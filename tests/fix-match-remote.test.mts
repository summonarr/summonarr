// The pure rules behind a fix-match remap (fix-match-plex.ts, fix-match-jellyfin.ts,
// fix-match-apply.ts, fix-match-run.ts, fix-match-conflicts.ts): how upstream
// answers are read (malformed ones never throw), how an unconfirmed Jellyfin
// apply is diagnosed, which plays a remap re-attributes, which failures the
// admin is told about, and which jobs may not run side by side. The route-level
// behaviour is pinned in tests/fix-match-routes.test.mts.
process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.TRUST_PROXY = "true";
(globalThis as unknown as { prisma: unknown }).prisma = {};

import { test } from "node:test";
import assert from "node:assert/strict";

const {
  asPlexSearchResult, candidateCarriesTarget, cachedPlexTarget, classifyPlexCopy, firstPlexMetadata, judgePlexConfirmation, PlexUnmatchedError,
} = await import("../src/lib/fix-match-plex.ts");
const {
  confirmAttemptsFor, fallbackSearchTerm, needsLibraryProbe, owningLibrary, parseVirtualFolders, providerTmdbId, unconfirmedDiagnosis,
} = await import("../src/lib/fix-match-jellyfin.ts");
const { FixMatchDiagnosticError } = await import("../src/lib/fix-match-remote.ts");
const { playReattributionWhere } = await import("../src/lib/fix-match-apply.ts");
const { clientFailure } = await import("../src/lib/fix-match-run.ts");
const { fixMatchScopesOverlap } = await import("../src/lib/fix-match-conflicts.ts");
const { translatorFor } = await import("../src/lib/i18n/server-locale.ts");

const en = translatorFor("en");
const es = translatorFor("es");

// ── Jellyfin: the confirmation fallback's search term ────────────────────────

test("the fallback searches a SERIES by its own folder and a MOVIE by the file's parent folder", () => {
  // A Series item's Path is the series folder: its parent is the library root.
  assert.equal(fallbackSearchTerm("/media/shows/Long Show (2019)", "TV"), "Long Show");
  assert.equal(fallbackSearchTerm("/media/shows/Long Show/", "TV"), "Long Show", "a trailing separator is not a segment");
  assert.equal(fallbackSearchTerm("D:\\TV\\ONE PIECE (2023)", "TV"), "ONE PIECE");
  assert.equal(fallbackSearchTerm("/m/Title (2000)/a.mkv", "MOVIE"), "Title");
  assert.equal(fallbackSearchTerm("C:\\Movies\\Heat (1995)\\heat.mkv", "MOVIE"), "Heat");
  assert.equal(fallbackSearchTerm("a.mkv", "MOVIE"), "", "no folder: the search runs without a term");
});

test("the confirmation window: 10 minutes as a job, 24 polls for a series or a timed-out apply, else 4", () => {
  assert.equal(confirmAttemptsFor(true, false, "MOVIE"), 120);
  assert.equal(confirmAttemptsFor(false, false, "TV"), 24);
  assert.equal(confirmAttemptsFor(false, true, "MOVIE"), 24);
  assert.equal(confirmAttemptsFor(false, false, "MOVIE"), 4);
});

test("providerTmdbId reads either casing and only a string", () => {
  assert.equal(providerTmdbId({ ProviderIds: { Tmdb: "12" } }), "12");
  assert.equal(providerTmdbId({ ProviderIds: { tmdb: "12" } }), "12");
  assert.equal(providerTmdbId({ ProviderIds: { Tmdb: 12 } }), null);
  assert.equal(providerTmdbId({ ProviderIds: "Tmdb=12" }), null);
  assert.equal(providerTmdbId(null), null);
});

// ── Jellyfin: diagnosing an apply the window never confirmed ─────────────────

const observed = (over: Partial<Parameters<typeof unconfirmedDiagnosis>[0]> = {}) => ({
  previousTmdbId: 111, correctTmdbId: 222, lastSeenTmdbId: null, itemLocked: false, readFailures: 0, attempts: 4, ...over,
});

test("an unconfirmed apply is diagnosed from what Jellyfin reported, most specific first", () => {
  assert.deepEqual(unconfirmedDiagnosis(observed({ readFailures: 4 }), null), { key: "apiAdmin.fixMatch.jellyfinUnreadable", vars: { tmdbId: 222, attempts: 4 } });
  // A lock explains everything, even an item still on the old id.
  assert.deepEqual(unconfirmedDiagnosis(observed({ itemLocked: true, lastSeenTmdbId: "111" }), null), { key: "apiAdmin.fixMatch.jellyfinLocked", vars: { tmdbId: 222 } });
  assert.deepEqual(unconfirmedDiagnosis(observed({ lastSeenTmdbId: "111" }), null), { key: "apiAdmin.fixMatch.jellyfinStillPrevious", vars: { previousTmdbId: 111 } });
  assert.deepEqual(unconfirmedDiagnosis(observed({ lastSeenTmdbId: "999" }), null), { key: "apiAdmin.fixMatch.jellyfinNotConfirmed", vars: { tmdbId: 222 } });

  const movies = { name: "Movies", locations: ["/media/movies"], nfoReader: true, nfoSaver: false };
  assert.deepEqual(unconfirmedDiagnosis(observed({ lastSeenTmdbId: "111" }), movies),
    { key: "apiAdmin.fixMatch.jellyfinStillPreviousNfo", vars: { previousTmdbId: 111, library: "Movies" } });
  assert.equal(unconfirmedDiagnosis(observed({ lastSeenTmdbId: "111" }), { ...movies, nfoSaver: true }).key, "apiAdmin.fixMatch.jellyfinStillPreviousNfoSaver");
  assert.equal(unconfirmedDiagnosis(observed({ lastSeenTmdbId: "111" }), { ...movies, nfoReader: false }).key, "apiAdmin.fixMatch.jellyfinStillPrevious");
  // A library with no name can't be named: the generic hint, not `""`.
  assert.equal(unconfirmedDiagnosis(observed({ lastSeenTmdbId: "111" }), { ...movies, name: "  " }).key, "apiAdmin.fixMatch.jellyfinStillPrevious");
});

test("only the still-the-old-id case reads the library configuration", () => {
  assert.equal(needsLibraryProbe(observed({ lastSeenTmdbId: "111" })), true);
  assert.equal(needsLibraryProbe(observed({ lastSeenTmdbId: "111", itemLocked: true })), false);
  assert.equal(needsLibraryProbe(observed({ lastSeenTmdbId: "111", readFailures: 4 })), false);
  assert.equal(needsLibraryProbe(observed({ lastSeenTmdbId: "999" })), false);
});

test("a malformed VirtualFolders answer degrades instead of throwing, and the OWNING library is found", () => {
  assert.equal(parseVirtualFolders({ Items: [] }), null);
  const libs = parseVirtualFolders([
    null,
    { Name: "Shows", Locations: ["/media/shows"], LibraryOptions: { DisabledLocalMetadataReaders: ["Nfo"] } },
    { Name: "Movies", Locations: [42, "/media/movies/"], LibraryOptions: { MetadataSavers: ["Nfo", 7] } },
    { Name: 5, Locations: "nope", LibraryOptions: "nope" },
  ]);
  assert.ok(libs);
  assert.deepEqual(libs.map((l) => [l.name, l.locations, l.nfoReader, l.nfoSaver]), [
    ["Shows", ["/media/shows"], false, false],
    ["Movies", ["/media/movies/"], true, true],
    ["", [], true, false],
  ]);
  assert.equal(owningLibrary(libs, "/media/movies/Wrong (1999)/wrong.mkv")?.name, "Movies");
  assert.equal(owningLibrary(libs, "/media/moviesextra/x.mkv"), null, "a sibling folder with a shared prefix is not inside");
  assert.equal(owningLibrary(libs, null), null);
});

// ── Plex: reading /matches and /library/metadata answers ─────────────────────

test("a /matches result without a guid is no candidate; names, years and Guid lists are read defensively", () => {
  assert.equal(asPlexSearchResult({ name: "x" }), null);
  assert.equal(asPlexSearchResult({ guid: "" }), null);
  assert.equal(asPlexSearchResult("plex://movie/x"), null);
  assert.deepEqual(asPlexSearchResult({ guid: "plex://movie/x", name: 7, year: "2010", Guid: [{ id: "tmdb://5" }, { id: 9 }, null] }),
    { guid: "plex://movie/x", name: undefined, year: 2010, guidIds: ["tmdb://5"] });
  assert.equal(asPlexSearchResult({ guid: "plex://movie/x", year: "soon" })?.year, undefined);
});

test("a candidate names the target by its TMDB or IMDb id — never by a longer id sharing the prefix", () => {
  const c = (raw: Record<string, unknown>) => asPlexSearchResult({ guid: "plex://movie/x", ...raw })!;
  assert.equal(candidateCarriesTarget(c({ Guid: [{ id: "tmdb://222" }] }), 222, ""), true);
  assert.equal(candidateCarriesTarget(c({ Guid: [{ id: "imdb://tt01" }] }), 222, "tt01"), true);
  assert.equal(candidateCarriesTarget(c({ guid: "com.plexapp.agents.themoviedb://222?lang=en" }), 222, ""), true);
  assert.equal(candidateCarriesTarget(c({ guid: "com.plexapp.agents.themoviedb://2229?lang=en" }), 222, ""), false);
  assert.equal(candidateCarriesTarget(c({ guid: "com.plexapp.agents.imdb://tt012?lang=en" }), 222, "tt01"), false);
});

test("a confirmation read is judged confirmed, IMDb-confirmed, conflated or pending", () => {
  const item = (ids: string[], guid = "plex://movie/abc") => ({ guid, Guid: ids.map((id) => ({ id })) });
  assert.equal(judgePlexConfirmation(item(["tmdb://222"]), 222, "").verdict, "tmdb");
  assert.equal(judgePlexConfirmation(item([], "com.plexapp.agents.themoviedb://222?lang=en"), 222, "").verdict, "tmdb");
  assert.equal(judgePlexConfirmation(item(["imdb://tt9"]), 222, "tt9").verdict, "imdb");
  assert.equal(judgePlexConfirmation(item(["tmdb://555", "imdb://tt9"]), 222, "tt9").verdict, null, "another TMDB id beside the IMDb one is not a confirmation");
  assert.deepEqual(judgePlexConfirmation(item(["tmdb://555", "tmdb://222"]), 222, ""), { verdict: "conflated", plexTmdbId: "555", plexImdbId: undefined });
  assert.equal(judgePlexConfirmation(item(["tmdb://111"]), 222, "").verdict, null);
  assert.equal(judgePlexConfirmation(null, 222, "").verdict, null, "an unreadable item is pending, never a throw");
});

test("firstPlexMetadata and classifyPlexCopy tolerate a malformed answer", () => {
  assert.equal(firstPlexMetadata({ MediaContainer: { Metadata: "x" } }), null);
  assert.equal(firstPlexMetadata({ MediaContainer: "x" }), null);
  assert.deepEqual(firstPlexMetadata({ MediaContainer: { Metadata: [{ title: "T" }] } }), { title: "T" });
  assert.equal(classifyPlexCopy({ Guid: { id: "tmdb://111" } }, 111, 222), "other", "a Guid that is not a list names nothing");
  assert.equal(classifyPlexCopy({ Guid: [{ id: "tmdb://111" }] }, 111, 222), "old");
  assert.equal(classifyPlexCopy({ guid: "com.plexapp.agents.themoviedb://222?lang=en" }, 111, 222), "correct");
});

test("the cached TMDB title is read field by field: a malformed row is blank, an IMDb id must look like one", () => {
  assert.deepEqual(cachedPlexTarget("not json"), { title: "", year: "", imdbId: "" });
  assert.deepEqual(cachedPlexTarget(JSON.stringify([1])), { title: "", year: "", imdbId: "" });
  assert.deepEqual(cachedPlexTarget(JSON.stringify({ name: "Show", releaseYear: "2019-05-01", imdbId: "tt123" })), { title: "Show", year: "2019", imdbId: "tt123" });
  assert.deepEqual(cachedPlexTarget(JSON.stringify({ title: 7, releaseYear: 2019, imdbId: "123)|.*" })), { title: "", year: "", imdbId: "" });
});

// ── Which plays a title-mode remap re-attributes (TV) ────────────────────────

test("TV plays move by the row's key only when every copy left the old row; otherwise only the moved copies' shows", () => {
  assert.deepEqual(playReattributionWhere("plex", "", "TV", 111, ["1001"], true), { source: "plex", serverInstance: "", tmdbId: 111, mediaType: "TV" });
  assert.deepEqual(playReattributionWhere("plex", "", "TV", 111, ["1001"], false),
    { source: "plex", serverInstance: "", tmdbId: 111, mediaType: "TV", sourceShowId: { in: ["1001"] } });
  // A movie play's own key is the item's: always pinned to the moved ids.
  assert.deepEqual(playReattributionWhere("jellyfin", "x", "MOVIE", 111, ["a"], true),
    { source: "jellyfin", serverInstance: "x", tmdbId: 111, mediaType: "MOVIE", sourceItemId: { in: ["a"] } });
});

// ── What the admin is told about a failed run ────────────────────────────────

const input = { server: "jellyfin" as const, tmdbId: 111, mediaType: "MOVIE" as const, correctTmdbId: 222, serverInstance: "" };

test("a remote diagnosis reaches the caller translated; anything else stays generic", () => {
  const locked = new FixMatchDiagnosticError("apiAdmin.fixMatch.jellyfinLocked", { tmdbId: 222 }, "upstream detail");
  assert.match(locked.message, /locked in Jellyfin/, "the log line is the English text");
  assert.match(locked.message, /\(upstream detail\)$/, "plus the upstream detail, for the log only");
  const fresh = { remoteRemapped: false, plexKeysTouched: [] };
  const toEs = clientFailure(locked, input, fresh, es);
  assert.equal(toEs.status, 502);
  assert.equal(toEs.message, es("apiAdmin.fixMatch.jellyfinLocked", { tmdbId: 222 }));
  assert.notEqual(toEs.message, en("apiAdmin.fixMatch.jellyfinLocked", { tmdbId: 222 }), "in the caller's language");
  assert.ok(!toEs.message.includes("upstream detail"));

  assert.equal(clientFailure(new Error("http://10.0.0.5:8096 said no"), input, fresh, en).message, en("apiAdmin.fixMatch.failed"));
  assert.equal(clientFailure(new PlexUnmatchedError("x"), { ...input, server: "plex" }, fresh, en).message, en("apiAdmin.fixMatch.plexUnmatched", { tmdbId: 222 }));
  // A failure after the remote remap landed is the cache's, whatever was thrown.
  const landed = clientFailure(locked, { ...input, serverInstance: "remote" }, { remoteRemapped: true, plexKeysTouched: [] }, en);
  assert.equal(landed.message, en("apiAdmin.fixMatch.cacheUpdateFailed", { server: "Jellyfin (remote)", tmdbId: 222 }));
});

// ── Which jobs may not run side by side ──────────────────────────────────────

test("two jobs overlap when they rewrite the same item: the same item, or a title-mode job and any job on that title", () => {
  const title = { server: "plex" as const, serverInstance: "", mediaType: "MOVIE" as const, tmdbId: 111 };
  assert.equal(fixMatchScopesOverlap(title, { ...title }), true, "A→B and A→C");
  assert.equal(fixMatchScopesOverlap(title, { ...title, itemKey: "7" }), true, "a title-mode job and an item of that title");
  assert.equal(fixMatchScopesOverlap({ ...title, itemKey: "7" }, { ...title, itemKey: "7" }), true);
  assert.equal(fixMatchScopesOverlap({ ...title, itemKey: "7" }, { ...title, itemKey: "8" }), false, "two items of one title each move only their own");
  assert.equal(fixMatchScopesOverlap(title, { ...title, serverInstance: "remote" }), false, "another server's library");
  assert.equal(fixMatchScopesOverlap(title, { ...title, server: "jellyfin" }), false);
  assert.equal(fixMatchScopesOverlap(title, { ...title, tmdbId: 112 }), false);
  assert.equal(fixMatchScopesOverlap({ ...title, tmdbId: 0, itemKey: "7" }, { ...title, tmdbId: 0 }), false, "an unmatched item belongs to no title");
});
