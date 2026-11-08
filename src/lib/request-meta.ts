import { prisma } from "@/lib/prisma";
import { verifyTmdbMedia } from "@/lib/tmdb";
import { tmdbDetailsKey } from "@/lib/tmdb-cache";
import { check, v } from "@/lib/validate";

export type RequestMediaMeta = { title: string; posterPath: string | null; releaseYear: string };

// The fields read from a cached TMDB details blob. Anything else (a not-found
// stub, a blob from an older shape) fails the check and falls through to the
// live verification, never into a MediaRequest row.
const CachedDetails = v.object({
  title: v.string(),
  posterPath: v.optional(v.nullable(v.string())),
  releaseYear: v.optional(v.string()),
});

/** The meta stored in a cached details blob, or null when it is unusable. */
export function metaFromCachedDetails(data: string): RequestMediaMeta | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  const parsed = check(CachedDetails, raw);
  if (!parsed.ok || !parsed.value.title) return null;
  return { title: parsed.value.title, posterPath: parsed.value.posterPath ?? null, releaseYear: parsed.value.releaseYear ?? "" };
}

// A failed cache read is not fatal (the live verification answers instead),
// but it should not be silent either.
function logReadFailure(what: string) {
  return (err: unknown): null => {
    console.warn(`[request-meta] ${what} read failed, falling back:`, err instanceof Error ? err.message : err);
    return null;
  };
}

// Resolves title/poster/releaseYear for a request row. Prefers the pre-warmed
// TmdbMediaCore table, falls back to the TmdbCache details blob, then a live
// TMDB verification. Shared by POST /api/requests and POST /api/requests/bulk.
export async function resolveMediaMeta(
  tmdbId: number,
  mediaType: "MOVIE" | "TV",
): Promise<RequestMediaMeta | null> {
  const core = await prisma.tmdbMediaCore
    .findUnique({
      where: { tmdbId_mediaType: { tmdbId, mediaType } },
      select: { title: true, posterPath: true, releaseYear: true },
    })
    .catch(logReadFailure("TmdbMediaCore"));
  if (core?.title) {
    return { title: core.title, posterPath: core.posterPath ?? null, releaseYear: core.releaseYear ?? "" };
  }

  const cacheRow = await prisma.tmdbCache
    .findUnique({ where: { key: tmdbDetailsKey(mediaType, tmdbId) }, select: { data: true, expiresAt: true } })
    .catch(logReadFailure("TmdbCache"));
  if (cacheRow && new Date() < cacheRow.expiresAt) {
    const meta = metaFromCachedDetails(cacheRow.data);
    if (meta) return meta;
  }

  return verifyTmdbMedia(tmdbId, mediaType === "MOVIE" ? "movie" : "tv");
}
