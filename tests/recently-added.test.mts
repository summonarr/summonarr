// Unit tests for the home page's "Recently Added" shelf (src/lib/recently-added.ts).
//
// What is pinned, and why each matters:
//   1. DEDUPE + ORDER. One title can be a row on several servers (Plex and
//      Jellyfin, or two Plex instances — PlexLibraryItem is keyed by
//      serverInstance). The shelf shows it once, dated by its NEWEST add, and
//      the order is total (ties broken deterministically) so the rail never
//      reshuffles between renders. A movie and a TV show that share a TMDB
//      number are different titles and must never collapse.
//   2. RESTRICTED-INSTANCE VISIBILITY (guardrail 35). A server marked
//      `restricted` contributes ONLY to users granted it, and that must be
//      decided in the QUERY: the shelf is a list of titles, so a restricted
//      server's newest arrival leaking onto an ungranted user's home page is
//      exactly the fact the grant exists to withhold. attachAllAvailability
//      can't catch it — it only decides the badge, not whether a title appears.
//   3. THE CACHE IS KEYED BY THE VISIBLE SET. A cached list built for a granted
//      viewer must never be served to an ungranted one.
//   4. SOURCES follow the viewer's own server pin and the integration flags.
//   5. POSTERS come from TmdbMediaCore first, the `:details` cache second —
//      never a TMDB call (guardrail 31).
//
// Harness: in-memory prisma stubs that honour `serverInstance IN (…)`,
// `addedAt` desc ordering and `take` the way Postgres would. No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const {
  mergeRecentlyAdded,
  recentlyAddedSources,
  getRecentlyAddedForViewer,
  clearRecentlyAddedCache,
  RECENTLY_ADDED_OVERFETCH,
} = await import("../src/lib/recently-added.ts");
const { Permission } = await import("../src/lib/permissions.ts");
type SummonarrSession = import("../src/lib/api-auth.ts").SummonarrSession;
type RecentLibraryRow = import("../src/lib/recently-added.ts").RecentLibraryRow;

// Network guard: nothing here may reach TMDB.
globalThis.fetch = (async () => {
  throw new Error("unexpected network call from the recently-added shelf");
}) as unknown as typeof fetch;

// ── in-memory library ───────────────────────────────────────────────────────
type LibRow = RecentLibraryRow & { serverInstance: string };
type LibArgs = {
  where: { addedAt?: { not: null }; tmdbId?: { gt: number }; serverInstance?: { in: string[] } };
  orderBy?: { addedAt: "desc" };
  take?: number;
};

function makeLibrary() {
  const state = { rows: [] as LibRow[], args: [] as LibArgs[] };
  const stub = {
    findMany: async (args: LibArgs) => {
      state.args.push(args);
      let rows = state.rows.filter((r) => r.addedAt != null && r.tmdbId > 0);
      // Honour the instance allowlist exactly as Postgres would. A query with
      // NO allowlist returns every server's rows — which is what an unscoped
      // (gate-less) read would really get, so the visibility pin can bite.
      const allow = args.where.serverInstance?.in;
      if (allow) rows = rows.filter((r) => allow.includes(r.serverInstance));
      rows = [...rows].sort((a, b) => b.addedAt!.getTime() - a.addedAt!.getTime());
      if (args.take != null) rows = rows.slice(0, args.take);
      return rows.map(({ serverInstance: _s, ...rest }) => rest);
    },
  };
  return { state, stub };
}
const plexLib = makeLibrary();
const jellyfinLib = makeLibrary();

type CoreRow = { tmdbId: number; mediaType: "MOVIE" | "TV"; title: string; posterPath: string | null; releaseYear: string | null; voteAverage: number; certification: string | null };
const core = { rows: [] as CoreRow[], calls: 0 };
const detailsCache = { rows: [] as { key: string; data: string }[] };

const registry = new Map<string, string>();
const grantsByUser = new Map<string, unknown>();

