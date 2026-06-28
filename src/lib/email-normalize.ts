// Canonicalizes an email for storage, lookup, and comparison. NFKC + lowercase
// + trim. The Unicode NFKC pass folds compatibility/homoglyph variants to a
// single canonical form (mirroring backup-crypto.ts's password handling) so two
// visually-identical-but-codepoint-distinct addresses can't mint separate
// accounts or sidestep an email-keyed lookup. Re-exported from auth.ts for
// backwards compatibility; lives in this tiny module so non-auth callers
// (download-policy, play-history, plex-user-backfill, the OIDC adapter,
// jellyfin webhook attribution) can import without pulling in the NextAuth +
// prisma-adapter dependency graph.
export function normalizeEmail(email: string): string {
  return email.normalize("NFKC").toLowerCase().trim();
}
