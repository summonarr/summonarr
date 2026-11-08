import { prisma } from "@/lib/prisma";
import { defaultPermissionsForRole } from "@/lib/permissions";
import { sanitizeOptional } from "@/lib/sanitize";
import { normalizeEmail } from "@/lib/email-normalize";
import { isReservedEmailDomain } from "@/lib/reserved-email";
import {
  hashAuditEmail,
  isPreSetupBootstrapBlocked,
  logBestEffortFailure,
  retryOnProvisionRace,
  PROVIDER_REBIND_REQUIRED,
  PROVIDER_SETUP_REQUIRED,
  ProviderRefusal,
  type AuthorizedDbUser,
  type ProviderLookupResult,
  type ProviderRebindRequired,
  type ProviderSetupRequired,
} from "@/lib/auth-provider";

// The OIDC identity lookup: (issuer, sub) is the identity (guardrail 34e); an
// email only ever links or creates, and only when the IdP verified it.

export interface OidcUserClaims {
  // The ID token's `iss` — the namespace `sub` is unique within.
  issuer: string;
  sub: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  preferredUsername: string | null;
  picture: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  idToken: string;
  expiresAt: number | null;
}

// Finds or creates a User for an OIDC identity — (issuer, sub), the IdP's
// stable user id within its own namespace. Used by both OIDC sign-in routes
// through resolveOidcSignIn (oidc-signin.ts), which applies the admin allowlist
// first. The Prisma extension auto-encrypts
// Account.{access_token,refresh_token,id_token} on write per guardrail 7a —
// callers must pass raw tokens.
//
// `allowCreate: false` is the allowlist's "existing users only" mode: a sign-in
// that would mint a new account is refused instead.
export async function findOrCreateOidcUser(
  claims: OidcUserClaims,
  opts: { allowCreate?: boolean } = {},
): Promise<ProviderLookupResult> {
  // The P2002 of a racing first sign-in surfaces from the create $transaction
  // in createOidcUser, so it is caught out here — never inside the tx
  // (guardrail 23).
  return retryOnProvisionRace(() => provisionOidcUser(claims, opts));
}

type OidcAccountTokens = {
  access_token: string | null;
  refresh_token: string | null;
  id_token: string;
  expires_at: number | null;
};

function oidcAccountTokens(claims: OidcUserClaims): OidcAccountTokens {
  return {
    access_token: claims.accessToken,
    refresh_token: claims.refreshToken,
    id_token: claims.idToken,
    expires_at: claims.expiresAt,
  };
}

async function provisionOidcUser(
  claims: OidcUserClaims,
  { allowCreate = true }: { allowCreate?: boolean },
): Promise<ProviderLookupResult> {
  const byAccount = await prisma.account.findUnique({
    where: { provider_providerAccountId: { provider: "oidc", providerAccountId: claims.sub } },
    include: { user: true },
  });
  if (byAccount?.user) return signInReturningOidcAccount({ ...byAccount, user: byAccount.user }, claims);

  // Email trust is only needed to LINK or CREATE by email. A returning user is
  // already bound by (issuer, sub) above — the sub is the identity, so an IdP
  // that stops sending email_verified (or the email) must not lock them out.
  // New links and new accounts keep the strict requirement.
  const email = await newOidcAccountEmail(claims, allowCreate);
  if (typeof email !== "string") return email;
  return createOidcUser(claims, email);
}

// A returning (issuer, sub). `sub` is unique only WITHIN an issuer (OIDC Core
// §2), so the row matches only under the issuer it was bound to — a changed
// OIDC_ISSUER must not sign a different IdP's user into this account
// (guardrail 34e). A row from before the column existed adopts this issuer,
// conditionally, so of two racing first sign-ins exactly one decides it; the
// loser re-reads. (The adoption writes `issuer` alone: account.updateMany
// refuses token columns, guardrail 7a.)
async function signInReturningOidcAccount(
  account: { id: string; issuer: string | null; user: AuthorizedDbUser },
  claims: OidcUserClaims,
): Promise<AuthorizedDbUser | ProviderRefusal> {
  let boundIssuer = account.issuer;
  if (boundIssuer === null) {
    const { count } = await prisma.account.updateMany({
      where: { id: account.id, issuer: null },
      data: { issuer: claims.issuer },
    });
    if (count === 1) {
      boundIssuer = claims.issuer;
    } else {
      const reread = await prisma.account.findUnique({ where: { id: account.id }, select: { issuer: true } });
      boundIssuer = reread?.issuer ?? null;
    }
  }
  if (boundIssuer !== claims.issuer) {
    console.warn("[auth/oidc] Refused sign-in: the subject is bound under a different issuer.");
    return new ProviderRefusal("issuer_mismatch");
  }
  // Refresh the stored OAuth tokens — the extension handles encryption.
  await prisma.account
    .update({ where: { id: account.id }, data: oidcAccountTokens(claims) })
    .catch(logBestEffortFailure("auth/oidc", "account token refresh"));
  const { id, email, name, role } = account.user;
  return { id, email, name, role };
}

