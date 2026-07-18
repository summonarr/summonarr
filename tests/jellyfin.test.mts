// Unit tests for the Jellyfin HTTP client (src/lib/jellyfin.ts) — the sole
// wire-facing layer between Summonarr and a Jellyfin server. Everything here
// funnels through safeFetchAdminConfigured (the URL is admin-configured
// Setting data), so the tests exercise the REAL safe-fetch/SSRF stack with a
// scripted globalThis.fetch. The contracts pinned here:
//
//   authenticateWithJellyfin / QuickConnect trio:
//   - the EXACT wire shape login depends on: POST /Users/AuthenticateByName
//     with the X-Emby-Authorization MediaBrowser identity header and a
//     {Username, Pw} JSON body (Jellyfin rejects password auth without both);
//     QuickConnect's initiate/poll/exchange endpoints, the Secret's
//     encodeURIComponent transport, and the {secret, code}/Authenticated
//     mappings;
//   - degradation: non-2xx THROWS (status in the message; auth failures also
//     log with the [jellyfin auth] scope), and a 2xx body missing User.Id or
//     User.Name throws rather than minting a half-formed user.
//
//   Library surface (hasJellyfinItemByTmdbId, getJellyfinTmdbIds,
//   getJellyfinMediaFolders, refreshJellyfinLibrary):
//   - the exact /Items queries: AnyProviderIdEquals=Tmdb.<id> for the
//     availability probe, and the paged library query (IncludeItemTypes,
//     ExcludeItemTypes=BoxSet, the full Fields list, StartIndex/Limit=5000)
//     whose drift would silently empty the library sync;
//   - MinDateLastSaved is appended ONLY when a date is passed — the recentOnly
//     window the sync orchestrator rides on;
//   - ProviderIds parsing: Tmdb with lowercase tmdb fallback, non-numeric
//     skipped, absent skipped, duplicate tmdb ids last-write-wins into the Map;
//   - paging: TotalRecordCount drives parallel page fan-out (StartIndex 0,
//     5000, 10000, …); library-scoped queries add ParentId per library;
//   - fetchPage retry: a 5xx retries (with the [jellyfin] retry warn), a
//     non-429 4xx fast-fails on the FIRST attempt (revoked API keys must not
//     hammer the server for ~12s per page);
//   - availability probe degrades to false on any failure; MediaFolders keeps
//     only movies/tvshows collections; /Library/Refresh throws with the
//     response body excerpt on failure.
//
//   Episodes (getJellyfinTVEpisodes, getJellyfinEpisodesForShow):
//   - series→episode mapping via SeriesId→tmdbId; unknown series, season 0
//     (specials), non-integer/negative indices all skipped; duplicates deduped;
//   - an empty series map short-circuits to [] with ZERO fetches;
//   - without a provided map the Series discovery query runs first;
//   - sequential episode paging advances StartIndex by items.length and stops
//     on a short page.
//
//   getJellyfinSessions (the 5s play-history poller's input):
//   - sessions without NowPlayingItem are dropped; the full field mapping the
//     poller consumes (ticks, device/client, RemoteEndPoint, ProviderIds,
//     episode title composition "Series — Name", resolution buckets);
//   - the playMethod decision table: TranscodingInfo is authoritative over
//     PlayState.PlayMethod, absent both → undefined (never a DirectPlay
//     default), transcodeReason only for Transcode with the humanized
//     PascalCase reasons (deduped) and the "Container not supported" fallback.
//
//   Admin surface (terminateJellyfinSession, getJellyfinAllUsers,
//   setJellyfinDownloadPolicy, getJellyfinUserCount):
//   - the elevated Authorization: MediaBrowser …, Token="…" header (newer
//     Jellyfin refuses X-MediaBrowser-Token alone for these);
//   - terminate: POST /Sessions/{id}/Playing/Stop returns {ok, status} without
//     throwing; a reason adds a best-effort DisplayMessage command (text capped
//     at 500 chars) whose failure must NOT affect the Stop;
//   - users: plain-array AND Jellyfin 10.9 QueryResult {Items} shapes, the
//     email @-gate, IsAdministrator===true, EnableContentDownloading only
//     explicitly-false disables (absent Policy = downloads enabled), and the
//     0-users warn;
//   - download policy: read-modify-write — GET /Users/{id} then POST the FULL
//     existing policy with only EnableContentDownloading overridden (posting a
//     partial policy would wipe every other permission bit).
//
// No DB (jellyfin.ts imports nothing but safe-fetch) and no network:
// globalThis.fetch is scripted per test. Base URLs are unique-per-test RFC1918
// IP LITERALS — safeFetchAdminConfigured runs allowPrivate=true and ssrf.ts
// short-circuits isIP() hosts past DNS entirely, so no dns.lookup stub is
// needed and the module-global dnsCache can never leak state between tests.
import { test, beforeEach } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";

// ── console capture ─────────────────────────────────────────────────────────
const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// ── scripted fetch ──────────────────────────────────────────────────────────
type SentRequest = { url: string; method: string; headers: Headers; body: string | null };
const sent: SentRequest[] = [];
let respond: (url: string) => Response | Promise<Response> = (url) => {
  throw new Error(`unexpected fetch ${url} — script a responder for this test`);
};

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  sent.push({
    url,
    method: init?.method ?? "GET",
    headers: new Headers(init?.headers),
    body: typeof init?.body === "string" ? init.body : null,
  });
  return respond(url);
}) as typeof fetch;

const okJson = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

