// Deletion votes, the personal watchlist and hidden titles, and the in-app notification inbox.

import { tooLargeAnswer, RETRY_AFTER_HEADER, OK_TRUE } from "../shared";
import type { OpenApiSchema, OpenApiPaths } from "../types";

// A watchlist or hidden-title row (WATCHLIST_ITEM_SELECT, src/lib/watchlist-add.ts,
// and the hidden route's SELECT — the same five columns).
const LIST_ITEM = {
  type: "object",
  properties: {
    tmdbId: { type: "integer" },
    mediaType: { $ref: "#/components/schemas/MediaType" },
    title: { type: "string" },
    posterPath: { type: "string", nullable: true },
    createdAt: { type: "string", format: "date-time" },
  },
} satisfies OpenApiSchema;

// POST/DELETE /notifications: marked read or deleted, and the caller's unread
// count after the change.
const NOTIFICATION_UNREAD_ACK = {
  type: "object",
  required: ["ok", "unreadCount"],
  properties: { ok: { type: "boolean", enum: [true] }, unreadCount: { type: "integer", minimum: 0 } },
} satisfies OpenApiSchema;

export const listsPaths: OpenApiPaths = {
  "/votes": {
    get: {
      tags: ["Votes"],
      summary: "List deletion vote items",
      parameters: [
        { name: "page", in: "query", schema: { type: "integer", default: 1, minimum: 1, maximum: 10000 } },
        {
          name: "mine", in: "query", schema: { type: "string", enum: ["1"] },
          description:
            "Set to the literal string 1 to show only items the caller has voted on. Any other value — INCLUDING the OpenAPI-canonical `true` — is ignored and returns the unfiltered list.",
        },
        {
          name: "sort", in: "query", schema: { type: "string", enum: ["votes", "recent"], default: "votes" },
          description: "`votes` orders by vote count desc, `recent` by most-recent vote desc; both tie-break on tmdbId asc. An unrecognized value falls back to `votes`.",
        },
        { name: "q", in: "query", schema: { type: "string" }, description: "Case-insensitive substring match on title" },
      ],
      responses: {
        "200": {
          description: "Paginated vote items — pageSize is fixed at 40 and is not a parameter",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/PaginatedMeta" },
                  {
                    type: "object",
                    properties: {
                      items: {
                        type: "array",
                        items: {
                          type: "object",
                          required: ["tmdbId", "mediaType", "title", "posterPath", "voteCount", "userVoted", "userReason", "reasons", "reasonEntries"],
                          properties: {
                            tmdbId: { type: "integer" },
                            mediaType: { $ref: "#/components/schemas/MediaType" },
                            title: { type: "string" },
                            posterPath: { type: "string", nullable: true },
                            voteCount: { type: "integer", description: "Every voter's vote on the title, whatever the filter" },
                            userVoted: { type: "boolean" },
                            userReason: { type: "string", nullable: true, description: "The caller's own reason" },
                            reasons: { type: "array", maxItems: 3, items: { type: "string" }, description: "Up to 3 recent distinct reasons from OTHER voters (no names)" },
                            reasonEntries: {
                              type: "array",
                              maxItems: 3,
                              description: "The same reasons in the same order, each with the id of the vote it came from — what POST /report `vote_reason` takes",
                              items: { type: "object", required: ["id", "reason"], properties: { id: { type: "string" }, reason: { type: "string" } } },
                            },
                          },
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "403": { description: "Deletion voting (feature.page.votes) is disabled" },
        "429": { description: "Rate limited (30 req/min per user)", headers: RETRY_AFTER_HEADER },
      },
    },
    post: {
      tags: ["Votes"],
      summary: "Submit a deletion vote",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["tmdbId", "mediaType", "_token"],
              properties: {
                tmdbId: { type: "integer", minimum: 1 },
                mediaType: { $ref: "#/components/schemas/MediaType" },
                reason: { type: "string", maxLength: 200 },
                _token: { type: "string", description: "Request token bound to tmdbId + mediaType + the calling user" },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Vote recorded — the body is the created DeletionVote row, not an empty ack",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["id", "createdAt", "tmdbId", "mediaType", "title", "posterPath", "userId", "reason"],
                properties: {
                  id: { type: "string", description: "The DeletionVote id — what POST /report `vote_reason` takes" },
                  createdAt: { type: "string", format: "date-time" },
                  tmdbId: { type: "integer" },
                  mediaType: { $ref: "#/components/schemas/MediaType" },
                  title: { type: "string", description: "As TMDB verified it" },
                  posterPath: { type: "string", nullable: true },
                  userId: { type: "string", description: "The caller" },
                  reason: { type: "string", nullable: true },
                },
              },
            },
          },
        },
        "400": { description: "Malformed JSON, or an invalid tmdbId / mediaType / reason" },
        "403": { description: "Deletion voting disabled, an invalid _token, or the caller has previously requested this title" },
        "409": { description: "Already voted — unique violation on (tmdbId, mediaType, userId)" },
        "413": tooLargeAnswer(16 * 1024),
        "422": { description: "TMDB could not verify the title, or it is in no library visible to this voter" },
        "429": { description: "Rate limited (rateLimitRequests setting, default 20/min per user)", headers: RETRY_AFTER_HEADER },
        "503": { description: "Maintenance mode (non-ADMIN callers)" },
      },
    },
  },
  "/votes/{tmdbId}": {
    patch: {
      tags: ["Votes"],
      summary: "Dismiss all deletion votes for a title (ADMIN)",
      description:
        "Deletes every DeletionVote for the title and clears the one-shot deletionVoteNotified setting key in one transaction, so the threshold notification can re-arm. Note the sibling DELETE on this path is withAuth (retract your own vote), not ADMIN.",
      parameters: [
        { name: "tmdbId", in: "path", required: true, schema: { type: "integer" } },
        { name: "mediaType", in: "query", required: true, schema: { $ref: "#/components/schemas/MediaType" } },
      ],
      responses: {
        "200": {
          description: "Votes dismissed",
          content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" }, dismissed: { type: "integer" } } } } },
        },
        "400": { description: "Invalid tmdbId or mediaType" },
        "403": { description: "Forbidden — ADMIN only" },
        "429": { description: "Rate limited (10/min per admin)" },
        "503": { description: "Maintenance mode" },
      },
    },
    delete: {
      tags: ["Votes"],
      summary: "Retract own vote",
      parameters: [
        { name: "tmdbId", in: "path", required: true, schema: { type: "integer" } },
        { name: "mediaType", in: "query", required: true, schema: { $ref: "#/components/schemas/MediaType" } },
      ],
      responses: {
        "200": { description: "Vote retracted", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" } } } } } },
        "400": { description: "Invalid tmdbId or mediaType" },
        "403": { description: "Deletion voting is disabled" },
        "404": { description: "The caller has no vote on this title" },
        "429": { description: "Rate limited (60/min per user)", headers: RETRY_AFTER_HEADER },
        "503": { description: "Maintenance mode (non-ADMIN callers)" },
      },
    },
  },
  "/watchlist": {
    get: {
      tags: ["Lists"],
      summary: "List the caller's watchlist",
      parameters: [
        { name: "page", in: "query", schema: { type: "integer", default: 1 } },
        { name: "type", in: "query", schema: { $ref: "#/components/schemas/MediaType" }, description: "Filter by media type; any other value is ignored" },
        { name: "q", in: "query", schema: { type: "string" }, description: "Case-insensitive substring match on the title (wildcard characters stripped)" },
      ],
      responses: {
        "200": {
          description: "Paginated watchlist items, newest first, 60 per page",
          content: { "application/json": { schema: { allOf: [{ $ref: "#/components/schemas/PaginatedMeta" }, { type: "object", properties: { items: { type: "array", items: LIST_ITEM } } }] } } },
        },
        "429": { description: "Rate limited (60/min)" },
      },
    },
    post: {
      tags: ["Lists"],
      summary: "Add a title to the caller's watchlist",
      description:
        "When watchlist auto-request applies (feature.behavior.watchlistAutoRequest on and the caller holds an AUTO_REQUEST* bit for the media type), the add also files a request through the same path as POST /requests. A refusal never fails the add: the 201 body then carries an additive `autoRequest` object. The field is absent whenever auto-request does not apply.",
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["tmdbId", "mediaType"], properties: { tmdbId: { type: "integer" }, mediaType: { $ref: "#/components/schemas/MediaType" } } } } } },
      responses: {
        "201": {
          description: "Added",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  tmdbId: { type: "integer" },
                  mediaType: { $ref: "#/components/schemas/MediaType" },
                  title: { type: "string" },
                  posterPath: { type: "string", nullable: true },
                  createdAt: { type: "string", format: "date-time" },
                  autoRequest: {
                    type: "object",
                    description: "Present only when auto-request applied to this add",
                    properties: {
                      outcome: {
                        type: "string",
                        description: "requested | already-available | already-requested | quota | blacklisted | permanently-declined | rating-cap | forbidden | instance-unavailable | tmdb-unverified | invalid-quality-profile | invalid-note | arr-unreachable | discord-link-required | rate-limited | maintenance | error",
                      },
                      requested: { type: "boolean" },
                      status: { type: "string", nullable: true, description: "The filed request's status when one was filed" },
                      message: { type: "string", description: "Short user-facing explanation" },
                    },
                  },
                },
              },
            },
          },
        },
        "400": { description: "tmdbId or mediaType missing or invalid" },
        "409": { description: "Already on watchlist" },
        "413": tooLargeAnswer(16 * 1024),
        "422": { description: "Could not verify media with TMDB" },
        "429": { description: "Rate limited" },
      },
    },
    delete: {
      tags: ["Lists"],
      summary: "Remove a title from the caller's watchlist",
      parameters: [
        { name: "tmdbId", in: "query", required: true, schema: { type: "integer" } },
        { name: "mediaType", in: "query", required: true, schema: { $ref: "#/components/schemas/MediaType" } },
      ],
      responses: {
        "200": { description: "{ ok: true } — removed, or it was not there (idempotent)", content: { "application/json": { schema: OK_TRUE } } },
        "400": { description: "tmdbId or mediaType missing or invalid" },
        "429": { description: "Rate limited (60/min)" },
      },
    },
  },
  "/hidden": {
    get: {
      tags: ["Lists"],
      summary: "List the caller's hidden (\"not interested\") titles",
      parameters: [{ name: "page", in: "query", schema: { type: "integer", default: 1 } }],
      responses: {
        "200": {
          description: "Paginated hidden items, newest first, 60 per page",
          content: { "application/json": { schema: { allOf: [{ $ref: "#/components/schemas/PaginatedMeta" }, { type: "object", properties: { items: { type: "array", items: LIST_ITEM } } }] } } },
        },
        "429": { description: "Rate limited (60/min)" },
      },
    },
    post: {
      tags: ["Lists"],
      summary: "Hide a title from the caller's discovery",
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["tmdbId", "mediaType"], properties: { tmdbId: { type: "integer" }, mediaType: { $ref: "#/components/schemas/MediaType" }, title: { type: "string", maxLength: 500, description: "Optional; cut to 500 characters. Not verified against TMDB" }, posterPath: { type: "string", nullable: true, maxLength: 500, description: "Stored only when 1–500 characters, else null" } } } } } },
      responses: { "201": { description: "Hidden — { tmdbId, mediaType, title, posterPath, createdAt }", content: { "application/json": { schema: LIST_ITEM } } }, "400": { description: "tmdbId or mediaType missing or invalid" }, "409": { description: "Already hidden" }, "413": tooLargeAnswer(16 * 1024), "429": { description: "Rate limited (60/min)" } },
    },
    delete: {
      tags: ["Lists"],
      summary: "Un-hide a title",
      parameters: [
        { name: "tmdbId", in: "query", required: true, schema: { type: "integer" } },
        { name: "mediaType", in: "query", required: true, schema: { $ref: "#/components/schemas/MediaType" } },
      ],
      responses: { "200": { description: "{ ok: true } — un-hidden, or it was not hidden (idempotent)", content: { "application/json": { schema: OK_TRUE } } }, "400": { description: "tmdbId or mediaType missing or invalid" }, "429": { description: "Rate limited (60/min)" } },
    },
  },
  "/notifications": {
    get: {
      tags: ["Notifications"],
      summary: "List the caller's in-app notifications + unread count",
      description: "Newest first, 30 per page, keyset-paged: pass the previous response's `nextCursor` as `cursor`. An absent or malformed cursor reads the first page. `title`/`body` are rendered in the caller's language (native clients get the instance default). 120 reads per minute per user.",
      parameters: [
        { name: "cursor", in: "query", schema: { type: "string" }, description: "Opaque `<createdAt-iso>|<id>` from the previous page's `nextCursor`" },
      ],
      responses: {
        "200": {
          description: "One page of notifications, the unread count and the caller's total",
          content: { "application/json": { schema: { type: "object", properties: {
            items: { type: "array", items: { type: "object", properties: {
              id: { type: "string" },
              type: { type: "string", description: "REQUEST_APPROVED | REQUEST_AVAILABLE | REQUEST_DECLINED | … (additive set)" },
              title: { type: "string", description: "Rendered in the caller's language" },
              body: { type: "string", description: "Rendered in the caller's language" },
              tmdbId: { type: "integer", nullable: true },
              mediaType: { type: "string", enum: ["MOVIE", "TV", null], nullable: true, description: "Null when the notification is about no title" },
              posterPath: { type: "string", nullable: true },
              readAt: { type: "string", format: "date-time", nullable: true },
              createdAt: { type: "string", format: "date-time" },
            } } },
            unreadCount: { type: "integer" },
            total: { type: "integer" },
            nextCursor: { type: "string", nullable: true, description: "Null when the page was not full" },
            pageSize: { type: "integer", example: 30 },
          } } } },
        },
        "429": { description: "Rate limited", headers: RETRY_AFTER_HEADER },
      },
    },
    post: {
      tags: ["Notifications"],
      summary: "Mark notifications read (specific ids, or all unread when omitted)",
      description: "Non-string entries in `ids` are dropped and only the first 500 ids are used; the rest are ignored.",
      requestBody: {
        required: false,
        content: { "application/json": { schema: { type: "object", properties: { ids: { type: "array", items: { type: "string" }, description: "Only the first 500 are used" } } } } },
      },
      responses: {
        "200": { description: "{ ok, unreadCount }", content: { "application/json": { schema: NOTIFICATION_UNREAD_ACK } } },
        "400": { description: "`ids` is present but not an array (never coerced to \"all\")" },
        "413": tooLargeAnswer(16 * 1024),
        "429": { description: "Rate limited (60/min)", headers: RETRY_AFTER_HEADER },
      },
    },
    delete: {
      tags: ["Notifications"],
      summary: "Delete notifications (specific ids via ?ids=, or all via ?all=1)",
      description:
        "Selection is by QUERY PARAMETER, never the body (DELETE bodies are stripped by some proxies). A request with neither `ids` nor `all=1` is a 400, never a wipe.",
      parameters: [
        { name: "ids", in: "query", schema: { type: "string" }, description: "Comma-separated notification ids (max 500)" },
        { name: "all", in: "query", schema: { type: "string", enum: ["1"] }, description: "Set to 1 to clear every notification" },
      ],
      responses: {
        "200": { description: "{ ok, unreadCount }", content: { "application/json": { schema: NOTIFICATION_UNREAD_ACK } } },
        "400": { description: "Neither ids nor all=1 supplied" },
        "429": { description: "Rate limited (60/min)", headers: RETRY_AFTER_HEADER },
      },
    },
  },
};
