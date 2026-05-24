// Canonicalizes an email for storage, lookup, and comparison. Lowercase + trim.
// Re-exported from auth.ts for backwards compatibility; live in this tiny module
// so non-auth callers (download-policy, play-history, plex-user-backfill, the
// OIDC adapter, jellyfin webhook attribution) can import without pulling in the
// NextAuth + prisma-adapter dependency graph.
export function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}
