// Interactive release search and grab — the request "Pick release", the issue
// Replace and the admin title manager. Every release list is projected through
// toArrRelease (guardrail 5e) and every grab goes through postReleaseGrab.
// Re-exported by arr.ts.
import { arrErrorMessage, arrFetch, ArrResponseError, asRecord, unusableAnswer, type ArrCfg } from "./arr-client";
import { requireArrCfg, type ArrVariant } from "./arr-config";
import { findEpisodeId, requireRadarrMovie, requireSonarrSeries } from "./arr-lookup";
import { forgetWarnOnChange, warnOnChange } from "./log-dedup";
import { int, languageNamesOf, namesOf, protocolOf } from "./arr-parse";
import { seriesReleaseScopeSearchable } from "./release-scope";
import { check, v } from "./validate";

// A Sonarr season search across many indexers routinely outlasts 30s; cut off,
// the admin saw a failure while the arr kept searching. EVERY interactive
// release read uses it — the request "Pick release" and the issue Replace too,
// not only the title manager's.
export const RELEASE_SEARCH_TIMEOUT_MS = 120_000;
// A grab (POST /api/v3/release) answers only after the arr has fetched the
// .torrent/.nzb from the indexer — often through Prowlarr or FlareSolverr — and
// handed it to the download client. Cut at the 30 s default, the admin was told
// the grab failed (and its handle was spent, nothing audited) while the arr
// finished it.
export const RELEASE_GRAB_TIMEOUT_MS = 120_000;

const QUALITY_PROFILE_TTL_MS = 10 * 60 * 1000;
const qualityProfileCache = new Map<string, { ids: Set<number> | null; expiresAt: number }>();

/**
 * The arr refusing the grab POST ITSELF (release-grab.ts reads its 404 as
 * "search again" and its 409 as the indexer or client refusing) — never a
 * lookup made before it: a 404 from `/api/v3/movie?tmdbId=` is not an expired
 * search cache. A subclass, so every `instanceof ArrResponseError` still holds.
 */
export class ArrReleaseGrabError extends ArrResponseError {}

/**
 * Whether a grab reached the point of sending POST /api/v3/release. The grab
 * helpers set `sent` on the line before they call postReleaseGrab, so a route
 * holding a claimed release handle can tell a failure BEFORE the grab (the
 * title lookup, a missing config — nothing reached the arr, the handle goes
 * back) from one during it (the outcome may be unknown — release-grab.ts).
 */
export interface GrabProgress {
  sent: boolean;
}

/**
 * POST /api/v3/release — the ONE way a release is grabbed (request Pick
 * release, issue Replace, the title manager), with the grab's own timeout.
 */
export async function postReleaseGrab(cfg: ArrCfg, body: Record<string, unknown>): Promise<void> {
  try {
    await arrFetch<unknown>(cfg, "/api/v3/release", { method: "POST", body: JSON.stringify(body), timeoutMs: RELEASE_GRAB_TIMEOUT_MS });
  } catch (err) {
    if (err instanceof ArrResponseError) throw new ArrReleaseGrabError(err.status, err.body);
    throw err;
  }
}

export interface ArrRelease {
  guid: string;
  title: string;
  size: number;
  indexerId: number;
  indexer: string;
  quality: { quality: { id: number; name: string }; revision: { version: number } };
  qualityWeight: number;
  /** The arr's own ranking of this release for the title (0 = what it would grab first); null on arrs that don't send it. */
  releaseWeight: number | null;
  customFormatScore: number | null;
  /** Custom format and language NAMES only. */
  customFormats: string[];
  languages: string[];
  protocol: "torrent" | "usenet";
  seeders: number | null;
  leechers: number | null;
  age: number;
  rejected: boolean;
  rejections: string[];
  downloadAllowed: boolean;
}

