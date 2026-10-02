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
const { localizeMedia } = await import("../src/lib/tmdb-localize.ts");
const { getTVSeasonEpisodesLocalized, tmdbLanguageFor, getMovieGenres } = await import("../src/lib/tmdb.ts");

type CacheRow = { key: string; data: string; cachedAt: Date; expiresAt: Date };
const cacheRows = new Map<string, CacheRow>();
let cacheReads = 0;
const far = () => new Date(Date.now() + 86_400_000);
const seed = (key: string, value: unknown) =>
  cacheRows.set(key, { key, data: JSON.stringify(value), cachedAt: new Date(), expiresAt: far() });
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
  seed("movie:1:i18n:v1", { fr: { title: "Film un", overview: "Résumé un" } });
  seed("movie:2:i18n:v1", { fr: { tagline: "Accroche" } });
  const out = await localizeMedia([movie(1, { tagline: "Tag" }), movie(2, { tagline: "Tag 2" })], "fr");
  assert.equal(fetched.length, 0, "fully cached ⇒ no fetch");
  assert.deepEqual([out[0].title, out[0].overview, out[0].tagline], ["Film un", "Résumé un", "Tag"]);
  assert.deepEqual([out[1].title, out[1].overview, out[1].tagline], ["Movie 2", "Overview 2", "Accroche"]);
});

test("a title in the viewer's own language uses the original title and drops the redundant 'Original title'", async () => {
  seed("movie:3:i18n:v1", {});
  const [out] = await localizeMedia([movie(3, { title: "Amelie", originalTitle: "Le Fabuleux Destin d'Amélie Poulain", originalLanguage: "fr" })], "fr");
  assert.equal(out.title, "Le Fabuleux Destin d'Amélie Poulain");
  assert.equal(out.originalTitle, undefined);
  // Another language keeps both.
  const [de] = await localizeMedia([movie(3, { title: "Amelie", originalTitle: "Le Fabuleux", originalLanguage: "fr" })], "de");
  assert.deepEqual([de.title, de.originalTitle], ["Amelie", "Le Fabuleux"]);
});

test("a miss is fetched once, trimmed to our locales with region preference, and cached (even when empty)", async () => {
  respond = (url) => {
    if (url.pathname === "/3/movie/10/translations") {
      return json({
        translations: [
          { iso_639_1: "es", iso_3166_1: "MX", data: { title: "Título MX", overview: "Resumen MX", tagline: "" } },
          { iso_639_1: "es", iso_3166_1: "ES", data: { title: "Título ES", overview: "", tagline: "" } },
          { iso_639_1: "zh", iso_3166_1: "TW", data: { title: "繁體標題", overview: "繁體", tagline: "" } },
          { iso_639_1: "ja", iso_3166_1: "JP", data: { title: "日本語", overview: "x", tagline: "" } },
        ],
      });
    }
    if (url.pathname === "/3/movie/11/translations") return json({ translations: [] });
    throw new Error(`unexpected ${url.pathname}`);
  };
  const out = await localizeMedia([movie(10), movie(10), movie(11)], "es");
  assert.equal(fetched.filter((u) => u.pathname === "/3/movie/10/translations").length, 1, "duplicates share one fetch");
  assert.equal(out[0].title, "Título ES", "es-ES title preferred");
  assert.equal(out[0].overview, "Resumen MX", "a field es-ES lacks falls back to es-MX");
  assert.equal(out[1].title, "Título ES");
  assert.equal(out[2].title, "Movie 11", "no translation keeps English");

  const stored = JSON.parse(cacheRows.get("movie:10:i18n:v1")!.data);
  assert.deepEqual(Object.keys(stored).sort(), ["es"], "trimmed to our locales; zh-TW is never Simplified Chinese");
  assert.deepEqual(JSON.parse(cacheRows.get("movie:11:i18n:v1")!.data), {}, "the empty answer is cached too");

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
  seed("movie:30:i18n:v1", {});
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
