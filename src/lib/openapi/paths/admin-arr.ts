// Radarr/Sonarr beyond one title: download history, the blocklist, the calendar,
// the monitor, commands, tasks, indexers, download clients and storage.

import { COMMAND_READ_MAX_IDS } from "@/lib/arr-command-status";
import {
  ARR_SNAPSHOT_PARAM,
  ARR_SNAPSHOT_204,
  JOB_STARTED,
  JOB_RUNNING,
  jobAnswer,
  ARR_ERROR_KINDS,
  ARR_SERVICE,
  ARR_SERVICE_PARAM,
  QUALITY_TAGS,
  PROTOCOL,
  ARR_HISTORY_EVENT,
  tooLargeAnswer,
  RETRY_AFTER_HEADER,
  OK_TRUE,
  ARR_ERRORS,
  ARR_COMMAND_IDS,
} from "../shared";
import type { OpenApiSchema, OpenApiPaths } from "../types";

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

export const adminArrPaths: OpenApiPaths = {
  "/admin/arr/history": {
    get: {
      tags: ["Admin – Arr"],
      summary: "One instance's Radarr/Sonarr history, paged (ADMIN)",
      description: "Newest first, paged by the arr. `kind` filters (translated per service — the event enums differ). Same data projection as the title history.",
      parameters: [
        ARR_SNAPSHOT_PARAM,
        ARR_SERVICE_PARAM,
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
        service: ARR_SERVICE, instance: { type: "string" },
        arrId: { type: "integer", minimum: 1 }, historyId: { type: "integer", minimum: 1 },
      } } } } },
      responses: { ...ARR_ERRORS, "200": { description: "Marked", content: { "application/json": { schema: OK_TRUE } } }, "400": { description: "Invalid service, instance, arrId or historyId, or the arr refused (its reason, masked)" }, "403": { description: "Not ADMIN" }, "409": { description: "Not a grab, not this title's, or its download already failed" }, "413": tooLargeAnswer(16 * 1024), "429": { description: "More than 30 marks a minute by this admin (Retry-After set)", headers: RETRY_AFTER_HEADER } },
    },
  },
  "/admin/arr/blocklist": {
    get: {
      tags: ["Admin – Arr"],
      summary: "One instance's blocklist, paged (ADMIN)",
      parameters: [
        ARR_SNAPSHOT_PARAM,
        ARR_SERVICE_PARAM,
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
        ARR_SERVICE_PARAM,
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
        "429": { description: "More than 30 removals a minute by this admin (Retry-After set)", headers: RETRY_AFTER_HEADER },
      },
    },
  },
  "/admin/arr/blocklist/clear": {
    post: {
      tags: ["Admin – Arr"],
      summary: "Clear an instance's whole blocklist (ADMIN)",
      description: "The arr's own ClearBlocklist command. Audited ARR_BLOCKLIST_CHANGE with the `count` the admin confirmed (the list it names is gone afterwards).",
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["service"], properties: {
        service: ARR_SERVICE, instance: { type: "string" },
        count: { type: "integer", minimum: 0, description: "Size of the list the admin confirmed clearing — recorded in the ARR_BLOCKLIST_CHANGE audit; missing or malformed is recorded as null" },
      } } } } },
      responses: {
        ...ARR_ERRORS,
        "202": {
          description: "{ ok, commandIds } — queued; commandIds is the arr's id for its ClearBlocklist command (GET /admin/arr/commands)",
          content: { "application/json": { schema: { type: "object", required: ["ok", "commandIds"], properties: { ok: { type: "boolean", enum: [true] }, commandIds: ARR_COMMAND_IDS } } } },
        },
        "403": { description: "Not ADMIN" },
        "413": tooLargeAnswer(4 * 1024),
        "429": { description: "More than 10 clears a minute by this admin (Retry-After set)", headers: RETRY_AFTER_HEADER },
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
        "413": tooLargeAnswer(4 * 1024),
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
        ARR_SERVICE_PARAM,
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
        "429": { description: "Too many (Retry-After)", headers: RETRY_AFTER_HEADER },
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
        service: ARR_SERVICE, instance: { type: "string" },
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
        "413": tooLargeAnswer(4 * 1024),
        "429": { description: "Too many", headers: RETRY_AFTER_HEADER },
      },
    },
    delete: {
      tags: ["Admin – Arr"],
      summary: "Cancel a queued command (ADMIN)",
      description: "Audited ARR_COMMAND (`{ cancelled: commandId }`) once the arr accepted the cancel; a refused one writes nothing.",
      parameters: [
        ARR_SERVICE_PARAM,
        { name: "instance", in: "query", schema: { type: "string" } },
        { name: "commandId", in: "query", required: true, schema: { type: "integer", minimum: 1 } },
      ],
      responses: { "429": { description: "More than 30 cancels a minute by this admin (Retry-After set)", headers: RETRY_AFTER_HEADER }, ...ARR_ERRORS, "200": { description: "Cancelled", content: { "application/json": { schema: OK_TRUE } } }, "403": { description: "Not ADMIN" }, "409": { description: "Not queued any more" } },
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
        service: ARR_SERVICE, instance: { type: "string" },
        kind: { type: "string", enum: ["indexer", "downloadClient"] }, id: { type: "integer", minimum: 1 },
        enableRss: { type: "boolean", description: "indexer" }, enableAutomaticSearch: { type: "boolean", description: "indexer" },
        enableInteractiveSearch: { type: "boolean", description: "indexer" }, enable: { type: "boolean", description: "downloadClient" },
        acceptWarnings: { type: "boolean", description: "Save despite test WARNINGS (never errors) — after a 409 warningsOnly" },
        async: { type: "boolean", description: "Run in the background: 202 { job }, poll GET ?job=" },
      } } } } },
      responses: { "429": { description: "More than 30 saves a minute by this admin (Retry-After set); joining a background save already running spends nothing", headers: RETRY_AFTER_HEADER },
        ...ARR_ERRORS,
        "200": { description: "{ provider, timedOut? }", content: { "application/json": { schema: ARR_PROVIDER_SAVED } } },
        "202": jobAnswer("`async: true` — { job }: started, or the same save already running", JOB_STARTED),
        "400": { description: "Invalid body, the arr refused, or the indexer doesn't support that use" },
        "403": { description: "Not ADMIN" },
        "404": { description: "Integration disabled, unknown instance, or no such provider" },
        "409": { description: "{ warningsOnly: true, messages } — the arr's test only warned; or, with acceptWarnings, { error, changed: true } — the provider was edited in the arr while it was tested (nothing saved)" },
        "413": tooLargeAnswer(4 * 1024),
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
        service: ARR_SERVICE, instance: { type: "string" },
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
        "413": tooLargeAnswer(4 * 1024),
        "429": { description: "Too many", headers: RETRY_AFTER_HEADER },
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
};