// Dynamic import so the fetch/console stubs above genuinely precede the module
// graph (static imports would hoist above them — the established pattern).
const {
  authenticateWithJellyfin,
  initiateJellyfinQuickConnect,
  pollJellyfinQuickConnect,
  authenticateWithJellyfinQuickConnect,
  getJellyfinUserEmail,
  hasJellyfinItemByTmdbId,
  getJellyfinMediaFolders,
  refreshJellyfinLibrary,
  getJellyfinTmdbIds,
  getJellyfinTVEpisodes,
  getJellyfinEpisodesForShow,
  getJellyfinSessions,
  terminateJellyfinSession,
  getJellyfinAllUsers,
  setJellyfinDownloadPolicy,
  getJellyfinUserCount,
} = await import("../src/lib/jellyfin.ts");

// Unique RFC1918 IP-literal base per test: IP literals skip the SSRF DNS
// resolver entirely (isIP short-circuit) and are allowed under admin mode.
let ipCounter = 0;
function nextBase(): string {
  ipCounter++;
  return `http://10.99.${Math.floor(ipCounter / 200)}.${(ipCounter % 200) + 1}:8096`;
}

// Drain the microtask cascade behind a mocked-timer fire (retry test). Real
// setImmediate — never in the mocked apis list.
async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise<void>((r) => setImmediate(r));
}

const IDENTITY_HEADER =
  'MediaBrowser Client="Summonarr", Device="Summonarr", DeviceId="summonarr-server", Version="1.0"';
const adminAuthHeader = (apiKey: string) =>
  `MediaBrowser Client="Summonarr", Device="Summonarr", DeviceId="summonarr-server", Version="1.0", Token="${apiKey}"`;

beforeEach(() => {
  sent.length = 0;
  warns.length = 0;
  errors.length = 0;
  respond = (url) => {
    throw new Error(`unexpected fetch ${url} — script a responder for this test`);
  };
});

// ── authenticateWithJellyfin ────────────────────────────────────────────────

test("password auth POSTs /Users/AuthenticateByName with the MediaBrowser identity header and {Username, Pw} body; trailing base slash is stripped", async () => {
  const B = nextBase();
  respond = () => okJson({ User: { Id: "user-1", Name: "alice" }, AccessToken: "ignored" });

  const user = await authenticateWithJellyfin(`${B}/`, "alice", "hunter2");
  assert.deepEqual(user, { id: "user-1", name: "alice" });

  assert.equal(sent.length, 1);
  const req = sent[0];
  assert.equal(req.url, `${B}/Users/AuthenticateByName`, "the doubled-slash trap: trailing base slash must be stripped");
  assert.equal(req.method, "POST");
  assert.equal(req.headers.get("x-emby-authorization"), IDENTITY_HEADER);
  assert.equal(req.headers.get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(req.body!), { Username: "alice", Pw: "hunter2" });
});

test("password auth non-2xx throws with the status and logs with the [jellyfin auth] scope", async () => {
  const B = nextBase();
  respond = () => okJson({ error: "nope" }, 401);
  await assert.rejects(
    () => authenticateWithJellyfin(B, "alice", "wrong"),
    /Jellyfin auth failed: 401/,
  );
  assert.ok(
    errors.some((e) => e.includes(`[jellyfin auth] 401 from ${B}/Users/AuthenticateByName`)),
    "the failure must be logged with its scope and endpoint",
  );
});

test("password auth 2xx with a malformed body throws instead of minting a half-formed user", async () => {
  const B = nextBase();
  respond = () => okJson({ AccessToken: "t" }); // no User at all
  await assert.rejects(
    () => authenticateWithJellyfin(B, "a", "b"),
    /Jellyfin auth response missing User\.Id or User\.Name/,
  );

  respond = () => okJson({ User: { Id: 42, Name: "bob" } }); // non-string Id
  await assert.rejects(
    () => authenticateWithJellyfin(B, "a", "b"),
    /Jellyfin auth response missing User\.Id or User\.Name/,
  );
});

// ── QuickConnect trio ───────────────────────────────────────────────────────

test("QuickConnect initiate POSTs /QuickConnect/Initiate with the identity header and maps {Secret, Code}; non-2xx throws", async () => {
  const B = nextBase();
  respond = () => okJson({ Secret: "qc-secret-1", Code: "123456" });

  const result = await initiateJellyfinQuickConnect(B);
  assert.deepEqual(result, { secret: "qc-secret-1", code: "123456" });
  assert.equal(sent[0].url, `${B}/QuickConnect/Initiate`);
  assert.equal(sent[0].method, "POST");
  assert.equal(sent[0].headers.get("x-emby-authorization"), IDENTITY_HEADER);

  respond = () => okJson({}, 500);
  await assert.rejects(() => initiateJellyfinQuickConnect(B), /Jellyfin QuickConnect initiate: 500/);
});

test("QuickConnect poll GETs /QuickConnect/Connect with the encodeURIComponent'd secret and maps Authenticated true/false; non-2xx throws", async () => {
  const B = nextBase();
  respond = () => okJson({ Authenticated: false });
  assert.equal(await pollJellyfinQuickConnect(B, "a b+c/="), false);

  const req = sent[0];
  assert.equal(req.url, `${B}/QuickConnect/Connect?Secret=a%20b%2Bc%2F%3D`, "the secret must ride encodeURIComponent'd in the query");
  assert.equal(req.method, "GET");
  assert.equal(req.headers.get("x-emby-authorization"), IDENTITY_HEADER);

  respond = () => okJson({ Authenticated: true });
  assert.equal(await pollJellyfinQuickConnect(B, "s"), true);

  respond = () => okJson({}, 410);
  await assert.rejects(() => pollJellyfinQuickConnect(B, "s"), /Jellyfin QuickConnect poll: 410/);
});

