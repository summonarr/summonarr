// Plex episodes: the TVEpisodeCache walk (every show section's type=4
// listing), one show's episodes for fix-match, and one show's episode keys
// for watch sync.
import { v, type Infer } from "./validate";
import { idKey, loose, looseList, looseString, numberish, parseEach } from "./media-server-payload";
import { plexFetchAllPages, plexUrl } from "./plex-http";
import { extractAllTmdbIds, firstPartFile, PlexMetadataItemSchema } from "./plex-metadata";
import { getPlexLibrarySections, walkPlexSection, type PlexSection } from "./plex-library";

export interface PlexTVEpisodeData {
  tmdbId: number;
  seasonNumber: number;
  episodeNumber: number;
  // When the episode reached the server — dates a season for the never-watched
  // report. The earliest across sections when a show sits in several.
  addedAt?: Date | null;
}

// An episode entry of a type=4 listing or a show's allLeaves. Lenient fields
// (media-server-payload.ts); the season/episode checks below decide.
const PlexEpisodeSchema = v.object({
  ratingKey: loose(idKey),
  grandparentRatingKey: loose(idKey),
  parentIndex: loose(v.number()),
  index: loose(v.number()),
  // Present on the type=4 section listing — the same file attribute the movie
  // branch reads from /all at type=1. Consumed only when the caller asked for
  // episode file paths (episodeFilePathsOut).
  Media: looseList(v.object({ Part: looseList(v.object({ file: looseString() })) })),
  addedAt: loose(numberish),
});
type PlexEpisode = Infer<typeof PlexEpisodeSchema>;

// A regular episode (season ≥ 1, episode ≥ 1): specials and unnumbered
// entries don't map to TMDB episode numbers.
function regularEpisode(ep: PlexEpisode): { season: number; episode: number } | null {
  if (!Number.isInteger(ep.parentIndex) || (ep.parentIndex as number) < 1) return null;
  if (!Number.isInteger(ep.index) || (ep.index as number) < 1) return null;
  return { season: ep.parentIndex as number, episode: ep.index as number };
}

function episodeAddedAt(ep: PlexEpisode): Date | null {
  return ep.addedAt !== undefined && ep.addedAt > 0 ? new Date(ep.addedAt * 1000) : null;
}

/** getPlexTVEpisodes' optional inputs and outputs. */
export interface PlexTVEpisodeOptions {
  signal?: AbortSignal;
}

export async function getPlexTVEpisodes(
  serverUrl: string,
  token: string,
  selectedKeys?: Set<string>,
  sections?: PlexSection[],
  // The ratingKey → tmdb ids map accumulated by getPlexTmdbIds' type=2 walk in
  // the SAME sync run. When provided, the per-section type=2 re-walk below is
  // skipped — the full sync used to page every show section twice for the
  // identical listing. ratingKeys are server-local: only pass a map built
  // against the same serverUrl/instance.
  precomputedRatingKeyToTmdb?: Map<string, number[]>,
  // Captures the first episode file path per show (grandparentRatingKey) from
  // the type=4 listing. The library walk reads no show path (a show item
  // carries no file), so this is where every sync gets one: it patches these
  // onto the TV rows it wrote (patchPlexShowFilePaths).
  episodeFilePathsOut?: Map<string, string>,
  opts: PlexTVEpisodeOptions = {},
): Promise<PlexTVEpisodeData[]> {
  const { signal } = opts;
  const allSections = sections ?? await getPlexLibrarySections(serverUrl, token, signal);
  const showSections = allSections.filter(
    (s) => s.type === "show" && (!selectedKeys?.size || selectedKeys.has(s.key))
  );

  const sectionResults = await Promise.all(showSections.map(async (section) => {
    const ratingKeyToTmdb = precomputedRatingKeyToTmdb ?? await walkShowTmdbIds(serverUrl, token, section.key, signal);
    if (ratingKeyToTmdb.size === 0) return [] as PlexTVEpisodeData[];
    return walkSectionEpisodes(serverUrl, token, section.key, ratingKeyToTmdb, episodeFilePathsOut, signal);
  }));

  return mergeEpisodeCopies(sectionResults.flat());
}

// A section's show ratingKey → tmdb ids, for a caller without the library
// walk's map. Multi-valued to match the availability path (extractAllTmdbIds):
// a Plex-merged show carries several tmdb:// GUIDs, and taking only the first
// one marked the other id "available" at show level while its TVEpisodeCache
// stayed empty — every season/episode rendered missing and users re-requested
// content already on disk.
async function walkShowTmdbIds(serverUrl: string, token: string, sectionKey: string, signal?: AbortSignal): Promise<Map<string, number[]>> {
  const walked = new Map<string, number[]>();
  await walkPlexSection(serverUrl, token, { sectionKey, plexType: 2, includeGuids: true }, PlexMetadataItemSchema, (batch) => {
    for (const show of batch) {
      if (!show.ratingKey) continue;
      const tmdbIds = extractAllTmdbIds(show);
      if (tmdbIds.length > 0) walked.set(show.ratingKey, tmdbIds);
    }
  }, signal);
  return walked;
}

