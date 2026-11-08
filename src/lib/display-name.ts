// A synced account can carry an empty (or blank) display name; every surface
// then falls back to the email instead of rendering nothing. `??` alone keeps
// an empty string, so a blank name rendered a blank label. Zero-import.
export function displayName(name: string | null | undefined): string | null {
  return name?.trim() || null;
}

/** The account's display name, else its email. */
export function nameOrEmail(user: { name: string | null; email: string }): string {
  return displayName(user.name) ?? user.email;
}
