// A title on an instance, by the ids the arr itself keys on: Radarr's library row
// for a tmdbId, Sonarr's for a tvdbId, and one episode of a series. Every
// search, release, grab and season helper reads through these, so "not in the
// library" means the same thing everywhere (ArrItemNotFoundError), and so does
// a missing episode (a plain Error: the SERIES is there, and callers read
// ArrItemNotFoundError as "not in Radarr/Sonarr — re-push").
import { arrFetch, asRecord, ArrItemNotFoundError, findLibraryRow, unusableAnswer, type ArrCfg, type ArrRecord } from "./arr-client";
import { posInt } from "./arr-parse";

/** Radarr's library row for a tmdbId (server-side filtered), or null. */
export async function findRadarrMovie(cfg: ArrCfg, tmdbId: number): Promise<ArrRecord | null> {
  return findLibraryRow(await arrFetch<unknown>(cfg, `/api/v3/movie?tmdbId=${tmdbId}`), "tmdbId", tmdbId, "Radarr");
}

/**
 * Sonarr's library row for a tvdbId, or null. `?tvdbId=` is Sonarr's
 * server-side filter (FindByTvdbId; statistics still attached on the filtered
 * branch in v3 and v4), so this never pays a full-library transfer.
 */
export async function findSonarrSeries(cfg: ArrCfg, tvdbId: number): Promise<ArrRecord | null> {
  return findLibraryRow(await arrFetch<unknown>(cfg, `/api/v3/series?tvdbId=${tvdbId}`), "tvdbId", tvdbId, "Sonarr");
}

/** A held title: its row, the arr's own id for it, and the quality profile the row names. */
export interface HeldTitle {
  row: ArrRecord;
  id: number;
  /** undefined when the row names none: no allowed/not-allowed split. */
  qualityProfileId: number | undefined;
}

// The row's own id is what every command and PUT names. A held row without one
// can't be acted on, which is what "not in the library" tells the caller.
function held(row: ArrRecord | null, notFound: string): HeldTitle {
  const id = posInt(row?.id);
  if (!row || id === null) throw new ArrItemNotFoundError(notFound);
  return { row, id, qualityProfileId: posInt(row.qualityProfileId) ?? undefined };
}

/** The movie as Radarr holds it; ArrItemNotFoundError when it doesn't. */
export async function requireRadarrMovie(cfg: ArrCfg, tmdbId: number): Promise<HeldTitle> {
  return held(await findRadarrMovie(cfg, tmdbId), "Movie not found in Radarr library");
}

/** The series as Sonarr holds it; ArrItemNotFoundError when it doesn't. */
export async function requireSonarrSeries(cfg: ArrCfg, tvdbId: number): Promise<HeldTitle> {
  return held(await findSonarrSeries(cfg, tvdbId), "Series not found in Sonarr library");
}

/**
 * The id of episode SxEy of a series. Asks for that season only (a long-running
 * series has thousands of episodes, and the full list approaches the 50 MB
 * cap), and still matches season, episode and series itself, in case an arr
 * build ignored the filter. A missing episode throws a plain Error.
 */
export async function findEpisodeId(cfg: ArrCfg, seriesId: number, seasonNumber: number, episodeNumber: number): Promise<number> {
  const raw = await arrFetch<unknown>(cfg, `/api/v3/episode?seriesId=${seriesId}&seasonNumber=${seasonNumber}`);
  if (!Array.isArray(raw)) throw unusableAnswer("Sonarr", "episode list");
  for (const x of raw) {
    const ep = asRecord(x);
    if (!ep || ep.seasonNumber !== seasonNumber || ep.episodeNumber !== episodeNumber) continue;
    // A row naming another series is not this one's; a row without the field is
    // kept — older builds don't always send it.
    if (ep.seriesId !== undefined && ep.seriesId !== seriesId) continue;
    const id = posInt(ep.id);
    if (id !== null) return id;
  }
  throw new Error(`Episode S${seasonNumber}E${episodeNumber} not found in Sonarr`);
}
