import { NextRequest, NextResponse } from "next/server";
import { auth, isTokenExpired } from "@/lib/auth";
import { generateRequestToken } from "@/lib/request-token";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session || isTokenExpired(session)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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
}
