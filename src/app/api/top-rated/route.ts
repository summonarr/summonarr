import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { getBadgeVisibility } from "@/lib/badge-visibility";
import { getTopRatedMovies, getTopRatedTV, type TmdbMedia } from "@/lib/tmdb";
import { getTraktPopularMovies, getTraktPopularTV } from "@/lib/trakt";
import { getMdblistTopRated } from "@/lib/mdblist";
import { attachAllAvailability } from "@/lib/attach-all";
import { getShow4kVisibility } from "@/lib/four-k-visibility";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { isFeatureEnabled } from "@/lib/features";

// Native-client mirror of src/app/(app)/top/page.tsx — deduplicated top-rated
// titles across TMDB + Trakt + MDBList, sorted by a chosen rating source. Keep
// the dedupe / backfill / filter / sort logic in sync with that page.
const PER_PAGE = 36;

type SortBy = "imdb" | "letterboxd" | "rt" | "trakt" | "mdblist";

// Sort by the chosen rating source, pushing titles with no parseable rating last.
function sortByRating(items: TmdbMedia[], sortBy: SortBy): TmdbMedia[] {
  return [...items].sort((a, b) => {
    let av: number, bv: number;
    switch (sortBy) {
      case "letterboxd":
        av = parseFloat(a.letterboxdRating ?? "");
        bv = parseFloat(b.letterboxdRating ?? "");
        break;
      case "rt":
        av = parseInt(a.rottenTomatoes?.replace("%", "") ?? "", 10);
        bv = parseInt(b.rottenTomatoes?.replace("%", "") ?? "", 10);
        break;
      case "trakt":
        av = parseFloat(a.traktRating ?? "");
        bv = parseFloat(b.traktRating ?? "");
        break;
      case "mdblist":
        av = parseFloat(a.mdblistScore ?? "");
        bv = parseFloat(b.mdblistScore ?? "");
        break;
      default:
        av = parseFloat(a.imdbRating ?? "");
        bv = parseFloat(b.imdbRating ?? "");
    }
    if (!isNaN(av) && !isNaN(bv)) return bv - av;
    if (!isNaN(av)) return -1;
    if (!isNaN(bv)) return 1;
    return b.voteAverage - a.voteAverage;
  });
}

