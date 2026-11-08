// Scan 2026-09-22, partition P13 — guardrail 41 pins for prewarmLibraryCache
// (src/lib/tmdb-prewarm.ts). The walk checks its AbortSignal per ITEM, but the
// page buffer used to be flushed unconditionally after the loop, and the
// per-page fetch loop never looked at the signal: an aborted run (the advisory
// lock already released) still issued up to LIBRARY_PAGE_SIZE - 1 TMDB fetches
// lock-free. Both leaks are pinned here.
//
// No DB or network: library/cache/core delegates are in-memory, fetch is
// scripted, and dns.lookup is stubbed (see tests/tmdb-prewarm.test.mts, whose
// harness this trims down).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.TMDB_READ_TOKEN = "test-tmdb-token";

const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) {
  throw new Error("could not stub dns.lookup — aborting before a real DNS query can leave the process");
}

const warns: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = () => {};

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const { prewarmLibraryCache } = await import("../src/lib/tmdb-prewarm.ts");

type MediaType = "MOVIE" | "TV";
type Row = { tmdbId: number; mediaType: MediaType };
const tables: Record<"plex" | "jellyfin", Row[]> = { plex: [], jellyfin: [] };
let onLibraryRead: (source: "plex" | "jellyfin", mediaType: MediaType) => void = () => {};

function libraryDelegate(source: "plex" | "jellyfin") {
  return {
    findMany: async (args: { where: { mediaType: MediaType }; take: number; cursor?: unknown }) => {
      onLibraryRead(source, args.where.mediaType);
      if (args.cursor) return []; // every fixture fits in one page
      return tables[source]
        .filter((r) => r.mediaType === args.where.mediaType)
        .slice(0, args.take)
        .map((r) => ({ ...r, serverInstance: "" }));
    },
  };
}
shadowPrismaModel(prisma, "plexLibraryItem", libraryDelegate("plex"));
shadowPrismaModel(prisma, "jellyfinLibraryItem", libraryDelegate("jellyfin"));

// Empty cache: every item is stale, so every item is a fetch candidate.
shadowPrismaModel(prisma, "tmdbCache", {
  findMany: async () => [],
  findUnique: async () => null,
  upsert: async (args: { create: unknown }) => args.create,
});
shadowPrismaModel(prisma, "tmdbMediaCore", {
  findMany: async () => [],
  upsert: async (args: unknown) => args,
});

const fetched: number[] = [];
let onFetch: (id: number) => void = () => {};
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  const id = Number(url.pathname.split("/").pop());
  fetched.push(id);
  onFetch(id);
  return new Response(JSON.stringify({ id, title: `M${id}` }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

beforeEach(() => {
  tables.plex = [];
  tables.jellyfin = [];
  fetched.length = 0;
  warns.length = 0;
  onLibraryRead = () => {};
  onFetch = () => {};
});

test("an abort that lands after the last item is walked skips the final partial-page flush — zero fetches", async () => {
  // Six stale movies: far below LIBRARY_PAGE_SIZE, so they are only ever
  // processed by the post-loop flush. The abort fires on the NEXT library read
  // (plex TV), after every item was buffered but before that flush. (The
  // skipped flush and the batch-boundary check both stop this; it fails only
  // when both are removed — the second test pins the boundary check alone.)
  tables.plex = Array.from({ length: 6 }, (_, i): Row => ({ tmdbId: 100 + i, mediaType: "MOVIE" }));
  const controller = new AbortController();
  onLibraryRead = (source, mediaType) => {
    if (source === "plex" && mediaType === "TV") controller.abort();
  };

  const result = await prewarmLibraryCache({ signal: controller.signal });
  assert.equal(fetched.length, 0, "no TMDB fetch may be issued once the lock has been released");
  assert.equal(result.fetched, 0);
});

test("an abort during a page's fetch batches stops at the next batch boundary", async () => {
  // Six stale movies = two CONCURRENCY=5 batches. Aborting inside the first
  // batch must keep the sixth fetch from ever being issued.
  tables.plex = Array.from({ length: 6 }, (_, i): Row => ({ tmdbId: 200 + i, mediaType: "MOVIE" }));
  const controller = new AbortController();
  let armed = false;
  // Abort only once the walk has finished buffering (the flush is running), so
  // the per-item check in the walk loop doesn't pre-empt the batch loop.
  onLibraryRead = (source, mediaType) => {
    if (source === "jellyfin" && mediaType === "TV") armed = true;
  };
  onFetch = () => {
    if (armed) controller.abort();
  };

  await prewarmLibraryCache({ signal: controller.signal });
  assert.equal(fetched.length, 5, "the second batch must not start after the abort");
});
