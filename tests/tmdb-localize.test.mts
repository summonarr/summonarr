// Unit tests for the TMDB content-language overlay (src/lib/tmdb-localize.ts)
// and its tmdb.ts halves (fetchTitleTranslations, getTVSeasonEpisodesLocalized,
// language-keyed genre lists).
//
// Pins:
//  - English is a no-op: the SAME array back, zero cache reads, zero fetches —
//    an English instance and every existing test stay byte-identical;
//  - a cached translation overlays title/overview/tagline, each field falling
//    back to English independently; a title in the viewer's own language uses
//    TMDB's original title and drops the now-redundant "Original title";
//  - a miss is fetched from /translations ONCE (coalesced across duplicate
//    items), trimmed to our locales with region preference field by field
//    (es-ES before es-MX), never Traditional Chinese for "zh", and cached —
//    including the empty answer, so an untranslated title isn't re-fetched;
//  - a failing fetch leaves items in English and never throws;
//  - detail-row genres are renamed by id from the localized genre list, which is
//    cached under its own key (the English key is untouched);
//  - a localized season keeps the English overview where TMDB's is blank, and
//    hands back the English list it merged over — the only one a caller may
//    STORE (guardrail 40a: TVEpisodeCache is shared by every viewer);
//  - the process-wide in-flight cap (guardrail 31) holds under the wake-up race:
//    a finishing fetch HANDS its slot to the parked waiter, so a caller arriving
//    in the microtask between the hand-off and the waiter's resumption parks
//    too. Release-then-wake let that newcomer take the freed slot and the woken
//    waiter then ran on top of it — one over the cap per woken waiter. Pinned
//    on the primitive (deterministic microtask placement) and end to end
//    through the prewarm + a concurrent biography read, sweeping the newcomer's
//    arrival across every microtask offset so the pin survives internal
//    refactors that shift the chains by a tick.
//
// No DB or network: prisma.tmdbCache is an in-memory map, fetch is scripted,
// dns.lookup is stubbed (the tests/tmdb.test.mts harness).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.TMDB_READ_TOKEN = "test-tmdb-read-token";

const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

const warns: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const {
  localizeMedia,
  cachedLocalizedTitles,
  titleResolver,
  localizedTitleFor,
  localizeStoredTitles,
  localizedCollectionName,
  nonEnglishInUse,
  localizedBiography,
  prewarmTitleTranslations,
  createInFlightLimiter,
  MAX_IN_FLIGHT,
} = await import("../src/lib/tmdb-localize.ts");
const { getTVSeasonEpisodesLocalized, tmdbLanguageFor, getMovieGenres } = await import("../src/lib/tmdb.ts");

type CacheRow = { key: string; data: string; cachedAt: Date; expiresAt: Date };
const cacheRows = new Map<string, CacheRow>();
let cacheReads = 0;
const far = () => new Date(Date.now() + 86_400_000);
const seed = (key: string, value: unknown) =>
  cacheRows.set(key, { key, data: JSON.stringify(value), cachedAt: new Date(), expiresAt: far() });