shadowPrismaModel(prisma, "plexLibraryItem", plexLib.stub);
shadowPrismaModel(prisma, "jellyfinLibraryItem", jellyfinLib.stub);
shadowPrismaModel(prisma, "tmdbMediaCore", {
  findMany: async (args: { where: { tmdbId: { in: number[] } } }) => {
    core.calls += 1;
    return core.rows.filter((r) => args.where.tmdbId.in.includes(r.tmdbId));
  },
});
shadowPrismaModel(prisma, "tmdbCache", {
  findMany: async (args: { where: { key: { in: string[] } } }) =>
    detailsCache.rows.filter((r) => args.where.key.in.includes(r.key)),
});
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    const v = registry.get(args.where.key);
    return v !== undefined ? { key: args.where.key, value: v } : null;
  },
});
shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id: string } }) => ({
    role: "USER",
    permissions: 0n,
    mediaServerGrants: grantsByUser.get(args.where.id) ?? null,
  }),
});

function session(id: string, mediaServer: string | null = "plex", permissions = 0n): SummonarrSession {
  return { user: { id, role: "USER", permissions, mediaServer } };
}

const day = (n: number) => new Date(Date.UTC(2026, 8, n));
function lib(tmdbId: number, mediaType: "MOVIE" | "TV", addedAt: Date | null, serverInstance = "", title: string | null = `T${tmdbId}`): LibRow {
  return { tmdbId, mediaType, addedAt, title, year: "2026", serverInstance };
}

const ALL_ON = { plex: true, jellyfin: true };

beforeEach(() => {
  plexLib.state.rows = [];
  plexLib.state.args = [];
  jellyfinLib.state.rows = [];
  jellyfinLib.state.args = [];
  core.rows = [];
  core.calls = 0;
  detailsCache.rows = [];
  registry.clear();
  grantsByUser.clear();
  clearRecentlyAddedCache();
});

// ── 1: dedupe + order (pure) ────────────────────────────────────────────────

test("one entry per title, dated by its NEWEST add across every source and server", () => {
  const plex = [lib(10, "MOVIE", day(3)), lib(10, "MOVIE", day(1), "remote")];
  const jellyfin = [lib(10, "MOVIE", day(7)), lib(20, "TV", day(5))];
  const out = mergeRecentlyAdded([plex, jellyfin], 10);
  assert.deepEqual(
    out.map((e) => [e.mediaType, e.tmdbId, e.addedAt.toISOString()]),
    [
      ["MOVIE", 10, day(7).toISOString()],
      ["TV", 20, day(5).toISOString()],
    ],
  );
});

test("the newest add wins regardless of which list it arrives in", () => {
  // Older copy LAST: a last-write-wins merge would date the title day(1).
  const out = mergeRecentlyAdded([[lib(10, "MOVIE", day(9))], [lib(10, "MOVIE", day(1))]], 10);
  assert.equal(out[0].addedAt.toISOString(), day(9).toISOString());
});

test("a movie and a TV show sharing a TMDB number are two titles", () => {
  const out = mergeRecentlyAdded([[lib(1399, "MOVIE", day(2)), lib(1399, "TV", day(3))]], 10);
  assert.deepEqual(out.map((e) => `${e.mediaType}:${e.tmdbId}`), ["TV:1399", "MOVIE:1399"]);
});

test("newest first, ties broken by mediaType then tmdbId (a total order)", () => {
  const rows = [lib(30, "TV", day(4)), lib(5, "MOVIE", day(4)), lib(2, "MOVIE", day(4)), lib(99, "MOVIE", day(6))];
  const forward = mergeRecentlyAdded([rows], 10).map((e) => `${e.mediaType}:${e.tmdbId}`);
  const reversed = mergeRecentlyAdded([[...rows].reverse()], 10).map((e) => `${e.mediaType}:${e.tmdbId}`);
  assert.deepEqual(forward, ["MOVIE:99", "MOVIE:2", "MOVIE:5", "TV:30"]);
  assert.deepEqual(reversed, forward, "input order must not change the rail");
});

