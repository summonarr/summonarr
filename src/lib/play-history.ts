import { prisma } from "./prisma";
import type { ActiveSession, MediaType } from "@/generated/prisma";

const settingsCache = new Map<string, { value: string | null; expiresAt: number }>();
const SETTINGS_CACHE_TTL = 15_000;

const activityCache = new Map<string, { data: unknown; expiresAt: number }>();
const STATS_TTL = 5 * 60 * 1000;
const CALENDAR_TTL = 30 * 60 * 1000;
const REWATCHED_TTL = 10 * 60 * 1000;

async function getSetting(key: string): Promise<string | null> {
  const cached = settingsCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const row = await prisma.setting.findUnique({ where: { key } });
  const value = row?.value ?? null;
  settingsCache.set(key, { value, expiresAt: Date.now() + SETTINGS_CACHE_TTL });
  return value;
}

export async function isPlayHistoryEnabled(): Promise<boolean> {
  return (await getSetting("playHistoryEnabled")) === "true";
}

export async function isSourceEnabled(source: "plex" | "jellyfin"): Promise<boolean> {
  const key = source === "plex" ? "playHistoryPlexEnabled" : "playHistoryJellyfinEnabled";
  return (await getSetting(key)) === "true";
}

export async function getWatchedThreshold(): Promise<number> {
  const val = await getSetting("playHistoryWatchedThreshold");
  const parsed = val ? parseInt(val, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : 80;
}

// Cumulative-watch threshold for an arc to count as a completion in getMostPopularOnServer.
// Stricter than getWatchedThreshold (per-session) — a "completion" should mean they basically finished it.
export async function getCompletionThreshold(): Promise<number> {
  const val = await getSetting("playHistoryCompletionThreshold");
  const parsed = val ? parseInt(val, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : 90;
}

// Gap (days) between consecutive sessions on the same media that splits one arc from the next.
// A weekend chunked watch stays one arc; a months-later rewatch starts a new arc.
export async function getArcGapDays(): Promise<number> {
  const val = await getSetting("playHistoryArcGapDays");
  const parsed = val ? parseInt(val, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 365 ? parsed : 14;
}

export async function resolveShowTmdbId(
  source: "plex" | "jellyfin",
  showKey: string | null | undefined,
): Promise<number | null> {
  if (!showKey) return null;
  if (source === "plex") {
    const item = await prisma.plexLibraryItem.findFirst({
      where: { plexRatingKey: showKey, mediaType: "TV" },
      select: { tmdbId: true },
    });
    return item?.tmdbId ?? null;
  }
  const item = await prisma.jellyfinLibraryItem.findFirst({
    where: { jellyfinItemId: showKey, mediaType: "TV" },
    select: { tmdbId: true },
  });
  return item?.tmdbId ?? null;
}

export async function resolveMediaServerUser(params: {
  source: string;
  sourceUserId: string;
  username: string;
  email?: string | null;
  thumbUrl?: string | null;
}): Promise<string> {
  const { source, sourceUserId, username, email, thumbUrl } = params;

  let userId: string | null = null;
  if (email) {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true, mediaServer: true } });

    if (user && (!user.mediaServer || user.mediaServer.toLowerCase() === source.toLowerCase())) {
      userId = user.id;
    }
  }

  const record = await prisma.mediaServerUser.upsert({
    where: { source_sourceUserId: { source, sourceUserId } },
    create: {
      source,
      sourceUserId,
      username,
      email: email ?? null,
      thumbUrl: thumbUrl ?? null,
      userId,
    },
    update: {
      username,
      ...(email ? { email } : {}),
      ...(thumbUrl ? { thumbUrl } : {}),
      ...(userId ? { userId } : {}),
    },
    select: { id: true },
  });

  return record.id;
}

export function calculateWatched(
  playDurationMs: number,
  totalDurationMs: number,
  thresholdPercent: number,
): boolean {
  if (totalDurationMs <= 0) return false;
  return (playDurationMs / totalDurationMs) * 100 >= thresholdPercent;
}

const EXCLUDED_USERNAMES = new Set(["gadgetusaf_space"]);
const MIN_PLAY_DURATION_S = 90;
// Cap any single accumulation delta. Protects against missed events, machine sleep, or clock skew
// inflating playtime. cleanupStaleSessions(30) handles ghost sessions; this is the per-event guard.
export const MAX_PLAYTIME_DELTA_MS = 5 * 60 * 1000;

// Returns the bigint to add to ActiveSession.playtimeMs when applying an event at `now`.
// Only accumulates when the prior state was "playing" — pause/buffer/initial state contribute nothing.
export function computePlaytimeIncrement(
  session: Pick<ActiveSession, "state" | "lastSeenAt">,
  now: Date,
): bigint {
  if (session.state !== "playing") return BigInt(0);
  const delta = now.getTime() - session.lastSeenAt.getTime();
  if (delta <= 0) return BigInt(0);
  return BigInt(Math.min(MAX_PLAYTIME_DELTA_MS, delta));
}

// Build a finalized session to pass to recordCompletedSession. Callers that close a "live" session
// (webhook stop, polling-sync-detected end) use this so the trailing playtime between lastSeenAt and
// the close event is counted. cleanupStaleSessions skips this — a stale session has no signal it
// was still playing.
export function applyFinalTick(
  session: ActiveSession,
  now: Date,
  override?: { progressMs?: bigint; stoppedAt?: Date },
): ActiveSession {
  const increment = computePlaytimeIncrement(session, now);
  return {
    ...session,
    playtimeMs: session.playtimeMs + increment,
    ...(override?.progressMs !== undefined ? { progressMs: override.progressMs } : {}),
    ...(override?.stoppedAt ? { lastSeenAt: override.stoppedAt } : {}),
  };
}

