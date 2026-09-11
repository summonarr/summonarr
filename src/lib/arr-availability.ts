import { prisma } from "@/lib/prisma";
import { getSyncableArrInstances } from "@/lib/arr-instance-registry";
import type { TmdbMedia } from "@/lib/tmdb-types";

/**
 * Guardrail 14a — the Sonarr completeness gate shared by every library-marking
 * pass (the orchestrator's markLibraryRequests and the per-source
 * /api/sync/plex + /api/sync/jellyfin routes).
 *
 * Returns the `${tmdbId}:${arrInstance}` keys of the given requests whose series
 * Sonarr still lists as WANTED on that instance — i.e. incomplete: not every
 * aired, monitored, regular-season episode is on disk (the writer is
 * getSonarrWantedTmdbIds via sonarrSeriesCompletion). A TV request with such a
 * key must NOT flip AVAILABLE off Plex/Jellyfin presence: the library holds the
 * show from its first imported episode, but "ready to watch" means the whole
 * aired run. The gated row stays PENDING/APPROVED with notifiedAvailable=false
 * and is re-evaluated next run; the ARR passes (or the Sonarr webhook) flip it
 * once the row moves to SonarrAvailableItem.
 *
 * A title with no wanted row on the request's instance is NOT gated — Sonarr
 * either reports it complete or does not track it at all (no Sonarr configured,
 * a show that arrived by another route, or an add that never landed), and in all
 * of those library presence is the only signal there is. Issues no query when
 * the input holds no TV rows, so movie-only runs pay nothing.
 *
 * Only a CONFIGURED instance's wanted row holds. The default instance can never
 * be de-registered, so its rows survive an operator blanking the Sonarr
 * connection for good — nothing rewrites or sweeps them — and Sonarr is no
 * longer the oracle for that instance's requests. Reading those stale rows
 * would strand every such request in APPROVED forever. The orchestrator passes
 * the syncable set it already read; the per-source routes let this helper
 * read it (two Setting queries).
 */
export async function sonarrIncompleteKeys(
  requests: readonly { tmdbId: number; mediaType: string; arrInstance: string }[],
  opts: { configuredSlugs?: ReadonlySet<string> } = {},
): Promise<Set<string>> {
  const tvIds = [...new Set(requests.filter((r) => r.mediaType === "TV").map((r) => r.tmdbId))];
  if (tvIds.length === 0) return new Set();
  const configured = opts.configuredSlugs
    ?? new Set((await getSyncableArrInstances("sonarr")).map((i) => i.slug));
  if (configured.size === 0) return new Set();
  const rows = await prisma.sonarrWantedItem.findMany({
    where: { tmdbId: { in: tvIds }, arrInstance: { in: [...configured] } },
    select: { tmdbId: true, arrInstance: true },
  });
  return new Set(rows.map((r) => `${r.tmdbId}:${r.arrInstance}`));
}

// "Pending" means the item exists in the Radarr/Sonarr wanted table — it does NOT confirm the item
// is actively downloading.  A negative result here only means it isn't tracked, not that it's absent.
//
// Multi-instance: one unfiltered query per table returns the (tmdbId, arrInstance) rows for every
// configured instance. From those we derive:
//   arrPending                    — wanted at the DEFAULT instance ("")            [back-compat]
//   arr4kPending / arr4kAvailable — wanted/available at the "4k" instance          [back-compat, gated by include4k]
//   arrInstances                  — the full per-slug { pending, available } map
//
// NOTE on arrInstances: it survives only when you call attachArrPending DIRECTLY.
// attachAllAvailability — the chokepoint every discovery/list route funnels through
// — re-projects this pass into {arrPending, arr4kPending, arr4kAvailable} and drops
// the map (pinned by tests/attach-all.test.mts). Since the field is optional on
// TmdbMedia, a list surface that read `media.arrInstances` would silently get
// undefined forever rather than a type error. The detail pages that need per-instance
// state query it directly for that reason. Propagating it through attach-all means
// every list response starts emitting it — flip that pin deliberately, not by accident.
export async function attachArrPending(
  items: TmdbMedia[],
  opts?: { include4k?: boolean },
): Promise<TmdbMedia[]> {
  if (items.length === 0) return items;
  const include4k = opts?.include4k ?? false;

  const movieIds = items.filter((i) => i.mediaType === "movie").map((i) => i.id);
  const tvIds    = items.filter((i) => i.mediaType === "tv").map((i) => i.id);

  const [radarrWanted, sonarrWanted, radarrAvail, sonarrAvail] = await Promise.all([
    movieIds.length > 0
      ? prisma.radarrWantedItem.findMany({ where: { tmdbId: { in: movieIds } }, select: { tmdbId: true, arrInstance: true } })
      : Promise.resolve([]),
    tvIds.length > 0
      ? prisma.sonarrWantedItem.findMany({ where: { tmdbId: { in: tvIds } }, select: { tmdbId: true, arrInstance: true } })
      : Promise.resolve([]),
    movieIds.length > 0
      ? prisma.radarrAvailableItem.findMany({ where: { tmdbId: { in: movieIds } }, select: { tmdbId: true, arrInstance: true } })
      : Promise.resolve([]),
    tvIds.length > 0
      ? prisma.sonarrAvailableItem.findMany({ where: { tmdbId: { in: tvIds } }, select: { tmdbId: true, arrInstance: true } })
      : Promise.resolve([]),
  ]);

  // tmdbId → (slug → { pending, available }) for movies and TV separately.
  const movieMap = new Map<number, Map<string, { pending: boolean; available: boolean }>>();
  const tvMap    = new Map<number, Map<string, { pending: boolean; available: boolean }>>();
  const bump = (
    m: Map<number, Map<string, { pending: boolean; available: boolean }>>,
    tmdbId: number,
    slug: string,
    field: "pending" | "available",
  ) => {
    let bySlug = m.get(tmdbId);
    if (!bySlug) { bySlug = new Map(); m.set(tmdbId, bySlug); }
    const cur = bySlug.get(slug) ?? { pending: false, available: false };
    cur[field] = true;
    bySlug.set(slug, cur);
  };
  for (const r of radarrWanted) bump(movieMap, r.tmdbId, r.arrInstance, "pending");
  for (const r of radarrAvail)  bump(movieMap, r.tmdbId, r.arrInstance, "available");
  for (const r of sonarrWanted) bump(tvMap, r.tmdbId, r.arrInstance, "pending");
  for (const r of sonarrAvail)  bump(tvMap, r.tmdbId, r.arrInstance, "available");

  return items.map((item) => {
    const isMovie = item.mediaType === "movie";
    const bySlug = (isMovie ? movieMap : tvMap).get(item.id);
    const arrInstances = bySlug ? Object.fromEntries(bySlug) : undefined;
    const def = bySlug?.get("");
    const fourK = bySlug?.get("4k");
    return {
      ...item,
      arrPending: def?.pending ?? false,
      ...(arrInstances ? { arrInstances } : {}),
      ...(include4k
        ? {
            arr4kAvailable: fourK?.available ?? false,
            arr4kPending: fourK?.pending ?? false,
          }
        : {}),
    };
  });
}
