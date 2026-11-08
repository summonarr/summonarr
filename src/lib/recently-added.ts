import "server-only";
import { prisma } from "@/lib/prisma";
import { processSingleton } from "@/lib/process-singleton";
import { coalesce } from "@/lib/concurrency";
import { resolvePosterPathMap, posterPathKey } from "@/lib/poster-cache";
import { getVisibleServerInstances, type VisibleServerInstances } from "@/lib/media-visibility";
import { getBadgeVisibility } from "@/lib/badge-visibility";
import type { SummonarrSession } from "@/lib/api-auth";
import type { TmdbMedia } from "@/lib/tmdb-types";

// The user-facing "Recently added" home shelf: what most recently landed on the
// Plex/Jellyfin server(s) THIS viewer can see.
//
// Visibility is enforced in the QUERY (guardrail 35): each library read is
// scoped to `serverInstance IN (<the viewer's visible slugs>)`, so a restricted
// server's rows never leave the database for an ungranted viewer. Masking the
// result afterwards would be the presentation-layer enforcement 35 forbids —
// and attachAllAvailability alone would NOT catch it, because it only decides
// the availability BADGE, not whether the title appears at all.
//
// Hidden titles ("not interested") are dropped by the caller's single
// attachAllAvailability pass, exactly like every other shelf, which is why this
// returns an over-fetched list rather than the final rail.
//
// Cost: two indexed reads (`@@index([addedAt])`, bounded by `take`), one
// TmdbMediaCore read for the titles/posters, and a TmdbCache `:details`
// fallback for posters core doesn't hold. Never a TMDB call (guardrail 31).
// The resolved list is cached for RECENTLY_ADDED_TTL_MS per visibility
// signature, so the home page pays it at most once a minute per distinct
// server set — not once per render.

export const RECENTLY_ADDED_SIZE = 20;
// Headroom for titles the viewer hid and for the per-title dedupe across
// servers; the caller trims to RECENTLY_ADDED_SIZE after enrichment.
export const RECENTLY_ADDED_OVERFETCH = 40;
// Per-source rows read. A title held by N servers is N rows, so read past the
// overfetch to still fill it after the dedupe.
const PER_SOURCE_TAKE = 60;
export const RECENTLY_ADDED_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 64;

export interface RecentLibraryRow {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  addedAt: Date | null;
  title: string | null;
  year: string | null;
}

export interface RecentlyAddedEntry {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  addedAt: Date;
  title: string | null;
  year: string | null;
}

/**
 * Union library rows from every source/server into one newest-first list, one
 * entry per (tmdbId, mediaType), keeping the NEWEST add. Movies and TV share a
 * TMDB number space only by coincidence, so they never collapse into each other.
 * Ties on addedAt break on mediaType then tmdbId so the order is total and the
 * rail never reshuffles between renders.
 */
export function mergeRecentlyAdded(
  lists: readonly (readonly RecentLibraryRow[])[],
  limit: number,
): RecentlyAddedEntry[] {
  const byKey = new Map<string, RecentlyAddedEntry>();
  for (const list of lists) {
    for (const row of list) {
      if (!row.addedAt || !(row.tmdbId > 0)) continue;
      const key = `${row.mediaType}:${row.tmdbId}`;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, { tmdbId: row.tmdbId, mediaType: row.mediaType, addedAt: row.addedAt, title: row.title, year: row.year });
        continue;
      }
      if (row.addedAt.getTime() > existing.addedAt.getTime()) {
        existing.addedAt = row.addedAt;
        existing.title = row.title ?? existing.title;
        existing.year = row.year ?? existing.year;
      } else {
        existing.title ??= row.title;
        existing.year ??= row.year;
      }
    }
  }
  return [...byKey.values()]
    .sort(
      (a, b) =>
        b.addedAt.getTime() - a.addedAt.getTime() ||
        a.mediaType.localeCompare(b.mediaType) ||
        a.tmdbId - b.tmdbId,
    )
    .slice(0, Math.max(0, limit));
}

