import { getMovieDetails, getMovieCredits, getMovieSuggestions, getMovieCollection, backdropUrl, posterUrl } from "@/lib/tmdb";
import { Badge } from "@/components/ui/badge";
import { RequestButton } from "@/components/media/request-button";
import { ReportIssueButton } from "@/components/media/report-issue-button";
import { RatingsBar } from "@/components/media/ratings-bar";
import { CastSection } from "@/components/media/cast-section";
import { SimilarRow } from "@/components/media/similar-row";
import { CollectionRow } from "@/components/media/collection-row";
import Image from "next/image";
import { notFound } from "next/navigation";
import { TrailerButton } from "@/components/media/trailer-button";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { attachAllAvailability } from "@/lib/attach-all";
import { getBadgeVisibility } from "@/lib/badge-visibility";
import { generateRequestToken } from "@/lib/request-token";
import { VoteDeleteButton } from "@/components/votes/vote-delete-button";

export default async function MovieDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let media;
  try {
    media = await getMovieDetails(Number(id));
  } catch {
    notFound();
  }

  const session = await auth();

  const [plexItem, jellyfinItem, radarrWanted, userRequest, userDeletionVote, cast, rawSuggestions, rawCollection] = await Promise.all([
    prisma.plexLibraryItem.findUnique({
      where: { tmdbId_mediaType: { tmdbId: media.id, mediaType: "MOVIE" } },
    }),
    prisma.jellyfinLibraryItem.findUnique({
      where: { tmdbId_mediaType: { tmdbId: media.id, mediaType: "MOVIE" } },
    }),
    prisma.radarrWantedItem.findUnique({ where: { tmdbId: media.id } }),
    session ? prisma.mediaRequest.findFirst({
      where: { tmdbId: media.id, mediaType: "MOVIE", requestedBy: session.user.id, status: { not: "DECLINED" } },
      select: { id: true },
    }) : Promise.resolve(null),
    session ? prisma.deletionVote.findFirst({
      where: { tmdbId: media.id, mediaType: "MOVIE", userId: session.user.id },
      select: { id: true },
    }) : Promise.resolve(null),
    getMovieCredits(media.id).catch(() => []),
    getMovieSuggestions(media.id).catch(() => []),
    media.collectionId ? getMovieCollection(media.collectionId).catch(() => []) : Promise.resolve([]),
  ]);
  const plexAvailable     = !!plexItem;
  const jellyfinAvailable = !!jellyfinItem;
  const arrPending        = !!radarrWanted;
  const requested         = !!userRequest;
  const { showPlex, showJellyfin } = getBadgeVisibility(session);

  const [suggestions, collectionItems] = await Promise.all([
    attachAllAvailability(rawSuggestions, session?.user.id),
    attachAllAvailability(rawCollection, session?.user.id, { skipRatings: true }),
  ]);

  const backdrop = backdropUrl(media.backdropPath, "original");
  const poster = posterUrl(media.posterPath, "w500");

  return (
    <div className="-m-6 lg:-m-8 xl:-m-10">
      <div className="relative w-full overflow-hidden aspect-video max-h-[500px] xl:max-h-[640px] 2xl:max-h-[760px]">
        {backdrop && (
          <Image src={backdrop} alt="" fill className="object-cover object-top" sizes="100vw" priority />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-zinc-950 via-zinc-950/50 to-transparent" />
      </div>

      <div className="px-6 pb-8 -mt-32 relative flex gap-6">
        {poster && (
          <div className="relative w-36 h-52 shrink-0 rounded-lg overflow-hidden shadow-2xl hidden sm:block">
            <Image src={poster} alt={media.title} fill className="object-cover" sizes="144px" />
          </div>
        )}

        <div className="flex flex-col justify-end gap-3 pt-28 sm:pt-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge className="bg-indigo-600 text-white border-0">Movie</Badge>
            {media.releaseYear && (
              <span className="text-zinc-400 text-sm">{media.releaseYear}</span>
            )}
            {media.certification && (
              <Badge className="bg-zinc-700 text-zinc-200 border border-zinc-500 text-xs">
                {media.certification}
              </Badge>
            )}
          </div>

          <h1 className="text-3xl font-bold text-white">{media.title}</h1>

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
            voteAverage={media.voteAverage}
          />

          {media.overview && (
            <p className="text-zinc-300 text-sm max-w-2xl leading-relaxed">{media.overview}</p>
          )}

          <div className="mt-2 flex items-center gap-3 flex-wrap">
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
              requestToken={generateRequestToken(media.id, "MOVIE", session?.user.id ?? "")}
            />
            {((showPlex && plexAvailable) || (showJellyfin && jellyfinAvailable)) && (
              <ReportIssueButton
                tmdbId={media.id}
                mediaType="MOVIE"
                title={media.title}
                posterPath={media.posterPath}
              />
            )}
            {((showPlex && plexAvailable) || (showJellyfin && jellyfinAvailable)) && session && (
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
              <span className="text-zinc-500 text-xs">
                Digital {new Date(media.releasedDigital).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
              </span>
            )}
          </div>
        </div>
      </div>

      {cast.length > 0 && <CastSection cast={cast} />}

      {media.collectionId && media.collectionName && (
        <CollectionRow
          collectionName={media.collectionName}
          items={collectionItems}
          currentId={media.id}
          showPlex={showPlex}
          showJellyfin={showJellyfin}
        />
      )}

      <SimilarRow items={suggestions} showPlex={showPlex} showJellyfin={showJellyfin} />
    </div>
  );
}