// Accounts and their stored languages, for the notification and prewarm paths.
let users: { id: string; locale: string | null; deactivatedAt: Date | null }[] = [];
shadowPrismaModel(prisma, "user", {
  findMany: async (args: { where: { id: { in: string[] } } }) => {
    return users.filter((u) => args.where.id.in.includes(u.id));
  },
  count: async () => users.filter((u) => !u.deactivatedAt && u.locale && u.locale !== "en").length,
});
// Setting rows (the content-locale "seen" stamps).
const settingRows = new Map<string, string>();
const settingUpserts: string[] = [];
shadowPrismaModel(prisma, "setting", {
  findMany: async (args: { where: { key: { startsWith: string } } }) =>
    [...settingRows].filter(([k]) => k.startsWith(args.where.key.startsWith)).map(([key, value]) => ({ key, value })),
  upsert: async (args: { where: { key: string }; create: { key: string; value: string } }) => {
    settingUpserts.push(args.where.key);
    settingRows.set(args.where.key, args.create.value);
    return args.create;
  },
});
let library: { tmdbId: number; mediaType: string }[] = [];
let requests: { tmdbId: number; mediaType: string }[] = [];
shadowPrismaModel(prisma, "plexLibraryItem", { findMany: async () => library });
shadowPrismaModel(prisma, "jellyfinLibraryItem", { findMany: async () => [] });
shadowPrismaModel(prisma, "mediaRequest", { findMany: async () => requests });
shadowPrismaModel(prisma, "watchlistItem", { findMany: async () => [] });

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
// The in-flight race test parks ONE title's cache write here so it can place
// that fetch's slot hand-off at a known distance from a newcomer's arrival.
let gatedUpsertKey: string | null = null;
let upsertGate: Deferred<void> | null = null;
let upsertGateReached = false;

shadowPrismaModel(prisma, "tmdbCache", {
  findUnique: async (args: { where: { key: string } }) => {
    cacheReads++;
    return cacheRows.get(args.where.key) ?? null;
  },
  findMany: async (args: { where: { key: { in: string[] } } }) => {
    cacheReads++;
    return args.where.key.in.flatMap((k) => (cacheRows.has(k) ? [cacheRows.get(k)!] : []));
  },
  upsert: async (args: { where: { key: string }; create: CacheRow }) => {
    if (upsertGate && args.where.key === gatedUpsertKey) {
      upsertGateReached = true;
      await upsertGate.promise;
    }
    cacheRows.set(args.where.key, args.create);
    return args.create;
  },
  deleteMany: async () => ({ count: 0 }),
});

const fetched: URL[] = [];
let respond: (url: URL) => Response | Promise<Response> = () => {
  throw new Error("unexpected fetch");
};
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  fetched.push(url);
  return respond(url);
}) as typeof fetch;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  settingRows.clear();
  settingUpserts.length = 0;
  users = [];
  library = [];
  requests = [];
  delete process.env.SUMMONARR_DEFAULT_LOCALE;
  cacheRows.clear();
  cacheReads = 0;
  fetched.length = 0;
  warns.length = 0;
  respond = () => {
    throw new Error("unexpected fetch");
  };
  gatedUpsertKey = null;
  upsertGate = null;
  upsertGateReached = false;
});

type Media = Parameters<typeof localizeMedia>[0][number];
const movie = (id: number, extra: Partial<Media> = {}): Media =>
  ({ id, mediaType: "movie", title: `Movie ${id}`, overview: `Overview ${id}`, posterPath: null, releaseYear: "2020", voteAverage: 7, ...extra }) as Media;

test("English is a no-op: same array, no cache read, no fetch", async () => {
  const items = [movie(1), movie(2)];
  const out = await localizeMedia(items, "en");
  assert.equal(out, items);
  assert.equal(cacheReads, 0);
  assert.equal(fetched.length, 0);
});

test("a cached translation overlays each field independently", async () => {
  seed("movie:1:i18n:v2", { fr: { title: "Film un", overview: "Résumé un" } });
  seed("movie:2:i18n:v2", { fr: { tagline: "Accroche" } });
  const out = await localizeMedia([movie(1, { tagline: "Tag" }), movie(2, { tagline: "Tag 2" })], "fr");
  assert.equal(fetched.length, 0, "fully cached ⇒ no fetch");
  assert.deepEqual([out[0].title, out[0].overview, out[0].tagline], ["Film un", "Résumé un", "Tag"]);
  assert.deepEqual([out[1].title, out[1].overview, out[1].tagline], ["Movie 2", "Overview 2", "Accroche"]);
});

