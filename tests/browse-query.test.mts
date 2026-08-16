// Unit tests for runBrowseQuery (src/lib/browse-query.ts) — the discover +
// enrichment pipeline shared by /movies, /tv and /api/browse.
//
// Why this file exists: until the extraction this logic lived in all three
// callers, and the branch that matters most — the "virtual page" window entered
// when a filter cannot be expressed as a TMDB query param — had ZERO coverage on
// any of them. `needsLoop` was never true in a single test, so nothing observed
// the window math, how many TMDB pages it fetched, or which of the fetched items
// actually reached the caller. Two real defects lived in that blind spot:
//
//   • the window fetches 5 TMDB pages (up to 100 items), filters them, and used
//     to return `slice(0, 20)`. Every survivor past the twentieth was discarded
//     PERMANENTLY, because virtual page 2 starts at TMDB page 6 and never looks
//     back. Items were lost whenever more than 20% of a window survived — so a
//     permissive filter is the bad case, not a restrictive one.
//   • /api/browse resolved 4K visibility with no media type, getting the OR of
//     both backends, while the two pages scoped it. That is what made 4K badges
//     appear on page 2 of /movies but not page 1.
//
// The pins below are written so that reintroducing either one goes red.
//
// No DB and no network: the TMDB layer is reached through a scripted
// globalThis.fetch (matching tests/tmdb.test.mts) and every Prisma delegate the
// enrichment touches is shadowed in-memory via tests/_helpers.mts (matching
// tests/attach-all.test.mts). TOKEN_ENCRYPTION_KEY is set before prisma.ts
// enters the module graph, so the source imports are dynamic — a static import
// would hoist above the assignment.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.TMDB_READ_TOKEN = "test-token";

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const { runBrowseQuery } = await import("../src/lib/browse-query.ts");
type SummonarrSession = import("../src/lib/api-auth.ts").SummonarrSession;

// ── scripted TMDB ───────────────────────────────────────────────────────────

/** Every TMDB page request this run made, in order, as page numbers. */
let fetchedPages: number[] = [];
/** Total TMDB pages the scripted API claims to have. */
const TOTAL_TMDB_PAGES = 500;

