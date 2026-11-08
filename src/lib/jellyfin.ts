// The Jellyfin client's entry point. Import from here ("@/lib/jellyfin"); the
// code lives in flat siblings, one concern each:
//   jellyfin-http.ts       identity and token headers, the /Items URL builder
//   jellyfin-paging.ts     one page with retry, the counted and sequential walks
//   jellyfin-signin.ts     password sign-in and QuickConnect
//   jellyfin-library.ts    media folders, the sync's title listing, match check, probe
//   jellyfin-episodes.ts   the episode cache walk, one show's episodes and ids
//   jellyfin-sessions.ts   now playing, terminate
//   jellyfin-users.ts      server users, user count, download policy
//   jellyfin-user-data.ts  one user's played/resumable/favorite items, watch-sync writes
export {
  jellyfinAdminHeaders,
  JELLYFIN_NO_COLLECTION_GROUPING,
} from "./jellyfin-http";
export {
  authenticateWithJellyfin,
  authenticateWithJellyfinQuickConnect,
  initiateJellyfinQuickConnect,
  pollJellyfinQuickConnect,
  type JellyfinQuickConnectResult,
  type JellyfinUser,
} from "./jellyfin-signin";
export {
  buildSeriesItemIdIndex,
  getJellyfinMediaFolders,
  getJellyfinSyncFolders,
  getJellyfinTmdbIds,
  hasJellyfinItemByTmdbId,
  libraryItemIds,
  listJellyfinMatchEntries,
  refreshJellyfinLibrary,
  type JellyfinLibraryItemData,
  type JellyfinMediaFolder,
} from "./jellyfin-library";
export {
  getJellyfinEpisodeIds,
  getJellyfinEpisodesForShow,
  getJellyfinTVEpisodes,
  type JellyfinEpisodeId,
  type JellyfinTVEpisodeData,
} from "./jellyfin-episodes";
export {
  getJellyfinSessions,
  terminateJellyfinSession,
  type JellyfinSessionData,
} from "./jellyfin-sessions";
export {
  getJellyfinAllUsers,
  getJellyfinUserCount,
  setJellyfinDownloadPolicy,
  type JellyfinUserInfo,
} from "./jellyfin-users";
export {
  getJellyfinFavorites,
  getJellyfinInProgress,
  getJellyfinPlayedSince,
  getJellyfinUserPlayedItems,
  getJellyfinUserStates,
  JELLYFIN_FAVORITES_MAX,
  markJellyfinPlayed,
  parseJellyfinFavorite,
  setJellyfinPosition,
  type JellyfinFavorite,
  type JellyfinItemProgress,
  type JellyfinMarkPlayedResult,
  type JellyfinUserPlayedItems,
} from "./jellyfin-user-data";
