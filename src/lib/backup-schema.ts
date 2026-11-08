// Single source of truth for which tables and enums the full-DB backup includes.
// Order is FK-respecting: parents before children, so the import can replay
// INSERTs sequentially without deferred constraints. The same list drives the
// TRUNCATE step on import, which means *every* table referenced by an FK from
// any listed table must itself be in the list — otherwise TRUNCATE fails.
//
// Keep this in sync with prisma/schema.prisma. Adding a model? Add it here.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

export const BACKUP_TABLES = [
  "User",
  "Account",
  "VerificationToken",
  "AuthSession",
  // Two-factor credentials (guardrail 6d). Backed up like every other secret:
  // UserTotp.secret travels as its enc:v1 ciphertext (restorable only under the
  // same TOKEN_ENCRYPTION_KEY — the import warns on a key mismatch, and such a
  // user then signs in with a recovery code or a passkey, or gets an admin
  // reset); recovery codes are hashes and passkeys are public keys, both inert
  // outside this database. Omitting them would silently strip 2FA on restore.
  "UserTotp",
  "MfaRecoveryCode",
  "WebAuthnCredential",
  "DiscordLinkToken",
  "DiscordMergeCode",
  "MediaRequest",
  "RequestComment",
  "Issue",
  "IssueMessage",
  "IssueGrab",
  "PushSubscription",
  // Removed web push endpoints (hashes only); a child of User, like the row above.
  "PushSubscriptionRemoval",
  "DeletionVote",
  "PlexLibraryItem",
  "JellyfinLibraryItem",
  "TVEpisodeCache",
  // Transient staging buffer for whole-table TVEpisodeCache rewrites. Listed
  // because BACKUP_TABLES must cover every model (the TRUNCATE step on import
  // reads this same list), not because its contents matter: the rewrite helper
  // clears its own rows in a finally block, so it is empty except during a run.
  "TVEpisodeCacheStaging",
  // The library twins of that buffer (replacePlexLibraryForInstances /
  // replaceJellyfinLibraryForInstances) — listed for the same reason, and
  // likewise empty except during a run.
  "PlexLibraryItemStaging",
  "JellyfinLibraryItemStaging",
  "RadarrWantedItem",
  "RadarrAvailableItem",
  "SonarrWantedItem",
  "SonarrAvailableItem",
  "UpcomingCacheItem",
  "TmdbCache",
  "TmdbMediaCore",
  "DiscordSearchCache",
  "IpLookupCache",
  "PlexTokenCache",
  "Setting",
  // Outbound notification channels. `secret` travels as its enc:v1 ciphertext,
  // restorable only under the same TOKEN_ENCRYPTION_KEY (like Setting secrets).
  "NotificationAgent",
  "AuditLog",
  "MediaServerUser",
  "PlayHistory",
  "WatchSyncPair",
  "WatchSyncMark",
  "WatchSyncPlexMark",
  "ActiveSession",
  "TrashSpec",
  "TrashApplication",
  "WebhookReplay",
  "WatchlistItem",
  "HiddenItem",
  "AutoRequestLedger",
  // Trakt connection state + imported watch history. The connection's tokens
  // live in Account (above) as enc:v1 ciphertext, restorable only under the same
  // TOKEN_ENCRYPTION_KEY — a mismatch just means the user reconnects Trakt.
  "TraktConnection",
  "TraktWatchedItem",
  // The user's own Trakt ratings, imported beside the history (same switch,
  // same deletions).
  "TraktRating",
  "Notification",
  "UserRecommendation",
  // The server-wide "For You" graph (recommendation-graph.ts). Derived data —
  // a restore that dropped it would simply be rebuilt by the next
  // warm-recommendations run — but BACKUP_TABLES must cover EVERY model (the
  // import's TRUNCATE step reads this same list), so both are listed.
  "RecommendationTitle",
  "TitleSuggestion",
  // The server's private co-watch edges (guardrail 40c) — derived, rebuilt
  // whole by every warm-recommendations run, listed for the same reason.
  "CoWatchSuggestion",
  "BlacklistItem",
  "CleanupProtection",
  // Snapshot of each media server's own watch records (never-watched report).
  // Derived — the next upstream-watch refresh rebuilds it — but listed because
  // BACKUP_TABLES must cover every model.
  "UpstreamWatchEvidence",
  // Each server identity's titles read from the media server's own history and
  // favorites (For You only), and how far each identity has been read. Unlike
  // the derived tables above, a server's pre-Summonarr history can't always be
  // rebuilt (servers prune it), so it travels with the backup. Children of
  // MediaServerUser, which is listed earlier.
  "ServerWatchedTitle",
  "ServerWatchCursor",
] as const;

export const BACKUP_ENUMS = [
  "Role",
  "MediaType",
  "RequestStatus",
  "IssueType",
  "IssueScope",
  "IssueStatus",
  "AuditAction",
  "TrashService",
  "TrashSpecKind",
  "RecommendationSeed",
] as const;

// Stable fingerprints of the live schema, derived from prisma/schema.prisma.
// Embedded in every export and verified on every import — a mismatch refuses
// the restore *before* TRUNCATE runs, so a version-skewed file can't
// half-replace the DB.
//
// Hashing the file (rather than Prisma.dmmf.datamodel) is deliberate:
// BaseDMMF strips enums and certain field metadata at runtime, and the
// schema file is copied into the standalone Docker runner image.
//
// Two of them:
//   - computeSchemaFingerprint: the raw bytes. Every backup carries it as
//     `Schema-Fingerprint`, which is all an older importer reads, so its
//     algorithm never changes (tests/backup-schema.test.mts pins it).
//   - computeNormalizedSchemaFingerprint: the text with comments removed and
//     whitespace collapsed, carried as `Schema-Fingerprint-Normalized`. The
//     importer prefers it, so a release that only edits a comment or
//     reformats the schema still restores the backups made before it.
let cachedFingerprint: string | null = null;
let cachedNormalizedFingerprint: string | null = null;

function readSchemaText(): string {
  return readFileSync(join(process.cwd(), "prisma", "schema.prisma"), "utf-8");
}

function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function computeSchemaFingerprint(): string {
  if (cachedFingerprint !== null) return cachedFingerprint;
  cachedFingerprint = shortHash(readSchemaText());
  return cachedFingerprint;
}

export function computeNormalizedSchemaFingerprint(): string {
  if (cachedNormalizedFingerprint !== null) return cachedNormalizedFingerprint;
  cachedNormalizedFingerprint = shortHash(normalizeSchemaText(readSchemaText()));
  return cachedNormalizedFingerprint;
}

// Prisma schema text with `//` comments (doc comments included) removed and
// every run of whitespace collapsed to one space. A `//` inside a string
// literal (`@default("https://…")`) is text, not a comment.
export function normalizeSchemaText(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"' && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, Math.min(j + 1, text.length));
      i = j + 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    out += ch;
    i++;
  }
  return out.replace(/\s+/g, " ").trim();
}
