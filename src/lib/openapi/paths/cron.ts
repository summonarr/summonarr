// Inbound Radarr/Sonarr webhooks and the scheduled maintenance jobs.

import {
  ADMIN_OR_CRON_SECURITY,
  ARR_SERVICE,
  AUDIT_SCRUB_FIELDS,
  CRON_RUN_FIELDS,
  cronRunOrSkip,
  UPSTREAM_REFRESH_RESULT,
  WATCH_SYNC_PAIR_RESULT,
  LIBRARY_PREWARM_COUNTS,
} from "../shared";
import type { OpenApiSchema, OpenApiPaths } from "../types";

// The fields the Radarr and Sonarr webhooks acknowledge with (handleArrWebhook,
// src/lib/arr-webhook.ts, and each route's dispatch): every 200 is
// { ok: true } plus whichever of these the delivery's outcome sets.
const ARR_WEBHOOK_ACK_FIELDS = {
  ok: { type: "boolean", enum: [true] },
  message: { type: "string", description: "A Test delivery only" },
  health: { type: "boolean", enum: [true], description: "A Health / HealthRestored delivery" },
  forwarded: { type: "boolean", description: "Health only: false when held back" },
  manualInteraction: { type: "boolean", enum: [true], description: "A ManualInteractionRequired delivery: admins were alerted" },
  evicted: { type: "boolean", description: "A delete event: whether the cache rows were removed (only once the arr confirmed it)" },
  skipped: { type: "boolean", enum: [true], description: "Nothing to change for this delivery" },
  marked: { type: "integer", description: "Requests flipped to AVAILABLE" },
} satisfies Record<string, OpenApiSchema>;

