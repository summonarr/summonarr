// Sensitive keys in the `Setting` table — the canonical list, imported by both
// the settings route (to mark them write-only at the API boundary) and the
// Prisma extension at src/lib/prisma.ts (to gate auto-encryption on write
// and auto-decryption on read).
//
// SINGLE SOURCE OF TRUTH. Don't duplicate this list anywhere — divergence
// between encryption gate and write surface lands as either plaintext-at-rest
// (write encrypted, read raw) or ciphertext-to-upstream (write raw, read
// "decrypted" garbage) the moment someone adds a key.
//
// Kept in a leaf module with zero non-built-in imports so the prisma client
// module can import it without bringing the API surface into its load graph.
export const SETTINGS_SENSITIVE_KEYS: readonly string[] = [
  "plexAdminToken",
  "jellyfinApiKey",
  "vapidPrivateKey",
  "webhookSecret",
  "sonarrWebhookSecret",
  "radarrWebhookSecret",
  "discordBotToken",
  "radarrApiKey",
  "sonarrApiKey",
  "radarr4kApiKey",
  "sonarr4kApiKey",
  "radarr4kWebhookSecret",
  "sonarr4kWebhookSecret",
  "omdbApiKey",
  "mdblistApiKey",
  "traktClientId",
  "ipinfoToken",
  "resendApiKey",
  "smtpPassword",
  "trashGithubToken",
  "apnsRelayKey",
] as const;

export const SETTINGS_SENSITIVE_KEYS_SET: ReadonlySet<string> = new Set(
  SETTINGS_SENSITIVE_KEYS,
);
