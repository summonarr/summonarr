// Schema fragments, responses and parameters more than one area of the
// OpenAPI document shares (src/lib/openapi/paths/*). A fragment only one
// area uses lives in that area's module.

import { ARR_ERROR_KIND_KEYS } from "@/lib/arr-error-kind";
import type { OpenApiSchema, OpenApiResponse, OpenApiResponses, OpenApiParameter, OpenApiSecurity } from "./types";

// `cached=1` on the admin Radarr/Sonarr READS that keep their last answer
// (`snapshotted`, src/lib/arr-snapshot.ts): a page opened again paints that
// answer at once, then reloads live. Display only — every action re-checks live
// on the server. Inlined like ARR_ERRORS: the in-app viewer resolves no $ref.
export const ARR_SNAPSHOT_PARAM = {
  name: "cached",
  in: "query",
  schema: { type: "string", enum: ["1"] },
  description:
    "`1` → the last answer kept for this exact read (same query, same language), at once and without asking " +
    "Radarr/Sonarr — 200 with the same body plus `X-Summonarr-Snapshot-At` (when it was read, ISO 8601), or 204 when " +
    "none is kept. Display only. A background-job poll (`job=`) is never kept.",
} satisfies OpenApiParameter;

export const ARR_SNAPSHOT_204 = {
  description: "`cached=1` and no answer is kept for this exact read yet (a restart starts empty; kept answers expire after 24 h). No body.",
} satisfies OpenApiResponse;

// Background jobs (the job registry in src/lib/release-search-jobs.ts and the
// routes built on it, guardrail 37a) answer 202 with a 32-hex job id: { job }
// when one starts (or the caller's identical job is joined), { job, running }
// on a `?job=` poll of one still running. One schema each, so the operations
// can't drift apart; each keeps its own description, the part the in-app viewer
// shows. (Fix-match's jobs are a separate registry with a uuid `jobId`.)
export const JOB_ID = { type: "string", pattern: "^[0-9a-f]{32}$" } satisfies OpenApiSchema;

export const JOB_STARTED = { type: "object", required: ["job"], properties: { job: JOB_ID } } satisfies OpenApiSchema;

export const JOB_RUNNING = {
  type: "object",
  required: ["job", "running"],
  properties: { job: JOB_ID, running: { type: "boolean", enum: [true] } },
} satisfies OpenApiSchema;

// A release-search GET both starts a search (`async=1`) and polls one (`?job=`).
export const SEARCH_JOB = {
  type: "object",
  required: ["job"],
  properties: {
    job: JOB_ID,
    running: { type: "boolean", enum: [true], description: "Only on a `?job=` poll of a search still running" },
  },
} satisfies OpenApiSchema;

export function jobAnswer(description: string, schema: OpenApiSchema): OpenApiResponse {
  return { description, content: { "application/json": { schema } } };
}

// Every /cron/* and /sync* operation goes through getCronActor/isCronAuthorized
// (src/lib/cron-auth.ts, guardrail 6): an ADMIN session — the cookie
// (same-origin) or a native bearer — OR the CRON_SECRET bearer.
export const ADMIN_OR_CRON_SECURITY: OpenApiSecurity = [{ session: [] }, { sessionBearer: [] }, { cronSecret: [] }];

// The per-title rating fields GET /ratings and POST /ratings/batch share — the
// MdblistRatings shape (src/lib/mdblist.ts); an OMDB-only title fills the fields
// it lacks with null.
export const RATING_FIELDS = {
  imdbId: { type: "string", nullable: true },
  imdbRating: { type: "string", nullable: true },
  imdbVotes: { type: "string", nullable: true },
  rottenTomatoes: { type: "string", nullable: true },
  rtAudienceScore: { type: "string", nullable: true },
  metacritic: { type: "string", nullable: true },
  traktRating: { type: "string", nullable: true },
  letterboxdRating: { type: "string", nullable: true },
  mdblistScore: { type: "string", nullable: true },
  malRating: { type: "string", nullable: true },
  rogerEbertRating: { type: "string", nullable: true },
} satisfies Record<string, OpenApiSchema>;

