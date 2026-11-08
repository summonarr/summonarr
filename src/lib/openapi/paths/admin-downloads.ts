// Missing titles, the download queues, Radarr/Sonarr health and "Open in" links.

import {
  ARR_SNAPSHOT_PARAM,
  ARR_SNAPSHOT_204,
  ARR_ERROR_KINDS,
  QUEUE_PHASE,
  ARR_SERVICE,
  ARR_SERVICE_PARAM,
  QUALITY_TAGS,
  PROTOCOL,
  tooLargeAnswer,
  RETRY_AFTER_HEADER,
  OK_TRUE,
} from "../shared";
import { QUEUE_GRAB_MAX_IDS, QUEUE_IMPORT_MAX_FILES, QUEUE_REMOVE_MAX_IDS } from "@/lib/api-body-limits";
import type { OpenApiSchema, OpenApiPaths } from "../types";

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

const POSTER_PATH = { type: "string", nullable: true } satisfies OpenApiSchema;

// One row of GET /admin/missing (MissingMovie / MissingSeries, or CutoffMovie /
// CutoffSeries — src/lib/arr-missing.ts): the title as the instance names it, then the
// variant's own fields. A Sonarr row also carries the series' tvdb id.
function missingItem(description: string, service: "radarr" | "sonarr", fields: Record<string, OpenApiSchema>): OpenApiSchema {
  return {
    type: "object",
    description,
    properties: {
      instance: { type: "string" },
      arrId: { type: "integer" },
      tmdbId: { type: "integer", nullable: true },
      ...(service === "sonarr" ? { tvdbId: { type: "integer", nullable: true } } : {}),
      title: { type: "string" },
      year: { type: "integer", nullable: true },
      ...fields,
    },
  };
}

