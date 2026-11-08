import { prisma } from "@/lib/prisma";
import { purposeHmacHex, signingKey } from "@/lib/signing-keys";
import { isPrismaErrorCode } from "@/lib/prisma-errors";

// What every provider's identity lookup (Plex, Jellyfin, OIDC) shares: the
// result it hands back, the refusals it can return instead, and the two rules
// every create path applies (the pre-setup bootstrap gate and the P2002 race
// retry). The sign-in entry point is auth.ts, which re-exports the public names.

// Keyed fingerprint of the lowercased email for audit storage (and the
// per-account login bucket key). Truncated to 16 hex chars so a password
// accidentally typed in the email field can't be recovered from logs, while
// still letting an operator correlate failed-login attempts on the same input.
//
// An HMAC under its own HKDF subkey of NEXTAUTH_SECRET (the "audit-email"
// purpose in signing-keys.ts, guardrail 6h), not a bare SHA-256: an unkeyed hash
// of an email is reversed by hashing a list of candidate addresses, so anyone
// holding an audit export (or a backup) could confirm which addresses had tried
// to sign in. Rows written before this used the unkeyed form; they no longer
// correlate with new ones, which the retention scrub makes moot (auth-event
// details are cleared once aged). The same value keys the per-account sign-in
// limiter and lockout notice, so it always uses the CURRENT secret.
export function hashAuditEmail(email: string): string {
  return purposeHmacHex(signingKey("audit-email"), email).slice(0, 16);
}

// Sentinel returned when a provider-bound lookup refuses sign-in due to an email
// collision with a user that has no corresponding provider subject yet. The
// authorize* callers turn this into `return null`, so the client only sees a
// generic sign-in failure.
export const PROVIDER_REBIND_REQUIRED = Symbol("provider-rebind-required");
export type ProviderRebindRequired = typeof PROVIDER_REBIND_REQUIRED;

// Returned when an OIDC sign-in would mint the very FIRST user before setup has
// run (no admin exists and OAuth bootstrap isn't enabled). Creating a plain USER
// there trips the "registration closed" guard in /api/auth/register and bricks
// first-admin bootstrap — refuse instead. See runFirstAdminPromotion.
export const PROVIDER_SETUP_REQUIRED = Symbol("provider-setup-required");
export type ProviderSetupRequired = typeof PROVIDER_SETUP_REQUIRED;

// Every other refusal a provider lookup can return (guardrail 34e). `reason`
// is what the AUTH_LOGIN_FAILED audit row records; the client only ever sees a
// coarse message for it.
export type ProviderRefusalReason =
  // Jellyfin: the id is bound to a different configured server.
  | "instance_mismatch"
  // OIDC: the (provider, sub) row was bound under a different issuer.
  | "issuer_mismatch"
  // OIDC: linking or creating needs an IdP-verified email.
  | "email_unverified"
  | "email_missing"
  // The address is in a domain Summonarr mints for itself (reserved-email.ts).
  | "reserved_email"
  // OIDC allowlist (oidc-allowlist.ts).
  | "not_in_allowed_group"
  | "email_domain_not_allowed"
  | "existing_users_only"
  | "allowlist_unreadable";

export class ProviderRefusal {
  readonly reason: ProviderRefusalReason;
  constructor(reason: ProviderRefusalReason) {
    this.reason = reason;
  }
}

export type AuthorizedDbUser = { id: string; email: string; name: string | null; role: string };

// What a findOrCreate*User lookup resolves to: the user, or why it refused.
export type ProviderLookupResult = AuthorizedDbUser | ProviderRebindRequired | ProviderSetupRequired | ProviderRefusal;
export type ProviderLookupRefusal = Exclude<ProviderLookupResult, AuthorizedDbUser>;

// Narrows a findOrCreate*User result to the user it resolved, i.e. none of the
// refusals above.
export function isAuthorizedDbUser(result: ProviderLookupResult): result is AuthorizedDbUser {
  return typeof result !== "symbol" && !(result instanceof ProviderRefusal);
}

// The AUTH_LOGIN_FAILED reason a lookup refusal is audited with. Shared by the
// Plex, Jellyfin password and QuickConnect sign-ins.
export function providerRefusalAuditReason(result: ProviderLookupRefusal): string {
  if (result === PROVIDER_SETUP_REQUIRED) return "setup_required";
  if (result === PROVIDER_REBIND_REQUIRED) return "email_collision_needs_rebind";
  return result.reason;
}

// True when minting the very FIRST user through an OAuth provider would brick
// first-admin bootstrap: OAuth bootstrap disabled, setup not yet completed, and no
// ADMIN exists. Creating a plain USER row in that state trips /api/auth/register's
// "registration closed" guard while runFirstAdminPromotion won't promote the row,
// leaving the instance with no admin and no way to create one. Every provider's
// create path (Plex, Jellyfin, OIDC) consults this before minting.
export async function isPreSetupBootstrapBlocked(): Promise<boolean> {
  if (process.env.SUMMONARR_ALLOW_OAUTH_FIRST_ADMIN === "true") return false;
  const setupRow = await prisma.setting.findUnique({ where: { key: "setup_completed_at" } });
  if (setupRow) return false;
  const existingAdmin = await prisma.user.findFirst({ where: { role: "ADMIN" }, select: { id: true } });
  return !existingAdmin;
}

// Two FIRST sign-ins of one provider identity at once (a double submit, the app
// and the web together) both pass the lookups and both create; the loser hits
// the unique subject/email key (P2002, read by code — guardrail 23b). Run the
// whole lookup again: it now finds the winner's row and takes the returning-user
// path, with every binding check that path makes (34e), or refuses a collision
// on the email the same way step 2 does. Once only: a second P2002 propagates.
export async function retryOnProvisionRace<T>(provision: () => Promise<T>): Promise<T> {
  try {
    return await provision();
  } catch (err) {
    if (!isPrismaErrorCode(err, "P2002")) throw err;
    return provision();
  }
}

// A `.catch` handler for a best-effort write: the sign-in carries on without
// it, but a write that keeps failing (a constraint, schema drift) is logged
// rather than silently dropped.
export function logBestEffortFailure(scope: string, what: string): (err: unknown) => void {
  return (err) => {
    console.error(`[${scope}] ${what} failed:`, err instanceof Error ? err.message : err);
  };
}