test("a title in the viewer's own language uses the original title and drops the redundant 'Original title'", async () => {
  seed("movie:3:i18n:v2", {});
  const [out] = await localizeMedia([movie(3, { title: "Amelie", originalTitle: "Le Fabuleux Destin d'Amélie Poulain", originalLanguage: "fr" })], "fr");
  assert.equal(out.title, "Le Fabuleux Destin d'Amélie Poulain");
  assert.equal(out.originalTitle, undefined);
  // Another language keeps both.
  const [de] = await localizeMedia([movie(3, { title: "Amelie", originalTitle: "Le Fabuleux", originalLanguage: "fr" })], "de");
  assert.deepEqual([de.title, de.originalTitle], ["Amelie", "Le Fabuleux"]);
});

test("a miss is fetched once (details + translations + posters), trimmed with region preference, and cached (even when empty)", async () => {
  respond = (url) => {
    if (url.pathname === "/3/movie/10") {
      assert.equal(url.searchParams.get("append_to_response"), "translations,images");
      assert.deepEqual(url.searchParams.get("include_image_language")!.split(",").sort(), ["de", "es", "fr", "it", "pt", "zh"]);
      return json({
        translations: {
          translations: [
            { iso_639_1: "es", iso_3166_1: "MX", data: { title: "Título MX", overview: "Resumen MX", tagline: "" } },
            { iso_639_1: "es", iso_3166_1: "ES", data: { title: "Título ES", overview: "", tagline: "" } },
            { iso_639_1: "zh", iso_3166_1: "TW", data: { title: "繁體標題", overview: "繁體", tagline: "" } },
            { iso_639_1: "ja", iso_3166_1: "JP", data: { title: "日本語", overview: "x", tagline: "" } },
          ],
        },
        images: {
          posters: [
            { file_path: "/es-low.jpg", iso_639_1: "es", vote_average: 5, vote_count: 3 },
            { file_path: "/es-best.jpg", iso_639_1: "es", iso_3166_1: "ES", vote_average: 6, vote_count: 9 },
            { file_path: "/es-ar.jpg", iso_639_1: "es", iso_3166_1: "AR", vote_average: 9, vote_count: 9 },
            { file_path: "/zh-tw.jpg", iso_639_1: "zh", iso_3166_1: "TW", vote_average: 9, vote_count: 9 },
            { file_path: "/zh-noregion.jpg", iso_639_1: "zh", vote_average: 9, vote_count: 9 },
          ],
        },
      });
    }
    if (url.pathname === "/3/movie/11") return json({ translations: { translations: [] }, images: { posters: [] } });
    throw new Error(`unexpected ${url.pathname}`);
  };
  const out = await localizeMedia([movie(10, { posterPath: "/en.jpg" }), movie(10, { posterPath: "/en.jpg" }), movie(11, { posterPath: "/en11.jpg" })], "es");
  assert.equal(fetched.filter((u) => u.pathname === "/3/movie/10").length, 1, "duplicates share one fetch");
  assert.equal(out[0].title, "Título ES", "es-ES title preferred");
  assert.equal(out[0].overview, "Resumen MX", "a field es-ES lacks falls back to es-MX");
  assert.equal(out[0].posterPath, "/es-best.jpg", "best-voted poster in a matching region (es-AR is not one of ours)");
  assert.equal(out[1].title, "Título ES");
  assert.deepEqual([out[2].title, out[2].posterPath], ["Movie 11", "/en11.jpg"], "nothing translated keeps English");

  const stored = JSON.parse(cacheRows.get("movie:10:i18n:v2")!.data);
  assert.deepEqual(Object.keys(stored).sort(), ["es"], "trimmed to our locales; zh-TW and region-less zh are never Simplified Chinese");
  assert.deepEqual(JSON.parse(cacheRows.get("movie:11:i18n:v2")!.data), {}, "the empty answer is cached too");
  assert.equal(cacheRows.get("movie:10:i18n:v2")!.expiresAt.getTime() - Date.now() > 29 * 86_400_000, true, "30-day TTL");

  fetched.length = 0;
  await localizeMedia([movie(10), movie(11)], "zh");
  assert.equal(fetched.length, 0, "both now answer from the cache");
});

