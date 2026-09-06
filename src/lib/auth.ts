import { prisma } from "@/lib/prisma";
import { headers } from "next/headers";
import { dummyVerify, verifyPassword, MAX_PASSWORD_LENGTH } from "@/lib/password-hash";
import { createHash, createHmac } from "crypto";
import { getPlexUser, getPlexFriendEmails, pingPlexToken, type PlexServerMembers } from "@/lib/plex";
import { authenticateWithJellyfin, authenticateWithJellyfinQuickConnect } from "@/lib/jellyfin";
import { getConfiguredJellyfinUrl } from "@/lib/jellyfin-config";
import { checkRateLimit, refundHit, getClientIp, ipBucketKey } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import { extractUaFingerprint, serializeFingerprint, fingerprintToLabel, matchesStoredFingerprint } from "@/lib/ua-fingerprint";
import { signSessionJwt, type SessionClaims } from "@/lib/session-jwt";
import { markUserForceRevalidate, markSessionForceRevoked } from "@/lib/session-revocation";
import type { SummonarrSession } from "@/lib/api-auth";
import { machineIpAllowed } from "@/lib/api-auth";
import { readSummonarrSession, readActiveSummonarrSession } from "@/lib/session-server";
import { defaultPermissionsForRole, effectivePermissions, parsePermissions, serializePermissions } from "@/lib/permissions";
import { sanitizeOptional, sanitizeText } from "@/lib/sanitize";
import { hasNativeClientHeader, NATIVE_CLIENT_HEADER } from "@/lib/mobile-auth";
import { NEVER_EXPIRES_AT_SEC } from "@/lib/session-lifetime";
import { type MediaInstanceKey, DEFAULT_MEDIA_INSTANCE, jellyfinSettingKey, plexSettingKey, mediaInstanceLabel } from "@/lib/media-instances";
import { getMediaInstances } from "@/lib/media-instance-registry";
import { getPlexConfig } from "@/lib/plex-config";

// Always run a password verify (even on missing accounts) to prevent timing-based user enumeration

// Wherever User.passwordHash is updated (e.g. src/app/api/profile/password/route.ts
// and admin password-set endpoints), the same code path must also call
// revokeAllUserSessions(userId) so the AuthSession rows are deleted and stale
// JWTs cannot refresh on any replica. This file does not write passwordHash directly.

import { normalizeEmail } from "@/lib/email-normalize";
// Re-exported so existing imports of `normalizeEmail` from "@/lib/auth"
// continue to work.
export { normalizeEmail };

// Hashes the lowercased email for audit storage. Truncated to 16 hex chars so a
// password accidentally typed in the email field can't be recovered from logs while
// still letting an operator correlate failed-login attempts on the same input.
export function hashAuditEmail(email: string): string {
  return createHash("sha256").update(email).digest("hex").slice(0, 16);
}

// Sentinel returned when a provider-bound lookup refuses sign-in due to an email
// collision with a user that has no corresponding provider subject yet. The caller
// translates this to `return null` from authorize() so NextAuth surfaces a generic
// failure to the client.
export const PROVIDER_REBIND_REQUIRED = Symbol("provider-rebind-required");
export type ProviderRebindRequired = typeof PROVIDER_REBIND_REQUIRED;

// Returned when an OIDC sign-in would mint the very FIRST user before setup has
// run (no admin exists and OAuth bootstrap isn't enabled). Creating a plain USER
// there trips the "registration closed" guard in /api/auth/register and bricks
// first-admin bootstrap — refuse instead. See runFirstAdminPromotion.
export const PROVIDER_SETUP_REQUIRED = Symbol("provider-setup-required");
export type ProviderSetupRequired = typeof PROVIDER_SETUP_REQUIRED;

export type AuthorizedDbUser = { id: string; email: string; name: string | null; role: string };

// True when minting the very FIRST user through an OAuth provider would brick
// first-admin bootstrap: OAuth bootstrap disabled, setup not yet completed, and no
// ADMIN exists. Creating a plain USER row in that state trips /api/auth/register's
// "registration closed" guard while runFirstAdminPromotion won't promote the row,
// leaving the instance with no admin and no way to create one. The Plex/Jellyfin
// create paths consult this before minting; OIDC inlines the same check.
async function isPreSetupBootstrapBlocked(): Promise<boolean> {
  if (process.env.SUMMONARR_ALLOW_OAUTH_FIRST_ADMIN === "true") return false;
  const setupRow = await prisma.setting.findUnique({ where: { key: "setup_completed_at" } });
  if (setupRow) return false;
  const existingAdmin = await prisma.user.findFirst({ where: { role: "ADMIN" }, select: { id: true } });
  return !existingAdmin;
}

export async function findOrCreatePlexUser({
  plexUserId,
  email,
  name,
  image,
  plexClientId,
}: {
  plexUserId: string;
  email: string;
  name?: string | null;
  image?: string | null;
  // The browser's X-Plex-Client-Identifier, when the sign-in carried a valid one.
  plexClientId?: string | null;
}): Promise<AuthorizedDbUser | ProviderRebindRequired | ProviderSetupRequired> {
  const normalized = normalizeEmail(email);
  // Provider-supplied display names are untrusted — strip HTML/control chars so
  // the name can't carry markup into any downstream sink (email/Discord/push),
  // mirroring the local-credentials register path.
  name = sanitizeOptional(name);

  // 1) Bind on (provider, sub) first. The external IdP's stable subject id is the
  //    only trustworthy identity anchor; email is NEVER the primary key for an
  //    external provider. Emails are reassignable and an attacker can stand up an
  //    account whose reported address matches an existing local user, so resolving
  //    identity by email would let one provider account silently take over another
  //    user's row. Matching on plexUserId avoids that entirely.
  const bySub = await prisma.user.findUnique({ where: { plexUserId } });
  if (bySub) {
    // notificationEmail is kept in lock-step with the Plex-verified email on every
    // sign-in so notifications always go to the user's current Plex address. This
    // is the ONE write per returning-user sign-in — the browser client id rides
    // along rather than costing authorizeWithPlex a second UPDATE on the same row.
    await prisma.user.update({
      where: { id: bySub.id },
      data: {
        notificationEmail: normalized,
        ...(name ? { name } : {}),
        ...(image ? { image } : {}),
        ...(plexClientId ? { plexClientId } : {}),
      },
    }).catch(() => {});
    return { id: bySub.id, email: bySub.email, name: name ?? bySub.name, role: bySub.role };
  }

  // 2) An existing row carrying this email but no plexUserId is the account-takeover
  //    surface: a Plex friend whose Plex-reported email happens to match a
  //    local-credentials user (potentially an admin) must NOT auto-link to that
  //    row and inherit its identity/role. Because we never reached step 1, no Plex
  //    sub is bound here yet — auto-linking on the email match alone would hand the
  //    incoming Plex account control of the existing user. Refuse and require an
  //    admin to perform an explicit, logged-in "link account" (rebind) instead.
  const byEmail = await prisma.user.findUnique({ where: { email: normalized } });
  if (byEmail) {
    console.warn(`[auth] Refused plex sign-in: ${normalized} matches an existing user with no plexUserId. Manual rebind required.`);
    return PROVIDER_REBIND_REQUIRED;
  }

  // Refuse to mint the first user pre-setup — see isPreSetupBootstrapBlocked.
  if (await isPreSetupBootstrapBlocked()) {
    console.warn(`[auth] Refused pre-setup plex sign-in for ${normalized}: complete initial setup (create the first admin) first.`);
    return PROVIDER_SETUP_REQUIRED;
  }

  // 3) New user — create with provider sub populated.
  const created = await prisma.user.create({
    data: {
      email: normalized,
      name: name ?? null,
      image: image ?? null,
      role: "USER",
      permissions: defaultPermissionsForRole("USER"),
      plexUserId,
      notificationEmail: normalized,
      plexClientId: plexClientId ?? null,
    },
    select: { id: true, email: true, name: true, role: true },
  });
  return created;
}

