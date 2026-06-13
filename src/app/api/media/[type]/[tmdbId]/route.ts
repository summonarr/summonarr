import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import {
  getMovieDetails,
  getTVDetails,
  getMovieCredits,
  getTVCredits,
} from "@/lib/tmdb";
import { attachAllAvailability } from "@/lib/attach-all";
import { getShow4kVisibility } from "@/lib/four-k-visibility";

// Full single-title detail for native clients. The web app builds this in a
// server component (src/app/(app)/{movie,tv}/[id]); this mirrors it as REST:
// rich TMDB details (genres, runtime, seasons, ratings, trailer) + top cast +
// per-viewer availability/request/4K flags.
export const GET = withAuth(async (
  _req,
  { params }: { params: Promise<{ type: string; tmdbId: string }> },
  session,
) => {
  const { type, tmdbId: rawId } = await params;
  const tmdbId = parseInt(rawId, 10);

  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    return NextResponse.json({ error: "tmdbId must be a positive integer" }, { status: 400 });
  }
  if (type !== "movie" && type !== "tv") {
    return NextResponse.json({ error: "type must be movie or tv" }, { status: 400 });
  }

  const show4k = await getShow4kVisibility(session);

  try {
    const [detail, cast] = await Promise.all([
      type === "movie" ? getMovieDetails(tmdbId) : getTVDetails(tmdbId),
      type === "movie" ? getMovieCredits(tmdbId) : getTVCredits(tmdbId),
    ]);
    const [withAvailability] = await attachAllAvailability([detail], session.user.id, { show4k });
    return NextResponse.json({ ...withAvailability, cast });
  } catch (err) {
    console.error("[media] detail fetch failed:", err);
    return NextResponse.json({ error: "Could not load this title" }, { status: 502 });
  }
});
