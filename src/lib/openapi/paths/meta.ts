// Health and readiness, public client capability negotiation, and the server-sent events stream.

import type { OpenApiPaths } from "../types";

export const metaPaths: OpenApiPaths = {
  "/health": {
    get: {
      tags: ["Health"],
      summary: "Readiness probe (public)",
      description:
        "Not a bare liveness reply — it pings Postgres with SELECT 1 and returns 503 when the database is unreachable, so an orchestrator restarts a live Node process fronting a dead DB. This is the Docker/compose HEALTHCHECK target.",
      security: [],
      responses: {
        "200": {
          description: "Service and database are up",
          content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" }, db: { type: "string", enum: ["up"] } } } } },
        },
        "503": {
          description: "Database unreachable — the container should be considered unhealthy",
          content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" }, db: { type: "string", enum: ["down"] } } } } },
        },
      },
    },
  },
  "/config/compat": {
    get: {
      tags: ["Config"],
      summary: "Public client capability descriptor (integers only)",
      security: [],
      responses: {
        "200": {
          description: "API contract floor/ceiling and minimum client build",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  apiVersion: { type: "integer" },
                  minApiVersion: { type: "integer" },
                  minClient: { type: "object", additionalProperties: { type: "integer" } },
                },
              },
            },
          },
        },
      },
    },
  },
  "/config/public": {
    get: {
      tags: ["Config"],
      summary: "User-readable client configuration (AUTHENTICATED)",
      description:
        "Despite the path name this requires a session — it is not in isPublicPath and is wrapped in withAuth. \"Public\" here means the non-sensitive slice of admin config a signed-in client may read, not unauthenticated. It carries NO sign-in provider information; for pre-auth capability negotiation use /config/compat.",
      responses: {
        "200": {
          description: "User-readable config slice",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  recommendedIosBuild: { type: "integer", description: "Soft-upgrade hint. OMITTED unless set to a valid integer >= 1 — clients key off the field's presence." },
                  siteTitle: { type: "string", nullable: true },
                  motd: { type: "object", properties: { enabled: { type: "boolean" }, title: { type: "string", nullable: true }, body: { type: "string", nullable: true } } },
                  donate: {
                    type: "object",
                    description: "Each value passes through safeExternalHref; non-http(s) values collapse to null.",
                    required: ["paypal", "venmo", "zelle", "amazon", "patreon", "buyMeACoffee"],
                    properties: {
                      paypal: { type: "string", nullable: true },
                      venmo: { type: "string", nullable: true },
                      zelle: { type: "string", nullable: true },
                      amazon: { type: "string", nullable: true },
                      patreon: { type: "string", nullable: true },
                      buyMeACoffee: { type: "string", nullable: true },
                    },
                  },
                  features: { type: "object", additionalProperties: { type: "boolean" }, description: "The feature.* flag map" },
                },
              },
            },
          },
        },
        "401": { description: "Unauthenticated" },
      },
    },
  },
  "/events": {
    get: {
      tags: ["Events"],
      summary: "Server-sent events stream for real-time UI updates",
      description: "A heartbeat every 25 seconds; the session is re-validated against the database every minute (a revoked or demoted session stops receiving admin/issue/request frames), and the stream is closed after one hour, so clients reconnect. At most 5 concurrent streams per user and SSE_MAX_LISTENERS (default 500) in total. The inbox frames (`request:updated`, `request:comment`, `issue:updated`, `issuemessage:created`) carry a boolean `own` (additive): true when the event is about the viewer, so a client re-reads its inbox only for those — never the other user's id. `issuemessage:created` also carries `messageId` (additive), the new message's id, so a client already showing it skips the re-read.",
      responses: {
        "200": {
          description: "SSE stream",
          content: { "text/event-stream": { schema: { type: "string" } } },
        },
        "401": { description: "Not signed in" },
        "429": { description: "Too many SSE connections (per user or in total)" },
        "503": { description: "Maintenance mode" },
      },
    },
  },
};
