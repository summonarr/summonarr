import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { RatingsBar } from "@/components/media/ratings-bar";
import { AvailabilityBadges } from "@/components/media/availability-badges";
import { NeverWatchedChip } from "@/components/admin/never-watched-chip";
import { DetailTitle } from "@/components/layout/detail-title";
import { Chip } from "@/components/ui/design";
import { backdropUrl, posterUrl } from "@/lib/tmdb";
import type { TmdbMedia } from "@/lib/tmdb-types";
import type { DetailPageState } from "@/lib/detail-page-data";
import type { Translator } from "@/lib/i18n/translate";

// The backdrop + hero block the movie and TV detail pages share: poster,
// chips, title, meta line, genre links, ratings, overview and the actions.
// Server component — the pages pass their type-specific parts in.
export function DetailHero({
  media,
  state,
  t,
  locale,
  kindLabel,
  metaParts,
  genreNameToId,
  genreHref,
  genreAriaLabel,
  extraLines,
  actions,
}: {
  media: TmdbMedia;
  state: DetailPageState;
  t: Translator;
  locale: string;
  kindLabel: string;
  /** The "·"-separated meta line; falsy parts are dropped. */
  metaParts: ReadonlyArray<string | number | null | undefined>;
  genreNameToId: ReadonlyMap<string, number>;
  genreHref: (genreId: number) => string;
  genreAriaLabel: (genre: string) => string;
  /** Rendered under the original title, above the ratings (the TV next-episode line). */
  extraLines?: ReactNode;
  actions: ReactNode;
}) {
  const { showPlex, showJellyfin, show4k } = state;
  const backdrop = backdropUrl(media.backdropPath, "original");
  const poster = posterUrl(media.posterPath, "w500");

  return (
    <>
      {/* Renders nothing — publishes the title so the header breadcrumb
          reads "<section> › <title>" instead of "<section> › Detail". */}
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
              {/* Decorative: the <h1> beside it carries the title, so a named
                  poster read the title twice. Same rule as the backdrop. */}
              <Image src={poster} alt="" fill className="object-cover" sizes="160px" />
            </div>
          )}

          <div className="flex flex-col justify-end" style={{ gap: 10 }}>
            <div className="flex items-center flex-wrap" style={{ gap: 8 }}>
              <Chip tone="accent">{kindLabel}</Chip>
              <AvailabilityBadges
                plexAvailable={state.plexAvailable}
                jellyfinAvailable={state.jellyfinAvailable}
                arrPending={state.arrPending}
                requested={state.requestedAny}
                arr4kAvailable={state.arr4kAvailable}
                arr4kPending={state.arr4kPending}
                showPlex={showPlex}
                showJellyfin={showJellyfin}
                show4k={show4k}
              />
              <NeverWatchedChip info={state.neverWatched} t={t} locale={locale} />
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
              {metaParts
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
                    <Link key={g} href={genreHref(gid)} aria-label={genreAriaLabel(g)}>
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
                {t("detail.originalTitle", { title: media.originalTitle })}
              </div>
            )}

            {extraLines}

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
                showJellyfin && state.jellyfinCommunityRating != null
                  ? state.jellyfinCommunityRating.toFixed(1)
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

            {actions}
          </div>
        </div>
      </div>
    </>
  );
}
