import { prisma } from "@/lib/prisma";
import { verifyTmdbMedia } from "@/lib/tmdb";

// Resolves title/poster/releaseYear for a request row. Prefers the pre-warmed
// TmdbMediaCore table, falls back to the TmdbCache details blob, then a live
// TMDB verification. Shared by POST /api/requests and POST /api/requests/bulk.
export async function resolveMediaMeta(
  tmdbId: number,
  mediaType: "MOVIE" | "TV",
): Promise<{ title: string; posterPath: string | null; releaseYear: string } | null> {
  const core = await prisma.tmdbMediaCore
    .findUnique({
      where: { tmdbId_mediaType: { tmdbId, mediaType } },
      select: { title: true, posterPath: true, releaseYear: true },
    })
    .catch(() => null);
  if (core?.title) {
    return { title: core.title, posterPath: core.posterPath ?? null, releaseYear: core.releaseYear ?? "" };
  }

  const cacheKey = `${mediaType === "MOVIE" ? "movie" : "tv"}:${tmdbId}:details`;
  const cacheRow = await prisma.tmdbCache
    .findUnique({ where: { key: cacheKey }, select: { data: true, expiresAt: true } })
    .catch(() => null);
  if (cacheRow && new Date() < cacheRow.expiresAt) {
    try {
      const parsed = JSON.parse(cacheRow.data) as {
        title?: string;
        posterPath?: string | null;
        releaseYear?: string;
      };
      if (parsed.title) {
        return { title: parsed.title, posterPath: parsed.posterPath ?? null, releaseYear: parsed.releaseYear ?? "" };
      }
    } catch {}
  }

  return verifyTmdbMedia(tmdbId, mediaType === "MOVIE" ? "movie" : "tv");
}
