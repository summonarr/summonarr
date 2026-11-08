// Unit tests for the Plex API client (src/lib/plex.ts and its plex-*.ts
// siblings) — the HTTP layer between
// Summonarr and both plex.tv (account surface, via safeFetchTrusted) and the
// admin-configured Plex Media Server (library/session/terminate surface, via
// safeFetchAdminConfigured). The contracts pinned here:
//   - extractTmdbIdFromGuids: first parseable tmdb:// guid wins; imdb/tvdb
//     entries, malformed values, and absent/empty arrays yield null;
//   - pingPlexToken/getPlexUser: the exact plex.tv URLs + X-Plex header set
//     (default client id "summonarr-server" vs per-caller override), numeric →
//     string id coercion, the username fallback chain, and the degradation
//     split (getPlexUser throws, ping never does);
//   - getPlexLibrarySections: movie/show filter (music/photo sections dropped);
//   - getPlexSectionTmdbIds/getPlexTmdbIds: the paginated /all | /recentlyAdded
//     wire shape (type=, includeGuids=1, X-Plex-Container-* pins), the
//     PlexLibraryItemData field mapping (null defaults; addedAt epoch-s → Date),
//     legacy single-guid agents, multi-guid items sharing one entry, collection
//     skip, totalSize paging, and the "no totalSize ⇒ page until an empty page"
//     anti-truncation rule the inline comment declares load-bearing; show
//     sections send no per-show request and leave filePath null (the sync reads
//     show paths from the type=4 episode walk); multi-section combine is
//     first-seen-wins and selectedKeys narrows the fan-out;
//   - getPlexTVEpisodes/getPlexEpisodesForShow: season/episode mapping with the
//     specials/zero/non-integer filters and per-key dedup; shows without a tmdb
//     guid contribute nothing, and an all-unresolvable section skips the
//     episode page entirely;
//   - getPlexSessions: the EXACT PlexSessionData shape the play-history poller
//     consumes (full deepEqual), episode title composition, the DirectPlay/
//     DirectStream/Transcode decision + the stream-only transcodeReason, "0"/"1"/
//     boolean secure-relayed normalization, friendly device naming, and
//     empty-session defaults;
//   - getPlexMarkers: split credits markers merge earliest-start/latest-end;
//     every failure degrades to {};
//   - terminatePlexSession: the exact terminate URL (sessionId= is the
//     Session.id GUID; reason= URL-encoded) and the {ok,status} no-throw shape;
//   - hasPlexItemByTmdbId: the guid=tmdb:// server-side filter with a one-item
//     container, totalSize→size→0 counting, trailing-slash base normalization,
//     and never-throws degradation (broken sections skipped; a failed section
//     listing reads as "not present");
//   - getPlexAccountsDetailed/getPlexMachineId/getPlexFriendEmails: DIRECT-call
//     contracts only — owner-first ordering, XML attribute parsing with
//     lowercased emails, per-hop warn-and-continue degradation, the machineId
//     null contract, the no-serverUrl refusal, and the non-2xx THROW from
//     getPlexFriendEmails. The caller-side swallow/cache/allowlist behavior is
//     pinned in tests/plex-membership.test.mts — kept complementary here, not
//     duplicated. refreshPlexSection is likewise skipped: library-scan.test.mts
//     already pins it through its only caller.
//
// No DB (the plex-*.ts client loads no prisma module) and no
// network/DNS: globalThis.fetch is scripted per URL and dns/promises.lookup is
// stubbed to a PUBLIC address (plex.tv goes through safeFetchTrusted, which
// rejects private answers; the admin-configured server host accepts public
// too). Server URLs use a unique fake hostname per test — the SSRF dnsCache in
// ssrf.ts is module-global, so hostname reuse across tests would serve a cached
// entry instead of exercising the stub.
import { test, beforeEach } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
// Type-only: erased at runtime, so the module graph still loads AFTER the stubs.
import type { PlexLegacyGuidRef } from "../src/lib/plex.ts";

// ── DNS stub (see tests/trakt.test.mts for the rationale) ───────────────────
const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) {
  throw new Error("could not stub dns.lookup — aborting before a real DNS query can leave the process");
}

// ── console capture ─────────────────────────────────────────────────────────
const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// ── scripted fetch ──────────────────────────────────────────────────────────
// safe-fetch hands us the fully-resolved target URL; capture it raw (for exact
// wire pins) and parsed (for param-based routing in paginated responders).
type FetchCall = { raw: string; url: URL; method: string; headers: Headers };
const fetchCalls: FetchCall[] = [];
let respond: (url: URL) => Response | Promise<Response> = (url) => {
  throw new Error(`unexpected fetch ${url} — script a responder for this test`);
};

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const raw = String(input);
  const url = new URL(raw);
  fetchCalls.push({ raw, url, method: init?.method ?? "GET", headers: new Headers(init?.headers) });
  return respond(url);
}) as typeof fetch;

const okJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const mediaContainer = (metadata: unknown[], extra: Record<string, unknown> = {}) =>
  okJson({ MediaContainer: { Metadata: metadata, ...extra } });
const xmlResponse = (xml: string) =>
  new Response(xml, { status: 200, headers: { "content-type": "application/xml" } });

beforeEach(() => {
  fetchCalls.length = 0;
  warns.length = 0;
  errors.length = 0;
  respond = (url) => {
    throw new Error(`unexpected fetch ${url} — script a responder for this test`);
  };
});

// Drain the microtask cascade behind a mocked-timer fire (retry tests). Real
// setImmediate — never in the mocked apis list. (Same helper as jellyfin's.)
async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise<void>((r) => setImmediate(r));
}

// Dynamic import so the stubs above genuinely precede the module-graph load
// (static imports would hoist above them).
const {
  PLEX_CLIENT_ID,
  pingPlexToken,
  checkPlexToken,
  getPlexUser,
  getPlexLibrarySections,
  getPlexSectionTmdbIds,
  getPlexTmdbIds,
  getPlexTVEpisodes,
  getPlexEpisodesForShow,
  getPlexSessions,
  getPlexMarkers,
  terminatePlexSession,
  hasPlexItemByTmdbId,
  extractTmdbIdFromGuids,
  getPlexAccountsDetailed,
  countPlexServerMembers,
  parseTmdbGuid,
  getPlexMachineId,
  getPlexFriendEmails,
  listPlexMatchEntries,
} = await import("../src/lib/plex.ts");

// ── extractTmdbIdFromGuids (pure) ───────────────────────────────────────────

test("extractTmdbIdFromGuids: absent, empty, and foreign-provider-only guid arrays all yield null", () => {
  assert.equal(extractTmdbIdFromGuids(undefined), null);
  assert.equal(extractTmdbIdFromGuids([]), null);
  assert.equal(
    extractTmdbIdFromGuids([{ id: "imdb://tt0133093" }, { id: "tvdb://290434" }]),
    null,
  );
});

test("extractTmdbIdFromGuids: the tmdb guid is found wherever it sits in a mixed-provider array", () => {
  assert.equal(
    extractTmdbIdFromGuids([{ id: "imdb://tt0133093" }, { id: "tmdb://603" }, { id: "tvdb://290434" }]),
    603,
  );
  assert.equal(
    extractTmdbIdFromGuids([{ id: "tmdb://550" }, { id: "imdb://tt0137523" }]),
    550,
  );
});

test("extractTmdbIdFromGuids: malformed tmdb guids are skipped, the first PARSEABLE one wins, prefix match is case-sensitive", () => {
  // NaN payload skipped; the later valid guid is used.
  assert.equal(extractTmdbIdFromGuids([{ id: "tmdb://abc" }, { id: "tmdb://604" }]), 604);
  // Empty payload → NaN → null when nothing else parses.
  assert.equal(extractTmdbIdFromGuids([{ id: "tmdb://" }]), null);
  // First-match-wins across two valid guids.
  assert.equal(extractTmdbIdFromGuids([{ id: "tmdb://1" }, { id: "tmdb://2" }]), 1);
  // A modern Guid entry is exactly tmdb://<digits>: trailing junk is no id
  // (parseInt used to read "12?lang=en" and "12abc" as 12).
  assert.equal(extractTmdbIdFromGuids([{ id: "tmdb://12?lang=en" }]), null);
  // Uppercase scheme does not match (startsWith is case-sensitive).
  assert.equal(extractTmdbIdFromGuids([{ id: "TMDB://603" }]), null);
});

// ── pingPlexToken ───────────────────────────────────────────────────────────

test("pingPlexToken hits plex.tv/api/v2/ping with the full X-Plex header set; clientId overrides the default", async () => {
  assert.equal(PLEX_CLIENT_ID, "summonarr-server"); // persisted in users' Plex device lists — churn orphans devices

  respond = () => okJson({});
  assert.equal(await pingPlexToken("tok-abc"), true);
  const call = fetchCalls[0];
  assert.equal(call.raw, "https://plex.tv/api/v2/ping");
  assert.equal(call.headers.get("x-plex-token"), "tok-abc");
  assert.equal(call.headers.get("x-plex-client-identifier"), "summonarr-server");
  assert.equal(call.headers.get("x-plex-product"), "Summonarr");
  assert.equal(call.headers.get("accept"), "application/json");

  assert.equal(await pingPlexToken("tok-abc", "per-user-device-id"), true);
  assert.equal(fetchCalls[1].headers.get("x-plex-client-identifier"), "per-user-device-id");
});

test("pingPlexToken never throws: a 401 and a network failure both read as false", async () => {
  respond = () => okJson({ error: "unauthorized" }, 401);
  assert.equal(await pingPlexToken("expired-tok"), false);

  respond = () => {
    throw new Error("connection refused");
  };
  assert.equal(await pingPlexToken("any-tok"), false);
});

// Sign-in deletes a cached token row only when plex.tv REFUSED the token. A
// timeout or an outage is no answer, so it must not read as "revoked".
test("checkPlexToken: only a 401 is revoked; a 429, a 5xx and a network failure are unknown", async () => {
  respond = () => okJson({});
  assert.equal(await checkPlexToken("tok"), "valid");
  respond = () => okJson({ error: "unauthorized" }, 401);
  assert.equal(await checkPlexToken("tok"), "revoked");
  for (const status of [429, 500, 502, 503]) {
    respond = () => okJson({}, status);
    assert.equal(await checkPlexToken("tok"), "unknown", `a ${status} is no answer`);
  }
  respond = () => {
    throw new Error("connection timed out");
  };
  assert.equal(await checkPlexToken("tok"), "unknown");
});

// ── getPlexUser ─────────────────────────────────────────────────────────────

test("getPlexUser parses /api/v2/user and coerces the numeric account id to a string", async () => {
  respond = () =>
    okJson({ id: 12345, email: "Owner@Example.com", username: "gadget", thumb: "https://plex.tv/u.png" });
  const user = await getPlexUser("tok-user");
  assert.deepEqual(user, {
    id: "12345", // number → string: the stable provider-subject binding
    email: "Owner@Example.com", // preserved verbatim — no lowercasing here
    username: "gadget",
    thumb: "https://plex.tv/u.png",
  });
  assert.equal(fetchCalls[0].raw, "https://plex.tv/api/v2/user");
  assert.equal(fetchCalls[0].headers.get("x-plex-token"), "tok-user");
});

test("getPlexUser username falls back username → title → friendlyName → ''", async () => {
  respond = () => okJson({ id: "u1", email: "a@b.co", title: "Title Name" });
  assert.equal((await getPlexUser("t")).username, "Title Name");

  respond = () => okJson({ id: "u1", email: "a@b.co", friendlyName: "Friendly Name" });
  assert.equal((await getPlexUser("t")).username, "Friendly Name");

  respond = () => okJson({ id: "u1", email: "a@b.co" });
  const bare = await getPlexUser("t");
  assert.equal(bare.username, "");
  assert.equal(bare.thumb, "");
});

