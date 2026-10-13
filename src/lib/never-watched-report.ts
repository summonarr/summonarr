// The never-watched REPORT (guardrail 14d): every library title, and every
// season of a watched show, that nobody has watched in this server's recorded
// history — with the space it takes, how far that claim can be trusted, and
// whether Library cleanup could delete it right now.
//
// Built on the cleanup engine's own loader (loadCleanupTitles → the shared
// never-watched facts) and judged by the cleanup engine itself, so "eligible"
// on this page is EXACTLY what the delete route's dry run will decide. Nothing
// here deletes, and nothing here writes.
import { isFeatureEnabled } from "./features";
import { failedArrInstances, getCachedArrLibraryIndex, peekCachedArrLibraryIndex, type ArrLibraryEntry, type ArrLibraryIndex } from "./library-cleanup-arr";
import {
  CLEANUP_FEATURE_KEY,
  fillAiring,
  loadCleanupSettings,
  loadCleanupTitles,
  type CleanupTitle,
} from "./library-cleanup-data";
import { cleanupKey, evaluateCleanupTitle, type CleanupExclusion, type CleanupMediaType, type CleanupRule } from "./library-cleanup";
import { currentActivityGeneration } from "./play-history";
import { processSingleton } from "./process-singleton";
import { coalesce } from "./concurrency";
import { loadLibraryWatchFacts, NEVER_WATCHED_FEATURE_KEY, type LibraryWatchTitle, type SharedWatchFacts } from "./never-watched-data";
import { hasPermission, Permission } from "./permissions";
import { upstreamErrorCode, type UpstreamErrorCode } from "./upstream-watch";
import {
  isNeverWatchedState,
  seasonSizeIfAgreed,
  stateMatchesFilter,
  type NwQuery,
  type NwReason,
  type NwState,
  type NwUpstreamHealth,
} from "./never-watched";

export interface NwArrCopy {
  service: "radarr" | "sonarr";
  instance: string;
  sizeOnDisk: number;
}

export interface NwTitleRow {
  kind: "title";
  tmdbId: number;
  mediaType: CleanupMediaType;
  title: string;
  posterPath: string | null;
  year: string | null;
  servers: string[];
  addedAt: string | null;
  shelfStart: string | null;
  state: NwState;
  reason: NwReason | null;
  reasonServers: string[];
  windowStart: string | null;
  days: number | null;
  fullyObserved: boolean;
  softPlays: number;
  softServers: string[];
  arr: NwArrCopy[];
  sizeOnDisk: number | null;
  protected: boolean;
  // What Library cleanup's engine says about it right now.
  cleanup: { matched: CleanupRule[]; excludedBy: CleanupExclusion[]; candidate: boolean };
  // candidate AND something to delete AND cleanup switched on AND every
  // instance of its service could be listed — exactly what a dry run would include.
  eligible: boolean;
}

export interface NwSeasonRow {
  kind: "season";
  tmdbId: number;
  mediaType: "TV";
  title: string;
  posterPath: string | null;
  year: string | null;
  servers: string[];
  seasonNumber: number;
  episodes: number;
  state: NwState;
  reason: NwReason | null;
  reasonServers: string[];
  windowStart: string | null;
  days: number | null;
  fullyObserved: boolean;
  // The show is still airing and this is its latest season.
  airing: boolean;
  sizeOnDisk: number | null;
  // Radarr/Sonarr and the media server disagree on what this season is.
  sizeMismatch: boolean;
}

export interface NwCoverageRow {
  server: string;
  source: "plex" | "jellyfin";
  tracked: boolean;
  since: string | null;
  // A library title sits on this server (ServerCoverage.holds) — only these can
  // hold a title back, so only these are named as unchecked.
  holds: boolean;
  upstream: {
    health: NwUpstreamHealth;
    fetchedAt: string | null;
    attemptedAt: string | null;
    entries: number;
    matched: number;
    samples: number;
    agreed: number;
    // The stored English failure text (logs, older pages) and its code — the
    // page translates the code (upstreamErrorCode), never the text.
    error: string | null;
    errorCode: UpstreamErrorCode | null;
    httpStatus: number | null;
  };
}