async function walkSectionEpisodes(
  serverUrl: string,
  token: string,
  sectionKey: string,
  ratingKeyToTmdb: Map<string, number[]>,
  episodeFilePathsOut: Map<string, string> | undefined,
  signal?: AbortSignal,
): Promise<PlexTVEpisodeData[]> {
  const episodes: PlexTVEpisodeData[] = [];
  await walkPlexSection(serverUrl, token, { sectionKey, plexType: 4 }, PlexEpisodeSchema, (batch) => {
    for (const ep of batch) {
      const showKey = ep.grandparentRatingKey;
      const tmdbIds = showKey ? ratingKeyToTmdb.get(showKey) : undefined;
      if (!showKey || !tmdbIds) continue;
      // First-wins per show; captured even for episodes the index filters
      // below skip (a specials-only file is still a real path).
      if (episodeFilePathsOut && !episodeFilePathsOut.has(showKey)) {
        const file = firstPartFile(ep);
        if (file) episodeFilePathsOut.set(showKey, file);
      }
      const numbered = regularEpisode(ep);
      if (!numbered) continue;
      const addedAt = episodeAddedAt(ep);
      for (const tmdbId of tmdbIds) {
        episodes.push({ tmdbId, seasonNumber: numbered.season, episodeNumber: numbered.episode, addedAt });
      }
    }
  }, signal);
  return episodes;
}

// One row per (tmdb id, season, episode); a show in several sections keeps
// the earliest arrival, which dates its season.
function mergeEpisodeCopies(all: readonly PlexTVEpisodeData[]): PlexTVEpisodeData[] {
  const episodeMap = new Map<string, PlexTVEpisodeData>();
  for (const ep of all) {
    const key = `${ep.tmdbId}-${ep.seasonNumber}-${ep.episodeNumber}`;
    const prev = episodeMap.get(key);
    if (!prev) episodeMap.set(key, ep);
    else if (ep.addedAt && (!prev.addedAt || ep.addedAt < prev.addedAt)) episodeMap.set(key, { ...prev, addedAt: ep.addedAt });
  }
  return Array.from(episodeMap.values());
}

export async function getPlexEpisodesForShow(
  serverUrl: string,
  token: string,
  ratingKey: string,
  tmdbId: number,
  opts: { signal?: AbortSignal } = {},
): Promise<PlexTVEpisodeData[]> {
  const episodes: PlexTVEpisodeData[] = [];
  await plexFetchAllPages(
    plexUrl(serverUrl, `/library/metadata/${encodeURIComponent(ratingKey)}/allLeaves`),
    token,
    (raw) => {
      for (const ep of parseEach(PlexEpisodeSchema, raw)) {
        const numbered = regularEpisode(ep);
        if (!numbered) continue;
        // Mapped exactly as getPlexTVEpisodes does: fix-match rebuilds a show's
        // TVEpisodeCache rows from this helper, and one undated episode makes
        // its season `unobservable` on the never-watched report (14d).
        episodes.push({ tmdbId, seasonNumber: numbered.season, episodeNumber: numbered.episode, addedAt: episodeAddedAt(ep) });
      }
    },
    opts.signal,
  );
  return episodes;
}

export interface PlexEpisodeKey {
  seasonNumber: number;
  episodeNumber: number;
  episodeNumberEnd: number | null;
  itemId: string;
}

/** Every episode of a show with its own ratingKey (season 0 included). */
export async function getPlexEpisodeKeys(serverUrl: string, token: string, showKey: string): Promise<PlexEpisodeKey[]> {
  if (!/^\d{1,20}$/.test(showKey)) return [];
  const out: PlexEpisodeKey[] = [];
  await plexFetchAllPages(
    plexUrl(serverUrl, `/library/metadata/${showKey}/allLeaves`),
    token,
    (raw) => {
      for (const ep of parseEach(PlexEpisodeSchema, raw)) {
        const key = ep.ratingKey ?? "";
        if (!/^\d{1,20}$/.test(key)) continue;
        if (!Number.isInteger(ep.parentIndex) || (ep.parentIndex as number) < 0) continue;
        if (!Number.isInteger(ep.index) || (ep.index as number) < 0) continue;
        out.push({ seasonNumber: ep.parentIndex as number, episodeNumber: ep.index as number, episodeNumberEnd: null, itemId: key });
      }
    },
  );
  return out;
}
