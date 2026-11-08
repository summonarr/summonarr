// The Jellyfin pass of the 5s play-history poller (POST /api/sync/play-history).
// The poller is the SOLE writer of Jellyfin play history (guardrail 19): a
// session it fails to track is a watch lost for good. Shared pieces are in
// session-poll-shared.ts.
import { prisma } from "@/lib/prisma";
import type { ActiveSession } from "@/generated/prisma";
import { computePlaytimeIncrement, resolveShowTmdbId } from "@/lib/play-history";
import { getJellyfinSessions, type JellyfinSessionData } from "@/lib/jellyfin";
import { type MediaInstanceKey, activeSessionId } from "@/lib/media-instances";
import { mapLimit } from "@/lib/concurrency";
import {
  continuingUpdateFields,
  finalizeAbsentSessions,
  forceFinalizeSession,
  lookupSessionPosters,
  posterOf,
  progressPercentOf,
  resolveMediaServerUserCached,
  stripShowPrefix,
  tickResult,
  writeEachSession,
  type SessionWriteOutcome,
  type SyncResult,
} from "@/lib/session-poll-shared";

/** The TMDB id a Jellyfin item's ProviderIds carry, else null. */
export function jellyfinProviderTmdbId(providerIds: Record<string, string> | undefined): number | null {
  const raw = providerIds?.Tmdb ?? providerIds?.tmdb;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

type ResolvedJellyfinSession = {
  s: JellyfinSessionData;
  msUserId: string;
  tmdbId: number | null;
  mediaType: "MOVIE" | "TV" | null;
};

// The rows a tick may continue, by the three keys a playback can be found under.
type ExistingJellyfinRows = {
  byId: ReadonlyMap<string, ActiveSession>;
  byKey: ReadonlyMap<string, ActiveSession>;
  // Single-use: a write that adopts one deletes it (see writeJellyfinSession).
  byUserItem: Map<string, ActiveSession>;
};

export async function syncJellyfinSessions(instance: MediaInstanceKey, baseUrl: string, apiKey: string, reanchored: boolean): Promise<SyncResult> {
  const sessions = await getJellyfinSessions(baseUrl, apiKey);
  const now = new Date();

  const valid = sessions.filter((s) => s.playSessionId && s.userId);

  const seenSessionKeys = new Set<string>();
  for (const s of valid) seenSessionKeys.add(s.playSessionId);

  // Resolve media server users so we have msUserId before the existing-row prefetch
  // (the (source, mediaServerUserId, sourceItemId) fallback lookup needs it). Bound
  // concurrency (guardrail 31): each call holds its own $transaction against the max:5
  // pool, and this runs concurrently with the Plex pass — cap below 5.
  const userIds = await mapLimit(valid, 4, (s) =>
    resolveMediaServerUserCached({
      source: "jellyfin",
      serverInstance: instance,
      sourceUserId: s.userId,
      username: s.userName,
    }),
  );

  const existing = await prefetchExistingRows(instance, valid, userIds);
  const resolved = await resolveJellyfinSessions(valid, userIds, instance);
  const posters = await lookupSessionPosters(resolved);

  // One failing write is skipped, not fatal (see writeEachSession).
  const outcomes = await writeEachSession(
    resolved,
    (r) => activeSessionId("jellyfin", instance, r.s.playSessionId),
    (r) => writeJellyfinSession({ instance, now, existing, posters, seenSessionKeys }, r),
  );

  // Grace window: only finalize sessions missing from /Sessions for
  // SESSION_ABSENCE_GRACE_MS. Jellyfin clients can briefly clear NowPlayingItem
  // (the filter on getJellyfinSessions) during pause-related transitions —
  // browser tab background, app reload, network reconnect — without the user
  // actually stopping. Real stops are detected within ~60s as the trade-off.
  // Nothing is selected when the boot re-anchor failed (guardrail 21).
  const sweptEnded = await finalizeAbsentSessions({
    source: "jellyfin",
    instance,
    seen: seenSessionKeys,
    reanchored,
    nowMs: now.getTime(),
  });
  return tickResult(outcomes, sweptEnded);
}

// Bulk prefetch: existing ActiveSession rows. Three lookup keys per session — primary id,
// alternate id (when sessionId !== playSessionId), and the (msUserId, sourceItemId) fallback
// for when the PlaySessionId changed but it is still the same playback.
async function prefetchExistingRows(
  instance: MediaInstanceKey,
  valid: readonly JellyfinSessionData[],
  userIds: readonly string[],
): Promise<ExistingJellyfinRows> {
  const primaryIds = valid.map((s) => activeSessionId("jellyfin", instance, s.playSessionId));
  const altIds = valid
    .filter((s) => s.sessionId && s.sessionId !== s.playSessionId)
    .map((s) => activeSessionId("jellyfin", instance, s.sessionId));
  const allIds = [...new Set([...primaryIds, ...altIds])];
  // A row's `id` is frozen at create ("jellyfin:<playSessionId-then>", or
  // "jellyfin:<instance>:<playSessionId-then>" for a named instance) but the
  // update branch REWRITES its `sessionKey` to the current playSessionId. After
  // that the two disagree, so an id-only lookup misses the row — and since
  // ActiveSession is @@unique([source, serverInstance, sessionKey]), the create
  // branch's createMany({skipDuplicates}) would then silently swallow the conflict
  // (ON CONFLICT DO NOTHING) and the new episode would get no ActiveSession, never
  // be finalized, and — the poller being the sole Jellyfin writer (guardrail 19) —
  // that watch would be lost, while the stale row pinned the now-playing card until
  // cleanupStaleSessions reaped it 30 minutes later. Matching on the live
  // sessionKey too lets the itemId-change finalize run instead.
  const allKeys = [...new Set(valid.flatMap((s) => [s.playSessionId, s.sessionId].filter((k): k is string => !!k)))];
  const idRows = allIds.length > 0 || allKeys.length > 0
    ? await prisma.activeSession.findMany({
        where: {
          // sessionKey is only unique WITH (source, serverInstance) — two
          // instances can report the same raw playSessionId, so the
          // serverInstance filter must apply to BOTH the id and sessionKey
          // branches or a same-key row on a different instance could leak in.
          source: "jellyfin",
          serverInstance: instance,
          OR: [{ id: { in: allIds } }, { sessionKey: { in: allKeys } }],
        },
      })
    : [];
  const byId = new Map(idRows.map((r) => [r.id, r]));
  const byKey = new Map(idRows.map((r) => [r.sessionKey, r]));
  // Every row already owned by id OR by live sessionKey — the fallback must not
  // hand any of them to a different session (see the notIn note below).
  const claimedIds = idRows.map((r) => r.id);

  // Fallback rows: only fetch for sessions that didn't match the primary or alternate id.
  const fallbackPairs = valid
    .map((s, i) => {
      const sessionId = activeSessionId("jellyfin", instance, s.playSessionId);
      const altSessionId = s.sessionId && s.sessionId !== s.playSessionId ? activeSessionId("jellyfin", instance, s.sessionId) : null;
      if (byId.has(sessionId) || (altSessionId && byId.has(altSessionId))) return null;
      if (byKey.has(s.playSessionId) || (s.sessionId && byKey.has(s.sessionId))) return null;
      return { msUserId: userIds[i], itemId: s.itemId };
    })
    .filter((p): p is { msUserId: string; itemId: string } => !!p && !!p.itemId);
  // notIn claimedIds: never hand a row that ANOTHER session in this same snapshot already owns
  // (by id or live sessionKey) to the fallback. Same account + same item on a second device (living-room TV and
  // tablet) otherwise resolves the tablet's new PlaySessionId onto the TV's live row, which
  // rewrites that row instead of creating one — so the second stream never gets an
  // ActiveSession, is never finalized, and (poller being the sole Jellyfin writer, guardrail
  // 19) its watch is unrecoverable. serverInstance scoped too (belt-and-suspenders — mediaServerUserId
  // already pins to one instance's MediaServerUser row transitively, since resolveMediaServerUser
  // never resolves across instances).
  const fallbackRows = fallbackPairs.length > 0
    ? await prisma.activeSession.findMany({
        where: {
          source: "jellyfin",
          serverInstance: instance,
          id: { notIn: claimedIds.length > 0 ? claimedIds : allIds },
          OR: fallbackPairs.map((p) => ({ mediaServerUserId: p.msUserId, sourceItemId: p.itemId })),
        },
      })
    : [];
  const byUserItem = new Map(fallbackRows.map((r) => [`${r.mediaServerUserId}:${r.sourceItemId ?? ""}`, r]));
  return { byId, byKey, byUserItem };
}

// Each session's TMDB id (TV episodes through their series via resolveShowTmdbId).
async function resolveJellyfinSessions(
  valid: readonly JellyfinSessionData[],
  userIds: readonly string[],
  instance: MediaInstanceKey,
): Promise<ResolvedJellyfinSession[]> {
  // Bulk prefetch JellyfinLibraryItem for movies whose TMDB id isn't in providerIds.
  const itemIdsNeedingLookup = valid
    .filter((s) => s.itemType !== "Episode" && jellyfinProviderTmdbId(s.providerIds) === null && !!s.itemId)
    .map((s) => s.itemId);
  const libRows = itemIdsNeedingLookup.length > 0
    ? await prisma.jellyfinLibraryItem.findMany({
        // serverInstance-scoped like the Plex prefetch: Jellyfin item ids are
        // server-local GUIDs, so a collision is unlikely but the scope keeps
        // this instance's watch from resolving against another server's row.
        //
        // ORed across both id columns (guardrail 37) — a title in two libraries
        // has an id per copy and only one is the stored `jellyfinItemId`, so a
        // watch of the other copy would otherwise resolve to "unknown". Rows
        // predating `jellyfinItemIds` are `[]`, so both branches are needed.
        where: {
          serverInstance: instance,
          OR: [
            { jellyfinItemId: { in: itemIdsNeedingLookup } },
            { jellyfinItemIds: { hasSome: itemIdsNeedingLookup } },
          ],
        },
        select: { jellyfinItemId: true, jellyfinItemIds: true, tmdbId: true, mediaType: true },
      })
    : [];
  // Keyed by EVERY id the row answers to, or widening the query above would find
  // the row and then fail to look it up.
  const libMap = new Map<string, (typeof libRows)[number]>();
  for (const r of libRows) {
    if (r.jellyfinItemId) libMap.set(r.jellyfinItemId, r);
    for (const id of r.jellyfinItemIds) libMap.set(id, r);
  }

  return Promise.all(
    valid.map(async (s, i): Promise<ResolvedJellyfinSession> => {
      let tmdbId: number | null = null;
      let mediaType: "MOVIE" | "TV" | null = s.itemType === "Episode" ? "TV" : s.itemType === "Movie" ? "MOVIE" : null;
      if (s.itemType === "Episode") {
        tmdbId = await resolveShowTmdbId("jellyfin", s.seriesId, instance);
      } else {
        tmdbId = jellyfinProviderTmdbId(s.providerIds);
        if (tmdbId == null && s.itemId) {
          const lib = libMap.get(s.itemId);
          if (lib) {
            tmdbId = lib.tmdbId;
            mediaType = mediaType ?? lib.mediaType;
          }
        }
      }
      // A 0 or NaN id is no id.
      return { s, msUserId: userIds[i], tmdbId: tmdbId && !Number.isNaN(tmdbId) ? tmdbId : null, mediaType };
    }),
  );
}

type JellyfinTick = {
  instance: MediaInstanceKey;
  now: Date;
  existing: ExistingJellyfinRows;
  posters: ReadonlyMap<string, string | null>;
  seenSessionKeys: Set<string>;
};

async function writeJellyfinSession(tick: JellyfinTick, r: ResolvedJellyfinSession): Promise<SessionWriteOutcome> {
  const { s } = r;
  const sessionId = activeSessionId("jellyfin", tick.instance, s.playSessionId);
  const existing = matchExistingRow(tick, r, sessionId);

  if (existing) {
    // The matched row stands for a playback the server reports THIS tick, under
    // whatever key it was stored with. If its write below is lost (the CAS sees
    // another writer) the row keeps that old key, and the absence sweep must
    // not finalize a live session for it.
    tick.seenSessionKeys.add(existing.sessionKey);
    // Auto-play next episode: a Jellyfin client advancing to the next item can
    // reuse the same PlaySessionId while swapping the itemId. The update below
    // never rewrites title/sourceItemId/episode metadata/durationMs (write-once
    // at create; a 0 placeholder is backfilled once), so without finalizing here
    // the prior item's watch silently merges into the next episode's
    // PlayHistory row. Mirrors the Plex ratingKey-change branch: force-finalize
    // the previous item, then fall through to create a fresh row for the new one.
    if (existing.sourceItemId && s.itemId && existing.sourceItemId !== s.itemId) {
      // On failure the old row survives, so a create here either no-ops onto
      // it (same id) or opens a second row beside it. The next tick sees the
      // item change again and retries the finalize.
      if (!(await forceFinalizeSession(existing, tick.now, "itemId-change finalize", sessionId))) return "skipped";
    } else {
      return updateContinuing(tick, r, existing);
    }
  }
  return createJellyfinSession(tick, r, sessionId);
}

// An existing row's id may not match the Sessions API's current PlaySessionId or s.Id
// for the same playback (the id changes, and rows from the old, since-removed Jellyfin
// webhook were keyed differently). Fall back to (userId, itemId) so we update that row
// instead of creating a duplicate; the update then rewrites the row's sessionKey to
// the API's playSessionId so later polls find it directly. The fallback row is
// single-use: two brand-new streams of the same item by the same account in one tick
// would otherwise both adopt the one prior row, and the loser would never create its
// own — losing that watch entirely. This runs in the synchronous prefix of each
// write (writeEachSession calls them in order), so the delete is seen by the next
// session's lookup.
function matchExistingRow(tick: JellyfinTick, r: ResolvedJellyfinSession, sessionId: string): ActiveSession | undefined {
  const { s } = r;
  const altSessionId = s.sessionId && s.sessionId !== s.playSessionId ? activeSessionId("jellyfin", tick.instance, s.sessionId) : null;
  const { byId, byKey, byUserItem } = tick.existing;
  const idMatch =
    byId.get(sessionId) ??
    (altSessionId ? byId.get(altSessionId) : undefined) ??
    byKey.get(s.playSessionId) ??
    (s.sessionId ? byKey.get(s.sessionId) : undefined);
  if (idMatch) return idMatch;
  const fallbackKey = `${r.msUserId}:${s.itemId ?? ""}`;
  const fallbackRow = byUserItem.get(fallbackKey);
  if (fallbackRow) byUserItem.delete(fallbackKey);
  return fallbackRow;
}

const ticksToMs = (ticks: number) => Math.floor(ticks / 10_000);

function posterFor(tick: JellyfinTick, r: ResolvedJellyfinSession): string | null {
  return posterOf(tick.posters, r.tmdbId, r.mediaType);
}

async function updateContinuing(tick: JellyfinTick, r: ResolvedJellyfinSession, existing: ActiveSession): Promise<SessionWriteOutcome> {
  const { s, tmdbId, mediaType } = r;
  const positionMs = ticksToMs(s.positionTicks);
  const durationMs = ticksToMs(s.durationTicks);
  const posterPath = posterFor(tick, r);
  // computePlaytimeIncrement looks at the PRIOR state (existing.state), not
  // the new one: a session paused for the whole interval that resumed in the
  // last millisecond must not be credited the full interval as watch time.
  // The Plex pass uses the same helper.
  const increment = computePlaytimeIncrement(existing, tick.now);
  // CAS on (id, lastSeenAt), like the Plex pass: if the row was deleted or
  // rewritten between the prefetch and this write — an overlapping tick (poll
  // >5s), the same run's absence finalize, or cleanupStaleSessions — updateMany
  // returns 0 and the session is skipped (not counted) instead of a P2025
  // rejecting the batch. The next poll re-reads state and resumes.
  const written = await prisma.activeSession.updateMany({
    where: { id: existing.id, lastSeenAt: existing.lastSeenAt },
    data: {
      sessionKey: s.playSessionId,
      lastSeenAt: tick.now,
      state: s.state,
      progressPercent: progressPercentOf(positionMs, durationMs),
      progressMs: BigInt(positionMs),
      playMethod: s.playMethod,
      resolution: s.resolution ?? null,
      transcodeReason: s.transcodeReason ?? null,
      // Jellyfin's bitrate is play-method dependent (TranscodingInfo.Bitrate
      // when transcoding, the source total on DirectPlay — jellyfin.ts), and
      // DELIVERED_KBPS_SQL (guardrail 19a) bills the stored value for every
      // Jellyfin row. A mid-stream DirectPlay→Transcode fallback that only
      // refreshed playMethod finalized as a transcode billed at the SOURCE
      // bitrate (10x the bytes that left the server). undefined leaves the
      // stored value alone when the payload carries none.
      bitrate: s.bitrate ?? undefined,
      ...continuingUpdateFields({ existing, increment, durationMs, tmdbId, mediaType, posterPath }),
    },
  });
  return written.count > 0 ? "updated" : "skipped";
}

async function createJellyfinSession(tick: JellyfinTick, r: ResolvedJellyfinSession, sessionId: string): Promise<SessionWriteOutcome> {
  const { s, msUserId, tmdbId, mediaType } = r;
  const positionMs = ticksToMs(s.positionTicks);
  const durationMs = ticksToMs(s.durationTicks);
  // See the Plex pass: single-row createMany({skipDuplicates}) so overlapping
  // poll ticks can't reject each other on a duplicate insert; the loser's
  // count is 0 and it counts nothing.
  const created = await prisma.activeSession.createMany({
    data: [{
      id: sessionId,
      source: "jellyfin",
      serverInstance: tick.instance,
      sessionKey: s.playSessionId,
      startedAt: tick.now,
      lastSeenAt: tick.now,
      state: s.state,
      mediaServerUserId: msUserId,
      serverUsername: s.userName,
      tmdbId,
      mediaType,

      title: s.itemType === "Episode" ? (s.seriesName ?? s.title) : s.title,
      year: s.year != null ? String(s.year) : null,
      seasonNumber: s.seasonNumber ?? null,
      episodeNumber: s.episodeNumber ?? null,
      episodeTitle: s.itemType === "Episode" ? stripShowPrefix(s.title, s.seriesName) : null,
      sourceItemId: s.itemId,
      // See the Plex pass's create.
      sourceShowId: s.itemType === "Episode" ? (s.seriesId || null) : null,
      posterPath: posterFor(tick, r),
      progressPercent: progressPercentOf(positionMs, durationMs),
      progressMs: BigInt(positionMs),
      // Resume offset — see the Plex pass's create.
      startProgressMs: BigInt(positionMs),
      durationMs: BigInt(durationMs),
      platform: s.client ?? null,
      player: s.client ?? null,
      device: s.deviceName ?? null,
      ipAddress: s.remoteEndPoint ?? null,
      playMethod: s.playMethod ?? null,
      videoCodec: s.videoCodec ?? null,
      audioCodec: s.audioCodec ?? null,
      resolution: s.resolution ?? null,
      bitrate: s.bitrate ?? null,
      container: s.container ?? null,
      transcodeReason: s.transcodeReason ?? null,
    }],
    skipDuplicates: true,
  });
  return created.count > 0 ? "started" : "skipped";
}