test("QuickConnect exchange POSTs /Users/AuthenticateWithQuickConnect with a {Secret} body and maps the User; missing User throws", async () => {
  const B = nextBase();
  respond = () => okJson({ User: { Id: "u-9", Name: "carol" } });

  const user = await authenticateWithJellyfinQuickConnect(B, "qc-secret-2");
  assert.deepEqual(user, { id: "u-9", name: "carol" });
  const req = sent[0];
  assert.equal(req.url, `${B}/Users/AuthenticateWithQuickConnect`);
  assert.equal(req.method, "POST");
  assert.equal(req.headers.get("x-emby-authorization"), IDENTITY_HEADER);
  assert.deepEqual(JSON.parse(req.body!), { Secret: "qc-secret-2" });

  respond = () => okJson({}); // authenticated but no User payload
  await assert.rejects(
    () => authenticateWithJellyfinQuickConnect(B, "qc-secret-2"),
    /Jellyfin QuickConnect auth response missing User\.Id or User\.Name/,
  );
});

// ── getJellyfinUserEmail ────────────────────────────────────────────────────

test("user email GETs /Users/{id} (encoded) with X-MediaBrowser-Token and returns Email only when it contains '@'", async () => {
  const B = nextBase();
  respond = () => okJson({ Id: "u 1", Email: "alice@example.com" });
  assert.equal(await getJellyfinUserEmail(B, "key-1", "u 1"), "alice@example.com");

  const req = sent[0];
  assert.equal(req.url, `${B}/Users/u%201`, "the userId must be encodeURIComponent'd into the path");
  assert.equal(req.method, "GET");
  assert.equal(req.headers.get("x-mediabrowser-token"), "key-1");

  // The @-gate: a non-address string and an absent field both read as "no email".
  respond = () => okJson({ Email: "not-an-address" });
  assert.equal(await getJellyfinUserEmail(B, "key-1", "u1"), null);
  respond = () => okJson({});
  assert.equal(await getJellyfinUserEmail(B, "key-1", "u1"), null);
});

test("user email degrades to null on non-2xx and on a network failure (never throws)", async () => {
  const B = nextBase();
  respond = () => okJson({}, 404);
  assert.equal(await getJellyfinUserEmail(B, "key-1", "gone"), null);

  respond = () => { throw new Error("ECONNREFUSED"); };
  assert.equal(await getJellyfinUserEmail(B, "key-1", "u1"), null);
});

// ── hasJellyfinItemByTmdbId ─────────────────────────────────────────────────

test("availability probe queries /Items with AnyProviderIdEquals=Tmdb.<id>, the mapped item type, and Limit=1", async () => {
  const B = nextBase();
  respond = () => okJson({ Items: [{ Id: "m1" }], TotalRecordCount: 1 });
  assert.equal(await hasJellyfinItemByTmdbId(B, "key-2", 550, "movie"), true);
  assert.equal(
    sent[0].url,
    `${B}/Items?AnyProviderIdEquals=Tmdb.550&IncludeItemTypes=Movie&Recursive=true&Limit=1`,
  );
  assert.equal(sent[0].headers.get("x-mediabrowser-token"), "key-2");

  respond = () => okJson({ Items: [], TotalRecordCount: 0 });
  assert.equal(await hasJellyfinItemByTmdbId(B, "key-2", 1399, "tv"), false);
  assert.equal(
    sent[1].url,
    `${B}/Items?AnyProviderIdEquals=Tmdb.1399&IncludeItemTypes=Series&Recursive=true&Limit=1`,
    "tv must map to the Series item type",
  );
});

test("availability probe falls back to Items.length without TotalRecordCount and degrades to false on any failure", async () => {
  const B = nextBase();
  respond = () => okJson({ Items: [{ Id: "m1" }] }); // no TotalRecordCount
  assert.equal(await hasJellyfinItemByTmdbId(B, "k", 1, "movie"), true);

  respond = () => okJson({}); // neither field
  assert.equal(await hasJellyfinItemByTmdbId(B, "k", 1, "movie"), false);

  respond = () => okJson({}, 500);
  assert.equal(await hasJellyfinItemByTmdbId(B, "k", 1, "movie"), false, "non-2xx reads as not-available, never a throw");

  respond = () => { throw new Error("boom"); };
  assert.equal(await hasJellyfinItemByTmdbId(B, "k", 1, "movie"), false, "a network failure reads as not-available");
});

// ── getJellyfinMediaFolders / refreshJellyfinLibrary ────────────────────────

test("media folders keeps only movies/tvshows collections and maps {id, name, collectionType}; non-2xx throws", async () => {
  const B = nextBase();
  respond = () => okJson({
    Items: [
      { Id: "lib1", Name: "Movies", CollectionType: "movies" },
      { Id: "lib2", Name: "Shows", CollectionType: "tvshows" },
      { Id: "lib3", Name: "Music", CollectionType: "music" },
      { Id: "lib4", Name: "Mixed" }, // no CollectionType
    ],
  });
  const folders = await getJellyfinMediaFolders(B, "key-3");
  assert.deepEqual(folders, [
    { id: "lib1", name: "Movies", collectionType: "movies" },
    { id: "lib2", name: "Shows", collectionType: "tvshows" },
  ]);
  assert.equal(sent[0].url, `${B}/Library/MediaFolders`);

  respond = () => okJson({}, 503);
  await assert.rejects(() => getJellyfinMediaFolders(B, "key-3"), /Jellyfin MediaFolders: 503/);
});

test("library refresh POSTs /Library/Refresh; a failure throws with the status and a body excerpt", async () => {
  const B = nextBase();
  respond = () => new Response(null, { status: 204 });
  await refreshJellyfinLibrary(B, "key-4"); // must resolve
  assert.equal(sent[0].url, `${B}/Library/Refresh`);
  assert.equal(sent[0].method, "POST");
  assert.equal(sent[0].headers.get("x-mediabrowser-token"), "key-4");

  respond = () => new Response("scan already running", { status: 503 });
  await assert.rejects(
    () => refreshJellyfinLibrary(B, "key-4"),
    /Jellyfin \/Library\/Refresh status=503 body=scan already running/,
  );
});

