// Pipeline inspection and the library match check.

import { MDBLIST_PLAN_CHOICES, MDBLIST_PLANS } from "@/lib/mdblist-plan";
import {
  JOB_STARTED,
  JOB_RUNNING,
  jobAnswer,
  RATING_FIELDS,
  ARR_ERROR_KINDS,
  ARR_SERVICE,
  tooLargeAnswer,
  RETRY_AFTER_HEADER,
} from "../shared";
import type { OpenApiSchema, OpenApiPaths } from "../types";

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

// GET /admin/debug/arr-state pieces (src/app/api/admin/debug/arr-state/route.ts).
// Sonarr's completion verdict for one instance (sonarrSeriesCompletion, guardrail 14a).
const DEBUG_LIVE_COMPLETION = {
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
} satisfies OpenApiSchema;

// One configured instance of the service: its cache row and its live answers.
const DEBUG_INSTANCE = {
  type: "object",
  properties: {
    slug: { type: "string" },
    name: { type: "string" },
    cacheRow: DEBUG_WANTED_ROW,
    hasEntry: { type: "boolean" },
    liveArrApi: DEBUG_LIVE_CHECK,
    liveCompletion: DEBUG_LIVE_COMPLETION,
  },
} satisfies OpenApiSchema;

const DEBUG_REQUEST_ROW = {
  type: "object",
  properties: {
    id: { type: "string" },
    status: { $ref: "#/components/schemas/RequestStatus" },
    requestedBy: { type: "string" },
    tvdbId: { type: "integer", nullable: true },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
} satisfies OpenApiSchema;

const DEBUG_TVDB_INFO = {
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
} satisfies OpenApiSchema;

export const adminDebugPaths: OpenApiPaths = {
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
                    items: DEBUG_INSTANCE,
                  },
                  attachArrPendingReturns: { type: "boolean" },
                  liveArrApi: DEBUG_LIVE_CHECK,
                  mediaRequests: {
                    type: "array",
                    items: DEBUG_REQUEST_ROW,
                  },
                  tvdbInfo: DEBUG_TVDB_INFO,
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
      responses: { "429": { description: "More than 5 live probes (?live=1) a minute by this admin (Retry-After set); the read-only dump is not limited", headers: RETRY_AFTER_HEADER },
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
                      reportedPlan: { type: "string", nullable: true, enum: [...MDBLIST_PLANS.map((p) => p.id), null], description: "The plan that limit matches, if any" },
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
        "413": tooLargeAnswer(8 * 1024),
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
                        arrVerdict: { type: "string", nullable: true, enum: ["plex", "jellyfin", null], description: "The side Radarr/Sonarr agree with" },
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
};
