// Authentication helpers (the sign-in handshakes themselves are not documented here).

import { tooLargeAnswer, OK_TRUE } from "../shared";
import type { OpenApiPaths } from "../types";

export const authPaths: OpenApiPaths = {
  "/auth/setup-status": {
    get: {
      tags: ["Auth"],
      summary: "Check whether initial admin setup is required",
      security: [],
      responses: {
        "200": { description: "Setup status", content: { "application/json": { schema: { type: "object", properties: { needsSetup: { type: "boolean" } } } } } },
        "429": { description: "Rate limited (30/min per client IP)" },
      },
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
              required: ["email", "password"],
              properties: {
                email: { type: "string", format: "email", maxLength: 254 },
                name: { type: "string", nullable: true, maxLength: 100 },
                password: { type: "string", minLength: 12, description: "12 characters minimum; also capped at MAX_PASSWORD_LENGTH" },
              },
            },
          },
        },
      },
      description: "First-run bootstrap ONLY: creates the initial ADMIN and never signs anyone in (no token or cookie in the response). Once any user exists or setup has completed it answers 403. Body capped at 16 KB; browsers must send a matching Origin (native clients are exempt via Authorization / X-Summonarr-Client).",
      responses: {
        "201": { description: "Initial admin created", content: { "application/json": { schema: { type: "object", properties: { id: { type: "string" }, email: { type: "string" }, name: { type: "string", nullable: true }, role: { type: "string" } } } } } },
        "400": { description: "Validation error (missing/invalid email or password, password too short or too long, name too long)" },
        "403": { description: "Registration is closed (a user already exists / setup completed), local login is disabled, or the Origin check failed" },
        "413": tooLargeAnswer(16 * 1024),
        "429": { description: "Rate limited: 30 attempts per 15 minutes per address before anything is read, then rateLimitRegister (default 5 per 15 minutes per address)" },
        "503": { description: "Maintenance mode" },
      },
    },
  },
  "/auth/plex/client-id": {
    get: {
      tags: ["Auth"],
      summary: "Get the signed-in user's stored Plex client ID",
      description: "Not an app-wide id: it is the caller's own stored Plex client identifier. An anonymous caller, or a user with none stored, gets `{ clientId: null }` with status 200 (never a 401).",
      security: [],
      responses: { "200": { description: "The caller's Plex client ID, or null", content: { "application/json": { schema: { type: "object", required: ["clientId"], properties: { clientId: { type: "string", nullable: true } } } } } } },
    },
  },
  "/auth/jellyfin/servers": {
    get: {
      tags: ["Auth"],
      summary: "List the configured Jellyfin servers available for sign-in",
      description:
        "Public pre-auth picker source for clients that cannot render the login page's server component. Only fully configured instances (server URL + API key) are listed, default (\"\") first. Returns an empty list — not a 404 — when Jellyfin is not configured. Rate-limited per IP.",
      security: [],
      responses: {
        "200": {
          description: "Configured Jellyfin instances",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  servers: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        slug: { type: "string", description: "Instance key; \"\" is the default server" },
                        name: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "429": { description: "Rate limited" },
      },
    },
  },
  "/auth/jellyfin/quickconnect": {
    get: {
      tags: ["Auth"],
      summary: "Poll a QuickConnect secret for approval (public)",
      description:
        "Public — native clients poll this before any session exists. `wait=1` upgrades to a server-side long poll (25s budget, 2s ticks) instead of a single upstream check.",
      security: [],
      parameters: [
        { name: "secret", in: "query", required: true, schema: { type: "string" } },
        { name: "wait", in: "query", schema: { type: "string", enum: ["1"] }, description: "Set to 1 to long-poll instead of returning immediately" },
        { name: "instance", in: "query", schema: { type: "string" }, description: "Media-instance slug; defaults to the default instance" },
      ],
      responses: {
        "200": { description: "Poll result", content: { "application/json": { schema: { type: "object", properties: { authenticated: { type: "boolean" } } } } } },
        "400": { description: "Missing secret or invalid instance slug" },
        "410": { description: "QuickConnect session expired or no longer known upstream" },
        "429": { description: "Rate limited — 60/min per IP, 30/min per secret" },
        "499": { description: "Client aborted during a long poll (non-standard)" },
        "502": { description: "QuickConnect disabled upstream, or the poll failed. The disabled case adds `code: \"quickconnect_disabled\"` (terminal: stop polling)" },
        "503": { description: "Jellyfin not configured (final: stop polling), or the route is busy — its poll budget is full or long-poll capacity reached (3/IP, 50 global). A busy answer adds `retry: true` (additive): wait a few seconds and poll again" },
      },
    },
    post: {
      tags: ["Auth"],
      summary: "Initiate a Jellyfin QuickConnect login (public)",
      description:
        "Takes NO request body — the instance is selected via the query string. The instance is pinned into a signed flow cookie here and read back from that verified cookie on redemption, never from a client-supplied field. Poll for approval with GET on this path.",
      security: [],
      parameters: [
        { name: "instance", in: "query", schema: { type: "string" }, description: "Media-instance slug; defaults to the default instance" },
      ],
      responses: {
        "200": {
          description: "QuickConnect initiation state (code, secret). A caller sending X-Summonarr-Client also gets `flowState` (the signed flow token to present at sign-in); browsers get it as an HttpOnly cookie instead",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["code", "secret"],
                properties: {
                  code: { type: "string", description: "The code the user enters in a signed-in Jellyfin client" },
                  secret: { type: "string", description: "Jellyfin's QuickConnect secret — poll GET with it, then redeem it at sign-in" },
                  flowState: { type: "string", description: "Only for a caller sending X-Summonarr-Client: the signed flow token (the HttpOnly cookie's value) to present at sign-in" },
                },
              },
            },
          },
        },
        "400": { description: "Invalid instance slug" },
        "429": { description: "Rate limited — 10/min per IP" },
        "502": { description: "QuickConnect is disabled or unavailable upstream. The disabled case adds `code: \"quickconnect_disabled\"`" },
        "503": { description: "Jellyfin not configured" },
      },
    },
  },
  "/auth/me": {
    get: {
      tags: ["Auth"],
      summary: "Get the current authenticated session (cookie or bearer)",
      responses: {
        "200": {
          description: "Current session. Never cached (no-store); a re-signed cookie is appended for browsers only",
          content: { "application/json": { schema: { type: "object", properties: { session: { type: "object", properties: { user: { type: "object", properties: { id: { type: "string" }, role: { type: "string" }, permissions: { type: "string", description: "Decimal bitmask" }, email: { type: "string", nullable: true }, name: { type: "string", nullable: true }, provider: { type: "string" }, mediaServer: { type: "string", nullable: true } } }, expiresAt: { type: "integer", description: "Unix seconds" } } } } } } },
        },
        "401": { description: "Not authenticated — body is { session: null }" },
      },
    },
  },
  "/auth/sign-out": {
    post: {
      tags: ["Auth"],
      summary: "Sign out the current session (clears cookie / revokes session)",
      description: "Always 200 { ok: true } and clears the cookies, even when there was no session or the server-side revoke failed. Bearer token is read before the cookie.",
      responses: { "200": { description: "Signed out ({ ok: true })", content: { "application/json": { schema: OK_TRUE } } } },
    },
  },
};
