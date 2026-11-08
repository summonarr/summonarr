import "server-only";
import { prisma } from "@/lib/prisma";
import type { SummonarrSession } from "@/lib/api-auth";
import { getVisibleServerInstances } from "@/lib/media-visibility";
import { getShow4kVisibility } from "@/lib/four-k-visibility";
import { getFeatureFlags, type FeatureFlags, type FeatureKey } from "@/lib/features";
import { getBadgeVisibility } from "@/lib/badge-visibility";
import { isBlacklisted } from "@/lib/blacklist";
import { hasPermission, Permission } from "@/lib/permissions";
import { resolveNamedInstanceTargets, type NamedInstanceTarget } from "@/lib/named-instance-targets";
import { resolveMainButtonRequested, routableMedia } from "@/lib/main-request-button";
import { arrInstancesForTitle } from "@/lib/arr-links-data";
import { getAdminTitleNeverWatched, type TitleNeverWatched } from "@/lib/never-watched-report";
import { generateRequestToken } from "@/lib/request-token";
import { DEFAULT_ARR_INSTANCE, FOURK_ARR_INSTANCE } from "@/lib/arr-instances";

// The viewer-scoped state behind a movie or TV detail page: library
// availability, the viewer's own requests and 4K / named-instance state, the
// flags that gate the action row, and the admin extras. ONE loader for both
// pages, so a change to request semantics lands on both (the per-type reads —
// TMDB rows, TV episodes — stay in each page).
//
// Runs AFTER the page's gate-first details read (requireAppSession, then TMDB,
// then its 404 check), keyed on the TMDB id the details came back with.

export type DetailMediaType = "MOVIE" | "TV";

export interface DetailPageState {
  // In a library on a server this viewer may see.
  plexAvailable: boolean;
  jellyfinAvailable: boolean;
  // The visible Jellyfin row's community rating (the ratings bar's Jellyfin score).
  jellyfinCommunityRating: number | null;
  showPlex: boolean;
  showJellyfin: boolean;
  // Queued on the default instance.
  arrPending: boolean;
  // Any of the viewer's live non-4K requests — the hero's Requested badge.
  requestedAny: boolean;
  // The main Request button's own request (resolveMainButtonRequested).
  requested: boolean;
  requested4k: boolean;
  // 4K state is shown only to a viewer who can request 4K (getShow4kVisibility).
  show4k: boolean;
  arr4kAvailable: boolean;
  arr4kPending: boolean;
  blacklisted: boolean;
  namedTargets: NamedInstanceTarget[];
  alreadyVoted: boolean;
  onWatchlist: boolean;
  onHidden: boolean;
  votesEnabled: boolean;
  issuesEnabled: boolean;
  canOnBehalf: boolean;
  canChooseProfile: boolean;
  // Every request action on the page posts the SAME token: it is scoped to
  // (tmdbId, mediaType, userId) under the request-token purpose (guardrail 6h).
  requestToken: string;
  arrLinks: Array<{ slug: string; name: string; holds: boolean }>;
  neverWatched: TitleNeverWatched | null;
}

// Promise.all over a NAMED set: each result is read by its name, so adding or
// reordering a read can't hand one flag another's value the way a positional
// tuple of booleans can. (`object`, not a Record of promises: a Record
// constraint contextually types every `.then` callback in the literal to
// return `unknown`.)
export async function allNamed<P extends object>(
  promises: P,
): Promise<{ [K in keyof P]: Awaited<P[K]> }> {
  const keys = Object.keys(promises) as Array<keyof P>;
  const values = await Promise.all(keys.map((key) => promises[key]));
  const out = {} as { [K in keyof P]: Awaited<P[K]> };
  keys.forEach((key, i) => {
    out[key] = values[i] as Awaited<P[typeof key]>;
  });
  return out;
}

// A side read that degrades to an empty list logs why, under the page's scope
// and the source's name, instead of silently rendering without it.
export function emptyOnFailure(scope: string, source: string, tmdbId: number) {
  return (err: unknown): never[] => {
    console.warn(`[${scope}] ${source} read failed for ${tmdbId}:`, err instanceof Error ? err.message : err);
    return [];
  };
}

const flagOn = (flags: FeatureFlags, key: FeatureKey): boolean => flags[key] ?? false;

