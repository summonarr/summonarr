import "server-only";

/**
 * Resolves the address to use for outgoing email notifications for a given user row.
 *
 * Precedence:
 *   1. `notificationEmail` — Plex/OIDC users have this auto-synced on every sign-in;
 *      Jellyfin users set it manually via the profile page (null until they do).
 *   2. `email` — the login identity. Only used as a fallback for users whose
 *      provider already guaranteed a real email address on signup (credentials/Plex/OIDC)
 *      but whose notificationEmail hasn't been backfilled yet.
 *
 * Synthetic identities (`jellyfin-<id>@jellyfin.local`, `discord_<id>@discord.local`)
 * are never used — they are placeholders for the unique constraint on `User.email`,
 * not delivery addresses. Handing them to SMTP would hard-bounce.
 *
 * Returns `null` when there is no deliverable address, signalling the caller to skip
 * sending. This is the correct behaviour for Jellyfin/Discord users who haven't set one yet.
 */
const SYNTHETIC_EMAIL_SUFFIXES = ["@jellyfin.local", "@discord.local"] as const;

export function resolveUserNotificationEmail(user: {
  email: string;
  notificationEmail: string | null;
}): string | null {
  if (user.notificationEmail && user.notificationEmail.trim() !== "") {
    return user.notificationEmail;
  }
  const lowered = user.email.toLowerCase();
  if (SYNTHETIC_EMAIL_SUFFIXES.some((suffix) => lowered.endsWith(suffix))) return null;
  return user.email || null;
}
