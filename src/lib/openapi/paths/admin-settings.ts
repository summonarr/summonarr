// Instance registries, the OIDC allowlist and outbound notification channels.

import { AGENT_KINDS, NOTIFY_EVENT_KEYS } from "@/lib/notify-events";
import { ARR_SERVICE, tooLargeAnswer, OK_TRUE } from "../shared";
import { NOTIFICATION_AGENTS_MAX } from "@/lib/api-body-limits";
import type { OpenApiSchema, OpenApiPaths } from "../types";

// One Radarr/Sonarr instance as GET /admin/arr-instances and the save's answer
// list it (instanceView, src/app/api/admin/arr-instances/route.ts): the registry
// entry plus the stored connection settings ("" when unset). Secrets only as
// has* flags — never the API key or webhook secret.
const ARR_INSTANCE_VIEW = {
  type: "object",
  properties: {
    slug: { type: "string", description: "'' = default, '4k', or a named slug" },
    name: { type: "string" },
    restricted: { type: "boolean" },
    serverAll: { type: "boolean" },
    skipLibraryCheck: { type: "boolean" },
    autoRoute: { type: "object", nullable: true, properties: { animeOnly: { type: "boolean" }, genreIds: { type: "array", items: { type: "integer" } }, originalLanguages: { type: "array", items: { type: "string" } } } },
    url: { type: "string", description: "Any embedded credential stripped" },
    externalUrl: { type: "string", description: "Any embedded credential stripped" },
    rootFolder: { type: "string" },
    qualityProfileId: { type: "string", description: "The stored value, \"\" when unset" },
    minimumAvailability: { type: "string" },
    languageProfileId: { type: "string" },
    hasApiKey: { type: "boolean" },
    hasWebhookSecret: { type: "boolean" },
  },
} satisfies OpenApiSchema;

// The registry versions GET/POST /admin/media-instances hand out: a SHA-256 of
// the named servers as GET shows them, sent back as POST `baseVersion`.
const MEDIA_INSTANCES_VERSION = {
  type: "string",
  pattern: "^[0-9a-f]{64}$",
  description: "Opaque — send it back as POST `baseVersion`",
} satisfies OpenApiSchema;

// One server of GET/POST /admin/media-instances (instanceView in that route):
// connection settings as stored, credentials only as has* flags, URLs with any
// userinfo stripped.
const PLEX_INSTANCE_VIEW = {
  type: "object",
  required: ["slug", "name", "restricted", "serverUrl", "adminEmail", "hasAdminToken", "libraries", "moviePathStripPrefix", "tvPathStripPrefix"],
  properties: {
    slug: { type: "string", description: "'' = the default server" },
    name: { type: "string" },
    restricted: { type: "boolean" },
    serverUrl: { type: "string", description: "Userinfo stripped" },
    adminEmail: { type: "string" },
    hasAdminToken: { type: "boolean", description: "The token itself is never returned" },
    libraries: { type: "string", description: "Comma-joined section keys; \"\" = all" },
    moviePathStripPrefix: { type: "string", description: "\"\" = inherits the default server's prefix" },
    tvPathStripPrefix: { type: "string" },
  },
} satisfies OpenApiSchema;

const JELLYFIN_INSTANCE_VIEW = {
  type: "object",
  required: ["slug", "name", "restricted", "url", "hasApiKey", "restrictSignIn", "libraries", "moviePathStripPrefix", "tvPathStripPrefix"],
  properties: {
    slug: { type: "string", description: "'' = the default server" },
    name: { type: "string" },
    restricted: { type: "boolean" },
    url: { type: "string", description: "Userinfo stripped" },
    hasApiKey: { type: "boolean", description: "The API key itself is never returned" },
    restrictSignIn: { type: "boolean", description: "true when no row is stored (fail-closed)" },
    libraries: { type: "string", description: "Comma-joined library ids; \"\" = all" },
    moviePathStripPrefix: { type: "string", description: "\"\" = inherits the default server's prefix" },
    tvPathStripPrefix: { type: "string" },
  },
} satisfies OpenApiSchema;

