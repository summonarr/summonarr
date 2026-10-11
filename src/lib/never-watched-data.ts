// "Never watched" — the data half (guardrail 14d). Gathers, for every library
// title (or a chosen few), who holds it, how well each holding server is being
// recorded, and EVERY piece of evidence that it was played, then hands those to
// the pure verdict in never-watched.ts. The cleanup engine (library-cleanup-data)
// and the never-watched report both read their watch facts from here, so there is
// one definition of "watched".
//
// Evidence is a union, never filtered by user, status, source, server or the
// `watched` flag (a deactivated user's two-minute sample still proves use):
//   1. recorded plays attributed by tmdb id;
//   2. recorded plays attributed by the movie's OWN item key — catches a play
//      stored under another tmdb id (a 37b conflation loser, a rematch done in
//      Plex/Jellyfin directly) or with none at all;
//   3. recorded plays attributed by the SHOW's key (PlayHistory.sourceShowId) —
//      catches an episode watched before its show reached the library cache;
//   4. sessions playing right now, matched the same three ways;
//   5. the media server's own watch records (UpstreamWatchEvidence, read-only).
// Anything left over — a play with no tmdb id and no key match — can only be
// matched by title, and is SOFT evidence: "possibly watched", never eligible.
//
// The narrowed read (`only`) filters every evidence query by tmdb ids OR item
// keys OR show keys OR titles. A tmdb-id-only filter cannot see 2/3/5 at all,
// which is how the delete route used to re-judge a title more leniently than
// the page that offered it. Parity between the two reads is pinned by a test.
//
// Everything here is a read. Nothing writes PlayHistory (guardrail 19).
import { Prisma } from "@/generated/prisma";
import { prisma } from "./prisma";
import { currentActivityGeneration, getRetentionCutoff, isPlayHistoryEnabled, isSourceEnabled } from "./play-history";
import { processSingleton } from "./process-singleton";
import { coalesce } from "./concurrency";
import { mediaInstanceLabel } from "./media-instances";
import { cleanupKey, type CleanupMediaType } from "./library-cleanup";
import type { ArrLibraryEntry, ArrLibraryIndex } from "./library-cleanup-arr";
import {
  EMPTY_EVIDENCE,
  TRACKING_STAMP_KEYS,
  earliestDate,
  judgeSeason,
  judgeTitle,
  latestDate,
  normalizeTitleKey,
  parseStampDate,
  upstreamHealth,
  type NwContext,
  type NwCoverage,
  type NwEvidence,
  type NwHolder,
  type NwSeasonFacts,
  type NwSeasonVerdict,
  type NwSource,
  type NwUpstreamHealth,
  type NwUpstreamStatus,
  type NwVerdict,
} from "./never-watched";

export const NEVER_WATCHED_FEATURE_KEY = "feature.admin.neverWatched";

const UPSTREAM_STATUS_PREFIX = "upstreamWatch:status:";

// The Setting row holding one server's last upstream-watch refresh outcome.
export function upstreamStatusKey(source: NwSource, instance: string): string {
  return `${UPSTREAM_STATUS_PREFIX}${source}:${instance}`;
}

export function parseUpstreamStatus(raw: string | null | undefined): NwUpstreamStatus | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<NwUpstreamStatus>;
    const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : 0);
    const str = (x: unknown) => (typeof x === "string" && x.length > 0 ? x : null);
    return {
      fetchedAt: str(v.fetchedAt),
      attemptedAt: str(v.attemptedAt),
      ok: v.ok === true,
      entries: num(v.entries),
      matched: num(v.matched),
      samples: num(v.samples),
      agreed: num(v.agreed),
      error: str(v.error),
    };
  } catch {
    return null;
  }
}

export interface ServerCoverage extends NwCoverage {
  // The media server's own watch-record snapshot for this server.
  upstream: NwUpstreamStatus | null;
  upstreamHealth: NwUpstreamHealth;
}

