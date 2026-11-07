import { prisma } from "@/lib/prisma";
import { TTL, getCache, setCache } from "@/lib/tmdb-cache";
import { forgetWarnOnChange, warnOnChange } from "@/lib/log-dedup";
import {
  folderOf,
  isMediaFileName,
  isSeasonFolderName,
  stripMountPoint,
  stripRelPrefix,
  toMatchKey,
} from "@/lib/library-paths";
import {
  DEFAULT_MEDIA_INSTANCE,
  isValidMediaInstanceSlug,
  jellyfinSettingKey,
  plexSettingKey,
  type MediaInstanceKey,
} from "@/lib/media-instances";

// Bad-match computation for native admin clients.
//
// MIRROR: src/app/(app)/admin/library/page.tsx computes this inline (alongside
// the full library diff + stats, which this omits). The path rules both use
// live in library-paths.ts and the Radarr/Sonarr folder map in
// loadArrPathIndex below; keep the conflict detection here in sync with that
// page. The web page is the richer surface; this is the headless subset the iOS
// client needs.

const LIBRARY_ITEM_CAP = 25_000;

export interface BadMatchSide {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  title: string | null;
  posterPath: string | null;
  releaseYear: string | null;
  // Which server holds this row ("" = the default/only one). A client fixing
  // the match MUST send it back as `serverInstance` — the ratingKey/itemId
  // beside it is server-local, so applying the fix against the default server
  // would remap whatever unrelated item happens to carry that id there.
  serverInstance: string;
}

export interface BadMatchItem {
  relativePath: string;
  plex: BadMatchSide;
  plexRatingKey: string | null;
  jellyfin: BadMatchSide;
  jellyfinItemId: string | null;
  arrTmdbId: number | null;
  arrVerdict: "plex" | "jellyfin" | null;
}

// Longest shared directory prefix across a set of file paths — the inferred
// mount point that stripMountPoint peels off so paths compare across servers.
// Only ever hand it ONE server instance's paths (see buildPathMap).
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

// The mount for a group holding ONE path. commonPathPrefix alone would return
// that file's own parent directory, shrinking the row's key to a bare filename
// that can never equal the other server's "Folder/file" key. Borrow the longest
// mount another group (same service, same media type) inferred for a prefix of
// this path; failing that, keep the title folder by shape — a movie file keeps
// its parent folder, a TV episode keeps its show folder (and a season folder
// under it), a folder path (no extension, e.g. a Jellyfin series) keeps itself.
function singlePathMount(path: string, mediaType: "MOVIE" | "TV", siblingMounts: string[]): string {
  const normalised = path.replace(/\\/g, "/");
  let best = "";
  for (const m of siblingMounts) {
    if (m && m.length > best.length && normalised.startsWith(m) && normalised.length > m.length) best = m;
  }
  if (best) return best;
  const segs = normalised.split("/").filter(Boolean);
  const isFile = isMediaFileName(segs[segs.length - 1] ?? "");
  let keep = 1;
  if (isFile) {
    keep = 2;
    if (mediaType === "TV" && segs.length >= 3 && isSeasonFolderName(segs[segs.length - 2])) keep = 3;
  }
  const mountLen = segs.length - keep;
  if (mountLen <= 0) return "";
  const sep = normalised.startsWith("/") ? "/" : "";
  return sep + segs.slice(0, mountLen).join("/") + "/";
}

// Mount per `<slug> <MEDIATYPE>` group — the one definition shared with the
// admin library page (src/app/(app)/admin/library/page.tsx). Multi-path groups
// take their common prefix; a one-path group goes through singlePathMount,
// borrowing from the other groups of the SAME media type in this call (so pass
// one service's groups at a time). Groups must hold only rows with a filePath.
export function inferGroupMounts(
  byGroup: Map<string, { filePath: string | null; mediaType: "MOVIE" | "TV" }[]>,
): Map<string, string> {
  const mediaTypeOf = (groupKey: string) => groupKey.slice(groupKey.indexOf(" ") + 1);
  const inferred = new Map<string, string>();
  for (const [groupKey, group] of byGroup) {
    if (group.length > 1) inferred.set(groupKey, commonPathPrefix(group.map((r) => r.filePath)));
  }
  const out = new Map(inferred);
  for (const [groupKey, group] of byGroup) {
    if (out.has(groupKey) || group.length === 0) continue;
    const siblings = [...inferred].filter(([k]) => mediaTypeOf(k) === mediaTypeOf(groupKey)).map(([, m]) => m);
    out.set(groupKey, singlePathMount(group[0].filePath!, group[0].mediaType, siblings));
  }
  return out;
}

