// The media request lifecycle.

import { ADMIN_NOTE_MAX, BULK_REQUEST_MAX_ITEMS } from "@/lib/request-limits";
import {
  SEARCH_JOB,
  jobAnswer,
  ARR_RELEASE,
  ARR_ERROR_KINDS,
  QUEUE_PHASE,
  ARR_SERVICE,
  tooLargeAnswer,
  forbiddenAnswer,
  RETRY_AFTER_HEADER,
  rowOwner,
  OK_TRUE,
  threadEntry,
} from "../shared";
import { REQUEST_BATCH_MAX_IDS, REQUEST_BATCH_MAX_PERMANENT } from "@/lib/api-body-limits";
import type { OpenApiSchema, OpenApiPaths } from "../types";

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

export const requestsPaths: OpenApiPaths = {
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
                  { type: "object", properties: { requests: { type: "array", items: { allOf: [{ $ref: "#/components/schemas/MediaRequest" }, { type: "object", required: ["user"], properties: { user: rowOwner("MANAGE_REQUESTS") } }] } }, statusCounts: { type: "object", additionalProperties: { type: "integer" }, description: "Count per status for the same scope and `q`, ignoring the selected `status`" } } },
                ],
              },
            },
          },
        },
        "429": { description: "Rate limited (60 per minute per user)", headers: RETRY_AFTER_HEADER },
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
        "413": tooLargeAnswer(64 * 1024),
        "422": { description: "TMDB could not verify the title" },
        "429": { description: "Quota exceeded, or the per-minute request rate limit (Retry-After)", headers: RETRY_AFTER_HEADER },
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
        "413": tooLargeAnswer(16 * 1024),
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
                  service: ARR_SERVICE,
                  errorKind: { type: "string", nullable: true, enum: [...ARR_ERROR_KINDS, null], description: "Set when the verdict is `unreachable`" },
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
                  queue: { type: "object", nullable: true, description: "ADMIN only (null for a delegate, and when the arr doesn't have the title): the Download Queue filter naming exactly this title's downloads — /admin/queue?service=&instance=&arrId=", properties: { service: ARR_SERVICE, instance: { type: "string" }, arrId: { type: "integer" } } },
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
        "429": { description: "Rate limited", headers: RETRY_AFTER_HEADER },
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
        "429": { description: "Rate limited — searches, or 60 Sonarr reads per minute for a TV request's tvdbId and season list", headers: RETRY_AFTER_HEADER },
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
        "413": tooLargeAnswer(16 * 1024),
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
                ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: REQUEST_BATCH_MAX_IDS, description: "Only requests still PENDING are transitioned; others are skipped silently" },
                status: { type: "string", enum: ["APPROVED", "DECLINED"] },
                adminNote: { type: "string", maxLength: ADMIN_NOTE_MAX },
                permanent: { type: "boolean", description: `On DECLINED, mark the request permanently declined (at most ${REQUEST_BATCH_MAX_PERMANENT} ids per permanent batch; ignored on APPROVED)` },
              },
            },
          },
        },
      },
      responses: {
        "403": forbiddenAnswer("the MANAGE_REQUESTS permission"),
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
        "400": { description: `ids empty/over ${REQUEST_BATCH_MAX_IDS}/not strings, invalid status, adminNote over ${ADMIN_NOTE_MAX} chars, non-boolean permanent, or a permanent batch over ${REQUEST_BATCH_MAX_PERMANENT} ids (\`code: "permanent-batch-too-large"\`)` },
        "413": tooLargeAnswer(1024 * 1024),
        "429": { description: "Rate limited (10/min per admin)" },
        "503": { description: "Maintenance mode (non-ADMIN callers)" },
      },
    },
  },
  "/requests/{id}/comments": {
    get: {
      tags: ["Requests"],
      summary: "List comments on a request",
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        { name: "before", in: "query", required: false, schema: { type: "string" }, description: "Keyset cursor `<createdAt ISO-8601>|<id>` of the oldest entry the client holds: answers the page strictly older, same array shape and cap. Absent or malformed reads the newest page; `X-Truncated: true` says older entries remain" }],
      responses: {
        "200": {
          description: "The newest 500 comments, oldest first, each with author { name, role } (+ email for MANAGE_REQUESTS callers) and fromAdmin",
          headers: { "X-Truncated": { description: "\"true\" when the list was cut at the cap", schema: { type: "string", enum: ["true", "false"] } }, "X-Truncated-Cap": { description: "The cap, as an integer string", schema: { type: "string" } } }, 
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
        "413": tooLargeAnswer(64 * 1024),
        "429": { description: "Rate limited (10/min per user)" },
        "503": { description: "Maintenance mode (non-ADMIN callers)" },
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
        "413": tooLargeAnswer(1024 * 1024),
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
        "429": { description: "Rate limited", headers: RETRY_AFTER_HEADER },
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
        "429": { description: "Rate limited (60/min)", headers: RETRY_AFTER_HEADER },
      },
    },
  },
  "/requests/users": {
    get: {
      tags: ["Requests"],
      summary: "Users the caller may request on behalf of (REQUEST_ON_BEHALF)",
      description: "Active accounts only (deactivated ones are left out), at most 1000, by name. A non-ADMIN caller is offered only targets whose permissions are a subset of their own, since the bulk route refuses any other — read on past ineligible accounts until 1000 are found or 50,000 were scanned. A non-ADMIN caller gets every other account's email masked (its first character and the domain).",
      responses: {
        "403": forbiddenAnswer("the REQUEST_ON_BEHALF permission"),
        "200": {
          description: "{ users: [{ id, name, email }], truncated }",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["users", "truncated"],
                properties: {
                  truncated: { type: "boolean", description: "true when the list stopped before reading every account — more may exist" },
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
};
