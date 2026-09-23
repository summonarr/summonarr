import "server-only";
import { prisma } from "./prisma";
import type { MediaType } from "@/generated/prisma";
import type { TmdbMedia } from "./tmdb-types";
import {
  getMovieSuggestions,
  getTVSuggestions,
  getTrending,
  getPopularMovies,
  getPopularTV,
  SUGGESTIONS_CACHE_MAX,
} from "./tmdb";
import { attachRatingsUnified } from "./omdb-availability";
import { isMdblistQuotaLocked } from "./mdblist";
import { isOmdbQuotaLocked } from "./omdb";
import { qualityScoreOf } from "./recommendation-quality";
import { collectAllLibraryItems } from "./library-iterator";
import { settleLimit } from "./concurrency";
import { batchCreateMany, BATCH_TX_TIMEOUT } from "./cron-auth";
import { tmdbAuth } from "./tmdb-auth";

// The SERVER-WIDE half of the "For You" engine.
//
// Two things the per-user engine needs about a TITLE are the same for every
// viewer: its list of suggested titles, and its quality verdict (how well it is
// rated). Working them out per user would repeat the same upstream calls for
// every account that watches the same show.
//
// This module computes both ONCE for the whole instance, into TitleSuggestion
// (the edges) and RecommendationTitle (the per-title node: refresh bookkeeping
// plus the quality verdict). refreshRecommendationGraph runs at the top of the
// warm-recommendations cron, BEFORE the per-user pass, so by the time a user is
// computed every seed they can possibly hold is already covered and the whole
// per-user path is two indexed reads with no upstream call in it.
//
// There is no live fallback anywhere downstream, so this module is the sole
// supplier and the REQUIRED SET is how that is made safe. warmRecommendationsCache
// selects every user's seeds first and passes their union in as `required`; those
// sources are built with NO per-run cap, before anything else, every run. The
// capped, oldest-first walk of the rest of the library is pure pre-warming for
// seeds that do not exist yet, and it can be starved for a hundred runs without
// costing anyone a recommendation.

// How long a source title's edge list is trusted. Aligned with the 7-day
// TTL.DETAILS the underlying `<type>:<id>:suggestions:v3` TmdbCache rows carry:
// refreshing faster would re-read the same cached blob for nothing, slower
// would keep serving edges whose cache row has already been purged.
const SOURCE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// How long a precomputed quality verdict is trusted. Ratings move slowly and
// the underlying MDBList/OMDB rows have their own (longer) TTLs — this only
// governs how often the verdict is re-derived from them.
const QUALITY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Per-run ceiling for the SPECULATIVE half of the walk — library titles nobody
// has watched, watchlisted or requested yet. A first walk of a large library
// cannot finish in one run and must not try: the cron is on a 12h cadence,
// sources are refreshed oldest-first, and anything not reached this run is
// reached next run. Nothing depends on it having finished.
//
// It does NOT apply to the required set (see refreshRequiredSources). Capping
// that would be capping the guarantee.
const MAX_SOURCES_PER_RUN = 2_000;

// Per-run ceiling for the DEDICATED prewarm pass (prewarmSuggestionEdges),
// which the warm-library cron runs alongside its metadata walk. Far higher than
// the tail's cap because it is the whole point of that pass and it owns its own
// daily run rather than sharing the latency-sensitive recommendations one. At
// the ~33 sources/second the build sustains, 10k is roughly five minutes —
// comfortable inside the 2100s cron timeout even stacked on the details walk.
const MAX_PREWARM_EDGE_SOURCES_PER_RUN = 10_000;

// Safety ceiling on the required set. Not a storage budget — it is a WALL-CLOCK
// one, and that is what fixes the number: the required set is built uncapped, a
// cold source costs one suggestions call, and the cron caller gives up at
// CRON_CALL_TIMEOUT (2100s). At the ~5 concurrent calls SOURCE_CONCURRENCY
// allows and ~150ms apiece that is roughly 33 sources/second, so a cold build of
// much more than ~69k sources cannot finish inside one run at all. 50k leaves
// room for the writes and the ratings pass underneath it.
//
// The set is bounded by real user activity — selectSeeds admits at most 348
// titles per user (300 history + 24 watchlist + 24 request) and households
// overlap heavily — so reaching this needs ~144 users sharing almost nothing.
// Exceeding it is LOUD rather than silent: past this point some seeds go
// uncovered and their users' shelves stop refreshing, which an operator must
// be told about.
const MAX_REQUIRED_SOURCES = 50_000;
// Total verdicts resolved per run, spent priority-first (see
// refreshQualityVerdicts). Raised well above the source cap because the unit
// cost is low and asymmetric: MDBList takes 200 ids per POST, so 10k titles is
// ~50 requests, while OMDB — the expensive one — only fires on an MDBList miss
// and locks itself out on quota. Convergence matters more than it used to now
// that nothing rates a candidate on demand.
const MAX_QUALITY_TITLES_PER_RUN = 10_000;
const MAX_ORPHAN_SWEEP_PER_RUN = 2_000;
// Hard ceiling on how many titles the graph will EVER hold edges for. This is
// the table's size budget, not a policy: at SUGGESTIONS_CACHE_MAX (40) edges
// apiece it bounds TitleSuggestion at ~800k rows. Raise it only with that
// multiplication in mind — the rows are wide (they denormalize the suggestion's
// display fields, overview included), and this ships to self-hosted Postgres.
const MAX_GRAPH_SOURCES = 20_000;
// Bounds on how much of each seed pool is admitted as a graph source. These
// mirror what selectSeeds can actually draw on, with headroom — a title nobody
// can seed from is not worth an edge list.
const MAX_SEED_POOL_TITLES = 20_000;