// ── Radarr/Sonarr folder map ────────────────────────────────────────────────
// One map per service, built from EVERY syncable instance's /api/v3/movie or
// /api/v3/series and cached under ONE key: this module, the admin library page
// and fix-match's file-info hint all read it. The cache holds each title's
// full folder path; the basename index (what lines up across bind-mount roots,
// /plexmedia vs /data) is derived from it in memory.

/** Radarr/Sonarr folders → tmdbId. */
export interface ArrPathIndex {
  /** Each title's folder path, normalised (forward slashes, no trailing "/"). The first instance listing a folder wins. */
  byPath: Map<string, number>;
  /** Folder basename → tmdbId. A basename two different titles share is left out: it can't referee either. */
  byName: Map<string, number>;
  /** An instance could not be read, so titles only it manages are missing. */
  incomplete: boolean;
}

// A partial or empty map is kept only briefly: long enough that a page render
// stops re-fetching every catalogue while one instance is down (each fetch can
// wait out its 30 s timeout), short enough that a Radarr restart costs minutes
// of missing verdicts, not the 6 h a full map keeps.
const ARR_PATHS_SHORT_TTL = 3 * 60;

type StoredArrPaths = [string, number][] | { entries: [string, number][]; incomplete: boolean };

function arrPathsCacheKey(mediaType: "MOVIE" | "TV"): string {
  return `arr:${mediaType === "MOVIE" ? "radarr" : "sonarr"}:paths`;
}

function storedEntries(value: unknown): { entries: [string, number][]; incomplete: boolean } | null {
  // A bare array is a complete map; `[]` is not a hit (an empty map is only
  // ever stored in the object form, under the short TTL).
  const raw = Array.isArray(value)
    ? (value.length > 0 ? { entries: value as unknown[], incomplete: false } : null)
    : value && typeof value === "object" && Array.isArray((value as { entries?: unknown }).entries)
      ? { entries: (value as { entries: unknown[] }).entries, incomplete: (value as { incomplete?: unknown }).incomplete === true }
      : null;
  if (!raw) return null;
  const entries: [string, number][] = [];
  for (const e of raw.entries) {
    if (Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "number") entries.push([e[0], e[1]]);
  }
  return { entries, incomplete: raw.incomplete };
}

/** Folder basename → tmdbId, leaving out a basename two different titles share. */
export function arrNameIndex(byPath: ReadonlyMap<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  const ambiguous = new Set<string>();
  for (const [path, tmdbId] of byPath) {
    const name = path.split("/").pop();
    if (!name || ambiguous.has(name)) continue;
    const seen = out.get(name);
    if (seen === undefined) out.set(name, tmdbId);
    else if (seen !== tmdbId) {
      out.delete(name);
      ambiguous.add(name);
    }
  }
  return out;
}

function toIndex(byPath: Map<string, number>, incomplete: boolean): ArrPathIndex {
  return { byPath, byName: arrNameIndex(byPath), incomplete };
}

/**
 * The Radarr (MOVIE) or Sonarr (TV) folder map, from the cache or built from
 * every syncable instance. Never throws: a failure warns (once per unchanged
 * condition, guardrail 7b) and leaves the map partial.
 */
