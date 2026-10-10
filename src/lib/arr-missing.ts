// Admin → Missing: the pure rules. Which Radarr/Sonarr entries are MISSING
// something they should already have, judged from one /api/v3/movie or
// /api/v3/series row (and, for a series' episode list, /api/v3/episode rows).
// Zero I/O; the data half is arr-missing-data.ts.
//
//   • A MOVIE is missing when it has no file and its PHYSICAL or DIGITAL release
//     date is in the past. A movie that is only in cinemas (or has no home
//     release date yet) is expected to be missing and is never listed.
//   • A SERIES is missing when at least one AIRED, MONITORED, REGULAR-SEASON
//     episode has no file. The counts come from the same per-season statistics
//     sonarrSeriesCompletion reads (guardrail 14a) — Sonarr's `episodeCount` is
//     already "(monitored AND aired) OR has-file", so a continuing show's unaired
//     episodes never count, and specials are excluded. A series that has not
//     aired anything yet is not missing.
//
// `monitored` is reported, never filtered on: an unmonitored title is missing
// for a different reason (nothing is searching for it), and the page decides
// whether to show it.
import { sonarrSeriesCompletion, type SonarrSeriesStatsRow } from "./sonarr-completion";

const posInt = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);
const count = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** A parseable timestamp as epoch ms, or null. Radarr/Sonarr send ISO strings. */
export function arrDateMs(v: unknown): number | null {
  if (typeof v !== "string" || v === "") return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

const DAY_MS = 86_400_000;
const daysSince = (ms: number, nowMs: number): number => Math.max(0, Math.floor((nowMs - ms) / DAY_MS));

type ArrImage = { coverType?: unknown; remoteUrl?: unknown };

// Radarr's poster remoteUrl points at TMDB ("https://image.tmdb.org/t/p/original/abc.jpg").
// Only that host is allowed by the CSP's img-src, so only its path is kept — the
// page rebuilds the URL at a sane size with posterUrl(). Sonarr's posters come
// from TheTVDB and never match.
const TMDB_IMAGE = /^https:\/\/image\.tmdb\.org\/t\/p\/[^/]+(\/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp))$/i;
export function tmdbPosterPathFromImages(images: unknown): string | null {
  if (!Array.isArray(images)) return null;
  for (const img of images as ArrImage[]) {
    if (img?.coverType !== "poster" || typeof img.remoteUrl !== "string") continue;
    const m = TMDB_IMAGE.exec(img.remoteUrl);
    if (m) return m[1];
  }
  return null;
}

// ── movies ───────────────────────────────────────────────────────────────────

export type RadarrMovieRow = {
  id?: unknown;
  tmdbId?: unknown;
  title?: unknown;
  year?: unknown;
  monitored?: unknown;
  hasFile?: unknown;
  inCinemas?: unknown;
  physicalRelease?: unknown;
  digitalRelease?: unknown;
  images?: unknown;
};

export interface MissingMovie {
  instance: string;
  arrId: number;
  tmdbId: number | null;
  title: string;
  year: number | null;
  monitored: boolean;
  posterPath: string | null;
  inCinemas: string | null;
  physicalRelease: string | null;
  digitalRelease: string | null;
  /** The earlier of the physical/digital release dates that are in the past. */
  releasedAt: string;
  /** Whole days since `releasedAt`, computed server-side (guardrail 16). */
  daysMissing: number;
}

export function missingMovie(row: RadarrMovieRow, instance: string, nowMs: number): MissingMovie | null {
  const arrId = posInt(row.id);
  if (arrId === null || row.hasFile === true) return null;
  const physical = arrDateMs(row.physicalRelease);
  const digital = arrDateMs(row.digitalRelease);
  const past = [physical, digital].filter((ms): ms is number => ms !== null && ms <= nowMs);
  if (past.length === 0) return null;
  const releasedMs = Math.min(...past);
  return {
    instance,
    arrId,
    tmdbId: posInt(row.tmdbId),
    title: str(row.title),
    year: posInt(row.year),
    monitored: row.monitored === true,
    posterPath: tmdbPosterPathFromImages(row.images),
    inCinemas: iso(arrDateMs(row.inCinemas)),
    physicalRelease: iso(physical),
    digitalRelease: iso(digital),
    releasedAt: new Date(releasedMs).toISOString(),
    daysMissing: daysSince(releasedMs, nowMs),
  };
}

// ── series ───────────────────────────────────────────────────────────────────

type SonarrSeasonStats = {
  episodeFileCount?: unknown;
  episodeCount?: unknown;
  previousAiring?: unknown;
};

