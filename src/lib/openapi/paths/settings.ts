// Application settings.

import { ARR_SERVICE_PARAM, RETRY_AFTER_HEADER, tooLargeAnswer } from "../shared";
import type { OpenApiPaths } from "../types";

export const settingsPaths: OpenApiPaths = {
  "/settings": {
    get: {
      tags: ["Settings"],
      summary: "Get all settings (ADMIN)",
      description: "Only allow-listed keys that have a stored row appear. Secret values come back masked as \"••••••••\" (or \"\" when unset) and URL values with any userinfo stripped.",
      responses: {
        "200": {
          description: "Flat { key: string } map",
          content: {
            "application/json": {
              schema: {
                type: "object",
                description: "Open-ended by design: one string per stored setting the route allows, keyed by setting name (the allowed set grows with the app). A secret reads as the mask sentinel (\"\" when unset); a URL has any userinfo stripped",
                additionalProperties: { type: "string" },
              },
            },
          },
        },
      },
    },
    patch: {
      tags: ["Settings"],
      summary: "Update settings (ADMIN)",
      description: "Body is a flat map of string values (64 KB cap); keys outside the allow-list are ignored; a non-string or over-long value, or a new value failing its per-key rules, is a 400 and nothing is written. Resending a stored value (or the secret mask) is not a change: it is not validated, written, audited or held to the cooldown. A blank clears a key that can be cleared; for any other key it is reported in `ignored` when a stored value was kept. A key changed within the last 10 seconds is refused with 429 (exempt keys aside). New connection settings are tested against the candidate config BEFORE anything is written; a failed test writes nothing. 10 per minute per admin.",
      requestBody: {
        content: {
          "application/json": {
            schema: { type: "object", additionalProperties: { type: "string" }, description: "Arbitrary key-value pairs" },
          },
        },
      },
      responses: {
        "200": {
          description: "{ ok: true, ...connectivity test results, ignored? } — also the answer when nothing changed. `ignored` (additive) lists keys sent blank that can't be cleared and kept their stored value",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["ok"],
                properties: {
                  ok: { type: "boolean", enum: [true] },
                  radarrVersion: { type: "string", description: "Connection test passed: the instance's version (present only when the test ran)" },
                  sonarrVersion: { type: "string" },
                  radarr4kVersion: { type: "string" },
                  sonarr4kVersion: { type: "string" },
                  jellyfinTested: { type: "boolean", enum: [true] },
                  smtpTested: { type: "boolean", enum: [true], description: "A test email went to the requesting admin" },
                  ignored: { type: "array", items: { type: "string" }, description: "Additive: keys sent blank that can't be cleared" },
                },
              },
            },
          },
        },
        "400": { description: "Validation error (a non-string or over-long value, a new value failing its per-key rule, or a cross-field rule); nothing was written" },
        "413": { description: "Request body over the 64 KB cap" },
        "422": { description: "A connectivity test failed — nothing was written ({ ok: false, ...test results, ignored? })" },
        "429": { description: "Rate limited, or a key was changed within its 10s cooldown ({ error, retryAfterMs })" },
        "500": { description: "The settings and audit transaction failed — nothing was written" },
      },
    },
  },
  "/settings/arr-options": {
    get: {
      tags: ["Settings"],
      summary: "Get available quality profiles / root folders from Radarr and Sonarr (ADMIN)",
      parameters: [
        ARR_SERVICE_PARAM,
        { name: "instance", in: "query", schema: { type: "string" }, description: "Instance slug (\"\" = default); the legacy `variant=4k` is still honored when `instance` is absent" },
      ],
      responses: {
        "200": {
          description: "{ rootFolders, qualityProfiles, languageProfiles? } — languageProfiles only for a Sonarr v3 with usable ones",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["rootFolders", "qualityProfiles"],
                properties: {
                  rootFolders: {
                    type: "array",
                    description: "The instance's root folders, for the default-folder picker (ADMIN)",
                    items: { type: "object", properties: { path: { type: "string" } } },
                  },
                  qualityProfiles: { type: "array", items: { type: "object", properties: { id: { type: "integer" }, name: { type: "string" } } } },
                  languageProfiles: {
                    type: "array",
                    description: "Sonarr v3 with usable ones only; absent otherwise",
                    items: { type: "object", properties: { id: { type: "integer" }, name: { type: "string" } } },
                  },
                },
              },
            },
          },
        },
        "400": { description: "Invalid service or instance" },
        "422": { description: "That instance has no URL/API key configured" },
        "502": { description: "The instance could not be reached or refused the request" },
      },
    },
  },
  "/settings/plex/libraries": {
    get: {
      tags: ["Settings"],
      summary: "List available Plex libraries (ADMIN)",
      parameters: [{ name: "instance", in: "query", schema: { type: "string" }, description: "Plex instance slug; absent = the default server" }],
      responses: {
        "200": {
          description: "The server's library sections",
          content: {
            "application/json": {
              schema: {
                type: "array",
                description: "Movie and show sections only",
                items: { type: "object", properties: { key: { type: "string" }, title: { type: "string" }, type: { type: "string", enum: ["movie", "show"] } } },
              },
            },
          },
        },
        "400": { description: "Invalid instance slug" },
        "422": { description: "That server is not configured" },
        "502": { description: "Plex could not be reached" },
      },
    },
  },
  "/settings/jellyfin/libraries": {
    get: {
      tags: ["Settings"],
      summary: "List available Jellyfin libraries (ADMIN)",
      parameters: [{ name: "instance", in: "query", schema: { type: "string" }, description: "Jellyfin instance slug; absent = the default server" }],
      responses: {
        "200": {
          description: "The server's media folders",
          content: {
            "application/json": {
              schema: {
                type: "array",
                description: "Movie and TV folders only",
                items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, collectionType: { type: "string", enum: ["movies", "tvshows"] } } },
              },
            },
          },
        },
        "400": { description: "Invalid instance slug" },
        "422": { description: "That server is not configured" },
        "502": { description: "Jellyfin could not be reached" },
      },
    },
  },
  "/settings/test-ratings": {
    post: {
      tags: ["Settings"],
      summary: "Test MDBList / OMDB / Trakt / ipinfo connectivity with stored keys (ADMIN)",
      description: "A live upstream request per call. 10 per minute per admin.",
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["service"], properties: { service: { type: "string", enum: ["omdb", "mdblist", "trakt", "ipinfo"] } } } } } },
      responses: {
        "200": {
          description: "{ ok: true, message }",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["ok", "message"],
                properties: { ok: { type: "boolean", enum: [true] }, message: { type: "string", description: "Translated: what the test fetched" } },
              },
            },
          },
        },
        "400": { description: "Unknown service" },
        "413": tooLargeAnswer(16 * 1024),
        "422": { description: "{ ok: false, error } — the provider test failed" },
        "429": { description: "Rate limited" },
      },
    },
  },
  "/settings/webhook-urls": {
    get: {
      tags: ["Settings"],
      summary: "Radarr/Sonarr webhook tokens, fetched on demand for the copy buttons (ADMIN)",
      description: "Kept off the settings page's server-rendered payload so the secrets cross the wire only when an admin asks. radarr/sonarr fall back to the legacy shared secret; the 4K entries do not.",
      responses: {
        "200": {
          description: "{ radarr, sonarr, radarr4k, sonarr4k } — each a token string or null",
          content: {
            "application/json": {
              schema: {
                type: "object",
                description: "Plaintext webhook tokens (ADMIN only, `private, no-store`) — fetched on a copy click, never in a page payload",
                properties: {
                  radarr: { type: "string", nullable: true, description: "Falls back to the legacy shared secret" },
                  sonarr: { type: "string", nullable: true, description: "Falls back to the legacy shared secret" },
                  radarr4k: { type: "string", nullable: true },
                  sonarr4k: { type: "string", nullable: true },
                },
              },
            },
          },
        },
        "429": { description: "More than 30 reads a minute by this admin (Retry-After set)", headers: RETRY_AFTER_HEADER },
      },
    },
  },
};
