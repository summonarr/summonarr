import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { isMdblistQuotaLocked } from "@/lib/mdblist";
import { isOmdbQuotaLocked } from "@/lib/omdb";
import { fetchUnifiedRatings, type UnifiedRatingsResult } from "@/lib/omdb-availability";
import type { TmdbMedia } from "@/lib/tmdb-types";

// Ratings-pipeline counterpart to /api/admin/debug/arr-state: dumps provider
// configuration, in-process quota lockouts, the raw ratings cache rows
// (mdblist/omdb per-title keys), and the rating-relevant slice of the details
// cache. Read-only unless ?live=1, which runs a real fetchUnifiedRatings call
// (provider requests + cache writes via the existing helpers).

type RatingsCacheReport = {
  key: string;
  exists: boolean;
  cachedAt: string | null;
  expiresAt: string | null;
  stale: boolean;
  notFoundSentinel: boolean;
  data: unknown;
};

// Describe a raw TmdbCache row without the getCache semantics: getCache lazily
// deletes expired rows and hides stale/sentinel state — exactly the state this
// diagnostic exists to expose — so we read the row directly and never mutate.
function describeRatingsRow(
  key: string,
  row: { data: string; cachedAt: Date; expiresAt: Date } | null,
  now: Date,
): RatingsCacheReport {
  if (!row) {
    return { key, exists: false, cachedAt: null, expiresAt: null, stale: false, notFoundSentinel: false, data: null };
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(row.data);
  } catch {
    parsed = null; // unparseable rows read as data:null — same miss semantics as the tmdb-cache readers
  }
  const notFoundSentinel = typeof parsed === "object" && parsed !== null && "_notFound" in parsed;
  return {
    key,
    exists: true,
    cachedAt: row.cachedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    stale: row.expiresAt < now,
    notFoundSentinel,
    // Ratings payloads are public review-aggregate data — safe to echo. The
    // sentinel is reported via the flag instead of dumping `{_notFound:true}`.
    data: notFoundSentinel ? null : parsed,
  };
}

export const GET = withAdmin(async (req, _ctx, _session) => {
  const sp = req.nextUrl.searchParams;
  const tmdbIdRaw = sp.get("tmdbId");
  const type = sp.get("type");
  if (!tmdbIdRaw || (type !== "movie" && type !== "tv")) {
    return NextResponse.json({ error: "tmdbId and type=movie|tv required" }, { status: 400 });
  }
  const tmdbId = Number(tmdbIdRaw);
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    return NextResponse.json({ error: "tmdbId must be a positive integer" }, { status: 400 });
  }
  const liveRequested = sp.get("live") === "1";

  const now = new Date();
  const mdblistCacheKey = `mdblist:tmdb:${type}:${tmdbId}`;
  const omdbCacheKey = `omdb:tmdb:${type}:${tmdbId}`;
  const detailsCacheKey = `${type}:${tmdbId}:details`;

  const [mdblistKeyRow, omdbKeyRow, traktIdRow, mdblistCacheRow, omdbCacheRow, detailsCacheRow] = await Promise.all([
    // The Prisma extension decrypts Setting.value on read; only truthiness is
    // tested here — the decrypted key value must never reach the response.
    prisma.setting.findUnique({ where: { key: "mdblistApiKey" } }),
    prisma.setting.findUnique({ where: { key: "omdbApiKey" } }),
    prisma.setting.findUnique({ where: { key: "traktClientId" } }),
    prisma.tmdbCache.findUnique({ where: { key: mdblistCacheKey } }),
    prisma.tmdbCache.findUnique({ where: { key: omdbCacheKey } }),
    prisma.tmdbCache.findUnique({ where: { key: detailsCacheKey } }),
  ]);

  // Rating-relevant subset of the cached details blob. Undefined fields are
  // dropped by JSON serialisation, which is itself diagnostic: absent = ratings
  // were never fetched into this row; null = an authoritative "no rating".
  let detailsParsed: Partial<TmdbMedia> | null = null;
  if (detailsCacheRow) {
    try {
      const parsed: unknown = JSON.parse(detailsCacheRow.data);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        detailsParsed = parsed as Partial<TmdbMedia>;
      }
    } catch {
      detailsParsed = null;
    }
  }
  const detailsFields = detailsParsed
    ? {
        imdbId: detailsParsed.imdbId,
        imdbRating: detailsParsed.imdbRating,
        imdbVotes: detailsParsed.imdbVotes,
        rottenTomatoes: detailsParsed.rottenTomatoes,
        rtAudienceScore: detailsParsed.rtAudienceScore,
        metacritic: detailsParsed.metacritic,
        traktRating: detailsParsed.traktRating,
        letterboxdRating: detailsParsed.letterboxdRating,
        mdblistScore: detailsParsed.mdblistScore,
        malRating: detailsParsed.malRating,
        rogerEbertRating: detailsParsed.rogerEbertRating,
        releasedDigital: detailsParsed.releasedDigital,
        certification: detailsParsed.certification,
        releaseDate: detailsParsed.releaseDate,
      }
    : null;

  // Live provider check (opt-in): the real single-item pipeline — MDBList first,
  // OMDB fallback — including its normal cache writes. Everything above is read-only.
  let live: UnifiedRatingsResult | { error: string } | undefined;
  if (liveRequested) {
    try {
      const releaseDate = typeof detailsParsed?.releaseDate === "string" ? detailsParsed.releaseDate : undefined;
      live = await fetchUnifiedRatings(tmdbId, type, releaseDate);
    } catch (err) {
      // Don't leak raw provider error detail to the client — log server-side,
      // return a generic flag (mirrors arr-state's live-check handling).
      console.error("[ratings-state] live unified ratings fetch failed:", err instanceof Error ? err.message : err);
      live = { error: "live ratings fetch failed" };
    }
  }

  return NextResponse.json({
    query: { tmdbId, type, live: liveRequested },
    now: now.toISOString(),
    providers: {
      mdblist: !!mdblistKeyRow?.value.trim(),
      omdb: !!omdbKeyRow?.value.trim(),
      trakt: !!traktIdRow?.value.trim(),
    },
    lockouts: {
      mdblistQuotaLocked: isMdblistQuotaLocked(),
      omdbQuotaLocked: isOmdbQuotaLocked(),
    },
    cache: {
      mdblist: describeRatingsRow(mdblistCacheKey, mdblistCacheRow, now),
      omdb: describeRatingsRow(omdbCacheKey, omdbCacheRow, now),
    },
    details: {
      key: detailsCacheKey,
      exists: !!detailsCacheRow,
      cachedAt: detailsCacheRow ? detailsCacheRow.cachedAt.toISOString() : null,
      expiresAt: detailsCacheRow ? detailsCacheRow.expiresAt.toISOString() : null,
      stale: detailsCacheRow ? detailsCacheRow.expiresAt < now : false,
      fields: detailsFields,
    },
    ...(live !== undefined ? { live } : {}),
  });
});
