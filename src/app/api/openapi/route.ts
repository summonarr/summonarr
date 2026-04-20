import { NextResponse } from "next/server";
import { auth, isTokenExpired } from "@/lib/auth";

const spec = {
  openapi: "3.0.3",
  info: {
    title: "Summonarr API",
    version: "1.0.0",
    description:
      "Internal REST API for Summonarr — media request aggregator with Plex/Jellyfin, Radarr/Sonarr, and TMDB integration.",
  },
  servers: [{ url: "/api", description: "Application API" }],
  components: {
    securitySchemes: {
      session: {
        type: "apiKey",
        in: "cookie",
        name: "authjs.session-token",
        description: "NextAuth session cookie",
      },
      cronSecret: {
        type: "http",
        scheme: "bearer",
        description: "CRON_SECRET bearer token for sync/cron routes",
      },
    },
    schemas: {
      MediaType: { type: "string", enum: ["MOVIE", "TV"] },
      RequestStatus: {
        type: "string",
        enum: ["PENDING", "APPROVED", "DECLINED", "AVAILABLE"],
      },
      UserRole: { type: "string", enum: ["USER", "ADMIN", "ISSUE_ADMIN"] },
      IssueType: {
        type: "string",
        enum: ["VIDEO", "AUDIO", "SUBTITLE", "OTHER"],
      },
      MediaRequest: {
        type: "object",
        properties: {
          id: { type: "string" },
          tmdbId: { type: "integer" },
          mediaType: { $ref: "#/components/schemas/MediaType" },
          title: { type: "string" },
          posterPath: { type: "string", nullable: true },
          releaseYear: { type: "string", nullable: true },
          status: { $ref: "#/components/schemas/RequestStatus" },
          note: { type: "string", nullable: true },
          adminNote: { type: "string", nullable: true },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      Issue: {
        type: "object",
        properties: {
          id: { type: "string" },
          tmdbId: { type: "integer" },
          mediaType: { $ref: "#/components/schemas/MediaType" },
          title: { type: "string" },
          type: { $ref: "#/components/schemas/IssueType" },
          description: { type: "string" },
          status: { type: "string", enum: ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"] },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      Error: {
        type: "object",
        properties: { error: { type: "string" } },
        required: ["error"],
      },
      PaginatedMeta: {
        type: "object",
        properties: {
          total: { type: "integer" },
          page: { type: "integer" },
          pageSize: { type: "integer" },
        },
      },
    },
  },
  security: [{ session: [] }],
  tags: [
    { name: "Health", description: "Liveness / readiness probes" },
    { name: "Search", description: "TMDB media search" },
    { name: "Requests", description: "Media request lifecycle" },
    { name: "Issues", description: "Content issue reporting" },
    { name: "Votes", description: "Deletion voting" },
    { name: "Ratings", description: "External ratings (MDBList / OMDB)" },
    { name: "Play History", description: "Watch history and sessions" },
    { name: "Sessions", description: "Active playback sessions" },
    { name: "TV", description: "TV episode / season data" },
    { name: "Person", description: "TMDB person credits" },
    { name: "TV Availability", description: "Episode-level availability" },
    { name: "Profile", description: "Authenticated user profile" },
    { name: "Push", description: "Web push notification subscriptions" },
    { name: "Auth", description: "Authentication helpers" },
    { name: "Admin – Users", description: "User management (ADMIN only)" },
    { name: "Admin – Sync", description: "Library sync triggers" },
    { name: "Admin – Stats", description: "System statistics" },
    { name: "Admin – Audit Log", description: "Audit trail" },
    { name: "Admin – Backup", description: "Database export / import" },
    { name: "Admin – Debug", description: "Pipeline inspection" },
    { name: "Admin – Fix Match", description: "Manual metadata correction" },
    { name: "Discord", description: "Discord OAuth / role sync" },
    { name: "Settings", description: "Application settings (ADMIN only)" },
    { name: "Webhooks", description: "Inbound webhooks from media servers / ARR" },
    { name: "Cron", description: "Scheduled maintenance jobs (CRON_SECRET)" },
    { name: "Events", description: "Server-sent events stream" },
  ],
  paths: {

    "/health": {
      get: {
        tags: ["Health"],
        summary: "Liveness probe",
        security: [],
        responses: {
          "200": {
            description: "Service is up",
            content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" } } } } },
          },
        },
      },
    },

    "/search": {
      get: {
        tags: ["Search"],
        summary: "Search TMDB for movies or TV shows",
        parameters: [
          { name: "q", in: "query", required: true, schema: { type: "string", maxLength: 200 } },
          { name: "type", in: "query", schema: { type: "string", enum: ["movie", "tv"] } },
        ],
        responses: {
          "200": {
            description: "Search results with library availability",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "integer" },
                      mediaType: { type: "string", enum: ["movie", "tv"] },
                      title: { type: "string" },
                      posterPath: { type: "string", nullable: true },
                      plexAvailable: { type: "boolean" },
                      jellyfinAvailable: { type: "boolean" },
                    },
                  },
                },
              },
            },
          },
          "400": { description: "Missing or invalid query", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "429": { description: "Rate limited (30 req/min per user)" },
        },
      },
    },

    "/requests": {
      get: {
        tags: ["Requests"],
        summary: "List media requests",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "status", in: "query", schema: { $ref: "#/components/schemas/RequestStatus" } },
          { name: "sort", in: "query", schema: { type: "string", enum: ["newest", "oldest", "title"] } },
        ],
        responses: {
          "200": {
            description: "Paginated request list",
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    { $ref: "#/components/schemas/PaginatedMeta" },
                    { type: "object", properties: { requests: { type: "array", items: { $ref: "#/components/schemas/MediaRequest" } } } },
                  ],
                },
              },
            },
          },
        },
      },
      post: {
        tags: ["Requests"],
        summary: "Create a new media request",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["tmdbId", "mediaType", "_token"],
                properties: {
                  tmdbId: { type: "integer" },
                  mediaType: { $ref: "#/components/schemas/MediaType" },
                  note: { type: "string", maxLength: 500 },
                  _token: { type: "string", description: "HMAC-signed request token from /api/requests/token" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Request created or already exists", content: { "application/json": { schema: { $ref: "#/components/schemas/MediaRequest" } } } },
          "400": { description: "Validation error" },
          "409": { description: "Duplicate request" },
          "429": { description: "Quota exceeded" },
        },
      },
    },
    "/requests/token": {
      get: {
        tags: ["Requests"],
        summary: "Get an HMAC token required to submit a request",
        responses: {
          "200": {
            description: "Short-lived HMAC token",
            content: { "application/json": { schema: { type: "object", properties: { token: { type: "string" } } } } },
          },
        },
      },
    },
    "/requests/{id}": {
      patch: {
        tags: ["Requests"],
        summary: "Update request status or trigger ARR action (ADMIN)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  status: { $ref: "#/components/schemas/RequestStatus" },
                  adminNote: { type: "string", maxLength: 1000 },
                  retry: { type: "boolean", description: "Re-push to Radarr/Sonarr" },
                  search: { type: "boolean", description: "Trigger search in ARR" },
                  permanent: { type: "boolean", description: "Permanently decline" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Updated request", content: { "application/json": { schema: { $ref: "#/components/schemas/MediaRequest" } } } },
          "403": { description: "Forbidden" },
          "404": { description: "Not found" },
        },
      },
      delete: {
        tags: ["Requests"],
        summary: "Delete a request (ADMIN)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Deleted", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" } } } } } },
          "403": { description: "Forbidden" },
          "404": { description: "Not found" },
        },
      },
    },
    "/requests/batch": {
      post: {
        tags: ["Requests"],
        summary: "Bulk approve or decline requests (ADMIN)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["ids", "action"],
                properties: {
                  ids: { type: "array", items: { type: "string" } },
                  action: { type: "string", enum: ["approve", "decline"] },
                  adminNote: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Batch result", content: { "application/json": { schema: { type: "object", properties: { updated: { type: "integer" } } } } } },
        },
      },
    },

    "/issues": {
      get: {
        tags: ["Issues"],
        summary: "List issues",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "status", in: "query", schema: { type: "string", enum: ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"] } },
        ],
        responses: {
          "200": {
            description: "Paginated issues",
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    { $ref: "#/components/schemas/PaginatedMeta" },
                    { type: "object", properties: { issues: { type: "array", items: { $ref: "#/components/schemas/Issue" } } } },
                  ],
                },
              },
            },
          },
        },
      },
      post: {
        tags: ["Issues"],
        summary: "Create a new issue",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["tmdbId", "mediaType", "type", "description"],
                properties: {
                  tmdbId: { type: "integer" },
                  mediaType: { $ref: "#/components/schemas/MediaType" },
                  type: { $ref: "#/components/schemas/IssueType" },
                  description: { type: "string", maxLength: 2000 },
                  seasonNumber: { type: "integer" },
                  episodeNumber: { type: "integer" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Created issue", content: { "application/json": { schema: { $ref: "#/components/schemas/Issue" } } } },
        },
      },
    },
    "/issues/{id}": {
      get: {
        tags: ["Issues"],
        summary: "Get issue detail",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Issue with messages", content: { "application/json": { schema: { $ref: "#/components/schemas/Issue" } } } },
          "404": { description: "Not found" },
        },
      },
      patch: {
        tags: ["Issues"],
        summary: "Update issue status (ADMIN / ISSUE_ADMIN)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  status: { type: "string", enum: ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"] },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Updated issue" },
          "403": { description: "Forbidden" },
        },
      },
      delete: {
        tags: ["Issues"],
        summary: "Delete an issue (ADMIN / ISSUE_ADMIN)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Deleted" },
        },
      },
    },
    "/issues/{id}/messages": {
      post: {
        tags: ["Issues"],
        summary: "Add a message to an issue",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["message"],
                properties: { message: { type: "string", maxLength: 2000 } },
              },
            },
          },
        },
        responses: { "200": { description: "Message added" } },
      },
    },
    "/issues/{id}/releases": {
      get: {
        tags: ["Issues"],
        summary: "Get Sonarr/Radarr releases for issue media (ADMIN / ISSUE_ADMIN)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Available releases from ARR" } },
      },
    },

    "/votes": {
      get: {
        tags: ["Votes"],
        summary: "List deletion vote items",
        parameters: [{ name: "page", in: "query", schema: { type: "integer", default: 1 } }],
        responses: {
          "200": {
            description: "Paginated vote items",
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    { $ref: "#/components/schemas/PaginatedMeta" },
                    { type: "object", properties: { items: { type: "array", items: { type: "object" } } } },
                  ],
                },
              },
            },
          },
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
                  tmdbId: { type: "integer" },
                  mediaType: { $ref: "#/components/schemas/MediaType" },
                  reason: { type: "string", maxLength: 200 },
                  _token: { type: "string" },
                },
              },
            },
          },
        },
        responses: { "200": { description: "Vote recorded" } },
      },
    },
    "/votes/{tmdbId}": {
      delete: {
        tags: ["Votes"],
        summary: "Retract own vote",
        parameters: [
          { name: "tmdbId", in: "path", required: true, schema: { type: "integer" } },
          { name: "mediaType", in: "query", required: true, schema: { $ref: "#/components/schemas/MediaType" } },
        ],
        responses: { "200": { description: "Vote retracted" } },
      },
    },

    "/ratings": {
      get: {
        tags: ["Ratings"],
        summary: "Get external ratings for a title (MDBList → OMDB fallback)",
        parameters: [
          { name: "id", in: "query", required: true, schema: { type: "integer" }, description: "TMDB ID" },
          { name: "type", in: "query", required: true, schema: { type: "string", enum: ["movie", "tv"] } },
        ],
        responses: {
          "200": {
            description: "Ratings from external sources",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    title: { type: "string" },
                    ratings: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: { source: { type: "string" }, value: { type: "number" } },
                      },
                    },
                  },
                },
              },
            },
          },
          "429": { description: "Rate limited (60 req/min)" },
        },
      },
    },
    "/ratings/batch": {
      post: {
        tags: ["Ratings"],
        summary: "Batch fetch ratings for multiple titles",
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
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "integer" },
                        type: { type: "string", enum: ["movie", "tv"] },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        responses: { "200": { description: "Map of TMDB ID → ratings" } },
      },
    },

    "/play-history": {
      get: {
        tags: ["Play History"],
        summary: "List play history for current user",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "tmdbId", in: "query", schema: { type: "integer" } },
          { name: "userId", in: "query", schema: { type: "string" }, description: "Admin-only filter" },
        ],
        responses: { "200": { description: "Paginated play history rows" } },
      },
    },
    "/play-history/sessions": {
      get: {
        tags: ["Play History"],
        summary: "Completed session list",
        parameters: [{ name: "page", in: "query", schema: { type: "integer", default: 1 } }],
        responses: { "200": { description: "Paginated completed sessions" } },
      },
    },
    "/play-history/stats": {
      get: {
        tags: ["Play History"],
        summary: "Play history statistics",
        responses: { "200": { description: "Aggregate stats (total runtime, titles, etc.)" } },
      },
    },
    "/play-history/export": {
      get: {
        tags: ["Play History"],
        summary: "Export play history as CSV (ADMIN)",
        responses: { "200": { description: "CSV file download" } },
      },
    },
    "/play-history/{id}": {
      delete: {
        tags: ["Play History"],
        summary: "Delete a play history record (ADMIN)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Deleted" } },
      },
    },

    "/sessions": {
      get: {
        tags: ["Sessions"],
        summary: "List active playback sessions",
        responses: {
          "200": {
            description: "Currently active sessions from Plex and Jellyfin",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      source: { type: "string", enum: ["plex", "jellyfin"] },
                      userId: { type: "string", nullable: true },
                      title: { type: "string" },
                      state: { type: "string" },
                      progress: { type: "number" },
                      updatedAt: { type: "string", format: "date-time" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },

    "/tv/{id}/season/{n}": {
      get: {
        tags: ["TV"],
        summary: "Get episode data for a season",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "integer" }, description: "TMDB TV ID" },
          { name: "n", in: "path", required: true, schema: { type: "integer" }, description: "Season number" },
        ],
        responses: { "200": { description: "Season episodes with availability" } },
      },
    },

    "/tv-availability": {
      get: {
        tags: ["TV Availability"],
        summary: "Episode-level availability for a TV show",
        parameters: [
          { name: "tmdbId", in: "query", required: true, schema: { type: "integer" } },
          { name: "source", in: "query", schema: { type: "string", enum: ["plex", "jellyfin"] } },
        ],
        responses: { "200": { description: "Per-episode availability map" } },
      },
    },

    "/person/{id}": {
      get: {
        tags: ["Person"],
        summary: "Get TMDB person details and credits",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        responses: { "200": { description: "Person details with cast/crew credits" } },
      },
    },

    "/profile/password": {
      patch: {
        tags: ["Profile"],
        summary: "Change password (credentials accounts only)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["currentPassword", "newPassword"],
                properties: {
                  currentPassword: { type: "string" },
                  newPassword: { type: "string", minLength: 8 },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Password updated" },
          "400": { description: "Validation error" },
          "401": { description: "Wrong current password" },
        },
      },
    },
    "/profile/notifications": {
      patch: {
        tags: ["Profile"],
        summary: "Update notification preferences",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  notifyOnApproved: { type: "boolean" },
                  notifyOnAvailable: { type: "boolean" },
                  notifyOnDeclined: { type: "boolean" },
                  emailOnApproved: { type: "boolean" },
                  emailOnAvailable: { type: "boolean" },
                  emailOnDeclined: { type: "boolean" },
                  pushOnApproved: { type: "boolean" },
                  pushOnAvailable: { type: "boolean" },
                  pushOnDeclined: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: { "200": { description: "Preferences updated" } },
      },
    },

    "/push/vapid-key": {
      get: {
        tags: ["Push"],
        summary: "Get the public VAPID key for push subscription",
        security: [],
        responses: { "200": { description: "VAPID public key", content: { "application/json": { schema: { type: "object", properties: { publicKey: { type: "string" } } } } } } },
      },
    },
    "/push/subscribe": {
      post: {
        tags: ["Push"],
        summary: "Register a push subscription",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["subscription"],
                properties: { subscription: { type: "object", description: "PushSubscription JSON" } },
              },
            },
          },
        },
        responses: { "200": { description: "Subscription registered" } },
      },
      delete: {
        tags: ["Push"],
        summary: "Remove a push subscription",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["endpoint"],
                properties: { endpoint: { type: "string" } },
              },
            },
          },
        },
        responses: { "200": { description: "Subscription removed" } },
      },
    },
    "/push/test": {
      post: {
        tags: ["Push"],
        summary: "Send a test push notification to current user",
        responses: { "200": { description: "Test notification dispatched" } },
      },
    },

    "/auth/setup-status": {
      get: {
        tags: ["Auth"],
        summary: "Check whether initial admin setup is required",
        security: [],
        responses: { "200": { description: "Setup status", content: { "application/json": { schema: { type: "object", properties: { needsSetup: { type: "boolean" } } } } } } },
      },
    },
    "/auth/register": {
      post: {
        tags: ["Auth"],
        summary: "Register a new user (credentials)",
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name", "email", "password"],
                properties: {
                  name: { type: "string" },
                  email: { type: "string", format: "email" },
                  password: { type: "string", minLength: 8 },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "User created" },
          "400": { description: "Validation error or email already in use" },
        },
      },
    },
    "/auth/plex/client-id": {
      get: {
        tags: ["Auth"],
        summary: "Get the Plex client ID for OAuth",
        security: [],
        responses: { "200": { description: "Plex client ID", content: { "application/json": { schema: { type: "object", properties: { clientId: { type: "string" } } } } } } },
      },
    },
    "/auth/jellyfin/quickconnect": {
      post: {
        tags: ["Auth"],
        summary: "Initiate or poll Jellyfin QuickConnect login",
        security: [],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { code: { type: "string", description: "QuickConnect code from poll response" } },
              },
            },
          },
        },
        responses: { "200": { description: "QuickConnect state or token" } },
      },
    },

    "/admin/users/{id}": {
      patch: {
        tags: ["Admin – Users"],
        summary: "Update user settings (ADMIN)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  role: { $ref: "#/components/schemas/UserRole" },
                  autoApprove: { type: "boolean" },
                  quotaExempt: { type: "boolean" },
                  mediaServer: { type: "string", enum: ["plex", "jellyfin"], nullable: true },
                  notifyOnApproved: { type: "boolean" },
                  notifyOnAvailable: { type: "boolean" },
                  notifyOnDeclined: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: { "200": { description: "Updated fields" }, "403": { description: "Forbidden" } },
      },
      delete: {
        tags: ["Admin – Users"],
        summary: "Delete a user (ADMIN)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "User deleted" },
          "400": { description: "Cannot delete last admin" },
          "403": { description: "Forbidden" },
        },
      },
    },
    "/admin/users/{id}/sessions": {
      get: {
        tags: ["Admin – Users"],
        summary: "List auth sessions for a user (ADMIN)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Auth session list" } },
      },
      delete: {
        tags: ["Admin – Users"],
        summary: "Revoke a specific auth session (ADMIN)",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "sessionId", in: "query", required: true, schema: { type: "string" } },
        ],
        responses: { "200": { description: "Session revoked" } },
      },
    },

    "/sync": {
      post: {
        tags: ["Admin – Sync"],
        summary: "Run the full sync orchestrator (admin session or CRON_SECRET)",
        security: [{ session: [] }, { cronSecret: [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { full: { type: "boolean", description: "Delete-and-repopulate instead of incremental" } },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Sync summary",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    checked: { type: "object", properties: { approved: { type: "integer" }, available: { type: "integer" } } },
                    marked: { type: "integer" },
                    reverted: { type: "integer" },
                    plexMarked: { type: "integer" },
                    jellyfinMarked: { type: "integer" },
                    radarrWanted: { type: "integer" },
                    sonarrWanted: { type: "integer" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/sync/plex": {
      post: {
        tags: ["Admin – Sync"],
        summary: "Sync Plex library",
        security: [{ session: [] }, { cronSecret: [] }],
        responses: { "200": { description: "Plex sync result" } },
      },
    },
    "/sync/jellyfin": {
      post: {
        tags: ["Admin – Sync"],
        summary: "Sync Jellyfin library",
        security: [{ session: [] }, { cronSecret: [] }],
        responses: { "200": { description: "Jellyfin sync result" } },
      },
    },
    "/sync/radarr": {
      post: {
        tags: ["Admin – Sync"],
        summary: "Sync Radarr wanted/available items",
        security: [{ session: [] }, { cronSecret: [] }],
        responses: { "200": { description: "Radarr sync result" } },
      },
    },
    "/sync/sonarr": {
      post: {
        tags: ["Admin – Sync"],
        summary: "Sync Sonarr wanted/available items",
        security: [{ session: [] }, { cronSecret: [] }],
        responses: { "200": { description: "Sonarr sync result" } },
      },
    },
    "/sync/upcoming": {
      post: {
        tags: ["Admin – Sync"],
        summary: "Sync upcoming releases from TMDB",
        security: [{ session: [] }, { cronSecret: [] }],
        responses: { "200": { description: "Upcoming sync result" } },
      },
    },
    "/sync/ratings": {
      post: {
        tags: ["Admin – Sync"],
        summary: "Sync external ratings cache",
        security: [{ session: [] }, { cronSecret: [] }],
        responses: { "200": { description: "Ratings sync result" } },
      },
    },
    "/sync/play-history": {
      post: {
        tags: ["Admin – Sync"],
        summary: "Ingest play history from Plex / Jellyfin",
        security: [{ session: [] }, { cronSecret: [] }],
        responses: { "200": { description: "Play history sync result" } },
      },
    },
    "/sync/tv-episodes": {
      post: {
        tags: ["Admin – Sync"],
        summary: "Sync TV episode cache from TMDB",
        security: [{ session: [] }, { cronSecret: [] }],
        responses: { "200": { description: "TV episode sync result" } },
      },
    },

    "/admin/stats": {
      get: {
        tags: ["Admin – Stats"],
        summary: "System statistics (ADMIN)",
        responses: { "200": { description: "Aggregate stats across requests, users, library, and sync" } },
      },
    },

    "/admin/audit-log": {
      get: {
        tags: ["Admin – Audit Log"],
        summary: "Paginated audit log (ADMIN)",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "action", in: "query", schema: { type: "string" } },
          { name: "userId", in: "query", schema: { type: "string" } },
        ],
        responses: { "200": { description: "Audit log entries" } },
      },
    },
    "/admin/audit-log/export": {
      get: {
        tags: ["Admin – Audit Log"],
        summary: "Export audit log as CSV (ADMIN)",
        responses: { "200": { description: "CSV download" } },
      },
    },

    "/admin/backup/db-export": {
      get: {
        tags: ["Admin – Backup"],
        summary: "Export encrypted database backup (ADMIN)",
        responses: { "200": { description: "Encrypted .backup file" } },
      },
    },
    "/admin/backup/db-import": {
      post: {
        tags: ["Admin – Backup"],
        summary: "Import database backup (ADMIN)",
        requestBody: {
          required: true,
          content: { "multipart/form-data": { schema: { type: "object", properties: { file: { type: "string", format: "binary" } } } } },
        },
        responses: { "200": { description: "Import result" } },
      },
    },

    "/admin/debug/arr-state": {
      get: {
        tags: ["Admin – Debug"],
        summary: "Dump full ARR pipeline state for a title (ADMIN)",
        parameters: [
          { name: "tmdbId", in: "query", required: true, schema: { type: "integer" } },
          { name: "type", in: "query", required: true, schema: { type: "string", enum: ["movie", "tv"] } },
        ],
        responses: {
          "200": {
            description: "Cache rows, live ARR check, tvdb→tmdb mapping, wanted-table counts, last LIBRARY_SYNC audit row",
          },
        },
      },
    },

    "/admin/fix-match": {
      post: {
        tags: ["Admin – Fix Match"],
        summary: "Manually reassign a library item to a different TMDB ID (ADMIN / ISSUE_ADMIN)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["source", "itemId", "tmdbId", "mediaType"],
                properties: {
                  source: { type: "string", enum: ["plex", "jellyfin"] },
                  itemId: { type: "string" },
                  tmdbId: { type: "integer" },
                  mediaType: { $ref: "#/components/schemas/MediaType" },
                },
              },
            },
          },
        },
        responses: { "200": { description: "Match updated" } },
      },
    },
    "/admin/fix-match/candidates": {
      get: {
        tags: ["Admin – Fix Match"],
        summary: "Get TMDB candidates for a library item title (ADMIN / ISSUE_ADMIN)",
        parameters: [
          { name: "query", in: "query", required: true, schema: { type: "string" } },
          { name: "mediaType", in: "query", required: true, schema: { $ref: "#/components/schemas/MediaType" } },
        ],
        responses: { "200": { description: "TMDB search results" } },
      },
    },
    "/admin/fix-match/file-info": {
      get: {
        tags: ["Admin – Fix Match"],
        summary: "Get file metadata for a library item (ADMIN / ISSUE_ADMIN)",
        parameters: [
          { name: "source", in: "query", required: true, schema: { type: "string", enum: ["plex", "jellyfin"] } },
          { name: "itemId", in: "query", required: true, schema: { type: "string" } },
        ],
        responses: { "200": { description: "File metadata from media server" } },
      },
    },
    "/admin/fix-match/thumb": {
      get: {
        tags: ["Admin – Fix Match"],
        summary: "Proxy thumbnail image for a library item (ADMIN / ISSUE_ADMIN)",
        parameters: [
          { name: "source", in: "query", required: true, schema: { type: "string", enum: ["plex", "jellyfin"] } },
          { name: "itemId", in: "query", required: true, schema: { type: "string" } },
        ],
        responses: { "200": { description: "Image binary (proxied)" } },
      },
    },

    "/admin/library-warm": {
      post: {
        tags: ["Admin – Stats"],
        summary: "Pre-warm the library cache (ADMIN)",
        security: [{ session: [] }, { cronSecret: [] }],
        responses: { "200": { description: "Warm result" } },
      },
    },
    "/admin/library-sample-paths": {
      get: {
        tags: ["Admin – Stats"],
        summary: "Sample file paths from the library (ADMIN)",
        responses: { "200": { description: "Sample paths" } },
      },
    },
    "/admin/check-schema": {
      get: {
        tags: ["Admin – Debug"],
        summary: "Check whether the DB schema is up to date (ADMIN)",
        responses: { "200": { description: "Schema check result" } },
      },
    },
    "/admin/clear-ratings-cache": {
      post: {
        tags: ["Admin – Stats"],
        summary: "Clear the ratings cache (ADMIN)",
        responses: { "200": { description: "Cache cleared" } },
      },
    },

    "/discord/generate-link": {
      get: {
        tags: ["Discord"],
        summary: "Generate Discord OAuth link",
        responses: { "200": { description: "Discord authorization URL" } },
      },
    },
    "/discord/initiate-merge": {
      post: {
        tags: ["Discord"],
        summary: "Start Discord account merge flow",
        responses: { "200": { description: "Merge token issued" } },
      },
    },
    "/discord/confirm-merge": {
      post: {
        tags: ["Discord"],
        summary: "Confirm Discord account merge",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["token"], properties: { token: { type: "string" } } } } },
        },
        responses: { "200": { description: "Accounts merged" } },
      },
    },
    "/discord/sync-roles": {
      post: {
        tags: ["Discord"],
        summary: "Sync Discord roles for the current user",
        responses: { "200": { description: "Roles synced" } },
      },
    },
    "/discord/register-commands": {
      post: {
        tags: ["Discord"],
        summary: "Register Discord slash commands (ADMIN)",
        responses: { "200": { description: "Commands registered" } },
      },
    },

    "/settings": {
      get: {
        tags: ["Settings"],
        summary: "Get all settings (ADMIN)",
        responses: { "200": { description: "Key-value settings map" } },
      },
      patch: {
        tags: ["Settings"],
        summary: "Update settings (ADMIN)",
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object", additionalProperties: { type: "string" }, description: "Arbitrary key-value pairs" },
            },
          },
        },
        responses: { "200": { description: "Updated settings" } },
      },
    },
    "/settings/arr-options": {
      get: {
        tags: ["Settings"],
        summary: "Get available quality profiles / root folders from Radarr and Sonarr (ADMIN)",
        responses: { "200": { description: "ARR options" } },
      },
    },
    "/settings/plex/libraries": {
      get: {
        tags: ["Settings"],
        summary: "List available Plex libraries (ADMIN)",
        responses: { "200": { description: "Plex library list" } },
      },
    },
    "/settings/jellyfin/libraries": {
      get: {
        tags: ["Settings"],
        summary: "List available Jellyfin libraries (ADMIN)",
        responses: { "200": { description: "Jellyfin library list" } },
      },
    },
    "/settings/test-ratings": {
      post: {
        tags: ["Settings"],
        summary: "Test MDBList / OMDB connectivity with stored keys (ADMIN)",
        responses: { "200": { description: "Test result" } },
      },
    },

    "/webhooks/plex": {
      post: {
        tags: ["Webhooks"],
        summary: "Plex media server webhook",
        description: "Accepts `Authorization: Bearer <secret>` or `?token=<secret>`. No HMAC — timing-safe compare against stored secret.",
        security: [],
        parameters: [{ name: "token", in: "query", schema: { type: "string" }, description: "Webhook secret (alternative to Authorization header)" }],
        requestBody: {
          content: { "application/x-www-form-urlencoded": { schema: { type: "object", properties: { payload: { type: "string", description: "JSON payload from Plex" } } } } },
        },
        responses: { "200": { description: "Processed" }, "401": { description: "Invalid token" } },
      },
    },
    "/webhooks/jellyfin": {
      post: {
        tags: ["Webhooks"],
        summary: "Jellyfin media server webhook",
        security: [],
        parameters: [{ name: "token", in: "query", schema: { type: "string" } }],
        requestBody: { content: { "application/json": { schema: { type: "object" } } } },
        responses: { "200": { description: "Processed" }, "401": { description: "Invalid token" } },
      },
    },
    "/webhooks/radarr": {
      post: {
        tags: ["Webhooks"],
        summary: "Radarr webhook (movie grabbed / imported / deleted)",
        security: [],
        parameters: [{ name: "token", in: "query", schema: { type: "string" } }],
        requestBody: { content: { "application/json": { schema: { type: "object" } } } },
        responses: { "200": { description: "Processed" }, "401": { description: "Invalid token" } },
      },
    },
    "/webhooks/sonarr": {
      post: {
        tags: ["Webhooks"],
        summary: "Sonarr webhook (episode grabbed / imported / deleted)",
        security: [],
        parameters: [{ name: "token", in: "query", schema: { type: "string" } }],
        requestBody: { content: { "application/json": { schema: { type: "object" } } } },
        responses: { "200": { description: "Processed" }, "401": { description: "Invalid token" } },
      },
    },

    "/cron/purge-auth-sessions": {
      post: {
        tags: ["Cron"],
        summary: "Purge expired auth sessions",
        security: [{ cronSecret: [] }],
        responses: { "200": { description: "Purge result" } },
      },
    },
    "/cron/scrub-audit-pii": {
      post: {
        tags: ["Cron"],
        summary: "Scrub PII from old audit log entries",
        security: [{ cronSecret: [] }],
        responses: { "200": { description: "Scrub result" } },
      },
    },
    "/cron/warm-activity": {
      post: {
        tags: ["Cron"],
        summary: "Pre-warm activity calendar cache",
        security: [{ cronSecret: [] }],
        responses: { "200": { description: "Warm result" } },
      },
    },
    "/cron/warm-mdblist": {
      post: {
        tags: ["Cron"],
        summary: "Pre-warm MDBList ratings cache",
        security: [{ cronSecret: [] }],
        responses: { "200": { description: "Warm result" } },
      },
    },
    "/cron/warm-omdb": {
      post: {
        tags: ["Cron"],
        summary: "Pre-warm OMDB ratings cache",
        security: [{ cronSecret: [] }],
        responses: { "200": { description: "Warm result" } },
      },
    },

    "/events": {
      get: {
        tags: ["Events"],
        summary: "Server-sent events stream for real-time UI updates",
        responses: {
          "200": {
            description: "SSE stream",
            content: { "text/event-stream": { schema: { type: "string" } } },
          },
        },
      },
    },
  },
};

export async function GET() {
  const session = await auth();
  if (!session || isTokenExpired(session)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "ADMIN" && session.user.role !== "ISSUE_ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.json(spec, {
    headers: { "Cache-Control": "no-store" },
  });
}