export type SonarrSeriesRow = {
  id?: unknown;
  tmdbId?: unknown;
  tvdbId?: unknown;
  title?: unknown;
  year?: unknown;
  status?: unknown;
  monitored?: unknown;
  previousAiring?: unknown;
  lastAired?: unknown;
  statistics?: unknown;
  seasons?: unknown;
};

export interface MissingSeason {
  seasonNumber: number;
  /** Aired, monitored episodes in the season without a file. */
  missing: number;
  /** Aired, monitored episodes in the season (plus any with a file). */
  aired: number;
  lastAired: string | null;
}

export interface MissingSeries {
  instance: string;
  arrId: number;
  tmdbId: number | null;
  tvdbId: number | null;
  title: string;
  year: number | null;
  monitored: boolean;
  status: string | null;
  posterPath: string | null;
  missing: number;
  aired: number;
  lastAired: string | null;
  /** Regular seasons with something missing; empty when Sonarr sent no per-season stats. */
  seasons: MissingSeason[];
}

export function missingSeries(row: SonarrSeriesRow, instance: string): MissingSeries | null {
  const arrId = posInt(row.id);
  if (arrId === null) return null;
  // The ONE completion rule (guardrail 14a) — a series it calls complete, or one
  // with nothing aired yet, has nothing missing.
  const completion = sonarrSeriesCompletion(row as SonarrSeriesStatsRow);
  const missing = Math.max(0, completion.episodeCount - completion.episodeFileCount);
  if (missing === 0) return null;
  const seasons: MissingSeason[] = [];
  if (completion.basis === "seasons" && Array.isArray(row.seasons)) {
    for (const s of row.seasons as Array<{ seasonNumber?: unknown; statistics?: SonarrSeasonStats | null }>) {
      const seasonNumber = posInt(s?.seasonNumber);
      const stats = s?.statistics;
      if (seasonNumber === null || stats == null || typeof stats !== "object") continue;
      const aired = count(stats.episodeCount);
      const m = Math.max(0, aired - count(stats.episodeFileCount));
      if (m === 0) continue;
      seasons.push({ seasonNumber, missing: m, aired, lastAired: iso(arrDateMs(stats.previousAiring)) });
    }
    seasons.sort((a, b) => a.seasonNumber - b.seasonNumber);
  }
  return {
    instance,
    arrId,
    tmdbId: posInt(row.tmdbId),
    tvdbId: posInt(row.tvdbId),
    title: str(row.title),
    year: posInt(row.year),
    monitored: row.monitored === true,
    status: typeof row.status === "string" && row.status !== "" ? row.status : null,
    posterPath: null,
    missing,
    aired: completion.episodeCount,
    lastAired: iso(arrDateMs(row.previousAiring) ?? arrDateMs(row.lastAired)),
    seasons,
  };
}

// ── episodes (one series, on demand) ─────────────────────────────────────────

export type SonarrEpisodeRow = {
  id?: unknown;
  seasonNumber?: unknown;
  episodeNumber?: unknown;
  title?: unknown;
  airDateUtc?: unknown;
  hasFile?: unknown;
  monitored?: unknown;
};

export interface MissingEpisode {
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  airDateUtc: string;
}

// The same set the series counts describe: regular season, monitored, aired,
// no file. An episode with no air date has not aired. Returns the parsed
// numbers, or null for an episode that is not missing.
function missingEpisodeParts(r: SonarrEpisodeRow, nowMs: number): { seasonNumber: number; episodeNumber: number; aired: number } | null {
  const seasonNumber = posInt(r?.seasonNumber);
  const episodeNumber = typeof r?.episodeNumber === "number" && Number.isInteger(r.episodeNumber) && r.episodeNumber >= 0 ? r.episodeNumber : null;
  const aired = arrDateMs(r?.airDateUtc);
  if (seasonNumber === null || episodeNumber === null || aired === null || aired > nowMs) return null;
  if (r.monitored !== true || r.hasFile === true) return null;
  return { seasonNumber, episodeNumber, aired };
}

export function missingEpisodes(rows: readonly SonarrEpisodeRow[], nowMs: number): MissingEpisode[] {
  const out: MissingEpisode[] = [];
  for (const r of rows) {
    const m = missingEpisodeParts(r, nowMs);
    if (m) out.push({ seasonNumber: m.seasonNumber, episodeNumber: m.episodeNumber, title: str(r.title), airDateUtc: new Date(m.aired).toISOString() });
  }
  return out.sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
}

// ── search (one series, on demand) ───────────────────────────────────────────

