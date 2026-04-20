import "server-only";
import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import type { TmdbMedia } from "@/lib/tmdb-types";
import type { OmdbRatings } from "@/lib/omdb";
import { getOmdbRatingsForTmdb } from "@/lib/omdb";
import type { MdblistRatings } from "@/lib/mdblist";
import { getMdblistRatingsForTmdb, fetchMdblistBatch, isMdblistQuotaLocked } from "@/lib/mdblist";

// MDBList provides richer data than OMDB; this is the canonical merge function for list-based flows.
function applyMdblist(item: TmdbMedia, d: MdblistRatings): TmdbMedia {
  return {
    ...item,
    imdbId:           d.imdbId,
    imdbRating:       d.imdbRating,
    imdbVotes:        d.imdbVotes,
    rottenTomatoes:   d.rottenTomatoes,
    rtAudienceScore:  d.rtAudienceScore,
    metacritic:       d.metacritic,
    traktRating:      d.traktRating,
    letterboxdRating: d.letterboxdRating,
    mdblistScore:     d.mdblistScore,
    malRating:        d.malRating,
    rogerEbertRating: d.rogerEbertRating,
    releasedDigital:  d.releasedDigital,

    // Prefer an already-resolved YouTube trailerKey over the MDBList trailer URL to avoid
    // overwriting a direct key with a potentially different or lower-quality source.
    ...(item.trailerKey ? {} : { trailerUrl: d.trailerUrl }),
  };
}

function applyOmdb(item: TmdbMedia, d: OmdbRatings): TmdbMedia {
  return {
    ...item,
    imdbId:         d.imdbId,
    imdbRating:     d.imdbRating,
    imdbVotes:      d.imdbVotes,
    rottenTomatoes: d.rottenTomatoes,
    metacritic:     d.metacritic,
  };
}

export async function attachOmdbRatingsBlocking(items: TmdbMedia[]): Promise<TmdbMedia[]> {
  return attachRatingsUnified(items, { blocking: true });
}

export async function attachRatingsUnified(
  items: TmdbMedia[],
  opts: { blocking?: boolean } = {},
): Promise<TmdbMedia[]> {
  if (items.length === 0) return items;
  const blocking = opts.blocking ?? false;

  const warm = await readCachedRatings(items);

  if (!blocking) {
    const uncached = items.filter((item) => !warm.byMdblist.has(mdblistKey(item)) && !warm.byOmdb.has(omdbKey(item)));
    if (uncached.length > 0) {
      // Non-blocking path: fire background fetches after the response is sent so the user isn't
      // held waiting; the next page load will hit the warm cache.
      after(async () => {
        if (!isMdblistQuotaLocked()) {
          const movieUncached = uncached.filter((m) => m.mediaType === "movie");
          const tvUncached    = uncached.filter((m) => m.mediaType === "tv");
          const [movieRatings, tvRatings] = await Promise.all([
            movieUncached.length > 0 ? fetchMdblistBatch(movieUncached, "movie") : Promise.resolve(new Map<number, MdblistRatings>()),
            tvUncached.length    > 0 ? fetchMdblistBatch(tvUncached,    "tv")    : Promise.resolve(new Map<number, MdblistRatings>()),
          ]);
          const found = new Set([...movieRatings.keys(), ...tvRatings.keys()]);

          const stillMissing = uncached.filter((m) => !found.has(m.id));
          if (stillMissing.length > 0) {
            const probe = await getMdblistRatingsForTmdb(stillMissing[0].id, stillMissing[0].mediaType, stillMissing[0].releaseDate).catch(() => null);
            if (probe && !probe.found && !probe.keyConfigured) {
              await Promise.all(stillMissing.map((item) => getOmdbRatingsForTmdb(item.id, item.mediaType, item.releaseDate).catch(() => {})));
            }
          }
        } else {
          await Promise.all(uncached.map((item) => getOmdbRatingsForTmdb(item.id, item.mediaType, item.releaseDate).catch(() => {})));
        }
      });
    }
    return items.map((item) => mergeWarm(item, warm));
  }

  const misses: TmdbMedia[] = [];
  const fetched = new Map<number, { source: "mdblist"; data: MdblistRatings } | { source: "omdb"; data: OmdbRatings }>();
  for (const item of items) {
    if (!warm.byMdblist.has(mdblistKey(item)) && !warm.byOmdb.has(omdbKey(item))) misses.push(item);
  }

  if (misses.length > 0) {
    if (!isMdblistQuotaLocked()) {
      // Batch by media type — MDBList's bulk endpoint is type-specific
      const movieMisses = misses.filter((m) => m.mediaType === "movie");
      const tvMisses    = misses.filter((m) => m.mediaType === "tv");

      const [movieRatings, tvRatings] = await Promise.all([
        movieMisses.length > 0 ? fetchMdblistBatch(movieMisses, "movie") : Promise.resolve(new Map<number, MdblistRatings>()),
        tvMisses.length    > 0 ? fetchMdblistBatch(tvMisses,    "tv")    : Promise.resolve(new Map<number, MdblistRatings>()),
      ]);

      for (const [id, data] of movieRatings) fetched.set(id, { source: "mdblist", data });
      for (const [id, data] of tvRatings)    fetched.set(id, { source: "mdblist", data });

      const mdbMisses = misses.filter((m) => !fetched.has(m.id));
      if (mdbMisses.length > 0) {
        // Probe a single item to check whether MDBList is configured; if it isn't, fall back to OMDB
        // for all remaining misses rather than checking every item individually.
        const probe = await getMdblistRatingsForTmdb(mdbMisses[0].id, mdbMisses[0].mediaType, mdbMisses[0].releaseDate).catch(() => null);
        const useFallback = probe && !probe.found && !probe.keyConfigured;
        if (useFallback) {
          await Promise.all(
            mdbMisses.map(async (item) => {
              const omdb = await getOmdbRatingsForTmdb(item.id, item.mediaType, item.releaseDate).catch(() => null);
              if (omdb && omdb.found) fetched.set(item.id, { source: "omdb", data: omdb.data });
            }),
          );
        }
      }
    } else {

      await Promise.all(
        misses.map(async (item) => {
          const omdb = await getOmdbRatingsForTmdb(item.id, item.mediaType, item.releaseDate).catch(() => null);
          if (omdb && omdb.found) fetched.set(item.id, { source: "omdb", data: omdb.data });
        }),
      );
    }
  }

  return items.map((item) => {
    const fresh = fetched.get(item.id);
    if (fresh) return fresh.source === "mdblist" ? applyMdblist(item, fresh.data) : applyOmdb(item, fresh.data);
    return mergeWarm(item, warm);
  });
}

