// User management, media-server identity links and request watch grades.

import { NOTIFICATION_PREF_FLAGS, tooLargeAnswer, AUTH_SESSION_ROW_FIELDS, OK_TRUE, RETRY_AFTER_HEADER } from "../shared";
import type { OpenApiSchema, OpenApiPaths } from "../types";

// One row of GET /admin/users — and POST /admin/users' 201, which answers the
// same shape (serializeUser in src/app/api/admin/users/route.ts).
const ADMIN_USER_ITEM = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string", nullable: true },
    email: { type: "string", nullable: true },
    role: { $ref: "#/components/schemas/UserRole" },
    createdAt: { type: "string", format: "date-time" },
    deactivatedAt: { type: "string", format: "date-time", nullable: true },
    purgedAt: { type: "string", format: "date-time", nullable: true },
    mediaServer: { type: "string", nullable: true },
    maxContentRating: { type: "string", nullable: true },
    source: { type: "string", description: "local | oidc | jellyfin | plex | discord (additive set)" },
    movieQuotaLimit: { type: "integer", nullable: true },
    movieQuotaDays: { type: "integer", nullable: true },
    tvQuotaLimit: { type: "integer", nullable: true },
    tvQuotaDays: { type: "integer", nullable: true },
    permissions: { type: "string", description: "Decimal bitmask" },
    ...NOTIFICATION_PREF_FLAGS,
    requestCount: { type: "integer" },
  },
} satisfies OpenApiSchema;

