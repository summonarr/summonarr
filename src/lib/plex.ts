// The Plex client's entry point. Import from here ("@/lib/plex"); the code
// lives in flat siblings, one concern each:
//   plex-http.ts       transport: headers, fetch, retry, the paged walk
//   plex-metadata.ts   one library item's shape and its tmdb/imdb/tvdb ids
//   plex-library.ts    sections, the sync's title walk, match check, probe
//   plex-episodes.ts   the episode cache walk, one show's episodes and keys
//   plex-sessions.ts   now playing, markers, terminate
//   plex-history.ts    the server's own watch history
//   plex-user-state.ts watch sync: per-user tokens, states, progress, scrobble
//   plex-accounts.ts   plex.tv tokens and users, friends, server membership
export {
  PLEX_CLIENT_ID,
  PLEX_IDENTITY_TIMEOUT_MS,
} from "./plex-http";
export {
  extractTmdbIdFromGuids,
  parseTmdbGuid,
} from "./plex-metadata";
export {
  foldDuplicateRatingKeys,
  getPlexLibrarySections,
  getPlexSectionTmdbIds,
  getPlexTmdbIds,
  hasPlexItemByTmdbId,
  listPlexMatchEntries,
  plexLibraryRatingKeys,
  refreshPlexSection,
  withDuplicateRatingKeys,
  type PlexLegacyGuidRef,
  type PlexLibraryItemData,
  type PlexSection,
  type PlexSectionWalkOptions,
  type PlexTmdbIdsOptions,
} from "./plex-library";
export {
  getPlexEpisodeKeys,
  getPlexEpisodesForShow,
  getPlexTVEpisodes,
  type PlexEpisodeKey,
  type PlexTVEpisodeData,
  type PlexTVEpisodeOptions,
} from "./plex-episodes";
export {
  getPlexMarkers,
  getPlexSessions,
  terminatePlexSession,
  type PlexMarkers,
  type PlexSessionData,
} from "./plex-sessions";
export {
  getPlexWatchHistory,
  PLEX_WATCH_HISTORY_MAX_ITEMS,
  PLEX_WATCH_HISTORY_MAX_RAW,
  type PlexWatchHistory,
  type PlexWatchHistoryOptions,
} from "./plex-history";
export {
  getPlexHomeUserToken,
  getPlexInProgress,
  getPlexAllInProgress,
  getPlexSharedServerTokens,
  getPlexUserStates,
  getPlexViewCounts,
  parsePlexHomeSwitchToken,
  parsePlexInProgress,
  parsePlexSharedServerTokens,
  scrobblePlexItem,
  setPlexProgress,
  type PlexInProgressItem,
  type PlexUserItemState,
} from "./plex-user-state";
export {
  checkPlexServerAccess,
  checkPlexToken,
  countPlexServerMembers,
  getPlexAccountsDetailed,
  getPlexFriendEmails,
  getPlexMachineId,
  getPlexResources,
  getPlexServerFriendIds,
  getPlexUser,
  pingPlexToken,
  type PlexAccountInfo,
  type PlexAccountsResult,
  type PlexServerMembers,
  type PlexTokenState,
  type PlexUser,
} from "./plex-accounts";