type DetailMedia = { id: number } & Parameters<typeof routableMedia>[0];
type VisibleInstances = ReturnType<typeof getVisibleServerInstances>;

// Which Plex/Jellyfin servers this viewer may see. Everything downstream keys off the two
// library rows below — the availability badges, the ratings bar's Jellyfin score, and the
// in-library gates on the "report issue" / "vote to delete" actions — so scoping the
// QUERIES (not their results) is what keeps a restricted server invisible end to end.
function libraryReads(visible: VisibleInstances, tmdbId: number, mediaType: DetailMediaType) {
  return {
    plexItem: visible.then((v) =>
      prisma.plexLibraryItem.findFirst({
        where: { tmdbId, mediaType, serverInstance: { in: v.plex } },
        select: { tmdbId: true },
      }),
    ),
    // Only the rating: a library row also carries the on-disk path, which is
    // admin data (guardrail 37f) and nothing on this page shows.
    jellyfinItem: visible.then((v) =>
      prisma.jellyfinLibraryItem.findFirst({
        where: { tmdbId, mediaType, serverInstance: { in: v.jellyfin } },
        select: { communityRating: true },
      }),
    ),
  };
}

// The default and 4K queue rows in one read, and the 4K copy on disk.
function arrQueueReads(isMovie: boolean, tmdbId: number) {
  const queueSlugs = { in: [DEFAULT_ARR_INSTANCE, FOURK_ARR_INSTANCE] };
  const available4kKey = { tmdbId_arrInstance: { tmdbId, arrInstance: FOURK_ARR_INSTANCE } };
  return {
    wanted: isMovie
      ? prisma.radarrWantedItem.findMany({ where: { tmdbId, arrInstance: queueSlugs }, select: { arrInstance: true } })
      : prisma.sonarrWantedItem.findMany({ where: { tmdbId, arrInstance: queueSlugs }, select: { arrInstance: true } }),
    available4k: isMovie
      ? prisma.radarrAvailableItem.findUnique({ where: available4kKey, select: { tmdbId: true } })
      : prisma.sonarrAvailableItem.findUnique({ where: available4kKey, select: { tmdbId: true } }),
  };
}

// Every live request of the viewer's on this title, 4K included; the non-4K
// ones; and whether the main button owns one. The hero's Requested badge counts
// every non-4K one; the main button owns only the default one or the one on the
// slug this title auto-routes to (resolveMainButtonRequested) — the rest belong
// to their "Request on X" button.
function viewerRequestReads(media: DetailMedia, mediaType: DetailMediaType, userId: string) {
  const requests = prisma.mediaRequest.findMany({
    where: { tmdbId: media.id, mediaType, requestedBy: userId, status: { not: "DECLINED" } },
    select: { arrInstance: true },
  });
  const userRequestsP = requests.then((rows) => rows.filter((r) => r.arrInstance !== FOURK_ARR_INSTANCE));
  return {
    requests,
    userRequests: userRequestsP,
    requested: userRequestsP.then((userRequests) =>
      resolveMainButtonRequested(mediaType, userRequests.map((r) => r.arrInstance), routableMedia(media)),
    ),
  };
}

// The viewer's own marks on the title: a deletion vote, the watchlist, hidden.
function viewerMarkReads(tmdbId: number, mediaType: DetailMediaType, userId: string) {
  const viewerKey = { userId_tmdbId_mediaType: { userId, tmdbId, mediaType } };
  return {
    deletionVote: prisma.deletionVote.findFirst({
      where: { tmdbId, mediaType, userId },
      select: { id: true },
    }),
    onWatchlist: prisma.watchlistItem.findUnique({ where: viewerKey, select: { id: true } }).then((row) => !!row),
    onHidden: prisma.hiddenItem.findUnique({ where: viewerKey, select: { id: true } }).then((row) => !!row),
  };
}