export interface LibraryWatchTitle {
  tmdbId: number;
  mediaType: CleanupMediaType;
  title: string;
  year: string | null;
  // Media-server labels holding the title: "plex", "jellyfin", "plex:remote", …
  servers: string[];
  holders: NwHolder[];
  // Earliest addedAt any holding media server reports (display).
  addedAt: Date | null;
  // Earliest arrival from ANY source: media servers, Radarr/Sonarr, a fulfilled request.
  shelfStart: Date | null;
  evidence: NwEvidence;
  playingNow: boolean;
  verdict: NwVerdict;
  // Holding servers whose own watch records were not checked successfully and
  // recently (upstream health other than "ok").
  upstreamUnchecked: string[];
  // Present only when seasons were requested, and only for a show that HAS been
  // watched (a never-watched show is reported whole).
  seasons?: NwSeasonVerdict[];
}

export interface LibraryWatchFacts {
  titles: LibraryWatchTitle[];
  ctx: NwContext;
  coverage: ServerCoverage[];
  // Recorded plays no tmdb id, item key, show key or title could place on a
  // library title — the honest size of what the verdict can't see.
  unplacedPlays: number;
  // Of the unattributed plays, how many only a title match placed (soft evidence).
  softPlays: number;
  // Earliest recorded play anywhere (display only — never a window).
  historyStart: Date | null;
}

export type TitleKey = { tmdbId: number; mediaType: CleanupMediaType };

interface Acc {
  plays: number;
  lastPlayedAt: Date | null;
  undated: boolean;
  softPlays: number;
  softLastPlayedAt: Date | null;
  softServers: Set<string>;
}

function newAcc(): Acc {
  return { plays: 0, lastPlayedAt: null, undated: false, softPlays: 0, softLastPlayedAt: null, softServers: new Set() };
}

function addHard(acc: Acc, count: number, at: Date | null) {
  if (count <= 0) return;
  acc.plays += count;
  if (at) acc.lastPlayedAt = latestDate(acc.lastPlayedAt, at);
  else acc.undated = true;
}

function addSoft(acc: Acc, count: number, at: Date | null, server: string) {
  if (count <= 0) return;
  acc.softPlays += count;
  acc.softLastPlayedAt = latestDate(acc.softLastPlayedAt, at);
  acc.softServers.add(server);
}

function toEvidence(acc: Acc | undefined): NwEvidence {
  if (!acc) return EMPTY_EVIDENCE;
  return {
    plays: acc.plays,
    lastPlayedAt: acc.lastPlayedAt,
    undated: acc.undated,
    softPlays: acc.softPlays,
    softLastPlayedAt: acc.softLastPlayedAt,
    softServers: [...acc.softServers].sort(),
  };
}

const keyOf = (source: string, instance: string, itemKey: string) => `${source}|${instance}|${itemKey}`;

const isSource = (s: string): s is NwSource => s === "plex" || s === "jellyfin";

// Per-show working state.
interface Working {
  t: Omit<LibraryWatchTitle, "evidence" | "verdict" | "upstreamUnchecked" | "seasons" | "shelfStart">;
  addedDates: Date[];
  show: Acc;
  // seasonNumber → evidence; season-less TV evidence lives in `seasonUnknown`.
  seasons: Map<number, Acc>;
  seasonUnknown: Acc;
}