// Ids per `IN`-shaped read when triaging the whole source list. The source list
// runs to MAX_GRAPH_SOURCES, and a single OR of that many key pairs is not a
// query any planner should be handed. Matches the prewarm passes' page size.
const TRIAGE_PAGE = 500;

const SOURCE_CONCURRENCY = 5;
// Sources whose edges are written in one transaction. Small enough that a
// failure loses little work, large enough to keep the round-trip count sane.
const SOURCE_WRITE_PAGE = 50;
// Titles per ratings pass. attachRatingsUnified batches MDBList at 200 ids per
// POST internally, so this is the natural page size.
const QUALITY_BATCH = 200;

export interface GraphSource {
  tmdbId: number;
  mediaType: MediaType;
}

function key(tmdbId: number, mediaType: MediaType): string {
  return `${tmdbId}:${mediaType}`;
}

function toTmdbMediaType(m: MediaType): "movie" | "tv" {
  return m === "MOVIE" ? "movie" : "tv";
}

export interface TitleQualityRow {
  // null with rated:true means "every provider was asked and none answered" —
  // which is what the obscurity damp keys on. A title with no row at all is
  // simply unknown and gets no opinion either way, so the two must not be
  // collapsed into one nullable number.
  quality: number | null;
  evidence: number;
  rated: boolean;
}

// ── Read side (the per-user hot path) ──────────────────────────────────────

// Every edge out of the given source titles, position-ordered, as the same
// TmdbMedia shape getMovieSuggestions/getTVSuggestions return — so the engine's
// scoring loop cannot tell a graph-served list from a live one.
//
// TWO queries for every seed a user holds, in place of one cache read per seed.
// The second one is what makes a KNOWN-EMPTY source distinguishable from an
// unbuilt one: a title TMDB has no suggestions for writes no edges, so without
// the node read it would look "not built yet" and wrongly lower the user's
// seed coverage. A built source with no edges is returned as an explicit empty
// list.
export async function readGraphSuggestions(sources: GraphSource[]): Promise<Map<string, TmdbMedia[]>> {
  const out = new Map<string, TmdbMedia[]>();
  if (sources.length === 0) return out;

  const [nodes, rows] = await Promise.all([
    prisma.recommendationTitle.findMany({
      where: {
        OR: sources.map((s) => ({ tmdbId: s.tmdbId, mediaType: s.mediaType })),
        suggestionsRefreshedAt: { not: null },
      },
      select: { tmdbId: true, mediaType: true },
    }),
    prisma.titleSuggestion.findMany({
      where: {
        OR: sources.map((s) => ({ sourceTmdbId: s.tmdbId, sourceMediaType: s.mediaType })),
      },
    }),
  ]);

  const bySource = new Map<string, typeof rows>();
  for (const row of rows) {
    const k = key(row.sourceTmdbId, row.sourceMediaType);
    const list = bySource.get(k);
    if (list) list.push(row);
    else bySource.set(k, [row]);
  }

  for (const node of nodes) out.set(key(node.tmdbId, node.mediaType), []);

  for (const [k, list] of bySource) {
    list.sort((a, b) => a.position - b.position);
    out.set(
      k,
      list.map((row) => ({
        id: row.tmdbId,
        mediaType: toTmdbMediaType(row.mediaType),
        title: row.title,
        overview: row.overview ?? "",
        posterPath: row.posterPath,
        backdropPath: row.backdropPath,
        releaseDate: row.releaseDate,
        releaseYear: row.releaseDate?.slice(0, 4) ?? null,
        voteAverage: row.voteAverage,
        voteCount: row.voteCount,
        originalLanguage: row.originalLanguage,
      })),
    );
  }
  return out;
}