/**
 * Which library SOURCES the shelf reads for a viewer.
 *
 * `pin` must be getBadgeVisibility(session) WITHOUT integration flags — i.e.
 * the user's own server pin (both true for ADMIN/MANAGE_ISSUES). A user pinned
 * to Plex is not shown Jellyfin-only arrivals they cannot play (their card would
 * carry no badge and read as "not available"). An account with no pin at all
 * (local credentials / OIDC with no assigned media server) sees the union.
 * A disabled integration contributes nothing either way — its sync arm is
 * skipped, so its rows are leftovers.
 */
export function recentlyAddedSources(
  pin: { showPlex: boolean; showJellyfin: boolean },
  integrations: { plex: boolean; jellyfin: boolean },
): { plex: boolean; jellyfin: boolean } {
  const pinned = pin.showPlex || pin.showJellyfin;
  return {
    plex: integrations.plex && (!pinned || pin.showPlex),
    jellyfin: integrations.jellyfin && (!pinned || pin.showJellyfin),
  };
}

// `generation` is bumped by every clear (a backup restore): a load that began
// before it neither stores its pre-restore list nor is joined by a caller
// after it.
const cacheState = processSingleton("recently-added:cache", () => ({
  entries: new Map<string, { items: TmdbMedia[]; expiresAt: number }>(),
  generation: 0,
}));

export function clearRecentlyAddedCache(): void {
  cacheState.entries.clear();
  cacheState.generation += 1;
}

// Room for one more entry: expired entries go first, then the oldest stored
// (Map order is insertion order). Never the whole cache at once — that sent
// every signature back to the database together.
function makeRoomInCache(now: number): void {
  const { entries } = cacheState;
  if (entries.size < MAX_CACHE_ENTRIES) return;
  for (const [sig, entry] of entries) {
    if (entry.expiresAt <= now) entries.delete(sig);
  }
  while (entries.size >= MAX_CACHE_ENTRIES) {
    const oldest = entries.keys().next();
    if (oldest.done) break;
    entries.delete(oldest.value);
  }
}

function signatureOf(plex: readonly string[], jellyfin: readonly string[]): string {
  // JSON keeps slugs unambiguous (no separator a slug could contain).
  return JSON.stringify([[...plex].sort(), [...jellyfin].sort()]);
}

const LIB_SELECT = { tmdbId: true, mediaType: true, addedAt: true, title: true, year: true } as const;

function libraryWhere(instances: readonly string[]) {
  return { addedAt: { not: null }, tmdbId: { gt: 0 }, serverInstance: { in: [...instances] } };
}

// One library row as the merge reads it. Explicit, so a schema change to a
// column the merge depends on fails to compile here instead of being cast past.
function toRecentRow(r: { tmdbId: number; mediaType: "MOVIE" | "TV"; addedAt: Date | null; title: string | null; year: string | null }): RecentLibraryRow {
  return { tmdbId: r.tmdbId, mediaType: r.mediaType, addedAt: r.addedAt, title: r.title, year: r.year };
}

async function readRecentRows(source: "plex" | "jellyfin", instances: readonly string[]): Promise<RecentLibraryRow[]> {
  if (instances.length === 0) return [];
  const args = { where: libraryWhere(instances), orderBy: { addedAt: "desc" as const }, take: PER_SOURCE_TAKE, select: LIB_SELECT };
  const rows = source === "plex" ? await prisma.plexLibraryItem.findMany(args) : await prisma.jellyfinLibraryItem.findMany(args);
  return rows.map(toRecentRow);
}

// A shelf entry as a TmdbMedia card: TmdbMediaCore's title/poster/year when it
// holds the title, else the library row's own title and year.
function toShelfItem(
  e: RecentlyAddedEntry,
  c: { title: string; posterPath: string | null; releaseYear: string | null; voteAverage: number | null; certification: string | null } | undefined,
  fallbackPoster: string | undefined,
): TmdbMedia {
  return {
    id: e.tmdbId,
    mediaType: e.mediaType === "TV" ? "tv" : "movie",
    title: c?.title || e.title || "Unknown",
    overview: "",
    posterPath: c?.posterPath ?? fallbackPoster ?? null,
    backdropPath: null,
    releaseDate: null,
    releaseYear: c?.releaseYear ?? e.year ?? null,
    voteAverage: c?.voteAverage ?? 0,
    ...(c?.certification ? { certification: c.certification } : {}),
  };
}