// One outbound notification channel as every /admin/notification-agents answer
// shows it (toPublicAgent, src/lib/notify-agents-admin.ts): `hasSecret`, never
// the secret.
const NOTIFICATION_AGENT = {
  type: "object",
  properties: {
    id: { type: "string" },
    kind: { type: "string", enum: [...AGENT_KINDS] },
    name: { type: "string" },
    enabled: { type: "boolean" },
    events: { type: "array", items: { type: "string" } },
    config: {
      type: "object",
      description: "webhook: { url, headerName, template|null }; ntfy: { url, topic, priority 1-5, attachPoster }; gotify: { url, priority 0-10 }",
      properties: {
        url: { type: "string" },
        headerName: { type: "string", description: "webhook" },
        template: { type: "string", nullable: true, description: "webhook" },
        topic: { type: "string", description: "ntfy" },
        priority: { type: "integer", description: "ntfy 1-5, gotify 0-10" },
        attachPoster: { type: "boolean", description: "ntfy" },
      },
    },
    hasSecret: { type: "boolean", description: "The secret itself is never returned." },
    configValid: { type: "boolean", description: "false when the stored config no longer passes validation — the channel is skipped until it is edited and saved." },
    lastStatus: { type: "string", nullable: true, enum: ["ok", "failed", null] },
    lastError: { type: "string", nullable: true },
    lastAttemptAt: { type: "string", format: "date-time", nullable: true },
    createdAt: { type: "string", format: "date-time" },
  },
} satisfies OpenApiSchema;

// The body of a notification channel's create (POST) and update (PATCH): the
// same fields, every one optional on the update (src/lib/notify-agents-admin.ts).
const AGENT_BODY = {
  type: "object",
  properties: {
    kind: { type: "string", enum: [...AGENT_KINDS], description: "Create only — fixed afterwards." },
    name: { type: "string", maxLength: 100 },
    enabled: { type: "boolean" },
    events: {
      type: "array",
      items: {
        type: "string",
        enum: [...NOTIFY_EVENT_KEYS],
      },
    },
    config: { type: "object" },
    secret: { type: "string", nullable: true, writeOnly: true, description: "Write-only (GET answers `hasSecret`). Omit to keep the saved value, null or \"\" to clear. Gotify requires one." },
  },
} satisfies OpenApiSchema;

