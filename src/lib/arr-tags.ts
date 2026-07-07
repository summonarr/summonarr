// Pure helper for Radarr/Sonarr requester tagging (used by arr.ts). Kept as its
// own ZERO-import leaf module so it's unit-testable (tests/arr-tags.test.mts)
// without importing the ARR HTTP client / prisma. Mirrors the permissions.ts /
// quota.ts leaf pattern.

// Sanitized, lowercased tag label for a requesting user: prefer the display
// name, then the email local-part, then a short user-id stub. ARR lowercases tag
// labels, so this round-trips through the find/create in ensureArrTag. Non-empty
// by construction (falls back to the id stub).
export function arrRequesterTagLabel(
  name: string | null | undefined,
  email: string | null | undefined,
  userId: string,
): string {
  const raw = (name && name.trim()) || (email ? email.split("@")[0] : "") || `user-${userId.slice(0, 8)}`;
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return slug || `user-${userId.slice(0, 8)}`;
}