// ── getJellyfinTmdbIds (library sync) ───────────────────────────────────────

test("library query pins the exact /Items wire shape (Fields list, BoxSet exclusion, 5000 page) and maps every item field", async () => {
  const B = nextBase();
  respond = () => okJson({
    Items: [{
      Id: "it-1",
      ProviderIds: { Tmdb: "550", Imdb: "tt0137523" },
      Path: "/movies/Fight Club (1999)/fc.mkv",
      Name: "Fight Club",
      ProductionYear: 1999,
      Overview: "An insomniac office worker…",
      OfficialRating: "R",
      CommunityRating: 8.8,
      DateCreated: "2024-05-01T12:00:00.000Z",
    }],
    TotalRecordCount: 1,
  });

  const items = await getJellyfinTmdbIds(B, "key-5", "MOVIE");
  assert.equal(sent.length, 1);
  assert.equal(
    sent[0].url,
    `${B}/Items?IncludeItemTypes=Movie&ExcludeItemTypes=BoxSet&Recursive=true&Fields=ProviderIds,Path,Name,ProductionYear,Overview,OfficialRating,CommunityRating,DateCreated&StartIndex=0&Limit=5000`,
    "the library sync's exact query — a drift here silently empties the sync",
  );
  assert.deepEqual(items.get(550), {
    filePath: "/movies/Fight Club (1999)/fc.mkv",
    itemId: "it-1",
    title: "Fight Club",
    year: "1999", // stringified
    overview: "An insomniac office worker…",
    contentRating: "R",
    communityRating: 8.8,
    addedAt: new Date("2024-05-01T12:00:00.000Z"),
  });

  // TV maps to the Series item type on the same query shape.
  respond = () => okJson({ Items: [], TotalRecordCount: 0 });
  await getJellyfinTmdbIds(B, "key-5", "TV");
  assert.ok(sent[1].url.includes("IncludeItemTypes=Series"), "TV must query Series");
});

test("ProviderIds parsing: lowercase tmdb fallback, non-numeric skipped, absent skipped, duplicate ids last-write-wins, missing fields null", async () => {
  const B = nextBase();
  respond = () => okJson({
    Items: [
      { Id: "a", ProviderIds: { tmdb: "603" } },              // lowercase fallback
      { Id: "b", ProviderIds: { Tmdb: "abc" } },              // non-numeric → skipped
      { Id: "c", Name: "No Providers" },                      // no ProviderIds → skipped
      { Id: "d", ProviderIds: { Tmdb: "77" }, Name: "First" },
      { Id: "e", ProviderIds: { Tmdb: "77" }, Name: "Second" }, // same id → overwrites
    ],
    TotalRecordCount: 5,
  });

  const items = await getJellyfinTmdbIds(B, "k", "MOVIE");
  assert.deepEqual([...items.keys()].sort((x, y) => x - y), [77, 603]);
  assert.equal(items.get(77)!.title, "Second", "a duplicate tmdb id must last-write-win into the map");
  // The minimal lowercase-fallback item: every optional field degrades to null.
  assert.deepEqual(items.get(603), {
    filePath: null,
    itemId: "a",
    title: null,
    year: null,
    overview: null,
    contentRating: null,
    communityRating: null,
    addedAt: null,
  });
});

test("recentOnly: minDateLastSaved rides the query as MinDateLastSaved, and is absent otherwise", async () => {
  const B = nextBase();
  respond = () => okJson({ Items: [], TotalRecordCount: 0 });

  await getJellyfinTmdbIds(B, "k", "MOVIE", undefined, new Date("2026-02-03T04:05:06.000Z"));
  const withDate = new URL(sent[0].url);
  assert.equal(withDate.searchParams.get("MinDateLastSaved"), "2026-02-03T04:05:06.000Z");

  await getJellyfinTmdbIds(B, "k", "MOVIE");
  const withoutDate = new URL(sent[1].url);
  assert.equal(withoutDate.searchParams.get("MinDateLastSaved"), null, "a full sync must not carry the window filter");
});

test("paging: TotalRecordCount fans out parallel pages at 5000-item StartIndex steps and merges every page into one map", async () => {
  const B = nextBase();
  respond = (url) => {
    const start = new URL(url).searchParams.get("StartIndex");
    if (start === "0") return okJson({ Items: [{ Id: "p0", ProviderIds: { Tmdb: "1" } }], TotalRecordCount: 10_001 });
    if (start === "5000") return okJson({ Items: [{ Id: "p1", ProviderIds: { Tmdb: "2" } }], TotalRecordCount: 10_001 });
    if (start === "10000") return okJson({ Items: [{ Id: "p2", ProviderIds: { Tmdb: "3" } }], TotalRecordCount: 10_001 });
    throw new Error(`unexpected StartIndex in ${url}`);
  };

  const items = await getJellyfinTmdbIds(B, "k", "MOVIE");
  const starts = sent.map((s) => new URL(s.url).searchParams.get("StartIndex")).sort();
  assert.deepEqual(starts, ["0", "10000", "5000"], "three pages for a 10001-item library");
  assert.deepEqual([...items.keys()].sort((x, y) => x - y), [1, 2, 3]);
});

test("library scoping: each libraryId becomes a ParentId-scoped query and the per-library results merge", async () => {
  const B = nextBase();
  respond = (url) => {
    const parent = new URL(url).searchParams.get("ParentId");
    if (parent === "libA") return okJson({ Items: [{ Id: "a1", ProviderIds: { Tmdb: "11" } }], TotalRecordCount: 1 });
    if (parent === "libB") return okJson({ Items: [{ Id: "b1", ProviderIds: { Tmdb: "22" } }], TotalRecordCount: 1 });
    throw new Error(`unexpected ParentId in ${url}`);
  };

  const items = await getJellyfinTmdbIds(B, "k", "MOVIE", new Set(["libA", "libB"]));
  assert.equal(sent.length, 2, "one query per scoped library");
  for (const req of sent) {
    assert.ok(req.url.includes("IncludeItemTypes=Movie") && req.url.includes("ExcludeItemTypes=BoxSet"));
  }
  assert.deepEqual([...items.keys()].sort((x, y) => x - y), [11, 22]);
});

