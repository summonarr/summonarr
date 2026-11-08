// System statistics, cache maintenance, the audit trail, and database export/import.

import {
  JOB_STARTED,
  JOB_RUNNING,
  jobAnswer,
  ARR_SERVICE,
  tooLargeAnswer,
  AUDIT_SCRUB_FIELDS,
  LIBRARY_PREWARM_COUNTS,
  RETRY_AFTER_HEADER,
} from "../shared";
import type { OpenApiSchema, OpenApiPaths } from "../types";

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

// What the library prewarm answers (prewarmLibraryCache, src/lib/tmdb-prewarm.ts)
// — the POST's 200 and, replayed, its background job's.
const LIBRARY_WARM_RESULT = {
  type: "object",
  required: Object.keys(LIBRARY_PREWARM_COUNTS),
  properties: LIBRARY_PREWARM_COUNTS,
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

// The library path preview of one library type: the inferred mount point and a
// spread of up to six mount-relative sample paths (library-sample-paths route).
const LIBRARY_PATH_SAMPLE = {
  type: "object",
  properties: {
    mountPoint: { type: "string", description: "The longest shared folder prefix, \"\" when there is none" },
    samples: { type: "array", maxItems: 6, items: { type: "string" }, description: "Paths with the mount point stripped (TV on Plex: one per show folder)" },
  },
} satisfies OpenApiSchema;

export const adminMaintenancePaths: OpenApiPaths = {
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
        "413": tooLargeAnswer(1024),
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
  "/admin/audit-log": {
    delete: {
      tags: ["Admin – Audit Log"],
      summary: "Scrub PII from audit rows past the retention cutoff (ADMIN)",
      description:
        "Manual equivalent of the scrub-audit-pii cron. Nulls ipAddress/userAgent and redacts userName on every row older than auditPiiRetentionDays (default 90); additionally nulls details on AUTH_LOGIN, AUTH_LOGIN_FAILED and AUTH_LOGOUT rows, and scrubs the target user's name from the details of admin-action rows about a user. Takes no body and no parameters.",
      responses: { "429": { description: "More than 5 scrubs in 10 minutes by this admin (Retry-After set)", headers: RETRY_AFTER_HEADER },
        "200": {
          description: "Scrub counts",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["scrubbed", "detailsScrubbed", "adminDetailsScrubbed", "cutoff", "retentionDays"],
                properties: {
                  scrubbed: AUDIT_SCRUB_FIELDS.scrubbed,
                  detailsScrubbed: { type: "integer", description: "Sign-in / sign-out rows whose details were cleared" },
                  adminDetailsScrubbed: AUDIT_SCRUB_FIELDS.adminDetailsScrubbed,
                  cutoff: AUDIT_SCRUB_FIELDS.cutoff,
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
};
