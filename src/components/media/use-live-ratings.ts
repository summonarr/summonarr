"use client";

import { useEffect, useState } from "react";
import type { TmdbMedia } from "@/lib/tmdb-types";
import { requestRatings, type RatingsPayload } from "@/lib/client/ratings-batcher";

/**
 * Ratings for a title that arrived bare (trending / list items carry no
 * IMDb or Rotten Tomatoes fields): fetched once through the shared batcher and
 * merged at render with mergeRatings. Null until they land, and for a title
 * that already carries them. A newer title's answer always wins: an older
 * one's is dropped.
 */
export function useLiveRatings(
  media: Pick<TmdbMedia, "id" | "mediaType" | "releaseDate" | "imdbRating" | "rottenTomatoes">,
): RatingsPayload | null {
  const [live, setLive] = useState<{ id: number; data: RatingsPayload } | null>(null);
  const { id, mediaType, releaseDate, imdbRating, rottenTomatoes } = media;
  useEffect(() => {
    if (imdbRating !== undefined || rottenTomatoes !== undefined) return;
    let cancelled = false;
    void requestRatings(id, mediaType, releaseDate ?? null).then((data) => {
      if (!cancelled && data) setLive({ id, data });
    });
    return () => {
      cancelled = true;
    };
  }, [id, mediaType, releaseDate, imdbRating, rottenTomatoes]);
  // Scoped to the title it was fetched for, so a reused instance never shows
  // the previous title's ratings while the new ones load.
  return live && live.id === id ? live.data : null;
}
