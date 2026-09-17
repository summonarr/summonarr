import { Prisma } from "@/generated/prisma";
import { prisma } from "@/lib/prisma";
import { isFeatureEnabled } from "@/lib/features";
import { getWatchedThreshold, isPlayHistoryEnabled, isSourceEnabled } from "@/lib/play-history";
import {
  resolveAccountMediaIdentities,
  resolveMediaServerUserOwners,
  type AccountMediaIdentity,
} from "@/lib/my-watch-history";
import {
  emptyWatchGradeSummary,
  gradeUser,
  parseWatchGradeFields,
  parseWatchGradeSettings,
  watchGradeSpread,
  WATCH_GRADE_SETTING_KEYS,
  type GradableRequest,
  type OtherViewerWatch,
  type RequestPlayUnit,
  type UserWatchGrade,
  type WatchGradeDetail,
  type WatchGradeIdentity,
  type WatchGradePreview,
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
//   1 MediaRequest read (the fulfilled requests in the window) + 1 approval
//   lookup per APPROVAL_TITLE_CHUNK titles among them with no approval of their own
//   2 identity reads (resolveAccountMediaIdentities — the shared linkage rule)
//   ≤2 point reads for when each tracked source's history begins
//   1 play aggregate + 1 episode-count aggregate per REQUEST_CHUNK requests
//   other viewers (unless turned off): 1 audience aggregate per REQUEST_CHUNK
//   requests that are scored and short of full credit + 2 owner reads
//   (resolveMediaServerUserOwners)

export const WATCH_GRADE_FEATURE_KEY = "feature.behavior.watchGrades";

// Bounds one aggregate's bind count (request ids + two per identity link), well
// under Postgres' 65,535-parameter ceiling.
const REQUEST_CHUNK = 5_000;

// The detail endpoint's row cap. The summary is computed over EVERY request —
// only the listing is trimmed.
export const MAX_VERDICT_ROWS = 500;

// Only APPROVED requests that became AVAILABLE are graded. AVAILABLE alone isn't
// enough: a library sync marks a PENDING request AVAILABLE when its title
// arrives, and nobody approved that request.
//
// Approval is a decision about a TITLE on an instance, so a request counts when
// it, or ANY request for the same title on the same instance, carries an
// approval (MediaRequest.approvedAt). The web queue approves every pending
// duplicate together, but Discord only offers the earliest one, the iOS app
// approves one request at a time, an auto-approved request leaves other people's
// pending duplicates alone, and a request made while its title is already
// approved copies that status without a decision of its own. All of those become
// AVAILABLE through the approved request, and its approval covers them. A
// declined request carries no approval, so it covers nothing.
//
// The grade and the preview's requester list both go through here, so they
// can't disagree about who has anything to grade.
type RequestTitle = { tmdbId: number; mediaType: "MOVIE" | "TV"; arrInstance: string };

// Bounds the OR list of one approval lookup.
const APPROVAL_TITLE_CHUNK = 1_000;

function titleKey(t: RequestTitle): string {
  return `${t.mediaType}:${t.tmdbId}:${t.arrInstance}`;
}

async function keepApprovedRequests<T extends RequestTitle & { approvedAt: Date | null }>(rows: T[]): Promise<T[]> {
  const lacking = new Map<string, RequestTitle>();
  for (const r of rows) {
    if (r.approvedAt === null) lacking.set(titleKey(r), { tmdbId: r.tmdbId, mediaType: r.mediaType, arrInstance: r.arrInstance });
  }
  if (lacking.size === 0) return rows;
  const titles = [...lacking.values()];
  const approved = new Set<string>();
  for (let i = 0; i < titles.length; i += APPROVAL_TITLE_CHUNK) {
    const found = await prisma.mediaRequest.findMany({
      where: { approvedAt: { not: null }, OR: titles.slice(i, i + APPROVAL_TITLE_CHUNK) },
      select: { tmdbId: true, mediaType: true, arrInstance: true },
      distinct: ["tmdbId", "mediaType", "arrInstance"],
    });
    for (const f of found) approved.add(titleKey(f));
  }
  return rows.filter((r) => r.approvedAt !== null || approved.has(titleKey(r)));
}

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

interface AudienceRow {
  requestId: string;
  msuId: string;
  seasonNumber: number | null;
  watched: number;
}

// EVERYONE's watches of each requested title since the request, per identity and
// season, as play history recorded them: for a movie, whether any play was
// flagged watched/completed; for a show, how many distinct episodes of the
// season were. One row per (request, identity, season) — never per episode, so
// a popular show's audience costs its viewers, not its viewers × episodes.
// Identities are mapped to people by the caller, so the linkage rule stays out
// of SQL here as well.
async function loadAudienceWatches(requestIds: string[]): Promise<AudienceRow[]> {
  const rows: AudienceRow[] = [];
  for (const ids of chunk(requestIds, REQUEST_CHUNK)) {
    const page = await prisma.$queryRaw<AudienceRow[]>(Prisma.sql`
      SELECT r."id" AS "requestId",
             h."mediaServerUserId" AS "msuId",
             h."seasonNumber" AS "seasonNumber",
             (CASE WHEN r."mediaType" = 'MOVIE'
                   THEN (CASE WHEN bool_or(h."watched" OR h."completed") THEN 1 ELSE 0 END)
                   ELSE COUNT(DISTINCT h."episodeNumber") FILTER (WHERE (h."watched" OR h."completed") AND h."episodeNumber" IS NOT NULL)
              END)::int AS "watched"
      FROM "MediaRequest" r
      JOIN "PlayHistory" h
        ON h."tmdbId" = r."tmdbId"
       AND h."mediaType" = r."mediaType"
       AND h."startedAt" >= r."createdAt"
      WHERE r."id" IN (${Prisma.join(ids)})
      GROUP BY r."id", r."mediaType", h."mediaServerUserId", h."seasonNumber"
    `);
    for (const row of page) {
      const watched = Number(row.watched) || 0;
      // Specials, plays with no season, and rows with nothing watched can't count.
      if (watched <= 0) continue;
      if (row.seasonNumber != null && row.seasonNumber <= 0) continue;
      rows.push({ requestId: row.requestId, msuId: row.msuId, seasonNumber: row.seasonNumber, watched });
    }
  }
  return rows;
}

// Other viewers per requester: the audience, each identity keyed by the PERSON
// it belongs to. One person's logins are merged per season by max — the same
// episode on two logins is one episode; different episodes on two logins are
// under-counted, never over. An identity with no account is keyed by its
// provider id, so one Plex account seen on two servers is still one person.
//
// The requester's own logins need no filtering here, by construction: a login
// whose plays were flagged watched gave the requester full credit through
// loadPlayUnits, and the audience is only ever read for requests short of full
// credit. (A row of theirs that reaches here has nothing flagged, or too few
// episodes for the share — so it never makes a viewer.)
async function loadOtherViewerWatches(
  requestIds: string[],
  ownerOfRequest: Map<string, string>,
): Promise<Map<string, OtherViewerWatch[]>> {
  const others = (await loadAudienceWatches(requestIds)).filter((row) => ownerOfRequest.has(row.requestId));
  const people = await resolveMediaServerUserOwners(others.map((r) => r.msuId));

  const merged = new Map<string, OtherViewerWatch>();
  for (const row of others) {
    const who = people.get(row.msuId);
    const viewer = who?.userId ? `user:${who.userId}` : who ? `identity:${who.source}:${who.sourceUserId}` : `identity:${row.msuId}`;
    const key = `${row.requestId}|${viewer}|${row.seasonNumber ?? ""}`;
    const existing = merged.get(key);
    if (existing) existing.watched = Math.max(existing.watched, row.watched);
    else merged.set(key, { requestId: row.requestId, viewer, seasonNumber: row.seasonNumber, watched: row.watched });
  }
  const out = new Map<string, OtherViewerWatch[]>();
  for (const w of merged.values()) {
    const requester = ownerOfRequest.get(w.requestId)!;
    const list = out.get(requester) ?? [];
    list.push(w);
    out.set(requester, list);
  }
  return out;
}

// Regular-season episodes held in the library per show and season, deduplicated
// across sources and servers (TVEpisodeCache accumulates every server's episodes
// into one namespace per source).
async function loadLibraryEpisodes(tmdbIds: number[]): Promise<Map<number, Map<number, number>>> {
  const out = new Map<number, Map<number, number>>();
  for (const ids of chunk([...new Set(tmdbIds)], REQUEST_CHUNK)) {
    const rows = await prisma.$queryRaw<{ tmdbId: number; seasonNumber: number; episodes: number }[]>(Prisma.sql`
      SELECT "tmdbId", "seasonNumber", COUNT(DISTINCT "episodeNumber")::int AS "episodes"
      FROM "TVEpisodeCache"
      WHERE "tmdbId" IN (${Prisma.join(ids)}) AND "seasonNumber" > 0
      GROUP BY "tmdbId", "seasonNumber"
    `);
    for (const row of rows) {
      const seasons = out.get(row.tmdbId) ?? new Map<number, number>();
      seasons.set(Number(row.seasonNumber), Number(row.episodes) || 0);
      out.set(row.tmdbId, seasons);
    }
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
// `settings` grades with values other than the stored ones — the settings
// preview. Availability (feature flag, tracking, watched threshold) still comes
// from what is in force.
export async function computeWatchGrades(
  userIds: string[],
  opts: { resolveIdentityForAll?: boolean; now?: Date; settings?: WatchGradeSettings } = {},
): Promise<WatchGradeComputation> {
  const grades = new Map<string, UserWatchGrade>();
  const availability = await getWatchGradeAvailability();
  const ids = [...new Set(userIds)];
  if (!availability.enabled || ids.length === 0) return { availability, grades };

  const { trackedSources, watchedThresholdPercent } = availability;
  const settings = opts.settings ?? availability.settings;
  const now = opts.now ?? new Date();
  const windowStart = settings.windowDays > 0 ? new Date(now.getTime() - settings.windowDays * 86_400_000) : null;

  const fulfilled = await prisma.mediaRequest.findMany({
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
      arrInstance: true,
      title: true,
      releaseYear: true,
      posterPath: true,
      createdAt: true,
      approvedAt: true,
      availableAt: true,
      updatedAt: true,
    },
  });
  const requestRows = await keepApprovedRequests(fulfilled);

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
  const observableIds = observableRequests.map((r) => r.id);
  const [units, libraryEpisodes] = await Promise.all([
    loadPlayUnits(observableIds, links),
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

  const gradeWith = (userId: string, identity: WatchGradeIdentity, otherWatches: OtherViewerWatch[]) =>
    gradeUser({
      requests: requestsByUser.get(userId) ?? [],
      units: unitsByUser.get(userId) ?? [],
      otherWatches,
      libraryEpisodes,
      identity,
      watchedThresholdPercent,
      settings,
      now,
    });

  // First pass: the requester's own watches. It also decides which requests the
  // other-viewers rule can still change — scored, and short of full credit — so
  // the audience is read for exactly those: a grace or untracked request is never
  // scored, and a watched one has nothing to gain.
  for (const userId of ids) {
    const identity = identityByUser.get(userId);
    if (!identity) {
      // List mode, nothing fulfilled in the window: nothing to grade, and the
      // linkage answer couldn't change an empty summary.
      grades.set(userId, { summary: emptyWatchGradeSummary("insufficient", settings.minGradedRequests), verdicts: [] });
      continue;
    }
    grades.set(userId, gradeWith(userId, identity, []));
  }
  if (settings.otherViewers <= 0) return { availability, grades };

  const needOthers: string[] = [];
  for (const grade of grades.values()) {
    for (const v of grade.verdicts) if (v.scoring === "scored" && v.credit < 1) needOthers.push(v.requestId);
  }
  if (needOthers.length === 0) return { availability, grades };

  const otherWatches = await loadOtherViewerWatches(needOthers, ownerOfRequest);
  for (const [userId, watches] of otherWatches) {
    const identity = identityByUser.get(userId);
    if (identity) grades.set(userId, gradeWith(userId, identity, watches));
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
    settings: { ...availability.settings, watchedThresholdPercent: availability.watchedThresholdPercent },
    grade: grade?.summary ?? null,
    requests: verdicts.slice(0, MAX_VERDICT_ROWS),
    truncated: verdicts.length > MAX_VERDICT_ROWS,
  };
}

// The settings a write of `incoming` would leave in force: each watch-grade key
// the body carries (blank = back to the default, as the form promises), the
// stored value for every key it doesn't. Per-field bounds only — callers run
// watchGradeCrossFieldError on the result, and the read-side repair in
// parseWatchGradeSettings would otherwise hide an out-of-order set of cutoffs.
// Shared by the settings save and the preview so both judge the same values.
export async function mergedWatchGradeSettings(incoming: Record<string, unknown>): Promise<WatchGradeSettings> {
  const keys = Object.values(WATCH_GRADE_SETTING_KEYS);
  const stored = await prisma.setting.findMany({ where: { key: { in: keys } }, select: { key: true, value: true } });
  const raw: Record<string, string | undefined> = Object.fromEntries(stored.map((r) => [r.key, r.value]));
  for (const key of keys) {
    const value = incoming[key];
    if (typeof value === "string") raw[key] = value.trim() === "" ? undefined : value.trim();
  }
  return parseWatchGradeFields(raw);
}

// How many users land on each letter today, and how many would with `proposed`.
// Everyone who has ever had an approved request fulfilled is graded, so a wider
// proposed window is judged against the same people as the current one.
export async function previewWatchGradeSpread(proposed: WatchGradeSettings): Promise<WatchGradePreview> {
  const availability = await getWatchGradeAvailability();
  if (!availability.enabled) {
    return { enabled: false, reason: availability.reason, requesters: 0, current: null, proposed: null };
  }
  // Requesters with an approved request of their own, then those whose only
  // fulfilled requests are covered by another request's approval of the title.
  const approvedOwn = await prisma.mediaRequest.findMany({
    where: { status: "AVAILABLE", approvedAt: { not: null } },
    distinct: ["requestedBy"],
    select: { requestedBy: true },
  });
  const unapproved = await prisma.mediaRequest.findMany({
    where: { status: "AVAILABLE", approvedAt: null },
    select: { requestedBy: true, tmdbId: true, mediaType: true, arrInstance: true, approvedAt: true },
  });
  const covered = await keepApprovedRequests(unapproved);
  const ids = [...new Set([...approvedOwn, ...covered].map((r) => r.requestedBy))];
  const now = new Date();
  // Sequential on purpose: two full grade runs at once would double the load on
  // the five-connection pool, for an answer nobody is waiting on mid-render.
  const current = await computeWatchGrades(ids, { now });
  const next = await computeWatchGrades(ids, { now, settings: proposed });
  return {
    enabled: true,
    reason: null,
    requesters: ids.length,
    current: watchGradeSpread([...current.grades.values()].map((g) => g.summary)),
    proposed: watchGradeSpread([...next.grades.values()].map((g) => g.summary)),
  };
}
