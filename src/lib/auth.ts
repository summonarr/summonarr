import { prisma } from "@/lib/prisma";
import { headers } from "next/headers";
import { dummyVerify, verifyPassword, MAX_PASSWORD_LENGTH } from "@/lib/password-hash";
import { createHash, createHmac } from "crypto";
import { getPlexUser, getPlexFriendEmails, pingPlexToken } from "@/lib/plex";
import { authenticateWithJellyfin, authenticateWithJellyfinQuickConnect, getJellyfinUserEmail } from "@/lib/jellyfin";
import { getConfiguredJellyfinUrl } from "@/lib/jellyfin-config";
import { checkRateLimit, peekRateLimit, recordFailure, getClientIp } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import { extractUaFingerprint, serializeFingerprint, fingerprintToLabel, matchesStoredFingerprint } from "@/lib/ua-fingerprint";
import { signSessionJwt, type SessionClaims } from "@/lib/session-jwt";
import { markUserForceRevalidate, markSessionForceRevoked } from "@/lib/session-revocation";
import type { SummonarrSession } from "@/lib/api-auth";
import { readSummonarrSession, readActiveSummonarrSession } from "@/lib/session-server";
import { defaultPermissionsForRole, effectivePermissions, parsePermissions, serializePermissions } from "@/lib/permissions";
import { sanitizeOptional, sanitizeText } from "@/lib/sanitize";
import { hasNativeClientHeader, NATIVE_CLIENT_HEADER } from "@/lib/mobile-auth";

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
}: {
  plexUserId: string;
  email: string;
  name?: string | null;
  image?: string | null;
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
    await prisma.user.update({
      where: { id: bySub.id },
      data: {
        notificationEmail: normalized,
        ...(name ? { name } : {}),
        ...(image ? { image } : {}),
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
    },
    select: { id: true, email: true, name: true, role: true },
  });
  return created;
}