test("a failing translation fetch leaves the items in English and never throws", async () => {
  respond = () => json({ status_message: "nope" }, 500);
  const items = [movie(20)];
  const out = await localizeMedia(items, "de");
  assert.equal(out[0].title, "Movie 20");
  assert.equal(out.length, 1);
});

test("detail-row genres are renamed by id from the localized list, cached under its own key", async () => {
  seed("movie:30:i18n:v2", {});
  respond = (url) => {
    assert.equal(url.pathname, "/3/genre/movie/list");
    assert.equal(url.searchParams.get("language"), "it-IT");
    return json({ genres: [{ id: 35, name: "Commedia" }, { id: 18, name: "Dramma" }] });
  };
  const [out] = await localizeMedia(
    [movie(30, { genres: ["Comedy", "Romance"], genreList: [{ id: 35, name: "Comedy" }, { id: 10749, name: "Romance" }] })],
    "it",
  );
  assert.deepEqual(out.genres, ["Commedia", "Romance"], "an id missing from the list keeps its English name");
  assert.ok(cacheRows.has("genres:movie:it-IT"));
  assert.ok(!cacheRows.has("genres:movie"), "the English genre key is not written by a localized read");
  assert.equal(tmdbLanguageFor("en"), null);
  // The plain call still reads/writes the original English key.
  respond = () => json({ genres: [{ id: 35, name: "Comedy" }] });
  await getMovieGenres();
  assert.ok(cacheRows.has("genres:movie"));
});

test("a localized season keeps English where TMDB's translation is blank, and hands back the English list it merged over", async () => {
  seed("tv:40:season:1", [
    { episodeNumber: 1, seasonNumber: 1, name: "Pilot", overview: "English one", airDate: null, stillPath: null, runtime: 40, voteAverage: 8 },
    { episodeNumber: 2, seasonNumber: 1, name: "Second", overview: "English two", airDate: null, stillPath: null, runtime: 40, voteAverage: 8 },
  ]);
  respond = (url) => {
    assert.equal(url.searchParams.get("language"), "de-DE");
    return json({ episodes: [{ episode_number: 1, name: "Pilotfolge", overview: "Deutsch eins" }, { episode_number: 2, name: "Folge 2", overview: "" }] });
  };
  const { episodes: eps, english } = await getTVSeasonEpisodesLocalized(40, 1, "de-DE");
  assert.deepEqual(eps.map((e) => [e.name, e.overview]), [["Pilotfolge", "Deutsch eins"], ["Folge 2", "English two"]]);
  assert.equal(eps[0].runtime, 40, "non-text fields come from the English row");
  // The season route stores episode metadata into TVEpisodeCache, a table every
  // viewer shares — it must store THIS list, not the merged one (guardrail 40a).
  assert.deepEqual(english.map((e) => [e.name, e.overview]), [["Pilot", "English one"], ["Second", "English two"]], "the English list is exposed unmerged");
  fetched.length = 0;
  await getTVSeasonEpisodesLocalized(40, 1, "de-DE");
  assert.equal(fetched.length, 0, "the localized season is cached");
  const plain = await getTVSeasonEpisodesLocalized(40, 1, null);
  assert.equal(plain.episodes[0].name, "Pilot", "English is the plain path");
  assert.equal(plain.episodes, plain.english, "…and the same array is both lists");
});

test("calendar titles come from the cache only — a miss stays English and nothing is fetched", async () => {
  seed("tv:50:i18n:v2", { fr: { title: "La Série" } });
  const out = await cachedLocalizedTitles([{ tmdbId: 50, mediaType: "tv" }, { tmdbId: 51, mediaType: "tv" }], "fr");
  assert.deepEqual([...out], [["tv:50", "La Série"]]);
  assert.equal(fetched.length, 0);
  assert.equal((await cachedLocalizedTitles([{ tmdbId: 50, mediaType: "tv" }], "en")).size, 0);
});

