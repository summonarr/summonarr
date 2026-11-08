// The now-playing snapshot: the `activity:sessions` SSE payload built from the
// current ActiveSession rows.
import { prisma } from "./prisma";
import { emitSSE } from "./sse-emitter";
import { posterPathKey, resolvePosterMap } from "./poster-cache";
import type { Prisma } from "@/generated/prisma";

// The ActiveSession columns a now-playing card shows — everything but the
// poller's bookkeeping (sessionKey, lastSeenAt, playtime, the item keys).
export const ACTIVE_SESSION_SNAPSHOT_SELECT = {
  id: true,
  source: true,
  state: true,
  mediaServerUserId: true,
  serverUsername: true,
  title: true,
  tmdbId: true,
  mediaType: true,
  year: true,
  seasonNumber: true,
  episodeNumber: true,
  episodeTitle: true,
  progressPercent: true,
  progressMs: true,
  durationMs: true,
  platform: true,
  player: true,
  device: true,
  ipAddress: true,
  startedAt: true,
  playMethod: true,
  videoCodec: true,
  audioCodec: true,
  resolution: true,
  bitrate: true,
  videoDecision: true,
  audioDecision: true,
  container: true,
  location: true,
  bandwidth: true,
  secure: true,
  relayed: true,
  introStartMs: true,
  introEndMs: true,
  creditsStartMs: true,
  creditsEndMs: true,
} as const satisfies Prisma.ActiveSessionSelect;

export type ActiveSessionSnapshotRow = Prisma.ActiveSessionGetPayload<{ select: typeof ACTIVE_SESSION_SNAPSHOT_SELECT }>;

// One row of the payload: the selected columns, BigInts as numbers and the
// start as an ISO string (SSE is JSON), plus the card's poster URL.
export function serializeActiveSession(row: ActiveSessionSnapshotRow, posterUrl: string | null) {
  const { progressMs, durationMs, startedAt, ...rest } = row;
  return {
    ...rest,
    progressMs: Number(progressMs),
    durationMs: Number(durationMs),
    startedAt: startedAt.toISOString(),
    posterUrl,
  };
}

// Build an activity:sessions SSE payload from current ActiveSession rows and emit it.
// Used after SSE-driven finalize (plex-events) to push an immediate now-playing update,
// and reused by the 5s poll route so the wire format stays in one place.
export async function emitActiveSessionsSnapshot(): Promise<void> {
  const allSessions = await prisma.activeSession.findMany({
    // Secondary key `id` (immutable PK) breaks startedAt ties deterministically.
    // Sessions that first appear in the same 5s poll share an identical
    // startedAt (the poll stamps one `now` across all creates), and with no
    // tiebreaker Postgres returns the tied rows in heap order — which the
    // per-poll UPDATEs reshuffle, making the now-playing cards swap places.
    orderBy: [{ startedAt: "desc" }, { id: "asc" }],
    select: ACTIVE_SESSION_SNAPSHOT_SELECT,
  });

  // The shared poster lookup the admin activity page renders its cards with
  // (TmdbMediaCore, then the :details cache), so the server-rendered list and
  // the first live push show the same art. Keyed by (tmdbId, mediaType): TMDB
  // numbers movies and TV separately, and a type the session NAMES is never
  // filled from the other medium's art — only an unknown type consults both.
  const withIds = allSessions.filter((s): s is typeof s & { tmdbId: number } => s.tmdbId != null);
  const posters = withIds.length > 0
    ? await resolvePosterMap(withIds.map((s) => ({ tmdbId: s.tmdbId, mediaType: s.mediaType })))
    : {};

  emitSSE({
    type: "activity:sessions",
    sessions: allSessions.map((s) =>
      serializeActiveSession(s, s.tmdbId != null ? posters[posterPathKey(s.tmdbId, s.mediaType)] ?? null : null),
    ),
  });
}