async function loadRecentlyAdded(plex: readonly string[], jellyfin: readonly string[]): Promise<TmdbMedia[]> {
  const [plexRows, jellyfinRows] = await Promise.all([readRecentRows("plex", plex), readRecentRows("jellyfin", jellyfin)]);
  const entries = mergeRecentlyAdded([plexRows, jellyfinRows], RECENTLY_ADDED_OVERFETCH);
  if (entries.length === 0) return [];

  const coreRows = await prisma.tmdbMediaCore.findMany({
    where: {
      tmdbId: { in: [...new Set(entries.map((e) => e.tmdbId))] },
      mediaType: { in: [...new Set(entries.map((e) => e.mediaType))] },
    },
    select: { tmdbId: true, mediaType: true, title: true, posterPath: true, releaseYear: true, voteAverage: true, certification: true },
  });
  const core = new Map(coreRows.map((r) => [`${r.mediaType}:${r.tmdbId}`, r]));

  // Core rows expire and are purged; fall back to the `:details` cache for any
  // poster core can't supply (the same two-tier read the admin views use).
  const needPoster = entries.filter((e) => !core.get(`${e.mediaType}:${e.tmdbId}`)?.posterPath);
  const fallbackPosters = needPoster.length > 0
    ? await resolvePosterPathMap(needPoster.map((e) => ({ tmdbId: e.tmdbId, mediaType: e.mediaType })))
    : {};

  return entries.map((e) =>
    toShelfItem(e, core.get(`${e.mediaType}:${e.tmdbId}`), fallbackPosters[posterPathKey(e.tmdbId, e.mediaType)]),
  );
}

/**
 * The newest arrivals on the given server instances, newest first, one entry
 * per title, NOT yet enriched (the caller runs attachAllAvailability, which
 * also drops the viewer's hidden titles). Up to RECENTLY_ADDED_OVERFETCH items.
 *
 * `instances` must already be the VIEWER's visible set — use
 * getRecentlyAddedForViewer unless you hold that set from somewhere else.
 */
export async function getRecentlyAdded(instances: VisibleServerInstances): Promise<TmdbMedia[]> {
  if (instances.plex.length === 0 && instances.jellyfin.length === 0) return [];
  const sig = signatureOf(instances.plex, instances.jellyfin);
  const hit = cacheState.entries.get(sig);
  if (hit && Date.now() < hit.expiresAt) return hit.items;
  const generation = cacheState.generation;
  return coalesce(`recently-added:${generation}:${sig}`, async () => {
    const items = await loadRecentlyAdded(instances.plex, instances.jellyfin);
    // A clear landed while this loaded: hand the list to this caller, store nothing.
    if (cacheState.generation !== generation) return items;
    const now = Date.now();
    makeRoomInCache(now);
    cacheState.entries.set(sig, { items, expiresAt: now + RECENTLY_ADDED_TTL_MS });
    return items;
  });
}

/**
 * The shelf for one signed-in viewer: their grant-scoped server instances
 * (guardrail 35), narrowed to the sources they're pinned to and the enabled
 * integrations.
 */
export async function getRecentlyAddedForViewer(
  session: SummonarrSession,
  integrations: { plex: boolean; jellyfin: boolean },
): Promise<TmdbMedia[]> {
  const sources = recentlyAddedSources(getBadgeVisibility(session), integrations);
  if (!sources.plex && !sources.jellyfin) return [];
  const visible = await getVisibleServerInstances(session);
  return getRecentlyAdded({
    plex: sources.plex ? visible.plex : [],
    jellyfin: sources.jellyfin ? visible.jellyfin : [],
  });
}
