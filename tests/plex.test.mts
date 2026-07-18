// Unit tests for the Plex API client (src/lib/plex.ts) — the HTTP layer between
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
//     sections enrich filePath from one /allLeaves episode per show and degrade
//     (filePath null) when the leaf fetch fails; multi-section combine is
//     first-seen-wins and selectedKeys narrows the fan-out;
//   - getPlexTVEpisodes/getPlexEpisodesForShow: season/episode mapping with the
//     specials/zero/non-integer filters and per-key dedup; shows without a tmdb
//     guid contribute nothing, and an all-unresolvable section skips the
//     episode page entirely;
//   - getPlexSessions: the EXACT PlexSessionData shape the play-history poller
//     consumes (full deepEqual), episode title composition, the DirectPlay/
//     DirectStream/Transcode decision + humanized transcodeReason, "0"/"1"/
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
//   - getPlexAccounts/getPlexMachineId/getPlexFriendEmails: DIRECT-call
//     contracts only — owner-first ordering, XML attribute parsing with
//     lowercased emails, per-hop warn-and-continue degradation, the machineId
//     null contract, the no-serverUrl refusal, and the non-2xx THROW from
//     getPlexFriendEmails. The caller-side swallow/cache/allowlist behavior is
//     pinned in tests/plex-membership.test.mts — kept complementary here, not
//     duplicated. refreshPlexSection is likewise skipped: library-scan.test.mts
//     already pins it through its only caller.
//
// No DB (plex.ts's only import is safe-fetch — prisma never loads) and no
// network/DNS: globalThis.fetch is scripted per URL and dns/promises.lookup is
// stubbed to a PUBLIC address (plex.tv goes through safeFetchTrusted, which
// rejects private answers; the admin-configured server host accepts public
// too). Server URLs use a unique fake hostname per test — the SSRF dnsCache in
// ssrf.ts is module-global, so hostname reuse across tests would serve a cached
// entry instead of exercising the stub.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

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

// Dynamic import so the stubs above genuinely precede the module-graph load
// (static imports would hoist above them).
const {
  PLEX_CLIENT_ID,
  pingPlexToken,
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
  getPlexAccounts,
  getPlexMachineId,
  getPlexFriendEmails,
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
  // parseInt trailing-junk tolerance — pinned as CURRENT behavior.
  assert.equal(extractTmdbIdFromGuids([{ id: "tmdb://12?lang=en" }]), 12);
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

  respond = () => okJson({ error: "boom" }, 500);
  await assert.rejects(() => getPlexLibrarySections(S, "t"), /Plex sections: 500/);
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

  const items = await getPlexSectionTmdbIds(S, "t", "5", "movie", false);
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

  const items = await getPlexSectionTmdbIds(S, "t", "1", "movie", false);
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

  const items = await getPlexSectionTmdbIds(S, "t", "1", "movie", false);
  assert.deepEqual([...items.keys()], [7]);
  assert.equal(fetchCalls.length, 2, "must fetch a second page rather than trust container.size as the total");
});

test("getPlexSectionTmdbIds show sections: recentlyAdded path, allLeaves filePath enrichment, and per-show leaf-failure degradation", async () => {
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
    if (url.pathname === "/library/metadata/201/allLeaves") {
      return okJson({
        MediaContainer: { Metadata: [{ Media: [{ Part: [{ file: "/tv/Show A/S01E01.mkv" }] }] }] },
      });
    }
    if (url.pathname === "/library/metadata/202/allLeaves") return okJson({ error: "boom" }, 500);
    if (url.pathname === "/library/metadata/203/allLeaves") throw new Error("socket hangup");
    throw new Error(`unexpected fetch ${url}`);
  };

  const items = await getPlexSectionTmdbIds(S, "t", "9", "show", true);
  // recentOnly=true routes to /recentlyAdded; shows use type=2.
  assert.equal(
    fetchCalls[0].raw,
    `${S}/library/sections/9/recentlyAdded?type=2&includeGuids=1&X-Plex-Container-Start=0&X-Plex-Container-Size=1000`,
  );
  // One single-episode leaf probe per show, capped to one item.
  const leaf = fetchCalls.find((c) => c.url.pathname === "/library/metadata/201/allLeaves");
  assert.ok(leaf);
  assert.equal(leaf.raw, `${S}/library/metadata/201/allLeaves?X-Plex-Container-Start=0&X-Plex-Container-Size=1`);

  assert.equal(items.get(100)?.filePath, "/tv/Show A/S01E01.mkv");
  assert.equal(items.get(200)?.filePath, null, "a 500 leaf response leaves filePath null");
  assert.equal(items.get(300)?.filePath, null, "a thrown leaf fetch is swallowed and leaves filePath null");
});

