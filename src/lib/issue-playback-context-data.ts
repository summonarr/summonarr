import "server-only";
import { prisma } from "./prisma";
import { resolveLinkedMediaServerUserIds } from "./my-watch-history";
import {
  PLAYBACK_CONTEXT_CANDIDATES,
  PLAYBACK_CONTEXT_WINDOW_DAYS,
  buildPlaybackContext,
  pickPlay,
  type IssueScopeRef,
  type PlaybackContext,
} from "./issue-playback-context";

/**
 * The reporter's most recent play of the reported title, or null. Identity goes
 * through the shared linkage rule (guardrail 34), so a reporter whose Plex or
 * Jellyfin account is linked by id, email or an admin's pin is found; one with
 * no linked identity, or no recent play, gets null. Best effort by contract: a
 * failed read must never block filing an issue.
 */
export async function loadPlaybackContext(
  reporterId: string,
  title: { tmdbId: number; mediaType: "MOVIE" | "TV" },
  scope: IssueScopeRef,
  now: Date,
): Promise<PlaybackContext | null> {
  try {
    const ids = await resolveLinkedMediaServerUserIds(reporterId);
    if (ids.length === 0) return null;
    const since = new Date(now.getTime() - PLAYBACK_CONTEXT_WINDOW_DAYS * 86_400_000);
    const rows = await prisma.playHistory.findMany({
      where: {
        mediaServerUserId: { in: ids },
        tmdbId: title.tmdbId,
        mediaType: title.mediaType,
        stoppedAt: { gte: since },
      },
      orderBy: { startedAt: "desc" },
      take: PLAYBACK_CONTEXT_CANDIDATES,
      select: {
        source: true, startedAt: true, stoppedAt: true, seasonNumber: true, episodeNumber: true,
        platform: true, player: true, device: true, playMethod: true,
        videoDecision: true, audioDecision: true, videoCodec: true, audioCodec: true,
        resolution: true, container: true, bitrate: true, transcodeReason: true,
        location: true, relayed: true,
      },
    });
    const pick = pickPlay(rows, scope, now);
    return pick ? buildPlaybackContext(pick.row, pick.exact) : null;
  } catch (err) {
    console.error("[issue-playback-context] read failed:", err instanceof Error ? err.message : err);
    return null;
  }
}
