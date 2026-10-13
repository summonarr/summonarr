// Library cleanup — the data half. Gathers the facts the pure engine
// (library-cleanup.ts) judges, for every library title or for a chosen few, in a
// fixed number of queries (no per-title round trips). Computed on demand, like
// the watch grades: no table, no cron.
//
// Scope notes, all deliberate:
//   - The library is the UNION of every Plex and Jellyfin server (guardrail 35),
//     and play history is read across every server and every user — the
//     question is "does anybody here watch this", which no grant or server
//     boundary narrows (the admin subtree is unscoped by design).
//   - Play history is never written or deleted here (guardrails 19/28).
//   - "Requester never watched it" is NOT a rule. Answering it honestly needs
//     the watch grade's per-account identity resolution (linkedIdentityBranches,
//     guardrail 34a) for every requester of every title, which is not cheap and
//     must never be restated in a shortcut. The audience rules here are
//     server-wide instead.
import { prisma } from "./prisma";
import { lookupTmdbToTvdb, resolveArrTargets, type ArrLibraryEntry, type ArrLibraryIndex, type CrossRefMode } from "./library-cleanup-arr";
import { loadLibraryWatchFacts, type LibraryWatchTitle, type ServerCoverage, type TitleKey } from "./never-watched-data";
import { latestDate, type NwSeasonVerdict } from "./never-watched";
import {
  CLEANUP_SETTING_KEYS,
  cleanupKey,
  evaluateCleanupTitle,
  parseCleanupSettings,
  tmdbStatusIsAiring,
  type CleanupContext,
  type CleanupMediaType,
  type CleanupRequestFact,
  type CleanupSettings,
  type CleanupTitleFacts,
  type CleanupVerdict,
} from "./library-cleanup";

export const CLEANUP_FEATURE_KEY = "feature.admin.cleanup";

export async function loadCleanupSettings(): Promise<CleanupSettings> {
  const rows = await prisma.setting.findMany({
    where: { key: { in: Object.values(CLEANUP_SETTING_KEYS) } },
    select: { key: true, value: true },
  });
  return parseCleanupSettings(Object.fromEntries(rows.map((r) => [r.key, r.value])));
}

export interface CleanupTitle extends CleanupTitleFacts {
  title: string;
  posterPath: string | null;
  year: string | null;
  // Media-server labels holding the title: "plex", "jellyfin", "plex:remote", …
  servers: string[];
  // Earliest arrival: the media servers' own addedAt and a fulfilled request's
  // availableAt — never Radarr/Sonarr's `added` (guardrail 14d).
  shelfStart: Date | null;
  // Season verdicts of a watched show, when seasons were requested.
  seasons?: NwSeasonVerdict[];
}

// What the load observed about recording, for display.
export interface CleanupLoadContext {
  playHistoryTracked: boolean;
  // Earliest recorded play anywhere (display only — never a window).
  historyStart: Date | null;
  coverage: ServerCoverage[];
  unplacedPlays: number;
  softPlays: number;
}

export interface CleanupRow {
  tmdbId: number;
  mediaType: CleanupMediaType;
  title: string;
  posterPath: string | null;
  year: string | null;
  servers: string[];
  addedAt: string | null;
  lastPlayedAt: string | null;
  playCount: number;
  votes: number;
  // Whole days since the last thing that happened to the title (its last play,
  // or the start of the window history observed it over). Server-computed so the
  // client never needs Date.now() in render (guardrail 16).
  idleDays: number | null;
  arr: Array<{ service: "radarr" | "sonarr"; instance: string; sizeOnDisk: number }>;
  // null when no *arr entry was found (nothing to delete) or the listing failed.
  sizeOnDisk: number | null;
  matched: CleanupVerdict["matched"];
  excludedBy: CleanupVerdict["excludedBy"];
  candidate: boolean;
}

export type { TitleKey };

// A TV title's requests are matched by tmdb id OR tvdb id — the title manager's
// Remove rule (requestIdentity in arr-title-lifecycle.ts). A TV request carries
// the tvdbId it was pushed to Sonarr with, which can be its ONLY link to the
// series when TMDB's id for the show and the one the library and Sonarr use
// disagree (a merged or re-split TMDB entry). Matched on tmdb id alone, such an
// APPROVED request neither holds the delete back nor gets stamped, and the next
// sync re-pushes it and downloads the show again (guardrail 14b).
const positiveIds = (ids: Iterable<number | null | undefined>): number[] =>
  [...new Set([...ids].filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n > 0))];

