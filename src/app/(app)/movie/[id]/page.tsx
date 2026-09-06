import { getMovieDetails, getMovieCredits, getMovieSuggestions, getMovieCollection, getMovieGenres, backdropUrl, posterUrl } from "@/lib/tmdb";
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
import { CollectionRow } from "@/components/media/collection-row";
import Image from "next/image";
import { notFound } from "next/navigation";
import { TrailerButton } from "@/components/media/trailer-button";
import { prisma } from "@/lib/prisma";
import { requireAppSession } from "@/lib/require-app-session";
import { attachAllAvailability } from "@/lib/attach-all";
import { getVisibleServerInstances } from "@/lib/media-visibility";
import { getBadgeVisibility } from "@/lib/badge-visibility";
import { isFeatureEnabled } from "@/lib/features";
import { generateRequestToken } from "@/lib/request-token";
import { VoteDeleteButton } from "@/components/votes/vote-delete-button";
import { AvailabilityBadges } from "@/components/media/availability-badges";
import { DetailExtras } from "@/components/media/detail-extras";
import { languageName } from "@/lib/tmdb-types";
import { Chip } from "@/components/ui/design";
import { canRequest, hasPermission, Permission } from "@/lib/permissions";
import { resolveNamedInstanceTargets } from "@/lib/named-instance-targets";
import { isBlacklisted } from "@/lib/blacklist";
import { DetailTitle } from "@/components/layout/detail-title";

