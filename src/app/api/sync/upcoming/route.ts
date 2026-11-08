import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUpcomingMoviesForRefresh, getUpcomingTVForRefresh } from "@/lib/tmdb";
import type { TmdbMedia } from "@/lib/tmdb-types";
import { CRON_SYSTEM_ACTOR, isCronAuthorized } from "@/lib/cron-auth";
import { CRON_DEGRADED_HEADER, cronSkippedResponse, withCronRunRecording } from "@/lib/cron-history";
import { BATCH_TX_TIMEOUT, batchCreateMany } from "@/lib/batch-write";
import { logAudit } from "@/lib/audit";
import { withAdvisoryLock, UPCOMING_CACHE_LOCK_ID } from "@/lib/advisory-lock";
import { warmCalendarCache, type CalendarWarmResult } from "@/lib/calendar-feed";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import type { Translator } from "@/lib/i18n/translate";

export async function POST(request: NextRequest) {
  const t = translatorForRequest(request);
  if (!(await isCronAuthorized(request))) {
    return NextResponse.json({ error: t("apiAdmin.common.forbidden") }, { status: 403 });
  }

  return withCronRunRecording("upcoming-cache", () => withAdvisoryLock(
    UPCOMING_CACHE_LOCK_ID,
    (signal: AbortSignal) => refreshUpcoming(t, signal),
    // A busy lock is not a run: X-Cron-Skipped keeps it out of the ledger.
    () => cronSkippedResponse(),
  ));
}

async function refreshUpcoming(t: Translator, signal: AbortSignal): Promise<NextResponse> {
  const startTime = Date.now();

  // The *ForRefresh helpers REJECT when any TMDB page failed. The page
  // helpers absorb a failed page and return what answered, so during an
  // outage they resolved [] — read below as "nothing upcoming", which
  // deleted both media types and recorded a green run. A rejected type keeps
  // its stored rows and the run reports it degraded (or 502 if nothing was
  // written).
  const [movies, tv] = await Promise.allSettled([getUpcomingMoviesForRefresh(), getUpcomingTVForRefresh()]);
  if (movies.status === "rejected") console.error("[sync/upcoming] Movie fetch failed:", movies.reason);
  if (tv.status === "rejected") console.error("[sync/upcoming] TV fetch failed:", tv.reason);
  const movieItems = movies.status === "fulfilled" ? movies.value : null;
  const tvItems = tv.status === "fulfilled" ? tv.value : null;
  const total = await replaceUpcomingCache(movieItems, tvItems);

  // Fill the release-date caches the personal iCal feeds read
  // (calendar-feed.ts). Bounded and signal-aware (guardrails 31/41); a
  // failure here never fails the upcoming-list refresh it rides along with.
  let calendar: CalendarWarmResult | null = null;
  try {
    calendar = await warmCalendarCache({ signal });
  } catch (err) {
    console.error("[sync/upcoming] calendar warm failed:", err instanceof Error ? err.message : err);
  }

  const durationMs = Date.now() - startTime;
  const failedSources = [
    ...(movieItems === null ? ["movies"] : []),
    ...(tvItems === null ? ["tv"] : []),
  ];
  const errors = failedSources.length;

  await logAudit({
    userId: CRON_SYSTEM_ACTOR.userId,
    userName: CRON_SYSTEM_ACTOR.userName,
    action: "LIBRARY_SYNC",
    target: "upcoming-cache",
    details: { movies: movieItems?.length ?? 0, tv: tvItems?.length ?? 0, total, errors, durationMs },
  }).catch(() => {});

  // A fetch failed and nothing was cached → 502 so the cron dashboard doesn't
  // show green on a total failure. A partial failure (one source) that still
  // wrote rows stays 200 — but DEGRADED, the orchestrator's shape: the
  // X-Cron-Degraded header is what withCronRunRecording reads to mark the
  // ledger row ok:false, and `error` is what the Run-now button's verdict
  // reads. Without both, a TV endpoint failing every run recorded a green
  // run while /upcoming served its last good TV rows indefinitely.
  const failed = errors > 0 && total === 0;
  const degraded = !failed && errors > 0;
  return NextResponse.json({
    movies: movieItems?.length ?? 0,
    tv: tvItems?.length ?? 0,
    total,
    errors,
    durationMs,
    calendar,
    ...(degraded ? { error: t("apiAdmin.sync.degraded", { sources: failedSources.join(", ") }) } : {}),
  }, failed
    ? { status: 502 }
    : degraded
      ? { headers: { [CRON_DEGRADED_HEADER]: failedSources.join(",") } }
      : {});
}

// One UpcomingCacheItem row. Pure.
function upcomingRow(item: TmdbMedia, mediaType: "MOVIE" | "TV", cachedAt: Date) {
  return {
    tmdbId: item.id,
    mediaType,
    title: item.title,
    overview: item.overview,
    posterPath: item.posterPath,
    backdropPath: item.backdropPath,
    releaseDate: item.releaseDate,
    releaseYear: item.releaseYear ?? "",
    voteAverage: item.voteAverage,
    cachedAt,
  };
}

// Per-type replace: only a media type whose fetch SUCCEEDED (non-null) is
// deleted and repopulated. A blanket deleteMany() would wipe the sibling type
// when only one source failed. Concurrency is already serialized by the
// caller's UPCOMING_CACHE_LOCK_ID; the transaction gives atomicity. Returns the
// rows written.
//
// A fulfilled-but-EMPTY fetch (every TMDB page answered, nothing listed)
// intentionally clears that type: for the upcoming list an empty TMDB result is
// a valid "nothing upcoming" state, and the cache re-warms on the next run. A
// TMDB failure is never fulfilled (above). This deliberately differs from the
// library sync's anti-wipe guard (guardrails 13/28), where 0 rows usually means
// a degraded fetch, not an empty library.
async function replaceUpcomingCache(movies: TmdbMedia[] | null, tv: TmdbMedia[] | null): Promise<number> {
  const cachedAt = new Date();
  const movieRows = (movies ?? []).map((m) => upcomingRow(m, "MOVIE", cachedAt));
  const tvRows = (tv ?? []).map((s) => upcomingRow(s, "TV", cachedAt));
  await prisma.$transaction(async (tx) => {
    if (movies !== null) {
      await tx.upcomingCacheItem.deleteMany({ where: { mediaType: "MOVIE" } });
      if (movieRows.length > 0) await batchCreateMany(tx.upcomingCacheItem, movieRows);
    }
    if (tv !== null) {
      await tx.upcomingCacheItem.deleteMany({ where: { mediaType: "TV" } });
      if (tvRows.length > 0) await batchCreateMany(tx.upcomingCacheItem, tvRows);
    }
  }, { timeout: BATCH_TX_TIMEOUT });
  return movieRows.length + tvRows.length;
}
