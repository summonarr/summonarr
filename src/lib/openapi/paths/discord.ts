// Discord account linking and the bot's role sync.

import { STEP_UP_401, tooLargeAnswer, OK_TRUE } from "../shared";
import type { OpenApiPaths } from "../types";
import { LINK_SECOND_FACTOR_400, LINK_SECOND_FACTOR_FIELD } from "./profile";

export const discordPaths: OpenApiPaths = {
  "/discord/generate-link": {
    post: {
      tags: ["Discord"],
      summary: "Issue a short-lived token to link a Discord account to the current user",
      description: "The token lives 10 minutes and replaces any earlier one for the caller. With `discordId` only that Discord account can redeem it; without, any Discord account that sees it can. 5 per 10 minutes per user. Requires a step-up: a password account sends `confirmPassword`; an SSO account must have signed in within the last 5 minutes. An account with an active second factor also sends `secondFactor`. Audited.",
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                discordId: { type: "string", description: "Discord snowflake (17–20 digits); present but malformed is a 400" },
                confirmPassword: { type: "string", description: "The current password (password accounts)" },
                secondFactor: LINK_SECOND_FACTOR_FIELD,
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Link token",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  token: { type: "string" },
                  expiresAt: { type: "string", format: "date-time" },
                },
              },
            },
          },
        },
        "400": { description: `\`discordId\` is present but not a valid snowflake, or ${LINK_SECOND_FACTOR_400}` },
        "401": STEP_UP_401,
        "403": { description: "The Discord integration is switched off (feature.integration.discord)" },
        "413": tooLargeAnswer(16 * 1024),
        "429": { description: "Rate limited, or a two-factor code lockout" },
      },
    },
  },
  "/discord/initiate-merge": {
    post: {
      tags: ["Discord"],
      summary: "Start Discord account merge flow",
      description: "DMs a 12-character code (valid 10 minutes) to the given Discord account through the bot. Deliberately does not say whether that Discord id is already linked; that surfaces at confirm-merge. A WEB session needs a step-up (a password account sends `confirmPassword`; an SSO account must have signed in within the last 5 minutes), and on an account with an active second factor `secondFactor` too; a native-app session is exempt from both.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: { type: "object", required: ["discordId"], properties: { discordId: { type: "string", description: "Discord snowflake (17–20 digits)" }, confirmPassword: { type: "string", description: "The current password (web sessions of password accounts)" }, secondFactor: LINK_SECOND_FACTOR_FIELD } } } },
      },
      responses: {
        "200": { description: "{ ok: true } — the code was DMed (it is never returned)", content: { "application/json": { schema: OK_TRUE } } },
        "400": { description: `Invalid Discord user id, or (web session) ${LINK_SECOND_FACTOR_400}` },
        "401": STEP_UP_401,
        "403": { description: "The Discord integration is switched off (feature.integration.discord)" },
        "413": tooLargeAnswer(16 * 1024),
        "429": { description: "More than 10 initiations an hour, 3 per target Discord id per 15 minutes, or a two-factor code lockout" },
        "502": { description: "The bot could not open or send the DM" },
        "503": { description: "No Discord bot token configured" },
      },
    },
  },
  "/discord/confirm-merge": {
    post: {
      tags: ["Discord"],
      summary: "Confirm Discord account merge",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["code"],
              properties: { code: { type: "string", description: "The 12-character code the bot sent by DM (case and surrounding whitespace are ignored)" } },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "{ ok: true, migrated, discordId }",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["ok", "migrated", "discordId"],
                properties: {
                  ok: { type: "boolean", enum: [true] },
                  migrated: { type: "integer", minimum: 0, description: "Requests moved over from the Discord-only account (0 when there was none)" },
                  discordId: { type: "string", description: "The Discord user id now linked" },
                },
              },
            },
          },
        },
        "400": { description: "No pending code, expired, or incorrect code" },
        "403": { description: "The Discord integration is switched off (feature.integration.discord)" },
        "409": { description: "The Discord account is already linked to another user" },
        "413": tooLargeAnswer(16 * 1024),
        "429": { description: "{ error: \"rate_limit\", message } — more than 5 attempts in 10 minutes; the pending code is deleted" },
        "500": { description: "The merge failed unexpectedly; nothing changed and the code stays redeemable" },
      },
    },
  },
  "/discord/sync-roles": {
    post: {
      tags: ["Discord"],
      summary: "Sync Discord roles for every linked account (ADMIN)",
      description: "Assigns the linked/server/admin roles to every active linked account (shadow `@discord.local` accounts excluded) and strips them from deactivated ones. Audited SETTINGS_CHANGE.",
      responses: {
        "200": {
          description: "{ synced, revoked, failed, skipped }: synced/revoked count the members Discord accepted, failed the ones with a refused or failed call, skipped the ones with nothing to do (integration off, no guild or role configured). Just { synced: 0 } when no account is linked or deactivated.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["synced"],
                properties: {
                  synced: { type: "integer", minimum: 0 },
                  revoked: { type: "integer", minimum: 0, description: "Absent when no account was linked or disabled (then `synced` is 0)" },
                  failed: { type: "integer", minimum: 0, description: "Absent when nothing was synced" },
                  skipped: { type: "integer", minimum: 0, description: "Absent when nothing was synced" },
                },
              },
            },
          },
        },
        "403": { description: "Not ADMIN" },
      },
    },
  },
  "/discord/register-commands": {
    post: {
      tags: ["Discord"],
      summary: "Register Discord slash commands (ADMIN)",
      description: "Pushes the slash commands with the stored bot token and client id, to the guild when a guild id is stored, else globally.",
      responses: {
        "200": {
          description: "{ ok: true, message }",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["ok", "message"],
                properties: { ok: { type: "boolean", enum: [true] }, message: { type: "string", description: "Where the commands were registered (the guild, or globally), in the caller's language" } },
              },
            },
          },
        },
        "400": { description: "Bot token or client id is not configured" },
        "403": { description: "Not ADMIN" },
        "502": { description: "Discord refused the registration" },
      },
    },
  },
  "/discord/status": {
    get: {
      tags: ["Discord"],
      summary: "Whether the caller has a linked Discord account",
      responses: {
        "200": {
          description: "{ discordId, linked }",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["discordId", "linked"],
                properties: { discordId: { type: "string", nullable: true }, linked: { type: "boolean" } },
              },
            },
          },
        },
      },
    },
  },
  "/discord/unlink": {
    post: {
      tags: ["Discord"],
      summary: "Unlink the caller's Discord account",
      responses: {
        "200": {
          description: "{ ok: true } — also strips the Discord roles Summonarr granted, in the background",
          content: { "application/json": { schema: OK_TRUE } },
        },
      },
    },
  },
};