// What a release must carry to be offered at all: the grab names guid and
// indexerId, the profile split and the sort read the quality id. The rest is
// read leniently below — a display field the arr left out never hides a release.
const ReleaseCore = v.object({
  guid: v.string(),
  indexerId: v.int(),
  downloadAllowed: v.boolean(),
  quality: v.object({
    quality: v.object({ id: v.int(), name: v.optional(v.nullable(v.string())) }),
    revision: v.optional(v.nullable(v.object({ version: v.optional(v.nullable(v.int())) }))),
  }),
});

const finiteOr = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const finiteOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const MAX_REJECTIONS = 50;
function rejectionsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (let i = 0; i < value.length && out.length < MAX_REJECTIONS; i++) {
    if (typeof value[i] === "string") out.push(value[i] as string);
  }
  return out;
}

/**
 * One upstream ReleaseResource projected to EXACTLY the `ArrRelease` field list,
 * or null when it lacks what a grab needs. The JSON Radarr and Sonarr return
 * carries every ReleaseResource field, including `downloadUrl` / `infoUrl` /
 * `magnetUrl`, and Newznab/Torznab download URLs embed the admin's indexer
 * `apikey=…`. The releases route hands this list to any MANAGE_ISSUES holder (an
 * ISSUE_ADMIN without the ADMIN bit), so the projection lives HERE, where every
 * release search returns through it and no caller can forget it. Nested
 * `quality` is projected too, so the shape is literally the interface. The
 * newer fields (Radarr v4+/Sonarr v4) are read defensively: older builds omit
 * them or send one `language` object (Sonarr v3).
 */
export function toArrRelease(raw: unknown): ArrRelease | null {
  const row = asRecord(raw);
  const core = check(ReleaseCore, raw);
  if (!row || !core.ok) return null;
  const { guid, indexerId, downloadAllowed, quality } = core.value;
  return {
    guid,
    title: typeof row.title === "string" ? row.title : "",
    size: finiteOr(row.size, 0),
    indexerId,
    indexer: typeof row.indexer === "string" ? row.indexer : "",
    quality: {
      quality: { id: quality.quality.id, name: quality.quality.name ?? "" },
      revision: { version: quality.revision?.version ?? 1 },
    },
    qualityWeight: finiteOr(row.qualityWeight, 0),
    releaseWeight: int(row.releaseWeight),
    customFormatScore: int(row.customFormatScore),
    customFormats: namesOf(row.customFormats),
    languages: languageNamesOf(row),
    // The documented wire enum (the iOS app decodes it): anything but a torrent
    // is shown as usenet, which is what every client already did.
    protocol: protocolOf(row.protocol) === "torrent" ? "torrent" : "usenet",
    seeders: finiteOrNull(row.seeders),
    leechers: finiteOrNull(row.leechers),
    age: finiteOr(row.age, 0),
    rejected: row.rejected === true,
    rejections: rejectionsOf(row.rejections),
    downloadAllowed,
  };
}

// The quality ids a profile allows: a group's allowed members, else the item's
// own quality. null when the profile isn't in the list or carries no items (an
// answer, cached), "unusable" when the answer isn't one (not cached).
function allowedQualityIdsOf(rawProfiles: unknown, profileId: number): Set<number> | null | "unusable" {
  if (!Array.isArray(rawProfiles)) return "unusable";
  const profile = rawProfiles.map(asRecord).find((p) => p?.id === profileId);
  if (!profile || !Array.isArray(profile.items)) return null;
  const ids = new Set<number>();
  for (const item of profile.items.map(asRecord)) {
    if (!item || item.allowed !== true) continue;
    if (Array.isArray(item.items) && item.items.length > 0) {
      for (const sub of item.items.map(asRecord)) {
        const id = sub?.allowed === true ? int(asRecord(sub.quality)?.id) : null;
        if (id !== null) ids.add(id);
      }
    } else {
      const id = int(asRecord(item.quality)?.id);
      if (id !== null) ids.add(id);
    }
  }
  return ids;
}