test("getPlexSectionTmdbIds error shapes: a non-2xx page and a missing MediaContainer both throw with the page offset", async () => {
  const S = "http://plex-err1.test:32400";
  respond = () => okJson({ error: "boom" }, 500);
  await assert.rejects(
    () => getPlexSectionTmdbIds(S, "t", "1", "movie", false),
    /Plex paginated fetch failed: 500 at start=0/,
  );

  respond = () => okJson({});
  await assert.rejects(
    () => getPlexSectionTmdbIds(S, "t", "1", "movie", false),
    /returned no MediaContainer at start=0/,
  );
});

// ── getPlexTmdbIds ──────────────────────────────────────────────────────────

test("getPlexTmdbIds lists sections, fans out over matching types only, and combines first-seen-wins", async () => {
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
  assert.equal(combined.get(10)?.title, "From One", "a tmdbId in two sections keeps the first-seen entry");
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
  const combined = await getPlexTmdbIds(S, "t", "MOVIE", false, new Set(["2"]), sections);
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
          { grandparentRatingKey: "301", parentIndex: 1, index: 1 },
          { grandparentRatingKey: "301", parentIndex: 1, index: 1 }, // duplicate → deduped
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
    { tmdbId: 1399, seasonNumber: 1, episodeNumber: 1 },
    { tmdbId: 1399, seasonNumber: 2, episodeNumber: 3 },
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

test("getPlexEpisodesForShow pages the show's allLeaves and stamps the caller's tmdbId onto valid episodes", async () => {
  const S = "http://plex-leaf1.test:32400";
  respond = (url) => {
    if (url.pathname === "/library/metadata/444/allLeaves") {
      return mediaContainer(
        [
          { parentIndex: 1, index: 2 },
          { parentIndex: 0, index: 1 }, // specials → dropped
          { index: 3 }, // missing season → dropped
          { parentIndex: 3, index: 4 },
        ],
        { totalSize: 4 },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const episodes = await getPlexEpisodesForShow(S, "t", "444", 777);
  assert.deepEqual(episodes, [
    { tmdbId: 777, seasonNumber: 1, episodeNumber: 2 },
    { tmdbId: 777, seasonNumber: 3, episodeNumber: 4 },
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
  assert.equal(ep.transcodeReason, "Video codec not supported, Subtitle burn-in");
  assert.equal(ep.videoDecision, "transcode");
  assert.equal(ep.audioDecision, "copy");
  assert.equal(ep.parentIndex, 1);
  assert.equal(ep.index, 2);

  assert.equal(copied.playMethod, "DirectStream");
  assert.equal(copied.transcodeReason, undefined);

  assert.equal(audio.playMethod, "Transcode");
  assert.equal(audio.transcodeReason, "Audio codec not supported");
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

  // Section listing itself fails → no sections → false, no throw.
  respond = () => okJson({ error: "down" }, 500);
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

// ── getPlexAccounts ─────────────────────────────────────────────────────────

test("getPlexAccounts returns the owner first (real plex.tv id, isAdmin) then XML shared users with lowercased emails and defaults", async () => {
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

  const accounts = await getPlexAccounts("http://unused.invalid:32400", "admin-tok");
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

test("getPlexAccounts hops degrade independently: owner failure keeps shared users, shared-users failure keeps the owner — each with a [plex] warn", async () => {
  // Owner fetch fails → warn, shared users still parsed.
  respond = (url) => {
    if (url.pathname === "/api/v2/user") return okJson({ error: "denied" }, 500);
    if (url.pathname === "/api/users") {
      return xmlResponse(`<MediaContainer size="1"><User id="60" title="solo" email="solo@example.com"></User></MediaContainer>`);
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  assert.deepEqual(await getPlexAccounts("http://unused.invalid:32400", "tok"), [
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
  const ownerOnly = await getPlexAccounts("http://unused.invalid:32400", "tok");
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

test("getPlexFriendEmails without a serverUrl refuses with an empty set and a [plex] warn — zero upstream traffic", async () => {
  assert.deepEqual(await getPlexFriendEmails("admin-tok"), new Set());
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
  const emails = await getPlexFriendEmails("admin-tok", S);
  // Only the friend shared on OUR machineIdentifier with a valid email
  // survives, lowercased. Other-server friends, invalid emails, and
  // email-less blocks are all dropped.
  assert.deepEqual(emails, new Set(["friend@example.com"]));
});