// The normalized address a NEW link or account may use, or why it may not.
async function newOidcAccountEmail(
  claims: OidcUserClaims,
  allowCreate: boolean,
): Promise<string | ProviderRefusal | ProviderRebindRequired | ProviderSetupRequired> {
  if (!claims.emailVerified) {
    return new ProviderRefusal("email_unverified");
  }
  if (!claims.email) {
    console.error("[auth/oidc] provider returned no email — rejecting sign-in for sub:", claims.sub);
    return new ProviderRefusal("email_missing");
  }
  const normalizedEmail = normalizeEmail(claims.email);

  // An IdP that lets users pick their address could hand back one Summonarr
  // mints for itself (reserved-email.ts) — e.g. a Jellyfin user's placeholder,
  // squatting it so that user can never be provisioned.
  if (isReservedEmailDomain(normalizedEmail)) {
    console.warn("[auth/oidc] Refused sign-in: the email is in a domain Summonarr reserves for its own placeholder addresses.");
    return new ProviderRefusal("reserved_email");
  }

  // Same account-takeover guard as the Plex/Jellyfin paths: an existing user with
  // this email but no (provider=oidc, sub=...) Account row is the SSO-takeover
  // attack vector. Any IdP under attacker control (or a misconfigured/multi-tenant
  // one) that vouches `email_verified=true` for the victim's email would otherwise
  // auto-link the attacker's OIDC sub to the existing row and inherit its role —
  // including ADMIN. Email verification by the IdP is not sufficient because the
  // IdP itself is the untrusted party here. Refuse: an admin must rebind via an
  // explicit, logged-in "Link account" flow.
  const byEmail = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (byEmail) {
    console.warn(`[auth/oidc] Refused sign-in: the email (hash ${hashAuditEmail(normalizedEmail)}) matches user ${byEmail.id}, which has no oidc account binding. Manual rebind required.`);
    return PROVIDER_REBIND_REQUIRED;
  }

  if (!allowCreate) return new ProviderRefusal("existing_users_only");

  // Refuse to MINT THE FIRST USER via OIDC before setup has run — see
  // isPreSetupBootstrapBlocked. After that, normal OIDC onboarding proceeds.
  if (await isPreSetupBootstrapBlocked()) {
    console.warn("[auth/oidc] Refused pre-setup OIDC sign-in: complete initial setup (create the first admin) first.");
    return PROVIDER_SETUP_REQUIRED;
  }
  return normalizedEmail;
}

// Creates the user and its OAuth account in ONE transaction. The account must be
// a TOP-LEVEL account.create (NOT a nested `accounts: { create }` under
// user.create) so the prisma.ts encryption extension's account.create hook fires
// and encrypts access_token/refresh_token/id_token at rest. A nested relation
// write bypasses that hook and persists the tokens in plaintext. Guardrail 7a:
// never call encryptToken here — the extension owns it; it applies to the tx
// client, and the single $transaction keeps the original write's atomicity.
// The two writes run in sequence on the tx connection (guardrail 23c).
async function createOidcUser(claims: OidcUserClaims, normalizedEmail: string): Promise<AuthorizedDbUser> {
  return prisma.$transaction(async (tx) => {
    const u = await tx.user.create({
      data: {
        email: normalizedEmail,
        name: sanitizeOptional(claims.name ?? claims.preferredUsername),
        image: claims.picture,
        role: "USER",
        permissions: defaultPermissionsForRole("USER"),
        notificationEmail: normalizedEmail,
      },
      select: { id: true, email: true, name: true, role: true },
    });
    await tx.account.create({
      data: {
        userId: u.id,
        type: "oidc",
        provider: "oidc",
        providerAccountId: claims.sub,
        issuer: claims.issuer,
        ...oidcAccountTokens(claims),
      },
    });
    return u;
  });
}
