// The fix-match picker's pieces (src/lib/fix-match-candidates.ts): the arr
// cross-check believes a row AT the file's folder over one elsewhere, and the
// Plex searches say when they got no answer and never pass a field of the
// wrong type through. Route-level behaviour: tests/fix-match-routes.test.mts
// and tests/fix-match-candidates-arr.test.mts.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
console.error = () => {};
console.warn = () => {};

const PLEX = "http://10.77.0.5:32400";
let answer: (url: URL) => Response = () => new Response("{}", { status: 200 });
const asked: URL[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  asked.push(url);
  return answer(url);
}) as typeof fetch;

const { decideArrConfirmation, searchPlexCandidates } = await import("../src/lib/fix-match-candidates.ts");

beforeEach(() => {
  asked.length = 0;
});

const LIB = "/media/movies/Right Film (2010)/right.mkv";
const ids = { tmdbId: 111, correctTmdbId: 222 };

test("a row at the file's folder decides: the correct id there confirms with the paths agreeing", () => {
  assert.deepEqual(
    decideArrConfirmation({ correct: [{ tmdbId: 222, path: "/media/movies/Right Film (2010)" }], wrong: [] }, ids, LIB),
    { arrConfirmedTmdbId: 222, arrPathAgrees: true },
  );
});

test("the correct id held ELSEWHERE never outvotes the wrong id held at THIS folder", () => {
  assert.deepEqual(
    decideArrConfirmation({
      correct: [{ tmdbId: 222, path: "/media/movies-4k/Right Film (2010)" }],
      wrong: [{ tmdbId: 111, path: "/media/movies/Right Film (2010)" }],
    }, ids, LIB),
    { arrConfirmedTmdbId: 111, arrPathAgrees: true },
  );
});

test("with several instances, the one whose folder holds the file is the one believed", () => {
  assert.deepEqual(
    decideArrConfirmation({
      correct: [{ tmdbId: 222, path: "/elsewhere/Right Film" }, { tmdbId: 222, path: "/media/movies/Right Film (2010)" }],
      wrong: [],
    }, ids, LIB),
    { arrConfirmedTmdbId: 222, arrPathAgrees: true },
  );
});

test("no row at the folder: the correct id's membership still confirms, with the paths disagreeing (split mounts)", () => {
  assert.deepEqual(
    decideArrConfirmation({ correct: [{ tmdbId: 222, path: "/elsewhere/Right Film" }], wrong: [{ tmdbId: 111, path: "/also/elsewhere" }] }, ids, LIB),
    { arrConfirmedTmdbId: 222, arrPathAgrees: false },
  );
  assert.deepEqual(decideArrConfirmation({ correct: [{ tmdbId: 222 }], wrong: [] }, ids, LIB), { arrConfirmedTmdbId: null, arrPathAgrees: null }, "no folder vouches for nothing");
});

const target = { correctTmdbId: 222, imdbId: "", title: "Right Film", year: "2010" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("Plex search results are read field by field: a year sent as text is its number, a guidless result is dropped", async () => {
  answer = () => json({ MediaContainer: { SearchResult: [
    { guid: "plex://movie/a", name: "Right Film", year: "2010", thumb: "/t", score: 90 },
    { name: "no guid" },
    { guid: "plex://movie/b", name: 7, year: "soon", score: "high" },
  ] } });
  const { raw, failed } = await searchPlexCandidates(PLEX, "42", {}, target, null);
  assert.equal(failed, false);
  assert.deepEqual(raw.map((c) => [c.guid, c.name, c.year, c.score]), [
    ["plex://movie/a", "Right Film", 2010, 90],
    ["plex://movie/b", "", null, null],
  ]);
});

test("a Plex search with no usable answer is reported, so the picker never keeps the short list as the whole one", async () => {
  answer = (url) => (url.searchParams.get("agent") === "com.plexapp.agents.themoviedb" ? new Response("bad gateway", { status: 502 }) : json({ MediaContainer: {} }));
  const res = await searchPlexCandidates(PLEX, "42", {}, target, null);
  assert.equal(res.failed, true);
  assert.deepEqual(res.raw, []);

  answer = () => json({ MediaContainer: {} });
  assert.equal((await searchPlexCandidates(PLEX, "42", {}, target, null)).failed, false, "an answer with no results is an answer");
});
