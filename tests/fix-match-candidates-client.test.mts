// The fix-match pickers' candidates read (src/lib/client/fix-match-candidates.ts).
// The route's answer is checked before a dialog renders it: a body that isn't
// the shape (a proxy's sign-in page, a changed route) used to be trusted on
// `res.ok`, and the modal then crashed reading `candidates.length` or
// `targetGenres.slice`. A failure is worded once for both dialogs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { candidatesErrorText, candidatesUrl, fetchFixMatchCandidates } from "../src/lib/client/fix-match-candidates.ts";

const ANSWER = {
  candidates: [{
    guid: "plex://movie/abc", name: "Dune", year: 2021, thumb: null, score: 90, imdbId: "tt1160419", tmdbId: "438631",
    tmdbTitle: "Dune", tmdbOverview: null, tmdbRuntime: 155, tmdbGenres: ["Sci-Fi"], tmdbVoteAvg: 7.8, tmdbPosterPath: null,
    matchLevel: "exact", confidence: 100, titleSimilarity: 1, radarrConfirmed: false, suggested: true,
  }],
  targetTitle: "Dune", targetYear: "2021", targetImdbId: "tt1160419", targetPosterPath: null, targetOverview: "",
  targetReleaseDate: null, targetVoteAverage: null, targetRuntime: 155, targetGenres: [], arrConfirmedTmdbId: null,
  arrConfirmedTitle: null, arrPathAgrees: null, ratingKey: "12", plexFilePath: null, jellyfinFilePath: null,
  serverInstance: "", currentTitle: null, currentYear: null,
};

async function withAnswer(status: number, body: unknown) {
  const real = globalThis.fetch;
  let url = "";
  globalThis.fetch = (async (u: string | URL | Request) => {
    url = String(u);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  try {
    return { res: await fetchFixMatchCandidates({ server: "plex", tmdbId: 1, mediaType: "MOVIE", correctTmdbId: 438631, serverInstance: "" }), url };
  } finally {
    globalThis.fetch = real;
  }
}

const t = (k: string, vars?: Record<string, unknown>) => (vars ? `${k}${JSON.stringify(vars)}` : k);

test("the route's answer passes the check whole", async () => {
  const { res, url } = await withAnswer(200, ANSWER);
  assert.ok(res.ok);
  assert.deepEqual(res.data, ANSWER);
  assert.match(url, /\/api\/admin\/fix-match\/candidates\?server=plex&tmdbId=1&mediaType=MOVIE&correctTmdbId=438631$/, "the default instance stays out of the query");
});

test("an answer missing what the dialog reads is a failure, not a half-read object", async () => {
  for (const broken of [
    { ...ANSWER, candidates: undefined },
    { ...ANSWER, targetGenres: "Sci-Fi" },
    { ...ANSWER, candidates: [{ ...ANSWER.candidates[0], matchLevel: "perfect" }] },
  ]) {
    const { res } = await withAnswer(200, broken);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.kind, "invalid");
  }
  const { res: html } = await withAnswer(200, "<html>sign in</html>");
  assert.equal(html.ok ? "ok" : html.kind, "invalid");
});

test("the failure text: the route's reason, else the status, else a network error", () => {
  const base = { ok: false as const, body: null, detail: "" };
  assert.equal(candidatesErrorText({ ...base, kind: "http", status: 404, error: "", body: { error: "Not in the library" } }, t), "Not in the library");
  assert.equal(candidatesErrorText({ ...base, kind: "http", status: 500, error: "" }, t), 'adminQueue.common.requestFailed{"status":500}');
  assert.equal(candidatesErrorText({ ...base, kind: "invalid", status: 200, error: "" }, t), 'adminQueue.common.requestFailed{"status":200}');
  assert.equal(candidatesErrorText({ ...base, kind: "network", status: 0, error: "" }, t), "shared.thread.networkError");
  assert.equal(candidatesErrorText({ ...base, kind: "timeout", status: 0, error: "" }, t), "shared.thread.networkError");
});

test("a named instance and the arr's id ride the query", () => {
  const url = candidatesUrl({ server: "jellyfin", tmdbId: 5, mediaType: "TV", correctTmdbId: 6, arrTmdbId: 7, serverInstance: "remote" });
  assert.match(url, /server=jellyfin&tmdbId=5&mediaType=TV&correctTmdbId=6&arrTmdbId=7&serverInstance=remote$/);
});
