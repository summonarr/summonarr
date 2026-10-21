// Pure half of the media servers' own watch records (src/lib/upstream-watch.ts).
// The never-watched report and the cleanup rules DELETE media off the back of
// "nobody watched this", so the parsers here decide whether a play the server
// recorded is seen at all. Each test names the mutation it catches.
//
// The join contract (never-watched-data.ts step 5) is pinned here at the source:
//   - a movie row is keyed by the movie's OWN key, season -1;
//   - an episode row is keyed by the SHOW's key, with the episode's season
//     (-1 when unknown).
import { test } from "node:test";
import assert from "node:assert/strict";

const {
  parsePlexHistoryItem,
  parseJellyfinPlayedItem,
  countsAsPlexWatchRecord,
  aggregateUpstream,
  computeAgreement,
  earliestViewed,
  agreementSince,
  safeUpstreamError,
  UPSTREAM_AGREEMENT_WINDOW_MS,
} = await import("../src/lib/upstream-watch.ts");

const T0 = 1_700_000_000; // epoch seconds

// ── parsePlexHistoryItem ─────────────────────────────────────────────────────

test("plex movie: its OWN ratingKey is the item key, no show, no season; viewedAt is epoch SECONDS (catches: ms-misread, show key on a movie)", () => {
  const e = parsePlexHistoryItem({ type: "movie", ratingKey: "4521", key: "/library/metadata/4521", viewedAt: T0, accountID: 1 });
  assert.deepEqual(e, {
    kind: "movie",
    itemKey: "4521",
    showKey: null,
    seasonNumber: null,
    viewedAt: new Date(T0 * 1000),
    accountId: "1",
  });
});

test("plex episode: grandparentRatingKey is the show key and parentIndex the season (catches: keying an episode by its own key or its season's)", () => {
  const e = parsePlexHistoryItem({
    type: "episode", ratingKey: 9001, key: "/library/metadata/9001", parentKey: "/library/metadata/800",
    grandparentKey: "/library/metadata/700", grandparentRatingKey: "700", parentIndex: 2, index: 5, viewedAt: String(T0), accountID: "42",
  });
  assert.equal(e?.kind, "episode");
  assert.equal(e?.itemKey, "9001");
  assert.equal(e?.showKey, "700");
  assert.equal(e?.seasonNumber, 2);
  assert.deepEqual(e?.viewedAt, new Date(T0 * 1000), "a numeric-string viewedAt is accepted");
  assert.equal(e?.accountId, "42");
});

test("plex episode: with no grandparentRatingKey the show key is parsed from grandparentKey (catches: dropping the fallback)", () => {
  const e = parsePlexHistoryItem({ type: "episode", ratingKey: "9002", grandparentKey: "/library/metadata/701", parentIndex: "3", viewedAt: T0 });
  assert.equal(e?.showKey, "701");
  assert.equal(e?.seasonNumber, 3, "a numeric-string parentIndex is accepted");
  // grandparentRatingKey wins over grandparentKey when both are present.
  const both = parsePlexHistoryItem({ type: "episode", ratingKey: "1", grandparentRatingKey: "702", grandparentKey: "/library/metadata/999" });
  assert.equal(both?.showKey, "702");
});

test("plex: with no ratingKey the item key is parsed from `key` (catches: requiring ratingKey)", () => {
  assert.equal(parsePlexHistoryItem({ type: "movie", key: "/library/metadata/77" })?.itemKey, "77");
  assert.equal(parsePlexHistoryItem({ type: "movie", key: "/library/metadata/78/children" })?.itemKey, "78");
});

test("plex: an episode with no usable show key is kept (it still feeds the agreement check) with showKey null", () => {
  const e = parsePlexHistoryItem({ type: "episode", ratingKey: "55", grandparentKey: "/somewhere/else" });
  assert.equal(e?.itemKey, "55");
  assert.equal(e?.showKey, null);
  assert.equal(e?.seasonNumber, null);
});