export async function findOrCreateJellyfinUser(
  jellyfinId: string,
  name: string,
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

  // 3) Real-email lookup is the account-takeover guard: if a user with this
  //    Jellyfin server's reported email already exists but is NOT bound to this
  //    Jellyfin sub (jellyfinUserId), auto-linking on the email match would let
  //    the incoming Jellyfin account inherit that existing row's identity/role.
  //    Refuse and require an explicit admin rebind. As above, email is never a
  //    trusted cross-provider identity anchor — only the provider subject id is.
  let realEmail: string | null = null;
  try {
    const [urlRow, keyRow] = await Promise.all([
      prisma.setting.findUnique({ where: { key: "jellyfinUrl" } }),
      prisma.setting.findUnique({ where: { key: "jellyfinApiKey" } }),
    ]);
    if (urlRow?.value && keyRow?.value) {
      realEmail = await getJellyfinUserEmail(urlRow.value, keyRow.value, jellyfinId);
    }
  } catch {
    // best-effort; missing email just means we use the synthetic anchor on create
  }

  if (realEmail) {
    const normalizedReal = normalizeEmail(realEmail);
    const byReal = await prisma.user.findUnique({ where: { email: normalizedReal } });
    if (byReal) {
      console.warn(`[auth] Refused jellyfin sign-in: ${normalizedReal} matches an existing user with no jellyfinUserId. Manual rebind required.`);
      return PROVIDER_REBIND_REQUIRED;
    }
  }

  // Refuse to mint the first user pre-setup — see isPreSetupBootstrapBlocked.
  if (await isPreSetupBootstrapBlocked()) {
    console.warn(`[auth] Refused pre-setup jellyfin sign-in for ${jellyfinId}: complete initial setup (create the first admin) first.`);
    return PROVIDER_SETUP_REQUIRED;
  }

  // 4) New user.
  const created = await prisma.user.create({
    data: {
      email: realEmail ? normalizeEmail(realEmail) : syntheticEmail,
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

// Native-app (bearer) sessions get a long FIXED lifetime so the iOS app stays signed
// in by default. The token lives in the iOS Keychain (hardware-backed, not an ambient
// cookie) and bearer clients have no sliding refresh (guardrail 6b), so a long fixed
// TTL is the mechanism. NOT a security hole: DB revocation — sign-out-everywhere, a
// password change, the sessionsRevokedAt/passwordChangedAt cutoffs — still invalidates
// it instantly on the next request, independent of this lifetime. Granted ONLY to
// rememberMe + a mobile device class (so web "remember me" is unaffected).
const NATIVE_APP_SESSION_SECONDS = 365 * 24 * 60 * 60; // 1 year

// Hard ceiling for ADMIN-CONFIGURABLE durations (the sessionDefault/Mobile/Max settings)
// — prevents an admin from configuring an unbounded JWT lifetime. NATIVE_APP_SESSION_SECONDS
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
  const cap = (n: number) => Math.min(n, MAX_ALLOWED_SESSION_SECONDS);
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
  const ua = (await headers()).get("user-agent");
  if (!matchesStoredFingerprint(claims.uaFingerprint, ua)) return null;
  return claimsToSession(claims);
}

export function invalidateUserSession(userId: string): void {
  markUserForceRevalidate(userId);
}

export async function revokeSessionById(sessionId: string): Promise<void> {
  // Bump sessionsRevokedAt to the revoked session's createdAt so refreshToken()'s
  // cutoff check on OTHER replicas rejects the revoked session's JWT even within
  // the 60s dbCheckedAt cache window (otherwise the cached token passes for up to
  // 60s after row deletion). The refresh cutoff is `iat <= sessionsRevokedAt` and
  // the JWT is signed in (almost always) the same wall-clock second the row is
  // created, so createdAt catches the revoked token while sparing newer sessions
  // (iat > createdAt). Older sessions are caught too — acceptable for "revoke this
  // device", since per-session granularity isn't expressible against a per-user
  // timestamp. We deliberately do NOT push the cutoff to `now`: that would
  // invalidate every current session of the user (revoke-one → revoke-everywhere).
  await prisma.$transaction(async (tx) => {
    const row = await tx.authSession.findUnique({
      where: { sessionId },
      select: { userId: true, createdAt: true },
    });
    if (!row) return;
    await tx.authSession.delete({ where: { sessionId } });
    // Never DECREASE sessionsRevokedAt — a prior full-user revoke may have set it
    // higher and overwriting would weaken that cutoff. Only bump forward.
    const userRow = await tx.user.findUnique({
      where: { id: row.userId },
      select: { sessionsRevokedAt: true },
    });
    const existing = userRow?.sessionsRevokedAt;
    if (!existing || row.createdAt > existing) {
      await tx.user.update({
        where: { id: row.userId },
        data: { sessionsRevokedAt: row.createdAt },
      });
    }
  });
  // Mark in-memory only AFTER the DB revocation commits (matches
  // revokeAllUserSessions). The error is intentionally not swallowed: a failed
  // revoke now propagates so the caller returns 500 instead of auditing a phantom
  // revocation that left the AuthSession row live (it would resurrect on restart).
  markSessionForceRevoked(sessionId);
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
// expiresAt/maxExpiresAt, resolves mediaServer when not provider-pinned, and
// upserts the backing AuthSession row.
export async function initializeTokenOnSignIn(token: JwtToken, user: Record<string, unknown>): Promise<JwtToken> {
  if (!token.sessionId) {
    // Credentials provider supplies _sessionId via DeviceMeta; OIDC/OAuth do not
    token.sessionId = crypto.randomUUID();
  }

  if (!token.uaFingerprint && token.provider === "oidc") {
    try {
      const { headers: getHeaders } = await import("next/headers");
      const h = await getHeaders();
      const ua = h.get("user-agent") ?? "";
      if (ua) token.uaFingerprint = serializeFingerprint(extractUaFingerprint(ua));
    } catch {
      // jwt() invoked outside request context — fingerprint stays unset, populated on next refresh
    }
  }

  const rememberMe = (user as { rememberMe?: string }).rememberMe === "true";
  const isMobile   = token.isMobile as boolean | undefined;
  const { desktopDuration, mobileDuration, maxDuration } = await getSessionDurations();

  // The 1-year native-app TTL is reserved for a real native client, identified by
  // the X-Summonarr-Client header it presents (a custom header a cross-origin web
  // page cannot forge on a credentialed request — guardrail 6b). A spoofed mobile
  // User-Agent alone (isMobile is UA-derived) must NOT grant it, or any browser
  // could mint a 1-year remember-me ceiling by lying about its UA.
  let isNativeClient = false;
  try {
    const { headers: getHeaders } = await import("next/headers");
    const h = await getHeaders();
    isNativeClient = hasNativeClientHeader(h.get(NATIVE_CLIENT_HEADER));
  } catch {
    // Invoked outside a request context — treat as non-native.
  }

  let ttl: number;
  if (rememberMe && isMobile && isNativeClient) {
    // Native app (iOS Keychain bearer) — long-lived by default. See NATIVE_APP_SESSION_SECONDS.
    ttl = NATIVE_APP_SESSION_SECONDS;
  } else if (rememberMe) {
    // Web "remember me" — admin-configurable maxDuration (30d default, capped at 90d).
    ttl = maxDuration;
  } else if (isMobile) {
    ttl = mobileDuration;
  } else {
    ttl = desktopDuration;
  }
  token.expiresAt = Math.floor(Date.now() / 1000) + ttl;
  // Hard ceiling captured once at sign-in. refreshToken() bounds the sliding
  // expiry against this value so non-admins can't be silently extended past
  // the original session TTL (which is itself capped at MAX_ALLOWED_SESSION_SECONDS
  // in getSessionDurations()). Server-side only — never exposed via session().
  token.maxExpiresAt = token.expiresAt;

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

  const ipKey = ip === "unknown" ? "login-ip:unknown" : `login-ip:${ip}`;
  const ipLimit = ip === "unknown" ? 100 : 20;
  const ipAllowed = checkRateLimit(ipKey, ipLimit, 5 * 60 * 1000);
  const accountAllowed = peekRateLimit(accountKey, accountLimit, accountWindowMs);

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
    // Record a hit on the account bucket ONLY now — i.e. on a genuine wrong
    // password (or unknown account, which also reached the dummyVerify branch).
    // Gating with peek above + recording here means the bucket counts real
    // failed verifications, not mere email guesses.
    recordFailure(accountKey, accountWindowMs);
    void logAudit({ userId: "anonymous", userName: "anonymous", action: "AUTH_LOGIN_FAILED", target: "auth:login", ipAddress: ip, userAgent: ua, provider: "credentials", details: { reason: "invalid_credentials", emailHash } });
    return null;
  }

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

  if (!checkRateLimit(`plex-ip:${ip}`, 20, 5 * 60 * 1000)) {
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

    // Refuse Plex sign-in entirely when plexServerUrl is not configured. The
    // membership gate below allows a Plex account only if its email is in the set
    // returned by getPlexFriendEmails(adminToken, plexServerUrl) — i.e. users with
    // access to THIS specific server. If plexServerUrl is empty that scoping is
    // lost and the friend-list filter degrades to "anyone the admin has shared ANY
    // server (or library) with on their whole Plex account," which can be a far
    // wider, attacker-influenceable population than the intended instance members.
    // Fail closed rather than authenticate against an unscoped friend list.
    const [adminTokenRow, adminEmailRow, serverUrlRow] = await Promise.all([
      prisma.setting.findUnique({ where: { key: "plexAdminToken" } }),
      prisma.setting.findUnique({ where: { key: "plexAdminEmail" } }),
      prisma.setting.findUnique({ where: { key: "plexServerUrl" } }),
    ]);
    const plexServerUrl = serverUrlRow?.value?.trim() || "";
    if (!plexServerUrl) {
      console.warn("[auth] Plex sign-in refused: plexServerUrl is not configured.");
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

    if (adminTokenRow?.value) {
      const allowed = await getPlexFriendEmails(adminTokenRow.value, plexServerUrl);
      if (adminEmailRow?.value) allowed.add(adminEmailRow.value.toLowerCase());

      if (allowed.has(verifiedEmail)) {
        const plexDbUser = await findOrCreatePlexUser({
          plexUserId: plexUserSub,
          email: verifiedEmail,
          name: plexName,
          image: plexThumb,
        });

        if (plexDbUser === PROVIDER_REBIND_REQUIRED) {
          void logAudit({ userId: "anonymous", userName: "anonymous", action: "AUTH_LOGIN_FAILED", target: "auth:login", ipAddress: ip, userAgent: ua, provider: "plex", details: { reason: "email_collision_needs_rebind", emailHash: hashAuditEmail(verifiedEmail) } });
        } else if (plexDbUser === PROVIDER_SETUP_REQUIRED) {
          void logAudit({ userId: "anonymous", userName: "anonymous", action: "AUTH_LOGIN_FAILED", target: "auth:login", ipAddress: ip, userAgent: ua, provider: "plex", details: { reason: "setup_required", emailHash: hashAuditEmail(verifiedEmail) } });
        } else {
          // notificationEmail is kept in lock-step with the Plex-verified email on every
          // sign-in so notifications always go to the user's current Plex address.
          await prisma.user.update({
            where: { id: plexDbUser.id },
            data: {
              notificationEmail: verifiedEmail,
              ...(browserClientId ? { plexClientId: browserClientId } : {}),
            },
          }).catch(() => {});
          const device = buildDeviceMeta(headers);
          plexResult = { ...plexDbUser, rememberMe: credentials.rememberMe as string | undefined, ...device };
        }
      }
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
async function isJellyfinSignInAllowed(jellyfinUserId: string): Promise<boolean> {
  const restrictRow = await prisma.setting.findUnique({ where: { key: "jellyfinRestrictSignIn" } });
  const restrict = (restrictRow?.value ?? "true").trim().toLowerCase() !== "false";
  if (!restrict) return true;
  const [member, existing] = await Promise.all([
    prisma.mediaServerUser.findFirst({
      where: { source: "jellyfin", sourceUserId: jellyfinUserId, active: true },
      select: { id: true },
    }),
    prisma.user.findUnique({ where: { jellyfinUserId }, select: { id: true } }),
  ]);
  return Boolean(member || existing);
}

export async function authorizeWithJellyfin(
  credentials: Partial<Record<string, unknown>>,
  req: Request,
): Promise<Record<string, unknown> | null> {
  if (!credentials?.username || !credentials?.password) return null;
  const username = credentials.username as string;
  if (username.length > 200 || (credentials.password as string).length > MAX_PASSWORD_LENGTH) {
    return null;
  }
  const headers = (req as Request).headers as Headers;
  const ip = getClientIp(headers);
  const ua = headers.get("user-agent")?.slice(0, 512) ?? null;

  if (!checkRateLimit(`jellyfin-ip:${ip}`, 10, 5 * 60 * 1000)) {
    void logAudit({ userId: "anonymous", userName: "anonymous", action: "AUTH_LOGIN_FAILED", target: "auth:login", ipAddress: ip, userAgent: ua, provider: "jellyfin", details: { reason: "rate_limited" } });
    return null;
  }

  const jellyfinUrl = await getConfiguredJellyfinUrl();
  if (!jellyfinUrl) {
    console.error("[jellyfin auth] Jellyfin URL is not configured");
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
  if (!(await isJellyfinSignInAllowed(jfUser.id))) {
    console.warn("[jellyfin auth] sign-in refused: user is not an authorized member of this instance.");
    await dummyVerify();
    void logAudit({ userId: "anonymous", userName: "anonymous", action: "AUTH_LOGIN_FAILED", target: "auth:login", ipAddress: ip, userAgent: ua, provider: "jellyfin", details: { reason: "not_authorized" } });
    return null;
  }
  const jfDbUser = await findOrCreateJellyfinUser(jfUser.id, jfUser.name);
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
): Promise<Record<string, unknown> | null> {
  if (!credentials?.secret) return null;
  const headers = (req as Request).headers as Headers;
  const ip = getClientIp(headers);
  const ua = headers.get("user-agent")?.slice(0, 512) ?? null;
  if (!checkRateLimit(`jellyfin-qc-ip:${ip}`, 10, 5 * 60 * 1000)) {
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
  const jellyfinUrl = await getConfiguredJellyfinUrl();
  if (!jellyfinUrl) {
    console.error("[jellyfin quickconnect auth] Jellyfin URL is not configured");
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
  if (!(await isJellyfinSignInAllowed(jfUser.id))) {
    console.warn("[jellyfin quickconnect auth] sign-in refused: user is not an authorized member of this instance.");
    await dummyVerify();
    void logAudit({ userId: "anonymous", userName: "anonymous", action: "AUTH_LOGIN_FAILED", target: "auth:login", ipAddress: ip, userAgent: ua, provider: "jellyfin-quickconnect", details: { reason: "not_authorized" } });
    return null;
  }
  const qcDbUser = await findOrCreateJellyfinUser(jfUser.id, jfUser.name);
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

export async function signInAndMintSession(params: {
  user: Record<string, unknown>;
  providerId: "credentials" | "plex" | "jellyfin" | "jellyfin-quickconnect" | "oidc";
}): Promise<SignInResult> {
  const { user, providerId } = params;

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

  // initializeTokenOnSignIn mutates `token` in place: sets sessionId/expiresAt/
  // maxExpiresAt, looks up mediaServer if not provider-pinned, AND creates the
  // AuthSession row.
  await initializeTokenOnSignIn(token, user);

  const userId = user.id as string | undefined;
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
