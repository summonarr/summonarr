// Library cleanup, the never-watched report, and Plex ⇄ Jellyfin watch sync.

import { CLEANUP_EXCLUSIONS, CLEANUP_MAX_ITEMS, CLEANUP_RULES } from "@/lib/library-cleanup";
import { NW_REASONS, NW_STATES } from "@/lib/never-watched";
import {
  JOB_STARTED,
  JOB_RUNNING,
  jobAnswer,
  ARR_ERROR_KINDS,
  ARR_SERVICE,
  tooLargeAnswer,
  OK_TRUE,
  UPSTREAM_REFRESH_RESULT,
  WATCH_SYNC_PAIR_RESULT,
  RETRY_AFTER_HEADER,
} from "../shared";
import type { OpenApiSchema, OpenApiPaths } from "../types";

// A Radarr/Sonarr instance whose listing failed, as the cleanup report and the
// never-watched report both name it (the title is then judged without it).
const ARR_LISTING_ERROR = {
  type: "object",
  properties: {
    service: ARR_SERVICE,
    instance: { type: "string" },
    error: { type: "string" },
    kind: { type: "string", enum: ARR_ERROR_KINDS, description: "Why the listing failed — translate this, not the English `error`" },
  },
} satisfies OpenApiSchema;

// One instance holding a title, with the size of its copy on disk.
const ARR_COPY_SIZE = {
  type: "object",
  properties: { service: ARR_SERVICE, instance: { type: "string" }, sizeOnDisk: { type: "number" } },
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
      items: ARR_COPY_SIZE,
    },
    sizeOnDisk: { type: "number", nullable: true },
    protected: { type: "boolean" },
    cleanup: {
      type: "object",
      description: "What Library cleanup's rules say about it now",
      properties: {
        matched: { type: "array", items: { type: "string", enum: [...CLEANUP_RULES] } },
        excludedBy: { type: "array", items: { type: "string", enum: [...CLEANUP_EXCLUSIONS] } },
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

export const adminLibraryPaths: OpenApiPaths = {
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
                        arr: { type: "array", items: ARR_COPY_SIZE },
                        sizeOnDisk: { type: "number", nullable: true },
                        matched: { type: "array", items: { type: "string", enum: [...CLEANUP_RULES] } },
                        excludedBy: { type: "array", items: { type: "string", enum: [...CLEANUP_EXCLUSIONS] } },
                        candidate: { type: "boolean" },
                      },
                    },
                  },
                  arrErrors: { type: "array", items: ARR_LISTING_ERROR },
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
        "413": tooLargeAnswer(4 * 1024),
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
        "413": tooLargeAnswer(16 * 1024),
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
                  maxItems: CLEANUP_MAX_ITEMS,
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
            targetCount: { type: "integer", description: "Dry run: Radarr/Sonarr entries a confirmed execute would delete" },
            targetsFingerprint: { type: "string", description: "Dry run: send back as `confirmFingerprint`" },
            reclaimableBytes: { type: "integer", description: "Dry run: bytes on disk those entries hold" },
            blacklist: { type: "boolean", description: "Dry run: whether fully removed titles would also be blacklisted" },
            items: { type: "array", description: "Dry run: the planned titles, each { tmdbId, mediaType, title, matched, targets: [{ service, instance, arrId, title, sizeOnDisk }] }", items: { type: "object", properties: {
              tmdbId: { type: "integer" },
              mediaType: { type: "string", enum: ["MOVIE", "TV"] },
              title: { type: "string" },
              matched: { type: "array", items: { type: "string" }, description: "The rules the title matched" },
              targets: { type: "array", items: { type: "object", properties: {
                service: ARR_SERVICE,
                instance: { type: "string" },
                arrId: { type: "integer" },
                title: { type: "string" },
                sizeOnDisk: { type: "integer" },
              } } },
            } } },
            skipped: { type: "array", description: "Titles asked about and not planned or deleted: { tmdbId, mediaType, title (nullable), reason }", items: { type: "object", properties: {
              tmdbId: { type: "integer" },
              mediaType: { type: "string", enum: ["MOVIE", "TV"] },
              title: { type: "string", nullable: true },
              reason: { type: "string" },
            } } },
            hint: { type: "string", description: "Dry run: how to confirm the execute (English text, not for display)" },
            deletedCount: { type: "integer", description: "Execute only" },
            partialCount: { type: "integer", description: "Execute only" },
            failedCount: { type: "integer", description: "Execute only" },
            results: { type: "array", description: "Execute only", items: { type: "object", properties: {
              tmdbId: { type: "integer" },
              mediaType: { type: "string", enum: ["MOVIE", "TV"] },
              title: { type: "string" },
              status: { type: "string", enum: ["deleted", "partial", "failed"] },
              deleted: { type: "array", items: { type: "string" } },
              failed: { type: "array", items: { type: "object", properties: {
                target: { type: "string" },
                service: ARR_SERVICE,
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
        "429": { description: "Rate limited (30 per minute per admin, dry run and execute alike)" },
        "400": { description: "Invalid body" },
        "403": { description: "Not ADMIN" },
        "404": { description: "Library cleanup is disabled" },
        "409": { description: "confirmTargets missing or not equal to the live count, or confirmFingerprint sent and not equal to the live target set (the fresh plan, with its targetCount, targetsFingerprint and reclaimableBytes, is returned)" },
        "413": tooLargeAnswer(64 * 1024),
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
                      errorCode: { type: "string", nullable: true, enum: ["timeout", "unreachable", "blocked", "tooLarge", "redirect", "http", "noUsers", "shape", "noRecords", "other", null] },
                      httpStatus: { type: "integer", nullable: true, description: "Set when errorCode is `http`" },
                    } },
                  } } },
                  trackingOn: { type: "boolean" },
                  historyStart: { type: "string", format: "date-time", nullable: true },
                  unplacedPlays: { type: "integer" },
                  softPlays: { type: "integer" },
                  arrErrors: { type: "array", items: ARR_LISTING_ERROR },
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
                  truncated: { type: "boolean", description: "The account lists stopped at 10,000 (additive)" },
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
        "413": tooLargeAnswer(1024),
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
        "429": { description: "Rate limited (6 per 10 minutes per admin)", headers: RETRY_AFTER_HEADER },
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
};