// The ADMIN extras. "Open in Radarr/Sonarr": one link per configured instance
// whose synced cache holds the title. A cosmetic shortcut (JWT-level session is
// fine — guardrail 29); the route behind it is ADMIN-gated itself. Nothing while
// the integration is switched off — every route behind the links would answer
// "integration disabled". The "never watched" chip (guardrail 14d) is null for
// anyone else.
function adminExtraReads(permissions: bigint, flags: Promise<FeatureFlags>, mediaType: DetailMediaType, tmdbId: number) {
  const isMovie = mediaType === "MOVIE";
  const service = isMovie ? "radarr" : "sonarr";
  return {
    arrLinks: hasPermission(permissions, Permission.ADMIN)
      ? flags.then((f) =>
          flagOn(f, isMovie ? "feature.integration.radarr" : "feature.integration.sonarr")
            ? arrInstancesForTitle(service, tmdbId).catch(emptyOnFailure(isMovie ? "movie-page" : "tv-page", "arr-links", tmdbId))
            : [],
        )
      : Promise.resolve([]),
    neverWatched: getAdminTitleNeverWatched(permissions, tmdbId, mediaType),
  };
}

export async function loadDetailPageState(
  session: SummonarrSession,
  media: DetailMedia,
  mediaType: DetailMediaType,
): Promise<DetailPageState> {
  const tmdbId = media.id;
  const userId = session.user.id;
  const permissions = session.user.permissions;
  const isMovie = mediaType === "MOVIE";

  const visible = getVisibleServerInstances(session);
  // Feature flags: the page flags hide the Report-issue and Vote-to-delete
  // buttons when those features are off (otherwise they would only fail with a
  // 403 on submit). The integration flags go to getBadgeVisibility, which would
  // otherwise assume both servers are on and show badges (and those buttons) for
  // a disabled Plex or Jellyfin.
  const flags = getFeatureFlags();
  const blacklisted = isBlacklisted(tmdbId, mediaType);

  const reads = await allNamed({
    ...libraryReads(visible, tmdbId, mediaType),
    ...arrQueueReads(isMovie, tmdbId),
    ...viewerRequestReads(media, mediaType, userId),
    ...viewerMarkReads(tmdbId, mediaType, userId),
    blacklisted,
    // Named instances (non-default, non-4K): an explicit "Request on X" button
    // for each configured one the viewer may target. Shared with GET
    // /api/requests/instances so the two can't drift — see
    // resolveNamedInstanceTargets.
    namedTargets: blacklisted.then((isBlocked) =>
      resolveNamedInstanceTargets({ tmdbId, mediaType, userId, permissions, blacklisted: isBlocked }),
    ),
    // A 4K instance configured AND the viewer can request 4K.
    show4k: getShow4kVisibility(session, isMovie ? "movie" : "tv"),
    flags,
    ...adminExtraReads(permissions, flags, mediaType, tmdbId),
  });

  const wantedSlugs = new Set(reads.wanted.map((w) => w.arrInstance));
  const { showPlex, showJellyfin } = getBadgeVisibility(session, {
    plex: flagOn(reads.flags, "feature.integration.plex"),
    jellyfin: flagOn(reads.flags, "feature.integration.jellyfin"),
  });
  return {
    plexAvailable: !!reads.plexItem,
    jellyfinAvailable: !!reads.jellyfinItem,
    jellyfinCommunityRating: reads.jellyfinItem?.communityRating ?? null,
    showPlex,
    showJellyfin,
    arrPending: wantedSlugs.has(DEFAULT_ARR_INSTANCE),
    requestedAny: reads.userRequests.length > 0,
    requested: reads.requested,
    requested4k: reads.requests.some((row) => row.arrInstance === FOURK_ARR_INSTANCE),
    show4k: reads.show4k,
    arr4kAvailable: reads.show4k && !!reads.available4k,
    arr4kPending: reads.show4k && wantedSlugs.has(FOURK_ARR_INSTANCE),
    blacklisted: reads.blacklisted,
    namedTargets: reads.namedTargets,
    alreadyVoted: !!reads.deletionVote,
    onWatchlist: reads.onWatchlist,
    onHidden: reads.onHidden,
    votesEnabled: flagOn(reads.flags, "feature.page.votes"),
    issuesEnabled: flagOn(reads.flags, "feature.page.issues"),
    canOnBehalf: hasPermission(permissions, Permission.REQUEST_ON_BEHALF),
    canChooseProfile: hasPermission(permissions, Permission.REQUEST_ADVANCED),
    requestToken: generateRequestToken(tmdbId, mediaType, userId),
    arrLinks: reads.arrLinks,
    neverWatched: reads.neverWatched,
  };
}