export async function loadLibraryWatchFacts(
  arr: ArrLibraryIndex | null,
  opts: { only?: readonly TitleKey[]; seasons?: boolean; now?: Date } = {},
): Promise<LibraryWatchFacts> {
  const now = opts.now ?? new Date();
  const only = opts.only;
  const onlyIds = only ? [...new Set(only.map((k) => k.tmdbId))] : null;
  const onlyKeys = only ? new Set(only.map((k) => cleanupKey(k.tmdbId, k.mediaType))) : null;
  const idFilter = onlyIds ? { tmdbId: { in: onlyIds } } : {};

  const [plexRows, jfRows] = await Promise.all([
    prisma.plexLibraryItem.findMany({
      where: idFilter,
      select: {
        tmdbId: true, mediaType: true, serverInstance: true, title: true, year: true, addedAt: true,
        plexRatingKey: true, plexRatingKeys: true,
      },
    }),
    prisma.jellyfinLibraryItem.findMany({
      where: idFilter,
      select: {
        tmdbId: true, mediaType: true, serverInstance: true, title: true, year: true, addedAt: true,
        jellyfinItemId: true, jellyfinItemIds: true,
      },
    }),
  ]);

  const byKey = new Map<string, Working>();
  // (source|instance|itemKey) → title key, for movies and for shows separately.
  const movieKeys = new Map<string, string>();
  const showKeys = new Map<string, string>();
  // (server label|normalized title|mediaType) → title keys, for soft matching.
  const titleIndex = new Map<string, string[]>();
  const indexTitle = (server: string, title: string | null, mediaType: CleanupMediaType, key: string) => {
    const norm = normalizeTitleKey(title);
    if (!norm) return;
    const k = `${server}|${norm}|${mediaType}`;
    const list = titleIndex.get(k);
    if (!list) titleIndex.set(k, [key]);
    else if (!list.includes(key)) list.push(key);
  };

  const absorb = (
    r: { tmdbId: number; mediaType: string; serverInstance: string; title: string | null; year: string | null; addedAt: Date | null },
    source: NwSource,
    itemKeys: string[],
  ) => {
    if (r.mediaType !== "MOVIE" && r.mediaType !== "TV") return;
    const key = cleanupKey(r.tmdbId, r.mediaType);
    if (onlyKeys && !onlyKeys.has(key)) return;
    let w = byKey.get(key);
    if (!w) {
      w = {
        t: {
          tmdbId: r.tmdbId, mediaType: r.mediaType, title: r.title ?? "", year: r.year,
          servers: [], holders: [], addedAt: null, playingNow: false,
        },
        addedDates: [],
        show: newAcc(),
        seasons: new Map(),
        seasonUnknown: newAcc(),
      };
      byKey.set(key, w);
    }
    const server = mediaInstanceLabel(source, r.serverInstance);
    if (!w.t.servers.includes(server)) {
      w.t.servers.push(server);
      w.t.holders.push({ server, source });
    }
    if (r.addedAt) {
      w.addedDates.push(r.addedAt);
      w.t.addedAt = earliestDate(w.t.addedAt, r.addedAt);
    }
    if (!w.t.title && r.title) w.t.title = r.title;
    if (!w.t.year && r.year) w.t.year = r.year;
    const target = r.mediaType === "MOVIE" ? movieKeys : showKeys;
    for (const k of itemKeys) target.set(keyOf(source, r.serverInstance, k), key);
    indexTitle(server, r.title, r.mediaType, key);
  };
  for (const r of plexRows) {
    absorb(r, "plex", [r.plexRatingKey, ...(r.plexRatingKeys ?? [])].filter((k): k is string => !!k));
  }
  for (const r of jfRows) {
    absorb(r, "jellyfin", [r.jellyfinItemId, ...(r.jellyfinItemIds ?? [])].filter((k): k is string => !!k));
  }

  const holderServers = new Map<string, { source: NwSource; instance: string }>();
  for (const r of plexRows) holderServers.set(mediaInstanceLabel("plex", r.serverInstance), { source: "plex", instance: r.serverInstance });
  for (const r of jfRows) holderServers.set(mediaInstanceLabel("jellyfin", r.serverInstance), { source: "jellyfin", instance: r.serverInstance });
  const coverageAndStatus = loadCoverage(now, [...holderServers.values()]);
  if (byKey.size === 0) {
    const { ctx, coverage, historyStart } = await coverageAndStatus;
    return { titles: [], ctx, coverage, unplacedPlays: 0, softPlays: 0, historyStart };
  }

  // Bound every evidence read to the chosen titles when narrowed — by tmdb id OR
  // key OR title, never tmdb id alone (see the header).
  const allMovieKeys = only ? [...new Set([...movieKeys.keys()].map((k) => k.split("|").slice(2).join("|")))] : null;
  const allShowKeys = only ? [...new Set([...showKeys.keys()].map((k) => k.split("|").slice(2).join("|")))] : null;
  const onlyTitles = only ? [...new Set([...byKey.values()].map((w) => w.t.title.trim()).filter((s) => s.length > 0))] : null;
  const tmdbScope = onlyIds ? { in: onlyIds } : { not: null };

  const [
    byTmdb, byTmdbSeason, byMovieItem, byShow, unattributed, active, upstream, fulfilled, coverageResult,
  ] = await Promise.all([
    prisma.playHistory.groupBy({
      by: ["tmdbId", "mediaType"],
      where: { tmdbId: tmdbScope },
      _count: { _all: true },
      _max: { startedAt: true },
    }),
    prisma.playHistory.groupBy({
      by: ["tmdbId", "seasonNumber"],
      where: { tmdbId: tmdbScope, mediaType: "TV" },
      _count: { _all: true },
      _max: { startedAt: true },
    }),
    allMovieKeys && allMovieKeys.length === 0
      ? Promise.resolve([])
      : prisma.playHistory.groupBy({
          by: ["source", "serverInstance", "sourceItemId", "tmdbId"],
          where: { seasonNumber: null, sourceItemId: allMovieKeys ? { in: allMovieKeys } : { not: null } },
          _count: { _all: true },
          _max: { startedAt: true },
        }),
    allShowKeys && allShowKeys.length === 0
      ? Promise.resolve([])
      : prisma.playHistory.groupBy({
          by: ["source", "serverInstance", "sourceShowId", "seasonNumber", "tmdbId"],
          where: { sourceShowId: allShowKeys ? { in: allShowKeys } : { not: null } },
          _count: { _all: true },
          _max: { startedAt: true },
        }),
    onlyTitles && onlyTitles.length === 0
      ? Promise.resolve([])
      : prisma.playHistory.groupBy({
          by: ["source", "serverInstance", "title", "seasonNumber", "sourceItemId", "sourceShowId"],
          where: {
            tmdbId: null,
            // `contains`, not `equals`: the stored title may carry padding the
            // in-memory normalizeTitleKey trims, and the narrowed read must find
            // every row the full read would (parity, pinned). The exact match is
            // made below, the same way for both reads.
            ...(onlyTitles ? { OR: onlyTitles.map((title) => ({ title: { contains: title, mode: "insensitive" as const } })) } : {}),
          },
          _count: { _all: true },
          _max: { startedAt: true },
        }),
    prisma.activeSession.findMany({
      select: {
        source: true, serverInstance: true, tmdbId: true, mediaType: true, title: true,
        seasonNumber: true, sourceItemId: true, sourceShowId: true, lastSeenAt: true,
      },
    }),
    prisma.upstreamWatchEvidence.findMany({
      where: only ? { itemKey: { in: [...new Set([...(allMovieKeys ?? []), ...(allShowKeys ?? [])])] } } : {},
      select: { source: true, serverInstance: true, itemKey: true, seasonNumber: true, mediaType: true, playCount: true, lastPlayedAt: true },
    }),
    prisma.mediaRequest.groupBy({
      by: ["tmdbId", "mediaType"],
      where: { ...idFilter, status: "AVAILABLE", availableAt: { not: null } },
      _min: { availableAt: true },
    }),
    coverageAndStatus,
  ]);

  const get = (tmdbId: number | null, mediaType: string | null) =>
    tmdbId == null || mediaType == null ? undefined : byKey.get(cleanupKey(tmdbId, mediaType));
  const seasonAcc = (w: Working, season: number | null): Acc => {
    if (season == null || season < 0) return w.seasonUnknown;
    let acc = w.seasons.get(season);
    if (!acc) {
      acc = newAcc();
      w.seasons.set(season, acc);
    }
    return acc;
  };
  // Hard evidence for a show also lands on its season (or "season unknown").
  const hardTv = (w: Working, season: number | null, count: number, at: Date | null) => {
    addHard(w.show, count, at);
    addHard(seasonAcc(w, season), count, at);
  };

  // 1. By tmdb id (show-level; the per-season split comes from byTmdbSeason).
  for (const p of byTmdb) {
    const w = get(p.tmdbId, p.mediaType);
    if (w) addHard(w.show, p._count._all, p._max.startedAt ?? null);
  }
  for (const p of byTmdbSeason) {
    const w = get(p.tmdbId, "TV");
    if (w) addHard(seasonAcc(w, p.seasonNumber), p._count._all, p._max.startedAt ?? null);
  }
  // 2. By the movie's own item key. A group whose tmdb id IS the title's was
  //    already counted in 1 — skip it, or the play count doubles.
  for (const p of byMovieItem) {
    if (!p.sourceItemId) continue;
    const key = movieKeys.get(keyOf(p.source, p.serverInstance, p.sourceItemId));
    const w = key ? byKey.get(key) : undefined;
    if (!w || p.tmdbId === w.t.tmdbId) continue;
    addHard(w.show, p._count._all, p._max.startedAt ?? null);
  }
  // 3. By the show's key — same double-count rule.
  for (const p of byShow) {
    if (!p.sourceShowId) continue;
    const key = showKeys.get(keyOf(p.source, p.serverInstance, p.sourceShowId));
    const w = key ? byKey.get(key) : undefined;
    if (!w || p.tmdbId === w.t.tmdbId) continue;
    hardTv(w, p.seasonNumber, p._count._all, p._max.startedAt ?? null);
  }
  // Unattributed plays: placed by key (already counted above, as hard) or by
  // title (soft), or nowhere.
  let unplacedPlays = 0;
  let softPlays = 0;
  for (const p of unattributed) {
    const n = p._count._all;
    if (p.sourceItemId && movieKeys.has(keyOf(p.source, p.serverInstance, p.sourceItemId))) continue;
    if (p.sourceShowId && showKeys.has(keyOf(p.source, p.serverInstance, p.sourceShowId))) continue;
    if (!isSource(p.source)) continue;
    const server = mediaInstanceLabel(p.source, p.serverInstance);
    // An unmatched play stores no mediaType; a season number means an episode.
    const mediaType: CleanupMediaType = p.seasonNumber != null ? "TV" : "MOVIE";
    const keys = titleIndex.get(`${server}|${normalizeTitleKey(p.title)}|${mediaType}`) ?? [];
    if (keys.length === 0) {
      unplacedPlays += n;
      continue;
    }
    softPlays += n;
    for (const key of keys) {
      const w = byKey.get(key)!;
      addSoft(w.show, n, p._max.startedAt ?? null, server);
      if (mediaType === "TV") addSoft(seasonAcc(w, p.seasonNumber), n, p._max.startedAt ?? null, server);
    }
  }
  // 4. Playing now — a session is one (live) play, matched the same ways.
  for (const a of active) {
    let w = get(a.tmdbId, a.mediaType);
    if (!w && a.sourceItemId) {
      const k = movieKeys.get(keyOf(a.source, a.serverInstance, a.sourceItemId));
      w = k ? byKey.get(k) : undefined;
    }
    if (!w && a.sourceShowId) {
      const k = showKeys.get(keyOf(a.source, a.serverInstance, a.sourceShowId));
      w = k ? byKey.get(k) : undefined;
    }
    if (w) {
      w.t.playingNow = true;
      if (w.t.mediaType === "TV") hardTv(w, a.seasonNumber, 1, a.lastSeenAt);
      else addHard(w.show, 1, a.lastSeenAt);
      continue;
    }
    if (a.tmdbId == null && isSource(a.source)) {
      const server = mediaInstanceLabel(a.source, a.serverInstance);
      const mediaType: CleanupMediaType = a.seasonNumber != null ? "TV" : "MOVIE";
      for (const key of titleIndex.get(`${server}|${normalizeTitleKey(a.title)}|${mediaType}`) ?? []) {
        const sw = byKey.get(key)!;
        addSoft(sw.show, 1, a.lastSeenAt, server);
        if (mediaType === "TV") addSoft(seasonAcc(sw, a.seasonNumber), 1, a.lastSeenAt, server);
      }
    }
  }
  // 5. The media server's own records — keyed by upstream id, joined here.
  for (const u of upstream) {
    const map = u.mediaType === "MOVIE" ? movieKeys : showKeys;
    const k = map.get(keyOf(u.source, u.serverInstance, u.itemKey));
    const w = k ? byKey.get(k) : undefined;
    if (!w) continue;
    if (w.t.mediaType === "TV") hardTv(w, u.seasonNumber, Math.max(1, u.playCount), u.lastPlayedAt);
    else addHard(w.show, Math.max(1, u.playCount), u.lastPlayedAt);
  }

  const availableAt = new Map<string, Date>();
  for (const f of fulfilled) {
    if (f._min.availableAt) availableAt.set(cleanupKey(f.tmdbId, f.mediaType), f._min.availableAt);
  }

  const { ctx, coverage, historyStart } = coverageResult;
  const healthByServer = new Map(coverage.map((c) => [c.server, c.upstreamHealth]));

  const titles: LibraryWatchTitle[] = [];
  const watchedShows: Array<{ w: Working; out: LibraryWatchTitle }> = [];
  for (const [key, w] of byKey) {
    const arrEntries: ArrLibraryEntry[] = arr?.byKey.get(key) ?? [];
    const shelfStart = earliestDate(...w.addedDates, ...arrEntries.map((e) => e.added ?? null), availableAt.get(key) ?? null);
    const evidence = toEvidence(w.show);
    const verdict = judgeTitle(w.t.holders, shelfStart, evidence, ctx);
    const out: LibraryWatchTitle = {
      ...w.t,
      servers: [...w.t.servers].sort(),
      shelfStart,
      evidence,
      verdict,
      upstreamUnchecked: w.t.servers.filter((s) => healthByServer.get(s) !== "ok").sort(),
    };
    titles.push(out);
    if (opts.seasons && w.t.mediaType === "TV" && verdict.state === "watched") watchedShows.push({ w, out });
  }

  if (watchedShows.length > 0) {
    const facts = await loadSeasonFacts(onlyIds ? watchedShows.map((s) => s.w.t.tmdbId) : null);
    for (const { w, out } of watchedShows) {
      const seasons = facts.get(w.t.tmdbId) ?? [];
      // A season-less play of the show (an episode with no season recorded)
      // could be ANY season, so it can only ever be soft evidence for each.
      const unknown = w.seasonUnknown;
      out.seasons = seasons.map((s) => {
        const acc = w.seasons.get(s.seasonNumber);
        const ev = toEvidence(acc);
        const merged: NwEvidence = unknown.plays > 0 || unknown.softPlays > 0
          ? {
              ...ev,
              softPlays: ev.softPlays + unknown.plays + unknown.softPlays,
              softLastPlayedAt: latestDate(ev.softLastPlayedAt, unknown.lastPlayedAt, unknown.softLastPlayedAt),
              softServers: [...new Set([...ev.softServers, ...unknown.softServers])].sort(),
            }
          : ev;
        return judgeSeason(out.holders, s, merged, ctx);
      });
    }
  }

  return { titles, ctx, coverage, unplacedPlays, softPlays, historyStart };
}