export default async function MovieDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // The gate MUST precede the TMDB fetch. On the RSC layout-skip path (proxy
  // skipped by a prefetch header, (app)/layout render skipped by a matching
  // Next-Router-State-Tree) this page's own requireAppSession() is the ONLY
  // check — overlapping it with getMovieDetails let an unauthenticated caller
  // burn TMDB/OMDB/MDBList quota and write cache rows before the redirect fired.
  const session = await requireAppSession();
  // A malformed id or a genuine TMDB 404 is a not-found; ANY other failure
  // (TMDB outage/timeout/5xx, missing credentials, a ratings-chain throw)
  // propagates to (app)/error.tsx, which offers a retry. The old bare
  // catch-all-to-notFound showed "might have been removed" for an existing
  // title during a TMDB blip — same shape as person/[id]/page.tsx.
  const tmdbId = Number(id);
  if (!Number.isFinite(tmdbId) || tmdbId <= 0) notFound();
  const media = await getMovieDetails(tmdbId).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    if (/failed: 404\b/.test(message)) notFound();
    throw err;
  });

  // Which Plex/Jellyfin servers this viewer may see. Everything downstream keys off the two
  // library rows below — the availability badges, the ratings bar's Jellyfin score, and the
  // in-library gates on the "report issue" / "vote to delete" actions — so scoping the
  // QUERIES (not their results) is what keeps a restricted server invisible end to end.
  const visible = await getVisibleServerInstances(session);

  const [
    plexItem,
    jellyfinItem,
    radarrWanted,
    userRequest,
    userDeletionVote,
    cast,
    rawSuggestions,
    rawCollection,
    genreList,
    blacklisted,
    has4k,
    userRequest4k,
    request4kAllRow,
    radarr4kAvailable,
    radarr4kWanted,
    votesEnabled,
    issuesEnabled,
    plexEnabled,
    jellyfinEnabled,
    onWatchlist,
    onHidden,
  ] = await Promise.all([
    prisma.plexLibraryItem.findFirst({
      where: { tmdbId: media.id, mediaType: "MOVIE", serverInstance: { in: visible.plex } },
    }),
    prisma.jellyfinLibraryItem.findFirst({
      where: { tmdbId: media.id, mediaType: "MOVIE", serverInstance: { in: visible.jellyfin } },
    }),
    prisma.radarrWantedItem.findUnique({ where: { tmdbId_arrInstance: { tmdbId: media.id, arrInstance: "" } } }),
    prisma.mediaRequest.findFirst({
      // Any non-4K instance: the main request button owns the default AND named
      // (auto-routed, e.g. anime) requests; only 4K has its own separate button.
      where: { tmdbId: media.id, mediaType: "MOVIE", requestedBy: session.user.id, arrInstance: { not: "4k" }, status: { not: "DECLINED" } },
      select: { id: true },
    }),
    prisma.deletionVote.findFirst({
      where: { tmdbId: media.id, mediaType: "MOVIE", userId: session.user.id },
      select: { id: true },
    }),
    getMovieCredits(media.id).catch(() => []),
    getMovieSuggestions(media.id).catch(() => []),
    media.collectionId ? getMovieCollection(media.collectionId).catch(() => []) : Promise.resolve([]),
    getMovieGenres().catch(() => []),
    isBlacklisted(media.id, "MOVIE"),
    // 4K: show the "Request in 4K" action only when a 4K Radarr instance is
    // configured AND the viewer holds REQUEST_4K.
    isArrConfigured("radarr", "4k"),
    prisma.mediaRequest.findFirst({
      where: { tmdbId: media.id, mediaType: "MOVIE", requestedBy: session.user.id, arrInstance: "4k", status: { not: "DECLINED" } },
      select: { id: true },
    }),
    prisma.setting.findUnique({ where: { key: "request4kAll" } }),
    prisma.radarrAvailableItem.findUnique({ where: { tmdbId_arrInstance: { tmdbId: media.id, arrInstance: "4k" } } }),
    prisma.radarrWantedItem.findUnique({ where: { tmdbId_arrInstance: { tmdbId: media.id, arrInstance: "4k" } } }),
    // The TV detail page has gated on these four since it was written; this
    // page never did. Without the page flags the Report-issue and Vote-to-
    // delete buttons render even when the feature is off, and only fail on
    // submit with the API's 403 — a dead-end button. Without the integration
    // flags getBadgeVisibility defaults both servers to true, so a disabled
    // Plex still shows Plex badges AND still satisfies the showPlex gate that
    // guards those very buttons.
    isFeatureEnabled("feature.page.votes"),
    isFeatureEnabled("feature.page.issues"),
    isFeatureEnabled("feature.integration.plex"),
    isFeatureEnabled("feature.integration.jellyfin"),
    prisma.watchlistItem
      .findUnique({ where: { userId_tmdbId_mediaType: { userId: session.user.id, tmdbId: media.id, mediaType: "MOVIE" } }, select: { id: true } })
      .then((r) => !!r),
    prisma.hiddenItem
      .findUnique({ where: { userId_tmdbId_mediaType: { userId: session.user.id, tmdbId: media.id, mediaType: "MOVIE" } }, select: { id: true } })
      .then((r) => !!r),
  ]);
  const genreNameToId = new Map(genreList.map((g) => [g.name, g.id]));
  const plexAvailable     = !!plexItem;
  const jellyfinAvailable = !!jellyfinItem;
  const arrPending        = !!radarrWanted;
  const requested         = !!userRequest;
  const { showPlex, showJellyfin } = getBadgeVisibility(session, { plex: plexEnabled, jellyfin: jellyfinEnabled });
  const canRequestMovies = canRequest(session.user.permissions, "MOVIE", false);
  const canOnBehalf = hasPermission(session.user.permissions, Permission.REQUEST_ON_BEHALF);
  const canChooseProfile = hasPermission(session.user.permissions, Permission.REQUEST_ADVANCED);
  const requested4k = !!userRequest4k;
  const canRequest4k = canRequest(session.user.permissions, "MOVIE", true, request4kAllRow?.value === "true");
  // Only surface 4K availability to viewers who can request 4K (instance configured + permission).
  const show4k = has4k && canRequest4k;
  const arr4kAvailable = show4k && !!radarr4kAvailable;
  const arr4kPending = show4k && !!radarr4kWanted;

  // Named instances (non-default, non-4K): render an explicit "Request on X"
  // button for each configured one the viewer may target. Shared with the TV
  // page and GET /api/requests/instances so the three can't drift — see
  // resolveNamedInstanceTargets.
  const [suggestions, collectionItems, namedTargets] = await Promise.all([
    attachAllAvailability(rawSuggestions, session.user.id, { blockRatings: true, show4k }),
    attachAllAvailability(rawCollection, session.user.id, { skipRatings: true, show4k }),
    resolveNamedInstanceTargets({
      tmdbId: media.id,
      mediaType: "MOVIE",
      userId: session.user.id,
      permissions: session.user.permissions,
      blacklisted,
    }),
  ]);

  const backdrop = backdropUrl(media.backdropPath, "original");
  const poster = posterUrl(media.posterPath, "w500");

  return (
    <div className="ds-page-enter ds-detail-bleed">
      {/* Renders nothing — publishes the title so the header breadcrumb
          reads "Movies › <title>" instead of "Movies › Detail". */}
      <DetailTitle title={media.title} />
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
              <Chip tone="accent">MOVIE</Chip>
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
                media.runtime ? `${media.runtime}m` : null,
                media.productionCountries?.[0],
                languageName(media.originalLanguage),
                media.status && media.status !== "Released" ? media.status : null,
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
                    <Link key={g} href={`/movies?genreId=${gid}`} aria-label={`Browse ${g} movies`}>
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
                mediaType="MOVIE"
                title={media.title}
                posterPath={media.posterPath}
                releaseYear={media.releaseYear ?? undefined}
                plexAvailable={plexAvailable}
                jellyfinAvailable={jellyfinAvailable}
                arrPending={arrPending}
                requested={requested}
                showPlex={showPlex}
                showJellyfin={showJellyfin}
                requestToken={generateRequestToken(media.id, "MOVIE", session.user.id)}
                canRequestOnBehalf={canOnBehalf}
                canChooseProfile={canChooseProfile}
                blacklisted={blacklisted}
              />
              {has4k && canRequest4k && (
                <Request4kButton
                  tmdbId={media.id}
                  mediaType="MOVIE"
                  requestToken={generateRequestToken(media.id, "MOVIE", session.user.id)}
                  requested={requested4k}
                  available={arr4kAvailable}
                  blacklisted={blacklisted}
                />
              )}
              {namedTargets.map((t) => (
                <RequestInstanceButton
                  key={t.slug}
                  tmdbId={media.id}
                  mediaType="MOVIE"
                  instance={t.slug}
                  instanceName={t.name}
                  requestToken={generateRequestToken(media.id, "MOVIE", session.user.id)}
                  requested={t.requested}
                  available={t.available}
                  blacklisted={blacklisted}
                />
              ))}
              <WatchlistButton tmdbId={media.id} mediaType="MOVIE" initialOnWatchlist={onWatchlist} />
              <HideButton
                  tmdbId={media.id}
                  mediaType="MOVIE"
                  title={media.title}
                  posterPath={media.posterPath}
                initialHidden={onHidden}
              />
              {issuesEnabled && ((showPlex && plexAvailable) || (showJellyfin && jellyfinAvailable)) && (
                <ReportIssueButton
                  tmdbId={media.id}
                  mediaType="MOVIE"
                  title={media.title}
                  posterPath={media.posterPath}
                />
              )}
              {votesEnabled && ((showPlex && plexAvailable) || (showJellyfin && jellyfinAvailable)) && (
                <VoteDeleteButton
                  tmdbId={media.id}
                  mediaType="MOVIE"
                  requestToken={generateRequestToken(media.id, "MOVIE", session.user.id)}
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

      <DetailExtras media={media} mediaType="movie" />

      {cast.length > 0 && <CastSection cast={cast} />}

      {media.collectionId && media.collectionName && (
        <CollectionRow
          collectionName={media.collectionName}
          items={collectionItems}
          currentId={media.id}
          showPlex={showPlex}
          showJellyfin={showJellyfin}
          canRequest={canRequestMovies}
        />
      )}

      <SimilarRow items={suggestions} showPlex={showPlex} showJellyfin={showJellyfin} />
    </div>
  );
}
