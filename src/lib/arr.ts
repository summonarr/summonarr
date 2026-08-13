import { prisma } from "./prisma";
import { arrRequesterTagLabel } from "./arr-tags";
import { arrSettingKey, isRadarrMinimumAvailability, type ArrInstanceKey, type RadarrMinimumAvailability } from "./arr-instances";
import { safeFetchAdminConfigured, safeFetchTrusted } from "./safe-fetch";
import { sanitizeForLog } from "./sanitize";
import { getCache, getCacheMany, setCache, TTL } from "./tmdb-cache";
import { tmdbAuth } from "./tmdb-auth";

const QUALITY_PROFILE_TTL_MS = 10 * 60 * 1000;
const QUEUE_STATE_TTL_MS = 15 * 1000;
const qualityProfileCache = new Map<string, { ids: Set<number> | null; expiresAt: number }>();
const queueCache = new Map<string, { tmdbIds: Set<number>; tvdbIds: Set<number>; expiresAt: number }>();

// Resolved mappings are stable for a year; unresolved ones re-try daily in case TMDB eventually adds the show
const TVDB_TO_TMDB_TTL_RESOLVED   = 365 * 24 * 60 * 60;
const TVDB_TO_TMDB_TTL_UNRESOLVED =        24 * 60 * 60;
type TvdbToTmdbCache = { tmdbId: number | null };

// `hadErrors` is true when a lookup could not be completed this run (TMDB auth missing,
// or a TMDB request threw / returned non-2xx). It lets callers that wholesale-replace a
// cache from the result distinguish "series genuinely has no tmdb mapping" (safe to omit)
// from "we couldn't resolve it right now" (omitting it would wrongly evict a known series).
export async function resolveTvdbToTmdb(
  tvdbIds: number[],
): Promise<{ map: Map<number, number>; hadErrors: boolean }> {
  const result = new Map<number, number>();
  let hadErrors = false;
  if (tvdbIds.length === 0) return { map: result, hadErrors };

  // One batched read for the whole id set — the old per-id getCache loop issued
  // hundreds of sequential round-trips per sync run on libraries where Sonarr
  // doesn't supply a native tmdbId.
  const cachedRows = await getCacheMany<TvdbToTmdbCache>(tvdbIds.map((id) => `tvdb-to-tmdb:${id}`));
  const uncached: number[] = [];
  for (const tvdbId of tvdbIds) {
    const cached = cachedRows.get(`tvdb-to-tmdb:${tvdbId}`);
    if (cached) {
      if (cached.tmdbId !== null) result.set(tvdbId, cached.tmdbId);
    } else {
      uncached.push(tvdbId);
    }
  }
  if (uncached.length === 0) return { map: result, hadErrors };

  const reqRows = await prisma.mediaRequest.findMany({
    where: { mediaType: "TV", tvdbId: { in: uncached } },
    select: { tvdbId: true, tmdbId: true },
  });
  const fromReq = new Map(
    reqRows.filter((r) => r.tvdbId != null).map((r) => [r.tvdbId!, r.tmdbId])
  );
  const stillUnknown: number[] = [];
  for (const tvdbId of uncached) {
    const tmdbId = fromReq.get(tvdbId);
    if (tmdbId !== undefined) {
      result.set(tvdbId, tmdbId);
      await setCache(`tvdb-to-tmdb:${tvdbId}`, { tmdbId }, TVDB_TO_TMDB_TTL_RESOLVED);
    } else {
      stillUnknown.push(tvdbId);
    }
  }
  if (stillUnknown.length === 0) return { map: result, hadErrors };

  const auth = tmdbAuth();
  if (!auth) {
    // Can't resolve any of the still-unknown series this run — report it so the
    // caller doesn't treat their absence as authoritative.
    return { map: result, hadErrors: true };
  }

  const CONCURRENCY = 5;
  for (let i = 0; i < stillUnknown.length; i += CONCURRENCY) {
    const batch = stillUnknown.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (tvdbId) => {
      try {
        const url = new URL(`https://api.themoviedb.org/3/find/${tvdbId}`);
        url.searchParams.set("external_source", "tvdb_id");
        for (const [k, v] of Object.entries(auth.query)) url.searchParams.set(k, v);
        const res = await safeFetchTrusted(url.toString(), {
          allowedHosts: ["api.themoviedb.org"],
          headers: auth.headers,
          timeoutMs: 10_000,
        });
        if (!res.ok) {
          console.warn("[arr] tvdb-to-tmdb TMDB lookup returned %s for tvdbId %s", sanitizeForLog(res.status), sanitizeForLog(tvdbId));
          hadErrors = true;
          return;
        }
        const data = await res.json() as { tv_results?: { id: number }[] };
        const tmdbId = data.tv_results?.[0]?.id ?? null;
        await setCache(
          `tvdb-to-tmdb:${tvdbId}`,
          { tmdbId } satisfies TvdbToTmdbCache,
          tmdbId !== null ? TVDB_TO_TMDB_TTL_RESOLVED : TVDB_TO_TMDB_TTL_UNRESOLVED,
        );
        if (tmdbId !== null) result.set(tvdbId, tmdbId);
      } catch (err) {
        // Don't swallow: a TMDB 429/401/outage here silently drops every
        // tvdbId-only series from wanted/available/arrPending with no evidence.
        console.warn("[arr] tvdb-to-tmdb TMDB lookup failed for tvdbId %s:", sanitizeForLog(tvdbId), sanitizeForLog(err instanceof Error ? err.message : err));
        hadErrors = true;
      }
    }));
  }
  return { map: result, hadErrors };
}

/**
 * Resolves a single tvdbId to its tmdbId (cache → MediaRequest → TMDB). Returns null
 * when it can't be resolved. Used by the Sonarr webhook to evict the tmdbId-keyed
 * wanted-cache row when a Download event carries only a tvdbId and no MediaRequest
 * maps it.
 */
export async function resolveSingleTvdbToTmdb(tvdbId: number): Promise<number | null> {
  if (!Number.isInteger(tvdbId) || tvdbId <= 0) return null;
  const { map } = await resolveTvdbToTmdb([tvdbId]);
  return map.get(tvdbId) ?? null;
}

export type ArrCfg = { url: string; apiKey: string };

type ArrCfgFull = ArrCfg & {
  rootFolder?: string;
  qualityProfileId?: number;
  // Radarr only — when the movie counts as "available" to search. Absent means
  // "don't send the field", preserving whatever Radarr defaults to.
  minimumAvailability?: RadarrMinimumAvailability;
  // Sonarr v3 only — v4 removed language profiles. Absent means "don't send".
  languageProfileId?: number;
};

// An instance slug: "" (the default), "4k", or any named instance from the
// registry (arr-instance-registry.ts). Functions that target a specific instance
// take an optional `variant` defaulting to "" (the default instance). ArrVariant
// is retained as an alias of ArrInstanceKey for call sites still typed on it, and
// getCfg accepts the legacy "hd" spelling (mapped to the default "") so existing
// `is4k ? "4k" : "hd"` callers keep resolving the same Setting keys.
export type ArrVariant = ArrInstanceKey;

// Human label for an error message: "Radarr" for the default/"hd", "Radarr (4k)"
// for any named instance.
function instanceLabel(service: string, variant: ArrVariant): string {
  return variant && variant !== "hd" ? `${service} (${variant})` : service;
}

export async function getArrCfg(service: "radarr" | "sonarr", variant: ArrVariant = ""): Promise<ArrCfg | null> {
  const cfg = await getCfg(service, variant);
  if (!cfg) return null;
  return { url: cfg.url, apiKey: cfg.apiKey };
}

// Whether a given instance variant is configured (the 4K instance is optional).
export async function isArrConfigured(service: "radarr" | "sonarr", variant: ArrVariant = ""): Promise<boolean> {
  return (await getCfg(service, variant)) !== null;
}

