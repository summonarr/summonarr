// Play history: recording what was watched on the media servers, and every
// aggregate read over it. This file is the stable entry point — importers keep
// using "@/lib/play-history" — and the code lives in the play-history-*.ts
// modules beside it:
//
//   -settings        the play-history Settings (tracking switches, thresholds, retention)
//   -identity        MediaServerUser resolution and show-key → tmdbId mapping
//   -record          the session finalize (guardrail 19), boot re-anchor (21),
//                    stale-session cleanup and the retention purge
//   -snapshot        the now-playing `activity:sessions` SSE payload
//   -cache           the memoized-aggregate cache and its generation guard (19b)
//   -sql-fragments   shared SQL: the zone bucket (19g), the resolution and
//                    transcode-reason reads (19c), title grouping, the arc chain
//   -aggregate       the capped statement runner and daily-series padding
//   -stats-filters   the window/source/mediaType filter SQL
//   -stats           the Statistics page bundle and its previous-period check (19d)
//   -leaderboards    the ranked lists beside it, the users list, platforms
//   -calendar        the activity calendar and heatmap-cell drill-down
//   -popular         "Popular on Server"
//   -user-stats      the per-person bundle; -wrapped its year in review
//   -media-stats     the per-title bundle
//   -warm            the cache pre-warm the cron runs
//
// (play-history-filters.ts is separate: the admin history list and export's
// query-string filters.)
export {
  isPlayHistoryEnabled,
  isSourceEnabled,
  getWatchedThreshold,
  getCompletionThreshold,
  getArcGapDays,
  getRetentionCutoff,
  invalidatePlayHistorySettings,
} from "./play-history-settings";
export { resolveShowTmdbId, MediaServerMismatchError, resolveMediaServerUser } from "./play-history-identity";
export {
  calculateWatched,
  MAX_PLAYTIME_DELTA_MS,
  SESSION_ABSENCE_GRACE_MS,
  SESSION_COMPLETED_RATIO,
  computePlaytimeIncrement,
  applyFinalTick,
  recordCompletedSession,
  reanchorActiveSessionsOnBoot,
  STALE_FINALIZE_CONCURRENCY,
  cleanupStaleSessions,
  purgeOldHistory,
} from "./play-history-record";
export {
  ACTIVE_SESSION_SNAPSHOT_SELECT,
  serializeActiveSession,
  emitActiveSessionsSnapshot,
  type ActiveSessionSnapshotRow,
} from "./play-history-snapshot";
export { currentActivityGeneration, clearActivityCache } from "./play-history-cache";
export { RECENT_PLAYS_SHOWN, getPlayStatsForServerUsers, getUserPlayStats } from "./play-history-user-stats";
export { getPlayYearsForServerUsers, getWrappedForServerUsers, type WrappedBundle } from "./play-history-wrapped";
export { getMediaPlayStats } from "./play-history-media-stats";
export {
  getAllUsersStats,
  getMostRewatched,
  getTranscodeOffenders,
  WATCH_TIME_LEADERBOARD_SIZE,
  getWatchTimeLeaderboard,
  getBusiestDay,
  getPlayHistoryPlatforms,
  type TranscodeOffenders,
} from "./play-history-leaderboards";
export { POPULAR_PER_PAGE, getMostPopularOnServer, type PopularSort } from "./play-history-popular";
export { appendPlayHistoryFilter, type PlayHistoryStatsFilters } from "./play-history-stats-filters";
export { getPlayHistoryStats, type PlayHistoryStatsResult } from "./play-history-stats";
export {
  getActivityCalendar,
  getHeatmapCellDetail,
  type HeatmapCellQuery,
  type HeatmapCellDetail,
} from "./play-history-calendar";
export { warmActivityCache } from "./play-history-warm";