export interface NwTotals {
  never: { titles: number; bytes: number; unsized: number };
  seasons: { count: number; bytes: number };
  eligible: { titles: number; bytes: number };
  possible: number;
  unknown: number;
  libraryTitles: number;
}

export interface NeverWatchedReport {
  titles: NwTitleRow[];
  seasons: NwSeasonRow[];
  totals: NwTotals;
  coverage: NwCoverageRow[];
  trackingOn: boolean;
  historyStart: string | null;
  unplacedPlays: number;
  softPlays: number;
  arrErrors: ArrLibraryIndex["errors"];
  sizesAsOf: string | null;
  cleanupEnabled: boolean;
  neverWatchedDays: number;
  requireUpstreamCheck: boolean;
  computedAt: string;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

// The delete route refuses every title of a service while ANY instance of it
// failed to list (it may hold a copy nobody can see, and a partial removal
// would half-delete the title), so the report can't call one eligible either.
// One rule for both: failedArrInstances.
export function arrServiceReadable(errors: ArrLibraryIndex["errors"], mediaType: CleanupMediaType): boolean {
  return failedArrInstances({ errors }, mediaType).length === 0;
}

// The titles whose rows the report shapes — a title that isn't watched, and a
// watched show with a season that isn't — get the delete route's own targets
// (resolveArrTargets: tvdb-only Sonarr series included), resolved inside the
// loader before the requests are read, so their sizes, season sizes and
// "eligible" are the dry run's. A private byKey-only lookup was a second
// definition: every Sonarr v3 show read "not in Radarr/Sonarr" here while the
// dry run planned its delete.
const needsTargets = (w: LibraryWatchTitle) =>
  w.verdict.state !== "watched" || (w.seasons ?? []).some((s) => s.state !== "watched");

// `opts.shared` (the /admin/stats storage section, which computes the cleanup
// report from the same load — SharedWatchFacts) supplies the Radarr/Sonarr index
// it was loaded for, its `now` and the facts themselves; everything else is
// computed here exactly as without it.
export async function computeNeverWatchedReport(
  opts: { now?: Date; freshArr?: boolean; shared?: SharedWatchFacts } = {},
): Promise<NeverWatchedReport> {
  const shared = opts.shared;
  if (shared && opts.now && opts.now.getTime() !== shared.now.getTime()) {
    throw new Error("[never-watched] shared watch facts were loaded for another now");
  }
  const now = shared?.now ?? opts.now ?? new Date();
  const [{ index: arr, at: arrAt }, settings, cleanupEnabled] = await Promise.all([
    shared ? { index: shared.arr, at: shared.arrAt } : getCachedArrLibraryIndex({ fresh: opts.freshArr }),
    loadCleanupSettings(),
    isFeatureEnabled(CLEANUP_FEATURE_KEY),
  ]);
  // "cached": a GET never waits on TMDB's tmdb→tvdb cross-reference (a miss is
  // filled in the background for the next load — CrossRefMode). Resolving every
  // unwatched show live made a cold report one TMDB call per show.
  const { titles, ctx, targets } = await loadCleanupTitles(arr, undefined, { seasons: true, now, resolveTargets: needsTargets, crossRef: "cached", shared });
  const copiesOf = (t: { tmdbId: number; mediaType: CleanupMediaType }): readonly ArrLibraryEntry[] =>
    targets?.get(cleanupKey(t.tmdbId, t.mediaType)) ?? [];

  // The still-airing status the first read left unknown (a tvdb-only Sonarr
  // series, then TMDB's cached status — fillAiring, the dry run's own pass) —
  // only for the rows that show it: never-watched shows (the airing exclusion)
  // and watched shows with never-watched seasons (the latest season's chip).
  const needAiring = titles.filter((t) =>
    t.mediaType === "TV" && t.airing === null &&
    (t.watch.state !== "watched" || (t.seasons ?? []).some((s) => s.state !== "watched")),
  );
  if (needAiring.length > 0) await fillAiring(needAiring, arr, "cached");

  const titleRows: NwTitleRow[] = [];
  const seasonRows: NwSeasonRow[] = [];
  const totals: NwTotals = {
    never: { titles: 0, bytes: 0, unsized: 0 },
    seasons: { count: 0, bytes: 0 },
    eligible: { titles: 0, bytes: 0 },
    possible: 0,
    unknown: 0,
    libraryTitles: titles.length,
  };

  for (const t of titles) {
    if (t.watch.state === "watched") {
      for (const row of seasonRowsFor(t, copiesOf(t))) {
        seasonRows.push(row);
        if (isNeverWatchedState(row.state)) {
          totals.seasons.count++;
          totals.seasons.bytes += row.sizeOnDisk ?? 0;
        }
      }
      continue;
    }
    const verdict = evaluateCleanupTitle(t, settings, { now });
    const copies = copiesOf(t);
    const sizeOnDisk = copies.length === 0 ? null : copies.reduce((n, e) => n + e.sizeOnDisk, 0);
    const eligible = cleanupEnabled && verdict.candidate && copies.length > 0 && arrServiceReadable(arr.errors, t.mediaType);
    titleRows.push({
      kind: "title",
      tmdbId: t.tmdbId,
      mediaType: t.mediaType,
      title: t.title,
      posterPath: t.posterPath,
      year: t.year,
      servers: t.servers,
      addedAt: iso(t.addedAt),
      shelfStart: iso(t.shelfStart),
      state: t.watch.state,
      reason: t.watch.reason,
      reasonServers: t.watch.reasonServers,
      windowStart: iso(t.watch.windowStart),
      days: t.watch.days,
      fullyObserved: t.watch.fullyObserved,
      softPlays: t.evidence.softPlays,
      softServers: t.evidence.softServers,
      arr: copies.map((e) => ({ service: e.service, instance: e.instance, sizeOnDisk: e.sizeOnDisk })),
      sizeOnDisk,
      protected: t.protected,
      cleanup: { matched: verdict.matched, excludedBy: verdict.excludedBy, candidate: verdict.candidate },
      eligible,
    });
    if (isNeverWatchedState(t.watch.state)) {
      totals.never.titles++;
      if (sizeOnDisk === null) totals.never.unsized++;
      else totals.never.bytes += sizeOnDisk;
    } else if (t.watch.state === "possiblyWatched") totals.possible++;
    else if (t.watch.state === "unobservable") totals.unknown++;
    if (eligible) {
      totals.eligible.titles++;
      totals.eligible.bytes += sizeOnDisk ?? 0;
    }
  }

  return {
    titles: titleRows,
    seasons: seasonRows,
    totals,
    coverage: ctx.coverage.map((c) => ({
      server: c.server,
      source: c.source,
      tracked: c.tracked,
      since: iso(c.since),
      holds: c.holds,
      upstream: {
        health: c.upstreamHealth,
        fetchedAt: c.upstream?.fetchedAt ?? null,
        attemptedAt: c.upstream?.attemptedAt ?? null,
        entries: c.upstream?.entries ?? 0,
        matched: c.upstream?.matched ?? 0,
        samples: c.upstream?.samples ?? 0,
        agreed: c.upstream?.agreed ?? 0,
        error: c.upstream?.error ?? null,
        errorCode: upstreamErrorCode(c.upstream?.error)?.code ?? null,
        httpStatus: upstreamErrorCode(c.upstream?.error)?.httpStatus ?? null,
      },
    })),
    trackingOn: ctx.playHistoryTracked,
    historyStart: iso(ctx.historyStart),
    unplacedPlays: ctx.unplacedPlays,
    softPlays: ctx.softPlays,
    arrErrors: arr.errors,
    sizesAsOf: arrAt.toISOString(),
    cleanupEnabled,
    neverWatchedDays: settings.neverWatchedDays,
    requireUpstreamCheck: settings.requireUpstreamCheck,
    computedAt: now.toISOString(),
  };
}

function seasonRowsFor(t: CleanupTitle, copies: readonly ArrLibraryEntry[]): NwSeasonRow[] {
  const seasons = t.seasons ?? [];
  if (seasons.length === 0) return [];
  const sonarrSeasons = copies.filter((e) => e.service === "sonarr").map((e) => e.seasons ?? []);
  const latest = Math.max(...seasons.map((s) => s.seasonNumber));
  const out: NwSeasonRow[] = [];
  for (const s of seasons) {
    if (s.state === "watched") continue;
    const size = seasonSizeIfAgreed(sonarrSeasons, s.seasonNumber, s.episodes);
    out.push({
      kind: "season",
      tmdbId: t.tmdbId,
      mediaType: "TV",
      title: t.title,
      posterPath: t.posterPath,
      year: t.year,
      servers: t.servers,
      seasonNumber: s.seasonNumber,
      episodes: s.episodes,
      state: s.state,
      reason: s.reason,
      reasonServers: s.reasonServers,
      windowStart: iso(s.windowStart),
      days: s.days,
      fullyObserved: s.fullyObserved,
      airing: t.airing === true && s.seasonNumber === latest,
      sizeOnDisk: size.bytes,
      sizeMismatch: size.mismatch,
    });
  }
  return out;
}

// ── Cache ──────────────────────────────────────────────────────────────────
//
// The report is a whole-library computation (two library reads, a dozen
// aggregates, one Radarr/Sonarr listing per instance through the shared index
// cache) — far too much to repeat for every page flip of a server-paged table.
// It is cached for a short TTL and dropped early by:
//   - a new recorded play (the activity-cache generation moves on every finalize);
//   - invalidateNeverWatchedReport(), called by the Summonarr actions that change
//     an input: protect/unprotect, the cleanup settings, a cleanup delete, an
//     upstream refresh (the route and its cron), the title manager's Add and
//     Remove, a media-server instance's removal, and a /api/settings write of a
//     tracking switch, the retention or the cleanup / never-watched feature flag.
// Every other input — a library sync, a fix-match, votes, requests, watchlists,
// an edit made inside Radarr/Sonarr — is bounded by the TTL alone. That staleness never
// reaches a delete: the cleanup dry run re-judges through its own narrowed read
// and never reads this cache (14b).
const REPORT_TTL_MS = 2 * 60 * 1000;
// A report built while a Radarr/Sonarr instance couldn't be listed is kept only
// as long as the shared index keeps a failed listing (library-cleanup-arr.ts),
// so "could not read Sonarr" clears soon after Sonarr recovers.
const REPORT_ERROR_TTL_MS = 30 * 1000;
const reportCache = processSingleton("never-watched:report", () => ({
  value: null as NeverWatchedReport | null,
  at: 0,
  generation: -1,
  version: 0,
}));

export function invalidateNeverWatchedReport(): void {
  reportCache.version++;
  reportCache.value = null;
}

// `opts.shared` hands a miss the caller's shared facts load (SharedWatchFacts —
// the /admin/stats storage section) instead of a load of its own; a hit never
// touches it. The store check below sees only what changed AFTER this call read
// its generation and version, so the shared inputs must not be older than that:
// the facts load not yet started (this computation starts it), and the
// Radarr/Sonarr index it carries still the shared index cache's current one (an
// Add, Remove or cleanup delete drops that cache along with this one — a
// listing obtained before it is no longer there). Otherwise the report may
// predate an invalidation this call can't see, so it is computed for this
// caller alone: never stored, never joined by another caller.
export async function getNeverWatchedReport(opts: { fresh?: boolean; shared?: SharedWatchFacts } = {}): Promise<NeverWatchedReport> {
  const generation = currentActivityGeneration();
  const sharedPredates = !!opts.shared && (opts.shared.started || peekCachedArrLibraryIndex() !== opts.shared.arr);
  const c = reportCache;
  const ttl = c.value && c.value.arrErrors.length > 0 ? REPORT_ERROR_TTL_MS : REPORT_TTL_MS;
  if (!opts.fresh && c.value && c.generation === generation && Date.now() - c.at < ttl) return c.value;
  if (opts.shared && sharedPredates) return computeNeverWatchedReport({ shared: opts.shared });
  const version = c.version;
  return coalesce(`never-watched:report:${generation}:${version}:${opts.fresh ? "fresh" : ""}`, async () => {
    const value = await computeNeverWatchedReport({ freshArr: opts.fresh, shared: opts.shared });
    // A report computed across an invalidation or a new play is already stale —
    // never store it over a newer state (the guardrail-19b shape).
    if (c.version === version && currentActivityGeneration() === generation) {
      c.value = value;
      c.at = Date.now();
      c.generation = generation;
    }
    return value;
  });
}

// ── Paging ─────────────────────────────────────────────────────────────────

export function selectReportRows(
  report: NeverWatchedReport,
  q: NwQuery,
): { rows: Array<NwTitleRow | NwSeasonRow>; total: number } {
  const needle = q.q.toLowerCase();
  const base: Array<NwTitleRow | NwSeasonRow> = q.level === "season" ? report.seasons : report.titles;
  const filtered = base.filter((r) => {
    if (!stateMatchesFilter(r.state, q.state)) return false;
    if (q.type === "movie" && r.mediaType !== "MOVIE") return false;
    if (q.type === "tv" && r.mediaType !== "TV") return false;
    if (q.eligibleOnly && !(r.kind === "title" && r.eligible)) return false;
    if (needle && !r.title.toLowerCase().includes(needle)) return false;
    return true;
  });
  const dir = q.sortDir === "asc" ? 1 : -1;
  // Unknowns (no size, no date) always sort last, whichever the direction.
  const num = (a: number | null, b: number | null) =>
    a === null && b === null ? 0 : a === null ? 1 : b === null ? -1 : (a - b) * dir;
  const time = (s: string | null) => (s ? new Date(s).getTime() : null);
  const added = (r: NwTitleRow | NwSeasonRow) => (r.kind === "title" ? time(r.shelfStart ?? r.addedAt) : time(r.windowStart));
  filtered.sort((a, b) => {
    let c = 0;
    switch (q.sortBy) {
      case "size": c = num(a.sizeOnDisk, b.sizeOnDisk); break;
      case "days": c = num(a.days, b.days); break;
      case "since": c = num(time(a.windowStart), time(b.windowStart)); break;
      case "added": c = num(added(a), added(b)); break;
      case "title": c = a.title.localeCompare(b.title) * dir; break;
    }
    return c
      || a.tmdbId - b.tmdbId
      || (a.kind === "season" && b.kind === "season" ? a.seasonNumber - b.seasonNumber : 0);
  });
  const start = (q.page - 1) * q.limit;
  return { rows: filtered.slice(start, start + q.limit), total: filtered.length };
}

// ── One title (the detail-page chip) ───────────────────────────────────────

export interface TitleNeverWatched {
  state: NwState;
  windowStart: string | null;
  days: number | null;
  fullyObserved: boolean;
  // Never-watched seasons of a watched show (season numbers, ascending).
  neverWatchedSeasons: number[];
}

// The narrowed read — the same evidence union as the report (guardrail 14d).
// The Radarr/Sonarr index feeds the verdict too, not just the size: a fulfilled
// request's delivery date counts as the arrival only while its instance hasn't
// re-added the title since (never-watched-data.ts). So the chip reads the SAME
// shared index the report does — but only when it is already in memory
// (peekCachedArrLibraryIndex): a page render never lists an arr. On a cold
// cache the chip can count a delivery the report drops, so its "since" date can
// be earlier than the report's until the index is warm again.
export async function getTitleNeverWatched(tmdbId: number, mediaType: CleanupMediaType): Promise<TitleNeverWatched | null> {
  const facts = await loadLibraryWatchFacts(peekCachedArrLibraryIndex(), { only: [{ tmdbId, mediaType }], seasons: mediaType === "TV" });
  const t = facts.titles[0];
  if (!t) return null;
  return {
    state: t.verdict.state,
    windowStart: iso(t.verdict.windowStart),
    days: t.verdict.days,
    fullyObserved: t.verdict.fullyObserved,
    neverWatchedSeasons: (t.seasons ?? []).filter((s) => isNeverWatchedState(s.state)).map((s) => s.seasonNumber),
  };
}

// The detail-page chip's read: ADMIN only, the page switched on, and a failure
// is "no chip", never an error page.
export async function getAdminTitleNeverWatched(
  permissions: Parameters<typeof hasPermission>[0],
  tmdbId: number,
  mediaType: CleanupMediaType,
): Promise<TitleNeverWatched | null> {
  if (!hasPermission(permissions, Permission.ADMIN)) return null;
  try {
    if (!(await isFeatureEnabled(NEVER_WATCHED_FEATURE_KEY))) return null;
    return await getTitleNeverWatched(tmdbId, mediaType);
  } catch (err) {
    console.warn("[never-watched] detail chip read failed:", err instanceof Error ? err.message : err);
    return null;
  }
}
