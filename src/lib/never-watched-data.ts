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
// matched by title (against a library title of its type on ANY server: the
// server that played it may never have identified the item), and is SOFT
// evidence: "possibly watched", never eligible.
//
// An item key can sit on more than one title (a 37b conflation whose losing key
// rides another row's plexRatingKeys), so a key credits EVERY title that answers
// to it — never only the last library row read, which would make the verdict
// depend on row order.
//
// The narrowed read (`only`) filters every evidence query by tmdb ids OR item
// keys OR show keys OR titles (every holder's own title — servers may name a
// title differently). A tmdb-id-only filter cannot see 2/3/5 at all, which is
// how the delete route used to re-judge a title more leniently than the page
// that offered it. It must also know which keys belong to OTHER library titles:
// an unattributed play keyed to an unchosen title is placed there in the full
// read, so it is never soft evidence for a same-named chosen one. Parity
// between the two reads is pinned by a test.
//
// Everything here is a read. Nothing writes PlayHistory (guardrail 19).
import { Prisma } from "@/generated/prisma";
import { prisma } from "./prisma";
import { currentActivityGeneration, getRetentionCutoff, isPlayHistoryEnabled, isSourceEnabled } from "./play-history";
import { processSingleton } from "./process-singleton";
import { coalesce } from "./concurrency";
import { mediaInstanceLabel } from "./media-instances";
import { cleanupKey, type CleanupMediaType } from "./library-cleanup";
import type { ArrLibraryIndex } from "./library-cleanup-arr";
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
      // Rows written before these fields read as a complete read with no
      // episode records — what upstreamHealth assumed of them before.
      truncated: v.truncated === true,
      episodeRecords: num(v.episodeRecords),
      unplacedEpisodes: num(v.unplacedEpisodes),
    };
  } catch {
    return null;
  }
}