// ── fetchPage retry / fast-fail (via getJellyfinTmdbIds) ────────────────────

test("a 5xx page retries after the backoff (with the [jellyfin] retry warn) and the retried page's items survive", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const B = nextBase();
  let calls = 0;
  respond = () => {
    calls++;
    if (calls === 1) return okJson({ error: "transient" }, 500);
    return okJson({ Items: [{ Id: "r1", ProviderIds: { Tmdb: "9" } }], TotalRecordCount: 1 });
  };

  const p = getJellyfinTmdbIds(B, "k", "MOVIE");
  await flush();
  assert.equal(sent.length, 1, "the first attempt has failed; the retry is parked behind its backoff");

  t.mock.timers.tick(2_000); // PAGE_RETRY_DELAY_MS * attempt 1
  const items = await p;
  assert.equal(sent.length, 2);
  assert.ok(warns.some((w) => w.includes("[jellyfin] retry 1/3 for StartIndex=0")), "each retry must warn with its scope");
  assert.deepEqual([...items.keys()], [9]);
});

test("a non-429 4xx fast-fails on the first attempt (no retries) and the whole call rejects", async () => {
  const B = nextBase();
  respond = () => okJson({ error: "revoked key" }, 401);
  await assert.rejects(
    () => getJellyfinTmdbIds(B, "revoked", "MOVIE"),
    /Jellyfin fetch failed: 401 at StartIndex=0/,
  );
  assert.equal(sent.length, 1, "a 401 can never succeed on retry — it must not hammer the server");
});

// ── getJellyfinTVEpisodes / getJellyfinEpisodesForShow ──────────────────────

test("episodes with a provided series map: exact fields query, SeriesId→tmdbId mapping, specials/invalid indices skipped, duplicates deduped", async () => {
  const B = nextBase();
  respond = () => okJson({
    Items: [
      { SeriesId: "ser-1", ParentIndexNumber: 1, IndexNumber: 1 },
      { SeriesId: "ser-1", ParentIndexNumber: 1, IndexNumber: 1 },   // duplicate → deduped
      { SeriesId: "ser-2", ParentIndexNumber: 2, IndexNumber: 3 },
      { SeriesId: "ser-x", ParentIndexNumber: 1, IndexNumber: 1 },   // unknown series → skipped
      { ParentIndexNumber: 1, IndexNumber: 1 },                       // no SeriesId → skipped
      { SeriesId: "ser-1", ParentIndexNumber: 0, IndexNumber: 5 },   // season 0 specials → skipped
      { SeriesId: "ser-1", ParentIndexNumber: 1 },                    // no IndexNumber → skipped
      { SeriesId: "ser-1", ParentIndexNumber: 1.5, IndexNumber: 2 }, // non-integer → skipped
      { SeriesId: "ser-1", ParentIndexNumber: 2, IndexNumber: -1 },  // negative → skipped
    ],
    TotalRecordCount: 9,
  });

  const seriesMap = new Map([["ser-1", 100], ["ser-2", 200]]);
  const episodes = await getJellyfinTVEpisodes(B, "k", undefined, seriesMap);
  assert.equal(
    sent[0].url,
    `${B}/Items?IncludeItemTypes=Episode&Recursive=true&Fields=SeriesId,ParentIndexNumber,IndexNumber&StartIndex=0&Limit=1000`,
  );
  assert.deepEqual(
    episodes.sort((a, b) => a.tmdbId - b.tmdbId),
    [
      { tmdbId: 100, seasonNumber: 1, episodeNumber: 1 },
      { tmdbId: 200, seasonNumber: 2, episodeNumber: 3 },
    ],
  );

  // An EMPTY series map short-circuits: no episode fetch at all.
  sent.length = 0;
  assert.deepEqual(await getJellyfinTVEpisodes(B, "k", undefined, new Map()), []);
  assert.equal(sent.length, 0, "no series ⇒ no episode query");
});