export async function loadArrPathIndex(mediaType: "MOVIE" | "TV"): Promise<ArrPathIndex> {
  const cacheKey = arrPathsCacheKey(mediaType);
  const service = mediaType === "MOVIE" ? "radarr" : "sonarr";
  const byPath = new Map<string, number>();
  try {
    const cached = storedEntries(await getCache<unknown>(cacheKey));
    if (cached) return toIndex(new Map(cached.entries), cached.incomplete);

    const [{ getSyncableArrInstances }, { arrErrorMessage, arrFetch, getArrCfg }] = await Promise.all([
      import("@/lib/arr-instance-registry"),
      import("@/lib/arr"),
    ]);
    const instances = await getSyncableArrInstances(service);
    if (instances.length === 0) return toIndex(byPath, false);

    const endpoint = mediaType === "MOVIE" ? "movie" : "series";
    // The handful of configured instances are read together, so one that is
    // down costs its own timeout rather than adding it to everyone else's.
    const lists = await Promise.allSettled(instances.map(async (inst) => {
      const cfg = await getArrCfg(service, inst.slug);
      if (!cfg) return [] as [string, number][];
      // arrFetch (not a bare safeFetchAdminConfigured): it carries the 50 MB
      // body cap (guardrail 5) and throws ArrResponseError on a non-2xx.
      const items = await arrFetch<unknown>(cfg, `/api/v3/${endpoint}`);
      if (!Array.isArray(items)) throw new Error(`/api/v3/${endpoint} did not answer with a list`);
      const out: [string, number][] = [];
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const { tmdbId, path } = item as { tmdbId?: unknown; path?: unknown };
        if (typeof tmdbId !== "number" || !tmdbId || typeof path !== "string" || !path) continue;
        out.push([path.replace(/\\/g, "/").replace(/\/$/, ""), tmdbId]);
      }
      return out;
    }));

    let incomplete = false;
    // Merged in registry order (the default instance first), first claim wins.
    lists.forEach((result, i) => {
      const slug = instances[i].slug;
      const logKey = `bad-matches:arr-paths:${service}:${slug}`;
      if (result.status === "rejected") {
        incomplete = true;
        const reason = arrErrorMessage(result.reason);
        warnOnChange(logKey, reason, `[bad-matches] ARR path map fetch failed for ${service} instance "${slug}": ${reason}`);
        return;
      }
      forgetWarnOnChange(logKey);
      for (const [path, tmdbId] of result.value) if (!byPath.has(path)) byPath.set(path, tmdbId);
    });

    if (!incomplete && byPath.size > 0) {
      await setCache(cacheKey, [...byPath.entries()], TTL.ARR_PATHS);
    } else {
      await setCache(cacheKey, { entries: [...byPath.entries()], incomplete } satisfies StoredArrPaths, ARR_PATHS_SHORT_TTL);
    }
    return toIndex(byPath, incomplete);
  } catch (err) {
    // Don't swallow silently: a missing map makes every bad-match verdict null,
    // which used to look like "no problems found".
    const reason = err instanceof Error ? err.message : String(err);
    warnOnChange(`bad-matches:arr-paths:${service}`, reason, `[bad-matches] ARR path map fetch failed: ${reason}`);
    return toIndex(byPath, true);
  }
}

/**
 * The cached basename index alone, or null when nothing is cached — never a
 * Radarr/Sonarr call. For a caller with its own exact lookup to fall back on
 * (fix-match's file-info).
 */
export async function cachedArrNameIndex(mediaType: "MOVIE" | "TV"): Promise<Map<string, number> | null> {
  const cached = storedEntries(await getCache<unknown>(arrPathsCacheKey(mediaType)));
  return cached ? arrNameIndex(new Map(cached.entries)) : null;
}

/**
 * Poster paths keyed by `${tmdbId}:${mediaType}`. TmdbMediaCore first — plain
 * `posterPath` column, no `:details` blob transfer/parse. Core rows expire and
 * get purged, so pairs missing from core fall back to the TMDB details cache.
 */
async function posterPathMap(
  items: { tmdbId: number; mediaType: "MOVIE" | "TV" }[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (items.length === 0) return out;

  const pairs = [...new Map(items.map((i) => [`${i.tmdbId}:${i.mediaType}`, i])).values()];
  // One `tmdbId IN (…)` per media type (the (tmdbId, mediaType) key serves
  // both), not one OR term per pair — the wide-OR shape plans poorly once a
  // badly mismatched library hands it hundreds of pairs.
  const movieIds = pairs.filter((p) => p.mediaType === "MOVIE").map((p) => p.tmdbId);
  const tvIds = pairs.filter((p) => p.mediaType === "TV").map((p) => p.tmdbId);
  const coreRows = await prisma.tmdbMediaCore.findMany({
    where: {
      OR: [
        ...(movieIds.length ? [{ mediaType: "MOVIE" as const, tmdbId: { in: movieIds } }] : []),
        ...(tvIds.length ? [{ mediaType: "TV" as const, tmdbId: { in: tvIds } }] : []),
      ],
    },
    select: { tmdbId: true, mediaType: true, posterPath: true },
  });
  // Skip null-poster core rows so they fall through to the blob fallback below
  // (consistent with poster-cache.ts — the blob may still carry a poster).
  for (const r of coreRows) {
    if (r.posterPath != null) out.set(`${r.tmdbId}:${r.mediaType}`, r.posterPath);
  }

  const misses = pairs.filter((p) => !out.has(`${p.tmdbId}:${p.mediaType}`));
  if (misses.length === 0) return out;

  const cacheKeys = misses.map((i) => `${i.mediaType === "MOVIE" ? "movie" : "tv"}:${i.tmdbId}:details`);
  const rows = await prisma.tmdbCache.findMany({
    where: { key: { in: cacheKeys } },
    select: { key: true, data: true },
  });
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.data) as { posterPath?: string | null };
      const parts = row.key.split(":");
      const mediaType = parts[0] === "movie" ? "MOVIE" : "TV";
      const tmdbId = parseInt(parts[1], 10);
      if (!isNaN(tmdbId)) out.set(`${tmdbId}:${mediaType}`, parsed.posterPath ?? null);
    } catch {}
  }
  return out;
}