export interface ServerCoverage extends NwCoverage {
  // The media server's own watch-record snapshot for this server.
  upstream: NwUpstreamStatus | null;
  upstreamHealth: NwUpstreamHealth;
  // A library title sits on this server right now. Only a holding server can
  // hold a title back (upstreamUnchecked is per holder); the others — a
  // de-registered slug whose PlayHistory is kept (guardrails 19/28), a server
  // that emptied — are listed for their coverage but never named as unchecked.
  holds: boolean;
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
  // Earliest arrival: every holder's own addedAt and a fulfilled request's
  // availableAt. Never Radarr/Sonarr's `added` — when the title entered the
  // arr, often long before any file existed (guardrail 14d).
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

// A play's media type as the poller stored it (it records the item type even
// when no tmdb id resolved). The season heuristic is only for a row with no
// type at all — an absolute-numbered episode has no season, and guessing MOVIE
// for it would soft-match a same-named film instead of its show.
const playMediaType = (mediaType: string | null, seasonNumber: number | null): CleanupMediaType =>
  mediaType === "TV" || mediaType === "MOVIE" ? mediaType : seasonNumber != null ? "TV" : "MOVIE";

const pushUnique = (map: Map<string, string[]>, k: string, v: string) => {
  const list = map.get(k);
  if (!list) map.set(k, [v]);
  else if (!list.includes(v)) list.push(v);
};

// Past this many chosen titles the narrowed read's unattributed-play title
// filter (one ILIKE '%title%' per title — nothing can index a leading wildcard)
// costs more than the full read's unfiltered query, so it IS that query. Parity
// holds by construction: the exact per-server match is made in memory either way.
export const NARROW_TITLE_FILTER_MAX = 50;

// How many of the evidence read's whole-table PlayHistory aggregates run at once.
export const EVIDENCE_AGGREGATE_CONCURRENCY = 2;

// At most `n` of the tasks it wraps run at once; the rest wait their turn, and a
// finishing task hands its slot straight to the next. Typed per call, for a
// fixed set of DIFFERENT queries (mapLimit wants one task type).
function taskGate(n: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active < n) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

// Per-show working state.
interface Working {
  t: Omit<LibraryWatchTitle, "evidence" | "verdict" | "upstreamUnchecked" | "seasons" | "shelfStart">;
  // Every holder row's own title (trimmed): the narrowed read's title filter.
  titles: Set<string>;
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
  // (source|instance|itemKey) → EVERY title key answering to it, for movies and
  // for shows separately (one key can sit on two titles — see the header).
  const movieKeys = new Map<string, string[]>();
  const showKeys = new Map<string, string[]>();
  // (normalized title|mediaType) → title keys, for soft matching. Deliberately
  // NOT per server: a play the server couldn't identify — or one from a server
  // whose library holding the title isn't synced (its `Libraries` selection) —
  // is stored with no tmdb id and a key no library row answers to, on a server
  // that holds no such title, while the file it played is the one another
  // server holds. Soft evidence only ever withholds eligibility, so matching it
  // anywhere leans the safe way (14d). It is also what keeps the narrowed read
  // at parity: whether a play matches a title depends on that pair alone, never
  // on which OTHER titles a server holds (the narrowed read can't see those).
  const titleIndex = new Map<string, string[]>();
  const indexTitle = (title: string | null, mediaType: CleanupMediaType, key: string) => {
    const norm = normalizeTitleKey(title);
    if (!norm) return;
    pushUnique(titleIndex, `${norm}|${mediaType}`, key);
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
        titles: new Set(),
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
    const ownTitle = r.title?.trim();
    if (ownTitle) w.titles.add(ownTitle);
    if (!w.t.year && r.year) w.t.year = r.year;
    const target = r.mediaType === "MOVIE" ? movieKeys : showKeys;
    for (const k of itemKeys) pushUnique(target, keyOf(source, r.serverInstance, k), key);
    indexTitle(r.title, r.mediaType, key);
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
  // The sources those movie keys were read from. Narrowed only, and NOT an
  // evidence filter: a key-attributed group counts only when (source, instance,
  // key) is in movieKeys, so a play from any other source could never match.
  // What it buys is the index — PlayHistory's only sourceItemId index is led by
  // `source`, and without that predicate (Postgres has no skip scan) the
  // detail-page chip's movie read scans the whole table.
  const movieKeySources = only ? [...new Set([...movieKeys.keys()].map((k) => k.split("|")[0]))] : null;
  // Every holder row's own title, not one per title: a Plex "The Office (US)"
  // never ILIKE-contains a Jellyfin play titled "The Office".
  const narrowTitles = only ? [...new Set([...byKey.values()].flatMap((w) => [...w.titles]))] : null;
  const onlyTitles = narrowTitles && narrowTitles.length <= NARROW_TITLE_FILTER_MAX ? narrowTitles : null;
  const tmdbScope = onlyIds ? { in: onlyIds } : { not: null };

  // The five PlayHistory aggregates are whole-table GROUP BYs on the full read.
  // At most two hold a pool connection at once (the pool is max 5, and a cleanup
  // page, the report and the storage stats can each be loading): the cheap
  // reads beside them still run in parallel (guardrail 31's spirit — never a
  // $transaction, which would pin them all to one connection anyway).
  const aggregate = taskGate(EVIDENCE_AGGREGATE_CONCURRENCY);
  const [
    byTmdb, byTmdbSeason, byMovieItem, byShow, unattributed, active, upstream, fulfilled, coverageResult,
  ] = await Promise.all([
    aggregate(() => prisma.playHistory.groupBy({
      by: ["tmdbId", "mediaType"],
      where: { tmdbId: tmdbScope },
      _count: { _all: true },
      _max: { startedAt: true },
    })),
    aggregate(() => prisma.playHistory.groupBy({
      by: ["tmdbId", "seasonNumber"],
      where: { tmdbId: tmdbScope, mediaType: "TV" },
      _count: { _all: true },
      _max: { startedAt: true },
    })),
    allMovieKeys && allMovieKeys.length === 0
      ? Promise.resolve([])
      : aggregate(() => prisma.playHistory.groupBy({
          by: ["source", "serverInstance", "sourceItemId", "tmdbId"],
          where: {
            seasonNumber: null,
            ...(movieKeySources ? { source: { in: movieKeySources } } : {}),
            sourceItemId: allMovieKeys ? { in: allMovieKeys } : { not: null },
          },
          _count: { _all: true },
          _max: { startedAt: true },
        })),
    allShowKeys && allShowKeys.length === 0
      ? Promise.resolve([])
      // Narrowed, this is served by PlayHistory @@index([sourceShowId]).
      : aggregate(() => prisma.playHistory.groupBy({
          by: ["source", "serverInstance", "sourceShowId", "seasonNumber", "tmdbId"],
          where: { sourceShowId: allShowKeys ? { in: allShowKeys } : { not: null } },
          _count: { _all: true },
          _max: { startedAt: true },
        })),
    onlyTitles && onlyTitles.length === 0
      ? Promise.resolve([])
      : aggregate(() => prisma.playHistory.groupBy({
          by: ["source", "serverInstance", "title", "mediaType", "seasonNumber", "sourceItemId", "sourceShowId"],
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
        })),
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
    // Grouped per instance and per cleanup stamp, not just per title: a stamped
    // request's date (and one whose instance re-added the title since) is the
    // DELETED copy's arrival and is dropped below.
    prisma.mediaRequest.groupBy({
      by: ["tmdbId", "mediaType", "arrInstance", "cleanedUpAt"],
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
  const titlesFor = (map: Map<string, string[]>, source: string, instance: string, itemKey: string | null): Working[] =>
    itemKey ? (map.get(keyOf(source, instance, itemKey)) ?? []).map((k) => byKey.get(k)!) : [];
  // 2. By the movie's own item key — every title answering to it. A group whose
  //    tmdb id IS that title's was already counted in 1 — skip it, or the play
  //    count doubles.
  for (const p of byMovieItem) {
    for (const w of titlesFor(movieKeys, p.source, p.serverInstance, p.sourceItemId)) {
      if (p.tmdbId === w.t.tmdbId) continue;
      addHard(w.show, p._count._all, p._max.startedAt ?? null);
    }
  }
  // 3. By the show's key — same double-count rule.
  for (const p of byShow) {
    for (const w of titlesFor(showKeys, p.source, p.serverInstance, p.sourceShowId)) {
      if (p.tmdbId === w.t.tmdbId) continue;
      hardTv(w, p.seasonNumber, p._count._all, p._max.startedAt ?? null);
    }
  }
  // Every title a live session is: by tmdb id AND by its item and show keys —
  // the tmdb id the poller stored can name a different library title than the
  // one owning the key (a conflation, a rematch done in Plex), and both are it.
  const sessionTitles = (a: (typeof active)[number]): Set<Working> => {
    const out = new Set<Working>(titlesFor(movieKeys, a.source, a.serverInstance, a.sourceItemId));
    for (const w of titlesFor(showKeys, a.source, a.serverInstance, a.sourceShowId)) out.add(w);
    const byTmdbId = get(a.tmdbId, a.mediaType);
    if (byTmdbId) out.add(byTmdbId);
    return out;
  };
  // Any server's same-named title (see titleIndex); the play's own server is
  // still the one recorded in softServers (display only).
  const softTitles = (source: string, title: string | null, mediaType: CleanupMediaType): string[] =>
    isSource(source) ? (titleIndex.get(`${normalizeTitleKey(title)}|${mediaType}`) ?? []) : [];
  const ownsKey = (source: string, instance: string, itemKey: string | null, showKey: string | null) =>
    (!!itemKey && movieKeys.has(keyOf(source, instance, itemKey))) ||
    (!!showKey && showKeys.has(keyOf(source, instance, showKey)));
  // Narrowed only: the item/show keys of OTHER library titles that a tmdb-less
  // play or session would otherwise soft-match onto a chosen one by title. The
  // full read places those by key (hard, on the other title), so this read must
  // too — only the keys a soft match would actually use are looked up.
  const foreign = only
    ? await loadForeignKeys([
        ...unattributed.map((p) => ({ ...p, mediaType: playMediaType(p.mediaType, p.seasonNumber) })),
        ...active
          .filter((a) => a.tmdbId == null && sessionTitles(a).size === 0)
          .map((a) => ({ ...a, mediaType: playMediaType(a.mediaType, a.seasonNumber) })),
      ].filter((p) =>
        !ownsKey(p.source, p.serverInstance, p.sourceItemId, p.sourceShowId) &&
        softTitles(p.source, p.title, p.mediaType).length > 0,
      ))
    : null;
  // Placed by a key — the chosen titles' own (already counted above, as hard),
  // or in the narrowed read another library title's.
  const placedByKey = (source: string, instance: string, itemKey: string | null, showKey: string | null) =>
    ownsKey(source, instance, itemKey, showKey) ||
    (!!foreign && (
      (!!itemKey && foreign.movie.has(keyOf(source, instance, itemKey))) ||
      (!!showKey && foreign.show.has(keyOf(source, instance, showKey)))
    ));
  // Unattributed plays: placed by key or by title (soft), or nowhere.
  let unplacedPlays = 0;
  let softPlays = 0;
  for (const p of unattributed) {
    const n = p._count._all;
    if (placedByKey(p.source, p.serverInstance, p.sourceItemId, p.sourceShowId)) continue;
    if (!isSource(p.source)) continue;
    const server = mediaInstanceLabel(p.source, p.serverInstance);
    const mediaType = playMediaType(p.mediaType, p.seasonNumber);
    const keys = softTitles(p.source, p.title, mediaType);
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
  // 4. Playing now — a session is one (live) play, matched the same ways, and
  //    credited ONCE to each title it is.
  for (const a of active) {
    const credited = sessionTitles(a);
    for (const w of credited) {
      w.t.playingNow = true;
      if (w.t.mediaType === "TV") hardTv(w, a.seasonNumber, 1, a.lastSeenAt);
      else addHard(w.show, 1, a.lastSeenAt);
    }
    if (credited.size > 0) continue;
    if (a.tmdbId == null && isSource(a.source) && !placedByKey(a.source, a.serverInstance, a.sourceItemId, a.sourceShowId)) {
      const server = mediaInstanceLabel(a.source, a.serverInstance);
      const mediaType = playMediaType(a.mediaType, a.seasonNumber);
      for (const key of softTitles(a.source, a.title, mediaType)) {
        const sw = byKey.get(key)!;
        addSoft(sw.show, 1, a.lastSeenAt, server);
        if (mediaType === "TV") addSoft(seasonAcc(sw, a.seasonNumber), 1, a.lastSeenAt, server);
      }
    }
  }
  // 5. The media server's own records — keyed by upstream id, joined here,
  //    crediting every title the key answers to.
  for (const u of upstream) {
    for (const w of titlesFor(u.mediaType === "MOVIE" ? movieKeys : showKeys, u.source, u.serverInstance, u.itemKey)) {
      if (w.t.mediaType === "TV") hardTv(w, u.seasonNumber, Math.max(1, u.playCount), u.lastPlayedAt);
      else addHard(w.show, Math.max(1, u.playCount), u.lastPlayedAt);
    }
  }

  // A fulfilled request's availableAt is an arrival only for a copy that is
  // still the one on the shelf: never a request stamped by a deliberate delete
  // (14b), and never one whose instance has (re-)added the title SINCE — that
  // entry is a new arrival after the removal, so the old delivery belongs to the
  // deleted copy. Dropping a date only ever moves the window later (14d).
  const availableAt = new Map<string, Date>();
  for (const f of fulfilled) {
    const at = f._min.availableAt;
    if (!at || f.cleanedUpAt != null) continue;
    const key = cleanupKey(f.tmdbId, f.mediaType);
    const instance = f.arrInstance ?? "";
    const readded = (arr?.byKey.get(key) ?? []).some((e) => e.instance === instance && e.added != null && e.added.getTime() > at.getTime());
    if (readded) continue;
    const prev = availableAt.get(key);
    if (!prev || at.getTime() < prev.getTime()) availableAt.set(key, at);
  }

  const { ctx, coverage, historyStart } = coverageResult;
  const healthByServer = new Map(coverage.map((c) => [c.server, c.upstreamHealth]));

  const titles: LibraryWatchTitle[] = [];
  const watchedShows: Array<{ w: Working; out: LibraryWatchTitle }> = [];
  for (const [key, w] of byKey) {
    // The arrival is the earliest date that can only be AT OR AFTER the file
    // reached the shelf: a holder's own addedAt (it resets on a re-add or an
    // upgrade, so it errs late — a shorter claim) and a fulfilled request's
    // delivery. Radarr/Sonarr's `added` is when the title entered the arr — an
    // approval pushed before release, an import-list add, a long wanted wait —
    // so it would open the window before any file existed and turn a title
    // downloaded last week into "never watched since March". It is used above
    // only as a bound on availableAt (a re-add since the delivery).
    const shelfStart = earliestDate(...w.addedDates, availableAt.get(key) ?? null);
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
    const { facts, mismatched } = await loadSeasonFacts(onlyIds ? watchedShows.map((s) => s.w.t.tmdbId) : null);
    for (const { w, out } of watchedShows) {
      const seasons = facts.get(w.t.tmdbId) ?? [];
      const numberingDiffers = mismatched.has(w.t.tmdbId);
      out.seasons = seasons.map((s) => {
        const ev = toEvidence(w.seasons.get(s.seasonNumber));
        // A season-less play of the show (an episode with no season recorded)
        // could be ANY season, so it can only ever be soft evidence for each.
        // So can every OTHER season's play when the Plex and Jellyfin copies
        // number the show differently: a play's season is the numbering of the
        // server it was watched on, and can't be placed in the other's.
        const others: Acc[] = [w.seasonUnknown];
        if (numberingDiffers) for (const [n, acc] of w.seasons) if (n !== s.seasonNumber) others.push(acc);
        const extra = others.reduce((sum, a) => sum + a.plays + a.softPlays, 0);
        const merged: NwEvidence = extra > 0
          ? {
              ...ev,
              softPlays: ev.softPlays + extra,
              softLastPlayedAt: latestDate(ev.softLastPlayedAt, ...others.flatMap((a) => [a.lastPlayedAt, a.softLastPlayedAt])),
              softServers: [...new Set([...ev.softServers, ...others.flatMap((a) => [...a.softServers])])].sort(),
            }
          : ev;
        return judgeSeason(out.holders, s, merged, ctx);
      });
    }
  }

  return { titles, ctx, coverage, unplacedPlays, softPlays, historyStart };
}

// ONE whole-library load of the facts above, handed to more than one
// computation of a single caller: the /admin/stats storage section computes the
// Library cleanup report AND the never-watched report, and each used to run this
// whole load (five whole-table PlayHistory aggregates, sessions, upstream
// evidence, requests, coverage) itself. It is loadLibraryWatchFacts called once —
// lazily, memoized — for the Radarr/Sonarr index and the `now` it carries, and
// each computation still does exactly what it does alone (both take it as
// `shared`; a shared value that doesn't fit the read they were asked for throws
// rather than standing in for it). Nothing here judges anything, so it is not a
// second definition of either report (guardrail 14d).
//
// Loaded with `seasons` only when a computation needs them (the never-watched
// report): the title verdicts don't depend on it, so the cleanup report reads
// the same titles either way.
export interface SharedWatchFacts {
  readonly arr: ArrLibraryIndex;
  // When `arr` was listed (the never-watched report's "sizes as of").
  readonly arrAt: Date;
  readonly now: Date;
  readonly seasons: boolean;
  // load() has been called. A cache fed from this load reads it before its own
  // generation check: a load that began earlier may predate an invalidation the
  // check can't see (the guardrail-19b shape — see getNeverWatchedReport).
  readonly started: boolean;
  load(): Promise<LibraryWatchFacts>;
}

export function shareLibraryWatchFacts(
  arr: ArrLibraryIndex,
  arrAt: Date,
  opts: { now: Date; seasons: boolean },
): SharedWatchFacts {
  let pending: Promise<LibraryWatchFacts> | null = null;
  return {
    arr,
    arrAt,
    now: opts.now,
    seasons: opts.seasons,
    get started() {
      return pending !== null;
    },
    load() {
      pending ??= loadLibraryWatchFacts(arr, { seasons: opts.seasons, now: opts.now });
      return pending;
    },
  };
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
      c = { server, source, tracked: tracked[source], since: null, upstream, upstreamHealth: upstreamHealth(upstream, now), holds: false };
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
  for (const h of holderServers) ensure(h.source, h.instance).holds = true;
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

// Narrowed read only: which of these tmdb-less plays' item/show keys belong to a
// library title (any — the chosen ones are already known). Sourced the way
// absorb() reads them: an item key against MOVIE rows, a show key against TV
// rows, every copy's key (plexRatingKeys / jellyfinItemIds) included.
async function loadForeignKeys(
  plays: ReadonlyArray<{ source: string; serverInstance: string; sourceItemId: string | null; sourceShowId: string | null }>,
): Promise<{ movie: Set<string>; show: Set<string> }> {
  const out = { movie: new Set<string>(), show: new Set<string>() };
  const want = { plex: { movie: new Set<string>(), show: new Set<string>() }, jellyfin: { movie: new Set<string>(), show: new Set<string>() } };
  for (const p of plays) {
    if (!isSource(p.source)) continue;
    if (p.sourceItemId) want[p.source].movie.add(p.sourceItemId);
    if (p.sourceShowId) want[p.source].show.add(p.sourceShowId);
  }
  const absorbRow = (source: NwSource, r: { serverInstance: string; mediaType: string }, keys: Array<string | null>) => {
    const target = r.mediaType === "MOVIE" ? out.movie : r.mediaType === "TV" ? out.show : null;
    if (!target) return;
    for (const k of keys) if (k) target.add(keyOf(source, r.serverInstance, k));
  };
  const plexOr: Prisma.PlexLibraryItemWhereInput[] = [];
  const jfOr: Prisma.JellyfinLibraryItemWhereInput[] = [];
  for (const mediaType of ["MOVIE", "TV"] as const) {
    const plexKeys = [...(mediaType === "MOVIE" ? want.plex.movie : want.plex.show)];
    if (plexKeys.length > 0) plexOr.push({ mediaType, plexRatingKey: { in: plexKeys } }, { mediaType, plexRatingKeys: { hasSome: plexKeys } });
    const jfKeys = [...(mediaType === "MOVIE" ? want.jellyfin.movie : want.jellyfin.show)];
    if (jfKeys.length > 0) jfOr.push({ mediaType, jellyfinItemId: { in: jfKeys } }, { mediaType, jellyfinItemIds: { hasSome: jfKeys } });
  }
  const [plexRows, jfRows] = await Promise.all([
    plexOr.length === 0
      ? Promise.resolve([])
      : prisma.plexLibraryItem.findMany({
          where: { OR: plexOr },
          select: { serverInstance: true, mediaType: true, plexRatingKey: true, plexRatingKeys: true },
        }),
    jfOr.length === 0
      ? Promise.resolve([])
      : prisma.jellyfinLibraryItem.findMany({
          where: { OR: jfOr },
          select: { serverInstance: true, mediaType: true, jellyfinItemId: true, jellyfinItemIds: true },
        }),
  ]);
  for (const r of plexRows) absorbRow("plex", r, [r.plexRatingKey, ...(r.plexRatingKeys ?? [])]);
  for (const r of jfRows) absorbRow("jellyfin", r, [r.jellyfinItemId, ...(r.jellyfinItemIds ?? [])]);
  return out;
}

// Distinct episodes and arrival dates per (show, season) — the media servers'
// own numbering, specials excluded (TVEpisodeCache never stores season 0).
// `mismatched` names the shows whose Plex and Jellyfin copies NUMBER the show
// differently (anime in TVDB vs TMDB order): their plays can't be placed by
// season number across servers. Renumbering moves episodes from one season to
// another, so the per-season counts CROSS — one server holds more in some
// season and the other more in another (a season one server lacks counts 0).
// A partial copy is not a disagreement: a server holding fewer seasons, or
// fewer episodes of a season (one not yet scanned, a Libraries difference, a
// multi-episode file indexed once), is smaller or equal everywhere.
async function loadSeasonFacts(onlyShowIds: number[] | null): Promise<{ facts: Map<number, NwSeasonFacts[]>; mismatched: Set<number> }> {
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
    plexEpisodes?: number | null;
    jellyfinEpisodes?: number | null;
  }>>(Prisma.sql`
    SELECT "tmdbId", "seasonNumber",
      COUNT(DISTINCT "episodeNumber")::int AS "episodes",
      MIN("addedAt") AS "firstAddedAt",
      MAX("addedAt") AS "lastAddedAt",
      (COUNT(*) - COUNT("addedAt"))::int AS "undated",
      (COUNT(DISTINCT "episodeNumber") FILTER (WHERE "source" = 'plex'))::int AS "plexEpisodes",
      (COUNT(DISTINCT "episodeNumber") FILTER (WHERE "source" = 'jellyfin'))::int AS "jellyfinEpisodes"
    FROM "TVEpisodeCache"
    WHERE "seasonNumber" > 0 ${scope}
    GROUP BY "tmdbId", "seasonNumber"
  `);
  const out = new Map<number, NwSeasonFacts[]>();
  // Per show: does either server hold MORE than the other in some season?
  const cross = new Map<number, { plexMore: boolean; jellyfinMore: boolean }>();
  for (const r of rows) {
    const plexEps = Number(r.plexEpisodes ?? 0);
    const jfEps = Number(r.jellyfinEpisodes ?? 0);
    const c = cross.get(Number(r.tmdbId)) ?? { plexMore: false, jellyfinMore: false };
    if (plexEps > jfEps) c.plexMore = true;
    if (jfEps > plexEps) c.jellyfinMore = true;
    cross.set(Number(r.tmdbId), c);
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
  // Crossing implies both servers hold the show (each is ahead somewhere).
  const mismatched = new Set<number>();
  for (const [tmdbId, c] of cross) if (c.plexMore && c.jellyfinMore) mismatched.add(tmdbId);
  return { facts: out, mismatched };
}
