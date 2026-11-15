// Library sync triggers (CRON_SECRET, or an admin session).

import {
  JOB_STARTED,
  JOB_RUNNING,
  jobAnswer,
  ADMIN_OR_CRON_SECURITY,
  tooLargeAnswer,
  CRON_RUN_FIELDS,
  cronRunOrSkip,
} from "../shared";
import type { OpenApiSchema, OpenApiPaths } from "../types";

// One server's library resync (/sync/plex, /sync/jellyfin), or the skip while
// that service's resync already runs. A GET ?job= poll replays the POST's
// answer, so all four operations share it.
// POST /sync/tv-episodes' answer, also what a finished background run hands back.
const TV_EPISODES_ANSWER = {
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
} satisfies OpenApiSchema;

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

export const syncPaths: OpenApiPaths = {
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
        "413": tooLargeAnswer(8 * 1024),
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
        "413": tooLargeAnswer(8 * 1024),
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
    get: {
      tags: ["Admin – Sync"],
      summary: "Poll a background episode-cache rebuild (ADMIN)",
      description: "The answer of a rebuild started with `async: true`, for the admin who started it. A CRON_SECRET caller has no jobs.",
      parameters: [
        { name: "job", in: "query", required: true, schema: { type: "string", pattern: "^[0-9a-f]{32}$" }, description: "The job id from the POST's 202" },
      ],
      responses: {
        "200": {
          description: "The finished rebuild's own answer",
          content: { "application/json": { schema: TV_EPISODES_ANSWER } },
        },
        "202": jobAnswer("Still running: { job, running: true }", JOB_RUNNING),
        "403": { description: "Not an admin session" },
        "404": { description: "{ error } — the job is unknown: expired, another admin's, or dropped by a restart" },
      },
    },
    post: {
      tags: ["Admin – Sync"],
      summary: "Sync TV episode cache from TMDB",
      security: ADMIN_OR_CRON_SECURITY,
      description: "Rebuilds the shared TVEpisodeCache from the UNION of every configured server of each type, all-or-nothing: a type with any failed server is left untouched and named in `skipped`.",
      requestBody: { required: false, content: { "application/json": { schema: { type: "object", properties: {
        async: { type: "boolean", description: "Admin session only: run as a background job — 202 { job } at once, poll GET ?job=. Default (and always for CRON_SECRET): synchronous" },
      } } } } },
      responses: {
        "200": {
          description: "{ plex, jellyfin, skipped, errors, … } — episode counts written per source",
          headers: {
            "X-Cron-Degraded": {
              description: "Comma-separated sources left untouched (`plex`, `jellyfin`). Present only when a source was skipped.",
              schema: { type: "string" },
            },
          },
          content: { "application/json": { schema: TV_EPISODES_ANSWER } },
        },
        "202": jobAnswer("{ job } — `async: true` from an admin: the rebuild runs in the background", JOB_STARTED),
        "403": { description: "Neither an admin session nor a valid CRON_SECRET" },
        "413": tooLargeAnswer(8 * 1024),
      },
    },
  },
};
