// Pure helper for Radarr/Sonarr requester tagging (used by arr.ts). Kept as its
// own ZERO-import leaf module so it's unit-testable (tests/arr-tags.test.mts)
// without importing the ARR HTTP client / prisma. Mirrors the permissions.ts /
// quota.ts leaf pattern.

// Sanitized, lowercased tag label for a requesting user: prefer the display
// name, then the email local-part, then a short user-id stub. ARR lowercases tag
// labels, so this round-trips through the find/create in ensureArrTag. Non-empty
// by construction (falls back to the id stub).
//
// A stable id-derived suffix is appended to the human-readable slug so two
// distinct users with the same display name (e.g. two "John Smith") never
// collapse to the same tag and misattribute each other's Radarr/Sonarr
// requests. The id-only fallback already carries the id, so it isn't suffixed
// again.
export function arrRequesterTagLabel(
  name: string | null | undefined,
  email: string | null | undefined,
  userId: string,
): string {
  const idStub = userId.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 8) || "user";
  const raw = (name && name.trim()) || (email ? email.split("@")[0] : "");
  const nameSlug = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!nameSlug) return `user-${idStub}`;
  // Reserve room for the "-<idStub>" suffix so the total stays within ARR's tag
  // label limits; trim a trailing hyphen the slice may have left behind.
  const budget = Math.max(1, 40 - idStub.length - 1);
  const base = nameSlug.slice(0, budget).replace(/-+$/g, "");
  return `${base}-${idStub}`;
}
