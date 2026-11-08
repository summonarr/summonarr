import { authActive } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma";
import { redirect } from "next/navigation";
import { hasPermission, Permission } from "@/lib/permissions";
import Link from "next/link";
import { WarmCacheButton } from "@/components/admin/warm-cache-button";
import { ResyncLibraryButton } from "@/components/admin/resync-library-button";
import { SyncTVEpisodesButton } from "@/components/admin/sync-tv-episodes-button";
import { inferGroupMounts, loadArrPathIndex, mountGroupKey, type ArrPathIndex } from "@/lib/bad-matches";
import { folderOf, stripMountPoint, stripRelPrefix, toMatchKey } from "@/lib/library-paths";
import { LibraryDiffClient, type DiffItem, type ClientBadMatch } from "@/components/admin/library-diff-client";
import { LibraryMatchCheck, type ClientMatchReport } from "@/components/admin/library-match-check";
import { readLibraryMatchReport } from "@/lib/library-match-data";
import { configuredLibrarySyncServers } from "@/lib/library-sync-jobs";
import { folderKey, ownFolder } from "@/lib/library-match";
import {
  diffCollator,
  diffSourceFor,
  makeBadMatchComparator,
  makeDiffComparator,
  type OtherSidePathEntry,
} from "@/lib/library-diff";
import { EmptyState, PageHeader } from "@/components/ui/design";
import { getLocale, getTranslator } from "@/lib/i18n/server";
import { Library } from "@/components/icons";
import { tmdbDetailsKey } from "@/lib/tmdb-cache";
import {
  DEFAULT_MEDIA_INSTANCE,
  isValidMediaInstanceSlug,
  jellyfinSettingKey,
  plexSettingKey,
  type MediaInstanceKey,
} from "@/lib/media-instances";

const LIBRARY_REFRESH_THRESHOLD = 5 * 24 * 60 * 60 * 1000;

export const dynamic = "force-dynamic";

interface RequestSummary {
  total: number;
  statuses: string[];
}

interface LibraryItem {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  // Which configured server the row came from ("" = default/only server).
  serverInstance: string;
  title: string | null;
  posterPath: string | null;
  releaseYear: string | null;
  overview: string | null;
  voteAverage: number | null;
  filePath: string | null;
  requests: RequestSummary;
}

type ArrVerdict = "plex" | "jellyfin" | null;

interface BadMatch {
  relativePath:   string;
  plex:           LibraryItem;
  plexRatingKey:  string | null;
  jellyfin:       LibraryItem;
  jellyfinItemId: string | null;
  arrTmdbId:      number | null;
  arrVerdict:     ArrVerdict;
}

// Most `:details` blobs one enrichItems call reads for titles missing from the
// core table.
const BLOB_FALLBACK_CAP = 1_000;

// The two fields this page reads from a cached TMDB details blob, each checked
// for its type: a corrupt row (or one of another shape) gives no poster or
// rating rather than a wrong-typed value in the client props.
function posterAndRating(data: string): { posterPath: string | null | undefined; voteAverage: number | undefined } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { posterPath, voteAverage } = parsed as { posterPath?: unknown; voteAverage?: unknown };
  return {
    posterPath: typeof posterPath === "string" || posterPath === null ? posterPath : undefined,
    voteAverage: typeof voteAverage === "number" && Number.isFinite(voteAverage) ? voteAverage : undefined,
  };
}