export interface SeriesSearchPlan {
  /** Seasons to search whole (Sonarr `SeasonSearch`): two or more missing, no file in the season. */
  seasons: number[];
  /** Every other missing episode, searched individually (Sonarr `EpisodeSearch`). */
  episodeIds: number[];
}

// What the Missing page's Search button asks Sonarr for: exactly the missing
// episodes, never the rest. A season with no file at all is searched as a season
// — that is what finds a season pack, and with nothing on disk there is nothing
// an upgrade hunt could touch. Anywhere a file already exists (or only one
// episode is missing) the missing episodes are searched one by one, so a
// season or series search never goes looking for upgrades the admin didn't ask
// for — the reason SeriesSearch is never used here.
export function planSeriesSearch(rows: readonly SonarrEpisodeRow[], nowMs: number): SeriesSearchPlan {
  const missingBySeason = new Map<number, number[]>();
  const seasonsWithFile = new Set<number>();
  for (const r of rows) {
    const season = posInt(r?.seasonNumber);
    if (season !== null && r.hasFile === true) seasonsWithFile.add(season);
    const m = missingEpisodeParts(r, nowMs);
    const id = posInt(r?.id);
    if (!m || id === null) continue;
    const list = missingBySeason.get(m.seasonNumber);
    if (list) list.push(id);
    else missingBySeason.set(m.seasonNumber, [id]);
  }
  const plan: SeriesSearchPlan = { seasons: [], episodeIds: [] };
  for (const season of [...missingBySeason.keys()].sort((a, b) => a - b)) {
    const ids = missingBySeason.get(season)!;
    if (ids.length > 1 && !seasonsWithFile.has(season)) plan.seasons.push(season);
    else plan.episodeIds.push(...ids);
  }
  return plan;
}

// ── cutoff unmet ─────────────────────────────────────────────────────────────
//
// The Missing page's second mode: titles that HAVE a file, but one below the
// quality profile's cutoff — what Radarr/Sonarr would replace given the chance.
// The listing is Radarr/Sonarr's own /api/v3/wanted/cutoff (monitored titles
// only, as the arr UI shows it); the verdict per file is the arr's own
// `qualityCutoffNotMet`, never a quality comparison of ours — cutoff also
// weighs custom-format scores we would have to re-implement to agree with it.

export interface QualityProfileInfo {
  name: string;
  /** The quality (or quality group) the profile stops upgrading at. */
  cutoff: string | null;
}

type ProfileItem = { id?: unknown; name?: unknown; quality?: { id?: unknown; name?: unknown } | null; items?: unknown };

function cutoffName(items: unknown, cutoff: unknown): string | null {
  if (!Array.isArray(items) || typeof cutoff !== "number") return null;
  for (const it of items as ProfileItem[]) {
    if (!it || typeof it !== "object") continue;
    // A quality GROUP carries its own id and name; a single quality is keyed by its quality id.
    if (Array.isArray(it.items) && it.items.length > 0 && it.id === cutoff) return str(it.name) || null;
    if (it.quality && it.quality.id === cutoff) return str(it.quality.name) || null;
  }
  return null;
}

/** /api/v3/qualityprofile → profile id → its name and cutoff label. */
export function qualityProfileInfo(raw: unknown): Map<number, QualityProfileInfo> {
  const out = new Map<number, QualityProfileInfo>();
  if (!Array.isArray(raw)) return out;
  for (const p of raw as Array<{ id?: unknown; name?: unknown; cutoff?: unknown; items?: unknown } | null>) {
    const id = posInt(p?.id);
    if (id === null || !p) continue;
    out.set(id, { name: str(p.name), cutoff: cutoffName(p.items, p.cutoff) });
  }
  return out;
}

const qualityName = (file: unknown): string | null => {
  const q = file && typeof file === "object" ? (file as { quality?: { quality?: { name?: unknown } | null } | null }).quality : null;
  const name = q?.quality?.name;
  return typeof name === "string" && name !== "" ? name.slice(0, 100) : null;
};

export type RadarrCutoffRow = RadarrMovieRow & { qualityProfileId?: unknown; movieFile?: unknown };

export interface CutoffMovie {
  instance: string;
  arrId: number;
  tmdbId: number | null;
  title: string;
  year: number | null;
  posterPath: string | null;
  /** The quality of the file on disk. */
  quality: string | null;
  profile: string | null;
  cutoff: string | null;
}