// The 13 per-user notification switches (User.notifyOn*/emailOn*/pushOn*): the
// profile's own preferences GET/PATCH, the admin user list and create, and the
// admin user PATCH all carry the same set.
export const NOTIFICATION_PREF_FLAGS = {
  notifyOnApproved: { type: "boolean" },
  notifyOnAvailable: { type: "boolean" },
  notifyOnDeclined: { type: "boolean" },
  emailOnApproved: { type: "boolean" },
  emailOnAvailable: { type: "boolean" },
  emailOnDeclined: { type: "boolean" },
  pushOnApproved: { type: "boolean" },
  pushOnAvailable: { type: "boolean" },
  pushOnDeclined: { type: "boolean" },
  notifyOnIssue: { type: "boolean" },
  notifyOnComment: { type: "boolean" },
  emailOnComment: { type: "boolean" },
  pushOnComment: { type: "boolean" },
} satisfies Record<string, OpenApiSchema>;

// One release of an interactive search — the projected ArrRelease (toArrRelease,
// src/lib/arr.ts) every release search answers: no download URL, and `guid`
// swapped for an opaque handle bound to that search (release-handles.ts), never
// the indexer's guid (guardrail 5e). The iOS app decodes this shape.
export const ARR_RELEASE = {
  type: "object",
  properties: {
    guid: { type: "string", pattern: "^[0-9a-f]{32}$", description: "Opaque handle — POST it back to grab" },
    title: { type: "string" },
    size: { type: "number" },
    indexerId: { type: "integer" },
    indexer: { type: "string" },
    quality: { type: "object", properties: { quality: { type: "object", properties: { id: { type: "integer" }, name: { type: "string" } } }, revision: { type: "object", properties: { version: { type: "integer" } } } } },
    qualityWeight: { type: "integer" },
    releaseWeight: { type: "integer", nullable: true, description: "The arr's own ranking for the title (0 = what it would grab first); the list is sorted by it" },
    customFormatScore: { type: "integer", nullable: true },
    customFormats: { type: "array", items: { type: "string" } },
    languages: { type: "array", items: { type: "string" } },
    protocol: { type: "string", enum: ["torrent", "usenet"] },
    seeders: { type: "integer", nullable: true },
    leechers: { type: "integer", nullable: true },
    age: { type: "integer", description: "Days" },
    rejected: { type: "boolean" },
    rejections: { type: "array", items: { type: "string" } },
    downloadAllowed: { type: "boolean" },
  },
} satisfies OpenApiSchema;

// Why a Radarr/Sonarr read failed (src/lib/arr-error-kind.ts) — the clients
// translate this, never the English error text.
export const ARR_ERROR_KINDS = Object.keys(ARR_ERROR_KIND_KEYS);

// A download's phase in the queue fold (QueuePhase, src/lib/arr-queue.ts).
export const QUEUE_PHASE = {
  type: "string",
  enum: ["downloading", "queued", "paused", "delay", "importPending", "importing", "importBlocked", "failed", "clientUnavailable", "unknown"],
} satisfies OpenApiSchema;

export const ARR_SERVICE = { type: "string", enum: ["radarr", "sonarr"] } satisfies OpenApiSchema;
// The `service` query parameter every per-service Radarr/Sonarr read takes.
export const ARR_SERVICE_PARAM = { name: "service", in: "query", required: true, schema: ARR_SERVICE } satisfies OpenApiParameter;

export const QUALITY_TAGS = { type: "array", items: { type: "string", enum: ["proper", "repack", "real"] } } satisfies OpenApiSchema;

export const PROTOCOL = { type: "string", enum: ["torrent", "usenet", "unknown"] } satisfies OpenApiSchema;