async function enrichItems(
  items: {
    tmdbId: number; mediaType: "MOVIE" | "TV"; filePath?: string | null;
    title?: string | null; year?: string | null; overview?: string | null;
    serverInstance?: string;
  }[]
): Promise<LibraryItem[]> {
  if (items.length === 0) return [];

  // Split by mediaType so each condition is a simple `tmdbId IN [...]` that can
  // use the (tmdbId, mediaType) index. One OR clause per item would be far too
  // large for the database to plan well at up to 25,000 items.
  const movieIds = items.filter((i) => i.mediaType === "MOVIE").map((i) => i.tmdbId);
  const tvIds = items.filter((i) => i.mediaType === "TV").map((i) => i.tmdbId);
  const allRequests = await prisma.mediaRequest.findMany({
    where: {
      OR: [
        ...(movieIds.length ? [{ mediaType: "MOVIE" as const, tmdbId: { in: movieIds } }] : []),
        ...(tvIds.length ? [{ mediaType: "TV" as const, tmdbId: { in: tvIds } }] : []),
      ],
    },
    select: { tmdbId: true, mediaType: true, status: true },
    orderBy: { createdAt: "desc" },
  });
  const requestsMap = new Map<string, string[]>();
  for (const r of allRequests) {
    const key = `${r.tmdbId}:${r.mediaType}`;
    (requestsMap.get(key) ?? requestsMap.set(key, []).get(key)!).push(r.status);
  }

  // TmdbMediaCore first: poster/rating as plain columns instead of pulling and
  // parsing one full `:details` blob (tens of KB) per item — on a divergent
  // library that's thousands of blobs per render across the three enrichItems
  // calls. Core rows expire and get purged, so pairs missing from core fall
  // back to the TmdbCache blob. Same mediaType split as the requests query.
  const cacheMap = new Map<string, { posterPath?: string | null; voteAverage?: number }>();
  const coreRows = await prisma.tmdbMediaCore.findMany({
    where: {
      OR: [
        ...(movieIds.length ? [{ mediaType: "MOVIE" as const, tmdbId: { in: movieIds } }] : []),
        ...(tvIds.length ? [{ mediaType: "TV" as const, tmdbId: { in: tvIds } }] : []),
      ],
    },
    select: { tmdbId: true, mediaType: true, posterPath: true, voteAverage: true },
  });
  for (const r of coreRows) {
    cacheMap.set(`${r.tmdbId}:${r.mediaType}`, { posterPath: r.posterPath, voteAverage: r.voteAverage });
  }

  // A core row with a null poster also falls back — the blob may still carry one
  // (consistent with poster-cache.ts; only costs extra reads for poster-less titles).
  // Each blob is a whole TMDB details document, so at most BLOB_FALLBACK_CAP
  // distinct titles are read this way per call (the diff columns draw 500 cards
  // each); the rest render without art until the core table is backfilled.
  const blobKeyToItem = new Map<string, string>();
  for (const i of items) {
    if (blobKeyToItem.size >= BLOB_FALLBACK_CAP) break;
    const itemKey = `${i.tmdbId}:${i.mediaType}`;
    if (cacheMap.get(itemKey)?.posterPath == null) blobKeyToItem.set(tmdbDetailsKey(i.mediaType, i.tmdbId), itemKey);
  }
  if (blobKeyToItem.size > 0) {
    const cacheRows = await prisma.tmdbCache.findMany({
      where: { key: { in: [...blobKeyToItem.keys()] } },
      select: { key: true, data: true },
    });
    for (const row of cacheRows) {
      const key = blobKeyToItem.get(row.key);
      const blob = key ? posterAndRating(row.data) : null;
      if (!key || !blob) continue;
      // Merge (not replace): a null-poster core hit re-enters as a miss, and a
      // blob without voteAverage must not wipe the core's value.
      const prior = cacheMap.get(key);
      cacheMap.set(key, {
        posterPath: blob.posterPath ?? prior?.posterPath ?? null,
        voteAverage: blob.voteAverage ?? prior?.voteAverage,
      });
    }
  }

  return items.map((i) => {
    const key = `${i.tmdbId}:${i.mediaType}`;
    const cached = cacheMap.get(key);
    const statuses = requestsMap.get(key) ?? [];
    return {
      tmdbId: i.tmdbId,
      mediaType: i.mediaType,
      serverInstance: i.serverInstance ?? DEFAULT_MEDIA_INSTANCE,
      title: i.title ?? null,
      posterPath: cached?.posterPath ?? null,
      releaseYear: i.year ?? null,
      overview: i.overview ?? null,
      voteAverage: cached?.voteAverage ?? null,
      filePath: i.filePath ?? null,
      requests: { total: statuses.length, statuses: [...new Set(statuses)] },
    };
  });
}

// `overview` is excluded from the whole-library pull (heaviest column, only
// rendered for the difference sets). Backfill it for a small set of rows from
// the source library table, keyed by `${tmdbId}:${mediaType}:${serverInstance}`
// — serverInstance is part of the key because it is part of the row's primary
// key: two servers holding the same title are two rows with two overviews, and
// a 2-part key silently attached whichever one came back last to both. Split by
// mediaType to hit the composite index — same shape as enrichItems.
async function fetchOverviews(
  source: "plex" | "jellyfin",
  rows: { tmdbId: number; mediaType: "MOVIE" | "TV" }[],
): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  if (rows.length === 0) return map;

  const movieIds = rows.filter((r) => r.mediaType === "MOVIE").map((r) => r.tmdbId);
  const tvIds    = rows.filter((r) => r.mediaType === "TV").map((r) => r.tmdbId);
  const where = {
    OR: [
      ...(movieIds.length ? [{ mediaType: "MOVIE" as const, tmdbId: { in: movieIds } }] : []),
      ...(tvIds.length    ? [{ mediaType: "TV"    as const, tmdbId: { in: tvIds } }]    : []),
    ],
  };
  if (where.OR.length === 0) return map;

  const found = source === "plex"
    ? await prisma.plexLibraryItem.findMany({ where, select: { tmdbId: true, mediaType: true, overview: true, serverInstance: true } })
    : await prisma.jellyfinLibraryItem.findMany({ where, select: { tmdbId: true, mediaType: true, overview: true, serverInstance: true } });
  for (const r of found) map.set(`${r.tmdbId}:${r.mediaType}:${r.serverInstance}`, r.overview);
  return map;
}

// ── multi-server path normalisation (MIRROR of src/lib/bad-matches.ts) ───────
// The path rules themselves are shared (library-paths.ts), as is the
// Radarr/Sonarr folder map (loadArrPathIndex).
// commonPathPrefix infers a bind-mount root from the longest shared prefix of
// the paths it is handed, so it must only ever see ONE server instance's paths:
// two Plex servers mounted at /plexmedia/… and /mnt/nas/video/… share no leading
// segment, the inferred mount collapses to "", nothing is stripped, and the
// Plex↔Jellyfin join misses every item — the bad-match list silently empties and
// the relative paths shown in the diff columns turn into raw absolute paths.
//
// It must not see two MEDIA TYPES at once either: in the normal layout
// (/data/movies + /data/tv) one mount across both stops at the shared parent, so
// every TV rel keeps its library-dir segment and toMatchKey — segment 0 for TV —
// reduces EVERY show to the single key "tv", collapsing the whole TV half of the
// map onto one entry and pairing unrelated shows.

type StripPrefixField = "MoviePathStripPrefix" | "TvPathStripPrefix";
type StripSettingKey = (instance: MediaInstanceKey, field: StripPrefixField) => string;