type PathEntry = {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  filePath: string;
  key: string | null; // ratingKey (plex) or itemId (jellyfin)
  serverInstance: string;
  title: string | null;
  year: string | null;
};

// One service's rows, flattened to the shape buildPathMap consumes (the two
// tables differ only in the name of their server-native id column).
type LibraryRow = {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  filePath: string | null;
  serverInstance: string;
  key: string | null;
  title: string | null;
  year: string | null;
};

type StripPrefixField = "MoviePathStripPrefix" | "TvPathStripPrefix";
type StripSettingKey = (instance: MediaInstanceKey, field: StripPrefixField) => string;

// The Movie/Tv strip-prefix Setting keys for every NAMED instance present in a
// row set. The default instance's two keys are always read separately, so this
// returns [] — and costs no query — for a single-server deployment.
function namedStripKeys(rows: { serverInstance: string }[], settingKey: StripSettingKey): string[] {
  const slugs = new Set<string>();
  for (const r of rows) {
    // isValidMediaInstanceSlug guards key derivation against a corrupt/hand-
    // edited serverInstance; such a row just inherits the default's prefix.
    if (r.serverInstance !== DEFAULT_MEDIA_INSTANCE && isValidMediaInstanceSlug(r.serverInstance)) {
      slugs.add(r.serverInstance);
    }
  }
  return [...slugs].flatMap((s) => [settingKey(s, "MoviePathStripPrefix"), settingKey(s, "TvPathStripPrefix")]);
}

// Per-instance strip prefix, falling back to the shared default-instance key
// when the instance has no row of its own. That fallback is what keeps every
// existing deployment byte-identical: only plexMoviePathStripPrefix & co. exist
// there, and a named server the admin hasn't configured separately inherits them.
function stripResolver(cfg: Record<string, string>, settingKey: StripSettingKey) {
  return (instance: string, mediaType: "MOVIE" | "TV"): string => {
    const field: StripPrefixField = mediaType === "MOVIE" ? "MoviePathStripPrefix" : "TvPathStripPrefix";
    return cfg[settingKey(instance, field)] ?? cfg[settingKey(DEFAULT_MEDIA_INSTANCE, field)] ?? "";
  };
}