function mdblistKey(item: TmdbMedia): string { return `mdblist:tmdb:${item.mediaType}:${item.id}`; }
function omdbKey(item: TmdbMedia): string    { return `omdb:tmdb:${item.mediaType}:${item.id}`; }

type WarmCache = { byMdblist: Map<string, MdblistRatings>; byOmdb: Map<string, OmdbRatings> };

async function readCachedRatings(items: TmdbMedia[]): Promise<WarmCache> {
  const mdblistKeys = items.map(mdblistKey);
  const omdbKeys    = items.map(omdbKey);

  const [mdblistRows, omdbRows] = await Promise.all([
    prisma.tmdbCache.findMany({
      where: { key: { in: mdblistKeys }, expiresAt: { gt: new Date() } },
      select: { key: true, data: true },
    }),
    prisma.tmdbCache.findMany({
      where: { key: { in: omdbKeys }, expiresAt: { gt: new Date() } },
      select: { key: true, data: true },
    }),
  ]);

  const byMdblist = new Map<string, MdblistRatings>();
  for (const row of mdblistRows) {
    try {
      const parsed = JSON.parse(row.data) as MdblistRatings | { _notFound: true };
      if (!("_notFound" in parsed)) byMdblist.set(row.key, parsed);
    } catch { }
  }

  const byOmdb = new Map<string, OmdbRatings>();
  for (const row of omdbRows) {
    try {
      const parsed = JSON.parse(row.data) as OmdbRatings | { _notFound: true };
      if (!("_notFound" in parsed)) byOmdb.set(row.key, parsed);
    } catch { }
  }

  return { byMdblist, byOmdb };
}

function mergeWarm(item: TmdbMedia, warm: WarmCache): TmdbMedia {
  const mdb  = warm.byMdblist.get(mdblistKey(item));
  const omdb = warm.byOmdb.get(omdbKey(item));
  if (mdb)  return applyMdblist(item, mdb);
  if (omdb) return applyOmdb(item, omdb);
  return item;
}

export async function attachOmdbRatings(items: TmdbMedia[]): Promise<TmdbMedia[]> {
  return attachRatingsUnified(items, { blocking: false });
}
