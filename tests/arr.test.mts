// Unit tests for the pure surface of the Radarr/Sonarr client (src/lib/arr.ts).
// ArrResponseError's status/body fields drive the webhook confirm paths and the
// duplicate/path-collision retry logic, and arrErrorMessage is what admins see
// when an approve/add fails — so both contracts are pinned exactly. Also pins
// the guardrail-5 constants (30s timeout, 50 MB response cap: libraries with
// >3k movies silently truncated at the old 10 MB cap) via a source-text check,
// since the constants are module-private and arrFetch itself does network.
// Everything DB/network-bound (getCfg, arrFetch, wanted/queue readers) is
// intentionally NOT exercised here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ArrResponseError,
  arrErrorMessage,
  pickSeriesByTmdbId,
  resolveSingleTvdbToTmdb,
} from "../src/lib/arr.ts";

// arr.ts imports @/lib/prisma (client constructed at load, connections/queries
// are lazy) and @/lib/token-crypto (key read lazily). Set the env so an
// incidental lazy read can never throw mid-test; no test below issues a query.
process.env.NEXTAUTH_SECRET ??= "unit-test-session-secret-0123456789abcdef";
process.env.TOKEN_ENCRYPTION_KEY ??= "ab".repeat(32);
process.env.DATABASE_URL ??= "postgresql://unit:unit@127.0.0.1:9/never_connects";

// ---------------------------------------------------------------------------
// ArrResponseError
// ---------------------------------------------------------------------------

test("ArrResponseError exposes status, body, and the exact message", () => {
  const err = new ArrResponseError(503, '{"message":"Service Unavailable"}');
  assert.equal(err.status, 503);
  assert.equal(err.body, '{"message":"Service Unavailable"}');
  assert.equal(err.message, "Arr service returned a non-200 response (503)");
});

test("ArrResponseError is an Error subclass (instanceof narrowing works)", () => {
  const err: unknown = new ArrResponseError(400, "bad request");
  assert.ok(err instanceof ArrResponseError);
  assert.ok(err instanceof Error);
  // The duplicate/path-collision handlers narrow on instanceof then read the
  // fields — after narrowing both must be reachable and correctly typed.
  if (err instanceof ArrResponseError) {
    assert.equal(err.status, 400);
    assert.equal(err.body, "bad request");
  }
});

test("ArrResponseError preserves an empty body verbatim", () => {
  const err = new ArrResponseError(500, "");
  assert.equal(err.body, "");
  assert.equal(err.message, "Arr service returned a non-200 response (500)");
});

// ---------------------------------------------------------------------------
// arrErrorMessage — the admin-facing mapping of upstream failures
// ---------------------------------------------------------------------------

test("arrErrorMessage: 401/403 map to the API-key hint", () => {
  assert.equal(
    arrErrorMessage(new ArrResponseError(401, "Unauthorized")),
    "Arr authentication failed (401) — check the API key",
  );
  assert.equal(
    arrErrorMessage(new ArrResponseError(403, "Forbidden")),
    "Arr authentication failed (403) — check the API key",
  );
});

test("arrErrorMessage: 404 maps to not-found", () => {
  assert.equal(
    arrErrorMessage(new ArrResponseError(404, "NotFound")),
    "Item not found in arr (404)",
  );
});

test("arrErrorMessage: >=500 maps to server-error (500 is the boundary)", () => {
  assert.equal(
    arrErrorMessage(new ArrResponseError(500, "boom")),
    "Arr server error (500) — check the arr service logs",
  );
  assert.equal(
    arrErrorMessage(new ArrResponseError(503, "unavailable")),
    "Arr server error (503) — check the arr service logs",
  );
  // 499 sits just below the boundary → generic bucket, not server-error.
  assert.equal(arrErrorMessage(new ArrResponseError(499, "x")), "Arr request failed (499)");
});