// Precomputed verdicts for the given candidates. A missing key means the graph
// has not rated that title yet; the caller treats it as "no opinion" (there is
// no live ratings lookup).
export async function readTitleQuality(titles: GraphSource[]): Promise<Map<string, TitleQualityRow>> {
  const out = new Map<string, TitleQualityRow>();
  if (titles.length === 0) return out;

  const rows = await prisma.recommendationTitle.findMany({
    where: { OR: titles.map((t) => ({ tmdbId: t.tmdbId, mediaType: t.mediaType })) },
    select: { tmdbId: true, mediaType: true, quality: true, evidence: true, qualityRatedAt: true },
  });
  for (const row of rows) {
    if (row.qualityRatedAt === null) continue; // node exists as a SOURCE only; nothing was rated
    out.set(key(row.tmdbId, row.mediaType), {
      quality: row.quality,
      evidence: row.evidence,
      rated: true,
    });
  }
  return out;
}

// ── Write side (the cron) ──────────────────────────────────────────────────

// Every title on this server that can seed a recommendation, SEED POOLS FIRST.
//
// Order is the point: the per-run ceiling means a big library will not finish
// in one pass, and the titles that must not wait are the ones somebody is
// actually seeding from. Library titles nobody has touched yet still get built
// — a user who starts watching one tomorrow finds it already covered — they
// just queue behind the pools.
interface SourceSet {
  sources: GraphSource[];
  // False when any ceiling clipped the list. The orphan sweep below refuses to
  // run on a clipped set: "absent from the source list" would then also mean
  // "past the cap", and it would delete edges it is about to rebuild.
  complete: boolean;
}

async function collectGraphSources(): Promise<SourceSet> {
  const [watched, watchlist, requests] = await Promise.all([
    prisma.playHistory.groupBy({
      by: ["tmdbId", "mediaType"],
      where: { watched: true, tmdbId: { not: null }, mediaType: { not: null } },
      _max: { startedAt: true },
      orderBy: [{ _max: { startedAt: "desc" } }],
      take: MAX_SEED_POOL_TITLES,
    }),
    prisma.watchlistItem.findMany({
      select: { tmdbId: true, mediaType: true },
      orderBy: { createdAt: "desc" },
      take: MAX_SEED_POOL_TITLES,
    }),
    prisma.mediaRequest.findMany({
      select: { tmdbId: true, mediaType: true },
      orderBy: { createdAt: "desc" },
      take: MAX_SEED_POOL_TITLES,
    }),
  ]);

  const seen = new Set<string>();
  const out: GraphSource[] = [];
  const push = (tmdbId: number | null, mediaType: MediaType | null) => {
    if (tmdbId == null || mediaType == null) return;
    const k = key(tmdbId, mediaType);
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ tmdbId, mediaType });
  };

  for (const r of watched) push(r.tmdbId, r.mediaType);
  for (const r of watchlist) push(r.tmdbId, r.mediaType);
  for (const r of requests) push(r.tmdbId, r.mediaType);

  // …then the rest of the library. collectAllLibraryItems already dedupes
  // across Plex/Jellyfin and across server instances (guardrail 35): a title on
  // two servers is ONE title as far as TMDB is concerned.
  if (out.length < MAX_GRAPH_SOURCES) {
    for (const item of await collectAllLibraryItems(MAX_GRAPH_SOURCES)) {
      push(item.tmdbId, item.mediaType);
      if (out.length >= MAX_GRAPH_SOURCES) break;
    }
  }

  const clipped =
    watched.length >= MAX_SEED_POOL_TITLES ||
    watchlist.length >= MAX_SEED_POOL_TITLES ||
    requests.length >= MAX_SEED_POOL_TITLES ||
    out.length >= MAX_GRAPH_SOURCES;
  return { sources: out.slice(0, MAX_GRAPH_SOURCES), complete: !clipped };
}

interface FetchedSource {
  source: GraphSource;
  suggestions: TmdbMedia[];
}

