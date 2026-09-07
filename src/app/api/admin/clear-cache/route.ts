import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { logAudit, auditContext } from "@/lib/audit";
import { checkRateLimit } from "@/lib/rate-limit";

// Cache "sources" map to TmdbCache key prefixes — plus, below, the derived
// tables that hold denormalized copies of the same upstream data (TmdbMediaCore,
// and the recommendation graph's TitleSuggestion/RecommendationTitle). A clear
// that reached only TmdbCache left those serving exactly what it was pressed to
// remove. TMDB details (movie:/tv:) is where the bulk of
// metadata lives — including the country/language/keyword/watch-provider fields — and previously had
// no clear button (only a warm one). MDBList and OMDB are the external ratings caches.
// The tmdb list must name EVERY key namespace src/lib/tmdb.ts writes (a drift pin in
// tests/review-2026-09-p44.test.mts scans that file): `movies:` is a separate entry because
// `movie:` does not prefix-match `movies:popular` / `movies:upcoming` / `movies:top_rated` /
// `movies:popular:page:<p>` (the "s" precedes the colon), and `search:` / `collection:` were
// simply missing — search results and collection pages kept serving stale rows after a
// "cleared" TMDB cache.
const SOURCE_PREFIXES: Record<string, string[]> = {
  tmdb: [
    "movie:",
    "movies:",
    "tv:",
    "person:",
    "search:",
    "collection:",
    "trending:",
    "discover:",
    "genres:",
    "watchproviders:",
  ],
  mdblist: ["mdblist:"],
  omdb: ["omdb:"],
};

type Source = keyof typeof SOURCE_PREFIXES | "all";

function isSource(v: string): v is Source {
  // Own-property check, never `in`: `in` walks the prototype chain, so
  // ?source=toString / constructor / valueOf passed the guard and then blew up
  // on `prefixes.map` — a 500 where the 400 below is the intended answer.
  return v === "all" || Object.hasOwn(SOURCE_PREFIXES, v);
}

export const DELETE = withAdmin(async (req, _ctx, session) => {
  // Per-admin rate limit on this destructive TmdbCache wipe. Clearing forces every
  // page load to re-fetch from upstream (TMDB / MDBList / OMDB), so looping it is a
  // self-inflicted refetch storm that burns their rate limits. 5 per 5-min window
  // stops a compromised session (or a double-click) from looping the wipe.
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

  // ── Everything else derived from the cleared source ──────────────────────
  // A "clear" that only empties TmdbCache stopped being a reset: three other
  // tables hold DENORMALIZED COPIES of the same upstream data and are read
  // without ever consulting TmdbCache, so they kept serving the exact rows the
  // admin pressed this button to get rid of.
  const resetTmdb = sourceParam === "tmdb" || sourceParam === "all";
  const resetRatings = sourceParam === "mdblist" || sourceParam === "omdb" || sourceParam === "all";

  let coreCleared = 0;
  let edgesCleared = 0;
  let verdictsCleared = 0;

  if (resetTmdb) {
    // TmdbMediaCore is the normalized grid-metadata table (/top, /popular, the
    // admin library, request-meta, poster-cache). It is written as a
    // side-effect of the same fetches this clears and read INSTEAD of the JSON
    // blob, so leaving it behind meant every grid kept the stale title, poster,
    // year and rating after a "cleared" TMDB cache.
    coreCleared = (await prisma.tmdbMediaCore.deleteMany({})).count;

    // The recommendation graph's edges are copies of TMDB's suggestion lists
    // (title/overview/poster/backdrop ride on the edge row — readGraphSuggestions
    // never re-reads TmdbCache), and the node's suggestionsRefreshedAt stamp is
    // what decides whether they get rebuilt. Clearing one without the other is
    // not an option in either direction:
    //   - edges kept + cache cleared  => For You serves the old metadata for a
    //     full SOURCE_TTL_MS while every other page shows the new;
    //   - edges deleted + stamp kept  => readGraphSuggestions reports the source
    //     as COVERED WITH NO SUGGESTIONS, which is an authoritative answer
    //     (guardrail 40) — full coverage, so the run is conclusive and it
    //     REPLACES every shelf with a fallback one.
    // The second is much worse than doing nothing, which is why the unstamp and
    // the delete share a transaction and the unstamp goes first.
    await prisma.$transaction(async (tx) => {
      await tx.recommendationTitle.updateMany({
        data: { suggestionsRefreshedAt: null, suggestionCount: 0 },
      });
      edgesCleared = (await tx.titleSuggestion.deleteMany({})).count;
    });
  }

  if (resetRatings) {
    // Quality verdicts are derived from MDBList/OMDB, so a ratings clear has to
    // reach them too — otherwise re-fetched ratings would not affect a single
    // For You ranking until the verdict's own 7-day TTL rolled. Deliberately
    // NOT touched by source=tmdb: a verdict has no TMDB input (the graph rates
    // with voteAverage/voteCount zeroed and the TMDB term is re-blended per
    // candidate at read time — guardrail 40).
    verdictsCleared = (await prisma.recommendationTitle.updateMany({
      where: { qualityRatedAt: { not: null } },
      data: { quality: null, evidence: 0, qualityRatedAt: null },
    })).count;
  }

  // UserRecommendation is deliberately left alone. Its rows are rebuilt from
  // the graph by the next warm-recommendations run, and clearing them would
  // blank every user's For You page for up to 12h to save the same staleness
  // window that leaving them costs. Nothing here may wipe a shelf.

  // Cache already cleared; a failed audit write must not 500 a successful clear.
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    // Reuse the existing cache-clear audit action; the cleared source is carried in details.
    action: "RATINGS_CACHE_CLEAR",
    target: "tmdbCache",
    details: { source: sourceParam, cleared: count, coreCleared, edgesCleared, verdictsCleared },
    ...auditContext(req, session),
  });

  return NextResponse.json({ source: sourceParam, cleared: count, coreCleared, edgesCleared, verdictsCleared });
});