test("arrErrorMessage: other statuses fall through to the generic bucket", () => {
  assert.equal(arrErrorMessage(new ArrResponseError(400, "validation")), "Arr request failed (400)");
  assert.equal(arrErrorMessage(new ArrResponseError(409, "conflict")), "Arr request failed (409)");
  assert.equal(arrErrorMessage(new ArrResponseError(429, "slow down")), "Arr request failed (429)");
});

test("arrErrorMessage never leaks the upstream response body", () => {
  // Arr error bodies can embed paths/urls from the admin's instance; the
  // user-facing message must stay a status-only summary for every bucket.
  const secret = "X-Api-Key=super-secret /mnt/media/Movies";
  for (const status of [400, 401, 403, 404, 429, 500, 503]) {
    const msg = arrErrorMessage(new ArrResponseError(status, secret));
    assert.equal(msg.includes("super-secret"), false, `status ${status} leaked the body`);
    assert.equal(msg.includes("/mnt/media"), false, `status ${status} leaked the body`);
  }
});

test("arrErrorMessage: plain Error passes its message through", () => {
  assert.equal(arrErrorMessage(new Error("fetch failed")), "fetch failed");
  assert.equal(arrErrorMessage(new TypeError("cfg.url is undefined")), "cfg.url is undefined");
});

test("arrErrorMessage: non-Error values get the generic fallback", () => {
  assert.equal(arrErrorMessage("boom"), "Arr request failed");
  assert.equal(arrErrorMessage(undefined), "Arr request failed");
  assert.equal(arrErrorMessage(null), "Arr request failed");
  assert.equal(arrErrorMessage({ status: 500 }), "Arr request failed");
  assert.equal(arrErrorMessage(42), "Arr request failed");
});

// ---------------------------------------------------------------------------
// resolveSingleTvdbToTmdb — the invalid-id fast path
// ---------------------------------------------------------------------------

test("resolveSingleTvdbToTmdb returns null for invalid ids without touching cache/DB", async () => {
  // Only the pure guard is exercised — a *valid* id proceeds to the tmdb-cache
  // and MediaRequest lookups (DB) and must not be called in a unit test. The
  // guard returning null (not throwing) matters: the Sonarr webhook calls this
  // with whatever id the payload carried, and a garbage tvdbId must degrade to
  // "no eviction", never a 500.
  assert.equal(await resolveSingleTvdbToTmdb(0), null);
  assert.equal(await resolveSingleTvdbToTmdb(-1), null);
  assert.equal(await resolveSingleTvdbToTmdb(2.5), null);
  assert.equal(await resolveSingleTvdbToTmdb(NaN), null);
  assert.equal(await resolveSingleTvdbToTmdb(Infinity), null);
  assert.equal(await resolveSingleTvdbToTmdb(-Infinity), null);
});

// ---------------------------------------------------------------------------
// Guardrail 5 pin — 50 MB response cap + 30s timeout, wired into arrFetch
// ---------------------------------------------------------------------------