// Rebuilds one page of sources' edges in a single transaction: scoped delete,
// then the replacement rows, then the node bookkeeping. The delete is scoped to
// the sources in THIS page — never a bare deleteMany — so a page that fails
// cannot take another page's edges with it.
async function writeSourcePage(page: FetchedSource[]): Promise<number> {
  const edges = page.flatMap(({ source, suggestions }) =>
    suggestions.map((item, position) => ({
      sourceTmdbId: source.tmdbId,
      sourceMediaType: source.mediaType,
      tmdbId: item.id,
      mediaType: (item.mediaType === "movie" ? "MOVIE" : "TV") as MediaType,
      position,
      title: item.title,
      overview: item.overview || null,
      posterPath: item.posterPath,
      backdropPath: item.backdropPath,
      releaseDate: item.releaseDate,
      voteAverage: item.voteAverage,
      voteCount: item.voteCount ?? 0,
      originalLanguage: item.originalLanguage ?? null,
    })),
  );

  await prisma.$transaction(
    async (tx) => {
      await tx.titleSuggestion.deleteMany({
        where: {
          OR: page.map(({ source }) => ({
            sourceTmdbId: source.tmdbId,
            sourceMediaType: source.mediaType,
          })),
        },
      });
      if (edges.length > 0) await batchCreateMany(tx.titleSuggestion, edges);

      // Introduce every NEW suggestion target as a graph node, carrying just
      // enough (title + releaseDate) for the ratings pass to look it up later.
      // skipDuplicates, never an update: an existing node already holds its
      // verdict and its own metadata, and rewriting those from an edge would
      // reset a title's rated state every time any source re-linked to it.
      //
      // This is what makes the quality pass a bounded indexed scan instead of a
      // distinct-over-every-edge aggregate: targets announce themselves here,
      // once, at the moment the edge that introduced them is written.
      const targets = new Map<string, { tmdbId: number; mediaType: MediaType; releaseDate: string | null }>();
      for (const edge of edges) {
        const k = key(edge.tmdbId, edge.mediaType);
        if (!targets.has(k)) {
          targets.set(k, { tmdbId: edge.tmdbId, mediaType: edge.mediaType, releaseDate: edge.releaseDate });
        }
      }
      if (targets.size > 0) {
        await batchCreateMany(tx.recommendationTitle, [...targets.values()]);
      }

      const now = new Date();
      for (const { source, suggestions } of page) {
        // upsert, not create-catch-duplicate: a caught unique violation inside a
        // top-level interactive transaction silently converts the COMMIT to a
        // ROLLBACK (guardrail 23), which would discard this whole page's edges
        // while reporting success.
        await tx.recommendationTitle.upsert({
          where: { tmdbId_mediaType: { tmdbId: source.tmdbId, mediaType: source.mediaType } },
          create: {
            tmdbId: source.tmdbId,
            mediaType: source.mediaType,
            suggestionsRefreshedAt: now,
            suggestionCount: suggestions.length,
          },
          update: { suggestionsRefreshedAt: now, suggestionCount: suggestions.length },
        });
      }
    },
    { timeout: BATCH_TX_TIMEOUT },
  );

  return edges.length;
}

export interface GraphRefreshResult {
  sources: number;
  // The seed union warmRecommendationsCache asked for, and how much of it the
  // graph can now answer. requiredCovered < requiredSources is the one number
  // that predicts a skipped user, so it is reported rather than inferred.
  requiredSources: number;
  requiredCovered: number;
  sourcesRefreshed: number;
  sourcesSkipped: number;
  sourcesFailed: number;
  edgesWritten: number;
  sourcesSwept: number;
  titlesRated: number;
  // Titles whose lookup produced nothing while a provider was locked out, so no
  // verdict was written. They are re-asked next run rather than carrying a
  // week-long "nobody answered" earned by an outage.
  verdictsDeferred: number;
  ratingsFailed: number;
}

const EMPTY_REFRESH: GraphRefreshResult = {
  sources: 0,
  requiredSources: 0,
  requiredCovered: 0,
  sourcesRefreshed: 0,
  sourcesSkipped: 0,
  sourcesFailed: 0,
  edgesWritten: 0,
  sourcesSwept: 0,
  titlesRated: 0,
  verdictsDeferred: 0,
  ratingsFailed: 0,
};

// Builds the edges for every stale source, oldest-first, up to `limit`.
// Pass Infinity for the required set — see MAX_SOURCES_PER_RUN.
async function refreshSuggestionEdges(
  sources: GraphSource[],
  stats: GraphRefreshResult,
  limit: number,
  signal?: AbortSignal,
): Promise<void> {
  const refreshedAt = new Map<string, Date | null>();
  for (let i = 0; i < sources.length; i += TRIAGE_PAGE) {
    const nodes = await prisma.recommendationTitle.findMany({
      where: { OR: sources.slice(i, i + TRIAGE_PAGE).map((s) => ({ tmdbId: s.tmdbId, mediaType: s.mediaType })) },
      select: { tmdbId: true, mediaType: true, suggestionsRefreshedAt: true },
    });
    for (const n of nodes) refreshedAt.set(key(n.tmdbId, n.mediaType), n.suggestionsRefreshedAt);
  }

  const cutoff = Date.now() - SOURCE_TTL_MS;
  const stale = sources.filter((s) => {
    const at = refreshedAt.get(key(s.tmdbId, s.mediaType));
    return at == null || at.getTime() < cutoff;
  });
  // += : this runs twice a cycle (required set, then the speculative tail).
  stats.sourcesSkipped += sources.length - stale.length;

  // Oldest first (never-built sources first of all), so a library that cannot
  // finish in one run still makes monotonic progress instead of re-picking the
  // same arbitrary slice every cycle.
  stale.sort((a, b) => {
    const at = refreshedAt.get(key(a.tmdbId, a.mediaType))?.getTime() ?? -1;
    const bt = refreshedAt.get(key(b.tmdbId, b.mediaType))?.getTime() ?? -1;
    return at - bt;
  });

  const batch = Number.isFinite(limit) ? stale.slice(0, limit) : stale;
  for (let i = 0; i < batch.length; i += SOURCE_WRITE_PAGE) {
    // Stop when the lock's timeout aborts us; ignoring it would keep this
    // running after withAdvisoryLock released the lock (guardrail 41).
    if (signal?.aborted) break;
    const page = batch.slice(i, i + SOURCE_WRITE_PAGE);
    const results = await settleLimit(page, SOURCE_CONCURRENCY, (source) =>
      source.mediaType === "MOVIE"
        ? getMovieSuggestions(source.tmdbId, SUGGESTIONS_CACHE_MAX)
        : getTVSuggestions(source.tmdbId, SUGGESTIONS_CACHE_MAX),
    );

    // getMovieSuggestions/getTVSuggestions hide upstream failures and return [],
    // so an empty list could mean "TMDB has nothing" OR "TMDB is down". Saving a
    // wrong "nothing" would serve it to every user for a week. So: if any
    // source in this page got results, TMDB is up and the empty ones are real
    // answers. If the whole page came back empty, treat it as an outage, write
    // nothing, and retry those sources next run.
    const conclusive = results.some((r) => r.status === "fulfilled" && r.value.length > 0);
    const fetched: FetchedSource[] = [];
    for (let j = 0; j < page.length; j++) {
      const r = results[j];
      if (r.status !== "fulfilled") {
        stats.sourcesFailed++;
        continue;
      }
      if (!conclusive) {
        stats.sourcesSkipped++;
        continue;
      }
      fetched.push({ source: page[j], suggestions: r.value });
    }

    if (fetched.length === 0) continue;
    try {
      stats.edgesWritten += await writeSourcePage(fetched);
      stats.sourcesRefreshed += fetched.length;
    } catch (err) {
      stats.sourcesFailed += fetched.length;
      console.error("[recommendation-graph] edge write failed for a page of sources:", err);
    }
  }
}

