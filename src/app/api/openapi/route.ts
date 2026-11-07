import { NextResponse } from "next/server";
import { withPermission } from "@/lib/api-auth";
import { ARR_ERROR_KIND_KEYS } from "@/lib/arr-error-kind";
import { COMMAND_READ_MAX_IDS } from "@/lib/arr-command-status";
import { withBasePath } from "@/lib/base-path";
import { LOCALES } from "@/lib/i18n/locales";
import { MDBLIST_PLAN_CHOICES, MDBLIST_PLANS } from "@/lib/mdblist-plan";
import { CLEANUP_EXCLUSION_LABELS, CLEANUP_RULE_LABELS } from "@/lib/library-cleanup";
import { RECOVERY_CODE_COUNT } from "@/lib/mfa/recovery-codes";
import { SUPPORTED_COSE_ALGS } from "@/lib/mfa/webauthn";
import { NW_REASONS, NW_STATES } from "@/lib/never-watched";
import { AGENT_KINDS, NOTIFY_EVENT_KEYS } from "@/lib/notify-events";
import { Permission } from "@/lib/permissions";
import { ADMIN_NOTE_MAX, BULK_REQUEST_MAX_ITEMS } from "@/lib/request-limits";

// The OpenAPI 3.0 subset this document uses, checked at compile time with
// `satisfies`: a misspelled key (`requestbody`, `nullabe`), a misplaced
// `required` or a status code that isn't one fails typecheck instead of shipping.
// Type-only, so the served JSON is exactly the literal below. Extend it when the
// spec needs a keyword it doesn't list yet.
type OpenApiSchema = {
  $ref?: string;
  type?: "string" | "integer" | "number" | "boolean" | "array" | "object";
  format?: string;
  description?: string;
  nullable?: boolean;
  deprecated?: boolean;
  enum?: readonly unknown[];
  default?: unknown;
  example?: unknown;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  items?: OpenApiSchema;
  properties?: Record<string, OpenApiSchema>;
  additionalProperties?: boolean | OpenApiSchema;
  required?: readonly string[];
  allOf?: readonly OpenApiSchema[];
  oneOf?: readonly OpenApiSchema[];
  anyOf?: readonly OpenApiSchema[];
};
type OpenApiMedia = { schema?: OpenApiSchema; example?: unknown };
type OpenApiResponse = {
  description: string;
  headers?: Record<string, { description?: string; schema?: OpenApiSchema }>;
  content?: Record<string, OpenApiMedia>;
};
type Digit = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
type OpenApiResponses = Partial<Record<`${1 | 2 | 3 | 4 | 5}${Digit}${Digit}` | "default", OpenApiResponse>>;
type OpenApiParameter = {
  name: string;
  in: "query" | "path" | "header" | "cookie";
  required?: boolean;
  description?: string;
  deprecated?: boolean;
  schema?: OpenApiSchema;
};
type OpenApiSecurity = readonly Record<string, readonly string[]>[];
type OpenApiOperation = {
  tags?: readonly string[];
  summary?: string;
  description?: string;
  operationId?: string;
  deprecated?: boolean;
  security?: OpenApiSecurity;
  parameters?: readonly OpenApiParameter[];
  requestBody?: { description?: string; required?: boolean; content: Record<string, OpenApiMedia> };
  responses: OpenApiResponses;
};
type OpenApiDocument = {
  openapi: "3.0.3";
  info: { title: string; version: string; description?: string };
  servers: readonly { url: string; description?: string }[];
  components: {
    securitySchemes: Record<string, {
      type: "apiKey" | "http";
      in?: "query" | "header" | "cookie";
      name?: string;
      scheme?: string;
      bearerFormat?: string;
      description?: string;
    }>;
    schemas: Record<string, OpenApiSchema>;
  };
  security: OpenApiSecurity;
  tags: readonly { name: string; description?: string }[];
  paths: Record<string, Partial<Record<"get" | "post" | "put" | "patch" | "delete", OpenApiOperation>>>;
};

// Body of every two-factor ENROLLMENT change (guardrail 6d): the current
// password, plus — once the account has an active factor — a fresh second factor.
const MFA_SECOND_FACTOR_SCHEMA = {
  type: "object",
  description:
    "Required once the account has an active second factor (omit for the first factor). { method: \"totp\" | \"recovery\", code } or { method: \"webauthn\", credential, challengeToken } with the challenge from POST /profile/mfa/challenge. A recovery code used here is spent.",
  required: ["method"],
  properties: {
    method: { type: "string", enum: ["totp", "recovery", "webauthn"] },
    code: { type: "string" },
    credential: { type: "object", description: "PublicKeyCredential JSON (assertion response, base64url)" },
    challengeToken: { type: "string" },
  },
} satisfies OpenApiSchema;
const MFA_STEP_UP_400 =
  "Missing or wrong password, or a missing/invalid second factor ({ error, secondFactorRequired: true, methods? })";
function mfaStepUpBody(extra: Record<string, OpenApiSchema> = {}, extraRequired: string[] = []): OpenApiSchema {
  return {
    type: "object",
    required: ["password", ...extraRequired],
    properties: { password: { type: "string" }, secondFactor: MFA_SECOND_FACTOR_SCHEMA, ...extra },
  };
}

// The answers every /admin/arr/* operation shares through arrGate/arrTitleGate
// and arrFailure (src/lib/arr-admin-http.ts): one error map, so one place to
// document it. Spread FIRST into an operation's `responses`, so a route's own
// description of the same status (title GET's 404, providers PATCH's 504) wins.
// Inlined rather than `components.responses` $refs: the in-app viewer
// (openapi-viewer.tsx) renders each response's own `description` and resolves
// no $ref. The fan-out reports (calendar, tasks/storage/providers GET) never
// answer these — a failed instance is named in their `errors[]` — so they don't
// take it.
const ARR_ERRORS = {
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

// `cached=1` on the admin Radarr/Sonarr READS that keep their last answer
// (`snapshotted`, src/lib/arr-snapshot.ts): a page opened again paints that
// answer at once, then reloads live. Display only — every action re-checks live
// on the server. Inlined like ARR_ERRORS: the in-app viewer resolves no $ref.
const ARR_SNAPSHOT_PARAM = {
  name: "cached",
  in: "query",
  schema: { type: "string", enum: ["1"] },
  description:
    "`1` → the last answer kept for this exact read (same query, same language), at once and without asking " +
    "Radarr/Sonarr — 200 with the same body plus `X-Summonarr-Snapshot-At` (when it was read, ISO 8601), or 204 when " +
    "none is kept. Display only. A background-job poll (`job=`) is never kept.",
} satisfies OpenApiParameter;
const ARR_SNAPSHOT_204 = {
  description: "`cached=1` and no answer is kept for this exact read yet (a restart starts empty; kept answers expire after 24 h). No body.",
} satisfies OpenApiResponse;

// Background jobs (the job registry in src/lib/release-search-jobs.ts and the
// routes built on it, guardrail 37a) answer 202 with a 32-hex job id: { job }
// when one starts (or the caller's identical job is joined), { job, running }
// on a `?job=` poll of one still running. One schema each, so the operations
// can't drift apart; each keeps its own description, the part the in-app viewer
// shows. (Fix-match's jobs are a separate registry with a uuid `jobId`.)
const JOB_ID = { type: "string", pattern: "^[0-9a-f]{32}$" } satisfies OpenApiSchema;
const JOB_STARTED = { type: "object", required: ["job"], properties: { job: JOB_ID } } satisfies OpenApiSchema;
const JOB_RUNNING = {
  type: "object",
  required: ["job", "running"],
  properties: { job: JOB_ID, running: { type: "boolean", enum: [true] } },
} satisfies OpenApiSchema;
// A release-search GET both starts a search (`async=1`) and polls one (`?job=`).
const SEARCH_JOB = {
  type: "object",
  required: ["job"],
  properties: {
    job: JOB_ID,
    running: { type: "boolean", enum: [true], description: "Only on a `?job=` poll of a search still running" },
  },
} satisfies OpenApiSchema;
function jobAnswer(description: string, schema: OpenApiSchema): OpenApiResponse {
  return { description, content: { "application/json": { schema } } };
}

// Every /cron/* and /sync* operation goes through getCronActor/isCronAuthorized
// (src/lib/cron-auth.ts, guardrail 6): an ADMIN session — the cookie
// (same-origin) or a native bearer — OR the CRON_SECRET bearer.
const ADMIN_OR_CRON_SECURITY: OpenApiSecurity = [{ session: [] }, { sessionBearer: [] }, { cronSecret: [] }];

// The per-title rating fields GET /ratings and POST /ratings/batch share — the
// MdblistRatings shape (src/lib/mdblist.ts); an OMDB-only title fills the fields
// it lacks with null.
const RATING_FIELDS = {
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
const NOTIFICATION_PREF_FLAGS = {
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

// One row of GET /admin/users — and POST /admin/users' 201, which answers the
// same shape (serializeUser in src/app/api/admin/users/route.ts).
const ADMIN_USER_ITEM = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string", nullable: true },
    email: { type: "string", nullable: true },
    role: { $ref: "#/components/schemas/UserRole" },
    createdAt: { type: "string", format: "date-time" },
    deactivatedAt: { type: "string", format: "date-time", nullable: true },
    purgedAt: { type: "string", format: "date-time", nullable: true },
    mediaServer: { type: "string", nullable: true },
    maxContentRating: { type: "string", nullable: true },
    source: { type: "string", description: "local | oidc | jellyfin | plex | discord (additive set)" },
    movieQuotaLimit: { type: "integer", nullable: true },
    movieQuotaDays: { type: "integer", nullable: true },
    tvQuotaLimit: { type: "integer", nullable: true },
    tvQuotaDays: { type: "integer", nullable: true },
    permissions: { type: "string", description: "Decimal bitmask" },
    ...NOTIFICATION_PREF_FLAGS,
    requestCount: { type: "integer" },
  },
} satisfies OpenApiSchema;

// One release of an interactive search — the projected ArrRelease (toArrRelease,
// src/lib/arr.ts) every release search answers: no download URL, and `guid`
// swapped for an opaque handle bound to that search (release-handles.ts), never
// the indexer's guid (guardrail 5e). The iOS app decodes this shape.
const ARR_RELEASE = {
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
const ARR_ERROR_KINDS = Object.keys(ARR_ERROR_KIND_KEYS);

// A download's phase in the queue fold (QueuePhase, src/lib/arr-queue.ts).
const QUEUE_PHASE = {
  type: "string",
  enum: ["downloading", "queued", "paused", "delay", "importPending", "importing", "importBlocked", "failed", "clientUnavailable", "unknown"],
} satisfies OpenApiSchema;

// A watchlist or hidden-title row (WATCHLIST_ITEM_SELECT, src/lib/watchlist-add.ts,
// and the hidden route's SELECT — the same five columns).
const LIST_ITEM = {
  type: "object",
  properties: {
    tmdbId: { type: "integer" },
    mediaType: { $ref: "#/components/schemas/MediaType" },
    title: { type: "string" },
    posterPath: { type: "string", nullable: true },
    createdAt: { type: "string", format: "date-time" },
  },
} satisfies OpenApiSchema;

// The paging envelope of an arr list read (ArrPage, src/lib/arr-history.ts),
// its records projected by name — never the arr's raw record.
function arrPage(record: OpenApiSchema): OpenApiSchema {
  return {
    type: "object",
    properties: {
      page: { type: "integer" },
      pageSize: { type: "integer" },
      totalRecords: { type: "integer" },
      records: { type: "array", items: record },
    },
  };
}
const ARR_SERVICE = { type: "string", enum: ["radarr", "sonarr"] } satisfies OpenApiSchema;
const QUALITY_TAGS = { type: "array", items: { type: "string", enum: ["proper", "repack", "real"] } } satisfies OpenApiSchema;
const PROTOCOL = { type: "string", enum: ["torrent", "usenet", "unknown"] } satisfies OpenApiSchema;

// One history record (ArrHistoryEvent, src/lib/arr-history.ts) — named fields
// only (guardrail 5e). The import and rename paths the admin page shows are
// projected too and left out here.
const ARR_HISTORY_EVENT = {
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

// One blocklist entry (BlocklistEntry, src/lib/arr-history.ts).
const BLOCKLIST_ENTRY = {
  type: "object",
  properties: {
    id: { type: "integer" },
    service: ARR_SERVICE,
    instance: { type: "string" },
    arrMediaId: { type: "integer", nullable: true },
    mediaTitle: { type: "string" },
    year: { type: "integer", nullable: true },
    tmdbId: { type: "integer", nullable: true },
    tvdbId: { type: "integer", nullable: true },
    episodeCount: { type: "integer", description: "Sonarr: how many episodes the release covered" },
    sourceTitle: { type: "string" },
    date: { type: "string", format: "date-time", nullable: true },
    quality: { type: "string", nullable: true },
    qualityTags: QUALITY_TAGS,
    languages: { type: "array", items: { type: "string" } },
    customFormats: { type: "array", items: { type: "string" } },
    protocol: PROTOCOL,
    indexer: { type: "string", nullable: true },
    message: { type: "string", nullable: true, description: "Why it was blocklisted, credentials masked" },
  },
} satisfies OpenApiSchema;

// The step-up refusal of the routes behind requireStepUp (guardrail 6g).
const STEP_UP_401 = {
  description:
    "Step-up authentication required or failed (guardrail 6g). `error` is a code: password-required (send `confirmPassword`), invalid-password, or session-too-old (an SSO caller whose session is older than 5 minutes)",
} satisfies OpenApiResponse;

// `{ ok: true }` — the plain acknowledgement many writes answer.
const OK_TRUE = {
  type: "object",
  required: ["ok"],
  properties: { ok: { type: "boolean", enum: [true] } },
} satisfies OpenApiSchema;

// A cron or sync run that did not happen (cronSkippedResponse,
// src/lib/cron-history.ts): another run holds the lock, or the job isn't
// configured. Sent with `X-Cron-Skipped: 1`. A route answering either its
// result or this documents `oneOf: [<result>, CRON_SKIPPED]`, the result
// branch carrying a `required` key a skip never has.
const CRON_SKIPPED = {
  type: "object",
  required: ["skipped", "reason"],
  properties: { skipped: { type: "boolean", enum: [true] }, reason: { type: "string" } },
} satisfies OpenApiSchema;

// The one-time recovery codes a two-factor enrollment shows once
// (generateRecoveryCodes, src/lib/mfa/recovery-codes.ts): 16 symbols with no
// I/O/0/1, in dash-joined groups of 4. Only their hashes are stored.
const MFA_RECOVERY_CODES = {
  type: "array",
  minItems: RECOVERY_CODE_COUNT,
  maxItems: RECOVERY_CODE_COUNT,
  items: { type: "string", pattern: "^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$" },
  description: "Shown once — only their hashes are stored",
} satisfies OpenApiSchema;

// The answer of a second-factor enrollment (TOTP enable, passkey add): the
// recovery codes come only with the account's FIRST factor, which also signs out
// every other session.
const MFA_FACTOR_ADDED = {
  type: "object",
  required: ["ok"],
  properties: {
    ok: { type: "boolean", enum: [true] },
    recoveryCodes: { ...MFA_RECOVERY_CODES, description: "Only when this is the account's first factor; shown once" },
  },
} satisfies OpenApiSchema;

// One of the caller's own passkeys named to the browser for a WebAuthn
// ceremony (allowCredentials / excludeCredentials): a public credential id.
const WEBAUTHN_CREDENTIAL_DESCRIPTOR = {
  type: "object",
  required: ["type", "id", "transports"],
  properties: {
    type: { type: "string", enum: ["public-key"] },
    id: { type: "string", description: "The credential id, base64url" },
    transports: { type: "array", items: { type: "string" } },
  },
} satisfies OpenApiSchema;

// The caller's Trakt connection (TraktProfileState, src/lib/trakt-user.ts):
// GET /profile/trakt and the PATCH that answers the same body.
const TRAKT_PROFILE_STATE = {
  type: "object",
  properties: {
    available: { type: "boolean", description: "The admin saved a Trakt client id AND secret, and the caller has a use for a connection" },
    uses: {
      type: "object",
      properties: {
        watchlist: { type: "boolean", description: "feature.behavior.watchlistAutoRequest is on and the caller holds an AUTO_REQUEST* bit" },
        history: { type: "boolean", description: "feature.page.forYou is on" },
      },
    },
    connected: { type: "boolean", description: "A Trakt grant is stored for the caller" },
    username: { type: "string", nullable: true },
    watchlistAutoRequest: { type: "boolean", description: "File new Trakt watchlist titles as requests" },
    historySeeds: { type: "boolean", description: "Seed For You from the Trakt watch history" },
    status: { type: "string", nullable: true, enum: ["ok", "error", "reauth"], description: "The last sync's verdict; \"reauth\" means Trakt refused the grant — reconnect" },
    syncedAt: { type: "string", format: "date-time", nullable: true },
  },
} satisfies OpenApiSchema;

// POST/DELETE /notifications: marked read or deleted, and the caller's unread
// count after the change.
const NOTIFICATION_UNREAD_ACK = {
  type: "object",
  required: ["ok", "unreadCount"],
  properties: { ok: { type: "boolean", enum: [true] }, unreadCount: { type: "integer", minimum: 0 } },
} satisfies OpenApiSchema;

// TMDB's media type as the discovery reads spell it — lowercase, unlike the
// MediaType component (the prisma enum MOVIE/TV the request routes use).
const TMDB_MEDIA_TYPE = { type: "string", enum: ["movie", "tv"] } satisfies OpenApiSchema;
const TMDB_ID_NAME = { type: "object", properties: { id: { type: "integer" }, name: { type: "string" } } } satisfies OpenApiSchema;
const TMDB_WATCH_PROVIDER = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["stream", "rent", "buy"] },
    name: { type: "string" },
    logoPath: { type: "string", nullable: true },
  },
} satisfies OpenApiSchema;
const RECOMMENDATION_SEED_SOURCE = { type: "string", enum: ["WATCH_HISTORY", "WATCHLIST", "REQUEST"] } satisfies OpenApiSchema;

// One title as every discovery read answers it: TmdbMedia (src/lib/tmdb-types.ts)
// after the attachAllAvailability chokepoint (src/lib/attach-all.ts). A list row
// carries what TMDB's list gave; the detail fields fill in on the single-title
// read. `arrInstances` is left out — that chokepoint never copies it. Served as
// components.schemas.TmdbMedia, so a generated client gets one named type.
const TMDB_MEDIA = {
  type: "object",
  required: ["id", "mediaType", "title", "overview", "posterPath", "backdropPath", "releaseDate", "releaseYear", "voteAverage"],
  properties: {
    id: { type: "integer", description: "TMDB id" },
    mediaType: TMDB_MEDIA_TYPE,
    title: { type: "string", description: "In the viewer's language when TMDB has a translation" },
    overview: { type: "string" },
    posterPath: { type: "string", nullable: true, description: "TMDB image path (prefix https://image.tmdb.org/t/p/<size>)" },
    backdropPath: { type: "string", nullable: true },
    releaseDate: { type: "string", nullable: true, description: "YYYY-MM-DD (first air date for TV)" },
    releaseYear: { type: "string", nullable: true },
    voteAverage: { type: "number" },
    voteCount: { type: "integer" },
    certification: { type: "string", description: "US content rating" },
    plexAvailable: { type: "boolean", description: "On a Plex server this viewer may see" },
    jellyfinAvailable: { type: "boolean", description: "On a Jellyfin server this viewer may see" },
    arrPending: { type: "boolean", description: "Wanted by the default Radarr/Sonarr, not yet on disk" },
    arr4kPending: { type: "boolean", description: "Only when the viewer can see 4K state" },
    arr4kAvailable: { type: "boolean", description: "Only when the viewer can see 4K state" },
    requested: { type: "boolean" },
    requestedByMe: { type: "boolean" },
    blacklisted: { type: "boolean", description: "Present (true) only when an admin blacklisted the title: it is shown, but a request is refused" },
    ...RATING_FIELDS,
    releasedDigital: { type: "string", nullable: true },
    digitalReleaseDate: { type: "string", nullable: true, description: "Movies only; absent when not fetched yet, null when TMDB has none" },
    physicalReleaseDate: { type: "string", nullable: true, description: "Movies only; absent when not fetched yet, null when TMDB has none" },
    trailerUrl: { type: "string", nullable: true },
    trailerKey: { type: "string", nullable: true },
    collectionId: { type: "integer", nullable: true },
    collectionName: { type: "string", nullable: true },
    seasons: {
      type: "array",
      items: {
        type: "object",
        properties: {
          seasonNumber: { type: "integer" },
          episodeCount: { type: "integer" },
          airDate: { type: "string", nullable: true },
          posterPath: { type: "string", nullable: true },
          name: { type: "string" },
          overview: { type: "string" },
        },
      },
    },
    genres: { type: "array", items: { type: "string" } },
    genreList: { type: "array", items: TMDB_ID_NAME, description: "`genres` with their TMDB ids, for browse deep links" },
    studios: { type: "array", items: { type: "string" } },
    studioList: {
      type: "array",
      items: { type: "object", properties: { id: { type: "integer" }, name: { type: "string" }, kind: { type: "string", enum: ["company", "network"] } } },
    },
    tagline: { type: "string", nullable: true },
    status: { type: "string", nullable: true },
    runtime: { type: "integer", nullable: true, description: "Minutes" },
    numberOfSeasons: { type: "integer", nullable: true },
    numberOfEpisodes: { type: "integer", nullable: true },
    originalTitle: { type: "string", nullable: true },
    originalLanguage: { type: "string", nullable: true },
    spokenLanguages: { type: "array", items: { type: "string" } },
    productionCountries: { type: "array", items: { type: "string" }, description: "Display names" },
    originCountryCodes: { type: "array", items: { type: "string" }, description: "ISO 3166-1 codes" },
    productionCountryCodes: { type: "array", items: { type: "string" }, description: "ISO codes, index-aligned with productionCountries" },
    homepage: { type: "string", nullable: true },
    budget: { type: "integer", nullable: true },
    revenue: { type: "integer", nullable: true },
    keywords: { type: "array", items: { type: "string" } },
    keywordList: { type: "array", items: TMDB_ID_NAME, description: "`keywords` with their TMDB ids, for browse deep links" },
    watchProviders: { type: "array", items: TMDB_WATCH_PROVIDER, description: "US region" },
    tvdbId: { type: "integer", nullable: true },
    lastAirDate: { type: "string", nullable: true },
    inProduction: { type: "boolean", nullable: true },
    tvType: { type: "string", nullable: true },
    nextEpisodeAirDate: { type: "string", nullable: true },
    recommendedBecause: {
      type: "object",
      description: "For You reads only: the strongest seed that surfaced the title",
      properties: {
        tmdbId: { type: "integer" },
        title: { type: "string" },
        mediaType: TMDB_MEDIA_TYPE,
        source: { type: "string", enum: ["WATCH_HISTORY", "WATCHLIST", "REQUEST", "TRENDING"], description: "TRENDING never appears: a fallback row carries fromTrendingFallback instead" },
        seedCount: { type: "integer", description: "How many seeds agreed (the true total)" },
        seeds: {
          type: "array",
          description: "Every seed, strongest first, capped (seedCount is the true total); absent on rows stored before the list was",
          items: { type: "object", properties: { tmdbId: { type: "integer" }, title: { type: "string" }, mediaType: TMDB_MEDIA_TYPE, source: RECOMMENDATION_SEED_SOURCE } },
        },
      },
    },
    fromTrendingFallback: { type: "boolean", description: "For You reads only: a cold-start row that is popular, not matched to the viewer" },
    matchTier: { type: "string", enum: ["top", "strong"], description: "For You reads only: absent outside a labelled band" },
  },
} satisfies OpenApiSchema;
const TMDB_MEDIA_LIST = { type: "array", items: { $ref: "#/components/schemas/TmdbMedia" } } satisfies OpenApiSchema;

// A related or collection title on GET /media/{type}/{tmdbId} — the route's
// `lite` projection (poster, label and availability marks only).
const MEDIA_DETAIL_LITE = {
  type: "object",
  properties: {
    tmdbId: { type: "integer" },
    mediaType: TMDB_MEDIA_TYPE,
    title: { type: "string" },
    posterPath: { type: "string", nullable: true },
    releaseYear: { type: "string", nullable: true },
    plexAvailable: { type: "boolean" },
    jellyfinAvailable: { type: "boolean" },
    arrPending: { type: "boolean" },
    requested: { type: "boolean" },
  },
} satisfies OpenApiSchema;

// One AuditLog row — the whole prisma row, as GET /admin/audit-log pages it and
// the JSON export streams it (JSON.stringify of each row).
const AUDIT_LOG_ROW = { type: "object", properties: {
  id: { type: "string" },
  createdAt: { type: "string", format: "date-time" },
  userId: { type: "string", nullable: true },
  userName: { type: "string" },
  action: { type: "string", description: "An AuditAction value (prisma/schema.prisma)" },
  target: { type: "string" },
  details: { type: "string", nullable: true, description: "JSON text" },
  ipAddress: { type: "string", nullable: true },
  userAgent: { type: "string", nullable: true },
  provider: { type: "string", nullable: true },
  sessionId: { type: "string", nullable: true },
} } satisfies OpenApiSchema;

// The counts of a database restore (BackupImportSummary, src/lib/backup-import.ts).
const BACKUP_IMPORT_SUMMARY = {
  type: "object",
  properties: {
    total: { type: "integer", description: "Statements in the dump" },
    executed: { type: "integer" },
    skipped: { type: "integer" },
    errors: { type: "integer" },
    conflictSkippedByTable: {
      type: "object",
      additionalProperties: { type: "integer" },
      description: "Rows an INSERT … ON CONFLICT DO NOTHING dropped, keyed by table — empty on a clean restore; anything here means a corrupt or drifted dump",
    },
    conflictSkippedTotal: { type: "integer" },
  },
} satisfies OpenApiSchema;

// A live Radarr/Sonarr check in the arr-state dump: the verdict, plus a generic
// `error` when the call failed (the real detail is only logged).
const DEBUG_LIVE_CHECK = {
  type: "object",
  required: ["result"],
  properties: { result: { type: "boolean" }, error: { type: "string" } },
} satisfies OpenApiSchema;
// A RadarrWantedItem / SonarrWantedItem row as stored (the two models share it).
const DEBUG_WANTED_ROW = {
  type: "object",
  nullable: true,
  description: "The wanted-table row as stored, or null when the title isn't on it",
  properties: {
    tmdbId: { type: "integer" },
    arrInstance: { type: "string", description: "\"\" = the default instance" },
    is4k: { type: "boolean", deprecated: true },
  },
} satisfies OpenApiSchema;

// A fix-match job's state and outcome (src/lib/fix-match-jobs.ts): the status
// route answers the whole job, the job tray a coarse summary of each.
const FIX_MATCH_JOB_STATUS = { type: "string", enum: ["queued", "running", "done", "failed"] } satisfies OpenApiSchema;
// The synchronous POST's 200 and a finished job's `result` (FixMatchJobResult).
const FIX_MATCH_RESULT = {
  type: "object",
  required: ["ok"],
  properties: {
    ok: { type: "boolean", enum: [true] },
    warning: { type: "string", description: "Plex conflated both TMDB ids on one item" },
  },
} satisfies OpenApiSchema;
const FIX_MATCH_PHASE = { type: "string", enum: ["searching", "applying", "confirming"] } satisfies OpenApiSchema;

// What the library prewarm answers (prewarmLibraryCache, src/lib/tmdb-prewarm.ts)
// — the POST's 200 and, replayed, its background job's.
const LIBRARY_WARM_RESULT = {
  type: "object",
  required: ["total", "fetched", "backfilled", "skipped", "failed"],
  properties: {
    total: { type: "integer" },
    fetched: { type: "integer" },
    backfilled: { type: "integer" },
    skipped: { type: "integer" },
    failed: { type: "integer" },
  },
} satisfies OpenApiSchema;

// The library match check's counts and per-source outcome (MatchCounts,
// src/lib/library-match.ts; LibraryMatchSource, src/lib/library-match-data.ts)
// — in the stored report and in the run's own answer.
const MATCH_CHECK_COUNTS = {
  type: "object",
  properties: {
    checked: { type: "integer", description: "Items judged (every listed item)" },
    agreed: { type: "integer", description: "Items Radarr/Sonarr agree with" },
    notManaged: { type: "integer", description: "Items in a folder no Radarr/Sonarr manages (judged by the folder year alone)" },
    flagged: { type: "integer" },
  },
} satisfies OpenApiSchema;
const MATCH_CHECK_SOURCE = {
  type: "object",
  properties: {
    service: { type: "string", enum: ["plex", "jellyfin", "radarr", "sonarr"] },
    instance: { type: "string" },
    ok: { type: "boolean" },
    kind: { type: "string", enum: ARR_ERROR_KINDS, description: "Radarr/Sonarr only: why it couldn't be read" },
    items: { type: "integer", description: "Items (servers) or titles (Radarr/Sonarr) read" },
  },
} satisfies OpenApiSchema;
// The run's own answer (POST 200, and a background run's replay on GET ?job=).
// Annotated rather than `satisfies`: TypeScript merges the two branch literals
// into one element type whose missing keys break the properties index type.
const MATCH_CHECK_RUN: OpenApiSchema = {
  oneOf: [
    {
      type: "object",
      required: ["ok", "checkedAt"],
      properties: {
        ok: { type: "boolean", enum: [true] },
        checkedAt: { type: "string", format: "date-time" },
        counts: MATCH_CHECK_COUNTS,
        sources: { type: "array", items: MATCH_CHECK_SOURCE },
        truncated: { type: "integer", description: "Flags past the stored cap, not stored" },
      },
    },
    {
      type: "object",
      required: ["ok", "aborted"],
      properties: { ok: { type: "boolean", enum: [false] }, aborted: { type: "boolean", enum: [true] } },
    },
  ],
};

// One side of a bad match (BadMatchSide, src/lib/bad-matches.ts).
const BAD_MATCH_SIDE = {
  type: "object",
  properties: {
    tmdbId: { type: "integer" },
    mediaType: { $ref: "#/components/schemas/MediaType" },
    title: { type: "string", nullable: true },
    posterPath: { type: "string", nullable: true },
    releaseYear: { type: "string", nullable: true },
    serverInstance: { type: "string", description: "The server holding this row (\"\" = the default) — send it back as the fix's `serverInstance`" },
  },
} satisfies OpenApiSchema;

// The author of a request comment or an issue message (the threads' shared
// `author: { select: { name, role, email? } }`). `email` goes only to the
// thread's managers, so a name-less manager's address never reaches the
// requester or reporter (guardrail 14e).
const THREAD_AUTHOR = {
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
function threadEntry(parentKey: "requestId" | "issueId"): OpenApiSchema {
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

// One file of a title as Radarr/Sonarr list it (TitleFile, src/lib/arr-title.ts).
// Its relative and absolute paths are projected too (ADMIN-only) and left out
// here, as ARR_HISTORY_EVENT leaves out its paths.
const TITLE_FILE_MEDIA = {
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
const TITLE_FILE = {
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

// One PlayHistory row as stored (prisma/schema.prisma), every column. ADMIN reads
// only: it carries the client's IP address and network location.
const PLAY_HISTORY_ROW_FIELDS = {
  id: { type: "string" },
  source: { type: "string", description: "plex | jellyfin" },
  serverInstance: { type: "string", description: "The server's slug ('' for the default server)" },
  startedAt: { type: "string", format: "date-time" },
  stoppedAt: { type: "string", format: "date-time" },
  duration: { type: "integer", description: "The media's length, seconds" },
  playDuration: { type: "integer", description: "Seconds spent playing (pause and buffering excluded)" },
  pausedDuration: { type: "integer" },
  watched: { type: "boolean" },
  completed: { type: "boolean" },
  mediaServerUserId: { type: "string" },
  tmdbId: { type: "integer", nullable: true },
  mediaType: { type: "string", enum: ["MOVIE", "TV"], nullable: true },
  title: { type: "string" },
  year: { type: "string", nullable: true },
  posterPath: { type: "string", nullable: true },
  seasonNumber: { type: "integer", nullable: true },
  episodeNumber: { type: "integer", nullable: true },
  episodeTitle: { type: "string", nullable: true },
  sourceSessionId: { type: "string", nullable: true },
  sourceItemId: { type: "string", nullable: true },
  sourceShowId: { type: "string", nullable: true },
  platform: { type: "string", nullable: true },
  player: { type: "string", nullable: true },
  device: { type: "string", nullable: true },
  ipAddress: { type: "string", nullable: true },
  playMethod: { type: "string", nullable: true, description: "DirectPlay | DirectStream | Transcode" },
  videoCodec: { type: "string", nullable: true },
  audioCodec: { type: "string", nullable: true },
  resolution: { type: "string", nullable: true },
  bitrate: { type: "integer", nullable: true, description: "As the source reported it (guardrail 19a) — normalize by `source`" },
  videoDecision: { type: "string", nullable: true },
  audioDecision: { type: "string", nullable: true },
  container: { type: "string", nullable: true },
  transcodeReason: { type: "string", nullable: true },
  location: { type: "string", nullable: true, description: "lan | wan | relay" },
  bandwidth: { type: "integer", nullable: true, description: "kbps" },
  secure: { type: "boolean", nullable: true },
  relayed: { type: "boolean", nullable: true },
  introStartMs: { type: "integer", nullable: true },
  introEndMs: { type: "integer", nullable: true },
  creditsStartMs: { type: "integer", nullable: true },
  creditsEndMs: { type: "integer", nullable: true },
  referenceId: { type: "string", nullable: true, description: "The first segment's id when this row continues a resume chain" },
  createdAt: { type: "string", format: "date-time" },
} satisfies Record<string, OpenApiSchema>;

// `{ <label>, count }[]` — the breakdown rows the play statistics share.
function playCountRows(label: string, labelSchema: OpenApiSchema = { type: "string" }): OpenApiSchema {
  return {
    type: "array",
    items: { type: "object", required: [label, "count"], properties: { [label]: labelSchema, count: { type: "integer" } } },
  };
}

// One entry of the caller's own consolidated history (MyWatchHistoryItem,
// src/lib/my-watch-history.ts) — the lean field set: no IP, codecs or ids of
// the media-server identity.
const MY_HISTORY_ITEM = {
  type: "object",
  properties: {
    id: { type: "string", description: "The latest play's id — any play id of the entry opens it at /play-history/mine/{id}" },
    source: { type: "string" },
    startedAt: { type: "string", format: "date-time" },
    stoppedAt: { type: "string", format: "date-time" },
    duration: { type: "integer" },
    playDuration: { type: "integer", description: "The latest play's seconds" },
    watched: { type: "boolean", description: "Any play of the entry counted as watched" },
    completed: { type: "boolean" },
    tmdbId: { type: "integer", nullable: true },
    mediaType: { type: "string", enum: ["MOVIE", "TV"], nullable: true },
    title: { type: "string" },
    year: { type: "string", nullable: true },
    posterPath: { type: "string", nullable: true },
    seasonNumber: { type: "integer", nullable: true },
    episodeNumber: { type: "integer", nullable: true },
    episodeTitle: { type: "string", nullable: true },
    platform: { type: "string", nullable: true },
    player: { type: "string", nullable: true },
    device: { type: "string", nullable: true },
    playMethod: { type: "string", nullable: true },
    posterUrl: { type: "string", nullable: true },
    playCount: { type: "integer", description: "How many plays the entry collapses" },
    totalPlaySeconds: { type: "integer" },
  },
} satisfies OpenApiSchema;

// The fields a recorded cron run answers around its own counts — each route
// sends the ones its schema lists: `ok` (false on a degraded run, which also
// sets `error` and X-Cron-Degraded), the run's `durationMs`, who drove it
// (`trigger`, CronActor.trigger in src/lib/cron-auth.ts) and when it finished.
const CRON_RUN_FIELDS = {
  ok: { type: "boolean", description: "false on a degraded run, with `error` and X-Cron-Degraded" },
  error: { type: "string", description: "Only on a degraded run (ok: false)" },
  durationMs: { type: "integer" },
  trigger: { type: "string", enum: ["admin", "cron"] },
  timestamp: { type: "string", format: "date-time" },
} satisfies Record<string, OpenApiSchema>;

// A cron or sync route's answer: its run, or a skip (CRON_SKIPPED). The run
// branch requires a key a skip never carries, so the two never both match.
function cronRunOrSkip(run: OpenApiSchema): OpenApiSchema {
  return { oneOf: [run, CRON_SKIPPED] };
}

// One server's library resync (/sync/plex, /sync/jellyfin), or the skip while
// that service's resync already runs. A GET ?job= poll replays the POST's
// answer, so all four operations share it.
const LIBRARY_RESYNC_ANSWER = cronRunOrSkip({
  type: "object",
  required: ["scanned", "checked", "marked", "full"],
  properties: {
    scanned: {
      type: "object",
      required: ["movies", "tv"],
      description: "Titles found on the server (only this run's window when incremental)",
      properties: { movies: { type: "integer" }, tv: { type: "integer" } },
    },
    checked: { type: "integer", description: "PENDING and APPROVED requests checked against the library" },
    marked: { type: "integer", description: "Requests marked AVAILABLE" },
    full: { type: "boolean", description: "true: a full replace of this server's rows; false: the incremental add" },
  },
});

// A Radarr/Sonarr cache refresh (/sync/radarr, /sync/sonarr — the `written`
// outcome of refreshArrCache, src/lib/arr-cache-refresh.ts).
const ARR_CACHE_SYNC_RESULT = {
  type: "object",
  required: ["wanted", "available"],
  properties: {
    wanted: { type: "integer" },
    available: { type: "integer" },
    failedInstances: {
      type: "array",
      items: { type: "string" },
      description: "Named instances whose fetch failed and kept their rows (X-Cron-Degraded). Absent when every instance answered",
    },
  },
} satisfies OpenApiSchema;

// The library-metadata prewarm's counts (prewarmLibraryCache,
// src/lib/tmdb-prewarm.ts).
const LIBRARY_PREWARM_COUNTS = {
  total: { type: "integer" },
  fetched: { type: "integer" },
  backfilled: { type: "integer" },
  skipped: { type: "integer" },
  failed: { type: "integer" },
} satisfies Record<string, OpenApiSchema>;

// A most-played title on GET /popular: the title plus its play counts
// (EnrichedMedia, src/app/api/popular/route.ts).
const SERVER_POPULAR_TITLE = {
  allOf: [
    { $ref: "#/components/schemas/TmdbMedia" },
    {
      type: "object",
      properties: {
        plays: { type: "integer", description: "Completed watches in the sort's window (a show sums its episodes)" },
        allTimePlays: { type: "integer" },
        viewers: { type: "integer" },
        episodes: { type: "integer" },
        totalHours: { type: "number" },
      },
    },
  ],
} satisfies OpenApiSchema;

// One Radarr/Sonarr instance as GET /admin/arr-instances and the save's answer
// list it (instanceView, src/app/api/admin/arr-instances/route.ts): the registry
// entry plus the stored connection settings ("" when unset). Secrets only as
// has* flags — never the API key or webhook secret.
const ARR_INSTANCE_VIEW = {
  type: "object",
  properties: {
    slug: { type: "string", description: "'' = default, '4k', or a named slug" },
    name: { type: "string" },
    restricted: { type: "boolean" },
    serverAll: { type: "boolean" },
    skipLibraryCheck: { type: "boolean" },
    autoRoute: { type: "object", nullable: true, properties: { animeOnly: { type: "boolean" }, genreIds: { type: "array", items: { type: "integer" } }, originalLanguages: { type: "array", items: { type: "string" } } } },
    url: { type: "string", description: "Any embedded credential stripped" },
    externalUrl: { type: "string", description: "Any embedded credential stripped" },
    rootFolder: { type: "string" },
    qualityProfileId: { type: "string", description: "The stored value, \"\" when unset" },
    minimumAvailability: { type: "string" },
    languageProfileId: { type: "string" },
    hasApiKey: { type: "boolean" },
    hasWebhookSecret: { type: "boolean" },
  },
} satisfies OpenApiSchema;

// One Sonarr season of a title (TitleSeason, src/lib/arr-title.ts).
const ARR_TITLE_SEASON = {
  type: "object",
  properties: {
    seasonNumber: { type: "integer" },
    monitored: { type: "boolean" },
    episodeCount: { type: "integer", description: "Sonarr's own \"(monitored AND aired) OR has a file\"" },
    episodeFileCount: { type: "integer" },
    totalEpisodeCount: { type: "integer" },
    sizeOnDisk: { type: "number" },
    nextAiring: { type: "string", format: "date-time", nullable: true },
    previousAiring: { type: "string", format: "date-time", nullable: true },
  },
} satisfies OpenApiSchema;

// A movie or series as the title manager shows it (ArrTitle, projectTitle in
// src/lib/arr-title.ts) — named fields only (guardrail 5e). The title's own
// folder on disk is projected too and left out here.
const ARR_TITLE = {
  type: "object",
  properties: {
    service: ARR_SERVICE,
    instance: { type: "string" },
    arrId: { type: "integer", description: "Radarr movie id / Sonarr series id" },
    title: { type: "string" },
    year: { type: "integer", nullable: true },
    tmdbId: { type: "integer", nullable: true },
    tvdbId: { type: "integer", nullable: true },
    imdbId: { type: "string", nullable: true },
    status: { type: "string", nullable: true, description: "The arr's own status word (Radarr announced/inCinemas/released/deleted, Sonarr continuing/ended/upcoming/deleted)" },
    monitored: { type: "boolean" },
    qualityProfileId: { type: "integer", nullable: true },
    rootFolderPath: { type: "string", nullable: true, description: "One of the instance's root folders (GET's `rootFolders`)" },
    tags: { type: "array", items: { type: "integer" } },
    sizeOnDisk: { type: "number" },
    added: { type: "string", format: "date-time", nullable: true },
    hasFile: { type: "boolean", description: "Radarr: the movie has a file. Sonarr: at least one episode does" },
    minimumAvailability: { type: "string", nullable: true, description: "Radarr only (null on a series)" },
    inCinemas: { type: "string", format: "date-time", nullable: true, description: "Radarr only" },
    physicalRelease: { type: "string", format: "date-time", nullable: true, description: "Radarr only" },
    digitalRelease: { type: "string", format: "date-time", nullable: true, description: "Radarr only" },
    isAvailable: { type: "boolean", nullable: true, description: "Radarr only" },
    studio: { type: "string", nullable: true, description: "Radarr only" },
    seriesType: { type: "string", nullable: true, description: "Sonarr only (null on a movie)" },
    seasonFolder: { type: "boolean", nullable: true, description: "Sonarr only" },
    monitorNewItems: { type: "string", nullable: true, description: "Sonarr v4 only; null on v3" },
    network: { type: "string", nullable: true, description: "Sonarr only" },
    episodeCount: { type: "integer", description: "Regular seasons summed (specials excluded, guardrail 14a)" },
    episodeFileCount: { type: "integer" },
    nextAiring: { type: "string", format: "date-time", nullable: true },
    previousAiring: { type: "string", format: "date-time", nullable: true },
    seasons: { type: "array", items: ARR_TITLE_SEASON, description: "Every season Sonarr lists, specials (season 0) included; empty on a movie" },
  },
} satisfies OpenApiSchema;

// The instance's own choices (Choice / RootFolderChoice, src/lib/arr-title.ts).
const ARR_CHOICE = { type: "object", properties: { id: { type: "integer" }, name: { type: "string" } } } satisfies OpenApiSchema;
const ARR_ROOT_FOLDER_CHOICE = {
  type: "object",
  properties: { path: { type: "string" }, freeSpace: { type: "number", nullable: true }, accessible: { type: "boolean" } },
} satisfies OpenApiSchema;

// One episode of a series' season (TitleEpisode, src/lib/arr-title.ts).
const ARR_TITLE_EPISODE = {
  type: "object",
  properties: {
    id: { type: "integer" },
    seasonNumber: { type: "integer" },
    episodeNumber: { type: "integer" },
    absoluteEpisodeNumber: { type: "integer", nullable: true },
    title: { type: "string" },
    airDateUtc: { type: "string", format: "date-time", nullable: true },
    monitored: { type: "boolean" },
    hasFile: { type: "boolean" },
    episodeFileId: { type: "integer", nullable: true },
    finaleType: { type: "string", nullable: true, description: "series | season | midseason when Sonarr knows the episode ends one" },
  },
} satisfies OpenApiSchema;

// One file of a title (TitleFile, src/lib/arr-title.ts). Its absolute path is
// projected too (ADMIN-only) and left out here; `relativePath` names the file.
const ARR_TITLE_FILE = {
  type: "object",
  properties: {
    id: { type: "integer" },
    relativePath: { type: "string", description: "Relative to the title's folder" },
    size: { type: "number" },
    dateAdded: { type: "string", format: "date-time", nullable: true },
    quality: { type: "string", nullable: true },
    qualityTags: QUALITY_TAGS,
    languages: { type: "array", items: { type: "string" } },
    customFormats: { type: "array", items: { type: "string" } },
    customFormatScore: { type: "integer", nullable: true },
    qualityCutoffNotMet: { type: "boolean" },
    releaseGroup: { type: "string", nullable: true },
    sceneName: { type: "string", nullable: true },
    edition: { type: "string", nullable: true, description: "Radarr only" },
    seasonNumber: { type: "integer", nullable: true, description: "Sonarr only" },
    episodes: { type: "array", items: { type: "object", properties: { seasonNumber: { type: "integer" }, episodeNumber: { type: "integer" } } } },
    media: {
      type: "object",
      nullable: true,
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
    },
  },
} satisfies OpenApiSchema;

// The arr's ids for commands it queued — followed at GET /admin/arr/commands.
const ARR_COMMAND_IDS = { type: "array", items: { type: "integer" } } satisfies OpenApiSchema;

// A command's status (CommandStatus, src/lib/arr-system.ts).
const ARR_COMMAND_STATUSES = ["queued", "started", "completed", "failed", "aborted", "cancelled", "orphaned", "unknown"];

// One Radarr/Sonarr command (ArrCommandRow, src/lib/arr-system.ts): Arr
// System's explicit field list, the message masked — never the command body
// (guardrail 5e).
const ARR_COMMAND_ROW = {
  type: "object",
  properties: {
    id: { type: "integer" },
    name: { type: "string", description: "The arr's label (\"Rss Sync\"), else its command name" },
    commandName: { type: "string" },
    status: { type: "string", enum: ARR_COMMAND_STATUSES },
    trigger: { type: "string", enum: ["manual", "scheduled", "other"] },
    queued: { type: "string", format: "date-time", nullable: true },
    started: { type: "string", format: "date-time", nullable: true },
    ended: { type: "string", format: "date-time", nullable: true },
    durationSeconds: { type: "number", nullable: true },
    message: { type: "string", nullable: true, description: "Credentials masked" },
  },
} satisfies OpenApiSchema;

// The per-instance fan-out of the Arr System tabs and the arr calendar
// (InstanceReport, src/lib/arr-system-data.ts; CalendarReport,
// arr-calendar-data.ts): every enabled instance, each one that failed named
// once in `errors` with the kind of failure, never as a 502.
const ARR_INSTANCE_REF = {
  type: "object",
  properties: { service: ARR_SERVICE, slug: { type: "string" }, name: { type: "string" } },
} satisfies OpenApiSchema;
const ARR_FANOUT_ERROR = {
  type: "object",
  properties: {
    service: ARR_SERVICE,
    instance: { type: "string" },
    error: { type: "string" },
    kind: { type: "string", enum: ARR_ERROR_KINDS, description: "Why the read failed — translate this, not the English `error`" },
  },
} satisfies OpenApiSchema;
function arrInstanceReport(result: Record<string, OpenApiSchema>): OpenApiSchema {
  return {
    type: "object",
    required: ["instances", "errors", "results"],
    properties: {
      instances: { type: "array", items: ARR_INSTANCE_REF },
      errors: { type: "array", items: ARR_FANOUT_ERROR },
      results: {
        type: "array",
        description: "One entry per instance that was read, in `instances` order",
        items: { type: "object", properties: { service: ARR_SERVICE, instance: { type: "string" }, ...result } },
      },
    },
  };
}

// An indexer and a download client as Arr System lists them (ArrIndexer /
// ArrDownloadClient, src/lib/arr-system.ts) — never their `fields`, which hold
// the provider's URL, API key and password (guardrail 5e).
const ARR_INDEXER = {
  type: "object",
  required: ["id", "name", "enableRss", "enableAutomaticSearch", "enableInteractiveSearch"],
  properties: {
    id: { type: "integer" },
    name: { type: "string" },
    implementation: { type: "string", nullable: true },
    protocol: PROTOCOL,
    priority: { type: "integer", nullable: true },
    enableRss: { type: "boolean" },
    enableAutomaticSearch: { type: "boolean" },
    enableInteractiveSearch: { type: "boolean" },
    supportsRss: { type: "boolean", nullable: true },
    supportsSearch: { type: "boolean", nullable: true },
    tags: { type: "array", items: { type: "integer" } },
    managedByProwlarr: { type: "boolean", description: "Synced from Prowlarr (read from the name) — Prowlarr's next sync turns a change back" },
  },
} satisfies OpenApiSchema;
const ARR_DOWNLOAD_CLIENT = {
  type: "object",
  required: ["id", "name", "enable"],
  properties: {
    id: { type: "integer" },
    name: { type: "string" },
    implementation: { type: "string", nullable: true },
    protocol: PROTOCOL,
    priority: { type: "integer", nullable: true },
    enable: { type: "boolean" },
    removeCompletedDownloads: { type: "boolean", nullable: true },
    removeFailedDownloads: { type: "boolean", nullable: true },
    tags: { type: "array", items: { type: "integer" } },
  },
} satisfies OpenApiSchema;

// PATCH /admin/arr/providers' 200 — and its background job's answer, which
// GET ?job= replays.
const ARR_PROVIDER_SAVED = {
  type: "object",
  required: ["provider"],
  properties: {
    provider: { oneOf: [ARR_INDEXER, ARR_DOWNLOAD_CLIENT], description: "The provider as the arr now holds it" },
    timedOut: { type: "boolean", enum: [true], description: "Present when the arr was still testing as the wait ended" },
  },
} satisfies OpenApiSchema;

// POST /admin/arr/providers/test's 200 (ProviderTestResult, src/lib/arr-system.ts)
// — and its background job's answer, which GET ?job= replays.
const ARR_PROVIDER_TEST_RESULTS = {
  type: "object",
  required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          ok: { type: "boolean" },
          warning: { type: "boolean" },
          messages: { type: "array", items: { type: "string" }, description: "The arr's validation failures, credentials masked" },
          uncertain: { type: "boolean", enum: [true], description: "Test All only, present only when true" },
        },
      },
    },
  },
} satisfies OpenApiSchema;

// One file of a download the arr would not import on its own (ImportCandidate,
// src/lib/arr-queue.ts): GET /admin/queue/import and its preview list the same.
// `path` is the key the dialog selects by — it only ever SELECTS among the
// arr's own rows (guardrail 5d).
const QUEUE_IMPORT_CANDIDATE = {
  type: "object",
  properties: {
    path: { type: "string" },
    name: { type: "string" },
    size: { type: "number" },
    quality: { type: "string", nullable: true },
    languages: { type: "array", items: { type: "string" } },
    releaseGroup: { type: "string", nullable: true },
    target: { type: "string", nullable: true },
    episodes: { type: "array", items: { type: "object", properties: { seasonNumber: { type: "integer" }, episodeNumber: { type: "integer" } } } },
    rejections: { type: "array", items: { type: "string" } },
    importable: { type: "boolean" },
    movieId: { type: "integer", nullable: true, description: "Radarr's movie id the file is matched to" },
    seriesId: { type: "integer", nullable: true, description: "Sonarr's series id the file is matched to" },
    episodeIds: { type: "array", items: { type: "integer" } },
    qualityId: { type: "integer", nullable: true },
    languageIds: { type: "array", items: { type: "integer" } },
    releaseType: { type: "string", nullable: true, description: "Sonarr only" },
  },
} satisfies OpenApiSchema;

// POST /requests/bulk's answer, 201 and 200 alike: one CreateOutcome per item
// (src/lib/request-bulk.ts) and how many rows were created.
const REQUEST_BULK_ANSWER = {
  type: "object",
  required: ["results", "created"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        required: ["tmdbId", "mediaType", "result"],
        properties: {
          tmdbId: { type: "integer" },
          mediaType: { $ref: "#/components/schemas/MediaType" },
          result: {
            type: "string",
            enum: ["created", "auto-approved", "already-available", "already-requested", "skipped-declined", "no-permission", "blacklisted", "rating-blocked", "error"],
          },
          pushFailed: {
            type: "boolean",
            enum: [true],
            description: "Additive: an auto-approval whose Radarr/Sonarr push failed and went back to PENDING (its result is `created`)",
          },
        },
      },
    },
    created: { type: "integer", description: "Rows created (results `created` or `auto-approved`)" },
  },
} satisfies OpenApiSchema;

// The registry versions GET/POST /admin/media-instances hand out: a SHA-256 of
// the named servers as GET shows them, sent back as POST `baseVersion`.
const MEDIA_INSTANCES_VERSION = {
  type: "string",
  pattern: "^[0-9a-f]{64}$",
  description: "Opaque — send it back as POST `baseVersion`",
} satisfies OpenApiSchema;

// One server of GET/POST /admin/media-instances (instanceView in that route):
// connection settings as stored, credentials only as has* flags, URLs with any
// userinfo stripped.
const PLEX_INSTANCE_VIEW = {
  type: "object",
  required: ["slug", "name", "restricted", "serverUrl", "adminEmail", "hasAdminToken", "libraries", "moviePathStripPrefix", "tvPathStripPrefix"],
  properties: {
    slug: { type: "string", description: "'' = the default server" },
    name: { type: "string" },
    restricted: { type: "boolean" },
    serverUrl: { type: "string", description: "Userinfo stripped" },
    adminEmail: { type: "string" },
    hasAdminToken: { type: "boolean", description: "The token itself is never returned" },
    libraries: { type: "string", description: "Comma-joined section keys; \"\" = all" },
    moviePathStripPrefix: { type: "string", description: "\"\" = inherits the default server's prefix" },
    tvPathStripPrefix: { type: "string" },
  },
} satisfies OpenApiSchema;
const JELLYFIN_INSTANCE_VIEW = {
  type: "object",
  required: ["slug", "name", "restricted", "url", "hasApiKey", "restrictSignIn", "libraries", "moviePathStripPrefix", "tvPathStripPrefix"],
  properties: {
    slug: { type: "string", description: "'' = the default server" },
    name: { type: "string" },
    restricted: { type: "boolean" },
    url: { type: "string", description: "Userinfo stripped" },
    hasApiKey: { type: "boolean", description: "The API key itself is never returned" },
    restrictSignIn: { type: "boolean", description: "true when no row is stored (fail-closed)" },
    libraries: { type: "string", description: "Comma-joined library ids; \"\" = all" },
    moviePathStripPrefix: { type: "string", description: "\"\" = inherits the default server's prefix" },
    tvPathStripPrefix: { type: "string" },
  },
} satisfies OpenApiSchema;

// The never-watched report's rows (NwTitleRow / NwSeasonRow,
// src/lib/never-watched-report.ts). A row's state is never `watched`: watched
// titles and seasons are left out of the report.
const NEVER_WATCHED_STATE = { type: "string", enum: NW_STATES.filter((s) => s !== "watched") } satisfies OpenApiSchema;
const NEVER_WATCHED_ROW_VERDICT = {
  state: NEVER_WATCHED_STATE,
  reason: { type: "string", nullable: true, enum: [...NW_REASONS, null], description: "Why it can't be judged (state unobservable)" },
  reasonServers: { type: "array", items: { type: "string" } },
  windowStart: { type: "string", format: "date-time", nullable: true },
  days: { type: "integer", nullable: true },
  fullyObserved: { type: "boolean" },
} satisfies Record<string, OpenApiSchema>;
const NEVER_WATCHED_TITLE_ROW = {
  type: "object",
  required: ["kind"],
  properties: {
    kind: { type: "string", enum: ["title"] },
    tmdbId: { type: "integer" },
    mediaType: { $ref: "#/components/schemas/MediaType" },
    title: { type: "string" },
    posterPath: { type: "string", nullable: true },
    year: { type: "string", nullable: true },
    servers: { type: "array", items: { type: "string" } },
    addedAt: { type: "string", format: "date-time", nullable: true },
    shelfStart: { type: "string", format: "date-time", nullable: true },
    ...NEVER_WATCHED_ROW_VERDICT,
    softPlays: { type: "integer" },
    softServers: { type: "array", items: { type: "string" } },
    arr: {
      type: "array",
      items: { type: "object", properties: { service: { type: "string", enum: ["radarr", "sonarr"] }, instance: { type: "string" }, sizeOnDisk: { type: "number" } } },
    },
    sizeOnDisk: { type: "number", nullable: true },
    protected: { type: "boolean" },
    cleanup: {
      type: "object",
      description: "What Library cleanup's rules say about it now",
      properties: {
        matched: { type: "array", items: { type: "string", enum: Object.keys(CLEANUP_RULE_LABELS) } },
        excludedBy: { type: "array", items: { type: "string", enum: Object.keys(CLEANUP_EXCLUSION_LABELS) } },
        candidate: { type: "boolean" },
      },
    },
    eligible: { type: "boolean", description: "Exactly what a cleanup dry run would include" },
  },
} satisfies OpenApiSchema;
const NEVER_WATCHED_SEASON_ROW = {
  type: "object",
  required: ["kind"],
  properties: {
    kind: { type: "string", enum: ["season"] },
    tmdbId: { type: "integer" },
    mediaType: { type: "string", enum: ["TV"] },
    title: { type: "string" },
    posterPath: { type: "string", nullable: true },
    year: { type: "string", nullable: true },
    servers: { type: "array", items: { type: "string" } },
    seasonNumber: { type: "integer" },
    episodes: { type: "integer" },
    ...NEVER_WATCHED_ROW_VERDICT,
    airing: { type: "boolean", description: "The show is still airing and this is its latest season" },
    sizeOnDisk: { type: "number", nullable: true },
    sizeMismatch: { type: "boolean", description: "Radarr/Sonarr and the media server disagree on what this season is" },
  },
} satisfies OpenApiSchema;

// One server's outcome of an upstream watch-record refresh (UpstreamRefreshResult,
// src/lib/upstream-watch-data.ts): the never-watched Refresh answers it.
const UPSTREAM_REFRESH_RESULT = {
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
const WATCH_SYNC_DIRECTION_RESULT = {
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
const WATCH_SYNC_PAIR_RESULT = {
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
const WATCH_SYNC_RUN_RESULT = {
  type: "object",
  required: ["pairs", "aborted"],
  properties: {
    pairs: { type: "array", items: WATCH_SYNC_PAIR_RESULT },
    aborted: { type: "boolean" },
  },
} satisfies OpenApiSchema;
// A Plex account or Jellyfin user as the watch sync page lists it: the
// MediaServerUser row id, never a provider id, token or address.
const WATCH_SYNC_SERVER_USER = {
  type: "object",
  properties: {
    id: { type: "string", description: "MediaServerUser id" },
    username: { type: "string" },
    server: { type: "string", description: "The server's display name" },
    active: { type: "boolean" },
  },
} satisfies OpenApiSchema;
const WATCH_SYNC_MARK_COUNTS = {
  type: "object",
  properties: {
    pending: { type: "integer" },
    marked: { type: "integer" },
    already: { type: "integer" },
    missing: { type: "integer" },
    failed: { type: "integer" },
  },
} satisfies OpenApiSchema;

// One outbound notification channel as every /admin/notification-agents answer
// shows it (toPublicAgent, src/lib/notify-agents-admin.ts): `hasSecret`, never
// the secret.
const NOTIFICATION_AGENT = {
  type: "object",
  properties: {
    id: { type: "string" },
    kind: { type: "string", enum: [...AGENT_KINDS] },
    name: { type: "string" },
    enabled: { type: "boolean" },
    events: { type: "array", items: { type: "string" } },
    config: {
      type: "object",
      description: "webhook: { url, headerName, template|null }; ntfy: { url, topic, priority 1-5, attachPoster }; gotify: { url, priority 0-10 }",
      properties: {
        url: { type: "string" },
        headerName: { type: "string", description: "webhook" },
        template: { type: "string", nullable: true, description: "webhook" },
        topic: { type: "string", description: "ntfy" },
        priority: { type: "integer", description: "ntfy 1-5, gotify 0-10" },
        attachPoster: { type: "boolean", description: "ntfy" },
      },
    },
    hasSecret: { type: "boolean", description: "The secret itself is never returned." },
    configValid: { type: "boolean", description: "false when the stored config no longer passes validation — the channel is skipped until it is edited and saved." },
    lastStatus: { type: "string", nullable: true, enum: ["ok", "failed"] },
    lastError: { type: "string", nullable: true },
    lastAttemptAt: { type: "string", format: "date-time", nullable: true },
    createdAt: { type: "string", format: "date-time" },
  },
} satisfies OpenApiSchema;

// GET /admin/stats pieces (src/app/api/admin/stats/route.ts and
// src/lib/admin-stats-data.ts / arr-stats.ts).
const ADMIN_STATS_SERVER_BREAKDOWN = {
  type: "object",
  properties: {
    movies: { type: "integer" },
    series: { type: "integer" },
    episodes: { type: "integer" },
    episodeRuntimeMinutes: { type: "number", description: "Only seasons opened recently carry a runtime, so this undercounts" },
    episodeRuntimeHours: { type: "number" },
  },
} satisfies OpenApiSchema;
const ADMIN_STATS_DURATION = {
  type: "object",
  properties: {
    count: { type: "integer" },
    medianSeconds: { type: "number", nullable: true },
    p90Seconds: { type: "number", nullable: true },
  },
} satisfies OpenApiSchema;
// One disk of a Radarr/Sonarr instance (DiskSpaceEntry). The mount `path` is
// sent too and, like every filesystem path, left out here.
const ADMIN_STATS_DISK = {
  type: "object",
  properties: {
    label: { type: "string" },
    freeSpace: { type: "number" },
    totalSpace: { type: "number" },
  },
} satisfies OpenApiSchema;

// One ratings cache row as the ratings-state dump reads it — directly, without
// getCache's delete-on-expiry, so a stale or not-found entry still shows.
const DEBUG_RATINGS_CACHE_ROW = {
  type: "object",
  properties: {
    key: { type: "string" },
    exists: { type: "boolean" },
    cachedAt: { type: "string", format: "date-time", nullable: true },
    expiresAt: { type: "string", format: "date-time", nullable: true },
    stale: { type: "boolean" },
    notFoundSentinel: { type: "boolean", description: "The provider said it has no such title" },
    data: { description: "The cached ratings payload as stored (null for a miss, an unparseable row or the not-found sentinel)" },
  },
} satisfies OpenApiSchema;

// The fields the Radarr and Sonarr webhooks acknowledge with (handleArrWebhook,
// src/lib/arr-webhook.ts, and each route's dispatch): every 200 is
// { ok: true } plus whichever of these the delivery's outcome sets.
const ARR_WEBHOOK_ACK_FIELDS = {
  ok: { type: "boolean", enum: [true] },
  message: { type: "string", description: "A Test delivery only" },
  health: { type: "boolean", enum: [true], description: "A Health / HealthRestored delivery" },
  forwarded: { type: "boolean", description: "Health only: false when held back" },
  manualInteraction: { type: "boolean", enum: [true], description: "A ManualInteractionRequired delivery: admins were alerted" },
  evicted: { type: "boolean", description: "A delete event: whether the cache rows were removed (only once the arr confirmed it)" },
  skipped: { type: "boolean", enum: [true], description: "Nothing to change for this delivery" },
  marked: { type: "integer", description: "Requests flipped to AVAILABLE" },
} satisfies Record<string, OpenApiSchema>;

// DELETE /admin/arr/title/files' 200 — and the background delete's answer,
// which GET ?job= replays.
const ARR_FILES_DELETED = {
  type: "object",
  required: ["deleted"],
  properties: { deleted: { type: "integer", description: "The number of files deleted" } },
} satisfies OpenApiSchema;

// A library item's on-disk path as a fix-match caller sees it (libraryPathFor,
// src/lib/library-path-view.ts, guardrail 37f): the full path for an ADMIN,
// the file name alone for a MANAGE_ISSUES delegate.
const FIX_MATCH_FILE_PATH = {
  type: "string",
  nullable: true,
  description: "ADMIN: the full on-disk path. A MANAGE_ISSUES delegate gets the file name only (guardrail 37f). null when the server has no row.",
} satisfies OpenApiSchema;

// The library path preview of one library type: the inferred mount point and a
// spread of up to six mount-relative sample paths (library-sample-paths route).
const LIBRARY_PATH_SAMPLE = {
  type: "object",
  properties: {
    mountPoint: { type: "string", description: "The longest shared folder prefix, \"\" when there is none" },
    samples: { type: "array", maxItems: 6, items: { type: "string" }, description: "Paths with the mount point stripped (TV on Plex: one per show folder)" },
  },
} satisfies OpenApiSchema;

// The statistics' top-title rows (topRewatched / topWatched in
// PlayHistoryStatsResult, src/lib/play-history.ts).
const PLAY_TOP_TITLE_ROWS = {
  type: "array",
  items: {
    type: "object",
    properties: {
      tmdbId: { type: "integer" },
      mediaType: { type: "string" },
      title: { type: "string" },
      posterPath: { type: "string", nullable: true },
      plays: { type: "integer" },
      viewers: { type: "integer" },
    },
  },
} satisfies OpenApiSchema;

const spec = {
  openapi: "3.0.3",
  info: {
    title: "Summonarr API",
    version: "1.0.0",
    description:
      "Internal REST API for Summonarr — media request aggregator with Plex/Jellyfin, Radarr/Sonarr, and TMDB integration.",
  },
  // Next serves every route under BASE_PATH, and a relative server url resolves
  // against the document's origin — without the prefix an external viewer or a
  // generated client would call /api/… on a subpath deployment.
  servers: [{ url: withBasePath("/api"), description: "Application API" }],
  components: {
    securitySchemes: {
      session: {
        type: "apiKey",
        in: "cookie",
        name: "__Host-summonarr-session",
        description:
          "Summonarr session JWT (jose HS256), web transport. Named `summonarr-session` in non-HTTPS contexts.",
      },
      sessionBearer: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description:
          "Same session JWT delivered to native/mobile clients via the sign-in response body (`Authorization: Bearer <session-jwt>`). Every authenticated route resolves bearer first, then the session cookie, so this is accepted anywhere the `session` cookie scheme is.",
      },
      cronSecret: {
        type: "http",
        scheme: "bearer",
        description: "CRON_SECRET bearer token for sync/cron routes",
      },
    },
    schemas: {
      MediaType: { type: "string", enum: ["MOVIE", "TV"] },
      TmdbMedia: TMDB_MEDIA,
      RequestStatus: {
        type: "string",
        enum: ["PENDING", "APPROVED", "DECLINED", "AVAILABLE"],
      },
      UserRole: { type: "string", enum: ["USER", "ADMIN", "ISSUE_ADMIN"] },
      OidcAllowlist: {
        type: "object",
        properties: {
          groups: { type: "array", items: { type: "string", maxLength: 256 }, maxItems: 50 },
          groupsClaim: { type: "string", pattern: "^[A-Za-z0-9_.:/-]{1,128}$", default: "groups" },
          requestGroupsScope: { type: "boolean", default: false },
          emailDomains: { type: "array", items: { type: "string" }, maxItems: 50 },
          existingUsersOnly: { type: "boolean", default: false },
        },
      },
      QueueImportFile: {
        type: "object",
        description: "One file of a queued download, chosen by the path Radarr/Sonarr reported, with optional corrections (ids only — the objects are read from the instance)",
        required: ["path"],
        properties: {
          path: { type: "string", maxLength: 4096 },
          movieId: { type: "integer", minimum: 1, description: "Radarr: re-match to this movie" },
          seriesId: { type: "integer", minimum: 1, description: "Sonarr: re-match to this series (requires episodeIds)" },
          episodeIds: { type: "array", items: { type: "integer", minimum: 1 }, minItems: 1, maxItems: 500, description: "Sonarr: the episodes the file holds" },
          qualityId: { type: "integer", minimum: 0 },
          languageIds: { type: "array", items: { type: "integer", minimum: -2 }, maxItems: 50 },
          releaseGroup: { type: "string", maxLength: 100 },
          releaseType: { type: "string", enum: ["unknown", "singleEpisode", "multiEpisode", "seasonPack"], description: "Sonarr only" },
        },
      },
      WatchGradeSpread: {
        type: "object",
        nullable: true,
        description: "Users per letter; notGraded = approved, fulfilled requests but no letter yet",
        properties: {
          A: { type: "integer" },
          B: { type: "integer" },
          C: { type: "integer" },
          D: { type: "integer" },
          F: { type: "integer" },
          notGraded: { type: "integer" },
        },
      },
      CleanupSettings: {
        type: "object",
        description: "Library cleanup rules. Day-based exclusions take 0 to mean off.",
        properties: {
          unwatchedEnabled: { type: "boolean" },
          unwatchedDays: { type: "integer", minimum: 1, maximum: 3650 },
          neverWatchedEnabled: { type: "boolean" },
          neverWatchedDays: { type: "integer", minimum: 1, maximum: 3650 },
          votesEnabled: { type: "boolean" },
          votesMin: { type: "integer", minimum: 1, maximum: 1000 },
          minAgeDays: { type: "integer", minimum: 0, maximum: 3650 },
          recentRequestDays: { type: "integer", minimum: 0, maximum: 3650 },
          excludeAiring: { type: "boolean" },
          requireUpstreamCheck: { type: "boolean", description: "Hold back watch-rule candidates until every holding server's own watch records were checked successfully within 7 days (exclusion `upstreamUnchecked`). Default true." },
        },
      },
      IssueType: {
        type: "string",
        enum: ["BAD_VIDEO", "WRONG_AUDIO", "MISSING_SUBTITLES", "WRONG_MATCH", "OTHER"],
      },
      IssueStatus: {
        type: "string",
        enum: ["OPEN", "IN_PROGRESS", "RESOLVED"],
      },
      IssueScope: {
        type: "string",
        enum: ["FULL", "SEASON", "EPISODE"],
      },
      MediaRequest: {
        type: "object",
        properties: {
          id: { type: "string" },
          tmdbId: { type: "integer" },
          mediaType: { $ref: "#/components/schemas/MediaType" },
          title: { type: "string" },
          posterPath: { type: "string", nullable: true },
          releaseYear: { type: "string", nullable: true },
          status: { $ref: "#/components/schemas/RequestStatus" },
          note: { type: "string", nullable: true },
          adminNote: { type: "string", nullable: true },
          approvedAt: {
            type: "string",
            format: "date-time",
            nullable: true,
            description:
              "When this request was approved by a decision: an admin, or auto-approve at creation. Cleared on " +
              "decline. null if it never was itself — a copy of an already-approved request, or a PENDING request a " +
              "library sync marked AVAILABLE when its title arrived. Present on responses that return the whole row.",
          },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      Issue: {
        type: "object",
        properties: {
          id: { type: "string" },
          tmdbId: { type: "integer" },
          tvdbId: { type: "integer", nullable: true },
          mediaType: { $ref: "#/components/schemas/MediaType" },
          title: { type: "string" },
          posterPath: { type: "string", nullable: true },
          issueType: { $ref: "#/components/schemas/IssueType" },
          scope: { $ref: "#/components/schemas/IssueScope" },
          seasonNumber: { type: "integer", nullable: true },
          episodeNumber: { type: "integer", nullable: true },
          note: { type: "string", nullable: true },
          status: { $ref: "#/components/schemas/IssueStatus" },
          resolution: { type: "string", nullable: true },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      Error: {
        type: "object",
        properties: { error: { type: "string" } },
        required: ["error"],
      },
      PaginatedMeta: {
        type: "object",
        properties: {
          total: { type: "integer" },
          page: { type: "integer" },
          pageSize: { type: "integer" },
        },
      },
    },
  },
  security: [{ session: [] }, { sessionBearer: [] }],
  tags: [
    { name: "Health", description: "Liveness / readiness probes" },
    { name: "Discovery", description: "Browse / home / popular / upcoming / top-rated lists" },
    { name: "Config", description: "Public client capability negotiation" },
    { name: "Search", description: "TMDB media search" },
    { name: "Requests", description: "Media request lifecycle" },
    { name: "Issues", description: "Content issue reporting" },
    { name: "Votes", description: "Deletion voting" },
    { name: "Lists", description: "Personal watchlist and hidden (\"not interested\") titles" },
    { name: "Notifications", description: "In-app notification inbox" },
    { name: "Ratings", description: "External ratings (MDBList / OMDB)" },
    { name: "Play History", description: "Watch history and sessions" },
    { name: "Sessions", description: "Active playback sessions" },
    { name: "TV", description: "TV episode / season data" },
    { name: "Person", description: "TMDB person credits" },
    { name: "TV Availability", description: "Episode-level availability" },
    { name: "Profile", description: "Authenticated user profile" },
    { name: "Push", description: "Web push notification subscriptions" },
    { name: "Auth", description: "Authentication helpers" },
    { name: "Admin – Users", description: "User management (ADMIN only)" },
    { name: "Admin – Sync", description: "Library sync triggers" },
    { name: "Admin – Stats", description: "System statistics" },
    { name: "Admin – Audit Log", description: "Audit trail" },
    { name: "Admin – Backup", description: "Database export / import" },
    { name: "Admin – Debug", description: "Pipeline inspection" },
    { name: "Admin – Fix Match", description: "Manual metadata correction" },
    { name: "Admin – Cleanup", description: "Library cleanup: rule-based candidates and admin-confirmed deletion (ADMIN only)" },
    { name: "Admin – Never watched", description: "Library titles and seasons nobody has watched in the server's recorded history, checked against each media server's own watch records (ADMIN only, read-only)" },
    { name: "Admin – Watch sync", description: "Pair a Plex account with a Jellyfin user and pick a direction; what one server counts as watched is marked played on the other. Add-only (ADMIN only)" },
    { name: "Admin – Arr", description: "Managing Radarr/Sonarr without opening them: a title's settings, files, history and searches; download history and blocklist; the calendar; tasks, indexers, download clients and storage (ADMIN only)" },
    { name: "Admin – Missing", description: "Radarr/Sonarr titles that should already have a file: released movies and aired episodes — or, in cutoff mode, files below the quality profile's cutoff (ADMIN only)" },
    { name: "Admin – Downloads", description: "Radarr/Sonarr download queues, health checks, the Summonarr webhook connection and \"Open in\" links (ADMIN only)" },
    { name: "Admin – Settings", description: "Radarr/Sonarr and Plex/Jellyfin instance registries, the OIDC sign-in allowlist and outbound notification channels (ADMIN only)" },
    { name: "Discord", description: "Discord OAuth / role sync" },
    { name: "Settings", description: "Application settings (ADMIN only)" },
    { name: "Webhooks", description: "Inbound webhooks from media servers / ARR" },
    { name: "Cron", description: "Scheduled maintenance jobs (CRON_SECRET, or an admin session)" },
    { name: "Events", description: "Server-sent events stream" },
  ],
  paths: {

    "/health": {
      get: {
        tags: ["Health"],
        summary: "Readiness probe (public)",
        description:
          "Not a bare liveness reply — it pings Postgres with SELECT 1 and returns 503 when the database is unreachable, so an orchestrator restarts a live Node process fronting a dead DB. This is the Docker/compose HEALTHCHECK target.",
        security: [],
        responses: {
          "200": {
            description: "Service and database are up",
            content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" }, db: { type: "string", enum: ["up"] } } } } },
          },
          "503": {
            description: "Database unreachable — the container should be considered unhealthy",
            content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" }, db: { type: "string", enum: ["down"] } } } } },
          },
        },
      },
    },

    "/config/compat": {
      get: {
        tags: ["Config"],
        summary: "Public client capability descriptor (integers only)",
        security: [],
        responses: {
          "200": {
            description: "API contract floor/ceiling and minimum client build",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    apiVersion: { type: "integer" },
                    minApiVersion: { type: "integer" },
                    minClient: { type: "object", additionalProperties: { type: "integer" } },
                  },
                },
              },
            },
          },
        },
      },
    },

    "/browse": {
      get: {
        tags: ["Discovery"],
        summary: "Discover/browse movies or TV with filters and availability enrichment",
        parameters: [
          { name: "mediaType", in: "query", schema: { type: "string", enum: ["movie", "tv"], default: "movie" }, description: "Anything but `tv` is read as `movie`" },
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "sortBy", in: "query", schema: { type: "string" } },
          { name: "genreId", in: "query", schema: { type: "string" } },
          { name: "keywordId", in: "query", schema: { type: "string" } },
          { name: "companyId", in: "query", schema: { type: "string" }, description: "TMDB production company id(s), digits separated by , or |. Movies and TV." },
          { name: "networkId", in: "query", schema: { type: "string" }, description: "TMDB TV network id(s), digits separated by , or |. Ignored for movies." },
          { name: "certification", in: "query", schema: { type: "string", enum: ["G", "PG", "PG-13", "R", "NC-17"] }, description: "Highest US certification to include. Movies only (ignored for TV); titles with no US rating are excluded." },
          { name: "fromYear", in: "query", schema: { type: "integer" } },
          { name: "toYear", in: "query", schema: { type: "integer" } },
          { name: "minRating", in: "query", schema: { type: "number" } },
          { name: "minVoteCount", in: "query", schema: { type: "integer" } },
          { name: "ratingFilter", in: "query", schema: { type: "string" } },
          { name: "watchProvider", in: "query", schema: { type: "string" } },
          { name: "watchRegion", in: "query", schema: { type: "string" } },
          { name: "hideAvailable", in: "query", schema: { type: "string", enum: ["1"] }, description: "`1` hides titles available on a server the user can see; any other value is off" },
        ],
        responses: {
          "200": {
            description: "{ items, totalPages, page } — discovery results with availability enrichment",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["items", "totalPages", "page"],
                  properties: {
                    items: TMDB_MEDIA_LIST,
                    totalPages: { type: "integer" },
                    page: { type: "integer" },
                  },
                },
              },
            },
          },
          "429": { description: "Rate limited (30 req/min per user)" },
          "500": { description: "{ error } — the TMDB query failed" },
        },
      },
    },
    "/home": {
      get: {
        tags: ["Discovery"],
        summary: "Home discovery rails (trending / popular / etc.)",
        parameters: [
          { name: "hideAvailable", in: "query", schema: { type: "string", enum: ["1"] }, description: "`1` hides titles available on a server the user can see" },
        ],
        responses: {
          "200": {
            description: "{ featured, carousels } — grouped discovery rails with availability enrichment",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["featured", "carousels"],
                  properties: {
                    featured: { ...TMDB_MEDIA_LIST, description: "The first trending movie and the first trending TV title (0–2 items)" },
                    carousels: {
                      type: "array",
                      description:
                        "The rails that have at least one title, in display order. `id` is trending, recently-added, for-you, popular-movies, popular-tv, " +
                        "upcoming-movies, on-the-air-tv, top-rated-movies or top-rated-tv — an additive set, so render an unknown id generically. " +
                        "`title` is in the viewer's language.",
                      items: {
                        type: "object",
                        required: ["id", "title", "items"],
                        properties: { id: { type: "string" }, title: { type: "string" }, items: TMDB_MEDIA_LIST },
                      },
                    },
                  },
                },
              },
            },
          },
          "429": { description: "Rate limited (30 req/min per user)" },
          "500": { description: "{ error }" },
        },
      },
    },
    "/recommendations": {
      get: {
        tags: ["Discovery"],
        summary: "Full personalized For You set with availability enrichment",
        parameters: [
          { name: "filter", in: "query", schema: { type: "string", enum: ["available", "missing"] }, description: "Restrict to titles on (or not on) the user's media servers" },
          { name: "type", in: "query", schema: { type: "string", enum: ["movie", "tv"] }, description: "Restrict to one media type" },
          { name: "sort", in: "query", schema: { type: "string", enum: ["match", "newest", "rating"], default: "match" }, description: "Ordering; \"match\" keeps the engine's own ranking" },
        ],
        responses: {
          "200": {
            description: "Ranked recommendation items ({ items, total, available }); each item carries recommendedBecause naming the strongest seed, plus recommendedBecause.seeds listing every seed (strongest first, capped at 25; seedCount is the true total)",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["items", "total", "available"],
                  properties: {
                    items: TMDB_MEDIA_LIST,
                    total: { type: "integer", description: "How many titles passed the filter (the length of `items`)" },
                    available: { type: "integer", description: "The whole ranked set before the filter" },
                  },
                },
              },
            },
          },
          "404": { description: "feature.page.forYou is disabled" },
          "429": { description: "Rate limited (30 req/min per user)" },
          "500": { description: "{ error }" },
        },
      },
    },
    "/popular": {
      get: {
        tags: ["Discovery"],
        summary: "Most-played movies and TV on the connected media servers",
        parameters: [
          { name: "mediaType", in: "query", schema: { type: "string", enum: ["movies", "tv"] }, description: "Restrict to one type (note the plural \"movies\"); omitted returns both" },
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "sort", in: "query", schema: { type: "string", enum: ["trending", "plays", "viewers"], default: "trending" } },
        ],
        responses: {
          "200": {
            description: "{ movies, tv, totalMovies, totalTv, totalPages, page, sort, rankOffset } with availability enrichment",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["movies", "tv", "totalMovies", "totalTv", "totalPages", "page", "sort", "rankOffset"],
                  properties: {
                    movies: { type: "array", items: SERVER_POPULAR_TITLE },
                    tv: { type: "array", items: SERVER_POPULAR_TITLE },
                    totalMovies: { type: "integer" },
                    totalTv: { type: "integer" },
                    totalPages: { type: "integer" },
                    page: { type: "integer" },
                    sort: { type: "string", enum: ["plays", "viewers", "trending"] },
                    rankOffset: { type: "integer", description: "The rank before this page's first title: (page − 1) × the page size" },
                  },
                },
              },
            },
          },
          "403": { description: "feature.page.popular is disabled" },
          "429": { description: "Rate limited (30 req/min per user)" },
          "500": { description: "{ error } — reading the play counts or the titles failed" },
        },
      },
    },
    "/upcoming": {
      get: {
        tags: ["Discovery"],
        summary: "Upcoming releases",
        parameters: [
          { name: "hideAvailable", in: "query", schema: { type: "string", enum: ["1"] }, description: "`1` hides titles available on a server the user can see" },
        ],
        responses: {
          "200": {
            description: "{ items } — upcoming releases (movies and TV interleaved by date) with availability enrichment",
            content: { "application/json": { schema: { type: "object", required: ["items"], properties: { items: TMDB_MEDIA_LIST } } } },
          },
          "403": { description: "feature.page.upcoming is disabled" },
          "429": { description: "Rate limited (30 req/min per user)" },
          "502": { description: "{ error } — the upstream fetch failed (never a 200 with an empty list)" },
        },
      },
    },
    "/top-rated": {
      get: {
        tags: ["Discovery"],
        summary: "Top-rated movies or TV",
        parameters: [
          { name: "mediaType", in: "query", schema: { type: "string", enum: ["movies", "tv"] }, description: "Restrict to one type (note the plural \"movies\"); omitted returns both" },
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "sortBy", in: "query", schema: { type: "string", enum: ["imdb", "letterboxd", "rt", "trakt", "mdblist"], default: "imdb" }, description: "Rating source to sort by; an unknown value is read as `imdb`" },
          { name: "fromYear", in: "query", schema: { type: "string", pattern: "^\\d{4}$" }, description: "4-digit year; anything else is ignored" },
          { name: "toYear", in: "query", schema: { type: "string", pattern: "^\\d{4}$" }, description: "4-digit year; anything else is ignored" },
          { name: "minImdb", in: "query", schema: { type: "number" } },
          { name: "minVotes", in: "query", schema: { type: "integer" } },
          { name: "hideAvailable", in: "query", schema: { type: "string", enum: ["1"] }, description: "`1` hides titles available on a server the user can see" },
        ],
        responses: {
          "200": {
            description: "{ movies, tv, totalMovies, totalTv, totalPages, page, sortBy } with availability enrichment",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["movies", "tv", "totalMovies", "totalTv", "totalPages", "page", "sortBy"],
                  properties: {
                    movies: TMDB_MEDIA_LIST,
                    tv: TMDB_MEDIA_LIST,
                    totalMovies: { type: "integer" },
                    totalTv: { type: "integer" },
                    totalPages: { type: "integer" },
                    page: { type: "integer" },
                    sortBy: { type: "string", enum: ["imdb", "letterboxd", "rt", "trakt", "mdblist"], description: "The sort actually applied" },
                  },
                },
              },
            },
          },
          "403": { description: "feature.page.top is disabled" },
          "429": { description: "Rate limited (30 req/min per user)" },
          "500": { description: "{ error }" },
        },
      },
    },

    "/search": {
      get: {
        tags: ["Search"],
        summary: "Search TMDB for movies or TV shows",
        parameters: [
          { name: "q", in: "query", schema: { type: "string", maxLength: 200 }, description: "An empty or whitespace-only query answers 200 with `[]`" },
          { name: "type", in: "query", schema: { type: "string", enum: ["movie", "tv"] } },
        ],
        responses: {
          "200": {
            description:
              "Search results enriched with library availability and request/ARR state",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "integer" },
                      mediaType: { type: "string", enum: ["movie", "tv"] },
                      title: { type: "string" },
                      posterPath: { type: "string", nullable: true },
                      plexAvailable: { type: "boolean" },
                      jellyfinAvailable: { type: "boolean" },
                      arrPending: { type: "boolean" },
                      arr4kPending: { type: "boolean" },
                      arr4kAvailable: { type: "boolean" },
                      requested: { type: "boolean" },
                      requestedByMe: { type: "boolean" },
                    },
                  },
                },
              },
            },
          },
          "400": { description: "Query longer than 200 characters", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "429": { description: "Rate limited (30 req/min per user)" },
          "500": { description: "{ error } — TMDB search failed" },
          "503": { description: "Maintenance mode (non-ADMIN callers)" },
        },
      },
    },

    "/requests": {
      get: {
        tags: ["Requests"],
        summary: "List media requests",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "status", in: "query", schema: { $ref: "#/components/schemas/RequestStatus" } },
          { name: "sort", in: "query", schema: { type: "string", enum: ["newest", "oldest"] } },
          { name: "q", in: "query", schema: { type: "string" }, description: "Title search filter (wildcard characters stripped, length bounded)" },
        ],
        responses: {
          "200": {
            description: "Paginated request list (fixed page size 20). MANAGE_REQUESTS callers see every request with the full row plus user { name, email }; everyone else sees only their own, in a reduced row (no adminNote/approvedAt) with user { name }. An unknown status/sort value is ignored.",
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    { $ref: "#/components/schemas/PaginatedMeta" },
                    { type: "object", properties: { requests: { type: "array", items: { $ref: "#/components/schemas/MediaRequest" } }, statusCounts: { type: "object", additionalProperties: { type: "integer" }, description: "Count per status for the same scope and `q`, ignoring the selected `status`" } } },
                  ],
                },
              },
            },
          },
        },
      },
      post: {
        tags: ["Requests"],
        summary: "Create a new media request",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["tmdbId", "mediaType", "_token"],
                properties: {
                  tmdbId: { type: "integer" },
                  mediaType: { $ref: "#/components/schemas/MediaType" },
                  note: { type: "string", maxLength: 500 },
                  _token: { type: "string", description: "HMAC-signed request token from /api/requests/token" },
                  arrInstance: { type: "string", description: "Target Radarr/Sonarr instance slug ('' = default, '4k', or a named instance). Omit to auto-route (anime rules) / default." },
                  is4k: { type: "boolean", description: "Legacy shorthand for arrInstance='4k'" },
                  qualityProfileId: { type: "integer", description: "REQUEST_ADVANCED only; validated against the resolved instance's profiles" },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "Request created", content: { "application/json": { schema: { $ref: "#/components/schemas/MediaRequest" } } } },
          "200": {
            description: "Title is already available in a library the caller can see — no request created",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["alreadyAvailable", "tmdbId", "mediaType", "title"],
                  properties: {
                    alreadyAvailable: { type: "boolean", enum: [true] },
                    tmdbId: { type: "integer" },
                    mediaType: { $ref: "#/components/schemas/MediaType" },
                    title: { type: "string" },
                  },
                },
              },
            },
          },
          "400": { description: "Validation error (missing tmdbId/mediaType, non-positive tmdbId, bad mediaType, note over 500 chars, unavailable/unconfigured instance, invalid qualityProfileId)" },
          "403": { description: "Missing/invalid `_token`, no permission for the media type/instance/profile, Discord link required, blacklisted title, content-rating cap, or permanently declined" },
          "409": { description: "Duplicate request" },
          "422": { description: "TMDB could not verify the title" },
          "429": { description: "Quota exceeded, or the per-minute request rate limit (Retry-After)" },
          "502": { description: "Could not connect to Radarr/Sonarr to validate the quality profile" },
          "503": { description: "Maintenance mode (non-ADMIN callers)" },
        },
      },
    },
    "/requests/token": {
      get: {
        tags: ["Requests"],
        summary: "Get an HMAC token required to submit a request",
        parameters: [
          { name: "tmdbId", in: "query", required: true, schema: { type: "integer", minimum: 1 } },
          { name: "mediaType", in: "query", required: true, schema: { $ref: "#/components/schemas/MediaType" } },
        ],
        responses: {
          "200": {
            description: "Short-lived HMAC token",
            content: { "application/json": { schema: { type: "object", properties: { token: { type: "string" } } } } },
          },
          "400": { description: "Missing, non-positive or out-of-range tmdbId, or invalid mediaType" },
        },
      },
    },
    "/requests/{id}": {
      patch: {
        tags: ["Requests"],
        summary: "Update request status or trigger ARR action (MANAGE_REQUESTS)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  status: { $ref: "#/components/schemas/RequestStatus" },
                  adminNote: { type: "string", maxLength: ADMIN_NOTE_MAX },
                  qualityProfileId: { type: "integer", minimum: 1, description: "One-time quality-profile override for the Radarr/Sonarr push; only used by the APPROVE transition" },
                  qualityProfileName: { type: "string", maxLength: 100, description: "Carried only so the audit log reads the profile name" },
                  retry: { type: "boolean", description: "Re-push to Radarr/Sonarr (APPROVED requests only; 400 otherwise)" },
                  search: { type: "boolean", description: "Trigger search in ARR (APPROVED or AVAILABLE only). For a TV request this queues only what is missing (SeasonSearch for a season with nothing on disk and 2+ episodes missing, EpisodeSearch for the rest — never SeriesSearch); a series with nothing missing answers 200 with an `arrError` explaining so." },
                  permanent: { type: "boolean", description: "Permanently decline" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Updated request. An approve / retry / search answers the row plus `arrError` (string or null) — when the Radarr/Sonarr push of an approval definitely fails the status is rolled back to PENDING and the body reflects it; when the push was sent but got no answer the row stays APPROVED (a later sync re-pushes it) and the body adds `arrPushOutcomeUnknown: true`. `adminNote` alone (no status/search/retry) is a note-only edit; an empty note clears it. Transitions: PENDING→APPROVED|DECLINED, APPROVED→AVAILABLE|DECLINED, DECLINED→PENDING|APPROVED.", content: { "application/json": { schema: { allOf: [{ $ref: "#/components/schemas/MediaRequest" }, { type: "object", properties: { arrError: { type: "string", nullable: true }, arrPushOutcomeUnknown: { type: "boolean", enum: [true], description: "Additive: present only when the approval's push got no answer and the row stays APPROVED" } } }] } } } },
          "400": { description: "Invalid status, adminNote over " + ADMIN_NOTE_MAX + " chars, bad qualityProfileId/Name, search on a request that is not APPROVED/AVAILABLE, retry on one that is not APPROVED, or a quality profile the instance does not have" },
          "403": { description: "Forbidden" },
          "404": { description: "Not found" },
          "409": { description: "The request changed status concurrently" },
          "422": { description: "Transition not allowed from the current status" },
          "429": { description: "Rate limited (60 req/min per admin)" },
          "502": { description: "Could not connect to Radarr/Sonarr to validate the quality profile" },
          "503": { description: "Maintenance mode (non-ADMIN callers)" },
        },
      },
      delete: {
        tags: ["Requests"],
        summary: "Delete a request (MANAGE_REQUESTS), or self-cancel your own PENDING request",
        description:
          "Two callers share this handler. A user holding MANAGE_REQUESTS may delete any request in any status, which is audited as REQUEST_DELETE. The request's OWNER may delete it only while still PENDING, and that is deliberately not audited — cancelling your own pending request is routine. Anyone else gets 403. A missing row 404s before the authorization branch runs.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Deleted", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" } } } } } },
          "401": { description: "Unauthenticated" },
          "403": { description: "Forbidden — caller lacks MANAGE_REQUESTS and is not the owner of a still-PENDING request" },
          "404": { description: "Not found" },
          "409": { description: "Self-cancel only — the request left PENDING between the read and the delete" },
          "503": { description: "Maintenance mode (non-ADMIN callers)" },
        },
      },
    },

    "/requests/{id}/arr-status": {
      get: {
        tags: ["Requests"],
        summary: "Why an approved request isn't available yet (MANAGE_REQUESTS)",
        description:
          "Live read of the request's OWN Radarr/Sonarr instance (its tmdbId, mediaType and arrInstance — never a caller-supplied id): " +
          "the title, its queue (`/api/v3/queue/details`), its DownloadFailed and import history since the request's approval (`approvedAt`, else " +
          "`createdAt`), and whether a Plex/Jellyfin library the REQUESTER can see holds it. Answers ONE verdict, the first that holds: " +
          "`unreachable` (title read failed) → `ready` (a visible library row the next sync marks from: always for a movie or an untracked " +
          "title, for a series only once Sonarr calls it complete) → `notInArr` → `inArrNotInLibrary` (the arr has the file / the whole " +
          "series, no library row yet — the sync's Radarr/Sonarr marking pass marks it available next run) → `waitingForLibrary` (the same, for a requester with a media-server preference — the ARR marking pass skips them, so the request waits for a library row they can see) → `unreachable` (queue read failed) → `importBlocked` (a download Radarr/Sonarr say needs attention) → " +
          "`downloading` → `unmonitored` (also a Sonarr series monitored at the series level with no aired episode monitored or on disk and no monitored airing ahead — `monitored` is then true) → `notReleased` (movie: no physical/digital date passed; series: no regular-season episode aired) → " +
          "`unreachable` (history read failed) → `downloadFailed` (a failure with no import of the title at or after it) → `incomplete` (Sonarr has some aired episodes) → `waiting`. A failed " +
          "Radarr/Sonarr read is the `unreachable` verdict with `errorKind`, not an error status. COARSE by design — MANAGE_REQUESTS delegates " +
          "read it: no output path, download id, download client or indexer name, release title or arr URL; the arr's status messages are " +
          "returned with credentials, URLs, paths and file names removed. Only APPROVED or AVAILABLE requests. Read-only, not audited, rate " +
          "limited per caller.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "The verdict and its details",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    verdict: { type: "string", enum: ["unreachable", "notInArr", "ready", "inArrNotInLibrary", "waitingForLibrary", "importBlocked", "downloading", "unmonitored", "notReleased", "downloadFailed", "incomplete", "waiting"] },
                    service: { type: "string", enum: ["radarr", "sonarr"] },
                    errorKind: { type: "string", nullable: true, enum: ARR_ERROR_KINDS, description: "Set when the verdict is `unreachable`" },
                    monitored: { type: "boolean", nullable: true },
                    hasFile: { type: "boolean", nullable: true, description: "Radarr: the movie's file. Sonarr: any episode file" },
                    released: { type: "boolean", nullable: true },
                    releasedAt: { type: "string", format: "date-time", nullable: true, description: "Movie: the earlier past physical/digital date (a calendar date, midnight UTC)" },
                    expectedAt: { type: "string", format: "date-time", nullable: true, description: "Movie: next physical/digital date. Series: next airing" },
                    episodes: { type: "object", nullable: true, description: "Sonarr's regular-season counts (specials excluded)", properties: { withFile: { type: "integer" }, total: { type: "integer" } } },
                    inLibrary: { type: "boolean", description: "A Plex/Jellyfin library the requester can see holds the title" },
                    downloads: {
                      type: "array",
                      maxItems: 5,
                      items: {
                        type: "object",
                        properties: {
                          phase: QUEUE_PHASE,
                          pending: { type: "boolean", description: "A release the arr is holding back (delay profile, client unavailable)" },
                          progress: { type: "number", minimum: 0, maximum: 1 },
                          timeLeftSeconds: { type: "integer", nullable: true },
                          estimatedCompletion: { type: "string", format: "date-time", nullable: true },
                          attention: { type: "boolean", description: "Radarr/Sonarr's own needs-attention verdict" },
                          messages: { type: "array", items: { type: "string" }, maxItems: 3, description: "Scrubbed: no credentials, URLs, paths, file names or release names" },
                          quality: { type: "string", nullable: true },
                          episodes: { type: "integer", description: "Sonarr: episodes in this download; 0 on a movie" },
                        },
                      },
                    },
                    downloadCount: { type: "integer" },
                    failures: { type: "object", properties: { count: { type: "integer", description: "Failed DOWNLOADS since `since` — Sonarr's per-episode records of one pack count once" }, lastAt: { type: "string", format: "date-time", nullable: true }, message: { type: "string", nullable: true } } },
                    since: { type: "string", format: "date-time", description: "The request's approval, else its creation" },
                    checkedAt: { type: "string", format: "date-time" },
                    canOpenQueue: { type: "boolean", description: "The caller can open the ADMIN-only Download Queue" },
                    queue: { type: "object", nullable: true, description: "ADMIN only (null for a delegate, and when the arr doesn't have the title): the Download Queue filter naming exactly this title's downloads — /admin/queue?service=&instance=&arrId=", properties: { service: { type: "string", enum: ["radarr", "sonarr"] }, instance: { type: "string" }, arrId: { type: "integer" } } },
                  },
                },
              },
            },
          },
          "400": { description: "The request names an invalid instance slug" },
          "401": { description: "Not signed in" },
          "403": { description: "Missing MANAGE_REQUESTS" },
          "404": { description: "No such request" },
          "409": { description: "Request not APPROVED or AVAILABLE" },
          "422": { description: "The request's instance is not configured" },
          "429": { description: "Rate limited" },
        },
      },
    },

    "/requests/{id}/releases": {
      get: {
        tags: ["Requests"],
        summary: "Interactive release search for an approved request (MANAGE_REQUESTS)",
        description:
          "On the request's own Radarr/Sonarr instance. MOVIE: `{ releases }`. TV without `season`: `{ seasons }` " +
          "(Sonarr's per-season counts, regular seasons only — no indexer is hit); TV with `season`: `{ releases }` for " +
          "that season. Sonarr has no whole-series release search, so a season is always required. Releases are projected " +
          "(no indexer download URL), and each `guid` is an OPAQUE handle (32 hex chars) bound to this request, instance " +
          "and season for 30 minutes — never the indexer's guid, which some indexers build from the apikey'd download " +
          "link. Only APPROVED or AVAILABLE requests (409 otherwise); 409 when the title is not in the arr yet. Searches " +
          "are rate limited per admin. With `async=1` a release search answers 202 `{ job }` at once and runs in the " +
          "background (indexers can take longer than a reverse proxy holds a request); GET `?job=<id>` answers 202 while it " +
          "runs, then the search's own status and body, 404 once the job is gone (expired, another user's, or a restart). " +
          "Without it the answer is synchronous.",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "season", in: "query", schema: { type: "integer", minimum: 0 } },
          { name: "async", in: "query", schema: { type: "string", enum: ["1"] }, description: "Run the search as a background job" },
          { name: "job", in: "query", schema: { type: "string", pattern: "^[0-9a-f]{32}$" }, description: "Poll a background search" },
        ],
        responses: {
          "200": {
            description: "Releases, or for TV without a season the season list",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    releases: {
                      type: "array",
                      items: ARR_RELEASE,
                    },
                    seasons: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          seasonNumber: { type: "integer" },
                          aired: { type: "integer", description: "Aired monitored episodes (plus any with a file) — Sonarr's own count" },
                          missing: { type: "integer" },
                          monitored: { type: "boolean" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          "202": jobAnswer(
            "{ job } — a background search started (`async=1`), or the same search already running was joined; polling `?job=` answers { job, running: true } while it runs",
            SEARCH_JOB,
          ),
          "400": { description: "Invalid season, or the request names an instance that no longer exists" },
          "403": { description: "Missing MANAGE_REQUESTS" },
          "404": { description: "No such request, or (with `?job=`) the job is gone — expired, another user's, or a restart; search again" },
          "409": { description: "Request not approved/available, or the title is not in the arr" },
          "422": { description: "Instance not configured, or the series' TVDB id can't be resolved" },
          "429": { description: "Rate limited" },
          "502": { description: "The arr could not be reached" },
        },
      },
      post: {
        tags: ["Requests"],
        summary: "Grab one release for an approved request (MANAGE_REQUESTS)",
        description:
          "Sends the release (by the handle a GET on this route returned) to the download client through the request's own instance. " +
          "The request's status is untouched — the Download webhook / sync flips it when the file lands. The handle is " +
          "spent on success. Audited ARR_RELEASE_GRAB with the release name; the guid is never recorded (some indexers " +
          "embed the apikey in it).",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["release"],
                properties: {
                  release: { type: "string", pattern: "^[0-9a-f]{32}$", description: "The handle from the GET's `guid`" },
                  season: { type: "integer", minimum: 0, description: "TV: the season the release was searched for" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "{ ok: true } — grabbed", content: { "application/json": { schema: OK_TRUE } } },
          "400": { description: "Invalid body, or the request names an instance that no longer exists" },
          "403": { description: "Missing MANAGE_REQUESTS" },
          "404": { description: "No such request" },
          "409": { description: "Request not approved/available, the title is not in the arr, the indexer/download client refused the release (the arr's reason, masked), or a grab of this handle is already in progress (nothing was sent)" },
          "410": { description: "Unknown or expired handle, one from a different search, or the arr's own 30-minute search cache no longer has the release — search again" },
          "422": { description: "Instance not configured, or the series' TVDB id can't be resolved" },
          "502": { description: "The arr could not be reached or refused the grab" },
          "503": { description: "Maintenance mode (non-ADMIN callers)" },
        },
      },
    },
    "/requests/batch": {
      patch: {
        tags: ["Requests"],
        summary: "Bulk approve or decline requests (requires MANAGE_REQUESTS)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["ids", "status"],
                properties: {
                  ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 100, description: "Only requests still PENDING are transitioned; others are skipped silently" },
                  status: { type: "string", enum: ["APPROVED", "DECLINED"] },
                  adminNote: { type: "string", maxLength: ADMIN_NOTE_MAX },
                  permanent: { type: "boolean", description: "On DECLINED, mark the request permanently declined (at most 25 ids per permanent batch; ignored on APPROVED)" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description:
              "Batch result. On APPROVED, a request whose Radarr/Sonarr add definitely fails is rolled back to PENDING and " +
              "reported in `failed` (with `arrError` summarizing, the same field the single-request PATCH returns); " +
              "both are omitted when every add landed. An add that was sent but got no answer stays APPROVED and is " +
              "listed in `outcomeUnknown` (additive; omitted when empty).",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean" },
                    failed: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: { id: { type: "string" }, title: { type: "string" }, error: { type: "string" } },
                      },
                    },
                    arrError: { type: "string" },
                    outcomeUnknown: { type: "array", items: { type: "string" }, description: "Request ids whose add got no answer and that stay APPROVED" },
                  },
                },
              },
            },
          },
          "400": { description: "ids empty/over 100/not strings, invalid status, adminNote over " + ADMIN_NOTE_MAX + " chars, non-boolean permanent, or a permanent batch over 25 ids (`code: \"permanent-batch-too-large\"`)" },
          "429": { description: "Rate limited (10/min per admin)" },
          "503": { description: "Maintenance mode (non-ADMIN callers)" },
        },
      },
    },

    "/issues": {
      get: {
        tags: ["Issues"],
        summary: "List issues",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", default: 50, maximum: 100 } },
          { name: "cursor", in: "query", required: false, schema: { type: "string" }, description: "Continue after a page: `<createdAt ISO>|<id>` of its last issue (or the page's `X-Next-Cursor`). Absent or malformed ⇒ the first page." },
        ],
        responses: {
          "200": {
            description: "Issues for the caller (own issues, or all when MANAGE_ISSUES), newest first (createdAt, then id), each with a `user` ({ name, email } for MANAGE_ISSUES, { name } otherwise)",
            headers: { "X-Next-Cursor": { description: "The `cursor` for the next page; sent only when the page is full", schema: { type: "string" } } },
            content: {
              "application/json": {
                schema: { type: "array", items: { $ref: "#/components/schemas/Issue" } },
              },
            },
          },
        },
      },
      post: {
        tags: ["Issues"],
        summary: "Create a new issue",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["tmdbId", "mediaType", "issueType"],
                properties: {
                  tmdbId: { type: "integer" },
                  mediaType: { $ref: "#/components/schemas/MediaType" },
                  issueType: { $ref: "#/components/schemas/IssueType" },
                  scope: { $ref: "#/components/schemas/IssueScope" },
                  note: { type: "string", maxLength: 1000 },
                  seasonNumber: { type: "integer" },
                  episodeNumber: { type: "integer" },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "Created issue (tvdbId is resolved server-side from tmdbId, never taken from the body). The caller's identical report still OPEN or IN_PROGRESS (same title, type, scope, season, episode and note) is answered instead, unchanged and without a second admin notification", content: { "application/json": { schema: { $ref: "#/components/schemas/Issue" } } } },
          "400": { description: "Validation error" },
          "403": { description: "feature.page.issues is disabled" },
          "422": { description: "Title could not be verified with TMDB, or is not in a library the caller can see" },
          "429": { description: "Rate limited (the `rateLimitIssues` setting per minute, default 10)" },
          "503": { description: "Maintenance mode (non-ADMIN callers)" },
        },
      },
    },
    "/issues/{id}": {
      patch: {
        tags: ["Issues"],
        summary: "Update issue status / resolution, or trigger an ARR re-search (ADMIN / ISSUE_ADMIN)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  status: { $ref: "#/components/schemas/IssueStatus" },
                  resolution: { type: "string", maxLength: 1000 },
                  refetch: { type: "boolean", description: "`true`: trigger a Radarr/Sonarr re-search for the issue media (scope's own search: movie MoviesSearch, EPISODE EpisodeSearch, SEASON SeasonSearch, FULL SeriesSearch). Takes precedence over status/resolution; 409 when the issue is RESOLVED. `false` (or null, or absent) is the status/resolution edit; any other value is 400." },
                  instance: { type: "string", description: "With `refetch`: the Radarr/Sonarr instance slug to search on ('' = default). An invalid slug is 400." },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Updated issue (unchanged, with nothing written or broadcast, when the body changes nothing). A `refetch` answers the issue plus `arrError` (string, or null when the search was queued); a failed search is still 200 with `arrError` set.", content: { "application/json": { schema: { allOf: [{ $ref: "#/components/schemas/Issue" }, { type: "object", properties: { arrError: { type: "string", nullable: true } } }] } } } },
          "400": { description: "Invalid status, resolution over 1000 chars or empty with no status, a `refetch` that is not a boolean, or (with refetch) an invalid instance slug" },
          "403": { description: "Forbidden" },
          "404": { description: "Not found" },
          "409": { description: "`refetch` on a RESOLVED issue, or `{ error: \"status-conflict\" }` — the status changed concurrently" },
          "503": { description: "Maintenance mode (non-ADMIN callers)" },
        },
      },
      delete: {
        tags: ["Issues"],
        summary: "Delete an issue (ADMIN / ISSUE_ADMIN)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Deleted", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" } } } } } },
          "403": { description: "Forbidden" },
          "404": { description: "Not found" },
          "503": { description: "Maintenance mode (non-ADMIN callers)" },
        },
      },
    },
    "/issues/{id}/messages": {
      get: {
        tags: ["Issues"],
        summary: "List messages on an issue",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "The newest 500 messages, oldest first, each with author { name, role } (+ email for MANAGE_ISSUES callers)",
            content: { "application/json": { schema: { type: "array", maxItems: 500, items: threadEntry("issueId") } } },
          },
          "403": { description: "Not the reporter and no MANAGE_ISSUES" },
          "404": { description: "No such issue" },
        },
      },
      post: {
        tags: ["Issues"],
        summary: "Add a message to an issue",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["body"],
                properties: { body: { type: "string", maxLength: 2000 } },
              },
            },
          },
        },
        description: "An admin's first reply flips an OPEN issue to IN_PROGRESS; the reporter replying to their own RESOLVED issue reopens it.",
        responses: {
          "201": { description: "Message added (the new message with its author)", content: { "application/json": { schema: threadEntry("issueId") } } },
          "400": { description: "Missing/non-string/empty body, or over 2000 characters" },
          "403": { description: "Not the reporter and no MANAGE_ISSUES, or issue reporting is disabled (non-admins)" },
          "404": { description: "No such issue" },
          "429": { description: "Rate limited (10/min per user)" },
          "503": { description: "Maintenance mode (non-ADMIN callers)" },
        },
      },
    },
    "/requests/{id}/comments": {
      get: {
        tags: ["Requests"],
        summary: "List comments on a request",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "The newest 500 comments, oldest first, each with author { name, role } (+ email for MANAGE_REQUESTS callers) and fromAdmin",
            content: { "application/json": { schema: { type: "array", maxItems: 500, items: threadEntry("requestId") } } },
          },
          "403": { description: "Not the requester and no MANAGE_REQUESTS, or request comments are turned off (non-managers)" },
          "404": { description: "No such request" },
        },
      },
      post: {
        tags: ["Requests"],
        summary: "Add a comment to a request",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["body"],
                properties: { body: { type: "string", maxLength: 2000 } },
              },
            },
          },
        },
        description: "Private to the requester and MANAGE_REQUESTS holders. A manager's comment notifies the requester; the requester's notifies the managers (per each person's notification preferences). A requester cannot comment on a permanently declined request.",
        responses: {
          "201": { description: "Comment added (the new comment with its author)", content: { "application/json": { schema: threadEntry("requestId") } } },
          "400": { description: "Missing/non-string/empty body, or over 2000 characters" },
          "403": { description: "Not the requester and no MANAGE_REQUESTS, request closed to comments, or the feature is off (requesters)" },
          "404": { description: "No such request" },
          "429": { description: "Rate limited (10/min per user)" },
          "503": { description: "Maintenance mode (non-ADMIN callers)" },
        },
      },
    },
    "/issues/{id}/files": {
      get: {
        tags: ["Issues"],
        summary: "List the files an issue is about, with the grab behind each (ADMIN)",
        description:
          "Resolves the issue's title on one Radarr/Sonarr instance and lists its files inside the issue's scope (FULL: all; SEASON: that season's; EPISODE: the file holding that S/E), each with the grab that produced it where the title's history can tell (projected — never a release's download URL or guid), and each file's episodes named by SONARR's own titles: the issue's numbers are the media server's, and on an anime or reordered show they can name different episodes. ADMIN only: ISSUE_ADMIN keeps Refetch and Replace-release.",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "instance", in: "query", schema: { type: "string" }, description: "Arr instance slug; defaults to the default instance" },
          { name: "job", in: "query", schema: { type: "string", pattern: "^[0-9a-f]{32}$" }, description: "A background replace's job id (from POST with async: true). When present the issue is not listed: 202 { job, running } while it runs, then the POST's own status and body; 404 when the job is gone (expired, another admin's, or a restart)" },
        ],
        responses: {
          "200": {
            description: "The in-scope files",
            content: { "application/json": { schema: { type: "object", properties: {
              service: { type: "string", enum: ["radarr", "sonarr"] },
              instance: { type: "string" },
              arrId: { type: "integer" },
              scope: {
                type: "object",
                description: "{ kind: movie | series | season | episode, seasonNumber?, episodeNumber? }",
                required: ["kind"],
                properties: {
                  kind: { type: "string", enum: ["movie", "series", "season", "episode"] },
                  seasonNumber: { type: "integer", description: "season and episode scopes" },
                  episodeNumber: { type: "integer", description: "episode scope only" },
                },
              },
              seriesType: { type: "string", nullable: true, description: "Sonarr's series type (standard | daily | anime); null for a movie. Anime numbering may not match the media server's" },
              files: {
                type: "array",
                items: {
                  type: "object",
                  description: "TitleFile (its episodes as { seasonNumber, episodeNumber, title: Sonarr's episode title | null }) plus grab: { event: ArrHistoryEvent, failed: boolean } | null",
                  properties: {
                    ...TITLE_FILE.properties,
                    episodes: {
                      type: "array",
                      description: "The episodes the file holds, each with SONARR's title for it (the issue's numbers are the media server's)",
                      items: {
                        type: "object",
                        required: ["seasonNumber", "episodeNumber", "title"],
                        properties: { seasonNumber: { type: "integer" }, episodeNumber: { type: "integer" }, title: { type: "string", nullable: true } },
                      },
                    },
                    grab: {
                      type: "object",
                      nullable: true,
                      description: "The grab that produced the file; null when the title's history can't tell — the file is then searched for, not blocklisted",
                      required: ["event", "failed"],
                      properties: {
                        event: ARR_HISTORY_EVENT,
                        failed: { type: "boolean", description: "A failure was already recorded for its download — marking it again is refused, so the file is searched for instead" },
                      },
                    },
                  },
                },
              },
              otherFiles: { type: "integer", description: "The title's files outside the issue's scope (not listed)" },
            } } } },
          },
          "202": jobAnswer("With ?job=: the replace is still running — { job, running: true }", JOB_RUNNING),
          "400": { description: "Invalid instance slug (or one over 100 characters), or the arr rejected the read (its validation messages in `messages`)" },
          "403": { description: "Forbidden — ADMIN only" },
          "404": { description: "Issue not found, the title isn't on that instance, the instance isn't configured, or the integration is off; or (with ?job=) the job is gone — reload the issue" },
          "409": { description: "Issue is RESOLVED, or the arr refused in its own words (masked)" },
          "422": { description: "A SEASON/EPISODE issue without its season/episode number" },
          "502": { description: "Radarr/Sonarr failed (worded by kind: API key, unreachable, server)" },
          "504": { description: "Radarr/Sonarr timed out" },
        },
      },
      post: {
        tags: ["Issues"],
        summary: "Delete an issue's broken files, then blocklist their release or search again (ADMIN)",
        description:
          "While a file is on disk Radarr/Sonarr only take an upgrade of it, so this deletes it first. The files and history are re-read; every id must be one of the issue's in-scope files (409, nothing deleted, otherwise). CAS-claims the issue to IN_PROGRESS BEFORE the delete. After the delete, whatever it UNMONITORED (Radarr/Sonarr's \"Unmonitor Deleted Movies/Episodes\" — the state is read before and after) is set back to monitored, before any mark or search: a SeasonSearch, the Missing plan and the arr's own redownload all search monitored items only. `markFailed` marks each deleted file's grab failed — one mark per download — and the arr's Redownload Failed searches again; when it reports that off or can't be read, when the grab was picked by hand and \"Redownload Failed from Interactive Search\" is off, or when a covered episode / the movie is still unmonitored, the search is queued here. Files with no known grab, or an already-failed one, are searched for instead. `search` queues a scoped search (Radarr MoviesSearch; Sonarr EpisodeSearch / SeasonSearch only when the whole season went; for a FULL issue the DELETED episodes only — a SeasonSearch per regular season emptied with 2+ of them, an EpisodeSearch for the rest, never the series' missing backlog — never SeriesSearch; an EpisodeSearch naming the episodes while any is still unmonitored). Records an instance-scoped IssueGrab. Audited ARR_FILE_DELETE, ARR_TITLE_EDIT (the re-monitor), ARR_MARK_FAILED and ISSUE_STATUS_CHANGE. One replace per issue at a time, process-wide (a second POST while one runs is 409, nothing written or sent). With `async: true` everything after the status CAS runs as a background job — 202 { job } at once, poll GET ?job= (a long series' marks outlast a reverse proxy's hold); the synchronous default stays for API callers.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: {
            type: "object",
            required: ["fileIds", "then"],
            properties: {
              instance: { type: "string", description: "Arr instance slug; defaults to the default instance" },
              fileIds: { type: "array", items: { type: "integer", minimum: 1 }, minItems: 1, maxItems: 5000 },
              then: { type: "string", enum: ["markFailed", "search"] },
              async: { type: "boolean", description: "Run everything after the status CAS as a background job: 202 { job } at once, poll GET ?job=. The same admin posting for the same issue while it runs joins it (no rate token spent). Default (absent/false): synchronous." },
            },
          } } },
        },
        responses: {
          "200": {
            description: "Deleted and followed up",
            content: { "application/json": { schema: { type: "object", properties: {
              deleted: { type: "integer" }, requested: { type: "integer" },
              marked: { type: "integer", description: "Downloads marked failed" },
              unmarked: { type: "integer", description: "Marks refused or failed — those files were searched for instead" },
              searched: { type: "boolean" },
              redownload: { type: "boolean", nullable: true, description: "The arr's Redownload Failed switch, read when a mark was planned" },
              redownloading: { type: "integer", description: "Marks the arr's own redownload searches for (no search of ours for their files)" },
              remonitored: { type: "integer", description: "Episodes (Sonarr) or the movie (Radarr: 1) the delete unmonitored and that were monitored again" },
              remonitorFailed: { type: "boolean", description: "Re-reading or re-monitoring failed — the files were searched for by name, and may stay unmonitored in the arr" },
              nothingMissing: { type: "boolean" },
            } } } },
          },
          "202": jobAnswer("async: true — { job }: the replace runs in the background; poll GET ?job= (the same admin re-posting while it runs gets the same job id)", JOB_STARTED),
          "400": { description: "Malformed JSON or body (fileIds / then / async), an invalid instance slug, or the arr rejected a read (its messages in `messages`)" },
          "403": { description: "Forbidden — ADMIN only" },
          "404": { description: "Issue not found, the title isn't on that instance, or the instance isn't configured" },
          "409": { description: "Issue is RESOLVED (before or during), a file isn't one of the issue's in-scope files, or a Replace file is already running for this issue — nothing deleted" },
          "413": { description: "Request body over the 64 KB cap" },
          "422": { description: "A SEASON/EPISODE issue without its season/episode number" },
          "429": { description: "Rate limited (10 per minute per admin); Retry-After header" },
          "502": { description: "Radarr/Sonarr failed; or files were deleted but the delete stopped part-way / the search couldn't be queued — the body then carries the 200 counts plus an `error`" },
          "503": { description: "Maintenance mode" },
          "504": { description: "Radarr/Sonarr timed out before anything was deleted" },
        },
      },
    },

    "/issues/{id}/releases": {
      post: {
        tags: ["Issues"],
        summary: "Grab a specific release for the issue's media (ADMIN / ISSUE_ADMIN)",
        description:
          "CAS-claims the issue to IN_PROGRESS before the grab, then records an instance-scoped IssueGrab row. Routes to Radarr for a MOVIE issue and Sonarr for a TV one. The `guid` is an opaque handle from the GET on this path (bound to this issue and instance, 30-minute TTL, single use) — never a raw indexer guid; `indexerId` is checked but the handle names the indexer. A TV issue must be searchable as a season or an episode (Sonarr has no whole-series release search): a FULL issue, or a SEASON/EPISODE one without its numbers, is 422 before the handle claim and the CAS.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["guid", "indexerId"],
                properties: {
                  guid: { type: "string", minLength: 1, maxLength: 500, description: "Opaque release handle (32 hex) from the GET on this path" },
                  indexerId: { type: "integer", minimum: 1 },
                  instance: { type: "string", description: "Arr instance slug; defaults to the default instance" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Grab accepted", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" } } } } } },
          "400": { description: "Missing or malformed guid / indexerId, or an invalid instance slug" },
          "403": { description: "Forbidden — ADMIN or ISSUE_ADMIN only" },
          "404": { description: "Issue not found" },
          "409": { description: "Issue is already RESOLVED (the handle is handed back), another grab with the same handle is in flight, or the indexer/download client refused the release (the arr's reason, masked)" },
          "410": { description: "The handle is unknown, expired, spent or from another search (a raw guid included), or the arr's own 30-minute search cache no longer has the release — search again" },
          "413": { description: "Request body over the 64 KB cap" },
          "422": { description: "Instance not configured, TVDB resolution failed, or the issue scope is invalid — a TV issue whose scope is FULL, or SEASON/EPISODE without its season/episode number (Sonarr can only search a season or an episode)" },
          "502": { description: "Radarr/Sonarr rejected the grab" },
          "503": { description: "Maintenance mode" },
        },
      },
      get: {
        tags: ["Issues"],
        summary: "Get Sonarr/Radarr releases for issue media (ADMIN / ISSUE_ADMIN)",
        description:
          "Interactive search on one instance for the issue's scope: a MOVIE issue on Radarr; a TV issue on Sonarr for its SEASON or EPISODE " +
          "(a FULL issue, or one missing its numbers, is 422 — Sonarr's series-only release query is the indexers' RSS feed). Answers the bare " +
          "projected `ArrRelease` list (no download URL) — the wire shape the iOS app decodes — with each release's `guid` replaced by an " +
          "OPAQUE handle (32 hex chars) bound to this issue, service and instance for 30 minutes; POST it back to grab. With `async=1` the " +
          "search answers 202 `{ job }` at once and runs in the background (a Sonarr season search can outlast a reverse proxy's hold); " +
          "GET `?job=<id>` answers 202 while it runs, then the search's own status and body, 404 once the job is gone. The same admin " +
          "re-searching the same issue and instance while one runs joins it.",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "instance", in: "query", schema: { type: "string" }, description: "Arr instance slug; defaults to the default instance" },
          { name: "async", in: "query", schema: { type: "string", enum: ["1"] }, description: "Run the search as a background job" },
          { name: "job", in: "query", schema: { type: "string", pattern: "^[0-9a-f]{32}$" }, description: "Poll a background search (when present the issue is not read)" },
        ],
        responses: {
          "200": {
            description: "The projected releases, each `guid` an opaque handle",
            content: { "application/json": { schema: { type: "array", items: ARR_RELEASE } } },
          },
          "202": jobAnswer(
            "{ job } — a background search started (`async=1`), or the same search already running was joined; polling `?job=` answers { job, running: true } while it runs",
            SEARCH_JOB,
          ),
          "400": { description: "Invalid instance slug" },
          "403": { description: "Forbidden — ADMIN or ISSUE_ADMIN only" },
          "404": { description: "Issue not found, or (with `?job=`) the job is gone — expired, not the caller's, or a restart; search again" },
          "422": { description: "Instance not configured, TVDB resolution failed, or a TV issue whose scope is FULL, or SEASON/EPISODE without its season/episode number (Sonarr can only search a season or an episode)" },
          "429": { description: "More than 20 searches a minute by this admin (Retry-After set); joining a search already running costs none" },
          "502": { description: "Radarr/Sonarr could not be reached or failed" },
        },
      },
    },

    "/votes": {
      get: {
        tags: ["Votes"],
        summary: "List deletion vote items",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", default: 1, minimum: 1, maximum: 10000 } },
          {
            name: "mine", in: "query", schema: { type: "string", enum: ["1"] },
            description:
              "Set to the literal string 1 to show only items the caller has voted on. Any other value — INCLUDING the OpenAPI-canonical `true` — is ignored and returns the unfiltered list.",
          },
          {
            name: "sort", in: "query", schema: { type: "string", enum: ["votes", "recent"], default: "votes" },
            description: "`votes` orders by vote count desc, `recent` by most-recent vote desc; both tie-break on tmdbId asc. An unrecognized value falls back to `votes`.",
          },
          { name: "q", in: "query", schema: { type: "string" }, description: "Case-insensitive substring match on title" },
        ],
        responses: {
          "200": {
            description: "Paginated vote items — pageSize is fixed at 40 and is not a parameter",
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    { $ref: "#/components/schemas/PaginatedMeta" },
                    {
                      type: "object",
                      properties: {
                        items: {
                          type: "array",
                          items: {
                            type: "object",
                            required: ["tmdbId", "mediaType", "title", "posterPath", "voteCount", "userVoted", "userReason", "reasons", "reasonEntries"],
                            properties: {
                              tmdbId: { type: "integer" },
                              mediaType: { $ref: "#/components/schemas/MediaType" },
                              title: { type: "string" },
                              posterPath: { type: "string", nullable: true },
                              voteCount: { type: "integer", description: "Every voter's vote on the title, whatever the filter" },
                              userVoted: { type: "boolean" },
                              userReason: { type: "string", nullable: true, description: "The caller's own reason" },
                              reasons: { type: "array", maxItems: 3, items: { type: "string" }, description: "Up to 3 recent distinct reasons from OTHER voters (no names)" },
                              reasonEntries: {
                                type: "array",
                                maxItems: 3,
                                description: "The same reasons in the same order, each with the id of the vote it came from — what POST /report `vote_reason` takes",
                                items: { type: "object", required: ["id", "reason"], properties: { id: { type: "string" }, reason: { type: "string" } } },
                              },
                            },
                          },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
          "403": { description: "Deletion voting (feature.page.votes) is disabled" },
          "429": { description: "Rate limited (30 req/min per user)" },
        },
      },
      post: {
        tags: ["Votes"],
        summary: "Submit a deletion vote",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["tmdbId", "mediaType", "_token"],
                properties: {
                  tmdbId: { type: "integer", minimum: 1 },
                  mediaType: { $ref: "#/components/schemas/MediaType" },
                  reason: { type: "string", maxLength: 200 },
                  _token: { type: "string", description: "Request token bound to tmdbId + mediaType + the calling user" },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Vote recorded — the body is the created DeletionVote row, not an empty ack",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["id", "createdAt", "tmdbId", "mediaType", "title", "posterPath", "userId", "reason"],
                  properties: {
                    id: { type: "string", description: "The DeletionVote id — what POST /report `vote_reason` takes" },
                    createdAt: { type: "string", format: "date-time" },
                    tmdbId: { type: "integer" },
                    mediaType: { $ref: "#/components/schemas/MediaType" },
                    title: { type: "string", description: "As TMDB verified it" },
                    posterPath: { type: "string", nullable: true },
                    userId: { type: "string", description: "The caller" },
                    reason: { type: "string", nullable: true },
                  },
                },
              },
            },
          },
          "400": { description: "Malformed JSON, or an invalid tmdbId / mediaType / reason" },
          "403": { description: "Deletion voting disabled, an invalid _token, or the caller has previously requested this title" },
          "409": { description: "Already voted — unique violation on (tmdbId, mediaType, userId)" },
          "413": { description: "Request body over the 16 KB cap" },
          "422": { description: "TMDB could not verify the title, or it is in no library visible to this voter" },
          "429": { description: "Rate limited (rateLimitRequests setting, default 20/min per user)" },
          "503": { description: "Maintenance mode (non-ADMIN callers)" },
        },
      },
    },
    "/votes/{tmdbId}": {
      patch: {
        tags: ["Votes"],
        summary: "Dismiss all deletion votes for a title (ADMIN)",
        description:
          "Deletes every DeletionVote for the title and clears the one-shot deletionVoteNotified setting key in one transaction, so the threshold notification can re-arm. Note the sibling DELETE on this path is withAuth (retract your own vote), not ADMIN.",
        parameters: [
          { name: "tmdbId", in: "path", required: true, schema: { type: "integer" } },
          { name: "mediaType", in: "query", required: true, schema: { $ref: "#/components/schemas/MediaType" } },
        ],
        responses: {
          "200": {
            description: "Votes dismissed",
            content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" }, dismissed: { type: "integer" } } } } },
          },
          "400": { description: "Invalid tmdbId or mediaType" },
          "403": { description: "Forbidden — ADMIN only" },
          "429": { description: "Rate limited (10/min per admin)" },
          "503": { description: "Maintenance mode" },
        },
      },
      delete: {
        tags: ["Votes"],
        summary: "Retract own vote",
        parameters: [
          { name: "tmdbId", in: "path", required: true, schema: { type: "integer" } },
          { name: "mediaType", in: "query", required: true, schema: { $ref: "#/components/schemas/MediaType" } },
        ],
        responses: {
          "200": { description: "Vote retracted", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" } } } } } },
          "400": { description: "Invalid tmdbId or mediaType" },
          "403": { description: "Deletion voting is disabled" },
          "404": { description: "The caller has no vote on this title" },
          "429": { description: "Rate limited (60/min per user)" },
          "503": { description: "Maintenance mode (non-ADMIN callers)" },
        },
      },
    },

    "/ratings": {
      get: {
        tags: ["Ratings"],
        summary: "Get external ratings for a title (MDBList → OMDB fallback)",
        parameters: [
          { name: "id", in: "query", required: true, schema: { type: "integer" }, description: "TMDB ID" },
          { name: "type", in: "query", required: true, schema: { type: "string", enum: ["movie", "tv"] } },
        ],
        responses: {
          "200": {
            description: "Ratings object, or null when no ratings are found for the title",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  nullable: true,
                  description:
                    "String-valued rating fields from MDBList (or OMDB fallback). Any field may be null.",
                  properties: {
                    ...RATING_FIELDS,
                    releasedDigital: { type: "string", nullable: true, description: "MDBList's digital release date (MDBList only)" },
                    trailerUrl: { type: "string", nullable: true, description: "MDBList's trailer link (MDBList only)" },
                  },
                },
              },
            },
          },
          "400": { description: "Missing or invalid id / type, or a non-positive / out-of-range id" },
          "429": { description: "Rate limited (60 req/min)" },
        },
      },
    },
    "/ratings/batch": {
      post: {
        tags: ["Ratings"],
        summary: "Batch fetch ratings for multiple titles",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["items"],
                properties: {
                  items: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "integer" },
                        type: { type: "string", enum: ["movie", "tv"] },
                        releaseDate: { type: "string", nullable: true, description: "Optional; picks the ratings-cache TTL bucket" },
                      },
                    },
                    maxItems: 200,
                    description: "At most 200 items; malformed or out-of-range entries and duplicates are skipped silently",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "{ ratings } — a map keyed \"<type>:<tmdbId>\" (e.g. \"movie:603\") → { imdbId, imdbRating, imdbVotes, rottenTomatoes, rtAudienceScore, metacritic, traktRating, letterboxdRating, mdblistScore, malRating, rogerEbertRating } (strings or null); titles with no ratings are omitted",
            content: { "application/json": { schema: { type: "object", properties: {
              ratings: { type: "object", additionalProperties: { type: "object", properties: RATING_FIELDS } },
            } } } },
          },
          "400": { description: "`items` missing / not an array, or over 200 entries" },
          "429": { description: "Rate limited (10 req/min per user)" },
        },
      },
    },

    "/play-history": {
      get: {
        tags: ["Play History"],
        summary: "List play history across all users (ADMIN)",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20, minimum: 1, maximum: 200 } },
          {
            name: "distinct", in: "query", schema: { type: "string", enum: ["platforms", "users"] },
            description:
              "A MODE SWITCH, not a boolean. `platforms` returns a bare string[] of non-null platforms; `users` returns a bare array of { id, username, source, serverInstance } over every MediaServerUser (departed ones included, per guardrail 28). Both ignore every other parameter. Any other value — including `true` — falls through to the paginated list.",
          },
          { name: "ungrouped", in: "query", schema: { type: "string", enum: ["true"] }, description: "Only the literal `true` lists individual segments; anything else collapses resume chains into one row each" },
          { name: "sortBy", in: "query", schema: { type: "string", enum: ["startedAt", "title", "playDuration", "duration", "source", "platform"], default: "startedAt" }, description: "Unknown values fall back to startedAt" },
          { name: "sortDir", in: "query", schema: { type: "string", enum: ["asc", "desc"], default: "desc" } },
          { name: "source", in: "query", schema: { type: "string", enum: ["plex", "jellyfin"] } },
          { name: "mediaType", in: "query", schema: { $ref: "#/components/schemas/MediaType" } },
          { name: "watched", in: "query", schema: { type: "string", enum: ["true", "false"] }, description: "Any other value is ignored" },
          { name: "playMethod", in: "query", schema: { type: "string" }, description: "A known play method; unknown values are ignored" },
          { name: "platform", in: "query", schema: { type: "string" } },
          { name: "startDate", in: "query", schema: { type: "string", format: "date" } },
          { name: "endDate", in: "query", schema: { type: "string", format: "date" } },
          { name: "fromDay", in: "query", schema: { type: "string", format: "date" }, description: "First day (YYYY-MM-DD) in the statistics time zone: plays from that day's midnight there" },
          { name: "toDay", in: "query", schema: { type: "string", format: "date" }, description: "Last day (YYYY-MM-DD) in the statistics time zone, inclusive: plays before the next day's midnight there" },
          { name: "search", in: "query", schema: { type: "string" } },
          { name: "userId", in: "query", schema: { type: "string" } },
          { name: "tmdbId", in: "query", schema: { type: "integer" } },
        ],
        responses: {
          "200": {
            description: "{ items, total, page, limit, totalPages, grouped } — grouped is false only on the `ungrouped=true` path. Rows carry posterPath/poster URLs resolved from the poster cache.",
            content: {
              "application/json": {
                schema: {
                  anyOf: [
                    {
                      type: "object",
                      required: ["items", "total", "page", "limit", "totalPages", "grouped"],
                      properties: {
                        items: {
                          type: "array",
                          items: {
                            type: "object",
                            description: "Grouped: the chain's latest segment with the chain's totals; ungrouped: one segment (a chain of one)",
                            properties: {
                              ...PLAY_HISTORY_ROW_FIELDS,
                              watched: { type: "boolean", description: "Grouped: any segment of the chain counted as watched" },
                              completed: { type: "boolean", description: "Grouped: any segment of the chain completed" },
                              mediaServerUser: {
                                type: "object",
                                nullable: true,
                                required: ["username", "source", "thumbUrl"],
                                properties: {
                                  username: { type: "string" },
                                  source: { type: "string" },
                                  thumbUrl: { type: "string", nullable: true },
                                  user: {
                                    type: "object",
                                    nullable: true,
                                    description: "Ungrouped only: the linked Summonarr account, null when unlinked",
                                    properties: { name: { type: "string", nullable: true } },
                                  },
                                },
                              },
                              posterUrl: { type: "string", nullable: true, description: "Live poster URL (w342), null when uncached" },
                              segmentCount: { type: "integer", description: "1 when ungrouped" },
                              chainId: { type: "string" },
                              totalPlayDuration: { type: "integer" },
                              totalPausedDuration: { type: "integer" },
                              firstStartedAt: { type: "string", format: "date-time" },
                              lastStoppedAt: { type: "string", format: "date-time" },
                            },
                          },
                        },
                        total: { type: "integer" },
                        page: { type: "integer" },
                        limit: { type: "integer" },
                        totalPages: { type: "integer" },
                        grouped: { type: "boolean" },
                      },
                    },
                    { type: "array", description: "distinct=platforms: every non-null platform", items: { type: "string" } },
                    {
                      type: "array",
                      description: "distinct=users: every MediaServerUser, departed ones included",
                      items: {
                        type: "object",
                        required: ["id", "username", "source", "serverInstance"],
                        properties: { id: { type: "string" }, username: { type: "string" }, source: { type: "string" }, serverInstance: { type: "string" } },
                      },
                    },
                  ],
                },
              },
            },
          },
          "400": { description: "Unparseable startDate / endDate" },
          "403": { description: "Forbidden" },
          "429": { description: "Rate limited (120/min per admin)" },
        },
      },
    },
    "/play-history/mine": {
      get: {
        tags: ["Play History"],
        summary:
          "The caller's OWN watch history. Scoped server-side to the media-server users linked to the session account — no parameter can select another user.",
        parameters: [
          { name: "cursor", in: "query", schema: { type: "string" }, description: "Keyset cursor from the previous response's nextCursor" },
          { name: "mediaType", in: "query", schema: { $ref: "#/components/schemas/MediaType" } },
          { name: "search", in: "query", schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description:
              "History page ({ linked, items, total, nextCursor, pageSize, stats }). Entries are consolidated — repeat plays of the same movie/episode collapse into one item (latest play + playCount/totalPlaySeconds aggregates); linked=false when the account has no linked media-server user yet",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["linked", "items", "total", "nextCursor", "pageSize", "stats"],
                  properties: {
                    linked: { type: "boolean" },
                    items: { type: "array", items: MY_HISTORY_ITEM },
                    total: { type: "integer", description: "Consolidated entries matching the filters" },
                    nextCursor: { type: "string", nullable: true, description: "Send back as `cursor`; null when exhausted" },
                    pageSize: { type: "integer" },
                    stats: {
                      type: "object",
                      required: ["plays", "playSeconds"],
                      description: "All-time raw totals, unaffected by filters and consolidation",
                      properties: { plays: { type: "integer" }, playSeconds: { type: "integer" } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/play-history/mine/{id}": {
      get: {
        tags: ["Play History"],
        summary:
          "Play-by-play breakdown of ONE consolidated entry from the caller's own history. `id` is any play id in the entry; a row outside the caller's scope 404s like a missing one.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "{ item, plays (capped at 100, newest first), firstStartedAt, lastStartedAt }",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["item", "plays", "firstStartedAt", "lastStartedAt"],
                  properties: {
                    item: MY_HISTORY_ITEM,
                    plays: {
                      type: "array",
                      maxItems: 100,
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          source: { type: "string" },
                          startedAt: { type: "string", format: "date-time" },
                          stoppedAt: { type: "string", format: "date-time" },
                          duration: { type: "integer" },
                          playDuration: { type: "integer" },
                          watched: { type: "boolean" },
                          completed: { type: "boolean" },
                          platform: { type: "string", nullable: true },
                          player: { type: "string", nullable: true },
                          device: { type: "string", nullable: true },
                          playMethod: { type: "string", nullable: true },
                        },
                      },
                    },
                    firstStartedAt: { type: "string", format: "date-time" },
                    lastStartedAt: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          },
          "400": { description: "Invalid id" },
          "404": { description: "Unknown id, or a play outside the caller's linked media-server users" },
        },
      },
    },
    "/play-history/mine/stats": {
      get: {
        tags: ["Play History"],
        summary:
          "The caller's OWN aggregate play stats — a lean projection for native clients (the same fields the /my-stats dashboard renders). Scoped server-side to the media-server users linked to the session account; no parameter can select another user.",
        responses: {
          "200": {
            description:
              "{ linked, stats }. stats carries totals (plays, watch hours, avg session), lastActiveIso, the 365-day activityCalendar, playsByDay, the day×hour userHeatmap, platform/device breakdowns, and topMedia. linked=false when the account has no linked media-server user yet",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["linked", "stats"],
                  properties: {
                    linked: { type: "boolean" },
                    stats: {
                      type: "object",
                      nullable: true,
                      description: "null when linked is false",
                      properties: {
                        timeZone: { type: "string", description: "The IANA zone the day and hour buckets are in (the statsTimeZone setting, else the server's own zone)" },
                        totalPlays: { type: "integer" },
                        totalWatchTimeHours: { type: "number" },
                        avgSessionDuration: { type: "integer", description: "Seconds" },
                        lastActiveIso: { type: "string", format: "date-time", nullable: true },
                        activityCalendar: playCountRows("day", { type: "string", format: "date" }),
                        playsByDay: {
                          type: "array",
                          description: "The last 91 days, zero-filled",
                          items: {
                            type: "object",
                            required: ["day", "count", "hours"],
                            properties: { day: { type: "string", format: "date" }, count: { type: "integer" }, hours: { type: "number" } },
                          },
                        },
                        userHeatmap: {
                          type: "array",
                          items: {
                            type: "object",
                            required: ["dow", "hour", "count"],
                            properties: { dow: { type: "integer", minimum: 0, maximum: 6 }, hour: { type: "integer", minimum: 0, maximum: 23 }, count: { type: "integer" } },
                          },
                        },
                        platformBreakdown: playCountRows("platform"),
                        deviceList: playCountRows("device"),
                        topMedia: {
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              title: { type: "string" },
                              tmdbId: { type: "integer", nullable: true },
                              mediaType: { type: "string", nullable: true },
                              count: { type: "integer" },
                              posterPath: { type: "string", nullable: true, description: "A raw TMDB path, not a URL" },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/play-history/mine/wrapped": {
      get: {
        tags: ["Play History"],
        summary:
          "The caller's OWN \"Wrapped\" year-in-review — the REST mirror of the /my-stats/wrapped page, projected for native clients. Scoped server-side to the media-server users linked to the session account; no parameter can select another user.",
        parameters: [
          {
            name: "year",
            in: "query",
            schema: { type: "integer" },
            description:
              "Calendar year (UTC). Honored only if it appears in the returned years list; anything else falls back to the most recent year on record",
          },
        ],
        responses: {
          "200": {
            description:
              "{ linked, years, year, data }. data carries totals, movie/TV splits, topTitles, biggestDay, busiestMonth, primeDow/primeHour, longestSitting, completion and top platform/device; posters ship as raw TMDB posterPath. linked=false when the account has no linked media-server user yet; year/data are null when it has no watched plays in any year",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["linked", "years", "year", "data"],
                  properties: {
                    linked: { type: "boolean" },
                    years: { type: "array", items: { type: "integer" }, description: "Years with a watched play, newest first" },
                    year: { type: "integer", nullable: true },
                    data: {
                      type: "object",
                      nullable: true,
                      properties: {
                        timeZone: { type: "string", description: "The IANA zone the day and hour buckets are in (the statsTimeZone setting, else the server's own zone)" },
                        year: { type: "integer" },
                        isCurrentYear: { type: "boolean", description: "Decided by the server's clock" },
                        totals: {
                          type: "object",
                          properties: { plays: { type: "integer" }, hours: { type: "number" }, titles: { type: "integer" } },
                        },
                        movies: { type: "object", properties: { titles: { type: "integer" }, hours: { type: "number" } } },
                        tv: { type: "object", properties: { shows: { type: "integer" }, episodes: { type: "integer" }, hours: { type: "number" } } },
                        topTitles: {
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              title: { type: "string" },
                              tmdbId: { type: "integer", nullable: true },
                              mediaType: { type: "string", nullable: true },
                              count: { type: "integer" },
                              hours: { type: "number" },
                              posterPath: { type: "string", nullable: true },
                            },
                          },
                        },
                        biggestDay: {
                          type: "object",
                          nullable: true,
                          properties: { day: { type: "string", format: "date" }, plays: { type: "integer" }, hours: { type: "number" } },
                        },
                        busiestMonth: { type: "object", nullable: true, properties: { month: { type: "string" }, plays: { type: "integer" } } },
                        primeDow: { type: "integer", nullable: true, minimum: 0, maximum: 6, description: "Day of week, 0 = Sunday" },
                        primeHour: { type: "integer", nullable: true, minimum: 0, maximum: 23 },
                        longestSitting: {
                          type: "object",
                          nullable: true,
                          properties: {
                            title: { type: "string" },
                            tmdbId: { type: "integer", nullable: true },
                            mediaType: { type: "string", nullable: true },
                            seconds: { type: "integer" },
                            startedAt: { type: "string", format: "date-time" },
                            posterPath: { type: "string", nullable: true },
                          },
                        },
                        completion: { type: "object", properties: { watched: { type: "integer" }, total: { type: "integer" } } },
                        topPlatform: { type: "string", nullable: true },
                        topDevice: { type: "string", nullable: true },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/play-history/sessions": {
      get: {
        tags: ["Sessions"],
        summary: "List active playback sessions (ADMIN)",
        responses: {
          "200": {
            description: "Active ActiveSession rows ordered by start time",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  description: "Newest first. Every ActiveSession column; the BigInt ones (progressMs, startProgressMs, playtimeMs, durationMs) as numbers",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      source: { type: "string", description: "plex | jellyfin" },
                      serverInstance: { type: "string" },
                      sessionKey: { type: "string" },
                      startedAt: { type: "string", format: "date-time" },
                      lastSeenAt: { type: "string", format: "date-time" },
                      state: { type: "string", description: "playing | paused | buffering" },
                      mediaServerUserId: { type: "string" },
                      serverUsername: { type: "string" },
                      tmdbId: { type: "integer", nullable: true },
                      mediaType: { type: "string", nullable: true },
                      title: { type: "string" },
                      year: { type: "string", nullable: true },
                      seasonNumber: { type: "integer", nullable: true },
                      episodeNumber: { type: "integer", nullable: true },
                      episodeTitle: { type: "string", nullable: true },
                      sourceItemId: { type: "string", nullable: true },
                      sourceShowId: { type: "string", nullable: true },
                      posterPath: { type: "string", nullable: true },
                      progressPercent: { type: "number" },
                      progressMs: { type: "integer" },
                      startProgressMs: { type: "integer" },
                      progressUpdatedAt: { type: "string", format: "date-time" },
                      playtimeMs: { type: "integer" },
                      durationMs: { type: "integer" },
                      platform: { type: "string", nullable: true },
                      player: { type: "string", nullable: true },
                      device: { type: "string", nullable: true },
                      ipAddress: { type: "string", nullable: true },
                      playMethod: { type: "string", nullable: true },
                      videoCodec: { type: "string", nullable: true },
                      audioCodec: { type: "string", nullable: true },
                      resolution: { type: "string", nullable: true },
                      bitrate: { type: "integer", nullable: true },
                      videoDecision: { type: "string", nullable: true },
                      audioDecision: { type: "string", nullable: true },
                      container: { type: "string", nullable: true },
                      transcodeReason: { type: "string", nullable: true },
                      location: { type: "string", nullable: true },
                      bandwidth: { type: "integer", nullable: true },
                      secure: { type: "boolean", nullable: true },
                      relayed: { type: "boolean", nullable: true },
                      introStartMs: { type: "integer", nullable: true },
                      introEndMs: { type: "integer", nullable: true },
                      creditsStartMs: { type: "integer", nullable: true },
                      creditsEndMs: { type: "integer", nullable: true },
                    },
                  },
                },
              },
            },
          },
          "403": { description: "Forbidden" },
        },
      },
    },
    "/play-history/stats": {
      get: {
        tags: ["Play History"],
        summary: "Play history statistics (ADMIN)",
        parameters: [
          { name: "days", in: "query", schema: { type: "integer" }, description: "Window in days; clamped server-side (parseActivityDays)" },
          { name: "source", in: "query", schema: { type: "string", enum: ["plex", "jellyfin"] }, description: "Other values are ignored" },
          { name: "mediaType", in: "query", schema: { $ref: "#/components/schemas/MediaType" }, description: "Other values are ignored" },
        ],
        responses: {
          "200": {
            description: "Aggregate stats (total runtime, titles, etc.)",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  description: "PlayHistoryStatsResult (src/lib/play-history.ts) for the window",
                  properties: {
                    timeZone: { type: "string", description: "The IANA zone the day and hour buckets are in (the statsTimeZone setting, else the server's own zone)" },
                    totalPlays: { type: "integer" },
                    totalWatchTimeHours: { type: "number" },
                    playsByDay: playCountRows("day", { type: "string", format: "date" }),
                    topUsers: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: { id: { type: "string", description: "MediaServerUser id" }, username: { type: "string" }, source: { type: "string" }, count: { type: "integer" } },
                      },
                    },
                    topMedia: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: { title: { type: "string" }, tmdbId: { type: "integer", nullable: true }, mediaType: { type: "string", nullable: true }, count: { type: "integer" } },
                      },
                    },
                    transcodeRatio: playCountRows("method"),
                    playsByPlatform: playCountRows("platform"),
                    playsByHour: playCountRows("hour", { type: "integer" }),
                    mediaTypeBreakdown: playCountRows("type"),
                    watchTimeByDay: {
                      type: "array",
                      items: { type: "object", properties: { day: { type: "string", format: "date" }, hours: { type: "number" } } },
                    },
                    heatmap: {
                      type: "array",
                      items: { type: "object", properties: { dow: { type: "integer" }, hour: { type: "integer" }, count: { type: "integer" } } },
                    },
                    completionRate: { type: "number" },
                    completionBuckets: playCountRows("bucket"),
                    avgBitrateMbps: { type: "number" },
                    totalBandwidthGB: { type: "number" },
                    bandwidthByDay: {
                      type: "array",
                      items: { type: "object", properties: { day: { type: "string", format: "date" }, gb: { type: "number" } } },
                    },
                    uniqueViewers: { type: "integer" },
                    uniqueTitles: { type: "integer", description: "Distinct (tmdbId, mediaType) pairs" },
                    rewatchPlays: { type: "integer" },
                    rewatchRate: { type: "number", description: "Share of the window's watched plays that were rewatches, 0–100" },
                    avgSessionMinutes: { type: "number" },
                    longestSessionMinutes: { type: "number" },
                    pauseRatio: { type: "number" },
                    peakConcurrent: { type: "integer" },
                    uniqueViewersByDay: playCountRows("day", { type: "string", format: "date" }),
                    playsByDow: playCountRows("dow", { type: "integer" }),
                    resolutionBreakdown: playCountRows("bucket"),
                    videoCodecBreakdown: playCountRows("codec"),
                    audioCodecBreakdown: playCountRows("codec"),
                    containerBreakdown: playCountRows("container"),
                    bitrateBuckets: playCountRows("bucket"),
                    transcodeReasons: playCountRows("reason"),
                    topDevices: playCountRows("device"),
                    topPlayers: playCountRows("player"),
                    sourceSplit: playCountRows("source"),
                    decadeBreakdown: playCountRows("decade"),
                    topRewatched: PLAY_TOP_TITLE_ROWS,
                    topWatched: PLAY_TOP_TITLE_ROWS,
                    topEpisodes: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          tmdbId: { type: "integer", nullable: true },
                          title: { type: "string" },
                          season: { type: "integer", nullable: true },
                          episode: { type: "integer", nullable: true },
                          episodeTitle: { type: "string", nullable: true },
                          count: { type: "integer" },
                        },
                      },
                    },
                    prevPeriod: {
                      type: "object",
                      properties: {
                        totalPlays: { type: "integer" },
                        totalWatchTimeHours: { type: "number" },
                        uniqueViewers: { type: "integer" },
                        complete: { type: "boolean", description: "False when history doesn't reach back across the whole previous window — show no period-over-period delta then (guardrail 19d)" },
                      },
                    },
                  },
                },
              },
            },
          },
          "403": { description: "Forbidden — ADMIN only" },
        },
      },
    },
    "/play-history/export": {
      get: {
        tags: ["Play History"],
        summary: "Export play history as CSV or JSON (ADMIN)",
        description: "Takes the same filter parameters as GET /play-history (source, mediaType, watched, userId, tmdbId, playMethod, platform, startDate, endDate, fromDay, toDay, search). Audited.",
        parameters: [
          { name: "format", in: "query", schema: { type: "string", enum: ["csv", "json"], default: "csv" } },
          { name: "source", in: "query", schema: { type: "string", enum: ["plex", "jellyfin"] } },
          { name: "mediaType", in: "query", schema: { $ref: "#/components/schemas/MediaType" } },
          { name: "watched", in: "query", schema: { type: "string", enum: ["true", "false"] } },
          { name: "userId", in: "query", schema: { type: "string" } },
          { name: "tmdbId", in: "query", schema: { type: "integer" } },
          { name: "playMethod", in: "query", schema: { type: "string" } },
          { name: "platform", in: "query", schema: { type: "string" } },
          { name: "startDate", in: "query", schema: { type: "string", format: "date" } },
          { name: "endDate", in: "query", schema: { type: "string", format: "date" } },
          { name: "fromDay", in: "query", schema: { type: "string", format: "date" }, description: "First day (YYYY-MM-DD) in the statistics time zone: plays from that day's midnight there" },
          { name: "toDay", in: "query", schema: { type: "string", format: "date" }, description: "Last day (YYYY-MM-DD) in the statistics time zone, inclusive: plays before the next day's midnight there" },
          { name: "search", in: "query", schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "CSV (default) or JSON file download",
            content: {
              "text/csv": {
                schema: {
                  type: "string",
                  description: "A header row, then one row per play, newest first, at most 10,000; past that a last one-field row says the export was cut and to narrow the dates",
                },
              },
              "application/json": {
                schema: {
                  type: "array",
                  maxItems: 10000,
                  description: "format=json: one object per play, newest first",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      title: { type: "string" },
                      mediaType: { type: "string", enum: ["MOVIE", "TV"], nullable: true },
                      year: { type: "string", nullable: true },
                      seasonNumber: { type: "integer", nullable: true },
                      episodeNumber: { type: "integer", nullable: true },
                      episodeTitle: { type: "string", nullable: true },
                      username: { type: "string", nullable: true },
                      source: { type: "string" },
                      startedAt: { type: "string", format: "date-time" },
                      stoppedAt: { type: "string", format: "date-time" },
                      duration: { type: "integer" },
                      playDuration: { type: "integer" },
                      pausedDuration: { type: "integer" },
                      watched: { type: "boolean" },
                      platform: { type: "string", nullable: true },
                      player: { type: "string", nullable: true },
                      device: { type: "string", nullable: true },
                      playMethod: { type: "string", nullable: true },
                      videoCodec: { type: "string", nullable: true },
                      audioCodec: { type: "string", nullable: true },
                      resolution: { type: "string", nullable: true },
                      bitrateKbps: { type: "number", nullable: true, description: "Normalized to kbps by source (guardrail 19a); null when unknown" },
                      videoDecision: { type: "string", nullable: true },
                      audioDecision: { type: "string", nullable: true },
                      container: { type: "string", nullable: true },
                    },
                  },
                },
              },
            },
          },
          "400": { description: "Unparseable startDate / endDate" },
          "403": { description: "Forbidden — ADMIN only" },
          "429": { description: "Rate limited (5 exports per hour per admin)" },
        },
      },
    },
    "/play-history/{id}": {
      get: {
        tags: ["Play History"],
        summary: "Fetch one play-history record (ADMIN)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "The PlayHistory row, with its media-server user embedded",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  description: "Full PlayHistory row plus mediaServerUser { id, username, source, thumbUrl }",
                  properties: {
                    ...PLAY_HISTORY_ROW_FIELDS,
                    mediaServerUser: {
                      type: "object",
                      required: ["id", "username", "source", "thumbUrl"],
                      properties: { id: { type: "string" }, username: { type: "string" }, source: { type: "string" }, thumbUrl: { type: "string", nullable: true } },
                    },
                  },
                },
              },
            },
          },
          "400": { description: "Invalid id" },
          "403": { description: "Forbidden — ADMIN only" },
          "404": { description: "Not found" },
        },
      },
      delete: {
        tags: ["Play History"],
        summary: "Delete a play history record, or its whole resume chain (ADMIN)",
        description:
          "Play history is unrecoverable — the live poller is its only writer, so a deleted watch cannot be rebuilt. `chain=true` deletes every segment of the resume chain the record belongs to, which is what the grouped admin table shows as one play.",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "chain", in: "query", schema: { type: "string", enum: ["true"] }, description: "Delete every segment of this record's resume chain, not just the one segment" },
        ],
        responses: {
          "204": { description: "Deleted — no content" },
          "400": { description: "Invalid id" },
          "403": { description: "Forbidden — ADMIN only" },
          "404": { description: "Not found" },
          "429": { description: "Rate limited" },
        },
      },
    },

    "/sessions": {
      get: {
        tags: ["Sessions"],
        summary: "List the current user's authenticated device sessions",
        responses: {
          "200": {
            description: "The caller's AuthSession (login/device) rows",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      sessionId: { type: "string" },
                      deviceType: { type: "string", nullable: true },
                      deviceLabel: { type: "string", nullable: true },
                      ipAddress: { type: "string", nullable: true },
                      createdAt: { type: "string", format: "date-time" },
                      lastSeenAt: { type: "string", format: "date-time" },
                      expiresAt: { type: "string", format: "date-time" },
                      isCurrent: { type: "boolean" },
                      indefinite: { type: "boolean", description: "Additive: a never-expiring (native) session — `expiresAt` is then the sentinel date" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      delete: {
        tags: ["Sessions"],
        summary: "Revoke one of the caller's own device sessions (step-up auth required)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["sessionId"],
                properties: {
                  sessionId: { type: "string" },
                  confirmPassword: { type: "string", description: "Step-up re-authentication, required to revoke a session other than the caller's own, for accounts with a local password. SSO accounts (no password) instead need the caller's own session to have been created within the last 5 minutes." },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Session revoked — { ok: true }", content: { "application/json": { schema: OK_TRUE } } },
          "400": { description: "sessionId missing or not a string" },
          "401": { description: "Step-up required or failed: { error: \"password-required\" | \"invalid-password\" | \"session-too-old\" }" },
          "404": { description: "No such session for this user" },
          "429": { description: "Rate limited (10 revokes/min per user): { error: \"rate_limit\", message }" },
          "500": { description: "The revocation did not commit" },
        },
      },
    },

    "/tv/{id}/season/{n}": {
      get: {
        tags: ["TV"],
        summary: "Get episode data for a season",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "integer" }, description: "TMDB TV ID" },
          { name: "n", in: "path", required: true, schema: { type: "integer" }, description: "Season number" },
        ],
        responses: {
          "200": {
            description: "Season episodes with availability",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["episodes", "owned", "source"],
                  properties: {
                    episodes: {
                      type: "array",
                      description: "TMDB's episodes, in the viewer's language",
                      items: {
                        type: "object",
                        properties: {
                          episodeNumber: { type: "integer" },
                          seasonNumber: { type: "integer" },
                          name: { type: "string" },
                          overview: { type: "string" },
                          airDate: { type: "string", nullable: true },
                          stillPath: { type: "string", nullable: true },
                          runtime: { type: "integer", nullable: true, description: "Minutes" },
                          voteAverage: { type: "number" },
                        },
                      },
                    },
                    owned: { type: "array", items: { type: "integer" }, description: "Episode numbers on a server this viewer may see, ascending" },
                    source: { type: "string", nullable: true, enum: ["plex", "jellyfin", "both", null], description: "Which server type holds the owned episodes; null when none" },
                  },
                },
              },
            },
          },
          "400": { description: "Invalid TV id or season number" },
          "429": { description: "Rate limited" },
          "502": { description: "TMDB season fetch failed" },
        },
      },
    },

    "/tv-availability": {
      get: {
        tags: ["TV Availability"],
        summary: "Episode-level availability for a TV show",
        parameters: [
          { name: "tmdbId", in: "query", required: true, schema: { type: "integer", minimum: 1 } },
        ],
        description: "Scoped by the caller's sign-in provider (a Plex user sees Plex episodes, a Jellyfin user Jellyfin, others both) and by the servers they may see. There is no `source` parameter.",
        responses: {
          "200": {
            description: "{ source: \"plex\" | \"jellyfin\" | \"both\" | null, seasons: [{ seasonNumber, episodes: number[] }] }",
            content: { "application/json": { schema: { type: "object", properties: {
              source: { type: "string", nullable: true, enum: ["plex", "jellyfin", "both"] },
              seasons: { type: "array", items: { type: "object", properties: { seasonNumber: { type: "integer" }, episodes: { type: "array", items: { type: "integer" } } } } },
            } } } },
          },
          "400": { description: "Missing, non-positive or out-of-range tmdbId" },
          "429": { description: "Rate limited (30 req/min per user)" },
        },
      },
    },

    "/person/{id}": {
      get: {
        tags: ["Person"],
        summary: "Get TMDB person details and credits",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        responses: {
          "200": {
            description: "Person details with cast/crew credits",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["id", "name", "profilePath", "knownForDepartment", "biography", "birthday", "deathday", "placeOfBirth", "credits"],
                  properties: {
                    id: { type: "integer" },
                    name: { type: "string" },
                    profilePath: { type: "string", nullable: true },
                    knownForDepartment: { type: "string" },
                    biography: { type: "string", description: "In the viewer's language when TMDB has one" },
                    birthday: { type: "string", nullable: true },
                    deathday: { type: "string", nullable: true },
                    placeOfBirth: { type: "string", nullable: true },
                    credits: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "integer" },
                          mediaType: TMDB_MEDIA_TYPE,
                          title: { type: "string" },
                          posterPath: { type: "string", nullable: true },
                          releaseYear: { type: "string" },
                          character: { type: "string" },
                          voteAverage: { type: "number" },
                          plexAvailable: { type: "boolean" },
                          jellyfinAvailable: { type: "boolean" },
                          arrPending: { type: "boolean" },
                          requested: { type: "boolean" },
                          requestedByMe: { type: "boolean" },
                          blacklisted: { type: "boolean" },
                          ...RATING_FIELDS,
                          requestToken: {
                            type: "string",
                            description: "This caller's `_token` for POST /requests on this title — the HMAC GET /requests/token answers, bound to the title and the caller",
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          "400": { description: "Invalid person id" },
          "404": { description: "Unknown person" },
          "429": { description: "Rate limited" },
          "502": { description: "TMDB upstream error" },
        },
      },
    },

    "/profile/password": {
      patch: {
        tags: ["Profile"],
        summary: "Change password (credentials accounts only)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["currentPassword", "newPassword"],
                properties: {
                  currentPassword: { type: "string" },
                  newPassword: { type: "string", minLength: 12, maxLength: 1024 },
                  // Guardrail 6i: an account with two-factor also proves a fresh
                  // second factor; checked only after the password verified.
                  secondFactor: MFA_SECOND_FACTOR_SCHEMA,
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Password updated ({ ok, requiresRelogin }) — every session is revoked",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["ok", "requiresRelogin"],
                  properties: {
                    ok: { type: "boolean", enum: [true] },
                    requiresRelogin: { type: "boolean", enum: [true], description: "Every session, this one included, was revoked — sign in again with the new password" },
                  },
                },
              },
            },
          },
          "400": { description: `${MFA_STEP_UP_400}, or a validation error (newPassword missing, under 12 or over 1024 characters). An account with two-factor gets secondFactorRequired until it sends secondFactor` },
          "401": { description: "User row not found" },
          "403": { description: "SSO account — local passwords are not available" },
          "429": { description: "Too many attempts (5 per 15 minutes per user), or code entry is locked" },
          "503": { description: "Maintenance mode (non-ADMIN callers)" },
        },
      },
    },
    // ── Two-factor authentication (local-credentials accounts only) ──────────
    // Every enrollment CHANGE takes the current password in the body (step-up);
    // once the account has an active factor it ALSO takes `secondFactor` (a
    // current TOTP code, an unused recovery code — spent — or a passkey assertion
    // over a /profile/mfa/challenge challenge). The first factor is
    // password-only. 403 = not a local-credentials account; 429 = too many
    // step-up attempts or the persistent code lockout. The sign-in half
    // (POST /auth/sign-in/mfa) is a handshake documented in SECURITY.md.
    "/profile/mfa": {
      get: {
        tags: ["Profile"],
        summary: "Read the caller's two-factor status",
        responses: {
          "200": {
            description:
              "{ available, enabled, totpEnabled, passkeys: [{ id, name, transports, backedUp, createdAt, lastUsedAt }], recoveryCodesRemaining, webauthnAvailable } — never a secret",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["available", "enabled", "totpEnabled", "passkeys", "recoveryCodesRemaining", "webauthnAvailable"],
                  properties: {
                    available: { type: "boolean", description: "Two-factor applies: a local-credentials account with a password" },
                    enabled: { type: "boolean", description: "At least one second factor is active" },
                    totpEnabled: { type: "boolean" },
                    passkeys: {
                      type: "array",
                      description: "The caller's passkeys, oldest first — names and dates only, never the credential or its key",
                      items: {
                        type: "object",
                        required: ["id", "name", "transports", "backedUp", "createdAt", "lastUsedAt"],
                        properties: {
                          id: { type: "string", description: "Summonarr's id for the passkey (PATCH/DELETE /profile/mfa/passkeys/{id})" },
                          name: { type: "string" },
                          transports: { type: "array", items: { type: "string" } },
                          backedUp: { type: "boolean" },
                          createdAt: { type: "string", format: "date-time" },
                          lastUsedAt: { type: "string", format: "date-time", nullable: true },
                        },
                      },
                    },
                    recoveryCodesRemaining: { type: "integer", minimum: 0 },
                    webauthnAvailable: { type: "boolean", description: "AUTH_URL names a relying party, so passkeys can be used" },
                  },
                },
              },
            },
          },
        },
      },
      delete: {
        tags: ["Profile"],
        summary: "Turn two-factor off (removes every factor and recovery code)",
        requestBody: { required: true, content: { "application/json": { schema: mfaStepUpBody() } } },
        responses: {
          "200": { description: "Turned off; every OTHER session is signed out", content: { "application/json": { schema: OK_TRUE } } },
          "400": { description: MFA_STEP_UP_400 },
          "403": { description: "Not a local-credentials account" },
          "429": { description: "Too many step-up attempts, or code entry is locked" },
        },
      },
    },
    "/profile/mfa/challenge": {
      post: {
        tags: ["Profile"],
        summary: "A fresh WebAuthn challenge for confirming an enrollment change with a passkey",
        responses: {
          "200": {
            description: "{ challengeToken, publicKey } — publicKey is PublicKeyCredentialRequestOptions (base64url); send the assertion back as secondFactor { method: \"webauthn\", credential, challengeToken }. Single-use, 5-minute, bound to this user and session",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["challengeToken", "publicKey"],
                  properties: {
                    challengeToken: { type: "string", description: "Signed, single-use, 5-minute token bound to this user and session — send it back with the assertion" },
                    publicKey: {
                      type: "object",
                      description: "PublicKeyCredentialRequestOptions, binary fields base64url",
                      required: ["challenge", "rpId", "allowCredentials", "userVerification", "timeout"],
                      properties: {
                        challenge: { type: "string", description: "32 random bytes, base64url" },
                        rpId: { type: "string" },
                        allowCredentials: { type: "array", items: WEBAUTHN_CREDENTIAL_DESCRIPTOR },
                        userVerification: { type: "string", enum: ["preferred"] },
                        timeout: { type: "integer", description: "Milliseconds — the token's lifetime" },
                      },
                    },
                  },
                },
              },
            },
          },
          "400": { description: "The account has no passkeys" },
          "401": { description: "The session carries no session id" },
          "403": { description: "Not a local-credentials account" },
          "429": { description: "Too many challenges" },
          "503": { description: "AUTH_URL is not configured, so no WebAuthn RP ID exists" },
        },
      },
    },
    "/profile/mfa/totp/setup": {
      post: {
        tags: ["Profile"],
        summary: "Issue a pending authenticator-app (TOTP) secret",
        requestBody: { required: true, content: { "application/json": { schema: mfaStepUpBody() } } },
        responses: {
          "200": {
            description: "{ secret, otpauthUri } — shown once; nothing changes until /totp/enable confirms a code",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["secret", "otpauthUri"],
                  properties: {
                    secret: { type: "string", pattern: "^[A-Z2-7]+$", description: "The new authenticator secret (RFC 4648 base32, unpadded), shown once — nothing is enabled until /totp/enable confirms a code" },
                    otpauthUri: { type: "string", pattern: "^otpauth://totp/", description: "The same secret as an otpauth:// URI, for a QR code" },
                  },
                },
              },
            },
          },
          "400": { description: MFA_STEP_UP_400 },
          "409": { description: "An authenticator app is already enabled" },
          "429": { description: "Too many step-up attempts, or code entry is locked" },
        },
      },
    },
    "/profile/mfa/totp/enable": {
      post: {
        tags: ["Profile"],
        summary: "Confirm the pending TOTP secret with a current code",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["code"], properties: { code: { type: "string", example: "123456" } } } } },
        },
        responses: {
          "200": {
            description: "{ ok, recoveryCodes? } — recoveryCodes (shown once) when this is the first factor, which also signs out every other session",
            content: { "application/json": { schema: MFA_FACTOR_ADDED } },
          },
          "400": { description: "No pending setup, or the code didn't match" },
          "409": { description: "Already enabled" },
        },
      },
    },
    "/profile/mfa/totp": {
      delete: {
        tags: ["Profile"],
        summary: "Remove the authenticator app",
        requestBody: { required: true, content: { "application/json": { schema: mfaStepUpBody() } } },
        responses: {
          "200": {
            description: "Removed (recovery codes too, and every OTHER session signed out, when no passkey remains)",
            content: { "application/json": { schema: OK_TRUE } },
          },
          "400": { description: MFA_STEP_UP_400 },
          "404": { description: "No authenticator app set up" },
          "429": { description: "Too many step-up attempts, or code entry is locked" },
        },
      },
    },
    "/profile/mfa/recovery-codes": {
      post: {
        tags: ["Profile"],
        summary: "Replace every recovery code with ten new ones",
        requestBody: { required: true, content: { "application/json": { schema: mfaStepUpBody() } } },
        responses: {
          "200": {
            description: "{ recoveryCodes } — shown once; only hashes are stored",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["recoveryCodes"],
                  properties: { recoveryCodes: MFA_RECOVERY_CODES },
                },
              },
            },
          },
          "400": { description: `${MFA_STEP_UP_400}, or two-factor is off` },
          "429": { description: "Too many step-up attempts, or code entry is locked" },
        },
      },
    },
    "/profile/mfa/passkeys/options": {
      post: {
        tags: ["Profile"],
        summary: "Begin adding a passkey — WebAuthn creation options",
        requestBody: { required: true, content: { "application/json": { schema: mfaStepUpBody() } } },
        responses: {
          "200": {
            description: "{ registrationToken, publicKey } — publicKey is PublicKeyCredentialCreationOptions with base64url binary fields; the token is single-use, 5-minute, bound to this user and session",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["registrationToken", "publicKey"],
                  properties: {
                    registrationToken: { type: "string", description: "Signed, single-use, 5-minute token bound to this user and session — send it back with the attestation (POST /profile/mfa/passkeys)" },
                    publicKey: {
                      type: "object",
                      description: "PublicKeyCredentialCreationOptions, binary fields base64url",
                      required: ["rp", "user", "challenge", "pubKeyCredParams", "timeout", "attestation", "authenticatorSelection", "excludeCredentials"],
                      properties: {
                        rp: { type: "object", required: ["id", "name"], properties: { id: { type: "string" }, name: { type: "string" } } },
                        user: {
                          type: "object",
                          required: ["id", "name", "displayName"],
                          properties: {
                            id: { type: "string", description: "The account's WebAuthn user handle: a hash of its id, base64url — never the email" },
                            name: { type: "string" },
                            displayName: { type: "string" },
                          },
                        },
                        challenge: { type: "string", description: "32 random bytes, base64url" },
                        pubKeyCredParams: {
                          type: "array",
                          items: {
                            type: "object",
                            required: ["type", "alg"],
                            properties: { type: { type: "string", enum: ["public-key"] }, alg: { type: "integer", enum: SUPPORTED_COSE_ALGS, description: "COSE algorithm id" } },
                          },
                        },
                        timeout: { type: "integer", description: "Milliseconds — the token's lifetime" },
                        attestation: { type: "string", enum: ["none"] },
                        authenticatorSelection: {
                          type: "object",
                          properties: {
                            residentKey: { type: "string", enum: ["discouraged"] },
                            requireResidentKey: { type: "boolean", enum: [false] },
                            userVerification: { type: "string", enum: ["preferred"] },
                          },
                        },
                        excludeCredentials: { type: "array", items: WEBAUTHN_CREDENTIAL_DESCRIPTOR, description: "The passkeys already registered, so the authenticator won't enroll one twice" },
                      },
                    },
                  },
                },
              },
            },
          },
          "400": { description: `${MFA_STEP_UP_400}, or the passkey limit is reached` },
          "401": { description: "The session carries no session id" },
          "429": { description: "Too many step-up attempts, or code entry is locked" },
          "503": { description: "AUTH_URL is not configured, so no WebAuthn RP ID exists" },
        },
      },
    },
    "/profile/mfa/passkeys": {
      post: {
        tags: ["Profile"],
        summary: "Finish adding a passkey",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["registrationToken", "credential"],
                properties: {
                  registrationToken: { type: "string" },
                  name: { type: "string", maxLength: 64 },
                  credential: { type: "object", description: "PublicKeyCredential JSON (attestation response, base64url)" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "{ ok, recoveryCodes? } — recoveryCodes when this is the first factor, which also signs out every other session",
            content: { "application/json": { schema: MFA_FACTOR_ADDED } },
          },
          "400": { description: "Expired/foreign registration token, a token issued on the password alone to an account that has since gained a factor, or the response failed verification" },
          "409": { description: "That credential is already registered" },
          "503": { description: "AUTH_URL is not configured, so no WebAuthn RP ID exists" },
        },
      },
    },
    "/profile/mfa/passkeys/{id}": {
      patch: {
        tags: ["Profile"],
        summary: "Rename one of the caller's passkeys",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: mfaStepUpBody({ name: { type: "string", maxLength: 64 } }, ["name"]) } },
        },
        responses: { "200": { description: "Renamed", content: { "application/json": { schema: OK_TRUE } } }, "400": { description: `${MFA_STEP_UP_400}, or an empty name` }, "404": { description: "Not the caller's passkey" }, "429": { description: "Too many step-up attempts, or code entry is locked" } },
      },
      delete: {
        tags: ["Profile"],
        summary: "Remove one of the caller's passkeys",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { required: true, content: { "application/json": { schema: mfaStepUpBody() } } },
        responses: {
          "200": {
            description: "Removed (recovery codes too, and every OTHER session signed out, when it was the last factor)",
            content: { "application/json": { schema: OK_TRUE } },
          },
          "400": { description: MFA_STEP_UP_400 },
          "404": { description: "Not the caller's passkey" },
          "429": { description: "Too many step-up attempts, or code entry is locked" },
        },
      },
    },
    "/profile/locale": {
      patch: {
        tags: ["Profile"],
        summary: "Store the caller's UI language (used for emails, push and Discord DMs)",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["locale"], properties: { locale: { type: "string", enum: [...LOCALES] } } } } },
        },
        responses: {
          "200": { description: "Stored — { locale }", content: { "application/json": { schema: { type: "object", properties: { locale: { type: "string", enum: [...LOCALES] } } } } } },
          "400": { description: "Unsupported locale" },
          "503": { description: "Maintenance mode (non-ADMIN callers)" },
        },
      },
    },
    "/profile/notifications": {
      get: {
        tags: ["Profile"],
        summary: "Read the caller's notification preferences",
        responses: {
          "200": {
            description: "Preference flags",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ...NOTIFICATION_PREF_FLAGS,
                    notificationEmail: { type: "string", nullable: true },
                    emailEnabled: {
                      type: "boolean",
                      description:
                        "True only when the email feature, the notification-email switch AND a configured transport all line up. Clients hide the email section when false, since the channel can never send.",
                    },
                  },
                },
              },
            },
          },
          "404": { description: "User row not found" },
        },
      },
      patch: {
        tags: ["Profile"],
        summary: "Update notification preferences",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  ...NOTIFICATION_PREF_FLAGS,
                  notificationEmail: {
                    type: "string", nullable: true,
                    description: "Jellyfin-provider accounts only — any other provider gets 403. Null or blank clears it. A NEW address is also 403: it must be verified through POST /api/profile/notification-email (mails a one-time token, bound on /confirm); only a write-back of the currently stored address is accepted here.",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Preferences updated — { ok: true }", content: { "application/json": { schema: OK_TRUE } } },
          "400": { description: "No valid field in the body, or a malformed notificationEmail" },
          "403": { description: "notificationEmail was sent by a non-Jellyfin account, or names a new unverified address" },
          "503": { description: "Maintenance mode (non-ADMIN callers)" },
        },
      },
    },

    "/profile/auto-request": {
      get: {
        tags: ["Profile"],
        summary: "Read the caller's watchlist auto-request state",
        responses: {
          "200": {
            description: "Feature, permission and toggle state",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    enabled: { type: "boolean", description: "feature.behavior.watchlistAutoRequest is on" },
                    permitted: {
                      type: "object",
                      description: "Whether the caller holds an AUTO_REQUEST* bit for each media type",
                      properties: { movie: { type: "boolean" }, tv: { type: "boolean" } },
                    },
                    plexWatchlist: { type: "boolean", description: "The caller's \"Auto-request from my Plex watchlist\" toggle" },
                    plexConnected: { type: "boolean", description: "A Plex token of the caller's own is stored (captured at Plex sign-in while the feature is on)" },
                    plexServerSource: { type: "boolean", description: "The admin lets the cron read Plex friends' watchlists through the Plex server owner's token (plexWatchlistServerSource)" },
                    plexServerOptedIn: { type: "boolean", description: "The caller's consent counts for that server-token path: their toggle is on AND they switched it on themselves, or the admin auto-enrolls friends. Always false while the toggle is off" },
                    plexServerStatus: { type: "string", nullable: true, enum: ["ok", "private", "error"], description: "The last server-token run's verdict for the caller; null when it did not read them. \"private\" means their Plex watchlist is not visible to friends" },
                    plexConnectedVia: { type: "string", nullable: true, enum: ["token", "server"], description: "How the cron reads the caller's Plex watchlist: their own token (always preferred), the server owner's token, or neither (null)" },
                  },
                },
              },
            },
          },
          "404": { description: "User row not found" },
        },
      },
      patch: {
        tags: ["Profile"],
        summary: "Turn the caller's Plex watchlist auto-request on or off",
        description: "Turning it on also records the caller's explicit consent for the server-token path (it is read only for users who opted in, unless the admin auto-enrolls); turning it off clears that consent and deletes the caller's stored Plex token.",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["plexWatchlist"], properties: { plexWatchlist: { type: "boolean" } } } } },
        },
        responses: {
          "200": { description: "Saved — { plexWatchlist }", content: { "application/json": { schema: { type: "object", properties: { plexWatchlist: { type: "boolean" } } } } } },
          "400": { description: "plexWatchlist is not a boolean" },
          "503": { description: "Maintenance mode (non-ADMIN callers)" },
        },
      },
    },

    // Per-user Trakt (src/lib/trakt-user.ts, guardrail 34c).
    "/profile/trakt": {
      get: {
        tags: ["Profile"],
        summary: "Read the caller's Trakt connection",
        responses: {
          "200": {
            description: "Connection state and the two uses",
            content: { "application/json": { schema: TRAKT_PROFILE_STATE } },
          },
        },
      },
      patch: {
        tags: ["Profile"],
        summary: "Turn either Trakt use on or off",
        description: "Turning historySeeds off deletes the imported Trakt history at once; turning it back on re-imports it on the next sync. Returns the same body as GET.",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", properties: { watchlistAutoRequest: { type: "boolean" }, historySeeds: { type: "boolean" } } } } },
        },
        responses: {
          "200": { description: "Saved — the connection state", content: { "application/json": { schema: TRAKT_PROFILE_STATE } } },
          "400": { description: "Neither field sent, or one is not a boolean" },
          "404": { description: "Trakt is not connected" },
        },
      },
      delete: {
        tags: ["Profile"],
        summary: "Disconnect Trakt",
        description: "Deletes the stored grant, the connection and the imported watch history, then revokes the token at Trakt (best-effort). Idempotent.",
        responses: { "200": { description: "Disconnected", content: { "application/json": { schema: OK_TRUE } } } },
      },
    },
    "/profile/trakt/device": {
      post: {
        tags: ["Profile"],
        summary: "Start connecting Trakt (device-code flow)",
        description: "Answers the short code the user enters at the verification URL. The device code itself stays on the server. Poll POST /profile/trakt/device/poll every `interval` seconds until it answers connected, expired, denied or conflict. Requires a step-up: a password account sends `confirmPassword`; an SSO account must have signed in within the last 5 minutes.",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { confirmPassword: { type: "string", description: "The current password (password accounts)" } },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "The code to show",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    userCode: { type: "string" },
                    verificationUrl: { type: "string", description: "Always a trakt.tv https URL" },
                    expiresIn: { type: "integer", description: "Seconds until the code expires" },
                    interval: { type: "integer", description: "Seconds between polls" },
                  },
                },
              },
            },
          },
          "400": { description: "Trakt is not available on this server (no client id/secret, or nothing to use it for)" },
          "401": STEP_UP_401,
          "413": { description: "Request body over the 16 KB cap" },
          "429": { description: "Too many starts, Trakt is rate limiting, or too many wrong step-up passwords" },
          "502": { description: "Trakt could not be reached" },
          "503": { description: "Maintenance mode" },
        },
      },
    },
    "/profile/trakt/device/poll": {
      post: {
        tags: ["Profile"],
        summary: "Poll a pending Trakt connection",
        description: "The server paces the real Trakt calls itself, so polling faster than the interval only gets \"pending\".",
        responses: {
          "200": {
            description: "The connection's state",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    state: { type: "string", enum: ["pending", "connected", "expired", "denied", "conflict"], description: "conflict: that Trakt account is connected to another account here" },
                    username: { type: "string", description: "Present when connected" },
                  },
                },
              },
            },
          },
          "400": { description: "Trakt is not available on this server" },
          "429": { description: "Polling too fast, or Trakt is rate limiting" },
          "502": { description: "Trakt could not be reached" },
        },
      },
    },

    "/push/vapid-key": {
      get: {
        tags: ["Push"],
        // No `security: []` override — the handler is withAuth-wrapped and 401s
        // anonymous callers, so it must inherit the document-level session/bearer
        // requirement. Declaring it public made generated clients omit the
        // credential and fail push registration with an unexplained 401.
        summary: "Get the public VAPID key for push subscription",
        responses: {
          "200": { description: "VAPID public key", content: { "application/json": { schema: { type: "object", properties: { publicKey: { type: "string" } } } } } },
          "503": { description: "Web push is not configured — the stored VAPID keypair is incomplete. A client must treat this as 'push unavailable', not a transient failure." },
        },
      },
    },
    "/push/subscribe": {
      post: {
        tags: ["Push"],
        summary: "Register a push subscription",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["endpoint", "keys"],
                description: "The browser PushSubscription JSON fields at the top level (not wrapped).",
                properties: {
                  endpoint: { type: "string", maxLength: 2048 },
                  keys: {
                    type: "object",
                    required: ["p256dh", "auth"],
                    properties: { p256dh: { type: "string" }, auth: { type: "string" } },
                  },
                  label: { type: "string", maxLength: 100 },
                  resync: {
                    type: "boolean",
                    description: "The web bell's page-load re-send of a subscription the browser already holds. It never evicts another device, and is refused (410) for an endpoint removed on purpose.",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Subscription registered ({ ok: true })", content: { "application/json": { schema: OK_TRUE } } },
          "400": { description: "Missing fields, over-long fields (endpoint 2048, keys 256), a non-https endpoint, or an endpoint that is not a recognized push service" },
          "403": { description: "feature.integration.push is disabled" },
          "409": { description: "Endpoint already registered to another user" },
          "410": { description: "resync only: the endpoint was removed (device list or the per-user cap), or re-adding it would exceed the cap — the browser should drop its subscription" },
          "429": { description: "Rate limited — 10/min per user" },
          "503": { description: "Maintenance mode" },
        },
      },
      delete: {
        tags: ["Push"],
        summary: "Remove a push subscription",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                description: "Either the subscription row id (device-management UI) or the push endpoint.",
                properties: { id: { type: "string" }, endpoint: { type: "string" } },
              },
            },
          },
        },
        responses: { "200": { description: "Subscription removed", content: { "application/json": { schema: OK_TRUE } } }, "400": { description: "Neither id nor a valid endpoint supplied" } },
      },
    },
    "/push/test": {
      post: {
        tags: ["Push"],
        summary: "Send a test push notification to current user",
        description: "Sends a real test push to every device registered to the caller (iOS via the APNs relay, Web Push via VAPID). Bypasses feature.integration.push. Rate-limited 5/min per user.",
        responses: {
          "200": {
            description: "Every device accepted the test",
            content: { "application/json": { schema: { type: "object", properties: { results: { type: "array", items: { type: "object", properties: { platform: { type: "string", enum: ["ios", "web"] }, endpoint: { type: "string" }, ok: { type: "boolean" }, status: { type: "integer" }, message: { type: "string" } } } } } } } },
          },
          "404": { description: "The caller has no push subscription" },
          "429": { description: "Rate limited" },
          "502": { description: "At least one device failed (or none was reached) — same { results } body as 200" },
        },
      },
    },

    "/auth/setup-status": {
      get: {
        tags: ["Auth"],
        summary: "Check whether initial admin setup is required",
        security: [],
        responses: { "200": { description: "Setup status", content: { "application/json": { schema: { type: "object", properties: { needsSetup: { type: "boolean" } } } } } } },
      },
    },
    "/auth/register": {
      post: {
        tags: ["Auth"],
        summary: "Register a new user (credentials)",
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["email", "password"],
                properties: {
                  email: { type: "string", format: "email", maxLength: 254 },
                  name: { type: "string", nullable: true, maxLength: 100 },
                  password: { type: "string", minLength: 12, description: "12 characters minimum; also capped at MAX_PASSWORD_LENGTH" },
                },
              },
            },
          },
        },
        description: "First-run bootstrap ONLY: creates the initial ADMIN and never signs anyone in (no token or cookie in the response). Once any user exists or setup has completed it answers 403. Body capped at 16 KB; browsers must send a matching Origin (native clients are exempt via Authorization / X-Summonarr-Client).",
        responses: {
          "201": { description: "Initial admin created", content: { "application/json": { schema: { type: "object", properties: { id: { type: "string" }, email: { type: "string" }, name: { type: "string", nullable: true }, role: { type: "string" } } } } } },
          "400": { description: "Validation error (missing/invalid email or password, password too short or too long, name too long)" },
          "403": { description: "Registration is closed (a user already exists / setup completed), local login is disabled, or the Origin check failed" },
          "429": { description: "Rate limited: 30 attempts per 15 minutes per address before anything is read, then rateLimitRegister (default 5 per 15 minutes per address)" },
          "503": { description: "Maintenance mode" },
        },
      },
    },
    "/auth/plex/client-id": {
      get: {
        tags: ["Auth"],
        summary: "Get the Plex client ID for OAuth",
        security: [],
        responses: { "200": { description: "Plex client ID", content: { "application/json": { schema: { type: "object", properties: { clientId: { type: "string" } } } } } } },
      },
    },
    "/auth/jellyfin/servers": {
      get: {
        tags: ["Auth"],
        summary: "List the configured Jellyfin servers available for sign-in",
        description:
          "Public pre-auth picker source for clients that cannot render the login page's server component. Only fully configured instances (server URL + API key) are listed, default (\"\") first. Returns an empty list — not a 404 — when Jellyfin is not configured. Rate-limited per IP.",
        security: [],
        responses: {
          "200": {
            description: "Configured Jellyfin instances",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    servers: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          slug: { type: "string", description: "Instance key; \"\" is the default server" },
                          name: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          "429": { description: "Rate limited" },
        },
      },
    },
    "/auth/jellyfin/quickconnect": {
      get: {
        tags: ["Auth"],
        summary: "Poll a QuickConnect secret for approval (public)",
        description:
          "Public — native clients poll this before any session exists. `wait=1` upgrades to a server-side long poll (25s budget, 2s ticks) instead of a single upstream check.",
        security: [],
        parameters: [
          { name: "secret", in: "query", required: true, schema: { type: "string" } },
          { name: "wait", in: "query", schema: { type: "string", enum: ["1"] }, description: "Set to 1 to long-poll instead of returning immediately" },
          { name: "instance", in: "query", schema: { type: "string" }, description: "Media-instance slug; defaults to the default instance" },
        ],
        responses: {
          "200": { description: "Poll result", content: { "application/json": { schema: { type: "object", properties: { authenticated: { type: "boolean" } } } } } },
          "400": { description: "Missing secret or invalid instance slug" },
          "410": { description: "QuickConnect session expired or no longer known upstream" },
          "429": { description: "Rate limited — 60/min per IP, 30/min per secret" },
          "499": { description: "Client aborted during a long poll (non-standard)" },
          "502": { description: "QuickConnect disabled upstream, or the poll failed. The disabled case adds `code: \"quickconnect_disabled\"` (terminal: stop polling)" },
          "503": { description: "Jellyfin not configured, or long-poll capacity reached (3/IP, 50 global)" },
        },
      },
      post: {
        tags: ["Auth"],
        summary: "Initiate a Jellyfin QuickConnect login (public)",
        description:
          "Takes NO request body — the instance is selected via the query string. The instance is pinned into a signed flow cookie here and read back from that verified cookie on redemption, never from a client-supplied field. Poll for approval with GET on this path.",
        security: [],
        parameters: [
          { name: "instance", in: "query", schema: { type: "string" }, description: "Media-instance slug; defaults to the default instance" },
        ],
        responses: {
          "200": {
            description: "QuickConnect initiation state (code, secret). A caller sending X-Summonarr-Client also gets `flowState` (the signed flow token to present at sign-in); browsers get it as an HttpOnly cookie instead",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["code", "secret"],
                  properties: {
                    code: { type: "string", description: "The code the user enters in a signed-in Jellyfin client" },
                    secret: { type: "string", description: "Jellyfin's QuickConnect secret — poll GET with it, then redeem it at sign-in" },
                    flowState: { type: "string", description: "Only for a caller sending X-Summonarr-Client: the signed flow token (the HttpOnly cookie's value) to present at sign-in" },
                  },
                },
              },
            },
          },
          "400": { description: "Invalid instance slug" },
          "429": { description: "Rate limited — 10/min per IP" },
          "502": { description: "QuickConnect is disabled or unavailable upstream. The disabled case adds `code: \"quickconnect_disabled\"`" },
          "503": { description: "Jellyfin not configured" },
        },
      },
    },
    "/auth/me": {
      get: {
        tags: ["Auth"],
        summary: "Get the current authenticated session (cookie or bearer)",
        responses: {
          "200": {
            description: "Current session. Never cached (no-store); a re-signed cookie is appended for browsers only",
            content: { "application/json": { schema: { type: "object", properties: { session: { type: "object", properties: { user: { type: "object", properties: { id: { type: "string" }, role: { type: "string" }, permissions: { type: "string", description: "Decimal bitmask" }, email: { type: "string", nullable: true }, name: { type: "string", nullable: true }, provider: { type: "string" }, mediaServer: { type: "string", nullable: true } } }, expiresAt: { type: "integer", description: "Unix seconds" } } } } } } },
          },
          "401": { description: "Not authenticated — body is { session: null }" },
        },
      },
    },
    "/auth/sign-out": {
      post: {
        tags: ["Auth"],
        summary: "Sign out the current session (clears cookie / revokes session)",
        description: "Always 200 { ok: true } and clears the cookies, even when there was no session or the server-side revoke failed. Bearer token is read before the cookie.",
        responses: { "200": { description: "Signed out ({ ok: true })", content: { "application/json": { schema: OK_TRUE } } } },
      },
    },

    "/sessions/revoke-all": {
      post: {
        tags: ["Sessions"],
        summary: "Revoke all of the caller's device sessions (step-up auth required)",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  confirmPassword: { type: "string", description: "Re-authentication for credentials accounts; SSO callers must hold a session younger than 5 minutes" },
                  includeCurrent: { type: "boolean", description: "Also revoke the caller's current session" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Sessions revoked", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" }, count: { type: "integer", description: "AuthSession rows deleted" }, includeCurrent: { type: "boolean" } } } } } },
          "401": { description: "Step-up authentication required or failed. `error` is a code: password-required, invalid-password, or session-too-old (SSO caller whose session is older than 5 minutes)" },
          "429": { description: "Rate limited — 5/hour per user. Body is { error: \"rate_limit\", message }" },
        },
      },
    },

    "/profile/calendar": {
      get: {
        tags: ["Profile"],
        summary: "Calendar feed status",
        description:
          "Whether the caller has an active iCal feed token. The feed URL itself is never returned here: only a SHA-256 hash of the token is stored, so the URL is shown once, by POST. 404 when feature.integration.calendar is off.",
        responses: {
          "200": {
            description: "Feed status",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    enabled: { type: "boolean" },
                    createdAt: { type: "string", format: "date-time", nullable: true },
                    canSubscribeAll: { type: "boolean", description: "Caller holds MANAGE_REQUESTS and may use ?scope=all" },
                  },
                },
              },
            },
          },
          "404": { description: "feature.integration.calendar is disabled" },
        },
      },
      post: {
        tags: ["Profile"],
        summary: "Generate (or regenerate) the calendar feed URL",
        description:
          "Mints a new secret token and returns the subscription URL ONCE. Any previous URL stops working immediately. Rate-limited per user.",
        responses: {
          "201": {
            description: "New feed URL (shown once)",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    token: { type: "string" },
                    url: { type: "string" },
                    webcalUrl: { type: "string" },
                    allUrl: { type: "string", nullable: true, description: "All-requests feed, for MANAGE_REQUESTS holders" },
                    createdAt: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          },
          "404": { description: "feature.integration.calendar is disabled, or the account is disabled" },
          "429": { description: "Too many regenerations — 10/hour per user; carries Retry-After" },
          "503": { description: "Maintenance mode" },
        },
      },
      delete: {
        tags: ["Profile"],
        summary: "Revoke the calendar feed URL",
        responses: {
          "200": { description: "Revoked ({ ok: true })", content: { "application/json": { schema: OK_TRUE } } },
          "404": { description: "feature.integration.calendar is disabled" },
        },
      },
    },
    "/calendar/feed/{token}": {
      get: {
        tags: ["Profile"],
        summary: "iCal subscription feed (public, token-authed)",
        description:
          "RFC 5545 calendar of upcoming release dates (movie theatrical/digital/physical, TV episode air dates) for the token owner's non-declined requests and watchlist, ~30 days back to ~1 year ahead. The path segment is `<token>.ics`. `?scope=all` returns every non-declined request instead and requires MANAGE_REQUESTS (re-checked on every poll). Cache-read only. Every failure — unknown/revoked token, disabled or purged owner, missing permission, feature off — is a bare 404.",
        security: [],
        parameters: [
          { name: "token", in: "path", required: true, schema: { type: "string" }, description: "`<token>.ics`" },
          { name: "scope", in: "query", required: false, schema: { type: "string", enum: ["all"] } },
        ],
        responses: {
          "200": { description: "The calendar", content: { "text/calendar": { schema: { type: "string" } } } },
          "404": { description: "Not found" },
          "429": { description: "Rate limited (per address and per token)" },
        },
      },
    },
    "/profile": {
      delete: {
        tags: ["Profile"],
        summary: "Close (disable) the caller's own account",
        description:
          "Revokes every session and blocks sign-in from then on. Nothing is scrubbed and nothing is cascade-deleted — an admin can re-enable the account, and the irreversible personal-data scrub is a separate admin action (POST /admin/users/{id}/purge).",
        requestBody: {
          required: false,
          content: { "application/json": { schema: { type: "object", properties: {
            password: { type: "string", description: "Required (non-empty) for local-credentials accounts; ignored for SSO accounts" },
            secondFactor: { ...MFA_SECOND_FACTOR_SCHEMA, description: "Local account with an active second factor, web session: a fresh second factor (same shape as the enrollment step-up). A native (app) session is exempt for now." },
          } } } },
        },
        responses: {
          "200": { description: "Account disabled ({ ok: true }; idempotent)", content: { "application/json": { schema: OK_TRUE } } },
          "400": { description: "Cannot disable the last admin, a missing/incorrect password on a local account, or (web session, active second factor) a missing/invalid second factor ({ error, secondFactorRequired: true, methods? })" },
          "413": { description: "Request body over the 16 KB cap" },
          "404": { description: "Account not found" },
          "429": { description: "Too many password attempts — 5 per 15 minutes (local accounts); carries Retry-After" },
          "503": { description: "Maintenance mode" },
        },
      },
    },

    "/admin/users": {
      get: {
        tags: ["Admin – Users"],
        summary: "List users (MANAGE_USERS)",
        description: "Up to 1000 users, ordered by name then email.",
        responses: { "200": { description: "User list", content: { "application/json": { schema: { type: "array", items: ADMIN_USER_ITEM } } } } },
      },
      post: {
        tags: ["Admin – Users"],
        summary: "Create a local-credentials user (MANAGE_USERS)",
        description: "Creating an ADMIN requires the caller to hold the ADMIN bit. An address in a domain Summonarr mints for itself (@jellyfin.local, @discord.local, @deleted.invalid) is refused for every caller. Rate-limited 10/min per caller. Body capped at 16 KB.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["email", "password"],
                properties: {
                  email: { type: "string", format: "email" },
                  password: { type: "string", minLength: 12 },
                  name: { type: "string", nullable: true, maxLength: 100 },
                  role: { $ref: "#/components/schemas/UserRole" },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "User created (same shape as a list item)", content: { "application/json": { schema: ADMIN_USER_ITEM } } },
          "400": { description: "Validation error, or a reserved email domain" },
          "403": { description: "Creating an ADMIN requires the ADMIN bit; a role whose permission preset the caller does not hold in full (a delegate can't grant beyond its own bits); or, for a caller without the ADMIN bit, an email that belongs to a Plex/Jellyfin server user" },
          "409": { description: "Email already in use" },
          "429": { description: "Rate limited" },
        },
      },
    },
    "/admin/users/{id}": {
      patch: {
        tags: ["Admin – Users"],
        summary: "Update user settings (MANAGE_USERS)",
        description: "Conferring the ADMIN role, or editing an account that is already ADMIN, additionally requires the caller to hold ADMIN. ONE FIELD GROUP PER CALL: the handler applies only the first group present, in this order — mediaServer, maxContentRating, permissions, instanceGrants, mediaServerGrants, then the first quota* field, then the first notification flag, then role — and answers 200 with `{ id, <field>: <new value> }` (permissions as a decimal string). A body with none of them is 400. A non-ADMIN delegate may not edit its own limits/grants, may not touch an ADMIN account, and may only grant what it holds itself (403). Rate-limited 20/min per caller; body capped at 32 KB.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  role: { $ref: "#/components/schemas/UserRole" },
                  permissions: { type: "string", description: "Decimal-encoded capability bitmask (see src/lib/permissions.ts)" },
                  movieQuotaLimit: { type: "integer", nullable: true },
                  movieQuotaDays: { type: "integer", nullable: true },
                  tvQuotaLimit: { type: "integer", nullable: true },
                  tvQuotaDays: { type: "integer", nullable: true },
                  mediaServer: { type: "string", enum: ["plex", "jellyfin"], nullable: true },
                  ...NOTIFICATION_PREF_FLAGS,
                  maxContentRating: { type: "string", nullable: true, description: "Content-rating cap; null or empty clears it" },
                  mediaServerGrants: {
                    type: "object",
                    nullable: true,
                    description: "Per-server library visibility for RESTRICTED Plex/Jellyfin instances: { plex: { <slug>: { view } }, jellyfin: { <slug>: { view } } }",
                    additionalProperties: { type: "object", additionalProperties: { type: "object", properties: { view: { type: "boolean" } } } },
                  },
                  instanceGrants: {
                    type: "object",
                    nullable: true,
                    description: "Per-instance grants for NAMED Radarr/Sonarr instances, keyed by slug",
                    additionalProperties: {
                      type: "object",
                      properties: { request: { type: "boolean" }, autoApprove: { type: "boolean" } },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "The single field group that was applied, echoed with `id`",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["id"],
                  description: "`id` plus exactly ONE of the other fields: the group that was applied, with its new value",
                  properties: {
                    id: { type: "string" },
                    mediaServer: { type: "string", enum: ["plex", "jellyfin", null], nullable: true },
                    maxContentRating: { type: "string", nullable: true },
                    permissions: { type: "string", description: "Decimal bitmask" },
                    instanceGrants: {
                      type: "object",
                      description: "As stored: only slugs with a grant",
                      additionalProperties: { type: "object", properties: { request: { type: "boolean", enum: [true] }, autoApprove: { type: "boolean", enum: [true] } } },
                    },
                    mediaServerGrants: {
                      type: "object",
                      description: "As stored: { plex?: { <slug>: { view: true } }, jellyfin?: { … } }",
                      additionalProperties: { type: "object", additionalProperties: { type: "object", properties: { view: { type: "boolean", enum: [true] } } } },
                    },
                    movieQuotaLimit: { type: "integer", nullable: true },
                    movieQuotaDays: { type: "integer", nullable: true },
                    tvQuotaLimit: { type: "integer", nullable: true },
                    tvQuotaDays: { type: "integer", nullable: true },
                    ...NOTIFICATION_PREF_FLAGS,
                    role: { $ref: "#/components/schemas/UserRole" },
                  },
                },
              },
            },
          },
          "400": { description: "Invalid value, no recognized field, own-role change, or a last-admin / promote-first rule" },
          "403": { description: "Forbidden (ADMIN-bit rule, own limits, or grant beyond the caller's own)" },
          "404": { description: "User not found" },
          "429": { description: "Rate limited" },
        },
      },
      delete: {
        tags: ["Admin – Users"],
        summary: "Disable a user (MANAGE_USERS)",
        description:
          "Revokes every session and blocks sign-in. Reversible — nothing is scrubbed, the account's requests/issues/votes stay attached, and its Plex/Jellyfin link stays intact so play history keeps being attributed. Re-enable with POST /admin/users/{id}/reactivate; erase with POST /admin/users/{id}/purge.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "User disabled ({ ok: true }; idempotent)", content: { "application/json": { schema: OK_TRUE } } },
          "400": { description: "Cannot disable the last admin, or the caller's own account" },
          "403": { description: "Forbidden (an ADMIN target needs the ADMIN bit)" },
          "404": { description: "User not found" },
          "429": { description: "Rate limited" },
        },
      },
    },
    "/admin/users/{id}/reactivate": {
      post: {
        tags: ["Admin – Users"],
        summary: "Re-enable a disabled user (MANAGE_USERS)",
        description:
          "Clears the disabled flag so the account can sign in again. Prior sessions stay revoked — the user signs in fresh. Refused for a purged account, which has no identity left to sign in with.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "User re-enabled (idempotent)", content: { "application/json": { schema: OK_TRUE } } },
          "400": { description: "Account was purged and cannot be re-enabled" },
          "403": { description: "Forbidden" },
          "404": { description: "User not found" },
          "409": { description: "Account state changed concurrently" },
          "429": { description: "Rate limited" },
        },
      },
    },
    "/admin/users/{id}/purge": {
      post: {
        tags: ["Admin – Users"],
        summary: "IRREVERSIBLY scrub a disabled user's personal data (MANAGE_USERS)",
        description:
          "Anonymizes the account in place: name, email, password, image, Discord, notification email, provider-subject keys, OAuth rows, push subscriptions, watchlist/hidden/notifications, and the Plex/Jellyfin identity link. Requests, votes and issues survive on a de-identified row. Requires the account to be disabled first, and cannot be undone — this is the action that services a 'delete my data' request.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Personal data purged (idempotent)", content: { "application/json": { schema: OK_TRUE } } },
          "400": { description: "Account must be disabled before it can be purged" },
          "403": { description: "Forbidden (an ADMIN target needs the ADMIN bit)" },
          "404": { description: "User not found" },
          "429": { description: "Rate limited" },
        },
      },
    },
    "/admin/users/{id}/mfa": {
      delete: {
        tags: ["Admin – Users"],
        summary: "Reset a user's two-factor authentication — lost device (MANAGE_USERS)",
        description:
          "Removes the user's authenticator app, every passkey and every recovery code, and signs the account out everywhere; their next sign-in is password-only. An ADMIN target needs the ADMIN bit. Refuses the caller's own account (use DELETE /profile/mfa with the password step-up).",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Reset", content: { "application/json": { schema: OK_TRUE } } },
          "400": { description: "Own account" },
          "403": { description: "Forbidden" },
          "404": { description: "Not found" },
          "429": { description: "Rate limited" },
        },
      },
    },
    "/admin/arr-instances": {
      get: {
        tags: ["Admin – Settings"],
        summary: "List all Radarr/Sonarr instances with connection state (ADMIN)",
        responses: {
          "200": {
            description:
              "Instance lists keyed by service. Each carries its registry entry plus url, externalUrl, rootFolder, " +
              "qualityProfileId, minimumAvailability, languageProfileId (stored strings, \"\" when unset); secrets only as " +
              "hasApiKey / hasWebhookSecret. `versions` (additive) holds an opaque version per service of the NAMED " +
              "instances, to send back as POST `baseVersion`.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["radarr", "sonarr"],
                  properties: {
                    radarr: { type: "array", items: ARR_INSTANCE_VIEW },
                    sonarr: { type: "array", items: ARR_INSTANCE_VIEW },
                    versions: { type: "object", properties: { radarr: { type: "string" }, sonarr: { type: "string" } } },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        tags: ["Admin – Settings"],
        summary: "Save one service's instance registry + connection settings (ADMIN)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["service", "instances"],
                properties: {
                  service: { type: "string", enum: ["radarr", "sonarr"] },
                  baseVersion: {
                    type: "string",
                    description: "Optional: the `version` this list was edited from (GET `versions[service]` or the last POST's `version`). When it is no longer current the save is refused with 409 and nothing is written. Omitted, the save is unconditional.",
                  },
                  instances: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["slug"],
                      properties: {
                        slug: { type: "string", description: "'' = default, '4k', or a named slug (lowercase alnum)" },
                        name: { type: "string" },
                        restricted: { type: "boolean" },
                        serverAll: { type: "boolean" },
                        skipLibraryCheck: { type: "boolean" },
                        autoRoute: { type: "object", nullable: true, properties: { animeOnly: { type: "boolean" }, genreIds: { type: "array", items: { type: "integer" } }, originalLanguages: { type: "array", items: { type: "string" } } } },
                        url: { type: "string" },
                        externalUrl: {
                          type: "string",
                          nullable: true,
                          description: "The address a BROWSER uses for the instance (Open in Radarr/Sonarr links) — never fetched by the server; blank or null falls back to url",
                        },
                        apiKey: { type: "string", maxLength: 512, description: "Write-only; send the mask sentinel to keep unchanged" },
                        rootFolder: { type: "string" },
                        qualityProfileId: { type: "integer", nullable: true },
                        webhookSecret: { type: "string", maxLength: 512, description: "Write-only; send the mask sentinel to keep unchanged" },
                        minimumAvailability: { type: "string", nullable: true, enum: ["", "announced", "inCinemas", "released", null], description: "Radarr only; \"\" or null clears (Radarr's default)" },
                        languageProfileId: { type: "integer", nullable: true, description: "Sonarr v3 only; null clears" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Saved. `instances` is the configured set as GET lists it (secrets masked as has* flags), `testResults` one entry per instance whose connection was tested, `removed` (additive — the iOS app decodes it) one entry per de-registered slug with the PENDING/APPROVED requests it left behind, and `version` (additive) the list's new version for the next `baseVersion`.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean" },
                    instances: { type: "array", items: ARR_INSTANCE_VIEW },
                    testResults: { type: "object", description: "Keyed by instance slug: only the instances whose connection was tested", additionalProperties: { type: "object", properties: { version: { type: "string" }, error: { type: "string" } } } },
                    removed: { type: "array", items: { type: "object", properties: { slug: { type: "string" }, openRequests: { type: "integer" } } } },
                    version: { type: "string" },
                  },
                },
              },
            },
          },
          "400": { description: "Invalid service or slug (`external` is reserved), `instances` is not an array, `baseVersion` is not a string, or an apiKey/webhookSecret is not a string of at most 512 characters" },
          "409": { description: "The stored list changed since `baseVersion`, or the body keeps a secret (mask sentinel) for a named instance that is no longer registered; nothing was written — reload and save again" },
          "413": { description: "Request body over the 64 KB cap" },
        },
      },
    },
    "/admin/oidc-allowlist": {
      get: {
        tags: ["Admin – Settings"],
        summary: "Who may sign in through OIDC (ADMIN)",
        description: "Off by default (empty lists, existingUsersOnly false). `unreadable: true` means the stored value doesn't parse and every OIDC sign-in is being refused until it is saved again; `allowlist` is then the default.",
        responses: {
          "200": {
            description: "The policy in force",
            content: { "application/json": { schema: { type: "object", properties: {
              allowlist: { $ref: "#/components/schemas/OidcAllowlist" },
              unreadable: { type: "boolean" },
            } } } },
          },
          "401": { description: "Not signed in" },
          "403": { description: "Not ADMIN" },
        },
      },
      patch: {
        tags: ["Admin – Settings"],
        summary: "Replace the OIDC allowlist (ADMIN)",
        description:
          "The whole policy. groups: the configured claim (default \"groups\", read from the ID token, else userinfo) must name at least one, exact match. " +
          "emailDomains: the IdP-verified email must be in one (exact domain; a leading @ is dropped, lowercased). existingUsersOnly: never create an account. " +
          "requestGroupsScope: also ask the IdP for the \"groups\" scope. Groups and domains apply to every OIDC sign-in, existing accounts included, on the web " +
          "callback and the native route; refusals are audited AUTH_LOGIN_FAILED with the reason. Nothing here ends an existing session. A wrong field refuses the " +
          "whole body. Lists are trimmed and de-duplicated, at most 50 entries each. Audited SETTINGS_CHANGE.",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/OidcAllowlist" } } } },
        responses: {
          "200": {
            description: "{ allowlist, unreadable: false } — the policy as saved",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["allowlist", "unreadable"],
                  properties: {
                    allowlist: { $ref: "#/components/schemas/OidcAllowlist" },
                    unreadable: { type: "boolean", enum: [false] },
                  },
                },
              },
            },
          },
          "400": { description: "A field is the wrong type or shape" },
          "401": { description: "Not signed in" },
          "403": { description: "Not ADMIN" },
          "413": { description: "Request body over the 32 KB cap" },
        },
      },
    },
    "/admin/media-instances": {
      get: {
        tags: ["Admin – Settings"],
        summary: "List all Plex/Jellyfin server instances with connection state (ADMIN)",
        responses: {
          "200": {
            description: "Instance lists keyed by service (secrets masked as has* flags). `versions` (additive) holds an opaque version per service of the NAMED servers, to send back as POST `baseVersion`.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["plex", "jellyfin", "versions"],
                  properties: {
                    plex: { type: "array", items: PLEX_INSTANCE_VIEW },
                    jellyfin: { type: "array", items: JELLYFIN_INSTANCE_VIEW },
                    versions: { type: "object", properties: { plex: MEDIA_INSTANCES_VERSION, jellyfin: MEDIA_INSTANCES_VERSION } },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        tags: ["Admin – Settings"],
        summary: "Save one service's instance registry + connection settings (ADMIN)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["service", "instances"],
                properties: {
                  service: { type: "string", enum: ["plex", "jellyfin"] },
                  baseVersion: {
                    type: "string",
                    description: "Optional: the `version` this list was edited from (GET `versions[service]` or the last POST's `version`). When it is no longer current the save is refused with 409 and nothing is written. Omitted, the save is unconditional.",
                  },
                  instances: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["slug"],
                      properties: {
                        slug: { type: "string", description: "'' = default, or a named slug (lowercase alnum)" },
                        name: { type: "string" },
                        serverUrl: { type: "string", description: "Plex only" },
                        adminToken: { type: "string", maxLength: 4096, description: "Plex only; write-only, send the mask sentinel to keep unchanged" },
                        adminEmail: { type: "string", description: "Plex only" },
                        url: { type: "string", description: "Jellyfin only" },
                        apiKey: { type: "string", maxLength: 4096, description: "Jellyfin only; write-only, send the mask sentinel to keep unchanged" },
                        restrictSignIn: { type: "boolean", description: "Jellyfin only; omit to leave the stored value untouched" },
                        restricted: { type: "boolean", description: "Gate this server's library behind a per-user view grant (never the default instance)" },
                        libraries: { type: "string", description: "Comma-joined library ids/section keys to sync from THIS server; omit to leave untouched, \"\" syncs all" },
                        moviePathStripPrefix: { type: "string", description: "Omit to leave untouched; \"\" deletes the row (inherit the default server's prefix)" },
                        tvPathStripPrefix: { type: "string", description: "As moviePathStripPrefix" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Saved ({ ok, instances, testResults, version }); includes per-instance connection test results and (additive) the list's new version for the next `baseVersion`",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["ok", "instances", "testResults", "version"],
                  properties: {
                    ok: { type: "boolean", enum: [true] },
                    instances: {
                      type: "array",
                      description: "The saved service's servers (Plex or Jellyfin shape)",
                      items: { oneOf: [PLEX_INSTANCE_VIEW, JELLYFIN_INSTANCE_VIEW] },
                    },
                    testResults: {
                      type: "object",
                      description: "Keyed by slug; only servers with their connection fields set are tested",
                      additionalProperties: { type: "object", properties: { ok: { type: "boolean", enum: [true] }, error: { type: "string" } } },
                    },
                    version: MEDIA_INSTANCES_VERSION,
                  },
                },
              },
            },
          },
          "400": { description: "Invalid service, slug, server URL or name, `instances` is not an array, `baseVersion` is not a string, or an adminToken/apiKey is not a string of at most 4096 characters" },
          "409": { description: "The stored list changed since `baseVersion`, or the body keeps a token (mask sentinel) for a named server that is no longer registered; nothing was written — reload and save again" },
          "413": { description: "Request body over the 64 KB cap" },
        },
      },
    },
    "/admin/users/{id}/sessions": {
      get: {
        tags: ["Admin – Users"],
        summary: "List auth sessions for a user (MANAGE_USERS)",
        description: "An ADMIN target needs the ADMIN bit.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "Auth session list, most recently seen first",
            content: { "application/json": { schema: { type: "array", items: { type: "object", properties: { id: { type: "string" }, sessionId: { type: "string" }, deviceType: { type: "string" }, deviceLabel: { type: "string", nullable: true }, ipAddress: { type: "string", nullable: true }, createdAt: { type: "string", format: "date-time" }, lastSeenAt: { type: "string", format: "date-time" }, expiresAt: { type: "string", format: "date-time", description: "Sentinel far-future date for a never-expiring native session" }, indefinite: { type: "boolean", description: "Additive: true for a never-expiring native session" } } } } } },
          },
          "403": { description: "An ADMIN target needs the ADMIN bit" },
          "404": { description: "User not found" },
        },
      },
      delete: {
        tags: ["Admin – Users"],
        summary: "Revoke one auth session, or all of them, for a user (MANAGE_USERS)",
        description: "The target is chosen in the JSON BODY, not the query string. `all: true` (strictly boolean true) revokes every session; otherwise `sessionId` revokes that one, which must belong to this user.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", properties: { sessionId: { type: "string" }, all: { type: "boolean" } } } } },
        },
        responses: {
          "200": { description: "Revoked", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" }, revoked: { type: "string", description: "\"all\" or the revoked sessionId" } } } } } },
          "400": { description: "Neither `all` nor a `sessionId` supplied" },
          "403": { description: "An ADMIN target needs the ADMIN bit" },
          "404": { description: "User not found, or the session does not belong to this user" },
        },
      },
    },

    "/admin/users/{id}/watch-grade": {
      get: {
        tags: ["Admin – Users"],
        summary: "A user's request watch grade with its per-request breakdown (MANAGE_USERS or MANAGE_REQUESTS)",
        description:
          "Grades A–F on the share of the user's APPROVED requests that became available that they went on to " +
          "watch, from recorded play history. Approval counts per title on an instance: a request counts when it, " +
          "or any request for the same title on the same instance, was approved (`approvedAt`). Pending and " +
          "declined requests never count, and neither does a request whose title nobody approved. " +
          "Display-only: nothing reads the grade to gate requests. A request is scored only after its " +
          "grace period since fulfilment, and only when play history already covered the user's media servers " +
          "when it was fulfilled; plays count only from the moment of the request. A movie earns full credit when " +
          "watched (half once a quarter of it was played); a show is scored per season — episodes watched ÷ the " +
          "configured share of that season's regular-season library episodes — and the best season counts. The " +
          "same title requested on several *arr instances is folded into one unit (`duplicates`). A request the " +
          "user didn't watch still earns full credit once `settings.otherViewers` other people watched it since " +
          "the request, as play history recorded them (0 = off; one account's several media-server logins count " +
          "once). `enabled: false` (with `reason`) when the feature flag or play history tracking is off.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "Watch grade detail",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    enabled: { type: "boolean" },
                    reason: { type: "string", nullable: true, enum: ["feature-off", "tracking-off"] },
                    settings: {
                      type: "object",
                      nullable: true,
                      properties: {
                        graceDays: { type: "integer" },
                        windowDays: { type: "integer", description: "0 = no limit" },
                        tvEpisodePercent: { type: "integer", description: "Share of a season's library episodes for full credit" },
                        otherViewers: { type: "integer", description: "0 = off" },
                        bandA: { type: "integer", description: "Minimum watch rate for an A" },
                        bandB: { type: "integer", description: "Minimum watch rate for a B" },
                        bandC: { type: "integer", description: "Minimum watch rate for a C" },
                        bandD: { type: "integer", description: "Minimum watch rate for a D; below it is an F" },
                        minGradedRequests: { type: "integer", description: "Scored requests needed before a letter" },
                        watchedThresholdPercent: { type: "integer" },
                      },
                    },
                    grade: {
                      type: "object",
                      nullable: true,
                      properties: {
                        status: { type: "string", enum: ["graded", "insufficient", "unlinked", "untracked"] },
                        letter: { type: "string", nullable: true, enum: ["A", "B", "C", "D", "F"] },
                        minGradedRequests: { type: "integer", description: "Scored requests a letter needs (the setting in force)" },
                        score: { type: "integer", nullable: true, description: "0–100 watch rate over scored requests" },
                        graded: { type: "integer" },
                        watched: { type: "integer" },
                        byOthers: { type: "integer", description: "Counted as watched because enough other people watched it" },
                        partial: { type: "integer" },
                        unwatched: { type: "integer" },
                        inGrace: { type: "integer" },
                        untracked: { type: "integer" },
                      },
                    },
                    requests: {
                      type: "array",
                      description: "Newest fulfilment first, capped at 500 rows (the grade itself covers every request)",
                      items: {
                        type: "object",
                        properties: {
                          requestId: { type: "string" },
                          tmdbId: { type: "integer" },
                          mediaType: { $ref: "#/components/schemas/MediaType" },
                          title: { type: "string" },
                          releaseYear: { type: "string", nullable: true },
                          posterPath: { type: "string", nullable: true },
                          requestedAt: { type: "string", format: "date-time" },
                          fulfilledAt: { type: "string", format: "date-time" },
                          duplicates: { type: "integer", description: "Further requests for the same title (other instances) folded into this one" },
                          watch: { type: "string", nullable: true, enum: ["watched", "partial", "unwatched"], description: "The requester's own watch state" },
                          otherViewers: { type: "integer", nullable: true, description: "Other people who watched it since the request; counted only for a scored request the requester didn't fully watch, null otherwise" },
                          watchedByOthers: { type: "boolean" },
                          credit: { type: "number", description: "0–1; 1 when watchedByOthers" },
                          scoring: { type: "string", enum: ["scored", "grace", "untracked"] },
                          graceDaysLeft: { type: "integer", nullable: true },
                          episodes: {
                            type: "object",
                            nullable: true,
                            description: "The best season — the one the credit comes from",
                            properties: {
                              season: { type: "integer", nullable: true },
                              watched: { type: "integer" },
                              started: { type: "integer" },
                              library: { type: "integer", description: "Episodes of that season in the library; 0 = unknown" },
                              required: { type: "integer" },
                            },
                          },
                        },
                      },
                    },
                    truncated: { type: "boolean" },
                  },
                },
              },
            },
          },
          "403": { description: "Caller holds neither MANAGE_USERS nor MANAGE_REQUESTS" },
          "404": { description: "No such user" },
        },
      },
    },

    "/admin/cleanup": {
      get: {
        tags: ["Admin – Cleanup"],
        summary: "Library cleanup report (ADMIN)",
        description:
          "Judges every library title (the union of every Plex and Jellyfin server) against the configured rules and " +
          "returns each title any enabled rule matched: candidates first, then the ones an exclusion holds back, with " +
          "every matched rule and exclusion named. Sizes and Radarr/Sonarr instances come from one live listing per " +
          "configured instance. Nothing is written. 404 while `feature.admin.cleanup` is off.",
        responses: {
          "200": {
            description: "The report",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    settings: { $ref: "#/components/schemas/CleanupSettings" },
                    playHistoryTracked: { type: "boolean" },
                    historyStart: { type: "string", format: "date-time", nullable: true },
                    libraryTitles: { type: "integer" },
                    rows: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          tmdbId: { type: "integer" },
                          mediaType: { type: "string", enum: ["MOVIE", "TV"] },
                          title: { type: "string" },
                          posterPath: { type: "string", nullable: true },
                          year: { type: "string", nullable: true },
                          servers: { type: "array", items: { type: "string" } },
                          addedAt: { type: "string", format: "date-time", nullable: true },
                          lastPlayedAt: { type: "string", format: "date-time", nullable: true },
                          playCount: { type: "integer" },
                          votes: { type: "integer" },
                          idleDays: { type: "integer", nullable: true },
                          arr: { type: "array", items: { type: "object", properties: { service: { type: "string", enum: ["radarr", "sonarr"] }, instance: { type: "string" }, sizeOnDisk: { type: "number" } } } },
                          sizeOnDisk: { type: "number", nullable: true },
                          matched: { type: "array", items: { type: "string", enum: ["unwatched", "neverWatched", "votes"] } },
                          excludedBy: { type: "array", items: { type: "string", enum: ["recentlyAdded", "activeRequest", "recentlyFulfilled", "watchlisted", "playingNow", "airing", "protected", "upstreamUnchecked"] } },
                          candidate: { type: "boolean" },
                        },
                      },
                    },
                    arrErrors: { type: "array", items: { type: "object", properties: { service: { type: "string", enum: ["radarr", "sonarr"] }, instance: { type: "string" }, error: { type: "string" }, kind: { type: "string", enum: ARR_ERROR_KINDS, description: "Why the listing failed — translate this, not the English `error`" } } } },
                    protected: { type: "array", description: "The 1000 most recently protected titles", items: { type: "object", properties: { tmdbId: { type: "integer" }, mediaType: { type: "string" }, title: { type: "string", nullable: true }, reason: { type: "string", nullable: true }, createdAt: { type: "string", format: "date-time" } } } },
                    protectedTotal: { type: "integer", description: "Every protected title — more than `protected` lists when that list is capped" },
                    totals: { type: "object", properties: { candidates: { type: "integer" }, held: { type: "integer" }, reclaimableBytes: { type: "number" } } },
                  },
                },
              },
            },
          },
          "403": { description: "Not ADMIN" },
          "404": { description: "Library cleanup is disabled" },
          "429": { description: "Too many cleanup report loads from this admin; 30 per minute", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },

    "/admin/never-watched": {
      get: {
        tags: ["Admin – Never watched"],
        summary: "Never-watched report, one page of it (ADMIN)",
        description:
          "Every library title — and every season of a show that HAS been watched — with no play in this server's recorded history. " +
          "A title is judged only when every server holding it is recorded and has history; the claim starts at the later of its " +
          "earliest arrival and the last holder's recording start. Evidence is a union: plays by tmdb id, by the movie's own item key, " +
          "by the show's key, sessions playing now, and each media server's own watch records (UpstreamWatchEvidence). States: " +
          "`neverWatched` (observed since it arrived), `noPlaysSince` (on the shelf before recording began), `possiblyWatched` " +
          "(only an unattributed play with the same title), `unobservable` (with a reason). `eligible` is exactly what Library " +
          "cleanup's dry run would include. The whole-library report is cached ~2 minutes; `fresh=1` recomputes it and re-lists " +
          "Radarr/Sonarr. Nothing is written. 404 while `feature.admin.neverWatched` is off; 60 requests/min per admin.",
        parameters: [
          { name: "level", in: "query", schema: { type: "string", enum: ["title", "season"], default: "title" } },
          { name: "state", in: "query", schema: { type: "string", enum: ["never", "possible", "unknown", "all"], default: "never" } },
          { name: "type", in: "query", schema: { type: "string", enum: ["all", "movie", "tv"], default: "all" }, description: "Title level only — ignored for level=season" },
          { name: "q", in: "query", schema: { type: "string", maxLength: 100 } },
          { name: "eligible", in: "query", schema: { type: "string", enum: ["1"] }, description: "Only titles Library cleanup could delete now. Title level only — ignored for level=season" },
          { name: "sortBy", in: "query", schema: { type: "string", enum: ["size", "days", "since", "added", "title"], default: "size" }, description: "`added` sorts seasons by `since`" },
          { name: "sortDir", in: "query", schema: { type: "string", enum: ["asc", "desc"] } },
          { name: "page", in: "query", schema: { type: "integer", minimum: 1, default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
          { name: "fresh", in: "query", schema: { type: "string", enum: ["1"] } },
        ],
        responses: {
          "200": {
            description: "One page of rows plus the report summary",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    rows: { type: "array", items: { type: "object", description: "kind: \"title\" | \"season\" — see the description", oneOf: [NEVER_WATCHED_TITLE_ROW, NEVER_WATCHED_SEASON_ROW] } },
                    total: { type: "integer" },
                    query: {
                      type: "object",
                      description: "The parameters as applied (an unknown value falls back to its default; season rows ignore type/eligible)",
                      properties: {
                        level: { type: "string", enum: ["title", "season"] },
                        state: { type: "string", enum: ["never", "possible", "unknown", "all"] },
                        type: { type: "string", enum: ["all", "movie", "tv"] },
                        q: { type: "string" },
                        eligibleOnly: { type: "boolean" },
                        sortBy: { type: "string", enum: ["size", "days", "since", "added", "title"] },
                        sortDir: { type: "string", enum: ["asc", "desc"] },
                        page: { type: "integer" },
                        limit: { type: "integer" },
                      },
                    },
                    totals: {
                      type: "object",
                      properties: {
                        never: { type: "object", properties: { titles: { type: "integer" }, bytes: { type: "number" }, unsized: { type: "integer" } } },
                        seasons: { type: "object", properties: { count: { type: "integer" }, bytes: { type: "number" } } },
                        eligible: { type: "object", properties: { titles: { type: "integer" }, bytes: { type: "number" } } },
                        possible: { type: "integer" },
                        unknown: { type: "integer" },
                        libraryTitles: { type: "integer" },
                      },
                    },
                    coverage: { type: "array", items: { type: "object", properties: {
                      server: { type: "string" },
                      source: { type: "string", enum: ["plex", "jellyfin"] },
                      tracked: { type: "boolean" },
                      since: { type: "string", format: "date-time", nullable: true },
                      holds: { type: "boolean", description: "A library title sits on this server; only these can hold a title back (upstreamUnchecked)" },
                      upstream: { type: "object", properties: {
                        health: { type: "string", enum: ["ok", "unreliable", "failed", "incomplete", "stale", "never"], description: "`incomplete`: the read stopped at its cap — what it holds is real, but not the whole history" },
                        fetchedAt: { type: "string", nullable: true },
                        attemptedAt: { type: "string", nullable: true },
                        entries: { type: "integer" },
                        matched: { type: "integer" },
                        samples: { type: "integer" },
                        agreed: { type: "integer" },
                        error: { type: "string", nullable: true, description: "The stored English failure text — translate `errorCode` instead" },
                        errorCode: { type: "string", nullable: true, enum: ["timeout", "unreachable", "blocked", "tooLarge", "redirect", "http", "noUsers", "shape", "noRecords", "other"] },
                        httpStatus: { type: "integer", nullable: true, description: "Set when errorCode is `http`" },
                      } },
                    } } },
                    trackingOn: { type: "boolean" },
                    historyStart: { type: "string", format: "date-time", nullable: true },
                    unplacedPlays: { type: "integer" },
                    softPlays: { type: "integer" },
                    arrErrors: { type: "array", items: { type: "object", properties: { service: { type: "string", enum: ["radarr", "sonarr"] }, instance: { type: "string" }, error: { type: "string" }, kind: { type: "string", enum: ARR_ERROR_KINDS, description: "Why the listing failed — translate this, not the English `error`" } } } },
                    sizesAsOf: { type: "string", format: "date-time", nullable: true },
                    cleanupEnabled: { type: "boolean" },
                    neverWatchedDays: { type: "integer" },
                    requireUpstreamCheck: { type: "boolean" },
                    computedAt: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          },
          "403": { description: "Not ADMIN" },
          "404": { description: "The Never Watched page is disabled" },
          "429": { description: "Rate limited" },
        },
      },
    },

    "/admin/watch-sync": {
      get: {
        tags: ["Admin – Watch sync"],
        summary: "Watch sync pairs, their ledger counts, the pickable accounts and suggestions (ADMIN)",
        description:
          "Every pair (Plex account → Jellyfin user) with its read point, last run and per-status item counts; every active Plex " +
          "and Jellyfin server user (row id, username, server display name — never a provider id, token or address); and " +
          "suggested pairs (both identities linked to one Summonarr account). A suggestion is never paired automatically.",
        responses: {
          "200": {
            description: "{ pairs: [{ id, enabled, direction, syncProgress, plex, jellyfin, historyReadTo, jellyfinReadTo, lastRunAt, lastResult, counts: { toJellyfin: {pending, marked, already, missing, failed}, toPlex: {…} } }], plexUsers, jellyfinUsers, suggestions: [{ plexUserId, jellyfinUserId, account }], run: { running, startedAt, pairId } }",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["pairs", "plexUsers", "jellyfinUsers", "suggestions", "run"],
                  properties: {
                    pairs: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          enabled: { type: "boolean" },
                          direction: { type: "string", enum: ["both", "toJellyfin", "toPlex"] },
                          syncProgress: { type: "boolean" },
                          plex: WATCH_SYNC_SERVER_USER,
                          jellyfin: WATCH_SYNC_SERVER_USER,
                          historyReadTo: { type: "string", format: "date-time", nullable: true, description: "Plex history read down to here; null = the next run reads it all" },
                          jellyfinReadTo: { type: "string", format: "date-time", nullable: true },
                          lastRunAt: { type: "string", format: "date-time", nullable: true },
                          lastResult: { ...WATCH_SYNC_PAIR_RESULT, nullable: true, description: "The pair's result from its last run, as stored (a run before a field existed lacks it)" },
                          counts: {
                            type: "object",
                            description: "Ledger items per status, per direction",
                            properties: { toJellyfin: WATCH_SYNC_MARK_COUNTS, toPlex: WATCH_SYNC_MARK_COUNTS },
                          },
                        },
                      },
                    },
                    plexUsers: { type: "array", items: WATCH_SYNC_SERVER_USER },
                    jellyfinUsers: { type: "array", items: WATCH_SYNC_SERVER_USER },
                    suggestions: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          plexUserId: { type: "string" },
                          jellyfinUserId: { type: "string" },
                          account: { type: "string", description: "The linked account's name, else its email, else the Plex username" },
                        },
                      },
                    },
                    run: {
                      type: "object",
                      description: "A run in progress in this process (cron or Run now)",
                      properties: {
                        running: { type: "boolean" },
                        startedAt: { type: "string", format: "date-time", nullable: true },
                        pairId: { type: "string", nullable: true },
                      },
                    },
                  },
                },
              },
            },
          },
          "403": { description: "Not ADMIN" },
          "404": { description: "The Watch Sync page is disabled" },
        },
      },
      post: {
        tags: ["Admin – Watch sync"],
        summary: "Pair a Plex account with a Jellyfin user (ADMIN)",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["plexUserId", "jellyfinUserId"], properties: {
            plexUserId: { type: "string", maxLength: 64, description: "A MediaServerUser id with source plex, still active" },
            jellyfinUserId: { type: "string", maxLength: 64, description: "A MediaServerUser id with source jellyfin, still active on its server" },
            direction: { type: "string", enum: ["both", "toJellyfin", "toPlex"], description: "Default both" },
            syncProgress: { type: "boolean", description: "Also copy resume positions (in-progress items). Default false" },
          } } } },
        },
        responses: {
          "201": {
            description: "{ id } — the first run reads each side's whole history",
            content: { "application/json": { schema: { type: "object", required: ["id"], properties: { id: { type: "string" } } } } },
          },
          "400": { description: "Not an active Plex account and an active Jellyfin user, an id over 64 characters, an unknown direction, or a non-boolean syncProgress" },
          "403": { description: "Not ADMIN" },
          "404": { description: "The Watch Sync page is disabled" },
          "409": { description: "That pair already exists" },
          "413": { description: "Request body over the 4 KB cap" },
        },
      },
    },
    "/admin/watch-sync/{id}": {
      patch: {
        tags: ["Admin – Watch sync"],
        summary: "Pause/resume a pair, change its direction, or re-read its whole history on both servers on the next run (ADMIN)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", properties: {
            enabled: { type: "boolean" },
            direction: { type: "string", enum: ["both", "toJellyfin", "toPlex"] },
            syncProgress: { type: "boolean", description: "Copy resume positions too" },
            rescan: { type: "boolean", enum: [true], description: "Forget both read points; items already in a ledger are not re-queued" },
          } } } },
        },
        responses: {
          "200": { description: "{ ok: true }", content: { "application/json": { schema: OK_TRUE } } },
          "400": { description: "None of enabled / direction / syncProgress / rescan, or a wrong value" },
          "403": { description: "Not ADMIN" },
          "404": { description: "Pair not found, or the page is disabled" },
        },
      },
      delete: {
        tags: ["Admin – Watch sync"],
        summary: "Remove a pair and its ledgers (ADMIN) — nothing on either server is unmarked",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "{ ok: true }", content: { "application/json": { schema: OK_TRUE } } },
          "403": { description: "Not ADMIN" },
          "404": { description: "Pair not found, or the page is disabled" },
        },
      },
    },
    "/admin/watch-sync/run": {
      post: {
        tags: ["Admin – Watch sync"],
        summary: "Run watch sync now, in the background (ADMIN)",
        description:
          "Always a background job on the cron's advisory lock: 202 { job } at once, poll GET ?job=. The same admin asking again " +
          "while theirs runs joins it. 6 runs per 10 minutes per admin.",
        responses: {
          "202": jobAnswer("{ job }", JOB_STARTED),
          "403": { description: "Not ADMIN" },
          "404": { description: "The Watch Sync page is disabled" },
          "429": { description: "Rate limited (6 per 10 minutes per admin)" },
        },
      },
      get: {
        tags: ["Admin – Watch sync"],
        summary: "Poll a background watch sync run (ADMIN)",
        description: "202 { job, running: true } while it runs, then the run's own answer: 200 { pairs: [{ pairId, toJellyfin, toPlex, progress, error? }], aborted } — progress is { toJellyfin, toPlex, failed, error? } (titles whose resume point was copied) or null when the pair doesn't sync them; each direction { queued, unresolved, unmatched, marked, already, missing, failed, error? } or null when the pair doesn't sync that way — or 409 when the lock was held.",
        parameters: [{ name: "job", in: "query", required: true, schema: { type: "string", pattern: "^[0-9a-f]{32}$" } }],
        responses: {
          "200": { description: "The run's result", content: { "application/json": { schema: WATCH_SYNC_RUN_RESULT } } },
          "202": jobAnswer("Still running", JOB_RUNNING),
          "403": { description: "Not ADMIN" },
          "404": { description: "Job not found (expired, another admin's, or dropped by a restart)" },
          "409": { description: "Another watch sync run held the lock" },
        },
      },
    },
    "/admin/never-watched/refresh": {
      post: {
        tags: ["Admin – Never watched"],
        summary: "Re-read every media server's own watch records now (ADMIN)",
        description:
          "Runs the upstream watch-record snapshot (Plex all-account history, Jellyfin per-user played/resumable items) under the " +
          "same advisory lock as its daily cron. Read-only towards the media servers; never writes play history. A server that " +
          "fails keeps its previous snapshot. 409 while a run is already in progress. No body is the synchronous walk; " +
          "`{ async: true }` answers 202 `{ job }` at once and runs it in the background (a whole Plex history plus every " +
          "Jellyfin user's played items outlasts a reverse proxy's hold) — poll GET `?job=`. The same admin asking again while " +
          "theirs runs joins it (no second walk, no rate token). 3 runs per 10 minutes per admin.",
        requestBody: {
          required: false,
          content: { "application/json": { schema: { type: "object", properties: {
            async: { type: "boolean", description: "Run the walk as a background job: 202 { job }, poll GET ?job=. Default (absent/false): synchronous" },
          } } } },
        },
        responses: {
          "200": {
            description: "Per-server outcome: { servers: [{ source, instance, ok, entries, matched, samples, agreed, error, health }], aborted }",
            content: { "application/json": { schema: UPSTREAM_REFRESH_RESULT } },
          },
          "202": jobAnswer(
            "async: true — the walk runs in the background: { job } (the same admin's running walk is joined, no rate token spent); poll GET ?job=",
            JOB_STARTED,
          ),
          "403": { description: "Not ADMIN" },
          "404": { description: "The Never Watched page is disabled" },
          "409": { description: "A refresh is already running — { ok: false, error, retryAfter: 30 }", headers: { "Retry-After": { schema: { type: "integer" }, description: "Seconds (30)" } } },
          "413": { description: "Request body over the 1 KB cap" },
          "429": { description: "Rate limited (3 per 10 minutes per admin)" },
        },
      },
      get: {
        tags: ["Admin – Never watched"],
        summary: "Poll a background watch-record refresh (ADMIN)",
        description:
          "The poll for a POST `{ async: true }` walk: 202 `{ job, running: true }` while it runs, then the walk's own answer — the same " +
          "status and body the synchronous POST would have given (200 per-server outcome, or 409 when the lock was held). Readable by the " +
          "admin who started it only.",
        parameters: [
          { name: "job", in: "query", required: true, schema: { type: "string", pattern: "^[0-9a-f]{32}$" }, description: "The job id from the POST's 202" },
        ],
        responses: {
          "200": {
            description: "The walk finished: { servers, aborted } — the synchronous POST's 200 body",
            content: { "application/json": { schema: UPSTREAM_REFRESH_RESULT } },
          },
          "202": jobAnswer("Still running: { job, running: true }", JOB_RUNNING),
          "403": { description: "Not ADMIN" },
          "404": { description: "The job is unknown — expired (10 minutes after it finished), another admin's, or dropped by a restart" },
          "409": { description: "The walk found a refresh already running — the synchronous POST's 409 body" },
        },
      },
    },

    "/admin/cleanup/settings": {
      get: {
        tags: ["Admin – Cleanup"],
        summary: "Library cleanup rules in force (ADMIN)",
        responses: {
          "200": { description: "The rules", content: { "application/json": { schema: { type: "object", properties: { settings: { $ref: "#/components/schemas/CleanupSettings" } } } } } },
          "403": { description: "Not ADMIN" },
          "404": { description: "Library cleanup is disabled" },
        },
      },
      patch: {
        tags: ["Admin – Cleanup"],
        summary: "Change library cleanup rules (ADMIN)",
        description: "A partial object keyed by field name. Any unknown field or out-of-range value refuses the whole patch.",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CleanupSettings" } } } },
        responses: {
          "200": { description: "The rules now in force", content: { "application/json": { schema: { type: "object", properties: { settings: { $ref: "#/components/schemas/CleanupSettings" } } } } } },
          "400": { description: "Invalid field or value" },
          "403": { description: "Not ADMIN" },
          "404": { description: "Library cleanup is disabled" },
        },
      },
    },

    "/admin/cleanup/protect": {
      post: {
        tags: ["Admin – Cleanup"],
        summary: "Protect a title from cleanup (ADMIN)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["tmdbId", "mediaType"],
                properties: {
                  tmdbId: { type: "integer" },
                  mediaType: { type: "string", enum: ["MOVIE", "TV"] },
                  title: { type: "string", maxLength: 500 },
                  reason: { type: "string", maxLength: 500 },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Protected (an upsert): { item: { tmdbId, mediaType, title, reason, addedBy, createdAt } }",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["item"],
                  properties: {
                    item: {
                      type: "object",
                      description: "The CleanupProtection row as saved",
                      properties: {
                        tmdbId: { type: "integer" },
                        mediaType: { $ref: "#/components/schemas/MediaType" },
                        title: { type: "string", nullable: true },
                        reason: { type: "string", nullable: true },
                        addedBy: { type: "string", nullable: true, description: "The protecting admin's user id" },
                        createdAt: { type: "string", format: "date-time" },
                      },
                    },
                  },
                },
              },
            },
          },
          "400": { description: "Invalid body" },
          "403": { description: "Not ADMIN" },
          "404": { description: "Library cleanup is disabled" },
        },
      },
      delete: {
        tags: ["Admin – Cleanup"],
        summary: "Remove a title's cleanup protection (ADMIN)",
        parameters: [
          { name: "tmdbId", in: "query", required: true, schema: { type: "integer" } },
          { name: "mediaType", in: "query", required: true, schema: { type: "string", enum: ["MOVIE", "TV"] } },
        ],
        responses: {
          "200": {
            description: "{ ok: true, removed: <count> }",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["ok", "removed"],
                  properties: {
                    ok: { type: "boolean", enum: [true] },
                    removed: { type: "integer", description: "0 when the title was not protected" },
                  },
                },
              },
            },
          },
          "400": { description: "Missing or invalid query" },
          "403": { description: "Not ADMIN" },
          "404": { description: "Library cleanup is disabled" },
        },
      },
    },

    "/admin/cleanup/delete": {
      post: {
        tags: ["Admin – Cleanup"],
        summary: "Delete cleanup candidates from Radarr/Sonarr — dry run, then confirmed execute (ADMIN)",
        description:
          "Default is a DRY RUN: re-judges exactly the given titles against the live rules and returns every " +
          "Radarr/Sonarr entry each occupies (every instance), `targetCount` and `targetsFingerprint` (the exact target " +
          "set). `?execute=true` with the same body plus `confirmTargets` equal to the live count — and, when sent, " +
          "`confirmFingerprint` equal to the live fingerprint — deletes each target with `deleteFiles=true` and the " +
          "import-list exclusion flag; any other count or fingerprint answers 409 with the fresh plan (a same-sized " +
          "different set fails only the fingerprint). A title that is no longer a " +
          "candidate is skipped, never deleted. Before deleting, every AVAILABLE request for the title is stamped so " +
          "the sync never re-pushes it; `blacklist` (default true) also blacklists a fully removed title. Results are " +
          "per title (deleted / partial / failed) — a partial failure is not an error status.",
        parameters: [{ name: "execute", in: "query", schema: { type: "string", enum: ["true"] } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["items"],
                properties: {
                  items: {
                    type: "array",
                    minItems: 1,
                    maxItems: 500,
                    items: { type: "object", required: ["tmdbId", "mediaType"], properties: { tmdbId: { type: "integer" }, mediaType: { type: "string", enum: ["MOVIE", "TV"] } } },
                  },
                  blacklist: { type: "boolean", default: true },
                  confirmTargets: { type: "integer", description: "Required with ?execute=true: the dry run's targetCount" },
                  confirmFingerprint: { type: "string", description: "With ?execute=true: the dry run's targetsFingerprint. Optional, but when sent the execute is refused (409) unless the live target set is exactly the one the dry run planned" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description:
              "Dry run: { dryRun: true, targetCount, targetsFingerprint, reclaimableBytes, blacklist, items, skipped, hint }. Execute: { dryRun: false, " +
              "deletedCount, partialCount, failedCount, results, skipped } — each results[] item is { tmdbId, mediaType, title, status: " +
              "deleted | partial | failed, deleted: [target label], failed: [{ target, service, instance, error, kind }], blacklisted, " +
              "uncertain?, bookkeepingError? }. `uncertain: true` when at least one target's delete had an unknown outcome (a timeout, " +
              "a network failure, a 502/504) — the arr may have taken it, so that title's cleanup stamps are kept and re-asserted " +
              "(except on an instance that definitely refused), even on a `failed` result; a failed re-assert there is reported as " +
              "that result's `bookkeepingError`.",
            content: { "application/json": { schema: { type: "object", properties: {
              dryRun: { type: "boolean" },
              results: { type: "array", description: "Execute only", items: { type: "object", properties: {
                tmdbId: { type: "integer" },
                mediaType: { type: "string", enum: ["MOVIE", "TV"] },
                title: { type: "string" },
                status: { type: "string", enum: ["deleted", "partial", "failed"] },
                deleted: { type: "array", items: { type: "string" } },
                failed: { type: "array", items: { type: "object", properties: {
                  target: { type: "string" },
                  service: { type: "string", enum: ["radarr", "sonarr"] },
                  instance: { type: "string" },
                  error: { type: "string", description: "English detail — translate `kind` instead" },
                  kind: { type: "string", enum: ARR_ERROR_KINDS },
                } } },
                blacklisted: { type: "boolean" },
                uncertain: { type: "boolean", enum: [true], description: "Present only when a target's delete had an unknown outcome (timeout, network, 502/504)" },
                bookkeepingError: { type: "string", description: "Present only when the files went but a request stamp, vote clear or blacklist write failed — or, on a `status: \"failed\"` result with `uncertain: true`, when re-asserting the title's cleanup stamps failed — or, on a `status: \"failed\"` result with nothing deleted, when the pre-delete cleanup stamp could not be written (that title was not deleted) or the un-stamp after every delete was refused failed. Several failures are joined with \"; \"" },
              } } },
            } } } },
          },
          "400": { description: "Invalid body" },
          "403": { description: "Not ADMIN" },
          "404": { description: "Library cleanup is disabled" },
          "409": { description: "confirmTargets missing or not equal to the live count, or confirmFingerprint sent and not equal to the live target set (the fresh plan, with its targetCount and targetsFingerprint, is returned)" },
        },
      },
    },

    "/admin/missing": {
      get: {
        tags: ["Admin – Missing"],
        summary: "What Radarr or Sonarr should already have but doesn't (ADMIN)",
        description:
          "One live listing per configured instance of the requested service. `radarr`: movies with no file whose " +
          "physical OR digital release date has passed (a cinema-only or undated movie is never listed). `sonarr`: " +
          "series with at least one aired, monitored, regular-season episode that has no file — Sonarr's own per-season " +
          "statistics, specials excluded, the same completion rule the sync uses. `monitored` is reported, not filtered " +
          "on. An instance whose listing failed is named in `errors` and contributes no items. Nothing is written; the last " +
          "answer is kept for display only (`cached=1`).",
        parameters: [
          ARR_SNAPSHOT_PARAM,
          { name: "service", in: "query", required: true, schema: { type: "string", enum: ["radarr", "sonarr"] } },
          {
            name: "mode",
            in: "query",
            schema: { type: "string", enum: ["missing", "cutoff"], default: "missing" },
            description:
              "`cutoff` lists instead what HAS a file below the quality profile's cutoff — Radarr/Sonarr's own " +
              "/api/v3/wanted/cutoff, monitored titles only, judged by the arr's `qualityCutoffNotMet`. Cutoff items carry " +
              "`quality` (radarr: the file's), `profile`, `cutoff` and, for sonarr, `episodes` (seasonNumber, episodeNumber, title, quality) " +
              "in place of the missing-mode counts.",
          },
        ],
        responses: {
          "204": ARR_SNAPSHOT_204,
          "200": {
            description: "The report. `items` are movies for radarr, series for sonarr.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    service: { type: "string", enum: ["radarr", "sonarr"] },
                    enabled: { type: "boolean", description: "feature.integration.<service>; false ⇒ no instance was read" },
                    instances: { type: "array", items: { type: "object", properties: { slug: { type: "string" }, name: { type: "string" } } } },
                    errors: { type: "array", items: { type: "object", properties: { instance: { type: "string" }, error: { type: "string" }, kind: { type: "string", enum: ARR_ERROR_KINDS, description: "Why the listing failed — translate this, not the English `error`" } } } },
                    truncated: {
                      type: "array",
                      description: "mode=cutoff only, present only when non-empty: instances whose /wanted/cutoff listing ran past the 20,000-record read ceiling, so the list is incomplete",
                      items: { type: "object", properties: { instance: { type: "string" }, read: { type: "integer" }, total: { type: "integer" } } },
                    },
                    items: {
                      type: "array",
                      items: {
                        oneOf: [
                          {
                            type: "object",
                            description: "Radarr movie",
                            properties: {
                              instance: { type: "string" },
                              arrId: { type: "integer" },
                              tmdbId: { type: "integer", nullable: true },
                              title: { type: "string" },
                              year: { type: "integer", nullable: true },
                              monitored: { type: "boolean" },
                              posterPath: { type: "string", nullable: true },
                              inCinemas: { type: "string", format: "date-time", nullable: true },
                              physicalRelease: { type: "string", format: "date-time", nullable: true },
                              digitalRelease: { type: "string", format: "date-time", nullable: true },
                              releasedAt: { type: "string", format: "date-time", description: "The earlier past home release" },
                              daysMissing: { type: "integer" },
                            },
                          },
                          {
                            type: "object",
                            description: "Sonarr series",
                            properties: {
                              instance: { type: "string" },
                              arrId: { type: "integer" },
                              tmdbId: { type: "integer", nullable: true },
                              tvdbId: { type: "integer", nullable: true },
                              title: { type: "string" },
                              year: { type: "integer", nullable: true },
                              monitored: { type: "boolean" },
                              status: { type: "string", nullable: true },
                              posterPath: { type: "string", nullable: true },
                              missing: { type: "integer" },
                              aired: { type: "integer" },
                              lastAired: { type: "string", format: "date-time", nullable: true },
                              seasons: {
                                type: "array",
                                items: {
                                  type: "object",
                                  properties: {
                                    seasonNumber: { type: "integer" },
                                    missing: { type: "integer" },
                                    aired: { type: "integer" },
                                    lastAired: { type: "string", format: "date-time", nullable: true },
                                  },
                                },
                              },
                            },
                          },
                          {
                            type: "object",
                            description: "Radarr movie, mode=cutoff",
                            properties: {
                              instance: { type: "string" },
                              arrId: { type: "integer" },
                              tmdbId: { type: "integer", nullable: true },
                              title: { type: "string" },
                              year: { type: "integer", nullable: true },
                              posterPath: { type: "string", nullable: true },
                              quality: { type: "string", nullable: true, description: "The quality of the file on disk" },
                              profile: { type: "string", nullable: true, description: "The movie's quality profile" },
                              cutoff: { type: "string", nullable: true, description: "That profile's cutoff (a quality or a quality group)" },
                            },
                          },
                          {
                            type: "object",
                            description: "Sonarr series, mode=cutoff",
                            properties: {
                              instance: { type: "string" },
                              arrId: { type: "integer" },
                              tmdbId: { type: "integer", nullable: true },
                              tvdbId: { type: "integer", nullable: true },
                              title: { type: "string" },
                              year: { type: "integer", nullable: true },
                              posterPath: { type: "string", nullable: true },
                              profile: { type: "string", nullable: true },
                              cutoff: { type: "string", nullable: true },
                              episodes: {
                                type: "array",
                                description: "Monitored episodes whose file is below cutoff, in order",
                                items: {
                                  type: "object",
                                  properties: {
                                    seasonNumber: { type: "integer" },
                                    episodeNumber: { type: "integer" },
                                    title: { type: "string" },
                                    quality: { type: "string", nullable: true },
                                  },
                                },
                              },
                            },
                          },
                        ],
                      },
                    },
                  },
                },
              },
            },
          },
          "400": { description: "service is not radarr or sonarr, or mode is not missing or cutoff" },
          "403": { description: "Not ADMIN" },
        },
      },
    },

    "/admin/missing/episodes": {
      get: {
        tags: ["Admin – Missing"],
        summary: "One series' missing episodes (ADMIN)",
        description:
          "Sonarr's aired, monitored, regular-season episodes of one series that have no file, oldest first. " +
          "`instance` is a Sonarr instance slug (absent or empty = the default) and must name a configured instance; " +
          "`seriesId` is Sonarr's own id from the /admin/missing report.",
        parameters: [
          ARR_SNAPSHOT_PARAM,
          { name: "seriesId", in: "query", required: true, schema: { type: "integer", minimum: 1 } },
          { name: "instance", in: "query", schema: { type: "string" } },
        ],
        responses: {
          "204": ARR_SNAPSHOT_204,
          "200": {
            description: "The episodes",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    episodes: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          seasonNumber: { type: "integer" },
                          episodeNumber: { type: "integer" },
                          title: { type: "string" },
                          airDateUtc: { type: "string", format: "date-time" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          "400": { description: "seriesId is not a positive integer" },
          "403": { description: "Not ADMIN" },
          "404": { description: "Sonarr integration disabled, unknown instance, or no such series" },
          "502": { description: "Sonarr could not be read" },
        },
      },
    },

    "/admin/missing/search": {
      post: {
        tags: ["Admin – Missing"],
        summary: "Search Radarr/Sonarr for one missing title (ADMIN)",
        description:
          "Re-judges the title live with the report's rules, then queues a search on that instance for exactly what is " +
          "missing: Radarr `MoviesSearch` for the movie; for a series, Sonarr `SeasonSearch` per season with two or more " +
          "missing episodes and no file at all, plus one `EpisodeSearch` for every other missing episode — never " +
          "`SeriesSearch`, which would also hunt upgrades. Returns once the commands are queued; Radarr/Sonarr run them " +
          "in the background. Nothing in Summonarr is written. Rate limited to 120 searches a minute per admin (one capped " +
          "bulk \"Search selected\" run fits in a window): past it, 429 with a Retry-After header — wait that many seconds " +
          "and retry. A malformed body is refused first and spends none of the budget.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["service", "arrId"],
                properties: {
                  service: { type: "string", enum: ["radarr", "sonarr"] },
                  instance: { type: "string", description: "Instance slug; absent or empty = the default" },
                  arrId: { type: "integer", minimum: 1, description: "Radarr movie id / Sonarr series id from the report" },
                  mode: {
                    type: "string",
                    enum: ["missing", "cutoff"],
                    default: "missing",
                    description:
                      "`cutoff`: an UPGRADE search for exactly what Radarr/Sonarr say is below cutoff right now — Radarr " +
                      "`MoviesSearch`; Sonarr one `EpisodeSearch` for the monitored episodes whose file has `qualityCutoffNotMet`. " +
                      "409 when nothing is below cutoff any more.",
                  },
                },
              },
            },
          },
        },
        responses: {
          "202": {
            description: "Search queued",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    commands: { type: "integer" },
                    seasons: { type: "array", items: { type: "integer" }, description: "Sonarr: seasons searched whole" },
                    episodes: { type: "integer", description: "Sonarr: episodes searched individually" },
                    partial: { type: "boolean", enum: [true], description: "Present only when a Sonarr search was refused part-way: the counts are what WAS queued, and those searches are running" },
                  },
                },
              },
            },
          },
          "400": { description: "Invalid body" },
          "403": { description: "Not ADMIN" },
          "404": { description: "Integration disabled, unknown instance, or no such movie/series" },
          "409": { description: "Nothing is missing (or, in cutoff mode, below cutoff) for this title any more. The nothing-missing answer carries an additive `nothingMissing: true` beside `error`." },
          "429": {
            description: "Too many searches — 120 per minute per admin; honour the Retry-After header (seconds)",
            headers: { "Retry-After": { description: "Seconds to wait before retrying", schema: { type: "integer", minimum: 1 } } },
          },
          "502": { description: "The search could not be queued" },
        },
      },
    },

    "/admin/queue": {
      get: {
        tags: ["Admin – Downloads"],
        summary: "Every Radarr/Sonarr download queue, one row per download (ADMIN)",
        description:
          "A live, paged /api/v3/queue read per configured Radarr and Sonarr instance (integrations switched off are " +
          "not read). Sonarr's per-episode records for one download fold into one row carrying every record id. Rows " +
          "Radarr/Sonarr flag (warning/error tracked status, blocked or failed import, failed or unreachable client) " +
          "have `attention: true` and sort first. `requesters` names the users with a non-declined request for the title " +
          "on that instance. An instance whose queue could not be read is named in `errors`; its downloads are absent, " +
          "not finished. Nothing is written; the last answer is kept for display only (`cached=1`).",
        parameters: [ARR_SNAPSHOT_PARAM],
        responses: {
          "204": ARR_SNAPSHOT_204,
          "200": {
            description: "The queues",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    instances: { type: "array", items: { type: "object", properties: { service: { type: "string", enum: ["radarr", "sonarr"] }, slug: { type: "string" }, name: { type: "string" } } } },
                    errors: { type: "array", items: { type: "object", properties: { service: { type: "string" }, instance: { type: "string" }, error: { type: "string" }, kind: { type: "string", enum: ARR_ERROR_KINDS, description: "Why the read failed — translate this, not the English `error`" } } } },
                    truncated: {
                      type: "array",
                      description: "Present only when an instance's queue was longer than the page cap: `read` records of `total` were read, so the rest are absent, not finished",
                      items: { type: "object", properties: { service: { type: "string", enum: ["radarr", "sonarr"] }, instance: { type: "string" }, read: { type: "integer" }, total: { type: "integer" } } },
                    },
                    items: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          service: { type: "string", enum: ["radarr", "sonarr"] },
                          instance: { type: "string" },
                          ids: { type: "array", items: { type: "integer" }, description: "Every queue record id of the download" },
                          downloadId: { type: "string", nullable: true },
                          title: { type: "string", description: "Release name" },
                          mediaTitle: { type: "string" },
                          year: { type: "integer", nullable: true },
                          tmdbId: { type: "integer", nullable: true },
                          tvdbId: { type: "integer", nullable: true },
                          arrMediaId: { type: "integer", nullable: true, description: "Radarr movie id / Sonarr series id" },
                          episodes: { type: "array", items: { type: "object", properties: { seasonNumber: { type: "integer" }, episodeNumber: { type: "integer" } } } },
                          quality: { type: "string", nullable: true },
                          qualityTags: { type: "array", items: { type: "string", enum: ["proper", "repack", "real"] }, description: "The release revision as the arr tags it beside the quality" },
                          languages: { type: "array", items: { type: "string" } },
                          customFormats: { type: "array", items: { type: "string" }, description: "Custom formats the release matched" },
                          customFormatScore: { type: "integer", nullable: true },
                          size: { type: "number" },
                          sizeLeft: { type: "number" },
                          progress: { type: "number", minimum: 0, maximum: 1 },
                          timeLeftSeconds: { type: "integer", nullable: true },
                          estimatedCompletion: { type: "string", format: "date-time", nullable: true },
                          added: { type: "string", format: "date-time", nullable: true },
                          phase: QUEUE_PHASE,
                          trackedStatus: { type: "string", enum: ["ok", "warning", "error"], nullable: true },
                          messages: { type: "array", items: { type: "string" } },
                          protocol: { type: "string", enum: ["torrent", "usenet", "unknown"] },
                          downloadClient: { type: "string", nullable: true },
                          indexer: { type: "string", nullable: true },
                          outputPath: { type: "string", nullable: true, description: "Where the download client put the files, as the arr sees the path" },
                          attention: { type: "boolean" },
                          pending: { type: "boolean", description: "Held by Radarr/Sonarr (delay profile, client unavailable, fallback) — Grab now applies; not yet in a download client" },
                          canChangeCategory: { type: "boolean", description: "The download client has a post-import category, so the `changeCategory` removal method is available" },
                          requesters: { type: "array", items: { type: "string" } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          "403": { description: "Not ADMIN" },
        },
      },
    },

    "/admin/queue/remove": {
      post: {
        tags: ["Admin – Downloads"],
        summary: "Remove a download from a Radarr/Sonarr queue (ADMIN)",
        description:
          "One bulk `DELETE /api/v3/queue/bulk` on that instance carrying the given record ids (the page sends one per download — any record of a Sonarr pack resolves the whole download, and Sonarr v3 blocklists once per id sent), with every flag " +
          "explicit (the arr defaults removeFromClient to true). `remove`: off the queue, no blocklist. `blocklist`: remove " +
          "and blocklist the release, no new search. `blocklistSearch`: remove, blocklist, and let Radarr/Sonarr search for a " +
          "replacement (their own \"redownload failed\" behaviour, which honours that arr setting). `method` is the arr " +
          "dialog's removal method: `removeFromClient` deletes the download (and its files) from the client, `changeCategory` " +
          "leaves it in the client under its post-import category (only when the client has one — the row's " +
          "`canChangeCategory`), `ignore` leaves it in the client untouched while the arr stops tracking it. With no `method`, " +
          "the older `removeFromClient` boolean is read (true/absent → removeFromClient, false → ignore). Audited " +
          "ARR_QUEUE_REMOVE after the arr accepted it.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["service", "ids", "action"],
                properties: {
                  service: { type: "string", enum: ["radarr", "sonarr"] },
                  instance: { type: "string", nullable: true, description: "Instance slug; absent, null or empty = the default" },
                  ids: { type: "array", items: { type: "integer", minimum: 1 }, minItems: 1, maxItems: 5000 },
                  action: { type: "string", enum: ["remove", "blocklist", "blocklistSearch"] },
                  method: { type: "string", enum: ["removeFromClient", "changeCategory", "ignore"], default: "removeFromClient" },
                  removeFromClient: { type: "boolean", deprecated: true, description: "Read only when `method` is absent" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Removed ({ ok: true })", content: { "application/json": { schema: OK_TRUE } } },
          "400": { description: "Invalid body" },
          "403": { description: "Not ADMIN" },
          "404": { description: "Integration disabled or unknown instance" },
          "409": { description: "The download is no longer in the queue" },
          "502": { description: "The arr could not be reached" },
        },
      },
    },

    "/admin/queue/import": {
      get: {
        tags: ["Admin – Downloads"],
        summary: "The files of a download Radarr/Sonarr would not import on their own (ADMIN)",
        description:
          "Radarr/Sonarr's `/api/v3/manualimport?downloadId=` for one queue download: each file's path, what the arr matched " +
          "it to (movie, or series + episodes), quality, languages, release group, and the reasons it refused to import it. " +
          "`importable` is false for a file the arr could not match to a title — correct it (POST with `movieId` / `seriesId` + " +
          "`episodeIds`) first. Also returns the instance's own qualities (in its weight order) and languages for the " +
          "per-file editor; those two are empty when the arr would not list them.",
        parameters: [
          { name: "service", in: "query", required: true, schema: { type: "string", enum: ["radarr", "sonarr"] } },
          { name: "instance", in: "query", schema: { type: "string" }, description: "Instance slug; empty = the default" },
          { name: "downloadId", in: "query", required: true, schema: { type: "string", maxLength: 200 } },
        ],
        responses: {
          "200": {
            description: "The files",
            content: { "application/json": { schema: { type: "object", properties: { files: { type: "array", items: QUEUE_IMPORT_CANDIDATE },
              qualities: { type: "array", items: { type: "object", properties: { id: { type: "integer" }, name: { type: "string" } } } },
              languages: { type: "array", items: { type: "object", properties: { id: { type: "integer" }, name: { type: "string" } } } },
            } } } },
          },
          "400": { description: "Invalid parameters" },
          "403": { description: "Not ADMIN" },
          "404": { description: "Integration disabled or unknown instance" },
          "409": { description: "The download is no longer in the queue" },
          "502": { description: "The arr could not be reached" },
        },
      },
      post: {
        tags: ["Admin – Downloads"],
        summary: "Import a download Radarr/Sonarr refused (ADMIN)",
        description:
          "Queues the arr's `ManualImport` command for the chosen files, overriding its refusal. The file list is RE-READ " +
          "from the arr and only its own rows whose path is chosen are sent — a path selects, it is never passed upstream " +
          "itself. Each file may carry corrections, the arr's own Manual Import fields: `movieId` (Radarr), `seriesId` + " +
          "`episodeIds` (Sonarr; `episodeIds` alone keeps the matched series), `qualityId`, `languageIds`, `releaseGroup`, " +
          "`releaseType` (Sonarr). They are IDS: every movie, series, episode, quality and language object in the command is " +
          "read from the instance itself, and an id it doesn't have is 400 with nothing sent. The older `paths: string[]` " +
          "body (no corrections) still works. 409 when none of the chosen files is importable. Audited ARR_QUEUE_IMPORT " +
          "(count, mode and how many were corrected — no paths). Returns once the command is queued.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["service", "downloadId"],
                properties: {
                  service: { type: "string", enum: ["radarr", "sonarr"] },
                  instance: { type: "string" },
                  downloadId: { type: "string", maxLength: 200 },
                  files: { type: "array", minItems: 1, maxItems: 2000, items: { $ref: "#/components/schemas/QueueImportFile" } },
                  paths: { type: "array", deprecated: true, items: { type: "string", maxLength: 4096 }, minItems: 1, maxItems: 2000, description: "Read only when `files` is absent" },
                  importMode: { type: "string", enum: ["auto", "move", "copy"], default: "auto" },
                },
              },
            },
          },
        },
        responses: {
          "202": { description: "Import queued", content: { "application/json": { schema: { type: "object", properties: { files: { type: "integer" } } } } } },
          "400": { description: "Invalid body, a correction names something the instance doesn't have, or more than 20 titles are re-matched at once" },
          "403": { description: "Not ADMIN" },
          "404": { description: "Integration disabled or unknown instance" },
          "409": { description: "Nothing chosen is importable any more, or the download is gone" },
          "502": { description: "The arr could not be reached or refused the command" },
        },
      },
    },

    "/admin/queue/import/preview": {
      post: {
        tags: ["Admin – Downloads"],
        summary: "Re-check a file's import corrections with Radarr/Sonarr (ADMIN)",
        description:
          "The chosen files with their corrections applied (each checked against the instance's own catalogs, as for the " +
          "import itself) and RE-JUDGED by the arr's manual-import reprocess (`POST /api/v3/manualimport`): fresh refusal " +
          "reasons and, for Sonarr, the episodes it resolves. `rechecked` is false when the arr could not reprocess (an older " +
          "version without the endpoint, or a file with no title to look up) — the corrections still show, with the arr's " +
          "earlier verdict. Imports nothing and writes nothing.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["service", "downloadId", "files"],
                properties: {
                  service: { type: "string", enum: ["radarr", "sonarr"] },
                  instance: { type: "string" },
                  downloadId: { type: "string", maxLength: 200 },
                  files: { type: "array", minItems: 1, maxItems: 2000, items: { $ref: "#/components/schemas/QueueImportFile" } },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "The corrected files, as the import dialog lists them",
            content: { "application/json": { schema: { type: "object", properties: {
              files: { type: "array", items: { ...QUEUE_IMPORT_CANDIDATE, description: "Same shape as GET /admin/queue/import's files" } },
              rechecked: { type: "boolean" },
            } } } },
          },
          "400": { description: "Invalid body, a correction names something the instance doesn't have, or more than 20 titles are re-matched at once" },
          "403": { description: "Not ADMIN" },
          "404": { description: "Integration disabled or unknown instance" },
          "409": { description: "The download is no longer in the queue" },
          "429": { description: "More than 30 previews a minute by this admin (each is a manual-import reprocess on the arr; Retry-After set)" },
          "502": { description: "The arr could not be reached" },
        },
      },
    },

    "/admin/queue/import/targets": {
      get: {
        tags: ["Admin – Downloads"],
        summary: "Titles a queued file can be re-matched to (ADMIN)",
        description:
          "The arr's own lookup (`/api/v3/movie/lookup` or `/api/v3/series/lookup`) for `term`, keeping only titles the " +
          "instance already has — a manual import needs the movie/series in the arr. At most 25.",
        parameters: [
          { name: "service", in: "query", required: true, schema: { type: "string", enum: ["radarr", "sonarr"] } },
          { name: "instance", in: "query", schema: { type: "string" } },
          { name: "term", in: "query", required: true, schema: { type: "string", minLength: 1, maxLength: 100 } },
        ],
        responses: {
          "200": {
            description: "Matching library titles",
            content: { "application/json": { schema: { type: "object", properties: { results: { type: "array", items: { type: "object", properties: {
              id: { type: "integer", description: "Radarr movie id / Sonarr series id" },
              title: { type: "string" },
              year: { type: "integer", nullable: true },
            } } } } } } },
          },
          "400": { description: "Invalid parameters" },
          "403": { description: "Not ADMIN" },
          "404": { description: "Integration disabled or unknown instance" },
          "502": { description: "The arr could not be reached" },
        },
      },
    },

    "/admin/queue/import/episodes": {
      get: {
        tags: ["Admin – Downloads"],
        summary: "A Sonarr series' episodes, for re-matching a queued file (ADMIN)",
        parameters: [
          { name: "instance", in: "query", schema: { type: "string" }, description: "Sonarr instance slug; empty = the default" },
          { name: "seriesId", in: "query", required: true, schema: { type: "integer", minimum: 1 }, description: "Sonarr's own series id" },
        ],
        responses: {
          "200": {
            description: "Episodes in season/episode order",
            content: { "application/json": { schema: { type: "object", properties: { episodes: { type: "array", items: { type: "object", properties: {
              id: { type: "integer" },
              seasonNumber: { type: "integer" },
              episodeNumber: { type: "integer" },
              title: { type: "string" },
              hasFile: { type: "boolean" },
            } } } } } } },
          },
          "400": { description: "Invalid series id" },
          "403": { description: "Not ADMIN" },
          "404": { description: "Sonarr disabled, unknown instance, or the series is not in Sonarr" },
          "502": { description: "Sonarr could not be reached" },
        },
      },
    },

    "/admin/queue/grab": {
      post: {
        tags: ["Admin – Downloads"],
        summary: "Grab a release Radarr/Sonarr are holding (ADMIN)",
        description:
          "Sends a PENDING queue item (held by a delay profile, an unavailable download client, or a fallback) to the " +
          "download client now — the arr's own `POST /api/v3/queue/grab/bulk`, one call for every id. 409 when it is no " +
          "longer pending. Audited ARR_RELEASE_GRAB (`source: \"queue\"`) after the arr accepted it.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["service", "ids"],
                properties: {
                  service: { type: "string", enum: ["radarr", "sonarr"] },
                  instance: { type: "string" },
                  ids: { type: "array", items: { type: "integer", minimum: 1 }, minItems: 1, maxItems: 500 },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Sent to the download client ({ ok: true })", content: { "application/json": { schema: OK_TRUE } } },
          "400": { description: "Invalid body" },
          "403": { description: "Not ADMIN" },
          "404": { description: "Integration disabled or unknown instance" },
          "409": { description: "The release is no longer pending" },
          "502": { description: "The arr could not be reached" },
        },
      },
    },

    "/admin/queue/recheck": {
      post: {
        tags: ["Admin – Downloads"],
        summary: "Ask every Radarr/Sonarr to re-check its downloads now (ADMIN)",
        description:
          "Queues `RefreshMonitoredDownloads` (what the arr runs every minute on its own) on every configured, enabled " +
          "instance — how to retry a blocked import after fixing its cause without waiting. Not awaited; an instance that " +
          "refused is named in `errors`. No body. Not audited (it changes nothing the arr wasn't about to do); 6 per minute per admin.",
        responses: {
          "202": {
            description: "Queued",
            content: { "application/json": { schema: { type: "object", properties: {
              instances: { type: "integer" },
              errors: { type: "array", items: { type: "object", properties: { service: { type: "string" }, instance: { type: "string" }, error: { type: "string" }, kind: { type: "string", enum: ARR_ERROR_KINDS, description: "Why the read failed — translate this, not the English `error`" } } } },
            } } } },
          },
          "403": { description: "Not ADMIN" },
          "429": { description: "Too many re-checks" },
        },
      },
    },

    "/admin/arr-health": {
      get: {
        tags: ["Admin – Downloads"],
        summary: "Radarr/Sonarr health and the Summonarr webhook verdict, per instance (ADMIN)",
        description:
          "For every configured instance: its version (/api/v3/system/status), Radarr/Sonarr's own non-ok health checks " +
          "(/api/v3/health, errors first, wiki links https only), and whether its Connect list holds a Summonarr webhook " +
          "(`ok`: enabled for every event Summonarr handles and carrying the token Summonarr accepts; `missing`; " +
          "`tokenMismatch`; `eventsMissing`; `unknown` when the list could not be read). The token is never returned. " +
          "`webhookBase` is the address the setup form pre-fills (AUTH_URL + BASE_PATH).",
        parameters: [ARR_SNAPSHOT_PARAM],
        responses: {
          "204": ARR_SNAPSHOT_204,
          "200": {
            description: "The report",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    webhookBase: { type: "string", nullable: true },
                    instances: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          service: { type: "string", enum: ["radarr", "sonarr"] },
                          slug: { type: "string" },
                          name: { type: "string" },
                          reachable: { type: "boolean" },
                          error: { type: "string", nullable: true },
                          errorKind: { type: "string", nullable: true, enum: ARR_ERROR_KINDS, description: "Why the instance could not be read — translate this, not the English `error`" },
                          version: { type: "string", nullable: true },
                          checks: { type: "array", items: { type: "object", properties: { source: { type: "string" }, level: { type: "string", enum: ["notice", "warning", "error"] }, message: { type: "string" }, wikiUrl: { type: "string", nullable: true } } } },
                          webhook: { type: "object", properties: { state: { type: "string", enum: ["ok", "missing", "tokenMismatch", "eventsMissing", "unknown"] }, missingEvents: { type: "array", items: { type: "string" } } } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          "403": { description: "Not ADMIN" },
        },
      },
    },

    "/admin/arr-health/webhook": {
      post: {
        tags: ["Admin – Downloads"],
        summary: "Create or repair Summonarr's webhook in a Radarr/Sonarr instance (ADMIN)",
        description:
          "Writes a Webhook Connect entry pointing at /api/webhooks/<service>?token=<the instance's secret>, built from the " +
          "instance's own /api/v3/notification/schema, with Summonarr's events switched on (Download, Upgrade, the delete " +
          "events, Health issue/restored, Manual interaction required). An existing entry pointing at the endpoint is " +
          "updated in place, keeping its other settings; one already correct is left alone. An instance with no webhook " +
          "secret gets one generated. Radarr/Sonarr test the URL before saving, so 422 carries their reason (`detail`, the " +
          "token masked). Audited SETTINGS_CHANGE with the base address, never the token.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["service"],
                properties: {
                  service: { type: "string", enum: ["radarr", "sonarr"] },
                  instance: { type: "string", description: "Instance slug; absent or empty = the default" },
                  baseUrl: { type: "string", description: "Summonarr's address as the arr reaches it; default AUTH_URL + BASE_PATH" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Done",
            content: { "application/json": { schema: { type: "object", properties: { outcome: { type: "string", enum: ["created", "updated", "unchanged"] }, secretGenerated: { type: "boolean" } } } } },
          },
          "400": { description: "Invalid body or base address" },
          "403": { description: "Not ADMIN" },
          "404": { description: "Integration disabled or unknown instance" },
          "422": { description: "The arr refused the entry (`detail` is its reason)" },
          "429": { description: "More than 10 setups a minute by this admin (each makes the arr test-POST Summonarr; Retry-After set)" },
          "502": { description: "The arr could not be reached, or offered no recognizable Webhook template" },
        },
      },
    },

    "/admin/arr/open": {
      get: {
        tags: ["Admin – Downloads"],
        summary: "Redirect to a title in a Radarr/Sonarr instance's web UI (ADMIN)",
        description:
          "Resolves the title on that instance on click and answers 302: a library title opens its movie/series page, one " +
          "the instance doesn't have opens Add New for the TMDB id. The host is the instance's External URL setting, else " +
          "its connection URL — admin-configured, never taken from the request. When the arr can't be read the redirect " +
          "lands on the instance's home page.",
        parameters: [
          { name: "service", in: "query", required: true, schema: { type: "string", enum: ["radarr", "sonarr"] } },
          { name: "instance", in: "query", schema: { type: "string" }, description: "Instance slug; empty = the default" },
          { name: "tmdbId", in: "query", schema: { type: "integer", minimum: 1 }, description: "Exactly one of tmdbId or arrId" },
          { name: "arrId", in: "query", schema: { type: "integer", minimum: 1 }, description: "Radarr movie id / Sonarr series id" },
        ],
        responses: {
          "302": { description: "To the arr's web UI" },
          "400": { description: "Invalid parameters" },
          "403": { description: "Not ADMIN" },
          "404": { description: "Unknown instance, or no usable address" },
        },
      },
    },

    "/admin/arr/title": {
      get: {
        tags: ["Admin – Arr"],
        summary: "One movie or series on a Radarr/Sonarr instance, with the instance's choices (ADMIN)",
        description:
          "The admin title manager's read. Exactly one of `id` (the arr's own movie/series id) or `tmdbId` (resolved on the " +
          "instance: Radarr filters by tmdbId; Sonarr through TMDB's TVDB cross-reference, then its own lookup). Returns the " +
          "title's settings (monitored, quality profile, root folder, path, tags, Radarr minimum availability and release " +
          "dates, Sonarr series type / season folders / monitorNewItems and every season with its counts — specials included, " +
          "but excluded from the series totals) and the instance's own quality profiles, root folders and tags. Read live; the " +
          "last answer is kept for display only (`cached=1`).",
        parameters: [
          ARR_SNAPSHOT_PARAM,
          { name: "service", in: "query", required: true, schema: { type: "string", enum: ["radarr", "sonarr"] } },
          { name: "instance", in: "query", schema: { type: "string" }, description: "Instance slug; empty = the default" },
          { name: "id", in: "query", schema: { type: "integer", minimum: 1 }, description: "Radarr movie id / Sonarr series id" },
          { name: "tmdbId", in: "query", schema: { type: "integer", minimum: 1 } },
        ],
        responses: {
          "204": ARR_SNAPSHOT_204,
          ...ARR_ERRORS,
          "200": {
            description: "The title",
            content: { "application/json": { schema: { type: "object", properties: {
              title: { ...ARR_TITLE, description: "ArrTitle — see src/lib/arr-title.ts" },
              qualityProfiles: { type: "array", nullable: true, description: "null when the instance failed to answer that list (the form disables the field)", items: { type: "object", properties: { id: { type: "integer" }, name: { type: "string" } } } },
              rootFolders: { type: "array", nullable: true, description: "null when the instance failed to answer that list (the form disables the field)", items: { type: "object", properties: { path: { type: "string" }, freeSpace: { type: "number", nullable: true }, accessible: { type: "boolean" } } } },
              tags: { type: "array", nullable: true, description: "null when the instance failed to answer that list (the form disables the field)", items: { type: "object", properties: { id: { type: "integer" }, name: { type: "string" } } } },
            } } } },
          },
          "400": { description: "Invalid parameters — not exactly one of `id` and `tmdbId`" },
          "403": { description: "Not ADMIN" },
          "404": { description: "Integration disabled, unknown instance, or the instance doesn't have the title" },
        },
      },
      patch: {
        tags: ["Admin – Arr"],
        summary: "Change a movie's or series' settings in Radarr/Sonarr (ADMIN)",
        description:
          "Any of: `monitored`, `qualityProfileId`, `rootFolderPath` (+ `moveFiles`: move the files too), `tags` (replaces), " +
          "Radarr `minimumAvailability` (announced/inCinemas/released), Sonarr `seriesType` (standard/daily/anime), " +
          "`seasonFolder`, `monitorNewItems` (all/none) — or, on its own, Sonarr `seasons` [{seasonNumber, monitored}]. " +
          "`seasons` is its own write: sent with any other field it is 400 with nothing written. A field for the other " +
          "service (to Radarr: seriesType/seasonFolder/monitorNewItems/seasons; to Sonarr: minimumAvailability) is 400. " +
          "Every value must be one the " +
          "instance offers — its own profiles, root folders, tags and the series' seasons — else 400 with nothing written. " +
          "Settings go through the arr's editor endpoint (only the sent fields change); season monitoring is a read-modify-write " +
          "of the series (Sonarr sets the season's episodes to match). Audited ARR_TITLE_EDIT after the arr accepted it.",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["service", "id"], properties: {
          service: { type: "string", enum: ["radarr", "sonarr"] },
          instance: { type: "string" },
          id: { type: "integer", minimum: 1 },
          monitored: { type: "boolean" },
          qualityProfileId: { type: "integer", minimum: 1 },
          rootFolderPath: { type: "string" },
          moveFiles: { type: "boolean" },
          tags: { type: "array", items: { type: "integer", minimum: 1 } },
          minimumAvailability: { type: "string", enum: ["announced", "inCinemas", "released"], description: "Radarr only" },
          seriesType: { type: "string", enum: ["standard", "daily", "anime"], description: "Sonarr only" },
          seasonFolder: { type: "boolean", description: "Sonarr only" },
          monitorNewItems: { type: "string", enum: ["all", "none"], description: "Sonarr only" },
          seasons: {
            type: "array",
            minItems: 1,
            description: "Sonarr only, and must be sent alone (with service/instance/id) — combined with any other field it is 400. Each season number at most once.",
            items: { type: "object", required: ["seasonNumber", "monitored"], properties: { seasonNumber: { type: "integer", minimum: 0 }, monitored: { type: "boolean" } } },
          },
        } } } } },
        responses: {
          ...ARR_ERRORS,
          "200": {
            description: "{ title } as the arr now has it — null when the re-read after the write failed (the write landed; read the title again)",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["title"],
                  properties: { title: { ...ARR_TITLE, nullable: true, description: "null when the re-read after the write failed" } },
                },
              },
            },
          },
          "400": { description: "Malformed or empty edit, `seasons` combined with other fields, a field the other service has, a value the instance doesn't offer, or the arr's own refusal (masked)" },
          "403": { description: "Not ADMIN" },
          "404": { description: "Integration disabled, unknown instance, or no such title" },
        },
      },
    },

    "/admin/arr/title/add": {
      get: {
        tags: ["Admin – Arr"],
        summary: "Choices for adding a title to one Radarr/Sonarr instance by hand (ADMIN)",
        description:
          "The instance's own quality profiles, root folders and tags, its configured add defaults to preselect, the arr's " +
          "lookup of the title, and `presentArrId` when the instance already has it.",
        parameters: [
          { name: "service", in: "query", required: true, schema: { type: "string", enum: ["radarr", "sonarr"] } },
          { name: "instance", in: "query", schema: { type: "string" } },
          { name: "tmdbId", in: "query", required: true, schema: { type: "integer", minimum: 1 } },
        ],
        responses: {
          ...ARR_ERRORS,
          "200": {
            description: "{ presentArrId, preview, qualityProfiles, rootFolders, tags, defaults }",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    presentArrId: { type: "integer", nullable: true, description: "The arr's id when the instance already has the title" },
                    preview: { type: "object", nullable: true, properties: { tmdbId: { type: "integer" }, title: { type: "string" }, year: { type: "integer", nullable: true } } },
                    qualityProfiles: { type: "array", items: ARR_CHOICE },
                    rootFolders: { type: "array", items: ARR_ROOT_FOLDER_CHOICE },
                    tags: { type: "array", items: ARR_CHOICE },
                    defaults: {
                      type: "object",
                      description: "The instance's configured add defaults (what a request's add would use)",
                      properties: { qualityProfileId: { type: "integer", nullable: true }, rootFolderPath: { type: "string", nullable: true }, minimumAvailability: { type: "string", nullable: true } },
                    },
                  },
                },
              },
            },
          },
          "400": { description: "Invalid service, instance or tmdbId" },
          "403": { description: "Not ADMIN" },
          "404": { description: "Integration disabled or unknown instance" },
        },
      },
      post: {
        tags: ["Admin – Arr"],
        summary: "Add a title to one Radarr/Sonarr instance with the admin's choices (ADMIN)",
        description:
          "Every value must be one the instance offers (400, nothing written). Radarr REQUIRES `monitored` " +
          "(`minimumAvailability` optional); Sonarr REQUIRES `monitor` (all, future, missing, existing, pilot, firstSeason, " +
          "latestSeason, none — accepted by v3 and v4; `seriesType`, `seasonFolder` optional). A field the other service has " +
          "is 400. `search` searches right after adding — sent as no search when it can find nothing (Radarr `monitored: " +
          "false`, Sonarr `monitor: none`). No MediaRequest is created — nobody is notified and no watch grade counts it. " +
          "Audited ARR_TITLE_ADD. 20 per minute per admin.",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["service", "tmdbId", "qualityProfileId", "rootFolderPath", "search"], properties: {
          service: { type: "string", enum: ["radarr", "sonarr"] }, instance: { type: "string" }, tmdbId: { type: "integer", minimum: 1 },
          qualityProfileId: { type: "integer", minimum: 1 }, rootFolderPath: { type: "string" }, tags: { type: "array", items: { type: "integer", minimum: 1 } },
          search: { type: "boolean", description: "Search right after adding (Radarr searchForMovie / Sonarr searchForMissingEpisodes). Ignored (sent and audited as false) when nothing is monitored: Radarr `monitored: false`, Sonarr `monitor: \"none\"` — the arr's add-time search would skip it." }, monitored: { type: "boolean", description: "Radarr — required (400 when missing); refused on Sonarr" },
          minimumAvailability: { type: "string", enum: ["announced", "inCinemas", "released"], description: "Radarr only, optional" },
          monitor: { type: "string", enum: ["all", "future", "missing", "existing", "pilot", "firstSeason", "latestSeason", "none"], description: "Sonarr — required (400 when missing); refused on Radarr" },
          seriesType: { type: "string", enum: ["standard", "daily", "anime"], description: "Sonarr only, optional" }, seasonFolder: { type: "boolean", description: "Sonarr only, optional" },
        } } } } },
        responses: {
          ...ARR_ERRORS,
          "201": {
            description: "{ arrId, title } — `arrId` is null when the arr took the add but neither its answer nor a re-read named the new id",
            content: { "application/json": { schema: { type: "object", required: ["arrId", "title"], properties: { arrId: { type: "integer", nullable: true }, title: { type: "string" } } } } },
          },
          "400": { description: "Invalid body (Radarr without `monitored`, Sonarr without `monitor`, a field the other service has), a profile/root folder/tag the instance doesn't have, or the arr's own refusal (masked)" },
          "403": { description: "Not ADMIN" },
          "404": { description: "Integration disabled, unknown instance, or the arr's lookup has no such title" },
          "409": { description: "{ error, arrId } — the instance already has it" },
          "429": { description: "Too many" },
        },
      },
    },

    "/admin/arr/title/remove": {
      post: {
        tags: ["Admin – Arr"],
        summary: "Remove a title from one Radarr/Sonarr instance — dry run, then execute (ADMIN)",
        description:
          "Without `execute`: a dry run → `{ title, requests: { pending, approved, available } }` (this instance's requests), " +
          "nothing changed. With `execute: true` and `confirm` echoing the id: removes it, `deleteFiles` and the import-list " +
          "exclusion always sent explicitly. 409 `{ approved }` while an APPROVED request on this instance would make the sync " +
          "add it back (nothing changed). Every AVAILABLE request on this instance is stamped `cleanedUpAt` before the delete " +
          "(the sync never re-adds it), and unstamped only when the arr DEFINITELY refused the delete and a re-read shows the title still there — an unknown outcome (timeout, 502/504, network) keeps them, since the arr may have taken it (guardrail 14b). Audited ARR_TITLE_DELETE. The execute is limited to 10 per minute per admin (429); the dry run is not.",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["service", "id", "deleteFiles", "addImportExclusion"], properties: {
          service: { type: "string", enum: ["radarr", "sonarr"] }, instance: { type: "string" }, id: { type: "integer", minimum: 1 },
          deleteFiles: { type: "boolean" }, addImportExclusion: { type: "boolean" }, execute: { type: "boolean" }, confirm: { type: "integer", description: "The id, echoed from the dry run" },
        } } } } },
        responses: {
          ...ARR_ERRORS,
          "200": {
            description: "Dry run: { title, requests } — execute: { removed, alreadyGone, requestsStamped }",
            content: {
              "application/json": {
                schema: {
                  oneOf: [
                    {
                      type: "object",
                      description: "Dry run — nothing changed",
                      required: ["title", "requests"],
                      properties: {
                        title: ARR_TITLE,
                        requests: { type: "object", properties: { pending: { type: "integer" }, approved: { type: "integer" }, available: { type: "integer" } } },
                      },
                    },
                    {
                      type: "object",
                      description: "Executed",
                      required: ["removed", "alreadyGone", "requestsStamped"],
                      properties: {
                        removed: { type: "boolean", enum: [true] },
                        alreadyGone: { type: "boolean", description: "The instance no longer had it (removed by hand since the dry run)" },
                        requestsStamped: { type: "integer" },
                      },
                    },
                  ],
                },
              },
            },
          },
          "400": { description: "Invalid body, a missing flag, or no confirmation" },
          "403": { description: "Not ADMIN" },
          "404": { description: "Integration disabled, unknown instance, or the instance doesn't have the title" },
          "409": { description: "{ error, approved } — APPROVED requests on this instance" },
          "429": { description: "Too many" },
        },
      },
    },

    "/admin/arr/title/episodes": {
      get: {
        tags: ["Admin – Arr"],
        summary: "One season's episodes of a Sonarr series (ADMIN)",
        parameters: [
          ARR_SNAPSHOT_PARAM,
          { name: "service", in: "query", required: true, schema: { type: "string", enum: ["sonarr"] } },
          { name: "instance", in: "query", schema: { type: "string" } },
          { name: "id", in: "query", required: true, schema: { type: "integer", minimum: 1 } },
          { name: "season", in: "query", required: true, schema: { type: "integer", minimum: 0 } },
        ],
        responses: {
          "204": ARR_SNAPSHOT_204,
          ...ARR_ERRORS,
          "200": {
            description: "{ episodes: [{ id, seasonNumber, episodeNumber, title, airDateUtc, monitored, hasFile, episodeFileId, finaleType }], now } — `now` is the server's time to judge \"aired\" against",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["episodes", "now"],
                  properties: {
                    episodes: { type: "array", items: ARR_TITLE_EPISODE },
                    now: { type: "string", format: "date-time", description: "The server's clock — what the page judges \"aired\" against" },
                  },
                },
              },
            },
          },
          "400": { description: "Invalid parameters" },
          "403": { description: "Not ADMIN" },
          "404": { description: "Integration disabled, unknown instance, or no such series" },
        },
      },
      patch: {
        tags: ["Admin – Arr"],
        summary: "Monitor or unmonitor episodes of a Sonarr series (ADMIN)",
        description: "Every id must be one of the series' episodes (409 otherwise, nothing written). Answers the series re-read — its counts follow monitoring. Audited ARR_TITLE_EDIT.",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["service", "id", "episodeIds", "monitored"], properties: {
          service: { type: "string", enum: ["sonarr"] }, instance: { type: "string" }, id: { type: "integer", minimum: 1 },
          episodeIds: { type: "array", items: { type: "integer", minimum: 1 }, maxItems: 5000 }, monitored: { type: "boolean" },
        } } } } },
        responses: {
          ...ARR_ERRORS,
          "200": {
            description: "{ updated, title }",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["updated", "title"],
                  properties: {
                    updated: { type: "integer" },
                    title: { ...ARR_TITLE, nullable: true, description: "null when the re-read after the write failed" },
                  },
                },
              },
            },
          },
          "400": { description: "Invalid body" },
          "403": { description: "Not ADMIN" },
          "409": { description: "An episode is not this series'" },
          "429": { description: "More than 60 changes a minute by this admin (Retry-After set)" },
        },
      },
    },

    "/admin/arr/title/files": {
      get: {
        tags: ["Admin – Arr"],
        summary: "A title's files in Radarr/Sonarr (ADMIN) — or poll a background file delete",
        description:
          "Path, size, quality (+ PROPER/REPACK), languages, custom formats and score, cutoff, release group, media info, and for Sonarr the episodes each file holds. " +
          "With `job` (no other parameter needed) it is instead the poll for a background delete (DELETE with `async: true`): 202 " +
          "`{ job, running: true }` while it runs, then the DELETE's own status and body — 200 `{ deleted }`, 502 `{ error, deleted }`, " +
          "or its 4xx `{ error }`; 404 `{ error }` once the job is unknown (expired 10 minutes after it finished, another admin's, or " +
          "lost to a restart — reload the files, never re-run the delete blindly). Readable by the admin who started it only.",
        parameters: [
          ARR_SNAPSHOT_PARAM,
          { name: "service", in: "query", schema: { type: "string", enum: ["radarr", "sonarr"] }, description: "Required unless `job`" },
          { name: "instance", in: "query", schema: { type: "string" } },
          { name: "id", in: "query", schema: { type: "integer", minimum: 1 }, description: "Required unless `job`" },
          { name: "job", in: "query", schema: { type: "string", pattern: "^[0-9a-f]{32}$" }, description: "Poll a background delete (DELETE with `async: true`) instead of listing; the other parameters are then ignored" },
        ],
        responses: {
          "204": ARR_SNAPSHOT_204,
          ...ARR_ERRORS,
          "200": {
            description: "{ files } — or, with `job`, the finished delete's own 200 { deleted } (any of DELETE's answers passes through with its status)",
            content: {
              "application/json": {
                schema: {
                  oneOf: [
                    { type: "object", required: ["files"], properties: { files: { type: "array", items: ARR_TITLE_FILE } } },
                    { ...ARR_FILES_DELETED, description: "With `job`: the finished delete's own 200" },
                  ],
                },
              },
            },
          },
          "202": jobAnswer("`job`: the delete is still running — { job, running: true }", JOB_RUNNING),
          "403": { description: "Not ADMIN" },
          "404": { description: "Integration disabled, or no such title or instance — or, with `job`, the job is gone (expired, another admin's, or lost to a restart): { error }" },
        },
      },
      delete: {
        tags: ["Admin – Arr"],
        summary: "Delete a title's files from disk through Radarr/Sonarr (ADMIN)",
        description:
          "Every id must be one of the title's files as the arr lists them now (409 otherwise, nothing deleted). Sonarr: one " +
          "bulk delete; Radarr: one delete per file. The ids go in a JSON body `{ fileIds }` (up to 10,000), or `fileIds` " +
          "in the query (up to 1,000). Audited ARR_FILE_DELETE after the arr accepted it — a delete that stops part-way (or " +
          "times out) audits the files it did delete and answers 502 `{ error, deleted }` with how many; a timeout after every " +
          "file was deleted answers 200. Each delete may wait up to 120 s (a recycle bin on another disk is a copy), past a " +
          "reverse proxy's hold, so `async: true` in the JSON body answers 202 `{ job }` at once and runs the delete and its " +
          "audit in the background; poll GET `?job=<id>` for the answer this call would have sent. The same admin deleting the " +
          "same files of the same title while one runs joins that job (nothing is sent twice). Without `async` (or with the " +
          "ids in the query) the delete answers inline.",
        parameters: [
          { name: "service", in: "query", required: true, schema: { type: "string", enum: ["radarr", "sonarr"] } },
          { name: "instance", in: "query", schema: { type: "string" } },
          { name: "id", in: "query", required: true, schema: { type: "integer", minimum: 1 } },
          { name: "fileIds", in: "query", schema: { type: "string" }, description: "Comma-separated file ids (or send them in the body)" },
        ],
        requestBody: { content: { "application/json": { schema: { type: "object", properties: {
          fileIds: { type: "array", minItems: 1, maxItems: 10000, items: { type: "integer", minimum: 1 } },
          async: { type: "boolean", description: "Run the delete as a background job: 202 { job }, poll GET ?job=. Default (absent/false): synchronous" },
        } } } } },
        responses: {
          ...ARR_ERRORS,
          "200": { description: "{ deleted } — the number of files deleted", content: { "application/json": { schema: ARR_FILES_DELETED } } },
          "202": jobAnswer("async: true — the delete runs in the background: { job } (the same admin's running delete of the same files is joined); poll GET ?job=", JOB_STARTED),
          "400": { description: "Invalid ids" },
          "403": { description: "Not ADMIN" },
          "429": { description: "More than 30 deletes a minute by this admin (Retry-After set)" },
          "409": { description: "A file is not this title's" },
          "502": { description: "The arr failed — possibly part-way, with `deleted` the count already gone" },
        },
      },
    },

    "/admin/arr/title/rename": {
      get: {
        tags: ["Admin – Arr"],
        summary: "Preview renaming a title's files to the arr's naming scheme (ADMIN)",
        parameters: [
          { name: "service", in: "query", required: true, schema: { type: "string", enum: ["radarr", "sonarr"] } },
          { name: "instance", in: "query", schema: { type: "string" } },
          { name: "id", in: "query", required: true, schema: { type: "integer", minimum: 1 } },
        ],
        responses: {
          ...ARR_ERRORS,
          "200": {
            description: "{ files: [{ fileId, existingPath, newPath, seasonNumber, episodeNumbers }] } — only files whose name would change",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["files"],
                  properties: {
                    files: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          fileId: { type: "integer" },
                          existingPath: { type: "string", description: "The file as the arr sees it now (ADMIN-only, like the rest of this route)" },
                          newPath: { type: "string", description: "What the arr's naming scheme would rename it to" },
                          seasonNumber: { type: "integer", nullable: true, description: "Sonarr only" },
                          episodeNumbers: { type: "array", items: { type: "integer" }, description: "Sonarr only" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          "403": { description: "Not ADMIN" },
        },
      },
      post: {
        tags: ["Admin – Arr"],
        summary: "Rename a title's files (the arr's RenameFiles) (ADMIN)",
        description: "The preview is re-read first; an id it no longer lists is 409 and nothing is renamed. Audited ARR_FILE_RENAME.",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["service", "id", "fileIds"], properties: {
          service: { type: "string", enum: ["radarr", "sonarr"] }, instance: { type: "string" }, id: { type: "integer", minimum: 1 },
          fileIds: { type: "array", minItems: 1, maxItems: 10000, items: { type: "integer", minimum: 1 } },
        } } } } },
        responses: {
          ...ARR_ERRORS,
          "202": {
            description: "{ files, commandIds } — queued; commandIds is the arr's id for its RenameFiles command (GET /admin/arr/commands)",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["files", "commandIds"],
                  properties: { files: { type: "integer", description: "How many files were sent to be renamed" }, commandIds: ARR_COMMAND_IDS },
                },
              },
            },
          },
          "400": { description: "Invalid body" },
          "403": { description: "Not ADMIN" },
          "409": { description: "A file no longer needs renaming" },
          "429": { description: "More than 10 renames a minute by this admin (Retry-After set)" },
        },
      },
    },

    "/admin/arr/title/history": {
      get: {
        tags: ["Admin – Arr"],
        summary: "A title's Radarr/Sonarr history (ADMIN)",
        description:
          "Every grab, import, failure, deletion, rename and ignored download, newest first. Only named fields of each record's " +
          "data are returned — never the release's download URL, guid or info URL (they can embed an indexer apikey); " +
          "messages have credentials masked.",
        parameters: [
          ARR_SNAPSHOT_PARAM,
          { name: "service", in: "query", required: true, schema: { type: "string", enum: ["radarr", "sonarr"] } },
          { name: "instance", in: "query", schema: { type: "string" } },
          { name: "id", in: "query", required: true, schema: { type: "integer", minimum: 1 } },
        ],
        responses: {
          "204": ARR_SNAPSHOT_204,
          ...ARR_ERRORS,
          "200": {
            description: "{ events }",
            content: { "application/json": { schema: { type: "object", required: ["events"], properties: { events: { type: "array", items: ARR_HISTORY_EVENT } } } } },
          },
          "403": { description: "Not ADMIN" },
          "404": { description: "Integration disabled, or no such title or instance" },
        },
      },
    },

    "/admin/arr/title/command": {
      post: {
        tags: ["Admin – Arr"],
        summary: "Search or refresh one title (ADMIN)",
        description:
          "Radarr: `search` (MoviesSearch — an upgrade search when it has a file) or `refresh` (RefreshMovie). Sonarr: " +
          "`refresh` (RefreshSeries), `searchMissing` (exactly what is missing, re-judged live — never SeriesSearch; 409 when " +
          "nothing is), `searchSeason` + seasonNumber (SeasonSearch), `searchEpisodes` + episodeIds (one EpisodeSearch; every " +
          "id must be the series'; with `missingOnly: true` only the ones that have aired and have no file — 409 when none " +
          "is left, so it never becomes an upgrade search). Not audited; 30 per minute per admin.",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["service", "id", "action"], properties: {
          service: { type: "string", enum: ["radarr", "sonarr"] }, instance: { type: "string" }, id: { type: "integer", minimum: 1 },
          action: { type: "string", enum: ["search", "refresh", "searchMissing", "searchSeason", "searchEpisodes"] },
          seasonNumber: { type: "integer", minimum: 0 },
          episodeIds: { type: "array", items: { type: "integer", minimum: 1 }, maxItems: 1000 },
          missingOnly: { type: "boolean" },
        } } } } },
        responses: {
          ...ARR_ERRORS,
          "202": {
            description: "{ commands, commandIds } — queued; commandIds are the arr's ids for the queued commands (follow them at GET /admin/arr/commands). searchMissing answers { commands, seasons, episodes, commandIds } — a searchMissing refused part-way still answers 202 with the ids it queued and `partial: true`; 404 when the instance no longer has the series",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["commands", "commandIds"],
                  properties: {
                    commands: { type: "integer", description: "Commands queued on the instance" },
                    commandIds: ARR_COMMAND_IDS,
                    seasons: { type: "array", items: { type: "integer" }, description: "searchMissing only: the seasons searched whole" },
                    episodes: { type: "integer", description: "searchMissing only: the episodes searched one by one" },
                    partial: { type: "boolean", enum: [true], description: "searchMissing only, present when a later command was refused part-way" },
                  },
                },
              },
            },
          },
          "400": { description: "Unknown action for the service, or searchSeason without a valid seasonNumber / searchEpisodes without 1–1000 episodeIds" },
          "403": { description: "Not ADMIN" },
          "409": { description: "Nothing missing (body carries an additive `nothingMissing: true`), a season/episode not the series' (no flag), or the arr's own refusal (its reason, masked; no flag)" },
          "429": { description: "Too many" },
        },
      },
    },

    "/admin/arr/title/releases": {
      get: {
        tags: ["Admin – Arr"],
        summary: "Interactive search for any title (ADMIN)",
        description:
          "A movie, or for a series one season (`season`) or one episode (`episodeId`) — Sonarr has no whole-series release " +
          "search. The projected ArrRelease list (no download URL) in the arr's own order (`releaseWeight`), each `guid` " +
          "replaced by an opaque handle bound to this title, instance and scope. 20 searches per minute per admin. With " +
          "`async=1` → 202 `{ job }`, the search runs in the background; GET `?job=<id>` answers 202 while it runs, then the " +
          "search's own answer, 404 once the job is gone.",
        parameters: [
          { name: "service", in: "query", schema: { type: "string", enum: ["radarr", "sonarr"] } },
          { name: "instance", in: "query", schema: { type: "string" } },
          { name: "id", in: "query", schema: { type: "integer", minimum: 1 } },
          { name: "season", in: "query", schema: { type: "integer", minimum: 0 } },
          { name: "episodeId", in: "query", schema: { type: "integer", minimum: 1 } },
          { name: "async", in: "query", schema: { type: "string", enum: ["1"] } },
          { name: "job", in: "query", schema: { type: "string", pattern: "^[0-9a-f]{32}$" }, description: "Poll a background search (the other parameters are then ignored)" },
        ],
        responses: {
          ...ARR_ERRORS,
          "200": {
            description: "{ releases }",
            content: { "application/json": { schema: { type: "object", properties: { releases: { type: "array", items: ARR_RELEASE } } } } },
          },
          "202": jobAnswer("{ job } — searching in the background (or, polling `?job=`, { job, running: true } while it runs)", SEARCH_JOB),
          "400": { description: "Invalid scope" },
          "403": { description: "Not ADMIN" },
          "404": { description: "Integration disabled, unknown instance or title, or (with `?job=`) the job is gone — expired, another admin's, or a restart; search again" },
          "429": { description: "Too many searches" },
        },
      },
      post: {
        tags: ["Admin – Arr"],
        summary: "Grab a release from an interactive search (ADMIN)",
        description:
          "410 when the handle is unknown, expired, or from another search — or when the arr's own 30-minute search cache no " +
          "longer has the release; 409 with the arr's reason (masked) when the indexer or download client refused it. The " +
          "handle is spent on success. Audited ARR_RELEASE_GRAB with the release name; the guid is never recorded.",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["service", "id", "release"], properties: {
          service: { type: "string", enum: ["radarr", "sonarr"] }, instance: { type: "string" }, id: { type: "integer", minimum: 1 },
          release: { type: "string", pattern: "^[0-9a-f]{32}$" }, season: { type: "integer", minimum: 0 }, episodeId: { type: "integer", minimum: 1 },
        } } } } },
        responses: { ...ARR_ERRORS, "200": { description: "{ ok: true } — grabbed", content: { "application/json": { schema: OK_TRUE } } }, "400": { description: "Invalid body" }, "403": { description: "Not ADMIN" }, "409": { description: "The indexer or download client refused it (the arr's reason, masked), or a grab of this handle is already in progress (nothing was sent)" }, "410": { description: "Handle expired, from another search, or no longer in the arr's search cache" }, "429": { description: "More than 20 grabs a minute by this admin (Retry-After set; the handle is not spent)" } },
      },
    },

    "/admin/arr/history": {
      get: {
        tags: ["Admin – Arr"],
        summary: "One instance's Radarr/Sonarr history, paged (ADMIN)",
        description: "Newest first, paged by the arr. `kind` filters (translated per service — the event enums differ). Same data projection as the title history.",
        parameters: [
          ARR_SNAPSHOT_PARAM,
          { name: "service", in: "query", required: true, schema: { type: "string", enum: ["radarr", "sonarr"] } },
          { name: "instance", in: "query", schema: { type: "string" } },
          { name: "page", in: "query", schema: { type: "integer", minimum: 1, default: 1 } },
          { name: "pageSize", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
          { name: "kind", in: "query", schema: { type: "string", enum: ["grabbed", "imported", "failed", "deleted", "renamed", "ignored"] } },
        ],
        responses: { "204": ARR_SNAPSHOT_204, ...ARR_ERRORS, "200": { description: "{ page, pageSize, totalRecords, records }", content: { "application/json": { schema: arrPage(ARR_HISTORY_EVENT) } } }, "400": { description: "Invalid paging or kind" }, "403": { description: "Not ADMIN" } },
      },
    },

    "/admin/arr/history/failed": {
      post: {
        tags: ["Admin – Arr"],
        summary: "Mark a grabbed release failed (ADMIN)",
        description:
          "The arr's own Mark as failed: blocklist the release, handle the download as failed, and search again if the arr's " +
          "Redownload Failed is on. The record must be a GRAB of `arrId` as the arr's history reads now, whose download is not " +
          "already failed (Sonarr writes a grab per episode of a pack) — 409 otherwise. Audited ARR_MARK_FAILED.",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["service", "arrId", "historyId"], properties: {
          service: { type: "string", enum: ["radarr", "sonarr"] }, instance: { type: "string" },
          arrId: { type: "integer", minimum: 1 }, historyId: { type: "integer", minimum: 1 },
        } } } } },
        responses: { ...ARR_ERRORS, "200": { description: "Marked", content: { "application/json": { schema: OK_TRUE } } }, "400": { description: "Invalid service, instance, arrId or historyId, or the arr refused (its reason, masked)" }, "403": { description: "Not ADMIN" }, "409": { description: "Not a grab, not this title's, or its download already failed" }, "429": { description: "More than 30 marks a minute by this admin (Retry-After set)" } },
      },
    },

    "/admin/arr/blocklist": {
      get: {
        tags: ["Admin – Arr"],
        summary: "One instance's blocklist, paged (ADMIN)",
        parameters: [
          ARR_SNAPSHOT_PARAM,
          { name: "service", in: "query", required: true, schema: { type: "string", enum: ["radarr", "sonarr"] } },
          { name: "instance", in: "query", schema: { type: "string" } },
          { name: "page", in: "query", schema: { type: "integer", minimum: 1, default: 1 } },
          { name: "pageSize", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
        ],
        responses: {
          "204": ARR_SNAPSHOT_204,
          ...ARR_ERRORS,
          "200": {
            description: "{ page, pageSize, totalRecords, records } — title, release, quality, indexer, reason (masked)",
            content: { "application/json": { schema: arrPage(BLOCKLIST_ENTRY) } },
          },
          "400": { description: "Invalid service, instance or paging" },
          "403": { description: "Not ADMIN" },
          "404": { description: "Integration disabled, unknown instance, or the arr is older than the /blocklist API (Radarr v3, Sonarr v3 before Aug 2021) — upgrade it; never \"not found\"" },
        },
      },
      delete: {
        tags: ["Admin – Arr"],
        summary: "Remove releases from a blocklist (ADMIN)",
        description:
          "The arr's bulk delete, so they can be grabbed again. Every id must be on the blocklist as it reads now (409 " +
          "otherwise, nothing removed) — the page named by `page`/`pageSize` is re-read first, then a bounded scan. Audited " +
          "ARR_BLOCKLIST_CHANGE with each removed release's name and title id.",
        parameters: [
          { name: "service", in: "query", required: true, schema: { type: "string", enum: ["radarr", "sonarr"] } },
          { name: "instance", in: "query", schema: { type: "string" } },
          { name: "ids", in: "query", required: true, schema: { type: "string" }, description: "Comma-separated blocklist ids (at most 500)" },
          { name: "page", in: "query", schema: { type: "integer", minimum: 1 }, description: "The page the ids were picked from, re-read first (with pageSize); malformed → 400" },
          { name: "pageSize", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 }, description: "The size of that page; malformed → 400" },
        ],
        responses: {
          ...ARR_ERRORS,
          "200": {
            description: "{ removed } — the number of ids removed",
            content: { "application/json": { schema: { type: "object", required: ["removed"], properties: { removed: { type: "integer", description: "The number of ids removed" } } } } },
          },
          "400": { description: "Invalid service, instance, ids, or page/pageSize" },
          "403": { description: "Not ADMIN" },
          "404": { description: "Integration disabled, unknown instance, or the arr is older than the /blocklist API (Radarr v3, Sonarr v3 before Aug 2021) — upgrade it; never \"not found\"" },
          "409": { description: "An id is no longer on the blocklist" },
          "429": { description: "More than 30 removals a minute by this admin (Retry-After set)" },
        },
      },
    },

    "/admin/arr/blocklist/clear": {
      post: {
        tags: ["Admin – Arr"],
        summary: "Clear an instance's whole blocklist (ADMIN)",
        description: "The arr's own ClearBlocklist command. Audited ARR_BLOCKLIST_CHANGE with the `count` the admin confirmed (the list it names is gone afterwards).",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["service"], properties: {
          service: { type: "string", enum: ["radarr", "sonarr"] }, instance: { type: "string" },
          count: { type: "integer", minimum: 0, description: "Size of the list the admin confirmed clearing — recorded in the ARR_BLOCKLIST_CHANGE audit; missing or malformed is recorded as null" },
        } } } } },
        responses: {
          ...ARR_ERRORS,
          "202": {
            description: "{ ok, commandIds } — queued; commandIds is the arr's id for its ClearBlocklist command (GET /admin/arr/commands)",
            content: { "application/json": { schema: { type: "object", required: ["ok", "commandIds"], properties: { ok: { type: "boolean", enum: [true] }, commandIds: ARR_COMMAND_IDS } } } },
          },
          "403": { description: "Not ADMIN" },
          "429": { description: "More than 10 clears a minute by this admin (Retry-After set)" },
        },
      },
    },

    "/admin/arr/calendar": {
      get: {
        tags: ["Admin – Arr"],
        summary: "Radarr's and Sonarr's own calendars across every instance (ADMIN)",
        description:
          "One entry per episode airing and per movie release date (in cinemas / physical / digital) in the window, each with " +
          "`status`: downloaded; downloading (in the instance's download queue — `progress` 0..1, with `attention` true when Radarr/Sonarr flag that download as needing attention (import blocked, a tracked warning/error)); missing (monitored, no file — " +
          "an episode only once it has finished airing and only in a regular season, a movie once a home release date passed); " +
          "airing (until air time + runtime); aired (a special that aired without a file — never missing); unmonitored; " +
          "upcoming; or released (a passed cinema date). Radarr's window is read a day wider each side, since its release " +
          "dates are calendar dates at midnight UTC — place each on its date — and Sonarr's 14 h wider each side (a host-local " +
          "date parse on v3), so entries may fall just outside [start, end); keep only those inside your own days. A failed instance is named in `errors`, each " +
          "with `kind`: auth, timeout, unreachable, server, notFound or other. `now` is the server's time the page judges " +
          "against.",
        parameters: [
          ARR_SNAPSHOT_PARAM,
          { name: "start", in: "query", required: true, schema: { type: "string", format: "date-time" } },
          { name: "end", in: "query", required: true, schema: { type: "string", format: "date-time" }, description: "At most 62 days after start" },
          { name: "unmonitored", in: "query", schema: { type: "string", enum: ["1", "true"] } },
        ],
        responses: {
          "204": ARR_SNAPSHOT_204,
          "200": {
            description: "{ instances, errors, entries, now }",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["instances", "errors", "entries", "now"],
                  properties: {
                    instances: { type: "array", items: ARR_INSTANCE_REF },
                    errors: { type: "array", items: ARR_FANOUT_ERROR },
                    entries: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          key: { type: "string", description: "Stable across reloads: service, instance, id and kind" },
                          service: ARR_SERVICE,
                          instance: { type: "string" },
                          kind: { type: "string", enum: ["episode", "cinema", "physical", "digital"] },
                          date: { type: "string", format: "date-time" },
                          arrId: { type: "integer", description: "Radarr movie id / Sonarr series id" },
                          episodeId: { type: "integer", nullable: true },
                          title: { type: "string" },
                          year: { type: "integer", nullable: true },
                          tmdbId: { type: "integer", nullable: true },
                          tvdbId: { type: "integer", nullable: true },
                          posterPath: { type: "string", nullable: true },
                          seasonNumber: { type: "integer", nullable: true },
                          episodeNumber: { type: "integer", nullable: true },
                          episodeTitle: { type: "string", nullable: true },
                          finaleType: { type: "string", nullable: true },
                          network: { type: "string", nullable: true, description: "Network (Sonarr) or studio (Radarr)" },
                          monitored: { type: "boolean" },
                          hasFile: { type: "boolean" },
                          status: { type: "string", enum: ["downloaded", "downloading", "missing", "airing", "aired", "unmonitored", "upcoming", "released"] },
                          progress: { type: "number", nullable: true, description: "0..1 while `downloading` (null when the queue doesn't know the size); null otherwise" },
                          attention: { type: "boolean", description: "While `downloading`: the arr flags the download as needing attention" },
                        },
                      },
                    },
                    now: { type: "string", format: "date-time", description: "The server's clock when the report was made" },
                  },
                },
              },
            },
          },
          "400": { description: "Invalid window" },
          "403": { description: "Not ADMIN" },
        },
      },
    },

    "/cron/arr-watch": {
      post: {
        tags: ["Cron"],
        summary: "Radarr/Sonarr monitor: low disks, failed downloads, downloads newly needing attention",
        description:
          "Reads every configured, enabled Radarr/Sonarr instance — the disks holding its root folders (/api/v3/rootfolder + /diskspace), " +
          "failed downloads since the last run (/api/v3/history/since, eventType=4) and its queue — and sends `arr.disk_low` / `arr.disk_ok` " +
          "(on a change of state per instance and disk), `arr.download_failed` (each new failed download once; a Sonarr pack is one event; a manual mark, \"Manually marked as failed\", is not announced) and " +
          "`arr.queue_attention` (each download newly needing attention, at most 25 per instance per run — the rest by the next run) to the " +
          "outbound notification channels. An announced download and a disk's state are remembered for 24 hours after they drop out of a " +
          "read, so one that comes back inside that is not announced again. A first run per instance seeds its history cursor and attention " +
          "set without announcing them. Writes the counts behind the admin nav's Download Queue badge. " +
          "Skipped (no ledger row) while no Radarr/Sonarr instance is enabled and configured; a failed read answers 200 with ok:false, " +
          "`error` and X-Cron-Degraded. `deferredFailures` counts history RECORDS left for the next run once the per-run cap was " +
          "reached (a Sonarr pack counts once per episode, so it is not a count of downloads); `deferredAttention` counts downloads.",
        security: ADMIN_OR_CRON_SECURITY,
        responses: {
          "200": {
            description: "{ ok, checked, notReached, aborted, errors: [{ service, instance, part: disk|history|queue, error }], events: { diskLow, diskOk, downloadFailed, queueAttention }, deferredFailures, deferredAttention, summary: { attention, lowDisks, failed24h }, durationMs, trigger, timestamp } — or { skipped: true, reason }",
            content: {
              "application/json": {
                schema: cronRunOrSkip({
                  type: "object",
                  required: ["ok", "checked", "notReached", "aborted", "errors", "events", "deferredFailures", "deferredAttention", "summary", "durationMs", "trigger", "timestamp"],
                  properties: {
                    ok: CRON_RUN_FIELDS.ok,
                    checked: { type: "integer", description: "Instances read this run" },
                    notReached: { type: "integer", description: "Instances not reached because the run was stopped" },
                    aborted: { type: "boolean" },
                    errors: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          service: ARR_SERVICE,
                          instance: { type: "string" },
                          part: { type: "string", enum: ["disk", "history", "queue"] },
                          error: { type: "string" },
                        },
                      },
                    },
                    events: {
                      type: "object",
                      properties: { diskLow: { type: "integer" }, diskOk: { type: "integer" }, downloadFailed: { type: "integer" }, queueAttention: { type: "integer" } },
                    },
                    deferredFailures: { type: "integer" },
                    deferredAttention: { type: "integer" },
                    summary: {
                      type: "object",
                      properties: { attention: { type: "integer" }, lowDisks: { type: "integer" }, failed24h: { type: "integer" } },
                    },
                    error: CRON_RUN_FIELDS.error,
                    durationMs: CRON_RUN_FIELDS.durationMs,
                    trigger: CRON_RUN_FIELDS.trigger,
                    timestamp: CRON_RUN_FIELDS.timestamp,
                  },
                }),
              },
            },
          },
          "401": { description: "Neither an admin session nor the cron secret" },
        },
      },
    },

    "/cron/refresh-arr-snapshots": {
      post: {
        tags: ["Cron"],
        summary: "Keep the admin Radarr/Sonarr pages' last answers fresh in the background",
        description:
          "Re-reads, through each route's own handler, every admin arr view an admin opened in the last 24 hours, on its page's priority: " +
          "the queue and Radarr/Sonarr health every 5 minutes; Missing, Download History/Blocklist, the calendar and the title manager every 10; " +
          "Arr System (tasks, indexers & clients, storage) every 15 — at most 40 re-reads per run, 2 at a time. The kept answer is what the page " +
          "paints at once on its next open (`?cached=1`). A failed re-read keeps the last good answer. Skipped (no ledger row) when nothing is due; " +
          "a failed re-read answers 200 with ok:false, `error` and X-Cron-Degraded.",
        security: ADMIN_OR_CRON_SECURITY,
        responses: {
          "200": {
            description: "{ ok, due, refreshed, failed, deferred, aborted, durationMs, trigger, timestamp } — or { skipped: true, reason }",
            content: {
              "application/json": {
                schema: cronRunOrSkip({
                  type: "object",
                  required: ["ok", "due", "refreshed", "failed", "deferred", "aborted", "durationMs", "trigger", "timestamp"],
                  properties: {
                    ok: CRON_RUN_FIELDS.ok,
                    due: { type: "integer", description: "Views that were due this run" },
                    refreshed: { type: "integer" },
                    failed: { type: "integer", description: "Re-reads that failed; their last good answer stays" },
                    deferred: { type: "integer", description: "Due views left for the next run" },
                    aborted: { type: "boolean" },
                    error: CRON_RUN_FIELDS.error,
                    durationMs: CRON_RUN_FIELDS.durationMs,
                    trigger: CRON_RUN_FIELDS.trigger,
                    timestamp: CRON_RUN_FIELDS.timestamp,
                  },
                }),
              },
            },
          },
          "401": { description: "Neither an admin session nor the cron secret" },
        },
      },
    },

    "/admin/arr-watch": {
      get: {
        tags: ["Admin – Arr"],
        summary: "Radarr/Sonarr monitor setting and the last run's counts (ADMIN)",
        responses: {
          "200": {
            description: "The low-disk threshold in force and the last monitor run's counts (null before the first run)",
            content: { "application/json": { schema: { type: "object", properties: {
              settings: { type: "object", properties: { diskLowPercent: { type: "integer", minimum: 1, maximum: 50 } } },
              summary: { type: "object", nullable: true, properties: {
                at: { type: "string", format: "date-time" },
                attention: { type: "integer", description: "Downloads Radarr/Sonarr say need an admin" },
                lowDisks: { type: "integer" },
                failed24h: { type: "integer", description: "Failed downloads announced in the last 24 hours" },
              } },
              navBadges: { type: "object", additionalProperties: { type: "integer", minimum: 1 }, description: "The admin nav's badges (href → count, e.g. { \"/admin/queue\": 3 }) by the same rule the layout renders them: no entry for a zero count or a snapshot older than three monitor intervals (at least an hour); {} for none. The browser re-reads this to keep the Download Queue badge fresh between page loads." },
            } } } },
          },
          "401": { description: "Not signed in" },
          "403": { description: "Not ADMIN" },
        },
      },
      patch: {
        tags: ["Admin – Arr"],
        summary: "Change the low-disk alert threshold (ADMIN)",
        description: "A disk holding a root folder is low when less than this percent of it is free (or under 10 GB); it reads ok again 2 points (and 2 GB) clear of the line. Anything but a whole number from 1 to 50 is refused.",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["diskLowPercent"], properties: { diskLowPercent: { type: "integer", minimum: 1, maximum: 50 } } } } } },
        responses: {
          "200": {
            description: "{ settings: { diskLowPercent } }",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["settings"],
                  properties: { settings: { type: "object", properties: { diskLowPercent: { type: "integer", minimum: 1, maximum: 50 } } } },
                },
              },
            },
          },
          "400": { description: "Not a whole number from 1 to 50" },
          "401": { description: "Not signed in" },
          "403": { description: "Not ADMIN" },
        },
      },
    },

    "/admin/arr/commands": {
      get: {
        tags: ["Admin – Arr"],
        summary: "Live status of Radarr/Sonarr commands Summonarr started (ADMIN)",
        description:
          "Follows the commands queued by the title manager (search, search missing, season/episode search, refresh), a " +
          "rename, Arr System's task runs and library-wide searches, and Clear blocklist — each of those answers with the " +
          "arr's command id(s) (`commandIds`; the task run's `id`). One read of the arr's /api/v3/command/{id} per id, " +
          "a few at a time (the first failure stops the rest). Each command carries Arr System's fields — id, name (the arr's label), commandName, status (queued, " +
          "started, completed, failed, aborted, cancelled, orphaned, unknown), message (the arr's progress or result line, " +
          "credentials masked), queued/started/ended and durationSeconds — never the command body. An id the arr answers 404 " +
          "for is `{ id, status: \"gone\" }` (it forgets a finished command after a while). The pages poll it every 2 s until " +
          "every command has ended. Not audited; 120 per minute per admin.",
        parameters: [
          { name: "service", in: "query", required: true, schema: { type: "string", enum: ["radarr", "sonarr"] } },
          { name: "instance", in: "query", schema: { type: "string" } },
          { name: "ids", in: "query", required: true, schema: { type: "string" }, description: "Comma-separated command ids: 1–" + COMMAND_READ_MAX_IDS + " positive integers (duplicates collapse). A Sonarr search-missing queues one SeasonSearch per fully missing season; the pages split a longer list across reads" },
        ],
        responses: {
          ...ARR_ERRORS,
          "200": {
            description: "{ commands: [{ id, name, commandName, status, message, queued, started, ended, durationSeconds } | { id, status: \"gone\" }] } — one per id, in the order asked",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["commands"],
                  properties: {
                    commands: {
                      type: "array",
                      description: "One per id, in the order asked. An id the arr no longer has is { id, status: \"gone\" }",
                      items: {
                        type: "object",
                        required: ["id", "status"],
                        properties: {
                          id: ARR_COMMAND_ROW.properties.id,
                          name: ARR_COMMAND_ROW.properties.name,
                          commandName: ARR_COMMAND_ROW.properties.commandName,
                          status: { type: "string", enum: [...ARR_COMMAND_STATUSES, "gone"] },
                          queued: ARR_COMMAND_ROW.properties.queued,
                          started: ARR_COMMAND_ROW.properties.started,
                          ended: ARR_COMMAND_ROW.properties.ended,
                          durationSeconds: ARR_COMMAND_ROW.properties.durationSeconds,
                          message: ARR_COMMAND_ROW.properties.message,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          "400": { description: "Invalid service or ids" },
          "403": { description: "Not ADMIN" },
          "404": { description: "Integration off, or no such configured instance" },
          "429": { description: "Too many (Retry-After)" },
          "502": { description: "The arr could not be read" },
        },
      },
    },

    "/admin/arr/tasks": {
      get: {
        tags: ["Admin – Arr"],
        summary: "Every instance's scheduled tasks and recent commands (ADMIN)",
        description: "Commands newest first; a command's body is never returned.",
        parameters: [ARR_SNAPSHOT_PARAM],
        responses: {
          "204": ARR_SNAPSHOT_204,
          "200": {
            description: "{ instances, errors, results: [{ service, instance, tasks, commands }] }",
            content: {
              "application/json": {
                schema: arrInstanceReport({
                  tasks: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        taskName: { type: "string", description: "The command the arr runs — what POST sends as `task`" },
                        name: { type: "string" },
                        intervalMinutes: { type: "number", nullable: true },
                        lastExecution: { type: "string", format: "date-time", nullable: true },
                        lastStartTime: { type: "string", format: "date-time", nullable: true },
                        lastDurationSeconds: { type: "number", nullable: true },
                        nextExecution: { type: "string", format: "date-time", nullable: true },
                      },
                    },
                  },
                  commands: { type: "array", items: ARR_COMMAND_ROW },
                }),
              },
            },
          },
          "403": { description: "Not ADMIN" },
        },
      },
      post: {
        tags: ["Admin – Arr"],
        summary: "Run a scheduled task, or a library-wide search (ADMIN)",
        description:
          "`task`: one of the instance's own scheduled tasks by taskName (re-read now; 400 otherwise — never an arbitrary " +
          "command). `action`: `searchMissing` (MissingMoviesSearch / MissingEpisodeSearch) or `searchCutoff` " +
          "(CutoffUnmet…Search), monitored titles only — Sonarr is sent `monitored: true`; Radarr has no such field (it searches " +
          "monitored movies only, and as a manual search it ignores Minimum Availability). Both audited ARR_COMMAND. 10 per " +
          "minute per admin.",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["service"], properties: {
          service: { type: "string", enum: ["radarr", "sonarr"] }, instance: { type: "string" },
          task: { type: "string" }, action: { type: "string", enum: ["searchMissing", "searchCutoff"] },
        } } } } },
        responses: {
          ...ARR_ERRORS,
          "202": {
            description: "{ id } — queued; the arr's command id (follow it at GET /admin/arr/commands)",
            content: { "application/json": { schema: { type: "object", required: ["id"], properties: { id: { type: "integer", nullable: true, description: "The arr's command id; null when its answer named none" } } } } },
          },
          "400": { description: "Neither a scheduled task nor an action, a task the instance doesn't list, or the arr refused (masked)" },
          "403": { description: "Not ADMIN" },
          "429": { description: "Too many" },
        },
      },
      delete: {
        tags: ["Admin – Arr"],
        summary: "Cancel a queued command (ADMIN)",
        parameters: [
          { name: "service", in: "query", required: true, schema: { type: "string", enum: ["radarr", "sonarr"] } },
          { name: "instance", in: "query", schema: { type: "string" } },
          { name: "commandId", in: "query", required: true, schema: { type: "integer", minimum: 1 } },
        ],
        responses: { ...ARR_ERRORS, "200": { description: "Cancelled", content: { "application/json": { schema: OK_TRUE } } }, "403": { description: "Not ADMIN" }, "409": { description: "Not queued any more" } },
      },
    },

    "/admin/arr/providers": {
      get: {
        tags: ["Admin – Arr"],
        summary: "Every instance's indexers and download clients (ADMIN)",
        description:
          "Name, implementation, protocol, priority, which uses are on, whether the indexer supports RSS / search at all " +
          "(`supportsRss` / `supportsSearch`, null when the arr doesn't say), tags, whether Prowlarr manages an indexer (its " +
          "\"(Prowlarr)\" name suffix — Prowlarr's next sync reverts a change), and a download client's remove-completed/failed " +
          "settings. Never their settings (API keys, passkeys, passwords). Neither arr has an indexer-status endpoint: " +
          "an indexer disabled after failures shows in the instance's health checks.",
        parameters: [
          ARR_SNAPSHOT_PARAM,
          { name: "job", in: "query", schema: { type: "string", pattern: "^[0-9a-f]{32}$" }, description: "Poll a background save (PATCH with `async: true`) instead of listing" },
        ],
        responses: {
          "204": ARR_SNAPSHOT_204,
          "200": {
            description: "{ instances, errors, results: [{ service, instance, indexers, downloadClients, tags }] } — or, with `job`, the finished save's own answer (any of PATCH's)",
            content: {
              "application/json": {
                schema: {
                  oneOf: [
                    arrInstanceReport({
                      indexers: { type: "array", items: ARR_INDEXER },
                      downloadClients: { type: "array", items: ARR_DOWNLOAD_CLIENT },
                      tags: { type: "array", items: { type: "object", properties: { id: { type: "integer" }, label: { type: "string" } } } },
                    }),
                    { ...ARR_PROVIDER_SAVED, description: "With `job`: the finished save's own 200" },
                  ],
                },
              },
            },
          },
          "202": jobAnswer("`job`: { job, running: true } — the save is still running", JOB_RUNNING),
          "403": { description: "Not ADMIN" },
          "404": { description: "`job`: no such job for this admin (expired, another admin's, or lost to a restart)" },
        },
      },
      patch: {
        tags: ["Admin – Arr"],
        summary: "Switch an indexer's uses or a download client on/off (ADMIN)",
        description:
          "The arr's resource is read and saved back with only those flags changed, server-side. Saves to one provider are taken " +
          "one at a time: each reads the resource only once the save before it has finished. Switching one ON lets the arr " +
          "test it (a failing test is 400 with its reason, masked; up to 120 s); a change that only turns things off is saved " +
          "with forceSave. When the arr refuses on WARNINGS alone the answer is 409 `{ warningsOnly: true, messages }`; " +
          "re-sending with `acceptWarnings: true` makes the server re-run the arr's own test on the changed resource and save " +
          "with forceSave only if it still finds no errors. A testing save that times out is read back: 200 `{ provider, " +
          "timedOut: true }` when the arr holds the change, 504 when it doesn't. Audited ARR_PROVIDER_CHANGE only when the " +
          "change was saved. `async: true` answers 202 `{ job }` at once and saves in the background (a testing save can wait " +
          "longer than a reverse proxy holds a request); poll GET `?job=<id>` for the answer this call would have sent. A " +
          "background save that times out is re-read for up to a minute more, so one the arr completes in that window answers " +
          "200 and is audited. The same save while one runs is joined. A use the indexer reports it can't do (`supportsRss` / " +
          "`supportsSearch` false on the fresh read) is never switched ON: 400, nothing sent.",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["service", "kind", "id"], properties: {
          service: { type: "string", enum: ["radarr", "sonarr"] }, instance: { type: "string" },
          kind: { type: "string", enum: ["indexer", "downloadClient"] }, id: { type: "integer", minimum: 1 },
          enableRss: { type: "boolean", description: "indexer" }, enableAutomaticSearch: { type: "boolean", description: "indexer" },
          enableInteractiveSearch: { type: "boolean", description: "indexer" }, enable: { type: "boolean", description: "downloadClient" },
          acceptWarnings: { type: "boolean", description: "Save despite test WARNINGS (never errors) — after a 409 warningsOnly" },
          async: { type: "boolean", description: "Run in the background: 202 { job }, poll GET ?job=" },
        } } } } },
        responses: {
          ...ARR_ERRORS,
          "200": { description: "{ provider, timedOut? }", content: { "application/json": { schema: ARR_PROVIDER_SAVED } } },
          "202": jobAnswer("`async: true` — { job }: started, or the same save already running", JOB_STARTED),
          "400": { description: "Invalid body, the arr refused, or the indexer doesn't support that use" },
          "403": { description: "Not ADMIN" },
          "404": { description: "Integration disabled, unknown instance, or no such provider" },
          "409": { description: "{ warningsOnly: true, messages } — the arr's test only warned; or, with acceptWarnings, { error, changed: true } — the provider was edited in the arr while it was tested (nothing saved)" },
          "504": { description: "{ error, provider, timedOut: true } — the save timed out and the arr does not hold it; or { error } alone when the arr timed out anywhere else (reading the provider, re-testing it, or a save that only turns things off) — read the list again to see whether that save landed" },
        },
      },
    },

    "/admin/arr/providers/test": {
      get: {
        tags: ["Admin – Arr"],
        summary: "Poll a background provider test (ADMIN)",
        parameters: [
          { name: "job", in: "query", required: true, schema: { type: "string", pattern: "^[0-9a-f]{32}$" }, description: "The job a POST with `async: true` answered" },
        ],
        responses: {
          "200": {
            description: "The finished test's own answer (or any other status POST would have sent)",
            content: { "application/json": { schema: ARR_PROVIDER_TEST_RESULTS } },
          },
          "202": jobAnswer("{ job, running: true } — still testing", JOB_RUNNING),
          "403": { description: "Not ADMIN" },
          "404": { description: "No such job for this admin (expired, another admin's, or lost to a restart)" },
        },
      },
      post: {
        tags: ["Admin – Arr"],
        summary: "Test indexers or download clients (ADMIN)",
        description:
          "The arr's Test All for the kind, or one by id (read and sent back to the arr's test endpoint server-side; up to " +
          "120 s). A background (`async: true`) Test All waits up to 270 s. Messages masked; a provider whose test only WARNED is `ok: true, warning: true`. On Test All, a provider whose failures don't say whether they are only warnings (every System.Text.Json Radarr/Sonarr — only Sonarr v3 says) is `ok: false, warning: false, uncertain: true`; a single test always says. Test All 6 per minute, " +
          "single tests 20 per minute, per admin; not audited. `async: true` answers 202 `{ job }` at once and tests in the " +
          "background (120 s outlasts what a reverse proxy holds a request); poll GET `?job=<id>`. The same test while one " +
          "runs is joined and spends no rate token.",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["service", "kind"], properties: {
          service: { type: "string", enum: ["radarr", "sonarr"] }, instance: { type: "string" },
          kind: { type: "string", enum: ["indexer", "downloadClient"] }, id: { type: "integer", minimum: 1 },
          async: { type: "boolean", description: "Run in the background: 202 { job }, poll GET ?job=" },
        } } } } },
        responses: {
          ...ARR_ERRORS,
          "200": {
            description: "{ results: [{ id, ok, warning, messages, uncertain? }] }",
            content: { "application/json": { schema: ARR_PROVIDER_TEST_RESULTS } },
          },
          "202": jobAnswer("`async: true` — { job }: started, or the same test already running", JOB_STARTED),
          "400": { description: "Invalid body, or the arr refused" },
          "403": { description: "Not ADMIN" },
          "404": { description: "Integration disabled, unknown instance, or no such provider" },
          "429": { description: "Too many" },
        },
      },
    },

    "/admin/arr/storage": {
      get: {
        tags: ["Admin – Arr"],
        summary: "Every instance's root folders and disks (ADMIN)",
        description:
          "Root folders with free space, whether the arr can reach them, and unmapped folders (on disk, no title in the arr); " +
          "disks with free/total space. A root folder's total comes from the disk it sits on (neither arr reports it).",
        parameters: [ARR_SNAPSHOT_PARAM],
        responses: {
          "204": ARR_SNAPSHOT_204,
          "200": {
            description: "{ instances, errors, results: [{ service, instance, rootFolders, disks }] }",
            content: {
              "application/json": {
                schema: arrInstanceReport({
                  rootFolders: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "integer" },
                        path: { type: "string", description: "The root folder as the arr sees it (ADMIN-only)" },
                        accessible: { type: "boolean" },
                        freeSpace: { type: "number", nullable: true },
                        totalSpace: { type: "number", nullable: true, description: "The size of the disk the folder sits on; null when no disk holds it" },
                        unmappedFolders: { type: "array", items: { type: "object", properties: { name: { type: "string" }, path: { type: "string" } } }, description: "Folders in the root the arr has no title for (bounded; `unmappedCount` is the true count)" },
                        unmappedCount: { type: "integer" },
                      },
                    },
                  },
                  disks: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        path: { type: "string", description: "The mount as the arr sees it (ADMIN-only)" },
                        label: { type: "string", nullable: true },
                        freeSpace: { type: "number", nullable: true },
                        totalSpace: { type: "number", nullable: true },
                      },
                    },
                  },
                }),
              },
            },
          },
          "403": { description: "Not ADMIN" },
        },
      },
    },

    "/admin/notification-agents": {
      get: {
        tags: ["Admin – Settings"],
        summary: "List the outbound notification channels (ADMIN)",
        responses: {
          "200": {
            description: "Every configured channel",
            content: { "application/json": { schema: { type: "object", properties: { agents: { type: "array", items: NOTIFICATION_AGENT } } } } },
          },
        },
      },
      post: {
        tags: ["Admin – Settings"],
        summary: "Create a webhook, ntfy or Gotify channel (ADMIN)",
        description:
          "Channel URLs may point at the LAN; cloud-metadata addresses are refused at send time. A webhook " +
          "`template` is JSON with `{{field}}` placeholders and must render to valid JSON. At most 25 channels.",
        requestBody: { required: true, content: { "application/json": { schema: {
                type: "object",
                properties: {
                  kind: { type: "string", enum: [...AGENT_KINDS], description: "Create only — fixed afterwards." },
                  name: { type: "string", maxLength: 100 },
                  enabled: { type: "boolean" },
                  events: {
                    type: "array",
                    items: {
                      type: "string",
                      enum: [...NOTIFY_EVENT_KEYS],
                    },
                  },
                  config: { type: "object" },
                  secret: { type: "string", nullable: true, description: "Omit to keep the saved value, null or \"\" to clear. Gotify requires one." },
                },
              } } } },
        responses: {
          "201": {
            description: "Created — { agent } (the public shape GET lists: `hasSecret`, never the secret)",
            content: { "application/json": { schema: { type: "object", required: ["agent"], properties: { agent: NOTIFICATION_AGENT } } } },
          },
          "400": { description: "Invalid input, or the channel limit is reached" },
        },
      },
    },

    "/admin/notification-agents/{id}": {
      patch: {
        tags: ["Admin – Settings"],
        summary: "Update a channel (ADMIN)",
        description: "Fields left out keep their stored value. The kind cannot change.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { required: true, content: { "application/json": { schema: {
                type: "object",
                properties: {
                  kind: { type: "string", enum: [...AGENT_KINDS], description: "Create only — fixed afterwards." },
                  name: { type: "string", maxLength: 100 },
                  enabled: { type: "boolean" },
                  events: {
                    type: "array",
                    items: {
                      type: "string",
                      enum: [...NOTIFY_EVENT_KEYS],
                    },
                  },
                  config: { type: "object" },
                  secret: { type: "string", nullable: true, description: "Omit to keep the saved value, null or \"\" to clear. Gotify requires one." },
                },
              } } } },
        responses: {
          "200": {
            description: "Updated — { agent } (the public shape)",
            content: { "application/json": { schema: { type: "object", required: ["agent"], properties: { agent: NOTIFICATION_AGENT } } } },
          },
          "400": { description: "Invalid input, including an attempt to change the kind" },
          "404": { description: "No such channel" },
        },
      },
      delete: {
        tags: ["Admin – Settings"],
        summary: "Delete a channel (ADMIN)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Deleted — { ok: true }", content: { "application/json": { schema: OK_TRUE } } }, "404": { description: "No such channel" } },
      },
    },

    "/admin/notification-agents/{id}/test": {
      post: {
        tags: ["Admin – Settings"],
        summary: "Send a sample event to a channel now (ADMIN)",
        description: "One attempt, no retry — works even while the channel is disabled. Rate-limited to 10 a minute.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "Delivery outcome",
            content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" }, status: { type: "integer", nullable: true }, error: { type: "string", nullable: true } } } } },
          },
          "400": { description: "The channel's stored settings no longer validate — edit and save it again" },
          "404": { description: "No such channel" },
          "429": { description: "Too many test sends" },
        },
      },
    },

    "/admin/watch-grade/preview": {
      post: {
        tags: ["Admin – Users"],
        summary: "Preview how the watch grade spread would change with other settings (ADMIN)",
        description:
          "Grades every requester with the watch-grade settings in the body and with the ones in force, and " +
          "returns how many land on each letter. Nothing is written. The body is judged exactly as a " +
          "`PATCH /settings` of the same keys would be: the same per-key bounds and cross-field rules (window " +
          "longer than grace, cutoffs strictly descending), a key left out keeps its stored value, and a blank " +
          "one means the default.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  watchGradeGraceDays: { type: "string", pattern: "^\\d+$", description: "integer string 1–365; blank = the default" },
                  watchGradeWindowDays: { type: "string", pattern: "^\\d+$", description: "integer string 30–3650, or 0 for no limit; blank = the default" },
                  watchGradeTvPercent: { type: "string", pattern: "^\\d+$", description: "integer string 1–100; blank = the default" },
                  watchGradeOtherViewers: { type: "string", pattern: "^\\d+$", description: "integer string 1–100, or 0 to turn off; blank = the default" },
                  watchGradeBandA: { type: "string", pattern: "^\\d+$", description: "integer string 1–100; blank = the default" },
                  watchGradeBandB: { type: "string", pattern: "^\\d+$", description: "integer string 1–100; blank = the default" },
                  watchGradeBandC: { type: "string", pattern: "^\\d+$", description: "integer string 1–100; blank = the default" },
                  watchGradeBandD: { type: "string", pattern: "^\\d+$", description: "integer string 1–100; blank = the default" },
                  watchGradeMinRequests: { type: "string", pattern: "^\\d+$", description: "integer string 1–100; blank = the default" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Spread with the settings in force and with the proposed ones",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    enabled: { type: "boolean" },
                    reason: { type: "string", nullable: true, enum: ["feature-off", "tracking-off"] },
                    requesters: { type: "integer", description: "Accounts with at least one approved, fulfilled request" },
                    current: { $ref: "#/components/schemas/WatchGradeSpread" },
                    proposed: { $ref: "#/components/schemas/WatchGradeSpread" },
                  },
                },
              },
            },
          },
          "400": { description: "Malformed JSON, a non-object body, a non-string value, a value out of bounds, or a combination the settings save would refuse" },
          "403": { description: "Caller is not an ADMIN" },
          "413": { description: "Body over 16 KB" },
        },
      },
    },

    "/sync": {
      post: {
        tags: ["Admin – Sync"],
        summary: "Run the full sync orchestrator (admin session or CRON_SECRET)",
        description:
          "Always a FULL library replace. The body is not read — the `{ full: true }` flag " +
          "is parsed only by /sync/plex and /sync/jellyfin. Runs the Radarr/Sonarr refreshes " +
          "and then the Plex and Jellyfin arms concurrently, each fanning out over every " +
          "configured instance, so a single call covers both media servers.",
        security: ADMIN_OR_CRON_SECURITY,
        responses: {
          "200": {
            description:
              "Sync summary, or { skipped: true, reason: \"sync already running\" } when another " +
              "run holds the lock (X-Cron-Skipped). Also the response for a DEGRADED run (a " +
              "configured source failed). Neither is ever 5xx, because the container's cron " +
              "reschedules a non-2xx after CRON_RETRY_INTERVAL and a full library replace every " +
              "5 minutes during an outage is worse than a missed hour.",
            headers: {
              "X-Cron-Degraded": {
                description: "Comma-separated failed sources (\"wind-down\" for a run that stopped early). Present only on a degraded run.",
                schema: { type: "string" },
              },
            },
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    checked: { type: "object", properties: { approved: { type: "integer" }, available: { type: "integer" } } },
                    marked: { type: "integer", description: "Radarr/Sonarr-driven marks only; library marks are in plexMarked/jellyfinMarked" },
                    reverted: { type: "integer" },
                    repushed: { type: "integer" },
                    plexMarked: { type: "integer" },
                    jellyfinMarked: { type: "integer", description: "Counted off the SAME pending snapshot as plexMarked, so a title on both servers appears in both — do not sum them" },
                    radarrWanted: { type: "integer" },
                    sonarrWanted: { type: "integer" },
                    failedSources: {
                      type: "array",
                      items: { type: "string", enum: ["radarr", "sonarr", "plex", "jellyfin"] },
                      description: "Sources that ARE configured and failed. Omitted when empty.",
                    },
                    skippedSources: {
                      type: "array",
                      items: { type: "string", enum: ["radarr", "sonarr", "plex", "jellyfin"] },
                      description:
                        "Sources not configured (or feature-disabled) and therefore never attempted. " +
                        "Omitted when empty. Needed because the counts cannot express it: an " +
                        "unconfigured server and a configured one that matched nothing both report 0.",
                    },
                    error: { type: "string", description: "Present only on a degraded run, alongside failedSources." },
                    skipped: { type: "boolean", description: "true when another sync held the advisory lock. Every count field is then ABSENT." },
                    reason: { type: "string" },
                    windDown: {
                      type: "boolean",
                      description:
                        "true when the run lost its lock and stopped at a step boundary: only checked, marked, " +
                        "reverted and repushed are present, `error` is set and X-Cron-Degraded is \"wind-down\".",
                    },
                  },
                },
              },
            },
          },
          "403": { description: "Neither an admin session nor a valid CRON_SECRET" },
        },
      },
    },
    "/sync/plex": {
      get: {
        tags: ["Admin – Sync"],
        summary: "Poll a background Plex resync (ADMIN)",
        description: "The answer of a resync started with `async: true`, for the admin who started it. A CRON_SECRET caller has no jobs.",
        parameters: [
          { name: "job", in: "query", required: true, schema: { type: "string", pattern: "^[0-9a-f]{32}$" }, description: "The job id from the POST's 202" },
        ],
        responses: {
          "200": {
            description: "The finished resync's own answer (any of the POST's statuses and bodies)",
            content: { "application/json": { schema: LIBRARY_RESYNC_ANSWER } },
          },
          "202": jobAnswer("Still running: { job, running: true }", JOB_RUNNING),
          "403": { description: "Not an admin session" },
          "404": { description: "{ error } — the job is unknown: expired, another admin's, or dropped by a restart" },
        },
      },
      post: {
        tags: ["Admin – Sync"],
        summary: "Sync Plex library",
        description:
          "Resyncs ONE Plex server (the default unless the body names `instance`). Default is incremental (`recentOnly`: insert-only inside a 2-hour window); `full: true` deletes and repopulates that server's rows only. " +
          "With more than one Plex server registered the shared TVEpisodeCache is left to /sync.",
        security: ADMIN_OR_CRON_SECURITY,
        requestBody: { required: false, content: { "application/json": { schema: { type: "object", properties: {
          full: { type: "boolean", description: "Only `true` selects the full replace; anything else is incremental" },
          instance: { type: "string", description: "Registered Plex instance slug; absent = the default server" },
          async: { type: "boolean", description: "Admin session only: run as a background job — 202 { job } at once, poll GET ?job=. Default (and always for CRON_SECRET): synchronous" },
        } } } } },
        responses: {
          "200": {
            description: "{ scanned: { movies, tv }, checked, marked, full }; or { skipped: true, reason } with X-Cron-Skipped when a Plex resync is already running",
            content: { "application/json": { schema: LIBRARY_RESYNC_ANSWER } },
          },
          "202": jobAnswer("{ job } — `async: true` from an admin: the resync runs in the background", JOB_STARTED),
          "400": { description: "Malformed or unregistered `instance`, or Plex not configured" },
          "403": { description: "Neither an admin session nor a valid CRON_SECRET" },
          "502": { description: "The Plex library could not be fetched" },
          "503": { description: "{ error } — the run lost its lock and stopped before writing" },
        },
      },
    },
    "/sync/jellyfin": {
      get: {
        tags: ["Admin – Sync"],
        summary: "Poll a background Jellyfin resync (ADMIN)",
        description: "The answer of a resync started with `async: true`, for the admin who started it. A CRON_SECRET caller has no jobs.",
        parameters: [
          { name: "job", in: "query", required: true, schema: { type: "string", pattern: "^[0-9a-f]{32}$" }, description: "The job id from the POST's 202" },
        ],
        responses: {
          "200": {
            description: "The finished resync's own answer (any of the POST's statuses and bodies)",
            content: { "application/json": { schema: LIBRARY_RESYNC_ANSWER } },
          },
          "202": jobAnswer("Still running: { job, running: true }", JOB_RUNNING),
          "403": { description: "Not an admin session" },
          "404": { description: "{ error } — the job is unknown: expired, another admin's, or dropped by a restart" },
        },
      },
      post: {
        tags: ["Admin – Sync"],
        summary: "Sync Jellyfin library",
        description:
          "Resyncs ONE Jellyfin server (the default unless the body names `instance`). Default is incremental (`recentOnly`: insert-only inside a 2-hour MinDateLastSaved window); `full: true` deletes and repopulates that server's rows only.",
        security: ADMIN_OR_CRON_SECURITY,
        requestBody: { required: false, content: { "application/json": { schema: { type: "object", properties: {
          full: { type: "boolean", description: "Only `true` selects the full replace; anything else is incremental" },
          instance: { type: "string", description: "Registered Jellyfin instance slug; absent = the default server" },
          async: { type: "boolean", description: "Admin session only: run as a background job — 202 { job } at once, poll GET ?job=. Default (and always for CRON_SECRET): synchronous" },
        } } } } },
        responses: {
          "200": {
            description: "{ scanned: { movies, tv }, checked, marked, full }; or { skipped: true, reason } with X-Cron-Skipped when a Jellyfin resync is already running",
            content: { "application/json": { schema: LIBRARY_RESYNC_ANSWER } },
          },
          "202": jobAnswer("{ job } — `async: true` from an admin: the resync runs in the background", JOB_STARTED),
          "400": { description: "Malformed or unregistered `instance`, or Jellyfin not configured" },
          "403": { description: "Neither an admin session nor a valid CRON_SECRET" },
          "502": { description: "The Jellyfin library could not be fetched" },
          "503": { description: "{ error } — the run lost its lock and stopped before writing" },
        },
      },
    },
    "/sync/radarr": {
      post: {
        tags: ["Admin – Sync"],
        summary: "Sync Radarr wanted/available items",
        security: ADMIN_OR_CRON_SECURITY,
        responses: {
          "200": {
            description: "{ wanted, available }; with `failedInstances` (and the X-Cron-Degraded header) when a named instance failed and kept its rows",
            content: { "application/json": { schema: ARR_CACHE_SYNC_RESULT } },
          },
          "403": { description: "Neither an admin session nor a valid CRON_SECRET" },
          "502": { description: "{ error }, or { skipped: true, reason: \"arr-unavailable\" } when the default instance's fetch failed" },
        },
      },
    },
    "/sync/sonarr": {
      post: {
        tags: ["Admin – Sync"],
        summary: "Sync Sonarr wanted/available items",
        security: ADMIN_OR_CRON_SECURITY,
        responses: {
          "200": {
            description: "{ wanted, available }; with `failedInstances` (and the X-Cron-Degraded header) when a named instance failed and kept its rows",
            content: { "application/json": { schema: ARR_CACHE_SYNC_RESULT } },
          },
          "403": { description: "Neither an admin session nor a valid CRON_SECRET" },
          "502": { description: "{ error }, or { skipped: true, reason: \"arr-unavailable\" } when the default instance's fetch failed" },
        },
      },
    },
    "/sync/upcoming": {
      post: {
        tags: ["Admin – Sync"],
        summary: "Sync upcoming releases from TMDB",
        security: ADMIN_OR_CRON_SECURITY,
        responses: {
          "200": {
            description: "{ movies, tv, total, errors, durationMs, calendar, error? } — a partial failure still answers 200 with `X-Cron-Degraded: movies|tv`; or { skipped: true, reason: \"already running\" } (X-Cron-Skipped)",
            content: {
              "application/json": {
                schema: cronRunOrSkip({
                  type: "object",
                  required: ["movies", "tv", "total", "errors", "durationMs", "calendar"],
                  properties: {
                    movies: { type: "integer" },
                    tv: { type: "integer" },
                    total: { type: "integer", description: "Rows written" },
                    errors: { type: "integer", description: "TMDB fetches (movies, TV) that failed" },
                    durationMs: CRON_RUN_FIELDS.durationMs,
                    calendar: {
                      type: "object",
                      nullable: true,
                      description: "The iCal release-date cache warm (null when it failed)",
                      properties: {
                        skipped: { type: "string", enum: ["disabled"] },
                        titles: { type: "integer" },
                        fetched: { type: "integer" },
                        failed: { type: "integer" },
                        aborted: { type: "boolean" },
                      },
                    },
                    error: { type: "string", description: "Only when one media type failed (X-Cron-Degraded)" },
                  },
                }),
              },
            },
          },
          "403": { description: "Neither an admin session nor a valid CRON_SECRET" },
          "502": { description: "Every TMDB fetch failed and nothing was written" },
        },
      },
    },
    "/sync/ratings": {
      post: {
        tags: ["Admin – Sync"],
        summary: "Sync external ratings cache",
        security: ADMIN_OR_CRON_SECURITY,
        responses: {
          "200": {
            description: "{ total, warmed, skipped, quotaExhausted, durationMs } (X-Cron-Degraded when the TMDB pool was partial or empty); or { skipped: true, reason } — \"already running\" with X-Cron-Skipped (not recorded as a run), or \"no ratings API key configured\" WITHOUT the header (recorded as a run, so the cron dashboard's last run still moves). Here `skipped` is a number on a run and `true` on a skip",
            content: {
              "application/json": {
                schema: cronRunOrSkip({
                  type: "object",
                  required: ["total", "warmed", "skipped", "quotaExhausted", "durationMs"],
                  properties: {
                    total: { type: "integer" },
                    warmed: { type: "integer" },
                    skipped: { type: "integer", description: "A number on a run (`true` only on a skip)" },
                    quotaExhausted: { type: "boolean" },
                    durationMs: CRON_RUN_FIELDS.durationMs,
                  },
                }),
              },
            },
          },
          "403": { description: "Neither an admin session nor a valid CRON_SECRET" },
        },
      },
    },
    "/sync/play-history": {
      post: {
        tags: ["Admin – Sync"],
        summary: "Ingest play history from Plex / Jellyfin",
        security: ADMIN_OR_CRON_SECURITY,
        responses: {
          "200": {
            description: "An object keyed by source and server (`plex`, `plex:<slug>`, `jellyfin`, `jellyfin:<slug>`), each { started, updated, ended } or { error }; a failed source sets `X-Cron-Degraded` (status stays 200). `purged` (a number) appears when the hourly retention purge ran; a failed after-sync step (the now-playing snapshot, the stale-session cleanup or the retention purge) adds `post-sync:snapshot|cleanup|retention` = { error } and is reported in X-Cron-Degraded too. Or { message } while play history tracking is disabled",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  description:
                    "A map with one entry per media server polled (`plex`, `plex:<slug>`, `jellyfin`, `jellyfin:<slug>`) and per failed after-sync step (`post-sync:<step>`), so its keys depend on the servers configured",
                  properties: {
                    purged: { type: "integer", description: "Rows the hourly retention purge deleted; present only when it ran and deleted some" },
                    message: { type: "string", description: "Only while play history tracking is disabled — then the only key" },
                  },
                  additionalProperties: {
                    type: "object",
                    description: "A server's { started, updated, ended } session counts, or { error } when it (or the after-sync step) failed",
                    properties: {
                      started: { type: "integer" },
                      updated: { type: "integer" },
                      ended: { type: "integer" },
                      error: { type: "string" },
                    },
                  },
                },
              },
            },
          },
          "403": { description: "Neither an admin session nor a valid CRON_SECRET" },
          "429": { description: "More than 30 runs a minute from one client IP" },
          "500": { description: "{ error: \"Sync failed\" }" },
        },
      },
    },
    "/sync/tv-episodes": {
      post: {
        tags: ["Admin – Sync"],
        summary: "Sync TV episode cache from TMDB",
        security: ADMIN_OR_CRON_SECURITY,
        description: "Rebuilds the shared TVEpisodeCache from the UNION of every configured server of each type, all-or-nothing: a type with any failed server is left untouched and named in `skipped`.",
        responses: {
          "200": {
            description: "{ plex, jellyfin, skipped, errors, … } — episode counts written per source",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["plex", "jellyfin", "errors", "skipped"],
                  properties: {
                    plex: { type: "integer", description: "Episodes written for Plex (0 when skipped or not configured)" },
                    jellyfin: { type: "integer", description: "Episodes written for Jellyfin (0 when skipped or not configured)" },
                    errors: { type: "array", items: { type: "string" }, description: "One per failed server, prefixed with the server" },
                    skipped: {
                      type: "array",
                      items: { type: "string", enum: ["plex", "jellyfin"] },
                      description: "Types left untouched because one of their servers failed",
                    },
                  },
                },
              },
            },
          },
          "403": { description: "Neither an admin session nor a valid CRON_SECRET" },
        },
      },
    },

    "/admin/stats": {
      get: {
        tags: ["Admin – Stats"],
        summary: "System statistics (ADMIN)",
        description:
          "All-time aggregates, shared with the /admin/stats page (src/lib/admin-stats-data.ts). `users` counts accounts that can sign in (disabled ones excluded). `library.plex`/`library.jellyfin` are distinct titles per service; `library.unique` is distinct titles across every server. `avgFulfillmentHours` is request → available over APPROVED requests only (copies created already-available and library-marked unapproved requests are excluded). `requestsByMonth` always holds the last 12 calendar months (UTC), zero months included. `diskSpace.unreachable` lists configured instances whose diskspace call failed. `fulfillment` (median/p90 seconds for approve, download and total), `pendingQueue` and `stuckRequests` are additive.",
        responses: {
          "200": {
            description: "Aggregate stats across requests, users, library, issues and storage",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    requests: { type: "object", additionalProperties: { type: "integer" } },
                    users: { type: "integer" },
                    library: {
                      type: "object",
                      properties: {
                        plex: { type: "integer", description: "Distinct Plex titles (movies + series)" },
                        jellyfin: { type: "integer", description: "Distinct Jellyfin titles (movies + series)" },
                        plexBreakdown: ADMIN_STATS_SERVER_BREAKDOWN,
                        jellyfinBreakdown: ADMIN_STATS_SERVER_BREAKDOWN,
                        unique: { type: "object", description: "Distinct titles across every server", properties: { movies: { type: "integer" }, series: { type: "integer" } } },
                      },
                    },
                    issues: {
                      type: "object",
                      properties: { total: { type: "integer" }, open: { type: "integer" }, inProgress: { type: "integer" } },
                    },
                    avgFulfillmentHours: { type: "number", nullable: true },
                    requestsByMonth: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          month: { type: "string", example: "2026-10" },
                          count: { type: "integer" },
                          byStatus: { type: "object", additionalProperties: { type: "integer" } },
                        },
                      },
                    },
                    topRequesters: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          name: { type: "string", nullable: true },
                          email: { type: "string" },
                          count: { type: "integer" },
                          available: { type: "integer" },
                          declined: { type: "integer" },
                        },
                      },
                    },
                    recentRequests: {
                      type: "array",
                      description: "The 10 newest requests",
                      items: {
                        type: "object",
                        properties: {
                          title: { type: "string" },
                          mediaType: { $ref: "#/components/schemas/MediaType" },
                          status: { $ref: "#/components/schemas/RequestStatus" },
                          createdAt: { type: "string", format: "date-time" },
                        },
                      },
                    },
                    diskSpace: {
                      type: "object",
                      properties: {
                        radarr: { type: "array", nullable: true, items: ADMIN_STATS_DISK, description: "The default Radarr; null when it isn't configured, enabled or reachable" },
                        sonarr: { type: "array", nullable: true, items: ADMIN_STATS_DISK, description: "The default Sonarr; as radarr" },
                        extra: {
                          type: "array",
                          description: "The 4K/named instances",
                          items: {
                            type: "object",
                            properties: { service: ARR_SERVICE, slug: { type: "string" }, label: { type: "string" }, entries: { type: "array", items: ADMIN_STATS_DISK } },
                          },
                        },
                        unreachable: {
                          type: "array",
                          items: { type: "object", properties: { service: ARR_SERVICE, slug: { type: "string" }, label: { type: "string" } } },
                        },
                      },
                    },
                    fulfillment: {
                      type: "object",
                      properties: {
                        approve: { ...ADMIN_STATS_DURATION, description: "Request → admin approval (auto-approvals and unknown approval times left out)" },
                        download: { ...ADMIN_STATS_DURATION, description: "Approval → available" },
                        total: {
                          type: "object",
                          description: "Request → available, approved requests only",
                          properties: { ...ADMIN_STATS_DURATION.properties, avgSeconds: { type: "number", nullable: true } },
                        },
                        autoApproved: { type: "integer" },
                        adminApproved: { type: "integer" },
                        byMediaType: {
                          type: "object",
                          description: "Keyed MOVIE / TV",
                          additionalProperties: { type: "object", properties: { download: ADMIN_STATS_DURATION, total: ADMIN_STATS_DURATION } },
                        },
                      },
                    },
                    pendingQueue: {
                      type: "object",
                      description: "Requests awaiting a decision (PENDING and never approved)",
                      properties: {
                        requests: { type: "integer" },
                        titles: { type: "integer" },
                        oldestCreatedAt: { type: "string", format: "date-time", nullable: true },
                        olderThanWarn: { type: "integer" },
                        olderThanAlert: { type: "integer" },
                      },
                    },
                    stuckRequests: {
                      type: "object",
                      properties: {
                        "push-failed": { type: "integer" },
                        "not-in-arr": { type: "integer" },
                        "slow-download": { type: "integer" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },

    "/admin/audit-log": {
      delete: {
        tags: ["Admin – Audit Log"],
        summary: "Scrub PII from audit rows past the retention cutoff (ADMIN)",
        description:
          "Manual equivalent of the scrub-audit-pii cron. Nulls ipAddress/userAgent and redacts userName on every row older than auditPiiRetentionDays (default 90); additionally nulls details on AUTH_LOGIN, AUTH_LOGIN_FAILED and AUTH_LOGOUT rows. Takes no body and no parameters.",
        responses: {
          "200": {
            description: "Scrub counts",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    scrubbed: { type: "integer" },
                    detailsScrubbed: { type: "integer" },
                    cutoff: { type: "string", format: "date-time" },
                    retentionDays: { type: "integer" },
                  },
                },
              },
            },
          },
          "403": { description: "Forbidden — ADMIN only" },
        },
      },
      get: {
        tags: ["Admin – Audit Log"],
        summary: "Audit log, keyset-paginated (ADMIN)",
        description:
          "Cursor (keyset) pagination — there is no page or offset parameter. Pass the previous response's nextCursor back as `cursor`; that row itself is skipped. Ordered createdAt DESC, id DESC.",
        parameters: [
          { name: "pageSize", in: "query", schema: { type: "integer", default: 50, minimum: 1, maximum: 50 } },
          { name: "cursor", in: "query", schema: { type: "string" }, description: "AuditLog id from the previous response's nextCursor; exclusive" },
          { name: "action", in: "query", schema: { type: "string" }, description: "Exact AuditAction value. Takes precedence over `group`; an unrecognized value is ignored." },
          { name: "group", in: "query", schema: { type: "string", enum: ["auth", "admin", "system"] }, description: "Coarse action bucket, ignored when a valid `action` is given" },
          { name: "dateFrom", in: "query", schema: { type: "string", format: "date" }, description: "createdAt >= this date; an unparseable value is a 400" },
          { name: "dateTo", in: "query", schema: { type: "string", format: "date" }, description: "Inclusive end date (compared as < dateTo + 1 UTC day); an unparseable value is a 400" },
          { name: "user", in: "query", schema: { type: "string" }, description: "Case-insensitive substring match on userName — the display name, NOT the user id" },
          { name: "target", in: "query", schema: { type: "string" }, description: "Case-insensitive substring match on target" },
          { name: "hideCron", in: "query", schema: { type: "string", enum: ["1"] }, description: "Hide the `system` principal. Rows with a NULL userId (e.g. the machine-session mint) are deliberately kept." },
        ],
        responses: {
          "200": {
            description: "Audit log page",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    logs: {
                      type: "array",
                      description: "Full AuditLog rows",
                      items: AUDIT_LOG_ROW,
                    },
                    nextCursor: { type: "string", nullable: true },
                    hasMore: { type: "boolean" },
                  },
                },
              },
            },
          },
          "400": { description: "Unparseable dateFrom or dateTo" },
          "403": { description: "Forbidden — ADMIN only" },
          "429": { description: "Rate limited (60/min per admin)" },
        },
      },
    },
    "/admin/audit-log/export": {
      get: {
        tags: ["Admin – Audit Log"],
        summary: "Export audit log as CSV or JSON (ADMIN)",
        description: "Streams up to 100,000 rows, newest first, and writes an AUDIT_LOG_EXPORT audit row before the stream starts. A capped export carries `X-Export-Truncated: true` and `X-Export-Limit`. 3 exports per hour per admin.",
        parameters: [
          { name: "format", in: "query", schema: { type: "string", enum: ["csv", "json"], default: "csv" }, description: "Anything but `json` is CSV" },
          { name: "action", in: "query", schema: { type: "string" }, description: "Exact AuditAction; takes precedence over `group`; unrecognized values are ignored" },
          { name: "group", in: "query", schema: { type: "string", enum: ["auth", "admin", "system"] } },
          { name: "dateFrom", in: "query", schema: { type: "string", format: "date" }, description: "Unparseable → 400" },
          { name: "dateTo", in: "query", schema: { type: "string", format: "date" }, description: "Inclusive end date; unparseable → 400" },
          { name: "user", in: "query", schema: { type: "string" }, description: "Substring match on userName" },
          { name: "target", in: "query", schema: { type: "string" } },
          { name: "hideCron", in: "query", schema: { type: "string", enum: ["1"] } },
        ],
        responses: {
          "200": {
            description: "CSV (text/csv) or JSON array download",
            headers: { "X-Export-Truncated": { schema: { type: "string", enum: ["true"] }, description: "Present only when more than 100,000 rows matched" } },
            content: {
              "text/csv": {
                schema: {
                  type: "string",
                  description:
                    "Header row `id,createdAt,userId,userName,action,target,details,ipAddress,userAgent,provider`, then one row per entry. " +
                    "A capped export ends with a `# truncated: …` line.",
                },
              },
              "application/json": { schema: { type: "array", items: AUDIT_LOG_ROW, description: "`format=json`: every matching row, newest first" } },
            },
          },
          "400": { description: "Unparseable dateFrom or dateTo" },
          "403": { description: "Forbidden — ADMIN only" },
          "429": { description: "More than 3 exports in an hour" },
          "500": { description: "{ error } — counting the matching rows failed; nothing was streamed" },
        },
      },
    },

    "/admin/backup/db-export": {
      get: {
        tags: ["Admin – Backup"],
        summary: "Export encrypted database backup (ADMIN)",
        description: "Streams the whole database as an AES-encrypted SQL dump (key from the BACKUP_DB_PASSWORD env var, at least 12 characters). Audited BACKUP_EXPORT (the row records how the export ended). 5 per hour per admin; one export at a time.",
        responses: {
          "200": {
            description: "Encrypted dump, application/octet-stream, attachment `summonarr-full-backup-<date>.sql.enc`",
            content: { "application/octet-stream": { schema: { type: "string", format: "binary", description: "The AES-encrypted SQL dump (key from BACKUP_DB_PASSWORD) — restore it with POST /admin/backup/db-import" } } },
          },
          "409": { description: "Another export is still streaming" },
          "429": { description: "More than 5 exports in an hour" },
          "503": { description: "BACKUP_DB_PASSWORD is unset or shorter than 12 characters" },
        },
      },
    },
    "/admin/backup/db-import": {
      post: {
        tags: ["Admin – Backup"],
        summary: "Import database backup (ADMIN)",
        description: "DESTRUCTIVE: truncates and replaces the database from an encrypted dump. The body is the raw encrypted dump bytes (not multipart), at most BACKUP_MAX_RESTORE_MB (default 4096 MB) plus 4 KB. The dump's schema fingerprint must match this server's. Audited BACKUP_IMPORT, failed attempts included. 5 per hour per admin.",
        requestBody: {
          required: true,
          content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
        },
        responses: {
          "200": {
            description: "{ ok: true, summary: { total, executed, skipped, errors }, warning? }; or, when statements failed, { ok: false, summary, errors } (status 200)",
            content: {
              "application/json": {
                schema: {
                  oneOf: [
                    {
                      type: "object",
                      required: ["ok", "summary"],
                      properties: {
                        ok: { type: "boolean", enum: [true] },
                        summary: BACKUP_IMPORT_SUMMARY,
                        warning: { type: "string", description: "Present when the restore landed with something to check (e.g. rows dropped on conflict)" },
                      },
                    },
                    {
                      type: "object",
                      required: ["ok", "errors"],
                      properties: {
                        ok: { type: "boolean", enum: [false] },
                        summary: BACKUP_IMPORT_SUMMARY,
                        errors: { type: "array", items: { type: "string" }, description: "Why each refused or failed statement failed — may quote the start of its SQL" },
                      },
                    },
                  ],
                },
              },
            },
          },
          "400": { description: "Empty body, not an encrypted Summonarr dump, or unreadable" },
          "409": { description: "Schema fingerprint mismatch — nothing touched" },
          "413": { description: "Body (or decrypted SQL) over the size cap" },
          "429": { description: "More than 5 restores in an hour" },
          "500": { description: "Restore failed" },
          "503": { description: "BACKUP_DB_PASSWORD is unset or shorter than 12 characters" },
        },
      },
    },

    "/admin/debug/arr-state": {
      get: {
        tags: ["Admin – Debug"],
        summary: "Dump full ARR pipeline state for a title (ADMIN)",
        parameters: [
          { name: "tmdbId", in: "query", required: true, schema: { type: "integer" } },
          { name: "type", in: "query", required: true, schema: { type: "string", enum: ["movie", "tv"] } },
        ],
        responses: {
          "200": {
            description:
              "Cache rows, live ARR check, tvdb→tmdb mapping, wanted-table counts, last LIBRARY_SYNC audit row. For type=tv each instance also carries liveCompletion — Sonarr's aired-episode counts (specials excluded) and whether the series reads complete, which is the sole condition for a TV request to flip AVAILABLE.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  description: "A curl-oriented diagnostic dump; every key below is always present. `lastFullSync.details` is the LIBRARY_SYNC audit row's own details, passed through as stored.",
                  required: ["query", "cacheTable", "fourK", "instances", "attachArrPendingReturns", "liveArrApi", "mediaRequests", "tvdbInfo", "wantedTableTotals", "lastFullSync"],
                  properties: {
                    query: { type: "object", properties: { tmdbId: { type: "integer" }, type: { type: "string", enum: ["movie", "tv"] } } },
                    cacheTable: {
                      type: "object",
                      description: "The default instance's wanted-table row",
                      properties: {
                        tableName: { type: "string", enum: ["radarrWantedItem", "sonarrWantedItem"] },
                        row: DEBUG_WANTED_ROW,
                        hasEntry: { type: "boolean" },
                      },
                    },
                    fourK: {
                      type: "object",
                      description: "The legacy 4K instance, derived from `instances`",
                      properties: {
                        instanceConfigured: { type: "boolean" },
                        cacheRow: DEBUG_WANTED_ROW,
                        hasEntry: { type: "boolean" },
                        liveArrApi: { ...DEBUG_LIVE_CHECK, nullable: true, description: "null when no 4K instance is configured" },
                      },
                    },
                    instances: {
                      type: "array",
                      description: "Every configured instance of the service, the default first",
                      items: {
                        type: "object",
                        properties: {
                          slug: { type: "string" },
                          name: { type: "string" },
                          cacheRow: DEBUG_WANTED_ROW,
                          hasEntry: { type: "boolean" },
                          liveArrApi: DEBUG_LIVE_CHECK,
                          liveCompletion: {
                            type: "object",
                            description:
                              "type=tv only. Sonarr's aired-episode counts (specials excluded) — { tvdbId, episodeFileCount, episodeCount, complete, basis } — " +
                              "or { result: null, error? } when Sonarr doesn't know the series or the check failed",
                            properties: {
                              tvdbId: { type: "integer" },
                              episodeFileCount: { type: "integer" },
                              episodeCount: { type: "integer" },
                              complete: { type: "boolean" },
                              basis: { type: "string", enum: ["seasons", "series"], description: "`series`: no per-season stats, so specials could not be excluded" },
                              result: { type: "boolean", nullable: true, description: "Always null: present only on the not-known / failed shape" },
                              error: { type: "string" },
                            },
                          },
                        },
                      },
                    },
                    attachArrPendingReturns: { type: "boolean" },
                    liveArrApi: DEBUG_LIVE_CHECK,
                    mediaRequests: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          status: { $ref: "#/components/schemas/RequestStatus" },
                          requestedBy: { type: "string" },
                          tvdbId: { type: "integer", nullable: true },
                          createdAt: { type: "string", format: "date-time" },
                          updatedAt: { type: "string", format: "date-time" },
                        },
                      },
                    },
                    tvdbInfo: {
                      type: "object",
                      nullable: true,
                      description: "type=tv only (null for a movie): the tvdb id the instances resolved and the stored tvdb→tmdb mapping, read directly so an expired negative entry still shows",
                      properties: {
                        tvdbId: { type: "integer", nullable: true },
                        tvdbIdInstance: { type: "string" },
                        cachedMapping: { type: "object", nullable: true, properties: { tmdbId: { type: "integer", nullable: true } }, description: "{ tmdbId: null } is a genuine negative mapping" },
                        cachedMappingRow: {
                          type: "object",
                          nullable: true,
                          properties: {
                            data: { type: "string", description: "The cache row's JSON text" },
                            cachedAt: { type: "string", format: "date-time" },
                            expiresAt: { type: "string", format: "date-time" },
                            stale: { type: "boolean" },
                          },
                        },
                        error: { type: "string" },
                      },
                    },
                    wantedTableTotals: { type: "object", properties: { radarr: { type: "integer" }, sonarr: { type: "integer" } } },
                    lastFullSync: {
                      type: "object",
                      nullable: true,
                      properties: {
                        at: { type: "string", format: "date-time" },
                        details: { description: "The audit row's details — parsed JSON, or the raw text when it doesn't parse" },
                      },
                    },
                  },
                },
              },
            },
          },
          "400": { description: "tmdbId (a positive integer) and type=movie|tv are required" },
        },
      },
    },

    "/admin/debug/ratings-state": {
      get: {
        tags: ["Admin – Debug"],
        summary: "Dump full ratings pipeline state for a title (ADMIN)",
        parameters: [
          { name: "tmdbId", in: "query", required: true, schema: { type: "integer" } },
          { name: "type", in: "query", required: true, schema: { type: "string", enum: ["movie", "tv"] } },
          { name: "live", in: "query", schema: { type: "string" }, description: "Set to 1 for an opt-in live fetchUnifiedRatings probe" },
        ],
        responses: {
          "200": {
            description: "Provider-configured flags, MDBList/OMDB quota-lockout state, raw ratings cache rows, details-cache rating fields, optional live probe",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  description: "A curl-oriented diagnostic dump. `cache.*.data` is the cached provider payload, passed through as stored; never an API key (only whether one is set).",
                  required: ["query", "now", "providers", "lockouts", "mdblistUsage", "cache", "details"],
                  properties: {
                    query: { type: "object", properties: { tmdbId: { type: "integer" }, type: { type: "string", enum: ["movie", "tv"] }, live: { type: "boolean" } } },
                    now: { type: "string", format: "date-time" },
                    providers: {
                      type: "object",
                      description: "Whether each provider's key (Trakt: client id) is set",
                      properties: { mdblist: { type: "boolean" }, omdb: { type: "boolean" }, trakt: { type: "boolean" } },
                    },
                    lockouts: { type: "object", properties: { mdblistQuotaLocked: { type: "boolean" }, omdbQuotaLocked: { type: "boolean" } } },
                    mdblistUsage: {
                      type: "object",
                      description: "The MDBList daily budget (MdblistUsageSnapshot, src/lib/mdblist.ts)",
                      properties: {
                        plan: { type: "string", enum: MDBLIST_PLAN_CHOICES, description: "The plan picked in Settings (`auto` = MDBList's own reported limit)" },
                        reportedLimit: { type: "integer", nullable: true, description: "The daily limit MDBList last reported" },
                        reportedPlan: { type: "string", nullable: true, enum: MDBLIST_PLANS.map((p) => p.id), description: "The plan that limit matches, if any" },
                        usedToday: { type: "integer", nullable: true },
                        limit: { type: "integer", nullable: true },
                        remaining: { type: "integer", nullable: true },
                        reserve: { type: "integer", description: "What background jobs leave for pages" },
                        backgroundStopped: { type: "boolean" },
                        pausedUntil: { type: "string", format: "date-time", nullable: true },
                        pauseReason: { type: "string", nullable: true },
                      },
                    },
                    cache: {
                      type: "object",
                      properties: { mdblist: DEBUG_RATINGS_CACHE_ROW, omdb: DEBUG_RATINGS_CACHE_ROW },
                    },
                    details: {
                      type: "object",
                      description: "The title's TMDB details-cache row, rating fields only",
                      properties: {
                        key: { type: "string" },
                        exists: { type: "boolean" },
                        cachedAt: { type: "string", format: "date-time", nullable: true },
                        expiresAt: { type: "string", format: "date-time", nullable: true },
                        stale: { type: "boolean" },
                        fields: {
                          type: "object",
                          nullable: true,
                          description: "A field absent here was never fetched into the row; null is an authoritative \"no rating\"",
                          properties: {
                            ...RATING_FIELDS,
                            releasedDigital: { type: "string", nullable: true },
                            certification: { type: "string" },
                            releaseDate: { type: "string", nullable: true },
                          },
                        },
                      },
                    },
                    live: {
                      type: "object",
                      description: "`live=1` only: the real single-title fetch, which writes the caches like any read, or { error } when it failed",
                      properties: {
                        found: { type: "boolean" },
                        keyConfigured: { type: "boolean" },
                        transient: { type: "boolean" },
                        quotaExhausted: { type: "boolean" },
                        data: { type: "object", properties: RATING_FIELDS },
                        error: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
          "400": { description: "tmdbId (a positive integer in range) and type=movie|tv are required" },
        },
      },
    },

    "/admin/debug/history-link": {
      get: {
        tags: ["Admin – Debug"],
        summary: "Dump play-history attribution state for an account (ADMIN)",
        description:
          "Why a user's watch history is empty: the account's three identity columns, every candidate MediaServerUser row with per-row matchesFk / matchesSubject / visibleToUser verdicts, the resolved id list, and any orphaned server identities holding history the account cannot see. Pass exactly one of userId or email.",
        parameters: [
          { name: "userId", in: "query", schema: { type: "string" }, description: "Summonarr User id (mutually exclusive with email)" },
          { name: "email", in: "query", schema: { type: "string" }, description: "Account email (mutually exclusive with userId)" },
        ],
        responses: {
          "200": {
            description: "Identity columns, candidate MediaServerUser rows with match verdicts, resolved ids, orphanedWithHistory",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  description: "A curl-oriented diagnostic dump. `allServerIdentities` is present only when no candidate matched.",
                  required: ["user", "resolvedMediaServerUserIds", "visibleHistoryRows", "candidates", "orphanedWithHistory"],
                  properties: {
                    user: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        email: { type: "string", nullable: true },
                        name: { type: "string", nullable: true },
                        plexUserId: { type: "string", nullable: true },
                        jellyfinUserId: { type: "string", nullable: true },
                        hasProviderSubject: { type: "boolean", description: "false: only the MediaServerUser FK can link this account to its history" },
                        deactivatedAt: { type: "string", format: "date-time", nullable: true },
                        purgedAt: { type: "string", format: "date-time", nullable: true },
                        isPurgedTombstone: { type: "boolean", description: "A scrubbed old record, never the account the person signs in with today" },
                      },
                    },
                    resolvedMediaServerUserIds: { type: "array", items: { type: "string" }, description: "What the watch-history readers resolve for this account" },
                    visibleHistoryRows: { type: "integer" },
                    candidates: {
                      type: "array",
                      description: "Every MediaServerUser linked to the account or matching its provider subject or email, with the matcher verdicts",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          source: { type: "string", enum: ["plex", "jellyfin"] },
                          sourceUserId: { type: "string" },
                          username: { type: "string" },
                          email: { type: "string", nullable: true },
                          userId: { type: "string", nullable: true },
                          manualUserLink: { type: "boolean" },
                          active: { type: "boolean" },
                          playHistoryRows: { type: "integer" },
                          matchesFk: { type: "boolean" },
                          matchesSubject: { type: "boolean" },
                          subjectSuppressedByPin: { type: "boolean", description: "The subject matches but an admin's manual pin hides it (guardrail 34)" },
                          visibleToUser: { type: "boolean" },
                          emailWouldRelink: { type: "boolean", description: "Not a read-path matcher: whether ingest's email fallback would re-link it" },
                        },
                      },
                    },
                    orphanedWithHistory: {
                      type: "array",
                      description: "Candidates holding history this account can't see — fix with PATCH /admin/server-users/{id} { userId }",
                      items: {
                        type: "object",
                        properties: {
                          mediaServerUserId: { type: "string" },
                          source: { type: "string", enum: ["plex", "jellyfin"] },
                          username: { type: "string" },
                          playHistoryRows: { type: "integer" },
                          active: { type: "boolean" },
                          manualUserLink: { type: "boolean" },
                          subjectSuppressedByPin: { type: "boolean" },
                          linkedToOtherUserId: { type: "string", nullable: true },
                          emailWouldRelink: { type: "boolean" },
                        },
                      },
                    },
                    allServerIdentities: {
                      type: "array",
                      maxItems: 200,
                      description: "Only when no candidate matched: up to 200 server identities, so the one that should have matched is visible",
                      items: {
                        type: "object",
                        properties: {
                          mediaServerUserId: { type: "string" },
                          source: { type: "string", enum: ["plex", "jellyfin"] },
                          sourceUserId: { type: "string" },
                          username: { type: "string" },
                          email: { type: "string", nullable: true },
                          isServerAdmin: { type: "boolean" },
                          active: { type: "boolean" },
                          linkedToUserId: { type: "string", nullable: true },
                          manualUserLink: { type: "boolean" },
                          playHistoryRows: { type: "integer" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          "400": { description: "Neither userId nor email supplied" },
          "404": { description: "No account matched" },
        },
      },
    },

    "/admin/play-history/backfill-playtime": {
      post: {
        tags: ["Admin – Debug"],
        summary: "One-shot clamp of pre-fix PlayHistory playDuration values (ADMIN, ops-only — no UI)",
        description:
          "Repairs rows written before ActiveSession.playtimeMs landed, where playDuration stored the playhead position at session end (a scrub-to-credits looked like a full watch). Clamps playDuration to wall-clock (stoppedAt - startedAt) and recomputes watched/pausedDuration. Defaults to a DRY RUN returning counts and a sample; pass ?execute=true with a body echoing the dry-run's candidate-row count to apply. Idempotent — already-clamped rows are excluded. Deliberately headless (curl-only), like the /admin/debug/* endpoints.",
        parameters: [
          { name: "execute", in: "query", schema: { type: "string", enum: ["true"] }, description: "Omit for a dry run; \"true\" applies the clamp" },
        ],
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  confirmAffectedRows: { type: "integer", description: "Required with ?execute=true — must echo the candidate-row count from a prior dry run" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Dry run: counts + five-row sample. Execute: rows updated + watched flips",
            content: {
              "application/json": {
                schema: {
                  oneOf: [
                    {
                      type: "object",
                      description: "Dry run (the default)",
                      required: ["dryRun", "threshold", "totalRows", "affectedRows", "watchedFlippedToFalse", "sample", "hint"],
                      properties: {
                        dryRun: { type: "boolean", enum: [true] },
                        threshold: { type: "integer", minimum: 0, maximum: 100, description: "The watched threshold (percent) the recomputed flags use" },
                        totalRows: { type: "integer" },
                        affectedRows: { type: "integer", description: "The candidate rows — echo it as `confirmAffectedRows` to execute" },
                        watchedFlippedToFalse: { type: "integer" },
                        sample: {
                          type: "array",
                          maxItems: 5,
                          description: "The five newest candidates, before and after",
                          items: {
                            type: "object",
                            properties: {
                              id: { type: "string" },
                              title: { type: "string" },
                              duration: { type: "integer", description: "Seconds" },
                              playDurationOld: { type: "integer", description: "Seconds" },
                              playDurationNew: { type: "integer", description: "Seconds" },
                              watchedOld: { type: "boolean" },
                              watchedNew: { type: "boolean" },
                            },
                          },
                        },
                        hint: { type: "string", description: "The exact re-POST that applies it" },
                      },
                    },
                    {
                      type: "object",
                      description: "`execute=true`, confirmed",
                      required: ["dryRun", "threshold", "updated", "watchedFlippedToFalse"],
                      properties: {
                        dryRun: { type: "boolean", enum: [false] },
                        threshold: { type: "integer", minimum: 0, maximum: 100 },
                        updated: { type: "integer", description: "Rows clamped" },
                        watchedFlippedToFalse: { type: "integer" },
                      },
                    },
                  ],
                },
              },
            },
          },
          "409": { description: "{ error, hint, affectedRows } — `confirmAffectedRows` is missing or does not match the live candidate count (nothing changed)" },
        },
      },
    },

    "/admin/fix-match": {
      post: {
        tags: ["Admin – Fix Match"],
        summary: "Manually reassign a library item to a different TMDB ID (ADMIN / ISSUE_ADMIN)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["server", "mediaType", "correctTmdbId"],
                properties: {
                  server: { type: "string", enum: ["plex", "jellyfin"] },
                  tmdbId: { type: "integer", description: "The wrong TMDB ID currently on the library row (every copy holding it is remapped). Required unless `itemKey` is sent" },
                  itemKey: {
                    type: "string",
                    description:
                      "Item mode: remap ONE server item (Plex ratingKey / Jellyfin item id) that the last library match check flagged (/admin/library/match-check), never the other copies of its title. Its current TMDB id, media type and path are read from the stored flag — `tmdbId` is ignored. 404 when the last check didn't flag it.",
                  },
                  mediaType: { $ref: "#/components/schemas/MediaType" },
                  correctTmdbId: { type: "integer" },
                  canonicalGuid: { type: "string", description: "Plex only — a candidate GUID preselected from /admin/fix-match/candidates" },
                  async: {
                    type: "boolean",
                    default: false,
                    description:
                      "Run the remap as a background job: answers 202 with a `jobId` immediately; poll /admin/fix-match/status. Use this from browsers — a series remap can outlive a reverse proxy's request timeout. Absent/false keeps the synchronous response.",
                  },
                  serverInstance: {
                    type: "string",
                    default: "",
                    description:
                      "Which configured media-server instance to remap (\"\" = the default server). MUST match the instance the library row came from — a Plex ratingKey / Jellyfin item id is server-local.",
                  },
                  issueId: {
                    type: "string",
                    description:
                      "`async: true`, title mode only — the WRONG_MATCH issue this fix answers. When the remap succeeds the job resolves it (only if it is about this `tmdbId` and `mediaType`, and not during maintenance for a non-admin), and the job's `result` carries `issueResolved`. Ignored by the synchronous call.",
                  },
                  issueTitle: { type: "string", description: "With `issueId` — the corrected title, named in the issue's resolution note (display only)" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Match updated (may carry a `warning` when Plex conflated both TMDB IDs)",
            content: { "application/json": { schema: FIX_MATCH_RESULT } },
          },
          "202": {
            description: "`async: true` — { ok: true, jobId, status }: the job was started, or an identical one was already running (then `joined: true`, additive)",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["ok", "jobId", "status"],
                  properties: {
                    ok: { type: "boolean", enum: [true] },
                    jobId: { type: "string", format: "uuid", description: "Poll GET /admin/fix-match/status?id=" },
                    status: FIX_MATCH_JOB_STATUS,
                    joined: { type: "boolean", enum: [true], description: "Present when an identical job was already running" },
                  },
                },
              },
            },
          },
          "400": { description: "Bad body, an invalid serverInstance slug, or a malformed itemKey" },
          "404": { description: "No library row for that tmdbId on that instance — re-sync first; in item mode, the last match check didn't flag that item" },
          "429": { description: "Rate limited (10/min/admin), or too many fix-match operations already queued" },
          "502": { description: "Remote remap or the follow-up cache write failed" },
        },
      },
    },
    "/admin/fix-match/status": {
      get: {
        tags: ["Admin – Fix Match"],
        summary: "Status of a background fix-match job started with `async: true` (ADMIN / ISSUE_ADMIN)",
        parameters: [{ name: "id", in: "query", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": {
            description: "`status` is queued | running | done | failed (`queueAhead` while queued, `progress` while running); `result` when done (same shape as the synchronous POST, plus `issueResolved` for a job started with `issueId`), `error` + `errorStatus` when failed",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["id", "status", "startedAt", "finishedAt"],
                  properties: {
                    id: { type: "string", format: "uuid" },
                    status: FIX_MATCH_JOB_STATUS,
                    queueAhead: { type: "integer", description: "While queued: jobs ahead of it" },
                    startedAt: { type: "integer", description: "Epoch milliseconds" },
                    finishedAt: { type: "integer", nullable: true, description: "Epoch milliseconds" },
                    progress: {
                      type: "object",
                      description: "While running: lets a client tell \"waiting on the media server\" from \"stuck\"",
                      properties: {
                        phase: FIX_MATCH_PHASE,
                        remoteApplied: { type: "boolean", description: "The media server accepted the new match; only its refresh is left" },
                        attempt: { type: "integer" },
                        attempts: { type: "integer" },
                        readFailures: { type: "integer", description: "Confirmation reads that errored or timed out" },
                        copy: { type: "integer", description: "Which copy of a multi-copy title (1-based); absent for a single item" },
                        copies: { type: "integer" },
                        updatedAt: { type: "integer", description: "Epoch milliseconds" },
                      },
                    },
                    result: {
                      allOf: [
                        FIX_MATCH_RESULT,
                        { type: "object", properties: { issueResolved: { type: "boolean", description: "A job started with `issueId`: whether that issue is closed now" } } },
                      ],
                    },
                    error: { type: "string", description: "When failed: a client-safe message" },
                    errorStatus: { type: "integer", nullable: true, description: "When failed: the status the synchronous call would have answered" },
                  },
                },
              },
            },
          },
          "400": { description: "Missing or malformed id" },
          "404": { description: "Unknown or expired job — jobs are in-process and do not survive a restart; re-sync to see whether the remap landed" },
        },
      },
    },
    "/admin/fix-match/jobs": {
      get: {
        tags: ["Admin – Fix Match"],
        summary: "Recent fix-match jobs for the job tray (ADMIN / ISSUE_ADMIN)",
        description: "Every job the in-process registry still holds — queued, running, and finished within the last hour — newest first. Coarse by design: id, status, title, server, timestamps, progress counters and the outcome; never a ratingKey, path or token. A restart empties it.",
        responses: {
          "200": {
            description: "`{ jobs: [{ id, status, title, server, serverInstance, startedAt, finishedAt, queueAhead?, progress?, warning?, error? }] }`",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["jobs"],
                  properties: {
                    jobs: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string", format: "uuid" },
                          status: FIX_MATCH_JOB_STATUS,
                          title: { type: "string", nullable: true, description: "What the job is about, for display (\"Dune (2021)\")" },
                          server: { type: "string", enum: ["plex", "jellyfin"] },
                          serverInstance: { type: "string", description: "\"\" = the default server" },
                          startedAt: { type: "integer", description: "Epoch milliseconds" },
                          finishedAt: { type: "integer", nullable: true, description: "Epoch milliseconds" },
                          queueAhead: { type: "integer" },
                          progress: {
                            type: "object",
                            properties: {
                              phase: FIX_MATCH_PHASE,
                              attempt: { type: "integer" },
                              attempts: { type: "integer" },
                              copy: { type: "integer" },
                              copies: { type: "integer" },
                            },
                          },
                          warning: { type: "string" },
                          error: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/admin/fix-match/candidates": {
      get: {
        tags: ["Admin – Fix Match"],
        summary: "List match candidates for a library item (ADMIN / ISSUE_ADMIN)",
        description: "Plex: scored candidates from the server's agent search. Jellyfin: the remote-search candidates for the item. 30 per minute per admin.",
        parameters: [
          { name: "server", in: "query", required: true, schema: { type: "string", enum: ["plex", "jellyfin"] } },
          { name: "tmdbId", in: "query", required: true, schema: { type: "integer" } },
          { name: "mediaType", in: "query", required: true, schema: { $ref: "#/components/schemas/MediaType" } },
          { name: "correctTmdbId", in: "query", required: true, schema: { type: "integer" } },
          { name: "arrTmdbId", in: "query", schema: { type: "integer" }, description: "Radarr/Sonarr hint to boost a matching candidate" },
          {
            name: "serverInstance", in: "query", schema: { type: "string", default: "" },
            description: "Which configured instance of `server` to read the row from and search (\"\" = the default server). Echoed back in the response.",
          },
        ],
        responses: {
          "200": {
            description: "Scored candidates plus target metadata, `ratingKey`, and the resolved `serverInstance`",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  description: "The same shape for both servers. Jellyfin has no candidate list (the POST applies the exact id): `candidates` is empty and `ratingKey` \"\" — the rest feeds the confirmation card.",
                  properties: {
                    candidates: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          guid: { type: "string", description: "The Plex metadata-agent guid — POST it back as `canonicalGuid`" },
                          name: { type: "string" },
                          year: { type: "integer", nullable: true },
                          thumb: { type: "string", nullable: true, description: "Artwork for /admin/fix-match/thumb?path=" },
                          score: { type: "number", nullable: true, description: "Plex's own search score" },
                          imdbId: { type: "string", nullable: true },
                          tmdbId: { type: "string", nullable: true },
                          tmdbTitle: { type: "string", nullable: true },
                          tmdbOverview: { type: "string", nullable: true },
                          tmdbRuntime: { type: "integer", nullable: true, description: "Minutes" },
                          tmdbGenres: { type: "array", items: { type: "string" } },
                          tmdbVoteAvg: { type: "number", nullable: true },
                          tmdbPosterPath: { type: "string", nullable: true },
                          matchLevel: { type: "string", enum: ["exact", "strong", "likely", "possible", "wrong", "unknown"] },
                          confidence: { type: "number" },
                          titleSimilarity: { type: "number" },
                          radarrConfirmed: { type: "boolean" },
                          suggested: { type: "boolean", description: "The one candidate to preselect" },
                        },
                      },
                    },
                    targetTitle: { type: "string" },
                    targetYear: { type: "string" },
                    targetImdbId: { type: "string" },
                    targetPosterPath: { type: "string", nullable: true },
                    targetOverview: { type: "string" },
                    targetReleaseDate: { type: "string", nullable: true },
                    targetVoteAverage: { type: "number", nullable: true },
                    targetRuntime: { type: "integer", nullable: true, description: "Minutes" },
                    targetGenres: { type: "array", items: { type: "string" } },
                    arrConfirmedTmdbId: { type: "integer", nullable: true, description: "The TMDB id Radarr/Sonarr hold for the item's folder" },
                    arrConfirmedTitle: { type: "string", nullable: true },
                    arrPathAgrees: { type: "boolean", nullable: true },
                    ratingKey: { type: "string", description: "The Plex item (\"\" for Jellyfin)" },
                    plexFilePath: FIX_MATCH_FILE_PATH,
                    jellyfinFilePath: FIX_MATCH_FILE_PATH,
                    serverInstance: { type: "string", description: "The instance the item and candidates came from — send it back with the fix" },
                    currentTitle: { type: "string", nullable: true, description: "What the item is matched to now" },
                    currentYear: { type: "string", nullable: true },
                  },
                },
              },
            },
          },
          "400": { description: "Missing or out-of-range params, a server other than plex|jellyfin, or an invalid serverInstance slug" },
          "404": { description: "No Plex/Jellyfin library row for that tmdbId on that instance" },
          "429": { description: "Rate limited (30/min/admin)" },
          "500": { description: "Plex is not configured" },
        },
      },
    },
    "/admin/fix-match/file-info": {
      get: {
        tags: ["Admin – Fix Match"],
        summary: "File paths + Radarr/Sonarr hint for a TMDB id across every configured server (ADMIN / ISSUE_ADMIN)",
        parameters: [
          { name: "tmdbId", in: "query", required: true, schema: { type: "integer" } },
          { name: "mediaType", in: "query", required: true, schema: { $ref: "#/components/schemas/MediaType" } },
          {
            name: "serverInstance", in: "query", schema: { type: "string", default: "" },
            description: "Which instance `plexFilePath` / `jellyfinFilePath` are read from (\"\" = the default server).",
          },
        ],
        responses: {
          "200": {
            description:
              "plexFilePath / jellyfinFilePath (for the requested instance) + arrTmdbId / arrTitle, " +
              "plus plexServerInstance / jellyfinServerInstance (the instance each path came from, null when that server has no row) " +
              "and plexInstances / jellyfinInstances — every instance holding the title, as `{ serverInstance, filePath }`. " +
              "`arrError` is true when a Radarr/Sonarr lookup failed, so a null arrTmdbId means \"could not tell\".",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    plexFilePath: FIX_MATCH_FILE_PATH,
                    jellyfinFilePath: FIX_MATCH_FILE_PATH,
                    arrTmdbId: { type: "integer", nullable: true },
                    arrTitle: { type: "string", nullable: true },
                    plexServerInstance: { type: "string", nullable: true },
                    jellyfinServerInstance: { type: "string", nullable: true },
                    plexInstances: { type: "array", items: { type: "object", properties: { serverInstance: { type: "string" }, filePath: FIX_MATCH_FILE_PATH } } },
                    jellyfinInstances: { type: "array", items: { type: "object", properties: { serverInstance: { type: "string" }, filePath: FIX_MATCH_FILE_PATH } } },
                    arrError: { type: "boolean" },
                  },
                },
              },
            },
          },
          "400": { description: "Missing params, or an invalid serverInstance slug" },
          "429": { description: "Rate limited (30/min/admin)" },
        },
      },
    },
    "/admin/fix-match/thumb": {
      get: {
        tags: ["Admin – Fix Match"],
        summary: "Proxy a Plex candidate thumbnail (ADMIN / ISSUE_ADMIN)",
        parameters: [
          {
            name: "path", in: "query", required: true, schema: { type: "string" },
            description: "A Plex item's artwork path (/library/metadata/{id}/thumb|art|banner|poster[/{ts}], no query string), or an absolute URL from an allowlisted metadata-agent CDN",
          },
          {
            name: "serverInstance", in: "query", schema: { type: "string", default: "" },
            description: "Which configured Plex instance a RELATIVE path belongs to (\"\" = the default server). Ignored for absolute URLs.",
          },
        ],
        responses: {
          "200": {
            description: "Image binary (proxied)",
            content: { "image/*": { schema: { type: "string", format: "binary", description: "The image as the upstream sent it (its own image/* type; anything else is a 502). Cache-Control: private, max-age=3600" } } },
          },
          "400": { description: "Missing/invalid path, or an invalid serverInstance slug" },
          "401": { description: "Not signed in" },
          "403": { description: "No MANAGE_ISSUES permission (ADMIN and ISSUE_ADMIN hold it)" },
          "500": { description: "A relative path, and that Plex instance is not configured" },
          "502": { description: "Upstream fetch failed or returned a non-image" },
        },
      },
    },

    "/admin/library-warm": {
      get: {
        tags: ["Admin – Stats"],
        summary: "Poll a background library warm (ADMIN)",
        description: "The answer of a warm started with `async: true`, for the admin who started it.",
        parameters: [
          { name: "job", in: "query", required: true, schema: { type: "string", pattern: "^[0-9a-f]{32}$" }, description: "The job id from the POST's 202" },
        ],
        responses: {
          "200": {
            description: "The finished warm's own answer (any of the POST's statuses and bodies)",
            content: { "application/json": { schema: LIBRARY_WARM_RESULT } },
          },
          "202": jobAnswer("Still running: { job, running: true }", JOB_RUNNING),
          "404": { description: "{ error } — the job is unknown: expired, another admin's, or dropped by a restart" },
        },
      },
      post: {
        tags: ["Admin – Stats"],
        summary: "Pre-warm the library cache (ADMIN)",
        description: "Admin session only (a bare CRON_SECRET bearer is rejected; the cron twin is POST /cron/warm-library). Takes the same advisory lock as that cron, and a 5-minute cooldown claimed inside the lock. Audited CACHE_WARM. No body is the synchronous run; `{ async: true }` answers 202 `{ job }` at once — poll GET `?job=`.",
        requestBody: { required: false, content: { "application/json": { schema: { type: "object", properties: {
          async: { type: "boolean", description: "Run as a background job: 202 { job }, poll GET ?job=. Default: synchronous" },
        } } } } },
        responses: {
          "200": { description: "The prewarm result (counts and durations)", content: { "application/json": { schema: LIBRARY_WARM_RESULT } } },
          "202": jobAnswer("{ job } — `async: true`: the warm runs in the background", JOB_STARTED),
          "409": { description: "{ ok: false, error, retryAfter: 30 } — a library warm is already running (Retry-After: 30)" },
          "429": { description: "{ error, retryAfter } — within 5 minutes of the last warm (seconds until the next is allowed)" },
          "500": { description: "{ error } — the warm failed; its cooldown claim is released" },
        },
      },
    },
    "/admin/library-sample-paths": {
      get: {
        tags: ["Admin – Stats"],
        summary: "Sample file paths from the library (ADMIN)",
        description: "Default server instance only. Up to 500 paths per service and media type feed the common mount point and a few samples.",
        responses: {
          "200": {
            description: "{ plex: { movie, tv }, jellyfin: { movie, tv } }, each { mountPoint, samples }",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  description: "The DEFAULT server instance's paths only (the strip-prefix Settings this preview accompanies apply to it)",
                  properties: {
                    plex: { type: "object", properties: { movie: LIBRARY_PATH_SAMPLE, tv: LIBRARY_PATH_SAMPLE } },
                    jellyfin: { type: "object", properties: { movie: LIBRARY_PATH_SAMPLE, tv: LIBRARY_PATH_SAMPLE } },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/admin/check-schema": {
      get: {
        tags: ["Admin – Debug"],
        summary: "Check whether the DB schema is up to date (ADMIN)",
        description: "Admin session only; a bare CRON_SECRET bearer is rejected. For a cookie session the route also demands a same-origin check (403 otherwise).",
        responses: {
          "200": {
            description: "{ allOk, tables: { <table>: { ok, missing, columns } }, allTables }",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["allOk", "tables", "allTables"],
                  properties: {
                    allOk: { type: "boolean" },
                    tables: {
                      type: "object",
                      description: "Keyed by each table the check expects (its own fixed list)",
                      additionalProperties: {
                        type: "object",
                        properties: {
                          ok: { type: "boolean" },
                          missing: { type: "array", items: { type: "string" }, description: "Expected columns the database lacks" },
                          columns: { type: "array", items: { type: "string" }, description: "Every column the table has (empty when the table is missing)" },
                        },
                      },
                    },
                    allTables: { type: "array", items: { type: "string" }, description: "Every table in the public schema, sorted" },
                  },
                },
              },
            },
          },
          "403": { description: "Failed the same-origin check" },
        },
      },
    },
    "/admin/clear-cache": {
      delete: {
        tags: ["Admin – Stats"],
        summary: "Clear a metadata cache source: tmdb | mdblist | omdb | all (ADMIN)",
        parameters: [
          {
            name: "source",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["tmdb", "mdblist", "omdb", "all"], default: "all" },
          },
        ],
        description: "`tmdb` also resets the denormalized copies (TmdbMediaCore, TitleSuggestion edges); `mdblist` / `omdb` also reset stored recommendation quality verdicts. 5 per 5 minutes per admin.",
        responses: {
          "200": {
            description: "{ source, cleared, coreCleared, edgesCleared, verdictsCleared }",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["source", "cleared", "coreCleared", "edgesCleared", "verdictsCleared"],
                  properties: {
                    source: { type: "string", enum: ["tmdb", "mdblist", "omdb", "all"] },
                    cleared: { type: "integer", description: "TmdbCache rows deleted" },
                    coreCleared: { type: "integer", description: "TmdbMediaCore rows deleted" },
                    edgesCleared: { type: "integer", description: "TitleSuggestion and CoWatchSuggestion edges deleted" },
                    verdictsCleared: { type: "integer", description: "Recommendation quality verdicts reset" },
                  },
                },
              },
            },
          },
          "400": { description: "Unknown source" },
          "429": { description: "Rate limited (5 per 5 minutes per admin)" },
        },
      },
    },

    "/discord/generate-link": {
      post: {
        tags: ["Discord"],
        summary: "Issue a short-lived token to link a Discord account to the current user",
        description: "The token lives 10 minutes and replaces any earlier one for the caller. With `discordId` only that Discord account can redeem it; without, any Discord account that sees it can. 5 per 10 minutes per user. Requires a step-up: a password account sends `confirmPassword`; an SSO account must have signed in within the last 5 minutes. Audited.",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  discordId: { type: "string", description: "Discord snowflake (17–20 digits); present but malformed is a 400" },
                  confirmPassword: { type: "string", description: "The current password (password accounts)" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Link token",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    token: { type: "string" },
                    expiresAt: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          },
          "400": { description: "`discordId` is present but not a valid snowflake" },
          "401": STEP_UP_401,
          "403": { description: "The Discord integration is switched off (feature.integration.discord)" },
          "429": { description: "Rate limited" },
        },
      },
    },
    "/discord/initiate-merge": {
      post: {
        tags: ["Discord"],
        summary: "Start Discord account merge flow",
        description: "DMs a 12-character code (valid 10 minutes) to the given Discord account through the bot. Deliberately does not say whether that Discord id is already linked; that surfaces at confirm-merge. A WEB session needs a step-up (a password account sends `confirmPassword`; an SSO account must have signed in within the last 5 minutes); a native-app session is exempt.",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["discordId"], properties: { discordId: { type: "string", description: "Discord snowflake (17–20 digits)" }, confirmPassword: { type: "string", description: "The current password (web sessions of password accounts)" } } } } },
        },
        responses: {
          "200": { description: "{ ok: true } — the code was DMed (it is never returned)", content: { "application/json": { schema: OK_TRUE } } },
          "400": { description: "Invalid Discord user id" },
          "401": STEP_UP_401,
          "403": { description: "The Discord integration is switched off (feature.integration.discord)" },
          "429": { description: "More than 10 initiations an hour, or 3 per target Discord id per 15 minutes" },
          "502": { description: "The bot could not open or send the DM" },
          "503": { description: "No Discord bot token configured" },
        },
      },
    },
    "/discord/confirm-merge": {
      post: {
        tags: ["Discord"],
        summary: "Confirm Discord account merge",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["code"],
                properties: { code: { type: "string", description: "The 12-character code the bot sent by DM (case and surrounding whitespace are ignored)" } },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "{ ok: true, migrated, discordId }",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["ok", "migrated", "discordId"],
                  properties: {
                    ok: { type: "boolean", enum: [true] },
                    migrated: { type: "integer", minimum: 0, description: "Requests moved over from the Discord-only account (0 when there was none)" },
                    discordId: { type: "string", description: "The Discord user id now linked" },
                  },
                },
              },
            },
          },
          "400": { description: "No pending code, expired, or incorrect code" },
          "403": { description: "The Discord integration is switched off (feature.integration.discord)" },
          "409": { description: "The merge was refused (for example the Discord id is linked to another account)" },
          "429": { description: "{ error: \"rate_limit\", message } — more than 5 attempts in 10 minutes; the pending code is deleted" },
        },
      },
    },
    "/discord/sync-roles": {
      post: {
        tags: ["Discord"],
        summary: "Sync Discord roles for every linked account (ADMIN)",
        description: "Assigns the linked/server/admin roles to every active linked account (shadow `@discord.local` accounts excluded) and strips them from deactivated ones. Audited SETTINGS_CHANGE.",
        responses: {
          "200": {
            description: "{ synced, revoked, failed, skipped }: synced/revoked count the members Discord accepted, failed the ones with a refused or failed call, skipped the ones with nothing to do (integration off, no guild or role configured). Just { synced: 0 } when no account is linked or deactivated.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["synced"],
                  properties: {
                    synced: { type: "integer", minimum: 0 },
                    revoked: { type: "integer", minimum: 0, description: "Absent when no account was linked or disabled (then `synced` is 0)" },
                    failed: { type: "integer", minimum: 0, description: "Absent when nothing was synced" },
                    skipped: { type: "integer", minimum: 0, description: "Absent when nothing was synced" },
                  },
                },
              },
            },
          },
          "403": { description: "Not ADMIN" },
        },
      },
    },
    "/discord/register-commands": {
      post: {
        tags: ["Discord"],
        summary: "Register Discord slash commands (ADMIN)",
        description: "Pushes the slash commands with the stored bot token and client id, to the guild when a guild id is stored, else globally.",
        responses: {
          "200": {
            description: "{ ok: true, message }",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["ok", "message"],
                  properties: { ok: { type: "boolean", enum: [true] }, message: { type: "string", description: "Where the commands were registered (the guild, or globally), in the caller's language" } },
                },
              },
            },
          },
          "400": { description: "Bot token or client id is not configured" },
          "403": { description: "Not ADMIN" },
          "502": { description: "Discord refused the registration" },
        },
      },
    },

    "/settings": {
      get: {
        tags: ["Settings"],
        summary: "Get all settings (ADMIN)",
        description: "Only allow-listed keys that have a stored row appear. Secret values come back masked as \"••••••••\" (or \"\" when unset) and URL values with any userinfo stripped.",
        responses: {
          "200": {
            description: "Flat { key: string } map",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  description: "Open-ended by design: one string per stored setting the route allows, keyed by setting name (the allowed set grows with the app). A secret reads as the mask sentinel (\"\" when unset); a URL has any userinfo stripped",
                  additionalProperties: { type: "string" },
                },
              },
            },
          },
        },
      },
      patch: {
        tags: ["Settings"],
        summary: "Update settings (ADMIN)",
        description: "Body is a flat map of string values (64 KB cap); keys outside the allow-list are ignored; a non-string or over-long value, or a new value failing its per-key rules, is a 400 and nothing is written. Resending a stored value (or the secret mask) is not a change: it is not validated, written, audited or held to the cooldown. A blank clears a key that can be cleared; for any other key it is reported in `ignored` when a stored value was kept. A key changed within the last 10 seconds is refused with 429 (exempt keys aside). New connection settings are tested against the candidate config BEFORE anything is written; a failed test writes nothing. 10 per minute per admin.",
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object", additionalProperties: { type: "string" }, description: "Arbitrary key-value pairs" },
            },
          },
        },
        responses: {
          "200": {
            description: "{ ok: true, ...connectivity test results, ignored? } — also the answer when nothing changed. `ignored` (additive) lists keys sent blank that can't be cleared and kept their stored value",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["ok"],
                  properties: {
                    ok: { type: "boolean", enum: [true] },
                    radarrVersion: { type: "string", description: "Connection test passed: the instance's version (present only when the test ran)" },
                    sonarrVersion: { type: "string" },
                    radarr4kVersion: { type: "string" },
                    sonarr4kVersion: { type: "string" },
                    jellyfinTested: { type: "boolean", enum: [true] },
                    smtpTested: { type: "boolean", enum: [true], description: "A test email went to the requesting admin" },
                    ignored: { type: "array", items: { type: "string" }, description: "Additive: keys sent blank that can't be cleared" },
                  },
                },
              },
            },
          },
          "400": { description: "Validation error (a non-string or over-long value, a new value failing its per-key rule, or a cross-field rule); nothing was written" },
          "413": { description: "Request body over the 64 KB cap" },
          "422": { description: "A connectivity test failed — nothing was written ({ ok: false, ...test results, ignored? })" },
          "429": { description: "Rate limited, or a key was changed within its 10s cooldown ({ error, retryAfterMs })" },
          "500": { description: "The settings and audit transaction failed — nothing was written" },
        },
      },
    },
    "/settings/arr-options": {
      get: {
        tags: ["Settings"],
        summary: "Get available quality profiles / root folders from Radarr and Sonarr (ADMIN)",
        parameters: [
          { name: "service", in: "query", required: true, schema: { type: "string", enum: ["radarr", "sonarr"] } },
          { name: "instance", in: "query", schema: { type: "string" }, description: "Instance slug (\"\" = default); the legacy `variant=4k` is still honored when `instance` is absent" },
        ],
        responses: {
          "200": {
            description: "{ rootFolders, qualityProfiles, languageProfiles? } — languageProfiles only for a Sonarr v3 with usable ones",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["rootFolders", "qualityProfiles"],
                  properties: {
                    rootFolders: {
                      type: "array",
                      description: "The instance's root folders, for the default-folder picker (ADMIN)",
                      items: { type: "object", properties: { path: { type: "string" } } },
                    },
                    qualityProfiles: { type: "array", items: { type: "object", properties: { id: { type: "integer" }, name: { type: "string" } } } },
                    languageProfiles: {
                      type: "array",
                      description: "Sonarr v3 with usable ones only; absent otherwise",
                      items: { type: "object", properties: { id: { type: "integer" }, name: { type: "string" } } },
                    },
                  },
                },
              },
            },
          },
          "400": { description: "Invalid service or instance" },
          "422": { description: "That instance has no URL/API key configured" },
        },
      },
    },
    "/settings/plex/libraries": {
      get: {
        tags: ["Settings"],
        summary: "List available Plex libraries (ADMIN)",
        parameters: [{ name: "instance", in: "query", schema: { type: "string" }, description: "Plex instance slug; absent = the default server" }],
        responses: {
          "200": {
            description: "The server's library sections",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  description: "Movie and show sections only",
                  items: { type: "object", properties: { key: { type: "string" }, title: { type: "string" }, type: { type: "string", enum: ["movie", "show"] } } },
                },
              },
            },
          },
          "400": { description: "Invalid instance slug" },
          "422": { description: "That server is not configured" },
          "502": { description: "Plex could not be reached" },
        },
      },
    },
    "/settings/jellyfin/libraries": {
      get: {
        tags: ["Settings"],
        summary: "List available Jellyfin libraries (ADMIN)",
        parameters: [{ name: "instance", in: "query", schema: { type: "string" }, description: "Jellyfin instance slug; absent = the default server" }],
        responses: {
          "200": {
            description: "The server's media folders",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  description: "Movie and TV folders only",
                  items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, collectionType: { type: "string", enum: ["movies", "tvshows"] } } },
                },
              },
            },
          },
          "400": { description: "Invalid instance slug" },
          "422": { description: "That server is not configured" },
          "502": { description: "Jellyfin could not be reached" },
        },
      },
    },
    "/settings/test-ratings": {
      post: {
        tags: ["Settings"],
        summary: "Test MDBList / OMDB / Trakt / ipinfo connectivity with stored keys (ADMIN)",
        description: "A live upstream request per call. 10 per minute per admin.",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["service"], properties: { service: { type: "string", enum: ["omdb", "mdblist", "trakt", "ipinfo"] } } } } } },
        responses: {
          "200": {
            description: "{ ok: true, message }",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["ok", "message"],
                  properties: { ok: { type: "boolean", enum: [true] }, message: { type: "string", description: "Translated: what the test fetched" } },
                },
              },
            },
          },
          "400": { description: "Unknown service" },
          "422": { description: "{ ok: false, error } — the provider test failed" },
          "429": { description: "Rate limited" },
        },
      },
    },
    "/settings/webhook-urls": {
      get: {
        tags: ["Settings"],
        summary: "Radarr/Sonarr webhook tokens, fetched on demand for the copy buttons (ADMIN)",
        description: "Kept off the settings page's server-rendered payload so the secrets cross the wire only when an admin asks. radarr/sonarr fall back to the legacy shared secret; the 4K entries do not.",
        responses: {
          "200": {
            description: "{ radarr, sonarr, radarr4k, sonarr4k } — each a token string or null",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  description: "Plaintext webhook tokens (ADMIN only, `private, no-store`) — fetched on a copy click, never in a page payload",
                  properties: {
                    radarr: { type: "string", nullable: true, description: "Falls back to the legacy shared secret" },
                    sonarr: { type: "string", nullable: true, description: "Falls back to the legacy shared secret" },
                    radarr4k: { type: "string", nullable: true },
                    sonarr4k: { type: "string", nullable: true },
                  },
                },
              },
            },
          },
        },
      },
    },

    "/webhooks/radarr": {
      post: {
        tags: ["Webhooks"],
        summary: "Radarr webhook (movie grabbed / imported / deleted, health)",
        description:
          "Authenticated by the instance's webhook secret, as `?token=` or a Bearer header. `Health` / `HealthRestored` " +
          "deliveries are forwarded to the outbound notification channels as `arr.health` / `arr.health_restored` and answer " +
          "{ ok: true, health: true, forwarded } — `forwarded` is false when held back (a repeat of the same state for the same check within 10 minutes, or a delivery with no message). " +
          "`ManualInteractionRequired` alerts admins. A byte-identical repeat of any other delivery is refused as a replay.",
        security: [],
        parameters: [{ name: "token", in: "query", schema: { type: "string" } }],
        requestBody: { content: { "application/json": { schema: { type: "object" } } } },
        responses: {
          "200": {
            description: "Processed — { ok: true, ... } (a Test event answers { ok, message })",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["ok"],
                  properties: {
                    ...ARR_WEBHOOK_ACK_FIELDS,
                    reason: { type: "string", enum: ["unverified", "not_deleted", "not_downloaded"], description: "Why nothing was evicted or marked" },
                  },
                },
              },
            },
          },
          "400": { description: "Body is not valid JSON (or is nested deeper than 64 levels), or the payload's tmdbId is invalid" },
          "401": { description: "Invalid token" },
          "409": { description: "Replayed delivery" },
          "413": { description: "Body over 1 MB" },
          "429": { description: "More than 600 deliveries a minute from one client IP" },
        },
      },
    },
    "/webhooks/sonarr": {
      post: {
        tags: ["Webhooks"],
        summary: "Sonarr webhook (episode grabbed / imported / deleted, health)",
        description:
          "Authenticated by the instance's webhook secret, as `?token=` or a Bearer header. `Health` / `HealthRestored` " +
          "deliveries are forwarded to the outbound notification channels as `arr.health` / `arr.health_restored` and answer " +
          "{ ok: true, health: true, forwarded }; a byte-identical repeat of any other delivery is refused as a replay. " +
          "A Download event flips the series' APPROVED requests to AVAILABLE only once Sonarr confirms the series COMPLETE (every aired regular-season episode on disk). Mid-import deliveries answer { skipped: true, reason: \"incomplete\", episodeFileCount, episodeCount }; an unverifiable delivery (Sonarr unreachable) answers { deferred: true } and is re-checked after the library scan settles.",
        security: [],
        parameters: [{ name: "token", in: "query", schema: { type: "string" } }],
        requestBody: { content: { "application/json": { schema: { type: "object" } } } },
        responses: {
          "200": {
            description: "Processed — { ok: true, ... } (a Test event answers { ok, message })",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["ok"],
                  properties: {
                    ...ARR_WEBHOOK_ACK_FIELDS,
                    deferred: { type: "boolean", enum: [true], description: "Sonarr could not be asked; re-checked after the library scan settles" },
                    reason: {
                      type: "string",
                      enum: ["unverified", "not_deleted", "unconfirmed", "not_downloaded", "incomplete"],
                      description: "Why nothing was evicted or marked",
                    },
                    episodeFileCount: { type: "integer", description: "reason \"incomplete\" only" },
                    episodeCount: { type: "integer", description: "reason \"incomplete\" only" },
                  },
                },
              },
            },
          },
          "400": { description: "Body is not valid JSON, or is nested deeper than 64 levels (an unusable tmdbId/tvdbId never 400s here: it is ignored and the delivery is verified by the series' other id)" },
          "401": { description: "Invalid token" },
          "409": { description: "Replayed delivery" },
          "413": { description: "Body over 1 MB" },
          "429": { description: "More than 600 deliveries a minute from one client IP" },
        },
      },
    },

    "/cron/purge-auth-sessions": {
      post: {
        tags: ["Cron"],
        summary: "Purge expired auth sessions",
        security: ADMIN_OR_CRON_SECURITY,
        responses: {
          "200": {
            description: "{ ok, deleted: { authSessions, discordLinkTokens, discordMergeCodes, ... counts per table }, errorCount, timestamp } — or { skipped: true, reason } when another run holds the lock (X-Cron-Skipped). Only rows past their `expiresAt` are swept (guardrail 6c)",
            content: {
              "application/json": {
                schema: cronRunOrSkip({
                  type: "object",
                  required: ["ok", "deleted", "errorCount", "timestamp"],
                  properties: {
                    ok: { type: "boolean", enum: [true], description: "A failed table answers 500 with this same body and ok: false" },
                    deleted: {
                      type: "object",
                      description: "Rows deleted per table",
                      properties: {
                        authSessions: { type: "integer" },
                        discordLinkTokens: { type: "integer" },
                        discordMergeCodes: { type: "integer" },
                        discordSearchCache: { type: "integer" },
                        webhookReplays: { type: "integer" },
                        plexTokensExpired: { type: "integer" },
                        plexTokensLegacy: { type: "integer" },
                        tmdbMediaCore: { type: "integer" },
                        ipLookupCache: { type: "integer" },
                        auditLogs: { type: "integer" },
                      },
                    },
                    errorCount: { type: "integer" },
                    timestamp: CRON_RUN_FIELDS.timestamp,
                  },
                }),
              },
            },
          },
          "401": { description: "Neither an admin session nor the cron secret" },
          "500": { description: "Same body with ok:false — one or more table sweeps failed" },
        },
      },
    },
    "/cron/purge-notifications": {
      post: {
        tags: ["Cron"],
        summary: "Delete old notification inbox rows",
        security: ADMIN_OR_CRON_SECURITY,
        responses: {
          "200": {
            description: "{ ok, deleted, aborted, timestamp } — or { skipped: true, reason } when another run holds the lock (X-Cron-Skipped). Deletes read notifications older than NOTIFICATION_READ_RETENTION_DAYS (90) and any older than NOTIFICATION_RETENTION_DAYS (365), in batches",
            content: {
              "application/json": {
                schema: cronRunOrSkip({
                  type: "object",
                  required: ["ok", "deleted", "aborted", "timestamp"],
                  properties: {
                    ok: { type: "boolean", enum: [true] },
                    deleted: { type: "integer" },
                    aborted: { type: "boolean", description: "The run stopped early; the next one continues" },
                    timestamp: CRON_RUN_FIELDS.timestamp,
                  },
                }),
              },
            },
          },
          "401": { description: "Neither an admin session nor the cron secret" },
          "500": { description: "{ ok: false, error } — the purge failed" },
        },
      },
    },
    "/cron/scrub-audit-pii": {
      post: {
        tags: ["Cron"],
        summary: "Scrub PII from old audit log entries",
        security: ADMIN_OR_CRON_SECURITY,
        responses: {
          "200": {
            description: "{ ok, scrubbed, authDetailsCleared, cutoff, timestamp } — or { skipped: true, reason } when another run holds the lock",
            content: {
              "application/json": {
                schema: cronRunOrSkip({
                  type: "object",
                  required: ["ok", "scrubbed", "authDetailsCleared", "adminDetailsScrubbed", "cutoff", "timestamp"],
                  properties: {
                    ok: { type: "boolean", enum: [true] },
                    scrubbed: { type: "integer", description: "Rows whose IP address, user agent and user name were cleared" },
                    authDetailsCleared: { type: "integer", description: "Sign-in / sign-out rows whose details were cleared" },
                    adminDetailsScrubbed: { type: "integer", description: "Admin-action rows whose target-user names were scrubbed" },
                    cutoff: { type: "string", format: "date-time" },
                    timestamp: CRON_RUN_FIELDS.timestamp,
                  },
                }),
              },
            },
          },
          "401": { description: "Neither an admin session nor the cron secret" },
        },
      },
    },
    "/cron/warm-activity": {
      post: {
        tags: ["Cron"],
        summary: "Pre-warm activity calendar cache",
        security: ADMIN_OR_CRON_SECURITY,
        responses: {
          "200": {
            description: "{ ok, warmed, timestamp } — or { skipped: true, reason } when another run holds the lock",
            content: {
              "application/json": {
                schema: cronRunOrSkip({
                  type: "object",
                  required: ["ok", "warmed", "timestamp"],
                  properties: {
                    ok: { type: "boolean", enum: [true] },
                    warmed: { type: "integer" },
                    timestamp: CRON_RUN_FIELDS.timestamp,
                  },
                }),
              },
            },
          },
          "401": { description: "Neither an admin session nor the cron secret" },
        },
      },
    },
    "/cron/refresh-upstream-watch": {
      post: {
        tags: ["Cron"],
        summary: "Snapshot each media server's own watch records for the never-watched report",
        security: ADMIN_OR_CRON_SECURITY,
        responses: {
          "200": {
            description: "{ ok, ...per-server results, durationMs, trigger, timestamp } (a server that could not be checked sets ok:false, `error` and X-Cron-Degraded) — or { skipped: true, reason } while both the Never Watched page and Library Cleanup are off, or another run holds the lock",
            content: {
              "application/json": {
                schema: cronRunOrSkip({
                  type: "object",
                  required: ["ok", "servers", "aborted", "durationMs", "trigger", "timestamp"],
                  properties: {
                    ok: CRON_RUN_FIELDS.ok,
                    servers: UPSTREAM_REFRESH_RESULT.properties.servers,
                    aborted: UPSTREAM_REFRESH_RESULT.properties.aborted,
                    error: CRON_RUN_FIELDS.error,
                    durationMs: CRON_RUN_FIELDS.durationMs,
                    trigger: CRON_RUN_FIELDS.trigger,
                    timestamp: CRON_RUN_FIELDS.timestamp,
                  },
                }),
              },
            },
          },
          "401": { description: "Neither an admin session nor the cron secret" },
        },
      },
    },
    "/cron/watch-sync": {
      post: {
        tags: ["Cron"],
        summary: "Watch sync: keep each admin-paired Plex and Jellyfin account's watched status in step, per the pair's direction",
        security: ADMIN_OR_CRON_SECURITY,
        responses: {
          "200": {
            description: "{ ok, pairs: [{ pairId, toJellyfin, toPlex, error? }], aborted, durationMs, trigger, timestamp } (a pair with an error or failed items in either direction sets ok:false, `error` and X-Cron-Degraded) — or { skipped: true, reason } while the feature is off or another run holds the lock",
            content: {
              "application/json": {
                schema: cronRunOrSkip({
                  type: "object",
                  required: ["ok", "pairs", "aborted", "durationMs", "trigger", "timestamp"],
                  properties: {
                    ok: CRON_RUN_FIELDS.ok,
                    pairs: { type: "array", items: WATCH_SYNC_PAIR_RESULT },
                    aborted: { type: "boolean", description: "The run stopped on its time limit; finished work is saved" },
                    error: CRON_RUN_FIELDS.error,
                    durationMs: CRON_RUN_FIELDS.durationMs,
                    trigger: CRON_RUN_FIELDS.trigger,
                    timestamp: CRON_RUN_FIELDS.timestamp,
                  },
                }),
              },
            },
          },
          "401": { description: "Neither an admin session nor the cron secret" },
        },
      },
    },
    "/cron/warm-library": {
      post: {
        tags: ["Cron"],
        summary: "Incrementally re-warm the library :details/TmdbMediaCore caches",
        security: ADMIN_OR_CRON_SECURITY,
        responses: {
          "200": {
            description: "{ ok, ...library counts, edges, translations, timestamp, error? } — or { skipped: true, reason } with X-Cron-Skipped (no TMDB credentials, or another run holds the lock; not recorded as a run)",
            content: {
              "application/json": {
                schema: cronRunOrSkip({
                  type: "object",
                  required: ["ok", "total", "fetched", "backfilled", "skipped", "failed", "edges", "translations", "timestamp"],
                  properties: {
                    ok: CRON_RUN_FIELDS.ok,
                    ...LIBRARY_PREWARM_COUNTS,
                    edges: {
                      type: "object",
                      description: "Suggestion edges built for the recommendation graph (prewarmSuggestionEdges)",
                      properties: {
                        sources: { type: "integer" },
                        refreshed: { type: "integer" },
                        skipped: { type: "integer" },
                        failed: { type: "integer" },
                        edgesWritten: { type: "integer" },
                      },
                    },
                    translations: {
                      type: "object",
                      description: "Title translations warmed (prewarmTitleTranslations); `skipped` while nobody reads a non-English language",
                      properties: {
                        skipped: { type: "boolean" },
                        candidates: { type: "integer" },
                        fetched: { type: "integer" },
                        failed: { type: "integer" },
                      },
                    },
                    error: CRON_RUN_FIELDS.error,
                    timestamp: CRON_RUN_FIELDS.timestamp,
                  },
                }),
              },
            },
          },
          "401": { description: "Neither an admin session nor the cron secret" },
        },
      },
    },
    "/cron/warm-mdblist": {
      post: {
        tags: ["Cron"],
        summary: "Pre-warm MDBList ratings cache",
        security: ADMIN_OR_CRON_SECURITY,
        responses: {
          "200": {
            description: "{ ok, total, ..., timestamp, error? } with X-Cron-Degraded when some items failed — or { skipped: true, reason } with X-Cron-Skipped (no MDBList key, or another run holds the lock; not recorded as a run)",
            content: {
              "application/json": {
                schema: cronRunOrSkip({
                  type: "object",
                  required: ["ok", "total", "fetched", "skipped", "failed", "purged", "timestamp"],
                  properties: {
                    ok: CRON_RUN_FIELDS.ok,
                    total: { type: "integer" },
                    fetched: { type: "integer" },
                    skipped: { type: "integer" },
                    failed: { type: "integer" },
                    purged: { type: "integer" },
                    quotaExhausted: { type: "boolean", description: "Present when MDBList's limit (or the background reserve) stopped the run" },
                    error: CRON_RUN_FIELDS.error,
                    timestamp: CRON_RUN_FIELDS.timestamp,
                  },
                }),
              },
            },
          },
          "401": { description: "Neither an admin session nor the cron secret" },
        },
      },
    },
    "/cron/warm-omdb": {
      post: {
        tags: ["Cron"],
        summary: "Pre-warm OMDB ratings cache",
        security: ADMIN_OR_CRON_SECURITY,
        responses: {
          "200": {
            description: "{ ok, total, ..., timestamp, error? } with X-Cron-Degraded when some items failed — or { skipped: true, reason } with X-Cron-Skipped (no OMDB key, or another run holds the lock; not recorded as a run)",
            content: {
              "application/json": {
                schema: cronRunOrSkip({
                  type: "object",
                  required: ["ok", "total", "fetched", "notFound", "skipped", "failed", "timestamp"],
                  properties: {
                    ok: CRON_RUN_FIELDS.ok,
                    total: { type: "integer" },
                    fetched: { type: "integer" },
                    notFound: { type: "integer", description: "Authoritative misses only (negative-cached); a transient failure counts in `failed`" },
                    skipped: { type: "integer" },
                    failed: { type: "integer" },
                    quotaExhausted: { type: "boolean", description: "Present when the OMDB quota lockout cut the run short" },
                    error: CRON_RUN_FIELDS.error,
                    timestamp: CRON_RUN_FIELDS.timestamp,
                  },
                }),
              },
            },
          },
          "401": { description: "Neither an admin session nor the cron secret" },
        },
      },
    },
    "/cron/warm-recommendations": {
      post: {
        tags: ["Cron"],
        summary: "Pre-warm personalized \"For You\" recommendation cache",
        security: ADMIN_OR_CRON_SECURITY,
        responses: {
          "200": {
            description: "{ ok, ...result, timestamp, error? } — a failed graph build or user computations set ok:false and X-Cron-Degraded (every stored shelf is kept); a failed orphan sweep after the build only sets `graph.sweepFailed` — or { skipped: true, reason } with X-Cron-Skipped when another run holds the lock",
            content: {
              "application/json": {
                schema: cronRunOrSkip({
                  type: "object",
                  required: ["ok", "usersEligible", "usersUpdated", "usersSkipped", "usersFailed", "candidatesWritten", "graphFailed", "graph", "serverHistory", "timestamp"],
                  properties: {
                    ok: CRON_RUN_FIELDS.ok,
                    usersEligible: { type: "integer" },
                    usersUpdated: { type: "integer" },
                    usersSkipped: { type: "integer" },
                    usersFailed: { type: "integer" },
                    candidatesWritten: { type: "integer" },
                    graphFailed: { type: "boolean", description: "The graph refresh threw: no user was recomputed" },
                    graph: {
                      type: "object",
                      description: "The recommendation graph refresh (GraphRefreshResult)",
                      properties: {
                        sources: { type: "integer" },
                        requiredSources: { type: "integer" },
                        requiredCovered: { type: "integer" },
                        sourcesRefreshed: { type: "integer" },
                        sourcesSkipped: { type: "integer" },
                        sourcesFailed: { type: "integer" },
                        edgesWritten: { type: "integer" },
                        sourcesSwept: { type: "integer" },
                        sweepFailed: { type: "boolean", description: "The orphan sweep threw (cleanup only; the rest ran)" },
                        titlesRated: { type: "integer" },
                        verdictsDeferred: { type: "integer" },
                        ratingsFailed: { type: "integer" },
                        coWatchEdges: { type: "integer" },
                        coWatchFailed: { type: "boolean", description: "The co-watch build failed; the previous edges were kept" },
                      },
                    },
                    serverHistory: {
                      type: "object",
                      description: "Phase 0: the media servers' own watch history and favorites (ServerHistoryImportResult)",
                      properties: {
                        servers: { type: "integer" },
                        identities: { type: "integer" },
                        failedServers: { type: "integer" },
                        failedIdentities: { type: "integer" },
                        unresolved: { type: "integer" },
                        aborted: { type: "boolean" },
                      },
                    },
                    error: CRON_RUN_FIELDS.error,
                    timestamp: CRON_RUN_FIELDS.timestamp,
                  },
                }),
              },
            },
          },
          "401": { description: "Neither an admin session nor the cron secret" },
        },
      },
    },

    "/notifications": {
      get: {
        tags: ["Notifications"],
        summary: "List the caller's in-app notifications + unread count",
        description: "Newest first, 30 per page, keyset-paged: pass the previous response's `nextCursor` as `cursor`. An absent or malformed cursor reads the first page. `title`/`body` are rendered in the caller's language (native clients get the instance default). 120 reads per minute per user.",
        parameters: [
          { name: "cursor", in: "query", schema: { type: "string" }, description: "Opaque `<createdAt-iso>|<id>` from the previous page's `nextCursor`" },
        ],
        responses: {
          "200": {
            description: "One page of notifications, the unread count and the caller's total",
            content: { "application/json": { schema: { type: "object", properties: {
              items: { type: "array", items: { type: "object", properties: {
                id: { type: "string" },
                type: { type: "string", description: "REQUEST_APPROVED | REQUEST_AVAILABLE | REQUEST_DECLINED | … (additive set)" },
                title: { type: "string", description: "Rendered in the caller's language" },
                body: { type: "string", description: "Rendered in the caller's language" },
                tmdbId: { type: "integer", nullable: true },
                mediaType: { $ref: "#/components/schemas/MediaType" },
                posterPath: { type: "string", nullable: true },
                readAt: { type: "string", format: "date-time", nullable: true },
                createdAt: { type: "string", format: "date-time" },
              } } },
              unreadCount: { type: "integer" },
              total: { type: "integer" },
              nextCursor: { type: "string", nullable: true, description: "Null when the page was not full" },
              pageSize: { type: "integer", example: 30 },
            } } } },
          },
          "429": { description: "Rate limited" },
        },
      },
      post: {
        tags: ["Notifications"],
        summary: "Mark notifications read (specific ids, or all unread when omitted)",
        requestBody: {
          required: false,
          content: { "application/json": { schema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } } } } },
        },
        responses: {
          "200": { description: "{ ok, unreadCount }", content: { "application/json": { schema: NOTIFICATION_UNREAD_ACK } } },
          "400": { description: "`ids` is present but not an array (never coerced to \"all\")" },
          "429": { description: "Rate limited (60/min)" },
        },
      },
      delete: {
        tags: ["Notifications"],
        summary: "Delete notifications (specific ids via ?ids=, or all via ?all=1)",
        description:
          "Selection is by QUERY PARAMETER, never the body (DELETE bodies are stripped by some proxies). A request with neither `ids` nor `all=1` is a 400, never a wipe.",
        parameters: [
          { name: "ids", in: "query", schema: { type: "string" }, description: "Comma-separated notification ids (max 500)" },
          { name: "all", in: "query", schema: { type: "string", enum: ["1"] }, description: "Set to 1 to clear every notification" },
        ],
        responses: {
          "200": { description: "{ ok, unreadCount }", content: { "application/json": { schema: NOTIFICATION_UNREAD_ACK } } },
          "400": { description: "Neither ids nor all=1 supplied" },
          "429": { description: "Rate limited (60/min)" },
        },
      },
    },
    "/watchlist": {
      get: {
        tags: ["Lists"],
        summary: "List the caller's watchlist",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "type", in: "query", schema: { $ref: "#/components/schemas/MediaType" }, description: "Filter by media type; any other value is ignored" },
          { name: "q", in: "query", schema: { type: "string" }, description: "Case-insensitive substring match on the title (wildcard characters stripped)" },
        ],
        responses: {
          "200": {
            description: "Paginated watchlist items, newest first, 60 per page",
            content: { "application/json": { schema: { allOf: [{ $ref: "#/components/schemas/PaginatedMeta" }, { type: "object", properties: { items: { type: "array", items: LIST_ITEM } } }] } } },
          },
          "429": { description: "Rate limited (60/min)" },
        },
      },
      post: {
        tags: ["Lists"],
        summary: "Add a title to the caller's watchlist",
        description:
          "When watchlist auto-request applies (feature.behavior.watchlistAutoRequest on and the caller holds an AUTO_REQUEST* bit for the media type), the add also files a request through the same path as POST /requests. A refusal never fails the add: the 201 body then carries an additive `autoRequest` object. The field is absent whenever auto-request does not apply.",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["tmdbId", "mediaType"], properties: { tmdbId: { type: "integer" }, mediaType: { $ref: "#/components/schemas/MediaType" } } } } } },
        responses: {
          "201": {
            description: "Added",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    tmdbId: { type: "integer" },
                    mediaType: { $ref: "#/components/schemas/MediaType" },
                    title: { type: "string" },
                    posterPath: { type: "string", nullable: true },
                    createdAt: { type: "string", format: "date-time" },
                    autoRequest: {
                      type: "object",
                      description: "Present only when auto-request applied to this add",
                      properties: {
                        outcome: {
                          type: "string",
                          description: "requested | already-available | already-requested | quota | blacklisted | permanently-declined | rating-cap | forbidden | instance-unavailable | tmdb-unverified | invalid-quality-profile | invalid-note | arr-unreachable | discord-link-required | rate-limited | maintenance | error",
                        },
                        requested: { type: "boolean" },
                        status: { type: "string", nullable: true, description: "The filed request's status when one was filed" },
                        message: { type: "string", description: "Short user-facing explanation" },
                      },
                    },
                  },
                },
              },
            },
          },
          "400": { description: "tmdbId or mediaType missing or invalid" },
          "409": { description: "Already on watchlist" },
          "413": { description: "Request body over the 16 KB cap" },
          "422": { description: "Could not verify media with TMDB" },
          "429": { description: "Rate limited" },
        },
      },
      delete: {
        tags: ["Lists"],
        summary: "Remove a title from the caller's watchlist",
        parameters: [
          { name: "tmdbId", in: "query", required: true, schema: { type: "integer" } },
          { name: "mediaType", in: "query", required: true, schema: { $ref: "#/components/schemas/MediaType" } },
        ],
        responses: {
          "200": { description: "{ ok: true } — removed, or it was not there (idempotent)", content: { "application/json": { schema: OK_TRUE } } },
          "400": { description: "tmdbId or mediaType missing or invalid" },
          "429": { description: "Rate limited (60/min)" },
        },
      },
    },
    "/hidden": {
      get: {
        tags: ["Lists"],
        summary: "List the caller's hidden (\"not interested\") titles",
        parameters: [{ name: "page", in: "query", schema: { type: "integer", default: 1 } }],
        responses: {
          "200": {
            description: "Paginated hidden items, newest first, 60 per page",
            content: { "application/json": { schema: { allOf: [{ $ref: "#/components/schemas/PaginatedMeta" }, { type: "object", properties: { items: { type: "array", items: LIST_ITEM } } }] } } },
          },
          "429": { description: "Rate limited (60/min)" },
        },
      },
      post: {
        tags: ["Lists"],
        summary: "Hide a title from the caller's discovery",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["tmdbId", "mediaType"], properties: { tmdbId: { type: "integer" }, mediaType: { $ref: "#/components/schemas/MediaType" }, title: { type: "string", maxLength: 500, description: "Optional; cut to 500 characters. Not verified against TMDB" }, posterPath: { type: "string", nullable: true, maxLength: 500, description: "Stored only when 1–500 characters, else null" } } } } } },
        responses: { "201": { description: "Hidden — { tmdbId, mediaType, title, posterPath, createdAt }", content: { "application/json": { schema: LIST_ITEM } } }, "400": { description: "tmdbId or mediaType missing or invalid" }, "409": { description: "Already hidden" }, "429": { description: "Rate limited (60/min)" } },
      },
      delete: {
        tags: ["Lists"],
        summary: "Un-hide a title",
        parameters: [
          { name: "tmdbId", in: "query", required: true, schema: { type: "integer" } },
          { name: "mediaType", in: "query", required: true, schema: { $ref: "#/components/schemas/MediaType" } },
        ],
        responses: { "200": { description: "{ ok: true } — un-hidden, or it was not hidden (idempotent)", content: { "application/json": { schema: OK_TRUE } } }, "400": { description: "tmdbId or mediaType missing or invalid" }, "429": { description: "Rate limited (60/min)" } },
      },
    },
    "/media/{type}/{tmdbId}": {
      get: {
        tags: ["Discovery"],
        summary: "Native detail payload (title detail + related rail + availability)",
        parameters: [
          { name: "type", in: "path", required: true, schema: { type: "string", enum: ["movie", "tv"] } },
          { name: "tmdbId", in: "path", required: true, schema: { type: "integer" } },
        ],
        responses: {
          "200": {
            description: "Title detail with availability + suggestions",
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    { $ref: "#/components/schemas/TmdbMedia" },
                    {
                      type: "object",
                      required: ["cast", "similar", "keywords", "keywordList", "genreList", "watchProviders", "homepage", "collection", "votedByMe", "onWatchlist", "onHidden"],
                      properties: {
                        cast: {
                          type: "array",
                          description: "Top cast; empty when the credits fetch failed",
                          items: {
                            type: "object",
                            properties: { id: { type: "integer" }, name: { type: "string" }, character: { type: "string" }, profilePath: { type: "string", nullable: true } },
                          },
                        },
                        similar: { type: "array", items: MEDIA_DETAIL_LITE, description: "Up to 12 related titles" },
                        keywords: { type: "array", items: { type: "string" } },
                        keywordList: { type: "array", items: TMDB_ID_NAME },
                        genreList: { type: "array", items: TMDB_ID_NAME },
                        watchProviders: { type: "array", items: TMDB_WATCH_PROVIDER, description: "US region" },
                        homepage: { type: "string", nullable: true },
                        collection: {
                          type: "object",
                          nullable: true,
                          description: "Movies only: the collection's parts; null when the title has none or the fetch failed",
                          properties: { id: { type: "integer" }, name: { type: "string" }, items: { type: "array", items: MEDIA_DETAIL_LITE } },
                        },
                        votedByMe: { type: "boolean", description: "The caller has an open deletion vote on the title" },
                        onWatchlist: { type: "boolean" },
                        onHidden: { type: "boolean" },
                        requested4kByMe: { type: "boolean", description: "Present only when the viewer can see 4K state: the caller holds an open 4K request" },
                      },
                    },
                  ],
                },
              },
            },
          },
          "400": { description: "Invalid type or tmdbId" },
          "502": { description: "Could not load this title" },
          "429": { description: "Rate limited" },
        },
      },
    },
    "/config/public": {
      get: {
        tags: ["Config"],
        summary: "User-readable client configuration (AUTHENTICATED)",
        description:
          "Despite the path name this requires a session — it is not in isPublicPath and is wrapped in withAuth. \"Public\" here means the non-sensitive slice of admin config a signed-in client may read, not unauthenticated. It carries NO sign-in provider information; for pre-auth capability negotiation use /config/compat.",
        responses: {
          "200": {
            description: "User-readable config slice",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    recommendedIosBuild: { type: "integer", description: "Soft-upgrade hint. OMITTED unless set to a valid integer >= 1 — clients key off the field's presence." },
                    siteTitle: { type: "string", nullable: true },
                    motd: { type: "object", properties: { enabled: { type: "boolean" }, title: { type: "string", nullable: true }, body: { type: "string", nullable: true } } },
                    donate: {
                      type: "object",
                      description: "Each value passes through safeExternalHref; non-http(s) values collapse to null.",
                      required: ["paypal", "venmo", "zelle", "amazon", "patreon", "buyMeACoffee"],
                      properties: {
                        paypal: { type: "string", nullable: true },
                        venmo: { type: "string", nullable: true },
                        zelle: { type: "string", nullable: true },
                        amazon: { type: "string", nullable: true },
                        patreon: { type: "string", nullable: true },
                        buyMeACoffee: { type: "string", nullable: true },
                      },
                    },
                    features: { type: "object", additionalProperties: { type: "boolean" }, description: "The feature.* flag map" },
                  },
                },
              },
            },
          },
          "401": { description: "Unauthenticated" },
        },
      },
    },
    "/play-history/calendar": {
      get: {
        tags: ["Play History"],
        summary: "365-day activity heatmap data (ADMIN)",
        description: "One row per UTC day with a watched-session count. Unrecognized `source` / `mediaType` values are ignored (the heatmap is then unfiltered).",
        parameters: [
          { name: "source", in: "query", schema: { type: "string", enum: ["plex", "jellyfin"] } },
          { name: "mediaType", in: "query", schema: { type: "string", enum: ["MOVIE", "TV"] } },
        ],
        responses: {
          "200": { description: "Array of { day: \"YYYY-MM-DD\", count }", content: { "application/json": { schema: { type: "array", items: { type: "object", properties: { day: { type: "string", format: "date" }, count: { type: "integer" } } } } } } },
          "403": { description: "Forbidden — ADMIN only" },
        },
      },
    },
    "/play-history/transcode-offenders": {
      get: {
        tags: ["Play History"],
        summary: "Titles/users driving the most transcodes (ADMIN)",
        description: "Top 6 users and top 6 titles forcing server-side transcodes in the window. Unrecognized `source` / `mediaType` values are ignored.",
        parameters: [
          { name: "days", in: "query", schema: { type: "integer", default: 30, minimum: 1, maximum: 3650 }, description: "Window in days; clamped, a non-number means 30" },
          { name: "source", in: "query", schema: { type: "string", enum: ["plex", "jellyfin"] } },
          { name: "mediaType", in: "query", schema: { type: "string", enum: ["MOVIE", "TV"] } },
        ],
        responses: {
          "200": {
            description: "{ topUsers: [{ id (MediaServerUser id), username, source, count }], topTitles: [{ title, tmdbId, mediaType, count }] }",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["topUsers", "topTitles"],
                  properties: {
                    topUsers: {
                      type: "array",
                      maxItems: 6,
                      items: {
                        type: "object",
                        required: ["id", "username", "source", "count"],
                        properties: {
                          id: { type: "string", description: "The MediaServerUser id — usernames are not unique" },
                          username: { type: "string" },
                          source: { type: "string" },
                          count: { type: "integer" },
                        },
                      },
                    },
                    topTitles: {
                      type: "array",
                      maxItems: 6,
                      items: {
                        type: "object",
                        required: ["title", "tmdbId", "mediaType", "count"],
                        properties: { title: { type: "string" }, tmdbId: { type: "integer", nullable: true }, mediaType: { type: "string", nullable: true }, count: { type: "integer" } },
                      },
                    },
                  },
                },
              },
            },
          },
          "403": { description: "Forbidden — ADMIN only" },
        },
      },
    },
    "/admin/library/match-check": {
      get: {
        tags: ["Admin – Debug"],
        summary: "The stored library match check, or poll a running one (ADMIN)",
        description:
          "Without `job`: `{ report }` — the last stored check, or null. Each flag is a Plex/Jellyfin item whose folder Radarr/Sonarr say holds a different title " +
          "(`wrongMatch`), an item the sync can't place for want of a TMDB id (`noTmdbId`), or, in a folder no Radarr/Sonarr manages, a \"Name (YYYY)\" folder whose " +
          "year is more than one year from the match (`yearMismatch`). `sibling` marks an item in a folder another item already matches (an extra or a second part). " +
          "With `job`: 202 `{ job, running: true }` while a background check runs, then its answer.",
        parameters: [
          { name: "job", in: "query", required: false, schema: { type: "string", pattern: "^[0-9a-f]{32}$" }, description: "The job id from the POST's 202" },
        ],
        responses: {
          "200": {
            description: "`{ report: { version, checkedAt, sources, counts, flags, truncated } | null }`, or the finished job's answer",
            content: {
              "application/json": {
                schema: {
                  oneOf: [
                    {
                      type: "object",
                      description: "Without `job`: the last stored report, or null",
                      required: ["report"],
                      properties: {
                        report: {
                          type: "object",
                          nullable: true,
                          properties: {
                            version: { type: "integer", enum: [1] },
                            checkedAt: { type: "string", format: "date-time" },
                            sources: { type: "array", items: MATCH_CHECK_SOURCE },
                            counts: MATCH_CHECK_COUNTS,
                            flags: {
                              type: "array",
                              maxItems: 2000,
                              description: "One per flagged item (MatchFlag, src/lib/library-match.ts). Each also carries the item's full `path` (ADMIN data the item-mode fix reads), left out here.",
                              items: {
                                type: "object",
                                properties: {
                                  kind: { type: "string", enum: ["wrongMatch", "noTmdbId", "yearMismatch"] },
                                  server: { type: "string", enum: ["plex", "jellyfin"] },
                                  serverInstance: { type: "string" },
                                  mediaType: { $ref: "#/components/schemas/MediaType" },
                                  itemKey: { type: "string", description: "Plex ratingKey / Jellyfin item id — POST it to /admin/fix-match as `itemKey`" },
                                  title: { type: "string", nullable: true },
                                  year: { type: "integer", nullable: true },
                                  folder: { type: "string", nullable: true, description: "The folder NAME the item was judged by (display only)" },
                                  file: { type: "string", nullable: true, description: "The item's own file name, when its path is a file (display only)" },
                                  serverTmdbId: { type: "integer", nullable: true, description: "The first TMDB id the server gives it" },
                                  arr: {
                                    type: "object",
                                    nullable: true,
                                    description: "What Radarr/Sonarr say the folder is; null when none manages it",
                                    properties: {
                                      service: ARR_SERVICE,
                                      instance: { type: "string" },
                                      tmdbId: { type: "integer", nullable: true },
                                      tvdbId: { type: "integer", nullable: true },
                                      title: { type: "string", nullable: true },
                                      year: { type: "integer", nullable: true },
                                    },
                                  },
                                  sibling: { type: "boolean", description: "Another item in the same folder already agrees with Radarr/Sonarr (an extra or a second part)" },
                                },
                              },
                            },
                            truncated: { type: "integer", description: "Flags past the stored cap, not stored" },
                          },
                        },
                      },
                    },
                    MATCH_CHECK_RUN,
                  ],
                },
              },
            },
          },
          "202": jobAnswer("The job is still running: { job, running: true }", JOB_RUNNING),
          "403": { description: "Not ADMIN" },
          "404": { description: "The job is unknown — expired, another admin's, or dropped by a restart" },
        },
      },
      post: {
        tags: ["Admin – Debug"],
        summary: "Run the library match check (ADMIN)",
        description:
          "Lists every configured Plex/Jellyfin server's movies and shows (every copy, every unmatched item) and every Radarr/Sonarr title with its folder, judges " +
          "them, and stores the report. Read-only towards every server. A source that can't be read is named in `sources` and judged nothing. No body is the " +
          "synchronous run; `{ async: true }` answers 202 `{ job }` at once — poll GET `?job=`. The same admin asking again while theirs runs joins it (no rate " +
          "token). 3 runs per 10 minutes per admin.",
        requestBody: {
          required: false,
          content: { "application/json": { schema: { type: "object", properties: {
            async: { type: "boolean", description: "Run as a background job: 202 { job }, poll GET ?job=. Default: synchronous" },
          } } } },
        },
        responses: {
          "200": {
            description: "`{ ok: true, checkedAt, counts, sources, truncated }`, or `{ ok: false, aborted: true }` when the run hit its time limit (nothing stored)",
            content: { "application/json": { schema: MATCH_CHECK_RUN } },
          },
          "202": jobAnswer("async: true — the check runs in the background: { job }", JOB_STARTED),
          "403": { description: "Not ADMIN" },
          "409": { description: "A check is already running — { ok: false, error, retryAfter: 30 }", headers: { "Retry-After": { schema: { type: "integer" }, description: "Seconds (30)" } } },
          "413": { description: "Request body over the 1 KB cap" },
          "429": { description: "Rate limited (3 per 10 minutes per admin)" },
        },
      },
    },
    "/admin/library/bad-matches": {
      get: {
        tags: ["Admin – Debug"],
        summary: "Library items whose TMDB match looks wrong (ADMIN)",
        description: "Apply a fix with POST /admin/fix-match.",
        parameters: [{ name: "mediaType", in: "query", schema: { type: "string", enum: ["movie", "tv"] }, description: "LOWERCASE here (unlike most endpoints); anything else lists both" }],
        responses: {
          "200": {
            description: "{ badMatches: [...], capped } — capped: a library past the 25,000-row cap was only partly compared",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["badMatches", "capped"],
                  properties: {
                    badMatches: {
                      type: "array",
                      description: "Titles the two servers hold at the same mount-relative path under different TMDB ids (BadMatchItem, src/lib/bad-matches.ts). Each also carries that shared `relativePath`, left out here.",
                      items: {
                        type: "object",
                        properties: {
                          plex: BAD_MATCH_SIDE,
                          plexRatingKey: { type: "string", nullable: true },
                          jellyfin: BAD_MATCH_SIDE,
                          jellyfinItemId: { type: "string", nullable: true },
                          arrTmdbId: { type: "integer", nullable: true, description: "The TMDB id Radarr/Sonarr hold for the folder" },
                          arrVerdict: { type: "string", nullable: true, enum: ["plex", "jellyfin"], description: "The side Radarr/Sonarr agree with" },
                        },
                      },
                    },
                    capped: { type: "boolean" },
                  },
                },
              },
            },
          },
          "500": { description: "The scan failed" },
        },
      },
    },
    "/discord/status": {
      get: {
        tags: ["Discord"],
        summary: "Whether the caller has a linked Discord account",
        responses: {
          "200": {
            description: "{ discordId, linked }",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["discordId", "linked"],
                  properties: { discordId: { type: "string", nullable: true }, linked: { type: "boolean" } },
                },
              },
            },
          },
        },
      },
    },
    "/discord/unlink": {
      post: {
        tags: ["Discord"],
        summary: "Unlink the caller's Discord account",
        responses: {
          "200": {
            description: "{ ok: true } — also strips the Discord roles Summonarr granted, in the background",
            content: { "application/json": { schema: OK_TRUE } },
          },
        },
      },
    },
    "/report": {
      post: {
        tags: ["Issues"],
        summary: "Report objectionable content (native app)",
        description: "Writes a CONTENT_REPORT audit row for the admins. The reported content must exist. 10 reports per hour per user; refused with 503 while maintenance mode applies to the caller.",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["contentType", "contentId"], properties: {
          contentType: { type: "string", enum: ["issue_message", "vote_reason", "issue"] },
          contentId: { type: "string", maxLength: 200, description: "The id of the IssueMessage, DeletionVote or Issue" },
          context: { type: "string", maxLength: 200, description: "Optional; cut to 200 characters" },
          reason: { type: "string", maxLength: 500, description: "Optional; cut to 500 characters" },
        } } } } },
        responses: {
          "200": { description: "{ ok: true } — report received", content: { "application/json": { schema: OK_TRUE } } },
          "400": { description: "Unknown contentType or missing/oversized contentId" },
          "404": { description: "No such content" },
          "429": { description: "Rate limited (10/hour)" },
          "503": { description: "Maintenance mode" },
        },
      },
    },
    "/requests/bulk": {
      post: {
        tags: ["Requests"],
        summary: "Bulk-create requests, optionally on behalf of another user (REQUEST, REQUEST_MOVIE or REQUEST_TV)",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["items"], properties: { items: { type: "array", minItems: 1, maxItems: BULK_REQUEST_MAX_ITEMS, items: { type: "object", required: ["tmdbId", "mediaType"], properties: { tmdbId: { type: "integer", minimum: 1 }, mediaType: { $ref: "#/components/schemas/MediaType" } } } }, onBehalfOfUserId: { type: "string", nullable: true } } } } },
        },
        responses: {
          "201": {
            description: "{ results, created } — at least one request row was created; `results` is one { tmdbId, mediaType, result } per item, `result` being created | auto-approved | already-available | already-requested | skipped-declined | no-permission | blacklisted | rating-blocked | error. An auto-approval whose Radarr/Sonarr push failed went back to PENDING: its result is `created` with `pushFailed: true` (additive), and the call sends one admin alert for all of them",
            content: { "application/json": { schema: REQUEST_BULK_ANSWER } },
          },
          "200": {
            description: "{ results, created: 0 } — nothing was created (every item skipped: blacklisted, no permission, already available or requested, declined, rating-blocked, or a failed metadata lookup)",
            content: { "application/json": { schema: REQUEST_BULK_ANSWER } },
          },
          "400": { description: "Validation error: items missing, empty or over " + BULK_REQUEST_MAX_ITEMS + ", an invalid tmdbId/mediaType, or a non-string onBehalfOfUserId" },
          "403": { description: "Not permitted (on-behalf without REQUEST_ON_BEHALF, a target with more permissions than the caller, or the Discord-link requirement)" },
          "404": { description: "The on-behalf target user does not exist" },
          "422": { description: "The on-behalf target is deactivated" },
          "429": { description: "Rate limited (the admin's requests-per-minute setting), or the target's quota would be exceeded" },
          "503": { description: "Maintenance mode" },
        },
      },
    },
    "/requests/quality-profiles": {
      get: {
        tags: ["Requests"],
        summary: "Quality profiles for the request-time picker (REQUEST_ADVANCED / MANAGE_REQUESTS)",
        parameters: [
          { name: "mediaType", in: "query", required: true, schema: { $ref: "#/components/schemas/MediaType" } },
          { name: "instance", in: "query", schema: { type: "string" }, description: "Instance slug ('' default, '4k', or named)" },
          { name: "is4k", in: "query", schema: { type: "boolean" }, description: "Legacy shorthand for instance=4k" },
        ],
        description: "A live Radarr/Sonarr read (`mediaType` picks the service). A non-default instance needs the caller's grant unless they hold MANAGE_REQUESTS; an ungranted and an unknown slug answer the same 403. 120 per minute per user.",
        responses: {
          "200": {
            description: "{ qualityProfiles: [{ id, name }], defaultId }",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["qualityProfiles", "defaultId"],
                  properties: {
                    qualityProfiles: {
                      type: "array",
                      maxItems: 200,
                      items: { type: "object", required: ["id", "name"], properties: { id: { type: "integer" }, name: { type: "string" } } },
                    },
                    defaultId: { type: "integer", nullable: true, description: "The instance's configured default profile, if any" },
                  },
                },
              },
            },
          },
          "400": { description: "mediaType is not MOVIE|TV, or the instance slug is invalid" },
          "403": { description: "Not permitted to read that instance" },
          "422": { description: "That instance is not configured" },
          "429": { description: "Rate limited" },
          "502": { description: "The arr could not be reached" },
        },
      },
    },
    "/requests/instances": {
      get: {
        tags: ["Requests"],
        summary:
          "NAMED Radarr/Sonarr instances the caller may request this title on, with its per-instance request/availability state — the data behind the detail page's \"Request on <instance>\" actions. Excludes the default ('') and '4k' instances, which are the plain and 4K request actions.",
        parameters: [
          { name: "tmdbId", in: "query", required: true, schema: { type: "integer" } },
          { name: "mediaType", in: "query", required: true, schema: { $ref: "#/components/schemas/MediaType" } },
        ],
        responses: {
          "200": {
            description:
              "{ instances: [{ slug, name, requested, available }] }. Filtered to instances this caller may target, so an ungranted or unknown slug is simply absent; empty when none are configured, none are grantable, or the title is blacklisted",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["instances"],
                  properties: {
                    instances: {
                      type: "array",
                      items: {
                        type: "object",
                        required: ["slug", "name", "requested", "available"],
                        properties: {
                          slug: { type: "string" },
                          name: { type: "string" },
                          requested: { type: "boolean", description: "The caller already has a live (non-DECLINED) request on this instance" },
                          available: { type: "boolean", description: "The title is already on this instance" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          "400": { description: "mediaType is not MOVIE|TV, or tmdbId is invalid or out of range" },
          "429": { description: "Rate limited (60/min)" },
        },
      },
    },
    "/requests/users": {
      get: {
        tags: ["Requests"],
        summary: "Users the caller may request on behalf of (REQUEST_ON_BEHALF)",
        description: "Active accounts only (deactivated ones are left out), at most 1000, by name. A non-ADMIN caller is offered only targets whose permissions are a subset of their own, since the bulk route refuses any other — read on past ineligible accounts until 1000 are found or 50,000 were scanned.",
        responses: {
          "200": {
            description: "{ users: [{ id, name, email }] }",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["users"],
                  properties: {
                    users: {
                      type: "array",
                      maxItems: 1000,
                      items: {
                        type: "object",
                        required: ["id", "name", "email"],
                        properties: { id: { type: "string" }, name: { type: "string", nullable: true }, email: { type: "string" } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/issues/{id}/claim": {
      post: {
        tags: ["Issues"],
        summary: "Claim, release or take over an issue (ADMIN / ISSUE_ADMIN)",
        description: "A toggle: unclaimed → claim for the caller; claimed by the caller → release; claimed by someone else → take over. Replies on a claimed issue narrow to the claimer and the reporter.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { required: false, content: { "application/json": { schema: { type: "object", properties: {
          expectedClaimedBy: { type: "string", nullable: true, description: "Who the caller saw as the claimer (null = unclaimed). When present and it no longer matches, the call is refused with 409 instead of silently taking over. Omit to toggle without the check" },
        } } } } },
        responses: {
          "200": {
            description: "{ id, claimedBy, claimedAt, claimedUser: { id, name, email } | null } after the change",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["id", "claimedBy", "claimedAt", "claimedUser"],
                  properties: {
                    id: { type: "string" },
                    claimedBy: { type: "string", nullable: true, description: "The claimer's user id; null once released" },
                    claimedAt: { type: "string", format: "date-time", nullable: true },
                    claimedUser: {
                      type: "object",
                      nullable: true,
                      required: ["id", "name", "email"],
                      properties: { id: { type: "string" }, name: { type: "string", nullable: true }, email: { type: "string" } },
                    },
                  },
                },
              },
            },
          },
          "400": { description: "`expectedClaimedBy` is neither null nor a string" },
          "404": { description: "No such issue" },
          "409": { description: "{ error: \"claim-conflict\", message } — the claim changed since the caller read it" },
          "503": { description: "Maintenance mode" },
        },
      },
    },
    "/push/apns": {
      post: {
        tags: ["Push"],
        summary: "Register an iOS APNs device token (native)",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["deviceToken"], properties: {
            deviceToken: { type: "string", pattern: "^(?:[0-9a-fA-F]{2}){32,100}$", description: "Hex APNs token, 32–100 bytes; stored lowercased" },
            label: { type: "string", maxLength: 100 },
            publicKey: { type: "string", nullable: true, description: "Optional P-256 X9.63 uncompressed key (65 bytes, base64) for encrypted rich pushes. Omitted = keep the stored key; an explicit null clears it; a malformed value is ignored" },
          } } } },
        },
        description: "Registers or updates the caller's device. Per-user cap (maxPushSubscriptions setting, default 5) evicts the oldest subscription. 10 per minute per user.",
        responses: {
          "200": { description: "{ ok: true }", content: { "application/json": { schema: OK_TRUE } } },
          "400": { description: "Invalid deviceToken" },
          "403": { description: "feature.integration.push is off" },
          "409": { description: "That device token is registered to another account — its owner must unregister it first" },
          "429": { description: "Rate limited" },
          "503": { description: "Maintenance mode" },
        },
      },
      delete: {
        tags: ["Push"],
        summary: "Unregister an iOS APNs device token",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["deviceToken"], properties: { deviceToken: { type: "string" } } } } },
        },
        responses: {
          "200": {
            description: "{ ok: true } — removed, or nothing matched (only the caller's own rows)",
            content: { "application/json": { schema: OK_TRUE } },
          },
          "400": { description: "deviceToken missing" },
        },
      },
    },
    "/events": {
      get: {
        tags: ["Events"],
        summary: "Server-sent events stream for real-time UI updates",
        description: "A heartbeat every 25 seconds; the session is re-validated against the database every minute (a revoked or demoted session stops receiving admin/issue/request frames), and the stream is closed after one hour, so clients reconnect. At most 5 concurrent streams per user and SSE_MAX_LISTENERS (default 500) in total. The inbox frames (`request:updated`, `request:comment`, `issue:updated`, `issuemessage:created`) carry a boolean `own` (additive): true when the event is about the viewer, so a client re-reads its inbox only for those — never the other user's id.",
        responses: {
          "200": {
            description: "SSE stream",
            content: { "text/event-stream": { schema: { type: "string" } } },
          },
          "401": { description: "Not signed in" },
          "429": { description: "Too many SSE connections (per user or in total)" },
          "503": { description: "Maintenance mode" },
        },
      },
    },
  },
} satisfies OpenApiDocument;

export const GET = withPermission(Permission.ADMIN)(async (_req, _ctx, _session) => {
  return NextResponse.json(spec, {
    headers: { "Cache-Control": "no-store" },
  });
});
