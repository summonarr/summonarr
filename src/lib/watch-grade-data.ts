import { Prisma } from "@/generated/prisma";
import { prisma } from "@/lib/prisma";
import { isFeatureEnabled } from "@/lib/features";
import { getWatchedThreshold, isPlayHistoryEnabled, isSourceEnabled } from "@/lib/play-history";
import { resolveAccountMediaIdentities, type AccountMediaIdentity } from "@/lib/my-watch-history";
import {
  emptyWatchGradeSummary,
  gradeUser,
  parseWatchGradeSettings,
  MIN_GRADED_REQUESTS,
  WATCH_GRADE_SETTING_KEYS,
  type GradableRequest,
  type RequestPlayUnit,
  type UserWatchGrade,
  type WatchGradeDetail,
  type WatchGradeIdentity,
  type WatchGradeSettings,
  type WatchGradeSummary,
} from "@/lib/watch-grade";

// Data half of the request watch grade (the rules are in watch-grade.ts). Admin
// surfaces only — every caller sits behind MANAGE_USERS or MANAGE_REQUESTS, and
// this module deliberately takes arbitrary user ids, unlike the self-service
// my-watch-history.ts, whose readers can only ever name themselves.
//
// Per call, independent of how many users are graded:
//   settings + feature flag (both memoized upstream)
//   1 MediaRequest read (the fulfilled requests in the window)
//   2 identity reads (resolveAccountMediaIdentities — the shared linkage rule)
//   ≤2 point reads for when each tracked source's history begins
//   1 play aggregate + 1 episode-count aggregate per REQUEST_CHUNK requests

export const WATCH_GRADE_FEATURE_KEY = "feature.behavior.watchGrades";

// Bounds one aggregate's bind count (request ids + two per identity link), well
// under Postgres' 65,535-parameter ceiling.
const REQUEST_CHUNK = 5_000;

// The detail endpoint's row cap. The summary is computed over EVERY request —
// only the listing is trimmed.
export const MAX_VERDICT_ROWS = 500;

type MediaSource = "plex" | "jellyfin";
const MEDIA_SOURCES: MediaSource[] = ["plex", "jellyfin"];

export type WatchGradeAvailability =
  | {
      enabled: true;
      settings: WatchGradeSettings;
      trackedSources: MediaSource[];
      watchedThresholdPercent: number;
    }
  | { enabled: false; reason: "feature-off" | "tracking-off" };

