import { prisma } from "@/lib/prisma";
import {
  findOrCreateOidcUser,
  hashAuditEmail,
  isAuthorizedDbUser,
  normalizeEmail,
  PROVIDER_REBIND_REQUIRED,
  PROVIDER_SETUP_REQUIRED,
  type AuthorizedDbUser,
  type ProviderRefusalReason,
} from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { getClientIp } from "@/lib/rate-limit";
import type { OidcClaims } from "@/lib/oidc";
import {
  evaluateOidcAllowlist,
  OIDC_ALLOWLIST_SETTING_KEY,
  parseOidcAllowlist,
  type OidcAllowlist,
} from "@/lib/oidc-allowlist";

// Everything an OIDC sign-in does between the code exchange and the session
// mint, shared by the web callback (/api/auth/oidc/callback) and the native
// route (/api/auth/sign-in/oidc) so the two can never disagree on who gets in
// (guardrail 34e). Each route only translates the outcome into its own
// transport (a /login?error= redirect, or a JSON status).

// The admin allowlist. No row ⇒ the default (off); an unreadable row ⇒ null,
// which resolveOidcSignIn refuses (fail closed).
export async function loadOidcAllowlist(): Promise<OidcAllowlist | null> {
  const row = await prisma.setting.findUnique({ where: { key: OIDC_ALLOWLIST_SETTING_KEY } });
  return parseOidcAllowlist(row?.value);
}

// The exchange options a policy needs: the groups claim, only when there are
// groups to check (a userinfo round-trip otherwise buys nothing).
export function oidcExchangeOptionsFor(policy: OidcAllowlist | null): { groupsClaim?: string } {
  return policy && policy.groups.length > 0 ? { groupsClaim: policy.groupsClaim } : {};
}

export type OidcSignInRefusal = ProviderRefusalReason | "rebind_required" | "setup_required";

export type OidcSignInOutcome =
  | { ok: true; user: AuthorizedDbUser }
  | { ok: false; reason: OidcSignInRefusal };

// Allowlist, then the identity lookup, then (on success) the notification
// address. Every refusal is audited AUTH_LOGIN_FAILED with its reason — the
// client sees only a coarse code (oidcWebErrorCode / oidcNativeRefusal). DB
// faults propagate: they are not a verdict on the credential.
export async function resolveOidcSignIn(
  claims: OidcClaims,
  policy: OidcAllowlist | null,
  headers: Headers,
): Promise<OidcSignInOutcome> {
  const refuse = (reason: OidcSignInRefusal): OidcSignInOutcome => {
    void logAudit({
      userId: "anonymous",
      userName: "anonymous",
      action: "AUTH_LOGIN_FAILED",
      target: "auth:login",
      ipAddress: getClientIp(headers),
      userAgent: headers.get("user-agent")?.slice(0, 512) ?? null,
      provider: "oidc",
      details: { reason, ...(claims.email ? { emailHash: hashAuditEmail(normalizeEmail(claims.email)) } : {}) },
    });
    return { ok: false, reason };
  };

  if (!policy) {
    console.warn("[auth/oidc] Refused sign-in: the OIDC allowlist setting is unreadable. Re-save it in Settings → Authentication.");
    return refuse("allowlist_unreadable");
  }
  const allowlistRefusal = evaluateOidcAllowlist(policy, {
    email: claims.email,
    emailVerified: claims.emailVerified,
    groups: claims.groups,
  });
  if (allowlistRefusal) return refuse(allowlistRefusal);

  const result = await findOrCreateOidcUser(claims, { allowCreate: !policy.existingUsersOnly });
  if (result === PROVIDER_REBIND_REQUIRED) return refuse("rebind_required");
  if (result === PROVIDER_SETUP_REQUIRED) return refuse("setup_required");
  if (!isAuthorizedDbUser(result)) return refuse(result.reason);

  // Notifications go to the IdP's address only when the IdP vouches for it. An
  // unverified claim is whatever the user typed at the IdP, and copying it would
  // send someone else's request notifications there.
  if (claims.email && claims.emailVerified) {
    const oidcEmail = normalizeEmail(claims.email);
    await prisma.user
      .update({ where: { id: result.id }, data: { notificationEmail: oidcEmail } })
      .catch((err) => console.error("[auth/oidc] notificationEmail sync failed:", err instanceof Error ? err.message : err));
  }
  return { ok: true, user: result };
}

// The /login?error= code for a refusal (login-form.tsx words each one). The
// allowlist's reasons share one code: which rule refused is for the audit row,
// not for whoever is trying to get in.
export function oidcWebErrorCode(reason: OidcSignInRefusal): string {
  switch (reason) {
    case "rebind_required":
      return "oidc_rebind_required";
    case "setup_required":
      return "oidc_setup_required";
    case "email_unverified":
      return "oidc_email_unverified";
    case "issuer_mismatch":
      return "oidc_issuer_mismatch";
    case "not_in_allowed_group":
    case "email_domain_not_allowed":
    case "existing_users_only":
    case "allowlist_unreadable":
      return "oidc_not_allowed";
    case "email_missing":
    case "reserved_email":
    case "instance_mismatch":
      return "oidc_user_rejected";
  }
}

// The native route's status and message key for a refusal. 409 for the two
// refusals the app has always received as 409; 403 for the rest. The app shows
// the `error` string of any non-2xx answer, so a new reason needs no app change
// (guardrail 25).
export function oidcNativeRefusal(reason: OidcSignInRefusal): { status: 403 | 409; messageKey: string } {
  switch (reason) {
    case "rebind_required":
      return { status: 409, messageKey: "apiAuth.oidc.rebindRequired" };
    case "setup_required":
      return { status: 409, messageKey: "apiAuth.oidc.setupRequired" };
    case "email_unverified":
      return { status: 403, messageKey: "apiAuth.oidc.emailUnverified" };
    case "issuer_mismatch":
      return { status: 403, messageKey: "apiAuth.oidc.issuerMismatch" };
    case "not_in_allowed_group":
    case "email_domain_not_allowed":
    case "existing_users_only":
    case "allowlist_unreadable":
      return { status: 403, messageKey: "apiAuth.oidc.notAllowed" };
    case "email_missing":
    case "reserved_email":
    case "instance_mismatch":
      return { status: 403, messageKey: "apiAuth.oidc.userRejected" };
  }
}
