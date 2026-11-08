// Jellyfin episodes: the TVEpisodeCache walk, one show's episodes for
// fix-match, and one show's episode ids for watch sync. Episode-only queries
// can't be grouped into collections, so they carry no CollapseBoxSetItems
// flag (guardrail 37d's one exemption).
import { v, type Infer } from "./validate";
import { loose, looseString, parseEach } from "./media-server-payload";
import { jellyfinItemsUrl, type ItemsParam } from "./jellyfin-http";
import { walkJellyfinSequential } from "./jellyfin-paging";
import { getJellyfinSeriesItemIndex, parseJellyfinDate } from "./jellyfin-library";

export interface JellyfinTVEpisodeData {
  tmdbId: number;
  seasonNumber: number;
  episodeNumber: number;
  // DateCreated — when the episode reached the server; dates a season for the
  // never-watched report. The earliest across copies of a duplicated show.
  addedAt?: Date | null;
}

// One listed episode. Lenient fields (media-server-payload.ts); the
// season/episode checks below decide what counts.
const JellyfinEpisodeSchema = v.object({
  Id: looseString(),
  SeriesId: looseString(),
  ParentIndexNumber: loose(v.number()),
  IndexNumber: loose(v.number()),
  IndexNumberEnd: loose(v.number()),
  DateCreated: looseString(),
});
type JellyfinEpisode = Infer<typeof JellyfinEpisodeSchema>;

// A regular episode (season ≥ 1, episode ≥ 1): specials (season 0) and
// negative or fractional indices don't map to TMDB episode numbers.
function regularEpisode(ep: JellyfinEpisode): { season: number; episode: number } | null {
  if (!Number.isInteger(ep.ParentIndexNumber) || (ep.ParentIndexNumber as number) < 1) return null;
  if (!Number.isInteger(ep.IndexNumber) || (ep.IndexNumber as number) < 1) return null;
  return { season: ep.ParentIndexNumber as number, episode: ep.IndexNumber as number };
}

function episodesQuery(baseUrl: string, parent: ItemsParam, fields: string, sortBy: string): string {
  return jellyfinItemsUrl(baseUrl, [
    parent,
    ["IncludeItemTypes", "Episode"],
    ["Recursive", "true"],
    ["Fields", fields],
    ["EnableImages", "false"],
    ["ImageTypeLimit", 0],
    ["SortBy", sortBy],
    ["SortOrder", "Ascending"],
  ]);
}

export async function getJellyfinTVEpisodes(
  baseUrl: string,
  apiKey: string,
  libraryIds?: Set<string>,
  seriesItemIdToTmdbId?: Map<string, number>,
): Promise<JellyfinTVEpisodeData[]> {
  const seriesMap = seriesItemIdToTmdbId ?? await getJellyfinSeriesItemIndex(baseUrl, apiKey, libraryIds);
  if (seriesMap.size === 0) return [];

  // One row per (tmdb id, season, episode); a show in two libraries keeps the
  // earliest arrival, which dates its season.
  const episodeMap = new Map<string, JellyfinTVEpisodeData>();
  const processEpisodes = (raw: unknown[]) => {
    for (const ep of parseEach(JellyfinEpisodeSchema, raw)) {
      const tmdbId = ep.SeriesId ? seriesMap.get(ep.SeriesId) : undefined;
      if (tmdbId == null) continue;
      const numbered = regularEpisode(ep);
      if (!numbered) continue;
      const key = `${tmdbId}-${numbered.season}-${numbered.episode}`;
      const addedAt = parseJellyfinDate(ep.DateCreated);
      const prev = episodeMap.get(key);
      if (!prev) {
        episodeMap.set(key, { tmdbId, seasonNumber: numbered.season, episodeNumber: numbered.episode, addedAt });
      } else if (addedAt && (!prev.addedAt || addedAt < prev.addedAt)) {
        prev.addedAt = addedAt;
      }
    }
  };

  const fields = "SeriesId,ParentIndexNumber,IndexNumber,DateCreated";
  const parents: ItemsParam[] = libraryIds?.size ? Array.from(libraryIds, (id) => ["ParentId", id] as const) : [null];
  for (const parent of parents) {
    await walkJellyfinSequential(episodesQuery(baseUrl, parent, fields, "DateCreated,SortName"), apiKey, processEpisodes);
  }
  return Array.from(episodeMap.values());
}

export async function getJellyfinEpisodesForShow(
  baseUrl: string,
  apiKey: string,
  seriesId: string,
  tmdbId: number,
): Promise<JellyfinTVEpisodeData[]> {
  const episodes: JellyfinTVEpisodeData[] = [];
  // DateCreated as in getJellyfinTVEpisodes: fix-match rebuilds the show's
  // TVEpisodeCache rows from here, and an undated episode makes its season
  // `unobservable` on the never-watched report (14d).
  await walkJellyfinSequential(
    episodesQuery(baseUrl, ["ParentId", seriesId], "ParentIndexNumber,IndexNumber,DateCreated", "DateCreated,SortName"),
    apiKey,
    (raw) => {
      for (const ep of parseEach(JellyfinEpisodeSchema, raw)) {
        const numbered = regularEpisode(ep);
        if (!numbered) continue;
        episodes.push({ tmdbId, seasonNumber: numbered.season, episodeNumber: numbered.episode, addedAt: parseJellyfinDate(ep.DateCreated) });
      }
    },
  );
  return episodes;
}

// One episode's own item Id, for watch sync (watch-sync.ts) — which marks an
// episode played by Id, so it needs the Id getJellyfinEpisodesForShow drops.
// Season 0 (specials) is kept here; the planner decides whether to use it.
export interface JellyfinEpisodeId {
  seasonNumber: number;
  episodeNumber: number;
  // IndexNumberEnd for a multi-episode file (S01E01-E02); null otherwise.
  episodeNumberEnd: number | null;
  itemId: string;
}

export async function getJellyfinEpisodeIds(
  baseUrl: string,
  apiKey: string,
  seriesId: string,
): Promise<JellyfinEpisodeId[]> {
  const out: JellyfinEpisodeId[] = [];
  await walkJellyfinSequential(
    episodesQuery(baseUrl, ["ParentId", seriesId], "ParentIndexNumber,IndexNumber,IndexNumberEnd", "SortName"),
    apiKey,
    (raw) => {
      for (const ep of parseEach(JellyfinEpisodeSchema, raw)) {
        if (!ep.Id || ep.Id.length > 256) continue;
        if (!Number.isInteger(ep.ParentIndexNumber) || (ep.ParentIndexNumber as number) < 0) continue;
        if (!Number.isInteger(ep.IndexNumber) || (ep.IndexNumber as number) < 0) continue;
        const end = Number.isInteger(ep.IndexNumberEnd) && (ep.IndexNumberEnd as number) > (ep.IndexNumber as number)
          ? (ep.IndexNumberEnd as number)
          : null;
        out.push({ seasonNumber: ep.ParentIndexNumber as number, episodeNumber: ep.IndexNumber as number, episodeNumberEnd: end, itemId: ep.Id });
      }
    },
  );
  return out;
}