export async function getWatchGradeAvailability(): Promise<WatchGradeAvailability> {
  if (!(await isFeatureEnabled(WATCH_GRADE_FEATURE_KEY))) return { enabled: false, reason: "feature-off" };
  // A grade computed while tracking is off decays with every request fulfilled
  // after tracking stopped — hide it rather than show a number going stale.
  if (!(await isPlayHistoryEnabled())) return { enabled: false, reason: "tracking-off" };
  const trackedSources: MediaSource[] = [];
  for (const source of MEDIA_SOURCES) {
    if (await isSourceEnabled(source)) trackedSources.push(source);
  }
  if (trackedSources.length === 0) return { enabled: false, reason: "tracking-off" };

  const [rows, watchedThresholdPercent] = await Promise.all([
    prisma.setting.findMany({
      where: { key: { in: Object.values(WATCH_GRADE_SETTING_KEYS) } },
      select: { key: true, value: true },
    }),
    getWatchedThreshold(),
  ]);
  const settings = parseWatchGradeSettings(Object.fromEntries(rows.map((r) => [r.key, r.value])));
  return { enabled: true, settings, trackedSources, watchedThresholdPercent };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Which identity the grader sees for an account. Sources come from the linked
// rows AND the provider subjects; only currently-tracked sources count, and
// coverage starts when history began on the LATEST of them — a request fulfilled
// before every server the user watches on was being recorded may have been
// watched where nothing was looking, so it stays unscored. A tracked source with
// no history at all doesn't hold coverage back: nobody has watched anything
// there yet.
function identityFor(
  identity: AccountMediaIdentity | undefined,
  trackedSources: MediaSource[],
  historyStart: Map<MediaSource, Date | null>,
): WatchGradeIdentity {
  if (!identity || (identity.linked.length === 0 && identity.subjects.length === 0)) {
    return { kind: "unlinked" };
  }
  const sources = new Set<string>([...identity.linked.map((l) => l.source), ...identity.subjects]);
  const inUse = trackedSources.filter((s) => sources.has(s));
  if (inUse.length === 0) return { kind: "untracked" };
  let coverageStart: Date | null = null;
  for (const source of inUse) {
    const start = historyStart.get(source) ?? null;
    if (start && (!coverageStart || start > coverageStart)) coverageStart = start;
  }
  return { kind: "tracked", coverageStart };
}

interface PlayUnitRow {
  requestId: string;
  seasonNumber: number | null;
  episodeNumber: number | null;
  anyWatched: boolean;
  playSeconds: number;
  durationSeconds: number;
}

// The requester's plays of each requested title since the request, per episode.
// Joined against MediaRequest in SQL so the "since the request" bound is applied
// per row rather than per title. Identity comes in as explicit (user, identity)
// pairs from resolveAccountMediaIdentities — the linkage rule is never restated
// in SQL.
async function loadPlayUnits(
  requestIds: string[],
  links: { userId: string; msuId: string }[],
): Promise<RequestPlayUnit[]> {
  if (requestIds.length === 0 || links.length === 0) return [];
  const linkValues = Prisma.join(links.map((l) => Prisma.sql`(${l.userId}::text, ${l.msuId}::text)`));
  const units: RequestPlayUnit[] = [];
  for (const ids of chunk(requestIds, REQUEST_CHUNK)) {
    const rows = await prisma.$queryRaw<PlayUnitRow[]>(Prisma.sql`
      SELECT r."id" AS "requestId",
             h."seasonNumber" AS "seasonNumber",
             h."episodeNumber" AS "episodeNumber",
             bool_or(h."watched" OR h."completed") AS "anyWatched",
             COALESCE(SUM(h."playDuration"), 0)::int AS "playSeconds",
             COALESCE(MAX(h."duration"), 0)::int AS "durationSeconds"
      FROM "MediaRequest" r
      JOIN (VALUES ${linkValues}) AS link("userId", "msuId") ON link."userId" = r."requestedBy"
      JOIN "PlayHistory" h
        ON h."mediaServerUserId" = link."msuId"
       AND h."tmdbId" = r."tmdbId"
       AND h."mediaType" = r."mediaType"
       AND h."startedAt" >= r."createdAt"
      WHERE r."id" IN (${Prisma.join(ids)})
      GROUP BY r."id", h."seasonNumber", h."episodeNumber"
    `);
    for (const row of rows) {
      units.push({
        requestId: row.requestId,
        seasonNumber: row.seasonNumber,
        episodeNumber: row.episodeNumber,
        anyWatched: row.anyWatched === true,
        playSeconds: Number(row.playSeconds) || 0,
        durationSeconds: Number(row.durationSeconds) || 0,
      });
    }
  }
  return units;
}

// Regular-season episodes held in the library per show, deduplicated across
// sources and servers (TVEpisodeCache accumulates every server's episodes into
// one namespace per source).
async function loadLibraryEpisodes(tmdbIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (const ids of chunk([...new Set(tmdbIds)], REQUEST_CHUNK)) {
    const rows = await prisma.$queryRaw<{ tmdbId: number; episodes: number }[]>(Prisma.sql`
      SELECT "tmdbId", COUNT(DISTINCT ("seasonNumber", "episodeNumber"))::int AS "episodes"
      FROM "TVEpisodeCache"
      WHERE "tmdbId" IN (${Prisma.join(ids)}) AND "seasonNumber" > 0
      GROUP BY "tmdbId"
    `);
    for (const row of rows) out.set(row.tmdbId, Number(row.episodes) || 0);
  }
  return out;
}

async function loadHistoryStart(sources: MediaSource[]): Promise<Map<MediaSource, Date | null>> {
  const starts = await Promise.all(
    sources.map((source) =>
      prisma.playHistory.findFirst({
        where: { source },
        orderBy: { startedAt: "asc" },
        select: { startedAt: true },
      }),
    ),
  );
  return new Map(sources.map((source, i) => [source, starts[i]?.startedAt ?? null]));
}

export interface WatchGradeComputation {
  availability: WatchGradeAvailability;
  // Every requested user id that exists, whether or not it has fulfilled requests.
  grades: Map<string, UserWatchGrade>;
}

// Grades `userIds` in one batch. `resolveIdentityForAll` also resolves identity
// for accounts with nothing fulfilled in the window — the detail view wants
// "not linked" vs "nothing to grade yet"; list surfaces skip that work, since an
// account with no fulfilled requests shows no chip either way.
export async function computeWatchGrades(
  userIds: string[],
  opts: { resolveIdentityForAll?: boolean; now?: Date } = {},
): Promise<WatchGradeComputation> {
  const grades = new Map<string, UserWatchGrade>();
  const availability = await getWatchGradeAvailability();
  const ids = [...new Set(userIds)];
  if (!availability.enabled || ids.length === 0) return { availability, grades };

  const { settings, trackedSources, watchedThresholdPercent } = availability;
  const now = opts.now ?? new Date();
  const windowStart = settings.windowDays > 0 ? new Date(now.getTime() - settings.windowDays * 86_400_000) : null;

  const requestRows = await prisma.mediaRequest.findMany({
    where: {
      requestedBy: { in: ids },
      status: "AVAILABLE",
      // Same fulfilment instant gradeUser reads: availableAt, else updatedAt.
      ...(windowStart
        ? { OR: [{ availableAt: { gte: windowStart } }, { availableAt: null, updatedAt: { gte: windowStart } }] }
        : {}),
    },
    select: {
      id: true,
      requestedBy: true,
      tmdbId: true,
      mediaType: true,
      title: true,
      releaseYear: true,
      posterPath: true,
      createdAt: true,
      availableAt: true,
      updatedAt: true,
    },
  });

  const requestsByUser = new Map<string, GradableRequest[]>();
  for (const r of requestRows) {
    const list = requestsByUser.get(r.requestedBy) ?? [];
    list.push({
      id: r.id,
      tmdbId: r.tmdbId,
      mediaType: r.mediaType,
      title: r.title,
      releaseYear: r.releaseYear,
      posterPath: r.posterPath,
      createdAt: r.createdAt,
      fulfilledAt: r.availableAt ?? r.updatedAt,
    });
    requestsByUser.set(r.requestedBy, list);
  }

  const identityUserIds = opts.resolveIdentityForAll ? ids : [...requestsByUser.keys()];
  const identities = await resolveAccountMediaIdentities(identityUserIds);

  const sourcesInUse = new Set<MediaSource>();
  for (const identity of identities.values()) {
    for (const source of trackedSources) {
      if (identity.subjects.includes(source) || identity.linked.some((l) => l.source === source)) {
        sourcesInUse.add(source);
      }
    }
  }
  const historyStart = await loadHistoryStart([...sourcesInUse]);

  // Plays are read through EVERY linked identity, tracked source or not: an old
  // watch on a server that is no longer tracked still happened.
  const links: { userId: string; msuId: string }[] = [];
  const identityByUser = new Map<string, WatchGradeIdentity>();
  for (const userId of identityUserIds) {
    const identity = identityFor(identities.get(userId), trackedSources, historyStart);
    identityByUser.set(userId, identity);
    if (identity.kind !== "tracked") continue;
    for (const l of identities.get(userId)?.linked ?? []) links.push({ userId, msuId: l.id });
  }

  const observableRequests = requestRows.filter((r) => identityByUser.get(r.requestedBy)?.kind === "tracked");
  const [units, libraryEpisodes] = await Promise.all([
    loadPlayUnits(
      observableRequests.map((r) => r.id),
      links,
    ),
    loadLibraryEpisodes(observableRequests.filter((r) => r.mediaType === "TV").map((r) => r.tmdbId)),
  ]);
  const unitsByUser = new Map<string, RequestPlayUnit[]>();
  const ownerOfRequest = new Map(requestRows.map((r) => [r.id, r.requestedBy]));
  for (const u of units) {
    const owner = ownerOfRequest.get(u.requestId);
    if (!owner) continue;
    const list = unitsByUser.get(owner) ?? [];
    list.push(u);
    unitsByUser.set(owner, list);
  }

  for (const userId of ids) {
    const identity = identityByUser.get(userId);
    if (!identity) {
      // List mode, nothing fulfilled in the window: nothing to grade, and the
      // linkage answer couldn't change an empty summary.
      grades.set(userId, { summary: emptyWatchGradeSummary(), verdicts: [] });
      continue;
    }
    grades.set(
      userId,
      gradeUser({
        requests: requestsByUser.get(userId) ?? [],
        units: unitsByUser.get(userId) ?? [],
        libraryEpisodes,
        identity,
        watchedThresholdPercent,
        settings,
        now,
      }),
    );
  }
  return { availability, grades };
}

// Summary per user for list surfaces (Users page, request queue). null when the
// feature is off or tracking is disabled — callers render no grade at all.
//
// A failure here also yields null rather than throwing: the grade is secondary
// information on pages whose real job is managing users and approving requests,
// and a broken aggregate must not take either page down with it. The detail
// endpoint calls computeWatchGrades directly and does surface the error.
export async function getWatchGradeSummaries(
  userIds: string[],
): Promise<Map<string, WatchGradeSummary> | null> {
  try {
    const { availability, grades } = await computeWatchGrades(userIds);
    if (!availability.enabled) return null;
    return new Map([...grades].map(([id, g]) => [id, g.summary]));
  } catch (err) {
    console.error("[watch-grade] summary load failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function getUserWatchGradeDetail(userId: string): Promise<WatchGradeDetail> {
  const { availability, grades } = await computeWatchGrades([userId], { resolveIdentityForAll: true });
  if (!availability.enabled) {
    return { enabled: false, reason: availability.reason, settings: null, grade: null, requests: [], truncated: false };
  }
  const grade = grades.get(userId);
  const verdicts = grade?.verdicts ?? [];
  return {
    enabled: true,
    reason: null,
    settings: {
      ...availability.settings,
      minGradedRequests: MIN_GRADED_REQUESTS,
      watchedThresholdPercent: availability.watchedThresholdPercent,
    },
    grade: grade?.summary ?? null,
    requests: verdicts.slice(0, MAX_VERDICT_ROWS),
    truncated: verdicts.length > MAX_VERDICT_ROWS,
  };
}