test("plex: non-title types, missing keys, garbage keys and non-objects are dropped (catches: guessing a key)", () => {
  for (const raw of [
    { type: "track", ratingKey: "1" },
    { type: "clip", ratingKey: "1" },
    { ratingKey: "1" },
    { type: "movie" },
    { type: "movie", ratingKey: "abc" },
    { type: "movie", ratingKey: -3 },
    { type: "movie", ratingKey: 1.5 },
    { type: "movie", key: "/library/sections/1" },
    null, undefined, "movie", 7, [{ type: "movie", ratingKey: "1" }],
  ]) {
    assert.equal(parsePlexHistoryItem(raw), null, JSON.stringify(raw));
  }
  // Type is case-insensitive.
  assert.equal(parsePlexHistoryItem({ type: "Movie", ratingKey: "1" })?.kind, "movie");
});

test("plex: a missing, zero, negative or non-numeric viewedAt is null — never epoch 0 (catches: new Date(0) as a play date)", () => {
  for (const viewedAt of [undefined, 0, -5, "yesterday", null]) {
    assert.equal(parsePlexHistoryItem({ type: "movie", ratingKey: "1", viewedAt })?.viewedAt, null, String(viewedAt));
  }
  assert.equal(parsePlexHistoryItem({ type: "episode", ratingKey: "1", grandparentRatingKey: "2", parentIndex: -1 })?.seasonNumber, null);
  assert.equal(parsePlexHistoryItem({ type: "episode", ratingKey: "1", grandparentRatingKey: "2", parentIndex: 0 })?.seasonNumber, 0, "season 0 (specials) is a real season");
});

test("countsAsPlexWatchRecord: music/photos/extras don't count; movies, episodes and UNKNOWN types do (catches: a music-only history reading as a broken parser, or a reshaped record vanishing)", () => {
  assert.equal(countsAsPlexWatchRecord({ type: "track" }), false);
  assert.equal(countsAsPlexWatchRecord({ type: "photo" }), false);
  assert.equal(countsAsPlexWatchRecord({ type: "movie" }), true);
  assert.equal(countsAsPlexWatchRecord({ type: "episode" }), true);
  assert.equal(countsAsPlexWatchRecord({ type: "videoItem" }), true);
  assert.equal(countsAsPlexWatchRecord({}), true);
  assert.equal(countsAsPlexWatchRecord(null), false);
});

// ── parseJellyfinPlayedItem ──────────────────────────────────────────────────

test("jellyfin movie: Id is the item key; LastPlayedDate and PlayCount come from UserData", () => {
  const e = parseJellyfinPlayedItem({ Type: "Movie", Id: "abc123", UserData: { PlayCount: 3, LastPlayedDate: "2025-03-01T10:00:00.0000000Z", Played: true } });
  assert.deepEqual(e, {
    kind: "movie", itemKey: "abc123", showKey: null, seasonNumber: null,
    lastPlayedAt: new Date("2025-03-01T10:00:00.000Z"), playCount: 3,
  });
});

test("jellyfin episode: SeriesId is the show key and ParentIndexNumber the season (catches: keying by the episode or the season item)", () => {
  const e = parseJellyfinPlayedItem({ Type: "Episode", Id: "ep1", SeriesId: "ser1", SeasonId: "sea1", ParentIndexNumber: 4, IndexNumber: 2, UserData: { PlayCount: 1 } });
  assert.equal(e?.showKey, "ser1");
  assert.equal(e?.seasonNumber, 4);
  assert.equal(e?.itemKey, "ep1");
});

test("jellyfin: PlayCount is at least 1 — a resumable item with PlayCount 0 or none was still started (catches: a zero-count row)", () => {
  assert.equal(parseJellyfinPlayedItem({ Type: "Movie", Id: "a", UserData: { PlayCount: 0 } })?.playCount, 1);
  assert.equal(parseJellyfinPlayedItem({ Type: "Movie", Id: "a" })?.playCount, 1);
  assert.equal(parseJellyfinPlayedItem({ Type: "Movie", Id: "a", UserData: { PlayCount: "x" } })?.playCount, 1);
});

