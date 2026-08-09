import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { fetchUnifiedRatings } from "@/lib/omdb-availability";
import { checkRateLimit } from "@/lib/rate-limit";
import { tooManyRequests } from "@/lib/http";

// GET /api/ratings?id=&type= — external ratings for a single title. MDBList is
// tried first (richer field set); OMDB is the fallback whenever MDBList can't
// serve the item — no key configured, a genuine miss, or a quota lockout — the
// same policy as the batch path (attachRatingsUnified). The payload always
// follows the MdblistRatings shape; an OMDB hit fills the fields it lacks with
// null.
export const GET = withAuth(async (req, _ctx, session) => {
  if (!checkRateLimit(`ratings:${session.user.id}`, 60, 60_000)) {
    return tooManyRequests(60);
  }

  const { searchParams } = req.nextUrl;
  const id = searchParams.get("id");
  const type = searchParams.get("type");

  if (!id || !type || (type !== "movie" && type !== "tv")) {
    return NextResponse.json({ error: "Missing or invalid id/type" }, { status: 400 });
  }

  const numericId = Number(id);
  if (!Number.isFinite(numericId) || numericId <= 0 || !Number.isInteger(numericId)) {
    return NextResponse.json({ error: "id must be a positive integer" }, { status: 400 });
  }

  // TTL bucketing: fetchUnifiedRatings keys its ratings-cache TTLs off the
  // release date — passing none pinned every title this route warmed into the
  // 30-day back-catalog bucket, fresh releases included. The core row's
  // releaseYear (one cheap PK read) is precise enough for the age buckets.
  const core = await prisma.tmdbMediaCore
    .findUnique({
      where: { tmdbId_mediaType: { tmdbId: numericId, mediaType: type === "movie" ? "MOVIE" : "TV" } },
      select: { releaseYear: true },
    })
    .catch(() => null);
  const releaseDate = core?.releaseYear ? `${core.releaseYear}-01-01` : null;

  const result = await fetchUnifiedRatings(numericId, type, releaseDate);
  if (result.found && result.data) return NextResponse.json(result.data);

  return NextResponse.json(null);
});
