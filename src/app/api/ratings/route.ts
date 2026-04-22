import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { getMdblistRatingsForTmdb } from "@/lib/mdblist";
import { getOmdbRatingsForTmdb } from "@/lib/omdb";
import { checkRateLimit } from "@/lib/rate-limit";

export async function GET(req: NextRequest) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  if (!checkRateLimit(`ratings:${session.user.id}`, 60, 60_000)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
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
}
