import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { generateRequestToken } from "@/lib/request-token";

export const GET = withAuth(async (req, _ctx, session) => {
  const tmdbId = parseInt(req.nextUrl.searchParams.get("tmdbId") ?? "", 10);
  const mediaType = req.nextUrl.searchParams.get("mediaType");

  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    return NextResponse.json({ error: "tmdbId must be a positive integer" }, { status: 400 });
  }
  if (mediaType !== "MOVIE" && mediaType !== "TV") {
    return NextResponse.json({ error: "mediaType must be MOVIE or TV" }, { status: 400 });
  }

  const token = generateRequestToken(tmdbId, mediaType, session.user.id);
  return NextResponse.json({ token });
});
