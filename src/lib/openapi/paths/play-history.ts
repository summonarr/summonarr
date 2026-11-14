// Watch history, statistics and active sessions.

import { STEP_UP_401, tooLargeAnswer, RETRY_AFTER_HEADER, AUTH_SESSION_ROW_FIELDS, OK_TRUE } from "../shared";
import type { OpenApiSchema, OpenApiParameter, OpenApiPaths } from "../types";

// One PlayHistory row as stored (prisma/schema.prisma), every column. ADMIN reads
// only: it carries the client's IP address and network location.
const PLAY_HISTORY_ROW_FIELDS = {
  id: { type: "string" },
  source: { type: "string", description: "plex | jellyfin" },
  serverInstance: { type: "string", description: "The server's slug ('' for the default server)" },
  startedAt: { type: "string", format: "date-time" },
  stoppedAt: { type: "string", format: "date-time" },
  duration: { type: "integer", description: "The media's length, seconds" },
  playDuration: { type: "integer", description: "Seconds spent playing (pause and buffering excluded)" },
  pausedDuration: { type: "integer" },
  watched: { type: "boolean" },
  completed: { type: "boolean" },
  mediaServerUserId: { type: "string" },
  tmdbId: { type: "integer", nullable: true },
  mediaType: { type: "string", enum: ["MOVIE", "TV", null], nullable: true },
  title: { type: "string" },
  year: { type: "string", nullable: true },
  posterPath: { type: "string", nullable: true },
  seasonNumber: { type: "integer", nullable: true },
  episodeNumber: { type: "integer", nullable: true },
  episodeTitle: { type: "string", nullable: true },
  sourceSessionId: { type: "string", nullable: true },
  sourceItemId: { type: "string", nullable: true },
  sourceShowId: { type: "string", nullable: true },
  platform: { type: "string", nullable: true },
  player: { type: "string", nullable: true },
  device: { type: "string", nullable: true },
  ipAddress: { type: "string", nullable: true },
  playMethod: { type: "string", nullable: true, description: "DirectPlay | DirectStream | Transcode" },
  videoCodec: { type: "string", nullable: true },
  audioCodec: { type: "string", nullable: true },
  resolution: { type: "string", nullable: true },
  bitrate: { type: "integer", nullable: true, description: "As the source reported it (guardrail 19a) — normalize by `source`" },
  videoDecision: { type: "string", nullable: true },
  audioDecision: { type: "string", nullable: true },
  container: { type: "string", nullable: true },
  transcodeReason: { type: "string", nullable: true },
  location: { type: "string", nullable: true, description: "lan | wan | relay" },
  bandwidth: { type: "integer", nullable: true, description: "kbps" },
  secure: { type: "boolean", nullable: true },
  relayed: { type: "boolean", nullable: true },
  introStartMs: { type: "integer", nullable: true },
  introEndMs: { type: "integer", nullable: true },
  creditsStartMs: { type: "integer", nullable: true },
  creditsEndMs: { type: "integer", nullable: true },
  referenceId: { type: "string", nullable: true, description: "The first segment's id when this row continues a resume chain" },
  createdAt: { type: "string", format: "date-time" },
} satisfies Record<string, OpenApiSchema>;

// `{ <label>, count }[]` — the breakdown rows the play statistics share.
function playCountRows(label: string, labelSchema: OpenApiSchema = { type: "string" }): OpenApiSchema {
  return {
    type: "array",
    items: { type: "object", required: [label, "count"], properties: { [label]: labelSchema, count: { type: "integer" } } },
  };
}

// One entry of the caller's own consolidated history (MyWatchHistoryItem,
// src/lib/my-watch-history.ts) — the lean field set: no IP, codecs or ids of
// the media-server identity.
const MY_HISTORY_ITEM = {
  type: "object",
  properties: {
    id: { type: "string", description: "The latest play's id — any play id of the entry opens it at /play-history/mine/{id}" },
    source: { type: "string" },
    startedAt: { type: "string", format: "date-time" },
    stoppedAt: { type: "string", format: "date-time" },
    duration: { type: "integer" },
    playDuration: { type: "integer", description: "The latest play's seconds" },
    watched: { type: "boolean", description: "Any play of the entry counted as watched" },
    completed: { type: "boolean" },
    tmdbId: { type: "integer", nullable: true },
    mediaType: { type: "string", enum: ["MOVIE", "TV", null], nullable: true },
    title: { type: "string" },
    year: { type: "string", nullable: true },
    posterPath: { type: "string", nullable: true },
    seasonNumber: { type: "integer", nullable: true },
    episodeNumber: { type: "integer", nullable: true },
    episodeTitle: { type: "string", nullable: true },
    platform: { type: "string", nullable: true },
    player: { type: "string", nullable: true },
    device: { type: "string", nullable: true },
    playMethod: { type: "string", nullable: true },
    posterUrl: { type: "string", nullable: true },
    playCount: { type: "integer", description: "How many plays the entry collapses" },
    totalPlaySeconds: { type: "integer" },
  },
} satisfies OpenApiSchema;