// Relative-path keyspace for one service, normalised PER (SERVER INSTANCE,
// MEDIA TYPE).
//
// Grouping first is the whole correctness story: commonPathPrefix infers a
// bind-mount root from the longest shared prefix of the paths it is handed, so
// two Plex servers mounted at /plexmedia/… and /mnt/nas/video/… share no leading
// segment, the inferred mount collapses to "", nothing is stripped, every key
// stays an absolute path the other service can never match — and the report
// silently empties out, reading as "no problems found".
//
// Media type is part of that grouping for the same reason: in the normal layout
// (/data/movies + /data/tv) one mount inferred across BOTH types stops at the
// shared parent, so every TV rel keeps its library-dir segment and toMatchKey —
// which takes segment 0 for TV — reduces EVERY show to the single key "tv". The
// whole TV half of the map then collapses onto one entry (last writer wins),
// hiding every real mismatch and pairing two unrelated shows. Per-type mounts
// also match what /api/admin/library-sample-paths previews to the admin, so the
// *TvPathStripPrefix field reads as unnecessary because it genuinely is.
//
// The groups then merge into ONE keyspace, because the Plex↔Jellyfin join is
// relative-path based and cannot be instance-scoped (the same file is normally
// on a Plex server AND a Jellyfin server, under unrelated slugs). Two instances
// holding the same relative path is a mirrored library, so last-writer-wins
// collapses two entries for one physical file rather than corrupting anything;
// the default instance is merged last so it wins that collapse.
function buildPathMap(rows: LibraryRow[], stripFor: (instance: string, mediaType: "MOVIE" | "TV") => string): Map<string, PathEntry> {
  // `<slug> <MEDIATYPE>` — a slug can hold no space (isValidMediaInstanceSlug),
  // so the first one always separates the two halves.
  const byGroup = new Map<string, LibraryRow[]>();
  for (const row of rows) {
    if (!row.filePath) continue;
    const groupKey = `${row.serverInstance} ${row.mediaType}`;
    const group = byGroup.get(groupKey);
    if (group) group.push(row);
    else byGroup.set(groupKey, [row]);
  }

  const out = new Map<string, PathEntry>();
  const instanceOf = (groupKey: string) => groupKey.slice(0, groupKey.indexOf(" "));
  const ordered = [...byGroup.keys()].sort((a, b) => {
    const ai = instanceOf(a);
    const bi = instanceOf(b);
    if (ai === bi) return a.localeCompare(b);
    return ai === DEFAULT_MEDIA_INSTANCE ? 1 : bi === DEFAULT_MEDIA_INSTANCE ? -1 : ai.localeCompare(bi);
  });
  const mounts = inferGroupMounts(byGroup);
  for (const groupKey of ordered) {
    const group = byGroup.get(groupKey)!;
    const mount = mounts.get(groupKey)!;
    for (const item of group) {
      const rel = stripMountPoint(item.filePath, mount);
      if (!rel) continue;
      const matchKey = toMatchKey(stripRelPrefix(rel, stripFor(item.serverInstance, item.mediaType)), item.mediaType);
      // An empty key is not an identity: paths sharing no first segment infer a
      // "" mount, and every such row would otherwise pile onto one blank entry
      // and pair two unrelated titles.
      if (!matchKey) continue;
      out.set(matchKey, {
        tmdbId: item.tmdbId, mediaType: item.mediaType, filePath: item.filePath!,
        key: item.key, serverInstance: item.serverInstance, title: item.title, year: item.year,
      });
    }
  }
  return out;
}

// The same stable order as the admin library page, so a library past the cap
// is cut at the same rows on every read instead of an arbitrary subset per table.
const LIBRARY_ORDER = [{ serverInstance: "asc" as const }, { mediaType: "asc" as const }, { tmdbId: "asc" as const }];

export interface BadMatchReport {
  badMatches: BadMatchItem[];
  /** A library table reached LIBRARY_ITEM_CAP rows: titles past it were not compared. */
  capped: boolean;
}

export async function getBadMatches(activeType?: "MOVIE" | "TV"): Promise<BadMatchItem[]> {
  return (await getBadMatchReport(activeType)).badMatches;
}

