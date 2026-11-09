// The Activity overview's live-session tmdbId lookup
// (src/lib/activity-session-tmdb.ts) and the shared title reads behind it and
// the per-user page (src/lib/activity-title-resolve-data.ts), against an
// in-memory prisma. No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ef".repeat(32);
process.env.NEXTAUTH_SECRET = "activity-session-tmdb-secret-0123456789";

const { prisma } = await import("../src/lib/prisma.ts");
const { Prisma } = await import("@/generated/prisma");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { resolveActiveSessionTmdb, applySessionResolution, sessionItemKey } = await import("../src/lib/activity-session-tmdb.ts");
const { resolveTitlesToTmdb } = await import("../src/lib/activity-title-resolve-data.ts");
const { addUnambiguousTitleResolutions } = await import("../src/lib/activity-title-resolve.ts");

type Row = Record<string, unknown>;
const raw: { sql: string; values: unknown[] }[] = [];
let itemRows: Row[] = [];
let titleRows: Row[] = [];
let plexLib: Row[] = [];
let jellyfinLib: Row[] = [];

shadowPrismaClientMethod(prisma, "$queryRaw", async (first: TemplateStringsArray | { sql: string; values: unknown[] }, ...values: unknown[]) => {
  const composed = "sql" in first && !Array.isArray(first) ? first : Prisma.sql(first as TemplateStringsArray, ...values);
  raw.push({ sql: composed.sql, values: composed.values });
  return composed.sql.includes('"sourceItemId"') ? itemRows : titleRows;
});
shadowPrismaModel(prisma, "plexLibraryItem", { findMany: async () => plexLib });
shadowPrismaModel(prisma, "jellyfinLibraryItem", { findMany: async () => jellyfinLib });

beforeEach(() => {
  raw.length = 0;
  itemRows = [];
  titleRows = [];
  plexLib = [];
  jellyfinLib = [];
});

const session = (over: Partial<{ source: string; serverInstance: string; sourceItemId: string | null; title: string; tmdbId: number | null; mediaType: string | null }>) => ({
  source: "plex", serverInstance: "", sourceItemId: "k1", title: "Fargo", tmdbId: null, mediaType: "TV", ...over,
});

test("an item match by the session's own server item is backfillable; one row per item comes back from SQL", async () => {
  itemRows = [{ source: "plex", serverInstance: "", sourceItemId: "k1", tmdbId: 60622, mediaType: "TV" }];
  const [s] = await resolveActiveSessionTmdb([session({})]);
  assert.equal(s.effectiveTmdbId, 60622);
  assert.deepEqual(s.backfill, { tmdbId: 60622, mediaType: "TV" });
  assert.match(raw[0].sql, /SELECT DISTINCT ON \("source", "serverInstance", "sourceItemId"\)/);
  assert.match(raw[0].sql, /\("source" = \? AND "sourceItemId" IN \(\?\)\)/, "scoped by source");
  assert.deepEqual(raw[0].values, ["plex", "k1"]);
});

test("an id another server issued never resolves this server's session", async () => {
  itemRows = [{ source: "plex", serverInstance: "other", sourceItemId: "k1", tmdbId: 1, mediaType: "TV" }];
  const [s] = await resolveActiveSessionTmdb([session({})]);
  assert.equal(s.effectiveTmdbId, null);
});

test("a Jellyfin item with the same id and slug never resolves a Plex session", async () => {
  itemRows = [{ source: "jellyfin", serverInstance: "", sourceItemId: "k1", tmdbId: 9, mediaType: "MOVIE" }];
  const [s] = await resolveActiveSessionTmdb([session({})]);
  assert.equal(s.effectiveTmdbId, null);
});

test("a title-only match feeds the display but is never backfilled, and keeps the session's type", async () => {
  titleRows = [{ title: "Fargo", tmdbId: 60622, mediaType: "TV" }];
  const [s] = await resolveActiveSessionTmdb([session({ sourceItemId: null })]);
  assert.equal(s.effectiveTmdbId, 60622);
  assert.equal(s.effectiveMediaType, "TV");
  assert.equal(s.backfill, null);
});

test("a library row resolves a Jellyfin session on any of its item ids", async () => {
  jellyfinLib = [{ tmdbId: 7, mediaType: "MOVIE", jellyfinItemId: "a", jellyfinItemIds: ["a", "b"], serverInstance: "" }];
  const [s] = await resolveActiveSessionTmdb([session({ source: "jellyfin", sourceItemId: "b", mediaType: "MOVIE" })]);
  assert.equal(s.effectiveTmdbId, 7);
});