// One history record (ArrHistoryEvent, src/lib/arr-history.ts) — named fields
// only (guardrail 5e). The import and rename paths the admin page shows are
// projected too and left out here.
export const ARR_HISTORY_EVENT = {
  type: "object",
  properties: {
    id: { type: "integer" },
    service: ARR_SERVICE,
    instance: { type: "string" },
    kind: { type: "string", enum: ["grabbed", "imported", "failed", "deleted", "renamed", "ignored", "unknown"] },
    date: { type: "string", format: "date-time", nullable: true },
    sourceTitle: { type: "string", description: "The release name" },
    arrMediaId: { type: "integer", nullable: true, description: "Radarr movie id / Sonarr series id" },
    mediaTitle: { type: "string" },
    year: { type: "integer", nullable: true },
    tmdbId: { type: "integer", nullable: true },
    tvdbId: { type: "integer", nullable: true },
    episode: { type: "object", nullable: true, properties: { seasonNumber: { type: "integer" }, episodeNumber: { type: "integer" }, title: { type: "string" } } },
    episodeId: { type: "integer", nullable: true },
    quality: { type: "string", nullable: true },
    qualityTags: QUALITY_TAGS,
    languages: { type: "array", items: { type: "string" } },
    customFormats: { type: "array", items: { type: "string" } },
    customFormatScore: { type: "integer", nullable: true },
    indexer: { type: "string", nullable: true },
    releaseGroup: { type: "string", nullable: true },
    protocol: PROTOCOL,
    size: { type: "number", nullable: true },
    reason: { type: "string", nullable: true, description: "Why a file was deleted (Upgrade, MissingFromDisk, Manual)" },
    message: { type: "string", nullable: true, description: "A failure's or an ignore's message, credentials masked" },
  },
} satisfies OpenApiSchema;

// One file of a title as Radarr/Sonarr list it (TitleFile, src/lib/arr-title.ts).
// Its relative and absolute paths are projected too (ADMIN-only) and left out
// here, as ARR_HISTORY_EVENT leaves out its paths: an issue's file list shows
// none, and the title manager's adds only `relativePath`.
export const TITLE_FILE_MEDIA = {
  type: "object",
  nullable: true,
  description: "The file's media info as the arr read it; null when it has none",
  properties: {
    videoCodec: { type: "string", nullable: true },
    videoDynamicRange: { type: "string", nullable: true },
    videoBitDepth: { type: "integer", nullable: true },
    videoBitrate: { type: "number", nullable: true },
    videoFps: { type: "number", nullable: true },
    resolution: { type: "string", nullable: true },
    scanType: { type: "string", nullable: true },
    audioCodec: { type: "string", nullable: true },
    audioChannels: { type: "number", nullable: true },
    audioBitrate: { type: "number", nullable: true },
    audioLanguages: { type: "string", nullable: true },
    audioStreamCount: { type: "integer", nullable: true },
    subtitles: { type: "string", nullable: true },
    runTime: { type: "string", nullable: true },
  },
} satisfies OpenApiSchema;

export const TITLE_FILE = {
  type: "object",
  properties: {
    id: { type: "integer" },
    size: { type: "number" },
    dateAdded: { type: "string", format: "date-time", nullable: true },
    quality: { type: "string", nullable: true },
    qualityTags: QUALITY_TAGS,
    languages: { type: "array", items: { type: "string" } },
    customFormats: { type: "array", items: { type: "string" } },
    customFormatScore: { type: "integer", nullable: true },
    qualityCutoffNotMet: { type: "boolean" },
    releaseGroup: { type: "string", nullable: true },
    sceneName: { type: "string", nullable: true, description: "The release name the file was imported as" },
    edition: { type: "string", nullable: true, description: "Radarr only" },
    seasonNumber: { type: "integer", nullable: true, description: "Sonarr only: the season the file belongs to" },
    episodes: {
      type: "array",
      description: "Sonarr only: the episodes the file holds",
      items: { type: "object", required: ["seasonNumber", "episodeNumber"], properties: { seasonNumber: { type: "integer" }, episodeNumber: { type: "integer" } } },
    },
    media: TITLE_FILE_MEDIA,
  },
} satisfies OpenApiSchema;