test("getPlexUser throws on non-2xx, on a missing/invalid email, and on a missing id", async () => {
  respond = () => okJson({ error: "nope" }, 401);
  await assert.rejects(() => getPlexUser("t"), /Failed to fetch Plex user: 401/);

  respond = () => okJson({ id: 5, email: "not-an-email" });
  await assert.rejects(() => getPlexUser("t"), /missing valid email/);

  respond = () => okJson({ email: "a@b.co", username: "no-id" });
  await assert.rejects(() => getPlexUser("t"), /missing required id/);
});

// ── getPlexLibrarySections ──────────────────────────────────────────────────

test("getPlexLibrarySections keeps only movie/show directories and maps key/title/type", async () => {
  const S = "http://plex-sec1.test:32400";
  respond = () =>
    okJson({
      MediaContainer: {
        Directory: [
          { key: "1", title: "Movies", type: "movie" },
          { key: "2", title: "Shows", type: "show" },
          { key: "3", title: "Music", type: "artist" },
          { key: "4", title: "Photos", type: "photo" },
        ],
      },
    });
  assert.deepEqual(await getPlexLibrarySections(S, "srv-tok"), [
    { key: "1", title: "Movies", type: "movie" },
    { key: "2", title: "Shows", type: "show" },
  ]);
  const call = fetchCalls[0];
  assert.equal(call.raw, `${S}/library/sections`);
  assert.equal(call.headers.get("x-plex-token"), "srv-tok");
  assert.equal(call.headers.get("x-plex-client-identifier"), "summonarr-server");
  assert.equal(call.headers.get("user-agent"), "Summonarr/1.0 (Node.js)");
});

test("getPlexLibrarySections: missing Directory is an empty list; a non-2xx throws with the status", async () => {
  const S = "http://plex-sec2.test:32400";
  respond = () => okJson({ MediaContainer: {} });
  assert.deepEqual(await getPlexLibrarySections(S, "t"), []);

  // 404 fast-fails the retry wrapper (a 5xx would sleep through three real
  // backoffs here — the retry mechanics are pinned with mocked timers in the
  // section-page retry test).
  respond = () => okJson({ error: "boom" }, 404);
  await assert.rejects(() => getPlexLibrarySections(S, "t"), /Plex sections: 404/);
});

// ── getPlexSectionTmdbIds ───────────────────────────────────────────────────

test("getPlexSectionTmdbIds maps movie items: field extraction, null defaults, collection/no-guid skips, legacy guid, multi-guid shared entry", async () => {
  const S = "http://plex-map1.test:32400";
  respond = () =>
    mediaContainer(
      [
        {
          type: "movie", ratingKey: "101", title: "Fight Club", year: 1999,
          summary: "An insomniac office worker.", contentRating: "R", addedAt: 1_700_000_000,
          Guid: [{ id: "imdb://tt0137523" }, { id: "tmdb://550" }],
          Media: [{ Part: [{ file: "/data/movies/Fight Club (1999).mkv" }] }],
        },
        { type: "collection", title: "Best Of", Guid: [{ id: "tmdb://999" }] },
        { type: "movie", ratingKey: "102", title: "No Tmdb Guid", Guid: [{ id: "imdb://tt0000001" }] },
        { type: "movie", title: "Old Agent Movie", guid: "com.plexapp.agents.themoviedb://604?lang=en" },
        { type: "movie", ratingKey: "104", title: "Double Guid", Guid: [{ id: "tmdb://11" }, { id: "tmdb://12" }] },
      ],
      { totalSize: 5 },
    );

  const items = await getPlexSectionTmdbIds(S, "t", "5", "movie");
  assert.deepEqual([...items.keys()].sort((a, b) => a - b), [11, 12, 550, 604]);
  assert.deepEqual(items.get(550), {
    filePath: "/data/movies/Fight Club (1999).mkv",
    ratingKey: "101",
    title: "Fight Club",
    year: "1999", // number → string
    overview: "An insomniac office worker.",
    contentRating: "R",
    addedAt: new Date(1_700_000_000_000), // epoch-seconds × 1000
  });
  // Legacy single-guid agent item: id extracted from the guid string, every
  // other field degrades to null.
  assert.deepEqual(items.get(604), {
    filePath: null, ratingKey: null, title: "Old Agent Movie",
    year: null, overview: null, contentRating: null, addedAt: null,
  });
  // Both tmdb guids on one item map to the SAME entry object.
  assert.equal(items.get(11), items.get(12));

  // Wire pin: full-sync movie path with the container paging params.
  assert.equal(fetchCalls.length, 1);
  assert.equal(
    fetchCalls[0].raw,
    `${S}/library/sections/5/all?type=1&includeGuids=1&X-Plex-Container-Start=0&X-Plex-Container-Size=1000`,
  );
});

test("getPlexSectionTmdbIds pages by totalSize, advancing X-Plex-Container-Start by items received", async () => {
  const S = "http://plex-page1.test:32400";
  const mv = (id: number) => ({ type: "movie", ratingKey: String(id), title: `M${id}`, Guid: [{ id: `tmdb://${id}` }] });
  respond = (url) => {
    const start = url.searchParams.get("X-Plex-Container-Start");
    if (start === "0") return mediaContainer([mv(1), mv(2)], { totalSize: 3 });
    if (start === "2") return mediaContainer([mv(3)], { totalSize: 3 });
    throw new Error(`unexpected page start=${start}`);
  };

  const items = await getPlexSectionTmdbIds(S, "t", "1", "movie");
  assert.deepEqual([...items.keys()].sort((a, b) => a - b), [1, 2, 3]);
  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[1].url.searchParams.get("X-Plex-Container-Start"), "2");
});

test("getPlexSectionTmdbIds with NO totalSize keeps paging until an empty page — container.size must not truncate the sync", async () => {
  // The inline comment in plexFetchAllPages declares this load-bearing: falling
  // back to container.size (the PAGE's count) would stop after one page and
  // silently truncate any library larger than a page on Plex builds that omit
  // totalSize. Pin the empty-page terminator instead.
  const S = "http://plex-page2.test:32400";
  respond = (url) => {
    const start = url.searchParams.get("X-Plex-Container-Start");
    if (start === "0") {
      return mediaContainer(
        [{ type: "movie", ratingKey: "7", title: "M7", Guid: [{ id: "tmdb://7" }] }],
        { size: 1 }, // size present, totalSize absent
      );
    }
    if (start === "1") return mediaContainer([], { size: 0 });
    throw new Error(`unexpected page start=${start}`);
  };

  const items = await getPlexSectionTmdbIds(S, "t", "1", "movie");
  assert.deepEqual([...items.keys()], [7]);
  assert.equal(fetchCalls.length, 2, "must fetch a second page rather than trust container.size as the total");
});

test("recentOnly early stop: paging ends once an ENTIRE addedAt-desc page predates the window; unknown addedAt keeps paging", async () => {
  // /recentlyAdded is addedAt-desc, so the "incremental" sync used to page the
  // whole section every run. A page mixing new+old (or carrying unknown ages)
  // must keep paging; a page that is entirely known-old ends the walk.
  const S = "http://plex-recent1.test:32400";
  const NOW_SEC = 1_700_000_000;
  const cutoff = NOW_SEC - 2 * 60 * 60; // 2h window
  const mv = (id: number, addedAt?: number) => ({
    type: "movie", ratingKey: `rk${id}`, title: `M${id}`, Guid: [{ id: `tmdb://${id}` }],
    ...(addedAt !== undefined ? { addedAt } : {}),
  });
  respond = (url) => {
    const start = url.searchParams.get("X-Plex-Container-Start");
    // Page 0: one in-window + one unknown-age → keep paging.
    if (start === "0") return mediaContainer([mv(1, NOW_SEC - 60), mv(2)], { totalSize: 3001 });
    // Page 1: entirely known-old → stop; page 2 must never be fetched.
    if (start === "2") return mediaContainer([mv(3, cutoff - 9_000), mv(4, cutoff - 10_000)], { totalSize: 3001 });
    throw new Error(`unexpected fetch ${url}`);
  };

  const items = await getPlexSectionTmdbIds(S, "t", "1", "movie", { recentOnly: true, recentSinceEpochSec: cutoff });
  assert.equal(fetchCalls.length, 2, "the walk must stop after the all-old page — no third fetch");
  // Items from fetched pages (including the old page's) still land in the map;
  // the recentOnly write path is insert-only, so extras are harmless.
  assert.deepEqual([...items.keys()].sort((a, b) => a - b), [1, 2, 3, 4]);
});

