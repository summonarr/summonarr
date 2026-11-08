import "server-only";
import { prisma } from "./prisma";
import { Prisma, type MediaType } from "@/generated/prisma";
import type { TmdbMedia } from "./tmdb-types";
import { getCacheStaleMany, tmdbDetailsKey } from "./tmdb-cache";
import { getSuggestionsResult, getTrending, getPopularMovies, getPopularTV } from "./tmdb";
import { upstreamFailed, type UpstreamResult } from "./upstream-result";
import { check, v, type Infer } from "./validate";
import { attachRatingsUnified } from "./omdb-availability";
import { isMdblistKeyRejected, isMdblistQuotaLocked, mdblistTransportFailureCount } from "./mdblist";
import { isOmdbQuotaLocked } from "./omdb";
import { qualityScoreOf } from "./recommendation-quality";
import { collectAllLibraryItems } from "./library-iterator";
import { settleLimit } from "./concurrency";
import {
  batchCreateMany,
  BATCH_TX_LOCK_TIMEOUT,
  BATCH_TX_STATEMENT_TIMEOUT,
  BATCH_TX_TIMEOUT,
  setBatchTxTimeouts,
} from "./batch-write";
import { describeTxFailure, seconds, txTrace } from "./tx-diagnostics";
import { tmdbAuth } from "./tmdb-auth";
import { FOR_YOU_COWATCH_FEATURE_KEY, isFeatureEnabled } from "./features";

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
// The set is bounded by real user activity — selectSeeds admits at most 372
// titles per user (300 history + 24 watchlist + 24 request + 24 loved,
// guardrail 40c) and households overlap heavily — so reaching this needs ~134
// users sharing almost nothing.
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
// A page write this slow gets one warning per pass (refreshSuggestionEdges):
// a third of BATCH_TX_TIMEOUT, where a healthy page takes about a second.
const SLOW_PAGE_WRITE_MS = 10_000;
// Titles per ratings pass. attachRatingsUnified batches MDBList at 200 ids per
// POST internally, so this is the natural page size.
const QUALITY_BATCH = 200;
// The verdict pass is a cron: MDBList stops it at the reserve kept for pages.
const BACKGROUND_RATINGS = { background: true } as const;
// Rows per release-date fill statement (3 bind parameters each).
const NODE_DATE_FILL_PAGE = 2_000;
// A verdict written while a provider was not answering is real (it is always
// written, guardrail 40) but may rest on fewer sources than the title has. It
// is stamped so it falls stale after this long instead of QUALITY_TTL_MS, and
// the next runs re-derive it once every provider answers again.
const PARTIAL_VERDICT_RECHECK_MS = 24 * 60 * 60 * 1000;

export interface GraphSource {
  tmdbId: number;
  mediaType: MediaType;
}

// The one "<tmdbId>:<MOVIE|TV>" title key of the For You engine (both this file
// and recommendations.ts; blacklist.ts's blacklistKey emits the same shape).
export function titleKey(tmdbId: number, mediaType: MediaType): string {
  return `${tmdbId}:${mediaType}`;
}
const key = titleKey;

export function toTmdbMediaType(m: MediaType): "movie" | "tv" {
  return m === "MOVIE" ? "movie" : "tv";
}

export function toDbMediaType(m: "movie" | "tv"): MediaType {
  return m === "movie" ? "MOVIE" : "TV";
}

// A graph node to introduce (createMany skipDuplicates): just enough for the
// ratings pass to look the title up later.
// A type alias, not an interface: batchCreateMany takes Record-shaped rows.
type TitleNode = {
  tmdbId: number;
  mediaType: MediaType;
  releaseDate: string | null;
};

// One node per title, first occurrence wins — the dedupe every node writer needs.
function uniqueTitleNodes(nodes: Iterable<TitleNode>): TitleNode[] {
  const out = new Map<string, TitleNode>();
  for (const n of nodes) {
    const k = key(n.tmdbId, n.mediaType);
    if (!out.has(k)) out.set(k, n);
  }
  return [...out.values()];
}

// Introduces nodes, and gives an existing node with no release date the one
// it now has. createMany skipDuplicates never touches an existing row (it keeps
// its verdict), so a title first created as a SOURCE — which carries no date —
// kept a null releaseDate for good, and the ratings pass then sent no date to
// the providers, whose negative-cache and details TTLs key on it. The fill is
// one COALESCE-style UPDATE (only rows still null), never an overwrite. A raw
// statement passed as ONE Prisma.sql value (guardrail 23a). Sequential on a
// transaction client (guardrail 23c).
async function writeTitleNodes(
  db: { recommendationTitle: { createMany: (args: { data: TitleNode[]; skipDuplicates?: boolean }) => Promise<unknown> }; $executeRaw: (query: Prisma.Sql) => Promise<number> },
  nodes: TitleNode[],
): Promise<void> {
  if (nodes.length === 0) return;
  await batchCreateMany(db.recommendationTitle, nodes);
  const dated = nodes.filter((n) => n.releaseDate !== null);
  for (let i = 0; i < dated.length; i += NODE_DATE_FILL_PAGE) {
    const rows = dated.slice(i, i + NODE_DATE_FILL_PAGE).map(
      (n) => Prisma.sql`(${n.tmdbId}::int, ${n.mediaType}::"MediaType", ${n.releaseDate}::text)`,
    );
    await db.$executeRaw(Prisma.sql`
      UPDATE "RecommendationTitle" AS r
      SET "releaseDate" = v."releaseDate"
      FROM (VALUES ${Prisma.join(rows)}) AS v("tmdbId", "mediaType", "releaseDate")
      WHERE r."tmdbId" = v."tmdbId" AND r."mediaType" = v."mediaType" AND r."releaseDate" IS NULL
    `);
  }
}

// Column widths of the denormalized display fields on TitleSuggestion and
// CoWatchSuggestion (and RecommendationTitle.releaseDate). TMDB bounds none of
// them, and ONE over-long value fails its whole page's createMany — on every
// run, since the page's sources are never stamped and sort first again.
const EDGE_TITLE_MAX = 500;
const EDGE_PATH_MAX = 500;
const EDGE_SHORT_MAX = 16;

// Cut by code points (Postgres counts characters, not UTF-16 units), so a
// clamp never splits a surrogate pair.
function clampText(s: string, max: number): string {
  return s.length <= max ? s : Array.from(s).slice(0, max).join("");
}