export async function recordCompletedSession(session: ActiveSession): Promise<void> {
  const playDurationMs = Number(session.playtimeMs);
  const playDurationS = Math.max(0, Math.floor(playDurationMs / 1000));

  // recordCompletedSession must be called exactly once per session end — upsert on sourceSessionId enforces idempotency
  if (EXCLUDED_USERNAMES.has(session.serverUsername)) {
    await prisma.activeSession.delete({ where: { id: session.id } }).catch(() => {});
    return;
  }
  if (playDurationS < MIN_PLAY_DURATION_S) {
    await prisma.activeSession.delete({ where: { id: session.id } }).catch(() => {});
    return;
  }

  const threshold = await getWatchedThreshold();

  const totalDurationMs = Number(session.durationMs);
  const watched = calculateWatched(playDurationMs, totalDurationMs, threshold);

  const now = new Date();
  const stoppedAt = session.lastSeenAt > session.startedAt ? session.lastSeenAt : now;

  const totalElapsedS = Math.max(0, Math.floor((stoppedAt.getTime() - session.startedAt.getTime()) / 1000));
  const durationS = Math.max(0, Math.floor(totalDurationMs / 1000));
  const pausedDurationS = Math.max(0, totalElapsedS - playDurationS);

  const progressMs = Number(session.progressMs);
  const completionRatio = totalDurationMs > 0 ? progressMs / totalDurationMs : 0;

  const completed = completionRatio >= 0.95;

  let posterPath: string | null = null;
  if (session.tmdbId && session.mediaType) {
    const cacheKey = `${session.mediaType === "TV" ? "tv" : "movie"}:${session.tmdbId}:details`;
    const cacheRow = await prisma.tmdbCache.findUnique({ where: { key: cacheKey }, select: { data: true } }).catch(() => null);
    if (cacheRow) {
      try {
        const parsed = JSON.parse(cacheRow.data) as { posterPath?: string | null };
        posterPath = parsed.posterPath ?? null;
      } catch { }
    }
  }

  const historyData = {
    source: session.source,
    startedAt: session.startedAt,
    stoppedAt,
    duration: durationS,
    playDuration: playDurationS,
    pausedDuration: pausedDurationS,
    watched,
    completed,
    mediaServerUserId: session.mediaServerUserId,
    tmdbId: session.tmdbId,
    mediaType: session.mediaType as MediaType | null,
    title: session.title,
    year: session.year,
    posterPath,
    seasonNumber: session.seasonNumber,
    episodeNumber: session.episodeNumber,
    episodeTitle: session.episodeTitle,
    sourceSessionId: session.sessionKey,
    sourceItemId: session.sourceItemId,
    platform: session.platform,
    player: session.player,
    device: session.device,
    ipAddress: session.ipAddress,
    playMethod: session.playMethod,
    videoCodec: session.videoCodec,
    audioCodec: session.audioCodec,
    resolution: session.resolution,
    bitrate: session.bitrate,
    videoDecision: session.videoDecision,
    audioDecision: session.audioDecision,
    container: session.container,
  };

  await prisma.$transaction(async (tx) => {
    // update:{} means a duplicate webhook replay is a no-op — the first write wins
    await tx.playHistory.upsert({
      where: {
        source_sourceSessionId: { source: session.source, sourceSessionId: session.sessionKey },
      },
      create: historyData,
      update: {},
    });

    await tx.activeSession.delete({ where: { id: session.id } }).catch(() => {});
  });
}

export async function cleanupStaleSessions(maxAgeMinutes: number): Promise<void> {
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000);
  const stale = await prisma.activeSession.findMany({
    where: { lastSeenAt: { lt: cutoff } },
  });

  for (const session of stale) {
    try {
      await recordCompletedSession(session);
    } catch {

    }
  }
}

export async function purgeOldHistory(): Promise<number> {
  const val = await getSetting("playHistoryRetentionDays");
  const days = val ? parseInt(val, 10) : 0;
  if (!days || days <= 0) return 0;

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const result = await prisma.playHistory.deleteMany({
    where: { startedAt: { lt: cutoff } },
  });
  return result.count;
}

export async function getUserPlayStats(mediaServerUserId: string) {
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);

  const [
    totalPlays,
    totalWatchTime,
    recentPlays,
    topMedia,
    playsByDay,
    platformBreakdown,
    activityCalendar,
    avgSessionDurationRaw,
    transcodeRatioRaw,
    resolutionBreakdownRaw,
    userHeatmapRaw,
    deviceListRaw,
  ] = await Promise.all([
    // "plays" surfaces filter watched=true (sessions that crossed the configured threshold).
    // Raw counts are reserved for technical/resource analytics (codec, transcode, bitrate, avg session).
    prisma.playHistory.count({ where: { mediaServerUserId, watched: true } }),
    prisma.$queryRawUnsafe<{ hours: number | null }[]>(
      `SELECT (COALESCE(SUM("playDuration"), 0) / 3600.0)::float8 AS hours FROM "PlayHistory" WHERE "mediaServerUserId" = $1`,
      mediaServerUserId,
    ),
    prisma.playHistory.findMany({
      where: { mediaServerUserId },
      orderBy: { startedAt: "desc" },
      take: 50,
    }),
    prisma.$queryRawUnsafe<{ title: string; tmdbId: number | null; mediaType: string | null; count: bigint }[]>(
      `SELECT "title", "tmdbId", "mediaType"::text, COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE "mediaServerUserId" = $1 AND "watched" = true
       GROUP BY "title", "tmdbId", "mediaType" ORDER BY count DESC LIMIT 10`,
      mediaServerUserId,
    ),
    prisma.$queryRawUnsafe<{ day: string; count: bigint; hours: number }[]>(
      `SELECT to_char(date_trunc('day', "startedAt"), 'YYYY-MM-DD') AS day,
              COUNT(*) FILTER (WHERE "watched" = true)::bigint AS count,
              (COALESCE(SUM("playDuration"), 0) / 3600.0)::float8 AS hours
       FROM "PlayHistory"
       WHERE "mediaServerUserId" = $1 AND "startedAt" >= $2
       GROUP BY day ORDER BY day`,
      mediaServerUserId,
      ninetyDaysAgo,
    ),
    prisma.$queryRawUnsafe<{ platform: string | null; count: bigint }[]>(
      `SELECT "platform", COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE "mediaServerUserId" = $1 AND "watched" = true
       GROUP BY "platform" ORDER BY count DESC`,
      mediaServerUserId,
    ),
    prisma.$queryRawUnsafe<{ day: string; count: bigint }[]>(
      `SELECT to_char(date_trunc('day', "startedAt"), 'YYYY-MM-DD') AS day,
              COUNT(*)::bigint AS count
       FROM "PlayHistory"
       WHERE "mediaServerUserId" = $1 AND "watched" = true AND "startedAt" >= $2
       GROUP BY day ORDER BY day`,
      mediaServerUserId,
      oneYearAgo,
    ),
    prisma.$queryRawUnsafe<{ avg_secs: number | null }[]>(
      `SELECT AVG("playDuration")::float8 AS avg_secs FROM "PlayHistory" WHERE "mediaServerUserId" = $1`,
      mediaServerUserId,
    ),
    prisma.$queryRawUnsafe<{ method: string | null; count: bigint }[]>(
      `SELECT "playMethod" AS method, COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE "mediaServerUserId" = $1
       GROUP BY "playMethod" ORDER BY count DESC`,
      mediaServerUserId,
    ),
    prisma.$queryRawUnsafe<{ resolution: string | null; count: bigint }[]>(
      `SELECT "resolution", COUNT(*)::bigint AS count
       FROM "PlayHistory"
       WHERE "mediaServerUserId" = $1 AND "resolution" IS NOT NULL
       GROUP BY "resolution" ORDER BY count DESC LIMIT 8`,
      mediaServerUserId,
    ),
    prisma.$queryRawUnsafe<{ dow: number; hour: number; count: bigint }[]>(
      `SELECT EXTRACT(DOW FROM "startedAt")::int AS dow,
              EXTRACT(HOUR FROM "startedAt")::int AS hour,
              COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE "mediaServerUserId" = $1 AND "watched" = true
       GROUP BY dow, hour ORDER BY dow, hour`,
      mediaServerUserId,
    ),
    prisma.$queryRawUnsafe<{ device: string | null; count: bigint }[]>(
      `SELECT "device", COUNT(*)::bigint AS count
       FROM "PlayHistory"
       WHERE "mediaServerUserId" = $1 AND "watched" = true AND "device" IS NOT NULL
       GROUP BY "device" ORDER BY count DESC LIMIT 6`,
      mediaServerUserId,
    ),
  ]);

  return {
    totalPlays,
    totalWatchTimeHours: Math.round(Number(totalWatchTime[0]?.hours ?? 0) * 10) / 10,
    recentPlays,
    topMedia: topMedia.map((r) => ({ title: r.title, tmdbId: r.tmdbId, mediaType: r.mediaType, count: Number(r.count) })),
    playsByDay: playsByDay.map((r) => ({ day: r.day, count: Number(r.count), hours: Math.round(r.hours * 100) / 100 })),
    platformBreakdown: platformBreakdown.map((r) => ({ platform: r.platform ?? "Unknown", count: Number(r.count) })),
    activityCalendar: activityCalendar.map((r) => ({ day: r.day, count: Number(r.count) })),
    avgSessionDuration: Math.round(Number(avgSessionDurationRaw[0]?.avg_secs ?? 0)),
    transcodeRatio: transcodeRatioRaw.map((r) => ({ method: r.method ?? "Unknown", count: Number(r.count) })),
    resolutionBreakdown: resolutionBreakdownRaw.map((r) => ({ resolution: r.resolution!, count: Number(r.count) })),
    userHeatmap: userHeatmapRaw.map((r) => ({ dow: r.dow, hour: r.hour, count: Number(r.count) })),
    deviceList: deviceListRaw.map((r) => ({ device: r.device!, count: Number(r.count) })),
  };
}

