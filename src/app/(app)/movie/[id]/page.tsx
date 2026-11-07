import type { Metadata } from "next";
import { cache } from "react";
import { getMovieDetails, tmdbLanguageFor, getMovieCredits, getMovieSuggestions, getMovieCollection, getMovieGenres, backdropUrl, posterUrl } from "@/lib/tmdb";
import Link from "next/link";
import { RatingsBar } from "@/components/media/ratings-bar";
import { CastSection } from "@/components/media/cast-section";
import { SimilarRow } from "@/components/media/similar-row";
import { CollectionRow } from "@/components/media/collection-row";
import Image from "next/image";
import { notFound } from "next/navigation";
import { parseManageLink } from "@/lib/arr-links-data";
import { NeverWatchedChip } from "@/components/admin/never-watched-chip";
import { requireAppSession } from "@/lib/require-app-session";
import { isTmdbIdInRange, parseTmdbIdParam } from "@/lib/tmdb-id";
import { attachAllAvailability } from "@/lib/attach-all";
import { permanentlyDeclinedKeys } from "@/lib/request-availability";
import { allNamed, emptyOnFailure, loadDetailPageState } from "@/lib/detail-page-data";
import { DetailActions } from "@/components/media/detail-actions";
import { AvailabilityBadges } from "@/components/media/availability-badges";
import { DetailExtras } from "@/components/media/detail-extras";
import { languageName, localizedProductionCountry } from "@/lib/tmdb-types";
import { Chip } from "@/components/ui/design";
import { canRequest } from "@/lib/permissions";
import { DetailTitle } from "@/components/layout/detail-title";
import { getLocale, getTranslator } from "@/lib/i18n/server";
import { localizeMedia, localizedCollectionName } from "@/lib/tmdb-localize";
import { translateTmdbStatus } from "@/components/media/detail-status";

// The gate + the details read, ONCE per request, shared by generateMetadata and
// the page body (React `cache`, keyed on the route id — the idiom
// (app)/layout.tsx uses for its settings read; Next only de-duplicates fetch()
// between the two, not Prisma reads or our coalesced TMDB helpers). A
// redirect()/notFound() thrown here is cached as the rejection, so both callers
// see the same outcome.
const loadMovie = cache(async (id: string) => {
  // The login gate MUST run before the TMDB fetch. When a crafted request
  // skips both the proxy and the (app) layout, this call is the ONLY check —
  // running the fetch alongside it let a signed-out caller use up TMDB/OMDB/
  // MDBList quota and write cache rows before the redirect happened.
  const session = await requireAppSession();
  const [t, locale] = await Promise.all([getTranslator(), getLocale()]);
  // A malformed id or a real TMDB 404 shows the not-found page. ANY other
  // failure (TMDB outage, timeout, missing credentials, a ratings error) is
  // rethrown to (app)/error.tsx, which offers a retry — so a brief TMDB outage
  // doesn't claim an existing title was removed. Same shape as person/[id].
  // Canonical digits only (parseTmdbIdParam): Number() let "1e3", "0x3E8" and
  // " 1000 " render a title at a URL that isn't its own, and sent "1.5" to TMDB.
  const tmdbId = parseTmdbIdParam(id);
  if (tmdbId === null || !isTmdbIdInRange(tmdbId)) notFound();
  const englishMedia = await getMovieDetails(tmdbId).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    if (/failed: 404\b/.test(message)) notFound();
    throw err;
  });
  // Title, overview, tagline and genres in the viewer's language (English is a
  // no-op). The genre list below is fetched in the SAME language so the chips'
  // name → id links keep resolving.
  const [[media], collectionName] = await Promise.all([
    localizeMedia([englishMedia], locale),
    englishMedia.collectionId && englishMedia.collectionName
      ? localizedCollectionName(englishMedia.collectionId, englishMedia.collectionName, locale)
      : Promise.resolve(englishMedia.collectionName ?? null),
  ]);
  return { session, t, locale, media, collectionName };
});

