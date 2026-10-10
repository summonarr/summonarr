import { NextResponse } from "next/server";
import { withPermission } from "@/lib/api-auth";
import { LOCALES } from "@/lib/i18n/locales";
import { Permission } from "@/lib/permissions";

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
};
const MFA_STEP_UP_400 =
  "Missing or wrong password, or a missing/invalid second factor ({ error, secondFactorRequired: true, methods? })";
function mfaStepUpBody(extra: Record<string, unknown> = {}, extraRequired: string[] = []) {
  return {
    type: "object",
    required: ["password", ...extraRequired],
    properties: { password: { type: "string" }, secondFactor: MFA_SECOND_FACTOR_SCHEMA, ...extra },
  };
}

const spec = {
  openapi: "3.0.3",
  info: {
    title: "Summonarr API",
    version: "1.0.0",
    description:
      "Internal REST API for Summonarr — media request aggregator with Plex/Jellyfin, Radarr/Sonarr, and TMDB integration.",
  },
  servers: [{ url: "/api", description: "Application API" }],
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
      RequestStatus: {
        type: "string",
        enum: ["PENDING", "APPROVED", "DECLINED", "AVAILABLE"],
      },
      UserRole: { type: "string", enum: ["USER", "ADMIN", "ISSUE_ADMIN"] },
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
    { name: "Admin – Missing", description: "Radarr/Sonarr titles that should already have a file: released movies and aired episodes — or, in cutoff mode, files below the quality profile's cutoff (ADMIN only)" },
    { name: "Admin – Downloads", description: "Radarr/Sonarr download queues, health checks, the Summonarr webhook connection and \"Open in\" links (ADMIN only)" },
    { name: "Discord", description: "Discord OAuth / role sync" },
    { name: "Settings", description: "Application settings (ADMIN only)" },
    { name: "Webhooks", description: "Inbound webhooks from media servers / ARR" },
    { name: "Cron", description: "Scheduled maintenance jobs (CRON_SECRET)" },
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
          { name: "mediaType", in: "query", schema: { type: "string", enum: ["movie", "tv"] } },
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "sortBy", in: "query", schema: { type: "string" } },
          { name: "genreId", in: "query", schema: { type: "string" } },
          { name: "keywordId", in: "query", schema: { type: "string" } },
          { name: "fromYear", in: "query", schema: { type: "integer" } },
          { name: "toYear", in: "query", schema: { type: "integer" } },
          { name: "minRating", in: "query", schema: { type: "number" } },
          { name: "minVoteCount", in: "query", schema: { type: "integer" } },
          { name: "ratingFilter", in: "query", schema: { type: "string" } },
          { name: "watchProvider", in: "query", schema: { type: "string" } },
          { name: "watchRegion", in: "query", schema: { type: "string" } },
          { name: "hideAvailable", in: "query", schema: { type: "boolean" } },
        ],
        responses: { "200": { description: "Enriched discovery results" } },
      },
    },
    "/home": {
      get: {
        tags: ["Discovery"],
        summary: "Home discovery rails (trending / popular / etc.)",
        responses: { "200": { description: "Grouped discovery rails with availability enrichment" } },
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
          "200": { description: "Ranked recommendation items ({ items, total, available }); each item carries recommendedBecause naming the strongest seed, plus recommendedBecause.seeds listing every seed (strongest first, capped at 25; seedCount is the true total)" },
          "404": { description: "feature.page.forYou is disabled" },
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
          "200": { description: "{ movies, tv, totalMovies, totalTv, totalPages, page, sort, rankOffset } with availability enrichment" },
          "403": { description: "feature.page.popular is disabled" },
          "429": { description: "Rate limited (30 req/min per user)" },
        },
      },
    },
    "/upcoming": {
      get: {
        tags: ["Discovery"],
        summary: "Upcoming releases",
        parameters: [
          { name: "hideAvailable", in: "query", schema: { type: "boolean" } },
        ],
        responses: { "200": { description: "Upcoming releases with availability enrichment" } },
      },
    },
    "/top-rated": {
      get: {
        tags: ["Discovery"],
        summary: "Top-rated movies or TV",
        parameters: [
          { name: "mediaType", in: "query", schema: { type: "string", enum: ["movie", "tv"] } },
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "sortBy", in: "query", schema: { type: "string" } },
          { name: "fromYear", in: "query", schema: { type: "integer" } },
          { name: "toYear", in: "query", schema: { type: "integer" } },
          { name: "minImdb", in: "query", schema: { type: "number" } },
          { name: "minVotes", in: "query", schema: { type: "integer" } },
          { name: "hideAvailable", in: "query", schema: { type: "boolean" } },
        ],
        responses: { "200": { description: "Top-rated results with availability enrichment" } },
      },
    },

    "/search": {
      get: {
        tags: ["Search"],
        summary: "Search TMDB for movies or TV shows",
        parameters: [
          { name: "q", in: "query", required: true, schema: { type: "string", maxLength: 200 } },
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
          "400": { description: "Missing or invalid query", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "429": { description: "Rate limited (30 req/min per user)" },
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
          { name: "q", in: "query", schema: { type: "string" }, description: "Title search filter" },
        ],
        responses: {
          "200": {
            description: "Paginated request list",
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    { $ref: "#/components/schemas/PaginatedMeta" },
                    { type: "object", properties: { requests: { type: "array", items: { $ref: "#/components/schemas/MediaRequest" } } } },
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
          "400": { description: "Validation error" },
          "409": { description: "Duplicate request" },
          "429": { description: "Quota exceeded" },
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
          "400": { description: "Missing or invalid tmdbId / mediaType" },
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
                  adminNote: { type: "string", maxLength: 1000 },
                  retry: { type: "boolean", description: "Re-push to Radarr/Sonarr" },
                  search: { type: "boolean", description: "Trigger search in ARR" },
                  permanent: { type: "boolean", description: "Permanently decline" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Updated request", content: { "application/json": { schema: { $ref: "#/components/schemas/MediaRequest" } } } },
          "403": { description: "Forbidden" },
          "404": { description: "Not found" },
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
          "are rate limited per admin.",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "season", in: "query", schema: { type: "integer", minimum: 0 } },
        ],
        responses: {
          "200": { description: "Releases, or for TV without a season the season list" },
          "400": { description: "Invalid season" },
          "403": { description: "Missing MANAGE_REQUESTS" },
          "404": { description: "No such request" },
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
          "The request's status is untouched — the Download webhook / sync flips it when the file lands. Audited " +
          "ARR_RELEASE_GRAB; the guid is never recorded (some indexers embed the apikey in it).",
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
          "200": { description: "Grabbed" },
          "400": { description: "Invalid body" },
          "403": { description: "Missing MANAGE_REQUESTS" },
          "404": { description: "No such request" },
          "409": { description: "Request not approved/available, or the title is not in the arr" },
          "410": { description: "Unknown or expired handle, or one from a different search — search again" },
          "502": { description: "The arr could not be reached or refused the grab" },
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
                  ids: { type: "array", items: { type: "string" }, maxItems: 100 },
                  status: { type: "string", enum: ["APPROVED", "DECLINED"] },
                  adminNote: { type: "string", maxLength: 1000 },
                  permanent: { type: "boolean", description: "On DECLINED, mark the request permanently declined" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description:
              "Batch result. On APPROVED, a request whose Radarr/Sonarr add fails is rolled back to PENDING and " +
              "reported in `failed` (with `arrError` summarizing, the same field the single-request PATCH returns); " +
              "both are omitted when every add landed.",
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
                  },
                },
              },
            },
          },
          "429": { description: "Rate limited (10/min per admin)" },
        },
      },
    },

    "/issues": {
      get: {
        tags: ["Issues"],
        summary: "List issues",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", default: 50, maximum: 100 } },
        ],
        responses: {
          "200": {
            description: "Issues for the caller (own issues, or all when MANAGE_ISSUES)",
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
          "201": { description: "Created issue (tvdbId is resolved server-side from tmdbId, never taken from the body)", content: { "application/json": { schema: { $ref: "#/components/schemas/Issue" } } } },
          "400": { description: "Validation error" },
          "403": { description: "feature.page.issues is disabled" },
          "422": { description: "Title could not be verified with TMDB, or is not in a library the caller can see" },
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
                  refetch: { type: "boolean", description: "Trigger a Radarr/Sonarr re-search for the issue media" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Updated issue" },
          "403": { description: "Forbidden" },
          "404": { description: "Not found" },
        },
      },
      delete: {
        tags: ["Issues"],
        summary: "Delete an issue (ADMIN / ISSUE_ADMIN)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Deleted" },
        },
      },
    },
    "/issues/{id}/messages": {
      get: {
        tags: ["Issues"],
        summary: "List messages on an issue",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Message list" } },
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
        responses: { "200": { description: "Message added" } },
      },
    },
    "/issues/{id}/releases": {
      post: {
        tags: ["Issues"],
        summary: "Grab a specific release for the issue's media (ADMIN / ISSUE_ADMIN)",
        description:
          "CAS-claims the issue to IN_PROGRESS before the grab, then records an instance-scoped IssueGrab row. Routes to Radarr for a MOVIE issue and Sonarr for a TV one.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["guid", "indexerId"],
                properties: {
                  guid: { type: "string", minLength: 1, maxLength: 500, description: "Release GUID from the GET on this path" },
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
          "409": { description: "Issue is already RESOLVED, or lost the claim race" },
          "413": { description: "Request body over the 64 KB cap" },
          "422": { description: "Named instance not configured, TVDB resolution failed, or the issue scope is invalid" },
          "502": { description: "Radarr/Sonarr rejected the grab" },
          "503": { description: "Maintenance mode" },
        },
      },
      get: {
        tags: ["Issues"],
        summary: "Get Sonarr/Radarr releases for issue media (ADMIN / ISSUE_ADMIN)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Available releases from ARR" } },
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
                    { type: "object", properties: { items: { type: "array", items: { type: "object" } } } },
                  ],
                },
              },
            },
          },
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
          "201": { description: "Vote recorded — the body is the created DeletionVote row, not an empty ack" },
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
        responses: { "200": { description: "Vote retracted" } },
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
                    imdbId: { type: "string", nullable: true },
                    imdbRating: { type: "string", nullable: true },
                    imdbVotes: { type: "string", nullable: true },
                    rottenTomatoes: { type: "string", nullable: true },
                    rtAudienceScore: { type: "string", nullable: true },
                    metacritic: { type: "string", nullable: true },
                    traktRating: { type: "string", nullable: true },
                    letterboxdRating: { type: "string", nullable: true },
                    mdblistScore: { type: "string", nullable: true },
                  },
                },
              },
            },
          },
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
                      },
                    },
                  },
                },
              },
            },
          },
        },
        responses: { "200": { description: "{ ratings } — a map keyed \"<type>:<tmdbId>\" (e.g. \"movie:603\") → ratings; titles with no ratings are omitted" } },
      },
    },

    "/play-history": {
      get: {
        tags: ["Play History"],
        summary: "List play history across all users (ADMIN)",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer" } },
          {
            name: "distinct", in: "query", schema: { type: "string", enum: ["platforms", "users"] },
            description:
              "A MODE SWITCH, not a boolean. `platforms` returns a bare string[] of non-null platforms; `users` returns a bare array of { id, username, source } over every MediaServerUser (departed ones included, per guardrail 28). Both ignore every other parameter. Any other value — including `true` — falls through to the paginated list.",
          },
          { name: "ungrouped", in: "query", schema: { type: "boolean" } },
          { name: "sortBy", in: "query", schema: { type: "string" } },
          { name: "sortDir", in: "query", schema: { type: "string", enum: ["asc", "desc"] } },
          { name: "source", in: "query", schema: { type: "string", enum: ["plex", "jellyfin"] } },
          { name: "watched", in: "query", schema: { type: "string" } },
          { name: "playMethod", in: "query", schema: { type: "string" } },
          { name: "platform", in: "query", schema: { type: "string" } },
          { name: "startDate", in: "query", schema: { type: "string", format: "date" } },
          { name: "endDate", in: "query", schema: { type: "string", format: "date" } },
          { name: "search", in: "query", schema: { type: "string" } },
          { name: "userId", in: "query", schema: { type: "string" } },
          { name: "tmdbId", in: "query", schema: { type: "integer" } },
        ],
        responses: { "200": { description: "Paginated play history rows" }, "403": { description: "Forbidden" } },
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
          "200": { description: "{ item, plays (capped at 100, newest first), firstStartedAt, lastStartedAt }" },
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
          },
        },
      },
    },
    "/play-history/sessions": {
      get: {
        tags: ["Sessions"],
        summary: "List active playback sessions (ADMIN)",
        responses: {
          "200": { description: "Active ActiveSession rows ordered by start time" },
          "403": { description: "Forbidden" },
        },
      },
    },
    "/play-history/stats": {
      get: {
        tags: ["Play History"],
        summary: "Play history statistics",
        responses: { "200": { description: "Aggregate stats (total runtime, titles, etc.)" } },
      },
    },
    "/play-history/export": {
      get: {
        tags: ["Play History"],
        summary: "Export play history as CSV (ADMIN)",
        responses: { "200": { description: "CSV file download" } },
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
                schema: { type: "object", description: "Full PlayHistory row plus mediaServerUser { id, username, source, thumbUrl }" },
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
                  confirmPassword: { type: "string", description: "Step-up re-authentication, required to revoke a session other than the caller's own" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Session revoked" },
          "401": { description: "Step-up authentication required or failed" },
          "429": { description: "Rate limited" },
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
        responses: { "200": { description: "Season episodes with availability" } },
      },
    },

    "/tv-availability": {
      get: {
        tags: ["TV Availability"],
        summary: "Episode-level availability for a TV show",
        parameters: [
          { name: "tmdbId", in: "query", required: true, schema: { type: "integer" } },
          { name: "source", in: "query", schema: { type: "string", enum: ["plex", "jellyfin"] } },
        ],
        responses: { "200": { description: "Per-episode availability map" } },
      },
    },

    "/person/{id}": {
      get: {
        tags: ["Person"],
        summary: "Get TMDB person details and credits",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        responses: { "200": { description: "Person details with cast/crew credits" } },
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
                  newPassword: { type: "string", minLength: 12 },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Password updated ({ ok, requiresRelogin }) — every session is revoked" },
          "400": { description: "Validation error, or wrong current password" },
          "403": { description: "SSO account — local passwords are not available" },
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
          },
        },
      },
      delete: {
        tags: ["Profile"],
        summary: "Turn two-factor off (removes every factor and recovery code)",
        requestBody: { required: true, content: { "application/json": { schema: mfaStepUpBody() } } },
        responses: {
          "200": { description: "Turned off; every OTHER session is signed out" },
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
          "200": { description: "{ challengeToken, publicKey } — publicKey is PublicKeyCredentialRequestOptions (base64url); send the assertion back as secondFactor { method: \"webauthn\", credential, challengeToken }. Single-use, 5-minute, bound to this user and session" },
          "400": { description: "The account has no passkeys" },
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
          "200": { description: "{ secret, otpauthUri } — shown once; nothing changes until /totp/enable confirms a code" },
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
          "200": { description: "{ ok, recoveryCodes? } — recoveryCodes (shown once) when this is the first factor, which also signs out every other session" },
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
          "200": { description: "Removed (recovery codes too, and every OTHER session signed out, when no passkey remains)" },
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
          "200": { description: "{ recoveryCodes } — shown once; only hashes are stored" },
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
          "200": { description: "{ registrationToken, publicKey } — publicKey is PublicKeyCredentialCreationOptions with base64url binary fields; the token is single-use, 5-minute, bound to this user and session" },
          "400": { description: `${MFA_STEP_UP_400}, or the passkey limit is reached` },
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
          "200": { description: "{ ok, recoveryCodes? } — recoveryCodes when this is the first factor, which also signs out every other session" },
          "400": { description: "Expired/foreign registration token, a token issued on the password alone to an account that has since gained a factor, or the response failed verification" },
          "409": { description: "That credential is already registered" },
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
        responses: { "200": { description: "Renamed" }, "400": { description: `${MFA_STEP_UP_400}, or an empty name` }, "404": { description: "Not the caller's passkey" }, "429": { description: "Too many step-up attempts, or code entry is locked" } },
      },
      delete: {
        tags: ["Profile"],
        summary: "Remove one of the caller's passkeys",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { required: true, content: { "application/json": { schema: mfaStepUpBody() } } },
        responses: { "200": { description: "Removed (recovery codes too, and every OTHER session signed out, when it was the last factor)" }, "400": { description: MFA_STEP_UP_400 }, "404": { description: "Not the caller's passkey" }, "429": { description: "Too many step-up attempts, or code entry is locked" } },
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
        responses: { "200": { description: "Stored" }, "400": { description: "Unsupported locale" } },
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
                  notificationEmail: {
                    type: "string", nullable: true,
                    description: "Jellyfin-provider accounts only — any other provider gets 403. Null clears it.",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Preferences updated" },
          "403": { description: "notificationEmail was sent by a non-Jellyfin account" },
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
        responses: { "200": { description: "Saved" }, "400": { description: "plexWatchlist is not a boolean" } },
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
            content: {
              "application/json": {
                schema: {
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
                },
              },
            },
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
          "200": { description: "Saved — the connection state" },
          "400": { description: "Neither field sent, or one is not a boolean" },
          "404": { description: "Trakt is not connected" },
        },
      },
      delete: {
        tags: ["Profile"],
        summary: "Disconnect Trakt",
        description: "Deletes the stored grant, the connection and the imported watch history, then revokes the token at Trakt (best-effort). Idempotent.",
        responses: { "200": { description: "Disconnected" } },
      },
    },
    "/profile/trakt/device": {
      post: {
        tags: ["Profile"],
        summary: "Start connecting Trakt (device-code flow)",
        description: "Answers the short code the user enters at the verification URL. The device code itself stays on the server. Poll POST /profile/trakt/device/poll every `interval` seconds until it answers connected, expired, denied or conflict.",
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
          "429": { description: "Too many starts, or Trakt is rate limiting" },
          "502": { description: "Trakt could not be reached" },
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
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Subscription registered" },
          "400": { description: "Missing fields, or an endpoint that is not a recognized push service" },
          "403": { description: "feature.integration.push is disabled" },
          "409": { description: "Endpoint already registered to another user" },
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
        responses: { "200": { description: "Subscription removed" }, "400": { description: "Neither id nor a valid endpoint supplied" } },
      },
    },
    "/push/test": {
      post: {
        tags: ["Push"],
        summary: "Send a test push notification to current user",
        responses: { "200": { description: "Test notification dispatched" } },
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
                required: ["name", "email", "password"],
                properties: {
                  name: { type: "string" },
                  email: { type: "string", format: "email" },
                  password: { type: "string", minLength: 12 },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "User created" },
          "400": { description: "Validation error or email already in use" },
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
          "502": { description: "QuickConnect disabled upstream, or the poll failed" },
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
          "200": { description: "QuickConnect initiation state (code, secret) plus any flow state" },
          "400": { description: "Invalid instance slug" },
          "502": { description: "QuickConnect is disabled or unavailable upstream" },
          "503": { description: "Jellyfin not configured" },
        },
      },
    },
    "/auth/me": {
      get: {
        tags: ["Auth"],
        summary: "Get the current authenticated session (cookie or bearer)",
        responses: {
          "200": { description: "Current user/session payload" },
          "401": { description: "Not authenticated" },
        },
      },
    },
    "/auth/sign-out": {
      post: {
        tags: ["Auth"],
        summary: "Sign out the current session (clears cookie / revokes session)",
        responses: { "200": { description: "Signed out" } },
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
          "200": { description: "Sessions revoked" },
          "401": { description: "Step-up authentication required or failed" },
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
          "429": { description: "Too many regenerations" },
        },
      },
      delete: {
        tags: ["Profile"],
        summary: "Revoke the calendar feed URL",
        responses: {
          "200": { description: "Revoked ({ ok: true })" },
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
        responses: {
          "200": { description: "Account disabled (idempotent)" },
          "400": { description: "Cannot disable the last admin, or a missing/incorrect password on a local account" },
        },
      },
    },

    "/admin/users": {
      get: {
        tags: ["Admin – Users"],
        summary: "List users (ADMIN)",
        responses: { "200": { description: "User list" } },
      },
      post: {
        tags: ["Admin – Users"],
        summary: "Create a user (ADMIN)",
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
        responses: { "200": { description: "User created" }, "400": { description: "Validation error" } },
      },
    },
    "/admin/users/{id}": {
      patch: {
        tags: ["Admin – Users"],
        summary: "Update user settings (MANAGE_USERS)",
        description: "Conferring the ADMIN role, or editing an account that is already ADMIN, additionally requires the caller to hold ADMIN.",
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
                  notifyOnApproved: { type: "boolean" },
                  notifyOnAvailable: { type: "boolean" },
                  notifyOnDeclined: { type: "boolean" },
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
        responses: { "200": { description: "Updated fields" }, "403": { description: "Forbidden" } },
      },
      delete: {
        tags: ["Admin – Users"],
        summary: "Disable a user (MANAGE_USERS)",
        description:
          "Revokes every session and blocks sign-in. Reversible — nothing is scrubbed, the account's requests/issues/votes stay attached, and its Plex/Jellyfin link stays intact so play history keeps being attributed. Re-enable with POST /admin/users/{id}/reactivate; erase with POST /admin/users/{id}/purge.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "User disabled (idempotent)" },
          "400": { description: "Cannot disable the last admin" },
          "403": { description: "Forbidden" },
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
          "200": { description: "User re-enabled (idempotent)" },
          "400": { description: "Account was purged and cannot be re-enabled" },
          "403": { description: "Forbidden" },
          "409": { description: "Account state changed concurrently" },
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
          "200": { description: "Personal data purged (idempotent)" },
          "400": { description: "Account must be disabled before it can be purged" },
          "403": { description: "Forbidden" },
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
          "200": { description: "Reset" },
          "400": { description: "Own account" },
          "403": { description: "Forbidden" },
          "404": { description: "Not found" },
        },
      },
    },
    "/admin/arr-instances": {
      get: {
        tags: ["Admin – Settings"],
        summary: "List all Radarr/Sonarr instances with connection state (ADMIN)",
        responses: { "200": { description: "Instance lists keyed by service (secrets masked as has* flags)" } },
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
                        apiKey: { type: "string", description: "Write-only; send the mask sentinel to keep unchanged" },
                        rootFolder: { type: "string" },
                        qualityProfileId: { type: "integer", nullable: true },
                        webhookSecret: { type: "string", description: "Write-only; send the mask sentinel to keep unchanged" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Saved; includes per-instance connection test results" },
          "400": { description: "Invalid service or slug" },
        },
      },
    },
    "/admin/media-instances": {
      get: {
        tags: ["Admin – Settings"],
        summary: "List all Plex/Jellyfin server instances with connection state (ADMIN)",
        responses: { "200": { description: "Instance lists keyed by service (secrets masked as has* flags)" } },
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
                  instances: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["slug"],
                      properties: {
                        slug: { type: "string", description: "'' = default, or a named slug (lowercase alnum)" },
                        name: { type: "string" },
                        serverUrl: { type: "string", description: "Plex only" },
                        adminToken: { type: "string", description: "Plex only; write-only, send the mask sentinel to keep unchanged" },
                        adminEmail: { type: "string", description: "Plex only" },
                        url: { type: "string", description: "Jellyfin only" },
                        apiKey: { type: "string", description: "Jellyfin only; write-only, send the mask sentinel to keep unchanged" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Saved; includes per-instance connection test results" },
          "400": { description: "Invalid service or slug" },
        },
      },
    },
    "/admin/users/{id}/sessions": {
      get: {
        tags: ["Admin – Users"],
        summary: "List auth sessions for a user (ADMIN)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Auth session list" } },
      },
      delete: {
        tags: ["Admin – Users"],
        summary: "Revoke a specific auth session (ADMIN)",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "sessionId", in: "query", required: true, schema: { type: "string" } },
        ],
        responses: { "200": { description: "Session revoked" } },
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
                          excludedBy: { type: "array", items: { type: "string", enum: ["recentlyAdded", "activeRequest", "recentlyFulfilled", "watchlisted", "playingNow", "airing", "protected"] } },
                          candidate: { type: "boolean" },
                        },
                      },
                    },
                    arrErrors: { type: "array", items: { type: "object", properties: { service: { type: "string" }, instance: { type: "string" }, error: { type: "string" } } } },
                    protected: { type: "array", items: { type: "object", properties: { tmdbId: { type: "integer" }, mediaType: { type: "string" }, title: { type: "string", nullable: true }, reason: { type: "string", nullable: true }, createdAt: { type: "string", format: "date-time" } } } },
                    totals: { type: "object", properties: { candidates: { type: "integer" }, held: { type: "integer" }, reclaimableBytes: { type: "number" } } },
                  },
                },
              },
            },
          },
          "403": { description: "Not ADMIN" },
          "404": { description: "Library cleanup is disabled" },
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
          "201": { description: "Protected (an upsert)" },
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
          "200": { description: "{ ok: true, removed: <count> }" },
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
          "Radarr/Sonarr entry each occupies (every instance) and `targetCount`. `?execute=true` with the same body " +
          "plus `confirmTargets` equal to the live count deletes each target with `deleteFiles=true` and the " +
          "import-list exclusion flag; any other count answers 409 with the fresh plan. A title that is no longer a " +
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
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Dry run: { dryRun: true, targetCount, reclaimableBytes, items, skipped }. Execute: { dryRun: false, deletedCount, partialCount, failedCount, results, skipped }" },
          "400": { description: "Invalid body" },
          "403": { description: "Not ADMIN" },
          "404": { description: "Library cleanup is disabled" },
          "409": { description: "confirmTargets missing or not equal to the live count (the fresh plan is returned)" },
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
          "on. An instance whose listing failed is named in `errors` and contributes no items. Nothing is cached or written.",
        parameters: [
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
                    errors: { type: "array", items: { type: "object", properties: { instance: { type: "string" }, error: { type: "string" } } } },
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
          { name: "seriesId", in: "query", required: true, schema: { type: "integer", minimum: 1 } },
          { name: "instance", in: "query", schema: { type: "string" } },
        ],
        responses: {
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
          "in the background. Nothing in Summonarr is written.",
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
                  },
                },
              },
            },
          },
          "400": { description: "Invalid body" },
          "403": { description: "Not ADMIN" },
          "404": { description: "Integration disabled, unknown instance, or no such movie/series" },
          "409": { description: "Nothing is missing (or, in cutoff mode, below cutoff) for this title any more" },
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
          "not finished. Nothing is cached or written.",
        responses: {
          "200": {
            description: "The queues",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    instances: { type: "array", items: { type: "object", properties: { service: { type: "string", enum: ["radarr", "sonarr"] }, slug: { type: "string" }, name: { type: "string" } } } },
                    errors: { type: "array", items: { type: "object", properties: { service: { type: "string" }, instance: { type: "string" }, error: { type: "string" } } } },
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
                          size: { type: "number" },
                          sizeLeft: { type: "number" },
                          progress: { type: "number", minimum: 0, maximum: 1 },
                          timeLeftSeconds: { type: "integer", nullable: true },
                          estimatedCompletion: { type: "string", format: "date-time", nullable: true },
                          added: { type: "string", format: "date-time", nullable: true },
                          phase: { type: "string", enum: ["downloading", "queued", "paused", "delay", "importPending", "importing", "importBlocked", "failed", "clientUnavailable", "unknown"] },
                          trackedStatus: { type: "string", enum: ["ok", "warning", "error"], nullable: true },
                          messages: { type: "array", items: { type: "string" } },
                          protocol: { type: "string", enum: ["torrent", "usenet", "unknown"] },
                          downloadClient: { type: "string", nullable: true },
                          indexer: { type: "string", nullable: true },
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
          "One bulk `DELETE /api/v3/queue/bulk` on that instance carrying every record id of the download, with every flag " +
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
                  instance: { type: "string", description: "Instance slug; absent or empty = the default" },
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
          "200": { description: "Removed" },
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
            content: { "application/json": { schema: { type: "object", properties: { files: { type: "array", items: {
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
            } },
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
          "400": { description: "Invalid body" },
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
              files: { type: "array", items: { type: "object", description: "Same shape as GET /admin/queue/import's files" } },
              rechecked: { type: "boolean" },
            } } } },
          },
          "400": { description: "Invalid body, or a correction names something the instance doesn't have" },
          "403": { description: "Not ADMIN" },
          "404": { description: "Integration disabled or unknown instance" },
          "409": { description: "The download is no longer in the queue" },
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
          "200": { description: "Sent to the download client" },
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
              errors: { type: "array", items: { type: "object", properties: { service: { type: "string" }, instance: { type: "string" }, error: { type: "string" } } } },
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
        responses: {
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

    "/admin/notification-agents": {
      get: {
        tags: ["Admin – Settings"],
        summary: "List the outbound notification channels (ADMIN)",
        responses: {
          "200": {
            description: "Every configured channel",
            content: { "application/json": { schema: { type: "object", properties: { agents: { type: "array", items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    kind: { type: "string", enum: ["webhook", "ntfy", "gotify"] },
                    name: { type: "string" },
                    enabled: { type: "boolean" },
                    events: { type: "array", items: { type: "string" } },
                    config: { type: "object", description: "webhook: { url, headerName, template|null }; ntfy: { url, topic, priority 1-5, attachPoster }; gotify: { url, priority 0-10 }" },
                    hasSecret: { type: "boolean", description: "The secret itself is never returned." },
                    lastStatus: { type: "string", nullable: true, enum: ["ok", "failed"] },
                    lastError: { type: "string", nullable: true },
                    lastAttemptAt: { type: "string", format: "date-time", nullable: true },
                    createdAt: { type: "string", format: "date-time" },
                  },
                } } } } } },
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
                  kind: { type: "string", enum: ["webhook", "ntfy", "gotify"], description: "Create only — fixed afterwards." },
                  name: { type: "string", maxLength: 100 },
                  enabled: { type: "boolean" },
                  events: {
                    type: "array",
                    items: {
                      type: "string",
                      enum: ["request.created", "request.approved", "request.declined", "request.available", "issue.created", "issue.reply", "issue.resolved", "vote.threshold", "arr.manual_interaction", "arr.grab_completed", "arr.health", "arr.health_restored"],
                    },
                  },
                  config: { type: "object" },
                  secret: { type: "string", nullable: true, description: "Omit to keep the saved value, null or \"\" to clear. Gotify requires one." },
                },
              } } } },
        responses: {
          "201": { description: "Created" },
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
                  kind: { type: "string", enum: ["webhook", "ntfy", "gotify"], description: "Create only — fixed afterwards." },
                  name: { type: "string", maxLength: 100 },
                  enabled: { type: "boolean" },
                  events: {
                    type: "array",
                    items: {
                      type: "string",
                      enum: ["request.created", "request.approved", "request.declined", "request.available", "issue.created", "issue.reply", "issue.resolved", "vote.threshold", "arr.manual_interaction", "arr.grab_completed", "arr.health", "arr.health_restored"],
                    },
                  },
                  config: { type: "object" },
                  secret: { type: "string", nullable: true, description: "Omit to keep the saved value, null or \"\" to clear. Gotify requires one." },
                },
              } } } },
        responses: { "200": { description: "Updated" }, "400": { description: "Invalid input" }, "404": { description: "No such channel" } },
      },
      delete: {
        tags: ["Admin – Settings"],
        summary: "Delete a channel (ADMIN)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Deleted" }, "404": { description: "No such channel" } },
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
                  watchGradeGraceDays: { type: "string" },
                  watchGradeWindowDays: { type: "string" },
                  watchGradeTvPercent: { type: "string" },
                  watchGradeOtherViewers: { type: "string" },
                  watchGradeBandA: { type: "string" },
                  watchGradeBandB: { type: "string" },
                  watchGradeBandC: { type: "string" },
                  watchGradeBandD: { type: "string" },
                  watchGradeMinRequests: { type: "string" },
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
          "400": { description: "A value out of bounds, or a combination the settings save would refuse" },
          "403": { description: "Caller is not an ADMIN" },
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
        security: [{ session: [] }, { cronSecret: [] }],
        responses: {
          "200": {
            description:
              "Sync summary. Also the response for a DEGRADED run (a configured source failed) " +
              "and for a run skipped because one was already in flight — the status is " +
              "deliberately never 5xx, because the container's cron reschedules a non-2xx after " +
              "CRON_RETRY_INTERVAL and a full library replace every 5 minutes during an outage " +
              "is worse than a missed hour.",
            headers: {
              "X-Cron-Degraded": {
                description: "Comma-separated failed sources. Present only on a degraded run.",
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
      post: {
        tags: ["Admin – Sync"],
        summary: "Sync Plex library",
        security: [{ session: [] }, { cronSecret: [] }],
        responses: { "200": { description: "Plex sync result" } },
      },
    },
    "/sync/jellyfin": {
      post: {
        tags: ["Admin – Sync"],
        summary: "Sync Jellyfin library",
        security: [{ session: [] }, { cronSecret: [] }],
        responses: { "200": { description: "Jellyfin sync result" } },
      },
    },
    "/sync/radarr": {
      post: {
        tags: ["Admin – Sync"],
        summary: "Sync Radarr wanted/available items",
        security: [{ session: [] }, { cronSecret: [] }],
        responses: { "200": { description: "Radarr sync result" } },
      },
    },
    "/sync/sonarr": {
      post: {
        tags: ["Admin – Sync"],
        summary: "Sync Sonarr wanted/available items",
        security: [{ session: [] }, { cronSecret: [] }],
        responses: { "200": { description: "Sonarr sync result" } },
      },
    },
    "/sync/upcoming": {
      post: {
        tags: ["Admin – Sync"],
        summary: "Sync upcoming releases from TMDB",
        security: [{ session: [] }, { cronSecret: [] }],
        responses: { "200": { description: "Upcoming sync result" } },
      },
    },
    "/sync/ratings": {
      post: {
        tags: ["Admin – Sync"],
        summary: "Sync external ratings cache",
        security: [{ session: [] }, { cronSecret: [] }],
        responses: { "200": { description: "Ratings sync result" } },
      },
    },
    "/sync/play-history": {
      post: {
        tags: ["Admin – Sync"],
        summary: "Ingest play history from Plex / Jellyfin",
        security: [{ session: [] }, { cronSecret: [] }],
        responses: { "200": { description: "Play history sync result" } },
      },
    },
    "/sync/tv-episodes": {
      post: {
        tags: ["Admin – Sync"],
        summary: "Sync TV episode cache from TMDB",
        security: [{ session: [] }, { cronSecret: [] }],
        responses: { "200": { description: "TV episode sync result" } },
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
                    library: { type: "object" },
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
                    topRequesters: { type: "array", items: { type: "object" } },
                    recentRequests: { type: "array", items: { type: "object" } },
                    diskSpace: { type: "object" },
                    fulfillment: { type: "object" },
                    pendingQueue: { type: "object" },
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
          { name: "dateFrom", in: "query", schema: { type: "string", format: "date" }, description: "createdAt >= this date; unparseable values are ignored" },
          { name: "dateTo", in: "query", schema: { type: "string", format: "date" }, description: "Inclusive end date (compared as < dateTo + 1 day); unparseable values are ignored" },
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
                    logs: { type: "array", items: { type: "object" }, description: "Full AuditLog rows" },
                    nextCursor: { type: "string", nullable: true },
                    hasMore: { type: "boolean" },
                  },
                },
              },
            },
          },
          "403": { description: "Forbidden — ADMIN only" },
          "429": { description: "Rate limited (60/min per admin)" },
        },
      },
    },
    "/admin/audit-log/export": {
      get: {
        tags: ["Admin – Audit Log"],
        summary: "Export audit log as CSV (ADMIN)",
        responses: { "200": { description: "CSV download" } },
      },
    },

    "/admin/backup/db-export": {
      get: {
        tags: ["Admin – Backup"],
        summary: "Export encrypted database backup (ADMIN)",
        responses: { "200": { description: "Encrypted .backup file" } },
      },
    },
    "/admin/backup/db-import": {
      post: {
        tags: ["Admin – Backup"],
        summary: "Import database backup (ADMIN)",
        requestBody: {
          required: true,
          content: { "multipart/form-data": { schema: { type: "object", properties: { file: { type: "string", format: "binary" } } } } },
        },
        responses: { "200": { description: "Import result" } },
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
          },
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
          },
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
          "200": { description: "Dry run: counts + five-row sample. Execute: rows updated + watched flips" },
          "409": { description: "confirmAffectedRows does not match the live candidate count" },
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
                required: ["server", "tmdbId", "mediaType", "correctTmdbId"],
                properties: {
                  server: { type: "string", enum: ["plex", "jellyfin"] },
                  tmdbId: { type: "integer", description: "The wrong TMDB ID currently on the library row" },
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
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Match updated (may carry a `warning` when Plex conflated both TMDB IDs)" },
          "202": { description: "`async: true` — the job was started (or an identical one was already running); body carries `jobId`" },
          "400": { description: "Bad body, or an invalid serverInstance slug" },
          "404": { description: "No library row for that tmdbId on that instance — re-sync first" },
          "429": { description: "Rate limited (10/min/admin)" },
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
          "200": { description: "`status` is running | done | failed; `result` when done (same shape as the synchronous POST), `error` + `errorStatus` when failed" },
          "400": { description: "Missing or malformed id" },
          "404": { description: "Unknown or expired job — jobs are in-process and do not survive a restart; re-sync to see whether the remap landed" },
        },
      },
    },
    "/admin/fix-match/candidates": {
      get: {
        tags: ["Admin – Fix Match"],
        summary: "List Plex match candidates for a library item (ADMIN / ISSUE_ADMIN)",
        parameters: [
          { name: "server", in: "query", required: true, schema: { type: "string", enum: ["plex"] } },
          { name: "tmdbId", in: "query", required: true, schema: { type: "integer" } },
          { name: "mediaType", in: "query", required: true, schema: { $ref: "#/components/schemas/MediaType" } },
          { name: "correctTmdbId", in: "query", required: true, schema: { type: "integer" } },
          { name: "arrTmdbId", in: "query", schema: { type: "integer" }, description: "Radarr/Sonarr hint to boost a matching candidate" },
          {
            name: "serverInstance", in: "query", schema: { type: "string", default: "" },
            description: "Which configured Plex instance to read the row from and search (\"\" = the default server). Echoed back in the response.",
          },
        ],
        responses: {
          "200": { description: "Scored candidates plus target metadata, `ratingKey`, and the resolved `serverInstance`" },
          "400": { description: "Missing params, a non-plex server, or an invalid serverInstance slug" },
          "404": { description: "No Plex row for that tmdbId on that instance" },
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
              "and plexInstances / jellyfinInstances — every instance holding the title, as `{ serverInstance, filePath }`.",
          },
          "400": { description: "Missing params, or an invalid serverInstance slug" },
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
            description: "A Plex-relative thumb path, or an absolute URL from an allowlisted metadata-agent CDN",
          },
          {
            name: "serverInstance", in: "query", schema: { type: "string", default: "" },
            description: "Which configured Plex instance a RELATIVE path belongs to (\"\" = the default server). Ignored for absolute URLs.",
          },
        ],
        responses: {
          "200": { description: "Image binary (proxied)" },
          "400": { description: "Missing/invalid path, or an invalid serverInstance slug" },
          "502": { description: "Upstream fetch failed or returned a non-image" },
        },
      },
    },

    "/admin/library-warm": {
      post: {
        tags: ["Admin – Stats"],
        summary: "Pre-warm the library cache (ADMIN)",
        security: [{ session: [] }, { cronSecret: [] }],
        responses: { "200": { description: "Warm result" } },
      },
    },
    "/admin/library-sample-paths": {
      get: {
        tags: ["Admin – Stats"],
        summary: "Sample file paths from the library (ADMIN)",
        responses: { "200": { description: "Sample paths" } },
      },
    },
    "/admin/check-schema": {
      get: {
        tags: ["Admin – Debug"],
        summary: "Check whether the DB schema is up to date (ADMIN)",
        responses: { "200": { description: "Schema check result" } },
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
        responses: { "200": { description: "Cleared source and deletion count" } },
      },
    },

    "/discord/generate-link": {
      post: {
        tags: ["Discord"],
        summary: "Issue a short-lived token to link a Discord account to the current user",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { discordId: { type: "string", description: "Discord snowflake (17–20 digits)" } },
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
          "429": { description: "Rate limited" },
        },
      },
    },
    "/discord/initiate-merge": {
      post: {
        tags: ["Discord"],
        summary: "Start Discord account merge flow",
        responses: { "200": { description: "Merge token issued" } },
      },
    },
    "/discord/confirm-merge": {
      post: {
        tags: ["Discord"],
        summary: "Confirm Discord account merge",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["token"], properties: { token: { type: "string" } } } } },
        },
        responses: { "200": { description: "Accounts merged" } },
      },
    },
    "/discord/sync-roles": {
      post: {
        tags: ["Discord"],
        summary: "Sync Discord roles for the current user",
        responses: { "200": { description: "Roles synced" } },
      },
    },
    "/discord/register-commands": {
      post: {
        tags: ["Discord"],
        summary: "Register Discord slash commands (ADMIN)",
        responses: { "200": { description: "Commands registered" } },
      },
    },

    "/settings": {
      get: {
        tags: ["Settings"],
        summary: "Get all settings (ADMIN)",
        responses: { "200": { description: "Key-value settings map" } },
      },
      patch: {
        tags: ["Settings"],
        summary: "Update settings (ADMIN)",
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object", additionalProperties: { type: "string" }, description: "Arbitrary key-value pairs" },
            },
          },
        },
        responses: {
          "200": { description: "{ ok: true, ...connectivity test results }" },
          "400": { description: "Validation error" },
          "422": { description: "A connectivity test failed — the write was rolled back ({ ok: false, ...test results })" },
          "429": { description: "Rate limited, or a key was modified within its 10s cooldown" },
        },
      },
    },
    "/settings/arr-options": {
      get: {
        tags: ["Settings"],
        summary: "Get available quality profiles / root folders from Radarr and Sonarr (ADMIN)",
        responses: { "200": { description: "ARR options" } },
      },
    },
    "/settings/plex/libraries": {
      get: {
        tags: ["Settings"],
        summary: "List available Plex libraries (ADMIN)",
        responses: { "200": { description: "Plex library list" } },
      },
    },
    "/settings/jellyfin/libraries": {
      get: {
        tags: ["Settings"],
        summary: "List available Jellyfin libraries (ADMIN)",
        responses: { "200": { description: "Jellyfin library list" } },
      },
    },
    "/settings/test-ratings": {
      post: {
        tags: ["Settings"],
        summary: "Test MDBList / OMDB connectivity with stored keys (ADMIN)",
        responses: { "200": { description: "Test result" } },
      },
    },

    "/webhooks/radarr": {
      post: {
        tags: ["Webhooks"],
        summary: "Radarr webhook (movie grabbed / imported / deleted)",
        security: [],
        parameters: [{ name: "token", in: "query", schema: { type: "string" } }],
        requestBody: { content: { "application/json": { schema: { type: "object" } } } },
        responses: { "200": { description: "Processed" }, "401": { description: "Invalid token" } },
      },
    },
    "/webhooks/sonarr": {
      post: {
        tags: ["Webhooks"],
        summary: "Sonarr webhook (episode grabbed / imported / deleted)",
        description:
          "A Download event flips the series' APPROVED requests to AVAILABLE only once Sonarr confirms the series COMPLETE (every aired regular-season episode on disk). Mid-import deliveries answer { skipped: true, reason: \"incomplete\", episodeFileCount, episodeCount }; an unverifiable delivery (Sonarr unreachable) answers { deferred: true } and is re-checked after the library scan settles.",
        security: [],
        parameters: [{ name: "token", in: "query", schema: { type: "string" } }],
        requestBody: { content: { "application/json": { schema: { type: "object" } } } },
        responses: { "200": { description: "Processed" }, "401": { description: "Invalid token" } },
      },
    },

    "/cron/purge-auth-sessions": {
      post: {
        tags: ["Cron"],
        summary: "Purge expired auth sessions",
        security: [{ cronSecret: [] }],
        responses: { "200": { description: "Purge result" } },
      },
    },
    "/cron/scrub-audit-pii": {
      post: {
        tags: ["Cron"],
        summary: "Scrub PII from old audit log entries",
        security: [{ cronSecret: [] }],
        responses: { "200": { description: "Scrub result" } },
      },
    },
    "/cron/warm-activity": {
      post: {
        tags: ["Cron"],
        summary: "Pre-warm activity calendar cache",
        security: [{ cronSecret: [] }],
        responses: { "200": { description: "Warm result" } },
      },
    },
    "/cron/warm-library": {
      post: {
        tags: ["Cron"],
        summary: "Incrementally re-warm the library :details/TmdbMediaCore caches",
        security: [{ cronSecret: [] }],
        responses: { "200": { description: "Warm result" } },
      },
    },
    "/cron/warm-mdblist": {
      post: {
        tags: ["Cron"],
        summary: "Pre-warm MDBList ratings cache",
        security: [{ cronSecret: [] }],
        responses: { "200": { description: "Warm result" } },
      },
    },
    "/cron/warm-omdb": {
      post: {
        tags: ["Cron"],
        summary: "Pre-warm OMDB ratings cache",
        security: [{ cronSecret: [] }],
        responses: { "200": { description: "Warm result" } },
      },
    },
    "/cron/warm-recommendations": {
      post: {
        tags: ["Cron"],
        summary: "Pre-warm personalized \"For You\" recommendation cache",
        security: [{ cronSecret: [] }],
        responses: { "200": { description: "Warm result" } },
      },
    },

    "/notifications": {
      get: {
        tags: ["Notifications"],
        summary: "List the caller's in-app notifications + unread count",
        responses: {
          "200": {
            description: "Recent notifications and unread count",
            content: { "application/json": { schema: { type: "object", properties: { items: { type: "array", items: { type: "object" } }, unreadCount: { type: "integer" } } } } },
          },
        },
      },
      post: {
        tags: ["Notifications"],
        summary: "Mark notifications read (specific ids, or all unread when omitted)",
        requestBody: {
          required: false,
          content: { "application/json": { schema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } } } } },
        },
        responses: { "200": { description: "{ ok, unreadCount }" } },
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
          "200": { description: "{ ok, unreadCount }" },
          "400": { description: "Neither ids nor all=1 supplied" },
        },
      },
    },
    "/watchlist": {
      get: {
        tags: ["Lists"],
        summary: "List the caller's watchlist",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "type", in: "query", schema: { $ref: "#/components/schemas/MediaType" }, description: "Filter by media type" },
        ],
        responses: {
          "200": {
            description: "Paginated watchlist items",
            content: { "application/json": { schema: { allOf: [{ $ref: "#/components/schemas/PaginatedMeta" }, { type: "object", properties: { items: { type: "array", items: { type: "object" } } } }] } } },
          },
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
                          description: "requested | already-available | already-requested | quota | blacklisted | permanently-declined | rating-cap | forbidden | instance-unavailable | tmdb-unverified | arr-unreachable | discord-link-required | rate-limited | maintenance | error",
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
          "409": { description: "Already on watchlist" },
          "422": { description: "Could not verify media with TMDB" },
        },
      },
      delete: {
        tags: ["Lists"],
        summary: "Remove a title from the caller's watchlist",
        parameters: [
          { name: "tmdbId", in: "query", required: true, schema: { type: "integer" } },
          { name: "mediaType", in: "query", required: true, schema: { $ref: "#/components/schemas/MediaType" } },
        ],
        responses: { "200": { description: "Removed (idempotent)" } },
      },
    },
    "/hidden": {
      get: {
        tags: ["Lists"],
        summary: "List the caller's hidden (\"not interested\") titles",
        parameters: [{ name: "page", in: "query", schema: { type: "integer", default: 1 } }],
        responses: {
          "200": {
            description: "Paginated hidden items",
            content: { "application/json": { schema: { allOf: [{ $ref: "#/components/schemas/PaginatedMeta" }, { type: "object", properties: { items: { type: "array", items: { type: "object" } } } }] } } },
          },
        },
      },
      post: {
        tags: ["Lists"],
        summary: "Hide a title from the caller's discovery",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["tmdbId", "mediaType"], properties: { tmdbId: { type: "integer" }, mediaType: { $ref: "#/components/schemas/MediaType" }, title: { type: "string" }, posterPath: { type: "string", nullable: true } } } } } },
        responses: { "201": { description: "Hidden" }, "409": { description: "Already hidden" } },
      },
      delete: {
        tags: ["Lists"],
        summary: "Un-hide a title",
        parameters: [
          { name: "tmdbId", in: "query", required: true, schema: { type: "integer" } },
          { name: "mediaType", in: "query", required: true, schema: { $ref: "#/components/schemas/MediaType" } },
        ],
        responses: { "200": { description: "Un-hidden (idempotent)" } },
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
        responses: { "200": { description: "Title detail with availability + suggestions" }, "400": { description: "Invalid type or tmdbId" }, "502": { description: "Could not load this title" }, "429": { description: "Rate limited" } },
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
                    donate: { type: "object", description: "Each value passes through safeExternalHref; non-http(s) values collapse to null." },
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
        responses: { "200": { description: "Calendar cells" }, "403": { description: "Forbidden — ADMIN only" } },
      },
    },
    "/play-history/transcode-offenders": {
      get: {
        tags: ["Play History"],
        summary: "Titles/users driving the most transcodes (ADMIN)",
        responses: { "200": { description: "Transcode offender list" }, "403": { description: "Forbidden — ADMIN only" } },
      },
    },
    "/admin/library/bad-matches": {
      get: {
        tags: ["Admin – Debug"],
        summary: "Library items whose TMDB match looks wrong",
        parameters: [{ name: "mediaType", in: "query", schema: { $ref: "#/components/schemas/MediaType" } }],
        responses: { "200": { description: "Bad-match candidates" } },
      },
    },
    "/discord/status": {
      get: {
        tags: ["Discord"],
        summary: "Whether the caller has a linked Discord account",
        responses: { "200": { description: "{ discordId, linked }" } },
      },
    },
    "/discord/unlink": {
      post: {
        tags: ["Discord"],
        summary: "Unlink the caller's Discord account",
        responses: { "200": { description: "Unlinked" } },
      },
    },
    "/report": {
      post: {
        tags: ["Issues"],
        summary: "Report objectionable content (native app)",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { contentType: { type: "string" }, contentId: { type: "string" }, context: { type: "string" }, reason: { type: "string" } } } } } },
        responses: { "200": { description: "Report received" } },
      },
    },
    "/requests/bulk": {
      post: {
        tags: ["Requests"],
        summary: "Bulk-create requests, optionally on behalf of another user (REQUEST)",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["items"], properties: { items: { type: "array", items: { type: "object", properties: { tmdbId: { type: "integer" }, mediaType: { $ref: "#/components/schemas/MediaType" } } } }, onBehalfOfUserId: { type: "string", nullable: true } } } } },
        },
        responses: {
          "201": { description: "{ results, created } — per-item results; at least one item reached the create phase" },
          "200": { description: "{ results, created: 0 } — every item was skipped before the create phase" },
          "400": { description: "Validation error" },
          "403": { description: "Not permitted (on-behalf without REQUEST_ON_BEHALF, or a target with more permissions than the caller)" },
          "429": { description: "Rate limited, or the target's quota would be exceeded" },
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
        responses: { "200": { description: "{ qualityProfiles: [...] }" } },
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
          },
        },
      },
    },
    "/requests/users": {
      get: {
        tags: ["Requests"],
        summary: "Users the caller may request on behalf of (REQUEST_ON_BEHALF)",
        responses: { "200": { description: "Eligible user list" } },
      },
    },
    "/issues/{id}/claim": {
      post: {
        tags: ["Issues"],
        summary: "Claim an issue (issue-admin)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Claimed" } },
      },
    },
    "/push/apns": {
      post: {
        tags: ["Push"],
        summary: "Register an iOS APNs device token (native)",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["deviceToken"], properties: { deviceToken: { type: "string" }, label: { type: "string" }, publicKey: { type: "string" } } } } },
        },
        responses: { "200": { description: "Registered" } },
      },
      delete: {
        tags: ["Push"],
        summary: "Unregister an iOS APNs device token",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["deviceToken"], properties: { deviceToken: { type: "string" } } } } },
        },
        responses: { "200": { description: "Unregistered" } },
      },
    },
    "/events": {
      get: {
        tags: ["Events"],
        summary: "Server-sent events stream for real-time UI updates",
        responses: {
          "200": {
            description: "SSE stream",
            content: { "text/event-stream": { schema: { type: "string" } } },
          },
        },
      },
    },
  },
};

export const GET = withPermission(Permission.ADMIN)(async (_req, _ctx, _session) => {
  return NextResponse.json(spec, {
    headers: { "Cache-Control": "no-store" },
  });
});