test("a session that already has a tmdbId runs no lookup", async () => {
  const [s] = await resolveActiveSessionTmdb([session({ tmdbId: 5 })]);
  assert.equal(s.effectiveTmdbId, 5);
  assert.equal(raw.length, 0);
});

test("applySessionResolution reads the instance-scoped key", () => {
  const items = new Map([[sessionItemKey("plex", "a", "k1"), { tmdbId: 3, mediaType: "TV" }]]);
  assert.equal(applySessionResolution(session({ serverInstance: "a" }), items, {}).effectiveTmdbId, 3);
  assert.equal(applySessionResolution(session({ serverInstance: "b" }), items, {}).effectiveTmdbId, null);
});

test("the library fallback leaves a title held under two tmdbIds unresolved instead of guessing", async () => {
  plexLib = [{ title: "Dune", tmdbId: 841, mediaType: "MOVIE" }];
  jellyfinLib = [{ title: "Dune", tmdbId: 438631, mediaType: "MOVIE" }, { title: "Heat", tmdbId: 949, mediaType: "MOVIE" }];
  const map = await resolveTitlesToTmdb(
    [{ title: "Dune", mediaType: "MOVIE" }, { title: "Heat", mediaType: "MOVIE" }],
    { libraryFallback: true },
  );
  assert.equal(map["MOVIE:Dune"], undefined);
  assert.deepEqual(map["MOVIE:Heat"], { tmdbId: 949, mediaType: "MOVIE" });
  // Without the fallback the library is never read.
  plexLib = [{ title: "Heat", tmdbId: 949, mediaType: "MOVIE" }];
  assert.deepEqual(await resolveTitlesToTmdb([{ title: "Heat", mediaType: "MOVIE" }], { libraryFallback: false }), {});
});

test("play history answers first; a library row never overrides it", () => {
  const map = { "MOVIE:Heat": { tmdbId: 1, mediaType: "MOVIE" as const } };
  addUnambiguousTitleResolutions(map, [{ title: "Heat", tmdbId: 2, mediaType: "MOVIE" }, { title: "Heat", tmdbId: 2, mediaType: "MOVIE" }]);
  assert.equal(map["MOVIE:Heat"].tmdbId, 1);
  const fresh = addUnambiguousTitleResolutions({}, [{ title: "X", tmdbId: 2, mediaType: "TV" }, { title: "X", tmdbId: 2, mediaType: "TV" }]);
  assert.deepEqual(fresh["TV:X"], { tmdbId: 2, mediaType: "TV" }, "two rows of ONE title are not ambiguous");
});

test("a known play year picks the library's same-named title of that year; an unknown or mixed year still leaves it unresolved", async () => {
  const { collectUnmappedPairs } = await import("../src/lib/activity-title-resolve.ts");
  plexLib = [{ title: "Dune", tmdbId: 841, mediaType: "MOVIE", year: "1984" }];
  jellyfinLib = [{ title: "Dune", tmdbId: 438631, mediaType: "MOVIE", year: "2021" }];
  const known = collectUnmappedPairs([
    { title: "Dune", tmdbId: null, mediaType: "MOVIE", year: "2021" },
    { title: "Dune", tmdbId: null, mediaType: "MOVIE", year: "2021" },
  ]);
  assert.deepEqual(known, [{ title: "Dune", mediaType: "MOVIE", year: "2021" }]);
  assert.deepEqual((await resolveTitlesToTmdb(known, { libraryFallback: true }))["MOVIE:Dune"], { tmdbId: 438631, mediaType: "MOVIE" });
  const historySql = raw.find((r) => r.sql.includes('"PlayHistory"'));
  assert.match(historySql!.sql, /"year" IS NULL OR "year" = \?/, "the history step skips plays of another year");
  assert.ok(historySql!.values.includes("2021"));

  const mixed = collectUnmappedPairs([
    { title: "Dune", tmdbId: null, mediaType: "MOVIE", year: "2021" },
    { title: "Dune", tmdbId: null, mediaType: "MOVIE", year: "1984" },
  ]);
  assert.deepEqual(mixed, [{ title: "Dune", mediaType: "MOVIE" }], "plays that disagree carry no year");
  assert.equal((await resolveTitlesToTmdb(mixed, { libraryFallback: true }))["MOVIE:Dune"], undefined);

  // A type-less play's year still narrows the typed library rows.
  const typeless = collectUnmappedPairs([{ title: "Dune", tmdbId: null, mediaType: null, year: "1984" }]);
  assert.deepEqual((await resolveTitlesToTmdb(typeless, { libraryFallback: true }))["MOVIE:Dune"], { tmdbId: 841, mediaType: "MOVIE" });
});