export async function findOrCreateJellyfinUser(
  jellyfinId: string,
  name: string,
  // Retained in the signature (the sign-in call sites pass their instance) even
  // though resolution is now instance-agnostic: it keyed the removed real-email
  // probe, and a future per-instance branch would want it back.
  _instance: MediaInstanceKey = DEFAULT_MEDIA_INSTANCE,
): Promise<AuthorizedDbUser | ProviderRebindRequired | ProviderSetupRequired> {
  // Provider-supplied display name is untrusted — strip HTML/control chars so it
  // can't carry markup into any downstream sink (email/Discord/push).
  name = sanitizeText(name);
  // Synthetic address is retained as a backward-compat anchor for users that
  // signed in before the (provider, sub) binding columns existed.
  const syntheticEmail = `jellyfin-${jellyfinId}@jellyfin.local`;

  // 1) Provider-subject lookup wins.
  const bySub = await prisma.user.findUnique({ where: { jellyfinUserId: jellyfinId } });
  if (bySub) {
    if (name && name !== bySub.name) {
      await prisma.user.updateMany({ where: { id: bySub.id }, data: { name } }).catch(() => {});
    }
    return { id: bySub.id, email: bySub.email, name: name ?? bySub.name, role: bySub.role };
  }

  // 2) Synthetic-email lookup for legacy rows. Backfill jellyfinUserId so
  //    subsequent sign-ins use the (sub) path.
  const bySynthetic = await prisma.user.findUnique({ where: { email: syntheticEmail } });
  if (bySynthetic) {
    await prisma.user.update({
      where: { id: bySynthetic.id },
      data: { jellyfinUserId: jellyfinId, ...(name ? { name } : {}) },
    }).catch(() => {});
    return { id: bySynthetic.id, email: bySynthetic.email, name: name ?? bySynthetic.name, role: bySynthetic.role };
  }

  // 3) NOTE on email: Jellyfin's API exposes no user email field (UserDto
  //    carries none in any version), so the old "real email" probe here always
  //    came back empty — every Jellyfin account anchors on the synthetic
  //    address. Email remains never a trusted cross-provider identity anchor;
  //    only the provider subject id (jellyfinUserId) is.

  // Refuse to mint the first user pre-setup — see isPreSetupBootstrapBlocked.
  if (await isPreSetupBootstrapBlocked()) {
    console.warn(`[auth] Refused pre-setup jellyfin sign-in for ${jellyfinId}: complete initial setup (create the first admin) first.`);
    return PROVIDER_SETUP_REQUIRED;
  }

  // 4) New user.
  const created = await prisma.user.create({
    data: {
      email: syntheticEmail,
      name: name ?? null,
      role: "USER",
      permissions: defaultPermissionsForRole("USER"),
      jellyfinUserId: jellyfinId,
    },
    select: { id: true, email: true, name: true, role: true },
  });
  return created;
}

export interface OidcUserClaims {
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

// Finds or creates a User for an OIDC sub. Replaces next-auth's adapter
// flow (getUserByAccount → getUserByEmail → linkAccount + maybe create) for
// the Summonarr-native OIDC callback. The Prisma extension auto-encrypts
// Account.{access_token,refresh_token,id_token} on write per guardrail 7a —
// callers must pass raw tokens.
export async function findOrCreateOidcUser(
  claims: OidcUserClaims,
): Promise<AuthorizedDbUser | ProviderRebindRequired | ProviderSetupRequired> {
  if (!claims.emailVerified) {
    throw new Error("OIDC account email is not verified");
  }
  if (!claims.email) {
    console.error("[auth/oidc] provider returned no email — rejecting sign-in for sub:", claims.sub);
    throw new Error("[auth/oidc] provider returned no email");
  }
  const normalizedEmail = normalizeEmail(claims.email);

  const accountTokens = {
    access_token: claims.accessToken,
    refresh_token: claims.refreshToken,
    id_token: claims.idToken,
    expires_at: claims.expiresAt,
  };

  const byAccount = await prisma.account.findUnique({
    where: { provider_providerAccountId: { provider: "oidc", providerAccountId: claims.sub } },
    include: { user: true },
  });
  if (byAccount?.user) {
    // Refresh the stored OAuth tokens — extension handles encryption
    await prisma.account
      .update({ where: { id: byAccount.id }, data: accountTokens })
      .catch((err) => console.error("[auth/oidc] account token refresh failed:", err instanceof Error ? err.message : err));
    return {
      id: byAccount.user.id,
      email: byAccount.user.email,
      name: byAccount.user.name,
      role: byAccount.user.role,
    };
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
    console.warn(`[auth/oidc] Refused sign-in: ${normalizedEmail} matches an existing user with no oidc account binding. Manual rebind required.`);
    return PROVIDER_REBIND_REQUIRED;
  }

  // Refuse to MINT THE FIRST USER via OIDC before setup has run. With OAuth
  // bootstrap disabled (the default), runFirstAdminPromotion won't promote this
  // sign-in, so a plain USER row would close /api/auth/register's "registration"
  // guard and permanently brick first-admin setup. Mirrors the promotion
  // preconditions: only block when bootstrap is off AND setup isn't complete AND
  // no admin exists yet. After that, normal OIDC onboarding proceeds.
  if (process.env.SUMMONARR_ALLOW_OAUTH_FIRST_ADMIN !== "true") {
    const setupRow = await prisma.setting.findUnique({ where: { key: "setup_completed_at" } });
    if (!setupRow) {
      const existingAdmin = await prisma.user.findFirst({ where: { role: "ADMIN" }, select: { id: true } });
      if (!existingAdmin) {
        console.warn(`[auth/oidc] Refused pre-setup OIDC sign-in for ${normalizedEmail}: complete initial setup (create the first admin) first.`);
        return PROVIDER_SETUP_REQUIRED;
      }
    }
  }

  // Create the user and its OAuth account in ONE transaction. The account must be
  // a TOP-LEVEL account.create (NOT a nested `accounts: { create }` under
  // user.create) so the prisma.ts encryption extension's account.create hook fires
  // and encrypts access_token/refresh_token/id_token at rest. A nested relation
  // write bypasses that hook and persists the tokens in plaintext. Guardrail 7a:
  // never call encryptToken here — the extension owns it; it applies to the tx
  // client, and the single $transaction keeps the original write's atomicity.
  const created = await prisma.$transaction(async (tx) => {
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
        ...accountTokens,
      },
    });
    return u;
  });
  return created;
}

const DEFAULT_SESSION_SECONDS        = 3_600;
const DEFAULT_MOBILE_SESSION_SECONDS = 604_800;
const DEFAULT_MAX_SESSION_SECONDS    = 2_592_000;

// Native-app (bearer) sessions never expire by time — the deadline is the
// never-reached NEVER_EXPIRES_AT_SEC sentinel (see session-lifetime.ts for why a
// sentinel and not an absent claim). The token lives in the iOS Keychain
// (hardware-backed, not an ambient cookie) and bearer clients have no refresh
// channel (guardrail 6b), so "never expires" is the mechanism that keeps the app
// signed in. NOT a security hole: DB revocation — sign-out, a per-device revoke,
// sign-out-everywhere, a password change, the sessionsRevokedAt/passwordChangedAt
// cutoffs, account deactivation — still invalidates it on the next request,
// independent of the deadline. Granted ONLY to a caller presenting the
// X-Summonarr-Client header (a custom header a cross-origin page cannot attach to
// a credentialed request), so web "remember me" is unaffected.