export function cleanupRequestIdentity(
  tmdbId: number,
  mediaType: CleanupMediaType,
  tvdbIds: Iterable<number | null | undefined> = [],
): { OR: Array<{ tmdbId: number } | { tvdbId: { in: number[] } }> } {
  const tvdb = mediaType === "TV" ? positiveIds(tvdbIds) : [];
  return { OR: [{ tmdbId }, ...(tvdb.length > 0 ? [{ tvdbId: { in: tvdb } }] : [])] };
}

// Every fact the engine needs, aggregated per title. `only` restricts every
// read to the given titles (the delete route re-judges exactly what it was
// asked to delete); omitted, the whole library is read. The watch facts — who
// holds it, the evidence it was played, the verdict — come from
// loadLibraryWatchFacts (guardrail 14d): one definition for the report, the
// rules and the delete re-check. A TV title's tvdb ids (for request matching —
// cleanupRequestIdentity) are its Sonarr entries' in `arr`, plus `opts.tvdbIds`
// (cleanupKey → ids): the delete route's resolved targets, which also reach
// the tmdb-less Sonarr entries TMDB's cross-reference points at.
// `opts.resolveTargets` does that resolution HERE, for the titles it selects,
// before the requests are read — the never-watched report needs the delete
// route's exact targets (tvdb-only Sonarr entries included, resolveArrTargets)
// and the exact requests they link, for every row it could call eligible. The
// map comes back as `targets` (null when not asked for). `opts.crossRef`
// (default "cached" — a read path never waits on TMDB, see CrossRefMode).
export async function loadCleanupTitles(
  arr: ArrLibraryIndex | null,
  only?: readonly TitleKey[],
  opts: {
    seasons?: boolean;
    now?: Date;
    tvdbIds?: ReadonlyMap<string, readonly number[]>;
    resolveTargets?: (t: LibraryWatchTitle) => boolean;
    crossRef?: CrossRefMode;
  } = {},
): Promise<{ titles: CleanupTitle[]; ctx: CleanupLoadContext; targets: ReadonlyMap<string, readonly ArrLibraryEntry[]> | null }> {
  const facts = await loadLibraryWatchFacts(arr, { only, seasons: opts.seasons, now: opts.now });
  const loadCtx: CleanupLoadContext = {
    playHistoryTracked: facts.ctx.trackingOn,
    historyStart: facts.historyStart,
    coverage: facts.coverage,
    unplacedPlays: facts.unplacedPlays,
    softPlays: facts.softPlays,
  };
  if (facts.titles.length === 0) return { titles: [], ctx: loadCtx, targets: opts.resolveTargets && arr ? new Map() : null };
  const targets = opts.resolveTargets && arr ? await resolveArrTargets(facts.titles.filter(opts.resolveTargets), arr, opts.crossRef ?? "cached") : null;

  const byKey = new Map<string, CleanupTitle>();
  for (const w of facts.titles) {
    byKey.set(cleanupKey(w.tmdbId, w.mediaType), {
      tmdbId: w.tmdbId,
      mediaType: w.mediaType,
      title: w.title,
      posterPath: null,
      year: w.year,
      servers: w.servers,
      addedAt: w.addedAt,
      shelfStart: w.shelfStart,
      playCount: w.evidence.plays,
      lastPlayedAt: w.evidence.lastPlayedAt,
      watch: w.verdict,
      evidence: w.evidence,
      upstreamUnchecked: w.upstreamUnchecked,
      seasons: w.seasons,
      votes: 0,
      requests: [],
      watchlisted: false,
      playingNow: w.playingNow,
      airing: null,
      protected: false,
    });
  }

  const ids = [...new Set([...byKey.values()].map((t) => t.tmdbId))];
  // A whole-library read aggregates unfiltered and drops non-library keys in
  // memory: an `IN` list as long as the library would run into Postgres's bind
  // parameter limit on a large one. A targeted read filters on its own few ids.
  const scoped = only ? { tmdbId: { in: ids } } : {};

  // tvdb id → the TV titles it names (cleanupRequestIdentity).
  const byTvdb = new Map<number, CleanupTitle[]>();
  for (const [key, t] of byKey) {
    if (t.mediaType !== "TV") continue;
    const targetTvdb = (targets?.get(key) ?? []).flatMap((e) => (e.service === "sonarr" ? [e.tvdbId] : []));
    for (const tvdbId of positiveIds([...(arr?.byKey.get(key) ?? []).map((e) => e.tvdbId), ...(opts.tvdbIds?.get(key) ?? []), ...targetTvdb])) {
      const list = byTvdb.get(tvdbId);
      if (list) list.push(t);
      else byTvdb.set(tvdbId, [t]);
    }
  }
  const tvdbIds = [...byTvdb.keys()];
  const requestScope = only
    ? { OR: [{ tmdbId: { in: ids } }, ...(tvdbIds.length > 0 ? [{ mediaType: "TV" as const, tvdbId: { in: tvdbIds } }] : [])] }
    : {};

  const [votes, requests, watchlist, protections, cores] = await Promise.all([
    prisma.deletionVote.groupBy({ by: ["tmdbId", "mediaType"], where: scoped, _count: { _all: true } }),
    prisma.mediaRequest.findMany({
      where: { ...requestScope, status: { in: ["PENDING", "APPROVED", "AVAILABLE"] } },
      select: { tmdbId: true, mediaType: true, tvdbId: true, status: true, availableAt: true },
    }),
    prisma.watchlistItem.groupBy({ by: ["tmdbId", "mediaType"], where: scoped }),
    prisma.cleanupProtection.findMany({ where: scoped, select: { tmdbId: true, mediaType: true } }),
    loadCores(ids),
  ]);

  const get = (tmdbId: number | null, mediaType: string | null) =>
    tmdbId == null || mediaType == null ? undefined : byKey.get(cleanupKey(tmdbId, mediaType));

  for (const v of votes) {
    const t = get(v.tmdbId, v.mediaType);
    if (t) t.votes = v._count._all;
  }
  for (const r of requests) {
    // A request counts once per title, however many of its ids match.
    const matched = new Set<CleanupTitle>();
    const byTmdb = get(r.tmdbId, r.mediaType);
    if (byTmdb) matched.add(byTmdb);
    if (r.mediaType === "TV" && r.tvdbId != null) for (const t of byTvdb.get(r.tvdbId) ?? []) matched.add(t);
    for (const t of matched) (t.requests as CleanupRequestFact[]).push({ status: r.status, availableAt: r.availableAt });
  }
  for (const w of watchlist) {
    const t = get(w.tmdbId, w.mediaType);
    if (t) t.watchlisted = true;
  }
  for (const p of protections) {
    const t = get(p.tmdbId, p.mediaType);
    if (t) t.protected = true;
  }
  for (const c of cores) {
    const t = get(c.tmdbId, c.mediaType);
    if (!t) continue;
    if (c.title) t.title = c.title;
    t.posterPath = c.posterPath;
    if (c.releaseYear) t.year = c.releaseYear;
  }
  // Still-airing: Sonarr's own series status is authoritative for a show it
  // manages. Any instance saying "continuing" wins over one saying "ended".
  // Only the entries carrying a tmdbId here; a tvdb-only one (Sonarr v3) is
  // reached through TMDB's cross-reference by fillAiring.
  if (arr) {
    for (const t of byKey.values()) {
      if (t.mediaType !== "TV") continue;
      const verdicts = (arr.byKey.get(cleanupKey(t.tmdbId, "TV")) ?? []).map((e) => e.airing).filter((a) => a !== null);
      if (verdicts.length > 0) t.airing = verdicts.includes(true);
    }
  }

  return { titles: [...byKey.values()], ctx: loadCtx, targets };
}

