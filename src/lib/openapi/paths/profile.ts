// The signed-in user's own profile, two-factor enrollment, Trakt, calendar feed,
// and push subscriptions.

import { LOCALES } from "@/lib/i18n/locales";
import { RECOVERY_CODE_COUNT } from "@/lib/mfa/recovery-codes";
import { SUPPORTED_COSE_ALGS } from "@/lib/mfa/webauthn";
import {
  NOTIFICATION_PREF_FLAGS,
  STEP_UP_401,
  tooLargeAnswer,
  RETRY_AFTER_HEADER,
  OK_TRUE,
} from "../shared";
import type { OpenApiSchema, OpenApiPaths } from "../types";

// Body of every two-factor ENROLLMENT change (guardrail 6d): the current
// password, plus — once the account has an active factor — a fresh second factor.
const MFA_SECOND_FACTOR_SCHEMA = {
  type: "object",
  description:
    "Required once the account has an active second factor (omit for the first factor). { method: \"totp\" | \"recovery\", code } or { method: \"webauthn\", credential, challengeToken } with the challenge from POST /profile/mfa/challenge. A recovery code used here is spent.",
  required: ["method"],
  properties: {
    method: { type: "string", enum: ["totp", "recovery", "webauthn"] },
    code: { type: "string" },
    credential: { type: "object", description: "PublicKeyCredential JSON (assertion response, base64url)" },
    challengeToken: { type: "string" },
  },
} satisfies OpenApiSchema;

const MFA_STEP_UP_400 =
  "Missing or wrong password, or a missing/invalid second factor ({ error, secondFactorRequired: true, methods? })";

function mfaStepUpBody(extra: Record<string, OpenApiSchema> = {}, extraRequired: string[] = []): OpenApiSchema {
  return {
    type: "object",
    required: ["password", ...extraRequired],
    properties: { password: { type: "string" }, secondFactor: MFA_SECOND_FACTOR_SCHEMA, ...extra },
  };
}

// The one-time recovery codes a two-factor enrollment shows once
// (generateRecoveryCodes, src/lib/mfa/recovery-codes.ts): 16 symbols with no
// I/O/0/1, in dash-joined groups of 4. Only their hashes are stored.
const MFA_RECOVERY_CODES = {
  type: "array",
  minItems: RECOVERY_CODE_COUNT,
  maxItems: RECOVERY_CODE_COUNT,
  items: { type: "string", pattern: "^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$" },
  description: "Shown once — only their hashes are stored",
} satisfies OpenApiSchema;

// The answer of a second-factor enrollment (TOTP enable, passkey add): the
// recovery codes come only with the account's FIRST factor, which also signs out
// every other session.
const MFA_FACTOR_ADDED = {
  type: "object",
  required: ["ok"],
  properties: {
    ok: { type: "boolean", enum: [true] },
    recoveryCodes: { ...MFA_RECOVERY_CODES, description: "Only when this is the account's first factor; shown once" },
  },
} satisfies OpenApiSchema;

// One of the caller's own passkeys named to the browser for a WebAuthn
// ceremony (allowCredentials / excludeCredentials): a public credential id.
const WEBAUTHN_CREDENTIAL_DESCRIPTOR = {
  type: "object",
  required: ["type", "id", "transports"],
  properties: {
    type: { type: "string", enum: ["public-key"] },
    id: { type: "string", description: "The credential id, base64url" },
    transports: { type: "array", items: { type: "string" } },
  },
} satisfies OpenApiSchema;

// The caller's Trakt connection (TraktProfileState, src/lib/trakt-user.ts):
// GET /profile/trakt and the PATCH that answers the same body.
const TRAKT_PROFILE_STATE = {
  type: "object",
  properties: {
    available: { type: "boolean", description: "The admin saved a Trakt client id AND secret, and the caller has a use for a connection" },
    uses: {
      type: "object",
      properties: {
        watchlist: { type: "boolean", description: "feature.behavior.watchlistAutoRequest is on and the caller holds an AUTO_REQUEST* bit" },
        history: { type: "boolean", description: "feature.page.forYou is on" },
      },
    },
    connected: { type: "boolean", description: "A Trakt grant is stored for the caller" },
    username: { type: "string", nullable: true },
    watchlistAutoRequest: { type: "boolean", description: "File new Trakt watchlist titles as requests" },
    historySeeds: { type: "boolean", description: "Seed For You from the Trakt watch history" },
    status: { type: "string", nullable: true, enum: ["ok", "error", "reauth", null], description: "The last sync's verdict; \"reauth\" means Trakt refused the grant — reconnect" },
    syncedAt: { type: "string", format: "date-time", nullable: true },
  },
} satisfies OpenApiSchema;

