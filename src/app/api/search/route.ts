import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { searchMulti } from "@/lib/tmdb";
import { prisma } from "@/lib/prisma";
import { maintenanceGuard } from "@/lib/maintenance";
import { checkRateLimit } from "@/lib/rate-limit";

export async function GET(req: NextRequest) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  const maint = await maintenanceGuard(session.user.role);
  if (maint) return maint;

  if (!checkRateLimit(`search:${session.user.id}`, 30, 60 * 1000)) {
    return NextResponse.json({ error: "Too many searches — try again in a minute" }, { status: 429 });
  }

  const query = req.nextUrl.searchParams.get("q") ?? "";
  const type = req.nextUrl.searchParams.get("type");
  if (!query.trim()) return NextResponse.json([]);
  if (query.length > 200) return NextResponse.json({ error: "Query too long" }, { status: 400 });

  try {
    const allResults = await searchMulti(query);
    const results = type === "movie" || type === "tv"
      ? allResults.filter((r) => r.mediaType === type)
      : allResults;

    const where = {
      OR: results.map((r) => ({
        tmdbId: r.id,
        mediaType: r.mediaType === "movie" ? ("MOVIE" as const) : ("TV" as const),
      })),
    };

    const [plexRows, jfRows] = await Promise.all([
      prisma.plexLibraryItem.findMany({ where, select: { tmdbId: true, mediaType: true } }),
      prisma.jellyfinLibraryItem.findMany({ where, select: { tmdbId: true, mediaType: true } }),
    ]);

    const plexSet = new Set(plexRows.map((r) => `${r.tmdbId}:${r.mediaType}`));
    const jfSet   = new Set(jfRows.map((r)   => `${r.tmdbId}:${r.mediaType}`));

    return NextResponse.json(
      results.map((r) => {
        const key = `${r.id}:${r.mediaType === "movie" ? "MOVIE" : "TV"}`;
        return {
          ...r,
          plexAvailable:     plexSet.has(key),
          jellyfinAvailable: jfSet.has(key),
        };
      })
    );
  } catch (err) {
    console.error("TMDB search error:", err);
    return NextResponse.json({ error: "Search failed" }, { status: 500 });
  }
}
