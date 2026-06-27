import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { logAudit, auditContext } from "@/lib/audit";
import { checkRateLimit } from "@/lib/rate-limit";

// Cache "sources" map to TmdbCache key prefixes. TMDB details (movie:/tv:) is where the bulk of
// metadata lives — including the country/language/keyword/watch-provider fields — and previously had
// no clear button (only a warm one). MDBList and OMDB are the external ratings caches.
const SOURCE_PREFIXES: Record<string, string[]> = {
  tmdb: ["movie:", "tv:", "person:", "trending:", "discover:", "genres:", "watchproviders:"],
  mdblist: ["mdblist:"],
  omdb: ["omdb:"],
};

type Source = keyof typeof SOURCE_PREFIXES | "all";

function isSource(v: string): v is Source {
  return v === "all" || v in SOURCE_PREFIXES;
}

export const DELETE = withAdmin(async (req, _ctx, session) => {
  // Per-admin rate limit on this destructive TmdbCache wipe. Clearing the cache
  // forces every subsequent page load to re-fetch its metadata from upstream
  // (TMDB / MDBList / OMDB), so clearing it repeatedly in a tight loop turns into
  // a self-inflicted refetch storm that hammers those APIs and burns their rate
  // limits. Bounding it to 5 clears per 5-minute window per admin stops a
  // compromised admin session — or an accidental UI double-click — from looping
  // the wipe, while still allowing a handful of legitimate manual clears.
  if (!checkRateLimit(`admin-clear-cache:${session.user.id}`, 5, 5 * 60 * 1000)) {
    return NextResponse.json({ error: "Too many cache clears — try again shortly." }, { status: 429 });
  }
  const url = new URL(req.url);
  const sourceParam = url.searchParams.get("source") ?? "all";

  if (!isSource(sourceParam)) {
    return NextResponse.json(
      { error: `Unknown source "${sourceParam}". Expected one of: tmdb, mdblist, omdb, all` },
      { status: 400 },
    );
  }

  const prefixes =
    sourceParam === "all"
      ? Object.values(SOURCE_PREFIXES).flat()
      : SOURCE_PREFIXES[sourceParam];

  const { count } = await prisma.tmdbCache.deleteMany({
    where: { OR: prefixes.map((p) => ({ key: { startsWith: p } })) },
  });

  // Cache already cleared; a failed audit write must not 500 a successful clear.
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    // Reuse the existing cache-clear audit action; the cleared source is carried in details.
    action: "RATINGS_CACHE_CLEAR",
    target: "tmdbCache",
    details: { source: sourceParam, cleared: count },
    ...auditContext(req, session),
  });

  return NextResponse.json({ source: sourceParam, cleared: count });
});