test("rows with no addedAt or a non-positive tmdbId are skipped, and the limit caps the list", () => {
  const out = mergeRecentlyAdded(
    [[lib(1, "MOVIE", null), lib(0, "MOVIE", day(9)), lib(2, "MOVIE", day(1)), lib(3, "MOVIE", day(2)), lib(4, "MOVIE", day(3))]],
    2,
  );
  assert.deepEqual(out.map((e) => e.tmdbId), [4, 3]);
});

test("a missing title on the newest row falls back to another copy's title", () => {
  const out = mergeRecentlyAdded([[lib(7, "MOVIE", day(9), "", null)], [lib(7, "MOVIE", day(1), "", "Named")]], 10);
  assert.equal(out[0].title, "Named");
});

// ── 4: sources (pure) ───────────────────────────────────────────────────────

test("sources follow the user's server pin, the union when unpinned, and the integration flags", () => {
  assert.deepEqual(recentlyAddedSources({ showPlex: true, showJellyfin: false }, ALL_ON), { plex: true, jellyfin: false });
  assert.deepEqual(recentlyAddedSources({ showPlex: false, showJellyfin: true }, ALL_ON), { plex: false, jellyfin: true });
  assert.deepEqual(recentlyAddedSources({ showPlex: false, showJellyfin: false }, ALL_ON), { plex: true, jellyfin: true });
  assert.deepEqual(recentlyAddedSources({ showPlex: true, showJellyfin: true }, { plex: false, jellyfin: true }), { plex: false, jellyfin: true });
  // A Plex-pinned user with Plex switched off gets NOTHING — not the Jellyfin library.
  assert.deepEqual(recentlyAddedSources({ showPlex: true, showJellyfin: false }, { plex: false, jellyfin: true }), { plex: false, jellyfin: false });
});

test("a Plex-pinned viewer never reads the Jellyfin library", async () => {
  plexLib.state.rows = [lib(1, "MOVIE", day(1))];
  jellyfinLib.state.rows = [lib(2, "MOVIE", day(2))];
  const out = await getRecentlyAddedForViewer(session("u", "plex"), ALL_ON);
  assert.deepEqual(out.map((m) => m.id), [1]);
  assert.equal(jellyfinLib.state.args.length, 0);
});

// ── 2: restricted-instance visibility ──────────────────────────────────────

test("a restricted server's arrivals reach ONLY a granted viewer, and the gate is in the query", async () => {
  registry.set("plexInstances", JSON.stringify([{ slug: "remote", name: "Friend's", restricted: true }]));
  plexLib.state.rows = [
    lib(100, "MOVIE", day(1), ""),
    lib(603, "MOVIE", day(9), "remote"), // newest, but ONLY on the restricted server
  ];
  grantsByUser.set("u_granted", { plex: { remote: { view: true } } });

  const ungranted = await getRecentlyAddedForViewer(session("u_plain"), ALL_ON);
  assert.deepEqual(
    ungranted.map((m) => m.id),
    [100],
    "an ungranted viewer must not see a restricted server's newest arrival",
  );
  assert.deepEqual(plexLib.state.args[0].where.serverInstance, { in: [""] }, "the scope belongs in the WHERE clause");

  const granted = await getRecentlyAddedForViewer(session("u_granted"), ALL_ON);
  assert.deepEqual(granted.map((m) => m.id), [603, 100]);
  assert.deepEqual(plexLib.state.args[1].where.serverInstance, { in: ["", "remote"] });
});

test("a restricted Jellyfin server is gated the same way", async () => {
  registry.set("jellyfinInstances", JSON.stringify([{ slug: "attic", name: "Attic", restricted: true }]));
  jellyfinLib.state.rows = [lib(5, "TV", day(3), "attic"), lib(6, "TV", day(2), "")];
  const out = await getRecentlyAddedForViewer(session("u_plain", "jellyfin"), ALL_ON);
  assert.deepEqual(out.map((m) => m.id), [6]);
});