async function getAllowedQualityIds(cfg: ArrCfg, profileId?: number): Promise<Set<number> | null> {
  if (!profileId) return null;
  const cacheKey = `${cfg.url}::${profileId}`;
  const now = Date.now();
  const cached = qualityProfileCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.ids;
  const logKey = `releases:qualityprofile:${cfg.url}`;
  try {
    const ids = allowedQualityIdsOf(await arrFetch<unknown>(cfg, "/api/v3/qualityprofile"), profileId);
    if (ids === "unusable") {
      warnOnChange(logKey, "unusable", "[arr] quality profile list was unusable; releases keep the arr's own order");
      return null;
    }
    forgetWarnOnChange(logKey);
    qualityProfileCache.set(cacheKey, { ids, expiresAt: now + QUALITY_PROFILE_TTL_MS });
    return ids;
  } catch (err) {
    // The split only orders the list: a failed read costs the profile-match
    // ordering, not the search. One line per unchanged condition (guardrail 7b).
    const error = arrErrorMessage(err);
    warnOnChange(logKey, error, `[arr] quality profile read failed; releases keep the arr's own order: ${error}`);
    return null;
  }
}

/**
 * Releases the arr would let us grab, in the arr's OWN order. Radarr/Sonarr
 * answer an interactive search already prioritised for the title — quality
 * against the title's profile, custom-format score, protocol, size, age — and
 * number that order in `releaseWeight`. `qualityWeight` is NOT a substitute:
 * the arr computes it against its DEFAULT profile, not the title's, and it
 * knows nothing of custom formats, so sorting on it put releases the arr would
 * rank last (a low-score WEB-DL tied on quality) at the top, pre-selected.
 * Releases whose quality the TITLE's own profile doesn't allow still go last
 * (`allowedIds` comes from the movie/series row's own qualityProfileId, never
 * the instance's add default; null = no split, the arr's own order); arrs too
 * old to send releaseWeight keep the old quality/seeders order.
 */
function filterAndSortReleases(releases: readonly unknown[], allowedIds: Set<number> | null): ArrRelease[] {
  const downloadable: ArrRelease[] = [];
  for (const raw of releases) {
    const release = toArrRelease(raw);
    if (release?.downloadAllowed) downloadable.push(release);
  }
  return downloadable.sort((a, b) => {
    const aMatch = allowedIds ? (allowedIds.has(a.quality.quality.id) ? 1 : 0) : 1;
    const bMatch = allowedIds ? (allowedIds.has(b.quality.quality.id) ? 1 : 0) : 1;
    if (bMatch !== aMatch) return bMatch - aMatch;
    // The arr's own order first; a release without one sorts after every release with one.
    if (a.releaseWeight !== b.releaseWeight) {
      if (a.releaseWeight === null) return 1;
      if (b.releaseWeight === null) return -1;
      return a.releaseWeight - b.releaseWeight;
    }
    if (b.qualityWeight !== a.qualityWeight) return b.qualityWeight - a.qualityWeight;
    return (b.seeders ?? 0) - (a.seeders ?? 0);
  });
}

// The ONE interactive release read: every /api/v3/release query waits on the
// instance's indexers, so every one gets RELEASE_SEARCH_TIMEOUT_MS. The quality
// profile split runs beside it.
async function readReleases(cfg: ArrCfg, path: string, profileId: number | undefined): Promise<{ raw: unknown; allowedIds: Set<number> | null }> {
  const [raw, allowedIds] = await Promise.all([
    arrFetch<unknown>(cfg, path, { timeoutMs: RELEASE_SEARCH_TIMEOUT_MS }),
    getAllowedQualityIds(cfg, profileId),
  ]);
  return { raw, allowedIds };
}

// A request's or an issue's release list: an answer that isn't a list throws,
// as it always did.
async function titleReleases(cfg: ArrCfg, service: "Radarr" | "Sonarr", path: string, profileId: number | undefined): Promise<ArrRelease[]> {
  const { raw, allowedIds } = await readReleases(cfg, path, profileId);
  if (!Array.isArray(raw)) throw unusableAnswer(service, "release list");
  return filterAndSortReleases(raw, allowedIds);
}

