import { prisma } from "@/lib/prisma";
import { dummyVerify, verifyPassword, MAX_PASSWORD_LENGTH } from "@/lib/password-hash";
import { createHash, createHmac } from "crypto";
import { getPlexUser, getPlexFriendEmails, pingPlexToken } from "@/lib/plex";
import { authenticateWithJellyfin, authenticateWithJellyfinQuickConnect, getJellyfinUserEmail } from "@/lib/jellyfin";
import { getConfiguredJellyfinUrl } from "@/lib/jellyfin-config";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import { extractUaFingerprint, serializeFingerprint, fingerprintToLabel } from "@/lib/ua-fingerprint";
import { signSessionJwt } from "@/lib/session-jwt";
import { markUserForceRevalidate, markSessionForceRevoked } from "@/lib/session-revocation";
import type { SummonarrSession } from "@/lib/api-auth";
import { readSummonarrSession } from "@/lib/session-server";
import { defaultPermissionsForRole, effectivePermissions, parsePermissions, serializePermissions } from "@/lib/permissions";
import { sanitizeOptional, sanitizeText } from "@/lib/sanitize";

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

export type AuthorizedDbUser = { id: string; email: string; name: string | null; role: string };

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
}): Promise<AuthorizedDbUser | ProviderRebindRequired> {
  const normalized = normalizeEmail(email);
  // Provider-supplied display names are untrusted — strip HTML/control chars so
  // the name can't carry markup into any downstream sink (email/Discord/push),
  // mirroring the local-credentials register path.
  name = sanitizeOptional(name);

  // 1) Bind on (provider, sub) first. This is the C-1 fix: never trust email as
  //    the primary identity anchor for an external IdP.
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

  // 2) An existing row with this email but no plexUserId is the C-1 attack
  //    surface: a Plex friend whose email matches a local-credentials admin
  //    must NOT auto-link to that admin. Refuse — manual rebind required.
  const byEmail = await prisma.user.findUnique({ where: { email: normalized } });
  if (byEmail) {
    console.warn(`[auth] Refused plex sign-in: ${normalized} matches an existing user with no plexUserId. Manual rebind required.`);
    return PROVIDER_REBIND_REQUIRED;
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
): Promise<AuthorizedDbUser | ProviderRebindRequired> {
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

  // 3) Real-email lookup is the C-1 hot path: if a user with this Jellyfin
  //    server's reported email already exists but isn't bound to this Jellyfin
  //    sub, refuse — manual rebind required.
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
): Promise<AuthorizedDbUser | ProviderRebindRequired> {
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

  // C-1 parity with Plex/Jellyfin: an existing user with this email but no
  // (provider=oidc, sub=...) Account row is the SSO-takeover attack vector.
  // Any IdP under attacker control that vouches `email_verified=true` for the
  // victim's email would otherwise auto-link and inherit role (incl. ADMIN).
  // Refuse — an admin must rebind via a logged-in "Link account" flow.
  const byEmail = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (byEmail) {
    console.warn(`[auth/oidc] Refused sign-in: ${normalizedEmail} matches an existing user with no oidc account binding. Manual rebind required.`);
    return PROVIDER_REBIND_REQUIRED;
  }

  const created = await prisma.user.create({
    data: {
      email: normalizedEmail,
      name: sanitizeOptional(claims.name ?? claims.preferredUsername),
      image: claims.picture,
      role: "USER",
      permissions: defaultPermissionsForRole("USER"),
      notificationEmail: normalizedEmail,
      accounts: {
        create: {
          type: "oidc",
          provider: "oidc",
          providerAccountId: claims.sub,
          ...accountTokens,
        },
      },
    },
    select: { id: true, email: true, name: true, role: true },
  });
  return created;
}

const DEFAULT_SESSION_SECONDS        = 3_600;
const DEFAULT_MOBILE_SESSION_SECONDS = 604_800;
const DEFAULT_MAX_SESSION_SECONDS    = 2_592_000;

// Hard ceiling regardless of admin-configured session durations — prevents unbounded JWT lifetimes
const MAX_ALLOWED_SESSION_SECONDS = 90 * 24 * 60 * 60;

type SessionDurations = { desktopDuration: number; mobileDuration: number; maxDuration: number };

const SESSION_DURATIONS_TTL_MS = 5 * 60 * 1000;
let sessionDurationsCache: { value: SessionDurations; expiresAt: number } | null = null;

export function invalidateSessionDurationsCache(): void {
  sessionDurationsCache = null;
}

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

// Server-component-friendly session reader. Mirrors what next-auth's `auth()`
// exported — synchronous-looking API that returns SummonarrSession | null.
// Routes that need 401/403 semantics should use requireAuth/withAuth from
// @/lib/api-auth instead.
export async function auth(): Promise<SummonarrSession | null> {
  const claims = await readSummonarrSession();
  if (!claims) return null;
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

export function invalidateUserSession(userId: string): void {
  markUserForceRevalidate(userId);
}

export async function revokeSessionById(sessionId: string): Promise<void> {
  markSessionForceRevoked(sessionId);

  // Bump sessionsRevokedAt to the revoked session's createdAt so refreshToken()'s
  // cutoff check on OTHER replicas rejects the revoked session's JWT even within
  // the 60s dbCheckedAt cache window (otherwise the cached token passes for up to
  // 60s after row deletion). Newer sessions of the same user (iat > createdAt)
  // survive; older sessions are caught — acceptable for an admin "revoke this
  // device" action, since per-session granularity isn't expressible against a
  // per-user timestamp anyway.
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
  }).catch(() => {});
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

  let ttl: number;
  if (rememberMe) {
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

  // Two independent throttles, both consumed on every attempt:
  //   • Per-IP — bounds rapid attempts from one source. Skipped when the IP is
  //     unknowable (TRUST_PROXY unset → getClientIp returns "unknown"); keying a
  //     single `login-ip:unknown` bucket would let a few typos from any one
  //     client lock out the whole instance.
  //   • Per-account — ALWAYS enforced so a password-spray distributed across
  //     many IPs against one account is still bounded (the per-IP bucket can't
  //     see that). Generous window so ordinary mistyping doesn't lock a user
  //     out. Trade-off: an attacker can burn a victim's account bucket to impose
  //     a temporary (≤15 min) login delay on that one account — the standard
  //     cost of account-level throttling, and far cheaper than unbounded spray.
  //     In-memory and per-replica like the rest of the limiter.
  const emailHash = hashAuditEmail(email);
  const ipAllowed = ip === "unknown" ? true : checkRateLimit(`login-ip:${ip}`, 20, 5 * 60 * 1000);
  const accountAllowed = checkRateLimit(`login-email:${emailHash}`, 50, 15 * 60 * 1000);

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

    // C-2: refuse Plex sign-in entirely when plexServerUrl is not set —
    // otherwise the friend-list filter degrades to "anyone the admin has
    // shared any server with" (see commit ff9eff0 / SECURITY-PASS-3).
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
  const jfDbUser = await findOrCreateJellyfinUser(jfUser.id, jfUser.name);
  if (jfDbUser === PROVIDER_REBIND_REQUIRED) {
    await dummyVerify();
    void logAudit({ userId: "anonymous", userName: "anonymous", action: "AUTH_LOGIN_FAILED", target: "auth:login", ipAddress: ip, userAgent: ua, provider: "jellyfin", details: { reason: "email_collision_needs_rebind" } });
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
  const jellyfinUrl = await getConfiguredJellyfinUrl();
  if (!jellyfinUrl) {
    console.error("[jellyfin quickconnect auth] Jellyfin URL is not configured");
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
  const qcDbUser = await findOrCreateJellyfinUser(jfUser.id, jfUser.name);
  if (qcDbUser === PROVIDER_REBIND_REQUIRED) {
    void logAudit({ userId: "anonymous", userName: "anonymous", action: "AUTH_LOGIN_FAILED", target: "auth:login", ipAddress: ip, userAgent: ua, provider: "jellyfin-quickconnect", details: { reason: "email_collision_needs_rebind" } });
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
    // Advisory lock prevents two concurrent first-time sign-ins both being promoted to ADMIN
    await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(1947888749)");
    const setupRow = await tx.setting.findUnique({ where: { key: "setup_completed_at" } });
    if (setupRow) return false;
    const existingAdmin = await tx.user.findFirst({ where: { role: "ADMIN" }, select: { id: true } });
    if (existingAdmin) return false;
    const self = await tx.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!self) return false;
    await tx.user.update({ where: { id: userId }, data: { role: "ADMIN", permissions: defaultPermissionsForRole("ADMIN") } });
    await tx.setting.create({ data: { key: "setup_completed_at", value: new Date().toISOString() } }).catch(() => {});
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
      email: user.email,
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
