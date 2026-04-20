import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { auth, isTokenExpired } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { withAdvisoryLock } from "@/lib/advisory-lock";
import {
  getTrending, getPopularMovies, getPopularTV,
  getUpcomingMovies, getUpcomingTV,
  getTopRatedMovies, getTopRatedTV,
  getPopularMoviesPage, getPopularTVPage,
  getMovieGenres, getTVGenres, getWatchProviders,
} from "@/lib/tmdb";
import { getTraktPopularMovies, getTraktPopularTV, getTraktTrendingMovies, getTraktTrendingTV } from "@/lib/trakt";
import { getMdblistTopRated } from "@/lib/mdblist";

function safeCompareStrings(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

async function getAuthContext(request: NextRequest): Promise<{ userId: string; userName: string; trigger: "admin" | "cron" } | null> {
  const session = await auth();
  if (session?.user?.role === "ADMIN" && !isTokenExpired(session)) {
    return { userId: session.user.id, userName: session.user.name ?? "admin", trigger: "admin" };
  }

  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get("authorization") ?? "";
    if (authHeader.startsWith("Bearer ") && safeCompareStrings(authHeader.slice(7), cronSecret)) {
      return { userId: "system", userName: "cron", trigger: "cron" };
    }
  }

  return null;
}

async function warm<T>(fn: () => Promise<T[]>): Promise<number> {
  try {
    const result = await fn();
    return result.length;
  } catch {
    return 0;
  }
}

export async function POST(request: NextRequest) {
  const authCtx = await getAuthContext(request);
  if (!authCtx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return withAdvisoryLock(
    2006,
    async () => {
      const startTime = Date.now();

    const [
      trending, popMovies, popTV, upMovies, upTV,
      topMovies, topTV,
      popMoviesP1, popTVP1,
      movieGenres, tvGenres, providers,
      traktPopMovies, traktPopTV, traktTrendMovies, traktTrendTV,
      mdbMovies, mdbTV,
    ] = await Promise.allSettled([

      warm(getTrending),
      warm(getPopularMovies),
      warm(getPopularTV),
      warm(getUpcomingMovies),
      warm(getUpcomingTV),
      warm(getTopRatedMovies),
      warm(getTopRatedTV),

      warm(() => getPopularMoviesPage(1).then((r) => r.items)),
      warm(() => getPopularTVPage(1).then((r) => r.items)),

      warm(getMovieGenres),
      warm(getTVGenres),
      warm(() => getWatchProviders("movie")),

      warm(getTraktPopularMovies),
      warm(getTraktPopularTV),
      warm(getTraktTrendingMovies),
      warm(getTraktTrendingTV),

      warm(() => getMdblistTopRated("movie")),
      warm(() => getMdblistTopRated("tv")),
    ]);

    const extract = (r: PromiseSettledResult<number>) => r.status === "fulfilled" ? r.value : 0;

    const counts = {
      trending: extract(trending),
      popularMovies: extract(popMovies),
      popularTV: extract(popTV),
      upcomingMovies: extract(upMovies),
      upcomingTV: extract(upTV),
      topRatedMovies: extract(topMovies),
      topRatedTV: extract(topTV),
      popularMoviesPage1: extract(popMoviesP1),
      popularTVPage1: extract(popTVP1),
      movieGenres: extract(movieGenres),
      tvGenres: extract(tvGenres),
      watchProviders: extract(providers),
      traktPopularMovies: extract(traktPopMovies),
      traktPopularTV: extract(traktPopTV),
      traktTrendingMovies: extract(traktTrendMovies),
      traktTrendingTV: extract(traktTrendTV),
      mdblistMovies: extract(mdbMovies),
      mdblistTV: extract(mdbTV),
    };

    const allResults = [
      trending, popMovies, popTV, upMovies, upTV,
      topMovies, topTV, popMoviesP1, popTVP1,
      movieGenres, tvGenres, providers,
      traktPopMovies, traktPopTV, traktTrendMovies, traktTrendTV,
      mdbMovies, mdbTV,
    ];
    const errorCount = allResults.filter((r) => r.status === "rejected").length;
    if (errorCount > 0) {
      console.error(`[warm-list-cache] ${errorCount} failures out of ${allResults.length} tasks`);
    }

    const durationMs = Date.now() - startTime;
    const totalItems = Object.values(counts).reduce((s, n) => s + n, 0);

    if (authCtx.trigger !== "cron") {
      await logAudit({
        userId: authCtx.userId,
        userName: authCtx.userName,
        action: "CACHE_WARM",
        target: "list-cache",
        details: { ...counts, totalItems, errors: errorCount, durationMs, trigger: authCtx.trigger },
      });
    }

      return NextResponse.json({
        ok: true,
        ...counts,
        totalItems,
        errors: errorCount,
        durationMs,
        timestamp: new Date().toISOString(),
      });
    },
    () => NextResponse.json({ skipped: true, reason: "already running" }),
  );
}