test("jellyfin: DateTime.MinValue / garbage LastPlayedDate is null (catches: year-1 dates as a real play)", () => {
  assert.equal(parseJellyfinPlayedItem({ Type: "Movie", Id: "a", UserData: { LastPlayedDate: "0001-01-01T00:00:00.0000000Z" } })?.lastPlayedAt, null);
  assert.equal(parseJellyfinPlayedItem({ Type: "Movie", Id: "a", UserData: { LastPlayedDate: "not a date" } })?.lastPlayedAt, null);
});

test("jellyfin: other types and missing ids are dropped", () => {
  for (const raw of [
    { Type: "Series", Id: "s" }, { Type: "Season", Id: "s" }, { Type: "Audio", Id: "a" },
    { Type: "Movie" }, { Type: "Movie", Id: "" }, { Type: "Movie", Id: "has space" }, null, [],
  ]) {
    assert.equal(parseJellyfinPlayedItem(raw), null, JSON.stringify(raw));
  }
});

// ── aggregateUpstream ────────────────────────────────────────────────────────

const d = (iso: string) => new Date(iso);

test("aggregate: a movie groups on its OWN key at season -1; episodes on (SHOW key, season) — the report's join keys (catches: episode rows keyed by episode)", () => {
  const rows = aggregateUpstream([
    { kind: "movie", itemKey: "m1", showKey: null, seasonNumber: null, viewedAt: d("2025-01-01") },
    { kind: "episode", itemKey: "e1", showKey: "s1", seasonNumber: 1, viewedAt: d("2025-01-02") },
    { kind: "episode", itemKey: "e2", showKey: "s1", seasonNumber: 1, viewedAt: d("2025-01-03") },
    { kind: "episode", itemKey: "e3", showKey: "s1", seasonNumber: 2, viewedAt: d("2025-01-04") },
  ]);
  const byKey = new Map(rows.map((r) => [`${r.itemKey}/${r.seasonNumber}`, r]));
  assert.equal(rows.length, 3);
  assert.deepEqual(byKey.get("m1/-1"), { itemKey: "m1", seasonNumber: -1, mediaType: "MOVIE", playCount: 1, lastPlayedAt: d("2025-01-01") });
  assert.deepEqual(byKey.get("s1/1"), { itemKey: "s1", seasonNumber: 1, mediaType: "TV", playCount: 2, lastPlayedAt: d("2025-01-03") });
  assert.deepEqual(byKey.get("s1/2"), { itemKey: "s1", seasonNumber: 2, mediaType: "TV", playCount: 1, lastPlayedAt: d("2025-01-04") });
});

test("aggregate: an unknown season lands on -1; an episode with no show key is skipped (catches: NaN/null seasons, unplaceable rows)", () => {
  const rows = aggregateUpstream([
    { kind: "episode", itemKey: "e1", showKey: "s1", seasonNumber: null },
    { kind: "episode", itemKey: "e2", showKey: null, seasonNumber: 1 },
  ]);
  assert.deepEqual(rows.map((r) => [r.itemKey, r.seasonNumber]), [["s1", -1]]);
});

test("aggregate: play counts SUM and the date is the LATEST (catches: last-write-wins dates, counting groups instead of plays)", () => {
  const [row] = aggregateUpstream([
    { kind: "movie", itemKey: "m1", showKey: null, seasonNumber: null, playCount: 2, lastPlayedAt: d("2025-05-01") },
    { kind: "movie", itemKey: "m1", showKey: null, seasonNumber: null, playCount: 3, lastPlayedAt: d("2025-02-01") },
  ]);
  assert.equal(row.playCount, 5);
  assert.deepEqual(row.lastPlayedAt, d("2025-05-01"));
});