export async function getMediaPlayStats(tmdbId: number) {
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  const [
    totalPlays,
    uniqueViewers,
    avgCompletion,
    topViewers,
    recentPlays,
    mediaInfo,
    playsByDayRaw,
    transcodeRatioRaw,
    resolutionBreakdownRaw,
  ] = await Promise.all([
    prisma.playHistory.count({ where: { tmdbId, watched: true } }),
    prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(DISTINCT "mediaServerUserId")::bigint AS count FROM "PlayHistory" WHERE "tmdbId" = $1 AND "watched" = true`,
      tmdbId,
    ),
    prisma.$queryRawUnsafe<{ avg_pct: number | null }[]>(
      `SELECT AVG(
         CASE WHEN "duration" > 0 THEN ("playDuration"::float / "duration") * 100 ELSE 0 END
       )::float8 AS avg_pct
       FROM "PlayHistory" WHERE "tmdbId" = $1`,
      tmdbId,
    ),
    prisma.$queryRawUnsafe<{ id: string; username: string; source: string; count: bigint; hours: number }[]>(
      `SELECT m."id", m."username", m."source", COUNT(*)::bigint AS count,
              (COALESCE(SUM(p."playDuration"), 0) / 3600.0)::float8 AS hours
       FROM "PlayHistory" p JOIN "MediaServerUser" m ON m."id" = p."mediaServerUserId"
       WHERE p."tmdbId" = $1 AND p."watched" = true
       GROUP BY m."id", m."username", m."source"
       ORDER BY count DESC LIMIT 20`,
      tmdbId,
    ),
    prisma.playHistory.findMany({
      where: { tmdbId },
      orderBy: { startedAt: "desc" },
      take: 50,
      include: {
        mediaServerUser: {
          select: { username: true, source: true },
        },
      },
    }),
    prisma.playHistory.findFirst({
      where: { tmdbId },
      orderBy: { startedAt: "desc" },
      select: { title: true, mediaType: true, year: true },
    }),
    prisma.$queryRawUnsafe<{ day: string; count: bigint }[]>(
      `SELECT to_char(date_trunc('day', "startedAt"), 'YYYY-MM-DD') AS day,
              COUNT(*)::bigint AS count
       FROM "PlayHistory"
       WHERE "tmdbId" = $1 AND "watched" = true AND "startedAt" >= $2
       GROUP BY day ORDER BY day`,
      tmdbId,
      ninetyDaysAgo,
    ),
    prisma.$queryRawUnsafe<{ method: string | null; count: bigint }[]>(
      `SELECT "playMethod" AS method, COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE "tmdbId" = $1
       GROUP BY "playMethod" ORDER BY count DESC`,
      tmdbId,
    ),
    prisma.$queryRawUnsafe<{ resolution: string | null; count: bigint }[]>(
      `SELECT "resolution", COUNT(*)::bigint AS count
       FROM "PlayHistory"
       WHERE "tmdbId" = $1 AND "resolution" IS NOT NULL
       GROUP BY "resolution" ORDER BY count DESC`,
      tmdbId,
    ),
  ]);

  let resolvedMedia: { title: string | null; mediaType: MediaType | null; year: string | null } = {
    title: mediaInfo?.title ?? null,
    mediaType: mediaInfo?.mediaType ?? null,
    year: mediaInfo?.year ?? null,
  };
  if (!mediaInfo) {
    const [plexFallback, jellyfinFallback] = await Promise.all([
      prisma.plexLibraryItem.findFirst({ where: { tmdbId }, select: { title: true, mediaType: true, year: true } }),
      prisma.jellyfinLibraryItem.findFirst({ where: { tmdbId }, select: { title: true, mediaType: true, year: true } }),
    ]);
    const fallback = plexFallback ?? jellyfinFallback;
    if (fallback) resolvedMedia = fallback;
  }

  return {
    totalPlays,
    uniqueViewers: Number(uniqueViewers[0]?.count ?? 0),
    avgCompletion: Math.round(Number(avgCompletion[0]?.avg_pct ?? 0)),
    topViewers: topViewers.map((r) => ({
      id: r.id,
      username: r.username,
      source: r.source,
      count: Number(r.count),
      hours: Math.round(Number(r.hours) * 10) / 10,
    })),
    recentPlays,
    title: resolvedMedia.title ?? `TMDB ${tmdbId}`,
    mediaType: resolvedMedia.mediaType,
    year: resolvedMedia.year,
    playsByDay: playsByDayRaw.map((r) => ({ day: r.day, count: Number(r.count) })),
    transcodeRatio: transcodeRatioRaw.map((r) => ({ method: r.method ?? "Unknown", count: Number(r.count) })),
    resolutionBreakdown: resolutionBreakdownRaw.map((r) => ({ resolution: r.resolution!, count: Number(r.count) })),
  };
}

export async function getAllUsersStats() {
  const rows = await prisma.$queryRaw<
    {
      id: string;
      username: string;
      source: string;
      thumbUrl: string | null;
      createdAt: Date;
      plays: bigint;
      hours: number | null;
      lastActive: Date | null;
      favPlatform: string | null;
      direct: bigint;
      transcodes: bigint;
    }[]
  >`
    SELECT
      m."id",
      m."username",
      m."source",
      m."thumbUrl",
      m."createdAt",
      COUNT(p."id") FILTER (WHERE p."watched" = true)::bigint AS plays,
      (COALESCE(SUM(p."playDuration"), 0) / 3600.0)::float8 AS hours,
      MAX(p."startedAt") AS "lastActive",
      (SELECT p2."platform"
       FROM "PlayHistory" p2
       WHERE p2."mediaServerUserId" = m."id" AND p2."platform" IS NOT NULL AND p2."watched" = true
       GROUP BY p2."platform"
       ORDER BY COUNT(*) DESC
       LIMIT 1) AS "favPlatform",
      COUNT(p."id") FILTER (WHERE p."playMethod" = 'DirectPlay')::bigint AS direct,
      COUNT(p."id") FILTER (WHERE p."playMethod" = 'Transcode')::bigint AS transcodes
    FROM "MediaServerUser" m
    LEFT JOIN "PlayHistory" p ON p."mediaServerUserId" = m."id"
    GROUP BY m."id", m."username", m."source", m."thumbUrl", m."createdAt"
    ORDER BY plays DESC
  `;

  return rows.map((r) => {
    const plays = Number(r.plays);
    const direct = Number(r.direct);
    const transcodes = Number(r.transcodes);
    const totalWithMethod = direct + transcodes;
    return {
      id: r.id,
      username: r.username,
      source: r.source,
      thumbUrl: r.thumbUrl,
      createdAt: r.createdAt,
      plays,
      hours: Math.round(Number(r.hours ?? 0) * 10) / 10,
      lastActive: r.lastActive,
      favPlatform: r.favPlatform,
      directPct: totalWithMethod > 0 ? Math.round((direct / totalWithMethod) * 100) : null,
      transcodePct: totalWithMethod > 0 ? Math.round((transcodes / totalWithMethod) * 100) : null,
    };
  });
}

export type PopularSort = "plays" | "viewers" | "trending";

export const POPULAR_PER_PAGE = 40;

type PopularItem = {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  title: string;
  year: string | null;
  plays: number;
  allTimePlays: number;
  viewers: number;
  episodes: number;
  totalHours: number;
};

type PopularResult = {
  items: PopularItem[];
  totalItems: number;
  totalPages: number;
  page: number;
};

const POPULAR_CACHE_TTL_MS = 5 * 60 * 1000;
const popularCache = new Map<string, { data: PopularResult; expiresAt: number }>();

// Popularity counts *completed arcs*, not raw sessions. An "arc" is a run of consecutive
// sessions on the same (user, tmdbId, season, episode) that hasn't been broken by either
// a `completed=true` finish (a rewatch boundary) or a gap longer than playHistoryArcGapDays.
// For TV the unit is per-episode; show-level "plays" sum across episodes.
// totalHours and episodes are computed from raw sessions so partial sittings still contribute.
export async function getMostPopularOnServer(
  opts: { mediaType?: "MOVIE" | "TV"; sort?: PopularSort; page?: number; limit?: number } = {},
): Promise<PopularResult> {
  const { mediaType, sort = "plays", page = 1, limit = POPULAR_PER_PAGE } = opts;

  const cacheKey = JSON.stringify({ mediaType, sort, page, limit });
  const cached = popularCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const [completionPct, arcGapDays] = await Promise.all([
    getCompletionThreshold(),
    getArcGapDays(),
  ]);
  const completionRatio = completionPct / 100;
  const arcGapSeconds = arcGapDays * 24 * 60 * 60;

  const params: unknown[] = [];

  const baseConditions: string[] = ['"tmdbId" IS NOT NULL'];
  if (mediaType) {
    params.push(mediaType);
    baseConditions.push(`"mediaType"::text = $${params.length}`);
  }
  const baseWhere = baseConditions.join(" AND ");

  params.push(arcGapSeconds);
  const arcGapIdx = params.length;

  params.push(completionRatio);
  const completionIdx = params.length;

  let trendingIdx: number | null = null;
  if (sort === "trending") {
    params.push(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
    trendingIdx = params.length;
  }

  const trendArcFilter = trendingIdx ? `FILTER (WHERE arc_started_at >= $${trendingIdx})` : "";
  const trendRawFilter = trendingIdx ? `FILTER (WHERE "startedAt" >= $${trendingIdx})` : "";
  const episodesFilter = trendingIdx
    ? `FILTER (WHERE "mediaType"::text = 'TV' AND "seasonNumber" IS NOT NULL AND "episodeNumber" IS NOT NULL AND "startedAt" >= $${trendingIdx})`
    : `FILTER (WHERE "mediaType"::text = 'TV' AND "seasonNumber" IS NOT NULL AND "episodeNumber" IS NOT NULL)`;
  const havingSql = trendingIdx ? `HAVING COUNT(*) ${trendArcFilter} > 0` : "";

  const orderBy =
    sort === "viewers" ? "viewers DESC, plays DESC" : "plays DESC, viewers DESC";

  params.push(limit);
  const limitIdx = params.length;
  params.push((page - 1) * limit);
  const offsetIdx = params.length;

  const sql = `
    WITH base AS (
      SELECT "mediaServerUserId", "tmdbId", "mediaType",
             "seasonNumber", "episodeNumber",
             "startedAt", "playDuration", "duration", "completed"
      FROM "PlayHistory"
      WHERE ${baseWhere}
    ),
    arc_flags AS (
      SELECT *,
        CASE
          WHEN LAG("startedAt") OVER w IS NULL
            OR EXTRACT(EPOCH FROM ("startedAt" - LAG("startedAt") OVER w)) >= $${arcGapIdx}
            OR LAG("completed") OVER w = true
          THEN 1 ELSE 0
        END AS arc_start
      FROM base
      WINDOW w AS (
        PARTITION BY "mediaServerUserId", "tmdbId", "mediaType",
                     COALESCE("seasonNumber", -1), COALESCE("episodeNumber", -1)
        ORDER BY "startedAt"
      )
    ),
    arc_ids AS (
      SELECT *,
        SUM(arc_start) OVER (
          PARTITION BY "mediaServerUserId", "tmdbId", "mediaType",
                       COALESCE("seasonNumber", -1), COALESCE("episodeNumber", -1)
          ORDER BY "startedAt"
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS arc_id
      FROM arc_flags
    ),
    arcs AS (
      SELECT "tmdbId", "mediaType", "mediaServerUserId",
             "seasonNumber", "episodeNumber", arc_id,
             SUM("playDuration") AS arc_play,
             MAX("duration") AS arc_dur,
             MIN("startedAt") AS arc_started_at
      FROM arc_ids
      GROUP BY "tmdbId", "mediaType", "mediaServerUserId",
               "seasonNumber", "episodeNumber", arc_id
    ),
    completed_arcs AS (
      SELECT *
      FROM arcs
      WHERE arc_dur > 0 AND (arc_play::float / arc_dur) >= $${completionIdx}
    ),
    session_aggregates AS (
      SELECT "tmdbId", "mediaType"::text AS "mediaType",
             MAX("title") AS title,
             MAX("year") AS year,
             (COUNT(DISTINCT ("seasonNumber", "episodeNumber")) ${episodesFilter})::bigint AS episodes,
             (COALESCE(SUM("playDuration") ${trendRawFilter}, 0) / 3600.0)::float8 AS "totalHours"
      FROM "PlayHistory"
      WHERE ${baseWhere}
      GROUP BY "tmdbId", "mediaType"
    ),
    popular AS (
      SELECT ca."tmdbId", ca."mediaType"::text AS "mediaType",
             sa.title, sa.year, sa.episodes, sa."totalHours",
             (COUNT(*) ${trendArcFilter})::bigint AS plays,
             COUNT(*)::bigint AS "allTimePlays",
             (COUNT(DISTINCT ca."mediaServerUserId") ${trendArcFilter})::bigint AS viewers
      FROM completed_arcs ca
      JOIN session_aggregates sa
        ON sa."tmdbId" = ca."tmdbId" AND sa."mediaType" = ca."mediaType"::text
      GROUP BY ca."tmdbId", ca."mediaType", sa.title, sa.year, sa.episodes, sa."totalHours"
      ${havingSql}
    )
    SELECT *,
           (COUNT(*) OVER ())::bigint AS total_items
    FROM popular
    ORDER BY ${orderBy}
    LIMIT $${limitIdx} OFFSET $${offsetIdx}
  `;

  const rows = await prisma.$queryRawUnsafe<
    {
      tmdbId: number;
      mediaType: string;
      title: string;
      year: string | null;
      plays: bigint;
      allTimePlays: bigint;
      viewers: bigint;
      episodes: bigint;
      totalHours: number;
      total_items: bigint;
    }[]
  >(sql, ...params);

  const totalItems = rows.length > 0 ? Number(rows[0].total_items) : 0;

  const result: PopularResult = {
    items: rows.map((r) => ({
      tmdbId: r.tmdbId,
      mediaType: r.mediaType as "MOVIE" | "TV",
      title: r.title,
      year: r.year,
      plays: Number(r.plays),
      allTimePlays: Number(r.allTimePlays),
      viewers: Number(r.viewers),
      episodes: Number(r.episodes ?? 0),
      totalHours: Math.round(Number(r.totalHours) * 10) / 10,
    })),
    totalItems,
    totalPages: Math.max(1, Math.ceil(totalItems / limit)),
    page,
  };

  popularCache.set(cacheKey, { data: result, expiresAt: Date.now() + POPULAR_CACHE_TTL_MS });
  return result;
}

export async function getMostRewatched(filters: PlayHistoryStatsFilters = {}, limit = 10) {
  const cacheKey = getCacheKey("rewatched", { ...filters, limit });
  const cached = getCached<Awaited<ReturnType<typeof getMostRewatchedUncached>>>(cacheKey);
  if (cached) return cached;

  const result = await getMostRewatchedUncached(filters, limit);
  setCached(cacheKey, result, REWATCHED_TTL);
  return result;
}

async function getMostRewatchedUncached(filters: PlayHistoryStatsFilters = {}, limit = 10) {
  const { where, params } = buildStatsFilters(filters);
  const limitIdx = params.length + 1;

  const rows = await prisma.$queryRawUnsafe<
    { tmdbId: number; mediaType: string; title: string; plays: bigint; viewers: bigint }[]
  >(
    `SELECT "tmdbId", "mediaType"::text, MAX("title") AS title,
            COUNT(*)::bigint AS plays,
            COUNT(DISTINCT "mediaServerUserId")::bigint AS viewers
     FROM "PlayHistory"
     WHERE ${where} AND "tmdbId" IS NOT NULL AND "watched" = true
     GROUP BY "tmdbId", "mediaType"
     HAVING COUNT(*) > 1
     ORDER BY plays DESC
     LIMIT $${limitIdx}`,
    ...params,
    limit,
  );

  return rows.map((r) => ({
    tmdbId: r.tmdbId,
    mediaType: r.mediaType,
    title: r.title,
    plays: Number(r.plays),
    viewers: Number(r.viewers),
  }));
}

export interface PlayHistoryStatsFilters {
  days?: number;
  source?: string;
  mediaType?: string;
}

// Parameters start at $1 here — callers that append further params must continue from params.length+1, not re-start at $1
function buildStatsFilters(filters: PlayHistoryStatsFilters, tableAlias = "") {
  const prefix = tableAlias ? `${tableAlias}.` : "";
  const conditions: string[] = [`${prefix}"startedAt" >= $1`];
  const params: unknown[] = [new Date(Date.now() - (filters.days ?? 30) * 24 * 60 * 60 * 1000)];

  const validSources = new Set(["plex", "jellyfin"]);
  if (filters.source && validSources.has(filters.source)) {
    params.push(filters.source);
    conditions.push(`${prefix}"source" = $${params.length}`);
  }

  const validMediaTypes = new Set(["MOVIE", "TV"]);
  if (filters.mediaType && validMediaTypes.has(filters.mediaType)) {
    params.push(filters.mediaType);
    conditions.push(`${prefix}"mediaType"::text = $${params.length}`);
  }

  return { where: conditions.join(" AND "), params };
}

type PlayHistoryStatsResult = {
  totalPlays: number;
  totalWatchTimeHours: number;
  playsByDay: { day: string; count: number }[];
  topUsers: { id: string; username: string; source: string; count: number }[];
  topMedia: { title: string; tmdbId: number | null; mediaType: string | null; count: number }[];
  transcodeRatio: { method: string; count: number }[];
  playsByPlatform: { platform: string; count: number }[];
  playsByHour: { hour: number; count: number }[];
  mediaTypeBreakdown: { type: string; count: number }[];
  watchTimeByDay: { day: string; hours: number }[];
  heatmap: { dow: number; hour: number; count: number }[];
  completionRate: number;
  completionBuckets: { bucket: string; count: number }[];
  avgBitrateMbps: number;
  totalBandwidthGB: number;
  bandwidthByDay: { day: string; gb: number }[];

  uniqueViewers: number;
  uniqueTitles: number;
  avgSessionMinutes: number;
  longestSessionMinutes: number;
  pauseRatio: number;
  peakConcurrent: number;

  uniqueViewersByDay: { day: string; count: number }[];
  playsByDow: { dow: number; count: number }[];

  resolutionBreakdown: { bucket: string; count: number }[];
  videoCodecBreakdown: { codec: string; count: number }[];
  audioCodecBreakdown: { codec: string; count: number }[];
  containerBreakdown: { container: string; count: number }[];
  bitrateBuckets: { bucket: string; count: number }[];
  transcodeReasons: { reason: string; count: number }[];

  topDevices: { device: string; count: number }[];
  topPlayers: { player: string; count: number }[];
  sourceSplit: { source: string; count: number }[];

  decadeBreakdown: { decade: string; count: number }[];
  topRewatched: { tmdbId: number; mediaType: string; title: string; plays: number; viewers: number }[];
  topEpisodes: { tmdbId: number | null; title: string; season: number | null; episode: number | null; episodeTitle: string | null; count: number }[];

  prevPeriod: { totalPlays: number; totalWatchTimeHours: number; uniqueViewers: number };
};

export async function getPlayHistoryStats(
  filters: PlayHistoryStatsFilters = {},
): Promise<PlayHistoryStatsResult> {
  const cacheKey = getCacheKey("stats", filters as Record<string, unknown>);
  const cached = getCached<PlayHistoryStatsResult>(cacheKey);
  if (cached) return cached;

  const result = await getPlayHistoryStatsUncached(filters);
  setCached(cacheKey, result, STATS_TTL);
  return result;
}

async function getPlayHistoryStatsUncached(filters: PlayHistoryStatsFilters = {}) {
  const { where, params } = buildStatsFilters(filters);
  const { where: joinWhere, params: joinParams } = buildStatsFilters(filters, "p");
  // "plays" surfaces use wwhere (filter watched=true); analytics surfaces (completion rate, codecs,
  // bitrate, bandwidth, peak concurrent) use the raw `where` so the denominator stays complete.
  const wwhere = `${where} AND "watched" = true`;
  const joinWWhere = `${joinWhere} AND p."watched" = true`;

  const days = filters.days ?? 30;
  const prevStart = new Date(Date.now() - days * 2 * 24 * 60 * 60 * 1000);
  const prevEnd = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const prevConditions: string[] = [`"startedAt" >= $1 AND "startedAt" < $2`];
  const prevParams: unknown[] = [prevStart, prevEnd];
  if (filters.source && ["plex", "jellyfin"].includes(filters.source)) {
    prevParams.push(filters.source);
    prevConditions.push(`"source" = $${prevParams.length}`);
  }
  if (filters.mediaType && ["MOVIE", "TV"].includes(filters.mediaType)) {
    prevParams.push(filters.mediaType);
    prevConditions.push(`"mediaType"::text = $${prevParams.length}`);
  }
  const prevWhere = prevConditions.join(" AND ");

  const [
    totalPlays,
    totalWatchTime,
    playsByDay,
    topUsers,
    topMedia,
    transcodeRatio,
    playsByPlatform,
    playsByHour,
    mediaTypeBreakdown,
    watchTimeByDay,
    heatmap,
    completionStats,
    completionBuckets,
    bitrateStats,
    bandwidthByDayRaw,
    summaryExtras,
    uniqueViewersByDay,
    playsByDow,
    resolutionBreakdown,
    videoCodecBreakdown,
    audioCodecBreakdown,
    containerBreakdown,
    bitrateBuckets,
    transcodeReasons,
    topDevices,
    topPlayers,
    sourceSplit,
    decadeBreakdown,
    topEpisodes,
    peakConcurrentRaw,
    prevPeriodStats,
    topRewatchedRaw,
  ] = await Promise.all([
    prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(*)::bigint AS count FROM "PlayHistory" WHERE ${wwhere}`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ hours: number | null }[]>(
      `SELECT (COALESCE(SUM("playDuration"), 0) / 3600.0)::float8 AS hours FROM "PlayHistory" WHERE ${where}`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ day: string; count: bigint }[]>(
      `SELECT to_char(date_trunc('day', "startedAt"), 'YYYY-MM-DD') AS day, COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${wwhere}
       GROUP BY day ORDER BY day`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ id: string; username: string; source: string; count: bigint }[]>(
      `WITH user_counts AS (
         SELECT m."id", m."username", m."source", COUNT(*)::bigint AS count
         FROM "PlayHistory" p JOIN "MediaServerUser" m ON m."id" = p."mediaServerUserId"
         WHERE ${joinWWhere}
         GROUP BY m."id", m."username", m."source"
       ), ranked AS (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY "source" ORDER BY "count" DESC) AS rn
         FROM user_counts
       )
       SELECT "id", "username", "source", "count"
       FROM ranked
       WHERE rn <= 10
       ORDER BY "count" DESC`,
      ...joinParams,
    ),
    prisma.$queryRawUnsafe<{ title: string; tmdbId: number | null; mediaType: string | null; count: bigint }[]>(
      `SELECT "title", "tmdbId", "mediaType"::text, COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${wwhere}
       GROUP BY "title", "tmdbId", "mediaType" ORDER BY count DESC LIMIT 10`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ method: string | null; count: bigint }[]>(
      `SELECT "playMethod" AS method, COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${where}
       GROUP BY "playMethod" ORDER BY count DESC`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ platform: string | null; count: bigint }[]>(
      `SELECT "platform", COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${wwhere}
       GROUP BY "platform" ORDER BY count DESC LIMIT 10`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ hour: number; count: bigint }[]>(
      `SELECT EXTRACT(HOUR FROM "startedAt")::int AS hour, COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${wwhere}
       GROUP BY hour ORDER BY hour`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ type: string; count: bigint }[]>(
      `SELECT "mediaType"::text AS type, COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${wwhere} AND "mediaType" IS NOT NULL
       GROUP BY "mediaType" ORDER BY count DESC`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ day: string; hours: number }[]>(
      `SELECT to_char(date_trunc('day', "startedAt"), 'YYYY-MM-DD') AS day,
              (COALESCE(SUM("playDuration"), 0) / 3600.0)::float8 AS hours
       FROM "PlayHistory" WHERE ${where}
       GROUP BY day ORDER BY day`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ dow: number; hour: number; count: bigint }[]>(
      `SELECT EXTRACT(DOW FROM "startedAt")::int AS dow,
              EXTRACT(HOUR FROM "startedAt")::int AS hour,
              COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${wwhere}
       GROUP BY dow, hour ORDER BY dow, hour`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ watched: bigint; total: bigint }[]>(
      `SELECT COUNT(*) FILTER (WHERE "watched" = true)::bigint AS watched,
              COUNT(*)::bigint AS total
       FROM "PlayHistory" WHERE ${where}`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ bucket: string; count: bigint }[]>(
      `SELECT CASE
         WHEN ("playDuration"::float / "duration") < 0.25 THEN '0-25%'
         WHEN ("playDuration"::float / "duration") < 0.50 THEN '25-50%'
         WHEN ("playDuration"::float / "duration") < 0.75 THEN '50-75%'
         ELSE '75-100%'
       END AS bucket, COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${where} AND "duration" > 0
       GROUP BY bucket ORDER BY bucket`,
      ...params,
    ),

    prisma.$queryRawUnsafe<{ avg_mbps: number | null; total_gb: number | null }[]>(
      `SELECT AVG(CASE WHEN "bitrate" > 100000 THEN "bitrate" / 1000.0 ELSE "bitrate" END / 1000.0)::float8 AS avg_mbps,
              (SUM(
                (CASE WHEN "bitrate" > 100000 THEN "bitrate" / 1000.0 ELSE "bitrate" END)::float8
                * "playDuration"::float8
              ) / 8.0 / 1024.0 / 1024.0)::float8 AS total_gb
       FROM "PlayHistory" WHERE ${where} AND "bitrate" IS NOT NULL AND "bitrate" > 0`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ day: string; gb: number }[]>(
      `SELECT to_char(date_trunc('day', "startedAt"), 'YYYY-MM-DD') AS day,
              (SUM(
                (CASE WHEN "bitrate" > 100000 THEN "bitrate" / 1000.0 ELSE "bitrate" END)::float8
                * "playDuration"::float8
              ) / 8.0 / 1024.0 / 1024.0)::float8 AS gb
       FROM "PlayHistory"
       WHERE ${where} AND "bitrate" IS NOT NULL AND "bitrate" > 0
       GROUP BY day ORDER BY day`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{
      unique_viewers: bigint;
      unique_titles: bigint;
      avg_session_s: number | null;
      longest_session_s: number | null;
      pause_ratio: number | null;
    }[]>(
      // unique_viewers/unique_titles are plays-semantic (filter watched). avg/longest/pause are
      // session analytics; keep across all sessions for honest "how long do people sit through this".
      `SELECT COUNT(DISTINCT "mediaServerUserId") FILTER (WHERE "watched" = true)::bigint AS unique_viewers,
              COUNT(DISTINCT "tmdbId") FILTER (WHERE "tmdbId" IS NOT NULL AND "watched" = true)::bigint AS unique_titles,
              COALESCE(AVG(NULLIF("playDuration", 0)), 0)::float8 AS avg_session_s,
              COALESCE(MAX("playDuration"), 0)::int AS longest_session_s,
              (COALESCE(SUM("pausedDuration"), 0)::float8
                / NULLIF(SUM("playDuration"), 0)::float8)::float8 AS pause_ratio
       FROM "PlayHistory" WHERE ${where}`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ day: string; count: bigint }[]>(
      `SELECT to_char(date_trunc('day', "startedAt"), 'YYYY-MM-DD') AS day,
              COUNT(DISTINCT "mediaServerUserId")::bigint AS count
       FROM "PlayHistory" WHERE ${wwhere}
       GROUP BY day ORDER BY day`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ dow: number; count: bigint }[]>(
      `SELECT EXTRACT(DOW FROM "startedAt")::int AS dow, COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${wwhere}
       GROUP BY dow ORDER BY dow`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ bucket: string; count: bigint }[]>(
      `SELECT CASE
         WHEN "resolution" IS NULL OR "resolution" = '' THEN 'Unknown'
         WHEN LOWER("resolution") LIKE '4k%' OR LOWER("resolution") LIKE '2160%' THEN '4K'
         WHEN LOWER("resolution") LIKE '1080%' THEN '1080p'
         WHEN LOWER("resolution") LIKE '720%' THEN '720p'
         WHEN LOWER("resolution") LIKE '576%'
           OR LOWER("resolution") LIKE '540%'
           OR LOWER("resolution") LIKE '480%'
           OR LOWER("resolution") = 'sd' THEN 'SD'
         ELSE 'Other'
       END AS bucket, COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${where}
       GROUP BY bucket ORDER BY count DESC`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ codec: string; count: bigint }[]>(
      `SELECT COALESCE(NULLIF(UPPER("videoCodec"), ''), 'Unknown') AS codec,
              COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${where}
       GROUP BY codec ORDER BY count DESC LIMIT 8`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ codec: string; count: bigint }[]>(
      `SELECT COALESCE(NULLIF(UPPER("audioCodec"), ''), 'Unknown') AS codec,
              COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${where}
       GROUP BY codec ORDER BY count DESC LIMIT 8`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ container: string; count: bigint }[]>(
      `SELECT COALESCE(NULLIF(LOWER("container"), ''), 'unknown') AS container,
              COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${where}
       GROUP BY container ORDER BY count DESC LIMIT 8`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ bucket: string; count: bigint }[]>(
      `SELECT CASE
         WHEN "bitrate" IS NULL OR "bitrate" <= 0 THEN 'Unknown'
         WHEN (CASE WHEN "bitrate" > 100000 THEN "bitrate"/1000000.0 ELSE "bitrate"/1000.0 END) < 2 THEN '<2 Mbps'
         WHEN (CASE WHEN "bitrate" > 100000 THEN "bitrate"/1000000.0 ELSE "bitrate"/1000.0 END) < 5 THEN '2-5 Mbps'
         WHEN (CASE WHEN "bitrate" > 100000 THEN "bitrate"/1000000.0 ELSE "bitrate"/1000.0 END) < 10 THEN '5-10 Mbps'
         WHEN (CASE WHEN "bitrate" > 100000 THEN "bitrate"/1000000.0 ELSE "bitrate"/1000.0 END) < 20 THEN '10-20 Mbps'
         WHEN (CASE WHEN "bitrate" > 100000 THEN "bitrate"/1000000.0 ELSE "bitrate"/1000.0 END) < 50 THEN '20-50 Mbps'
         ELSE '50+ Mbps'
       END AS bucket, COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${where}
       GROUP BY bucket ORDER BY count DESC`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ reason: string; count: bigint }[]>(
      `SELECT COALESCE(NULLIF("videoDecision", ''), 'Unknown') AS reason,
              COUNT(*)::bigint AS count
       FROM "PlayHistory"
       WHERE ${where} AND "playMethod" = 'Transcode'
       GROUP BY reason ORDER BY count DESC LIMIT 8`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ device: string; count: bigint }[]>(
      `SELECT COALESCE(NULLIF("device", ''), 'Unknown') AS device,
              COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${wwhere}
       GROUP BY device ORDER BY count DESC LIMIT 10`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ player: string; count: bigint }[]>(
      `SELECT COALESCE(NULLIF("player", ''), 'Unknown') AS player,
              COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${wwhere}
       GROUP BY player ORDER BY count DESC LIMIT 10`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ source: string; count: bigint }[]>(
      `SELECT "source", COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${wwhere}
       GROUP BY "source" ORDER BY count DESC`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ decade: string; count: bigint }[]>(
      `SELECT CASE
         WHEN "year" IS NULL OR "year" = '' THEN 'Unknown'
         WHEN "year" ~ '^[0-9]{4}' THEN (SUBSTRING("year", 1, 3) || '0s')
         ELSE 'Unknown'
       END AS decade, COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${wwhere}
       GROUP BY decade ORDER BY decade`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{
      tmdbId: number | null;
      title: string;
      season: number | null;
      episode: number | null;
      episodeTitle: string | null;
      count: bigint;
    }[]>(
      `SELECT "tmdbId", "title",
              "seasonNumber" AS season, "episodeNumber" AS episode,
              "episodeTitle", COUNT(*)::bigint AS count
       FROM "PlayHistory"
       WHERE ${wwhere} AND "mediaType"::text = 'TV'
         AND "seasonNumber" IS NOT NULL AND "episodeNumber" IS NOT NULL
       GROUP BY "tmdbId", "title", "seasonNumber", "episodeNumber", "episodeTitle"
       ORDER BY count DESC LIMIT 10`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ peak: number | null }[]>(
      `SELECT COALESCE(MAX(concurrent), 0)::int AS peak FROM (
         SELECT SUM(delta) OVER (ORDER BY t, delta DESC) AS concurrent
         FROM (
           SELECT "startedAt" AS t, 1 AS delta FROM "PlayHistory" WHERE ${where}
           UNION ALL
           SELECT "stoppedAt" AS t, -1 AS delta FROM "PlayHistory" WHERE ${where}
         ) events
       ) sweeps`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{
      plays: bigint;
      hours: number | null;
      viewers: bigint;
    }[]>(
      // Mirror current-period stance: plays/viewers filter watched, hours stays raw.
      `SELECT COUNT(*) FILTER (WHERE "watched" = true)::bigint AS plays,
              (COALESCE(SUM("playDuration"), 0) / 3600.0)::float8 AS hours,
              COUNT(DISTINCT "mediaServerUserId") FILTER (WHERE "watched" = true)::bigint AS viewers
       FROM "PlayHistory" WHERE ${prevWhere}`,
      ...prevParams,
    ),
    getMostRewatchedUncached(filters, 10),
  ]);

  const watchedCount = Number(completionStats[0]?.watched ?? 0);
  const totalCount = Number(completionStats[0]?.total ?? 0);
  const extras = summaryExtras[0];
  const avgSessionMinutes = extras ? Math.round((Number(extras.avg_session_s ?? 0) / 60) * 10) / 10 : 0;
  const longestSessionMinutes = extras ? Math.round(Number(extras.longest_session_s ?? 0) / 60) : 0;
  const pauseRatio = extras ? Math.round(Number(extras.pause_ratio ?? 0) * 1000) / 1000 : 0;
  const peakConcurrent = Number(peakConcurrentRaw[0]?.peak ?? 0);
  const prev = prevPeriodStats[0];

  return {
    totalPlays: Number(totalPlays[0]?.count ?? 0),
    totalWatchTimeHours: Math.round(Number(totalWatchTime[0]?.hours ?? 0) * 10) / 10,
    playsByDay: playsByDay.map((r) => ({ day: r.day, count: Number(r.count) })),
    topUsers: topUsers.map((r) => ({ id: r.id, username: r.username, source: r.source, count: Number(r.count) })),
    topMedia: topMedia.map((r) => ({ title: r.title, tmdbId: r.tmdbId, mediaType: r.mediaType, count: Number(r.count) })),
    transcodeRatio: transcodeRatio.map((r) => ({ method: r.method ?? "Unknown", count: Number(r.count) })),
    playsByPlatform: playsByPlatform.map((r) => ({ platform: r.platform ?? "Unknown", count: Number(r.count) })),
    playsByHour: playsByHour.map((r) => ({ hour: r.hour, count: Number(r.count) })),
    mediaTypeBreakdown: mediaTypeBreakdown.map((r) => ({ type: r.type, count: Number(r.count) })),
    watchTimeByDay: watchTimeByDay.map((r) => ({ day: r.day, hours: Math.round(r.hours * 100) / 100 })),
    heatmap: heatmap.map((r) => ({ dow: r.dow, hour: r.hour, count: Number(r.count) })),
    completionRate: totalCount > 0 ? Math.round((watchedCount / totalCount) * 100) : 0,
    completionBuckets: completionBuckets.map((r) => ({ bucket: r.bucket, count: Number(r.count) })),
    avgBitrateMbps: Math.round(Number(bitrateStats[0]?.avg_mbps ?? 0) * 10) / 10,
    totalBandwidthGB: Math.round(Number(bitrateStats[0]?.total_gb ?? 0) * 10) / 10,
    bandwidthByDay: bandwidthByDayRaw.map((r) => ({ day: r.day, gb: Math.round(r.gb * 100) / 100 })),
    uniqueViewers: Number(extras?.unique_viewers ?? 0),
    uniqueTitles: Number(extras?.unique_titles ?? 0),
    avgSessionMinutes,
    longestSessionMinutes,
    pauseRatio,
    peakConcurrent,
    uniqueViewersByDay: uniqueViewersByDay.map((r) => ({ day: r.day, count: Number(r.count) })),
    playsByDow: playsByDow.map((r) => ({ dow: r.dow, count: Number(r.count) })),
    resolutionBreakdown: resolutionBreakdown.map((r) => ({ bucket: r.bucket, count: Number(r.count) })),
    videoCodecBreakdown: videoCodecBreakdown.map((r) => ({ codec: r.codec, count: Number(r.count) })),
    audioCodecBreakdown: audioCodecBreakdown.map((r) => ({ codec: r.codec, count: Number(r.count) })),
    containerBreakdown: containerBreakdown.map((r) => ({ container: r.container, count: Number(r.count) })),
    bitrateBuckets: bitrateBuckets.map((r) => ({ bucket: r.bucket, count: Number(r.count) })),
    transcodeReasons: transcodeReasons.map((r) => ({ reason: r.reason, count: Number(r.count) })),
    topDevices: topDevices.map((r) => ({ device: r.device, count: Number(r.count) })),
    topPlayers: topPlayers.map((r) => ({ player: r.player, count: Number(r.count) })),
    sourceSplit: sourceSplit.map((r) => ({ source: r.source, count: Number(r.count) })),
    decadeBreakdown: decadeBreakdown.map((r) => ({ decade: r.decade, count: Number(r.count) })),
    topRewatched: topRewatchedRaw,
    topEpisodes: topEpisodes.map((r) => ({
      tmdbId: r.tmdbId,
      title: r.title,
      season: r.season,
      episode: r.episode,
      episodeTitle: r.episodeTitle,
      count: Number(r.count),
    })),
    prevPeriod: {
      totalPlays: Number(prev?.plays ?? 0),
      totalWatchTimeHours: Math.round(Number(prev?.hours ?? 0) * 10) / 10,
      uniqueViewers: Number(prev?.viewers ?? 0),
    },
  };
}

export async function getActivityCalendar(
  source?: string,
  mediaType?: string,
): Promise<{ day: string; count: number }[]> {
  const cacheKey = getCacheKey("calendar", { source, mediaType });
  const cached = getCached<{ day: string; count: number }[]>(cacheKey);
  if (cached) return cached;

  const result = await getActivityCalendarUncached(source, mediaType);
  setCached(cacheKey, result, CALENDAR_TTL);
  return result;
}

async function getActivityCalendarUncached(
  source?: string,
  mediaType?: string,
): Promise<{ day: string; count: number }[]> {
  // Parameters start at $1 (commit 803cd11 fixed an off-by-one where the filtered path incorrectly used $2)
  const filterParams: unknown[] = [];
  const filterClauses: string[] = [];

  if (source && ["plex", "jellyfin"].includes(source)) {
    filterClauses.push(`"source" = $${filterParams.length + 1}`);
    filterParams.push(source);
  }

  if (mediaType && ["MOVIE", "TV"].includes(mediaType)) {
    filterClauses.push(`"mediaType"::text = $${filterParams.length + 1}`);
    filterParams.push(mediaType);
  }

  const filterSql = filterClauses.length > 0 ? ` AND ${filterClauses.join(" AND ")}` : "";

  const result = await prisma.$queryRawUnsafe<{ day: string; count: bigint }[]>(
    `SELECT DATE("startedAt")::text AS day, COUNT(*)::bigint AS count
     FROM "PlayHistory"
     WHERE "startedAt" >= CURRENT_DATE - INTERVAL '364 days' AND "watched" = true${filterSql} -- 365 calendar days inclusive of today
     GROUP BY DATE("startedAt")
     ORDER BY day ASC`,
    ...filterParams,
  );

  return result.map((r) => ({ day: r.day, count: Number(r.count) }));
}

function getCacheKey(prefix: string, params: Record<string, unknown>): string {
  const parts = [prefix];
  if (params.days) parts.push(String(params.days));
  if (params.source) parts.push(String(params.source));
  if (params.mediaType) parts.push(String(params.mediaType));
  if (params.limit) parts.push(String(params.limit));
  return parts.join(":");
}

function getCached<T>(key: string): T | null {
  const entry = activityCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    activityCache.delete(key);
    return null;
  }
  return entry.data as T;
}

function setCached<T>(key: string, data: T, ttlMs: number): void {
  activityCache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

export function clearActivityCache(): void {
  activityCache.clear();
}

export async function warmActivityCache(): Promise<{ warmed: number }> {
  let warmed = 0;

  for (const days of [1, 7, 14, 30, 90]) {
    await getPlayHistoryStats({ days });
    warmed++;
  }

  await getActivityCalendar();
  warmed++;

  for (const days of [7, 14, 30]) {
    await getMostRewatched({ days }, 10);
    warmed++;
  }

  return { warmed };
}