// Hard ceiling for ADMIN-CONFIGURABLE durations (the sessionDefault/Mobile/Max settings)
// — prevents an admin from configuring an unbounded JWT lifetime. The native sentinel
// above is a deliberate code-level constant and is intentionally not bound by this.
const MAX_ALLOWED_SESSION_SECONDS = 90 * 24 * 60 * 60;

type SessionDurations = { desktopDuration: number; mobileDuration: number; maxDuration: number };

const SESSION_DURATIONS_TTL_MS = 5 * 60 * 1000;
let sessionDurationsCache: { value: SessionDurations; expiresAt: number } | null = null;

export function invalidateSessionDurationsCache(): void {
  sessionDurationsCache = null;
}

// Reads the admin-configurable desktop/mobile/max session TTLs (5-min cached),
// each capped at MAX_ALLOWED_SESSION_SECONDS, falling back to the DEFAULT_* consts.
export async function getSessionDurations(): Promise<SessionDurations> {
  const now = Date.now();
  if (sessionDurationsCache && sessionDurationsCache.expiresAt > now) {
    return sessionDurationsCache.value;
  }
  const rows = await prisma.setting.findMany({
    where: { key: { in: ["sessionDefaultDuration", "sessionMobileDuration", "sessionMaxDuration"] } },
  });
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  // Symmetric clamp: the settings route enforces [60, MAX] at write time, but a
  // hand-edited row or a restored pre-clamp backup can carry 0/negative — which
  // would mint a session already past its deadline and present as an
  // instant-logout loop on every sign-in. Clamp reads the same way as writes.
  const cap = (n: number) => Math.min(Math.max(n, 60), MAX_ALLOWED_SESSION_SECONDS);
  const value: SessionDurations = {
    desktopDuration: cap(parseInt(map.sessionDefaultDuration ?? "") || DEFAULT_SESSION_SECONDS),
    mobileDuration:  cap(parseInt(map.sessionMobileDuration  ?? "") || DEFAULT_MOBILE_SESSION_SECONDS),
    maxDuration:     cap(parseInt(map.sessionMaxDuration     ?? "") || DEFAULT_MAX_SESSION_SECONDS),
  };
  sessionDurationsCache = { value, expiresAt: now + SESSION_DURATIONS_TTL_MS };
  return value;
}

export function isTokenExpired(session: SummonarrSession | null): boolean {
  // A null session is not a valid, unexpired session — report expired. Every
  // current caller guards with `!session || …` or a `session?.… &&` short-
  // circuit, so this only hardens against a future caller that writes
  // `if (!isTokenExpired(session)) allow()` and would otherwise treat a missing
  // session as valid.
  if (!session) return true;
  return !!session.tokenExpiresAt && Math.floor(Date.now() / 1000) > session.tokenExpiresAt;
}

function claimsToSession(claims: SessionClaims): SummonarrSession {
  return {
    user: {
      id: claims.id,
      role: claims.role,
      permissions: effectivePermissions(claims.role, parsePermissions(claims.permissions)),
      email: claims.email ?? null,
      name: claims.name ?? null,
      provider: claims.provider,
      mediaServer: claims.mediaServer ?? null,
    },
    sessionId: claims.sessionId,
    tokenExpiresAt: claims.expiresAt,
  };
}

// Server-component-friendly session reader. Mirrors what next-auth's `auth()`
// exported — synchronous-looking API that returns SummonarrSession | null.
// JWT-only: verifies signature + expiry, NOT DB revocation/role-rotation. Fine
// for personalization reads; for an AUTHORIZATION decision in a page/layout use
// authActive() instead. Routes that need 401/403 semantics should use
// requireAuth/withAuth from @/lib/api-auth.
export async function auth(): Promise<SummonarrSession | null> {
  const claims = await readSummonarrSession();
  return claims ? claimsToSession(claims) : null;
}

// DB-checked counterpart of auth() for AUTHORIZATION decisions in server
// components (page/layout role guards). Routes through readActiveSummonarrSession
// → verifyAndRefreshSession, so a revoked AuthSession, sessionsRevokedAt/
// passwordChangedAt cutoff, or role demotion is honored immediately — not just
// the JWT signature + expiry. Required because proxy.ts's matcher skips prefetch
// requests (next-router-prefetch / purpose=prefetch), so a page that makes a
// role-based redirect cannot assume the proxy's DB check has run. Same
// SummonarrSession shape as auth(), so it is a drop-in replacement at the guard.
export async function authActive(): Promise<SummonarrSession | null> {
  const claims = await readActiveSummonarrSession();
  if (!claims) return null;
  // UA-fingerprint replay check — parity with the proxy and the withAuth/withAdmin
  // wrappers ([api-auth.ts]). The proxy's matcher skips prefetch requests, so the
  // page-render path must re-enforce the cookie→device binding here too: otherwise a
  // stolen cookie replayed with a prefetch-looking header could render protected
  // pages. Page renders are cookie/SSR only (no bearer); machine:/no-fingerprint
  // sessions are skipped inside the helper.
  const h = await headers();
  if (!matchesStoredFingerprint(claims.uaFingerprint, h.get("user-agent"))) return null;
  // A machine session carries a mint-time IP allowlist; the API guards + isCronAuthorized
  // enforce it, so bind the page-render path too — else a leaked machine JWT could render
  // admin pages from a disallowed IP. Absent/empty allowlist ⇒ true (no restriction).
  if (!machineIpAllowed(claims, h as unknown as Headers)) return null;
  return claimsToSession(claims);
}

export function invalidateUserSession(userId: string): void {
  markUserForceRevalidate(userId);
}

export async function revokeSessionById(sessionId: string): Promise<void> {
  // Deliberately does NOT touch sessionsRevokedAt.
  //
  // It used to bump the cutoff to the revoked row's createdAt, on the theory that
  // another replica might serve the deleted session from its dbCheckedAt cache.
  // That reasoning does not survive contact with the code: the cutoff is only ever
  // consulted on the SLOW path, where the AuthSession row-presence check already
  // rejects the deleted session several lines earlier; on the FAST path the
  // function returns before it even loads the user, so the cutoff is unreachable
  // there. And this deployment is a single Node process (guardrail 17), so
  // markSessionForceRevoked below forces the very next request onto the slow path
  // anyway. The bump bought nothing.
  //
  // What it cost was real. The cutoff is `iat <= sessionsRevokedAt`, and it is
  // per-USER, so anchoring it to one session's createdAt also kills every session
  // minted earlier. Cookie sessions hide this — they are re-signed constantly, so
  // their iat is always newer — but a bearer/native token keeps its sign-in iat for
  // its whole (now indefinite) life. Revoking a laptop therefore signed out every iOS device
  // that had been signed in longer. Revoke-all still stamps a cutoff ("now"), which
  // is correct for its everywhere semantics.
  try {
    await prisma.$transaction(async (tx) => {
      await tx.authSession.delete({ where: { sessionId } });
    });
  } catch (err) {
    // Idempotent: a concurrent revoke of the SAME session (a retried native
    // sign-out, or the admin route racing the user's own DELETE /api/sessions)
    // already removed the row. The revocation the caller asked for is a fact, so
    // a not-found (P2025) is success, not a 500 that skips the audit row. There
    // is deliberately no find-then-delete: a plain SELECT takes no lock, so both
    // racers observed the row and the loser's DELETE affected 0 rows anyway.
    if (!isPrismaNotFound(err)) throw err;
  }
  // Mark in-memory only AFTER the DB revocation commits (matches
  // revokeAllUserSessions). Every other error is intentionally not swallowed: a
  // failed revoke propagates so the caller returns 500 instead of auditing a
  // phantom revocation that left the AuthSession row live (it would resurrect on
  // restart).
  markSessionForceRevoked(sessionId);
}

function isPrismaNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2025";
}