// The step-up refusal of the routes behind requireStepUp (guardrail 6g).
export const STEP_UP_401 = {
  description:
    "Step-up authentication required or failed (guardrail 6g). `error` is a code: password-required (send `confirmPassword`), invalid-password, or session-too-old (an SSO caller whose session is older than 5 minutes)",
} satisfies OpenApiResponse;

// The 413 every capped body read answers (readJsonCapped and its siblings,
// src/lib/body-size.ts), worded with the handler's own cap. Every operation whose
// handler reads a capped body lists it; tests/openapi-status-parity.test.mts reads
// the cap from the handler, so the two can't drift apart.
export function tooLargeAnswer(maxBytes: number): OpenApiResponse {
  const MIB = 1024 * 1024;
  const cap = maxBytes >= MIB ? `${Math.round(maxBytes / MIB)} MB` : `${Math.max(1, Math.round(maxBytes / 1024))} KB`;
  return { description: `Request body over the ${cap} cap` };
}

// The header a limiter's 429 carries (tooManyRequests, src/lib/http.ts).
export const RETRY_AFTER_HEADER = {
  "Retry-After": { description: "Seconds to wait before retrying", schema: { type: "integer", minimum: 1 } },
} satisfies OpenApiResponse["headers"];

// The counts both audit-PII scrubs answer — DELETE /admin/audit-log and the
// scrub-audit-pii cron — beside each one's count of cleared sign-in details.
export const AUDIT_SCRUB_FIELDS = {
  scrubbed: { type: "integer", description: "Rows whose IP address, user agent and user name were cleared" },
  adminDetailsScrubbed: { type: "integer", description: "Admin-action rows whose target-user names were scrubbed" },
  cutoff: { type: "string", format: "date-time" },
} satisfies Record<string, OpenApiSchema>;

// One AuthSession row as both session lists project it (GET /sessions for the
// caller's own, GET /admin/users/{id}/sessions for a user's), plus `indefinite`.
export const AUTH_SESSION_ROW_FIELDS = {
  id: { type: "string" },
  sessionId: { type: "string" },
  deviceType: { type: "string", description: "mobile | tablet | desktop" },
  deviceLabel: { type: "string", nullable: true },
  ipAddress: { type: "string", nullable: true },
  createdAt: { type: "string", format: "date-time" },
  lastSeenAt: { type: "string", format: "date-time" },
  expiresAt: { type: "string", format: "date-time", description: "Sentinel far-future date for a never-expiring native session" },
  indefinite: { type: "boolean", description: "Additive: true for a never-expiring native session" },
} satisfies Record<string, OpenApiSchema>;

// The `user` a request or issue list row carries (the prisma include): who filed
// it, by name — and by email too when the caller manages that list.
export function rowOwner(manageBit: "MANAGE_REQUESTS" | "MANAGE_ISSUES"): OpenApiSchema {
  return {
    type: "object",
    description: `Who filed it: { name, email } for ${manageBit} callers, { name } otherwise`,
    required: ["name"],
    properties: {
      name: { type: "string", nullable: true },
      email: { type: "string", description: `${manageBit} callers only` },
    },
  };
}

// `{ ok: true }` — the plain acknowledgement many writes answer.
export const OK_TRUE = {
  type: "object",
  required: ["ok"],
  properties: { ok: { type: "boolean", enum: [true] } },
} satisfies OpenApiSchema;

// A cron or sync run that did not happen (cronSkippedResponse,
// src/lib/cron-history.ts): another run holds the lock, or the job isn't
// configured. Sent with `X-Cron-Skipped: 1`. A route answering either its
// result or this documents `oneOf: [<result>, CRON_SKIPPED]`, the result
// branch carrying a `required` key a skip never has.
export const CRON_SKIPPED = {
  type: "object",
  required: ["skipped", "reason"],
  properties: { skipped: { type: "boolean", enum: [true] }, reason: { type: "string" } },
} satisfies OpenApiSchema;

