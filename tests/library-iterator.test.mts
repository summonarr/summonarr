// Unit tests for src/lib/library-iterator.ts — the cursor-paged reader the
// ratings warm / library-wide jobs use to walk Plex+Jellyfin library tables
// without loading them whole. Contracts pinned:
//
//  - iterateLibrary pages by LIBRARY_PAGE_SIZE with keyset pagination: the
//    first query carries NO cursor/skip; every follow-up carries skip:1 plus a
//    compound tmdbId_mediaType cursor equal to the LAST row of the previous
//    page — the skip:1 is what stops the cursor row from being yielded twice;
//  - a short page (< LIBRARY_PAGE_SIZE) ends iteration WITHOUT another
//    round-trip; a table of exactly one full page costs a second (empty)
//    query — the two loop exits;
//  - source routing is strict (plex ⇒ PlexLibraryItem, jellyfin ⇒
//    JellyfinLibraryItem) and the mediaType filter rides in `where`, so a
//    MOVIE walk can never bleed TV rows;
//  - countUniqueLibraryItems converts Postgres's bigint COUNT to a JS number
//    and its SQL deduplicates via UNION — the source comment says "UNION (not
//    UNION ALL)", and the statement text is pinned so a future edit to
//    UNION ALL (double-counting titles present on both servers) fails here;
//  - collectAllLibraryItems walks plex-MOVIE → plex-TV → jellyfin-MOVIE →
//    jellyfin-TV, dedups on `${tmdbId}:${mediaType}` (same id, different type
//    stays distinct), and stops the whole fan-out the moment maxItems is hit —
//    later sources are never even queried. The maxItems=0 edge (first item
//    still returned — the cap is checked post-push) is pinned as CURRENT
//    behaviour.
//
// No DB: both library delegates are shadowed with an in-memory findMany that
// faithfully models the where/orderBy/cursor/skip/take subset the iterator
// uses, and $queryRaw is shadowed for the count (tests/_helpers.mts).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto

// Dynamic imports so the env stub precedes the module-graph load.
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { LIBRARY_PAGE_SIZE, iterateLibrary, countUniqueLibraryItems, collectAllLibraryItems } =
  await import("../src/lib/library-iterator.ts");

// ── in-memory library delegates (cursor-aware findMany) ─────────────────────
type MediaType = "MOVIE" | "TV";
type Row = { tmdbId: number; mediaType: MediaType };
type FindManyArgs = {
  where: { mediaType: MediaType };
  take: number;
  skip?: number;
  cursor?: { tmdbId_mediaType: { tmdbId: number; mediaType: MediaType } };
  orderBy: { tmdbId: "asc" };
  select: { tmdbId: true; mediaType: true };
};
type Call = { source: "plex" | "jellyfin"; args: FindManyArgs };

const calls: Call[] = [];
const tables: Record<"plex" | "jellyfin", Row[]> = { plex: [], jellyfin: [] };

function delegate(source: "plex" | "jellyfin") {
  return {
    findMany: async (args: FindManyArgs): Promise<Row[]> => {
      calls.push({ source, args });
      const all = tables[source]
        .filter((r) => r.mediaType === args.where.mediaType)
        .sort((a, b) => a.tmdbId - b.tmdbId);
      let start = 0;
      if (args.cursor) {
        const { tmdbId, mediaType } = args.cursor.tmdbId_mediaType;
        const idx = all.findIndex((r) => r.tmdbId === tmdbId && r.mediaType === mediaType);
        // Prisma errors on a missing cursor row; a bogus cursor means the
        // iterator advanced with an id it never received — fail loudly.
        if (idx === -1) throw new Error(`cursor row ${tmdbId}:${mediaType} not found`);
        start = idx + (args.skip ?? 0);
      }
      return all.slice(start, start + args.take).map((r) => ({ ...r }));
    },
  };
}

shadowPrismaModel(prisma, "plexLibraryItem", delegate("plex"));
shadowPrismaModel(prisma, "jellyfinLibraryItem", delegate("jellyfin"));

