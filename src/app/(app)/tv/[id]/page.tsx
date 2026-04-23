import { getTVDetails, getTVCredits, getTVSuggestions, backdropUrl, posterUrl } from "@/lib/tmdb";
import { RequestButton } from "@/components/media/request-button";
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
import { Chip } from "@/components/ui/design";

export default async function TVDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let media;
  try {
    media = await getTVDetails(Number(id));
  } catch {
    notFound();
  }

  const session = await auth();

  const provider = session?.user.provider;
  const episodeSources =
    provider === "plex"
      ? ["plex"]
      : provider === "jellyfin" || provider === "jellyfin-quickconnect"
      ? ["jellyfin"]
      : ["plex", "jellyfin"];

  const [plexItem, jellyfinItem, tvdbRequest, userRequest, userDeletionVote, sonarrWanted, cast, rawSuggestions, ownedEpisodes] = await Promise.all([
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
      where: { tmdbId: media.id, mediaType: "TV", requestedBy: session.user.id, status: { not: "DECLINED" } },
      select: { id: true },
    }) : Promise.resolve(null),
    session ? prisma.deletionVote.findFirst({
      where: { tmdbId: media.id, mediaType: "TV", userId: session.user.id },
      select: { id: true },
    }) : Promise.resolve(null),
    prisma.sonarrWantedItem.findUnique({ where: { tmdbId: media.id } }),
    getTVCredits(media.id).catch(() => []),
    getTVSuggestions(media.id).catch(() => []),
    prisma.tVEpisodeCache.findMany({
      where: { tmdbId: media.id, source: { in: episodeSources } },
      select: { seasonNumber: true, episodeNumber: true },
    }),
  ]);

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
  const { showPlex, showJellyfin } = getBadgeVisibility(session);

  const suggestions = await attachAllAvailability(rawSuggestions, session?.user.id);

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
              {media.releaseYear && (
                <span
                  className="ds-mono"
                  style={{ fontSize: 12, color: "var(--ds-fg-muted)" }}
                >
                  {media.releaseYear}
                </span>
              )}
              {media.certification && <Chip>{media.certification}</Chip>}
            </div>

            <h1
              className="font-bold"
              style={{
                fontSize: 28,
                letterSpacing: "-0.02em",
                color: "var(--ds-fg)",
                margin: 0,
                lineHeight: 1.1,
              }}
            >
              {media.title}
            </h1>

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
              <p
                className="max-w-2xl leading-relaxed"
                style={{ fontSize: 13, color: "var(--ds-fg-muted)" }}
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
              />
              {((showPlex && plexAvailable) || (showJellyfin && jellyfinAvailable)) && (
                <ReportIssueButton
                  tmdbId={media.id}
                  tvdbId={tvdbId}
                  mediaType="TV"
                  title={media.title}
                  posterPath={media.posterPath}
                />
              )}
              {((showPlex && plexAvailable) || (showJellyfin && jellyfinAvailable)) && session && (
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

      {cast.length > 0 && <CastSection cast={cast} />}

      {media.seasons && media.seasons.length > 0 && (
        <TVSeasons tmdbId={media.id} seasons={media.seasons} ownedBySeason={ownedBySeason} />
      )}

      <SimilarRow items={suggestions} showPlex={showPlex} showJellyfin={showJellyfin} />
    </div>
  );
}
