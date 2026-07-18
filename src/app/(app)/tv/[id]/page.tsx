import { getTVDetails, getTVCredits, getTVSuggestions, getTVGenres, backdropUrl, posterUrl } from "@/lib/tmdb";
import Link from "next/link";
import { RequestButton } from "@/components/media/request-button";
import { Request4kButton } from "@/components/media/request-4k-button";
import { RequestInstanceButton } from "@/components/media/request-instance-button";
import { WatchlistButton } from "@/components/media/watchlist-button";
import { HideButton } from "@/components/media/hide-button";
import { isArrConfigured } from "@/lib/arr";
import { ReportIssueButton } from "@/components/media/report-issue-button";
import { RatingsBar } from "@/components/media/ratings-bar";
import { CastSection } from "@/components/media/cast-section";
import { SimilarRow } from "@/components/media/similar-row";
import { TVSeasons } from "@/components/media/tv-seasons";
import Image from "next/image";
import { notFound } from "next/navigation";
import { TrailerButton } from "@/components/media/trailer-button";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { attachAllAvailability } from "@/lib/attach-all";
import { getBadgeVisibility } from "@/lib/badge-visibility";
import { generateRequestToken } from "@/lib/request-token";
import { VoteDeleteButton } from "@/components/votes/vote-delete-button";
import { AvailabilityBadges } from "@/components/media/availability-badges";
import { DetailExtras } from "@/components/media/detail-extras";
import { languageName } from "@/lib/tmdb-types";
import { Chip } from "@/components/ui/design";
import { canRequest, canRequestInstance, hasPermission, parseInstanceGrants, Permission } from "@/lib/permissions";
import { getSyncableArrInstances } from "@/lib/arr-instance-registry";
import { FOURK_ARR_INSTANCE } from "@/lib/arr-instances";
import { isBlacklisted } from "@/lib/blacklist";
import { isFeatureEnabled } from "@/lib/features";