export async function getReleasesForMovie(tmdbId: number, variant: ArrVariant = ""): Promise<ArrRelease[]> {
  const cfg = await requireArrCfg("radarr", variant);
  const movie = await requireRadarrMovie(cfg, tmdbId);
  // The split is by the MOVIE's own profile (read off its row), never
  // cfg.qualityProfileId — that is the instance's ADD default, and a title
  // approved with an override or re-profiled since differs from it.
  return titleReleases(cfg, "Radarr", `/api/v3/release?movieId=${movie.id}`, movie.qualityProfileId);
}

// Interactive search by the arr's OWN ids — the admin title manager already
// holds the movie/series/episode id, so nothing is re-resolved. `query` is the
// /api/v3/release query (movieId=, seriesId=&seasonNumber=, episodeId=);
// releases matching the title's own quality profile sort first. An answer that
// isn't a list reads as no releases.
export async function searchReleasesByArrId(cfg: ArrCfg, query: string, qualityProfileId?: number | null): Promise<ArrRelease[]> {
  const { raw, allowedIds } = await readReleases(cfg, `/api/v3/release?${query}`, qualityProfileId ?? undefined);
  return filterAndSortReleases(Array.isArray(raw) ? raw : [], allowedIds);
}

export async function grabMovieRelease(tmdbId: number, guid: string, indexerId: number, variant: ArrVariant = "", progress?: GrabProgress): Promise<void> {
  const cfg = await requireArrCfg("radarr", variant);
  const movie = await requireRadarrMovie(cfg, tmdbId);
  if (progress) progress.sent = true;
  await postReleaseGrab(cfg, { guid, indexerId, movieId: movie.id });
}

/**
 * A Sonarr release search needs a season or an episode: `/api/v3/release`
 * with only `seriesId` answers with the indexers' RSS FEED — other shows'
 * episodes, some of them grabbable — not a search for this series. Thrown
 * before any release call for a whole-series (FULL) scope, or a season or
 * episode scope missing its numbers.
 */
export class ReleaseSeasonRequiredError extends Error {}

export async function getReleasesForSeries(
  tvdbId: number,
  scope: "FULL" | "SEASON" | "EPISODE",
  seasonNumber?: number | null,
  episodeNumber?: number | null,
  variant: ArrVariant = "",
): Promise<ArrRelease[]> {
  if (!seriesReleaseScopeSearchable(scope, seasonNumber, episodeNumber)) {
    throw new ReleaseSeasonRequiredError("a Sonarr release search needs a season or an episode");
  }
  const cfg = await requireArrCfg("sonarr", variant);
  const series = await requireSonarrSeries(cfg, tvdbId);
  const releasePath = scope === "EPISODE" && seasonNumber != null && episodeNumber != null
    ? `/api/v3/release?episodeId=${await findEpisodeId(cfg, series.id, seasonNumber, episodeNumber)}`
    // SEASON with its number (checked above). Never a series-only query — the RSS feed.
    : `/api/v3/release?seriesId=${series.id}&seasonNumber=${seasonNumber}`;
  // The SERIES' own profile, as for a movie above — never the add default.
  return titleReleases(cfg, "Sonarr", releasePath, series.qualityProfileId);
}

export async function grabSeriesRelease(
  tvdbId: number,
  guid: string,
  indexerId: number,
  seasonNumber?: number | null,
  episodeNumber?: number | null,
  variant: ArrVariant = "",
  progress?: GrabProgress,
): Promise<void> {
  const cfg = await requireArrCfg("sonarr", variant);
  const series = await requireSonarrSeries(cfg, tvdbId);
  // An episode grab names its episode; one Sonarr no longer lists fails here,
  // before anything is sent, exactly as the episode's release search does.
  const episodeId = seasonNumber != null && episodeNumber != null
    ? await findEpisodeId(cfg, series.id, seasonNumber, episodeNumber)
    : undefined;
  if (progress) progress.sent = true;
  await postReleaseGrab(cfg, { guid, indexerId, seriesId: series.id, ...(episodeId != null && { episodeId }) });
}