// The statistics' top-title rows (topRewatched / topWatched in
// PlayHistoryStatsResult, src/lib/play-history.ts).
const PLAY_TOP_TITLE_ROWS = {
  type: "array",
  items: {
    type: "object",
    properties: {
      tmdbId: { type: "integer" },
      mediaType: { type: "string" },
      title: { type: "string" },
      posterPath: { type: "string", nullable: true },
      plays: { type: "integer" },
      viewers: { type: "integer" },
    },
  },
} satisfies OpenApiSchema;

// The filters GET /play-history and its export share — both read them through
// normalizePlayHistoryFilters (src/lib/play-history-filters.ts).
const PLAY_HISTORY_FILTER_PARAMS = [
  { name: "source", in: "query", schema: { type: "string", enum: ["plex", "jellyfin"] } },
  { name: "mediaType", in: "query", schema: { $ref: "#/components/schemas/MediaType" } },
  { name: "watched", in: "query", schema: { type: "string", enum: ["true", "false"] }, description: "Any other value is ignored" },
  { name: "playMethod", in: "query", schema: { type: "string" }, description: "A known play method; unknown values are ignored" },
  { name: "platform", in: "query", schema: { type: "string" } },
  { name: "startDate", in: "query", schema: { type: "string", format: "date" } },
  { name: "endDate", in: "query", schema: { type: "string", format: "date" } },
  { name: "fromDay", in: "query", schema: { type: "string", format: "date" }, description: "First day (YYYY-MM-DD) in the statistics time zone: plays from that day's midnight there" },
  { name: "toDay", in: "query", schema: { type: "string", format: "date" }, description: "Last day (YYYY-MM-DD) in the statistics time zone, inclusive: plays before the next day's midnight there" },
  { name: "search", in: "query", schema: { type: "string" } },
  { name: "userId", in: "query", schema: { type: "string" } },
  { name: "tmdbId", in: "query", schema: { type: "integer" } },
] satisfies OpenApiParameter[];

// One row of GET /play-history's paginated list.
const PLAY_HISTORY_LIST_ROW = {
  type: "object",
  description: "Grouped: the chain's latest segment with the chain's totals; ungrouped: one segment (a chain of one)",
  properties: {
    ...PLAY_HISTORY_ROW_FIELDS,
    watched: { type: "boolean", description: "Grouped: any segment of the chain counted as watched" },
    completed: { type: "boolean", description: "Grouped: any segment of the chain completed" },
    mediaServerUser: {
      type: "object",
      nullable: true,
      required: ["username", "source", "thumbUrl"],
      properties: {
        username: { type: "string" },
        source: { type: "string" },
        thumbUrl: { type: "string", nullable: true },
        user: {
          type: "object",
          nullable: true,
          description: "Ungrouped only: the linked Summonarr account, null when unlinked",
          properties: { name: { type: "string", nullable: true } },
        },
      },
    },
    posterUrl: { type: "string", nullable: true, description: "Live poster URL (w342), null when uncached" },
    segmentCount: { type: "integer", description: "1 when ungrouped" },
    chainId: { type: "string" },
    totalPlayDuration: { type: "integer" },
    totalPausedDuration: { type: "integer" },
    firstStartedAt: { type: "string", format: "date-time" },
    lastStoppedAt: { type: "string", format: "date-time" },
  },
} satisfies OpenApiSchema;

// GET /play-history?distinct=users.
const PLAY_HISTORY_DISTINCT_USERS = {
  type: "array",
  description: "distinct=users: every MediaServerUser, departed ones included",
  items: {
    type: "object",
    required: ["id", "username", "source", "serverInstance"],
    properties: { id: { type: "string" }, username: { type: "string" }, source: { type: "string" }, serverInstance: { type: "string" } },
  },
} satisfies OpenApiSchema;