test("titleResolver: one resolution per recipient language; English, unknown ids and English-only sets cost nothing", async () => {
  seed("movie:60:i18n:v2", { de: { title: "Der Film" }, it: { title: "Il film" } });
  const ref = { tmdbId: 60, mediaType: "MOVIE", title: "The Movie" };
  const noId = { tmdbId: null, mediaType: "MOVIE", title: "No id" };
  const resolve = await titleResolver([ref, noId], ["de", "it", "en"]);
  assert.deepEqual(
    [resolve(ref, "de"), resolve(ref, "it"), resolve(ref, "en"), resolve(ref, "fr"), resolve(noId, "de")],
    ["Der Film", "Il film", "The Movie", "The Movie", "No id"],
  );

  cacheReads = 0;
  const english = await titleResolver([ref], ["en", "en"]);
  assert.equal(english(ref, "en"), "The Movie");
  assert.equal(cacheReads, 0, "an all-English recipient set never reads the cache");
  assert.equal(fetched.length, 0);
});

test("localizedTitleFor: a null stored locale reads the instance default", async () => {
  seed("tv:61:i18n:v2", { it: { title: "La serie" } });
  const ref = { tmdbId: 61, mediaType: "TV", title: "The Show" };
  assert.equal(await localizedTitleFor(ref, null), "The Show");
  process.env.SUMMONARR_DEFAULT_LOCALE = "it";
  assert.equal(await localizedTitleFor(ref, null), "La serie");
  assert.equal(await localizedTitleFor(ref, "en"), "The Show", "a stored English choice wins over the default");
});

test("localizeStoredTitles: inbox rows in the reader's language, untouched for English", async () => {
  seed("movie:62:i18n:v2", { pt: { title: "O Filme" } });
  seed("movie:63:i18n:v2", {});
  const rows = [
    { id: "n1", title: "The Movie", tmdbId: 62, mediaType: "MOVIE" as const },
    { id: "n2", title: "Untranslated", tmdbId: 63, mediaType: "MOVIE" as const },
  ];
  const out = await localizeStoredTitles(rows, "pt");
  assert.deepEqual(out.map((r) => r.title), ["O Filme", "Untranslated"]);
  assert.equal(out[1], rows[1], "an unchanged row is returned as-is");
  assert.equal(await localizeStoredTitles(rows, "en"), rows);
});

test("a collection name is localized from /collection/<id>/translations and cached", async () => {
  respond = (url) => {
    assert.equal(url.pathname, "/3/collection/70/translations");
    return json({ translations: [{ iso_639_1: "fr", iso_3166_1: "FR", data: { title: "Saga Truc" } }] });
  };
  assert.equal(await localizedCollectionName(70, "Thing Collection", "fr"), "Saga Truc");
  assert.equal(await localizedCollectionName(70, "Thing Collection", "de"), "Thing Collection");
  assert.equal(fetched.length, 1);
  assert.equal(await localizedCollectionName(70, "Thing Collection", "en"), "Thing Collection");
});

test("a served language is stamped (throttled) and counts as in use; a stale stamp does not", async () => {
  assert.equal(await nonEnglishInUse(), false);
  seed("movie:64:i18n:v2", {});
  // "pt": the throttle is per PROCESS, and no earlier test in this file serves
  // Portuguese through localizeMedia.
  await localizeMedia([movie(64)], "pt");
  await localizeMedia([movie(64)], "pt");
  await new Promise((r) => setTimeout(r, 0)); // the stamp is fire-and-forget
  assert.deepEqual(settingUpserts, ["contentLocaleSeen:pt"], "stamped once, not per call");
  assert.equal(await nonEnglishInUse(), true);
  settingRows.set("contentLocaleSeen:pt", new Date(Date.now() - 31 * 86_400_000).toISOString());
  assert.equal(await nonEnglishInUse(), false, "older than 30 days ⇒ not in use");
});

