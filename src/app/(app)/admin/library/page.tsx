import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import Link from "next/link";
import { WarmCacheButton } from "@/components/admin/warm-cache-button";
import { ResyncLibraryButton } from "@/components/admin/resync-library-button";
import { SyncTVEpisodesButton } from "@/components/admin/sync-tv-episodes-button";
import { TTL, getCache, setCache } from "@/lib/tmdb-cache";
import { LibraryDiffClient, type DiffItem, type ClientBadMatch } from "@/components/admin/library-diff-client";
import { PageHeader } from "@/components/ui/design";

const LIBRARY_REFRESH_THRESHOLD = 5 * 24 * 60 * 60 * 1000;

export const dynamic = "force-dynamic";

interface RequestSummary {
  total: number;
  statuses: string[];
}

interface LibraryItem {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
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

async function enrichItems(
  items: {
    tmdbId: number; mediaType: "MOVIE" | "TV"; filePath?: string | null;
    title?: string | null; year?: string | null; overview?: string | null;
  }[]
): Promise<LibraryItem[]> {
  if (items.length === 0) return [];

  const orClause = items.map((i) => ({ tmdbId: i.tmdbId, mediaType: i.mediaType }));
  const allRequests = await prisma.mediaRequest.findMany({
    where: { OR: orClause },
    select: { tmdbId: true, mediaType: true, status: true },
    orderBy: { createdAt: "desc" },
  });
  const requestsMap = new Map<string, string[]>();
  for (const r of allRequests) {
    const key = `${r.tmdbId}:${r.mediaType}`;
    (requestsMap.get(key) ?? requestsMap.set(key, []).get(key)!).push(r.status);
  }

  const cacheKeys = items.map((i) => `${i.mediaType === "MOVIE" ? "movie" : "tv"}:${i.tmdbId}:details`);
  const cacheRows = await prisma.tmdbCache.findMany({
    where: { key: { in: cacheKeys } },
    select: { key: true, data: true },
  });
  const cacheMap = new Map<string, { posterPath?: string | null; voteAverage?: number }>();
  for (const row of cacheRows) {
    try {
      const parsed = JSON.parse(row.data) as { posterPath?: string | null; voteAverage?: number };
      const parts = row.key.split(":");
      const mediaType = parts[0] === "movie" ? "MOVIE" : "TV";
      const tmdbId = parseInt(parts[1], 10);
      if (!isNaN(tmdbId)) cacheMap.set(`${tmdbId}:${mediaType}`, parsed);
    } catch { }
  }

  return items.map((i) => {
    const key = `${i.tmdbId}:${i.mediaType}`;
    const cached = cacheMap.get(key);
    const statuses = requestsMap.get(key) ?? [];
    return {
      tmdbId: i.tmdbId,
      mediaType: i.mediaType,
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

function commonPathPrefix(paths: (string | null)[]): string {
  const valid = paths.filter((p): p is string => p !== null && p.length > 0);
  if (valid.length === 0) return "";

  const segmented = valid.map((p) => p.replace(/\\/g, "/").split("/").filter(Boolean));
  const first = segmented[0];
  let commonLen = first.length - 1;

  for (const segs of segmented.slice(1)) {
    let i = 0;
    while (i < commonLen && i < segs.length - 1 && first[i] === segs[i]) i++;
    commonLen = i;
    if (commonLen === 0) return "";
  }

  if (commonLen === 0) return "";
  const sep = valid[0].startsWith("/") ? "/" : "";
  return sep + first.slice(0, commonLen).join("/") + "/";
}

function stripMountPoint(filePath: string | null, mountPoint: string): string | null {
  if (!filePath) return null;
  const normalised = filePath.replace(/\\/g, "/");
  if (mountPoint && normalised.startsWith(mountPoint)) return normalised.slice(mountPoint.length);
  return normalised;
}

function normaliseRelPath(rel: string, stripPrefix: string): string {
  if (!stripPrefix) return rel;
  const p = stripPrefix.endsWith("/") ? stripPrefix : stripPrefix + "/";
  return rel.startsWith(p) ? rel.slice(p.length) : rel;
}

async function buildArrPathMap(
  mediaType: "MOVIE" | "TV",
): Promise<Map<string, number>> {
  const cacheKey = `arr:${mediaType === "MOVIE" ? "radarr" : "sonarr"}:paths`;

  const cached = await getCache<[string, number][]>(cacheKey);
  if (cached) return new Map(cached);

  const map = new Map<string, number>();
  try {
    const [urlRow, keyRow] = await Promise.all([
      prisma.setting.findUnique({ where: { key: mediaType === "MOVIE" ? "radarrUrl" : "sonarrUrl" } }),
      prisma.setting.findUnique({ where: { key: mediaType === "MOVIE" ? "radarrApiKey" : "sonarrApiKey" } }),
    ]);
    if (!urlRow?.value || !keyRow?.value) return map;

    const { safeFetchAdminConfigured } = await import("@/lib/safe-fetch");
    const endpoint = mediaType === "MOVIE" ? "movie" : "series";
    const res = await safeFetchAdminConfigured(`${urlRow.value.replace(/\/$/, "")}/api/v3/${endpoint}`, {
      headers: { "X-Api-Key": keyRow.value, "Content-Type": "application/json" },
      timeoutMs: 10_000,
    });
    if (!res.ok) return map;

    type ArrItem = { tmdbId?: number; path?: string };
    const items = await res.json() as ArrItem[];
    for (const item of items) {
      if (!item.tmdbId || !item.path) continue;
      const normPath = item.path.replace(/\\/g, "/").replace(/\/$/, "");
      map.set(normPath, item.tmdbId);
    }

    await setCache(cacheKey, [...map.entries()], TTL.ARR_PATHS);
  } catch { }
  return map;
}

function folderOf(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/\/[^/]+$/, "");
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
      className="inline-flex items-center whitespace-nowrap font-medium transition-colors"
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
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") redirect("/");

  const { type, server: highlightServer, tmdbId: highlightTmdbIdStr, mediaType: highlightMediaType } = await searchParams;
  const activeType = type === "movie" ? "MOVIE" : type === "tv" ? "TV" : null;
  const highlightTmdbId = highlightTmdbIdStr ? parseInt(highlightTmdbIdStr, 10) : null;
  const highlightKey = highlightTmdbId && highlightMediaType
    ? `${highlightTmdbId}:${highlightMediaType}`
    : null;

  const LIBRARY_ITEM_CAP = 25_000;
  const [plexItems, jellyfinItems, prefixRows] = await Promise.all([
    prisma.plexLibraryItem.findMany({ select: { tmdbId: true, mediaType: true, filePath: true, plexRatingKey: true, title: true, year: true, overview: true }, take: LIBRARY_ITEM_CAP }),
    prisma.jellyfinLibraryItem.findMany({ select: { tmdbId: true, mediaType: true, filePath: true, jellyfinItemId: true, title: true, year: true, overview: true }, take: LIBRARY_ITEM_CAP }),
    prisma.setting.findMany({ where: { key: { in: ["plexMoviePathStripPrefix", "plexTvPathStripPrefix", "jellyfinMoviePathStripPrefix", "jellyfinTvPathStripPrefix"] } } }),
  ]);
  const libraryCapped = plexItems.length >= LIBRARY_ITEM_CAP || jellyfinItems.length >= LIBRARY_ITEM_CAP;

  const prefixCfg = Object.fromEntries(prefixRows.map((r) => [r.key, r.value]));
  const plexMovieStripPrefix     = prefixCfg.plexMoviePathStripPrefix     ?? "";
  const plexTvStripPrefix        = prefixCfg.plexTvPathStripPrefix        ?? "";
  const jellyfinMovieStripPrefix = prefixCfg.jellyfinMoviePathStripPrefix ?? "";
  const jellyfinTvStripPrefix    = prefixCfg.jellyfinTvPathStripPrefix    ?? "";

  // eslint-disable-next-line react-hooks/purity -- server component; Date.now() runs once per request
  const threshold = new Date(Date.now() + LIBRARY_REFRESH_THRESHOLD);
  const [freshMovieCount, freshTvCount] = await Promise.all([
    prisma.tmdbCache.count({
      where: { key: { startsWith: "movie:", endsWith: ":details" }, expiresAt: { gt: threshold } },
    }),
    prisma.tmdbCache.count({
      where: { key: { startsWith: "tv:", endsWith: ":details" }, expiresAt: { gt: threshold } },
    }),
  ]);
  const uniqueLibraryCount = (() => {
    const seen = new Set<string>();
    for (const i of [...plexItems, ...jellyfinItems]) seen.add(`${i.tmdbId}:${i.mediaType}`);
    return seen.size;
  })();

  const uncachedCount = Math.max(0, uniqueLibraryCount - (freshMovieCount + freshTvCount));

  const plexConfigured    = plexItems.length > 0;
  const jellyfinConfigured = jellyfinItems.length > 0;
  const neither = !plexConfigured && !jellyfinConfigured;

  const jellyfinSet = new Set(jellyfinItems.map((i) => `${i.tmdbId}:${i.mediaType}`));
  const plexSet     = new Set(plexItems.map((i)     => `${i.tmdbId}:${i.mediaType}`));

  const rawOnlyPlex      = plexItems.filter((i)     => !jellyfinSet.has(`${i.tmdbId}:${i.mediaType}`));
  const rawOnlyJellyfin  = jellyfinItems.filter((i) => !plexSet.has(`${i.tmdbId}:${i.mediaType}`));
  const inSyncCount      = plexItems.filter((i)     =>  jellyfinSet.has(`${i.tmdbId}:${i.mediaType}`)).length;

  const filteredOnlyPlex = activeType
    ? rawOnlyPlex.filter((i) => i.mediaType === activeType)
    : rawOnlyPlex;
  const filteredOnlyJellyfin = activeType
    ? rawOnlyJellyfin.filter((i) => i.mediaType === activeType)
    : rawOnlyJellyfin;

  const [onlyPlex, onlyJellyfin] = await Promise.all([
    enrichItems(filteredOnlyPlex),
    enrichItems(filteredOnlyJellyfin),
  ]);

  const plexMountPoint     = commonPathPrefix(plexItems.map((i) => i.filePath));
  const jellyfinMountPoint = commonPathPrefix(jellyfinItems.map((i) => i.filePath));

  function toMatchKey(rel: string, mediaType: "MOVIE" | "TV"): string {
    if (mediaType === "TV") return rel.split("/")[0];
    return rel;
  }

  type PlexPathEntry     = { tmdbId: number; mediaType: "MOVIE" | "TV"; filePath: string; ratingKey: string | null; title: string | null; year: string | null; overview: string | null };
  type JellyfinPathEntry = { tmdbId: number; mediaType: "MOVIE" | "TV"; filePath: string; itemId: string | null;   title: string | null; year: string | null; overview: string | null };

  const plexPathMap = new Map<string, PlexPathEntry>();
  for (const item of plexItems) {
    if (!item.filePath) continue;
    const rel = stripMountPoint(item.filePath, plexMountPoint);
    const plexPrefix = item.mediaType === "MOVIE" ? plexMovieStripPrefix : plexTvStripPrefix;
    if (rel) plexPathMap.set(toMatchKey(normaliseRelPath(rel, plexPrefix), item.mediaType), { tmdbId: item.tmdbId, mediaType: item.mediaType, filePath: item.filePath, ratingKey: item.plexRatingKey, title: item.title, year: item.year, overview: item.overview });
  }

  const jellyfinPathMap = new Map<string, JellyfinPathEntry>();
  for (const item of jellyfinItems) {
    if (!item.filePath) continue;
    const rel = stripMountPoint(item.filePath, jellyfinMountPoint);
    const jellyfinPrefix = item.mediaType === "MOVIE" ? jellyfinMovieStripPrefix : jellyfinTvStripPrefix;
    if (rel) jellyfinPathMap.set(toMatchKey(normaliseRelPath(rel, jellyfinPrefix), item.mediaType), { tmdbId: item.tmdbId, mediaType: item.mediaType, filePath: item.filePath, itemId: item.jellyfinItemId, title: item.title, year: item.year, overview: item.overview });
  }

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

  const [bmPlexItems, bmJellyfinItems, movieArrMap, tvArrMap] = await Promise.all([
    enrichItems(filteredRawBadMatches.map((m) => ({ tmdbId: m.plexItem.tmdbId,     mediaType: m.plexItem.mediaType,     filePath: m.plexItem.filePath,     title: m.plexItem.title,     year: m.plexItem.year,     overview: m.plexItem.overview }))),
    enrichItems(filteredRawBadMatches.map((m) => ({ tmdbId: m.jellyfinItem.tmdbId, mediaType: m.jellyfinItem.mediaType, filePath: m.jellyfinItem.filePath, title: m.jellyfinItem.title, year: m.jellyfinItem.year, overview: m.jellyfinItem.overview }))),
    buildArrPathMap("MOVIE"),
    buildArrPathMap("TV"),
  ]);

  const badMatches: BadMatch[] = filteredRawBadMatches.map((m, i) => {
    const arrMap = m.plexItem.mediaType === "MOVIE" ? movieArrMap : tvArrMap;
    const folder = folderOf(m.plexItem.filePath) || folderOf(m.jellyfinItem.filePath);
    const arrTmdbId = arrMap.get(folder) ?? null;

    let arrVerdict: ArrVerdict = null;
    if (arrTmdbId !== null) {
      const plexCorrect     = m.plexItem.tmdbId     === arrTmdbId;
      const jellyfinCorrect = m.jellyfinItem.tmdbId === arrTmdbId;
      if (plexCorrect && !jellyfinCorrect)  arrVerdict = "jellyfin";
      if (!plexCorrect && jellyfinCorrect)  arrVerdict = "plex";
    }

    return {
      relativePath:   m.relativePath,
      plex:           bmPlexItems[i],
      plexRatingKey:  m.plexItem.ratingKey,
      jellyfin:       bmJellyfinItems[i],
      jellyfinItemId: m.jellyfinItem.itemId,
      arrTmdbId,
      arrVerdict,
    };
  });

  const titleSort = (a: LibraryItem, b: LibraryItem) => {
    if (a.title && !b.title) return -1;
    if (!a.title && b.title) return 1;
    return (a.title ?? "").localeCompare(b.title ?? "");
  };
  onlyPlex.sort(titleSort);
  onlyJellyfin.sort(titleSort);

  const movieArrTmdbIds = new Set(movieArrMap.values());
  const tvArrTmdbIds    = new Set(tvArrMap.values());

  const tvArrPathByTmdbId = new Map<number, string>();
  for (const [path, tmdbId] of tvArrMap.entries()) {
    if (!tvArrPathByTmdbId.has(tmdbId)) tvArrPathByTmdbId.set(tmdbId, path);
  }

  const toClientItem = (
    items: LibraryItem[],
    mountPoint: string,
    arrMap: (item: LibraryItem) => Map<string, number>,
    arrTmdbSet: (item: LibraryItem) => Set<number>,
  ): DiffItem[] =>
    items.map((item) => {
      const map       = arrMap(item);
      const arrTmdbId = item.filePath ? (map.get(folderOf(item.filePath)) ?? null) : null;
      const inArr     = arrTmdbSet(item).has(item.tmdbId);

      const mediaRelPath = stripMountPoint(item.filePath, mountPoint);
      const arrFallbackPath = (!mediaRelPath && item.mediaType === "TV")
        ? (tvArrPathByTmdbId.get(item.tmdbId) ?? null)
        : null;

      return {
        tmdbId:         item.tmdbId,
        mediaType:      item.mediaType,
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
        requests:       item.requests,
      };
    });

  const clientOnlyPlex     = toClientItem(onlyPlex,     plexMountPoint,     (i) => i.mediaType === "MOVIE" ? movieArrMap : tvArrMap, (i) => i.mediaType === "MOVIE" ? movieArrTmdbIds : tvArrTmdbIds);
  const clientOnlyJellyfin = toClientItem(onlyJellyfin, jellyfinMountPoint, (i) => i.mediaType === "MOVIE" ? movieArrMap : tvArrMap, (i) => i.mediaType === "MOVIE" ? movieArrTmdbIds : tvArrTmdbIds);

  const clientBadMatches: ClientBadMatch[] = badMatches.map((m) => ({
    relativePath:   m.relativePath,
    plex:           { tmdbId: m.plex.tmdbId, mediaType: m.plex.mediaType, title: m.plex.title, posterPath: m.plex.posterPath, releaseYear: m.plex.releaseYear },
    plexRatingKey:  m.plexRatingKey,
    jellyfin:       { tmdbId: m.jellyfin.tmdbId, mediaType: m.jellyfin.mediaType, title: m.jellyfin.title, posterPath: m.jellyfin.posterPath, releaseYear: m.jellyfin.releaseYear },
    jellyfinItemId: m.jellyfinItemId,
    arrTmdbId:      m.arrTmdbId,
    arrVerdict:     m.arrVerdict,
  }));

  const stats = [
    { label: "Plex Library",     value: plexItems.length,     color: "var(--ds-plex)" },
    { label: "Jellyfin Library", value: jellyfinItems.length, color: "var(--ds-jellyfin)" },
    { label: "In Sync",          value: inSyncCount,          color: "var(--ds-success)"  },
    { label: "Differences",      value: rawOnlyPlex.length + rawOnlyJellyfin.length, color: "var(--ds-danger)" },
    { label: "Bad Matches",      value: allRawBadMatches.length, color: "var(--ds-warning)" },
  ];

  return (
    <div className="ds-page-enter">
      <PageHeader
        title="Library Diff"
        subtitle="Media present on one server but missing from the other."
        right={
          <div className="flex items-center gap-2 flex-wrap">
            <ResyncLibraryButton />
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
          Library exceeds {LIBRARY_ITEM_CAP.toLocaleString()} items — results are
          truncated and the diff may be incomplete.
        </div>
      )}

      {neither ? (
        <div
          className="text-center ds-mono"
          style={{
            padding: "40px 20px",
            background: "var(--ds-bg-1)",
            border: "1px dashed var(--ds-border)",
            borderRadius: 8,
            fontSize: 12,
            color: "var(--ds-fg-subtle)",
          }}
        >
          Neither Plex nor Jellyfin has been synced yet.{" "}
          <Link
            href="/admin"
            className="hover:underline"
            style={{ color: "var(--ds-accent)" }}
          >
            Run a sync
          </Link>{" "}
          first.
        </div>
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
              label={`All (${rawOnlyPlex.length + rawOnlyJellyfin.length})`}
              href="/admin/library"
              active={!activeType}
            />
            <TypeTab
              label={`Movies (${rawOnlyPlex.filter((i) => i.mediaType === "MOVIE").length + rawOnlyJellyfin.filter((i) => i.mediaType === "MOVIE").length})`}
              href="/admin/library?type=movie"
              active={activeType === "MOVIE"}
            />
            <TypeTab
              label={`TV Shows (${rawOnlyPlex.filter((i) => i.mediaType === "TV").length + rawOnlyJellyfin.filter((i) => i.mediaType === "TV").length})`}
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
    </div>
  );
}
