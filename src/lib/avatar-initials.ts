// Up to two initials for an avatar fallback, or "?" when the name has none.
// The name can be "" or whitespace (an OIDC/Plex claim is passed through as
// sent), and `Array.from` keeps an emoji or other surrogate pair whole instead
// of splitting it mid-character. Two letters fit the 28px header avatar; a
// four-word name used to overflow it.
export function avatarInitials(name: string | null | undefined): string {
  const initials = (name ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => Array.from(part)[0])
    .join("")
    .toUpperCase();
  return initials || "?";
}