// Keyed by (instance, media type) through bad-matches.ts's mountGroupKey, so
// every lookup must use mountKey() rather than the bare serverInstance.
function mountKey(row: { serverInstance: string; mediaType: "MOVIE" | "TV" }): string {
  return mountGroupKey(row.serverInstance, row.mediaType);
}

// One-path groups must NOT fall back to commonPathPrefix (it returns that
// file's own parent dir, shrinking the key to a bare filename) — the shared
// inferGroupMounts handles them exactly as the native bad-match list does.
function mountsByInstance(rows: { serverInstance: string; mediaType: "MOVIE" | "TV"; filePath: string | null }[]): Map<string, string> {
  const groups = new Map<string, { filePath: string | null; mediaType: "MOVIE" | "TV" }[]>();
  for (const r of rows) {
    if (!r.filePath) continue;
    const k = mountKey(r);
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  return inferGroupMounts(groups);
}

// Per-instance strip prefix, falling back to the shared default-instance key
// when the server has no row of its own — which is every existing deployment.
function stripResolver(cfg: Record<string, string>, settingKey: StripSettingKey) {
  return (instance: string, mediaType: "MOVIE" | "TV"): string => {
    const field: StripPrefixField = mediaType === "MOVIE" ? "MoviePathStripPrefix" : "TvPathStripPrefix";
    // A row left with a slug the registry would refuse derives no key of its own.
    const own = instance !== DEFAULT_MEDIA_INSTANCE && isValidMediaInstanceSlug(instance)
      ? cfg[settingKey(instance, field)]
      : undefined;
    return own ?? cfg[settingKey(DEFAULT_MEDIA_INSTANCE, field)] ?? "";
  };
}

// Named instances first, default LAST, so the default server deterministically
// wins when two instances hold the same relative path (a mirrored library). The
// sort is stable, so ordering within one instance — and the whole ordering of a
// single-server deployment — is untouched.
function defaultInstanceLast<T extends { serverInstance: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) =>
    a.serverInstance === b.serverInstance ? 0
      : a.serverInstance === DEFAULT_MEDIA_INSTANCE ? 1
      : b.serverInstance === DEFAULT_MEDIA_INSTANCE ? -1
      : a.serverInstance.localeCompare(b.serverInstance),
  );
}

// Which server holds the WRONG id, by Radarr/Sonarr's answer: the one that
// disagrees with the arr while the other agrees. No verdict when the arr has
// no answer, or agrees with both or neither.
function arrVerdictFor(plexTmdbId: number, jellyfinTmdbId: number, arrTmdbId: number | null): ArrVerdict {
  if (arrTmdbId === null) return null;
  const plexCorrect = plexTmdbId === arrTmdbId;
  const jellyfinCorrect = jellyfinTmdbId === arrTmdbId;
  if (plexCorrect && !jellyfinCorrect) return "jellyfin";
  if (!plexCorrect && jellyfinCorrect) return "plex";
  return null;
}

// Every title (`tmdbId:mediaType`) on each side, read over the WHOLE tables.
// Only read when a side hit the row cap: the capped reads stop at a sort
// position chosen independently on each side, so a title past one side's cut
// would read as "only on" the other and every tile would count it as a
// difference. Two narrow columns, so the full read stays light where the row
// read (paths, titles) has to be capped.
async function wholeLibraryTitleKeys(): Promise<{ plex: Set<string>; jellyfin: Set<string> }> {
  type KeyRow = { tmdbId: number; mediaType: string };
  const [plex, jellyfin] = await Promise.all([
    prisma.$queryRaw<KeyRow[]>(Prisma.sql`SELECT DISTINCT "tmdbId", "mediaType"::text AS "mediaType" FROM "PlexLibraryItem"`),
    prisma.$queryRaw<KeyRow[]>(Prisma.sql`SELECT DISTINCT "tmdbId", "mediaType"::text AS "mediaType" FROM "JellyfinLibraryItem"`),
  ]);
  const keys = (rows: KeyRow[]) => new Set(rows.map((r) => `${r.tmdbId}:${r.mediaType}`));
  return { plex: keys(plex), jellyfin: keys(jellyfin) };
}

// No overview here: bad-match rows never render it (clientBadMatches omits it).
type PathEntryBase = { tmdbId: number; mediaType: "MOVIE" | "TV"; serverInstance: string; filePath: string; title: string | null; year: string | null };
type PlexPathEntry     = PathEntryBase & { ratingKey: string | null };
type JellyfinPathEntry = PathEntryBase & { itemId: string | null };

type LibraryRowKey = { tmdbId: number; mediaType: "MOVIE" | "TV"; serverInstance: string };
// Each row's own join key, so an "only on X" row can be looked up on the other side.
const rowKey = (r: LibraryRowKey) => `${r.tmdbId}:${r.mediaType}:${r.serverInstance}`;