// Merge the per-source arrays, keeping the first occurrence of each mediaType:id.
function dedup(sources: TmdbMedia[][]): TmdbMedia[] {
  const seen = new Set<string>();
  const result: TmdbMedia[] = [];
  for (const items of sources) {
    for (const item of items) {
      const key = `${item.mediaType}:${item.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(item);
      }
    }
  }
  return result;
}

// Fill posterless items (Trakt/MDBList entries lacking TMDB fields) from the TmdbMediaCore cache.
async function backfillMetadata(items: TmdbMedia[]): Promise<TmdbMedia[]> {
  const missing = items.filter((i) => !i.posterPath);
  if (missing.length === 0) return items;

  const coreRows = await prisma.tmdbMediaCore.findMany({
    where: {
      OR: missing.map((i) => ({
        tmdbId: i.id,
        mediaType: i.mediaType === "movie" ? "MOVIE" : "TV",
      })),
    },
  });
  const coreMap = new Map(coreRows.map((r) => [`${r.mediaType}:${r.tmdbId}`, r]));

  return items.map((item) => {
    if (item.posterPath) return item;
    const core = coreMap.get(`${item.mediaType === "movie" ? "MOVIE" : "TV"}:${item.id}`);
    if (!core) return item;
    return {
      ...item,
      title: core.title || item.title,
      posterPath: core.posterPath ?? item.posterPath,
      releaseYear: core.releaseYear ?? item.releaseYear,
      voteAverage: core.voteAverage ?? item.voteAverage,
    };
  });
}

// Apply the availability / rating / vote-count / year filters from the query string.
function applyFilters(
  items: TmdbMedia[],
  opts: { hideAvailable: boolean; showPlex: boolean; showJellyfin: boolean; minImdb?: string; minVotes?: string; fromYear?: string; toYear?: string },
): TmdbMedia[] {
  let result = items;
  if (opts.hideAvailable) {
    // Gate on the user's own server visibility: a Plex-pinned user must not have
    // Jellyfin-only titles hidden (and vice versa).
    result = result.filter((m) => !((opts.showPlex && m.plexAvailable) || (opts.showJellyfin && m.jellyfinAvailable)));
  }
  if (opts.minImdb) {
    const threshold = parseFloat(opts.minImdb);
    if (!isNaN(threshold)) {
      result = result.filter((m) => {
        const r = parseFloat(m.imdbRating ?? "");
        return !isNaN(r) && r >= threshold;
      });
    }
  }
  if (opts.minVotes) {
    const threshold = parseInt(opts.minVotes, 10);
    if (!isNaN(threshold)) {
      // Unknown voteCount passes — non-TMDB sources (Trakt/MDBList) carry no vote counts; only a known count is filterable (cf. content-rating.ts exceedsCap).
      result = result.filter((m) => typeof m.voteCount !== "number" || m.voteCount >= threshold);
    }
  }
  if (opts.fromYear) {
    result = result.filter((m) => (m.releaseYear ?? "") >= opts.fromYear!);
  }
  if (opts.toYear) {
    result = result.filter((m) => (m.releaseYear ?? "") <= opts.toYear!);
  }
  return result;
}

export const GET = withAuth(async (request, _ctx, session) => {
  if (!(await isFeatureEnabled("feature.page.top"))) {
    return NextResponse.json({ error: "Top Rated is disabled" }, { status: 403 });
  }
  if (!checkRateLimit(`top-rated:${session.user.id}`, 30, 60_000)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const sp = request.nextUrl.searchParams;
  const hideAvailable = sp.get("hideAvailable") === "1";
  const mediaType = sp.get("mediaType") || undefined; // "movies" | "tv" | undefined
  const minImdb = sp.get("minImdb") || undefined;
  const minVotes = sp.get("minVotes") || undefined;
  // releaseYear is a 4-digit string compared lexicographically; only accept a
  // 4-digit year so a junk value can't filter unexpectedly (an arbitrary string
  // sorts in undefined positions against year strings). An invalid value is
  // treated as "not set".
  const isYear = (v: string | null): v is string => v != null && /^\d{4}$/.test(v);
  const fromYear = isYear(sp.get("fromYear")) ? sp.get("fromYear")! : undefined;
  const toYear = isYear(sp.get("toYear")) ? sp.get("toYear")! : undefined;
  const validSorts = new Set<SortBy>(["imdb", "letterboxd", "rt", "trakt", "mdblist"]);
  const sortParam = sp.get("sortBy");
  const sortBy: SortBy = validSorts.has(sortParam as SortBy) ? (sortParam as SortBy) : "imdb";
  const page = Math.min(Math.max(1, parseInt(sp.get("page") ?? "1", 10) || 1), 10_000);
  const show4k = await getShow4kVisibility(session);

  const { showPlex, showJellyfin } = getBadgeVisibility(session);
  const filterOpts = { hideAvailable, showPlex, showJellyfin, minImdb, minVotes, fromYear, toYear };

  try {
    // A single down source degrades to an empty contribution rather than failing
    // the whole page. Log each failure so a silently-missing source is diagnosable.
    const fromSource = <T>(name: string, p: Promise<T[]>): Promise<T[]> =>
      p.catch((err) => {
        console.error(`[top-rated] source ${name} failed:`, err instanceof Error ? err.message : err);
        return [] as T[];
      });

    const [
      rawTmdbMovies, rawTmdbTV,
      rawTraktMovies, rawTraktTV,
      rawMdbMovies, rawMdbTV,
    ] = await Promise.all([
      mediaType === "tv" ? [] : fromSource("tmdb-movies", getTopRatedMovies()),
      mediaType === "movies" ? [] : fromSource("tmdb-tv", getTopRatedTV()),
      mediaType === "tv" ? [] : fromSource("trakt-movies", getTraktPopularMovies()),
      mediaType === "movies" ? [] : fromSource("trakt-tv", getTraktPopularTV()),
      mediaType === "tv" ? [] : fromSource("mdblist-movies", getMdblistTopRated("movie")),
      mediaType === "movies" ? [] : fromSource("mdblist-tv", getMdblistTopRated("tv")),
    ]);

    const allMovies = dedup([rawTmdbMovies, rawTraktMovies, rawMdbMovies]);
    const allTV = dedup([rawTmdbTV, rawTraktTV, rawMdbTV]);

    const showMovies = mediaType !== "tv";
    const showTV = mediaType !== "movies";

    // applyFilters (minImdb / hideAvailable) and the rating sort read fields that
    // only exist AFTER attachAllAvailability. When any filter or a non-default sort
    // is active, enrich + filter + sort the WHOLE pool before paginating, so pages
    // aren't short and the totals aren't the unfiltered pool size. Otherwise keep
    // the cheap path that enriches only the visible slice — the default view is
    // already rating-ordered by source, so per-slice work is correct and far
    // cheaper than enriching hundreds of pooled titles per request.
    const filtersActive = hideAvailable || !!minImdb || !!minVotes || !!fromYear || !!toYear || sortBy !== "imdb";
    const offset = (page - 1) * PER_PAGE;

    let movies: TmdbMedia[];
    let tv: TmdbMedia[];
    let totalMovies: number;
    let totalTv: number;

    if (filtersActive) {
      const [enrichedMovies, enrichedTV] = await Promise.all([
        showMovies && allMovies.length > 0
          ? backfillMetadata(allMovies).then((m) => attachAllAvailability(m, session.user.id, { show4k }))
          : Promise.resolve([] as TmdbMedia[]),
        showTV && allTV.length > 0
          ? backfillMetadata(allTV).then((t) => attachAllAvailability(t, session.user.id, { show4k }))
          : Promise.resolve([] as TmdbMedia[]),
      ]);
      const filteredMovies = sortByRating(applyFilters(enrichedMovies, filterOpts), sortBy);
      const filteredTV = sortByRating(applyFilters(enrichedTV, filterOpts), sortBy);
      totalMovies = filteredMovies.length;
      totalTv = filteredTV.length;
      movies = filteredMovies.slice(offset, offset + PER_PAGE);
      tv = filteredTV.slice(offset, offset + PER_PAGE);
    } else {
      let moviePage = allMovies.slice(offset, offset + PER_PAGE);
      let tvPage = allTV.slice(offset, offset + PER_PAGE);
      [moviePage, tvPage] = await Promise.all([
        backfillMetadata(moviePage),
        backfillMetadata(tvPage),
      ]);
      [movies, tv] = await Promise.all([
        showMovies && moviePage.length > 0
          ? attachAllAvailability(moviePage, session.user.id, { show4k })
          : Promise.resolve([] as TmdbMedia[]),
        showTV && tvPage.length > 0
          ? attachAllAvailability(tvPage, session.user.id, { show4k })
          : Promise.resolve([] as TmdbMedia[]),
      ]);
      movies = sortByRating(movies, sortBy);
      tv = sortByRating(tv, sortBy);
      totalMovies = allMovies.length;
      totalTv = allTV.length;
    }

    const totalPages = Math.max(
      1,
      Math.ceil(totalMovies / PER_PAGE),
      Math.ceil(totalTv / PER_PAGE),
    );

    return NextResponse.json({
      movies,
      tv,
      totalMovies,
      totalTv,
      totalPages,
      page,
      sortBy,
    });
  } catch (err) {
    console.error("[top-rated] Failed:", err);
    return NextResponse.json({ error: "Failed to fetch" }, { status: 500 });
  }
});