// Reads the trending/popular lists and registers them as graph nodes.
//
// Two jobs. First: buildFallbackCandidates (which fills new or thin shelves)
// reads these lists during the per-user pass. They are shared caches, but on a
// cold cache the first user of the run would pay for the fetch. Reading them
// here first means every later read is a cache hit.
//
// Second job: the pool's titles are scored by the same quality prior as any
// other candidate, so they need verdicts. skipDuplicates — an already-known
// title keeps the verdict it has.
async function warmFallbackPool(): Promise<void> {
  try {
    const [trending, popMovies, popTV] = await Promise.all([getTrending(), getPopularMovies(), getPopularTV()]);
    const pool = new Map<string, { tmdbId: number; mediaType: MediaType; releaseDate: string | null }>();
    for (const item of [...trending, ...popMovies, ...popTV]) {
      const mediaType: MediaType = item.mediaType === "movie" ? "MOVIE" : "TV";
      const k = key(item.id, mediaType);
      if (!pool.has(k)) pool.set(k, { tmdbId: item.id, mediaType, releaseDate: item.releaseDate });
    }
    if (pool.size > 0) await batchCreateMany(prisma.recommendationTitle, [...pool.values()]);
  } catch (err) {
    // Non-fatal: a cold-start user's shelf is the only thing downstream, and
    // buildFallbackCandidates already treats a pool failure as inconclusive.
    console.warn("[recommendation-graph] fallback pool unavailable:", err);
  }
}

// Every distinct suggestion target of the required sources — i.e. the candidate
// universe of the users who actually exist, as opposed to of the library.
// groupBy, not findMany+distinct: Prisma applies `distinct` CLIENT-side, and
// there are up to 40 edge rows per source to drag across the wire otherwise.
async function requiredTargets(required: GraphSource[]): Promise<GraphSource[]> {
  const out = new Map<string, GraphSource>();
  for (let i = 0; i < required.length; i += TRIAGE_PAGE) {
    const rows = await prisma.titleSuggestion.groupBy({
      by: ["tmdbId", "mediaType"],
      where: {
        OR: required.slice(i, i + TRIAGE_PAGE).map((s) => ({ sourceTmdbId: s.tmdbId, sourceMediaType: s.mediaType })),
      },
    });
    for (const r of rows) out.set(key(r.tmdbId, r.mediaType), { tmdbId: r.tmdbId, mediaType: r.mediaType });
  }
  return [...out.values()];
}