export async function revokeAllUserSessions(userId: string): Promise<void> {
  // All three writes wrapped in a $transaction so a failed sessionsRevokedAt
  // bump rolls back the AuthSession deletion — otherwise we'd end up with rows
  // gone (primary path) but the cross-replica timestamp backstop never set, so
  // a cached JWT on another replica would pass validation for up to 60s
  // (refreshToken's dbCheckedAt window) by failing both the row-presence check
  // AND the cutoff check.
  const sessionIds = await prisma.$transaction(async (tx) => {
    const sessions = await tx.authSession.findMany({
      where: { userId },
      select: { sessionId: true },
    });
    await tx.authSession.deleteMany({ where: { userId } });
    await tx.user.update({
      where: { id: userId },
      data: { sessionsRevokedAt: new Date() },
    });
    return sessions.map((s) => s.sessionId);
  });

  for (const sessionId of sessionIds) markSessionForceRevoked(sessionId);
  markUserForceRevalidate(userId);
}

export interface DeviceMeta {
  _sessionId: string;
  _uaFingerprint: string;
  _isMobile: boolean;
  _deviceLabel: string;
  _auditIp: string;
  _auditUa: string;
}

// Derives the per-device session metadata (fresh sessionId, UA fingerprint,
// mobile flag, device label, audit IP/UA) from the request headers at sign-in.
export function buildDeviceMeta(headers: Headers): DeviceMeta {
  const ua           = headers.get("user-agent") ?? "";
  const ip           = getClientIp(headers);
  const fp           = extractUaFingerprint(ua);
  return {
    _sessionId:     crypto.randomUUID(),
    _uaFingerprint: serializeFingerprint(fp),
    _isMobile:      fp.device !== "desktop",
    _deviceLabel:   fingerprintToLabel(fp),
    _auditIp:       ip,
    _auditUa:       ua.slice(0, 512),
  };
}

type JwtToken = Record<string, unknown>;

// Mutates `token` in place at sign-in: fills sessionId, computes the TTL →
// expiresAt, resolves mediaServer when not provider-pinned, and
// upserts the backing AuthSession row.
export async function initializeTokenOnSignIn(token: JwtToken, user: Record<string, unknown>): Promise<JwtToken> {
  if (!token.sessionId) {
    // Credentials provider supplies _sessionId via DeviceMeta; OIDC/OAuth do not
    token.sessionId = crypto.randomUUID();
  }

  const rememberMe = (user as { rememberMe?: string }).rememberMe === "true";
  const isMobile   = token.isMobile as boolean | undefined;
  const { desktopDuration, mobileDuration, maxDuration } = await getSessionDurations();

  // The never-expiring native-app session is reserved for a real native client,
  // identified by the X-Summonarr-Client header it presents (a custom header a
  // cross-origin web page cannot forge on a credentialed request — guardrail 6b).
  // A spoofed mobile User-Agent alone (isMobile is UA-derived) must NOT grant it,
  // or any browser could mint a never-expiring cookie by lying about its UA.
  let isNativeClient = false;
  try {
    const { headers: getHeaders } = await import("next/headers");
    const h = await getHeaders();
    isNativeClient = hasNativeClientHeader(h.get(NATIVE_CLIENT_HEADER));
  } catch {
    // Invoked outside a request context — treat as non-native.
  }

  let expiresAt: number;
  if (isNativeClient) {
    // Native app (iOS Keychain bearer) — no time-based expiry. Every native
    // sign-in qualifies regardless of rememberMe / device class: the header is
    // the signal, the UA only feeds the device label. See session-lifetime.ts.
    expiresAt = NEVER_EXPIRES_AT_SEC;
  } else {
    let ttl: number;
    if (rememberMe) {
      // Web "remember me" — admin-configurable maxDuration (30d default, capped at 90d).
      ttl = maxDuration;
    } else if (isMobile) {
      ttl = mobileDuration;
    } else {
      ttl = desktopDuration;
    }
    // The session deadline, captured once at sign-in. verifyAndRefreshSession
    // enforces it on every DB-checked verify and re-signs the JWT / cookie out to
    // exactly this instant — there is no inactivity window on top of it (guardrail
    // 6c), and it can never move, so a session can't outlive the configured
    // duration (itself capped at MAX_ALLOWED_SESSION_SECONDS in getSessionDurations()).
    expiresAt = Math.floor(Date.now() / 1000) + ttl;
  }
  token.expiresAt = expiresAt;

  const userId = user.id as string | undefined;
  if (!token.mediaServer && userId) {
    const dbUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { mediaServer: true },
    });
    token.mediaServer = dbUser?.mediaServer ?? null;
  }

  if (userId) {
    const sessionId   = token.sessionId as string;
    const deviceLabel = (token.deviceLabel as string | undefined) ?? null;
    const deviceType  = isMobile ? "mobile" : "desktop";
    const ipAddress   = (user as { _auditIp?: string })._auditIp ?? null;
    await prisma.authSession.upsert({
      where: { sessionId },
      update: { lastSeenAt: new Date(), expiresAt: new Date((token.expiresAt as number) * 1000) },
      create: {
        sessionId,
        userId,
        deviceType,
        deviceLabel,
        ipAddress,
        expiresAt:   new Date((token.expiresAt as number) * 1000),
      },
    });
  }

  return token;
}


export async function authorizeWithCredentials(
  credentials: Partial<Record<string, unknown>>,
  req: Request,
): Promise<Record<string, unknown> | null> {
  if (!credentials?.email || !credentials?.password) return null;
  if ((credentials.password as string).length > MAX_PASSWORD_LENGTH) return null;

  const disableRow = await prisma.setting.findUnique({ where: { key: "disableLocalLogin" } });
  if (disableRow?.value === "true") return null;

  const headers = (req as Request).headers as Headers;
  const ip = getClientIp(headers);
  const ua = headers.get("user-agent")?.slice(0, 512) ?? null;
  const email = normalizeEmail(credentials.email as string);

  // Two independent throttles:
  //   • Per-IP — bounds rapid attempts from one source, counting EVERY attempt
  //     (consumed here, before the password check). When the IP is unknowable
  //     (TRUST_PROXY unset → getClientIp returns "unknown"), attempts share one
  //     looser `login-ip:unknown` bucket rather than going unthrottled: a single
  //     shared bucket can't pin the lockout on a specific victim, and the higher
  //     limit keeps ordinary typos across the instance from tripping it.
  //   • Per-account — ALWAYS enforced so a password-spray distributed across
  //     many IPs against one account is still bounded (the per-IP bucket can't
  //     see that). PEEK to gate, RECORD only on an ACTUAL FAILED PASSWORD
  //     VERIFICATION — an attacker who merely knows the victim's email can no
  //     longer burn the account's lockout without supplying wrong passwords.
  //     Generous window so ordinary mistyping doesn't lock a user out.
  //     In-memory and per-replica like the rest of the limiter.
  const emailHash = hashAuditEmail(email);
  const accountKey = `login-email:${emailHash}`;
  const accountLimit = 50;
  const accountWindowMs = 15 * 60 * 1000;

  // NOTE: there is deliberately no special case for an indeterminate client IP.
  // getClientIp never returns the bare string "unknown" — when the address can't be
  // trusted it returns `unknown:<uaHash>`, a per-User-Agent bucket (see
  // untrustedBucket in rate-limit.ts). The old `ip === "unknown"` test was therefore
  // dead: it was meant to widen the limit to 100 for a single shared bucket, but the
  // bucket is already per-UA, so the standard limit applies per bucket and no group
  // of users shares one counter. Don't reintroduce a widened limit here — that would
  // loosen the throttle without the shared-bucket problem it was written for.
  const ipKey = `login-ip:${ipBucketKey(ip)}`;
  const ipLimit = 20;
  const ipAllowed = checkRateLimit(ipKey, ipLimit, 5 * 60 * 1000);
  // RESERVE atomically rather than peek. peekRateLimit is synchronous but the verify
  // below is awaited, so concurrent attempts all passed a peek before any of them
  // recorded — an attacker firing N requests at once got N password verifications
  // regardless of the limit. checkRateLimit checks and pushes in one step; the hit is
  // refunded on a successful login so the original intent still holds (the account
  // bucket counts real failed verifications, not successful sign-ins).
  const accountAllowed = checkRateLimit(accountKey, accountLimit, accountWindowMs);

  if (!ipAllowed || !accountAllowed) {
    void logAudit({ userId: "anonymous", userName: "anonymous", action: "AUTH_LOGIN_FAILED", target: "auth:login", ipAddress: ip, userAgent: ua, provider: "credentials", details: { reason: "rate_limited", emailHash } });
    return null;
  }

  const user = await prisma.user.findUnique({ where: { email } });

  let valid = false;
  if (user?.passwordHash) {
    valid = await verifyPassword(credentials.password as string, user.passwordHash);
  } else {
    await dummyVerify();
  }

  if (!valid || !user) {
    // The hit was already reserved at the gate above — a genuine wrong password (or an
    // unknown account, which also reached the dummyVerify branch) simply keeps it.
    void logAudit({ userId: "anonymous", userName: "anonymous", action: "AUTH_LOGIN_FAILED", target: "auth:login", ipAddress: ip, userAgent: ua, provider: "credentials", details: { reason: "invalid_credentials", emailHash } });
    return null;
  }

  // Successful sign-in: give the reserved slot back so the account bucket still counts
  // only failures, exactly as the peek/record split intended.
  refundHit(accountKey);

  const device = buildDeviceMeta(headers);
  return { id: user.id, email: user.email, name: user.name, role: user.role, rememberMe: credentials.rememberMe as string | undefined, ...device };
}

