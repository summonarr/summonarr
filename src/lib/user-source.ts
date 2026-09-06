// How an account authenticates, as shown on Admin → Users (the source chip +
// avatar colour in user-table.tsx). A pure, zero-import leaf so the page and
// the tests share one derivation.
//
// Precedence, and why:
// - "local" (a passwordHash) and "oidc" (an `oidc` Account row) come first —
//   these are the two sources with no provider-pinned media server, so they
//   are the ones user-table.tsx hands the Server access controls to.
// - "jellyfin" keys on the SUBJECT column first (`User.jellyfinUserId`, what
//   auth.ts looks a sign-in up by) and only then on the synthetic
//   `jellyfin-<id>@jellyfin.local` address that every Jellyfin account is
//   anchored on (Jellyfin exposes no email).
// - "plex" keys on `User.plexUserId` when set. It is ALSO the final fallback:
//   legacy Plex rows can still carry a null plexUserId (plex-user-backfill.ts
//   exists precisely because of that), so a bare `plexUserId != null` test
//   would mislabel them.
// - "discord" is a shadow account minted by the Discord interactions route
//   (`discord_<id>@discord.local`, no passwordHash, no subject, no Account
//   row). Before this branch existed those rows fell all the way through to
//   "plex" — a wrong chip and a wrong avatar colour for every one of them.
export type UserSource = "local" | "oidc" | "plex" | "jellyfin" | "discord";

export interface UserSourceInput {
  email: string;
  plexUserId: string | null;
  jellyfinUserId: string | null;
  /** The row has a passwordHash. */
  hasLocalCredentials: boolean;
  /** The row has an `oidc` Account binding. */
  hasOidcAccount: boolean;
}

export const JELLYFIN_SYNTHETIC_EMAIL_SUFFIX = "@jellyfin.local";
export const DISCORD_SYNTHETIC_EMAIL_SUFFIX = "@discord.local";

export function deriveUserSource(u: UserSourceInput): UserSource {
  if (u.hasLocalCredentials) return "local";
  if (u.hasOidcAccount) return "oidc";
  if (u.jellyfinUserId != null || u.email.endsWith(JELLYFIN_SYNTHETIC_EMAIL_SUFFIX)) return "jellyfin";
  if (u.plexUserId != null) return "plex";
  if (u.email.endsWith(DISCORD_SYNTHETIC_EMAIL_SUFFIX)) return "discord";
  return "plex";
}
