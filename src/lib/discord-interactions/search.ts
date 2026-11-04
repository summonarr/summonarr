import { prisma } from "@/lib/prisma";
import { safeFetchTrusted } from "@/lib/safe-fetch";
import { tmdbAuth } from "@/lib/tmdb-auth";
import { effectivePermissions, parseMediaServerGrants } from "@/lib/permissions";
import { getMediaInstanceAccessLists, visibleInstancesFor, type VisibleServerInstances } from "@/lib/media-visibility";
import type { TmdbResult } from "./types";

const TMDB_HOSTS = ["api.themoviedb.org"];

// Which Plex/Jellyfin servers a Discord caller may see. The acting identity here is a
// discordId, not a session or a primary key, so this resolves it itself — and only when a
// restricted server actually exists, so a deployment that hasn't opted in issues no extra
// user read at all.
export async function discordVisibleInstances(discordUserId: string): Promise<VisibleServerInstances> {
  const { plex, jellyfin, anyRestricted } = await getMediaInstanceAccessLists();
  if (!anyRestricted) return visibleInstancesFor(0n, {}, plex, jellyfin);
  const user = await prisma.user.findUnique({
    where: { discordId: discordUserId },
    select: { role: true, permissions: true, mediaServerGrants: true, deactivatedAt: true },
  });
  // No linked/shadow account yet ⇒ least privilege, same as an anonymous web reader.
  // So is a deactivated one: deactivation leaves role, permissions and grants on
  // the row (guardrail 33), and none of them may still open a restricted server.
  if (!user || user.deactivatedAt) return visibleInstancesFor(0n, {}, plex, jellyfin);
  return visibleInstancesFor(
    effectivePermissions(user.role, user.permissions),
    parseMediaServerGrants(user.mediaServerGrants),
    plex,
    jellyfin,
  );
}

export async function attachAvailability(
  results: TmdbResult[],
  visible: VisibleServerInstances,
): Promise<TmdbResult[]> {
  if (results.length === 0) return results;
  const orClause = results.map((r) => ({
    tmdbId: r.id,
    mediaType: r.mediaType === "movie" ? ("MOVIE" as const) : ("TV" as const),
  }));
  const movieIds = results.filter((r) => r.mediaType === "movie").map((r) => r.id);
  const tvIds    = results.filter((r) => r.mediaType === "tv").map((r) => r.id);

  const [plexRows, jfRows, requestRows, radarrRows, sonarrRows] = await Promise.all([
    // Library rows are scoped to the servers the searching user may see — a restricted
    // server they hold no grant for must not badge a result "available" in the embed.
    prisma.plexLibraryItem.findMany({ where: { OR: orClause, serverInstance: { in: visible.plex } }, select: { tmdbId: true, mediaType: true } }),
    prisma.jellyfinLibraryItem.findMany({ where: { OR: orClause, serverInstance: { in: visible.jellyfin } }, select: { tmdbId: true, mediaType: true } }),
    prisma.mediaRequest.findMany({
      where: { status: { not: "DECLINED" }, OR: orClause },
      select: { tmdbId: true, mediaType: true },
      distinct: ["tmdbId", "mediaType"],
    }),
    // Any instance counts as "in queue" for the search-embed badge (requests may
    // auto-route to a named instance now, not only the default).
    movieIds.length > 0
      ? prisma.radarrWantedItem.findMany({ where: { tmdbId: { in: movieIds } }, select: { tmdbId: true } })
      : Promise.resolve([]),
    tvIds.length > 0
      ? prisma.sonarrWantedItem.findMany({ where: { tmdbId: { in: tvIds } }, select: { tmdbId: true } })
      : Promise.resolve([]),
  ]);

  const plexSet      = new Set(plexRows.map((r) => `${r.tmdbId}:${r.mediaType}`));
  const jfSet        = new Set(jfRows.map((r) => `${r.tmdbId}:${r.mediaType}`));
  const requestedSet = new Set(requestRows.map((r) => `${r.tmdbId}:${r.mediaType}`));
  const radarrSet    = new Set(radarrRows.map((r) => r.tmdbId));
  const sonarrSet    = new Set(sonarrRows.map((r) => r.tmdbId));

  return results.map((r) => {
    const dbType = r.mediaType === "movie" ? "MOVIE" : "TV";
    const key = `${r.id}:${dbType}`;
    return {
      ...r,
      plexAvailable:     plexSet.has(key),
      jellyfinAvailable: jfSet.has(key),
      requested:         requestedSet.has(key),
      arrPending:        r.mediaType === "movie" ? radarrSet.has(r.id) : sonarrSet.has(r.id),
    };
  });
}

async function searchTmdb(query: string, type: "movie" | "tv"): Promise<TmdbResult[]> {
  const auth = tmdbAuth();
  if (!auth) throw new Error("No TMDB credentials configured (set TMDB_READ_TOKEN)");

  const url = new URL(`https://api.themoviedb.org/3/search/${type}`);
  for (const [k, v] of Object.entries(auth.query)) url.searchParams.set(k, v);
  url.searchParams.set("query", query);
  url.searchParams.set("page", "1");
  url.searchParams.set("include_adult", "false");

  const res = await safeFetchTrusted(url.toString(), {
    allowedHosts: TMDB_HOSTS,
    headers: auth.headers,
    timeoutMs: 15_000,
  });
  if (!res.ok) throw new Error(`TMDB search failed: ${res.status}`);
  const data = (await res.json()) as { results: Record<string, unknown>[] };

  return data.results
    .slice(0, 5)
    .map((item) => {
      const rawDate = (type === "movie" ? item.release_date : item.first_air_date) as string | undefined;
      const title = (type === "movie" ? item.title : item.name) as string | undefined;
      return {
        id: item.id as number,
        title: title ?? "",
        mediaType: type,
        releaseYear: rawDate ? rawDate.substring(0, 4) : "Unknown",
        posterPath: (item.poster_path as string | null) ?? null,
        overview: (item.overview as string) ?? "",
        voteAverage: (item.vote_average as number) ?? 0,
      };
    })
    .filter((r) => r.title.length > 0);
}

export async function cachedSearchTmdb(query: string, type: "movie" | "tv", discordUserId: string): Promise<TmdbResult[]> {
  // Per-user cache scope prevents one Discord user's stale/poisoned results from leaking to others
  const key = `q:${discordUserId}:${type}:${query.toLowerCase().trim()}`;
  const cached = await prisma.discordSearchCache.findUnique({ where: { queryKey: key } }).catch(() => null);
  if (cached && new Date() < cached.expiresAt) {
    try { return JSON.parse(cached.data) as TmdbResult[]; } catch { }
  }
  const results = await searchTmdb(query, type);
  prisma.discordSearchCache.upsert({
    where:  { queryKey: key },
    create: { queryKey: key, data: JSON.stringify(results), expiresAt: new Date(Date.now() + 3_600_000) },
    update: { data: JSON.stringify(results), expiresAt: new Date(Date.now() + 3_600_000) },
  }).catch(() => {});
  return results;
}

// Searches back the same five results /request shows.
export async function searchForDiscord(query: string, type: "movie" | "tv", discordUserId: string): Promise<TmdbResult[]> {
  const raw = await cachedSearchTmdb(query, type, discordUserId);
  return attachAvailability(raw, await discordVisibleInstances(discordUserId));
}