export async function authorizeWithPlex(
  credentials: Partial<Record<string, unknown>>,
  req: Request,
): Promise<Record<string, unknown> | null> {
  if (!credentials?.plexToken) return null;
  const headers = (req as Request).headers as Headers;
  const ip = getClientIp(headers);
  const ua = headers.get("user-agent")?.slice(0, 512) ?? null;

  if (!checkRateLimit(`plex-ip:${ipBucketKey(ip)}`, 20, 5 * 60 * 1000)) {
    void logAudit({ userId: "anonymous", userName: "anonymous", action: "AUTH_LOGIN_FAILED", target: "auth:login", ipAddress: ip, userAgent: ua, provider: "plex", details: { reason: "rate_limited" } });
    return null;
  }
  const tokenKey = (credentials.plexToken as string).slice(0, 16);
  if (!checkRateLimit(`plex:${tokenKey}`, 10, 5 * 60 * 1000)) {
    void logAudit({ userId: "anonymous", userName: "anonymous", action: "AUTH_LOGIN_FAILED", target: "auth:login", ipAddress: ip, userAgent: ua, provider: "plex", details: { reason: "rate_limited" } });
    return null;
  }

  let plexResult: ReturnType<typeof buildDeviceMeta> & { id: string; email: string; name: string | null; role: string; rememberMe?: string } | null = null;
  try {

    const browserClientId = typeof credentials.plexClientId === "string" && /^[a-f0-9-]{8,64}$/i.test(credentials.plexClientId)
      ? credentials.plexClientId
      : undefined;

    const plexToken = credentials.plexToken as string;
    const plexTokenHashSecret = process.env.NEXTAUTH_SECRET;
    if (!plexTokenHashSecret) throw new Error("[auth] NEXTAUTH_SECRET required for plex token hashing");
    const tokenHash = createHmac("sha256", plexTokenHashSecret).update(plexToken).digest("hex");

    const CACHE_TTL_DAYS = 30;
    const cacheCutoff = new Date(Date.now() - CACHE_TTL_DAYS * 24 * 60 * 60 * 1000);
    const cached = await prisma.plexTokenCache.findUnique({ where: { tokenHash } });

    // Refuse Plex sign-in entirely when no Plex server is configured. The
    // membership gate below allows a Plex account only if its email is in the set
    // returned by getPlexFriendEmails(adminToken, serverUrl) for some configured
    // instance — i.e. users with access to THAT specific server. Without a server
    // URL that scoping is lost and the friend-list filter degrades to "anyone the
    // admin has shared ANY server (or library) with on their whole Plex account,"
    // which can be a far wider, attacker-influenceable population than the
    // intended instance members. Fail closed rather than authenticate against an
    // unscoped friend list.
    //
    // Per-instance configs are read up front, before identity resolution —
    // exactly where the old single-server read sat. An instance with a blank
    // (trimmed) URL or token is skipped: this reproduces getSyncableMediaInstances'
    // filter with findUnique-only reads (getPlexConfig + one AdminEmail read per
    // instance, which getPlexConfig doesn't carry), the same pattern as the
    // Phase-2 play-history poller.
    const registered = await getMediaInstances("plex");
    const instances: { slug: MediaInstanceKey; url: string; token: string; adminEmail: string | null }[] = [];
    for (const inst of registered) {
      const [cfg, adminEmailRow] = await Promise.all([
        getPlexConfig(inst.slug),
        prisma.setting.findUnique({ where: { key: plexSettingKey(inst.slug, "AdminEmail") } }),
      ]);
      const url = cfg.url?.trim() ?? "";
      const token = cfg.token?.trim() ?? "";
      if (!url || !token) continue;
      instances.push({ slug: inst.slug, url, token, adminEmail: adminEmailRow?.value ?? null });
    }
    if (instances.length === 0) {
      console.warn("[auth] Plex sign-in refused: no Plex server is configured.");
      void logAudit({ userId: "anonymous", userName: "anonymous", action: "AUTH_LOGIN_FAILED", target: "auth:login", ipAddress: ip, userAgent: ua, provider: "plex", details: { reason: "plex_server_not_configured" } });
      // Fall through to the unified failure path below.
      await dummyVerify();
      return null;
    }

    let verifiedEmail: string | null = null;
    let plexUserSub:   string | null = null;
    let plexName: string | null = null;
    let plexThumb: string = "";

    if (cached && cached.verifiedAt > cacheCutoff) {
      // Cache hit is only honored when the row carries the Plex
      // subject id — looking the bound user up by email would let an
      // attacker whose Plex account happens to share a stale cache
      // row's email inherit that row's identity. Legacy rows
      // (plexUserId === null, written before the column existed) fall
      // through to the full /api/v2/user round-trip, which re-binds
      // the cache row to the verified sub.
      if (cached.plexUserId) {
        const stillValid = await pingPlexToken(plexToken, browserClientId);
        if (stillValid) {
          const existing = await prisma.user.findUnique({
            where: { plexUserId: cached.plexUserId },
            select: { id: true, plexUserId: true, email: true },
          });
          if (existing?.plexUserId) {
            verifiedEmail = cached.email;
            plexUserSub   = existing.plexUserId;
            await prisma.plexTokenCache.update({
              where: { tokenHash },
              data: {
                lastUsedAt: new Date(),
                expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
              },
            });
          }
          // No bound row for this sub yet — fall through to the full
          // lookup so we can properly bind plexUserId on first sign-in.
        } else {
          // Token was revoked in Plex — purge cache so next attempt re-validates from scratch
          await prisma.plexTokenCache.delete({ where: { tokenHash } }).catch(() => {});
        }
      }
      // else: legacy row without plexUserId — skip the cache hit and
      // let the round-trip below re-populate the column.
    }

    if (!verifiedEmail || !plexUserSub) {
      const plexUser = await getPlexUser(plexToken, browserClientId);
      verifiedEmail = normalizeEmail(plexUser.email);
      plexUserSub   = plexUser.id;
      plexName = plexUser.username;
      plexThumb = plexUser.thumb;
      // 90-day TTL — bumped on every cache hit + on this re-verify path.
      const plexCacheExpiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
      await prisma.plexTokenCache.upsert({
        where: { tokenHash },
        create: { tokenHash, email: verifiedEmail, plexUserId: plexUserSub, expiresAt: plexCacheExpiresAt },
        update: { email: verifiedEmail, plexUserId: plexUserSub, verifiedAt: new Date(), lastUsedAt: new Date(), expiresAt: plexCacheExpiresAt },
      });
    }

    // Membership gate — first match wins across every configured instance,
    // default first. A Plex account is admitted when its verified email is on
    // the friend list of ANY configured server (scoped to that server's
    // machineIdentifier) or is that instance's admin email. Per-instance
    // failures are isolated so one unreachable server can't block sign-in via
    // a healthy one — but each instance still fails CLOSED on a plex.tv error
    // (skip it; never fall back to an unscoped list).
    for (const inst of instances) {
      let allowed: PlexServerMembers;
      try {
        allowed = await getPlexFriendEmails(inst.token, inst.url);
      } catch (err) {
        console.warn(`[plex auth] membership check failed for ${mediaInstanceLabel("plex", inst.slug)}:`, err instanceof Error ? err.message : String(err));
        continue;
      }
      // normalizeEmail (NFKC + lowercase + trim) — verifiedEmail is normalized the
      // same way, and plex-membership.ts normalizes identically, so a Setting value
      // with stray whitespace/Unicode form can't make the two gates disagree. Added
      // unconditionally after the fetch: an admin-only server with an empty friend
      // list must still admit its admin.
      if (inst.adminEmail) allowed.emails.add(normalizeEmail(inst.adminEmail));

      // Immutable plex.tv account id first (the same namespace sign-in pins to
      // User.plexUserId — same identity by construction), email as the legacy
      // fallback: an email is user-changeable on plex.tv, and a mid-window
      // change used to bounce the member off sign-in entirely.
      if (!allowed.ids.has(plexUserSub) && !allowed.emails.has(verifiedEmail)) continue;

      const plexDbUser = await findOrCreatePlexUser({
        plexUserId: plexUserSub,
        email: verifiedEmail,
        name: plexName,
        image: plexThumb,
        plexClientId: browserClientId,
      });

      if (plexDbUser === PROVIDER_REBIND_REQUIRED) {
        void logAudit({ userId: "anonymous", userName: "anonymous", action: "AUTH_LOGIN_FAILED", target: "auth:login", ipAddress: ip, userAgent: ua, provider: "plex", details: { reason: "email_collision_needs_rebind", emailHash: hashAuditEmail(verifiedEmail) } });
      } else if (plexDbUser === PROVIDER_SETUP_REQUIRED) {
        void logAudit({ userId: "anonymous", userName: "anonymous", action: "AUTH_LOGIN_FAILED", target: "auth:login", ipAddress: ip, userAgent: ua, provider: "plex", details: { reason: "setup_required", emailHash: hashAuditEmail(verifiedEmail) } });
      } else {
        // notificationEmail + plexClientId were written by findOrCreatePlexUser
        // (one UPDATE for a returning user, the CREATE for a new one) — no second
        // write on the same row here.
        const device = buildDeviceMeta(headers);
        plexResult = { ...plexDbUser, rememberMe: credentials.rememberMe as string | undefined, ...device };
      }
      // Identity (findOrCreatePlexUser) is instance-independent — a sentinel
      // refusal here would repeat identically on every remaining instance, so
      // the loop stops at the first membership match either way.
      break;
    }
  } catch (err) {
    console.error("[plex auth] error:", err);
  }
  if (!plexResult) {
    // Constant-time delay mirrors the credentials provider path to prevent timing oracle
    await dummyVerify();
    void logAudit({ userId: "anonymous", userName: "anonymous", action: "AUTH_LOGIN_FAILED", target: "auth:login", ipAddress: ip, userAgent: ua, provider: "plex", details: { reason: "invalid_credentials" } });
    return null;
  }
  return { ...plexResult };
}