const DAY_MS = 86_400_000;
const TMDB_STATUS_CHUNK = 500;
const CORE_CHUNK = 5_000;

// Poster/title/year from TmdbMediaCore, chunked: that table holds every title
// the app has ever shown (trending, search, …), far more than the library.
async function loadCores(ids: readonly number[]) {
  const out: Array<{ tmdbId: number; mediaType: string; title: string; posterPath: string | null; releaseYear: string | null }> = [];
  for (let i = 0; i < ids.length; i += CORE_CHUNK) {
    out.push(...await prisma.tmdbMediaCore.findMany({
      where: { tmdbId: { in: ids.slice(i, i + CORE_CHUNK) } },
      select: { tmdbId: true, mediaType: true, title: true, posterPath: true, releaseYear: true },
    }));
  }
  return out;
}

// The still-airing status for the shows the first read left unknown. Called
// only for the titles whose verdict it can change (a show that matched a rule).
//
// Sonarr first, as for every show it manages: a series Sonarr lists with NO
// tmdbId (Sonarr v3, or one TVDB never cross-referenced) sits in `tvdbOnly`, so
// loadCleanupTitles' byKey read never saw its status. It is reached here
// through TMDB's TVDB cross-reference — the same bounded lookup resolveArrTargets
// uses to DELETE that very entry (guardrail 31) — or the delete could find the
// series while the airing exclusion could not. Then TMDB's cached status, in
// chunks, because a :details blob is large and a library has thousands. Still
// null after both = neither source answered. `crossRef` defaults to "cached":
// only the delete route's re-judgement may wait on TMDB (CrossRefMode).
export async function fillAiring(titles: CleanupTitle[], arr: ArrLibraryIndex | null, crossRef: CrossRefMode = "cached"): Promise<void> {
  if (arr && arr.tvdbOnly.size > 0) {
    const unknown = titles.filter((t) => t.mediaType === "TV" && t.airing === null);
    const tvdbOf = await lookupTmdbToTvdb(unknown.map((t) => t.tmdbId), crossRef);
    for (const t of unknown) {
      const tvdbId = tvdbOf.get(t.tmdbId);
      if (tvdbId == null) continue;
      const verdicts = (arr.tvdbOnly.get(tvdbId) ?? [])
        .filter((e) => e.service === "sonarr")
        .map((e) => e.airing)
        .filter((a) => a !== null);
      if (verdicts.length > 0) t.airing = verdicts.includes(true);
    }
  }
  await fillTmdbCachedAiring(titles);
}

