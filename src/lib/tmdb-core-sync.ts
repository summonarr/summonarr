import { prisma } from "./prisma";
import { libraryDetailsTtl } from "./tmdb-cache";
import type { TmdbMedia } from "./tmdb-types";

const LIST_TTL_MS = 12 * 3600 * 1000;

// Items are sorted before the batch upsert to prevent deadlocks on concurrent transactions
// that write overlapping sets in different orders.
export async function syncTmdbMediaCore(items: TmdbMedia[]): Promise<void> {
  if (!items.length) return;
  const expiresAt = new Date(Date.now() + LIST_TTL_MS);

  const sorted = [...items].sort(
    (a, b) => a.id - b.id || a.mediaType.localeCompare(b.mediaType)
  );
  await prisma.$transaction(
    sorted.map((m) =>
      prisma.tmdbMediaCore.upsert({
        where: {
          tmdbId_mediaType: {
            tmdbId: m.id,
            mediaType: m.mediaType === "movie" ? "MOVIE" : "TV",
          },
        },
        create: {
          tmdbId:        m.id,
          mediaType:     m.mediaType === "movie" ? "MOVIE" : "TV",
          title:         m.title,
          posterPath:    m.posterPath    ?? null,
          releaseYear:   m.releaseYear   || null,
          voteAverage:   m.voteAverage   ?? 0,
          certification: m.certification ?? null,
          expiresAt,
        },
        update: {
          title:         m.title,
          posterPath:    m.posterPath    ?? null,
          releaseYear:   m.releaseYear   || null,
          voteAverage:   m.voteAverage   ?? 0,
          certification: m.certification ?? null,
          expiresAt,
          lastSyncedAt:  new Date(),
        },
      })
    )
  ).catch((err) => {
    console.error("[tmdb-core-sync] batch upsert failed for", items.length, "items:", err);
    throw err;
  });
}

// Single-item upsert used after fetching a full detail page; uses age-aware TTL rather than the
// fixed list TTL so library items aren't re-fetched sooner than they need to be.
export async function upsertTmdbMediaCore(media: TmdbMedia): Promise<void> {
  const expiresAt = new Date(
    Date.now() + libraryDetailsTtl(media.releaseDate) * 1000
  );
  await prisma.tmdbMediaCore.upsert({
    where: {
      tmdbId_mediaType: {
        tmdbId:    media.id,
        mediaType: media.mediaType === "movie" ? "MOVIE" : "TV",
      },
    },
    create: {
      tmdbId:        media.id,
      mediaType:     media.mediaType === "movie" ? "MOVIE" : "TV",
      title:         media.title,
      posterPath:    media.posterPath    ?? null,
      releaseYear:   media.releaseYear   || null,
      voteAverage:   media.voteAverage   ?? 0,
      certification: media.certification ?? null,
      expiresAt,
    },
    update: {
      title:         media.title,
      posterPath:    media.posterPath    ?? null,
      releaseYear:   media.releaseYear   || null,
      voteAverage:   media.voteAverage   ?? 0,
      certification: media.certification ?? null,
      expiresAt,
      lastSyncedAt:  new Date(),
    },
  }).catch((err) => {
    console.error("[tmdb-core-sync] single upsert failed for tmdbId", media.id, ":", err);
    throw err;
  });
}