type SqlLike = { sql: string; values: unknown[] };
const rawQueries: SqlLike[] = [];
let rawRows: [{ count: bigint }] = [{ count: 0n }];
shadowPrismaClientMethod(prisma, "$queryRaw", async (q: SqlLike) => {
  rawQueries.push(q);
  return rawRows;
});

beforeEach(() => {
  calls.length = 0;
  tables.plex = [];
  tables.jellyfin = [];
  rawQueries.length = 0;
  rawRows = [{ count: 0n }];
});

const range = (n: number, mediaType: MediaType, start = 1): Row[] =>
  Array.from({ length: n }, (_, i) => ({ tmdbId: start + i, mediaType }));

async function drain(gen: AsyncGenerator<Row>): Promise<Row[]> {
  const out: Row[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

const norm = (sql: string) => sql.replace(/\s+/g, " ").trim();

// ── iterateLibrary ──────────────────────────────────────────────────────────

test("empty table: one page query with the full arg shape and NO cursor, nothing yielded", async () => {
  assert.deepEqual(await drain(iterateLibrary("plex", "MOVIE")), []);
  assert.equal(calls.length, 1);
  const args = calls[0].args;
  assert.equal(calls[0].source, "plex");
  assert.deepEqual(args.where, { mediaType: "MOVIE" });
  assert.equal(args.take, LIBRARY_PAGE_SIZE);
  assert.equal(args.cursor, undefined); // first page is cursor-free
  assert.equal(args.skip, undefined);
  assert.deepEqual(args.orderBy, { tmdbId: "asc" });
  assert.deepEqual(args.select, { tmdbId: true, mediaType: true });
});

test("a short page ends iteration after exactly one round-trip", async () => {
  tables.plex = range(3, "MOVIE");
  const items = await drain(iterateLibrary("plex", "MOVIE"));
  assert.deepEqual(items, [
    { tmdbId: 1, mediaType: "MOVIE" },
    { tmdbId: 2, mediaType: "MOVIE" },
    { tmdbId: 3, mediaType: "MOVIE" },
  ]);
  assert.equal(calls.length, 1); // page.length < LIBRARY_PAGE_SIZE ⇒ no second query
});

test("exactly one full page: a second query with skip:1 and the last row as compound cursor, then stop on empty", async () => {
  tables.plex = range(LIBRARY_PAGE_SIZE, "MOVIE"); // ids 1..500
  const items = await drain(iterateLibrary("plex", "MOVIE"));

  assert.equal(items.length, LIBRARY_PAGE_SIZE);
  assert.equal(new Set(items.map((i) => i.tmdbId)).size, LIBRARY_PAGE_SIZE); // no dupes

  assert.equal(calls.length, 2);
  const second = calls[1].args;
  assert.equal(second.skip, 1); // skip the cursor row itself — the double-yield guard
  assert.deepEqual(second.cursor, {
    tmdbId_mediaType: { tmdbId: LIBRARY_PAGE_SIZE, mediaType: "MOVIE" },
  });
});

test("multi-page walk: cursors chain page tails, every row yielded exactly once in order", async () => {
  const total = 2 * LIBRARY_PAGE_SIZE + 203;
  tables.jellyfin = range(total, "TV");
  const items = await drain(iterateLibrary("jellyfin", "TV"));

  assert.equal(items.length, total);
  assert.deepEqual(items.map((i) => i.tmdbId), range(total, "TV").map((r) => r.tmdbId));

  // 500 + 500 + 203: the short third page terminates without a fourth query.
  assert.equal(calls.length, 3);
  assert.equal(calls[1].args.cursor?.tmdbId_mediaType.tmdbId, LIBRARY_PAGE_SIZE);
  assert.equal(calls[2].args.cursor?.tmdbId_mediaType.tmdbId, 2 * LIBRARY_PAGE_SIZE);
  assert.ok(calls.every((c) => c.source === "jellyfin"));
});

test("source and mediaType routing: each walk touches only its own delegate and type", async () => {
  tables.plex = [...range(2, "MOVIE"), ...range(2, "TV", 100)];
  tables.jellyfin = [...range(2, "MOVIE", 200), ...range(2, "TV", 300)];

  const plexTv = await drain(iterateLibrary("plex", "TV"));
  assert.deepEqual(plexTv, [
    { tmdbId: 100, mediaType: "TV" },
    { tmdbId: 101, mediaType: "TV" },
  ]);
  assert.ok(calls.every((c) => c.source === "plex" && c.args.where.mediaType === "TV"));

  calls.length = 0;
  const jfMovies = await drain(iterateLibrary("jellyfin", "MOVIE"));
  assert.deepEqual(jfMovies.map((i) => i.tmdbId), [200, 201]);
  assert.ok(calls.every((c) => c.source === "jellyfin" && c.args.where.mediaType === "MOVIE"));
});

// ── countUniqueLibraryItems ─────────────────────────────────────────────────

test("countUniqueLibraryItems: bigint count → JS number; SQL dedups with UNION, never UNION ALL", async () => {
  rawRows = [{ count: 1234n }]; // Postgres COUNT(*) arrives as bigint
  const count = await countUniqueLibraryItems();
  assert.equal(count, 1234);
  assert.equal(typeof count, "number");

  assert.equal(rawQueries.length, 1);
  const sql = norm(rawQueries[0].sql);
  assert.match(sql, /SELECT "tmdbId", "mediaType" FROM "PlexLibraryItem" UNION SELECT "tmdbId", "mediaType" FROM "JellyfinLibraryItem"/);
  // UNION ALL would double-count titles present on both servers.
  assert.doesNotMatch(sql, /UNION\s+ALL/i);
});

// ── collectAllLibraryItems ──────────────────────────────────────────────────

test("collect: fixed traversal order, cross-source dedup, and mediaType as part of identity", async () => {
  tables.plex = [
    { tmdbId: 1, mediaType: "MOVIE" },
    { tmdbId: 2, mediaType: "MOVIE" },
    { tmdbId: 2, mediaType: "TV" }, // same id, different type — must stay distinct
  ];
  tables.jellyfin = [
    { tmdbId: 2, mediaType: "MOVIE" }, // dup of plex — dropped
    { tmdbId: 3, mediaType: "MOVIE" },
    { tmdbId: 2, mediaType: "TV" }, // dup of plex TV — dropped
  ];

  // Cap far above the total also pins termination when the cap never bites.
  const items = await collectAllLibraryItems(100);
  assert.deepEqual(items, [
    { tmdbId: 1, mediaType: "MOVIE" }, // plex MOVIE first…
    { tmdbId: 2, mediaType: "MOVIE" },
    { tmdbId: 2, mediaType: "TV" }, // …then plex TV…
    { tmdbId: 3, mediaType: "MOVIE" }, // …then jellyfin MOVIE (minus dups)
  ]);
});

test("collect: hitting maxItems stops the fan-out — later sources are never queried", async () => {
  tables.plex = range(5, "MOVIE");
  tables.jellyfin = range(5, "MOVIE", 100);

  const items = await collectAllLibraryItems(3);
  assert.deepEqual(items.map((i) => i.tmdbId), [1, 2, 3]);

  // The break happens mid plex-MOVIE walk: no plex-TV query, no jellyfin
  // query of any kind — the whole point of capping before the fan-out.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].source, "plex");
  assert.deepEqual(calls[0].args.where, { mediaType: "MOVIE" });
});

test("PINS CURRENT BEHAVIOR: maxItems 0 still returns the first item (cap is checked after the push)", async () => {
  // The loop pushes, THEN checks `items.length >= maxItems`. Every live caller
  // passes a positive cap, so this is harmless today — but if the check ever
  // moves before the push, this pin is the one to flip.
  tables.plex = range(3, "MOVIE");
  const items = await collectAllLibraryItems(0);
  assert.deepEqual(items, [{ tmdbId: 1, mediaType: "MOVIE" }]);
});
