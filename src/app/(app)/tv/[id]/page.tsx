import type { Metadata } from "next";
import { cache } from "react";
import { getTVDetails, tmdbLanguageFor, getTVCredits, getTVSuggestions, getTVGenres, backdropUrl, posterUrl } from "@/lib/tmdb";
import Link from "next/link";
import { RatingsBar } from "@/components/media/ratings-bar";
import { CastSection } from "@/components/media/cast-section";
import { SimilarRow } from "@/components/media/similar-row";
import { TVSeasons } from "@/components/media/tv-seasons";
import Image from "next/image";
import { notFound } from "next/navigation";
import { parseManageLink } from "@/lib/arr-links-data";
import { NeverWatchedChip } from "@/components/admin/never-watched-chip";
import { prisma } from "@/lib/prisma";
import { requireAppSession } from "@/lib/require-app-session";
import { isTmdbIdInRange, parseTmdbIdParam } from "@/lib/tmdb-id";
import { attachAllAvailability } from "@/lib/attach-all";
import { providerEpisodeSources, visibleEpisodeSourcesFrom } from "@/lib/media-visibility";
import { allNamed, emptyOnFailure, loadDetailPageState } from "@/lib/detail-page-data";
import { DetailActions } from "@/components/media/detail-actions";
import { AvailabilityBadges } from "@/components/media/availability-badges";
import { DetailExtras } from "@/components/media/detail-extras";
import { languageName, localizedProductionCountry } from "@/lib/tmdb-types";
import { Chip } from "@/components/ui/design";
import { canRequest } from "@/lib/permissions";
import { DetailTitle } from "@/components/layout/detail-title";
import { getLocale, getTranslator } from "@/lib/i18n/server";
import { localizeMedia } from "@/lib/tmdb-localize";
import { translateTmdbStatus } from "@/components/media/detail-status";

// The gate + the details read, ONCE per request, shared by generateMetadata and
// the page body (React `cache`, keyed on the route id — the idiom
// (app)/layout.tsx uses for its settings read; Next only de-duplicates fetch()
// between the two, not Prisma reads or our coalesced TMDB helpers). A
// redirect()/notFound() thrown here is cached as the rejection, so both callers
// see the same outcome.
const loadShow = cache(async (id: string) => {
  // The gate MUST precede the TMDB fetch. On the RSC layout-skip path (proxy
  // skipped by a prefetch header, (app)/layout render skipped by a matching
  // Next-Router-State-Tree) this page's own requireAppSession() is the ONLY
  // check — overlapping it with getTVDetails let an unauthenticated caller
  // burn TMDB/OMDB/MDBList quota and write cache rows before the redirect fired.
  const session = await requireAppSession();
  const [t, locale] = await Promise.all([getTranslator(), getLocale()]);
  // A malformed id or a genuine TMDB 404 is a not-found; ANY other failure
  // (TMDB outage/timeout/5xx, missing credentials, a ratings-chain throw)
  // propagates to (app)/error.tsx, which offers a retry. The old bare
  // catch-all-to-notFound showed "might have been removed" for an existing
  // title during a TMDB blip — same shape as person/[id]/page.tsx.
  // Canonical digits only (parseTmdbIdParam): Number() let "1e3", "0x3E8" and
  // " 1000 " render a title at a URL that isn't its own, and sent "1.5" to TMDB.
  const tmdbId = parseTmdbIdParam(id);
  if (tmdbId === null || !isTmdbIdInRange(tmdbId)) notFound();
  const englishMedia = await getTVDetails(tmdbId).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    if (/failed: 404\b/.test(message)) notFound();
    throw err;
  });
  // Title, overview, tagline and genres in the viewer's language (English is a
  // no-op). The genre list below is fetched in the SAME language so the chips'
  // name → id links keep resolving.
  const [media] = await localizeMedia([englishMedia], locale);
  return { session, t, locale, media };
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
  const { media } = await loadShow(id);
  return { title: media.title };
}