test("a biography is localized from /person/<id>/translations and cached; English is a no-op", async () => {
  respond = (url) => {
    assert.equal(url.pathname, "/3/person/80/translations");
    return json({ translations: [
      { iso_639_1: "pt", iso_3166_1: "PT", data: { biography: "Biografia PT" } },
      { iso_639_1: "pt", iso_3166_1: "BR", data: { biography: "Biografia BR" } },
      { iso_639_1: "fr", iso_3166_1: "FR", data: { biography: "" } },
    ] });
  };
  assert.equal(await localizedBiography(80, "pt"), "Biografia BR", "pt-BR preferred over pt-PT");
  assert.equal(await localizedBiography(80, "fr"), null, "a blank translation keeps English");
  assert.equal(fetched.length, 1, "the second read is served from the cache");
  assert.equal(await localizedBiography(80, "en"), null);
});

test("prewarm: a no-op when nobody reads a non-English language", async () => {
  library = [{ tmdbId: 90, mediaType: "MOVIE" }];
  const r = await prewarmTitleTranslations();
  assert.equal(r.skipped, true);
  assert.equal(fetched.length, 0);
});

test("prewarm: fetches only uncached titles, requests first, up to the cap", async () => {
  users = [{ id: "u", locale: "fr", deactivatedAt: null }];
  library = [{ tmdbId: 91, mediaType: "MOVIE" }, { tmdbId: 92, mediaType: "TV" }, { tmdbId: 93, mediaType: "MOVIE" }];
  requests = [{ tmdbId: 94, mediaType: "MOVIE" }];
  seed("movie:91:i18n:v2", {});
  respond = () => json({ translations: { translations: [] }, images: { posters: [] } });
  const r = await prewarmTitleTranslations({ maxFetches: 2 });
  assert.deepEqual(r, { skipped: false, candidates: 4, fetched: 2, failed: 0 });
  assert.deepEqual(fetched.map((u) => u.pathname), ["/3/movie/94", "/3/tv/92"], "the request first, the cached title skipped, the cap honoured");
});

test("prewarm: an aborted signal stops before fetching", async () => {
  users = [{ id: "u", locale: "zh", deactivatedAt: null }];
  library = [{ tmdbId: 95, mediaType: "MOVIE" }];
  const c = new AbortController();
  c.abort();
  const r = await prewarmTitleTranslations({ signal: c.signal });
  assert.equal(r.fetched, 0);
  assert.equal(fetched.length, 0);
});


// ── the in-flight cap (guardrail 31) ────────────────────────────────────────

const settle = () => new Promise<void>((r) => setImmediate(r));

test("createInFlightLimiter: a finishing task hands its slot to the parked waiter — a newcomer in the wake-up gap never runs on top of it", async () => {
  // The waiter resumes one microtask AFTER the finishing task's `finally` wakes
  // it. The newcomer is placed at every offset d from that `finally` (d = 2 is
  // the exact gap for this task shape), so the pin does not depend on counting
  // ticks right: with release-then-wake, SOME offset lets the newcomer see a
  // free slot and the woken waiter then runs as a third task.
  for (let d = 0; d <= 5; d++) {
    const limit = createInFlightLimiter(2);
    let running = 0;
    let most = 0;
    const task = (g: Deferred<void>) => limit(async () => {
      running++;
      most = Math.max(most, running);
      await g.promise;
      running--;
    });
    const a = deferred<void>(), b = deferred<void>(), waiter = deferred<void>(), newcomer = deferred<void>();
    const pa = task(a), pb = task(b), pw = task(waiter);
    assert.equal(running, 2, "two run, the third parks");
    a.resolve();
    for (let i = 0; i < d; i++) await null;
    const pn = task(newcomer);
    await settle();
    assert.equal(most, 2, `d=${d}: ${most} tasks ran at once under a cap of 2`);
    b.resolve(); waiter.resolve(); newcomer.resolve();
    await Promise.all([pa, pb, pw, pn]);
    assert.equal(running, 0);
  }
});

