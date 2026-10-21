// The email domains Summonarr mints for itself (guardrail 34e). Pure and
// zero-import so routes, auth.ts and tests share one definition.
//
// Each one is a placeholder the app writes into `User.email` — a column that
// must be unique and non-null — for an identity with no real address:
//   - `jellyfin-<id>@jellyfin.local`: every Jellyfin-provisioned account
//     (Jellyfin exposes no email), see findOrCreateJellyfinUser.
//   - `discord_<id>@discord.local`: the shadow account /request mints for an
//     unlinked Discord user, see the interactions route.
//   - `deleted-<id>@deleted.invalid`: a purged account's tombstone, see
//     purgedEmailFor in account-lifecycle.ts.
//
// Why no human-created account may carry one:
//   - Other code reads meaning into the shape — user-source.ts labels a
//     @jellyfin.local row "jellyfin", the Discord routes treat @discord.local as
//     "unlinked", isPurgedRow reads the tombstone as "purged".
//   - A row squatting `jellyfin-<id>@jellyfin.local` blocks that Jellyfin user
//     from ever being provisioned (the address is unique), and before 34e the
//     sign-in path BOUND a Jellyfin login to whatever row held the address — so
//     a delegate or an OIDC user could plant one and inherit the next sign-in.
export const RESERVED_EMAIL_DOMAINS = ["jellyfin.local", "discord.local", "deleted.invalid"] as const;

// True when `email`'s domain is one of the reserved domains. Exact domain match
// (a subdomain such as `x@a.jellyfin.local` is not the synthetic shape, and no
// matcher elsewhere treats it as one). Canonicalized the same way as
// normalizeEmail so a fullwidth or uppercase spelling can't slip past.
export function isReservedEmailDomain(email: string): boolean {
  const canonical = email.normalize("NFKC").toLowerCase().trim();
  const at = canonical.lastIndexOf("@");
  if (at === -1) return false;
  const domain = canonical.slice(at + 1);
  return (RESERVED_EMAIL_DOMAINS as readonly string[]).includes(domain);
}