test("ADMIN sees a restricted server without holding a grant", async () => {
  registry.set("plexInstances", JSON.stringify([{ slug: "remote", name: "Friend's", restricted: true }]));
  plexLib.state.rows = [lib(603, "MOVIE", day(9), "remote")];
  const out = await getRecentlyAddedForViewer(session("admin", null, Permission.ADMIN), ALL_ON);
  assert.deepEqual(out.map((m) => m.id), [603]);
});

// ── 3: cache keyed by the visible set ──────────────────────────────────────

test("the cached list is reused for the same visible set and NEVER crosses to a different one", async () => {
  registry.set("plexInstances", JSON.stringify([{ slug: "remote", name: "Friend's", restricted: true }]));
  plexLib.state.rows = [lib(100, "MOVIE", day(1), ""), lib(603, "MOVIE", day(9), "remote")];
  grantsByUser.set("u_granted", { plex: { remote: { view: true } } });

  // Granted first, so a signature-blind cache would hand 603 to the next caller.
  assert.deepEqual((await getRecentlyAddedForViewer(session("u_granted"), ALL_ON)).map((m) => m.id), [603, 100]);
  assert.deepEqual((await getRecentlyAddedForViewer(session("u_plain"), ALL_ON)).map((m) => m.id), [100]);
  assert.equal(plexLib.state.args.length, 2);

  // A second ungranted viewer shares the first's entry: no further library read.
  assert.deepEqual((await getRecentlyAddedForViewer(session("u_plain_2"), ALL_ON)).map((m) => m.id), [100]);
  assert.equal(plexLib.state.args.length, 2, "same visible set ⇒ served from cache");
});

test("no visible source ⇒ no library read at all", async () => {
  const out = await getRecentlyAddedForViewer(session("u", "plex"), { plex: false, jellyfin: false });
  assert.deepEqual(out, []);
  assert.equal(plexLib.state.args.length + jellyfinLib.state.args.length, 0);
});

// ── 5: titles/posters from the local caches ────────────────────────────────

test("TmdbMediaCore supplies title/poster/year; the :details cache backs a missing poster", async () => {
  plexLib.state.rows = [lib(1, "MOVIE", day(3), "", "Library Title"), lib(2, "TV", day(2), "", "Show"), lib(3, "MOVIE", day(1), "", "Bare")];
  core.rows = [
    { tmdbId: 1, mediaType: "MOVIE", title: "Core Title", posterPath: "/core.jpg", releaseYear: "1999", voteAverage: 8.1, certification: "R" },
    // Same number, other medium — must not lend its poster to MOVIE 2 / TV 2 confusion.
    { tmdbId: 2, mediaType: "MOVIE", title: "Wrong Medium", posterPath: "/wrong.jpg", releaseYear: "2001", voteAverage: 1, certification: null },
  ];
  detailsCache.rows = [{ key: "tv:2:details", data: JSON.stringify({ posterPath: "/show.jpg" }) }];

  const out = await getRecentlyAddedForViewer(session("u", "plex"), ALL_ON);
  assert.deepEqual(
    out.map((m) => [m.mediaType, m.id, m.title, m.posterPath, m.releaseYear]),
    [
      ["movie", 1, "Core Title", "/core.jpg", "1999"],
      ["tv", 2, "Show", "/show.jpg", "2026"],
      ["movie", 3, "Bare", null, "2026"],
    ],
  );
  assert.equal(out[0].certification, "R");
  assert.equal(out[0].voteAverage, 8.1);
});

test("the list is capped at the overfetch even when the library is large", async () => {
  plexLib.state.rows = Array.from({ length: 100 }, (_, i) => lib(i + 1, "MOVIE", new Date(Date.UTC(2026, 0, 1, 0, i))));
  const out = await getRecentlyAddedForViewer(session("u", "plex"), ALL_ON);
  assert.equal(out.length, RECENTLY_ADDED_OVERFETCH);
  assert.equal(out[0].id, 100, "newest first");
  assert.ok((plexLib.state.args[0].take ?? Infinity) <= 100, "the library read is bounded by take");
});
