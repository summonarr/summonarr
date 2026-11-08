import type { Metadata } from "next";
import { cache } from "react";
import { getMovieDetails, isTmdbNotFound, tmdbLanguageFor, getMovieCredits, getMovieSuggestions, getMovieCollection, getMovieGenres } from "@/lib/tmdb";
import { CastSection } from "@/components/media/cast-section";
import { SimilarRow } from "@/components/media/similar-row";
import { CollectionRow } from "@/components/media/collection-row";
import { notFound } from "next/navigation";
import { parseManageLink } from "@/lib/arr-links-data";
import { requireAppSession } from "@/lib/require-app-session";
import { isTmdbIdInRange, parseTmdbIdParam } from "@/lib/tmdb-id";
import { attachAllAvailability } from "@/lib/attach-all";
import { permanentlyDeclinedKeys } from "@/lib/request-availability";
import { allNamed, emptyOnFailure, loadDetailPageState } from "@/lib/detail-page-data";
import { DetailActions } from "@/components/media/detail-actions";
import { DetailHero } from "@/components/media/detail-hero";
import { DetailExtras } from "@/components/media/detail-extras";
import { languageName, localizedProductionCountry } from "@/lib/tmdb-types";
import { canRequest } from "@/lib/permissions";
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
    if (isTmdbNotFound(err)) notFound();
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

  return (
    <div className="ds-page-enter ds-detail-bleed">
      <DetailHero
        media={media}
        state={state}
        t={t}
        locale={locale}
        kindLabel={t("detail.kindMovie")}
        metaParts={[
          media.releaseYear,
          media.certification,
          media.runtime ? t("detail.runtime.minutes", { minutes: media.runtime }) : null,
          // TMDB's English name unless Intl agrees on the country — never
          // a bare code or ICU's successor-state alias (tmdb-types.ts).
          localizedProductionCountry(media, locale),
          // A code Intl has no name for renders as the code, as it always has.
          languageName(media.originalLanguage, locale) ?? media.originalLanguage,
          media.status && media.status !== "Released" ? translateTmdbStatus(media.status, t) : null,
        ]}
        genreNameToId={genreNameToId}
        genreHref={(gid) => `/movies?genreId=${gid}`}
        genreAriaLabel={(genre) => t("detail.browseGenreMovies", { genre })}
        actions={
          <DetailActions
            media={media}
            mediaType="MOVIE"
            state={state}
            canRequest={canRequestMovies}
            manageLink={manageLink}
            t={t}
          />
        }
      />

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