// One server's rows by match key. Every instance's rows normalise against
// their OWN mount and strip prefix, then merge into one keyspace — the
// Plex↔Jellyfin join is relative-path keyed and can't be instance-scoped (a
// file is normally on a Plex server AND a Jellyfin server, under unrelated
// slugs). Two instances holding the same relative path is a mirrored library,
// so the collapse is correct; the default-last ordering decides the winner
// deterministically. An empty match key is not an identity: paths sharing no
// first segment infer a "" mount, and every such row would otherwise pile onto
// one blank entry and pair two unrelated titles.
function buildPathIndex<R extends LibraryRowKey & { filePath: string | null }, E>(
  rows: R[],
  mounts: Map<string, string>,
  stripFor: (instance: string, mediaType: "MOVIE" | "TV") => string,
  entry: (row: R, filePath: string) => E,
): { pathMap: Map<string, E>; keyByRow: Map<string, string> } {
  const pathMap = new Map<string, E>();
  const keyByRow = new Map<string, string>();
  for (const item of defaultInstanceLast(rows)) {
    if (!item.filePath) continue;
    const rel = stripMountPoint(item.filePath, mounts.get(mountKey(item)) ?? "");
    if (!rel) continue;
    const matchKey = toMatchKey(stripRelPrefix(rel, stripFor(item.serverInstance, item.mediaType)), item.mediaType);
    if (!matchKey) continue;
    keyByRow.set(rowKey(item), matchKey);
    pathMap.set(matchKey, entry(item, item.filePath));
  }
  return { pathMap, keyByRow };
}

function TypeTab({
  label,
  href,
  active,
}: {
  label: string;
  href: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className="ds-hover-tint inline-flex items-center whitespace-nowrap font-medium transition-colors"
      style={{
        padding: "5px 12px",
        borderRadius: 6,
        fontSize: 12,
        background: active ? "var(--ds-bg-3)" : "transparent",
        color: active ? "var(--ds-fg)" : "var(--ds-fg-muted)",
      }}
    >
      {label}
    </Link>
  );
}