export const adminDownloadsPaths: OpenApiPaths = {
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
        ARR_SERVICE_PARAM,
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
                  service: ARR_SERVICE,
                  enabled: { type: "boolean", description: "feature.integration.<service>; false ⇒ no instance was read" },
                  instances: { type: "array", items: { type: "object", properties: { slug: { type: "string" }, name: { type: "string" } } } },
                  errors: { type: "array", items: { type: "object", properties: { instance: { type: "string" }, error: { type: "string" }, kind: { type: "string", enum: ARR_ERROR_KINDS, description: "Why the listing failed — translate this, not the English `error`" } } } },
                  truncated: {
                    type: "array",
                    description: "Present only when non-empty: instances whose listing ran past a ceiling — mode=cutoff: the 20,000-record /wanted/cutoff read; mode=missing: the per-instance 20,000-title cap — so the list is incomplete",
                    items: { type: "object", properties: { instance: { type: "string" }, read: { type: "integer" }, total: { type: "integer" } } },
                  },
                  items: {
                    type: "array",
                    items: {
                      oneOf: [
                        missingItem("Radarr movie", "radarr", {
                          monitored: { type: "boolean" },
                          posterPath: POSTER_PATH,
                          inCinemas: { type: "string", format: "date-time", nullable: true },
                          physicalRelease: { type: "string", format: "date-time", nullable: true },
                          digitalRelease: { type: "string", format: "date-time", nullable: true },
                          releasedAt: { type: "string", format: "date-time", description: "The earlier past home release" },
                          daysMissing: { type: "integer" },
                        }),
                        missingItem("Sonarr series", "sonarr", {
                          monitored: { type: "boolean" },
                          status: { type: "string", nullable: true },
                          posterPath: POSTER_PATH,
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
                        }),
                        missingItem("Radarr movie, mode=cutoff", "radarr", {
                          posterPath: POSTER_PATH,
                          quality: { type: "string", nullable: true, description: "The quality of the file on disk" },
                          profile: { type: "string", nullable: true, description: "The movie's quality profile" },
                          cutoff: { type: "string", nullable: true, description: "That profile's cutoff (a quality or a quality group)" },
                        }),
                        missingItem("Sonarr series, mode=cutoff", "sonarr", {
                          posterPath: POSTER_PATH,
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
                        }),
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
                service: ARR_SERVICE,
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
        "413": tooLargeAnswer(4 * 1024),
        "429": {
          description: "Too many searches — 120 per minute per admin; honour the Retry-After header (seconds)",
          headers: RETRY_AFTER_HEADER,
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
                  instances: { type: "array", items: { type: "object", properties: { service: ARR_SERVICE, slug: { type: "string" }, name: { type: "string" } } } },
                  errors: { type: "array", items: { type: "object", properties: { service: { type: "string" }, instance: { type: "string" }, error: { type: "string" }, kind: { type: "string", enum: ARR_ERROR_KINDS, description: "Why the read failed — translate this, not the English `error`" } } } },
                  truncated: {
                    type: "array",
                    description: "Present only when an instance's queue was longer than the page cap, or its 45 s read budget ran out: `read` records of `total` were read, so the rest are absent, not finished",
                    items: { type: "object", properties: { service: ARR_SERVICE, instance: { type: "string" }, read: { type: "integer" }, total: { type: "integer" } } },
                  },
                  items: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        service: ARR_SERVICE,
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
                        qualityTags: { ...QUALITY_TAGS, description: "The release revision as the arr tags it beside the quality" },
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
                        trackedStatus: { type: "string", enum: ["ok", "warning", "error", null], nullable: true },
                        messages: { type: "array", items: { type: "string" } },
                        protocol: PROTOCOL,
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
                service: ARR_SERVICE,
                instance: { type: "string", nullable: true, description: "Instance slug; absent, null or empty = the default" },
                ids: { type: "array", items: { type: "integer", minimum: 1 }, minItems: 1, maxItems: QUEUE_REMOVE_MAX_IDS },
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
        "413": tooLargeAnswer(64 * 1024),
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
        ARR_SERVICE_PARAM,
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
                service: ARR_SERVICE,
                instance: { type: "string" },
                downloadId: { type: "string", maxLength: 200 },
                files: { type: "array", minItems: 1, maxItems: QUEUE_IMPORT_MAX_FILES, items: { $ref: "#/components/schemas/QueueImportFile" } },
                paths: { type: "array", deprecated: true, items: { type: "string", maxLength: 4096 }, minItems: 1, maxItems: QUEUE_IMPORT_MAX_FILES, description: "Read only when `files` is absent" },
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
        "413": tooLargeAnswer(512 * 1024),
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
                service: ARR_SERVICE,
                instance: { type: "string" },
                downloadId: { type: "string", maxLength: 200 },
                files: { type: "array", minItems: 1, maxItems: QUEUE_IMPORT_MAX_FILES, items: { $ref: "#/components/schemas/QueueImportFile" } },
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
        "413": tooLargeAnswer(512 * 1024),
        "429": { description: "More than 30 previews a minute by this admin (each is a manual-import reprocess on the arr; Retry-After set)", headers: RETRY_AFTER_HEADER },
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
        ARR_SERVICE_PARAM,
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
                service: ARR_SERVICE,
                instance: { type: "string" },
                ids: { type: "array", items: { type: "integer", minimum: 1 }, minItems: 1, maxItems: QUEUE_GRAB_MAX_IDS },
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
        "413": tooLargeAnswer(16 * 1024),
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
        "429": { description: "Too many re-checks", headers: RETRY_AFTER_HEADER },
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
                        service: ARR_SERVICE,
                        slug: { type: "string" },
                        name: { type: "string" },
                        reachable: { type: "boolean" },
                        error: { type: "string", nullable: true },
                        errorKind: { type: "string", nullable: true, enum: [...ARR_ERROR_KINDS, null], description: "Why the instance could not be read — translate this, not the English `error`" },
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
                service: ARR_SERVICE,
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
        "413": tooLargeAnswer(4 * 1024),
        "422": { description: "The arr refused the entry (`detail` is its reason)" },
        "429": { description: "More than 10 setups a minute by this admin (each makes the arr test-POST Summonarr; Retry-After set)", headers: RETRY_AFTER_HEADER },
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
        ARR_SERVICE_PARAM,
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
};