// TMDB's media type as the discovery reads spell it — lowercase, unlike the
// MediaType component (the prisma enum MOVIE/TV the request routes use).
export const TMDB_MEDIA_TYPE = { type: "string", enum: ["movie", "tv"] } satisfies OpenApiSchema;

export const TMDB_ID_NAME = { type: "object", properties: { id: { type: "integer" }, name: { type: "string" } } } satisfies OpenApiSchema;

export const TMDB_WATCH_PROVIDER = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["stream", "rent", "buy"] },
    name: { type: "string" },
    logoPath: { type: "string", nullable: true },
  },
} satisfies OpenApiSchema;

// The author of a request comment or an issue message (the threads' shared
// `author: { select: { name, role, email? } }`). `email` goes only to the
// thread's managers, so a name-less manager's address never reaches the
// requester or reporter (guardrail 14e).
export const THREAD_AUTHOR = {
  type: "object",
  required: ["name", "role"],
  properties: {
    name: { type: "string", nullable: true },
    role: { $ref: "#/components/schemas/UserRole" },
    email: {
      type: "string",
      description: "Only to a caller holding the thread's MANAGE_* permission (MANAGE_REQUESTS on a request, MANAGE_ISSUES on an issue) — never to the requester or reporter",
    },
  },
} satisfies OpenApiSchema;

// One request comment or issue message: the row (RequestComment / IssueMessage)
// with its author. `parentKey` names the thread's own id column.
export function threadEntry(parentKey: "requestId" | "issueId"): OpenApiSchema {
  return {
    type: "object",
    required: ["id", "createdAt", parentKey, "authorId", "body", "fromAdmin", "author"],
    properties: {
      id: { type: "string" },
      createdAt: { type: "string", format: "date-time" },
      [parentKey]: { type: "string" },
      authorId: { type: "string" },
      body: { type: "string" },
      fromAdmin: { type: "boolean", description: "The author held the thread's MANAGE_* permission when writing" },
      author: THREAD_AUTHOR,
    },
  };
}

// The fields a recorded cron run answers around its own counts — each route
// sends the ones its schema lists: `ok` (false on a degraded run, which also
// sets `error` and X-Cron-Degraded), the run's `durationMs`, who drove it
// (`trigger`, CronActor.trigger in src/lib/cron-auth.ts) and when it finished.
export const CRON_RUN_FIELDS = {
  ok: { type: "boolean", description: "false on a degraded run, with `error` and X-Cron-Degraded" },
  error: { type: "string", description: "Only on a degraded run (ok: false)" },
  durationMs: { type: "integer" },
  trigger: { type: "string", enum: ["admin", "cron"] },
  timestamp: { type: "string", format: "date-time" },
} satisfies Record<string, OpenApiSchema>;

// A cron or sync route's answer: its run, or a skip (CRON_SKIPPED). The run
// branch requires a key a skip never carries, so the two never both match.
export function cronRunOrSkip(run: OpenApiSchema): OpenApiSchema {
  return { oneOf: [run, CRON_SKIPPED] };
}

// One server's outcome of an upstream watch-record refresh (UpstreamRefreshResult,
// src/lib/upstream-watch-data.ts): the never-watched Refresh answers it.
export const UPSTREAM_REFRESH_RESULT = {
  type: "object",
  required: ["servers", "aborted"],
  properties: {
    servers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          source: { type: "string", enum: ["plex", "jellyfin"] },
          instance: { type: "string" },
          ok: { type: "boolean", description: "This run's fetch succeeded and its snapshot was written" },
          entries: { type: "integer", description: "The stored status after this run (on a failure, the previous snapshot's)" },
          matched: { type: "integer" },
          samples: { type: "integer" },
          agreed: { type: "integer" },
          error: { type: "string", nullable: true },
          health: { type: "string", enum: ["ok", "unreliable", "failed", "incomplete", "stale", "never"] },
        },
      },
    },
    aborted: { type: "boolean", description: "The run stopped on its lock signal; the server in progress was not written" },
  },
} satisfies OpenApiSchema;

