// Process memos built from the tables a database restore replaces. A committed
// restore (backup-import.ts) drops them all, so nothing keeps serving the
// pre-restore Settings, agents or library until a TTL lapses — or, for the
// Discord public key, until a restart (it has no TTL). Sessions minted while
// the old session lengths were cached would carry them for life (guardrail 6c).
//
// backup-import.ts clears the session-check floor and the arr snapshots itself;
// this module is everything else, imported on demand after the commit.
import { invalidatePublicKeyCache } from "@/lib/discord-interactions/signature";
import { invalidateSessionDurationsCache } from "@/lib/auth";
import { invalidateFeatureFlagCache } from "@/lib/features";
import { invalidateBlacklistCache } from "@/lib/blacklist";
import { invalidateAgentCache } from "@/lib/notify-agents";
import { invalidateApnsRelayCache } from "@/lib/push";
import { invalidateMdblistPlanCache } from "@/lib/mdblist";
import { invalidateArrLibraryIndexCache } from "@/lib/library-cleanup-arr";
import { clearActivityCache, invalidatePlayHistorySettings } from "@/lib/play-history";
import { clearRecentlyAddedCache } from "@/lib/recently-added";
import { invalidateNeverWatchedReport } from "@/lib/never-watched-report";
import { clearCandidateCache } from "@/lib/fix-match-candidate-cache";
import { invalidateStatsTimeZone } from "@/lib/stats-time-zone-data";
import { invalidateWatchGradeSettings } from "@/lib/watch-grade-data";

export function invalidateCachesAfterRestore(): void {
  invalidatePublicKeyCache();
  invalidateSessionDurationsCache();
  invalidateFeatureFlagCache();
  invalidateBlacklistCache();
  invalidateAgentCache();
  invalidateApnsRelayCache();
  invalidateMdblistPlanCache();
  invalidateArrLibraryIndexCache();
  clearActivityCache();
  invalidatePlayHistorySettings();
  invalidateStatsTimeZone();
  invalidateWatchGradeSettings();
  clearRecentlyAddedCache();
  invalidateNeverWatchedReport();
  clearCandidateCache();
}