export default async function TVDetailPage({
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
  const { session, t, locale, media } = await loadShow(id);

  const providerSources = providerEpisodeSources(session.user.provider);

  // The viewer-scoped state (shared with the movie page) and this page's own
  // reads, together.
  const warnEmpty = (source: string) => emptyOnFailure("tv-page", source, media.id);
  const { state, tvdbRequest, cast, rawSuggestions, ownedEpisodes, genreList } = await allNamed({
    state: loadDetailPageState(session, media, "TV"),
    tvdbRequest: prisma.mediaRequest.findFirst({
      where: { tmdbId: media.id, mediaType: "TV", tvdbId: { not: null } },
      select: { tvdbId: true },
    }),
    cast: getTVCredits(media.id).catch(warnEmpty("credits")),
    rawSuggestions: getTVSuggestions(media.id).catch(warnEmpty("suggestions")),
    // Fetched for every source the viewer's PROVIDER allows, then filtered
    // below against the scoped library availability resolved alongside it.
    // TVEpisodeCache has no serverInstance column (guardrail 35), so `source`
    // alone would surface a RESTRICTED server's per-episode holdings; `source`
    // is selected here purely so that filter can run without a second query.
    ownedEpisodes: prisma.tVEpisodeCache.findMany({
      where: { tmdbId: media.id, source: { in: providerSources } },
      select: { seasonNumber: true, episodeNumber: true, source: true },
    }),
    genreList: getTVGenres(tmdbLanguageFor(locale)).catch(warnEmpty("genres")),
  });
  const genreNameToId = new Map(genreList.map((g) => [g.name, g.id]));

  // Report a source's episodes only when this viewer can see some server of
  // that type actually holding the show — the TVEpisodeCache gate described in
  // media-visibility.ts. Filtering here rather than in the query above keeps it
  // to zero extra round-trips, since the scoped library rows land in the same
  // read.
  const episodeSources = visibleEpisodeSourcesFrom(state.plexAvailable, state.jellyfinAvailable, providerSources);
  const ownedBySeason: Record<number, number[]> = {};
  const seen = new Set<string>();
  for (const row of ownedEpisodes) {
    if (!episodeSources.includes(row.source as "plex" | "jellyfin")) continue;
    const key = `${row.seasonNumber}:${row.episodeNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);
    (ownedBySeason[row.seasonNumber] ??= []).push(row.episodeNumber);
  }
  const tvdbId = tvdbRequest?.tvdbId ?? null;
  const { showPlex, showJellyfin, show4k } = state;
  const canRequestTv = canRequest(session.user.permissions, "TV", false);

  const suggestions = await attachAllAvailability(rawSuggestions, session.user.id, { blockRatings: true, show4k });
  const manageLink = parseManageLink(sp.manage, sp.tab, "sonarr");

  const backdrop = backdropUrl(media.backdropPath, "original");
  const poster = posterUrl(media.posterPath, "w500");

  return (
    <div className="ds-page-enter ds-detail-bleed">
      {/* Renders nothing — publishes the title so the header breadcrumb
          reads "TV Shows › <title>" instead of "TV Shows › Detail". */}
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
              <Chip tone="accent">{t("detail.kindTv")}</Chip>
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
                media.runtime ? t("detail.runtimePerEpisode", { minutes: media.runtime }) : null,
                media.numberOfSeasons
                  ? t("detail.seasonCount", { count: media.numberOfSeasons })
                  : null,
                // TMDB's English name unless Intl agrees on the country — never
                // a bare code or ICU's successor-state alias (tmdb-types.ts).
                localizedProductionCountry(media, locale),
                // A code Intl has no name for renders as the code, as it always has.
                languageName(media.originalLanguage, locale) ?? media.originalLanguage,
                media.status ? translateTmdbStatus(media.status, t) : null,
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
                    <Link key={g} href={`/tv?genreId=${gid}`} aria-label={t("detail.browseGenreTv", { genre: g })}>
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

            {media.nextEpisodeAirDate && (
              <div className="ds-mono" style={{ fontSize: 11, color: "var(--ds-fg-subtle)" }}>
                {t("detail.nextEpisode")}{" "}
                {/* TMDB air dates are date-only ("YYYY-MM-DD"), which Date parses
                    as UTC midnight — format in UTC too, or a server running west
                    of UTC renders the day before (same fix as formatReleaseDate). */}
                {new Date(media.nextEpisodeAirDate).toLocaleDateString(locale, {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                  timeZone: "UTC",
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
              mediaType="TV"
              state={state}
              canRequest={canRequestTv}
              tvdbId={tvdbId}
              manageLink={manageLink}
              t={t}
            />
          </div>
        </div>
      </div>

      <DetailExtras media={media} mediaType="tv" />

      {cast.length > 0 && <CastSection cast={cast} />}

      {media.seasons && media.seasons.length > 0 && (
        <TVSeasons tmdbId={media.id} seasons={media.seasons} ownedBySeason={ownedBySeason} />
      )}

      <SimilarRow items={suggestions} showPlex={showPlex} showJellyfin={showJellyfin} canRequest={canRequestTv} />
    </div>
  );
}