test("the Sonarr download check cross-verifies the payload's tvdbId and tmdbId against each other", () => {
  // isSeriesDownloadedInSonarr is the webhook's anti-forgery gate, but it does DB
  // (getArrCfg) and network (arrFetch) I/O, so pin the source the same way the
  // guardrail-5 test below does.
  //
  // The hazard: the guard RESOLVES and verifies the tvdbId, while the Sonarr
  // webhook's status flip keys on the tmdbId. Whoever holds the webhook secret —
  // the threat the guard's own comment names — could pair a tvdbId they really did
  // download (so the check passes) with an arbitrary tmdbId, and an unrelated
  // APPROVED request would flip to AVAILABLE, lose its wanted row, and notify its
  // requester. Two ids naming different series is never legitimate, so it must
  // return false (skip the flip), not fall through to the tvdb-only verdict.
  const source = readFileSync(new URL("../src/lib/arr.ts", import.meta.url), "utf8");
  const fn = source.slice(source.indexOf("export async function isSeriesDownloadedInSonarr"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /resolved !== tvdbId/, "the two ids must be compared, not just the tvdbId resolved");
  assert.match(body, /reason: "ids-disagree"/, "disagreeing ids must return the refused verdict (skip the flip), never null/downloaded");
  assert.doesNotMatch(body, /return false;|return true;|return null;\s*\/\/ disagree/, "the verdict is a discriminated object now — a bare boolean would lose the reason the webhook branches on");
});

// ---------------------------------------------------------------------------
// Guardrail 14a — ONE completeness rule, shared by the cache writer and the
// webhook gate. Both are DB/network-bound, so pin the source: each must call
// sonarrSeriesCompletion (tests/sonarr-completion.test.mts owns the rule
// itself), and neither may carry a private threshold. The old writer said a
// CONTINUING series was available with any single episode file
// (`status !== "ended"`), so a requester was told "ready to watch" off episode
// 1 of a season pack; a private copy in either function would reintroduce
// that on one path and have the other path revert it every tick.
// ---------------------------------------------------------------------------

test("guardrail 14a: the Sonarr cache writer and the webhook gate share sonarrSeriesCompletion and carry no private threshold", () => {
  const source = readFileSync(new URL("../src/lib/arr.ts", import.meta.url), "utf8");
  for (const name of ["getSonarrWantedTmdbIds", "isSeriesDownloadedInSonarr", "getSonarrSeriesCompletion"]) {
    const fn = source.slice(source.indexOf(`export async function ${name}`));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    assert.match(body, /sonarrSeriesCompletion\(/, `${name} must derive completeness from the shared helper`);
    assert.doesNotMatch(body, /!==\s*"ended"|===\s*"ended"/, `${name} must not special-case series status — an ended/continuing split is the any-file shortcut guardrail 14a removed`);
    assert.doesNotMatch(body, /episodeFileCount\s*>=\s*episodeCount|episodeFileCount\s*>\s*0/, `${name} must not re-derive the threshold inline`);
    assert.doesNotMatch(body, /totalEpisodeCount/, `${name} must never count unaired/unmonitored episodes`);
  }
});

test("pickSeriesByTmdbId REJECTS a lone row that names a DIFFERENT title — a degraded lookup must not become the verdict", () => {
  // Observed live: `term=tmdb:84503` answered with exactly one row whose tvdbId
  // was 84503 (a fallback id/text search matched the wrong series). The lone-row
  // fallback accepted it, the webhook's ids-disagree guard then compared that
  // wrong tvdbId against the payload's real one, and a genuine Download event
  // was refused. A row that CARRIES a positive tmdbId has told us which title it
  // is; when that is not the requested one it is a different show, full stop.
  const wrongShow = [{ tmdbId: 4321, tvdbId: 84503 }];
  assert.equal(pickSeriesByTmdbId(wrongShow, 84503), null);
  // The tmdbId-less lone row (older SkyHook rows) is still accepted — that
  // heuristic is what makes tvdb-only metadata resolvable at all.
  assert.equal(pickSeriesByTmdbId([{ tvdbId: 84503 } as { tmdbId?: number; tvdbId: number }], 84503)?.tvdbId, 84503);
  // Non-positive / non-integer tmdbId values are "no claim", not "a different title".
  for (const claimed of [0, -1, 2.5, NaN]) {
    assert.equal(pickSeriesByTmdbId([{ tmdbId: claimed, tvdbId: 777 }], 84503)?.tvdbId, 777, `tmdbId=${claimed} carries no claim`);
  }
});

test("the Sonarr download check holds EVERY id to a positive-integer contract, upstream ones included", () => {
  // Same source-pinning idiom as the test above, for the same reason (DB + network
  // I/O in the function).
  //
  // Both payload ids are guarded, but the value Sonarr's own lookup returns used
  // not to be — and it is not merely logged, it can BECOME `tvdbId` and then be
  // compared with `===` against the library rows. A non-integer from a malformed
  // or hostile upstream would make that comparison silently never match, so the
  // function would answer "not downloaded" for a series Sonarr actually holds,
  // instead of the honest `null` its tri-state contract reserves for unverifiable.
  //
  // The Number() wrappers on the warn() are the log-injection half: the webhook is
  // secret-only authed with no schema, so an id arriving as a string could carry a
  // newline and forge a second "[arr] …" line in the log. They are no-ops at
  // runtime — the point is that the guarantee is visible AT the call site rather
  // than several lines up, where neither a reader nor a scanner will look.
  const source = readFileSync(new URL("../src/lib/arr.ts", import.meta.url), "utf8");
  const fn = source.slice(source.indexOf("export async function isSeriesDownloadedInSonarr"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));

  const guards = body.match(/Number\.isInteger\(/g) ?? [];
  assert.equal(guards.length, 3, "expected all three ids (tvdbId, tmdbId, and the resolved lookup) to be integer-guarded");
  assert.match(body, /Number\.isInteger\(rawResolved\)/, "the upstream lookup result must be validated before use");
  assert.match(
    body,
    /Number\(tvdbId\), Number\(claimedTmdbId\), Number\(resolved\)/,
    "the warn() ids must be numerically coerced at the call site",
  );
});

test("guardrail 5: the 50 MB cap and 30s timeout are pinned and wired into arrFetch", () => {
  // The constants are module-private and arrFetch does real network I/O, so a
  // runtime assertion isn't possible here. Pin the source text instead: this
  // fails the suite if anyone lowers the cap (the old 10 MB cap silently
  // truncated >3k-movie libraries) or detaches it from the safe-fetch call.
  const source = readFileSync(new URL("../src/lib/arr.ts", import.meta.url), "utf8");
  assert.match(source, /const ARR_FETCH_MAX_BYTES = 50 \* 1024 \* 1024;/);
  assert.match(source, /const ARR_FETCH_TIMEOUT_MS = 30_000;/);
  assert.match(source, /maxResponseBytes: ARR_FETCH_MAX_BYTES/);
  assert.match(source, /timeoutMs: ARR_FETCH_TIMEOUT_MS/);
});

test("getCfg normalizes an EMPTY rootFolder to undefined so the `??` fallback actually fires", () => {
  // getCfg is module-private and DB-bound, so pin it structurally (same technique
  // as the 50 MB cap above). An empty-string rootFolder is the instance manager's
  // documented "— use the server's default —" choice: its select ships
  // <option value=""> and POST /api/admin/arr-instances writes it verbatim as a
  // Setting row. Every guard around the value is a FALSY check
  // (`cfg.rootFolder ? skip : fetch`, `!cfg.rootFolder && !rootFolders.length`),
  // so "" flows through them as "unset" — but it SURVIVES `??`, so
  // `cfg.rootFolder ?? rootFolders[0].path` yielded "" and the add POSTed
  // rootFolderPath:"". Radarr/Sonarr 400 that, and every request routed to the
  // instance bounced APPROVED→PENDING forever behind an opaque "Arr request
  // failed (400)". The sibling qualityProfileId already normalizes for exactly
  // this reason.
  const source = readFileSync(new URL("../src/lib/arr.ts", import.meta.url), "utf8");
  const fn = source.slice(source.indexOf("async function getCfg("));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(
    body,
    /rootFolder:\s*map\[folderKey\]\s*\|\|\s*undefined/,
    "rootFolder must be `|| undefined` — a bare `map[folderKey]` lets \"\" survive the `??` at both add sites",
  );

  // And both add sites must still rely on `??` (the guards above them assume it).
  for (const site of ["addMovieToRadarr", "addSeriesToSonarr"]) {
    const f = source.slice(source.indexOf(`export async function ${site}`));
    const b = f.slice(0, f.indexOf("\n}\n"));
    assert.match(b, /const rootFolderPath = cfg\.rootFolder \?\? rootFolders\[0\]\.path;/, `${site} root-folder fallback`);
  }
});

test("isSeriesWantedInSonarr tolerates a series row with no statistics block", () => {
  // Its two siblings guard `statistics` explicitly (one carries a comment about
  // an "opaque availability freeze"); this one dereferenced it bare, so a single
  // anomalous /api/v3/series row would throw into the function's own catch and
  // report wantedLive:false with no error — actively misleading the arr-state
  // diagnostic CLAUDE.md tells operators to trust first.
  const source = readFileSync(new URL("../src/lib/arr.ts", import.meta.url), "utf8");
  const fn = source.slice(source.indexOf("export async function isSeriesWantedInSonarr"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /match\.statistics\?\./, "statistics must be optional-chained");
  assert.doesNotMatch(body, /match\.statistics\.[a-z]/i, "no bare statistics dereference may remain");
});

// ---------------------------------------------------------------------------
// pickSeriesByTmdbId — the wrong-series guard shared by every Sonarr lookup.
//
// Sonarr degrades an unrecognized `term=tmdb:<id>` into a fuzzy SkyHook title
// search, so a non-empty response can be entirely unrelated shows. addSeriesToSonarr
// has guarded this since the wrong-series incident; the read paths did not, and
// their failures are quieter — a wrong tvdbId reaches queue/library membership
// checks, gates the webhook's AVAILABLE transition, and via resolveTvdbIdFromTmdbId
// is PERSISTED onto Issue.tvdbId, where nothing ever re-resolves it.
// ---------------------------------------------------------------------------

test("pickSeriesByTmdbId prefers the row whose tmdbId matches, whatever its position", () => {
  const results = [
    { tmdbId: 999, tvdbId: 111 },
    { tmdbId: 1399, tvdbId: 121361 },
    { tmdbId: 555, tvdbId: 222 },
  ];
  assert.equal(pickSeriesByTmdbId(results, 1399)?.tvdbId, 121361);
});

test("PIN: a multi-row fuzzy result with NO tmdbId match resolves to null, never row 0", () => {
  // The wrong-series hazard itself: SkyHook returned unrelated shows, none of
  // which is the requested title. Returning results[0] here is what put a wrong
  // tvdbId onto Issue rows and into queue membership checks.
  const skyhookMiss = [
    { tmdbId: 4321, tvdbId: 111 },
    { tmdbId: 8765, tvdbId: 222 },
  ];
  assert.equal(pickSeriesByTmdbId(skyhookMiss, 1399), null);
});

test("pickSeriesByTmdbId accepts index 0 only when the lookup returned exactly one candidate", () => {
  // A recognized id lookup yields exactly one row, and SkyHook rows may carry no
  // tmdbId at all — so a lone result is accepted even unmatched.
  type Row = { tmdbId?: number; tvdbId: number };
  const lone: Row[] = [{ tvdbId: 121361 }];
  assert.equal(pickSeriesByTmdbId(lone, 1399)?.tvdbId, 121361);
  // …but two unmatched rows are ambiguous, so neither is trusted.
  const ambiguous: Row[] = [{ tvdbId: 111 }, { tvdbId: 222 }];
  assert.equal(pickSeriesByTmdbId(ambiguous, 1399), null);
});

test("pickSeriesByTmdbId returns null for an empty result set", () => {
  assert.equal(pickSeriesByTmdbId([], 1399), null);
});

test("every Sonarr series/lookup caller routes through the shared picker", () => {
  // Source-text pin: these functions are DB/network-bound so they cannot be
  // invoked here, but a new call site that hand-rolls `results[0]` again would
  // silently reintroduce the wrong-series bug.
  const source = readFileSync(new URL("../src/lib/arr.ts", import.meta.url), "utf8");
  // Interpolated form only — the helper's own doc comment mentions the path too.
  const lookupCalls = source.match(/series\/lookup\?term=tmdb:\$\{/g) ?? [];
  assert.equal(
    lookupCalls.length,
    2,
    "expected exactly two lookup URLs: the shared helper and addSeriesToSonarr's Promise.all fetch",
  );
  assert.doesNotMatch(source, /lookup\[0\]/, "no direct lookup[0] indexing may remain");
  assert.doesNotMatch(source, /results\[0\]\?\.(tvdbId|firstAired)/, "no direct results[0] field access may remain");
});
