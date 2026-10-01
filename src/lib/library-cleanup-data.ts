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
import { isFeatureEnabled } from "./features";
import { mediaInstanceLabel } from "./media-instances";
import type { ArrLibraryEntry, ArrLibraryIndex } from "./library-cleanup-arr";
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

export type TitleKey = { tmdbId: number; mediaType: CleanupMediaType };

const DAY_MS = 86_400_000;
const TMDB_STATUS_CHUNK = 500;

// Every fact the engine needs, aggregated per title. `only` restricts every
// read to the given titles (the delete route re-judges exactly what it was
// asked to delete); omitted, the whole library is read.
export async function loadCleanupTitles(
  arr: ArrLibraryIndex | null,
  only?: readonly TitleKey[],
): Promise<{ titles: CleanupTitle[]; ctx: Omit<CleanupContext, "now"> }> {
  const onlyIds = only ? [...new Set(only.map((k) => k.tmdbId))] : null;
  const onlyKeys = only ? new Set(only.map((k) => cleanupKey(k.tmdbId, k.mediaType))) : null;
  const idFilter = onlyIds ? { tmdbId: { in: onlyIds } } : {};

  const [plexRows, jfRows] = await Promise.all([
    prisma.plexLibraryItem.findMany({
      where: idFilter,
      select: { tmdbId: true, mediaType: true, serverInstance: true, title: true, year: true, addedAt: true },
    }),
    prisma.jellyfinLibraryItem.findMany({
      where: idFilter,
      select: { tmdbId: true, mediaType: true, serverInstance: true, title: true, year: true, addedAt: true },
    }),
  ]);

  const byKey = new Map<string, CleanupTitle>();
  const absorb = (
    rows: Array<{ tmdbId: number; mediaType: string; serverInstance: string; title: string | null; year: string | null; addedAt: Date | null }>,
    service: "plex" | "jellyfin",
  ) => {
    for (const r of rows) {
      if (r.mediaType !== "MOVIE" && r.mediaType !== "TV") continue;
      const key = cleanupKey(r.tmdbId, r.mediaType);
      if (onlyKeys && !onlyKeys.has(key)) continue;
      let t = byKey.get(key);
      if (!t) {
        t = {
          tmdbId: r.tmdbId, mediaType: r.mediaType, title: r.title ?? "", posterPath: null, year: r.year,
          servers: [], addedAt: null, playCount: 0, lastPlayedAt: null, votes: 0, requests: [],
          watchlisted: false, playingNow: false, airing: null, protected: false,
        };
        byKey.set(key, t);
      }
      const label = mediaInstanceLabel(service, r.serverInstance);
      if (!t.servers.includes(label)) t.servers.push(label);
      // Earliest across servers: the title has been on the shelf since then.
      if (r.addedAt && (!t.addedAt || r.addedAt < t.addedAt)) t.addedAt = r.addedAt;
      if (!t.title && r.title) t.title = r.title;
      if (!t.year && r.year) t.year = r.year;
    }
  };
  absorb(plexRows, "plex");
  absorb(jfRows, "jellyfin");

  const ids = [...new Set([...byKey.values()].map((t) => t.tmdbId))];
  // A whole-library read aggregates unfiltered and drops non-library keys in
  // memory: an `IN` list as long as the library would run into Postgres's bind
  // parameter limit on a large one. A targeted read filters on its own few ids.
  const scoped = onlyIds ? { tmdbId: { in: ids } } : {};
  const playHistoryTracked = await isFeatureEnabled("playHistoryEnabled");
  if (ids.length === 0) {
    return { titles: [], ctx: { playHistoryTracked, historyStart: null } };
  }

  const [plays, historyStartAgg, votes, requests, watchlist, active, protections, cores] = await Promise.all([
    prisma.playHistory.groupBy({
      by: ["tmdbId", "mediaType"],
      where: scoped,
      _count: { _all: true },
      _max: { startedAt: true },
    }),
    prisma.playHistory.aggregate({ _min: { startedAt: true } }),
    prisma.deletionVote.groupBy({ by: ["tmdbId", "mediaType"], where: scoped, _count: { _all: true } }),
    prisma.mediaRequest.findMany({
      where: { ...scoped, status: { in: ["PENDING", "APPROVED", "AVAILABLE"] } },
      select: { tmdbId: true, mediaType: true, status: true, availableAt: true },
    }),
    prisma.watchlistItem.groupBy({ by: ["tmdbId", "mediaType"], where: scoped }),
    prisma.activeSession.findMany({ where: scoped, select: { tmdbId: true, mediaType: true } }),
    prisma.cleanupProtection.findMany({ where: scoped, select: { tmdbId: true, mediaType: true } }),
    loadCores(ids),
  ]);

  const get = (tmdbId: number | null, mediaType: string | null) =>
    tmdbId == null || mediaType == null ? undefined : byKey.get(cleanupKey(tmdbId, mediaType));

  for (const p of plays) {
    const t = get(p.tmdbId, p.mediaType);
    if (!t) continue;
    t.playCount = p._count._all;
    t.lastPlayedAt = p._max.startedAt ?? null;
  }
  for (const v of votes) {
    const t = get(v.tmdbId, v.mediaType);
    if (t) t.votes = v._count._all;
  }
  for (const r of requests) {
    const t = get(r.tmdbId, r.mediaType);
    if (t) (t.requests as CleanupRequestFact[]).push({ status: r.status, availableAt: r.availableAt });
  }
  for (const w of watchlist) {
    const t = get(w.tmdbId, w.mediaType);
    if (t) t.watchlisted = true;
  }
  for (const a of active) {
    const t = get(a.tmdbId, a.mediaType);
    if (t) t.playingNow = true;
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
  if (arr) {
    for (const t of byKey.values()) {
      if (t.mediaType !== "TV") continue;
      const verdicts = (arr.byKey.get(cleanupKey(t.tmdbId, "TV")) ?? []).map((e) => e.airing).filter((a) => a !== null);
      if (verdicts.length > 0) t.airing = verdicts.includes(true);
    }
  }

  return {
    titles: [...byKey.values()],
    ctx: { playHistoryTracked, historyStart: historyStartAgg._min.startedAt ?? null },
  };
}

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

// TMDB's cached status for the shows Sonarr couldn't speak for. Read only for
// the titles whose verdict it can change (a show that matched a rule), in
// chunks, because a :details blob is large and a library has thousands.
async function fillTmdbAiring(titles: CleanupTitle[]): Promise<void> {
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
export async function computeCleanupReport(
  arr: ArrLibraryIndex | null,
  now: Date,
  only?: readonly TitleKey[],
): Promise<CleanupReport> {
  const settings = await loadCleanupSettings();
  const { titles, ctx: partial } = await loadCleanupTitles(arr, only);
  const ctx: CleanupContext = { ...partial, now };

  let verdicts = titles.map((t) => evaluateCleanupTitle(t, settings, ctx));
  if (settings.excludeAiring) {
    // Second look, only where the airing exclusion could change the outcome.
    const unresolved = titles.filter((t, i) => t.mediaType === "TV" && t.airing === null && verdicts[i].matched.length > 0);
    if (unresolved.length > 0) {
      await fillTmdbAiring(unresolved);
      verdicts = titles.map((t) => evaluateCleanupTitle(t, settings, ctx));
    }
  }

  const rows: CleanupRow[] = [];
  titles.forEach((t, i) => {
    const v = verdicts[i];
    if (v.matched.length === 0) return;
    const entries = arr?.byKey.get(cleanupKey(t.tmdbId, t.mediaType)) ?? [];
    const lastActivity = [t.lastPlayedAt, v.observedSince].filter((d): d is Date => d !== null)
      .reduce<Date | null>((a, d) => (!a || d > a ? d : a), null);
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
    playHistoryTracked: ctx.playHistoryTracked,
    historyStart: ctx.historyStart?.toISOString() ?? null,
    rows,
    libraryTitles: titles.length,
  };
}