export function cutoffMovie(row: RadarrCutoffRow, instance: string, profiles: ReadonlyMap<number, QualityProfileInfo>): CutoffMovie | null {
  const arrId = posInt(row.id);
  if (arrId === null || row.hasFile !== true) return null;
  const file = row.movieFile && typeof row.movieFile === "object" ? (row.movieFile as { qualityCutoffNotMet?: unknown }) : null;
  // The listing is the cutoff endpoint, but a row whose own file says the
  // cutoff IS met (changed between pages) is not listed.
  if (file && file.qualityCutoffNotMet === false) return null;
  const profile = profiles.get(posInt(row.qualityProfileId) ?? -1);
  return {
    instance,
    arrId,
    tmdbId: posInt(row.tmdbId),
    title: str(row.title),
    year: posInt(row.year),
    posterPath: tmdbPosterPathFromImages(row.images),
    quality: qualityName(row.movieFile),
    profile: profile?.name || null,
    cutoff: profile?.cutoff ?? null,
  };
}

export type SonarrCutoffRecord = {
  id?: unknown;
  seriesId?: unknown;
  seasonNumber?: unknown;
  episodeNumber?: unknown;
  title?: unknown;
  hasFile?: unknown;
  episodeFile?: unknown;
  series?: { id?: unknown; tmdbId?: unknown; tvdbId?: unknown; title?: unknown; year?: unknown; qualityProfileId?: unknown; monitored?: unknown } | null;
};

export interface CutoffEpisode {
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  quality: string | null;
}

export interface CutoffSeries {
  instance: string;
  arrId: number;
  tmdbId: number | null;
  tvdbId: number | null;
  title: string;
  year: number | null;
  posterPath: string | null;
  profile: string | null;
  cutoff: string | null;
  episodes: CutoffEpisode[];
}

/** One instance's cutoff-unmet episode records → one row per series, its episodes in order. */
export function cutoffSeriesFromEpisodes(
  records: readonly SonarrCutoffRecord[],
  instance: string,
  profiles: ReadonlyMap<number, QualityProfileInfo>,
): CutoffSeries[] {
  const bySeries = new Map<number, CutoffSeries>();
  for (const r of records) {
    if (!r || typeof r !== "object" || r.hasFile !== true) continue;
    const seriesId = posInt(r.seriesId) ?? posInt(r.series?.id);
    const seasonNumber = typeof r.seasonNumber === "number" && Number.isInteger(r.seasonNumber) && r.seasonNumber >= 0 ? r.seasonNumber : null;
    const episodeNumber = typeof r.episodeNumber === "number" && Number.isInteger(r.episodeNumber) && r.episodeNumber >= 0 ? r.episodeNumber : null;
    if (seriesId === null || seasonNumber === null || episodeNumber === null) continue;
    const file = r.episodeFile && typeof r.episodeFile === "object" ? (r.episodeFile as { qualityCutoffNotMet?: unknown }) : null;
    if (file && file.qualityCutoffNotMet === false) continue;
    let row = bySeries.get(seriesId);
    if (!row) {
      const profile = profiles.get(posInt(r.series?.qualityProfileId) ?? -1);
      row = {
        instance,
        arrId: seriesId,
        tmdbId: posInt(r.series?.tmdbId),
        tvdbId: posInt(r.series?.tvdbId),
        title: str(r.series?.title),
        year: posInt(r.series?.year),
        posterPath: null,
        profile: profile?.name || null,
        cutoff: profile?.cutoff ?? null,
        episodes: [],
      };
      bySeries.set(seriesId, row);
    }
    row.episodes.push({ seasonNumber, episodeNumber, title: str(r.title), quality: qualityName(r.episodeFile) });
  }
  const out = [...bySeries.values()];
  for (const s of out) s.episodes.sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
  return out;
}

export type SonarrEpisodeFileRow = { id?: unknown; qualityCutoffNotMet?: unknown };

/**
 * The cutoff Search for one series, judged LIVE: the monitored episodes whose
 * file Sonarr itself says is below cutoff (`episodeFileId` → that file's
 * `qualityCutoffNotMet`). Searched as one EpisodeSearch — never SeasonSearch or
 * SeriesSearch, which would also look for episodes that are fine.
 */
export function planCutoffSearch(
  episodes: ReadonlyArray<SonarrEpisodeRow & { episodeFileId?: unknown }>,
  files: readonly SonarrEpisodeFileRow[],
): number[] {
  const below = new Set<number>();
  for (const f of files) {
    const id = posInt(f?.id);
    if (id !== null && f.qualityCutoffNotMet === true) below.add(id);
  }
  const ids: number[] = [];
  for (const e of episodes) {
    const id = posInt(e?.id);
    const fileId = posInt(e?.episodeFileId);
    if (id === null || fileId === null || e.hasFile !== true || e.monitored !== true) continue;
    if (below.has(fileId)) ids.push(id);
  }
  return ids.sort((a, b) => a - b);
}