// Per-server recording coverage and upstream status.
async function loadCoverage(
  now: Date,
  holderServers: ReadonlyArray<{ source: NwSource; instance: string }>,
): Promise<{ ctx: NwContext; coverage: ServerCoverage[]; historyStart: Date | null }> {
  const [trackingOn, plexOn, jfOn, starts, retentionCutoff, settingRows] = await Promise.all([
    isPlayHistoryEnabled(),
    isSourceEnabled("plex"),
    isSourceEnabled("jellyfin"),
    firstPlayPerServer(),
    getRetentionCutoff(now),
    prisma.setting.findMany({
      where: {
        OR: [
          { key: { in: Object.values(TRACKING_STAMP_KEYS) } },
          { key: { startsWith: UPSTREAM_STATUS_PREFIX } },
        ],
      },
      select: { key: true, value: true },
    }),
  ]);
  const settings = new Map(settingRows.map((r) => [r.key, r.value]));
  const stamp = (k: string) => parseStampDate(settings.get(k));
  const globalSince = stamp(TRACKING_STAMP_KEYS.playHistoryEnabled);
  const sourceSince: Record<NwSource, Date | null> = {
    plex: stamp(TRACKING_STAMP_KEYS.playHistoryPlexEnabled),
    jellyfin: stamp(TRACKING_STAMP_KEYS.playHistoryJellyfinEnabled),
  };
  const tracked: Record<NwSource, boolean> = { plex: plexOn, jellyfin: jfOn };

  const coverage = new Map<string, ServerCoverage>();
  const ensure = (source: NwSource, instance: string): ServerCoverage => {
    const server = mediaInstanceLabel(source, instance);
    let c = coverage.get(server);
    if (!c) {
      const upstream = parseUpstreamStatus(settings.get(upstreamStatusKey(source, instance)));
      c = { server, source, tracked: tracked[source], since: null, upstream, upstreamHealth: upstreamHealth(upstream, now) };
      coverage.set(server, c);
    }
    return c;
  };
  let historyStart: Date | null = null;
  for (const s of starts) {
    if (!isSource(s.source)) continue;
    const first = s._min.startedAt ?? null;
    historyStart = earliestDate(historyStart, first);
    const c = ensure(s.source, s.serverInstance);
    // Recording is trusted from the later of the first recorded play, the last
    // time tracking (global or this source) was switched back on, and the
    // retention cutoff — a play before it is deleted (or about to be), so it
    // can never be evidence and a window must never reach back past it.
    c.since = first ? latestDate(first, globalSince, sourceSince[s.source], retentionCutoff) : null;
  }
  // A holding server with nothing recorded yet still needs its entry, or the
  // verdict would read it as "untracked" instead of "no history". Servers with
  // only an upstream snapshot belong in the list too.
  for (const h of holderServers) ensure(h.source, h.instance);
  for (const key of settings.keys()) {
    if (!key.startsWith(UPSTREAM_STATUS_PREFIX)) continue;
    const [source, ...rest] = key.slice(UPSTREAM_STATUS_PREFIX.length).split(":");
    if (isSource(source)) ensure(source, rest.join(":"));
  }

  return {
    ctx: { now, trackingOn, coverage },
    coverage: [...coverage.values()].sort((a, b) => a.server.localeCompare(b.server)),
    historyStart,
  };
}

