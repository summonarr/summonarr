import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { getMdblistRatingsForTmdb } from "@/lib/mdblist";
import { getOmdbRatingsForTmdb } from "@/lib/omdb";
import { checkRateLimit } from "@/lib/rate-limit";
import { tooManyRequests } from "@/lib/http";

// GET /api/ratings?id=&type= — external ratings for a single title; tries
// mdblist first, falls back to OMDB only when no mdblist key is configured.
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

  const mdbResult = await getMdblistRatingsForTmdb(numericId, type);
  if (mdbResult.found) return NextResponse.json(mdbResult.data);

  if (!mdbResult.keyConfigured) {
    const omdbResult = await getOmdbRatingsForTmdb(numericId, type);
    if (omdbResult.found) return NextResponse.json(omdbResult.data);
  }

  return NextResponse.json(null);
});
