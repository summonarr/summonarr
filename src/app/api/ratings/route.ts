import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
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

  const result = await fetchUnifiedRatings(numericId, type);
  if (result.found && result.data) return NextResponse.json(result.data);

  return NextResponse.json(null);
});
