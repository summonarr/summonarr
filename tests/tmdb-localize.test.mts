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
//  - a localized season keeps the English overview where TMDB's is blank.
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
  localizeNotificationTitles,
  localizedTitleFor,
  localizedBiography,
  prewarmTitleTranslations,
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
let userReads = 0;
shadowPrismaModel(prisma, "user", {
  findMany: async (args: { where: { id: { in: string[] } } }) => {
    userReads++;
    return users.filter((u) => args.where.id.in.includes(u.id));
  },
  count: async () => users.filter((u) => !u.deactivatedAt && u.locale && u.locale !== "en").length,
});
let library: { tmdbId: number; mediaType: string }[] = [];
let requests: { tmdbId: number; mediaType: string }[] = [];
shadowPrismaModel(prisma, "plexLibraryItem", { findMany: async () => library });
shadowPrismaModel(prisma, "jellyfinLibraryItem", { findMany: async () => [] });
shadowPrismaModel(prisma, "mediaRequest", { findMany: async () => requests });
shadowPrismaModel(prisma, "watchlistItem", { findMany: async () => [] });

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
    cacheRows.set(args.where.key, args.create);
    return args.create;
  },
  deleteMany: async () => ({ count: 0 }),
});

const fetched: URL[] = [];
let respond: (url: URL) => Response = () => {
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
  users = [];
  userReads = 0;
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

test("a localized season keeps English where TMDB's translation is blank", async () => {
  seed("tv:40:season:1", [
    { episodeNumber: 1, seasonNumber: 1, name: "Pilot", overview: "English one", airDate: null, stillPath: null, runtime: 40, voteAverage: 8 },
    { episodeNumber: 2, seasonNumber: 1, name: "Second", overview: "English two", airDate: null, stillPath: null, runtime: 40, voteAverage: 8 },
  ]);
  respond = (url) => {
    assert.equal(url.searchParams.get("language"), "de-DE");
    return json({ episodes: [{ episode_number: 1, name: "Pilotfolge", overview: "Deutsch eins" }, { episode_number: 2, name: "Folge 2", overview: "" }] });
  };
  const eps = await getTVSeasonEpisodesLocalized(40, 1, "de-DE");
  assert.deepEqual(eps.map((e) => [e.name, e.overview]), [["Pilotfolge", "Deutsch eins"], ["Folge 2", "English two"]]);
  assert.equal(eps[0].runtime, 40, "non-text fields come from the English row");
  fetched.length = 0;
  await getTVSeasonEpisodesLocalized(40, 1, "de-DE");
  assert.equal(fetched.length, 0, "the localized season is cached");
  assert.equal((await getTVSeasonEpisodesLocalized(40, 1, null))[0].name, "Pilot", "English is the plain path");
});

test("calendar titles come from the cache only — a miss stays English and nothing is fetched", async () => {
  seed("tv:50:i18n:v2", { fr: { title: "La Série" } });
  const out = await cachedLocalizedTitles([{ tmdbId: 50, mediaType: "tv" }, { tmdbId: 51, mediaType: "tv" }], "fr");
  assert.deepEqual([...out], [["tv:50", "La Série"]]);
  assert.equal(fetched.length, 0);
  assert.equal((await cachedLocalizedTitles([{ tmdbId: 50, mediaType: "tv" }], "en")).size, 0);
});

test("notification titles follow each REQUESTER's stored language, else the instance default", async () => {
  seed("movie:60:i18n:v2", { de: { title: "Der Film" }, it: { title: "Il film" } });
  users = [
    { id: "u-de", locale: "de", deactivatedAt: null },
    { id: "u-none", locale: null, deactivatedAt: null },
  ];
  const rows = [
    { requestedBy: "u-de", tmdbId: 60, mediaType: "MOVIE", title: "The Movie" },
    { requestedBy: "u-none", tmdbId: 60, mediaType: "MOVIE", title: "The Movie" },
    { requestedBy: "u-de", tmdbId: null, mediaType: "MOVIE", title: "No id" },
  ];
  let out = await localizeNotificationTitles(rows);
  assert.deepEqual(out.map((r) => r.title), ["Der Film", "The Movie", "No id"]);

  process.env.SUMMONARR_DEFAULT_LOCALE = "it";
  out = await localizeNotificationTitles(rows);
  assert.deepEqual(out.map((r) => r.title), ["Der Film", "Il film", "No id"], "a null locale reads the instance default");

  // A caller that already read the locales passes them and costs no query.
  userReads = 0;
  out = await localizeNotificationTitles(rows, new Map([["u-de", "de"], ["u-none", "en"]]));
  assert.equal(userReads, 0);
  assert.deepEqual(out.map((r) => r.title), ["Der Film", "The Movie", "No id"]);

  assert.equal(await localizedTitleFor({ tmdbId: 60, mediaType: "MOVIE", title: "The Movie" }, "de"), "Der Film");
  assert.equal(await localizedTitleFor({ tmdbId: 60, mediaType: "MOVIE", title: "The Movie" }, "en"), "The Movie");
});

test("an English recipient set never reads the cache or fetches", async () => {
  users = [{ id: "u", locale: null, deactivatedAt: null }];
  const rows = [{ requestedBy: "u", tmdbId: 70, mediaType: "TV", title: "Show" }];
  const out = await localizeNotificationTitles(rows);
  assert.equal(out, rows);
  assert.equal(cacheReads, 0);
  assert.equal(fetched.length, 0);
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