test("createInFlightLimiter: FIFO, and a rejecting task still passes its slot on while the rejection propagates", async () => {
  const limit = createInFlightLimiter(1);
  const order: string[] = [];
  const first = limit(async () => { order.push("first"); throw new Error("boom"); });
  const second = limit(async () => { order.push("second"); return 2; });
  const third = limit(async () => { order.push("third"); return 3; });
  await assert.rejects(first, /boom/);
  assert.deepEqual([await second, await third], [2, 3]);
  assert.deepEqual(order, ["first", "second", "third"]);
});

test("translation fetches never exceed MAX_IN_FLIGHT across concurrent callers, whatever microtask a newcomer lands on", async () => {
  // End to end through the real limiter singleton: the prewarm parks seven
  // titles (six fetch, one waits), one of the six is released and its cache
  // write is held at the gate so its slot hand-off happens a known distance
  // from where a concurrent biography read (another caller, another request)
  // enters the limiter. The newcomer's arrival is swept across microtask
  // offsets 0..8 — the hand-off-to-resumption gap is one specific offset, and
  // the sweep finds it without the test knowing how many awaits sit inside
  // setCache or getCacheMany.
  users = [{ id: "u", locale: "fr", deactivatedAt: null }];
  const pending = new Map<string, Deferred<Response>>();
  let inFlight = 0;
  let most = 0;
  respond = (url) => {
    inFlight++;
    most = Math.max(most, inFlight);
    const d = deferred<Response>();
    pending.set(url.pathname, d);
    return d.promise;
  };
  const release = (path: string) => {
    const d = pending.get(path)!;
    pending.delete(path);
    inFlight--;
    d.resolve(path.includes("/person/") ? json({ translations: [] }) : json({ translations: { translations: [] }, images: { posters: [] } }));
  };
  const until = async (pred: () => boolean, label: string) => {
    for (let i = 0; i < 500 && !pred(); i++) await settle();
    assert.ok(pred(), label);
  };

  for (let d = 0; d <= 8; d++) {
    const base = 7000 + d * 10;
    library = Array.from({ length: MAX_IN_FLIGHT + 1 }, (_, i) => ({ tmdbId: base + i, mediaType: "MOVIE" }));
    const run = prewarmTitleTranslations();
    await until(() => inFlight === MAX_IN_FLIGHT, `d=${d}: ${MAX_IN_FLIGHT} fetches in flight`);
    await settle();
    assert.equal(inFlight, MAX_IN_FLIGHT, `d=${d}: the ${MAX_IN_FLIGHT + 1}th title is parked, not fetched`);

    // Release one fetch; its chain runs on to setCache, where the gate holds it.
    const [aPath] = [...pending.keys()];
    gatedUpsertKey = `movie:${aPath.split("/").pop()}:i18n:v2`;
    upsertGate = deferred<void>();
    upsertGateReached = false;
    release(aPath);
    await until(() => upsertGateReached, `d=${d}: the released fetch reached its cache write`);
    upsertGate.resolve(); // its slot hand-off is now a fixed number of microtasks away
    for (let i = 0; i < d; i++) await null;
    const bio = localizedBiography(9000 + d, "fr"); // the newcomer enters the limiter d ticks later
    for (let i = 0; i < 4; i++) await settle();
    assert.ok(most <= MAX_IN_FLIGHT, `d=${d}: ${most} translation fetches in flight at once — the cap is ${MAX_IN_FLIGHT}`);

    // Drain: everything parked must still run to completion.
    gatedUpsertKey = null;
    upsertGate = null;
    let done = false;
    void Promise.allSettled([run, bio]).then(() => { done = true; });
    while (!done) {
      for (const path of [...pending.keys()]) release(path);
      await settle();
    }
    assert.equal(inFlight, 0, `d=${d}: drained`);
    assert.equal(cacheRows.has(`person:${9000 + d}:i18n:v1`), true, `d=${d}: the newcomer did run`);
  }
});