export const profilePaths: OpenApiPaths = {
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
                newPassword: { type: "string", minLength: 12, maxLength: 1024 },
                // Guardrail 6i: an account with two-factor also proves a fresh
                // second factor; checked only after the password verified.
                secondFactor: MFA_SECOND_FACTOR_SCHEMA,
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Password updated ({ ok, requiresRelogin }) — every session is revoked",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["ok", "requiresRelogin"],
                properties: {
                  ok: { type: "boolean", enum: [true] },
                  requiresRelogin: { type: "boolean", enum: [true], description: "Every session, this one included, was revoked — sign in again with the new password" },
                },
              },
            },
          },
        },
        "400": { description: `${MFA_STEP_UP_400}, or a validation error (newPassword missing, under 12 or over 1024 characters). An account with two-factor gets secondFactorRequired until it sends secondFactor` },
        "401": { description: "User row not found" },
        "403": { description: "SSO account — local passwords are not available" },
        "413": tooLargeAnswer(16 * 1024),
        "429": { description: "Too many attempts (5 per 15 minutes per user), or code entry is locked", headers: RETRY_AFTER_HEADER },
        "503": { description: "Maintenance mode (non-ADMIN callers)" },
      },
    },
  },
  // ── Two-factor authentication (local-credentials accounts only) ──────────
  // Every enrollment CHANGE takes the current password in the body (step-up);
  // once the account has an active factor it ALSO takes `secondFactor` (a
  // current TOTP code, an unused recovery code — spent — or a passkey assertion
  // over a /profile/mfa/challenge challenge). The first factor is
  // password-only. 403 = not a local-credentials account; 429 = too many
  // step-up attempts or the persistent code lockout. The sign-in half
  // (POST /auth/sign-in/mfa) is a handshake documented in SECURITY.md.
  "/profile/mfa": {
    get: {
      tags: ["Profile"],
      summary: "Read the caller's two-factor status",
      responses: {
        "200": {
          description:
            "{ available, enabled, totpEnabled, passkeys: [{ id, name, transports, backedUp, createdAt, lastUsedAt }], recoveryCodesRemaining, webauthnAvailable } — never a secret",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["available", "enabled", "totpEnabled", "passkeys", "recoveryCodesRemaining", "webauthnAvailable"],
                properties: {
                  available: { type: "boolean", description: "Two-factor applies: a local-credentials account with a password" },
                  enabled: { type: "boolean", description: "At least one second factor is active" },
                  totpEnabled: { type: "boolean" },
                  passkeys: {
                    type: "array",
                    description: "The caller's passkeys, oldest first — names and dates only, never the credential or its key",
                    items: {
                      type: "object",
                      required: ["id", "name", "transports", "backedUp", "createdAt", "lastUsedAt"],
                      properties: {
                        id: { type: "string", description: "Summonarr's id for the passkey (PATCH/DELETE /profile/mfa/passkeys/{id})" },
                        name: { type: "string" },
                        transports: { type: "array", items: { type: "string" } },
                        backedUp: { type: "boolean" },
                        createdAt: { type: "string", format: "date-time" },
                        lastUsedAt: { type: "string", format: "date-time", nullable: true },
                      },
                    },
                  },
                  recoveryCodesRemaining: { type: "integer", minimum: 0 },
                  webauthnAvailable: { type: "boolean", description: "AUTH_URL names a relying party, so passkeys can be used" },
                },
              },
            },
          },
        },
      },
    },
    delete: {
      tags: ["Profile"],
      summary: "Turn two-factor off (removes every factor and recovery code)",
      requestBody: { required: true, content: { "application/json": { schema: mfaStepUpBody() } } },
      responses: {
        "200": { description: "Turned off; every OTHER session is signed out", content: { "application/json": { schema: OK_TRUE } } },
        "400": { description: MFA_STEP_UP_400 },
        "403": { description: "Not a local-credentials account" },
        "413": tooLargeAnswer(64 * 1024),
        "429": { description: "Too many step-up attempts, or code entry is locked" },
      },
    },
  },
  "/profile/mfa/challenge": {
    post: {
      tags: ["Profile"],
      summary: "A fresh WebAuthn challenge for confirming an enrollment change with a passkey",
      responses: {
        "200": {
          description: "{ challengeToken, publicKey } — publicKey is PublicKeyCredentialRequestOptions (base64url); send the assertion back as secondFactor { method: \"webauthn\", credential, challengeToken }. Single-use, 5-minute, bound to this user and session",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["challengeToken", "publicKey"],
                properties: {
                  challengeToken: { type: "string", description: "Signed, single-use, 5-minute token bound to this user and session — send it back with the assertion" },
                  publicKey: {
                    type: "object",
                    description: "PublicKeyCredentialRequestOptions, binary fields base64url",
                    required: ["challenge", "rpId", "allowCredentials", "userVerification", "timeout"],
                    properties: {
                      challenge: { type: "string", description: "32 random bytes, base64url" },
                      rpId: { type: "string" },
                      allowCredentials: { type: "array", items: WEBAUTHN_CREDENTIAL_DESCRIPTOR },
                      userVerification: { type: "string", enum: ["preferred"] },
                      timeout: { type: "integer", description: "Milliseconds — the token's lifetime" },
                    },
                  },
                },
              },
            },
          },
        },
        "400": { description: "The account has no passkeys" },
        "401": { description: "The session carries no session id" },
        "403": { description: "Not a local-credentials account" },
        "429": { description: "Too many challenges", headers: RETRY_AFTER_HEADER },
        "503": { description: "AUTH_URL is not configured, so no WebAuthn RP ID exists" },
      },
    },
  },
  "/profile/mfa/totp/setup": {
    post: {
      tags: ["Profile"],
      summary: "Issue a pending authenticator-app (TOTP) secret",
      requestBody: { required: true, content: { "application/json": { schema: mfaStepUpBody() } } },
      responses: {
        "200": {
          description: "{ secret, otpauthUri } — shown once; nothing changes until /totp/enable confirms a code",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["secret", "otpauthUri"],
                properties: {
                  secret: { type: "string", pattern: "^[A-Z2-7]+$", description: "The new authenticator secret (RFC 4648 base32, unpadded), shown once — nothing is enabled until /totp/enable confirms a code" },
                  otpauthUri: { type: "string", pattern: "^otpauth://totp/", description: "The same secret as an otpauth:// URI, for a QR code" },
                },
              },
            },
          },
        },
        "400": { description: MFA_STEP_UP_400 },
        "409": { description: "An authenticator app is already enabled" },
        "413": tooLargeAnswer(64 * 1024),
        "429": { description: "Too many step-up attempts, or code entry is locked" },
      },
    },
  },
  "/profile/mfa/totp/enable": {
    post: {
      tags: ["Profile"],
      summary: "Confirm the pending TOTP secret with a current code",
      requestBody: {
        required: true,
        content: { "application/json": { schema: { type: "object", required: ["code"], properties: { code: { type: "string", example: "123456" } } } } },
      },
      responses: {
        "200": {
          description: "{ ok, recoveryCodes? } — recoveryCodes (shown once) when this is the first factor, which also signs out every other session",
          content: { "application/json": { schema: MFA_FACTOR_ADDED } },
        },
        "400": { description: "No pending setup, or the code didn't match" },
        "409": { description: "Already enabled" },
        "413": tooLargeAnswer(4 * 1024),
        "429": { description: "Too many attempts — 10 per 15 minutes per user", headers: RETRY_AFTER_HEADER },
      },
    },
  },
  "/profile/mfa/totp": {
    delete: {
      tags: ["Profile"],
      summary: "Remove the authenticator app",
      requestBody: { required: true, content: { "application/json": { schema: mfaStepUpBody() } } },
      responses: {
        "200": {
          description: "Removed (recovery codes too, and every OTHER session signed out, when no passkey remains)",
          content: { "application/json": { schema: OK_TRUE } },
        },
        "400": { description: MFA_STEP_UP_400 },
        "404": { description: "No authenticator app set up" },
        "413": tooLargeAnswer(64 * 1024),
        "429": { description: "Too many step-up attempts, or code entry is locked" },
      },
    },
  },
  "/profile/mfa/recovery-codes": {
    post: {
      tags: ["Profile"],
      summary: "Replace every recovery code with ten new ones",
      requestBody: { required: true, content: { "application/json": { schema: mfaStepUpBody() } } },
      responses: {
        "200": {
          description: "{ recoveryCodes } — shown once; only hashes are stored",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["recoveryCodes"],
                properties: { recoveryCodes: MFA_RECOVERY_CODES },
              },
            },
          },
        },
        "400": { description: `${MFA_STEP_UP_400}, or two-factor is off` },
        "413": tooLargeAnswer(64 * 1024),
        "429": { description: "Too many step-up attempts, or code entry is locked" },
      },
    },
  },
  "/profile/mfa/passkeys/options": {
    post: {
      tags: ["Profile"],
      summary: "Begin adding a passkey — WebAuthn creation options",
      requestBody: { required: true, content: { "application/json": { schema: mfaStepUpBody() } } },
      responses: {
        "200": {
          description: "{ registrationToken, publicKey } — publicKey is PublicKeyCredentialCreationOptions with base64url binary fields; the token is single-use, 5-minute, bound to this user and session",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["registrationToken", "publicKey"],
                properties: {
                  registrationToken: { type: "string", description: "Signed, single-use, 5-minute token bound to this user and session — send it back with the attestation (POST /profile/mfa/passkeys)" },
                  publicKey: {
                    type: "object",
                    description: "PublicKeyCredentialCreationOptions, binary fields base64url",
                    required: ["rp", "user", "challenge", "pubKeyCredParams", "timeout", "attestation", "authenticatorSelection", "excludeCredentials"],
                    properties: {
                      rp: { type: "object", required: ["id", "name"], properties: { id: { type: "string" }, name: { type: "string" } } },
                      user: {
                        type: "object",
                        required: ["id", "name", "displayName"],
                        properties: {
                          id: { type: "string", description: "The account's WebAuthn user handle: a hash of its id, base64url — never the email" },
                          name: { type: "string" },
                          displayName: { type: "string" },
                        },
                      },
                      challenge: { type: "string", description: "32 random bytes, base64url" },
                      pubKeyCredParams: {
                        type: "array",
                        items: {
                          type: "object",
                          required: ["type", "alg"],
                          properties: { type: { type: "string", enum: ["public-key"] }, alg: { type: "integer", enum: SUPPORTED_COSE_ALGS, description: "COSE algorithm id" } },
                        },
                      },
                      timeout: { type: "integer", description: "Milliseconds — the token's lifetime" },
                      attestation: { type: "string", enum: ["none"] },
                      authenticatorSelection: {
                        type: "object",
                        properties: {
                          residentKey: { type: "string", enum: ["discouraged"] },
                          requireResidentKey: { type: "boolean", enum: [false] },
                          userVerification: { type: "string", enum: ["preferred"] },
                        },
                      },
                      excludeCredentials: { type: "array", items: WEBAUTHN_CREDENTIAL_DESCRIPTOR, description: "The passkeys already registered, so the authenticator won't enroll one twice" },
                    },
                  },
                },
              },
            },
          },
        },
        "400": { description: `${MFA_STEP_UP_400}, or the passkey limit is reached` },
        "401": { description: "The session carries no session id" },
        "413": tooLargeAnswer(64 * 1024),
        "429": { description: "Too many step-up attempts, or code entry is locked" },
        "503": { description: "AUTH_URL is not configured, so no WebAuthn RP ID exists" },
      },
    },
  },
  "/profile/mfa/passkeys": {
    post: {
      tags: ["Profile"],
      summary: "Finish adding a passkey",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["registrationToken", "credential"],
              properties: {
                registrationToken: { type: "string" },
                name: { type: "string", maxLength: 64 },
                credential: { type: "object", description: "PublicKeyCredential JSON (attestation response, base64url)" },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "{ ok, recoveryCodes? } — recoveryCodes when this is the first factor, which also signs out every other session",
          content: { "application/json": { schema: MFA_FACTOR_ADDED } },
        },
        "400": { description: "Expired/foreign registration token, a token issued on the password alone to an account that has since gained a factor, or the response failed verification" },
        "409": { description: "That credential is already registered" },
        "413": tooLargeAnswer(64 * 1024),
        "503": { description: "AUTH_URL is not configured, so no WebAuthn RP ID exists" },
      },
    },
  },
  "/profile/mfa/passkeys/{id}": {
    patch: {
      tags: ["Profile"],
      summary: "Rename one of the caller's passkeys",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      requestBody: {
        required: true,
        content: { "application/json": { schema: mfaStepUpBody({ name: { type: "string", maxLength: 64 } }, ["name"]) } },
      },
      responses: { "200": { description: "Renamed", content: { "application/json": { schema: OK_TRUE } } }, "400": { description: `${MFA_STEP_UP_400}, or an empty name` }, "404": { description: "Not the caller's passkey" }, "413": tooLargeAnswer(64 * 1024), "429": { description: "Too many step-up attempts, or code entry is locked" } },
    },
    delete: {
      tags: ["Profile"],
      summary: "Remove one of the caller's passkeys",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      requestBody: { required: true, content: { "application/json": { schema: mfaStepUpBody() } } },
      responses: {
        "200": {
          description: "Removed (recovery codes too, and every OTHER session signed out, when it was the last factor)",
          content: { "application/json": { schema: OK_TRUE } },
        },
        "400": { description: MFA_STEP_UP_400 },
        "404": { description: "Not the caller's passkey" },
        "413": tooLargeAnswer(64 * 1024),
        "429": { description: "Too many step-up attempts, or code entry is locked" },
      },
    },
  },
  "/profile/locale": {
    patch: {
      tags: ["Profile"],
      summary: "Store the caller's UI language (used for emails, push and Discord DMs)",
      requestBody: {
        required: true,
        content: { "application/json": { schema: { type: "object", required: ["locale"], properties: { locale: { type: "string", enum: [...LOCALES] } } } } },
      },
      responses: {
        "200": { description: "Stored — { locale }", content: { "application/json": { schema: { type: "object", properties: { locale: { type: "string", enum: [...LOCALES] } } } } } },
        "400": { description: "Unsupported locale" },
        "413": tooLargeAnswer(1024),
        "503": { description: "Maintenance mode (non-ADMIN callers)" },
      },
    },
  },
  "/profile/notifications": {
    get: {
      tags: ["Profile"],
      summary: "Read the caller's notification preferences",
      responses: {
        "200": {
          description: "Preference flags",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  ...NOTIFICATION_PREF_FLAGS,
                  notificationEmail: { type: "string", nullable: true },
                  emailEnabled: {
                    type: "boolean",
                    description:
                      "True only when the email feature, the notification-email switch AND a configured transport all line up. Clients hide the email section when false, since the channel can never send.",
                  },
                },
              },
            },
          },
        },
        "404": { description: "User row not found" },
      },
    },
    patch: {
      tags: ["Profile"],
      summary: "Update notification preferences",
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                ...NOTIFICATION_PREF_FLAGS,
                notificationEmail: {
                  type: "string", nullable: true,
                  description: "Jellyfin-provider accounts only — any other provider gets 403. Null or blank clears it. A NEW address is also 403: it must be verified through POST /profile/notification-email (mails a one-time link, bound when it is confirmed); only a write-back of the currently stored address is accepted here.",
                },
              },
            },
          },
        },
      },
      responses: {
        "200": { description: "Preferences updated — { ok: true }", content: { "application/json": { schema: OK_TRUE } } },
        "400": { description: "No valid field in the body, or a malformed notificationEmail" },
        "403": { description: "notificationEmail was sent by a non-Jellyfin account, or names a new unverified address" },
        "413": tooLargeAnswer(16 * 1024),
        "503": { description: "Maintenance mode (non-ADMIN callers)" },
      },
    },
  },
  "/profile/notification-email": {
    post: {
      tags: ["Profile"],
      summary: "Start verifying a notification email (Jellyfin accounts)",
      description:
        "Jellyfin-provider accounts only (a Plex or OIDC address comes from the provider). Mails a one-time link to the " +
        "candidate address; it is bound to the account only once that link is confirmed (/profile/notification-email/confirm, " +
        "the public page the link opens). A new request replaces a pending one. A web session needs a step-up first " +
        "(guardrail 6g): `confirmPassword`, or an SSO sign-in younger than 5 minutes; a native session is exempt. At most " +
        "3 sends per 15 minutes per user, checked before the step-up and spent only after it passes.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["email"],
              properties: {
                email: { type: "string", maxLength: 320 },
                confirmPassword: { type: "string", writeOnly: true, description: "The step-up password (web sessions on a local-password account)" },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "{ ok: true, email } — the link was mailed to `email` (normalized)",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["ok", "email"],
                properties: { ok: { type: "boolean", enum: [true] }, email: { type: "string" } },
              },
            },
          },
        },
        "400": { description: "A missing or implausible email, or no email transport is configured" },
        "401": STEP_UP_401,
        "403": { description: "Not a Jellyfin account" },
        "413": tooLargeAnswer(16 * 1024),
        "429": { description: "More than 3 verification emails in 15 minutes, or too many step-up password attempts", headers: RETRY_AFTER_HEADER },
        "502": { description: "The verification email could not be sent" },
        "503": { description: "Maintenance mode (non-ADMIN callers)" },
      },
    },
  },
  "/profile/auto-request": {
    get: {
      tags: ["Profile"],
      summary: "Read the caller's watchlist auto-request state",
      responses: {
        "200": {
          description: "Feature, permission and toggle state",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  enabled: { type: "boolean", description: "feature.behavior.watchlistAutoRequest is on" },
                  permitted: {
                    type: "object",
                    description: "Whether the caller holds an AUTO_REQUEST* bit for each media type",
                    properties: { movie: { type: "boolean" }, tv: { type: "boolean" } },
                  },
                  plexWatchlist: { type: "boolean", description: "The caller's \"Auto-request from my Plex watchlist\" toggle" },
                  plexConnected: { type: "boolean", description: "A Plex token of the caller's own is stored (captured at Plex sign-in while the feature is on)" },
                  plexServerSource: { type: "boolean", description: "The admin lets the cron read Plex friends' watchlists through the Plex server owner's token (plexWatchlistServerSource)" },
                  plexServerOptedIn: { type: "boolean", description: "The caller's consent counts for that server-token path: their toggle is on AND they switched it on themselves, or the admin auto-enrolls friends. Always false while the toggle is off" },
                  plexServerStatus: { type: "string", nullable: true, enum: ["ok", "private", "error", null], description: "The last server-token run's verdict for the caller; null when it did not read them. \"private\" means their Plex watchlist is not visible to friends" },
                  plexConnectedVia: { type: "string", nullable: true, enum: ["token", "server", null], description: "How the cron reads the caller's Plex watchlist: their own token (always preferred), the server owner's token, or neither (null)" },
                },
              },
            },
          },
        },
        "404": { description: "User row not found" },
      },
    },
    patch: {
      tags: ["Profile"],
      summary: "Turn the caller's Plex watchlist auto-request on or off",
      description: "Turning it on also records the caller's explicit consent for the server-token path (it is read only for users who opted in, unless the admin auto-enrolls); turning it off clears that consent and deletes the caller's stored Plex token.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: { type: "object", required: ["plexWatchlist"], properties: { plexWatchlist: { type: "boolean" } } } } },
      },
      responses: {
        "200": { description: "Saved — { plexWatchlist }", content: { "application/json": { schema: { type: "object", properties: { plexWatchlist: { type: "boolean" } } } } } },
        "400": { description: "plexWatchlist is not a boolean" },
        "413": tooLargeAnswer(4 * 1024),
        "503": { description: "Maintenance mode (non-ADMIN callers)" },
      },
    },
  },
  // Per-user Trakt (src/lib/trakt-user.ts, guardrail 34c).
  "/profile/trakt": {
    get: {
      tags: ["Profile"],
      summary: "Read the caller's Trakt connection",
      responses: {
        "200": {
          description: "Connection state and the two uses",
          content: { "application/json": { schema: TRAKT_PROFILE_STATE } },
        },
      },
    },
    patch: {
      tags: ["Profile"],
      summary: "Turn either Trakt use on or off",
      description: "Turning historySeeds off deletes the imported Trakt history at once; turning it back on re-imports it on the next sync. Returns the same body as GET.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: { type: "object", properties: { watchlistAutoRequest: { type: "boolean" }, historySeeds: { type: "boolean" } } } } },
      },
      responses: {
        "200": { description: "Saved — the connection state", content: { "application/json": { schema: TRAKT_PROFILE_STATE } } },
        "400": { description: "Neither field sent, or one is not a boolean" },
        "404": { description: "Trakt is not connected" },
        "413": tooLargeAnswer(4 * 1024),
      },
    },
    delete: {
      tags: ["Profile"],
      summary: "Disconnect Trakt",
      description: "Deletes the stored grant, the connection and the imported watch history, then revokes the token at Trakt (best-effort). Idempotent.",
      responses: { "200": { description: "Disconnected", content: { "application/json": { schema: OK_TRUE } } } },
    },
  },
  "/profile/trakt/device": {
    post: {
      tags: ["Profile"],
      summary: "Start connecting Trakt (device-code flow)",
      description: "Answers the short code the user enters at the verification URL. The device code itself stays on the server. Poll POST /profile/trakt/device/poll every `interval` seconds until it answers connected, expired, denied or conflict. Requires a step-up: a password account sends `confirmPassword`; an SSO account must have signed in within the last 5 minutes.",
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: { confirmPassword: { type: "string", description: "The current password (password accounts)" } },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "The code to show",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  userCode: { type: "string" },
                  verificationUrl: { type: "string", description: "Always a trakt.tv https URL" },
                  expiresIn: { type: "integer", description: "Seconds until the code expires" },
                  interval: { type: "integer", description: "Seconds between polls" },
                },
              },
            },
          },
        },
        "400": { description: "Trakt is not available on this server (no client id/secret, or nothing to use it for)" },
        "401": STEP_UP_401,
        "413": { description: "Request body over the 16 KB cap" },
        "429": { description: "Too many starts, Trakt is rate limiting, or too many wrong step-up passwords" },
        "502": { description: "Trakt could not be reached" },
        "503": { description: "Maintenance mode" },
      },
    },
  },
  "/profile/trakt/device/poll": {
    post: {
      tags: ["Profile"],
      summary: "Poll a pending Trakt connection",
      description: "The server paces the real Trakt calls itself, so polling faster than the interval only gets \"pending\".",
      responses: {
        "200": {
          description: "The connection's state",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  state: { type: "string", enum: ["pending", "connected", "expired", "denied", "conflict"], description: "conflict: that Trakt account is connected to another account here" },
                  username: { type: "string", description: "Present when connected" },
                },
              },
            },
          },
        },
        "400": { description: "Trakt is not available on this server" },
        "429": { description: "Polling too fast, or Trakt is rate limiting" },
        "502": { description: "Trakt could not be reached" },
      },
    },
  },
  "/profile/calendar": {
    get: {
      tags: ["Profile"],
      summary: "Calendar feed status",
      description:
        "Whether the caller has an active iCal feed token. The feed URL itself is never returned here: only a SHA-256 hash of the token is stored, so the URL is shown once, by POST. 404 when feature.integration.calendar is off.",
      responses: {
        "200": {
          description: "Feed status",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  enabled: { type: "boolean" },
                  createdAt: { type: "string", format: "date-time", nullable: true },
                  canSubscribeAll: { type: "boolean", description: "Caller holds MANAGE_REQUESTS and may use ?scope=all" },
                },
              },
            },
          },
        },
        "404": { description: "feature.integration.calendar is disabled" },
      },
    },
    post: {
      tags: ["Profile"],
      summary: "Generate (or regenerate) the calendar feed URL",
      description:
        "Mints a new secret token and returns the subscription URL ONCE. Any previous URL stops working immediately. Rate-limited per user.",
      responses: {
        "201": {
          description: "New feed URL (shown once)",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  token: { type: "string" },
                  url: { type: "string" },
                  webcalUrl: { type: "string" },
                  allUrl: { type: "string", nullable: true, description: "All-requests feed, for MANAGE_REQUESTS holders" },
                  createdAt: { type: "string", format: "date-time" },
                },
              },
            },
          },
        },
        "404": { description: "feature.integration.calendar is disabled, or the account is disabled" },
        "429": { description: "Too many regenerations — 10/hour per user; carries Retry-After", headers: RETRY_AFTER_HEADER },
        "503": { description: "Maintenance mode" },
      },
    },
    delete: {
      tags: ["Profile"],
      summary: "Revoke the calendar feed URL",
      responses: {
        "200": { description: "Revoked ({ ok: true })", content: { "application/json": { schema: OK_TRUE } } },
        "404": { description: "feature.integration.calendar is disabled" },
      },
    },
  },
  "/calendar/feed/{token}": {
    get: {
      tags: ["Profile"],
      summary: "iCal subscription feed (public, token-authed)",
      description:
        "RFC 5545 calendar of upcoming release dates (movie theatrical/digital/physical, TV episode air dates) for the token owner's non-declined requests and watchlist, ~30 days back to ~1 year ahead. The path segment is `<token>.ics`. `?scope=all` returns every non-declined request instead and requires MANAGE_REQUESTS (re-checked on every poll). Cache-read only. Every failure — unknown/revoked token, disabled or purged owner, missing permission, feature off — is a bare 404.",
      security: [],
      parameters: [
        { name: "token", in: "path", required: true, schema: { type: "string" }, description: "`<token>.ics`" },
        { name: "scope", in: "query", required: false, schema: { type: "string", enum: ["all"] } },
      ],
      responses: {
        "200": { description: "The calendar", content: { "text/calendar": { schema: { type: "string" } } } },
        "404": { description: "Not found" },
        "429": { description: "Rate limited (per address and per token)" },
      },
    },
  },
  "/profile": {
    delete: {
      tags: ["Profile"],
      summary: "Close (disable) the caller's own account",
      description:
        "Revokes every session and blocks sign-in from then on. Nothing is scrubbed and nothing is cascade-deleted — an admin can re-enable the account, and the irreversible personal-data scrub is a separate admin action (POST /admin/users/{id}/purge).",
      requestBody: {
        required: false,
        content: { "application/json": { schema: { type: "object", properties: {
          password: { type: "string", description: "Required (non-empty) for local-credentials accounts. An account with no local password (SSO, Plex, Jellyfin) proves a sign-in within the last 5 minutes instead on a web session, and nothing on a native (app) session." },
          secondFactor: { ...MFA_SECOND_FACTOR_SCHEMA, description: "Local account with an active second factor, web session: a fresh second factor (same shape as the enrollment step-up). A native (app) session is exempt for now." },
        } } } },
      },
      responses: {
        "200": { description: "Account disabled ({ ok: true }; idempotent)", content: { "application/json": { schema: OK_TRUE } } },
        "400": { description: "Cannot disable the last admin, a missing/incorrect password on a local account, or (web session, active second factor) a missing/invalid second factor ({ error, secondFactorRequired: true, methods? })" },
        "401": { description: "{ error: \"session-too-old\", message } — an account with no local password, from a web session that signed in more than 5 minutes ago; sign in again" },
        "413": { description: "Request body over the 16 KB cap" },
        "404": { description: "Account not found" },
        "429": { description: "Too many attempts — 5 per 15 minutes, every account kind; carries Retry-After", headers: RETRY_AFTER_HEADER },
        "503": { description: "Maintenance mode" },
      },
    },
  },
  "/push/vapid-key": {
    get: {
      tags: ["Push"],
      // No `security: []` override — the handler is withAuth-wrapped and 401s
      // anonymous callers, so it must inherit the document-level session/bearer
      // requirement. Declaring it public made generated clients omit the
      // credential and fail push registration with an unexplained 401.
      summary: "Get the public VAPID key for push subscription",
      responses: {
        "200": { description: "VAPID public key", content: { "application/json": { schema: { type: "object", properties: { publicKey: { type: "string" } } } } } },
        "503": { description: "Web push is not configured — the stored VAPID keypair is incomplete. A client must treat this as 'push unavailable', not a transient failure." },
      },
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
              required: ["endpoint", "keys"],
              description: "The browser PushSubscription JSON fields at the top level (not wrapped).",
              properties: {
                endpoint: { type: "string", maxLength: 2048 },
                keys: {
                  type: "object",
                  required: ["p256dh", "auth"],
                  properties: { p256dh: { type: "string" }, auth: { type: "string" } },
                },
                label: { type: "string", maxLength: 100 },
                resync: {
                  type: "boolean",
                  description: "The web bell's page-load re-send of a subscription the browser already holds. It never evicts another device, and is refused (410) for an endpoint removed on purpose.",
                },
              },
            },
          },
        },
      },
      responses: {
        "200": { description: "Subscription registered ({ ok: true })", content: { "application/json": { schema: OK_TRUE } } },
        "400": { description: "Missing fields, over-long fields (endpoint 2048, keys 256), a non-https endpoint, or an endpoint that is not a recognized push service" },
        "403": { description: "feature.integration.push is disabled" },
        "409": { description: "Endpoint already registered to another user" },
        "410": { description: "resync only: the endpoint was removed (device list or the per-user cap), or re-adding it would exceed the cap — the browser should drop its subscription" },
        "413": tooLargeAnswer(32 * 1024),
        "429": { description: "Rate limited — 10/min per user" },
        "503": { description: "Maintenance mode" },
      },
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
              description: "Either the subscription row id (device-management UI) or the push endpoint.",
              properties: { id: { type: "string" }, endpoint: { type: "string" } },
            },
          },
        },
      },
      responses: { "200": { description: "Subscription removed", content: { "application/json": { schema: OK_TRUE } } }, "400": { description: "Neither id nor a valid endpoint supplied" }, "413": tooLargeAnswer(32 * 1024) },
    },
  },
  "/push/test": {
    post: {
      tags: ["Push"],
      summary: "Send a test push notification to current user",
      description: "Sends a real test push to every device registered to the caller (iOS via the APNs relay, Web Push via VAPID). Bypasses feature.integration.push. Rate-limited 5/min per user.",
      responses: {
        "200": {
          description: "Every device accepted the test",
          content: { "application/json": { schema: { type: "object", properties: { results: { type: "array", items: { type: "object", properties: { platform: { type: "string", enum: ["ios", "web"] }, endpoint: { type: "string" }, ok: { type: "boolean" }, status: { type: "integer" }, message: { type: "string" } } } } } } } },
        },
        "404": { description: "The caller has no push subscription" },
        "429": { description: "Rate limited" },
        "502": { description: "At least one device failed (or none was reached) — same { results } body as 200" },
      },
    },
  },
  "/push/apns": {
    post: {
      tags: ["Push"],
      summary: "Register an iOS APNs device token (native)",
      requestBody: {
        required: true,
        content: { "application/json": { schema: { type: "object", required: ["deviceToken"], properties: {
          deviceToken: { type: "string", pattern: "^(?:[0-9a-fA-F]{2}){32,100}$", description: "Hex APNs token, 32–100 bytes; stored lowercased" },
          label: { type: "string", maxLength: 100 },
          publicKey: { type: "string", nullable: true, description: "Optional P-256 X9.63 uncompressed key (65 bytes, base64) for encrypted rich pushes. Omitted = keep the stored key; an explicit null clears it; a malformed value is ignored" },
        } } } },
      },
      description: "Registers or updates the caller's device. Per-user cap (maxPushSubscriptions setting, default 5) evicts the oldest subscription. 10 per minute per user.",
      responses: {
        "200": { description: "{ ok: true }", content: { "application/json": { schema: OK_TRUE } } },
        "400": { description: "Invalid deviceToken" },
        "403": { description: "feature.integration.push is off" },
        "409": { description: "That device token is registered to another account — its owner must unregister it first" },
        "413": tooLargeAnswer(16 * 1024),
        "429": { description: "Rate limited" },
        "503": { description: "Maintenance mode" },
      },
    },
    delete: {
      tags: ["Push"],
      summary: "Unregister an iOS APNs device token",
      requestBody: {
        required: true,
        content: { "application/json": { schema: { type: "object", required: ["deviceToken"], properties: { deviceToken: { type: "string" } } } } },
      },
      responses: {
        "200": {
          description: "{ ok: true } — removed, or nothing matched (only the caller's own rows)",
          content: { "application/json": { schema: OK_TRUE } },
        },
        "400": { description: "deviceToken missing" },
        "413": tooLargeAnswer(16 * 1024),
      },
    },
  },
};