// A path or code too long for its column is useless cut short: drop it.
function fitOrNull(s: string | null | undefined, max: number): string | null {
  return typeof s === "string" && s.length <= max ? s : null;
}

// An edge row's display columns, fitted to their widths.
function edgeDisplayColumns(item: Omit<TmdbMedia, "id" | "mediaType">) {
  return {
    title: clampText(item.title, EDGE_TITLE_MAX),
    overview: item.overview || null,
    posterPath: fitOrNull(item.posterPath, EDGE_PATH_MAX),
    backdropPath: fitOrNull(item.backdropPath, EDGE_PATH_MAX),
    releaseDate: fitOrNull(item.releaseDate, EDGE_SHORT_MAX),
    voteAverage: item.voteAverage,
    voteCount: item.voteCount ?? 0,
    originalLanguage: fitOrNull(item.originalLanguage, EDGE_SHORT_MAX),
  };
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

// The display columns an edge row (TitleSuggestion or CoWatchSuggestion)
// carries, as the TmdbMedia shape getSuggestionsResult returns — so the
// engine's scoring loop cannot tell a graph-served list from a live one.
interface EdgeDisplayRow {
  tmdbId: number;
  mediaType: MediaType;
  title: string;
  overview: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  releaseDate: string | null;
  voteAverage: number;
  voteCount: number;
  originalLanguage: string | null;
}

function edgeRowToMedia(row: EdgeDisplayRow): TmdbMedia {
  return {
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
  };
}

// Every edge out of the given source titles, position-ordered (edgeRowToMedia).
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
    out.set(k, list.map(edgeRowToMedia));
  }
  return out;
}

