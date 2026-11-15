// getEnrichedPerson (src/lib/person.ts) hands a person's filmography to the
// ratings pass. A credit carries a release YEAR, not a date, and the ratings
// caches key their TTLs off the date: a title released this year refreshes in
// days, a back-catalog one in weeks, and a "not found" answer for a new release
// is retried within a day instead of a week. Cast straight to TmdbMedia, every
// credit reached the ratings lookups with no date at all and got the
// back-catalog TTLs. Pinned here end to end: the credit's year reaches the OMDb
// fallback as a date, observed through the TTL of the row it writes.
//
// No DB or network: prisma is shadowed in-memory, fetch is scripted for TMDB,
// dns.lookup is stubbed. No MDBList key, so the OMDb fallback answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "person-credit-ratings-secret-0123456789";
process.env.TMDB_READ_TOKEN = "test-tmdb-read-token";

const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

const warns: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");

const THIS_YEAR = new Date().getFullYear();
const NEW_MOVIE = 7001;
const OLD_SHOW = 7002;

const settings = new Map<string, string>([["omdbApiKey", "test-omdb-key"]]);
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
  findMany: async () => [],
});

type CacheRow = { key: string; data: string; cachedAt: Date; expiresAt: Date };
const cacheRows = new Map<string, CacheRow>();
shadowPrismaModel(prisma, "tmdbCache", {
  findUnique: async (args: { where: { key: string } }) => cacheRows.get(args.where.key) ?? null,
  findMany: async (args: { where: { key: { in: string[] } } }) =>
    args.where.key.in.flatMap((k) => (cacheRows.has(k) ? [cacheRows.get(k)!] : [])),
  upsert: async (args: { where: { key: string }; create: CacheRow }) => {
    cacheRows.set(args.where.key, args.create);
    return args.create;
  },
  deleteMany: async () => ({ count: 0 }),
});
for (const m of ["plexLibraryItem", "jellyfinLibraryItem", "mediaRequest", "radarrWantedItem", "sonarrWantedItem", "radarrAvailableItem", "sonarrAvailableItem", "blacklistItem", "hiddenItem"]) {
  shadowPrismaModel(prisma, m, { findMany: async () => [] });
}
shadowPrismaModel(prisma, "tmdbMediaCore", { upsert: async () => ({}), updateMany: async () => ({ count: 0 }) });
shadowPrismaClientMethod(prisma, "$transaction", async (arg: unknown) =>
  Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => Promise<unknown>)(prisma));

const fetched: URL[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  fetched.push(url);
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  if (url.pathname === "/3/person/31") {
    return json({
      id: 31, name: "An Actor", profile_path: null, known_for_department: "Acting",
      combined_credits: {
        cast: [
          { id: NEW_MOVIE, media_type: "movie", title: "This Year's Film", poster_path: "/n.jpg", release_date: `${THIS_YEAR}-03-01`, vote_average: 7, vote_count: 500, character: "Lead" },
          { id: OLD_SHOW, media_type: "tv", name: "An Old Show", poster_path: "/o.jpg", first_air_date: "2001-01-01", vote_average: 8, vote_count: 900, character: "Self" },
        ],
      },
    });
  }
  // OMDb resolves the IMDb id through TMDB first; none ⇒ an authoritative miss, negative-cached.
  if (url.pathname.endsWith("/external_ids")) return json({ imdb_id: null });
  throw new Error(`unexpected fetch ${url}`);
}) as typeof fetch;

const { getEnrichedPerson, creditRatingFields, withNullRatings } = await import("../src/lib/person.ts");
type SummonarrSession = import("../src/lib/api-auth.ts").SummonarrSession;

test("a credit's release year reaches the ratings lookups as a date, so a new release gets the fresh-title TTL", async () => {
  const session = { user: { id: "viewer", role: "USER", permissions: 0n, mediaServer: "plex" } } as unknown as SummonarrSession;
  const person = await getEnrichedPerson(31, session);
  assert.deepEqual(person.credits.map((c) => c.id), [NEW_MOVIE, OLD_SHOW]);

  const ttlDays = (key: string) => {
    const row = cacheRows.get(key);
    assert.ok(row, `${key} was written`);
    return (row.expiresAt.getTime() - Date.now()) / 86_400_000;
  };
  // omdb.ts: a not-found answer for a title released within the year is retried
  // after a day; anything else (including an unknown date) after a week.
  assert.ok(ttlDays(`omdb:tmdb:movie:${NEW_MOVIE}`) <= 1, "this year's film is retried within a day");
  assert.ok(ttlDays(`omdb:tmdb:tv:${OLD_SHOW}`) > 6, "the 2001 show keeps the back-catalog TTL");
});

test("a credit the ratings pass did not look up keeps its rating fields unset; a looked-up one carries nulls", () => {
  // Untouched by the pass: no rating field at all, so the card fetches them.
  assert.deepEqual(creditRatingFields({}), {});
  // Looked up, nothing found: explicit nulls, so the card does not ask again.
  const none = creditRatingFields({ imdbRating: null, rottenTomatoes: null });
  assert.equal(none.imdbRating, null);
  assert.equal(none.rottenTomatoes, null);
  assert.equal(none.metacritic, null, "the other fields are filled in as null");
  // Looked up with one source only.
  assert.equal(creditRatingFields({ rottenTomatoes: "91%" }).imdbRating, null);
  assert.equal(creditRatingFields({ rottenTomatoes: "91%" }).rottenTomatoes, "91%");
});

test("the API answer keeps every rating field, null when unset", () => {
  const bare: { id: number; imdbRating?: string | null } = { id: 1 };
  const wire = withNullRatings(bare);
  assert.equal("imdbRating" in wire && wire.imdbRating, null);
  assert.equal(wire.rogerEbertRating, null);
  assert.equal(wire.id, 1);
  assert.equal(withNullRatings({ imdbRating: "7.1" }).imdbRating, "7.1");
});