// Which of `titles` still need a verdict, cheapest-first triage.
//
// Stops as soon as `limit` of them are found rather than triaging the whole set:
// the required set's target list runs to tens of thousands and only
// MAX_QUALITY_TITLES_PER_RUN of them can be spent in a run anyway, so paging the
// remainder is queries bought for rows this run will discard. Convergence is
// unaffected — a rated title drops out of "stale", so the next run's scan starts
// where this one stopped.
async function staleQualityTitles(
  titles: GraphSource[],
  limit: number,
): Promise<{ tmdbId: number; mediaType: MediaType; releaseDate: string | null }[]> {
  const cutoff = Date.now() - QUALITY_TTL_MS;
  const out: { tmdbId: number; mediaType: MediaType; releaseDate: string | null }[] = [];
  for (let i = 0; i < titles.length && out.length < limit; i += TRIAGE_PAGE) {
    const rows = await prisma.recommendationTitle.findMany({
      where: { OR: titles.slice(i, i + TRIAGE_PAGE).map((t) => ({ tmdbId: t.tmdbId, mediaType: t.mediaType })) },
      select: { tmdbId: true, mediaType: true, releaseDate: true, qualityRatedAt: true },
    });
    for (const r of rows) {
      if (r.qualityRatedAt !== null && r.qualityRatedAt.getTime() >= cutoff) continue;
      out.push({ tmdbId: r.tmdbId, mediaType: r.mediaType, releaseDate: r.releaseDate });
    }
  }
  return out;
}

// Resolves quality verdicts for the titles the engine will actually score.
//
// PRIORITY-FIRST. Nothing rates a candidate on demand, so an unrated one is
// ranked on relevance alone until some run reaches it. The run's budget goes
// first to the suggestions of the REQUIRED sources (what real users will
// actually see). Whatever is left goes to the general oldest-first scan, which
// eventually covers the trending/popular pool and the rest of the library.
async function refreshQualityVerdicts(required: GraphSource[], stats: GraphRefreshResult, signal?: AbortSignal): Promise<void> {
  const cutoff = new Date(Date.now() - QUALITY_TTL_MS);

  const priority = required.length > 0
    ? await staleQualityTitles(await requiredTargets(required), MAX_QUALITY_TITLES_PER_RUN)
    : [];
  const budget = Math.max(0, MAX_QUALITY_TITLES_PER_RUN - priority.length);

  const filler = budget > 0
    ? await prisma.recommendationTitle.findMany({
        where: { OR: [{ qualityRatedAt: null }, { qualityRatedAt: { lt: cutoff } }] },
        // nulls first: a title that has never been rated is worth more than a
        // re-derivation of a verdict that is merely a week old.
        orderBy: { qualityRatedAt: { sort: "asc", nulls: "first" } },
        take: budget,
        select: { tmdbId: true, mediaType: true, releaseDate: true },
      })
    : [];

  // The filler scan can re-list a priority title; rating one twice would spend
  // budget on a verdict already written this run.
  const seen = new Set(priority.map((t) => key(t.tmdbId, t.mediaType)));
  const stale = [...priority];
  for (const row of filler) {
    if (seen.has(key(row.tmdbId, row.mediaType))) continue;
    stale.push(row);
  }
  if (stale.length === 0) return;

  for (let i = 0; i < stale.length; i += QUALITY_BATCH) {
    if (signal?.aborted) break;
    // Both providers locked out means every remaining batch would resolve to
    // "nobody answered" and then STAMP that as a verdict for a week. Stop, and
    // let the next run rate them for real. Mirrors prewarmMdblistCache's
    // early exit; either provider still answering is reason enough to continue.
    if (isMdblistQuotaLocked() && isOmdbQuotaLocked()) {
      console.warn(`[recommendation-graph] both ratings providers are quota-locked — stopping after ${stats.titlesRated} verdict(s)`);
      break;
    }
    const slice = stale.slice(i, i + QUALITY_BATCH);
    let rated: TmdbMedia[];
    try {
      // blocking:true fetches the misses inline; this runs inside a cron request
      // whose response must not be sent before the verdicts are written.
      //
      // deferToAfter:false keeps the rest inline too. blocking:true alone still
      // hands every stale row's refresh to after(), and Next starts all of a
      // request's after() callbacks at once when the response closes. At one
      // callback per QUALITY_BATCH that is up to 50 batches of MDBList POSTs and
      // OMDB/TMDB refreshes landing together, on top of whichever cron runs next.
      // Inline, each batch's refresh finishes before the next batch begins, and
      // it stays inside the advisory lock this run holds.
      rated = await attachRatingsUnified(
        slice.map((c) => ({
          id: c.tmdbId,
          mediaType: toTmdbMediaType(c.mediaType),
          // Neither field is a lookup key — MDBList and OMDB are both queried
          // by tmdbId (+ releaseDate) — so there is nothing to carry here.
          title: "",
          overview: "",
          posterPath: null,
          backdropPath: null,
          releaseDate: c.releaseDate,
          releaseYear: c.releaseDate?.slice(0, 4) ?? null,
          // Deliberately zero, and the stored verdict is deliberately
          // TMDB-FREE: the prior's TMDB term is scored per CANDIDATE at read
          // time, where that candidate's own voteAverage/voteCount are known
          // (they ride on the edge row). Feeding a placebo pair in here would
          // bake a wrong TMDB contribution into a verdict shared by every
          // viewer — qualityScoreOf gates that term on the vote count, so zero
          // is exactly "TMDB abstains", which is what this needs.
          voteAverage: 0,
          voteCount: 0,
        })),
        { blocking: true, deferToAfter: false },
      );
    } catch (err) {
      stats.ratingsFailed += slice.length;
      console.warn("[recommendation-graph] ratings lookup failed for a batch; verdicts unchanged:", err);
      continue;
    }

    // A NULL verdict ("nobody answered") can only be trusted if the providers
    // were reachable. attachRatingsUnified hides its own upstream failures, so
    // the try/catch above does not fire on a network outage. Without this check
    // an outage would stamp week-long null verdicts, and the obscurity penalty
    // would then demote every low-vote title it touched.
    //
    // Checked AFTER the batch so a lockout tripped mid-batch is seen. This is
    // why the OMDB transport circuit breaker (omdb.ts) matters: without it a
    // run of timeouts would never set this flag.
    const providersAnswering = !isMdblistQuotaLocked() && !isOmdbQuotaLocked();

    const now = new Date();
    for (const media of rated) {
      const mediaType: MediaType = media.mediaType === "movie" ? "MOVIE" : "TV";
      const verdict = qualityScoreOf(media);
      // A real verdict is authoritative however the rest of the batch fared —
      // a provider answered for THIS title. Only the nulls are in question.
      if (verdict === null && !providersAnswering) {
        stats.verdictsDeferred++;
        continue;
      }
      try {
        await prisma.recommendationTitle.update({
          where: { tmdbId_mediaType: { tmdbId: media.id, mediaType } },
          data: {
            quality: verdict?.quality ?? null,
            evidence: verdict?.evidence ?? 0,
            // Stamped even when nothing answered — PROVIDED the providers were
            // reachable (see above). "Asked, nobody answered" is the state the
            // obscurity damp keys on, and leaving it null would both lose that
            // verdict and re-ask every run forever.
            qualityRatedAt: now,
          },
        });
        stats.titlesRated++;
      } catch (err) {
        stats.ratingsFailed++;
        console.error("[recommendation-graph] verdict write failed:", err);
      }
    }
  }
}