export default async function TVDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Start the session read concurrently with the TMDB details fetch. The no-op
  // catch only marks the promise handled if notFound() fires first — the await
  // below still rethrows an auth() failure exactly as before.
  const sessionPromise = auth();
  sessionPromise.catch(() => {});
  let media;
  try {
    media = await getTVDetails(Number(id));
  } catch {
    notFound();
  }

  const session = await sessionPromise;

  const provider = session?.user.provider;
  const episodeSources =
    provider === "plex"
      ? ["plex"]
      : provider === "jellyfin" || provider === "jellyfin-quickconnect"
      ? ["jellyfin"]
      : ["plex", "jellyfin"];

  const [
    plexItem,
    jellyfinItem,
    tvdbRequest,
    userRequest,
    userDeletionVote,
    sonarrWanted,
    cast,
    rawSuggestions,
    ownedEpisodes,
    genreList,
    blacklisted,
    has4k,
    userRequest4k,
    request4kAllRow,
    sonarr4kAvailable,
    sonarr4kWanted,
    sonarrInstances,
    votesEnabled,
    issuesEnabled,
    plexEnabled,
    jellyfinEnabled,
    onWatchlist,
    onHidden,
  ] = await Promise.all([
    prisma.plexLibraryItem.findUnique({
      where: { tmdbId_mediaType: { tmdbId: media.id, mediaType: "TV" } },
    }),
    prisma.jellyfinLibraryItem.findUnique({
      where: { tmdbId_mediaType: { tmdbId: media.id, mediaType: "TV" } },
    }),
    prisma.mediaRequest.findFirst({
      where: { tmdbId: media.id, mediaType: "TV", tvdbId: { not: null } },
      select: { tvdbId: true },
    }),
    session ? prisma.mediaRequest.findFirst({
      // Any non-4K instance: the main request button owns the default AND named
      // (auto-routed, e.g. anime) requests; only 4K has its own separate button.
      where: { tmdbId: media.id, mediaType: "TV", requestedBy: session.user.id, arrInstance: { not: "4k" }, status: { not: "DECLINED" } },
      select: { id: true },
    }) : Promise.resolve(null),
    session ? prisma.deletionVote.findFirst({
      where: { tmdbId: media.id, mediaType: "TV", userId: session.user.id },
      select: { id: true },
    }) : Promise.resolve(null),
    prisma.sonarrWantedItem.findUnique({ where: { tmdbId_arrInstance: { tmdbId: media.id, arrInstance: "" } } }),
    getTVCredits(media.id).catch(() => []),
    getTVSuggestions(media.id).catch(() => []),
    prisma.tVEpisodeCache.findMany({
      where: { tmdbId: media.id, source: { in: episodeSources } },
      select: { seasonNumber: true, episodeNumber: true },
    }),
    getTVGenres().catch(() => []),
    isBlacklisted(media.id, "TV"),
    isArrConfigured("sonarr", "4k"),
    session
      ? prisma.mediaRequest.findFirst({
          where: { tmdbId: media.id, mediaType: "TV", requestedBy: session.user.id, arrInstance: "4k", status: { not: "DECLINED" } },
          select: { id: true },
        })
      : Promise.resolve(null),
    prisma.setting.findUnique({ where: { key: "request4kAll" } }),
    prisma.sonarrAvailableItem.findUnique({ where: { tmdbId_arrInstance: { tmdbId: media.id, arrInstance: "4k" } } }),
    prisma.sonarrWantedItem.findUnique({ where: { tmdbId_arrInstance: { tmdbId: media.id, arrInstance: "4k" } } }),
    getSyncableArrInstances("sonarr"),
    isFeatureEnabled("feature.page.votes"),
    isFeatureEnabled("feature.page.issues"),
    isFeatureEnabled("feature.integration.plex"),
    isFeatureEnabled("feature.integration.jellyfin"),
    session
      ? prisma.watchlistItem
          .findUnique({ where: { userId_tmdbId_mediaType: { userId: session.user.id, tmdbId: media.id, mediaType: "TV" } }, select: { id: true } })
          .then((r) => !!r)
      : Promise.resolve(false),
    session
      ? prisma.hiddenItem
          .findUnique({ where: { userId_tmdbId_mediaType: { userId: session.user.id, tmdbId: media.id, mediaType: "TV" } }, select: { id: true } })
          .then((r) => !!r)
      : Promise.resolve(false),
  ]);
  const genreNameToId = new Map(genreList.map((g) => [g.name, g.id]));

  const ownedBySeason: Record<number, number[]> = {};
  const seen = new Set<string>();
  for (const row of ownedEpisodes) {
    const key = `${row.seasonNumber}:${row.episodeNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);
    (ownedBySeason[row.seasonNumber] ??= []).push(row.episodeNumber);
  }
  const plexAvailable     = !!plexItem;
  const jellyfinAvailable = !!jellyfinItem;
  const arrPending        = !!sonarrWanted;
  const requested         = !!userRequest;
  const tvdbId = tvdbRequest?.tvdbId ?? null;
  const canOnBehalf = session ? hasPermission(session.user.permissions, Permission.REQUEST_ON_BEHALF) : false;
  const canChooseProfile = session ? hasPermission(session.user.permissions, Permission.REQUEST_ADVANCED) : false;
  const requested4k = !!userRequest4k;
  const canRequest4k = session ? canRequest(session.user.permissions, "TV", true, request4kAllRow?.value === "true") : false;
  // Only surface 4K availability to viewers who can request 4K (instance configured + permission).
  const show4k = has4k && canRequest4k;
  const arr4kAvailable = show4k && !!sonarr4kAvailable;
  const arr4kPending = show4k && !!sonarr4kWanted;

  // Named instances (non-default, non-4K): render an explicit "Request on X"
  // button for each configured one the viewer may target. Grants require a DB
  // read (they're not in the session JWT), so only pay it when one exists.
  const namedDefs = sonarrInstances.filter(
    (i) => i.slug !== "" && i.slug !== FOURK_ARR_INSTANCE,
  );

  const [suggestions, namedTargets] = await Promise.all([
    attachAllAvailability(rawSuggestions, session?.user.id, { blockRatings: true, show4k }),
    (async (): Promise<{ slug: string; name: string; requested: boolean; available: boolean }[]> => {
      if (!session || namedDefs.length === 0 || blacklisted) return [];
      const viewer = await prisma.user.findUnique({
        where: { id: session.user.id },
        select: { instanceGrants: true },
      });
      const grants = parseInstanceGrants(viewer?.instanceGrants);
      const eligible = namedDefs.filter((inst) =>
        canRequestInstance(session.user.permissions, inst, grants, "TV"),
      );
      return Promise.all(
        eligible.map(async (inst) => {
          const [namedRequest, namedAvailable] = await Promise.all([
            prisma.mediaRequest.findFirst({
              where: { tmdbId: media.id, mediaType: "TV", requestedBy: session.user.id, arrInstance: inst.slug, status: { not: "DECLINED" } },
              select: { id: true },
            }),
            prisma.sonarrAvailableItem.findUnique({
              where: { tmdbId_arrInstance: { tmdbId: media.id, arrInstance: inst.slug } },
            }),
          ]);
          return { slug: inst.slug, name: inst.name, requested: !!namedRequest, available: !!namedAvailable };
        }),
      );
    })(),
  ]);
  const { showPlex, showJellyfin } = getBadgeVisibility(session, { plex: plexEnabled, jellyfin: jellyfinEnabled });

  const backdrop = backdropUrl(media.backdropPath, "original");
  const poster = posterUrl(media.posterPath, "w500");

  return (
    <div className="ds-page-enter ds-detail-bleed">
      <div
        className="relative w-full overflow-hidden aspect-video max-h-[500px] xl:max-h-[640px] 2xl:max-h-[760px]"
        style={{ background: "var(--ds-bg-inset)" }}
      >
        {backdrop && (
          <Image src={backdrop} alt="" fill className="object-cover object-top" sizes="100vw" priority />
        )}
        <div
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(to top, var(--ds-bg) 0%, color-mix(in oklab, var(--ds-bg) 55%, transparent) 55%, transparent 100%)",
          }}
        />
      </div>

      <div className="ds-detail-body">
        <div className="ds-detail-hero">
          {poster && (
            <div
              className="ds-detail-poster relative shrink-0 overflow-hidden hidden sm:block"
              style={{
                width: 160,
                aspectRatio: "2 / 3",
                borderRadius: 8,
                boxShadow: "var(--ds-shadow-lg)",
                border: "1px solid var(--ds-border)",
                background: "var(--ds-bg-3)",
              }}
            >
              <Image src={poster} alt={media.title} fill className="object-cover" sizes="160px" />
            </div>
          )}

          <div className="flex flex-col justify-end" style={{ gap: 10 }}>
            <div className="flex items-center flex-wrap" style={{ gap: 8 }}>
              <Chip tone="accent">TV SHOW</Chip>
              <AvailabilityBadges
                plexAvailable={plexAvailable}
                jellyfinAvailable={jellyfinAvailable}
                arrPending={arrPending}
                requested={requested}
                arr4kAvailable={arr4kAvailable}
                arr4kPending={arr4kPending}
                showPlex={showPlex}
                showJellyfin={showJellyfin}
                show4k={show4k}
              />
            </div>

            <h1
              className="font-semibold"
              style={{
                fontSize: 32,
                letterSpacing: "-0.025em",
                color: "var(--ds-fg)",
                margin: 0,
                lineHeight: 1.08,
              }}
            >
              {media.title}
            </h1>

            <div
              className="ds-mono flex items-center flex-wrap"
              style={{ fontSize: 11.5, color: "var(--ds-fg-subtle)", gap: 8 }}
            >
              {[
                media.releaseYear,
                media.certification,
                media.runtime ? `${media.runtime}m/ep` : null,
                media.numberOfSeasons
                  ? `${media.numberOfSeasons} season${media.numberOfSeasons === 1 ? "" : "s"}`
                  : null,
                media.productionCountries?.[0],
                languageName(media.originalLanguage),
                media.status,
              ]
                .filter(Boolean)
                .map((part, i) => (
                  <span key={i} className="flex items-center" style={{ gap: 8 }}>
                    {i > 0 && <span style={{ opacity: 0.4 }}>·</span>}
                    {part}
                  </span>
                ))}
            </div>

            {media.genres && media.genres.length > 0 && (
              <div className="flex flex-wrap" style={{ gap: 6 }}>
                {media.genres.slice(0, 5).map((g) => {
                  const gid = genreNameToId.get(g);
                  return gid !== undefined ? (
                    <Link key={g} href={`/tv?genreId=${gid}`} aria-label={`Browse ${g} TV shows`}>
                      <Chip className="ds-chip-link">{g}</Chip>
                    </Link>
                  ) : (
                    <Chip key={g}>{g}</Chip>
                  );
                })}
              </div>
            )}

            {media.originalTitle && (
              <div className="ds-mono" style={{ fontSize: 11, color: "var(--ds-fg-subtle)" }}>
                Original title: {media.originalTitle}
              </div>
            )}

            {media.nextEpisodeAirDate && (
              <div className="ds-mono" style={{ fontSize: 11, color: "var(--ds-fg-subtle)" }}>
                Next episode:{" "}
                {new Date(media.nextEpisodeAirDate).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </div>
            )}

            <RatingsBar
              imdbRating={media.imdbRating}
              imdbId={media.imdbId}
              imdbVotes={media.imdbVotes}
              rottenTomatoes={media.rottenTomatoes}
              rtAudienceScore={media.rtAudienceScore}
              metacritic={media.metacritic}
              traktRating={media.traktRating}
              letterboxdRating={media.letterboxdRating}
              mdblistScore={media.mdblistScore}
              malRating={media.malRating}
              rogerEbertRating={media.rogerEbertRating}
              jellyfinRating={
                showJellyfin && jellyfinItem?.communityRating != null
                  ? jellyfinItem.communityRating.toFixed(1)
                  : null
              }
              voteAverage={media.voteAverage}
              size="md"
            />

            {media.overview && (
              <p
                className="max-w-2xl"
                style={{
                  fontSize: 14,
                  color: "var(--ds-fg-muted)",
                  lineHeight: 1.65,
                }}
              >
                {media.overview}
              </p>
            )}

            <div
              className="flex items-center flex-wrap"
              style={{ gap: 10, marginTop: 6 }}
            >
              <RequestButton
                tmdbId={media.id}
                mediaType="TV"
                title={media.title}
                posterPath={media.posterPath}
                releaseYear={media.releaseYear ?? undefined}
                plexAvailable={plexAvailable}
                jellyfinAvailable={jellyfinAvailable}
                arrPending={arrPending}
                requested={requested}
                showPlex={showPlex}
                showJellyfin={showJellyfin}
                requestToken={generateRequestToken(media.id, "TV", session?.user.id ?? "")}
                canRequestOnBehalf={canOnBehalf}
                canChooseProfile={canChooseProfile}
                blacklisted={blacklisted}
              />
              {has4k && canRequest4k && (
                <Request4kButton
                  tmdbId={media.id}
                  mediaType="TV"
                  requestToken={generateRequestToken(media.id, "TV", session?.user.id ?? "")}
                  requested={requested4k}
                  available={arr4kAvailable}
                  blacklisted={blacklisted}
                />
              )}
              {namedTargets.map((t) => (
                <RequestInstanceButton
                  key={t.slug}
                  tmdbId={media.id}
                  mediaType="TV"
                  instance={t.slug}
                  instanceName={t.name}
                  requestToken={generateRequestToken(media.id, "TV", session?.user.id ?? "")}
                  requested={t.requested}
                  available={t.available}
                  blacklisted={blacklisted}
                />
              ))}
              {session && (
                <WatchlistButton tmdbId={media.id} mediaType="TV" initialOnWatchlist={onWatchlist} />
              )}
              {session && (
                <HideButton
                  tmdbId={media.id}
                  mediaType="TV"
                  title={media.title}
                  posterPath={media.posterPath}
                  initialHidden={onHidden}
                />
              )}
              {issuesEnabled && ((showPlex && plexAvailable) || (showJellyfin && jellyfinAvailable)) && (
                <ReportIssueButton
                  tmdbId={media.id}
                  tvdbId={tvdbId}
                  mediaType="TV"
                  title={media.title}
                  posterPath={media.posterPath}
                />
              )}
              {votesEnabled && ((showPlex && plexAvailable) || (showJellyfin && jellyfinAvailable)) && session && (
                <VoteDeleteButton
                  tmdbId={media.id}
                  mediaType="TV"
                  requestToken={generateRequestToken(media.id, "TV", session.user.id)}
                  alreadyVoted={!!userDeletionVote}
                />
              )}
              {(media.trailerKey || media.trailerUrl) && (
                <TrailerButton trailerKey={media.trailerKey} trailerUrl={media.trailerUrl} />
              )}
              {media.releasedDigital && (
                <span
                  className="ds-mono"
                  style={{ fontSize: 11, color: "var(--ds-fg-subtle)" }}
                >
                  Digital{" "}
                  {new Date(media.releasedDigital).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      <DetailExtras media={media} mediaType="tv" />

      {cast.length > 0 && <CastSection cast={cast} />}

      {media.seasons && media.seasons.length > 0 && (
        <TVSeasons tmdbId={media.id} seasons={media.seasons} ownedBySeason={ownedBySeason} />
      )}

      <SimilarRow items={suggestions} showPlex={showPlex} showJellyfin={showJellyfin} />
    </div>
  );
}