export default async function LibraryDiffPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; server?: string; tmdbId?: string; mediaType?: string }>;
}) {
  const session = await authActive();
  if (!session || !hasPermission(session.user.permissions, Permission.ADMIN)) redirect("/");

  const { type, server: highlightServer, tmdbId: highlightTmdbIdStr, mediaType: highlightMediaType } = await searchParams;
  const [t, locale] = await Promise.all([getTranslator(), getLocale()]);
  const activeType = type === "movie" ? "MOVIE" : type === "tv" ? "TV" : null;
  const highlightTmdbId = highlightTmdbIdStr ? parseInt(highlightTmdbIdStr, 10) : null;
  const highlightKey = highlightTmdbId && highlightMediaType
    ? `${highlightTmdbId}:${highlightMediaType}`
    : null;

  const LIBRARY_ITEM_CAP = 25_000;
  // eslint-disable-next-line react-hooks/purity -- server component; Date.now() runs once per request
  const threshold = new Date(Date.now() + LIBRARY_REFRESH_THRESHOLD);
  // overview is omitted here on purpose: it is the heaviest column and is only
  // rendered for the difference sets, so pulling it for up to 50k rows per render
  // is wasted. fetchOverviews backfills it for just the displayed rows below.
  const [plexItems, jellyfinItems, prefixRows, matchReport, syncServers] = await Promise.all([
    prisma.plexLibraryItem.findMany({ select: { tmdbId: true, mediaType: true, filePath: true, plexRatingKey: true, title: true, year: true, serverInstance: true }, orderBy: [{ serverInstance: "asc" }, { mediaType: "asc" }, { tmdbId: "asc" }], take: LIBRARY_ITEM_CAP }),
    prisma.jellyfinLibraryItem.findMany({ select: { tmdbId: true, mediaType: true, filePath: true, jellyfinItemId: true, title: true, year: true, serverInstance: true }, orderBy: [{ serverInstance: "asc" }, { mediaType: "asc" }, { tmdbId: "asc" }], take: LIBRARY_ITEM_CAP }),
    // Every server's strip prefixes in one read — the default instance's and
    // each named one's (plex<Slug>MoviePathStripPrefix, …). The resolver below
    // reads them by exact key, so nothing else ending this way is used.
    prisma.setting.findMany({ where: { key: { endsWith: "PathStripPrefix" } }, select: { key: true, value: true } }),
    readLibraryMatchReport(),
    // Which servers are CONNECTED (every instance), so the Re-sync button syncs
    // each of them and skips one that is not there rather than POSTing to it and
    // reading a not-configured 400 as a failure. Not derived from the library
    // rows: a configured-but-empty or freshly-added server has none yet and would
    // be wrongly reported as absent.
    configuredLibrarySyncServers(),
  ]);
  // The match check judges each server against Radarr/Sonarr, so unlike the
  // diff below it means something on a one-server deployment too. Paths stay
  // on the server: the rows show folder names only.
  const clientMatchReport: ClientMatchReport | null = matchReport && {
    checkedAt: matchReport.checkedAt,
    sources: matchReport.sources,
    counts: matchReport.counts,
    truncated: matchReport.truncated,
    flags: matchReport.flags.map(({ path: _path, ...flag }) => flag),
  };
  const libraryCapped = plexItems.length >= LIBRARY_ITEM_CAP || jellyfinItems.length >= LIBRARY_ITEM_CAP;

  const plexConfigured    = plexItems.length > 0;
  const jellyfinConfigured = jellyfinItems.length > 0;
  // A diff needs BOTH sides. With only one server holding rows the set-difference
  // degenerates to that server's entire library — "every Plex title is missing
  // from Jellyfin" is technically true and completely useless, and it is exactly
  // the render that falls over: measured at ~12MB of HTML and 70k DOM elements
  // for an ordinary 5,000-title library, ~61MB and 350k at the 25,000 cap, plus
  // the same rows again in the RSC payload. Single-server deployments are the
  // common case (guardrail 35), so we show a short notice instead.
  const oneSided = !plexConfigured || !jellyfinConfigured;

  // Start the ARR folder-map reads now (external Radarr/Sonarr HTTP when the
  // shared cache is cold, independent of everything below) so they overlap the
  // fetchOverviews/enrichItems DB stages; awaited in the bad-match Promise.all
  // where they are consumed. loadArrPathIndex never throws; the no-op catches
  // only mark the promises handled if an intermediate await throws first.
  //
  // Skipped on a one-sided deployment, matching the fetchOverviews/enrichItems
  // gate below: every consumer (the bad-match verdicts, toClientItem over
  // onlyPlex/onlyJellyfin) is empty there, yet a cold build is a full
  // /api/v3/movie and /api/v3/series list from EVERY syncable instance on a 30s
  // timeout each — a one-line notice must not wait on that.
  const noArrIndex: ArrPathIndex = { byPath: new Map(), byName: new Map(), incomplete: false };
  const movieArrIndexPromise = oneSided ? Promise.resolve(noArrIndex) : loadArrPathIndex("MOVIE");
  movieArrIndexPromise.catch(() => {});
  const tvArrIndexPromise = oneSided ? Promise.resolve(noArrIndex) : loadArrPathIndex("TV");
  tvArrIndexPromise.catch(() => {});

  // Keyed by the row's own instance, so a row left behind by a de-registered
  // instance still gets its own prefix.
  const prefixCfg: Record<string, string> = Object.fromEntries(prefixRows.map((r) => [r.key, r.value]));
  const plexStripFor     = stripResolver(prefixCfg, plexSettingKey);
  const jellyfinStripFor = stripResolver(prefixCfg, jellyfinSettingKey);

  // The distinct library titles as their TMDB details cache keys. Freshness is
  // counted over exactly these keys: an unscoped `movie:*:details` count also
  // takes in every title anyone browsed, requested or was recommended, which
  // routinely exceeds the library and clamped uncachedCount to 0 — the Warm
  // Cache button then read "Cache warm" over thousands of uncached titles.
  const libraryDetailKeys = (() => {
    const seen = new Set<string>();
    for (const i of [...plexItems, ...jellyfinItems]) {
      seen.add(tmdbDetailsKey(i.mediaType, i.tmdbId));
    }
    return [...seen];
  })();
  const uniqueLibraryCount = libraryDetailKeys.length;

  // Chunked so a capped library (up to 50k keys) stays well under Postgres's
  // bind-parameter limit; sequential to stay off the small connection pool.
  const FRESH_COUNT_CHUNK = 10_000;
  let freshLibraryCount = 0;
  for (let i = 0; i < libraryDetailKeys.length; i += FRESH_COUNT_CHUNK) {
    freshLibraryCount += await prisma.tmdbCache.count({
      where: { key: { in: libraryDetailKeys.slice(i, i + FRESH_COUNT_CHUNK) }, expiresAt: { gt: threshold } },
    });
  }

  const uncachedCount = Math.max(0, uniqueLibraryCount - freshLibraryCount);

  // Past the row cap, membership comes from the whole tables, so every row the
  // lists show as "only on X" really is (the lists themselves stay capped,
  // under the banner that says so).
  const wholeKeys = libraryCapped ? await wholeLibraryTitleKeys() : null;
  const jellyfinSet = wholeKeys?.jellyfin ?? new Set(jellyfinItems.map((i) => `${i.tmdbId}:${i.mediaType}`));
  const plexSet     = wholeKeys?.plex     ?? new Set(plexItems.map((i)     => `${i.tmdbId}:${i.mediaType}`));

  // The raw lists stay ROW-based (one card per server holding the title) —
  // that's what the diff columns and the type-tab counts render. The stat tiles
  // below count DISTINCT titles instead; see the comment there.
  const rawOnlyPlex      = plexItems.filter((i)     => !jellyfinSet.has(`${i.tmdbId}:${i.mediaType}`));
  const rawOnlyJellyfin  = jellyfinItems.filter((i) => !plexSet.has(`${i.tmdbId}:${i.mediaType}`));
  const inSyncCount      = [...plexSet].filter((k)  =>  jellyfinSet.has(k)).length;

  // Skip the whole enrichment pipeline on a one-sided deployment. The render is
  // gated below, but fetchOverviews + enrichItems run BEFORE that gate and are
  // the expensive half — three more queries per call over what would be the
  // entire library — so gating only the JSX would still pay for a result nobody
  // is shown. The tab counts that read the raw arrays live inside the gated
  // branch, so nothing downstream observes these being empty.
  const filteredOnlyPlex = oneSided
    ? []
    : activeType
      ? rawOnlyPlex.filter((i) => i.mediaType === activeType)
      : rawOnlyPlex;
  const filteredOnlyJellyfin = oneSided
    ? []
    : activeType
      ? rawOnlyJellyfin.filter((i) => i.mediaType === activeType)
      : rawOnlyJellyfin;

  // Backfill overview for just the difference rows (the only place it is rendered),
  // then merge it into the enrichItems input.
  const [plexOverviews, jellyfinOverviews] = await Promise.all([
    fetchOverviews("plex", filteredOnlyPlex),
    fetchOverviews("jellyfin", filteredOnlyJellyfin),
  ]);
  const [onlyPlex, onlyJellyfin] = await Promise.all([
    enrichItems(filteredOnlyPlex.map((i) => ({ ...i, overview: plexOverviews.get(`${i.tmdbId}:${i.mediaType}:${i.serverInstance}`) ?? null }))),
    enrichItems(filteredOnlyJellyfin.map((i) => ({ ...i, overview: jellyfinOverviews.get(`${i.tmdbId}:${i.mediaType}:${i.serverInstance}`) ?? null }))),
  ]);

  const plexMountPoints     = mountsByInstance(plexItems);
  const jellyfinMountPoints = mountsByInstance(jellyfinItems);

  const { pathMap: plexPathMap, keyByRow: plexKeyByRow } = buildPathIndex(
    plexItems, plexMountPoints, plexStripFor,
    (item, filePath): PlexPathEntry => ({ tmdbId: item.tmdbId, mediaType: item.mediaType, serverInstance: item.serverInstance, filePath, ratingKey: item.plexRatingKey, title: item.title, year: item.year }),
  );
  const { pathMap: jellyfinPathMap, keyByRow: jellyfinKeyByRow } = buildPathIndex(
    jellyfinItems, jellyfinMountPoints, jellyfinStripFor,
    (item, filePath): JellyfinPathEntry => ({ tmdbId: item.tmdbId, mediaType: item.mediaType, serverInstance: item.serverInstance, filePath, itemId: item.jellyfinItemId, title: item.title, year: item.year }),
  );

  type RawBadMatch = {
    relativePath: string;
    plexItem:     PlexPathEntry;
    jellyfinItem: JellyfinPathEntry;
  };

  const allRawBadMatches: RawBadMatch[] = [];
  for (const [relPath, plexItem] of plexPathMap) {
    const jellyfinItem = jellyfinPathMap.get(relPath);
    if (!jellyfinItem) continue;
    if (plexItem.tmdbId !== jellyfinItem.tmdbId || plexItem.mediaType !== jellyfinItem.mediaType) {
      allRawBadMatches.push({ relativePath: relPath, plexItem, jellyfinItem });
    }
  }

  const filteredRawBadMatches = activeType
    ? allRawBadMatches.filter((m) => m.plexItem.mediaType === activeType || m.jellyfinItem.mediaType === activeType)
    : allRawBadMatches;

  const [bmPlexItems, bmJellyfinItems, movieArrIndex, tvArrIndex] = await Promise.all([
    enrichItems(filteredRawBadMatches.map((m) => ({ tmdbId: m.plexItem.tmdbId,     mediaType: m.plexItem.mediaType,     filePath: m.plexItem.filePath,     title: m.plexItem.title,     year: m.plexItem.year,     serverInstance: m.plexItem.serverInstance }))),
    enrichItems(filteredRawBadMatches.map((m) => ({ tmdbId: m.jellyfinItem.tmdbId, mediaType: m.jellyfinItem.mediaType, filePath: m.jellyfinItem.filePath, title: m.jellyfinItem.title, year: m.jellyfinItem.year, serverInstance: m.jellyfinItem.serverInstance }))),
    movieArrIndexPromise,
    tvArrIndexPromise,
  ]);

  // Lookups go through each map's folder-BASENAME index: the arr paths are
  // absolute under a different bind-mount root (/data vs /plexmedia), so a
  // full-path get() never matches, while basenames ("Movie (2020)") line up.
  // Sonarr keys by the SERIES folder — a TV lookup off folderOf(filePath) would
  // yield the season folder (Plex stores an episode leaf) or the library root
  // (Jellyfin stores the series folder itself). A basename two titles share is
  // absent from the index, so it gives no verdict rather than a wrong one. The
  // full-path maps stay for the inArr sets and tvArrPathByTmdbId below.
  const movieArrMap    = movieArrIndex.byPath;
  const tvArrMap       = tvArrIndex.byPath;
  const movieArrByName = movieArrIndex.byName;
  const tvArrByName    = tvArrIndex.byName;

  const badMatches: BadMatch[] = filteredRawBadMatches.map((m, i) => {
    // toMatchKey already reduced a TV relativePath to the show folder; movies
    // keep their full relative file path, so they look the file's parent
    // directory's basename up against the radarr basename index.
    const arrTmdbId = m.plexItem.mediaType === "TV"
      ? (tvArrByName.get(m.relativePath) ?? null)
      : (movieArrByName.get((folderOf(m.plexItem.filePath) || folderOf(m.jellyfinItem.filePath)).split("/").pop() ?? "") ?? null);

    return {
      relativePath:   m.relativePath,
      plex:           bmPlexItems[i],
      plexRatingKey:  m.plexItem.ratingKey,
      jellyfin:       bmJellyfinItems[i],
      jellyfinItemId: m.jellyfinItem.itemId,
      arrTmdbId,
      arrVerdict: arrVerdictFor(m.plexItem.tmdbId, m.jellyfinItem.tmdbId, arrTmdbId),
    };
  });

  const movieArrTmdbIds = new Set(movieArrMap.values());
  const tvArrTmdbIds    = new Set(tvArrMap.values());

  const tvArrPathByTmdbId = new Map<number, string>();
  for (const [path, tmdbId] of tvArrMap.entries()) {
    if (!tvArrPathByTmdbId.has(tmdbId)) tvArrPathByTmdbId.set(tmdbId, path);
  }

  const arrTmdbIdsFor = (item: LibraryItem) => (item.mediaType === "MOVIE" ? movieArrTmdbIds : tvArrTmdbIds);

  const toClientItem = (
    items: LibraryItem[],
    side: {
      // This server's rows by join key, and the OTHER server's rows by match
      // key — the pair that explains why a title is on this server only.
      keyByRow: Map<string, string>;
      otherByPath: ReadonlyMap<string, OtherSidePathEntry>;
      otherUnmatched: ReadonlySet<string>;
      // Per-instance mounts, not one shared string — an item from a second
      // server must be stripped with ITS root or the card renders a raw
      // absolute path.
      mountPoints: Map<string, string>;
    },
  ): DiffItem[] =>
    items.map((item) => {
      const mediaRelPath = stripMountPoint(item.filePath, side.mountPoints.get(mountKey(item)) ?? "");
      const matchKey = side.keyByRow.get(rowKey(item)) ?? null;
      // Both sides resolve against a folder-BASENAME index (see tvArrByName /
      // movieArrByName): the arr paths are absolute under a different
      // bind-mount root, so a full-path lookup never matches. TV looks up its
      // match key — the series folder AFTER the server's strip prefix, exactly
      // as the bad-match list does; the first segment of the mount-relative
      // path was the prefix itself ("tv") whenever one was set. Movies use the
      // file's parent directory.
      const arrTmdbId = item.mediaType === "TV"
        ? (matchKey ? (tvArrByName.get(matchKey) ?? null) : null)
        : (item.filePath ? (movieArrByName.get(folderOf(item.filePath).split("/").pop() ?? "") ?? null) : null);
      const inArr = arrTmdbIdsFor(item).has(item.tmdbId);
      // An instance that could not be read leaves its titles out of the index, so
      // "not in Radarr/Sonarr" is only a verdict when the whole index was read.
      const arrUnknown = !inArr && (item.mediaType === "MOVIE" ? movieArrIndex : tvArrIndex).incomplete;

      const arrFallbackPath = (!mediaRelPath && item.mediaType === "TV")
        ? (tvArrPathByTmdbId.get(item.tmdbId) ?? null)
        : null;

      const movieFolder = item.mediaType === "MOVIE" ? ownFolder(item.filePath, "MOVIE") : null;
      const folder = item.mediaType === "TV"
        ? (matchKey ? folderKey(matchKey) : null)
        : (movieFolder ? folderKey(movieFolder) : null);

      return {
        tmdbId:         item.tmdbId,
        mediaType:      item.mediaType,
        serverInstance: item.serverInstance,
        diffSource:     diffSourceFor(matchKey, folder, item.mediaType, side.otherByPath, side.otherUnmatched),
        title:          item.title,
        posterPath:     item.posterPath,
        releaseYear:    item.releaseYear,
        overview:       item.overview,
        voteAverage:    item.voteAverage,
        relPath:        mediaRelPath ?? arrFallbackPath,
        relPathFromArr: mediaRelPath === null && arrFallbackPath !== null,
        arrTmdbId,
        arrMismatch:    arrTmdbId !== null && arrTmdbId !== item.tmdbId,
        inArr,
        arrUnknown,
        requests:       item.requests,
      };
    });

  // Folders each server lists WITHOUT a TMDB id: the sync drops those, so the
  // title reads as "only on the other server" although the file is right there.
  const unmatchedFolders = (server: "plex" | "jellyfin") => new Set(
    (matchReport?.flags ?? [])
      .filter((f) => f.server === server && f.kind === "noTmdbId" && f.folder)
      .map((f) => `${f.mediaType}:${folderKey(f.folder as string)}`),
  );
  const toOther = (m: Map<string, PlexPathEntry | JellyfinPathEntry>): Map<string, OtherSidePathEntry> =>
    new Map([...m].map(([k, v]) => [k, { tmdbId: v.tmdbId, mediaType: v.mediaType, serverInstance: v.serverInstance, title: v.title }]));
  const plexOther = toOther(plexPathMap);
  const jellyfinOther = toOther(jellyfinPathMap);

  const clientOnlyPlex = toClientItem(onlyPlex, {
    keyByRow: plexKeyByRow, otherByPath: jellyfinOther, otherUnmatched: unmatchedFolders("jellyfin"), mountPoints: plexMountPoints,
  });
  const clientOnlyJellyfin = toClientItem(onlyJellyfin, {
    keyByRow: jellyfinKeyByRow, otherByPath: plexOther, otherUnmatched: unmatchedFolders("plex"), mountPoints: jellyfinMountPoints,
  });

  const collator = diffCollator(locale);
  const diffCompare = makeDiffComparator(collator);
  clientOnlyPlex.sort(diffCompare);
  clientOnlyJellyfin.sort(diffCompare);

  const clientBadMatches: ClientBadMatch[] = badMatches.sort(makeBadMatchComparator(collator)).map((m) => ({
    relativePath:   m.relativePath,
    plex:           { tmdbId: m.plex.tmdbId, mediaType: m.plex.mediaType, serverInstance: m.plex.serverInstance, title: m.plex.title, posterPath: m.plex.posterPath, releaseYear: m.plex.releaseYear },
    plexRatingKey:  m.plexRatingKey,
    jellyfin:       { tmdbId: m.jellyfin.tmdbId, mediaType: m.jellyfin.mediaType, serverInstance: m.jellyfin.serverInstance, title: m.jellyfin.title, posterPath: m.jellyfin.posterPath, releaseYear: m.jellyfin.releaseYear },
    jellyfinItemId: m.jellyfinItemId,
    arrTmdbId:      m.arrTmdbId,
    arrVerdict:     m.arrVerdict,
  }));

  // Tiles count DISTINCT titles (`tmdbId:mediaType`), not rows: one film on two
  // Plex servers is one library entry, and row counts would inflate every tile
  // and break the Plex + Jellyfin − In Sync arithmetic between them. Identical
  // to the old row counts on a single-server deployment, where the composite PK
  // makes one row exactly one title. (The type tabs below stay row-based on
  // purpose — they label the cards actually rendered, one per server.)
  //
  // Past the row cap both sets are the whole tables' (wholeLibraryTitleKeys).
  const titleCounts = { plex: plexSet.size, jellyfin: jellyfinSet.size, inSync: inSyncCount };
  const stats = [
    { label: t("adminManage.library.stat.plex"),     value: titleCounts.plex,     color: "var(--ds-plex-text)" },
    { label: t("adminManage.library.stat.jellyfin"), value: titleCounts.jellyfin, color: "var(--ds-jellyfin-text)" },
    { label: t("adminManage.library.stat.inSync"),          value: titleCounts.inSync,      color: "var(--ds-success)"  },
    { label: t("adminManage.library.stat.differences"),      value: (titleCounts.plex - titleCounts.inSync) + (titleCounts.jellyfin - titleCounts.inSync), color: "var(--ds-danger)" },
    { label: t("adminManage.library.stat.badMatches"),      value: allRawBadMatches.length, color: "var(--ds-warning)" },
  ];

  return (
    <div className="ds-page-enter">
      <PageHeader
        title={t("adminManage.library.title")}
        subtitle={t("adminManage.library.subtitle")}
        right={
          <div className="flex items-center gap-2 flex-wrap">
            <ResyncLibraryButton servers={syncServers} />
            <SyncTVEpisodesButton />
            <WarmCacheButton uncachedCount={uncachedCount} />
          </div>
        }
      />

      <div
        className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5"
        style={{ gap: 10, marginBottom: 20 }}
      >
        {stats.map((s) => (
          <div
            key={s.label}
            style={{
              padding: "14px 16px",
              background: "var(--ds-bg-2)",
              border: "1px solid var(--ds-border)",
              borderRadius: 8,
            }}
          >
            <p
              className="ds-mono uppercase"
              style={{
                fontSize: 10.5,
                color: "var(--ds-fg-subtle)",
                letterSpacing: "0.08em",
                margin: "0 0 6px",
              }}
            >
              {s.label}
            </p>
            <p
              className="font-semibold"
              style={{
                fontSize: 22,
                color: s.color,
                margin: 0,
                letterSpacing: "-0.02em",
              }}
            >
              {s.value}
            </p>
          </div>
        ))}
      </div>

      {libraryCapped && (
        <div
          style={{
            marginBottom: 16,
            padding: "10px 14px",
            borderRadius: 8,
            background:
              "color-mix(in oklab, var(--ds-warning) 12%, transparent)",
            border:
              "1px solid color-mix(in oklab, var(--ds-warning) 30%, transparent)",
            color: "var(--ds-warning)",
            fontSize: 12.5,
          }}
        >
          {t("adminManage.library.capped", { cap: LIBRARY_ITEM_CAP.toLocaleString(locale) })}
        </div>
      )}

      {oneSided ? (
        <EmptyState
          icon={Library}
          title={
            !plexConfigured && !jellyfinConfigured
              ? t("adminManage.library.oneSided.neither")
              : t("adminManage.library.oneSided.only", { server: plexConfigured ? "Plex" : "Jellyfin" })
          }
          description={t("adminManage.library.oneSided.description")}
          cta={{ href: "/admin", label: t("adminManage.library.oneSided.cta") }}
        />
      ) : (
        <>
          <div
            className="ds-no-scrollbar flex overflow-x-auto max-w-full"
            style={{
              padding: 2,
              background: "var(--ds-bg-1)",
              border: "1px solid var(--ds-border)",
              borderRadius: 8,
              marginBottom: 24,
              width: "fit-content",
            }}
          >
            <TypeTab
              label={t("adminManage.library.tab.all", { count: rawOnlyPlex.length + rawOnlyJellyfin.length })}
              href="/admin/library"
              active={!activeType}
            />
            <TypeTab
              label={t("adminManage.library.tab.movies", { count: rawOnlyPlex.filter((i) => i.mediaType === "MOVIE").length + rawOnlyJellyfin.filter((i) => i.mediaType === "MOVIE").length })}
              href="/admin/library?type=movie"
              active={activeType === "MOVIE"}
            />
            <TypeTab
              label={t("adminManage.library.tab.tv", { count: rawOnlyPlex.filter((i) => i.mediaType === "TV").length + rawOnlyJellyfin.filter((i) => i.mediaType === "TV").length })}
              href="/admin/library?type=tv"
              active={activeType === "TV"}
            />
          </div>

          <LibraryDiffClient
            onlyPlex={clientOnlyPlex}
            onlyJellyfin={clientOnlyJellyfin}
            badMatches={clientBadMatches}
            plexConfigured={plexConfigured}
            jellyfinConfigured={jellyfinConfigured}
            highlightServer={highlightServer ?? null}
            highlightKey={highlightKey}
          />
        </>
      )}

      {/* Below the diff on purpose: the difference lists are what an admin opens
          this page for, and the match check is a longer, collapsible audit. */}
      <div style={{ marginTop: 24 }}>
        <LibraryMatchCheck report={clientMatchReport} mediaType={activeType} />
      </div>
    </div>
  );
}
