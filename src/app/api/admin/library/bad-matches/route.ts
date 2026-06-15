import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { getBadMatches } from "@/lib/bad-matches";

// Native-client bad-match list for the admin Library screen. Mirrors the
// server-rendered list in src/app/(app)/admin/library/page.tsx. Apply a fix via
// the existing POST /api/admin/fix-match.
export const GET = withAdmin(async (request) => {
  const t = request.nextUrl.searchParams.get("mediaType");
  const activeType = t === "movie" ? "MOVIE" : t === "tv" ? "TV" : undefined;
  try {
    const badMatches = await getBadMatches(activeType);
    return NextResponse.json({ badMatches });
  } catch (err) {
    console.error("[library/bad-matches] Failed:", err);
    return NextResponse.json({ error: "Failed to compute bad matches" }, { status: 500 });
  }
});