// The server's co-watch edges out of the given seeds, position-ordered, in the
// same TmdbMedia shape as readGraphSuggestions. Supplementary: a seed with no
// co-watch edges is simply absent (there is no "covered" notion here — the
// TMDB half alone decides coverage).
export async function readCoWatchSuggestions(sources: GraphSource[]): Promise<Map<string, TmdbMedia[]>> {
  const out = new Map<string, TmdbMedia[]>();
  if (sources.length === 0) return out;
  const rows = await prisma.coWatchSuggestion.findMany({
    where: { OR: sources.map((s) => ({ sourceTmdbId: s.tmdbId, sourceMediaType: s.mediaType })) },
  });
  rows.sort((a, b) => a.position - b.position);
  for (const row of rows) {
    const k = key(row.sourceTmdbId, row.sourceMediaType);
    const item = edgeRowToMedia(row);
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
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
//
// Postgres-side timeouts go first (setBatchTxTimeouts): a stuck statement is
// cancelled by Postgres before Prisma's 30s deadline instead of holding its
// locks past it, and a wait on another writer's rows fails fast. On failure it
// logs ONE line — which run, the cause, and the time per step — and rethrows;
// a P2028 alone names the query that started after the deadline, not the slow
// one before it.
interface PageWrite {
  edges: number;
  ms: number;
  steps: string;
}

// Sources (and targets) are written in one fixed key order. The warm-library
// prewarm and the recommendations run can write overlapping pages at once
// (guardrail 40 accepts that rather than serializing the two crons); taking the
// row locks in the same order keeps two such pages from deadlocking each other.
function byTitleKey(a: { tmdbId: number; mediaType: MediaType }, b: { tmdbId: number; mediaType: MediaType }): number {
  return a.tmdbId - b.tmdbId || (a.mediaType < b.mediaType ? -1 : a.mediaType > b.mediaType ? 1 : 0);
}

async function writeSourcePage(fetchedPage: FetchedSource[], run: string): Promise<PageWrite> {
  const page = [...fetchedPage].sort((a, b) => byTitleKey(a.source, b.source));
  const edges = page.flatMap(({ source, suggestions }) =>
    suggestions.map((item, position) => ({
      sourceTmdbId: source.tmdbId,
      sourceMediaType: source.mediaType,
      tmdbId: item.id,
      mediaType: toDbMediaType(item.mediaType),
      position,
      ...edgeDisplayColumns(item),
    })),
  );
  // Introduce every NEW suggestion target as a graph node, carrying just
  // enough (title + releaseDate) for the ratings pass to look it up later.
  // skipDuplicates, never an update: an existing node already holds its
  // verdict and its own metadata, and rewriting those from an edge would
  // reset a title's rated state every time any source re-linked to it (only
  // a missing release date is filled, see writeTitleNodes).
  //
  // This is what makes the quality pass a bounded indexed scan instead of a
  // distinct-over-every-edge aggregate: targets announce themselves here,
  // once, at the moment the edge that introduced them is written.
  const targets = uniqueTitleNodes(edges.map((e) => ({ tmdbId: e.tmdbId, mediaType: e.mediaType, releaseDate: e.releaseDate })))
    .sort(byTitleKey);
  // The source stamps, one updateMany per distinct edge count (at most
  // SUGGESTIONS_CACHE_MAX + 1 of them, usually a handful) in place of an
  // awaited upsert per source.
  const byCount = new Map<number, GraphSource[]>();
  for (const { source, suggestions } of page) {
    const list = byCount.get(suggestions.length);
    if (list) list.push(source);
    else byCount.set(suggestions.length, [source]);
  }

  const trace = txTrace();
  trace.step("start transaction");
  try {
    await prisma.$transaction(
      async (tx) => {
        trace.step("set timeouts");
        await setBatchTxTimeouts(tx);
        trace.step("delete old edges");
        await tx.titleSuggestion.deleteMany({
          where: {
            OR: page.map(({ source }) => ({
              sourceTmdbId: source.tmdbId,
              sourceMediaType: source.mediaType,
            })),
          },
        });
        trace.step(`insert ${edges.length} edges`);
        if (edges.length > 0) await batchCreateMany(tx.titleSuggestion, edges);

        trace.step(`add ${targets.length} titles`);
        await writeTitleNodes(tx, targets);

        // createMany skipDuplicates then updateMany, never create-catch-
        // duplicate: a caught unique violation inside a top-level interactive
        // transaction silently converts the COMMIT to a ROLLBACK (guardrail 23),
        // which would discard this whole page's edges while reporting success.
        trace.step(`stamp ${page.length} sources`);
        await batchCreateMany(
          tx.recommendationTitle,
          page.map(({ source }) => ({ tmdbId: source.tmdbId, mediaType: source.mediaType, releaseDate: null })),
        );
        const now = new Date();
        for (const [suggestionCount, sources] of byCount) {
          await tx.recommendationTitle.updateMany({
            where: { OR: sources.map((s) => ({ tmdbId: s.tmdbId, mediaType: s.mediaType })) },
            data: { suggestionsRefreshedAt: now, suggestionCount },
          });
        }
        trace.step("commit");
      },
      { timeout: BATCH_TX_TIMEOUT },
    );
  } catch (err) {
    const { kind, text } = describeTxFailure(err, {
      txTimeoutMs: BATCH_TX_TIMEOUT,
      statementTimeoutMs: BATCH_TX_STATEMENT_TIMEOUT,
      lockTimeoutMs: BATCH_TX_LOCK_TIMEOUT,
    });
    const line =
      `[recommendation-graph] edge write failed (${run}) for ${page.length} sources, ${edges.length} edges: ` +
      `${text}. Time by step: ${trace.summary()}. Those sources keep their old edges and are retried next run.`;
    // A classified cause says everything; anything else keeps the full error.
    if (kind === "other") console.error(line, err);
    else console.error(line);
    throw err;
  }

  return { edges: edges.length, ms: trace.elapsedMs(), steps: trace.summary() };
}

export interface GraphRefreshResult {
  sources: number;
  // The seed union warmRecommendationsCache asked for, and how much of it the
  // graph can now answer. requiredCovered < requiredSources is the one number
  // that predicts a skipped user, so it is reported rather than inferred.
  requiredSources: number;
  requiredCovered: number;
  sourcesRefreshed: number;
  // Fresh, inconclusive, or not reached this run (past the per-run cap, or
  // after an abort) — so refreshed + skipped + failed covers every source.
  sourcesSkipped: number;
  // Sources whose suggestions fetch failed (twice: once, then with the next
  // page) or whose write failed. They keep their old edges and are retried.
  sourcesFailed: number;
  edgesWritten: number;
  sourcesSwept: number;
  // The orphan sweep threw; the rest of the refresh ran (it is cleanup only).
  sweepFailed?: boolean;
  titlesRated: number;
  // Titles whose lookup produced nothing while a provider was locked out, so no
  // verdict was written. They are re-asked next run rather than carrying a
  // week-long "nobody answered" earned by an outage.
  verdictsDeferred: number;
  ratingsFailed: number;
  // Server co-watch edges written this run (guardrail 40c). coWatchFailed: the
  // build failed and the previous edges were kept.
  coWatchEdges: number;
  coWatchFailed?: boolean;
}

// A refresh that did nothing — the one zero literal (recommendations.ts reports
// it for a run whose refresh threw).
export function emptyGraphResult(): GraphRefreshResult {
  return {
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
    coWatchEdges: 0,
  };
}

// The sources whose edges are older than SOURCE_TTL_MS (or were never built),
// oldest first — never-built ones first of all — so a library that cannot
// finish in one run still makes monotonic progress instead of re-picking the
// same arbitrary slice every cycle.
async function staleSourcesOldestFirst(sources: GraphSource[]): Promise<GraphSource[]> {
  const refreshedAt = new Map<string, Date | null>();
  for (let i = 0; i < sources.length; i += TRIAGE_PAGE) {
    const nodes = await prisma.recommendationTitle.findMany({
      where: { OR: sources.slice(i, i + TRIAGE_PAGE).map((s) => ({ tmdbId: s.tmdbId, mediaType: s.mediaType })) },
      select: { tmdbId: true, mediaType: true, suggestionsRefreshedAt: true },
    });
    for (const n of nodes) refreshedAt.set(key(n.tmdbId, n.mediaType), n.suggestionsRefreshedAt);
  }
  const cutoff = Date.now() - SOURCE_TTL_MS;
  const builtAt = (s: GraphSource) => refreshedAt.get(key(s.tmdbId, s.mediaType))?.getTime() ?? -1;
  return sources.filter((s) => builtAt(s) < cutoff).sort((a, b) => builtAt(a) - builtAt(b));
}

// A source asked again with the next page, and why: its fetch failed, or it
// answered "nothing" on a page where nothing else answered either.
interface Carried {
  source: GraphSource;
  failed: boolean;
}

// What one page's answers allow (guardrail 40 — never stamp a source from a
// failed or inconclusive lookup). Pure.
//
// A FAILED fetch (getSuggestionsResult "failed": a timeout, a 5xx, a 429, a
// partial answer) is never written: the source keeps its old edges and its old
// stamp. It used to come back as [] — and when a neighbour on the page answered,
// that [] was stamped as "TMDB has nothing similar", deleting the source's edges
// for a week.
//
// An EMPTY answer is only a real "nothing" when TMDB is demonstrably up: some
// source on the page answered with something. A page where nothing came back
// writes nothing. Its sources are not simply dropped, though: never-built
// sources sort first, so a block TMDB genuinely has nothing for would form the
// same all-empty page every run and never be stamped. They — and the failed
// ones — are asked AGAIN with the next page and judged with its answers, so a
// zero is only ever stamped from an answer fetched alongside a non-empty one.
// Once only: a carried source that fails or comes back inconclusive again is
// counted and waits for the next run.
export function judgeSourcePage(
  page: GraphSource[],
  results: UpstreamResult<TmdbMedia[]>[],
  carriedCount: number,
): { write: FetchedSource[]; carry: Carried[]; failed: number; skipped: number } {
  const conclusive = results.some((r) => r.kind === "ok" && r.value.length > 0);
  const write: FetchedSource[] = [];
  const carry: Carried[] = [];
  let failed = 0;
  let skipped = 0;
  for (let j = 0; j < page.length; j++) {
    const r = results[j];
    const wasCarried = j < carriedCount;
    if (r.kind !== "ok") {
      if (wasCarried) failed++;
      else carry.push({ source: page[j], failed: true });
      continue;
    }
    if (!conclusive) {
      if (wasCarried) skipped++;
      else carry.push({ source: page[j], failed: false });
      continue;
    }
    write.push({ source: page[j], suggestions: r.value });
  }
  return { write, carry, failed, skipped };
}

// One source's suggestions as an answer or a failure; a throw (a cache read
// failing, say) is a failure like any other.
function fetchSourceSuggestions(source: GraphSource): Promise<UpstreamResult<TmdbMedia[]>> {
  return getSuggestionsResult(toTmdbMediaType(source.mediaType), source.tmdbId).catch((err: unknown) => upstreamFailed(err));
}

// Builds the edges for every stale source, oldest-first, up to `limit`.
// Pass Infinity for the required set — see MAX_SOURCES_PER_RUN.
// `run` names the pass in the logs ("library prewarm", "required seeds",
// "speculative") — the warm-library and warm-recommendations crons both call this.
//
// Every source lands in exactly one of sourcesRefreshed / sourcesFailed /
// sourcesSkipped. Skipped covers the fresh ones, the inconclusive ones, and the
// ones this run did not reach (past `limit`, or after an abort).
async function refreshSuggestionEdges(
  sources: GraphSource[],
  stats: GraphRefreshResult,
  limit: number,
  run: string,
  signal?: AbortSignal,
): Promise<void> {
  const stale = await staleSourcesOldestFirst(sources);
  // += : this runs twice a cycle (required set, then the speculative tail).
  stats.sourcesSkipped += sources.length - stale.length;

  const batch = Number.isFinite(limit) ? stale.slice(0, limit) : stale;
  stats.sourcesSkipped += stale.length - batch.length;
  let slowest: PageWrite | null = null;
  let carried: Carried[] = [];
  let next = 0;
  for (; next < batch.length; next += SOURCE_WRITE_PAGE) {
    // Stop when the lock's timeout aborts us; ignoring it would keep this
    // running after withAdvisoryLock released the lock (guardrail 41).
    if (signal?.aborted) break;
    const page = [...carried.map((c) => c.source), ...batch.slice(next, next + SOURCE_WRITE_PAGE)];
    const results = await settleLimit(page, SOURCE_CONCURRENCY, fetchSourceSuggestions);
    const judged = judgeSourcePage(
      page,
      results.map((r) => (r.status === "fulfilled" ? r.value : upstreamFailed(r.reason))),
      carried.length,
    );
    carried = judged.carry;
    stats.sourcesFailed += judged.failed;
    stats.sourcesSkipped += judged.skipped;

    if (judged.write.length === 0) continue;
    try {
      const written = await writeSourcePage(judged.write, run);
      stats.edgesWritten += written.edges;
      stats.sourcesRefreshed += judged.write.length;
      if (!slowest || written.ms > slowest.ms) slowest = written;
    } catch {
      // writeSourcePage logged the cause and the time per step.
      stats.sourcesFailed += judged.write.length;
    }
  }
  // The last page's carry had no next page (or the run was aborted first), and
  // an abort leaves the rest of the batch unreached.
  for (const c of carried) {
    if (c.failed) stats.sourcesFailed++;
    else stats.sourcesSkipped++;
  }
  stats.sourcesSkipped += Math.max(0, batch.length - next);

  // A page normally commits in about a second. One that took a third of the
  // transaction limit is the early sign of the stall that makes pages fail, so
  // say so once per pass (the slowest page, never one line per page).
  if (slowest && slowest.ms >= SLOW_PAGE_WRITE_MS) {
    console.warn(
      `[recommendation-graph] slowest edge write (${run}) took ${seconds(slowest.ms)} of the ${seconds(BATCH_TX_TIMEOUT)} limit. ` +
        `Time by step: ${slowest.steps}`,
    );
  }
}

// The trending/popular pool the cold-start shelf is filled from, trending first
// (the freshest signal; a title on both lists then reads as trending). The ONE
// read both warmFallbackPool and the per-user buildFallbackCandidates use, so
// the warm here is exactly what the compute then hits in the cache.
export async function fetchFallbackPool(): Promise<TmdbMedia[]> {
  const [trending, popMovies, popTV] = await Promise.all([getTrending(), getPopularMovies(), getPopularTV()]);
  return [...trending, ...popMovies, ...popTV];
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
    const pool = uniqueTitleNodes((await fetchFallbackPool()).map((item) => ({
      tmdbId: item.id,
      mediaType: toDbMediaType(item.mediaType),
      releaseDate: fitOrNull(item.releaseDate, EDGE_SHORT_MAX),
    })));
    await writeTitleNodes(prisma, pool);
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
    const page = required.slice(i, i + TRIAGE_PAGE).map((s) => ({ sourceTmdbId: s.tmdbId, sourceMediaType: s.mediaType }));
    // The co-watch targets are candidates real users will see too, so they
    // share the priority budget (guardrail 40c).
    const [tmdbRows, coWatchRows] = await Promise.all([
      prisma.titleSuggestion.groupBy({ by: ["tmdbId", "mediaType"], where: { OR: page } }),
      prisma.coWatchSuggestion.groupBy({ by: ["tmdbId", "mediaType"], where: { OR: page } }),
    ]);
    for (const r of tmdbRows) out.set(key(r.tmdbId, r.mediaType), { tmdbId: r.tmdbId, mediaType: r.mediaType });
    for (const r of coWatchRows) out.set(key(r.tmdbId, r.mediaType), { tmdbId: r.tmdbId, mediaType: r.mediaType });
  }
  return [...out.values()];
}

// ── Server co-watching (guardrail 40c) ─────────────────────────────────────
// "People on this server who watched X also watched Y", from the server's own
// records: PlayHistory plus ServerWatchedTitle (which reaches past the install).
// Server-wide — the same for every viewer — so it is built here, once, and the
// per-user pass only reads it (guardrail 40). Rebuilt whole each run.
//
// PRIVACY is the design constraint, not an afterthought. A "person" is a
// Summonarr account (every identity linked to it counts once) or, for an
// identity linked to no account, that identity. An edge X → Y exists only when:
//   - at least COWATCH_MIN_VIEWERS distinct people watched BOTH — so it never
//     rests on one or two people's viewing;
//   - at least COWATCH_MIN_NON_VIEWERS people on the server did NOT watch both.
//     The viewer it is shown to is always one of them (a title they watched is
//     excluded from their shelf), so this guarantees at least one OTHER person
//     also didn't: no edge can tell a viewer that everyone else watched it;
//   - and the server has at least COWATCH_MIN_PEOPLE people with any history.
// On top of that, a co-watch pick carries the same "Because you watched X" line
// as a TMDB pick, never a "people here watched" one, so a viewer cannot even
// tell which picks came from co-watching.
//
// Scored by cosine similarity (together / √(viewersX × viewersY)), so a title
// everyone watched does not top every list just for being popular.
//
// OPT-IN: the whole thing is behind FOR_YOU_COWATCH_FEATURE_KEY, default OFF.
export { FOR_YOU_COWATCH_FEATURE_KEY };
export const COWATCH_MIN_VIEWERS = 3;
export const COWATCH_MIN_NON_VIEWERS = 2;
export const COWATCH_MIN_PEOPLE = COWATCH_MIN_VIEWERS + COWATCH_MIN_NON_VIEWERS;
export const COWATCH_PER_SOURCE = 20;
// Bounds the table (rows are wide, like TitleSuggestion's).
const COWATCH_MAX_EDGES = 200_000;
// The build is one aggregate over every person's watched titles. Pairing is a
// self-join per person, so its cost is the SUM of (titles per person)² — one
// viewer with 20k imported titles alone would be 400M rows. So each person
// pairs only their COWATCH_MAX_TITLES_PER_PERSON most recently watched popular
// titles (only titles at least COWATCH_MIN_VIEWERS people watched can pair at
// all). The statement timeout stays as a safety valve: on a timeout the
// previous edges stay and the next run tries again.
const COWATCH_MAX_TITLES_PER_PERSON = 500;
const COWATCH_STATEMENT_TIMEOUT = "60s";
const COWATCH_TX_TIMEOUT_MS = 90_000;

// One edge row of the co-watch aggregate, checked at runtime: $queryRaw's type
// parameter is only a promise about the SQL, not a check of what came back.
const CoWatchEdgeRowSchema = v.object({
  srcId: v.int(),
  srcType: v.string(),
  dstId: v.int(),
  dstType: v.string(),
  together: v.int(),
  position: v.int(),
});
type CoWatchEdgeRow = Infer<typeof CoWatchEdgeRowSchema>;

type CoWatchDisplay = Omit<TmdbMedia, "id" | "mediaType">;

const str = (x: unknown): string | null => (typeof x === "string" ? x : null);
const finiteOr = (x: unknown, fallback: number): number => (typeof x === "number" && Number.isFinite(x) ? x : fallback);

// The display fields of a cached `:details` blob, read field by field: the blob
// is JSON from the cache table, and these values go straight into DB columns.
// Null when it has no usable title. Pure.
export function coWatchDisplayFromBlob(blob: unknown): CoWatchDisplay | null {
  if (!blob || typeof blob !== "object" || Array.isArray(blob)) return null;
  const b = blob as Record<string, unknown>;
  const title = str(b.title);
  if (!title) return null;
  const releaseDate = str(b.releaseDate);
  const originalLanguage = str(b.originalLanguage);
  return {
    title,
    overview: str(b.overview) ?? "",
    posterPath: str(b.posterPath),
    backdropPath: str(b.backdropPath),
    releaseDate,
    releaseYear: releaseDate?.slice(0, 4) ?? null,
    voteAverage: finiteOr(b.voteAverage, 0),
    voteCount: finiteOr(b.voteCount, 0),
    ...(originalLanguage ? { originalLanguage } : {}),
  };
}

// TMDB display fields for co-watch targets, from LOCAL caches only — the build
// makes no TMDB call. Co-watched titles are by definition watched on this
// server, so warm-library has almost always cached their details; a title with
// neither a details blob nor a TmdbMediaCore row is left out this run.
async function coWatchDisplay(targets: GraphSource[]): Promise<Map<string, CoWatchDisplay>> {
  const out = new Map<string, CoWatchDisplay>();
  for (let i = 0; i < targets.length; i += TRIAGE_PAGE) {
    const page = targets.slice(i, i + TRIAGE_PAGE);
    const blobKeys = page.map((t) => tmdbDetailsKey(t.mediaType, t.tmdbId));
    const blobs = await getCacheStaleMany<unknown>(blobKeys);
    const missing: GraphSource[] = [];
    page.forEach((t, j) => {
      const shown = coWatchDisplayFromBlob(blobs.get(blobKeys[j])?.value);
      if (shown) out.set(key(t.tmdbId, t.mediaType), shown);
      else missing.push(t);
    });
    if (missing.length === 0) continue;
    const cores = await prisma.tmdbMediaCore.findMany({
      where: { OR: missing.map((t) => ({ tmdbId: t.tmdbId, mediaType: t.mediaType })) },
      select: { tmdbId: true, mediaType: true, title: true, posterPath: true, voteAverage: true },
    });
    for (const c of cores) {
      if (!c.title) continue;
      out.set(key(c.tmdbId, c.mediaType), {
        title: c.title,
        overview: "",
        posterPath: c.posterPath,
        backdropPath: null,
        releaseDate: null,
        releaseYear: null,
        voteAverage: c.voteAverage,
        voteCount: 0,
      });
    }
  }
  return out;
}

// One aggregate, in the database: the per-person title sets never leave
// Postgres, only the edges that clear every floor do.
//
// The per-person cap (COWATCH_MAX_TITLES_PER_PERSON) can only UNDER-count
// `together`, which keeps the "at least COWATCH_MIN_VIEWERS watched both" floor
// safe. It would NOT keep the non-viewer floor safe — an under-counted pair could
// pass while everyone else watched both — so once any person is capped that floor
// is held on the uncapped viewer counts instead: at most total − 2 people watched
// one of the two titles, so at least two did not watch both. Uncapped (the usual
// case) every floor reads exactly as it always did.
//
// `people` and `capped` are MATERIALIZED: both are one-row aggregates
// cross-joined into the scored set, and inlined the planner (misjudging them as
// tiny) re-ran the COUNT(DISTINCT) once per candidate pair. Measured on Postgres
// 17 with ten heavy viewers: over 120s inlined, about 1.5s materialized.
async function queryCoWatchEdges(): Promise<CoWatchEdgeRow[]> {
  const raw = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT set_config('statement_timeout', ${COWATCH_STATEMENT_TIMEOUT}, true)`);
      return tx.$queryRaw<unknown>(Prisma.sql`
        WITH watched AS (
          SELECT "mediaServerUserId", "tmdbId", "mediaType", MAX("startedAt") AS at FROM "PlayHistory"
            WHERE "watched" = true AND "tmdbId" IS NOT NULL AND "mediaType" IS NOT NULL
            GROUP BY 1, 2, 3
          UNION ALL
          SELECT "mediaServerUserId", "tmdbId", "mediaType", "lastWatchedAt" AS at FROM "ServerWatchedTitle"
            WHERE "plays" > 0
        ),
        person_titles AS (
          SELECT COALESCE(m."userId", m."id") AS person, w."tmdbId", w."mediaType", MAX(w.at) AS at
          FROM watched w JOIN "MediaServerUser" m ON m."id" = w."mediaServerUserId"
          GROUP BY 1, 2, 3
        ),
        people AS MATERIALIZED (
          SELECT COUNT(DISTINCT person)::int AS total FROM person_titles
        ),
        popular AS (
          SELECT "tmdbId", "mediaType", COUNT(*)::int AS viewers
          FROM person_titles
          GROUP BY "tmdbId", "mediaType"
          HAVING COUNT(*) >= ${COWATCH_MIN_VIEWERS}
        ),
        ranked_pt AS (
          SELECT p.person, p."tmdbId", p."mediaType",
                 ROW_NUMBER() OVER (
                   PARTITION BY p.person
                   ORDER BY p.at DESC NULLS LAST, p."tmdbId" ASC, p."mediaType" ASC
                 ) AS rn
          FROM person_titles p JOIN popular USING ("tmdbId", "mediaType")
        ),
        pt AS (
          SELECT person, "tmdbId", "mediaType" FROM ranked_pt WHERE rn <= ${COWATCH_MAX_TITLES_PER_PERSON}
        ),
        capped AS MATERIALIZED (
          SELECT EXISTS (SELECT 1 FROM ranked_pt WHERE rn > ${COWATCH_MAX_TITLES_PER_PERSON}) AS hit
        ),
        pairs AS (
          SELECT a."tmdbId" AS "srcId", a."mediaType" AS "srcType",
                 b."tmdbId" AS "dstId", b."mediaType" AS "dstType",
                 COUNT(*)::int AS together
          FROM pt a
          JOIN pt b ON a.person = b.person
                   AND (a."tmdbId" <> b."tmdbId" OR a."mediaType" <> b."mediaType")
          GROUP BY 1, 2, 3, 4
          HAVING COUNT(*) >= ${COWATCH_MIN_VIEWERS}
        ),
        scored AS (
          SELECT p.*, p.together / sqrt(ps.viewers::float8 * pd.viewers::float8) AS score
          FROM pairs p
          JOIN popular ps ON ps."tmdbId" = p."srcId" AND ps."mediaType" = p."srcType"
          JOIN popular pd ON pd."tmdbId" = p."dstId" AND pd."mediaType" = p."dstType"
          CROSS JOIN people
          CROSS JOIN capped
          WHERE people.total >= ${COWATCH_MIN_PEOPLE}
            AND p.together <= people.total - ${COWATCH_MIN_NON_VIEWERS}
            AND (NOT capped.hit OR LEAST(ps.viewers, pd.viewers) <= people.total - ${COWATCH_MIN_NON_VIEWERS})
        ),
        ranked AS (
          SELECT s.*, (ROW_NUMBER() OVER (
            PARTITION BY s."srcId", s."srcType"
            ORDER BY s.score DESC, s.together DESC, s."dstId" ASC, s."dstType" ASC
          ) - 1)::int AS position
          FROM scored s
        )
        SELECT "srcId", "srcType"::text AS "srcType", "dstId", "dstType"::text AS "dstType", together, position
        FROM ranked
        WHERE position < ${COWATCH_PER_SOURCE}
        ORDER BY "srcId", "srcType", position
        LIMIT ${COWATCH_MAX_EDGES}
      `);
    },
    { timeout: COWATCH_TX_TIMEOUT_MS },
  );
  const checked = check(v.array(CoWatchEdgeRowSchema), raw);
  // A row of the wrong shape fails the build (the previous edges stay).
  if (!checked.ok) throw new Error(`co-watch aggregate returned an unexpected row: ${checked.error}`);
  return checked.value;
}

function asMediaType(v: string): MediaType | null {
  return v === "MOVIE" || v === "TV" ? v : null;
}

// Rebuild the co-watch edges. Best-effort: on any failure the previous edges
// stay (they are a week-stale signal at worst) and the run carries on.
//
// Behind FOR_YOU_COWATCH_FEATURE_KEY, OFF by default: For You is then built
// only from each viewer's own records. Off also DELETES any edges a previous
// "on" left behind, so no shared signal outlives the switch.
async function refreshCoWatchEdges(stats: GraphRefreshResult, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  try {
    if (!(await isFeatureEnabled(FOR_YOU_COWATCH_FEATURE_KEY))) {
      await prisma.coWatchSuggestion.deleteMany({});
      return;
    }
    const raw = await queryCoWatchEdges();
    if (signal?.aborted) return;
    const targets = new Map<string, GraphSource>();
    for (const r of raw) {
      const mediaType = asMediaType(r.dstType);
      if (mediaType) targets.set(key(r.dstId, mediaType), { tmdbId: r.dstId, mediaType });
    }
    const display = await coWatchDisplay([...targets.values()]);
    // Positions are renumbered after dropping targets with no display data, so
    // each source's list stays 0-based and gapless (positionFactor scores it).
    const nextPosition = new Map<string, number>();
    const edges: Prisma.CoWatchSuggestionCreateManyInput[] = [];
    for (const r of raw) {
      const srcType = asMediaType(r.srcType);
      const dstType = asMediaType(r.dstType);
      if (!srcType || !dstType) continue;
      const shown = display.get(key(r.dstId, dstType));
      if (!shown) continue;
      const src = key(r.srcId, srcType);
      const position = nextPosition.get(src) ?? 0;
      nextPosition.set(src, position + 1);
      edges.push({
        sourceTmdbId: r.srcId,
        sourceMediaType: srcType,
        tmdbId: r.dstId,
        mediaType: dstType,
        position,
        viewers: r.together,
        ...edgeDisplayColumns(shown),
      });
    }
    await prisma.$transaction(
      async (tx) => {
        await tx.coWatchSuggestion.deleteMany({});
        if (edges.length > 0) await batchCreateMany(tx.coWatchSuggestion, edges);
        // Targets become graph nodes so the ratings pass can give them a
        // verdict (skipDuplicates: an existing node keeps its verdict).
        await writeTitleNodes(tx, uniqueTitleNodes(edges.map((e) => ({ tmdbId: e.tmdbId, mediaType: e.mediaType, releaseDate: e.releaseDate ?? null }))));
      },
      { timeout: BATCH_TX_TIMEOUT },
    );
    stats.coWatchEdges = edges.length;
  } catch (err) {
    stats.coWatchFailed = true;
    console.warn("[recommendation-graph] co-watch build failed; the previous edges stay:", err instanceof Error ? err.message : err);
  }
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
      if (out.length >= limit) break;
    }
  }
  return out;
}

// The titles this run rates, PRIORITY-FIRST: the stale suggestion targets of
// the REQUIRED sources (what real users will actually see), then the general
// oldest-first scan with whatever budget is left — never-rated titles first.
async function verdictWorklist(required: GraphSource[]): Promise<TitleNode[]> {
  const priority = required.length > 0
    ? await staleQualityTitles(await requiredTargets(required), MAX_QUALITY_TITLES_PER_RUN)
    : [];
  const budget = Math.max(0, MAX_QUALITY_TITLES_PER_RUN - priority.length);
  if (budget === 0) return priority;

  const filler = await prisma.recommendationTitle.findMany({
    where: { OR: [{ qualityRatedAt: null }, { qualityRatedAt: { lt: new Date(Date.now() - QUALITY_TTL_MS) } }] },
    // nulls first: a title that has never been rated is worth more than a
    // re-derivation of a verdict that is merely a week old.
    orderBy: { qualityRatedAt: { sort: "asc", nulls: "first" } },
    take: budget,
    select: { tmdbId: true, mediaType: true, releaseDate: true },
  });
  // The filler scan can re-list a priority title; rating one twice would spend
  // budget on a verdict already written this run.
  return uniqueTitleNodes([...priority, ...filler]);
}

// One batch's titles through the ratings providers, as bare TmdbMedia.
//
// blocking:true fetches the misses inline; this runs inside a cron request
// whose response must not be sent before the verdicts are written.
//
// deferToAfter:false keeps the rest inline too. blocking:true alone still hands
// every stale row's refresh to after(), and Next starts all of a request's
// after() callbacks at once when the response closes. At one callback per
// QUALITY_BATCH that is up to 50 batches of MDBList POSTs and OMDB/TMDB
// refreshes landing together, on top of whichever cron runs next. Inline, each
// batch's refresh finishes before the next batch begins, and it stays inside
// the advisory lock this run holds.
function rateTitles(slice: TitleNode[]): Promise<TmdbMedia[]> {
  return attachRatingsUnified(
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
      // Deliberately zero, and the stored verdict is deliberately TMDB-FREE:
      // the prior's TMDB term is scored per CANDIDATE at read time, where that
      // candidate's own voteAverage/voteCount are known (they ride on the edge
      // row). Feeding a placebo pair in here would bake a wrong TMDB
      // contribution into a verdict shared by every viewer — qualityScoreOf
      // gates that term on the vote count, so zero is exactly "TMDB abstains",
      // which is what this needs.
      voteAverage: 0,
      voteCount: 0,
    })),
    { blocking: true, deferToAfter: false, background: true },
  );
}

// The verdict rows a rated batch earns. A NULL verdict ("nobody answered") can
// only be trusted if the providers were reachable: attachRatingsUnified hides
// its own upstream failures, so an outage would otherwise stamp week-long null
// verdicts, and the obscurity penalty would then demote every low-vote title it
// touched. A real verdict is authoritative however the rest of the batch fared
// — a provider answered for THIS title. Pure.
export function verdictRowsFor(
  rated: TmdbMedia[],
  providersAnswering: boolean,
): { rows: { tmdbId: number; mediaType: MediaType; quality: number | null; evidence: number }[]; deferred: number } {
  const rows: { tmdbId: number; mediaType: MediaType; quality: number | null; evidence: number }[] = [];
  let deferred = 0;
  for (const media of rated) {
    const verdict = qualityScoreOf(media);
    if (verdict === null && !providersAnswering) {
      deferred++;
      continue;
    }
    rows.push({ tmdbId: media.id, mediaType: toDbMediaType(media.mediaType), quality: verdict?.quality ?? null, evidence: verdict?.evidence ?? 0 });
  }
  return { rows, deferred };
}

// When a verdict row is stamped. While a provider was not answering, a real
// verdict may rest on fewer sources than the title has, so it is stamped to
// fall stale after PARTIAL_VERDICT_RECHECK_MS rather than QUALITY_TTL_MS: still
// written (guardrail 40), but re-derived within a day instead of in a week.
export function verdictStamp(providersAnswering: boolean, now: number = Date.now()): Date {
  return new Date(providersAnswering ? now : now - QUALITY_TTL_MS + PARTIAL_VERDICT_RECHECK_MS);
}

// Resolves quality verdicts for the titles the engine will actually score.
//
// PRIORITY-FIRST. Nothing rates a candidate on demand, so an unrated one is
// ranked on relevance alone until some run reaches it (verdictWorklist).
async function refreshQualityVerdicts(required: GraphSource[], stats: GraphRefreshResult, signal?: AbortSignal): Promise<void> {
  const stale = await verdictWorklist(required);
  if (stale.length === 0) return;

  for (let i = 0; i < stale.length; i += QUALITY_BATCH) {
    if (signal?.aborted) break;
    // Both providers locked out means every remaining batch would resolve to
    // "nobody answered" and then STAMP that as a verdict for a week. Stop, and
    // let the next run rate them for real. Mirrors prewarmMdblistCache's
    // early exit; either provider still answering is reason enough to continue.
    if (isMdblistQuotaLocked(BACKGROUND_RATINGS) && isOmdbQuotaLocked()) {
      console.warn(`[recommendation-graph] both ratings providers are quota-locked — stopping after ${stats.titlesRated} verdict(s)`);
      break;
    }
    const slice = stale.slice(i, i + QUALITY_BATCH);
    // Read before the batch, compared after it (see providersAnswering below).
    const mdblistFailuresBefore = mdblistTransportFailureCount();
    let rated: TmdbMedia[];
    try {
      rated = await rateTitles(slice);
    } catch (err) {
      stats.ratingsFailed += slice.length;
      console.warn("[recommendation-graph] ratings lookup failed for a batch; verdicts unchanged:", err);
      continue;
    }

    // The try/catch above does not fire on a network outage (attachRatingsUnified
    // hides its own upstream failures), so whether the providers answered is
    // read off their own state AFTER the batch, so a lockout tripped mid-batch
    // is seen. This is why the transport circuit breakers (omdb.ts, mdblist.ts)
    // matter: without them a run of timeouts would never set this flag. MDBList
    // had none until 2026-10-28, so a night of MDBList timeouts stamped null
    // verdicts here.
    //
    // The breaker alone still let the FIRST batch of a storm through: it trips
    // on the fifth failure in a row, and one batch sends about two MDBList
    // requests (a POST per media type). So any MDBList request that got no
    // answer during this batch also counts as not answering.
    //
    // MDBList also reads as not answering once this cron is down to the reserve
    // the plan setting keeps for pages: it stopped asking, so a null is not a verdict.
    //
    // And a key MDBList refused is MDBList not answering either.
    const mdblistFailedInBatch = mdblistTransportFailureCount() !== mdblistFailuresBefore;
    const providersAnswering = !isMdblistQuotaLocked(BACKGROUND_RATINGS) && !isOmdbQuotaLocked() && !mdblistFailedInBatch && !isMdblistKeyRejected();

    const { rows, deferred } = verdictRowsFor(rated, providersAnswering);
    stats.verdictsDeferred += deferred;
    if (rows.length === 0) continue;

    // ONE statement per batch, in place of an awaited round trip per title.
    // qualityRatedAt is stamped even when nothing answered — PROVIDED the
    // providers were reachable (see above). "Asked, nobody answered" is the
    // state the obscurity damp keys on, and leaving it null would both lose
    // that verdict and re-ask every run forever. A failed write leaves the
    // whole batch unrated, so it is re-asked next run.
    const values = rows.map((r) =>
      Prisma.sql`(${r.tmdbId}::int, ${r.mediaType}::"MediaType", ${r.quality}::float8, ${r.evidence}::float8)`,
    );
    try {
      stats.titlesRated += await prisma.$executeRaw(Prisma.sql`
        UPDATE "RecommendationTitle" AS r
        SET "quality" = v."quality", "evidence" = v."evidence", "qualityRatedAt" = ${verdictStamp(providersAnswering)}
        FROM (VALUES ${Prisma.join(values)}) AS v("tmdbId", "mediaType", "quality", "evidence")
        WHERE r."tmdbId" = v."tmdbId" AND r."mediaType" = v."mediaType"
      `);
    } catch (err) {
      stats.ratingsFailed += rows.length;
      console.error(`[recommendation-graph] verdict write failed for a batch of ${rows.length}; they are re-asked next run:`, err);
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
//
// The scan reads OLDEST stamps first. Built sources can outnumber the read cap
// (the required set alone may hold more), and an unordered take would examine an
// arbitrary slice each run, so an orphan could hide past it indefinitely. An
// orphan is never refreshed again, so its stamp only ages, and oldest-first
// reaches it (the stamp index serves the order).
//
// Observes the lock's signal between pages and returns, never throws
// (guardrail 41): a half-done sweep is just finished by a later run.
async function sweepOrphanSources(live: Set<string>, stats: GraphRefreshResult, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  const built = await prisma.recommendationTitle.findMany({
    where: { suggestionsRefreshedAt: { not: null } },
    orderBy: { suggestionsRefreshedAt: "asc" },
    select: { tmdbId: true, mediaType: true },
    take: MAX_GRAPH_SOURCES,
  });
  const orphans = built
    .filter((b) => !live.has(key(b.tmdbId, b.mediaType)))
    .slice(0, MAX_ORPHAN_SWEEP_PER_RUN);
  if (orphans.length === 0) return;

  for (let i = 0; i < orphans.length; i += SOURCE_WRITE_PAGE) {
    if (signal?.aborted) return;
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
  const stats: GraphRefreshResult = emptyGraphResult();
  if (sources.length > 0) await refreshSuggestionEdges(sources, stats, MAX_PREWARM_EDGE_SOURCES_PER_RUN, "library prewarm", opts.signal);

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
  if (!tmdbAuth()) return emptyGraphResult();

  const stats: GraphRefreshResult = emptyGraphResult();

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
  if (required.length > 0) await refreshSuggestionEdges(required, stats, Infinity, "required seeds", opts.signal);
  stats.requiredCovered = required.length > 0 ? await countCovered(required) : 0;

  // 1b. The server's private co-watching (guardrail 40c). Local data only, no
  //     upstream call; before the verdict pass so its targets get rated.
  await refreshCoWatchEdges(stats, opts.signal);

  // 2. Speculative pre-warming for seeds that do not exist yet — the library,
  //    and the wider watched/watchlist/request pools beyond what any active user
  //    currently seeds from. Capped, oldest-first, and starvable without cost.
  const { sources, complete } = await collectGraphSources();
  const requiredKeys = new Set(required.map((r) => key(r.tmdbId, r.mediaType)));
  const tail = sources.filter((s) => !requiredKeys.has(key(s.tmdbId, s.mediaType)));
  stats.sources = required.length + tail.length;
  if (tail.length > 0) await refreshSuggestionEdges(tail, stats, MAX_SOURCES_PER_RUN, "speculative", opts.signal);

  // 3. Reap sources that have left the server. Only on a COMPLETE source list —
  //    see SourceSet.complete. The required set is added to `live` too: a seed
  //    is still in use by definition, so it must never look departed.
  //
  //    Cleanup only, so a failure here is reported and survived: the required
  //    edges are already written, and letting a transient sweep error throw out
  //    of the refresh would skip the verdicts and recompute no user at all.
  if (complete) {
    const live = new Set([...requiredKeys, ...tail.map((s) => key(s.tmdbId, s.mediaType))]);
    try {
      await sweepOrphanSources(live, stats, opts.signal);
    } catch (err) {
      stats.sweepFailed = true;
      console.warn("[recommendation-graph] orphan sweep failed; departed sources keep their edges until a later run:", err);
    }
  }

  // 4. Warm the trending/popular pool so the cold-start path's reads are cache
  //    hits, and register its titles for rating.
  await warmFallbackPool();

  // 5. Verdicts, priority-first over the required set's own candidates.
  await refreshQualityVerdicts(required, stats, opts.signal);

  return stats;
}