export const playHistoryPaths: OpenApiPaths = {
  "/play-history": {
    get: {
      tags: ["Play History"],
      summary: "List play history across all users (ADMIN)",
      parameters: [
        { name: "page", in: "query", schema: { type: "integer", default: 1 } },
        { name: "limit", in: "query", schema: { type: "integer", default: 20, minimum: 1, maximum: 200 } },
        {
          name: "distinct", in: "query", schema: { type: "string", enum: ["platforms", "users"] },
          description:
            "A MODE SWITCH, not a boolean. `platforms` returns a bare string[] of non-null platforms; `users` returns a bare array of { id, username, source, serverInstance } over every MediaServerUser (departed ones included, per guardrail 28). Both ignore every other parameter. Any other value — including `true` — falls through to the paginated list.",
        },
        { name: "ungrouped", in: "query", schema: { type: "string", enum: ["true"] }, description: "Only the literal `true` lists individual segments; anything else collapses resume chains into one row each" },
        { name: "sortBy", in: "query", schema: { type: "string", enum: ["startedAt", "title", "playDuration", "duration", "source", "platform"], default: "startedAt" }, description: "Unknown values fall back to startedAt" },
        { name: "sortDir", in: "query", schema: { type: "string", enum: ["asc", "desc"], default: "desc" } },
        ...PLAY_HISTORY_FILTER_PARAMS,
      ],
      responses: {
        "200": {
          description: "{ items, total, page, limit, totalPages, grouped } — grouped is false only on the `ungrouped=true` path. Rows carry posterPath/poster URLs resolved from the poster cache.",
          content: {
            "application/json": {
              schema: {
                anyOf: [
                  {
                    type: "object",
                    required: ["items", "total", "page", "limit", "totalPages", "grouped"],
                    properties: {
                      items: {
                        type: "array",
                        items: PLAY_HISTORY_LIST_ROW,
                      },
                      total: { type: "integer" },
                      page: { type: "integer" },
                      limit: { type: "integer" },
                      totalPages: { type: "integer" },
                      grouped: { type: "boolean" },
                    },
                  },
                  { type: "array", description: "distinct=platforms: every non-null platform", items: { type: "string" } },
                  PLAY_HISTORY_DISTINCT_USERS,
                ],
              },
            },
          },
        },
        "400": { description: "An unparseable startDate, endDate, fromDay or toDay (`error` names it)" },
        "403": { description: "Forbidden" },
        "429": { description: "Rate limited (120/min per admin)" },
      },
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
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["linked", "items", "total", "nextCursor", "pageSize", "stats"],
                properties: {
                  linked: { type: "boolean" },
                  items: { type: "array", items: MY_HISTORY_ITEM },
                  total: { type: "integer", description: "Consolidated entries matching the filters" },
                  nextCursor: { type: "string", nullable: true, description: "Send back as `cursor`; null when no further entry exists (an exactly full last page has none)" },
                  pageSize: { type: "integer" },
                  stats: {
                    type: "object",
                    required: ["plays", "playSeconds"],
                    description: "All-time raw totals, unaffected by filters and consolidation",
                    properties: { plays: { type: "integer" }, playSeconds: { type: "integer" } },
                  },
                },
              },
            },
          },
        },
        "429": { description: "Rate limited (120/min per user, shared with GET /play-history/mine/{id})", headers: RETRY_AFTER_HEADER },
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
        "200": {
          description: "{ item, plays (capped at 100, newest first), firstStartedAt, lastStartedAt }",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["item", "plays", "firstStartedAt", "lastStartedAt"],
                properties: {
                  item: MY_HISTORY_ITEM,
                  plays: {
                    type: "array",
                    maxItems: 100,
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        source: { type: "string" },
                        startedAt: { type: "string", format: "date-time" },
                        stoppedAt: { type: "string", format: "date-time" },
                        duration: { type: "integer" },
                        playDuration: { type: "integer" },
                        watched: { type: "boolean" },
                        completed: { type: "boolean" },
                        platform: { type: "string", nullable: true },
                        player: { type: "string", nullable: true },
                        device: { type: "string", nullable: true },
                        playMethod: { type: "string", nullable: true },
                      },
                    },
                  },
                  firstStartedAt: { type: "string", format: "date-time" },
                  lastStartedAt: { type: "string", format: "date-time" },
                },
              },
            },
          },
        },
        "400": { description: "Invalid id" },
        "404": { description: "Unknown id, or a play outside the caller's linked media-server users" },
        "429": { description: "Rate limited (120/min per user, shared with GET /play-history/mine)", headers: RETRY_AFTER_HEADER },
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
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["linked", "stats"],
                properties: {
                  linked: { type: "boolean" },
                  stats: {
                    type: "object",
                    nullable: true,
                    description: "null when linked is false",
                    properties: {
                      timeZone: { type: "string", description: "The IANA zone the day and hour buckets are in (the statsTimeZone setting, else the server's own zone)" },
                      totalPlays: { type: "integer" },
                      totalWatchTimeHours: { type: "number" },
                      avgSessionDuration: { type: "integer", description: "Seconds" },
                      lastActiveIso: { type: "string", format: "date-time", nullable: true },
                      activityCalendar: playCountRows("day", { type: "string", format: "date" }),
                      playsByDay: {
                        type: "array",
                        description: "The last 91 days, zero-filled",
                        items: {
                          type: "object",
                          required: ["day", "count", "hours"],
                          properties: { day: { type: "string", format: "date" }, count: { type: "integer" }, hours: { type: "number" } },
                        },
                      },
                      userHeatmap: {
                        type: "array",
                        items: {
                          type: "object",
                          required: ["dow", "hour", "count"],
                          properties: { dow: { type: "integer", minimum: 0, maximum: 6 }, hour: { type: "integer", minimum: 0, maximum: 23 }, count: { type: "integer" } },
                        },
                      },
                      platformBreakdown: playCountRows("platform"),
                      deviceList: playCountRows("device"),
                      topMedia: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            title: { type: "string" },
                            tmdbId: { type: "integer", nullable: true },
                            mediaType: { type: "string", nullable: true },
                            count: { type: "integer" },
                            posterPath: { type: "string", nullable: true, description: "A raw TMDB path, not a URL" },
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
        "429": { description: "Rate limited (30/min per user)", headers: RETRY_AFTER_HEADER },
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
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["linked", "years", "year", "data"],
                properties: {
                  linked: { type: "boolean" },
                  years: { type: "array", items: { type: "integer" }, description: "Years with a watched play, newest first" },
                  year: { type: "integer", nullable: true },
                  data: {
                    type: "object",
                    nullable: true,
                    properties: {
                      timeZone: { type: "string", description: "The IANA zone the day and hour buckets are in (the statsTimeZone setting, else the server's own zone)" },
                      year: { type: "integer" },
                      isCurrentYear: { type: "boolean", description: "Decided by the server's clock" },
                      totals: {
                        type: "object",
                        properties: { plays: { type: "integer" }, hours: { type: "number" }, titles: { type: "integer" } },
                      },
                      movies: { type: "object", properties: { titles: { type: "integer" }, hours: { type: "number" } } },
                      tv: { type: "object", properties: { shows: { type: "integer" }, episodes: { type: "integer" }, hours: { type: "number" } } },
                      topTitles: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            title: { type: "string" },
                            tmdbId: { type: "integer", nullable: true },
                            mediaType: { type: "string", nullable: true },
                            count: { type: "integer" },
                            hours: { type: "number" },
                            posterPath: { type: "string", nullable: true },
                          },
                        },
                      },
                      biggestDay: {
                        type: "object",
                        nullable: true,
                        properties: { day: { type: "string", format: "date" }, plays: { type: "integer" }, hours: { type: "number" } },
                      },
                      busiestMonth: { type: "object", nullable: true, properties: { month: { type: "string" }, plays: { type: "integer" } } },
                      primeDow: { type: "integer", nullable: true, minimum: 0, maximum: 6, description: "Day of week, 0 = Sunday" },
                      primeHour: { type: "integer", nullable: true, minimum: 0, maximum: 23 },
                      longestSitting: {
                        type: "object",
                        nullable: true,
                        properties: {
                          title: { type: "string" },
                          tmdbId: { type: "integer", nullable: true },
                          mediaType: { type: "string", nullable: true },
                          seconds: { type: "integer" },
                          startedAt: { type: "string", format: "date-time" },
                          posterPath: { type: "string", nullable: true },
                        },
                      },
                      completion: { type: "object", properties: { watched: { type: "integer" }, total: { type: "integer" } } },
                      topPlatform: { type: "string", nullable: true },
                      topDevice: { type: "string", nullable: true },
                    },
                  },
                },
              },
            },
          },
        },
        "429": { description: "Rate limited (30/min per user)", headers: RETRY_AFTER_HEADER },
      },
    },
  },
  "/play-history/stats": {
    get: {
      tags: ["Play History"],
      summary: "Play history statistics (ADMIN)",
      parameters: [
        { name: "days", in: "query", schema: { type: "integer" }, description: "Window in days; clamped server-side (parseActivityDays)" },
        { name: "source", in: "query", schema: { type: "string", enum: ["plex", "jellyfin"] }, description: "Other values are ignored" },
        { name: "mediaType", in: "query", schema: { $ref: "#/components/schemas/MediaType" }, description: "Other values are ignored" },
      ],
      responses: {
        "200": {
          description: "Aggregate stats (total runtime, titles, etc.)",
          content: {
            "application/json": {
              schema: {
                type: "object",
                description: "PlayHistoryStatsResult (src/lib/play-history.ts) for the window",
                properties: {
                  timeZone: { type: "string", description: "The IANA zone the day and hour buckets are in (the statsTimeZone setting, else the server's own zone)" },
                  totalPlays: { type: "integer" },
                  totalWatchTimeHours: { type: "number" },
                  playsByDay: playCountRows("day", { type: "string", format: "date" }),
                  topUsers: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: { id: { type: "string", description: "MediaServerUser id" }, username: { type: "string" }, source: { type: "string" }, count: { type: "integer" } },
                    },
                  },
                  topMedia: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: { title: { type: "string" }, tmdbId: { type: "integer", nullable: true }, mediaType: { type: "string", nullable: true }, count: { type: "integer" } },
                    },
                  },
                  transcodeRatio: playCountRows("method"),
                  playsByPlatform: playCountRows("platform"),
                  playsByHour: playCountRows("hour", { type: "integer" }),
                  mediaTypeBreakdown: playCountRows("type"),
                  watchTimeByDay: {
                    type: "array",
                    items: { type: "object", properties: { day: { type: "string", format: "date" }, hours: { type: "number" } } },
                  },
                  heatmap: {
                    type: "array",
                    items: { type: "object", properties: { dow: { type: "integer" }, hour: { type: "integer" }, count: { type: "integer" } } },
                  },
                  completionRate: { type: "number" },
                  completionBuckets: playCountRows("bucket"),
                  avgBitrateMbps: { type: "number" },
                  totalBandwidthGB: { type: "number" },
                  bandwidthByDay: {
                    type: "array",
                    items: { type: "object", properties: { day: { type: "string", format: "date" }, gb: { type: "number" } } },
                  },
                  uniqueViewers: { type: "integer" },
                  uniqueTitles: { type: "integer", description: "Distinct (tmdbId, mediaType) pairs" },
                  rewatchPlays: { type: "integer" },
                  rewatchRate: { type: "number", description: "Share of the window's watched plays that were rewatches, 0–100" },
                  avgSessionMinutes: { type: "number" },
                  longestSessionMinutes: { type: "number" },
                  pauseRatio: { type: "number" },
                  peakConcurrent: { type: "integer" },
                  uniqueViewersByDay: playCountRows("day", { type: "string", format: "date" }),
                  playsByDow: playCountRows("dow", { type: "integer" }),
                  resolutionBreakdown: playCountRows("bucket"),
                  videoCodecBreakdown: playCountRows("codec"),
                  audioCodecBreakdown: playCountRows("codec"),
                  containerBreakdown: playCountRows("container"),
                  bitrateBuckets: playCountRows("bucket"),
                  transcodeReasons: playCountRows("reason"),
                  topDevices: playCountRows("device"),
                  topPlayers: playCountRows("player"),
                  sourceSplit: playCountRows("source"),
                  decadeBreakdown: playCountRows("decade"),
                  topRewatched: PLAY_TOP_TITLE_ROWS,
                  topWatched: PLAY_TOP_TITLE_ROWS,
                  topEpisodes: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        tmdbId: { type: "integer", nullable: true },
                        title: { type: "string" },
                        season: { type: "integer", nullable: true },
                        episode: { type: "integer", nullable: true },
                        episodeTitle: { type: "string", nullable: true },
                        count: { type: "integer" },
                      },
                    },
                  },
                  prevPeriod: {
                    type: "object",
                    properties: {
                      totalPlays: { type: "integer" },
                      totalWatchTimeHours: { type: "number" },
                      uniqueViewers: { type: "integer" },
                      complete: { type: "boolean", description: "False when history doesn't reach back across the whole previous window — show no period-over-period delta then (guardrail 19d)" },
                    },
                  },
                },
              },
            },
          },
        },
        "403": { description: "Forbidden — ADMIN only" },
      },
    },
  },
  "/play-history/export": {
    get: {
      tags: ["Play History"],
      summary: "Export play history as CSV or JSON (ADMIN)",
      description: "Takes the same filter parameters as GET /play-history (source, mediaType, watched, userId, tmdbId, playMethod, platform, startDate, endDate, fromDay, toDay, search). Audited.",
      parameters: [
        { name: "format", in: "query", schema: { type: "string", enum: ["csv", "json"], default: "csv" } },
        ...PLAY_HISTORY_FILTER_PARAMS,
      ],
      responses: {
        "200": {
          description: "CSV (default) or JSON file download",
          headers: { "X-Export-Truncated": { description: "format=json: \"true\" when more than the maximum matched and the list was cut", schema: { type: "string", enum: ["true", "false"] } }, "X-Export-Max-Rows": { description: "format=json: the maximum, as an integer string", schema: { type: "string" } } },
          content: {
            "text/csv": {
              schema: {
                type: "string",
                description: "A header row, then one row per play, newest first, at most 10,000; only when more than 10,000 rows match, a last one-field row says the export was cut and to narrow the dates",
              },
            },
            "application/json": {
              schema: {
                type: "array",
                maxItems: 10000,
                description: "format=json: one object per play, newest first (id breaks a tie on startedAt)",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    title: { type: "string" },
                    mediaType: { type: "string", enum: ["MOVIE", "TV", null], nullable: true },
                    year: { type: "string", nullable: true },
                    seasonNumber: { type: "integer", nullable: true },
                    episodeNumber: { type: "integer", nullable: true },
                    episodeTitle: { type: "string", nullable: true },
                    username: { type: "string", nullable: true },
                    source: { type: "string" },
                    startedAt: { type: "string", format: "date-time" },
                    stoppedAt: { type: "string", format: "date-time" },
                    duration: { type: "integer" },
                    playDuration: { type: "integer" },
                    pausedDuration: { type: "integer" },
                    watched: { type: "boolean" },
                    platform: { type: "string", nullable: true },
                    player: { type: "string", nullable: true },
                    device: { type: "string", nullable: true },
                    playMethod: { type: "string", nullable: true },
                    videoCodec: { type: "string", nullable: true },
                    audioCodec: { type: "string", nullable: true },
                    resolution: { type: "string", nullable: true },
                    bitrateKbps: { type: "number", nullable: true, description: "Normalized to kbps by source (guardrail 19a); null when unknown" },
                    videoDecision: { type: "string", nullable: true },
                    audioDecision: { type: "string", nullable: true },
                    container: { type: "string", nullable: true },
                  },
                },
              },
            },
          },
        },
        "400": { description: "An unparseable startDate, endDate, fromDay or toDay (`error` names it)" },
        "403": { description: "Forbidden — ADMIN only" },
        "429": { description: "Rate limited (5 exports per hour per admin)" },
        "500": { description: "{ error } — the export's audit row could not be written; nothing was exported" },
      },
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
              schema: {
                type: "object",
                description: "Full PlayHistory row plus mediaServerUser { id, username, source, thumbUrl }",
                properties: {
                  ...PLAY_HISTORY_ROW_FIELDS,
                  mediaServerUser: {
                    type: "object",
                    required: ["id", "username", "source", "thumbUrl"],
                    properties: { id: { type: "string" }, username: { type: "string" }, source: { type: "string" }, thumbUrl: { type: "string", nullable: true } },
                  },
                },
              },
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
        "429": { description: "Rate limited" },
      },
    },
  },
  "/play-history/calendar": {
    get: {
      tags: ["Play History"],
      summary: "365-day activity heatmap data (ADMIN)",
      description: "One row per UTC day with a watched-session count. Unrecognized `source` / `mediaType` values are ignored (the heatmap is then unfiltered).",
      parameters: [
        { name: "source", in: "query", schema: { type: "string", enum: ["plex", "jellyfin"] } },
        { name: "mediaType", in: "query", schema: { type: "string", enum: ["MOVIE", "TV"] } },
      ],
      responses: {
        "200": { description: "Array of { day: \"YYYY-MM-DD\", count }", content: { "application/json": { schema: { type: "array", items: { type: "object", properties: { day: { type: "string", format: "date" }, count: { type: "integer" } } } } } } },
        "403": { description: "Forbidden — ADMIN only" },
      },
    },
  },
  "/play-history/transcode-offenders": {
    get: {
      tags: ["Play History"],
      summary: "Titles/users driving the most transcodes (ADMIN)",
      description: "Top 6 users and top 6 titles forcing server-side transcodes in the window. Unrecognized `source` / `mediaType` values are ignored.",
      parameters: [
        { name: "days", in: "query", schema: { type: "integer", default: 30, minimum: 1, maximum: 3650 }, description: "Window in days; clamped, a non-number means 30" },
        { name: "source", in: "query", schema: { type: "string", enum: ["plex", "jellyfin"] } },
        { name: "mediaType", in: "query", schema: { type: "string", enum: ["MOVIE", "TV"] } },
      ],
      responses: {
        "200": {
          description: "{ topUsers: [{ id (MediaServerUser id), username, source, count }], topTitles: [{ title, tmdbId, mediaType, count }] }",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["topUsers", "topTitles"],
                properties: {
                  topUsers: {
                    type: "array",
                    maxItems: 6,
                    items: {
                      type: "object",
                      required: ["id", "username", "source", "count"],
                      properties: {
                        id: { type: "string", description: "The MediaServerUser id — usernames are not unique" },
                        username: { type: "string" },
                        source: { type: "string" },
                        count: { type: "integer" },
                      },
                    },
                  },
                  topTitles: {
                    type: "array",
                    maxItems: 6,
                    items: {
                      type: "object",
                      required: ["title", "tmdbId", "mediaType", "count"],
                      properties: { title: { type: "string" }, tmdbId: { type: "integer", nullable: true }, mediaType: { type: "string", nullable: true }, count: { type: "integer" } },
                    },
                  },
                },
              },
            },
          },
        },
        "403": { description: "Forbidden — ADMIN only" },
      },
    },
  },
  "/play-history/users": {
    get: {
      tags: ["Play History"],
      summary: "Every media-server user's activity, with whether they are still on the server (ADMIN)",
      description: "The admin Activity users list for a native client (API v6): one row per media-server user, most plays first, unpaged — the client filters, searches and sorts. `onServer` is read live per server (a Plex server's share list, a Jellyfin server's users) and falls back to the stored flag for a server that can't be read.",
      responses: {
        "200": {
          description: "{ users: [...], truncated }",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["users", "truncated"],
                properties: {
                  users: {
                    type: "array",
                    maxItems: 10000,
                    items: {
                      type: "object",
                      required: ["id", "username", "source", "serverInstance", "thumbUrl", "plays", "hours", "lastActive", "favPlatform", "directPct", "transcodePct", "onServer"],
                      properties: {
                        id: { type: "string", description: "The MediaServerUser id — usernames are not unique" },
                        username: { type: "string" },
                        source: { type: "string", description: "plex | jellyfin" },
                        serverInstance: { type: "string", description: "The server's instance slug; \"\" is the default server" },
                        thumbUrl: { type: "string", nullable: true },
                        plays: { type: "integer", description: "Watched plays" },
                        hours: { type: "number", description: "Watch time in hours, one decimal" },
                        lastActive: { type: "string", format: "date-time", nullable: true, description: "Start of the latest play; null for a user with none" },
                        favPlatform: { type: "string", nullable: true },
                        directPct: { type: "integer", nullable: true, description: "Share of all the user's plays that were direct plays; null for a user with no plays" },
                        transcodePct: { type: "integer", nullable: true, description: "Share of all the user's plays that were transcoded; null for a user with no plays" },
                        onServer: { type: "boolean", description: "Still on their server (the page's Active filter); false = removed" },
                      },
                    },
                  },
                  truncated: { type: "boolean", description: "The list was cut at 10,000 rows" },
                },
              },
            },
          },
        },
        "403": { description: "Forbidden — ADMIN only" },
      },
    },
  },
  "/play-history/sessions": {
    get: {
      tags: ["Sessions"],
      summary: "List active playback sessions (ADMIN)",
      responses: {
        "200": {
          description: "Active ActiveSession rows ordered by start time",
          content: {
            "application/json": {
              schema: {
                type: "array",
                description: "Newest first. Every ActiveSession column; the BigInt ones (progressMs, startProgressMs, playtimeMs, durationMs) as numbers",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    source: { type: "string", description: "plex | jellyfin" },
                    serverInstance: { type: "string" },
                    sessionKey: { type: "string" },
                    startedAt: { type: "string", format: "date-time" },
                    lastSeenAt: { type: "string", format: "date-time" },
                    state: { type: "string", description: "playing | paused | buffering" },
                    mediaServerUserId: { type: "string" },
                    serverUsername: { type: "string" },
                    tmdbId: { type: "integer", nullable: true },
                    mediaType: { type: "string", nullable: true },
                    title: { type: "string" },
                    year: { type: "string", nullable: true },
                    seasonNumber: { type: "integer", nullable: true },
                    episodeNumber: { type: "integer", nullable: true },
                    episodeTitle: { type: "string", nullable: true },
                    sourceItemId: { type: "string", nullable: true },
                    sourceShowId: { type: "string", nullable: true },
                    posterPath: { type: "string", nullable: true },
                    progressPercent: { type: "number" },
                    progressMs: { type: "integer" },
                    startProgressMs: { type: "integer" },
                    progressUpdatedAt: { type: "string", format: "date-time" },
                    playtimeMs: { type: "integer" },
                    durationMs: { type: "integer" },
                    platform: { type: "string", nullable: true },
                    player: { type: "string", nullable: true },
                    device: { type: "string", nullable: true },
                    ipAddress: { type: "string", nullable: true },
                    playMethod: { type: "string", nullable: true },
                    videoCodec: { type: "string", nullable: true },
                    audioCodec: { type: "string", nullable: true },
                    resolution: { type: "string", nullable: true },
                    bitrate: { type: "integer", nullable: true },
                    videoDecision: { type: "string", nullable: true },
                    audioDecision: { type: "string", nullable: true },
                    container: { type: "string", nullable: true },
                    transcodeReason: { type: "string", nullable: true },
                    location: { type: "string", nullable: true },
                    bandwidth: { type: "integer", nullable: true },
                    secure: { type: "boolean", nullable: true },
                    relayed: { type: "boolean", nullable: true },
                    introStartMs: { type: "integer", nullable: true },
                    introEndMs: { type: "integer", nullable: true },
                    creditsStartMs: { type: "integer", nullable: true },
                    creditsEndMs: { type: "integer", nullable: true },
                  },
                },
              },
            },
          },
        },
        "403": { description: "Forbidden" },
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
                    ...AUTH_SESSION_ROW_FIELDS,
                    isCurrent: { type: "boolean", description: "The session this request was made with" },
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
                confirmPassword: { type: "string", description: "Step-up re-authentication, required to revoke a session other than the caller's own, for accounts with a local password. SSO accounts (no password) instead need the caller's own session to have been created within the last 5 minutes." },
              },
            },
          },
        },
      },
      responses: {
        "200": { description: "Session revoked — { ok: true }", content: { "application/json": { schema: OK_TRUE } } },
        "400": { description: "sessionId missing or not a string" },
        "401": STEP_UP_401,
        "404": { description: "No such session for this user" },
        "413": tooLargeAnswer(16 * 1024),
        "429": { description: "Rate limited (10 revokes/min per user): { error: \"rate_limit\", message }" },
        "500": { description: "The revocation did not commit" },
      },
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
        "200": { description: "Sessions revoked", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" }, count: { type: "integer", description: "AuthSession rows deleted" }, includeCurrent: { type: "boolean" } } } } } },
        "401": STEP_UP_401,
        "413": tooLargeAnswer(16 * 1024),
        "429": { description: "Rate limited — 5/hour per user. Body is { error: \"rate_limit\", message }" },
      },
    },
  },
};