// Drops the edges of sources that have left the server entirely — a title
// removed from the library that nobody has watched, watchlisted or requested.
// Nothing else would ever reach those rows: no run lists them as a source, so
// their edges would sit at full width forever.
//
// The node row itself is KEPT (it is narrow, and it may hold a quality verdict
// the title still earns as somebody else's suggestion); only its source
// bookkeeping is cleared, which is also what makes the sweep idempotent — a
// cleared node is no longer "built" and cannot be swept twice.
async function sweepOrphanSources(live: Set<string>, stats: GraphRefreshResult): Promise<void> {
  const built = await prisma.recommendationTitle.findMany({
    where: { suggestionsRefreshedAt: { not: null } },
    select: { tmdbId: true, mediaType: true },
    take: MAX_GRAPH_SOURCES,
  });
  const orphans = built
    .filter((b) => !live.has(key(b.tmdbId, b.mediaType)))
    .slice(0, MAX_ORPHAN_SWEEP_PER_RUN);
  if (orphans.length === 0) return;

  for (let i = 0; i < orphans.length; i += SOURCE_WRITE_PAGE) {
    const page = orphans.slice(i, i + SOURCE_WRITE_PAGE);
    await prisma.$transaction(
      async (tx) => {
        await tx.titleSuggestion.deleteMany({
          where: { OR: page.map((o) => ({ sourceTmdbId: o.tmdbId, sourceMediaType: o.mediaType })) },
        });
        await tx.recommendationTitle.updateMany({
          where: { OR: page.map((o) => ({ tmdbId: o.tmdbId, mediaType: o.mediaType })) },
          data: { suggestionsRefreshedAt: null, suggestionCount: 0 },
        });
      },
      { timeout: BATCH_TX_TIMEOUT },
    );
    stats.sourcesSwept += page.length;
  }
}

export interface SuggestionEdgePrewarmResult {
  sources: number;
  refreshed: number;
  skipped: number;
  failed: number;
  edgesWritten: number;
}