// Jellyfin sign-in membership gate. Mirrors Plex's friend-list gate — a valid
// Jellyfin credential alone is NOT sufficient to sign in. Without this gate, every
// account on the configured Jellyfin server (which an admin may not fully control,
// or which may have public/self-registration enabled) could authenticate into
// Summonarr, request media, and consume the request/issue surfaces. The account
// must instead be a known member of THIS Summonarr instance. The gate is
// fail-closed by default (only an explicit `jellyfinRestrictSignIn = "false"`
// setting disables it). Allowed when EITHER:
//   • an active jellyfin MediaServerUser row exists for this sourceUserId
//     (a synced member — the library sync populates this table), OR
//   • a Summonarr User is already bound to this jellyfinUserId (a returning user,
//     so an upgrade can't lock out anyone who has already signed in).
// A brand-new, unknown Jellyfin account (no MediaServerUser, no bound User) is
// refused until an admin syncs the library or allows them.
//
// Both the restrict-sign-in policy and the membership check are scoped to the
// instance the credential was verified against — a server B account must not
// be admitted by server A's MediaServerUser rows (or vice versa). The
// "already-bound returning user" bypass stays GLOBAL and unscoped: identity
// binding (User.jellyfinUserId) is a single cross-instance anchor by design
// (see the multi-server plan's decision #6), so a user who has ever bound to
// this jellyfinUserId on ANY instance must not be locked out by an instance's
// restrict policy.
async function isJellyfinSignInAllowed(jellyfinUserId: string, instance: MediaInstanceKey): Promise<boolean> {
  const restrictRow = await prisma.setting.findUnique({ where: { key: jellyfinSettingKey(instance, "RestrictSignIn") } });
  const restrict = (restrictRow?.value ?? "true").trim().toLowerCase() !== "false";
  if (!restrict) return true;
  const [member, existing] = await Promise.all([
    prisma.mediaServerUser.findFirst({
      where: { source: "jellyfin", serverInstance: instance, sourceUserId: jellyfinUserId, active: true },
      select: { id: true },
    }),
    prisma.user.findUnique({ where: { jellyfinUserId }, select: { id: true } }),
  ]);
  return Boolean(member || existing);
}

