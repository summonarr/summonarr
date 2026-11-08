// Manual metadata correction (guardrails 37/37a).

import { tooLargeAnswer } from "../shared";
import type { OpenApiSchema, OpenApiPaths } from "../types";

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

// A library item's on-disk path as a fix-match caller sees it (libraryPathFor,
// src/lib/library-path-view.ts, guardrail 37f): the full path for an ADMIN,
// the file name alone for a MANAGE_ISSUES delegate.
const FIX_MATCH_FILE_PATH = {
  type: "string",
  nullable: true,
  description: "ADMIN: the full on-disk path. A MANAGE_ISSUES delegate gets the file name only (guardrail 37f). null when the server has no row.",
} satisfies OpenApiSchema;

export const adminFixMatchPaths: OpenApiPaths = {
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
        "413": tooLargeAnswer(16 * 1024),
        "429": { description: "Rate limited (10/min/admin), or too many fix-match operations already queued" },
        "409": { description: "Another fix-match job for the same item (a different target) is still running or queued — wait for it to finish, then send this again" },
        "502": { description: "Remote remap or the follow-up cache write failed; `error` says what the media server reported (locked item, still processing, unreadable, not confirmed, …)" },
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
};