// Each server's earliest surviving recorded play. A whole-table aggregate, so it
// is shared for a few minutes rather than paid on every detail page an admin
// opens, and dropped whenever the activity cache is (a finalize, a history
// delete). The hourly retention purge does NOT clear it — which is safe only
// because coverage is clamped to the retention cutoff in loadCoverage: a stale
// first play from before the cutoff can never open a window over purged rows.
const FIRST_PLAY_TTL_MS = 5 * 60 * 1000;
const firstPlayCache = processSingleton("never-watched:first-play", () => ({
  value: null as Array<{ source: string; serverInstance: string; _min: { startedAt: Date | null } }> | null,
  at: 0,
  generation: -1,
}));

async function firstPlayPerServer() {
  const generation = currentActivityGeneration();
  const c = firstPlayCache;
  if (c.value && c.generation === generation && Date.now() - c.at < FIRST_PLAY_TTL_MS) return c.value;
  return coalesce(`never-watched:first-play:${generation}`, async () => {
    const rows = await prisma.playHistory.groupBy({ by: ["source", "serverInstance"], _min: { startedAt: true } });
    if (currentActivityGeneration() === generation) {
      c.value = rows;
      c.at = Date.now();
      c.generation = generation;
    }
    return rows;
  });
}

// Distinct episodes and arrival dates per (show, season) — the media servers'
// own numbering, specials excluded (TVEpisodeCache never stores season 0).
async function loadSeasonFacts(onlyShowIds: number[] | null): Promise<Map<number, NwSeasonFacts[]>> {
  const scope = onlyShowIds
    ? Prisma.sql`AND "tmdbId" IN (${Prisma.join(onlyShowIds)})`
    : Prisma.empty;
  const rows = await prisma.$queryRaw<Array<{
    tmdbId: number;
    seasonNumber: number;
    episodes: number;
    firstAddedAt: Date | null;
    lastAddedAt: Date | null;
    undated: number;
  }>>(Prisma.sql`
    SELECT "tmdbId", "seasonNumber",
      COUNT(DISTINCT "episodeNumber")::int AS "episodes",
      MIN("addedAt") AS "firstAddedAt",
      MAX("addedAt") AS "lastAddedAt",
      (COUNT(*) - COUNT("addedAt"))::int AS "undated"
    FROM "TVEpisodeCache"
    WHERE "seasonNumber" > 0 ${scope}
    GROUP BY "tmdbId", "seasonNumber"
  `);
  const out = new Map<number, NwSeasonFacts[]>();
  for (const r of rows) {
    // One undated episode makes the season's arrival unknowable: the newest
    // episode could be that one, and an unknown arrival is never guessed.
    const dated = Number(r.undated) === 0;
    const facts: NwSeasonFacts = {
      seasonNumber: Number(r.seasonNumber),
      episodes: Number(r.episodes),
      firstAddedAt: dated ? r.firstAddedAt : null,
      lastAddedAt: dated ? r.lastAddedAt : null,
    };
    const list = out.get(Number(r.tmdbId));
    if (list) list.push(facts);
    else out.set(Number(r.tmdbId), [facts]);
  }
  for (const list of out.values()) list.sort((a, b) => a.seasonNumber - b.seasonNumber);
  return out;
}