export async function authorizeWithJellyfin(
  credentials: Partial<Record<string, unknown>>,
  req: Request,
  instance: MediaInstanceKey = DEFAULT_MEDIA_INSTANCE,
): Promise<Record<string, unknown> | null> {
  if (!credentials?.username || !credentials?.password) return null;
  const username = credentials.username as string;
  if (username.length > 200 || (credentials.password as string).length > MAX_PASSWORD_LENGTH) {
    return null;
  }
  const headers = (req as Request).headers as Headers;
  const ip = getClientIp(headers);
  const ua = headers.get("user-agent")?.slice(0, 512) ?? null;

  // Deliberately NOT scoped by instance — an attacker's per-IP attempt budget
  // must not multiply with the number of configured Jellyfin servers.
  if (!checkRateLimit(`jellyfin-ip:${ipBucketKey(ip)}`, 10, 5 * 60 * 1000)) {
    void logAudit({ userId: "anonymous", userName: "anonymous", action: "AUTH_LOGIN_FAILED", target: "auth:login", ipAddress: ip, userAgent: ua, provider: "jellyfin", details: { reason: "rate_limited" } });
    return null;
  }

  // SECOND bucket, keyed on the credential rather than the caller — the bucket
  // above is NOT sufficient on its own. When TRUST_PROXY is not "true" (the
  // default docker deployment ships it blank), getClientIp falls back to
  // untrustedBucket, a hash of the User-Agent — a header the caller sets. An
  // attacker who rotates it per request gets a fresh bucket every time and an
  // unlimited number of guesses, and stock Jellyfin has no account lockout of
  // its own, which made this an unthrottled password-guessing proxy for the
  // media server.
  //
  // Both sibling providers already carry such a bucket — plex keys on the token
  // (`plex:${tokenKey}`) and QuickConnect on the secret
  // (`jellyfin-qc-secret:${qcKey}`); only the username/password path lacked one.
  // Keyed on the lowercased username so case variation cannot mint new budgets.
  //
  // TRADE-OFF, accepted deliberately: a per-username bucket lets an attacker
  // spend a known user's budget and lock them out for the window. That is the
  // standard cost of credential-keyed throttling, and it is strictly better than
  // unlimited guessing — the window is 5 minutes, not an account disable.
  if (!checkRateLimit(`jellyfin-user:${username.toLowerCase()}`, 10, 5 * 60 * 1000)) {
    void logAudit({ userId: "anonymous", userName: "anonymous", action: "AUTH_LOGIN_FAILED", target: "auth:login", ipAddress: ip, userAgent: ua, provider: "jellyfin", details: { reason: "rate_limited_username" } });
    return null;
  }

  const jellyfinUrl = await getConfiguredJellyfinUrl(instance);
  if (!jellyfinUrl) {
    console.error(`[jellyfin auth] Jellyfin URL is not configured for instance "${instance}"`);
    await dummyVerify();
    return null;
  }

  let jfUser;
  try {
    jfUser = await authenticateWithJellyfin(
      jellyfinUrl,
      username,
      credentials.password as string
    );
  } catch (err) {
    console.error("[jellyfin auth] authentication failed:", err);
    await dummyVerify();
    void logAudit({ userId: "anonymous", userName: "anonymous", action: "AUTH_LOGIN_FAILED", target: "auth:login", ipAddress: ip, userAgent: ua, provider: "jellyfin", details: { reason: "invalid_credentials" } });
    return null;
  }
  // Fail-closed membership gate — the Jellyfin credentials are valid, but a valid
  // server credential is not enough: the account must be a known member of this
  // Summonarr instance (or the gate must be explicitly disabled). See
  // isJellyfinSignInAllowed for the membership criteria.
  if (!(await isJellyfinSignInAllowed(jfUser.id, instance))) {
    console.warn("[jellyfin auth] sign-in refused: user is not an authorized member of this instance.");
    await dummyVerify();
    void logAudit({ userId: "anonymous", userName: "anonymous", action: "AUTH_LOGIN_FAILED", target: "auth:login", ipAddress: ip, userAgent: ua, provider: "jellyfin", details: { reason: "not_authorized" } });
    return null;
  }
  const jfDbUser = await findOrCreateJellyfinUser(jfUser.id, jfUser.name, instance);
  if (jfDbUser === PROVIDER_REBIND_REQUIRED || jfDbUser === PROVIDER_SETUP_REQUIRED) {
    await dummyVerify();
    const reason = jfDbUser === PROVIDER_SETUP_REQUIRED ? "setup_required" : "email_collision_needs_rebind";
    void logAudit({ userId: "anonymous", userName: "anonymous", action: "AUTH_LOGIN_FAILED", target: "auth:login", ipAddress: ip, userAgent: ua, provider: "jellyfin", details: { reason } });
    return null;
  }
  const device = buildDeviceMeta(headers);
  return { ...jfDbUser, rememberMe: credentials.rememberMe as string | undefined, ...device };
}

export async function authorizeWithJellyfinQuickConnect(
  credentials: Partial<Record<string, unknown>>,
  req: Request,
  instance: MediaInstanceKey = DEFAULT_MEDIA_INSTANCE,
): Promise<Record<string, unknown> | null> {
  if (!credentials?.secret) return null;
  const headers = (req as Request).headers as Headers;
  const ip = getClientIp(headers);
  const ua = headers.get("user-agent")?.slice(0, 512) ?? null;
  // Deliberately NOT scoped by instance — see authorizeWithJellyfin.
  if (!checkRateLimit(`jellyfin-qc-ip:${ipBucketKey(ip)}`, 10, 5 * 60 * 1000)) {
    void logAudit({ userId: "anonymous", userName: "anonymous", action: "AUTH_LOGIN_FAILED", target: "auth:login", ipAddress: ip, userAgent: ua, provider: "jellyfin-quickconnect", details: { reason: "rate_limited" } });
    return null;
  }
  // Per-secret bucket so a QuickConnect secret can't be brute-redeemed from
  // rotating IPs (mirrors the Plex per-token limit). Hash the secret so no raw
  // secret material lands in a limiter key.
  const qcKey = createHash("sha256").update(credentials.secret as string).digest("hex").slice(0, 16);
  if (!checkRateLimit(`jellyfin-qc-secret:${qcKey}`, 10, 5 * 60 * 1000)) {
    void logAudit({ userId: "anonymous", userName: "anonymous", action: "AUTH_LOGIN_FAILED", target: "auth:login", ipAddress: ip, userAgent: ua, provider: "jellyfin-quickconnect", details: { reason: "rate_limited" } });
    return null;
  }
  const jellyfinUrl = await getConfiguredJellyfinUrl(instance);
  if (!jellyfinUrl) {
    console.error(`[jellyfin quickconnect auth] Jellyfin URL is not configured for instance "${instance}"`);
    await dummyVerify();
    return null;
  }

  let jfUser;
  try {
    jfUser = await authenticateWithJellyfinQuickConnect(
      jellyfinUrl,
      credentials.secret as string
    );
  } catch (err) {
    console.error("[jellyfin quickconnect auth] failed:", err);
    void logAudit({ userId: "anonymous", userName: "anonymous", action: "AUTH_LOGIN_FAILED", target: "auth:login", ipAddress: ip, userAgent: ua, provider: "jellyfin-quickconnect", details: { reason: "authentication_failed" } });
    return null;
  }
  // Fail-closed membership gate (same as the standard Jellyfin path): a valid
  // QuickConnect secret authenticates the account but does not by itself authorize
  // sign-in — the account must be a known member of this instance.
  if (!(await isJellyfinSignInAllowed(jfUser.id, instance))) {
    console.warn("[jellyfin quickconnect auth] sign-in refused: user is not an authorized member of this instance.");
    await dummyVerify();
    void logAudit({ userId: "anonymous", userName: "anonymous", action: "AUTH_LOGIN_FAILED", target: "auth:login", ipAddress: ip, userAgent: ua, provider: "jellyfin-quickconnect", details: { reason: "not_authorized" } });
    return null;
  }
  const qcDbUser = await findOrCreateJellyfinUser(jfUser.id, jfUser.name, instance);
  if (qcDbUser === PROVIDER_REBIND_REQUIRED || qcDbUser === PROVIDER_SETUP_REQUIRED) {
    const reason = qcDbUser === PROVIDER_SETUP_REQUIRED ? "setup_required" : "email_collision_needs_rebind";
    void logAudit({ userId: "anonymous", userName: "anonymous", action: "AUTH_LOGIN_FAILED", target: "auth:login", ipAddress: ip, userAgent: ua, provider: "jellyfin-quickconnect", details: { reason } });
    return null;
  }
  const device = buildDeviceMeta(headers);
  return { ...qcDbUser, rememberMe: credentials.rememberMe as string | undefined, ...device };
}


// ────────────────────────────────────────────────────────────────────────────
// Summonarr-native sign-in flow (parallel to next-auth)
//
// The new credentials/plex/jellyfin/jellyfin-quickconnect route handlers under
// /api/auth/sign-in/* call signInAndMintSession after the provider-specific
// authorize() returns a user. It replicates what next-auth's jwt + events.signIn
// callbacks do today, but produces a Summonarr-controlled JWT we own.
//
// The next-auth flow continues to operate unchanged in parallel — its providers
// still call the same exported authorize* functions. PR 5 will retire the
// next-auth flow and consumers altogether.
// ────────────────────────────────────────────────────────────────────────────