async function getCfg(service: "radarr" | "sonarr", variant: ArrVariant = ""): Promise<ArrCfgFull | null> {
  // Key derivation is centralized in arr-instances.ts (the single place that
  // knows how an instance maps to Setting keys). `variant` is an instance slug;
  // the legacy "hd" spelling maps to the default instance ("").
  const instance    = variant === "hd" ? "" : variant;
  const urlKey      = arrSettingKey(service, instance, "Url");
  const keyKey      = arrSettingKey(service, instance, "ApiKey");
  const folderKey   = arrSettingKey(service, instance, "RootFolder");
  const profileKey  = arrSettingKey(service, instance, "QualityProfileId");
  // Service-specific optional fields — the derived key for the "wrong" service
  // simply never has a Setting row, so reading both keeps this fn uniform.
  const minAvailKey = arrSettingKey(service, instance, "MinimumAvailability");
  const langKey     = arrSettingKey(service, instance, "LanguageProfileId");
  const rows = await prisma.setting.findMany({
    where: { key: { in: [urlKey, keyKey, folderKey, profileKey, minAvailKey, langKey] } },
  });
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  if (!map[urlKey] || !map[keyKey]) return null;
  // A non-numeric stored value (nothing validates it on the write side) must read
  // as "unset", not NaN. NaN is falsy — so the `needProfiles` guards fetch a
  // fallback profile — but it survives `??`, so the fetched fallback is skipped
  // and the add POSTs `"qualityProfileId": null`, hard-failing every request
  // routed to that instance with a Radarr/Sonarr 400.
  const storedProfileId = map[profileKey] ? Number(map[profileKey]) : NaN;
  return {
    url: map[urlKey].replace(/\/$/, ""),
    apiKey: map[keyKey],
    // Same hazard as qualityProfileId above, one type down: a stored EMPTY string
    // is the instance manager's documented "— use the server's default —" choice
    // (its select ships `<option value="">`), and it is written verbatim as a
    // Setting row. `""` is falsy — so the add's `needRootFolders` guards fetch the
    // fallback list — but it SURVIVES `??`, so `cfg.rootFolder ?? rootFolders[0].path`
    // yields `""` and the add POSTs `"rootFolderPath": ""`, which Radarr/Sonarr
    // reject with a 400. Every request routed to that instance then bounces
    // APPROVED→PENDING forever. Normalise to undefined so `??` behaves as the
    // guards already assume.
    rootFolder: map[folderKey] || undefined,
    qualityProfileId: Number.isInteger(storedProfileId) && storedProfileId > 0 ? storedProfileId : undefined,
    // Same normalize-to-undefined discipline as the two fields above: an
    // unexpected stored value must read as "unset", never ship in a POST body.
    minimumAvailability:
      map[minAvailKey] && isRadarrMinimumAvailability(map[minAvailKey]) ? map[minAvailKey] : undefined,
    languageProfileId:
      map[langKey] && Number.isInteger(Number(map[langKey])) && Number(map[langKey]) > 0
        ? Number(map[langKey])
        : undefined,
  };
}

// Quality profiles for one instance variant, plus the configured default id so a
// picker can mark/pre-select it. Returns null when that instance isn't configured.
// Permission-agnostic — callers gate access (e.g. MANAGE_REQUESTS for the approve
// picker, ADMIN for settings).
export async function listQualityProfiles(
  service: "radarr" | "sonarr",
  variant: ArrVariant = "",
): Promise<{ profiles: { id: number; name: string }[]; defaultId: number | null } | null> {
  const cfg = await getCfg(service, variant);
  if (!cfg) return null;
  const profiles = await arrFetch<{ id: number; name: string }[]>(cfg, "/api/v3/qualityprofile");
  return { profiles, defaultId: cfg.qualityProfileId ?? null };
}

export class ArrResponseError extends Error {
  // Explicit fields (not constructor parameter properties) so the module loads
  // under Node's strip-only TS mode — the unit suite imports it.
  public readonly status: number;
  public readonly body: string;
  constructor(status: number, body: string) {
    super(`Arr service returned a non-200 response (${status})`);
    this.status = status;
    this.body = body;
  }
}

const ARR_FETCH_TIMEOUT_MS = 30_000;

// Raised from 10 MB — libraries with >3k movies were being silently truncated at the old cap
const ARR_FETCH_MAX_BYTES = 50 * 1024 * 1024;