export async function getBadMatchReport(activeType?: "MOVIE" | "TV"): Promise<BadMatchReport> {
  const [plexItems, jellyfinItems, prefixRows] = await Promise.all([
    prisma.plexLibraryItem.findMany({
      select: { tmdbId: true, mediaType: true, filePath: true, plexRatingKey: true, title: true, year: true, serverInstance: true },
      orderBy: LIBRARY_ORDER,
      take: LIBRARY_ITEM_CAP,
    }),
    prisma.jellyfinLibraryItem.findMany({
      select: { tmdbId: true, mediaType: true, filePath: true, jellyfinItemId: true, title: true, year: true, serverInstance: true },
      orderBy: LIBRARY_ORDER,
      take: LIBRARY_ITEM_CAP,
    }),
    prisma.setting.findMany({
      where: { key: { in: ["plexMoviePathStripPrefix", "plexTvPathStripPrefix", "jellyfinMoviePathStripPrefix", "jellyfinTvPathStripPrefix"] } },
    }),
  ]);

  const capped = plexItems.length >= LIBRARY_ITEM_CAP || jellyfinItems.length >= LIBRARY_ITEM_CAP;
  const prefixCfg: Record<string, string> = Object.fromEntries(prefixRows.map((r) => [r.key, r.value]));

  // Named servers' own strip prefixes (plex<Slug>MoviePathStripPrefix, …). The
  // slug list is taken from the library rows rather than the instance registry:
  // those are exactly the instances with paths to normalise, and a row left
  // behind by a de-registered instance still gets its own prefix.
  const namedKeys = [
    ...namedStripKeys(plexItems, plexSettingKey),
    ...namedStripKeys(jellyfinItems, jellyfinSettingKey),
  ];
  if (namedKeys.length > 0) {
    const namedRows = await prisma.setting.findMany({ where: { key: { in: namedKeys } } });
    for (const r of namedRows) prefixCfg[r.key] = r.value;
  }

  const plexPathMap = buildPathMap(
    plexItems.map((i) => ({
      tmdbId: i.tmdbId, mediaType: i.mediaType, filePath: i.filePath,
      serverInstance: i.serverInstance, key: i.plexRatingKey, title: i.title, year: i.year,
    })),
    stripResolver(prefixCfg, plexSettingKey),
  );

  const jfPathMap = buildPathMap(
    jellyfinItems.map((i) => ({
      tmdbId: i.tmdbId, mediaType: i.mediaType, filePath: i.filePath,
      serverInstance: i.serverInstance, key: i.jellyfinItemId, title: i.title, year: i.year,
    })),
    stripResolver(prefixCfg, jellyfinSettingKey),
  );

  const raw: { relativePath: string; plex: PathEntry; jellyfin: PathEntry }[] = [];
  for (const [relPath, plexItem] of plexPathMap) {
    const jellyfinItem = jfPathMap.get(relPath);
    if (!jellyfinItem) continue;
    if (plexItem.tmdbId !== jellyfinItem.tmdbId || plexItem.mediaType !== jellyfinItem.mediaType) {
      raw.push({ relativePath: relPath, plex: plexItem, jellyfin: jellyfinItem });
    }
  }

  const filtered = activeType
    ? raw.filter((m) => m.plex.mediaType === activeType || m.jellyfin.mediaType === activeType)
    : raw;

  // Nothing to verdict → nothing to look up. The arr maps below are consumed only
  // inside the per-match map, and on the common healthy library they used to be
  // built anyway: two TmdbCache reads + a library-sized JSON.parse when warm, and
  // when cold a full /api/v3/movie + /api/v3/series arrFetch across EVERY syncable
  // instance. posterPathMap already short-circuits on empty input; this guard
  // covers the arr maps too.
  if (filtered.length === 0) return { badMatches: [], capped };

  const [posters, movieArr, tvArr] = await Promise.all([
    posterPathMap(filtered.flatMap((m) => [m.plex, m.jellyfin])),
    loadArrPathIndex("MOVIE"),
    loadArrPathIndex("TV"),
  ]);

  const side = (e: PathEntry): BadMatchSide => ({
    tmdbId: e.tmdbId,
    mediaType: e.mediaType,
    title: e.title,
    posterPath: posters.get(`${e.tmdbId}:${e.mediaType}`) ?? null,
    releaseYear: e.year,
    serverInstance: e.serverInstance,
  });

  const badMatches = filtered.map((m) => {
    const arrNames = (m.plex.mediaType === "MOVIE" ? movieArr : tvArr).byName;
    // The basename index's key: for TV the SERIES folder — m.relativePath is
    // already reduced to it by toMatchKey — while for movies it's the movie's
    // own folder (the file's parent). Using folderOf for TV yields the SEASON
    // folder and never matches Sonarr, so split by mediaType.
    const folder = m.plex.mediaType === "TV"
      ? m.relativePath
      : (folderOf(m.plex.filePath) || folderOf(m.jellyfin.filePath)).split("/").pop() ?? "";
    const arrTmdbId = arrNames.get(folder) ?? null;

    let arrVerdict: "plex" | "jellyfin" | null = null;
    if (arrTmdbId !== null) {
      const plexCorrect = m.plex.tmdbId === arrTmdbId;
      const jellyfinCorrect = m.jellyfin.tmdbId === arrTmdbId;
      if (plexCorrect && !jellyfinCorrect) arrVerdict = "jellyfin";
      if (!plexCorrect && jellyfinCorrect) arrVerdict = "plex";
    }

    return {
      relativePath: m.relativePath,
      plex: side(m.plex),
      plexRatingKey: m.plex.key,
      jellyfin: side(m.jellyfin),
      jellyfinItemId: m.jellyfin.key,
      arrTmdbId,
      arrVerdict,
    };
  });
  return { badMatches, capped };
}
