// Data from outside the process is checked, not cast. These sites read an
// upstream or server answer and used to trust it with `as T`; a regression to
// the cast fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("the OMDb key test checks its answer instead of casting it", () => {
  const src = read("src/lib/omdb.ts");
  assert.doesNotMatch(src, /\.json\(\)\s+as\s+\{/);
  assert.match(src, /check\(TEST_ANSWER,/);
});

test("the download queue load rejects a 200 that is not the report", () => {
  const src = read("src/components/admin/use-queue-data.ts");
  assert.doesNotMatch(src, /\.json\(\)\)\s+as\s+QueueReport/);
  assert.match(src, /queueAnswer\(await res\.json\(\)/);
  assert.match(src, /Array\.isArray\(r\.items\)/);
});

test("a Plex playing frame's notification fields are type-checked before use", () => {
  const src = read("src/lib/plex-events.ts");
  assert.match(src, /typeof n\.sessionKey === "string"/);
  assert.match(src, /typeof n\.viewOffset === "number"/);
});

test("a stored pending search that is not the expected shape reads as absent", async () => {
  const { PENDING_SEARCH, PENDING_ISSUE } = await import("../src/lib/discord-interactions/pending-schemas.ts");
  const { check } = await import("../src/lib/validate.ts");
  const result = { id: 1, title: "T", mediaType: "movie", releaseYear: "2020", posterPath: null, overview: "", voteAverage: 1 };
  assert.equal(check(PENDING_SEARCH, { results: [result], discordUserId: "9" }).ok, true);
  assert.equal(check(PENDING_SEARCH, { results: [{ ...result, id: "1" }], discordUserId: "9" }).ok, false);
  assert.equal(check(PENDING_SEARCH, { results: "x", discordUserId: "9" }).ok, false);
  const issue = { results: [result], issueType: "OTHER", note: null, season: null, episode: null };
  assert.equal(check(PENDING_ISSUE, issue).ok, true);
  assert.equal(check(PENDING_ISSUE, { ...issue, issueType: "NOPE" }).ok, false);
  const src = read("src/lib/discord-interactions/reply.ts");
  assert.doesNotMatch(src, /JSON\.parse\(row\.data\)\s+as\s/);
  assert.match(src, /check\(schema, parsed\)/);
  for (const f of ["pick", "issue", "watchlist"]) {
    assert.doesNotMatch(read(`src/lib/discord-interactions/components/${f}.ts`), /loadPending</);
  }
});

test("the library prewarm checks a TMDB details body before building the stored blob", () => {
  const src = read("src/lib/tmdb-prewarm.ts");
  assert.doesNotMatch(src, /JSON\.parse\(bodyText\)\s+as\s+TmdbDetailsBody/);
  assert.match(src, /check\(DETAILS_ENVELOPE, body\)/);
});

test("a Plex SSE frame or entry that is not an object is skipped, not dereferenced", () => {
  const src = read("src/lib/plex-events.ts");
  assert.match(src, /if \(!parsed \|\| typeof parsed !== "object"\) return;\s+const raw = parsed\.TimelineEntry/);
  assert.match(src, /if \(!parsed \|\| typeof parsed !== "object"\) return;\s+const raw = parsed\.PlaySessionStateNotification/);
  assert.match(src, /for \(const e of entries\) \{[^]*?if \(!e \|\| typeof e !== "object"\) continue;/);
});

test("arr listings are read as unknown and each row is narrowed to a record", () => {
  const cleanup = read("src/lib/library-cleanup-arr.ts");
  assert.doesNotMatch(cleanup, /fetchListing<(Radarr|Sonarr)\w+\[\]>/);
  assert.match(cleanup, /asRecord\(row\)/);
  const missing = read("src/lib/arr-missing-data.ts");
  assert.doesNotMatch(missing, /as (SonarrEpisodeRow|SonarrEpisodeFileRow|SonarrCutoffRecord|RadarrCutoffRow)\[\]/);
  assert.doesNotMatch(missing, /arrFetch<RadarrMovieRow>/);
  assert.match(missing, /recordRows</);
});

test("the debug arr-state mapping blob is checked, not cast", () => {
  const src = read("src/app/api/admin/debug/arr-state/route.ts");
  assert.doesNotMatch(src, /JSON\.parse\(row\.data\)\s+as\s/);
  assert.match(src, /check\(CACHED_MAPPING,/);
});