// 20 results per page, ids derived from the page so a caller can tell which
// TMDB page any item came from: page P yields ids P*100 … P*100+19.
function pageBody(page: number) {
  return {
    page,
    total_pages: TOTAL_TMDB_PAGES,
    total_results: TOTAL_TMDB_PAGES * 20,
    results: Array.from({ length: 20 }, (_, i) => ({
      id: page * 100 + i,
      title: `Movie ${page}-${i}`,
      overview: "",
      poster_path: null,
      backdrop_path: null,
      release_date: "2020-01-01",
      vote_average: 7,
    })),
  };
}

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(typeof input === "string" ? input : input.toString());
  const page = parseInt(url.searchParams.get("page") ?? "1", 10);
  fetchedPages.push(page);
  return new Response(JSON.stringify(pageBody(page)), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

// ── in-memory Prisma ────────────────────────────────────────────────────────

/** tmdbIds the Plex library "holds" — drives the hideAvailable filter. */
let plexHeld = new Set<number>();
/** Settings rows, keyed by key. */
let settings = new Map<string, string>();

// tmdbCache serves two very different readers here.
//
// findUnique is the DISCOVER page cache — always a miss, so every call reaches
// the scripted fetch and `fetchedPages` stays an honest record of the window.
//
// findMany is the RATINGS warm cache, and it must always HIT. A miss or a stale
// row makes attachRatingsUnified schedule revalidation through next/server's
// after(), which throws outside a request scope. Seeding a fresh _notFound
// sentinel for every id is the same trick tests/attach-all.test.mts uses: it
// reads as "no ratings" for display and never re-enters the miss fan-out.
shadowPrismaModel(prisma, "tmdbCache", {
  findUnique: async () => null,
  findMany: async (args: { where: { key: { in: string[] } } }) => {
    const fresh = new Date(Date.now() + 60 * 60 * 1000);
    return args.where.key.in.map((key) => ({
      key,
      data: JSON.stringify({ _notFound: true }),
      cachedAt: new Date(),
      expiresAt: fresh,
    }));
  },
  upsert: async () => ({}),
  deleteMany: async () => ({ count: 0 }),
});
shadowPrismaModel(prisma, "plexLibraryItem", {
  findMany: async (args: { where: { tmdbId: { in: number[] } } }) =>
    args.where.tmdbId.in.filter((id) => plexHeld.has(id)).map((tmdbId) => ({ tmdbId })),
});
// The core-sync writer fires as a side effect of every TMDB page parse. It
// already swallows its own failures, but an unshadowed model logs a Prisma
// error per page and drowns the output.
shadowPrismaModel(prisma, "tmdbMediaCore", {
  findMany: async () => [],
  upsert: async () => ({}),
  createMany: async () => ({ count: 0 }),
  updateMany: async () => ({ count: 0 }),
});
shadowPrismaModel(prisma, "jellyfinLibraryItem", { findMany: async () => [] });
shadowPrismaModel(prisma, "radarrWantedItem", { findMany: async () => [] });
shadowPrismaModel(prisma, "radarrAvailableItem", { findMany: async () => [] });
shadowPrismaModel(prisma, "sonarrWantedItem", { findMany: async () => [] });
shadowPrismaModel(prisma, "sonarrAvailableItem", { findMany: async () => [] });
shadowPrismaModel(prisma, "mediaRequest", { findMany: async () => [] });
shadowPrismaModel(prisma, "blacklistItem", { findMany: async () => [] });
shadowPrismaModel(prisma, "hiddenItem", { findMany: async () => [] });
shadowPrismaModel(prisma, "user", { findUnique: async () => null });
shadowPrismaModel(prisma, "setting", {
  findMany: async (args?: { where?: { key?: { in?: string[] } } }) => {
    const keys = args?.where?.key?.in;
    return [...settings.entries()]
      .filter(([k]) => !keys || keys.includes(k))
      .map(([key, value]) => ({ key, value }));
  },
  findUnique: async (args: { where: { key: string } }) => {
    const value = settings.get(args.where.key);
    return value === undefined ? null : { key: args.where.key, value };
  },
});

function session(): SummonarrSession {
  return {
    user: { id: "u1", permissions: 1n, mediaServer: "plex" },
  } as unknown as SummonarrSession;
}

beforeEach(() => {
  fetchedPages = [];
  plexHeld = new Set();
  settings = new Map();
});

// ── the window ──────────────────────────────────────────────────────────────

test("no local filter ⇒ ONE TMDB page, fetched at the requested page number", async () => {
  const r = await runBrowseQuery({
    mediaType: "movie", page: 3, filters: {}, hideAvailable: false, session: session(),
  });
  assert.deepEqual(fetchedPages, [3], "an expressible query must not open the 5-page window");
  assert.equal(r.items.length, 20);
  assert.equal(r.totalPages, TOTAL_TMDB_PAGES, "totalPages passes through untouched");
});

test("hideAvailable ⇒ the 5-page window, at (page-1)*5+1 … +4", async () => {
  const r = await runBrowseQuery({
    mediaType: "movie", page: 2, filters: {}, hideAvailable: true, session: session(),
  });
  assert.deepEqual(
    [...fetchedPages].sort((a, b) => a - b),
    [6, 7, 8, 9, 10],
    "virtual page 2 covers TMDB pages 6-10",
  );
  assert.equal(r.totalPages, 100, "500 TMDB pages / 5 = 100 virtual pages");
});

// THE regression pin. Nothing rejected ⇒ the whole 100-item window survives the
// filter, and every one of them must come back. `slice(0, PAGE_SIZE)` returns 20
// here and permanently strands the other 80.
test("the FULL filtered window is returned — survivors past the 20th are not dropped", async () => {
  const r = await runBrowseQuery({
    mediaType: "movie", page: 1, filters: {}, hideAvailable: true, session: session(),
  });
  assert.equal(
    r.items.length, 100,
    "5 TMDB pages x 20, nothing filtered out — a 20-item result means the slice is back",
  );
});

// The consequence that makes the slice a correctness bug rather than a display
// one: page 2 starts a fresh window, so anything page 1 withheld is unreachable.
test("virtual pages 1 and 2 are disjoint, so a dropped survivor is reachable from NEITHER", async () => {
  const p1 = await runBrowseQuery({
    mediaType: "movie", page: 1, filters: {}, hideAvailable: true, session: session(),
  });
  fetchedPages = [];
  const p2 = await runBrowseQuery({
    mediaType: "movie", page: 2, filters: {}, hideAvailable: true, session: session(),
  });

  const ids1 = new Set(p1.items.map((i) => i.id));
  const ids2 = new Set(p2.items.map((i) => i.id));
  assert.equal([...ids1].filter((id) => ids2.has(id)).length, 0, "the two windows never overlap");

  // Union must be every id TMDB served across pages 1-10. If page 1 returned
  // only 20 of its 100, ids 100*1+20 … through page 5 are in NO result set.
  const expected = new Set<number>();
  for (let p = 1; p <= 10; p++) for (let i = 0; i < 20; i++) expected.add(p * 100 + i);
  const union = new Set([...ids1, ...ids2]);
  assert.equal(union.size, expected.size, `expected ${expected.size} distinct items across two pages, got ${union.size}`);
  for (const id of expected) assert.ok(union.has(id), `id ${id} is unreachable from either page`);
});

test("hideAvailable actually removes held titles, and only those", async () => {
  // Hold every id on TMDB page 1 — 20 of the window's 100.
  for (let i = 0; i < 20; i++) plexHeld.add(100 + i);
  const r = await runBrowseQuery({
    mediaType: "movie", page: 1, filters: {}, hideAvailable: true, session: session(),
  });
  assert.equal(r.items.length, 80, "the 20 held titles are filtered out, the other 80 survive");
  assert.ok(!r.items.some((i) => plexHeld.has(i.id)), "no held title survives");
});

// ── the divergence that made page 1 and page 2 disagree ─────────────────────

// getShow4kVisibility(session) with no media type returns movieShow || tvShow.
// The route called it that way while the pages scoped it, which is exactly why
// 4K badges appeared on client-fetched pages of /movies and not on the first.
// Sonarr-4K configured + TV-only 4K permission must NOT light up a movie query.
test("4K visibility is resolved with THIS request's media type, not the OR of both", async () => {
  settings.set("sonarr4kUrl", "http://sonarr4k.local");
  settings.set("sonarr4kApiKey", "k");
  settings.set("show4kBadges", "true");

  const movie = await runBrowseQuery({
    mediaType: "movie", page: 1, filters: {}, hideAvailable: false, session: session(),
  });
  // arr4kPending/arr4kAvailable are key-present-but-undefined unless show4k was
  // passed through to the enrichment (see tests/attach-all.test.mts).
  const anyMovie4k = movie.items.some(
    (i) => "arr4kPending" in i && (i as { arr4kPending?: boolean }).arr4kPending !== undefined,
  );
  assert.equal(
    anyMovie4k, false,
    "a movie query must not inherit 4K state from the Sonarr side — that is the unscoped OR",
  );
});