export const cronPaths: OpenApiPaths = {
  "/webhooks/radarr": {
    post: {
      tags: ["Webhooks"],
      summary: "Radarr webhook (movie grabbed / imported / deleted, health)",
      description:
        "Authenticated by the instance's webhook secret, as `?token=` or a Bearer header. `Health` / `HealthRestored` " +
        "deliveries are forwarded to the outbound notification channels as `arr.health` / `arr.health_restored` and answer " +
        "{ ok: true, health: true, forwarded } — `forwarded` is false when held back (a repeat of the same state for the same check within 10 minutes, or a delivery with no message). " +
        "`ManualInteractionRequired` alerts admins. A byte-identical repeat of any other delivery is refused as a replay.",
      security: [],
      parameters: [{ name: "token", in: "query", schema: { type: "string" } }],
      requestBody: { content: { "application/json": { schema: { type: "object" } } } },
      responses: {
        "200": {
          description: "Processed — { ok: true, ... } (a Test event answers { ok, message })",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["ok"],
                properties: {
                  ...ARR_WEBHOOK_ACK_FIELDS,
                  reason: { type: "string", enum: ["unverified", "not_deleted", "not_downloaded"], description: "Why nothing was evicted or marked" },
                },
              },
            },
          },
        },
        "400": { description: "Body is not valid JSON (or is nested deeper than 64 levels), or the payload's tmdbId is invalid" },
        "401": { description: "Invalid token" },
        "409": { description: "Replayed delivery" },
        "413": { description: "Body over 1 MB" },
        "429": { description: "More than 600 deliveries a minute from one client IP" },
      },
    },
  },
  "/webhooks/sonarr": {
    post: {
      tags: ["Webhooks"],
      summary: "Sonarr webhook (episode grabbed / imported / deleted, health)",
      description:
        "Authenticated by the instance's webhook secret, as `?token=` or a Bearer header. `Health` / `HealthRestored` " +
        "deliveries are forwarded to the outbound notification channels as `arr.health` / `arr.health_restored` and answer " +
        "{ ok: true, health: true, forwarded }; a byte-identical repeat of any other delivery is refused as a replay. " +
        "A Download event flips the series' APPROVED requests to AVAILABLE only once Sonarr confirms the series COMPLETE (every aired regular-season episode on disk). Mid-import deliveries answer { skipped: true, reason: \"incomplete\", episodeFileCount, episodeCount }; an unverifiable delivery (Sonarr unreachable) answers { deferred: true } and is re-checked after the library scan settles.",
      security: [],
      parameters: [{ name: "token", in: "query", schema: { type: "string" } }],
      requestBody: { content: { "application/json": { schema: { type: "object" } } } },
      responses: {
        "200": {
          description: "Processed — { ok: true, ... } (a Test event answers { ok, message })",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["ok"],
                properties: {
                  ...ARR_WEBHOOK_ACK_FIELDS,
                  deferred: { type: "boolean", enum: [true], description: "Sonarr could not be asked; re-checked after the library scan settles" },
                  reason: {
                    type: "string",
                    enum: ["unverified", "not_deleted", "unconfirmed", "not_downloaded", "incomplete"],
                    description: "Why nothing was evicted or marked",
                  },
                  episodeFileCount: { type: "integer", description: "reason \"incomplete\" only" },
                  episodeCount: { type: "integer", description: "reason \"incomplete\" only" },
                },
              },
            },
          },
        },
        "400": { description: "Body is not valid JSON, or is nested deeper than 64 levels (an unusable tmdbId/tvdbId never 400s here: it is ignored and the delivery is verified by the series' other id)" },
        "401": { description: "Invalid token" },
        "409": { description: "Replayed delivery" },
        "413": { description: "Body over 1 MB" },
        "429": { description: "More than 600 deliveries a minute from one client IP" },
      },
    },
  },
  "/cron/arr-watch": {
    post: {
      tags: ["Cron"],
      summary: "Radarr/Sonarr monitor: low disks, failed downloads, downloads newly needing attention",
      description:
        "Reads every configured, enabled Radarr/Sonarr instance — the disks holding its root folders (/api/v3/rootfolder + /diskspace), " +
        "failed downloads since the last run (/api/v3/history/since, eventType=4) and its queue — and sends `arr.disk_low` / `arr.disk_ok` " +
        "(on a change of state per instance and disk), `arr.download_failed` (each new failed download once; a Sonarr pack is one event; a manual mark, \"Manually marked as failed\", is not announced) and " +
        "`arr.queue_attention` (each download newly needing attention, at most 25 per instance per run — the rest by the next run) to the " +
        "outbound notification channels. An announced download and a disk's state are remembered for 24 hours after they drop out of a " +
        "read, so one that comes back inside that is not announced again. A first run per instance seeds its history cursor and attention " +
        "set without announcing them. Writes the counts behind the admin nav's Download Queue badge. " +
        "Skipped (no ledger row) while no Radarr/Sonarr instance is enabled and configured; a failed read answers 200 with ok:false, " +
        "`error` and X-Cron-Degraded. `deferredFailures` counts history RECORDS left for the next run once the per-run cap was " +
        "reached (a Sonarr pack counts once per episode, so it is not a count of downloads); `deferredAttention` counts downloads.",
      security: ADMIN_OR_CRON_SECURITY,
      responses: {
        "200": {
          description: "{ ok, checked, notReached, aborted, errors: [{ service, instance, part: disk|history|queue, error }], events: { diskLow, diskOk, downloadFailed, queueAttention }, deferredFailures, deferredAttention, summary: { attention, lowDisks, failed24h }, durationMs, trigger, timestamp } — or { skipped: true, reason }",
          content: {
            "application/json": {
              schema: cronRunOrSkip({
                type: "object",
                required: ["ok", "checked", "notReached", "aborted", "errors", "events", "deferredFailures", "deferredAttention", "summary", "durationMs", "trigger", "timestamp"],
                properties: {
                  ok: CRON_RUN_FIELDS.ok,
                  checked: { type: "integer", description: "Instances read this run" },
                  notReached: { type: "integer", description: "Instances not reached because the run was stopped" },
                  aborted: { type: "boolean" },
                  errors: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        service: ARR_SERVICE,
                        instance: { type: "string" },
                        part: { type: "string", enum: ["disk", "history", "queue"] },
                        error: { type: "string" },
                      },
                    },
                  },
                  events: {
                    type: "object",
                    properties: { diskLow: { type: "integer" }, diskOk: { type: "integer" }, downloadFailed: { type: "integer" }, queueAttention: { type: "integer" } },
                  },
                  deferredFailures: { type: "integer" },
                  deferredAttention: { type: "integer" },
                  summary: {
                    type: "object",
                    properties: { attention: { type: "integer" }, lowDisks: { type: "integer" }, failed24h: { type: "integer" } },
                  },
                  error: CRON_RUN_FIELDS.error,
                  durationMs: CRON_RUN_FIELDS.durationMs,
                  trigger: CRON_RUN_FIELDS.trigger,
                  timestamp: CRON_RUN_FIELDS.timestamp,
                },
              }),
            },
          },
        },
        "401": { description: "Neither an admin session nor the cron secret" },
      },
    },
  },
  "/cron/refresh-arr-snapshots": {
    post: {
      tags: ["Cron"],
      summary: "Keep the admin Radarr/Sonarr pages' last answers fresh in the background",
      description:
        "Re-reads, through each route's own handler, every admin arr view an admin opened in the last 24 hours, on its page's priority: " +
        "the queue and Radarr/Sonarr health every 5 minutes; Missing, Download History/Blocklist, the calendar and the title manager every 10; " +
        "Arr System (tasks, indexers & clients, storage) every 15 — at most 40 re-reads per run, 2 at a time. The kept answer is what the page " +
        "paints at once on its next open (`?cached=1`). A failed re-read keeps the last good answer. Skipped (no ledger row) when nothing is due; " +
        "a failed re-read answers 200 with ok:false, `error` and X-Cron-Degraded.",
      security: ADMIN_OR_CRON_SECURITY,
      responses: {
        "200": {
          description: "{ ok, due, refreshed, failed, deferred, aborted, durationMs, trigger, timestamp } — or { skipped: true, reason }",
          content: {
            "application/json": {
              schema: cronRunOrSkip({
                type: "object",
                required: ["ok", "due", "refreshed", "failed", "deferred", "aborted", "durationMs", "trigger", "timestamp"],
                properties: {
                  ok: CRON_RUN_FIELDS.ok,
                  due: { type: "integer", description: "Views that were due this run" },
                  refreshed: { type: "integer" },
                  failed: { type: "integer", description: "Re-reads that failed; their last good answer stays" },
                  deferred: { type: "integer", description: "Due views left for the next run" },
                  aborted: { type: "boolean" },
                  error: CRON_RUN_FIELDS.error,
                  durationMs: CRON_RUN_FIELDS.durationMs,
                  trigger: CRON_RUN_FIELDS.trigger,
                  timestamp: CRON_RUN_FIELDS.timestamp,
                },
              }),
            },
          },
        },
        "401": { description: "Neither an admin session nor the cron secret" },
      },
    },
  },
  "/cron/purge-auth-sessions": {
    post: {
      tags: ["Cron"],
      summary: "Purge expired auth sessions",
      security: ADMIN_OR_CRON_SECURITY,
      responses: {
        "200": {
          description: "{ ok, deleted: { authSessions, discordLinkTokens, discordMergeCodes, ... counts per table }, errorCount, aborted, timestamp, error? } — a failed table sweep, or a run stopped on its lock signal, answers ok:false with `error` and X-Cron-Degraded (still 200) — or { skipped: true, reason } when another run holds the lock (X-Cron-Skipped). Only rows past their `expiresAt` are swept (guardrail 6c)",
          content: {
            "application/json": {
              schema: cronRunOrSkip({
                type: "object",
                required: ["ok", "deleted", "errorCount", "aborted", "timestamp"],
                properties: {
                  ok: { type: "boolean", description: "false when a table sweep failed or the run was stopped — with `error` and X-Cron-Degraded (still 200)" },
                  aborted: { type: "boolean", description: "The run stopped on its lock signal before every table was swept; the next run continues" },
                  error: { type: "string", description: "Why the run is degraded" },
                  deleted: {
                    type: "object",
                    description: "Rows deleted per table",
                    properties: {
                      authSessions: { type: "integer" },
                      discordLinkTokens: { type: "integer" },
                      discordMergeCodes: { type: "integer" },
                      discordSearchCache: { type: "integer" },
                      webhookReplays: { type: "integer" },
                      plexTokensExpired: { type: "integer" },
                      plexTokensLegacy: { type: "integer" },
                      tmdbMediaCore: { type: "integer" },
                      ipLookupCache: { type: "integer" },
                      auditLogs: { type: "integer" },
                    },
                  },
                  errorCount: { type: "integer" },
                  timestamp: CRON_RUN_FIELDS.timestamp,
                },
              }),
            },
          },
        },
        "401": { description: "Neither an admin session nor the cron secret" },
      },
    },
  },
  "/cron/purge-notifications": {
    post: {
      tags: ["Cron"],
      summary: "Delete old notification inbox rows",
      security: ADMIN_OR_CRON_SECURITY,
      responses: {
        "200": {
          description: "{ ok, deleted, aborted, timestamp, error? } — a run stopped on its lock signal answers ok:false with `error` and X-Cron-Degraded (still 200) — or { skipped: true, reason } when another run holds the lock (X-Cron-Skipped). Deletes read notifications older than NOTIFICATION_READ_RETENTION_DAYS (90) and any older than NOTIFICATION_RETENTION_DAYS (365), in batches",
          content: {
            "application/json": {
              schema: cronRunOrSkip({
                type: "object",
                required: ["ok", "deleted", "aborted", "timestamp"],
                properties: {
                  ok: { type: "boolean", description: "false when the run was stopped before it finished, with `error` and X-Cron-Degraded (still 200)" },
                  error: { type: "string", description: "Why the run is degraded" },
                  deleted: { type: "integer" },
                  aborted: { type: "boolean", description: "The run stopped early; the next one continues" },
                  timestamp: CRON_RUN_FIELDS.timestamp,
                },
              }),
            },
          },
        },
        "401": { description: "Neither an admin session nor the cron secret" },
        "500": { description: "{ ok: false, error } — the purge failed" },
      },
    },
  },
  "/cron/scrub-audit-pii": {
    post: {
      tags: ["Cron"],
      summary: "Scrub PII from old audit log entries",
      security: ADMIN_OR_CRON_SECURITY,
      responses: {
        "200": {
          description: "{ ok, scrubbed, authDetailsCleared, cutoff, timestamp } — or { skipped: true, reason } when another run holds the lock",
          content: {
            "application/json": {
              schema: cronRunOrSkip({
                type: "object",
                required: ["ok", "scrubbed", "authDetailsCleared", "adminDetailsScrubbed", "cutoff", "timestamp"],
                properties: {
                  ok: { type: "boolean", enum: [true] },
                  scrubbed: AUDIT_SCRUB_FIELDS.scrubbed,
                  authDetailsCleared: { type: "integer", description: "Sign-in / sign-out rows whose details were cleared" },
                  adminDetailsScrubbed: AUDIT_SCRUB_FIELDS.adminDetailsScrubbed,
                  cutoff: AUDIT_SCRUB_FIELDS.cutoff,
                  timestamp: CRON_RUN_FIELDS.timestamp,
                },
              }),
            },
          },
        },
        "401": { description: "Neither an admin session nor the cron secret" },
      },
    },
  },
  "/cron/warm-activity": {
    post: {
      tags: ["Cron"],
      summary: "Pre-warm activity calendar cache",
      security: ADMIN_OR_CRON_SECURITY,
      responses: {
        "200": {
          description: "{ ok, warmed, timestamp } — or { skipped: true, reason } when another run holds the lock",
          content: {
            "application/json": {
              schema: cronRunOrSkip({
                type: "object",
                required: ["ok", "warmed", "timestamp"],
                properties: {
                  ok: { type: "boolean", enum: [true] },
                  warmed: { type: "integer" },
                  timestamp: CRON_RUN_FIELDS.timestamp,
                },
              }),
            },
          },
        },
        "401": { description: "Neither an admin session nor the cron secret" },
      },
    },
  },
  "/cron/refresh-upstream-watch": {
    post: {
      tags: ["Cron"],
      summary: "Snapshot each media server's own watch records for the never-watched report",
      security: ADMIN_OR_CRON_SECURITY,
      responses: {
        "200": {
          description: "{ ok, ...per-server results, durationMs, trigger, timestamp } (a server that could not be checked sets ok:false, `error` and X-Cron-Degraded) — or { skipped: true, reason } while both the Never Watched page and Library Cleanup are off, or another run holds the lock",
          content: {
            "application/json": {
              schema: cronRunOrSkip({
                type: "object",
                required: ["ok", "servers", "aborted", "durationMs", "trigger", "timestamp"],
                properties: {
                  ok: CRON_RUN_FIELDS.ok,
                  servers: UPSTREAM_REFRESH_RESULT.properties.servers,
                  aborted: UPSTREAM_REFRESH_RESULT.properties.aborted,
                  error: CRON_RUN_FIELDS.error,
                  durationMs: CRON_RUN_FIELDS.durationMs,
                  trigger: CRON_RUN_FIELDS.trigger,
                  timestamp: CRON_RUN_FIELDS.timestamp,
                },
              }),
            },
          },
        },
        "401": { description: "Neither an admin session nor the cron secret" },
      },
    },
  },
  "/cron/watch-sync": {
    post: {
      tags: ["Cron"],
      summary: "Watch sync: keep each admin-paired Plex and Jellyfin account's watched status in step, per the pair's direction",
      security: ADMIN_OR_CRON_SECURITY,
      responses: {
        "200": {
          description: "{ ok, pairs: [{ pairId, toJellyfin, toPlex, error? }], aborted, durationMs, trigger, timestamp } (a pair with an error or failed items in either direction sets ok:false, `error` and X-Cron-Degraded) — or { skipped: true, reason } while the feature is off or another run holds the lock",
          content: {
            "application/json": {
              schema: cronRunOrSkip({
                type: "object",
                required: ["ok", "pairs", "aborted", "durationMs", "trigger", "timestamp"],
                properties: {
                  ok: CRON_RUN_FIELDS.ok,
                  pairs: { type: "array", items: WATCH_SYNC_PAIR_RESULT },
                  aborted: { type: "boolean", description: "The run stopped on its time limit; finished work is saved" },
                  error: CRON_RUN_FIELDS.error,
                  durationMs: CRON_RUN_FIELDS.durationMs,
                  trigger: CRON_RUN_FIELDS.trigger,
                  timestamp: CRON_RUN_FIELDS.timestamp,
                },
              }),
            },
          },
        },
        "401": { description: "Neither an admin session nor the cron secret" },
      },
    },
  },
  "/cron/warm-library": {
    post: {
      tags: ["Cron"],
      summary: "Incrementally re-warm the library :details/TmdbMediaCore caches",
      security: ADMIN_OR_CRON_SECURITY,
      responses: {
        "200": {
          description: "{ ok, ...library counts, edges, translations, timestamp, error? } — or { skipped: true, reason } with X-Cron-Skipped (no TMDB credentials, or another run holds the lock; not recorded as a run)",
          content: {
            "application/json": {
              schema: cronRunOrSkip({
                type: "object",
                required: ["ok", "total", "fetched", "backfilled", "skipped", "failed", "edges", "translations", "timestamp"],
                properties: {
                  ok: CRON_RUN_FIELDS.ok,
                  ...LIBRARY_PREWARM_COUNTS,
                  edges: {
                    type: "object",
                    description: "Suggestion edges built for the recommendation graph (prewarmSuggestionEdges)",
                    properties: {
                      sources: { type: "integer" },
                      refreshed: { type: "integer" },
                      skipped: { type: "integer" },
                      failed: { type: "integer" },
                      edgesWritten: { type: "integer" },
                    },
                  },
                  translations: {
                    type: "object",
                    description: "Title translations warmed (prewarmTitleTranslations); `skipped` while nobody reads a non-English language",
                    properties: {
                      skipped: { type: "boolean" },
                      candidates: { type: "integer" },
                      fetched: { type: "integer" },
                      failed: { type: "integer" },
                    },
                  },
                  error: CRON_RUN_FIELDS.error,
                  timestamp: CRON_RUN_FIELDS.timestamp,
                },
              }),
            },
          },
        },
        "401": { description: "Neither an admin session nor the cron secret" },
      },
    },
  },
  "/cron/warm-mdblist": {
    post: {
      tags: ["Cron"],
      summary: "Pre-warm MDBList ratings cache",
      security: ADMIN_OR_CRON_SECURITY,
      responses: {
        "200": {
          description: "{ ok, total, ..., timestamp, error? } with X-Cron-Degraded when some items failed — or { skipped: true, reason } with X-Cron-Skipped (no MDBList key, or another run holds the lock; not recorded as a run)",
          content: {
            "application/json": {
              schema: cronRunOrSkip({
                type: "object",
                required: ["ok", "total", "fetched", "skipped", "failed", "purged", "timestamp"],
                properties: {
                  ok: CRON_RUN_FIELDS.ok,
                  total: { type: "integer" },
                  fetched: { type: "integer" },
                  skipped: { type: "integer" },
                  failed: { type: "integer" },
                  purged: { type: "integer" },
                  quotaExhausted: { type: "boolean", description: "Present when MDBList's limit (or the background reserve) stopped the run" },
                  error: CRON_RUN_FIELDS.error,
                  timestamp: CRON_RUN_FIELDS.timestamp,
                },
              }),
            },
          },
        },
        "401": { description: "Neither an admin session nor the cron secret" },
      },
    },
  },
  "/cron/warm-omdb": {
    post: {
      tags: ["Cron"],
      summary: "Pre-warm OMDB ratings cache",
      security: ADMIN_OR_CRON_SECURITY,
      responses: {
        "200": {
          description: "{ ok, total, ..., timestamp, error? } with X-Cron-Degraded when some items failed — or { skipped: true, reason } with X-Cron-Skipped (no OMDB key, or another run holds the lock; not recorded as a run)",
          content: {
            "application/json": {
              schema: cronRunOrSkip({
                type: "object",
                required: ["ok", "total", "fetched", "notFound", "skipped", "failed", "timestamp"],
                properties: {
                  ok: CRON_RUN_FIELDS.ok,
                  total: { type: "integer" },
                  fetched: { type: "integer" },
                  notFound: { type: "integer", description: "Authoritative misses only (negative-cached); a transient failure counts in `failed`" },
                  skipped: { type: "integer" },
                  failed: { type: "integer" },
                  quotaExhausted: { type: "boolean", description: "Present when the OMDB quota lockout cut the run short" },
                  error: CRON_RUN_FIELDS.error,
                  timestamp: CRON_RUN_FIELDS.timestamp,
                },
              }),
            },
          },
        },
        "401": { description: "Neither an admin session nor the cron secret" },
      },
    },
  },
  "/cron/warm-recommendations": {
    post: {
      tags: ["Cron"],
      summary: "Pre-warm personalized \"For You\" recommendation cache",
      security: ADMIN_OR_CRON_SECURITY,
      responses: {
        "200": {
          description: "{ ok, ...result, timestamp, error? } — a failed graph build or user computations set ok:false and X-Cron-Degraded (every stored shelf is kept); a failed orphan sweep after the build only sets `graph.sweepFailed` — or { skipped: true, reason } with X-Cron-Skipped when another run holds the lock",
          content: {
            "application/json": {
              schema: cronRunOrSkip({
                type: "object",
                required: ["ok", "usersEligible", "usersUpdated", "usersSkipped", "usersFailed", "candidatesWritten", "graphFailed", "graph", "serverHistory", "timestamp"],
                properties: {
                  ok: CRON_RUN_FIELDS.ok,
                  usersEligible: { type: "integer" },
                  usersUpdated: { type: "integer" },
                  usersSkipped: { type: "integer" },
                  usersFailed: { type: "integer" },
                  candidatesWritten: { type: "integer" },
                  graphFailed: { type: "boolean", description: "The graph refresh threw: no user was recomputed" },
                  serverHistoryFailed: { type: "boolean", description: "Present (always true) only when the media servers' history import threw outright; serverHistory then reports zeros rather than a guessed tally" },
                  graph: {
                    type: "object",
                    description: "The recommendation graph refresh (GraphRefreshResult)",
                    properties: {
                      sources: { type: "integer" },
                      requiredSources: { type: "integer" },
                      requiredCovered: { type: "integer" },
                      sourcesRefreshed: { type: "integer" },
                      sourcesSkipped: { type: "integer" },
                      sourcesFailed: { type: "integer" },
                      edgesWritten: { type: "integer" },
                      sourcesSwept: { type: "integer" },
                      sweepFailed: { type: "boolean", description: "The orphan sweep threw (cleanup only; the rest ran)" },
                      titlesRated: { type: "integer" },
                      verdictsDeferred: { type: "integer" },
                      ratingsFailed: { type: "integer" },
                      coWatchEdges: { type: "integer" },
                      coWatchFailed: { type: "boolean", description: "The co-watch build failed; the previous edges were kept" },
                    },
                  },
                  serverHistory: {
                    type: "object",
                    description: "Phase 0: the media servers' own watch history and favorites (ServerHistoryImportResult)",
                    properties: {
                      servers: { type: "integer" },
                      identities: { type: "integer" },
                      failedServers: { type: "integer" },
                      failedIdentities: { type: "integer" },
                      unresolved: { type: "integer" },
                      aborted: { type: "boolean" },
                    },
                  },
                  error: CRON_RUN_FIELDS.error,
                  timestamp: CRON_RUN_FIELDS.timestamp,
                },
              }),
            },
          },
        },
        "401": { description: "Neither an admin session nor the cron secret" },
      },
    },
  },
};