async function fillTmdbCachedAiring(titles: CleanupTitle[]): Promise<void> {
  const need = titles.filter((t) => t.mediaType === "TV" && t.airing === null);
  for (let i = 0; i < need.length; i += TMDB_STATUS_CHUNK) {
    const chunk = need.slice(i, i + TMDB_STATUS_CHUNK);
    const rows = await prisma.tmdbCache.findMany({
      where: { key: { in: chunk.map((t) => `tv:${t.tmdbId}:details`) } },
      select: { key: true, data: true },
    });
    const byKey = new Map(rows.map((r) => [r.key, r.data]));
    for (const t of chunk) {
      const raw = byKey.get(`tv:${t.tmdbId}:details`);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as { status?: unknown; inProduction?: unknown };
        t.airing = tmdbStatusIsAiring(parsed.status, parsed.inProduction);
      } catch {
        // A corrupt cache row is "unknown", never a verdict.
      }
    }
  }
}

function sizeOf(entries: readonly ArrLibraryEntry[]): number | null {
  return entries.length === 0 ? null : entries.reduce((n, e) => n + e.sizeOnDisk, 0);
}

export interface CleanupReport {
  settings: CleanupSettings;
  playHistoryTracked: boolean;
  historyStart: string | null;
  // Every title that matched at least one enabled rule — candidates AND the ones
  // an exclusion holds back (so the admin sees why), candidates first.
  rows: CleanupRow[];
  libraryTitles: number;
}

