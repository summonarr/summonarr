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

// Per-instance Radarr/Sonarr secret keys (multi-instance support) can't be
// statically enumerated once instance slugs are admin-defined at runtime. They
// are always spelled `${service}${Segment}ApiKey` / `${service}${Segment}WebhookSecret`
// (Segment capitalized per src/lib/arr-instances.ts: "" / "4k" / "Anime" / …), so
// a shape regex is the encryption gate for them. This matches the base + 4K keys
// too (harmless — they're also in the static set above). It CANNOT match a
// RootFolder/Url/QualityProfileId key, so non-secret instance settings stay
// plaintext by design.
//
// Kept here (not imported from arr-instances) so this module stays a zero-import
// leaf that the Prisma client can load without pulling in any API surface.
const ARR_INSTANCE_SECRET_RE = /^(radarr|sonarr)([A-Z0-9][A-Za-z0-9]*)?(ApiKey|WebhookSecret)$/;

// The single predicate the encryption extension (src/lib/prisma.ts) and the
// settings write surface consult. A key is sensitive if it's in the static set OR
// it's a per-instance Radarr/Sonarr secret. Guardrail 7a: a miss here = a secret
// stored plaintext-at-rest, so both writers MUST route through this.
export function isSensitiveSettingKey(key: string): boolean {
  return SETTINGS_SENSITIVE_KEYS_SET.has(key) || ARR_INSTANCE_SECRET_RE.test(key);
}