// Watch sync (src/lib/watch-sync-data.ts): one direction's counts of a run
// (WatchSyncDirectionResult), one pair's result (WatchSyncPairResult) and the
// whole run (WatchSyncRunResult) — what a run answers and what a pair stores
// as `lastResult`.
export const WATCH_SYNC_DIRECTION_RESULT = {
  type: "object",
  nullable: true,
  description: "null when the pair doesn't sync this way",
  properties: {
    queued: { type: "integer" },
    unresolved: { type: "integer" },
    unmatched: { type: "integer" },
    marked: { type: "integer" },
    already: { type: "integer" },
    missing: { type: "integer" },
    failed: { type: "integer" },
    error: { type: "string" },
  },
} satisfies OpenApiSchema;

export const WATCH_SYNC_PAIR_RESULT = {
  type: "object",
  properties: {
    pairId: { type: "string" },
    toJellyfin: WATCH_SYNC_DIRECTION_RESULT,
    toPlex: WATCH_SYNC_DIRECTION_RESULT,
    progress: {
      type: "object",
      nullable: true,
      description: "Resume points copied (titles); null when the pair doesn't sync them",
      properties: { toJellyfin: { type: "integer" }, toPlex: { type: "integer" }, failed: { type: "integer" }, error: { type: "string" } },
    },
    error: { type: "string", description: "A problem with the pair itself (both directions stopped)" },
  },
} satisfies OpenApiSchema;

// The library-metadata prewarm's counts (prewarmLibraryCache,
// src/lib/tmdb-prewarm.ts): POST /admin/library-warm's answer and the
// warm-library cron's.
export const LIBRARY_PREWARM_COUNTS = {
  total: { type: "integer" },
  fetched: { type: "integer" },
  missing: { type: "integer", description: "Titles TMDB answered 404 for (cached as gone, not counted as fetched)" },
  backfilled: { type: "integer" },
  skipped: { type: "integer" },
  failed: { type: "integer" },
} satisfies Record<string, OpenApiSchema>;

// The answers every /admin/arr/* operation shares through arrGate/arrTitleGate
// and arrFailure (src/lib/arr-admin-http.ts): one error map, so one place to
// document it. Spread FIRST into an operation's `responses`, so a route's own
// description of the same status (title GET's 404, providers PATCH's 504) wins.
// Inlined rather than `components.responses` $refs: the in-app viewer
// (openapi-viewer.tsx) renders each response's own `description` and resolves
// no $ref. The fan-out reports (calendar, tasks/storage/providers GET) never
// answer these — a failed instance is named in their `errors[]` — so they don't
// take it.
export const ARR_ERRORS = {
  "400": { description: "Invalid service, instance or title id, or the arr refused the request ({ error, messages } — its reason, masked)" },
  "404": { description: "Integration disabled, unknown instance, or the arr says the item is gone" },
  "409": {
    description:
      "{ error } — a named season, episode, file or history record isn't this title's, the record isn't a grab, its " +
      "download already failed, the release is no longer on the blocklist, or the command is no longer queued; or " +
      "{ error, messages } — the arr refused it as a conflict (its reason, masked)",
  },
  "502": { description: "{ error } — the arr refused the API key, could not be reached, or failed (worded by the kind of failure)" },
  "504": { description: "{ error } — the arr timed out" },
} satisfies OpenApiResponses;

// The arr's ids for commands it queued — followed at GET /admin/arr/commands.
export const ARR_COMMAND_IDS = { type: "array", items: { type: "integer" } } satisfies OpenApiSchema;