// Judges titles and shapes the rows. `only` limits it to those titles.
//
// `opts.resolveTargets` (the cleanup page, the storage stats) gives every row
// the delete route's own targets: resolveArrTargets, so a show Sonarr lists only
// by tvdb id (Sonarr v3, a series TVDB never cross-referenced) is sized and
// selectable instead of "not in Radarr/Sonarr". Resolved for the ROWS only (a
// rule matched — `matched` never depends on requests or targets), and a row
// whose targets brought a tvdb id the first read didn't know is re-judged
// narrowed with them, exactly as the dry run judges it: a request linked only
// by that tvdb id is an exclusion (cleanupRequestIdentity, guardrail 14d's
// narrowed-read parity). The delete route resolves its own targets first and
// passes `tvdbIds` instead. `opts.crossRef` defaults to "cached" (no TMDB call
// inside a page render); the delete route passes "fetch" (CrossRefMode).
export async function computeCleanupReport(
  arr: ArrLibraryIndex | null,
  now: Date,
  only?: readonly TitleKey[],
  opts: { tvdbIds?: ReadonlyMap<string, readonly number[]>; resolveTargets?: boolean; crossRef?: CrossRefMode } = {},
): Promise<CleanupReport> {
  const crossRef = opts.crossRef ?? "cached";
  const settings = await loadCleanupSettings();
  const { titles: firstRead, ctx: partial } = await loadCleanupTitles(arr, only, { now, tvdbIds: opts.tvdbIds });
  const ctx: CleanupContext = { now };
  let titles = firstRead;

  let verdicts = titles.map((t) => evaluateCleanupTitle(t, settings, ctx));
  let targets: ReadonlyMap<string, readonly ArrLibraryEntry[]> | null = null;
  if (opts.resolveTargets && arr) {
    const rowTitles = titles.filter((_, i) => verdicts[i].matched.length > 0);
    targets = await resolveArrTargets(rowTitles, arr, crossRef);
    const sonarrTvdb = (entries: readonly ArrLibraryEntry[]) =>
      positiveIds(entries.flatMap((e) => (e.service === "sonarr" ? [e.tvdbId] : [])));
    const rejudge: TitleKey[] = [];
    const rejudgeTvdb = new Map<string, number[]>();
    for (const t of rowTitles) {
      if (t.mediaType !== "TV") continue;
      const key = cleanupKey(t.tmdbId, t.mediaType);
      const known = new Set([...sonarrTvdb(arr.byKey.get(key) ?? []), ...(opts.tvdbIds?.get(key) ?? [])]);
      const ids = sonarrTvdb(targets.get(key) ?? []);
      if (!ids.some((id) => !known.has(id))) continue;
      rejudge.push({ tmdbId: t.tmdbId, mediaType: t.mediaType });
      rejudgeTvdb.set(key, ids);
    }
    if (rejudge.length > 0) {
      const again = await loadCleanupTitles(arr, rejudge, { now, tvdbIds: rejudgeTvdb });
      const fresh = new Map(again.titles.map((t) => [cleanupKey(t.tmdbId, t.mediaType), t]));
      titles = titles.map((t) => fresh.get(cleanupKey(t.tmdbId, t.mediaType)) ?? t);
      verdicts = titles.map((t) => evaluateCleanupTitle(t, settings, ctx));
    }
  }
  if (settings.excludeAiring) {
    // Second look, only where the airing exclusion could change the outcome.
    const unresolved = titles.filter((t, i) => t.mediaType === "TV" && t.airing === null && verdicts[i].matched.length > 0);
    if (unresolved.length > 0) {
      await fillAiring(unresolved, arr, crossRef);
      verdicts = titles.map((t) => evaluateCleanupTitle(t, settings, ctx));
    }
  }

  const rows: CleanupRow[] = [];
  titles.forEach((t, i) => {
    const v = verdicts[i];
    if (v.matched.length === 0) return;
    const key = cleanupKey(t.tmdbId, t.mediaType);
    const entries = targets?.get(key) ?? arr?.byKey.get(key) ?? [];
    const lastActivity = latestDate(t.lastPlayedAt, t.evidence.softLastPlayedAt, v.observedSince);
    rows.push({
      tmdbId: t.tmdbId,
      mediaType: t.mediaType,
      title: t.title,
      posterPath: t.posterPath,
      year: t.year,
      servers: [...t.servers].sort(),
      addedAt: t.addedAt?.toISOString() ?? null,
      lastPlayedAt: t.lastPlayedAt?.toISOString() ?? null,
      playCount: t.playCount,
      votes: t.votes,
      idleDays: lastActivity ? Math.floor((now.getTime() - lastActivity.getTime()) / DAY_MS) : null,
      arr: entries.map((e) => ({ service: e.service, instance: e.instance, sizeOnDisk: e.sizeOnDisk })),
      sizeOnDisk: sizeOf(entries),
      matched: v.matched,
      excludedBy: v.excludedBy,
      candidate: v.candidate,
    });
  });
  rows.sort((a, b) =>
    Number(b.candidate) - Number(a.candidate) ||
    (b.sizeOnDisk ?? -1) - (a.sizeOnDisk ?? -1) ||
    a.title.localeCompare(b.title),
  );

  return {
    settings,
    playHistoryTracked: partial.playHistoryTracked,
    historyStart: partial.historyStart?.toISOString() ?? null,
    rows,
    libraryTitles: titles.length,
  };
}