test("getPlexSectionTmdbIds show sections: the recentlyAdded path, and no per-show request — a show's file path comes from the episode walk", async () => {
  const S = "http://plex-shows1.test:32400";
  respond = (url) => {
    if (url.pathname === "/library/sections/9/recentlyAdded") {
      return mediaContainer(
        [
          { type: "show", ratingKey: "201", title: "Show A", Guid: [{ id: "tmdb://100" }] },
          { type: "show", ratingKey: "202", title: "Show B", Guid: [{ id: "tmdb://200" }] },
          { type: "show", ratingKey: "203", title: "Show C", Guid: [{ id: "tmdb://300" }] },
        ],
        { totalSize: 3 },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const items = await getPlexSectionTmdbIds(S, "t", "9", "show", { recentOnly: true });
  // recentOnly=true routes to /recentlyAdded; shows use type=2.
  assert.deepEqual(
    fetchCalls.map((c) => c.raw),
    [`${S}/library/sections/9/recentlyAdded?type=2&includeGuids=1&X-Plex-Container-Start=0&X-Plex-Container-Size=1000`],
    "the listing is the only request: one allLeaves read per show used to follow it",
  );
  for (const id of [100, 200, 300]) assert.equal(items.get(id)?.filePath, null, `show ${id} carries no file of its own`);
});

test("getPlexSectionTmdbIds error shapes: a persistent 5xx and a missing MediaContainer throw with the page offset after retries exhaust", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const S = "http://plex-err1.test:32400";

  respond = () => okJson({ error: "boom" }, 500);
  {
    const done = assert.rejects(
      getPlexSectionTmdbIds(S, "t", "1", "movie"),
      /Plex paginated fetch failed: 500 at start=0/,
    );
    for (const ms of [2_000, 4_000, 6_000]) { await flush(); t.mock.timers.tick(ms); }
    await done;
    assert.equal(fetchCalls.length, 4, "one attempt + three retries on a persistent 5xx");
  }

  fetchCalls.length = 0;
  respond = () => okJson({});
  {
    const done = assert.rejects(
      getPlexSectionTmdbIds(S, "t", "1", "movie"),
      /returned no MediaContainer at start=0/,
    );
    for (const ms of [2_000, 4_000, 6_000]) { await flush(); t.mock.timers.tick(ms); }
    await done;
    assert.equal(fetchCalls.length, 1, "an answer with no MediaContainer is the same on every try — not retried");
  }
});

test("a page over the response cap is not downloaded again: one fetch, then the size error", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const S = "http://plex-err-size.test:32400";
  respond = () => new Response("{}", { status: 200, headers: { "content-type": "application/json", "content-length": String(60 * 1024 * 1024) } });
  const done = assert.rejects(getPlexSectionTmdbIds(S, "t", "1", "movie"), (err: Error) => err.name === "SafeFetchError" && /exceeds cap/.test(err.message));
  for (const ms of [2_000, 4_000, 6_000]) { await flush(); t.mock.timers.tick(ms); }
  await done;
  assert.equal(fetchCalls.length, 1, "a body over LIBRARY_FETCH_MAX_BYTES is over it on every download");
});

test("a 5xx page retries after the backoff (with the [plex] retry warn) and the retried page's items survive; a non-429 4xx fast-fails", async (t: TestContext) => {
  // The Jellyfin twin's per-page retry is established precedent — one transient
  // blip must not abort an entire instance's sync arm for a full SYNC_INTERVAL.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const S = "http://plex-retry1.test:32400";
  let calls = 0;
  respond = () => {
    calls++;
    if (calls === 1) return okJson({ error: "transient" }, 500);
    return mediaContainer([{ type: "movie", ratingKey: "9", title: "Nine", Guid: [{ id: "tmdb://9" }] }], { totalSize: 1 });
  };

  const p = getPlexSectionTmdbIds(S, "t", "1", "movie");
  await flush();
  assert.equal(fetchCalls.length, 1, "the first attempt has failed; the retry is parked behind its backoff");
  t.mock.timers.tick(2_000); // PAGE_RETRY_DELAY_MS * attempt 1
  const items = await p;
  assert.equal(fetchCalls.length, 2);
  assert.ok(warns.some((w) => w.includes("[plex] retry 1/3 for start=0")), "each retry must warn with its scope");
  assert.deepEqual([...items.keys()], [9]);

  // A revoked token can never succeed on retry — it must not hammer the server.
  fetchCalls.length = 0;
  respond = () => okJson({ error: "revoked" }, 401);
  await assert.rejects(
    () => getPlexSectionTmdbIds(S, "t", "1", "movie"),
    /Plex paginated fetch failed: 401 at start=0/,
  );
  assert.equal(fetchCalls.length, 1, "non-429 4xx fast-fails on the first attempt");
});

test("legacy-agent thetvdb://​/imdb:// items land in the legacy channel instead of vanishing; modern Guid arrays never do", async () => {
  // Pre-2020 agents carry NO tmdb id at all (com.plexapp.agents.thetvdb://,
  // com.plexapp.agents.imdb://) — those items used to be invisible to
  // availability and the episode cache. The walk now collects them for the
  // sync layer's best-effort TMDB /find resolution.
  const S = "http://plex-legacy1.test:32400";
  respond = () =>
    mediaContainer([
      { type: "movie", ratingKey: "L1", title: "Old Movie", guid: "com.plexapp.agents.imdb://tt0137523?lang=en" },
      { type: "show", ratingKey: "L2", title: "Old Show", guid: "com.plexapp.agents.thetvdb://81189?lang=en" },
      { type: "movie", ratingKey: "L3", title: "Legacy tmdb", guid: "com.plexapp.agents.themoviedb://550" },
      { type: "movie", ratingKey: "L4", title: "Modern imdb-only", Guid: [{ id: "imdb://tt1375666" }] },
    ], { totalSize: 4 });

  const legacyOut = new Map<string, PlexLegacyGuidRef>();
  const items = await getPlexSectionTmdbIds(S, "t", "1", "movie", { legacyOut });
  // The legacy themoviedb:// guid still resolves inline, never via the channel.
  assert.deepEqual([...items.keys()], [550]);
  assert.deepEqual([...legacyOut.keys()].sort(), ["L1", "L2"]);
  assert.equal(legacyOut.get("L1")!.imdbId, "tt0137523");
  assert.equal(legacyOut.get("L1")!.data.title, "Old Movie", "the channel carries the full item data for the post-resolution merge");
  assert.equal(legacyOut.get("L2")!.tvdbId, 81189);
  // A MODERN Guid array without a tmdb entry stays excluded (pinned deliberate
  // in the guid tests above) and must NOT enter the legacy channel either.
  assert.ok(!legacyOut.has("L4"));
});

// ── getPlexTmdbIds ──────────────────────────────────────────────────────────

test("getPlexTmdbIds lists sections, fans out over matching types only, and keeps the first copy on an exact tie", async () => {
  const S = "http://plex-comb1.test:32400";
  const mv = (id: number, title: string) => ({ type: "movie", ratingKey: String(id), title, Guid: [{ id: `tmdb://${id}` }] });
  respond = (url) => {
    if (url.pathname === "/library/sections") {
      return okJson({
        MediaContainer: {
          Directory: [
            { key: "1", title: "Movies A", type: "movie" },
            { key: "2", title: "Movies B", type: "movie" },
            { key: "3", title: "Shows", type: "show" },
          ],
        },
      });
    }
    if (url.pathname === "/library/sections/1/all") return mediaContainer([mv(10, "From One")], { totalSize: 1 });
    if (url.pathname === "/library/sections/2/all") {
      return mediaContainer([mv(10, "From Two"), mv(20, "Only Two")], { totalSize: 2 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const combined = await getPlexTmdbIds(S, "t", "MOVIE");
  assert.deepEqual([...combined.keys()].sort((a, b) => a - b), [10, 20]);
  assert.equal(combined.get(10)?.title, "From One", "copies alike in date and ratingKey: the first-seen entry stays");
  assert.ok(
    fetchCalls.every((c) => !c.url.pathname.startsWith("/library/sections/3/")),
    "show sections must not be fetched for a MOVIE sync",
  );
  assert.ok(
    fetchCalls
      .filter((c) => /^\/library\/sections\/\d+\/all$/.test(c.url.pathname))
      .every((c) => c.url.searchParams.get("type") === "1"),
  );
});

// guardrail 37c: a title in two sections is two Plex items with two ratingKeys.
// The merge keeps the preferred copy (newest addedAt) but must keep the other
// copy's key addressable, or every play/history entry filed under it resolves
// to nobody.
test("getPlexTmdbIds records the losing section copy's ratingKey, without leaking it onto a conflated sibling", async () => {
  const S = "http://plex-comb3.test:32400";
  respond = (url) => {
    if (url.pathname === "/library/sections") {
      return okJson({ MediaContainer: { Directory: [
        { key: "1", title: "Movies", type: "movie" },
        { key: "2", title: "4K Movies", type: "movie" },
      ] } });
    }
    if (url.pathname === "/library/sections/1/all") {
      return mediaContainer([
        // One conflated item claiming two tmdb ids — ONE entry object is shared by both.
        { type: "movie", ratingKey: "100", title: "Merged", addedAt: 1_700_000_100, Guid: [{ id: "tmdb://10" }, { id: "tmdb://11" }] },
      ], { totalSize: 1 });
    }
    if (url.pathname === "/library/sections/2/all") {
      return mediaContainer([
        { type: "movie", ratingKey: "200", title: "4K copy", addedAt: 1_700_000_000, Guid: [{ id: "tmdb://10" }] },
        // A split duplicate inside one section: both items stay addressable.
        { type: "movie", ratingKey: "300", title: "Dup A", Guid: [{ id: "tmdb://30" }] },
        { type: "movie", ratingKey: "301", title: "Dup B", Guid: [{ id: "tmdb://30" }] },
      ], { totalSize: 3 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const { plexLibraryRatingKeys } = await import("../src/lib/plex.ts");
  const combined = await getPlexTmdbIds(S, "t", "MOVIE");
  assert.equal(combined.get(10)?.ratingKey, "100", "the newer copy owns the row");
  assert.deepEqual(plexLibraryRatingKeys(combined.get(10)!), ["100", "200"]);
  assert.deepEqual(
    plexLibraryRatingKeys(combined.get(11)!),
    ["100"],
    "the conflated sibling shares the entry object — an in-place push would hand it a copy it isn't",
  );
  assert.deepEqual(plexLibraryRatingKeys(combined.get(30)!), ["301", "300"]);
});

test("getPlexTmdbIds with provided sections + selectedKeys skips the section listing and fetches only the selected key", async () => {
  const S = "http://plex-comb2.test:32400";
  respond = (url) => {
    if (url.pathname === "/library/sections/2/all") {
      return mediaContainer(
        [{ type: "movie", ratingKey: "1", title: "Picked", Guid: [{ id: "tmdb://42" }] }],
        { totalSize: 1 },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const sections = [
    { key: "1", title: "Movies A", type: "movie" as const },
    { key: "2", title: "Movies B", type: "movie" as const },
  ];
  const combined = await getPlexTmdbIds(S, "t", "MOVIE", { selectedKeys: new Set(["2"]), sections });
  assert.deepEqual([...combined.keys()], [42]);
  assert.equal(fetchCalls.length, 1, "no /library/sections listing and no unselected-section fetch");
});

// ── getPlexTVEpisodes / getPlexEpisodesForShow ──────────────────────────────

test("getPlexTVEpisodes maps episodes through the show ratingKey→tmdb table, filters specials/zero/non-integer indices, and dedups", async () => {
  const S = "http://plex-eps1.test:32400";
  respond = (url) => {
    if (url.searchParams.get("type") === "2") {
      return mediaContainer(
        [
          { ratingKey: "301", title: "Mapped Show", Guid: [{ id: "tmdb://1399" }] },
          { ratingKey: "302", title: "No Tmdb Show", Guid: [{ id: "imdb://tt1" }] },
        ],
        { totalSize: 2 },
      );
    }
    if (url.searchParams.get("type") === "4") {
      return mediaContainer(
        [
          { grandparentRatingKey: "301", parentIndex: 1, index: 1, addedAt: 1_700_000_500 },
          // duplicate → deduped, keeping the EARLIER arrival (dates the season)
          { grandparentRatingKey: "301", parentIndex: 1, index: 1, addedAt: 1_700_000_000 },
          { grandparentRatingKey: "301", parentIndex: 0, index: 5 }, // specials season → dropped
          { grandparentRatingKey: "301", parentIndex: 2, index: 0 }, // episode 0 → dropped
          { grandparentRatingKey: "301", parentIndex: 1.5, index: 2 }, // non-integer season → dropped
          { grandparentRatingKey: "301", index: 3 }, // missing season → dropped
          { grandparentRatingKey: "302", parentIndex: 1, index: 1 }, // show without tmdb → dropped
          { grandparentRatingKey: "999", parentIndex: 1, index: 1 }, // unknown show → dropped
          { grandparentRatingKey: "301", parentIndex: 2, index: 3 },
        ],
        { totalSize: 9 },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const sections = [{ key: "7", title: "Shows", type: "show" as const }];
  const episodes = await getPlexTVEpisodes(S, "t", undefined, sections);
  assert.deepEqual(episodes, [
    { tmdbId: 1399, seasonNumber: 1, episodeNumber: 1, addedAt: new Date(1_700_000_000_000) },
    { tmdbId: 1399, seasonNumber: 2, episodeNumber: 3, addedAt: null },
  ]);
});

test("getPlexTVEpisodes returns [] without fetching the episode page when no show resolves to a tmdb id", async () => {
  const S = "http://plex-eps2.test:32400";
  respond = (url) => {
    if (url.searchParams.get("type") === "2") {
      return mediaContainer([{ ratingKey: "401", title: "Unmatched", Guid: [{ id: "imdb://tt2" }] }], { totalSize: 1 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const sections = [{ key: "7", title: "Shows", type: "show" as const }];
  assert.deepEqual(await getPlexTVEpisodes(S, "t", undefined, sections), []);
  assert.equal(fetchCalls.length, 1, "the type=4 episode page must be skipped entirely");
});

test("the type=2 walk accumulates ratingKey→tmdb ids, and a precomputed map skips getPlexTVEpisodes' show re-walk", async () => {
  // The full sync used to page every show section TWICE — once for the library
  // map, once inside getPlexTVEpisodes for the identical ratingKey→tmdb table.
  const S = "http://plex-pre1.test:32400";
  respond = (url) => {
    if (url.pathname === "/library/sections/3/all") {
      return mediaContainer([{ type: "show", ratingKey: "70", title: "Severance", Guid: [{ id: "tmdb://95396" }] }], { totalSize: 1 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const out = new Map<string, number[]>();
  await getPlexSectionTmdbIds(S, "t", "3", "show", { ratingKeyToTmdbOut: out });
  assert.deepEqual([...out.entries()], [["70", [95396]]]);

  fetchCalls.length = 0;
  respond = (url) => {
    if (url.pathname === "/library/sections/3/all" && url.searchParams.get("type") === "4") {
      return mediaContainer([{ grandparentRatingKey: "70", parentIndex: 1, index: 2 }], { totalSize: 1 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const sections = [{ key: "3", title: "Shows", type: "show" as const }];
  const eps = await getPlexTVEpisodes(S, "t", undefined, sections, out);
  assert.deepEqual(eps, [{ tmdbId: 95396, seasonNumber: 1, episodeNumber: 2, addedAt: null }]);
  assert.ok(
    fetchCalls.every((c) => c.url.searchParams.get("type") !== "2"),
    "the precomputed map must skip the duplicate type=2 show walk",
  );
});

test("the show walk sends no per-show allLeaves probe; the type=4 walk captures the paths instead", async () => {
  // The sync used to fire ONE allLeaves request per show, every run, just to
  // learn a file path the type=4 episode listing already carries.
  const S = "http://plex-skip1.test:32400";
  respond = (url) => {
    if (url.pathname === "/library/sections/3/all" && url.searchParams.get("type") === "2") {
      return mediaContainer([{ type: "show", ratingKey: "70", title: "Severance", Guid: [{ id: "tmdb://95396" }] }], { totalSize: 1 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const out = new Map<string, number[]>();
  const items = await getPlexSectionTmdbIds(S, "t", "3", "show", { ratingKeyToTmdbOut: out });
  assert.equal(items.get(95396)!.filePath, null, "no allLeaves probe ⇒ no path from the show walk");
  assert.ok(
    fetchCalls.every((c) => !c.url.pathname.includes("/allLeaves")),
    "the per-show allLeaves fan-out must never fire",
  );

  fetchCalls.length = 0;
  respond = (url) => {
    if (url.pathname === "/library/sections/3/all" && url.searchParams.get("type") === "4") {
      return mediaContainer([
        // Specials are index-filtered out of the episode rows but still carry
        // a real on-disk path — the capture must not skip them.
        { grandparentRatingKey: "70", parentIndex: 0, index: 2, Media: [{ Part: [{ file: "/tv/severance/special.mkv" }] }] },
        { grandparentRatingKey: "70", parentIndex: 1, index: 1, Media: [{ Part: [{ file: "/tv/severance/e1.mkv" }] }] },
      ], { totalSize: 2 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const sections = [{ key: "3", title: "Shows", type: "show" as const }];
  const files = new Map<string, string>();
  const eps = await getPlexTVEpisodes(S, "t", undefined, sections, out, files);
  assert.deepEqual(eps, [{ tmdbId: 95396, seasonNumber: 1, episodeNumber: 1, addedAt: null }]);
  assert.deepEqual(
    [...files.entries()],
    [["70", "/tv/severance/special.mkv"]],
    "first-wins path capture per show, including index-filtered specials",
  );
});

test("getPlexEpisodesForShow pages the show's allLeaves and stamps the caller's tmdbId onto valid episodes", async () => {
  const S = "http://plex-leaf1.test:32400";
  respond = (url) => {
    if (url.pathname === "/library/metadata/444/allLeaves") {
      return mediaContainer(
        [
          { parentIndex: 1, index: 2, addedAt: 1_700_000_000 },
          { parentIndex: 0, index: 1 }, // specials → dropped
          { index: 3 }, // missing season → dropped
          { parentIndex: 3, index: 4 }, // undated → addedAt null
        ],
        { totalSize: 4 },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const episodes = await getPlexEpisodesForShow(S, "t", "444", 777);
  // addedAt is mapped exactly as getPlexTVEpisodes maps it: fix-match rebuilds
  // a show's TVEpisodeCache rows from this helper, and one undated episode
  // makes its season unobservable on the never-watched report (14d).
  assert.deepEqual(episodes, [
    { tmdbId: 777, seasonNumber: 1, episodeNumber: 2, addedAt: new Date(1_700_000_000_000) },
    { tmdbId: 777, seasonNumber: 3, episodeNumber: 4, addedAt: null },
  ]);
  // Base has no query string, so pagination starts with "?" not "&".
  assert.equal(
    fetchCalls[0].raw,
    `${S}/library/metadata/444/allLeaves?X-Plex-Container-Start=0&X-Plex-Container-Size=1000`,
  );
});

// ── getPlexSessions ─────────────────────────────────────────────────────────

test("getPlexSessions maps a DirectPlay movie session to the exact shape the play-history poller consumes", async () => {
  const S = "http://plex-sess1.test:32400";
  respond = () =>
    mediaContainer([
      {
        sessionKey: "12",
        Player: {
          state: "playing", title: "Living Room", device: "Apple TV 4K",
          product: "Plex for Apple TV", platform: "tvOS", address: "192.168.1.50",
          secure: "1", relayed: "0",
        },
        User: { id: 42, title: "chris", thumb: "https://plex.tv/users/42/avatar" },
        ratingKey: "555",
        title: "Inception",
        type: "movie",
        year: 2010,
        duration: 8_880_000,
        viewOffset: 123_456,
        Guid: [{ id: "tmdb://27205" }, { id: "imdb://tt1375666" }],
        Media: [{
          container: "mkv", bitrate: 20_000, videoResolution: "4k",
          Part: [{
            file: "/data/movies/Inception.mkv",
            Stream: [
              { streamType: 1, codec: "hevc", decision: "directplay" },
              { streamType: 2, codec: "eac3" },
            ],
          }],
        }],
        Session: { id: "guid-abc", bandwidth: 25_000, location: "lan" },
      },
    ]);

  const sessions = await getPlexSessions(S, "srv-tok");
  assert.equal(fetchCalls[0].raw, `${S}/status/sessions?includeGuids=1`);
  assert.equal(fetchCalls[0].headers.get("x-plex-token"), "srv-tok");

  // Full-shape pin: a key added to or dropped from the mapper output fails
  // here, which is the point — the poller and SSE handler consume this shape.
  assert.deepEqual(sessions, [{
    sessionKey: "12",
    sessionId: "guid-abc",
    state: "playing",
    accountId: "42", // numeric User.id → string
    accountName: "chris",
    accountThumb: "https://plex.tv/users/42/avatar",
    ratingKey: "555",
    grandparentRatingKey: undefined,
    title: "Inception",
    grandparentTitle: undefined,
    parentIndex: undefined,
    index: undefined,
    type: "movie",
    year: "2010",
    duration: 8_880_000,
    viewOffset: 123_456,
    Guid: [{ id: "tmdb://27205" }, { id: "imdb://tt1375666" }],
    platform: "tvOS",
    player: "Living Room",
    device: "Apple TV", // "Plex for " prefix stripped from Player.product
    address: "192.168.1.50",
    remotePublicAddress: undefined, // LAN fixture carries none — mapped through when PMS sends it
    playMethod: "DirectPlay", // no TranscodeSession at all
    videoCodec: "hevc",
    audioCodec: "eac3",
    resolution: "4k",
    bitrate: 20_000,
    videoDecision: "directplay", // stream decision when no TranscodeSession
    audioDecision: undefined,
    container: "mkv",
    transcodeReason: undefined,
    location: "lan",
    bandwidth: 25_000,
    secure: true, // "1" → true
    relayed: false, // "0" → false
  }]);
});

test("getPlexSessions prefers the `selected` Media/Part/Stream over [0]/first-of-type on multi-version items", async () => {
  // /status/sessions lists EVERY Media version of a multi-version item and
  // every stream of the playing part, with the actually-playing ones marked
  // selected ("1" string or boolean). [0]/first-of-type is routinely the wrong
  // one; fixtures without the attribute keep the old first-entry fallback.
  const S = "http://plex-sess4.test:32400";
  respond = () =>
    mediaContainer([{
      sessionKey: "9",
      Media: [
        {
          container: "mkv", bitrate: 30_000, videoResolution: "4k",
          Part: [{ Stream: [{ streamType: 1, codec: "hevc" }, { streamType: 2, codec: "truehd" }] }],
        },
        {
          container: "mp4", bitrate: 4_000, videoResolution: "1080", selected: "1",
          Part: [
            { Stream: [{ streamType: 1, codec: "h264-wrong-part" }] },
            {
              selected: "1",
              Stream: [
                { streamType: 1, codec: "h264-other" },
                { streamType: 1, codec: "h264-sel", selected: "1" },
                { streamType: 2, codec: "aac" },
                { streamType: 2, codec: "eac3", selected: true },
              ],
            },
          ],
        },
      ],
    }]);

  const [s] = await getPlexSessions(S, "t");
  assert.equal(s.resolution, "1080", "the selected Media version wins over Media[0]");
  assert.equal(s.bitrate, 4_000);
  assert.equal(s.container, "mp4");
  assert.equal(s.videoCodec, "h264-sel", "the selected stream of the selected Part wins over first-of-type");
  assert.equal(s.audioCodec, "eac3", "boolean selected normalizes like secure/relayed");
});

test("getPlexSessions: episode title composition and the Transcode/DirectStream decision with humanized reasons", async () => {
  const S = "http://plex-sess2.test:32400";
  respond = () =>
    mediaContainer([
      {
        type: "episode", grandparentTitle: "Severance", title: "Half Loop",
        grandparentRatingKey: "70", parentIndex: 1, index: 2,
        TranscodeSession: { videoDecision: "transcode", audioDecision: "copy" },
        Media: [{ Part: [{ Stream: [{ streamType: 3, decision: "burn" }] }] }],
      },
      { title: "Copied", TranscodeSession: { videoDecision: "copy", audioDecision: "copy" } },
      { title: "Audio Only", TranscodeSession: { audioDecision: "transcode" } },
    ]);

  const [ep, copied, audio] = await getPlexSessions(S, "t");
  assert.equal(ep.title, "Severance — Half Loop");
  assert.equal(ep.playMethod, "Transcode");
  // Plex reports WHICH stream it transcoded, never why — the label must not
  // claim a cause (it used to say "Video codec not supported" for every one).
  assert.equal(ep.transcodeReason, "Video transcoded, Subtitle burn-in");
  assert.equal(ep.videoDecision, "transcode");
  assert.equal(ep.audioDecision, "copy");
  assert.equal(ep.parentIndex, 1);
  assert.equal(ep.index, 2);

  assert.equal(copied.playMethod, "DirectStream");
  assert.equal(copied.transcodeReason, undefined);

  assert.equal(audio.playMethod, "Transcode");
  assert.equal(audio.transcodeReason, "Audio transcoded");
});

test("getPlexSessions degrades an empty raw session to safe defaults; sessionKey falls back to Session.id; state and toBool normalize", async () => {
  const S = "http://plex-sess3.test:32400";
  respond = () =>
    mediaContainer([
      {},
      {
        Session: { id: "g2" },
        Player: { state: "paused", secure: true, relayed: false, device: "SHIELD Android TV" },
      },
      {
        Player: { state: "buffering", title: "Chrome", product: "Plex Web" },
        Session: { location: "space", bandwidth: "fast" },
      },
    ]);

  const [empty, paused, buffering] = await getPlexSessions(S, "t");
  assert.equal(empty.sessionKey, "");
  assert.equal(empty.state, "playing", "an unknown Player.state reads as playing");
  assert.equal(empty.accountId, "");
  assert.equal(empty.accountName, "");
  assert.equal(empty.title, "");
  assert.equal(empty.type, "movie");
  assert.equal(empty.duration, 0);
  assert.equal(empty.viewOffset, 0);
  assert.equal(empty.playMethod, "DirectPlay");
  assert.equal(empty.device, undefined);
  assert.equal(empty.secure, undefined);
  assert.equal(empty.year, undefined);

  assert.equal(paused.sessionKey, "g2", "sessionKey falls back to the Session.id GUID");
  assert.equal(paused.sessionId, "g2");
  assert.equal(paused.state, "paused");
  assert.equal(paused.secure, true, "boolean secure passes through");
  assert.equal(paused.relayed, false);
  assert.equal(paused.device, "SHIELD Android TV", "no Player.product → device attribute fallback");

  assert.equal(buffering.state, "buffering");
  assert.equal(buffering.device, "Web", "'Plex ' prefix stripped from Player.product");
  assert.equal(buffering.location, undefined, "an unrecognized Session.location is dropped");
  assert.equal(buffering.bandwidth, undefined, "a non-numeric bandwidth is dropped");
});

test("getPlexSessions throws on non-2xx and returns [] for an empty MediaContainer", async () => {
  const S = "http://plex-sess4.test:32400";
  respond = () => okJson({ error: "unavailable" }, 503);
  await assert.rejects(() => getPlexSessions(S, "t"), /Plex sessions: 503/);

  respond = () => okJson({ MediaContainer: {} });
  assert.deepEqual(await getPlexSessions(S, "t"), []);
});

// ── getPlexMarkers ──────────────────────────────────────────────────────────

test("getPlexMarkers merges split credits markers to earliest-start/latest-end and ignores unknown marker types", async () => {
  const S = "http://plex-mark1.test:32400";
  respond = () =>
    mediaContainer([
      {
        Marker: [
          { type: "intro", startTimeOffset: 5_000, endTimeOffset: 95_000 },
          { type: "credits", final: false, startTimeOffset: 2_500_000, endTimeOffset: 2_550_000 },
          { type: "credits", final: true, startTimeOffset: 2_600_000, endTimeOffset: 2_700_000 },
          { type: "commercial", startTimeOffset: 1, endTimeOffset: 2 },
        ],
      },
    ]);

  assert.deepEqual(await getPlexMarkers(S, "t", "888"), {
    introStartMs: 5_000,
    introEndMs: 95_000,
    creditsStartMs: 2_500_000, // min across the split credits blocks
    creditsEndMs: 2_700_000, // max across the split credits blocks
  });
  assert.equal(fetchCalls[0].raw, `${S}/library/metadata/888?includeMarkers=1`);
});

test("getPlexMarkers degrades to {} on non-2xx, on unparseable JSON, and on metadata without markers", async () => {
  const S = "http://plex-mark2.test:32400";
  respond = () => okJson({ error: "gone" }, 404);
  assert.deepEqual(await getPlexMarkers(S, "t", "1"), {});

  respond = () => new Response("<html>not json</html>", { status: 200 });
  assert.deepEqual(await getPlexMarkers(S, "t", "1"), {});

  respond = () => mediaContainer([{}]);
  assert.deepEqual(await getPlexMarkers(S, "t", "1"), {});
});

// ── terminatePlexSession ────────────────────────────────────────────────────

test("terminatePlexSession hits the exact terminate URL with an encoded reason and returns {ok,status} without throwing", async () => {
  const S = "http://plex-term1.test:32400";
  respond = () => new Response("", { status: 200 });
  assert.deepEqual(
    await terminatePlexSession(S, "t", "abc123", "Stream limit & quota reached"),
    { ok: true, status: 200 },
  );
  assert.equal(
    fetchCalls[0].raw,
    `${S}/status/sessions/terminate?sessionId=abc123&reason=Stream%20limit%20%26%20quota%20reached`,
  );

  // Plex 404s when the id is the short sessionKey instead of the Session.id
  // GUID — surfaced as a value, never a throw.
  respond = () => new Response("", { status: 404 });
  assert.deepEqual(await terminatePlexSession(S, "t", "wrong-key", "r"), { ok: false, status: 404 });
});

// ── hasPlexItemByTmdbId ─────────────────────────────────────────────────────

test("hasPlexItemByTmdbId queries only matching-type sections with a guid filter and a one-item container; trailing slash normalized", async () => {
  const S = "http://plex-has1.test:32400/"; // trailing slash — item URL must use the stripped base
  respond = () => okJson({ MediaContainer: { totalSize: 1 } });
  const sections = [
    { key: "4", title: "Shows", type: "show" as const },
    { key: "3", title: "Movies", type: "movie" as const },
  ];
  assert.equal(await hasPlexItemByTmdbId(S, "t", 550, "movie", sections), true);
  assert.equal(fetchCalls.length, 1, "the show section must be filtered out, not fetched");
  assert.equal(
    fetchCalls[0].raw,
    "http://plex-has1.test:32400/library/sections/3/all?type=1&includeGuids=1&guid=tmdb://550&X-Plex-Container-Start=0&X-Plex-Container-Size=1",
  );
});

test("hasPlexItemByTmdbId counts totalSize, falls back to size, and reads absent/zero counts as not present", async () => {
  const S = "http://plex-has2.test:32400";
  const sections = [{ key: "3", title: "Movies", type: "movie" as const }];

  respond = () => okJson({ MediaContainer: { size: 2 } });
  assert.equal(await hasPlexItemByTmdbId(S, "t", 1, "movie", sections), true);

  respond = () => okJson({ MediaContainer: {} });
  assert.equal(await hasPlexItemByTmdbId(S, "t", 1, "movie", sections), false);

  respond = () => okJson({ MediaContainer: { totalSize: 0 } });
  assert.equal(await hasPlexItemByTmdbId(S, "t", 1, "movie", sections), false);
});

test("hasPlexItemByTmdbId never throws: a failed section listing reads as false; broken sections are skipped until one answers", async () => {
  const S = "http://plex-has3.test:32400";

  // Section listing itself fails → no sections → false, no throw. (A 404
  // fast-fails the listing's retry wrapper; a 5xx would retry first — the
  // retry mechanics are pinned in the retry test above.)
  respond = () => okJson({ error: "gone" }, 404);
  assert.equal(await hasPlexItemByTmdbId(S, "t", 1, "movie"), false);
  assert.equal(fetchCalls.length, 1);

  // First section throws (network), second is non-2xx, third finds the item.
  fetchCalls.length = 0;
  respond = (url) => {
    if (url.pathname.startsWith("/library/sections/31/")) throw new Error("net down");
    if (url.pathname.startsWith("/library/sections/32/")) return okJson({ error: "boom" }, 500);
    if (url.pathname.startsWith("/library/sections/33/")) return okJson({ MediaContainer: { totalSize: 1 } });
    throw new Error(`unexpected fetch ${url}`);
  };
  const sections = [
    { key: "31", title: "A", type: "movie" as const },
    { key: "32", title: "B", type: "movie" as const },
    { key: "33", title: "C", type: "movie" as const },
  ];
  assert.equal(await hasPlexItemByTmdbId(S, "t", 1, "movie", sections), true);
  assert.equal(fetchCalls.length, 3, "every section is attempted despite earlier failures");
});

// ── getPlexAccountsDetailed ─────────────────────────────────────────────────────────

test("getPlexAccountsDetailed returns the owner first (real plex.tv id, isAdmin) then XML shared users with lowercased emails and defaults", async () => {
  respond = (url) => {
    if (url.pathname === "/api/v2/user") {
      return okJson({ id: 1, email: "owner@example.com", username: "gadget", thumb: "https://plex.tv/owner.png" });
    }
    if (url.pathname === "/api/users") {
      // Attribute-only <User> blocks: id + title are required, email/thumb
      // degrade. (Blocks with Server children are exercised in the friend-email
      // test — here the parse contract itself is the target.)
      return xmlResponse(
        `<?xml version="1.0"?><MediaContainer size="4">` +
        `<User id="55" title="friend1" email="Friend@Example.COM" thumb="https://plex.tv/f1.png"></User>` +
        `<User id="56" title="friend2"></User>` +
        `<User title="no-id" email="x@y.co"></User>` +
        `<User id="57" email="no-title@y.co"></User>` +
        `</MediaContainer>`,
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const { accounts } = await getPlexAccountsDetailed("admin-tok");
  assert.deepEqual(accounts, [
    { id: "1", name: "gadget", email: "owner@example.com", thumb: "https://plex.tv/owner.png", isAdmin: true },
    { id: "55", name: "friend1", email: "friend@example.com", thumb: "https://plex.tv/f1.png", isAdmin: false },
    { id: "56", name: "friend2", email: "", thumb: "", isAdmin: false },
  ]);
  const usersCall = fetchCalls.find((c) => c.url.pathname === "/api/users");
  assert.ok(usersCall);
  assert.equal(usersCall.headers.get("x-plex-token"), "admin-tok");
  assert.equal(usersCall.headers.get("x-plex-client-identifier"), "summonarr-server");
  assert.equal(warns.length, 0, "a clean fetch pair must not warn");
});

test("getPlexAccountsDetailed hops degrade independently: owner failure keeps shared users, shared-users failure keeps the owner — each with a [plex] warn", async () => {
  // Owner fetch fails → warn, shared users still parsed.
  respond = (url) => {
    if (url.pathname === "/api/v2/user") return okJson({ error: "denied" }, 500);
    if (url.pathname === "/api/users") {
      return xmlResponse(`<MediaContainer size="1"><User id="60" title="solo" email="solo@example.com"></User></MediaContainer>`);
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  assert.deepEqual((await getPlexAccountsDetailed("tok")).accounts, [
    { id: "60", name: "solo", email: "solo@example.com", thumb: "", isAdmin: false },
  ]);
  assert.ok(warns.some((w) => w.includes("[plex] Failed to fetch server owner info:")));

  // Shared-users fetch throws → warn, owner still returned.
  warns.length = 0;
  respond = (url) => {
    if (url.pathname === "/api/v2/user") {
      return okJson({ id: 2, email: "own2@example.com", username: "own2" });
    }
    throw new Error("plex.tv unreachable");
  };
  const ownerOnly = (await getPlexAccountsDetailed("tok")).accounts;
  assert.deepEqual(ownerOnly, [
    { id: "2", name: "own2", email: "own2@example.com", thumb: "", isAdmin: true },
  ]);
  assert.ok(warns.some((w) => w.includes("[plex] Failed to fetch shared users:")));
});

// ── getPlexMachineId ────────────────────────────────────────────────────────

test("getPlexMachineId reads /identity and returns null on non-2xx, on a missing field, and on a network failure", async () => {
  const S = "http://plex-mach1.test:32400";
  respond = () => okJson({ MediaContainer: { machineIdentifier: "machine-xyz" } });
  assert.equal(await getPlexMachineId(S, "admin-tok"), "machine-xyz");
  assert.equal(fetchCalls[0].raw, `${S}/identity`);
  assert.equal(fetchCalls[0].headers.get("x-plex-token"), "admin-tok");

  respond = () => okJson({ error: "boom" }, 500);
  assert.equal(await getPlexMachineId(S, "t"), null);

  respond = () => okJson({ MediaContainer: {} });
  assert.equal(await getPlexMachineId(S, "t"), null);

  respond = () => {
    throw new Error("refused");
  };
  assert.equal(await getPlexMachineId(S, "t"), null);
});

// ── getPlexFriendEmails (direct-call contracts; caller behavior lives in
//    tests/plex-membership.test.mts) ──────────────────────────────────────────

test("getPlexFriendEmails without a serverUrl refuses with empty sets and a [plex] warn — zero upstream traffic", async () => {
  assert.deepEqual(await getPlexFriendEmails("admin-tok"), { ids: new Set(), emails: new Set() });
  assert.ok(warns.some((w) => w.includes("[plex]") && w.includes("without serverUrl")));
  assert.equal(fetchCalls.length, 0, "the over-broad all-servers enumeration must never be attempted");
});

test("getPlexFriendEmails direct contract: a non-2xx /api/users THROWS; valid emails are machine-scoped, regex-filtered, lowercased", async () => {
  const S = "http://plex-friends1.test:32400";
  let usersFail = true;
  respond = (url) => {
    if (url.pathname === "/identity") {
      return okJson({ MediaContainer: { machineIdentifier: "machine-ours" } });
    }
    if (url.pathname === "/api/users") {
      if (usersFail) return new Response("plex.tv exploded", { status: 502 });
      return xmlResponse(
        `<?xml version="1.0"?><MediaContainer size="4">` +
        `<User id="1" title="a" email="Friend@Example.COM"><Server machineIdentifier="machine-ours"/></User>` +
        `<User id="2" title="b" email="other@example.com"><Server machineIdentifier="machine-other"/></User>` +
        `<User id="3" title="c" email="not-an-email"><Server machineIdentifier="machine-ours"/></User>` +
        `<User id="4" title="d"><Server machineIdentifier="machine-ours"/></User>` +
        `</MediaContainer>`,
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  // The direct contract is a THROW — the plex-membership caller is what
  // swallows it into a null "no opinion".
  await assert.rejects(() => getPlexFriendEmails("admin-tok", S), /Failed to fetch Plex users: 502/);

  usersFail = false;
  const members = await getPlexFriendEmails("admin-tok", S);
  // Ids are captured for EVERY machine-scoped block — the immutable plex.tv
  // account id is the id-first join key for the sign-in and session-refresh
  // membership gates — even when the email is invalid or absent. The email
  // set keeps only valid addresses, lowercased. Other-server friends
  // contribute to neither set.
  assert.deepEqual(members, {
    ids: new Set(["1", "3", "4"]),
    emails: new Set(["friend@example.com"]),
  });
});

// ── getPlexWatchHistory (the never-watched report's upstream evidence) ───────
// Appended for src/lib/upstream-watch-data.ts. Pins the exact history URL, the
// newest-first sort, the token header, paging, parse-while-paging, the
// records-vs-entries split, and both stops (maxItems, AbortSignal — guardrail 41).

const { getPlexWatchHistory, PLEX_WATCH_HISTORY_MAX_ITEMS } = await import("../src/lib/plex.ts");

test("getPlexWatchHistory hits the exact all-account history URL, newest first, with the server token; a trailing slash is normalized", async () => {
  const S = "http://plex-hist1.test:32400";
  respond = () => mediaContainer(
    [
      { type: "movie", ratingKey: "10", viewedAt: 1_700_000_000, accountID: 1 },
      { type: "episode", ratingKey: "21", grandparentRatingKey: "20", parentIndex: 1, viewedAt: 1_700_000_100, accountID: 2 },
      { type: "track", ratingKey: "30", viewedAt: 1_700_000_200 },
      { type: "movie", title: "no key at all" },
    ],
    { totalSize: 4 },
  );
  const h = await getPlexWatchHistory(`${S}/`, "hist-token");
  assert.equal(fetchCalls.length, 1);
  assert.equal(
    fetchCalls[0].raw,
    `${S}/status/sessions/history/all?sort=viewedAt:desc&X-Plex-Container-Start=0&X-Plex-Container-Size=1000`,
  );
  assert.equal(fetchCalls[0].headers.get("x-plex-token"), "hist-token");
  assert.deepEqual(h.entries.map((e) => [e.kind, e.itemKey, e.showKey, e.seasonNumber]), [["movie", "10", null, null], ["episode", "21", "20", 1]]);
  assert.equal(h.records, 3, "the track is not a watch record; the unplaceable movie IS (that is how a reshaped response shows up)");
  assert.equal(h.truncated, false);
  assert.equal(PLEX_WATCH_HISTORY_MAX_ITEMS, 500_000);
});

test("getPlexWatchHistory pages by X-Plex-Container-Start and stops at maxItems, marking the result truncated", async () => {
  const S = "http://plex-hist2.test:32400";
  const mv = (id: number) => ({ type: "movie", ratingKey: String(id), viewedAt: 1_700_000_000 - id });
  respond = (url) => {
    const start = Number(url.searchParams.get("X-Plex-Container-Start"));
    return mediaContainer([mv(start + 1), mv(start + 2)], { totalSize: 100 });
  };
  const h = await getPlexWatchHistory(S, "t", { maxItems: 3 });
  assert.equal(fetchCalls.length, 2, "the walk stops once maxItems records were read, despite totalSize=100");
  assert.equal(fetchCalls[1].url.searchParams.get("X-Plex-Container-Start"), "2");
  assert.deepEqual(h.entries.map((e) => e.itemKey), ["1", "2", "3"]);
  assert.equal(h.truncated, true);
});

test("getPlexWatchHistory stops paging when its AbortSignal fires (guardrail 41) and does nothing when already aborted", async () => {
  const S = "http://plex-hist3.test:32400";
  const controller = new AbortController();
  respond = (url) => {
    controller.abort();
    const start = Number(url.searchParams.get("X-Plex-Container-Start"));
    return mediaContainer([{ type: "movie", ratingKey: String(start + 1) }], { totalSize: 50 });
  };
  const partial = await getPlexWatchHistory(S, "t", { signal: controller.signal });
  assert.equal(fetchCalls.length, 1, "no further page after the abort");
  assert.equal(partial.aborted, true, "a walk the signal cut short says so");
  assert.deepEqual(partial.entries.map((e) => e.itemKey), ["1"], "the page already read is returned");

  fetchCalls.length = 0;
  const h = await getPlexWatchHistory(S, "t", { signal: controller.signal });
  assert.equal(fetchCalls.length, 0);
  assert.deepEqual(h, { entries: [], records: 0, truncated: false, aborted: true });
});

test("getPlexWatchHistory follows a totalSize that GROWS mid-walk (a view recorded while paging) and reads the shifted oldest record", async () => {
  // viewedAt-desc: a new view is prepended, every older record shifts one
  // offset down, and a total frozen at page 0 (2000) ended the walk before
  // the oldest record — the same one on every run of a busy server.
  const S = "http://plex-hist-grow.test:32400";
  const mv = (id: number) => ({ type: "movie", ratingKey: String(id), viewedAt: 1_700_000_000 - id });
  respond = (url) => {
    const start = Number(url.searchParams.get("X-Plex-Container-Start"));
    if (start === 0) return mediaContainer(Array.from({ length: 1000 }, (_, i) => mv(i + 1)), { totalSize: 2000 });
    // One view landed: this page repeats the previous page's last record.
    if (start === 1000) return mediaContainer(Array.from({ length: 1000 }, (_, i) => mv(i + 1000)), { totalSize: 2001 });
    if (start === 2000) return mediaContainer([mv(5_000_000)], { totalSize: 2001 });
    throw new Error(`unexpected page start=${start}`);
  };
  const h = await getPlexWatchHistory(S, "t");
  assert.ok(
    fetchCalls.some((c) => c.url.searchParams.get("X-Plex-Container-Start") === "2000"),
    "the walk must follow the refreshed total past the page-0 count",
  );
  assert.ok(h.entries.some((e) => e.itemKey === "5000000"), "the oldest record is read");
  assert.equal(fetchCalls.length, 3);
});

test("getPlexWatchHistory THROWS on a non-2xx (a 4xx fast-fails) — the caller must keep its previous snapshot, never read it as 'no history'", async () => {
  const S = "http://plex-hist4.test:32400";
  respond = () => new Response("unauthorized", { status: 401 });
  await assert.rejects(() => getPlexWatchHistory(S, "bad"), /Plex paginated fetch failed: 401/);
  assert.equal(fetchCalls.length, 1, "a 401 is not retried");
});

// Audit C159 (part 5): the cap counts WATCH RECORDS, not raw ones — a music-
// heavy history used to hit it on track plays and drop the oldest VIDEO views
// (the pre-install ones the snapshot exists for). Raw records have their own
// ceiling below the pager's silent 2M, which ALSO reports truncated. A history
// of exactly maxItems records is complete.
test("getPlexWatchHistory: music tracks don't advance the cap; the raw ceiling reports truncated; exactly maxItems is complete", async () => {
  const S = "http://plex-hist5.test:32400";
  const page = [
    { type: "track", ratingKey: "1" }, { type: "track", ratingKey: "2" }, { type: "track", ratingKey: "3" },
    { type: "movie", ratingKey: "10", viewedAt: 1_700_000_000 },
    { type: "movie", ratingKey: "11", viewedAt: 1_699_000_000 },
  ];
  respond = () => mediaContainer(page, { totalSize: page.length });
  const h = await getPlexWatchHistory(S, "t", { maxItems: 2 });
  assert.deepEqual(h.entries.map((e) => e.itemKey), ["10", "11"], "three track plays did not use up a cap of 2");
  assert.equal(h.records, 2);
  assert.equal(h.truncated, false, "exactly maxItems watch records, nothing past them: complete");

  fetchCalls.length = 0;
  const raw = await getPlexWatchHistory(S, "t", { maxItems: 100, maxRaw: 3 });
  assert.equal(raw.truncated, true, "the raw ceiling stops the walk AND says so");
  assert.deepEqual(raw.entries, [], "only the three tracks were read");
  assert.equal(fetchCalls.length, 1);

  fetchCalls.length = 0;
  const capped = await getPlexWatchHistory(S, "t", { maxItems: 1 });
  assert.equal(capped.truncated, true, "a watch record past the cap exists");
  assert.deepEqual(capped.entries.map((e) => e.itemKey), ["10"]);
});

// ── listPlexMatchEntries (the library match check) ──────────────────────────

test("listPlexMatchEntries lists EVERY item of the selected sections — copies, unmatched and legacy items included — with each one's own ids and path", async () => {
  const S = "http://plex-match1.test:32400";
  respond = (url) => {
    if (url.pathname === "/library/sections") {
      return okJson({ MediaContainer: { Directory: [
        { key: "1", title: "Movies", type: "movie" },
        { key: "2", title: "4K Movies", type: "movie" },
        { key: "3", title: "Shows", type: "show" },
      ] } });
    }
    if (url.pathname === "/library/sections/1/all") {
      assert.equal(url.searchParams.get("type"), "1");
      assert.equal(url.searchParams.get("includeGuids"), "1");
      return mediaContainer([
        { type: "movie", ratingKey: "10", title: "Ghost in the Shell", year: 1995, Guid: [{ id: "tmdb://9323" }, { id: "imdb://tt0113568" }], Media: [{ Part: [{ file: "/m/Ghost in the Shell (1995)/a.mkv" }] }] },
        // Same tmdb id, other folder: the sync folds this one into 9323's row; the check must see it.
        { type: "movie", ratingKey: "11", title: "Ghost in the Shell", year: 1995, Guid: [{ id: "tmdb://9323" }], Media: [{ Part: [{ file: "/m/Ghost in the Shell (2017)/b.mkv" }] }] },
        { type: "movie", ratingKey: "12", title: "Unmatched.Rip", Guid: [], Media: [{ Part: [{ file: "/m/Unmatched.Rip.mkv" }] }] },
        { type: "movie", ratingKey: "13", title: "Old Agent", guid: "com.plexapp.agents.imdb://tt0000013?lang=en", Media: [{ Part: [{ file: "/m/Old (1990)/o.mkv" }] }] },
        { type: "collection", ratingKey: "99", title: "A Collection" },
      ], { totalSize: 5 });
    }
    if (url.pathname === "/library/sections/2/all") throw new Error("section 2 was not selected");
    if (url.pathname === "/library/sections/3/all") {
      assert.equal(url.searchParams.get("type"), "2");
      return mediaContainer([
        { type: "show", ratingKey: "20", title: "Doctor Who", year: 2005, Guid: [{ id: "tmdb://57243" }, { id: "tvdb://78804" }], Location: [{ path: "/tv/Doctor Who (2005)" }] },
        { type: "show", ratingKey: "21", title: "No Location", Guid: [{ id: "tvdb://1" }] },
      ], { totalSize: 2 });
    }
    throw new Error(`unexpected ${url}`);
  };
  const movies = await listPlexMatchEntries(S, "tok", "remote", "MOVIE", new Set(["1"]));
  assert.deepEqual(movies.map((e) => [e.itemKey, e.tmdbIds, e.imdbId, e.path, e.legacyPlaced]), [
    ["10", [9323], "tt0113568", "/m/Ghost in the Shell (1995)/a.mkv", false],
    ["11", [9323], null, "/m/Ghost in the Shell (2017)/b.mkv", false],
    ["12", [], null, "/m/Unmatched.Rip.mkv", false],
    ["13", [], "tt0000013", "/m/Old (1990)/o.mkv", true],
  ]);
  assert.ok(movies.every((e) => e.server === "plex" && e.serverInstance === "remote" && e.mediaType === "MOVIE"));
  assert.equal(movies[0].year, 1995);

  const shows = await listPlexMatchEntries(S, "tok", "", "TV");
  assert.deepEqual(shows.map((e) => [e.itemKey, e.tmdbIds, e.tvdbId, e.path]), [
    ["20", [57243], 78804, "/tv/Doctor Who (2005)"],
    ["21", [], 1, null],
  ]);
});

test("getPlexWatchHistory stopBefore (watch sync): the first DATED record older than the bound ends the walk; it and everything after are dropped; undated records never stop it", async () => {
  const S = "http://plex-hist-stop.test:32400";
  respond = (url) => {
    const start = Number(url.searchParams.get("X-Plex-Container-Start"));
    if (start === 0) {
      return mediaContainer([
        { type: "movie", ratingKey: "1", viewedAt: 1_700_000_300 },
        { type: "movie", ratingKey: "2" },
        { type: "movie", ratingKey: "3", viewedAt: 1_700_000_200 },
        { type: "movie", ratingKey: "4", viewedAt: 1_700_000_099 },
        { type: "movie", ratingKey: "5", viewedAt: 1_700_000_500 },
      ], { totalSize: 10 });
    }
    throw new Error("no second page: the stop ends the walk");
  };
  const h = await getPlexWatchHistory(S, "t", { stopBefore: new Date(1_700_000_100 * 1000) });
  assert.equal(fetchCalls.length, 1);
  assert.deepEqual(h.entries.map((e) => e.itemKey), ["1", "2", "3"]);
  assert.equal(h.truncated, false);
});

// ── watch sync, Jellyfin → Plex: per-user token parsers (plex.ts) ─────────────
const { parsePlexSharedServerTokens, parsePlexHomeSwitchToken } = await import("../src/lib/plex.ts");

test("parsePlexSharedServerTokens: userID → accessToken per SharedServer; malformed ids/tokens are dropped", () => {
  const xml = `<MediaContainer size="3">
    <SharedServer id="1" username="a" userID="101" accessToken="tokA_123456"><Section key="1"/></SharedServer>
    <SharedServer id="2" username="b" userID="abc" accessToken="tokB_123456"/>
    <SharedServer id="3" username="c" userID="103" accessToken="bad token"/>
  </MediaContainer>`;
  assert.deepEqual([...parsePlexSharedServerTokens(xml)], [["101", "tokA_123456"]]);
  assert.equal(parsePlexSharedServerTokens("<MediaContainer/>").size, 0);
});

test("parsePlexHomeSwitchToken: XML authenticationToken / authToken, or JSON authToken; anything else is null", () => {
  assert.equal(parsePlexHomeSwitchToken(`<user id="9" authenticationToken="homeTok_1234"/>`), "homeTok_1234");
  assert.equal(parsePlexHomeSwitchToken(`<user id="9" authToken="homeTok_5678"></user>`), "homeTok_5678");
  assert.equal(parsePlexHomeSwitchToken(`{"authToken":"jsonTok_1234"}`), "jsonTok_1234");
  assert.equal(parsePlexHomeSwitchToken(`<user id="9"/>`), null);
  assert.equal(parsePlexHomeSwitchToken(`{"authToken":"x"}`), null, "too short to be a token");
  assert.equal(parsePlexHomeSwitchToken("not xml"), null);
});

test("parsePlexInProgress: movies and episodes with a resume point; an up-next episode (no viewOffset) and junk are dropped", async () => {
  const { parsePlexInProgress } = await import("../src/lib/plex.ts");
  const out = parsePlexInProgress([
    { type: "movie", ratingKey: "12", viewOffset: 720000, duration: 6000000, lastViewedAt: 1700000000, viewCount: 0 },
    { type: "episode", ratingKey: 191, grandparentRatingKey: "19", parentIndex: 1, index: 2, viewOffset: "60000" },
    { type: "episode", ratingKey: "192", grandparentRatingKey: "19", parentIndex: 1, index: 3 },
    { type: "track", ratingKey: "5", viewOffset: 10 },
    { type: "movie", ratingKey: "x1", viewOffset: 10 },
  ]);
  assert.deepEqual(out.map((i) => [i.kind, i.ratingKey, i.showKey, i.seasonNumber, i.episodeNumber, i.state.viewOffset]), [
    ["movie", "12", null, null, null, 720000],
    ["episode", "191", "19", 1, 2, 60000],
  ]);
  assert.deepEqual(out[0].state.lastViewedAt, new Date(1700000000 * 1000));
});

// ── tmdb guid parsing ─────────────────────────────────────────────────────────

test("parseTmdbGuid: only tmdb://<positive digits> as a string; extractTmdbIdFromGuids skips junk entries and finds a later valid one", () => {
  assert.equal(parseTmdbGuid("tmdb://603"), 603);
  for (const bad of [603, "tmdb://0", "tmdb://12abc", "tmdb://-5", "tmdb://12345678901", null, undefined, {}]) {
    assert.equal(parseTmdbGuid(bad), null, String(bad));
  }
  const junk = [{ id: 603 }, { id: "tmdb://0" }, { id: "tmdb://12abc" }, null, {}];
  assert.equal(extractTmdbIdFromGuids(junk as never), null);
  assert.equal(extractTmdbIdFromGuids([...junk, { id: "tmdb://604" }] as never), 604);
  assert.equal(extractTmdbIdFromGuids("tmdb://603" as never), null, "a Guid that is not an array is no guid");
});

test("the library walk skips a Guid entry without a string id instead of throwing on it", async () => {
  const S = "http://plex-guid-junk.test:32400";
  respond = () => mediaContainer([
    { ratingKey: "1", title: "Junk then good", Guid: [{ id: 7 }, { id: "tmdb://70" }] },
    { ratingKey: "2", title: "Not an array", Guid: { id: "tmdb://80" } },
    { ratingKey: "3", title: "Zero", Guid: [{ id: "tmdb://0" }] },
  ], { totalSize: 3 });
  const items = await getPlexSectionTmdbIds(S, "t", "1", "movie");
  assert.deepEqual([...items.keys()], [70]);
});

// ── server address normalization ─────────────────────────────────────────────

test("a server address ending in slashes never doubles them: sections and sessions are requested at the clean path", async () => {
  const S = "http://plex-slashes.test:32400";
  respond = (url) => url.pathname === "/library/sections"
    ? okJson({ MediaContainer: { Directory: [] } })
    : okJson({ MediaContainer: {} });
  await getPlexLibrarySections(`${S}//`, "t");
  await getPlexSessions(`${S}//`, "t");
  assert.deepEqual(fetchCalls.map((c) => c.raw), [`${S}/library/sections`, `${S}/status/sessions?includeGuids=1`]);
});

test("getPlexSessions with no MediaContainer is a failed read, never 'nothing is playing'", async () => {
  respond = () => okJson({});
  await assert.rejects(() => getPlexSessions("http://plex-sess-nocontainer.test:32400", "t"), /no MediaContainer/);
});

// ── abort reaches the in-flight page ─────────────────────────────────────────

test("getPlexWatchHistory: an abort while a page answers 503 makes one fetch, never retries, and resolves with what it read", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const S = "http://plex-hist-abort-503.test:32400";
  const controller = new AbortController();
  respond = () => {
    controller.abort();
    return okJson({ error: "busy" }, 503);
  };
  const p = getPlexWatchHistory(S, "t", { signal: controller.signal });
  for (const ms of [2_000, 4_000, 6_000]) { await flush(); t.mock.timers.tick(ms); }
  const h = await p;
  assert.equal(fetchCalls.length, 1, "no retry once the signal has fired (guardrail 41)");
  assert.deepEqual(warns.filter((w) => w.includes("[plex] retry")), [], "no retry attempt at all");
  assert.deepEqual(h, { entries: [], records: 0, truncated: false, aborted: true });
});

test("an abort DURING a retry's backoff ends the walk there: no further attempt", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const S = "http://plex-hist-abort-sleep.test:32400";
  const controller = new AbortController();
  respond = () => okJson({ error: "busy" }, 503);
  let settled = false;
  const p = getPlexWatchHistory(S, "t", { signal: controller.signal }).finally(() => { settled = true; });
  await flush();
  assert.equal(fetchCalls.length, 1, "the first attempt failed; the retry waits out its backoff");
  controller.abort();
  await flush();
  assert.equal(settled, true, "the abort ends the backoff at once — no timer has to run out");
  for (const ms of [2_000, 4_000, 6_000]) { await flush(); t.mock.timers.tick(ms); }
  const h = await p;
  assert.equal(fetchCalls.length, 1, "the backoff ended with the abort and no retry was sent");
  assert.deepEqual(warns.filter((w) => w.includes("[plex] retry")), [], "no retry attempt at all — not even one safe-fetch refuses");
  assert.equal(h.aborted, true);
});

test("getPlexWatchHistory hands its signal to the request itself", async () => {
  const S = "http://plex-hist-signal.test:32400";
  let seen: AbortSignal | null | undefined;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen = init?.signal;
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    const controller = new AbortController();
    respond = () => mediaContainer([], { totalSize: 0 });
    await getPlexWatchHistory(S, "t", { signal: controller.signal });
    assert.ok(seen, "the request carries a signal");
    controller.abort();
    assert.equal(seen?.aborted, true, "aborting the caller's signal aborts the request's");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── intro markers ────────────────────────────────────────────────────────────

test("getPlexMarkers merges several intro markers to the earliest start and latest end, whatever order Plex lists them in", async () => {
  const S = "http://plex-mark-intro.test:32400";
  const intros = [
    { type: "intro", startTimeOffset: 300_000, endTimeOffset: 330_000 },
    { type: "intro", startTimeOffset: 5_000, endTimeOffset: 95_000 },
  ];
  for (const order of [intros, [...intros].reverse()]) {
    respond = () => mediaContainer([{ Marker: order }]);
    assert.deepEqual(await getPlexMarkers(S, "t", "1"), { introStartMs: 5_000, introEndMs: 330_000 });
  }
});

// ── hasPlexItemByTmdbId: the recently-added check ───────────────────────────

test("hasPlexItemByTmdbId: when the guid filter answers none, the section's newest additions are matched on their tmdb guids", async () => {
  const S = "http://plex-has-recent.test:32400";
  const sections = [{ key: "3", title: "Movies", type: "movie" as const }];
  let recent: unknown[] = [];
  respond = (url) => url.pathname === "/library/sections/3/all"
    ? okJson({ MediaContainer: { totalSize: 0, size: 0 } })
    : mediaContainer(recent);

  recent = [
    { ratingKey: "1", type: "movie", Guid: [{ id: "imdb://tt1" }, { id: "tmdb://111" }] },
    { ratingKey: "2", type: "movie", Guid: [{ id: "plex://movie/x" }, { id: "tmdb://550" }] },
  ];
  assert.equal(await hasPlexItemByTmdbId(S, "t", 550, "movie", sections), true);
  assert.deepEqual(fetchCalls.map((c) => c.raw), [
    `${S}/library/sections/3/all?type=1&includeGuids=1&guid=tmdb://550&X-Plex-Container-Start=0&X-Plex-Container-Size=1`,
    `${S}/library/sections/3/recentlyAdded?type=1&includeGuids=1&X-Plex-Container-Start=0&X-Plex-Container-Size=200`,
  ]);

  recent = [{ ratingKey: "1", type: "movie", Guid: [{ id: "tmdb://111" }] }];
  assert.equal(await hasPlexItemByTmdbId(S, "t", 550, "movie", sections), false);

  respond = (url) => url.pathname === "/library/sections/3/all"
    ? okJson({ MediaContainer: { totalSize: 0 } })
    : okJson({ error: "boom" }, 500);
  assert.equal(await hasPlexItemByTmdbId(S, "t", 550, "movie", sections), false, "a failed second read is 'not yet', never a throw");
});

// ── plex.tv /api/users parsing ───────────────────────────────────────────────

test("plex.tv user XML is entity-decoded: an o'brien address reaches the allowlist and the account list as typed", async () => {
  const S = "http://plex-entities.test:32400";
  respond = (url) => {
    if (url.pathname === "/identity") return okJson({ MediaContainer: { machineIdentifier: "machine-ours" } });
    if (url.pathname === "/api/v2/user") return okJson({ id: 1, email: "owner@example.com", username: "owner" });
    if (url.pathname === "/api/users") {
      return xmlResponse(
        `<MediaContainer size="2">` +
        `<User id="7" title="Tom &amp; Jerry" email="O&apos;Brien@X.com" thumb="https://plex.tv/u?a=1&amp;b=2"><Server machineIdentifier="machine-ours"/></User>` +
        `<User id="8" title="q&#34;uote&#x21;" email="other@example.com"><Server name="a &gt; b" machineIdentifier="machine-other"/></User>` +
        `</MediaContainer>`,
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const members = await getPlexFriendEmails("admin-tok", S);
  assert.deepEqual(members, { ids: new Set(["7"]), emails: new Set(["o'brien@x.com"]) });
  const { accounts } = await getPlexAccountsDetailed("admin-tok");
  assert.deepEqual(accounts.slice(1), [
    { id: "7", name: "Tom & Jerry", email: "o'brien@x.com", thumb: "https://plex.tv/u?a=1&b=2", isAdmin: false },
    { id: "8", name: 'q"uote!', email: "other@example.com", thumb: "", isAdmin: false },
  ]);
});

test("countPlexServerMembers counts this server's friends plus the owner, and is null when the server or plex.tv can't answer", async () => {
  const S = "http://plex-count.test:32400";
  let usersStatus = 200;
  let machine: string | null = "machine-ours";
  respond = (url) => {
    if (url.pathname === "/identity") return machine ? okJson({ MediaContainer: { machineIdentifier: machine } }) : okJson({ error: "x" }, 500);
    if (url.pathname === "/api/users") {
      if (usersStatus !== 200) return new Response("no", { status: usersStatus });
      return xmlResponse(
        `<MediaContainer>` +
        `<User id="1" title="a"><Server machineIdentifier="machine-ours"/></User>` +
        `<User id="2" title="b"><Server machineIdentifier="machine-other"/></User>` +
        `</MediaContainer>`,
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  assert.equal(await countPlexServerMembers("tok", S), 2, "one friend of this server + the owner; the other server's friend is not counted");
  usersStatus = 401;
  assert.equal(await countPlexServerMembers("tok", S), null);
  usersStatus = 200;
  machine = null;
  assert.equal(await countPlexServerMembers("tok", S), null);
});

// ── home user switch ─────────────────────────────────────────────────────────

test("getPlexHomeUserToken: a 429 is an error (a rate limit says nothing about the user); another 4xx is 'no token'", async () => {
  const { getPlexHomeUserToken } = await import("../src/lib/plex.ts");
  respond = () => new Response("slow down", { status: 429 });
  await assert.rejects(() => getPlexHomeUserToken("admin", "888"), /rate-limited \(429\)/);
  respond = () => new Response("pin", { status: 403 });
  assert.equal(await getPlexHomeUserToken("admin", "888"), null);
});

// ── payload checks and the copy rule ─────────────────────────────────────────

test("a duplicated title's stored copy does not depend on the order Plex lists its copies: newest addedAt, then the greater ratingKey", async () => {
  const copies = [
    { type: "movie", ratingKey: "300", title: "Older", addedAt: 1_700_000_000, Guid: [{ id: "tmdb://30" }] },
    { type: "movie", ratingKey: "301", title: "Newer", addedAt: 1_700_000_500, Guid: [{ id: "tmdb://30" }] },
    { type: "movie", ratingKey: "299", title: "Undated", Guid: [{ id: "tmdb://30" }] },
  ];
  const { plexLibraryRatingKeys } = await import("../src/lib/plex.ts");
  for (const order of [copies, [...copies].reverse(), [copies[1], copies[2], copies[0]]]) {
    respond = () => mediaContainer(order, { totalSize: order.length });
    const items = await getPlexSectionTmdbIds("http://plex-copy-order.test:32400", "t", "1", "movie");
    assert.equal(items.get(30)!.title, "Newer", "the newest copy wins inside a section, whatever the page order");
    assert.deepEqual(plexLibraryRatingKeys(items.get(30)!), ["301", "299", "300"]);
  }

  // Across sections the same rule decides, whichever section is listed first.
  const sectionsOf = (first: string) => [
    { key: first, title: "A", type: "movie" as const },
    { key: first === "1" ? "2" : "1", title: "B", type: "movie" as const },
  ];
  respond = (url) => url.pathname === "/library/sections/1/all"
    ? mediaContainer([{ type: "movie", ratingKey: "10", title: "In one", addedAt: 1_700_000_000, Guid: [{ id: "tmdb://40" }] }], { totalSize: 1 })
    : mediaContainer([{ type: "movie", ratingKey: "20", title: "In two", addedAt: 1_700_000_900, Guid: [{ id: "tmdb://40" }] }], { totalSize: 1 });
  for (const first of ["1", "2"]) {
    const combined = await getPlexTmdbIds("http://plex-copy-sections.test:32400", "t", "MOVIE", { sections: sectionsOf(first) });
    assert.equal(combined.get(40)!.title, "In two");
    assert.deepEqual(plexLibraryRatingKeys(combined.get(40)!), ["20", "10"]);
  }
});

test("getPlexLibrarySections: a 2xx without a MediaContainer is a clear failure, not retried", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  respond = () => okJson({ error: "not plex" });
  const done = assert.rejects(getPlexLibrarySections("http://plex-sec-nocontainer.test:32400", "t"), /Plex sections: no MediaContainer/);
  for (const ms of [2_000, 4_000, 6_000]) { await flush(); t.mock.timers.tick(ms); }
  await done;
  assert.equal(fetchCalls.length, 1);
});

test("tmdb ids outside INT4 range are no ids, on the modern Guid and the legacy guid string alike", async () => {
  assert.equal(parseTmdbGuid("tmdb://2147483647"), 2147483647);
  assert.equal(parseTmdbGuid("tmdb://2147483648"), null);
  respond = () => mediaContainer([
    { type: "movie", ratingKey: "1", guid: "com.plexapp.agents.themoviedb://0?lang=en" },
    { type: "movie", ratingKey: "2", guid: "com.plexapp.agents.themoviedb://99999999999?lang=en" },
    { type: "movie", ratingKey: "3", guid: "com.plexapp.agents.themoviedb://605?lang=en" },
    { type: "movie", ratingKey: "4", Guid: [{ id: "tmdb://2147483648" }] },
  ], { totalSize: 4 });
  const items = await getPlexSectionTmdbIds("http://plex-int4.test:32400", "t", "1", "movie");
  assert.deepEqual([...items.keys()], [605]);
});

test("getPlexWatchHistory: a malformed account id throws before any request — the filter is never dropped to read every account", async () => {
  const S = "http://plex-hist-account.test:32400";
  await assert.rejects(() => getPlexWatchHistory(S, "t", { accountId: "1 OR 2" }), /Invalid Plex account id/);
  await assert.rejects(() => getPlexWatchHistory(S, "t", { accountId: "" }), /Invalid Plex account id/);
  assert.equal(fetchCalls.length, 0);

  respond = () => mediaContainer([], { totalSize: 0 });
  await getPlexWatchHistory(S, "t", { accountId: "5" });
  assert.equal(fetchCalls[0].url.searchParams.get("accountID"), "5");
});

test("getPlexWatchHistory: a record the previous page already returned (the list grew mid-walk) counts once", async () => {
  const S = "http://plex-hist-dedupe.test:32400";
  const mv = (id: number, extra: Record<string, unknown> = {}) => ({ type: "movie", ratingKey: String(id), viewedAt: 1_700_000_000 - id, accountID: 1, ...extra });
  respond = (url) => {
    const start = Number(url.searchParams.get("X-Plex-Container-Start"));
    if (start === 0) return mediaContainer(Array.from({ length: 1000 }, (_, i) => mv(i + 1)), { totalSize: 2000 });
    // Two views landed: this page repeats the previous page's last two records.
    if (start === 1000) return mediaContainer(Array.from({ length: 1000 }, (_, i) => mv(i + 999)), { totalSize: 2002 });
    if (start === 2000) return mediaContainer([mv(1999), mv(2000)], { totalSize: 2002 });
    throw new Error(`unexpected page start=${start}`);
  };
  const h = await getPlexWatchHistory(S, "t");
  assert.equal(h.entries.filter((e) => e.itemKey === "999").length, 1);
  assert.equal(h.entries.filter((e) => e.itemKey === "1000").length, 1);
  assert.equal(h.records, 2000, "every play once");

  // Plex's own historyKey is the identity when present: the same item and
  // second under two history keys are two plays.
  fetchCalls.length = 0;
  respond = (url) => Number(url.searchParams.get("X-Plex-Container-Start")) === 0
    ? mediaContainer([mv(1, { historyKey: "/status/sessions/history/9" })], { totalSize: 2 })
    : mediaContainer([mv(1, { historyKey: "/status/sessions/history/8" })], { totalSize: 2 });
  const twice = await getPlexWatchHistory(S, "t");
  assert.equal(twice.records, 2);
});

test("getPlexUserStates: a transient 5xx on one chunk is retried, so the states already read are kept; no MediaContainer is a failed read", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { getPlexUserStates } = await import("../src/lib/plex.ts");
  const S = "http://plex-states.test:32400";
  const keys = Array.from({ length: 60 }, (_, i) => String(i + 1));
  let failedOnce = false;
  respond = (url) => {
    const asked = url.pathname.replace("/library/metadata/", "").split(",");
    if (asked.includes("51") && !failedOnce) {
      failedOnce = true;
      return okJson({ error: "busy" }, 503);
    }
    return mediaContainer(asked.map((k) => ({ ratingKey: k, viewCount: 1 })));
  };
  const p = getPlexUserStates(S, "t", keys);
  for (let i = 0; i < 5; i++) { await flush(); t.mock.timers.tick(2_000); }
  const states = await p;
  assert.equal(states.size, 60, "the second chunk's retry answered; the first chunk's states survived");
  assert.ok(warns.some((w) => w.includes("[plex] retry 1/3")));

  respond = () => okJson({ error: "not plex" });
  await assert.rejects(getPlexUserStates(S, "t", ["1"]), /no MediaContainer/);
});

test("getPlexHomeUserToken: a 401 is the ADMIN token refused — an error, never 'no token for this user'", async () => {
  const { getPlexHomeUserToken } = await import("../src/lib/plex.ts");
  respond = () => new Response("unauthorized", { status: 401 });
  await assert.rejects(() => getPlexHomeUserToken("admin", "888"), /refused the server's admin token \(401\)/);
});

test("the library walk takes a signal: an abort between pages rejects (never a partial library) and sends no further page", async () => {
  const S = "http://plex-walk-abort.test:32400";
  const controller = new AbortController();
  respond = () => {
    controller.abort();
    return mediaContainer(Array.from({ length: 1000 }, (_, i) => ({ type: "movie", ratingKey: String(i + 1), Guid: [{ id: `tmdb://${i + 1}` }] })), { totalSize: 3000 });
  };
  await assert.rejects(getPlexSectionTmdbIds(S, "t", "1", "movie", { signal: controller.signal }));
  assert.equal(fetchCalls.length, 1);

  fetchCalls.length = 0;
  const episodes = new AbortController();
  episodes.abort();
  await assert.rejects(getPlexTVEpisodes(S, "t", undefined, undefined, undefined, undefined, { signal: episodes.signal }));
  assert.equal(fetchCalls.length, 0, "an aborted episode walk lists no sections");
});

test("getPlexSessions: Metadata that is not a list is a failed read; an odd field degrades without hiding the session", async () => {
  const S = "http://plex-sess-shape.test:32400";
  respond = () => okJson({ MediaContainer: { Metadata: { sessionKey: "1" } } });
  await assert.rejects(() => getPlexSessions(S, "t"), /no MediaContainer/);

  respond = () => mediaContainer([
    null,
    { sessionKey: 12, User: { id: 42, title: 7 }, duration: "long", viewOffset: 1.5, Player: "Living Room", Media: "none", Guid: [null, { id: "tmdb://5" }] },
  ]);
  const sessions = await getPlexSessions(S, "t");
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionKey, "12", "a numeric sessionKey reads as its string");
  assert.equal(sessions[0].accountId, "42");
  assert.equal(sessions[0].accountName, "");
  assert.equal(sessions[0].duration, 0);
  assert.equal(sessions[0].viewOffset, 1);
  assert.equal(sessions[0].state, "playing");
  assert.equal(extractTmdbIdFromGuids(sessions[0].Guid), 5);
});