test("episodes without a provided map discover the Series set first, then map episodes through it (series lacking Id or tmdb drop out)", async () => {
  const B = nextBase();
  respond = (url) => {
    if (url.includes("IncludeItemTypes=Series")) {
      return okJson({
        Items: [
          { Id: "ser-1", ProviderIds: { Tmdb: "1399" } },
          { ProviderIds: { Tmdb: "9" } }, // no Id → can't anchor episodes
          { Id: "ser-3", Name: "No tmdb" }, // no provider id → not in the map
        ],
        TotalRecordCount: 3,
      });
    }
    if (url.includes("IncludeItemTypes=Episode")) {
      return okJson({
        Items: [
          { SeriesId: "ser-1", ParentIndexNumber: 1, IndexNumber: 2 },
          { SeriesId: "ser-3", ParentIndexNumber: 1, IndexNumber: 1 }, // unmapped series → dropped
        ],
        TotalRecordCount: 2,
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const episodes = await getJellyfinTVEpisodes(B, "k");
  assert.ok(sent[0].url.includes("IncludeItemTypes=Series"), "series discovery runs first");
  assert.deepEqual(episodes, [{ tmdbId: 1399, seasonNumber: 1, episodeNumber: 2 }]);
});

test("sequential episode paging advances StartIndex by items served and stops on a short page", async () => {
  const B = nextBase();
  const page = (start: number, count: number) =>
    Array.from({ length: count }, (_, i) => ({ SeriesId: "ser-1", ParentIndexNumber: 1, IndexNumber: start + i + 1 }));
  respond = (url) => {
    const start = new URL(url).searchParams.get("StartIndex");
    if (start === "0") return okJson({ Items: page(0, 1000), TotalRecordCount: 1500 });
    if (start === "1000") return okJson({ Items: page(1000, 500), TotalRecordCount: 1500 });
    throw new Error(`unexpected StartIndex in ${url}`);
  };

  const episodes = await getJellyfinTVEpisodes(B, "k", undefined, new Map([["ser-1", 42]]));
  assert.deepEqual(
    sent.map((s) => new URL(s.url).searchParams.get("StartIndex")),
    ["0", "1000"],
    "episode pages are sequential 1000-item steps; the short page ends the loop",
  );
  assert.equal(episodes.length, 1500);
});

test("episodes-for-show scopes to ParentId=<seriesId>, stamps the caller's tmdbId, and drops invalid indices", async () => {
  const B = nextBase();
  respond = () => okJson({
    Items: [
      { ParentIndexNumber: 1, IndexNumber: 1 },
      { ParentIndexNumber: 0, IndexNumber: 2 },  // specials → skipped
      { ParentIndexNumber: 3, IndexNumber: 7 },
      { IndexNumber: 4 },                        // no season → skipped
    ],
    TotalRecordCount: 4,
  });

  const episodes = await getJellyfinEpisodesForShow(B, "k", "ser-77", 4242);
  assert.equal(
    sent[0].url,
    `${B}/Items?ParentId=ser-77&IncludeItemTypes=Episode&Recursive=true&Fields=ParentIndexNumber,IndexNumber&StartIndex=0&Limit=1000`,
  );
  assert.deepEqual(episodes, [
    { tmdbId: 4242, seasonNumber: 1, episodeNumber: 1 },
    { tmdbId: 4242, seasonNumber: 3, episodeNumber: 7 },
  ]);
});

// ── getJellyfinSessions ─────────────────────────────────────────────────────

test("sessions: idle sessions (no NowPlayingItem) are dropped and a transcoding episode maps every field the poller consumes", async () => {
  const B = nextBase();
  respond = () => okJson([
    { Id: "idle-1", UserName: "nobody" }, // no NowPlayingItem → dropped
    {
      Id: "sess-1",
      PlaySessionId: "play-1",
      UserId: "u1",
      UserName: "alice",
      Client: "Jellyfin Web",
      DeviceName: "Chrome",
      DeviceId: "dev-1",
      RemoteEndPoint: "203.0.113.9",
      NowPlayingItem: {
        Id: "ep-1", Name: "Pilot", SeriesId: "ser-1", SeriesName: "Severance",
        ParentIndexNumber: 1, IndexNumber: 2, Type: "Episode", ProductionYear: 2022,
        RunTimeTicks: 36_000_000_000,
        ProviderIds: { Tmdb: "95396" },
        Container: "mkv",
        MediaStreams: [
          { Type: "Video", Codec: "hevc", BitRate: 25_000_000, Width: 3840, Height: 2160 },
          { Type: "Audio", Codec: "truehd" },
        ],
      },
      PlayState: { PositionTicks: 12_000_000_000, IsPaused: true, PlayMethod: "Transcode" },
      TranscodingInfo: {
        VideoCodec: "h264", AudioCodec: "aac", Bitrate: 8_000_000, Container: "ts",
        IsVideoDirect: false, IsAudioDirect: true,
        // duplicate reason must dedup after humanization
        TranscodeReasons: ["VideoCodecNotSupported", "AudioCodecNotSupported", "VideoCodecNotSupported"],
      },
    },
  ]);

  const sessions = await getJellyfinSessions(B, "key-6");
  assert.equal(sent[0].url, `${B}/Sessions`);
  assert.equal(sessions.length, 1, "idle sessions must be filtered out");
  assert.deepEqual(sessions[0], {
    sessionId: "sess-1",
    playSessionId: "play-1",
    state: "paused",
    userId: "u1",
    userName: "alice",
    itemId: "ep-1",
    title: "Severance — Pilot", // episode title composition
    seriesId: "ser-1",
    seriesName: "Severance",
    seasonNumber: 1,
    episodeNumber: 2,
    itemType: "Episode",
    year: 2022,
    durationTicks: 36_000_000_000,
    positionTicks: 12_000_000_000,
    providerIds: { Tmdb: "95396" },
    playMethod: "Transcode",
    client: "Jellyfin Web",
    deviceName: "Chrome",
    deviceId: "dev-1",
    remoteEndPoint: "203.0.113.9",
    videoCodec: "h264",   // TranscodingInfo wins over the source stream
    audioCodec: "aac",
    resolution: "4K",     // 2160-high source stream
    container: "ts",      // TranscodingInfo wins over NowPlayingItem.Container
    bitrate: 8_000_000,   // TranscodingInfo wins over the stream BitRate
    transcodeReason: "Video codec not supported, Audio codec not supported",
  });
});

test("sessions playMethod table: TranscodingInfo is authoritative, absent info never defaults to DirectPlay, reason only for Transcode", async () => {
  const B = nextBase();
  const s = (id: string, extra: Record<string, unknown>) => ({
    Id: id, UserId: "u", UserName: "u",
    NowPlayingItem: { Id: `${id}-item`, Name: "Thing", Type: "Movie" },
    ...extra,
  });
  respond = () => okJson([
    s("s1", { PlayState: { PlayMethod: "DirectPlay" } }),
    s("s2", {}), // no PlayState, no TranscodingInfo
    s("s3", { PlayState: { PlayMethod: "DirectPlay" }, TranscodingInfo: { IsVideoDirect: true, IsAudioDirect: true } }),
    s("s4", { TranscodingInfo: { IsVideoDirect: true, IsAudioDirect: true } }),
    s("s5", { PlayState: { PlayMethod: "DirectPlay" }, TranscodingInfo: { IsVideoDirect: true, IsAudioDirect: false } }),
  ]);

  const sessions = await getJellyfinSessions(B, "k");
  const byId = new Map(sessions.map((x) => [x.sessionId, x]));
  assert.equal(byId.get("s1")!.playMethod, "DirectPlay", "PlayState is trusted when there is no TranscodingInfo");
  assert.equal(byId.get("s2")!.playMethod, undefined, "absent everywhere must stay unknown — never a DirectPlay default");
  assert.equal(byId.get("s3")!.playMethod, "DirectPlay", "fully-direct transcode info preserves a DirectPlay claim");
  assert.equal(byId.get("s4")!.playMethod, "DirectStream", "fully-direct with no DirectPlay claim is DirectStream");
  assert.equal(byId.get("s5")!.playMethod, "Transcode", "any non-direct leg overrides a stale DirectPlay claim");
  assert.equal(byId.get("s5")!.transcodeReason, "Container not supported", "no TranscodeReasons ⇒ the fallback reason");
  assert.equal(byId.get("s3")!.transcodeReason, undefined, "reason only accompanies Transcode");
  assert.equal(byId.get("s2")!.state, "playing", "not-paused (absent IsPaused) reads as playing");
});

test("sessions fallbacks: movie title, playSessionId←Id, stream-derived codecs/resolution buckets, defaults; non-2xx throws", async () => {
  const B = nextBase();
  respond = () => okJson([
    {
      Id: "m-1", UserId: "u", UserName: "u",
      NowPlayingItem: {
        Id: "mv-1", Name: "Heat", Type: "Movie", Container: "mp4",
        RunTimeTicks: 10, MediaStreams: [
          { Type: "Video", Codec: "h264", BitRate: 4_000_000, Height: 1080 },
          { Type: "Audio", Codec: "ac3" },
        ],
      },
      PlayState: { PositionTicks: 5, IsPaused: false },
    },
    {
      Id: "m-2", UserId: "u", UserName: "u",
      NowPlayingItem: { Id: "mv-2", MediaStreams: [{ Type: "Video", Codec: "vp9", Height: 720 }] },
    },
    {
      Id: "m-3", UserId: "u", UserName: "u",
      NowPlayingItem: { Id: "mv-3", MediaStreams: [{ Type: "Video", Codec: "mpeg2", Height: 468 }] },
    },
  ]);

  const [a, b, c] = await getJellyfinSessions(B, "k");
  assert.equal(a.title, "Heat", "a movie title is the bare Name");
  assert.equal(a.playSessionId, "m-1", "no PlaySessionId falls back to the session Id");
  assert.equal(a.state, "playing");
  assert.equal(a.videoCodec, "h264", "no TranscodingInfo ⇒ source-stream codec");
  assert.equal(a.audioCodec, "ac3");
  assert.equal(a.resolution, "1080p");
  assert.equal(a.container, "mp4", "no TranscodingInfo ⇒ NowPlayingItem container");
  assert.equal(a.bitrate, 4_000_000);
  assert.equal(a.transcodeReason, undefined);

  assert.equal(b.title, "", "absent Name degrades to an empty title");
  assert.equal(b.itemType, "Movie", "absent Type defaults to Movie");
  assert.equal(b.durationTicks, 0);
  assert.equal(b.positionTicks, 0);
  assert.equal(b.resolution, "720p");
  assert.equal(c.resolution, "468p", "odd heights render literally");

  respond = () => okJson([], 500);
  await assert.rejects(() => getJellyfinSessions(B, "k"), /Jellyfin sessions: 500/);
});

// ── terminateJellyfinSession ────────────────────────────────────────────────

test("terminate without a reason issues exactly one elevated POST to /Sessions/{id}/Playing/Stop and returns {ok, status}", async () => {
  const B = nextBase();
  respond = () => new Response(null, { status: 204 });

  const result = await terminateJellyfinSession(B, "key-7", "sess/1"); // id needs encoding
  assert.deepEqual(result, { ok: true, status: 204 });
  assert.equal(sent.length, 1, "no reason ⇒ no DisplayMessage command");
  assert.equal(sent[0].url, `${B}/Sessions/sess%2F1/Playing/Stop`);
  assert.equal(sent[0].method, "POST");
  assert.equal(sent[0].headers.get("authorization"), adminAuthHeader("key-7"), "session control requires the elevated MediaBrowser Token header");
  assert.equal(sent[0].headers.get("x-mediabrowser-token"), "key-7");
});

test("terminate with a reason fires a best-effort DisplayMessage (text capped at 500) whose failure cannot affect the Stop", async () => {
  const B = nextBase();
  respond = (url) => {
    if (url.endsWith("/Command")) throw new Error("client never acked"); // the command fails hard
    return new Response(null, { status: 204 });
  };

  const longReason = "x".repeat(600);
  const result = await terminateJellyfinSession(B, "key-8", "sess-2", longReason);
  assert.deepEqual(result, { ok: true, status: 204 }, "a dead DisplayMessage must not break the Stop");
  await flush(); // let the floating command promise settle its catch

  const cmd = sent.find((r) => r.url === `${B}/Sessions/sess-2/Command`);
  assert.ok(cmd, "the reason rides a Sessions/{id}/Command call");
  assert.equal(cmd.method, "POST");
  assert.deepEqual(JSON.parse(cmd.body!), {
    Name: "DisplayMessage",
    Arguments: { Header: "Playback stopped", Text: "x".repeat(500), TimeoutMs: 5000 },
  });
  assert.ok(sent.some((r) => r.url === `${B}/Sessions/sess-2/Playing/Stop`), "the Stop still went out");
});

test("terminate: a whitespace-only reason skips the command, and a failed Stop reports {ok: false} without throwing", async () => {
  const B = nextBase();
  respond = () => new Response("no such session", { status: 404 });

  const result = await terminateJellyfinSession(B, "k", "gone", "   ");
  assert.deepEqual(result, { ok: false, status: 404 });
  assert.equal(sent.length, 1, "blank reasons must not fire a DisplayMessage");
  assert.ok(sent[0].url.endsWith("/Sessions/gone/Playing/Stop"));
});

// ── getJellyfinAllUsers / getJellyfinUserCount ──────────────────────────────

test("all users (plain array): elevated header, email @-gate, IsAdministrator===true, only explicit false disables downloads, rows missing Id/Name dropped", async () => {
  const B = nextBase();
  respond = () => okJson([
    { Id: "u1", Name: "alice", Email: "alice@example.com", Policy: { IsAdministrator: true, EnableContentDownloading: true } },
    { Id: "u2", Name: "bob", Email: "not-an-email", Policy: { IsAdministrator: false, EnableContentDownloading: false } },
    { Id: "u3", Name: "carol" },      // no Policy at all → Jellyfin defaults
    { Name: "no-id" },                // dropped
    { Id: "no-name" },                // dropped
  ]);

  const users = await getJellyfinAllUsers(B, "key-9");
  assert.equal(sent[0].url, `${B}/Users`);
  assert.equal(sent[0].headers.get("authorization"), adminAuthHeader("key-9"), "GET /Users requires elevation — the token header alone is not enough");
  assert.deepEqual(users, [
    { id: "u1", name: "alice", email: "alice@example.com", isAdmin: true, downloadsEnabled: true },
    { id: "u2", name: "bob", email: undefined, isAdmin: false, downloadsEnabled: false },
    { id: "u3", name: "carol", email: undefined, isAdmin: false, downloadsEnabled: true },
  ]);
  assert.equal(warns.length, 0);
});

test("all users: the Jellyfin 10.9 QueryResult {Items} wrapper parses too; zero users warns; non-2xx throws", async () => {
  const B = nextBase();
  respond = () => okJson({ Items: [{ Id: "u1", Name: "dave", Policy: {} }] });
  const users = await getJellyfinAllUsers(B, "k");
  assert.deepEqual(users, [{ id: "u1", name: "dave", email: undefined, isAdmin: false, downloadsEnabled: true }]);

  respond = () => okJson([]);
  assert.deepEqual(await getJellyfinAllUsers(B, "k"), []);
  assert.ok(
    warns.some((w) => w.includes("[jellyfin] getJellyfinAllUsers returned 0 users")),
    "an empty user list is a key-permission red flag and must warn",
  );

  respond = () => okJson({}, 401);
  await assert.rejects(() => getJellyfinAllUsers(B, "k"), /Jellyfin users: 401/);
});

test("user count handles the plain array, the {Items} wrapper, a malformed wrapper (0), and throws on non-2xx", async () => {
  const B = nextBase();
  respond = () => okJson([{ Id: "a" }, { Id: "b" }, { Id: "c" }]);
  assert.equal(await getJellyfinUserCount(B, "k"), 3);
  assert.equal(sent[0].url, `${B}/Users`);
  assert.equal(sent[0].headers.get("authorization"), adminAuthHeader("k"));

  respond = () => okJson({ Items: [{ Id: "a" }] });
  assert.equal(await getJellyfinUserCount(B, "k"), 1);

  respond = () => okJson({ Items: "corrupt" });
  assert.equal(await getJellyfinUserCount(B, "k"), 0);

  respond = () => okJson({}, 500);
  await assert.rejects(() => getJellyfinUserCount(B, "k"), /Jellyfin users: 500/);
});

// ── setJellyfinDownloadPolicy ───────────────────────────────────────────────

test("download policy is read-modify-write: GET /Users/{id}, then POST the FULL existing policy with only EnableContentDownloading changed", async () => {
  const B = nextBase();
  respond = (url) => {
    if (url === `${B}/Users/user%201`) {
      return okJson({ Id: "user 1", Policy: { IsAdministrator: false, EnableContentDownloading: true, RemoteClientBitrateLimit: 20 } });
    }
    if (url === `${B}/Users/user%201/Policy`) return new Response(null, { status: 204 });
    throw new Error(`unexpected fetch ${url}`);
  };

  await setJellyfinDownloadPolicy(B, "key-10", "user 1", false);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].method, "GET");
  assert.equal(sent[1].method, "POST");
  assert.equal(sent[1].url, `${B}/Users/user%201/Policy`);
  assert.equal(sent[1].headers.get("authorization"), adminAuthHeader("key-10"));
  assert.deepEqual(
    JSON.parse(sent[1].body!),
    { IsAdministrator: false, RemoteClientBitrateLimit: 20, EnableContentDownloading: false },
    "every other policy bit must survive the write — a partial policy POST would wipe user permissions",
  );
});

test("download policy failure contracts: a failed user read throws before any POST; a failed policy POST throws; a missing Policy still writes the flag", async () => {
  const B = nextBase();
  respond = () => okJson({}, 404);
  await assert.rejects(() => setJellyfinDownloadPolicy(B, "k", "ghost", true), /Jellyfin fetch user ghost: 404/);
  assert.equal(sent.length, 1, "a failed read must never be followed by a blind policy write");

  sent.length = 0;
  respond = (url) => {
    if (url.endsWith("/Policy")) return okJson({}, 400);
    return okJson({ Id: "u1" }); // user exists but exposes no Policy object
  };
  await assert.rejects(() => setJellyfinDownloadPolicy(B, "k", "u1", true), /Jellyfin set policy u1: 400/);
  assert.deepEqual(
    JSON.parse(sent[1].body!),
    { EnableContentDownloading: true },
    "an absent Policy degrades to writing just the download flag",
  );
});