export async function arrFetch<T>(cfg: ArrCfg, path: string, options: RequestInit = {}): Promise<T> {

  const { signal, method, body } = options;
  const res = await safeFetchAdminConfigured(`${cfg.url}${path}`, {
    method,
    body,
    ...(signal ? { signal } : {}),
    cache: "no-store",
    timeoutMs: ARR_FETCH_TIMEOUT_MS,
    maxResponseBytes: ARR_FETCH_MAX_BYTES,
    headers: { "X-Api-Key": cfg.apiKey, "Content-Type": "application/json", ...(options.headers ?? {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    console.error(`[arr] ${sanitizeForLog(path)} → ${res.status}`);
    throw new ArrResponseError(res.status, text);
  }

  return res.json() as Promise<T>;
}

function isDuplicate(err: unknown): boolean {
  if (err instanceof ArrResponseError) {
    return err.status === 400 && /already (been )?added/i.test(err.body);
  }
  return /already (been )?added/i.test(String(err));
}

/**
 * Radarr's `MoviePathValidator` / Sonarr's `SeriesPathValidator` reject an add
 * with a 400 when the `Title (Year)` folder the item would use is already
 * occupied by a *different* item (different tmdb/tvdb id) — two genuinely
 * distinct films/shows that map to the same folder name. This is NOT a
 * duplicate: the requested item still needs to be added under its own id.
 *
 * Returns the colliding path Radarr/Sonarr reported so the caller can retry
 * with an id-disambiguated path; null when the error is anything else. Prefers
 * the structured body (stable `errorCode` + `path` placeholder) and falls back
 * to the human-readable message.
 */
function pathCollisionTarget(err: unknown): string | null {
  if (!(err instanceof ArrResponseError) || err.status !== 400) return null;
  try {
    const parsed = JSON.parse(err.body) as Array<{
      errorCode?: string;
      attemptedValue?: string;
      formattedMessagePlaceholderValues?: { path?: string };
    }>;
    const hit = Array.isArray(parsed)
      ? parsed.find((e) => e?.errorCode === "MoviePathValidator" || e?.errorCode === "SeriesPathValidator")
      : undefined;
    const p = hit?.formattedMessagePlaceholderValues?.path ?? hit?.attemptedValue;
    if (typeof p === "string" && p.length > 0) return p;
  } catch {
    // body wasn't JSON — fall through to the message regex
  }
  const m = err.body.match(/Path '([^']+)' is already configured for an existing/);
  return m && m[1] ? m[1] : null;
}

export function arrErrorMessage(err: unknown): string {
  if (err instanceof ArrResponseError) {
    if (err.status === 401 || err.status === 403) return `Arr authentication failed (${err.status}) — check the API key`;
    if (err.status === 404) return `Item not found in arr (${err.status})`;
    if (err.status >= 500) return `Arr server error (${err.status}) — check the arr service logs`;
    return `Arr request failed (${err.status})`;
  }
  if (err instanceof Error) return err.message;
  return "Arr request failed";
}

async function getAllowedQualityIds(cfg: ArrCfg, profileId?: number): Promise<Set<number> | null> {
  if (!profileId) return null;
  const cacheKey = `${cfg.url}::${profileId}`;
  const now = Date.now();
  const cached = qualityProfileCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.ids;
  try {
    const profiles = await arrFetch<{ id: number; items: { quality?: { id: number }; allowed: boolean; items?: { quality?: { id: number }; allowed: boolean }[] }[] }[]>(
      cfg, "/api/v3/qualityprofile"
    );
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile || !Array.isArray(profile.items)) {
      qualityProfileCache.set(cacheKey, { ids: null, expiresAt: now + QUALITY_PROFILE_TTL_MS });
      return null;
    }
    const ids = new Set<number>();
    for (const item of profile.items) {
      if (!item.allowed) continue;
      if (item.items?.length) {
        for (const sub of item.items) {
          if (sub.allowed && sub.quality?.id != null) ids.add(sub.quality.id);
        }
      } else if (item.quality?.id != null) {
        ids.add(item.quality.id);
      }
    }
    qualityProfileCache.set(cacheKey, { ids, expiresAt: now + QUALITY_PROFILE_TTL_MS });
    return ids;
  } catch {
    return null;
  }
}

function filterAndSortReleases(releases: ArrRelease[], allowedIds: Set<number> | null): ArrRelease[] {
  const downloadable = releases.filter((r) => r.downloadAllowed);
  return downloadable.sort((a, b) => {
    const aMatch = allowedIds ? (allowedIds.has(a.quality.quality.id) ? 1 : 0) : 1;
    const bMatch = allowedIds ? (allowedIds.has(b.quality.quality.id) ? 1 : 0) : 1;
    if (bMatch !== aMatch) return bMatch - aMatch;
    if (b.qualityWeight !== a.qualityWeight) return b.qualityWeight - a.qualityWeight;
    return (b.seeders ?? 0) - (a.seeders ?? 0);
  });
}

export interface ArrRelease {
  guid: string;
  title: string;
  size: number;
  indexerId: number;
  indexer: string;
  quality: { quality: { id: number; name: string }; revision: { version: number } };
  qualityWeight: number;
  protocol: "torrent" | "usenet";
  seeders: number | null;
  leechers: number | null;
  age: number;
  rejected: boolean;
  rejections: string[];
  downloadAllowed: boolean;
}

// Requester tagging (Overseerr parity) — BEST-EFFORT. A grabbed request is tagged
// in Radarr/Sonarr with the requesting user's label so an admin can filter media
// by requester in the *arr UI. Tags are additive metadata with no effect on
// quality/download, so any tagging failure is logged and the add proceeds
// UNTAGGED — it must NEVER fail the add.

// Find-or-create a tag by label; returns its id, or null on ANY failure so the
// caller proceeds untagged rather than failing the add.
async function ensureArrTag(cfg: ArrCfgFull, label: string): Promise<number | null> {
  try {
    const tags = await arrFetch<{ id: number; label: string }[]>(cfg, "/api/v3/tag");
    const existing = tags.find((t) => t.label.toLowerCase() === label.toLowerCase());
    if (existing) return existing.id;
    const created = await arrFetch<{ id: number }>(cfg, "/api/v3/tag", {
      method: "POST",
      body: JSON.stringify({ label }),
    });
    return typeof created?.id === "number" ? created.id : null;
  } catch (err) {
    console.warn("[arr] requester-tag ensure failed (proceeding untagged):", sanitizeForLog(err instanceof Error ? err.message : String(err)));
    return null;
  }
}

// Resolve the requester's tag id(s) for an instance. Looks the user up for a
// human-readable label; returns [] on any failure (⇒ the add stays untagged).
async function resolveRequesterTagIds(cfg: ArrCfgFull, requesterUserId: string | null | undefined): Promise<number[]> {
  if (!requesterUserId) return [];
  try {
    const user = await prisma.user.findUnique({ where: { id: requesterUserId }, select: { name: true, email: true } });
    const id = await ensureArrTag(cfg, arrRequesterTagLabel(user?.name, user?.email, requesterUserId));
    return id != null ? [id] : [];
  } catch (err) {
    console.warn("[arr] requester-tag resolve failed (proceeding untagged):", sanitizeForLog(err instanceof Error ? err.message : String(err)));
    return [];
  }
}

export async function addMovieToRadarr(tmdbId: number, variant: ArrVariant = "", qualityProfileIdOverride?: number, requesterUserId?: string | null): Promise<void> {
  const cfg = await getCfg("radarr", variant);
  if (!cfg) throw new Error(instanceLabel("Radarr", variant) + " is not configured");

  // An explicit override (admin "approve with profile X") wins over the
  // configured default; only fetch the instance's profiles when neither is set.
  const needProfiles = !qualityProfileIdOverride && !cfg.qualityProfileId;
  const [movies, rootFolders, profiles] = await Promise.all([
    arrFetch<{ title: string; tmdbId: number; year: number; images: object[]; titleSlug: string; digitalRelease?: string; physicalRelease?: string; status?: string }[]>(
      cfg, `/api/v3/movie/lookup?term=tmdb:${tmdbId}`
    ),
    cfg.rootFolder
      ? Promise.resolve<{ path: string }[]>([])
      : arrFetch<{ path: string }[]>(cfg, "/api/v3/rootfolder"),
    needProfiles
      ? arrFetch<{ id: number }[]>(cfg, "/api/v3/qualityprofile")
      : Promise.resolve<{ id: number }[]>([]),
  ]);

  if (!movies.length) throw new Error(`Radarr: no movie found for tmdbId ${tmdbId}`);
  if (!cfg.rootFolder && !rootFolders.length) throw new Error("Radarr: no root folders configured");
  if (needProfiles && !profiles.length) throw new Error("Radarr: no quality profiles configured");

  const rootFolderPath = cfg.rootFolder ?? rootFolders[0].path;
  const qualityProfileId = qualityProfileIdOverride ?? cfg.qualityProfileId ?? profiles[0].id;
  const tagIds = await resolveRequesterTagIds(cfg, requesterUserId);

  // Radarr's `tmdb:` lookup degrades to a fuzzy *title* search when the term
  // isn't recognized as an id form, so a non-empty result list can be entirely
  // unrelated films — taking [0] blindly adds the wrong movie to the library.
  // Match on the requested id (every read path in this file already does) and
  // fall back to the single row only when the lookup returned exactly one.
  const movie = movies.find((m) => m.tmdbId === tmdbId) ?? (movies.length === 1 ? movies[0] : undefined);
  if (!movie) throw new Error(`Radarr: lookup for tmdbId ${tmdbId} returned no matching movie`);
  const now = new Date();
  const releaseDates = [movie.digitalRelease, movie.physicalRelease]
    .filter(Boolean)
    .map((d) => new Date(d!));
  // Also trust Radarr's own computed `status === "released"`: upstream sets it
  // when a home date is past OR when a title has NO home dates but left
  // cinemas 90+ days ago — exactly the metadata state the year heuristic
  // mishandled (a current-year release missing type-4/5 dates read as
  // unreleased and the add-time search never fired).
  const movieReleased =
    releaseDates.some((d) => d <= now) ||
    movie.status === "released" ||
    (releaseDates.length === 0 && movie.year > 0 && movie.year < now.getFullYear());

  // Explicit allowlist of the Radarr POST body fields we own — previous code
  // spread the entire lookup row (~30 fields, untyped) which would silently
  // forward whatever Radarr returned at lookup time, exposing us to a
  // future Radarr API tightening that rejects unexpected fields on add.
  // `pathOverride` is set only on the collision-retry below.
  const postMovie = (pathOverride?: string) =>
    arrFetch<unknown>(cfg, "/api/v3/movie", {
      method: "POST",
      body: JSON.stringify({
        tmdbId: movie.tmdbId,
        title: movie.title,
        year: movie.year,
        titleSlug: movie.titleSlug,
        images: movie.images,
        rootFolderPath,
        ...(pathOverride ? { path: pathOverride } : {}),
        qualityProfileId,
        // Only when the instance configured one — omitting the field preserves
        // Radarr's own default, byte-identical to pre-feature adds.
        ...(cfg.minimumAvailability ? { minimumAvailability: cfg.minimumAvailability } : {}),
        ...(tagIds.length ? { tags: tagIds } : {}),
        monitored: true,
        addOptions: { searchForMovie: movieReleased },
      }),
    });

  // Duplicate remediation: "already been added" used to read as pure success —
  // but a pre-existing UNMONITORED, file-less entry is never auto-grabbed
  // (Radarr's decision engine rejects unmonitored movies on RSS and automatic
  // search), so the approved request sat APPROVED forever while approve
  // reported success. Best-effort: re-monitor + search; any failure degrades
  // to the old warn-and-skip.
  const remediateExistingMovie = async () => {
    try {
      const existing = await arrFetch<Array<{ id: number; tmdbId: number; monitored: boolean; hasFile: boolean } & Record<string, unknown>>>(
        cfg, `/api/v3/movie?tmdbId=${tmdbId}`,
      );
      const row = existing.find((m) => m.tmdbId === tmdbId);
      if (!row || row.hasFile || row.monitored) return;
      // Radarr's PUT expects the full MovieResource — round-trip the row with
      // only the monitored flag flipped.
      await arrFetch<unknown>(cfg, `/api/v3/movie/${row.id}`, {
        method: "PUT",
        body: JSON.stringify({ ...row, monitored: true }),
      });
      if (movieReleased) {
        await arrFetch<unknown>(cfg, "/api/v3/command", {
          method: "POST",
          body: JSON.stringify({ name: "MoviesSearch", movieIds: [row.id] }),
        });
      }
    } catch (remErr) {
      console.warn("[arr] existing-movie re-monitor failed (leaving as-is):", arrErrorMessage(remErr));
    }
  };

  try {
    await postMovie();
  } catch (err) {
    if (isDuplicate(err)) {
      console.warn("[arr] movie already in Radarr — re-checking its monitored state", { tmdbId });
      await remediateExistingMovie();
      return;
    }
    // A *different* movie (different tmdbId) already occupies the `Title (Year)`
    // folder this title would use. Retry once with a tmdbId-tagged path —
    // mirrors Radarr's own `{tmdb-<id>}` folder token — so two genuinely
    // distinct same-title films can coexist instead of the request hard-failing.
    const collidedPath = pathCollisionTarget(err);
    if (!collidedPath) throw err;
    try {
      await postMovie(`${collidedPath} {tmdb-${movie.tmdbId}}`);
    } catch (retryErr) {
      // The id-tagged path can only collide if this exact tmdbId is already in
      // Radarr — a real duplicate, which surfaces as "already added".
      if (isDuplicate(retryErr)) {
        console.warn("[arr] movie already in Radarr — re-checking its monitored state", { tmdbId });
        await remediateExistingMovie();
        return;
      }
      throw retryErr;
    }
  }
}

export async function getRadarrWantedTmdbIds(variant: ArrVariant = ""): Promise<{ wanted: Set<number>; available: Set<number> } | null> {
  const cfg = await getCfg("radarr", variant);
  if (!cfg) return { wanted: new Set(), available: new Set() };
  try {
    const movies = await arrFetch<{ tmdbId: number; hasFile: boolean }[]>(cfg, "/api/v3/movie");
    const wanted = new Set(movies.filter((m) => !m.hasFile).map((m) => m.tmdbId));
    const available = new Set(movies.filter((m) => m.hasFile).map((m) => m.tmdbId));
    return { wanted, available };
  } catch (err) {
    console.error("[arr] getRadarrWantedTmdbIds failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function getSonarrWantedTmdbIds(variant: ArrVariant = ""): Promise<{ wanted: Set<number>; available: Set<number> } | null> {
  const cfg = await getCfg("sonarr", variant);
  if (!cfg) return { wanted: new Set(), available: new Set() };
  try {
    const series = await arrFetch<{ tvdbId: number; tmdbId?: number; status: string; statistics: { episodeFileCount: number; episodeCount: number } }[]>(
      cfg, "/api/v3/series"
    );
    const wanted = new Set<number>();
    const available = new Set<number>();
    const wantedNeedsResolve: number[] = [];
    const availableNeedsResolve: number[] = [];
    for (const s of series) {
      // Guard `statistics` like isSeriesDownloadedInSonarr does: the field is
      // normally always present on /api/v3/series, but ONE anomalous row without
      // it would throw here, trip the outer catch, and silently skip the entire
      // wanted/available cache update run after run — an opaque availability
      // freeze. A missing statistics block reads as zero files (wanted).
      //
      // Denominator is `episodeCount` — Sonarr's own 100% notion ((monitored AND
      // aired) OR has-file; the PercentOfEpisodes denominator) — NOT
      // `totalEpisodeCount`, which counts unmonitored and unaired episodes
      // including season-0 specials (which addSeriesToSonarr itself adds
      // unmonitored). Against totalEpisodeCount, an ended series with any
      // unmonitored file-less episode could NEVER read fully-downloaded: the
      // request stayed wanted forever and the webhook confirm below rejected
      // its genuine Download events.
      const episodeFileCount = s.statistics?.episodeFileCount ?? 0;
      const episodeCount = s.statistics?.episodeCount ?? 0;
      const allDownloaded = episodeFileCount >= episodeCount;
      // Ongoing series with partial files are "available"; ended series only when fully downloaded
      const isAvailable = episodeFileCount > 0 &&
        (s.status !== "ended" || allDownloaded);
      const isWanted = !isAvailable;

      if (typeof s.tmdbId === "number" && Number.isInteger(s.tmdbId) && s.tmdbId > 0) {
        if (isWanted) wanted.add(s.tmdbId); else available.add(s.tmdbId);
      } else if (typeof s.tvdbId === "number" && Number.isInteger(s.tvdbId) && s.tvdbId > 0) {
        if (isWanted) wantedNeedsResolve.push(s.tvdbId); else availableNeedsResolve.push(s.tvdbId);
      }
    }
    const allNeedsResolve = [...new Set([...wantedNeedsResolve, ...availableNeedsResolve])];
    if (allNeedsResolve.length > 0) {
      const { map, hadErrors } = await resolveTvdbToTmdb(allNeedsResolve);
      // A tvdb→tmdb resolution failure (TMDB unreachable / 429 / auth missing) would
      // otherwise drop a still-present series from BOTH sets. Because the orchestrator
      // wholesale-replaces the wanted/available caches from this result, that vanish
      // could spuriously revert a previously-AVAILABLE TV request. Signal the caller
      // (return null = "ARR fetch failed, leave the cache intact") rather than emit a
      // partial set that under-reports the library.
      if (hadErrors) {
        console.warn("[arr] getSonarrWantedTmdbIds: tvdb→tmdb resolution incomplete; skipping cache update this run");
        return null;
      }
      for (const tvdbId of wantedNeedsResolve) {
        const tmdbId = map.get(tvdbId);
        if (tmdbId !== undefined) wanted.add(tmdbId);
      }
      for (const tvdbId of availableNeedsResolve) {
        const tmdbId = map.get(tvdbId);
        if (tmdbId !== undefined) available.add(tmdbId);
      }
    }
    return { wanted, available };
  } catch (err) {
    console.error("[arr] getSonarrWantedTmdbIds failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function getMovieReleaseInfo(tmdbId: number): Promise<{
  digitalRelease: string | null;
  physicalRelease: string | null;
} | null> {
  const auth = tmdbAuth();
  if (!auth) return null;
  // DEDICATED key — never `movie:${id}:details`. That key belongs to
  // getMovieDetails (tmdb.ts) and holds a NORMALIZED TmdbMedia; this fn used to
  // write the raw snake_case TMDB body under it, poisoning the detail page
  // (mediaType/posterPath/releaseDate all undefined) for the rest of the 7-day
  // TTL — and reading a normalized blob back here found no `release_date`, so
  // release gating silently returned null dates. Store only the fields we need.
  //
  // :v2 — the v1 rows held only the primary release_date, which is normally the
  // THEATRICAL date; reporting it as both digitalRelease and physicalRelease
  // made every consumer's "awaiting release" vs "download pending" split
  // vacuous — an in-cinemas-only movie read as home-released. v2 rows carry the
  // real per-type dates from /release_dates (type 4 = Digital, 5 = Physical);
  // v1 rows age out via their own TTL.
  const cacheKey = `movie:${tmdbId}:release-info:v2`;
  try {
    type ReleaseInfo = { digital: string | null; physical: string | null; primary: string | null };
    let details = await getCache<ReleaseInfo>(cacheKey);
    if (!details) {
      const url = new URL(`https://api.themoviedb.org/3/movie/${tmdbId}`);
      url.searchParams.set("append_to_response", "release_dates");
      for (const [k, v] of Object.entries(auth.query)) url.searchParams.set(k, v);
      const res = await safeFetchTrusted(url.toString(), {
        allowedHosts: ["api.themoviedb.org"],
        headers: auth.headers,
        timeoutMs: 10_000,
      });
      if (!res.ok) return null;
      const body = await res.json() as {
        release_date?: string;
        release_dates?: { results?: Array<{ release_dates?: Array<{ type?: number; release_date?: string }> }> };
      };
      // Earliest digital/physical date across every region (ISO strings —
      // lexicographic min is chronological min).
      let digital: string | null = null;
      let physical: string | null = null;
      for (const region of body.release_dates?.results ?? []) {
        for (const rd of region.release_dates ?? []) {
          if (!rd.release_date) continue;
          if (rd.type === 4 && (digital === null || rd.release_date < digital)) digital = rd.release_date;
          if (rd.type === 5 && (physical === null || rd.release_date < physical)) physical = rd.release_date;
        }
      }
      details = { digital, physical, primary: body.release_date ?? null };
      await setCache(cacheKey, details, TTL.DETAILS);
    }
    // Only when NO home-release type exists in any region fall back to the
    // primary date for both — a dateless back-catalog title should still gate
    // on something rather than read as forever-unreleased.
    if (details.digital === null && details.physical === null) {
      return { digitalRelease: details.primary, physicalRelease: details.primary };
    }
    return { digitalRelease: details.digital, physicalRelease: details.physical };
  } catch { return null; }
}

export async function getSeriesFirstAired(tmdbId: number, variant: ArrVariant = ""): Promise<string | null> {
  const cfg = await getCfg("sonarr", variant);
  if (!cfg) return null;
  try {
    const results = await arrFetch<{ firstAired?: string }[]>(
      cfg, `/api/v3/series/lookup?term=tmdb:${tmdbId}`
    );
    return results[0]?.firstAired ?? null;
  } catch { return null; }
}

export async function isMovieWantedInRadarr(tmdbId: number, variant: ArrVariant = ""): Promise<boolean> {
  const cfg = await getCfg("radarr", variant);
  if (!cfg) return false;
  try {
    const movies = await arrFetch<{ tmdbId: number; hasFile: boolean }[]>(
      cfg, `/api/v3/movie?tmdbId=${tmdbId}`
    );
    return movies.some((m) => m.tmdbId === tmdbId && !m.hasFile);
  } catch {
    return false;
  }
}

export async function isSeriesWantedInSonarr(tmdbId: number, variant: ArrVariant = ""): Promise<boolean> {
  const cfg = await getCfg("sonarr", variant);
  if (!cfg) return false;
  try {
    const lookup = await arrFetch<{ tvdbId: number }[]>(
      cfg, `/api/v3/series/lookup?term=tmdb:${tmdbId}`
    );
    if (!lookup.length) return false;
    const { tvdbId } = lookup[0];
    // Interpolated into the query — hold the never-schema-checked lookup value
    // to the same positive-integer contract isSeriesDownloadedInSonarr applies.
    if (!Number.isInteger(tvdbId) || tvdbId <= 0) return false;
    const library = await arrFetch<{ tvdbId: number; statistics?: { episodeFileCount: number } }[]>(
      cfg, `/api/v3/series?tvdbId=${tvdbId}`
    );
    const match = library.find((s) => s.tvdbId === tvdbId);
    // Guard `statistics` like getSonarrWantedTmdbIds and isSeriesDownloadedInSonarr
    // do: one anomalous /api/v3/series row without the block would throw, hit the
    // catch below, and report `wantedLive: false` with no error — silently
    // misleading the arr-state diagnostic that CLAUDE.md points operators at.
    return !!match && (match.statistics?.episodeFileCount ?? 0) === 0;
  } catch {
    return false;
  }
}

// Authoritative "is this movie actually downloaded" check, used by the Radarr
// webhook to confirm against Radarr's live library before acting on a webhook
// payload. The webhook is authenticated only by a shared secret (no per-payload
// signature — the upstream services don't sign), so a caller who learns that
// secret could POST a forged Download event carrying an arbitrary tmdbId and
// flip an APPROVED request to AVAILABLE for a title Radarr never downloaded.
// Re-querying Radarr for the movie's hasFile flag closes that gap: we trust the
// upstream library's own state rather than the (spoofable) webhook body.
// Returns:
//   true  — Radarr has the movie WITH a file
//   false — Radarr is reachable and reports the movie absent / without a file
//   null  — could not verify (variant not configured, or the call errored).
//           The caller proceeds on null: an attacker can't induce it without
//           also breaking the operator's Radarr connectivity, and the periodic
//           sync reconciles availability independently.
export async function isMovieDownloadedInRadarr(
  tmdbId: number,
  variant: ArrVariant = "",
): Promise<boolean | null> {
  const cfg = await getArrCfg("radarr", variant);
  if (!cfg) return null;
  try {
    const movies = await arrFetch<{ tmdbId: number; hasFile: boolean }[]>(
      cfg, `/api/v3/movie?tmdbId=${tmdbId}`,
    );
    return movies.some((m) => m.tmdbId === tmdbId && m.hasFile);
  } catch (err) {
    console.warn("[arr] isMovieDownloadedInRadarr failed:", arrErrorMessage(err));
    return null;
  }
}

// Authoritative "does this series have a downloaded file" check for the Sonarr
// webhook — the series-side counterpart to isMovieDownloadedInRadarr, with the
// same purpose: confirm against Sonarr's live library so a forged Download event
// (the secret-only webhook auth means anyone holding the secret can submit an
// arbitrary payload) can't mark a series AVAILABLE that Sonarr never grabbed.
// Same tri-state contract as isMovieDownloadedInRadarr (true / false / null when
// unverifiable). Resolves the series by tvdbId (Sonarr's primary key); falls
// back to a tmdb→tvdb lookup when only tmdbId is present. The "available"
// threshold MUST match getSonarrWantedTmdbIds (the sync writer): a continuing
// series is available with any episode file, an *ended* series only once fully
// downloaded — with `episodeCount` (Sonarr's own completion denominator) as the
// target, never `totalEpisodeCount` (see the sync writer's comment). Otherwise
// an ended series at 1/N flips AVAILABLE on the webhook, and the next sync
// reverts it to APPROVED — a per-tick flip-flop.
export async function isSeriesDownloadedInSonarr(
  ids: { tvdbId?: number | null; tmdbId?: number | null },
  variant: ArrVariant = "",
): Promise<boolean | null> {
  const cfg = await getArrCfg("sonarr", variant);
  if (!cfg) return null;
  try {
    let tvdbId =
      Number.isInteger(ids.tvdbId) && (ids.tvdbId as number) > 0 ? (ids.tvdbId as number) : null;
    const claimedTmdbId =
      Number.isInteger(ids.tmdbId) && (ids.tmdbId as number) > 0 ? (ids.tmdbId as number) : null;
    if (claimedTmdbId !== null) {
      const lookup = await arrFetch<{ tvdbId: number }[]>(
        cfg, `/api/v3/series/lookup?term=tmdb:${claimedTmdbId}`,
      );
      // Sonarr's lookup response is typed but never schema-checked, so hold it to the
      // same positive-integer contract as the payload ids above. Unguarded, a
      // malformed upstream value could become `tvdbId` below, where the `===` against
      // the library rows would silently never match — reporting "not downloaded" for a
      // series Sonarr actually has, rather than the honest `null` for unverifiable.
      const rawResolved = lookup.length ? lookup[0].tvdbId : null;
      const resolved =
        Number.isInteger(rawResolved) && (rawResolved as number) > 0 ? (rawResolved as number) : null;
      if (tvdbId === null) {
        tvdbId = resolved;
      } else if (resolved !== null && resolved !== tvdbId) {
        // The payload's two ids name DIFFERENT series. This is the forgery shape the
        // webhook guard exists to catch: the caller (who holds the webhook secret)
        // supplies a tvdbId they really did download so the download check passes,
        // paired with an arbitrary tmdbId — and the Sonarr webhook's status flip keys
        // on the tmdbId, so an unrelated APPROVED request would be marked AVAILABLE,
        // its wanted row evicted, and its requester told it's ready. Verifying only
        // the tvdbId left that path unchecked. Disagreeing ids are never legitimate.
        // All three are positive integers by the guards above, so the explicit
        // Number() is a no-op at runtime — it is there to make that evident AT the
        // call site, both to a reader and to the log-injection scanner, which cannot
        // see validation that happened several lines earlier. The webhook payload is
        // attacker-shaped (secret-only auth, no schema), so a string id carrying a
        // newline would otherwise be able to forge a second "[arr] …" log entry.
        console.warn(
          "[arr] Sonarr download check: payload ids disagree (tvdbId=%s resolves tmdbId=%s to tvdbId=%s); treating as not downloaded.",
          Number(tvdbId), Number(claimedTmdbId), Number(resolved),
        );
        return false;
      }
    }
    if (tvdbId === null) return null;
    // ?tvdbId= — Sonarr's server-side filter (FindByTvdbId; statistics still
    // attached on the filtered branch in both v3 and v4). This runs on EVERY
    // Sonarr Download webhook, so an unfiltered fetch paid a full-library
    // transfer per episode of a season-pack import.
    const library = await arrFetch<{ tvdbId: number; status?: string; statistics?: { episodeFileCount: number; episodeCount: number } }[]>(
      cfg, `/api/v3/series?tvdbId=${tvdbId}`,
    );
    const match = library.find((s) => s.tvdbId === tvdbId);
    if (!match) return false;
    const episodeFileCount = match.statistics?.episodeFileCount ?? 0;
    const episodeCount = match.statistics?.episodeCount ?? 0;
    const allDownloaded = episodeFileCount >= episodeCount;
    return episodeFileCount > 0 && (match.status !== "ended" || allDownloaded);
  } catch (err) {
    console.warn("[arr] isSeriesDownloadedInSonarr failed:", arrErrorMessage(err));
    return null;
  }
}

export async function searchMovieInRadarr(tmdbId: number, variant: ArrVariant = ""): Promise<void> {
  const cfg = await getCfg("radarr", variant);
  if (!cfg) throw new Error("Radarr is not configured");
  const movies = await arrFetch<{ id: number; tmdbId: number }[]>(cfg, `/api/v3/movie?tmdbId=${tmdbId}`);
  const movie = movies.find((m) => m.tmdbId === tmdbId);
  if (!movie) throw new Error("Movie not found in Radarr library");
  await arrFetch<unknown>(cfg, "/api/v3/command", {
    method: "POST",
    body: JSON.stringify({ name: "MoviesSearch", movieIds: [movie.id] }),
  });
}

export async function getReleasesForMovie(tmdbId: number, variant: ArrVariant = ""): Promise<ArrRelease[]> {
  const cfg = await getCfg("radarr", variant);
  if (!cfg) throw new Error("Radarr is not configured");

  const movies = await arrFetch<{ id: number; tmdbId: number }[]>(cfg, `/api/v3/movie?tmdbId=${tmdbId}`);
  const movie = movies.find((m) => m.tmdbId === tmdbId);
  if (!movie) throw new Error("Movie not found in Radarr library");

  const [releases, allowedQualityIds] = await Promise.all([
    arrFetch<ArrRelease[]>(cfg, `/api/v3/release?movieId=${movie.id}`),
    getAllowedQualityIds(cfg, cfg.qualityProfileId),
  ]);

  return filterAndSortReleases(releases, allowedQualityIds);
}

export async function grabMovieRelease(tmdbId: number, guid: string, indexerId: number, variant: ArrVariant = ""): Promise<void> {
  const cfg = await getCfg("radarr", variant);
  if (!cfg) throw new Error("Radarr is not configured");

  const movies = await arrFetch<{ id: number; tmdbId: number }[]>(cfg, `/api/v3/movie?tmdbId=${tmdbId}`);
  const movie = movies.find((m) => m.tmdbId === tmdbId);
  if (!movie) throw new Error("Movie not found in Radarr library");

  await arrFetch<unknown>(cfg, "/api/v3/release", {
    method: "POST",
    body: JSON.stringify({ guid, indexerId, movieId: movie.id }),
  });
}

// Returns null when the queue could not be read AND no stale cache exists, so
// callers don't mistake a fetch failure for an empty queue (which would yield
// false "not downloading" → spurious notifies / premature scans). A successful
// read (even empty) returns a Set.
async function getRadarrQueueSet(cfg: ArrCfg): Promise<Set<number> | null> {
  const now = Date.now();
  const cacheKey = `radarr::${cfg.url}`;
  const cached = queueCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.tmdbIds;
  try {
    // The queue endpoint is paged — pageSize=200 silently dropped downloads past
    // the 200th on busy instances, giving false "not downloading" badges. Page
    // through totalRecords with a 40-page (10k-item) runaway backstop.
    const tmdbIds = new Set<number>();
    for (let page = 1; page <= 40; page++) {
      const queue = await arrFetch<{ records: { movie?: { tmdbId: number } }[]; totalRecords: number }>(
        cfg, `/api/v3/queue?page=${page}&pageSize=250&includeMovie=true`
      );
      for (const r of queue.records) {
        if (r.movie?.tmdbId) tmdbIds.add(r.movie.tmdbId);
      }
      if (queue.records.length === 0 || page * 250 >= queue.totalRecords) break;
    }
    queueCache.set(cacheKey, { tmdbIds, tvdbIds: new Set(), expiresAt: now + QUEUE_STATE_TTL_MS });
    return tmdbIds;
  } catch (err) {
    if (cached) {
      console.warn("[arr] getRadarrQueueSet failed, serving stale queue data:", err instanceof Error ? err.message : err);
      return cached.tmdbIds;
    }
    console.error("[arr] getRadarrQueueSet failed, no cache:", err instanceof Error ? err.message : err);
    return null;
  }
}

// Null = unknown (fetch failed, no stale cache) vs Set = read succeeded. See getRadarrQueueSet.
async function getSonarrQueueSet(cfg: ArrCfg): Promise<Set<number> | null> {
  const now = Date.now();
  const cacheKey = `sonarr::${cfg.url}`;
  const cached = queueCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.tvdbIds;
  try {
    // Paged endpoint — see getRadarrQueueSet. pageSize=200 dropped downloads past
    // the 200th; page through totalRecords with a runaway backstop.
    const tvdbIds = new Set<number>();
    for (let page = 1; page <= 40; page++) {
      const queue = await arrFetch<{ records: { series?: { tvdbId: number } }[]; totalRecords: number }>(
        cfg, `/api/v3/queue?page=${page}&pageSize=250&includeSeries=true`
      );
      for (const r of queue.records) {
        if (r.series?.tvdbId) tvdbIds.add(r.series.tvdbId);
      }
      if (queue.records.length === 0 || page * 250 >= queue.totalRecords) break;
    }
    queueCache.set(cacheKey, { tmdbIds: new Set(), tvdbIds, expiresAt: now + QUEUE_STATE_TTL_MS });
    return tvdbIds;
  } catch (err) {
    if (cached) {
      console.warn("[arr] getSonarrQueueSet failed, serving stale queue data:", err instanceof Error ? err.message : err);
      return cached.tvdbIds;
    }
    console.error("[arr] getSonarrQueueSet failed, no cache:", err instanceof Error ? err.message : err);
    return null;
  }
}

// Tri-state: true = in queue; false = confirmed not in queue (or no Radarr
// configured); null = couldn't determine (queue fetch failed). Callers MUST treat
// null as "still pending", not "not downloading", or a queue outage fires false
// "download pending" notifies and premature scans.
export async function isMovieDownloadingInRadarr(tmdbId: number, variant: ArrVariant = ""): Promise<boolean | null> {
  const cfg = await getCfg("radarr", variant);
  if (!cfg) return false;
  try {
    const queueSet = await getRadarrQueueSet(cfg);
    if (queueSet === null) return null;
    return queueSet.has(tmdbId);
  } catch { return null; }
}

export async function countRadarrQueue(variant: ArrVariant = ""): Promise<number | null> {
  try {
    const cfg = await getCfg("radarr", variant);
    if (!cfg) return null;
    const queueSet = await getRadarrQueueSet(cfg);
    if (queueSet === null) return null;
    return queueSet.size;
  } catch { return null; }
}

// Same tri-state contract as isMovieDownloadingInRadarr — null = unknown.
export async function isSeriesDownloadingInSonarr(tmdbId: number, variant: ArrVariant = ""): Promise<boolean | null> {
  const cfg = await getCfg("sonarr", variant);
  if (!cfg) return false;
  try {
    const lookup = await arrFetch<{ tvdbId: number }[]>(
      cfg, `/api/v3/series/lookup?term=tmdb:${tmdbId}`
    );
    if (!lookup.length) return false;
    const { tvdbId } = lookup[0];
    const queueSet = await getSonarrQueueSet(cfg);
    if (queueSet === null) return null;
    return queueSet.has(tvdbId);
  } catch { return null; }
}

export async function countSonarrQueue(variant: ArrVariant = ""): Promise<number | null> {
  try {
    const cfg = await getCfg("sonarr", variant);
    if (!cfg) return null;
    const queueSet = await getSonarrQueueSet(cfg);
    if (queueSet === null) return null;
    return queueSet.size;
  } catch { return null; }
}

export async function testRadarrConnection(url: string, apiKey: string): Promise<string> {
  const cfg = { url: url.replace(/\/$/, ""), apiKey };
  const status = await arrFetch<{ version: string; appName?: string }>(cfg, "/api/v3/system/status");
  // /system/status reports the service's own identity — a Sonarr URL pasted
  // into the Radarr field used to pass this test (both answer with a version)
  // and persist a cross-wired config. Missing appName (older builds) is
  // tolerated; a PRESENT mismatched one fails so the save rolls back.
  if (status.appName && status.appName.toLowerCase() !== "radarr") {
    throw new Error(`URL points at ${status.appName}, not Radarr`);
  }
  return status.version;
}

export async function getReleasesForSeries(
  tvdbId: number,
  scope: "FULL" | "SEASON" | "EPISODE",
  seasonNumber?: number | null,
  episodeNumber?: number | null,
  variant: ArrVariant = "",
): Promise<ArrRelease[]> {
  const cfg = await getCfg("sonarr", variant);
  if (!cfg) throw new Error("Sonarr is not configured");

  const library = await arrFetch<{ id: number; tvdbId: number }[]>(cfg, `/api/v3/series?tvdbId=${tvdbId}`);
  const series = library.find((s) => s.tvdbId === tvdbId);
  if (!series) throw new Error("Series not found in Sonarr library");

  let releasePath: string;
  if (scope === "EPISODE" && seasonNumber != null && episodeNumber != null) {
    const episodes = await arrFetch<{ id: number; seasonNumber: number; episodeNumber: number }[]>(
      cfg, `/api/v3/episode?seriesId=${series.id}`
    );
    const ep = episodes.find((e) => e.seasonNumber === seasonNumber && e.episodeNumber === episodeNumber);
    if (!ep) throw new Error(`Episode S${seasonNumber}E${episodeNumber} not found in Sonarr`);
    releasePath = `/api/v3/release?episodeId=${ep.id}`;
  } else if (scope === "SEASON" && seasonNumber != null) {
    releasePath = `/api/v3/release?seriesId=${series.id}&seasonNumber=${seasonNumber}`;
  } else {
    releasePath = `/api/v3/release?seriesId=${series.id}`;
  }

  const [releases, allowedQualityIds] = await Promise.all([
    arrFetch<ArrRelease[]>(cfg, releasePath),
    getAllowedQualityIds(cfg, cfg.qualityProfileId),
  ]);

  return filterAndSortReleases(releases, allowedQualityIds);
}

export async function grabSeriesRelease(
  tvdbId: number,
  guid: string,
  indexerId: number,
  seasonNumber?: number | null,
  episodeNumber?: number | null,
  variant: ArrVariant = "",
): Promise<void> {
  const cfg = await getCfg("sonarr", variant);
  if (!cfg) throw new Error("Sonarr is not configured");

  const library = await arrFetch<{ id: number; tvdbId: number }[]>(cfg, `/api/v3/series?tvdbId=${tvdbId}`);
  const series = library.find((s) => s.tvdbId === tvdbId);
  if (!series) throw new Error("Series not found in Sonarr library");

  let episodeId: number | undefined;
  if (seasonNumber != null && episodeNumber != null) {
    const episodes = await arrFetch<{ id: number; seasonNumber: number; episodeNumber: number }[]>(
      cfg, `/api/v3/episode?seriesId=${series.id}`
    );
    const ep = episodes.find((e) => e.seasonNumber === seasonNumber && e.episodeNumber === episodeNumber);
    if (ep) episodeId = ep.id;
  }

  await arrFetch<unknown>(cfg, "/api/v3/release", {
    method: "POST",
    body: JSON.stringify({ guid, indexerId, seriesId: series.id, ...(episodeId != null && { episodeId }) }),
  });
}

export async function addSeriesToSonarr(tmdbId: number, variant: ArrVariant = "", qualityProfileIdOverride?: number, requesterUserId?: string | null): Promise<number> {
  const cfg = await getCfg("sonarr", variant);
  if (!cfg) throw new Error(instanceLabel("Sonarr", variant) + " is not configured");

  // An explicit override (admin "approve with profile X") wins over the
  // configured default; only fetch the instance's profiles when neither is set.
  const needProfiles = !qualityProfileIdOverride && !cfg.qualityProfileId;
  const [results, rootFolders, profiles] = await Promise.all([
    arrFetch<{ title: string; tvdbId: number; tmdbId?: number; year: number; images: object[]; titleSlug: string; seasons: { seasonNumber: number; monitored: boolean }[]; firstAired?: string; status?: string }[]>(
      cfg, `/api/v3/series/lookup?term=tmdb:${tmdbId}`
    ),
    cfg.rootFolder
      ? Promise.resolve<{ path: string }[]>([])
      : arrFetch<{ path: string }[]>(cfg, "/api/v3/rootfolder"),
    needProfiles
      ? arrFetch<{ id: number }[]>(cfg, "/api/v3/qualityprofile")
      : Promise.resolve<{ id: number }[]>([]),
  ]);

  if (!results.length) throw new Error(`Sonarr: no series found for tmdbId ${tmdbId}`);
  if (!cfg.rootFolder && !rootFolders.length) throw new Error("Sonarr: no root folders configured");
  if (needProfiles && !profiles.length) throw new Error("Sonarr: no quality profiles configured");

  // Same fuzzy-title-search hazard as the Radarr add: an unmapped tmdb id makes
  // Sonarr fall back to a SkyHook title search, so results[0] can be an unrelated
  // show — which would be added to the library AND returned as this request's
  // tvdbId, so the webhook later marks the wrong download AVAILABLE. Prefer the
  // row whose tmdbId matches; accept [0] only when the lookup returned exactly
  // one candidate (what a recognized id lookup always yields).
  const series = results.find((s) => s.tmdbId === tmdbId) ?? (results.length === 1 ? results[0] : undefined);
  if (!series) throw new Error(`Sonarr: lookup for tmdbId ${tmdbId} returned no matching series`);
  // firstAired is authoritative; without it, Sonarr's own status ("upcoming"
  // vs continuing/ended) beats the year heuristic, which read every
  // current-year show as unaired and skipped the add-time search.
  const seriesReleased = series.firstAired
    ? new Date(series.firstAired) <= new Date()
    : (series.status ? series.status !== "upcoming" : series.year < new Date().getFullYear());

  const rootFolderPath = cfg.rootFolder ?? rootFolders[0].path;
  const qualityProfileId = qualityProfileIdOverride ?? cfg.qualityProfileId ?? profiles[0].id;
  const tagIds = await resolveRequesterTagIds(cfg, requesterUserId);

  // Explicit allowlist of POST body fields — previous code spread the entire
  // lookup row (~30 fields, untyped) which silently forwarded whatever Sonarr
  // returned, exposing us to a future Sonarr API tightening that rejects
  // unexpected fields on add. `pathOverride` is set only on the collision-retry.
  const postSeries = (pathOverride?: string) =>
    arrFetch<unknown>(cfg, "/api/v3/series", {
      method: "POST",
      body: JSON.stringify({
        tvdbId: series.tvdbId,
        title: series.title,
        year: series.year,
        titleSlug: series.titleSlug,
        images: series.images,
        seasons: series.seasons.map((s) => ({ ...s, monitored: s.seasonNumber > 0 })),
        rootFolderPath,
        ...(pathOverride ? { path: pathOverride } : {}),
        qualityProfileId,
        // Sonarr v3 only (v4 removed language profiles and its settings UI never
        // offers one) — omitted when unconfigured, byte-identical to old adds.
        ...(cfg.languageProfileId ? { languageProfileId: cfg.languageProfileId } : {}),
        ...(tagIds.length ? { tags: tagIds } : {}),
        monitored: true,
        addOptions: { searchForMissingEpisodes: seriesReleased },
      }),
    });

  // Sonarr twin of the Radarr duplicate remediation above: an existing
  // UNMONITORED entry is never auto-grabbed, so re-monitor (regular seasons
  // only, matching the add path) + search, degrading to warn-and-skip on any
  // failure.
  const remediateExistingSeries = async () => {
    try {
      const existing = await arrFetch<Array<{ id: number; tvdbId: number; monitored: boolean; seasons?: { seasonNumber: number; monitored: boolean }[] } & Record<string, unknown>>>(
        cfg, `/api/v3/series?tvdbId=${series.tvdbId}`,
      );
      const row = existing.find((s) => s.tvdbId === series.tvdbId);
      if (!row || row.monitored) return;
      await arrFetch<unknown>(cfg, `/api/v3/series/${row.id}`, {
        method: "PUT",
        body: JSON.stringify({
          ...row,
          monitored: true,
          seasons: (row.seasons ?? []).map((s) => ({ ...s, monitored: s.seasonNumber > 0 })),
        }),
      });
      if (seriesReleased) {
        await arrFetch<unknown>(cfg, "/api/v3/command", {
          method: "POST",
          body: JSON.stringify({ name: "SeriesSearch", seriesId: row.id }),
        });
      }
    } catch (remErr) {
      console.warn("[arr] existing-series re-monitor failed (leaving as-is):", arrErrorMessage(remErr));
    }
  };

  try {
    await postSeries();
  } catch (err) {
    if (isDuplicate(err)) {
      console.warn("[arr] series already in Sonarr — re-checking its monitored state", { tmdbId });
      await remediateExistingSeries();
    } else {
      // A *different* series (different tvdbId) already occupies the folder this
      // title would use. Retry once with a tvdbId-tagged path — mirrors Sonarr's
      // own `{tvdb-<id>}` folder token — so distinct same-title shows coexist.
      const collidedPath = pathCollisionTarget(err);
      if (!collidedPath) throw err;
      try {
        await postSeries(`${collidedPath} {tvdb-${series.tvdbId}}`);
      } catch (retryErr) {
        if (isDuplicate(retryErr)) {
          console.warn("[arr] series already in Sonarr — re-checking its monitored state", { tmdbId });
          await remediateExistingSeries();
        } else {
          throw retryErr;
        }
      }
    }
  }

  return series.tvdbId;
}

export async function searchSeriesInSonarr(tvdbId: number, variant: ArrVariant = ""): Promise<void> {
  const cfg = await getCfg("sonarr", variant);
  if (!cfg) throw new Error("Sonarr is not configured");
  const library = await arrFetch<{ id: number; tvdbId: number }[]>(cfg, `/api/v3/series?tvdbId=${tvdbId}`);
  const series = library.find((s) => s.tvdbId === tvdbId);
  if (!series) throw new Error("Series not found in Sonarr library");
  await arrFetch<unknown>(cfg, "/api/v3/command", {
    method: "POST",
    body: JSON.stringify({ name: "SeriesSearch", seriesId: series.id }),
  });
}

export async function searchSeasonInSonarr(tvdbId: number, seasonNumber: number, variant: ArrVariant = ""): Promise<void> {
  const cfg = await getCfg("sonarr", variant);
  if (!cfg) throw new Error("Sonarr is not configured");
  const library = await arrFetch<{ id: number; tvdbId: number }[]>(cfg, `/api/v3/series?tvdbId=${tvdbId}`);
  const series = library.find((s) => s.tvdbId === tvdbId);
  if (!series) throw new Error("Series not found in Sonarr library");
  await arrFetch<unknown>(cfg, "/api/v3/command", {
    method: "POST",
    body: JSON.stringify({ name: "SeasonSearch", seriesId: series.id, seasonNumber }),
  });
}

export async function searchEpisodeInSonarr(tvdbId: number, seasonNumber: number, episodeNumber: number, variant: ArrVariant = ""): Promise<void> {
  const cfg = await getCfg("sonarr", variant);
  if (!cfg) throw new Error("Sonarr is not configured");
  const library = await arrFetch<{ id: number; tvdbId: number }[]>(cfg, `/api/v3/series?tvdbId=${tvdbId}`);
  const series = library.find((s) => s.tvdbId === tvdbId);
  if (!series) throw new Error("Series not found in Sonarr library");
  const episodes = await arrFetch<{ id: number; seasonNumber: number; episodeNumber: number }[]>(
    cfg, `/api/v3/episode?seriesId=${series.id}`
  );
  const episode = episodes.find(
    (e) => e.seasonNumber === seasonNumber && e.episodeNumber === episodeNumber
  );
  if (!episode) throw new Error(`Episode S${seasonNumber}E${episodeNumber} not found in Sonarr`);
  await arrFetch<unknown>(cfg, "/api/v3/command", {
    method: "POST",
    body: JSON.stringify({ name: "EpisodeSearch", episodeIds: [episode.id] }),
  });
}

export async function resolveTvdbIdFromTmdbId(tmdbId: number, variant: ArrVariant = ""): Promise<number | null> {
  const cfg = await getCfg("sonarr", variant);
  if (!cfg) return null;
  try {
    const library = await arrFetch<{ tvdbId: number; tmdbId?: number }[]>(cfg, "/api/v3/series");
    const libMatch = library.find((s) => s.tmdbId === tmdbId);
    if (libMatch) return libMatch.tvdbId;
    const results = await arrFetch<{ tvdbId: number }[]>(cfg, `/api/v3/series/lookup?term=tmdb:${tmdbId}`);
    return results[0]?.tvdbId ?? null;
  } catch {
    return null;
  }
}

export async function testSonarrConnection(url: string, apiKey: string): Promise<string> {
  const cfg = { url: url.replace(/\/$/, ""), apiKey };
  const status = await arrFetch<{ version: string; appName?: string }>(cfg, "/api/v3/system/status");
  // Identity check — see testRadarrConnection.
  if (status.appName && status.appName.toLowerCase() !== "sonarr") {
    throw new Error(`URL points at ${status.appName}, not Sonarr`);
  }
  return status.version;
}