export interface SignInResult {
  token: string;
  expiresInSeconds: number;
  sessionId: string;
  user: {
    id: string;
    role: string;
    email: string | null;
    name: string | null;
    provider: string;
    mediaServer: string | null;
  };
}

async function runFirstAdminPromotion(
  userId: string,
  providerId: string,
): Promise<boolean> {
  // Bootstrap promotion only fires for the credentials path (matched against
  // /api/auth/register, which is the only sanctioned setup flow). OAuth/OIDC
  // first-sign-in cannot grant ADMIN — defends against an attacker reaching
  // /api/auth/oidc/start (or completing a Plex PIN) before the operator has
  // run setup, where any IdP-vouched user would otherwise inherit ADMIN.
  // Opt-in escape hatch for OAuth-only deployments via env var.
  const allowOauthBootstrap = process.env.SUMMONARR_ALLOW_OAUTH_FIRST_ADMIN === "true";
  if (providerId !== "credentials" && !allowOauthBootstrap) return false;
  return prisma.$transaction(async (tx) => {
    // Lock 43 is the SAME advisory lock /api/auth/register holds for its
    // count→create-ADMIN→setup_completed_at sequence. Sharing it serializes the
    // two first-admin paths so a concurrent register + OAuth bootstrap can't both
    // observe "no admin yet" and each mint an ADMIN.
    await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(43)");
    const setupRow = await tx.setting.findUnique({ where: { key: "setup_completed_at" } });
    if (setupRow) return false;
    const existingAdmin = await tx.user.findFirst({ where: { role: "ADMIN" }, select: { id: true } });
    if (existingAdmin) return false;
    const self = await tx.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!self) return false;
    await tx.user.update({ where: { id: userId }, data: { role: "ADMIN", permissions: defaultPermissionsForRole("ADMIN") } });
    // upsert, not create().catch(): a P2002 from a concurrent setup race (the
    // /api/auth/register path holds a DIFFERENT advisory lock and can create this
    // key between our findUnique and create) would abort the transaction and
    // silently roll back the ADMIN promotion above (guardrail 23). upsert is
    // idempotent and never trips the unique constraint.
    await tx.setting.upsert({
      where: { key: "setup_completed_at" },
      update: {},
      create: { key: "setup_completed_at", value: new Date().toISOString() },
    });
    return true;
  });
}

// Refusal for a DISABLED account (User.deactivatedAt set). Account removal
// disables rather than scrubs (see account-lifecycle.ts), so the row keeps its
// email, plexUserId/jellyfinUserId and OAuth rows — every provider's lookup still
// MATCHES it. Thrown by signInAndMintSession and surfaced as a 403 by each
// sign-in route.
export class AccountDeactivatedError extends Error {
  constructor() {
    super("This account has been disabled.");
    this.name = "AccountDeactivatedError";
  }
}

export async function signInAndMintSession(params: {
  user: Record<string, unknown>;
  providerId: "credentials" | "plex" | "jellyfin" | "jellyfin-quickconnect" | "oidc";
}): Promise<SignInResult> {
  const { user, providerId } = params;
  const userId = user.id as string | undefined;

  // Single chokepoint for every provider (credentials / plex / jellyfin /
  // jellyfin-quickconnect / oidc): refuse a disabled account BEFORE
  // initializeTokenOnSignIn mints a JWT and writes an AuthSession row.
  // verifyAndRefreshSession would reject the resulting token on the very next
  // request anyway, but only after handing the client a session it can't use and
  // leaving a live AuthSession row behind. The check runs post-authorization, so
  // "disabled" is only ever disclosed to someone who already proved the
  // credential — it leaks nothing to a stranger probing addresses.
  if (userId) {
    const state = await prisma.user.findUnique({
      where: { id: userId },
      select: { deactivatedAt: true },
    });
    if (state?.deactivatedAt) throw new AccountDeactivatedError();
  }

  // Build the same token shape next-auth's jwt callback (auth.config.ts) would build.
  const token: Record<string, unknown> = {
    id: user.id,
    role: (user as { role?: string }).role,
    provider: providerId,
    // mediaServer is provider-determined for plex/jellyfin*; otherwise null —
    // initializeTokenOnSignIn will look up the DB column for credentials/oidc.
    mediaServer:
      providerId === "plex"
        ? "plex"
        : providerId === "jellyfin" || providerId === "jellyfin-quickconnect"
          ? "jellyfin"
          : null,
  };
  const sessionField = (user as { _sessionId?: string })._sessionId;
  if (sessionField) token.sessionId = sessionField;
  const uaFp = (user as { _uaFingerprint?: string })._uaFingerprint;
  if (uaFp) token.uaFingerprint = uaFp;
  const isMobileField = (user as { _isMobile?: boolean })._isMobile;
  if (isMobileField !== undefined) token.isMobile = isMobileField;
  const deviceLabelField = (user as { _deviceLabel?: string })._deviceLabel;
  if (deviceLabelField) token.deviceLabel = deviceLabelField;

  // initializeTokenOnSignIn mutates `token` in place: sets sessionId/expiresAt,
  // looks up mediaServer if not provider-pinned, AND creates the
  // AuthSession row.
  await initializeTokenOnSignIn(token, user);

  if (userId) {
    const promoted = await runFirstAdminPromotion(userId, providerId);
    if (promoted) token.role = "ADMIN";
  }

  // Carry the user's stored permission bitmask (raw decimal) in the token. New
  // users were seeded at the create site; a just-promoted first admin was
  // re-seeded in runFirstAdminPromotion. If this read somehow returns 0,
  // effectivePermissions() on the read side still falls back to the role preset.
  let permissionsClaim = "0";
  if (userId) {
    const permRow = await prisma.user.findUnique({ where: { id: userId }, select: { permissions: true } });
    if (permRow) permissionsClaim = serializePermissions(permRow.permissions);
  }

  void logAudit({
    userId: (user.id as string) ?? "unknown",
    userName: (user.name as string) ?? (user.email as string) ?? "unknown",
    action: "AUTH_LOGIN",
    target: "auth:login",
    ipAddress: (user as { _auditIp?: string })._auditIp ?? null,
    userAgent: (user as { _auditUa?: string })._auditUa ?? null,
    provider: providerId,
    details: {
      provider: providerId,
      // Store a hash, not the raw address — matches the AUTH_LOGIN_FAILED paths
      // and minimizes cleartext PII held in the audit log (it would otherwise
      // persist until the 90-day scrub).
      emailHash: typeof user.email === "string" ? hashAuditEmail(user.email) : null,
      role: token.role,
      ip: (user as { _auditIp?: string })._auditIp,
      browser: ((user as { _auditUa?: string })._auditUa)?.slice(0, 100),
    },
  });

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = token.expiresAt as number;
  const expiresInSeconds = Math.max(60, expiresAt - now);

  const jwt = await signSessionJwt(
    {
      id: token.id as string,
      role: token.role as string,
      permissions: permissionsClaim,
      email: (user.email as string | null) ?? null,
      name: (user.name as string | null) ?? null,
      provider: token.provider as string,
      mediaServer: (token.mediaServer as string | null | undefined) ?? null,
      sessionId: token.sessionId as string,
      uaFingerprint: token.uaFingerprint as string | undefined,
      isMobile: token.isMobile as boolean | undefined,
      deviceLabel: token.deviceLabel as string | undefined,
      expiresAt,
    },
    { expiresInSeconds },
  );

  return {
    token: jwt,
    expiresInSeconds,
    sessionId: token.sessionId as string,
    user: {
      id: token.id as string,
      role: token.role as string,
      email: (user.email as string | null) ?? null,
      name: (user.name as string | null) ?? null,
      provider: providerId,
      mediaServer: (token.mediaServer as string | null | undefined) ?? null,
    },
  };
}