// Builds suggestion edges for every graph source, on the warm-library cron's
// cadence, as a companion to the metadata walk that cron already does.
//
// It writes the same TitleSuggestion table as refreshRecommendationGraph; it
// just does the work EARLIER. The recommendations run only builds
// MAX_SOURCES_PER_RUN speculative sources per run, so a 20k-title library
// would take ten runs (five days) to cover. Doing it in the daily library
// cron, which already walks the whole library, keeps the 12h recommendations
// run short.
//
// It is an ACCELERANT, never a substitute. refreshRecommendationGraph still builds
// the required set uncapped on every recommendations run; this pass just means it
// usually finds everything TTL-fresh and does nothing. Nothing downstream may ever
// assume this ran — see guardrail 40.
//
// Concurrency note: this and the recommendations run can be in flight together and
// both write TitleSuggestion. The shared TTL triage makes an overlap on the SAME
// source rare (whichever builds it first, the other skips it), the writes are
// scoped per source page, and a page that loses a lock race fails alone and is
// retried next run. That is accepted rather than serialized: making the two crons
// share a lock would let a long library walk block shelf refreshes outright.
export async function prewarmSuggestionEdges(opts: { signal?: AbortSignal } = {}): Promise<SuggestionEdgePrewarmResult> {
  if (!tmdbAuth()) return { sources: 0, refreshed: 0, skipped: 0, failed: 0, edgesWritten: 0 };

  // The same source universe the graph defines for itself — library titles PLUS
  // the watched/watchlist/request pools, which covers inactive users too. Those
  // never enter a required set (it is built from ACTIVE users' seeds), so this is
  // the only pass that reaches them before the person signs back in.
  const { sources } = await collectGraphSources();
  const stats: GraphRefreshResult = { ...EMPTY_REFRESH };
  if (sources.length > 0) await refreshSuggestionEdges(sources, stats, MAX_PREWARM_EDGE_SOURCES_PER_RUN, opts.signal);

  return {
    sources: sources.length,
    refreshed: stats.sourcesRefreshed,
    skipped: stats.sourcesSkipped,
    failed: stats.sourcesFailed,
    edgesWritten: stats.edgesWritten,
  };
}

// How much of the required set the graph can now answer for. Read back from the
// node stamps rather than inferred from the build's own counters: a source that
// was already fresh contributes coverage without being refreshed, and one whose
// write failed must not contribute it despite having been attempted.
async function countCovered(required: GraphSource[]): Promise<number> {
  let covered = 0;
  for (let i = 0; i < required.length; i += TRIAGE_PAGE) {
    covered += await prisma.recommendationTitle.count({
      where: {
        OR: required.slice(i, i + TRIAGE_PAGE).map((r) => ({ tmdbId: r.tmdbId, mediaType: r.mediaType })),
        suggestionsRefreshedAt: { not: null },
      },
    });
  }
  return covered;
}

// One pass of the server-wide precompute. Called at the top of
// warmRecommendationsCache; safe to call on a schedule and safe to interrupt —
// every unit of work is idempotent and the per-run ceilings make it resumable.
//
// `required` is the union of every user's already-selected seeds. It is built
// FIRST and WITHOUT the per-run cap, because nothing downstream has a fallback:
// an uncovered seed is a seed that contributes nothing that cycle. Everything
// after it is speculative pre-warming and is capped.
export async function refreshRecommendationGraph(
  opts: { required?: GraphSource[]; signal?: AbortSignal } = {},
): Promise<GraphRefreshResult> {
  if (!tmdbAuth()) return { ...EMPTY_REFRESH };

  const stats: GraphRefreshResult = { ...EMPTY_REFRESH };

  const requiredAll = opts.required ?? [];
  const required = requiredAll.slice(0, MAX_REQUIRED_SOURCES);
  if (requiredAll.length > MAX_REQUIRED_SOURCES) {
    console.error(
      `[recommendation-graph] the required seed set is ${requiredAll.length} titles, past the ${MAX_REQUIRED_SOURCES} ceiling — ` +
        `${requiredAll.length - MAX_REQUIRED_SOURCES} seed(s) will go uncovered and their users' shelves will stop refreshing`,
    );
  }
  stats.requiredSources = required.length;

  // 1. The guarantee: every seed the fan-out is about to read, uncapped.
  if (required.length > 0) await refreshSuggestionEdges(required, stats, Infinity, opts.signal);
  stats.requiredCovered = required.length > 0 ? await countCovered(required) : 0;

  // 2. Speculative pre-warming for seeds that do not exist yet — the library,
  //    and the wider watched/watchlist/request pools beyond what any active user
  //    currently seeds from. Capped, oldest-first, and starvable without cost.
  const { sources, complete } = await collectGraphSources();
  const requiredKeys = new Set(required.map((r) => key(r.tmdbId, r.mediaType)));
  const tail = sources.filter((s) => !requiredKeys.has(key(s.tmdbId, s.mediaType)));
  stats.sources = required.length + tail.length;
  if (tail.length > 0) await refreshSuggestionEdges(tail, stats, MAX_SOURCES_PER_RUN, opts.signal);

  // 3. Reap sources that have left the server. Only on a COMPLETE source list —
  //    see SourceSet.complete. The required set is added to `live` too: a seed
  //    is still in use by definition, so it must never look departed.
  if (complete) {
    const live = new Set([...requiredKeys, ...tail.map((s) => key(s.tmdbId, s.mediaType))]);
    await sweepOrphanSources(live, stats);
  }

  // 4. Warm the trending/popular pool so the cold-start path's reads are cache
  //    hits, and register its titles for rating.
  await warmFallbackPool();

  // 5. Verdicts, priority-first over the required set's own candidates.
  await refreshQualityVerdicts(required, stats, opts.signal);

  return stats;
}
