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
  "Session",
  "VerificationToken",
  "AuthSession",
  "DiscordLinkToken",
  "DiscordMergeCode",
  "MediaRequest",
  "Issue",
  "IssueMessage",
  "IssueGrab",
  "PushSubscription",
  "DeletionVote",
  "PlexLibraryItem",
  "JellyfinLibraryItem",
  "TVEpisodeCache",
  "RadarrWantedItem",
  "RadarrAvailableItem",
  "SonarrWantedItem",
  "SonarrAvailableItem",
  "UpcomingCacheItem",
  "TmdbCache",
  "TmdbMediaCore",
  "DiscordSearchCache",
  "PlexTokenCache",
  "Setting",
  "AuditLog",
  "MediaServerUser",
  "PlayHistory",
  "ActiveSession",
  "TrashSpec",
  "TrashApplication",
  "WebhookReplay",
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
] as const;

// Stable fingerprint of the live schema, derived from the bytes of
// prisma/schema.prisma. Embedded in every export and verified on every
// import — a mismatch refuses the restore *before* TRUNCATE runs, so a
// version-skewed file can't half-replace the DB.
//
// Hashing the file (rather than Prisma.dmmf.datamodel) is deliberate:
// BaseDMMF strips enums and certain field metadata at runtime, and the
// schema file is copied into the standalone Docker runner image.
//
// A whitespace-only or comment-only edit will change the fingerprint —
// that's a small price for the simplicity of byte-level hashing. Re-export
// the backup if it bites.
let cachedFingerprint: string | null = null;

export function computeSchemaFingerprint(): string {
  if (cachedFingerprint !== null) return cachedFingerprint;
  const path = join(process.cwd(), "prisma", "schema.prisma");
  const contents = readFileSync(path, "utf-8");
  cachedFingerprint = createHash("sha256")
    .update(contents)
    .digest("hex")
    .slice(0, 16);
  return cachedFingerprint;
}