// Tab / bookmark / history title: the (localized) TMDB title, under the root
// layout's "%s · Summonarr" template. Runs the same gate-first loader as the
// page, so a signed-out caller still burns no TMDB quota here.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const { media } = await loadMovie(id);
  return { title: media.title };
}

export default async function MovieDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  // `?manage=<service>:<slug>&tab=` opens the title manager on that instance
  // (a link from an admin list); it only ever selects among this page's own.
  const sp = await searchParams;
  const { session, t, locale, media, collectionName } = await loadMovie(id);

  // The viewer-scoped state (shared with the TV page) and this page's TMDB
  // rows, together. A failed TMDB side read degrades to an empty row and says
  // so in the log; the page still renders.
  const warnEmpty = (source: string) => emptyOnFailure("movie-page", source, media.id);
  const { state, cast, rawSuggestions, rawCollection, genreList } = await allNamed({
    state: loadDetailPageState(session, media, "MOVIE"),
    cast: getMovieCredits(media.id).catch(warnEmpty("credits")),
    rawSuggestions: getMovieSuggestions(media.id).catch(warnEmpty("suggestions")),
    rawCollection: media.collectionId ? getMovieCollection(media.collectionId).catch(warnEmpty("collection")) : Promise.resolve([]),
    genreList: getMovieGenres(tmdbLanguageFor(locale)).catch(warnEmpty("genres")),
  });
  const genreNameToId = new Map(genreList.map((g) => [g.name, g.id]));
  const { showPlex, showJellyfin, show4k } = state;
  const canRequestMovies = canRequest(session.user.permissions, "MOVIE", false);

  const { suggestions, collectionItems, collectionDeclined } = await allNamed({
    suggestions: attachAllAvailability(rawSuggestions, session.user.id, { blockRatings: true, show4k }),
    collectionItems: attachAllAvailability(rawCollection, session.user.id, { skipRatings: true, show4k }),
    // Titles the collection's "Request all" must leave out: permanently
    // declined for this viewer, so the bulk route would skip them every time.
    collectionDeclined: permanentlyDeclinedKeys(rawCollection, session.user.id),
  });
  const manageLink = parseManageLink(sp.manage, sp.tab, "radarr");

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
              {/* Decorative: the <h1> beside it carries the title, so a named
                  poster read the title twice. Same rule as the backdrop. */}
              <Image src={poster} alt="" fill className="object-cover" sizes="160px" />
            </div>
          )}

          <div className="flex flex-col justify-end" style={{ gap: 10 }}>
            <div className="flex items-center flex-wrap" style={{ gap: 8 }}>
              <Chip tone="accent">{t("detail.kindMovie")}</Chip>
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
              {[
                media.releaseYear,
                media.certification,
                media.runtime ? t("detail.runtime.minutes", { minutes: media.runtime }) : null,
                // TMDB's English name unless Intl agrees on the country — never
                // a bare code or ICU's successor-state alias (tmdb-types.ts).
                localizedProductionCountry(media, locale),
                // A code Intl has no name for renders as the code, as it always has.
                languageName(media.originalLanguage, locale) ?? media.originalLanguage,
                media.status && media.status !== "Released" ? translateTmdbStatus(media.status, t) : null,
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
                    <Link key={g} href={`/movies?genreId=${gid}`} aria-label={t("detail.browseGenreMovies", { genre: g })}>
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

            <DetailActions
              media={media}
              mediaType="MOVIE"
              state={state}
              canRequest={canRequestMovies}
              manageLink={manageLink}
              t={t}
            />
          </div>
        </div>
      </div>

      <DetailExtras media={media} mediaType="movie" />

      {cast.length > 0 && <CastSection cast={cast} />}

      {media.collectionId && collectionName && (
        <CollectionRow
          collectionName={collectionName}
          items={collectionItems}
          declinedKeys={collectionDeclined}
          currentId={media.id}
          showPlex={showPlex}
          showJellyfin={showJellyfin}
          canRequest={canRequestMovies}
        />
      )}

      <SimilarRow items={suggestions} showPlex={showPlex} showJellyfin={showJellyfin} canRequest={canRequestMovies} />
    </div>
  );
}
