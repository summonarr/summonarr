// The Radarr/Sonarr title manager: one title's settings, files, episodes,
// history, commands and releases.

import { MAX_TITLE_FILE_IDS, TITLE_FILE_IDS_BODY_BYTES } from "@/lib/arr-title";
import {
  ARR_SNAPSHOT_PARAM,
  ARR_SNAPSHOT_204,
  JOB_STARTED,
  JOB_RUNNING,
  SEARCH_JOB,
  jobAnswer,
  ARR_RELEASE,
  ARR_SERVICE,
  ARR_SERVICE_PARAM,
  ARR_HISTORY_EVENT,
  TITLE_FILE,
  tooLargeAnswer,
  RETRY_AFTER_HEADER,
  OK_TRUE,
  ARR_ERRORS,
  ARR_COMMAND_IDS,
} from "../shared";
import { TITLE_COMMAND_MAX_EPISODES, TITLE_EPISODES_MAX_IDS } from "@/lib/api-body-limits";
import type { OpenApiSchema, OpenApiPaths } from "../types";

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

// One file of a title (TitleFile, src/lib/arr-title.ts) in the title manager:
// TITLE_FILE plus `relativePath`, which names the file. Its absolute path is
// projected too (ADMIN-only) and left out here.
const { id: TITLE_FILE_ID, ...TITLE_FILE_FIELDS } = TITLE_FILE.properties;

const ARR_TITLE_FILE = {
  ...TITLE_FILE,
  properties: {
    id: TITLE_FILE_ID,
    relativePath: { type: "string", description: "Relative to the title's folder" },
    ...TITLE_FILE_FIELDS,
  },
} satisfies OpenApiSchema;

// DELETE /admin/arr/title/files' 200 — and the background delete's answer,
// which GET ?job= replays.
const ARR_FILES_DELETED = {
  type: "object",
  required: ["deleted"],
  properties: { deleted: { type: "integer", description: "The number of files deleted" } },
} satisfies OpenApiSchema;

export const adminArrTitlePaths: OpenApiPaths = {
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
        ARR_SERVICE_PARAM,
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
        service: ARR_SERVICE,
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
      responses: { "429": { description: "More than 60 edits a minute by this admin (Retry-After set)", headers: RETRY_AFTER_HEADER },
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
        "413": tooLargeAnswer(64 * 1024),
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
        ARR_SERVICE_PARAM,
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
        service: ARR_SERVICE, instance: { type: "string" }, tmdbId: { type: "integer", minimum: 1 },
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
        "413": tooLargeAnswer(16 * 1024),
        "429": { description: "Too many", headers: RETRY_AFTER_HEADER },
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
        service: ARR_SERVICE, instance: { type: "string" }, id: { type: "integer", minimum: 1 },
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
        "413": tooLargeAnswer(4 * 1024),
        "429": { description: "Too many", headers: RETRY_AFTER_HEADER },
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
        episodeIds: { type: "array", items: { type: "integer", minimum: 1 }, maxItems: TITLE_EPISODES_MAX_IDS }, monitored: { type: "boolean" },
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
        "413": tooLargeAnswer(128 * 1024),
        "429": { description: "More than 60 changes a minute by this admin (Retry-After set)", headers: RETRY_AFTER_HEADER },
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
        { name: "service", in: "query", schema: ARR_SERVICE, description: "Required unless `job`" },
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
        ARR_SERVICE_PARAM,
        { name: "instance", in: "query", schema: { type: "string" } },
        { name: "id", in: "query", required: true, schema: { type: "integer", minimum: 1 } },
        { name: "fileIds", in: "query", schema: { type: "string" }, description: "Comma-separated file ids (or send them in the body)" },
      ],
      requestBody: { content: { "application/json": { schema: { type: "object", properties: {
        fileIds: { type: "array", minItems: 1, maxItems: MAX_TITLE_FILE_IDS, items: { type: "integer", minimum: 1 } },
        async: { type: "boolean", description: "Run the delete as a background job: 202 { job }, poll GET ?job=. Default (absent/false): synchronous" },
      } } } } },
      responses: {
        ...ARR_ERRORS,
        "200": { description: "{ deleted } — the number of files deleted", content: { "application/json": { schema: ARR_FILES_DELETED } } },
        "202": jobAnswer("async: true — the delete runs in the background: { job } (the same admin's running delete of the same files is joined); poll GET ?job=", JOB_STARTED),
        "400": { description: "Invalid ids" },
        "403": { description: "Not ADMIN" },
        "413": tooLargeAnswer(TITLE_FILE_IDS_BODY_BYTES),
        "429": { description: "More than 30 deletes a minute by this admin (Retry-After set)", headers: RETRY_AFTER_HEADER },
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
        ARR_SERVICE_PARAM,
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
        service: ARR_SERVICE, instance: { type: "string" }, id: { type: "integer", minimum: 1 },
        fileIds: { type: "array", minItems: 1, maxItems: MAX_TITLE_FILE_IDS, items: { type: "integer", minimum: 1 } },
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
        "413": tooLargeAnswer(TITLE_FILE_IDS_BODY_BYTES),
        "429": { description: "More than 10 renames a minute by this admin (Retry-After set)", headers: RETRY_AFTER_HEADER },
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
        ARR_SERVICE_PARAM,
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
        service: ARR_SERVICE, instance: { type: "string" }, id: { type: "integer", minimum: 1 },
        action: { type: "string", enum: ["search", "refresh", "searchMissing", "searchSeason", "searchEpisodes"] },
        seasonNumber: { type: "integer", minimum: 0 },
        episodeIds: { type: "array", items: { type: "integer", minimum: 1 }, maxItems: TITLE_COMMAND_MAX_EPISODES },
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
        "413": tooLargeAnswer(32 * 1024),
        "429": { description: "Too many", headers: RETRY_AFTER_HEADER },
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
        { name: "service", in: "query", schema: ARR_SERVICE },
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
        "429": { description: "Too many searches", headers: RETRY_AFTER_HEADER },
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
        service: ARR_SERVICE, instance: { type: "string" }, id: { type: "integer", minimum: 1 },
        release: { type: "string", pattern: "^[0-9a-f]{32}$" }, season: { type: "integer", minimum: 0 }, episodeId: { type: "integer", minimum: 1 },
      } } } } },
      responses: { ...ARR_ERRORS, "200": { description: "{ ok: true } — grabbed", content: { "application/json": { schema: OK_TRUE } } }, "400": { description: "Invalid body" }, "403": { description: "Not ADMIN" }, "409": { description: "The indexer or download client refused it (the arr's reason, masked), or a grab of this handle is already in progress (nothing was sent)" }, "410": { description: "Handle expired, from another search, or no longer in the arr's search cache" }, "413": tooLargeAnswer(16 * 1024), "429": { description: "More than 20 grabs a minute by this admin (Retry-After set; the handle is not spent)", headers: RETRY_AFTER_HEADER } },
    },
  },
};