test("aggregate: an undated play never overwrites a real date; an all-undated group keeps null (catches: null clobbering, inventing a date)", () => {
  const [dated] = aggregateUpstream([
    { kind: "movie", itemKey: "m1", showKey: null, seasonNumber: null, viewedAt: d("2025-05-01") },
    { kind: "movie", itemKey: "m1", showKey: null, seasonNumber: null, viewedAt: null },
  ]);
  assert.deepEqual(dated.lastPlayedAt, d("2025-05-01"));
  const [undatedFirst] = aggregateUpstream([
    { kind: "movie", itemKey: "m1", showKey: null, seasonNumber: null, viewedAt: null },
    { kind: "movie", itemKey: "m1", showKey: null, seasonNumber: null, viewedAt: d("2025-04-01") },
  ]);
  assert.deepEqual(undatedFirst.lastPlayedAt, d("2025-04-01"));
  const [none] = aggregateUpstream([
    { kind: "movie", itemKey: "m1", showKey: null, seasonNumber: null },
    { kind: "movie", itemKey: "m1", showKey: null, seasonNumber: null },
  ]);
  assert.equal(none.lastPlayedAt, null);
  assert.equal(none.playCount, 2, "a missing playCount is one play");
});

test("aggregate: mediaTypeFor decides each row's media type", () => {
  const rows = aggregateUpstream(
    [{ kind: "movie", itemKey: "m1", showKey: null, seasonNumber: null }],
    () => "TV",
  );
  assert.equal(rows[0].mediaType, "TV");
});

// ── agreement ────────────────────────────────────────────────────────────────

test("computeAgreement: samples are what Summonarr recorded; agreed is how many the server also has (catches: counting the server's side, or the union)", () => {
  assert.deepEqual(computeAgreement(new Set(["a", "b", "c", "d"]), new Set(["b", "d", "x", "y", "z"])), { samples: 4, agreed: 2 });
  assert.deepEqual(computeAgreement(new Set(), new Set(["a"])), { samples: 0, agreed: 0 });
  assert.deepEqual(computeAgreement(new Set(["a"]), new Set()), { samples: 1, agreed: 0 });
});

test("earliestViewed: the earliest DATED record; null when nothing is dated", () => {
  assert.deepEqual(earliestViewed([{ viewedAt: d("2025-03-01") }, { viewedAt: null }, { lastPlayedAt: d("2025-01-01") }]), d("2025-01-01"));
  assert.equal(earliestViewed([{ viewedAt: null }, {}]), null);
});

test("agreementSince: the 90-day window, raised to the earliest record the fetch reached — never lowered (catches: sampling plays the server never returned)", () => {
  const now = d("2025-06-01T00:00:00.000Z");
  const windowStart = new Date(now.getTime() - UPSTREAM_AGREEMENT_WINDOW_MS);
  assert.deepEqual(agreementSince(now, null), windowStart);
  assert.deepEqual(agreementSince(now, d("2020-01-01")), windowStart, "an older floor does not widen the window");
  assert.deepEqual(agreementSince(now, d("2025-05-20")), d("2025-05-20"));
});

// ── safeUpstreamError ────────────────────────────────────────────────────────

test("safeUpstreamError: never carries a URL, a token or upstream text (catches: relaying err.message)", () => {
  const secretUrl = "http://10.0.0.5:32400/status/sessions/history/all?X-Plex-Token=SECRET";
  const cases: Array<[unknown, string]> = [
    [new Error(`Plex paginated fetch failed: 401 at start=0`), "HTTP 401"],
    [new Error(`Jellyfin fetch failed: 503 at StartIndex=1000`), "HTTP 503"],
    [new Error(`Jellyfin users: 403`), "HTTP 403"],
    [new Error("Jellyfin returned no users"), "the server returned no users"],
    [Object.assign(new Error(`Request to ${secretUrl} timed out`), { name: "SafeFetchError", reason: "timeout" }), "timed out"],
    [Object.assign(new Error(`connect ECONNREFUSED ${secretUrl}`), { name: "SafeFetchError", reason: "network" }), "unreachable"],
    [new Error(`boom at ${secretUrl}`), "request failed"],
    ["weird", "request failed"],
  ];
  for (const [err, expected] of cases) {
    const msg = safeUpstreamError(err);
    assert.equal(msg, expected);
    assert.ok(!msg.includes("SECRET") && !msg.includes("http"), msg);
  }
});