export const adminUsersPaths: OpenApiPaths = {
  "/admin/users": {
    get: {
      tags: ["Admin – Users"],
      summary: "List users (MANAGE_USERS)",
      description: "Up to 1000 users, ordered by name then email.",
      responses: { "200": { description: "User list", content: { "application/json": { schema: { type: "array", items: ADMIN_USER_ITEM } } } } },
    },
    post: {
      tags: ["Admin – Users"],
      summary: "Create a local-credentials user (MANAGE_USERS)",
      description: "Creating an ADMIN requires the caller to hold the ADMIN bit. An address in a domain Summonarr mints for itself (@jellyfin.local, @discord.local, @deleted.invalid) is refused for every caller. Rate-limited 10/min per caller. Body capped at 16 KB.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["email", "password"],
              properties: {
                email: { type: "string", format: "email" },
                password: { type: "string", minLength: 12 },
                name: { type: "string", nullable: true, maxLength: 100 },
                role: { $ref: "#/components/schemas/UserRole" },
              },
            },
          },
        },
      },
      responses: {
        "201": { description: "User created (same shape as a list item)", content: { "application/json": { schema: ADMIN_USER_ITEM } } },
        "400": { description: "Validation error, or a reserved email domain" },
        "403": { description: "Creating an ADMIN requires the ADMIN bit; a role whose permission preset the caller does not hold in full (a delegate can't grant beyond its own bits); or, for a caller without the ADMIN bit, an email that belongs to a Plex/Jellyfin server user" },
        "409": { description: "Email already in use" },
        "413": tooLargeAnswer(16 * 1024),
        "429": { description: "Rate limited (Retry-After set)", headers: RETRY_AFTER_HEADER },
      },
    },
  },
  "/admin/users/{id}": {
    patch: {
      tags: ["Admin – Users"],
      summary: "Update user settings (MANAGE_USERS)",
      description: "Conferring the ADMIN role, or editing an account that is already ADMIN, additionally requires the caller to hold ADMIN. ONE FIELD GROUP PER CALL: the handler applies only the first group present, in this order — mediaServer, maxContentRating, permissions, instanceGrants, mediaServerGrants, then the first quota* field, then the first notification flag, then role — and answers 200 with `{ id, <field>: <new value> }` (permissions as a decimal string). A body with none of them is 400. A non-ADMIN delegate may not edit its own limits/grants, may not touch an ADMIN account, and may only grant what it holds itself (403). Rate-limited 20/min per caller; body capped at 32 KB.",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                role: { $ref: "#/components/schemas/UserRole" },
                permissions: { type: "string", description: "Decimal-encoded capability bitmask (see src/lib/permissions.ts)" },
                movieQuotaLimit: { type: "integer", nullable: true },
                movieQuotaDays: { type: "integer", nullable: true },
                tvQuotaLimit: { type: "integer", nullable: true },
                tvQuotaDays: { type: "integer", nullable: true },
                mediaServer: { type: "string", enum: ["plex", "jellyfin", null], nullable: true },
                ...NOTIFICATION_PREF_FLAGS,
                maxContentRating: { type: "string", nullable: true, description: "Content-rating cap; null or empty clears it" },
                mediaServerGrants: {
                  type: "object",
                  nullable: true,
                  description: "Per-server library visibility for RESTRICTED Plex/Jellyfin instances: { plex: { <slug>: { view } }, jellyfin: { <slug>: { view } } }",
                  additionalProperties: { type: "object", additionalProperties: { type: "object", properties: { view: { type: "boolean" } } } },
                },
                instanceGrants: {
                  type: "object",
                  nullable: true,
                  description: "Per-instance grants for NAMED Radarr/Sonarr instances, keyed by slug",
                  additionalProperties: {
                    type: "object",
                    properties: { request: { type: "boolean" }, autoApprove: { type: "boolean" } },
                  },
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "The single field group that was applied, echoed with `id`",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["id"],
                description: "`id` plus exactly ONE of the other fields: the group that was applied, with its new value",
                properties: {
                  id: { type: "string" },
                  mediaServer: { type: "string", enum: ["plex", "jellyfin", null], nullable: true },
                  maxContentRating: { type: "string", nullable: true },
                  permissions: { type: "string", description: "Decimal bitmask" },
                  instanceGrants: {
                    type: "object",
                    description: "As stored: only slugs with a grant",
                    additionalProperties: { type: "object", properties: { request: { type: "boolean", enum: [true] }, autoApprove: { type: "boolean", enum: [true] } } },
                  },
                  mediaServerGrants: {
                    type: "object",
                    description: "As stored: { plex?: { <slug>: { view: true } }, jellyfin?: { … } }",
                    additionalProperties: { type: "object", additionalProperties: { type: "object", properties: { view: { type: "boolean", enum: [true] } } } },
                  },
                  movieQuotaLimit: { type: "integer", nullable: true },
                  movieQuotaDays: { type: "integer", nullable: true },
                  tvQuotaLimit: { type: "integer", nullable: true },
                  tvQuotaDays: { type: "integer", nullable: true },
                  ...NOTIFICATION_PREF_FLAGS,
                  role: { $ref: "#/components/schemas/UserRole" },
                },
              },
            },
          },
        },
        "400": { description: "Invalid value, no recognized field, own-role change, or a last-admin / promote-first rule" },
        "403": { description: "Forbidden (ADMIN-bit rule, own limits, or grant beyond the caller's own)" },
        "404": { description: "User not found" },
        "413": tooLargeAnswer(32 * 1024),
        "429": { description: "Rate limited (Retry-After set)", headers: RETRY_AFTER_HEADER },
      },
    },
    delete: {
      tags: ["Admin – Users"],
      summary: "Disable a user (MANAGE_USERS)",
      description:
        "Revokes every session and blocks sign-in. Reversible — nothing is scrubbed, the account's requests/issues/votes stay attached, and its Plex/Jellyfin link stays intact so play history keeps being attributed. Re-enable with POST /admin/users/{id}/reactivate; erase with POST /admin/users/{id}/purge.",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "200": { description: "User disabled ({ ok: true }; idempotent)", content: { "application/json": { schema: OK_TRUE } } },
        "400": { description: "Cannot disable the last admin, or the caller's own account" },
        "403": { description: "Forbidden (an ADMIN target needs the ADMIN bit)" },
        "404": { description: "User not found" },
        "429": { description: "Rate limited (Retry-After set)", headers: RETRY_AFTER_HEADER },
      },
    },
  },
  "/admin/users/{id}/reactivate": {
    post: {
      tags: ["Admin – Users"],
      summary: "Re-enable a disabled user (MANAGE_USERS)",
      description:
        "Clears the disabled flag so the account can sign in again. Prior sessions stay revoked — the user signs in fresh. Refused for a purged account, which has no identity left to sign in with.",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "200": { description: "User re-enabled (idempotent)", content: { "application/json": { schema: OK_TRUE } } },
        "400": { description: "Account was purged and cannot be re-enabled" },
        "403": { description: "Forbidden" },
        "404": { description: "User not found" },
        "409": { description: "Account state changed concurrently" },
        "429": { description: "Rate limited (Retry-After set)", headers: RETRY_AFTER_HEADER },
      },
    },
  },
  "/admin/users/{id}/purge": {
    post: {
      tags: ["Admin – Users"],
      summary: "IRREVERSIBLY scrub a disabled user's personal data (MANAGE_USERS)",
      description:
        "Anonymizes the account in place: name, email, password, image, Discord, notification email, provider-subject keys, OAuth rows, push subscriptions, watchlist/hidden/notifications, and the Plex/Jellyfin identity link. Requests, votes and issues survive on a de-identified row. Requires the account to be disabled first, and cannot be undone — this is the action that services a 'delete my data' request.",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "200": { description: "Personal data purged (idempotent)", content: { "application/json": { schema: OK_TRUE } } },
        "400": { description: "Account must be disabled before it can be purged" },
        "403": { description: "Forbidden (an ADMIN target needs the ADMIN bit)" },
        "404": { description: "User not found" },
        "429": { description: "Rate limited (Retry-After set)", headers: RETRY_AFTER_HEADER },
      },
    },
  },
  "/admin/users/{id}/mfa": {
    delete: {
      tags: ["Admin – Users"],
      summary: "Reset a user's two-factor authentication — lost device (MANAGE_USERS)",
      description:
        "Removes the user's authenticator app, every passkey and every recovery code, and signs the account out everywhere; their next sign-in is password-only. An ADMIN target needs the ADMIN bit. Refuses the caller's own account (use DELETE /profile/mfa with the password step-up).",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "200": { description: "Reset", content: { "application/json": { schema: OK_TRUE } } },
        "400": { description: "Own account" },
        "403": { description: "Forbidden" },
        "404": { description: "Not found" },
        "429": { description: "Rate limited (Retry-After set)", headers: RETRY_AFTER_HEADER },
      },
    },
  },
  "/admin/server-users/{id}": {
    patch: {
      tags: ["Admin – Users"],
      summary: "Link a media-server identity to an account, or set its download policy (MANAGE_USERS; linking needs the ADMIN bit)",
      description:
        "Two separate actions on one Plex/Jellyfin identity (a MediaServerUser row), one per call. `userId` attributes the " +
        "identity's watch history to that account (null unlinks) and pins the link, so automatic resolution leaves it " +
        "alone; `autoLink: true` hands it back to automatic resolution (guardrail 34). Linking needs the ADMIN bit " +
        "(guardrail 34d): a MANAGE_USERS caller gets 403 before the identity is read, and a body mixing a link with " +
        "`downloadsEnabled` is refused whole. A link is audited (SERVER_USER_LINK). `downloadsEnabled` sets a Jellyfin " +
        "user's download policy and pushes it to the server at once; a failed push still saves.",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" }, description: "MediaServerUser id" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              description: "One action: `userId`, `autoLink`, or `downloadsEnabled`",
              properties: {
                userId: { type: "string", nullable: true, description: "The account to attribute the identity's history to; null unlinks. ADMIN bit only." },
                autoLink: { type: "boolean", description: "`true`: return the identity to automatic linking. ADMIN bit only." },
                downloadsEnabled: { type: "boolean", description: "Jellyfin identities only" },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "{ ok: true } for a link; for the download policy also `pushed`, and a `warning` when the server didn't take it",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["ok"],
                properties: {
                  ok: { type: "boolean", enum: [true] },
                  pushed: { type: "boolean", description: "Download policy only: whether the media server took the change (it is saved either way)" },
                  warning: { type: "string", description: "Present when `pushed` is false" },
                },
              },
            },
          },
        },
        "400": {
          description:
            "No action, both `userId` and `autoLink`, a link combined with `downloadsEnabled`, an empty or purged `userId`, " +
            "a non-boolean `downloadsEnabled`, or a download policy for a server admin or a Plex identity (Jellyfin only)",
        },
        "403": { description: "Linking without the ADMIN bit" },
        "404": { description: "No such identity (for the download policy: no longer on the server), or no such account" },
        "413": tooLargeAnswer(16 * 1024),
      },
    },
  },
  "/admin/users/{id}/sessions": {
    get: {
      tags: ["Admin – Users"],
      summary: "List auth sessions for a user (MANAGE_USERS)",
      description: "An ADMIN target needs the ADMIN bit.",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "200": {
          description: "Auth session list, most recently seen first",
          content: { "application/json": { schema: { type: "array", items: { type: "object", properties: AUTH_SESSION_ROW_FIELDS } } } },
        },
        "403": { description: "An ADMIN target needs the ADMIN bit" },
        "404": { description: "User not found" },
      },
    },
    delete: {
      tags: ["Admin – Users"],
      summary: "Revoke one auth session, or all of them, for a user (MANAGE_USERS)",
      description: "The target is chosen in the JSON BODY, not the query string. `all: true` (strictly boolean true) revokes every session; otherwise `sessionId` revokes that one, which must belong to this user.",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { type: "object", properties: { sessionId: { type: "string" }, all: { type: "boolean" } } } } },
      },
      responses: {
        "200": { description: "Revoked", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" }, revoked: { type: "string", description: "\"all\" or the revoked sessionId" } } } } } },
        "400": { description: "Neither `all` nor a `sessionId` supplied" },
        "403": { description: "An ADMIN target needs the ADMIN bit" },
        "404": { description: "User not found, or the session does not belong to this user" },
        "413": tooLargeAnswer(16 * 1024),
      },
    },
  },
  "/admin/users/{id}/watch-grade": {
    get: {
      tags: ["Admin – Users"],
      summary: "A user's request watch grade with its per-request breakdown (MANAGE_USERS or MANAGE_REQUESTS)",
      description:
        "Grades A–F on the share of the user's APPROVED requests that became available that they went on to " +
        "watch, from recorded play history. Approval counts per title on an instance: a request counts when it, " +
        "or any request for the same title on the same instance, was approved (`approvedAt`). Pending and " +
        "declined requests never count, and neither does a request whose title nobody approved. " +
        "Display-only: nothing reads the grade to gate requests. A request is scored only after its " +
        "grace period since fulfilment, and only when play history already covered the user's media servers " +
        "when it was fulfilled; plays count only from the moment of the request. A movie earns full credit when " +
        "watched (half once a quarter of it was played); a show is scored per season — episodes watched ÷ the " +
        "configured share of that season's regular-season library episodes — and the best season counts. The " +
        "same title requested on several *arr instances is folded into one unit (`duplicates`). A request the " +
        "user didn't watch still earns full credit once `settings.otherViewers` other people watched it since " +
        "the request, as play history recorded them (0 = off; one account's several media-server logins count " +
        "once). `enabled: false` (with `reason`) when the feature flag or play history tracking is off.",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "200": {
          description: "Watch grade detail",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  enabled: { type: "boolean" },
                  reason: { type: "string", nullable: true, enum: ["feature-off", "tracking-off", null] },
                  settings: {
                    type: "object",
                    nullable: true,
                    properties: {
                      graceDays: { type: "integer" },
                      windowDays: { type: "integer", description: "0 = no limit" },
                      tvEpisodePercent: { type: "integer", description: "Share of a season's library episodes for full credit" },
                      otherViewers: { type: "integer", description: "0 = off" },
                      bandA: { type: "integer", description: "Minimum watch rate for an A" },
                      bandB: { type: "integer", description: "Minimum watch rate for a B" },
                      bandC: { type: "integer", description: "Minimum watch rate for a C" },
                      bandD: { type: "integer", description: "Minimum watch rate for a D; below it is an F" },
                      minGradedRequests: { type: "integer", description: "Scored requests needed before a letter" },
                      watchedThresholdPercent: { type: "integer" },
                    },
                  },
                  grade: {
                    type: "object",
                    nullable: true,
                    properties: {
                      status: { type: "string", enum: ["graded", "insufficient", "unlinked", "untracked"] },
                      letter: { type: "string", nullable: true, enum: ["A", "B", "C", "D", "F", null] },
                      minGradedRequests: { type: "integer", description: "Scored requests a letter needs (the setting in force)" },
                      score: { type: "integer", nullable: true, description: "0–100 watch rate over scored requests" },
                      graded: { type: "integer" },
                      watched: { type: "integer" },
                      byOthers: { type: "integer", description: "Counted as watched because enough other people watched it" },
                      partial: { type: "integer" },
                      unwatched: { type: "integer" },
                      inGrace: { type: "integer" },
                      untracked: { type: "integer" },
                    },
                  },
                  requests: {
                    type: "array",
                    description: "Newest fulfilment first, capped at 500 rows (the grade itself covers every request)",
                    items: {
                      type: "object",
                      properties: {
                        requestId: { type: "string" },
                        tmdbId: { type: "integer" },
                        mediaType: { $ref: "#/components/schemas/MediaType" },
                        title: { type: "string" },
                        releaseYear: { type: "string", nullable: true },
                        posterPath: { type: "string", nullable: true },
                        requestedAt: { type: "string", format: "date-time" },
                        fulfilledAt: { type: "string", format: "date-time" },
                        duplicates: { type: "integer", description: "Further requests for the same title (other instances) folded into this one" },
                        watch: { type: "string", nullable: true, enum: ["watched", "partial", "unwatched", null], description: "The requester's own watch state" },
                        otherViewers: { type: "integer", nullable: true, description: "Other people who watched it since the request; counted only for a scored request the requester didn't fully watch, null otherwise" },
                        watchedByOthers: { type: "boolean" },
                        credit: { type: "number", description: "0–1; 1 when watchedByOthers" },
                        scoring: { type: "string", enum: ["scored", "grace", "untracked"] },
                        graceDaysLeft: { type: "integer", nullable: true },
                        episodes: {
                          type: "object",
                          nullable: true,
                          description: "The best season — the one the credit comes from",
                          properties: {
                            season: { type: "integer", nullable: true },
                            watched: { type: "integer" },
                            started: { type: "integer" },
                            library: { type: "integer", description: "Episodes of that season in the library; 0 = unknown" },
                            required: { type: "integer" },
                          },
                        },
                      },
                    },
                  },
                  truncated: { type: "boolean" },
                },
              },
            },
          },
        },
        "403": { description: "Caller holds neither MANAGE_USERS nor MANAGE_REQUESTS" },
        "404": { description: "No such user" },
      },
    },
  },
  "/admin/watch-grade/preview": {
    post: {
      tags: ["Admin – Users"],
      summary: "Preview how the watch grade spread would change with other settings (ADMIN)",
      description:
        "Grades every requester with the watch-grade settings in the body and with the ones in force, and " +
        "returns how many land on each letter. Nothing is written. The body is judged exactly as a " +
        "`PATCH /settings` of the same keys would be: the same per-key bounds and cross-field rules (window " +
        "longer than grace, cutoffs strictly descending), a key left out keeps its stored value, and a blank " +
        "one means the default.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                watchGradeGraceDays: { type: "string", pattern: "^\\d+$", description: "integer string 1–365; blank = the default" },
                watchGradeWindowDays: { type: "string", pattern: "^\\d+$", description: "integer string 30–3650, or 0 for no limit; blank = the default" },
                watchGradeTvPercent: { type: "string", pattern: "^\\d+$", description: "integer string 1–100; blank = the default" },
                watchGradeOtherViewers: { type: "string", pattern: "^\\d+$", description: "integer string 1–100, or 0 to turn off; blank = the default" },
                watchGradeBandA: { type: "string", pattern: "^\\d+$", description: "integer string 1–100; blank = the default" },
                watchGradeBandB: { type: "string", pattern: "^\\d+$", description: "integer string 1–100; blank = the default" },
                watchGradeBandC: { type: "string", pattern: "^\\d+$", description: "integer string 1–100; blank = the default" },
                watchGradeBandD: { type: "string", pattern: "^\\d+$", description: "integer string 1–100; blank = the default" },
                watchGradeMinRequests: { type: "string", pattern: "^\\d+$", description: "integer string 1–100; blank = the default" },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Spread with the settings in force and with the proposed ones",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  enabled: { type: "boolean" },
                  reason: { type: "string", nullable: true, enum: ["feature-off", "tracking-off", null] },
                  requesters: { type: "integer", description: "Accounts with at least one approved, fulfilled request" },
                  current: { $ref: "#/components/schemas/WatchGradeSpread" },
                  proposed: { $ref: "#/components/schemas/WatchGradeSpread" },
                },
              },
            },
          },
        },
        "400": { description: "Malformed JSON, a non-object body, a non-string value, a value out of bounds, or a combination the settings save would refuse" },
        "403": { description: "Caller is not an ADMIN" },
        "413": { description: "Body over 16 KB" },
      },
    },
  },
};