export const adminSettingsPaths: OpenApiPaths = {
  "/admin/arr-instances": {
    get: {
      tags: ["Admin – Settings"],
      summary: "List all Radarr/Sonarr instances with connection state (ADMIN)",
      responses: {
        "200": {
          description:
            "Instance lists keyed by service. Each carries its registry entry plus url, externalUrl, rootFolder, " +
            "qualityProfileId, minimumAvailability, languageProfileId (stored strings, \"\" when unset); secrets only as " +
            "hasApiKey / hasWebhookSecret. `versions` (additive) holds an opaque version per service of the NAMED " +
            "instances, to send back as POST `baseVersion`.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["radarr", "sonarr"],
                properties: {
                  radarr: { type: "array", items: ARR_INSTANCE_VIEW },
                  sonarr: { type: "array", items: ARR_INSTANCE_VIEW },
                  versions: { type: "object", properties: { radarr: { type: "string" }, sonarr: { type: "string" } } },
                },
              },
            },
          },
        },
      },
    },
    post: {
      tags: ["Admin – Settings"],
      summary: "Save one service's instance registry + connection settings (ADMIN)",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["service", "instances"],
              properties: {
                service: ARR_SERVICE,
                baseVersion: {
                  type: "string",
                  description: "Optional: the `version` this list was edited from (GET `versions[service]` or the last POST's `version`). When it is no longer current the save is refused with 409 and nothing is written. Omitted, the save is unconditional.",
                },
                instances: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["slug"],
                    properties: {
                      slug: { type: "string", description: "'' = default, '4k', or a named slug (lowercase alnum)" },
                      name: { type: "string" },
                      restricted: { type: "boolean" },
                      serverAll: { type: "boolean" },
                      skipLibraryCheck: { type: "boolean" },
                      autoRoute: { type: "object", nullable: true, properties: { animeOnly: { type: "boolean" }, genreIds: { type: "array", items: { type: "integer" } }, originalLanguages: { type: "array", items: { type: "string" } } } },
                      url: { type: "string" },
                      externalUrl: {
                        type: "string",
                        nullable: true,
                        description: "The address a BROWSER uses for the instance (Open in Radarr/Sonarr links) — never fetched by the server; blank or null falls back to url",
                      },
                      apiKey: { type: "string", maxLength: 512, writeOnly: true, description: "Write-only; send the mask sentinel to keep unchanged" },
                      rootFolder: { type: "string" },
                      qualityProfileId: { type: "integer", nullable: true },
                      webhookSecret: { type: "string", maxLength: 512, writeOnly: true, description: "Write-only; send the mask sentinel to keep unchanged" },
                      minimumAvailability: { type: "string", nullable: true, enum: ["", "announced", "inCinemas", "released", null], description: "Radarr only; \"\" or null clears (Radarr's default)" },
                      languageProfileId: { type: "integer", nullable: true, description: "Sonarr v3 only; null clears" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Saved. `instances` is the configured set as GET lists it (secrets masked as has* flags), `testResults` one entry per instance whose connection was tested, `removed` (additive — the iOS app decodes it) one entry per de-registered slug with the PENDING/APPROVED requests it left behind, and `version` (additive) the list's new version for the next `baseVersion`.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  ok: { type: "boolean" },
                  instances: { type: "array", items: ARR_INSTANCE_VIEW },
                  testResults: { type: "object", description: "Keyed by instance slug: only the instances whose connection was tested", additionalProperties: { type: "object", properties: { version: { type: "string" }, error: { type: "string" } } } },
                  removed: { type: "array", items: { type: "object", properties: { slug: { type: "string" }, openRequests: { type: "integer" } } } },
                  version: { type: "string" },
                },
              },
            },
          },
        },
        "400": { description: "Invalid service or slug (`external` is reserved), `instances` is not an array, `baseVersion` is not a string, or an apiKey/webhookSecret is not a string of at most 512 characters" },
        "409": { description: "The stored list changed since `baseVersion`, or the body keeps a secret (mask sentinel) for a named instance that is no longer registered; nothing was written — reload and save again" },
        "413": { description: "Request body over the 64 KB cap" },
      },
    },
  },
  "/admin/oidc-allowlist": {
    get: {
      tags: ["Admin – Settings"],
      summary: "Who may sign in through OIDC (ADMIN)",
      description: "Off by default (empty lists, existingUsersOnly false). `unreadable: true` means the stored value doesn't parse and every OIDC sign-in is being refused until it is saved again; `allowlist` is then the default.",
      responses: {
        "200": {
          description: "The policy in force",
          content: { "application/json": { schema: { type: "object", properties: {
            allowlist: { $ref: "#/components/schemas/OidcAllowlist" },
            unreadable: { type: "boolean" },
          } } } },
        },
        "401": { description: "Not signed in" },
        "403": { description: "Not ADMIN" },
      },
    },
    patch: {
      tags: ["Admin – Settings"],
      summary: "Replace the OIDC allowlist (ADMIN)",
      description:
        "The whole policy. groups: the configured claim (default \"groups\", read from the ID token, else userinfo) must name at least one, exact match. " +
        "emailDomains: the IdP-verified email must be in one (exact domain; a leading @ is dropped, lowercased). existingUsersOnly: never create an account. " +
        "requestGroupsScope: also ask the IdP for the \"groups\" scope. Groups and domains apply to every OIDC sign-in, existing accounts included, on the web " +
        "callback and the native route; refusals are audited AUTH_LOGIN_FAILED with the reason. Nothing here ends an existing session. A wrong field refuses the " +
        "whole body. Lists are trimmed and de-duplicated, at most 50 entries each. Audited SETTINGS_CHANGE.",
      requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/OidcAllowlist" } } } },
      responses: {
        "200": {
          description: "{ allowlist, unreadable: false } — the policy as saved",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["allowlist", "unreadable"],
                properties: {
                  allowlist: { $ref: "#/components/schemas/OidcAllowlist" },
                  unreadable: { type: "boolean", enum: [false] },
                },
              },
            },
          },
        },
        "400": { description: "A field is the wrong type or shape" },
        "401": { description: "Not signed in" },
        "403": { description: "Not ADMIN" },
        "413": { description: "Request body over the 32 KB cap" },
      },
    },
  },
  "/admin/media-instances": {
    get: {
      tags: ["Admin – Settings"],
      summary: "List all Plex/Jellyfin server instances with connection state (ADMIN)",
      responses: {
        "200": {
          description: "Instance lists keyed by service (secrets masked as has* flags). `versions` (additive) holds an opaque version per service of the NAMED servers, to send back as POST `baseVersion`.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["plex", "jellyfin", "versions"],
                properties: {
                  plex: { type: "array", items: PLEX_INSTANCE_VIEW },
                  jellyfin: { type: "array", items: JELLYFIN_INSTANCE_VIEW },
                  versions: { type: "object", properties: { plex: MEDIA_INSTANCES_VERSION, jellyfin: MEDIA_INSTANCES_VERSION } },
                },
              },
            },
          },
        },
      },
    },
    post: {
      tags: ["Admin – Settings"],
      summary: "Save one service's instance registry + connection settings (ADMIN)",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["service", "instances"],
              properties: {
                service: { type: "string", enum: ["plex", "jellyfin"] },
                baseVersion: {
                  type: "string",
                  description: "Optional: the `version` this list was edited from (GET `versions[service]` or the last POST's `version`). When it is no longer current the save is refused with 409 and nothing is written. Omitted, the save is unconditional.",
                },
                instances: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["slug"],
                    properties: {
                      slug: { type: "string", description: "'' = default, or a named slug (lowercase alnum)" },
                      name: { type: "string" },
                      serverUrl: { type: "string", description: "Plex only" },
                      adminToken: { type: "string", maxLength: 4096, writeOnly: true, description: "Plex only; write-only, send the mask sentinel to keep unchanged" },
                      adminEmail: { type: "string", description: "Plex only" },
                      url: { type: "string", description: "Jellyfin only" },
                      apiKey: { type: "string", maxLength: 4096, writeOnly: true, description: "Jellyfin only; write-only, send the mask sentinel to keep unchanged" },
                      restrictSignIn: { type: "boolean", description: "Jellyfin only; omit to leave the stored value untouched" },
                      restricted: { type: "boolean", description: "Gate this server's library behind a per-user view grant (never the default instance)" },
                      libraries: { type: "string", description: "Comma-joined library ids/section keys to sync from THIS server; omit to leave untouched, \"\" syncs all" },
                      moviePathStripPrefix: { type: "string", description: "Omit to leave untouched; \"\" deletes the row (inherit the default server's prefix)" },
                      tvPathStripPrefix: { type: "string", description: "As moviePathStripPrefix" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Saved ({ ok, instances, testResults, version }); includes per-instance connection test results and (additive) the list's new version for the next `baseVersion`",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["ok", "instances", "testResults", "version"],
                properties: {
                  ok: { type: "boolean", enum: [true] },
                  instances: {
                    type: "array",
                    description: "The saved service's servers (Plex or Jellyfin shape)",
                    items: { oneOf: [PLEX_INSTANCE_VIEW, JELLYFIN_INSTANCE_VIEW] },
                  },
                  testResults: {
                    type: "object",
                    description: "Keyed by slug; only servers with their connection fields set are tested",
                    additionalProperties: { type: "object", properties: { ok: { type: "boolean", enum: [true] }, error: { type: "string" } } },
                  },
                  version: MEDIA_INSTANCES_VERSION,
                },
              },
            },
          },
        },
        "400": { description: "Invalid service, slug, server URL or name, `instances` is not an array, `baseVersion` is not a string, an adminToken/apiKey is not a string of at most 4096 characters, or a NEW named slug whose Setting keys would collide with the default server's (e.g. \"movie\", \"tv\"; a slug already registered is still accepted) — nothing was written" },
        "409": { description: "The stored list changed since `baseVersion`, or the body keeps a token (mask sentinel) for a named server that is no longer registered; nothing was written — reload and save again" },
        "413": { description: "Request body over the 64 KB cap" },
      },
    },
  },
  "/admin/notification-agents": {
    get: {
      tags: ["Admin – Settings"],
      summary: "List the outbound notification channels (ADMIN)",
      responses: {
        "200": {
          description: "Every configured channel",
          content: { "application/json": { schema: { type: "object", properties: { agents: { type: "array", items: NOTIFICATION_AGENT } } } } },
        },
      },
    },
    post: {
      tags: ["Admin – Settings"],
      summary: "Create a webhook, ntfy or Gotify channel (ADMIN)",
      description:
        "Channel URLs may point at the LAN; cloud-metadata addresses are refused at send time. A webhook " +
        "`template` is JSON with `{{field}}` placeholders and must render to valid JSON. " +
        `At most ${NOTIFICATION_AGENTS_MAX} channels.`,
      requestBody: { required: true, content: { "application/json": { schema: AGENT_BODY } } },
      responses: {
        "201": {
          description: "Created — { agent } (the public shape GET lists: `hasSecret`, never the secret)",
          content: { "application/json": { schema: { type: "object", required: ["agent"], properties: { agent: NOTIFICATION_AGENT } } } },
        },
        "400": { description: "Invalid input, or the channel limit is reached" },
        "413": tooLargeAnswer(64 * 1024),
      },
    },
  },
  "/admin/notification-agents/{id}": {
    patch: {
      tags: ["Admin – Settings"],
      summary: "Update a channel (ADMIN)",
      description: "Fields left out keep their stored value. The kind cannot change.",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      requestBody: { required: true, content: { "application/json": { schema: AGENT_BODY } } },
      responses: {
        "200": {
          description: "Updated — { agent } (the public shape)",
          content: { "application/json": { schema: { type: "object", required: ["agent"], properties: { agent: NOTIFICATION_AGENT } } } },
        },
        "400": { description: "Invalid input, including an attempt to change the kind" },
        "404": { description: "No such channel" },
        "413": tooLargeAnswer(64 * 1024),
      },
    },
    delete: {
      tags: ["Admin – Settings"],
      summary: "Delete a channel (ADMIN)",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: { "200": { description: "Deleted — { ok: true }", content: { "application/json": { schema: OK_TRUE } } }, "404": { description: "No such channel" } },
    },
  },
  "/admin/notification-agents/{id}/test": {
    post: {
      tags: ["Admin – Settings"],
      summary: "Send a sample event to a channel now (ADMIN)",
      description: "One attempt, no retry — works even while the channel is disabled. Rate-limited to 10 a minute.",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "200": {
          description: "Delivery outcome",
          content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" }, status: { type: "integer", nullable: true }, error: { type: "string", nullable: true } } } } },
        },
        "400": { description: "The channel's stored settings no longer validate — edit and save it again" },
        "404": { description: "No such channel" },
        "429": { description: "Too many test sends" },
      },
    },
  },
};
