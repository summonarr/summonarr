import NextAuth, { type Session } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { prismaAuthAdapter } from "@/lib/auth-adapter";
import { prisma } from "@/lib/prisma";
import { dummyVerify, verifyPassword } from "@/lib/password-hash";
import { createHash, createHmac } from "crypto";
import { authConfig } from "@/lib/auth.config";
import { getPlexUser, getPlexFriendEmails, pingPlexToken } from "@/lib/plex";
import { authenticateWithJellyfin, authenticateWithJellyfinQuickConnect, getJellyfinUserEmail } from "@/lib/jellyfin";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import { extractUaFingerprint, serializeFingerprint, fingerprintToLabel } from "@/lib/ua-fingerprint";

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
function hashAuditEmail(email: string): string {
  return createHash("sha256").update(email).digest("hex").slice(0, 16);
}

// Sentinel returned when a provider-bound lookup refuses sign-in due to an email
// collision with a user that has no corresponding provider subject yet. The caller
// translates this to `return null` from authorize() so NextAuth surfaces a generic
// failure to the client.
const PROVIDER_REBIND_REQUIRED = Symbol("provider-rebind-required");
type ProviderRebindRequired = typeof PROVIDER_REBIND_REQUIRED;

type AuthorizedDbUser = { id: string; email: string; name: string | null; role: string };

async function findOrCreatePlexUser({
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
      plexUserId,
      notificationEmail: normalized,
    },
    select: { id: true, email: true, name: true, role: true },
  });
  return created;
}

async function findOrCreateJellyfinUser(
  jellyfinId: string,
  name: string,
): Promise<AuthorizedDbUser | ProviderRebindRequired> {
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
      jellyfinUserId: jellyfinId,
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

async function getSessionDurations(): Promise<SessionDurations> {
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

export function isTokenExpired(session: Session | null): boolean {
  if (!session) return false;
  return !!session.tokenExpiresAt && Math.floor(Date.now() / 1000) > session.tokenExpiresAt;
}

// In-memory revoke sets are a single-replica fast path — the AuthSession row
// (deleted by revokeAllUserSessions / revokeSessionById / signOut) is the
// cross-replica source of truth, consulted on every refreshToken() call.
// Capped to bound memory growth on long-lived processes (auth#34).
const FORCE_REVOKE_MAX = 1024;

function addBounded(set: Set<string>, key: string, max: number): void {
  if (set.size >= max) {
    // Evict oldest insertion (Sets retain insertion order in JS).
    const first = set.values().next().value;
    if (first !== undefined) set.delete(first);
  }
  set.add(key);
}

const forceRevalidateUserIds = new Set<string>();

export function invalidateUserSession(userId: string): void {
  addBounded(forceRevalidateUserIds, userId, FORCE_REVOKE_MAX);
}

const forceRevokeSessions = new Set<string>();

export async function revokeSessionById(sessionId: string): Promise<void> {
  addBounded(forceRevokeSessions, sessionId, FORCE_REVOKE_MAX);

  await prisma.authSession.delete({ where: { sessionId } }).catch(() => {});
}

export async function revokeAllUserSessions(userId: string): Promise<void> {
  const sessions = await prisma.authSession.findMany({
    where: { userId },
    select: { sessionId: true },
  });
  await prisma.authSession.deleteMany({ where: { userId } });
  for (const s of sessions) addBounded(forceRevokeSessions, s.sessionId, FORCE_REVOKE_MAX);

  addBounded(forceRevalidateUserIds, userId, FORCE_REVOKE_MAX);

  // Replica-safe revocation: refreshToken() compares this timestamp against the
  // JWT's iat on every token refresh. The in-memory Set above is just a same-
  // replica latency win (avoids the next DB read).
  await prisma.user.update({
    where: { id: userId },
    data: { sessionsRevokedAt: new Date() },
  }).catch((err) => console.error("[auth] sessionsRevokedAt write failed:", err instanceof Error ? err.message : err));
}

interface DeviceMeta {
  _sessionId: string;
  _uaFingerprint: string;
  _isMobile: boolean;
  _deviceLabel: string;
  _auditIp: string;
  _auditUa: string;
}

function buildDeviceMeta(headers: Headers): DeviceMeta {
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

async function initializeTokenOnSignIn(token: JwtToken, user: Record<string, unknown>): Promise<JwtToken> {
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

async function rotateSessionIdOnRoleChange(oldSessionId: string): Promise<string | null> {
  // Rotate sessionId when role changes so the old token cannot be replayed after a role change
  const newSessionId = crypto.randomUUID();
  addBounded(forceRevokeSessions, oldSessionId, FORCE_REVOKE_MAX);
  const rotated = await prisma.authSession.update({
    where: { sessionId: oldSessionId },
    data:  { sessionId: newSessionId },
  }).catch(() => null);
  return rotated ? newSessionId : null;
}

async function refreshToken(token: JwtToken): Promise<JwtToken | null> {
  const nowSec = Math.floor(Date.now() / 1000);
  if (token.expiresAt && nowSec > (token.expiresAt as number)) {
    return null;
  }

  const userId = token.id as string | undefined;
  if (!userId) return null;

  const sessionId = token.sessionId as string | undefined;
  if (!sessionId) return null;

  if (forceRevokeSessions.has(sessionId)) {
    forceRevokeSessions.delete(sessionId);
    return null;
  }

  const now         = Math.floor(Date.now() / 1000);
  const lastChecked = token.dbCheckedAt as number | undefined;
  const forceCheck  = forceRevalidateUserIds.has(userId);
  if (forceCheck) forceRevalidateUserIds.delete(userId);
  // Admins/issue-admins recheck DB every 10 s so role demotions propagate quickly
  const checkInterval = (token.role === "ADMIN" || token.role === "ISSUE_ADMIN") ? 10 : 60;

  if (!forceCheck && lastChecked && now - lastChecked <= checkInterval) {
    return token;
  }

  const [dbUser, authSessionRow] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, mediaServer: true, sessionsRevokedAt: true, passwordChangedAt: true },
    }),
    prisma.authSession.findUnique({ where: { sessionId } }),
  ]);

  if (!dbUser) return null;
  // Cross-replica revocation: revokeAllUserSessions / revokeSessionById delete the
  // AuthSession row, and the next refreshToken() call on any replica fails here.
  if (!authSessionRow) return null;

  // Defense-in-depth revocation backstop: even if an AuthSession row somehow
  // survives a revoke (failed delete, replica lag, manual DB intervention),
  // any JWT minted before sessionsRevokedAt / passwordChangedAt is refused.
  // Existing flows (AuthSession deletion + in-memory force-revoke set) remain
  // the primary path; this is the belt-and-suspenders timestamp check.
  const revokedSec = dbUser.sessionsRevokedAt ? Math.floor(dbUser.sessionsRevokedAt.getTime() / 1000) : 0;
  const passwordSec = dbUser.passwordChangedAt ? Math.floor(dbUser.passwordChangedAt.getTime() / 1000) : 0;
  const cutoff = Math.max(revokedSec, passwordSec);
  if (cutoff > 0 && typeof token.iat === "number" && token.iat < cutoff) {
    return null;
  }

  void prisma.authSession.update({
    where: { sessionId },
    data: { lastSeenAt: new Date() },
  }).catch(() => {});

  if (!token.uaFingerprint) {
    // OIDC sign-ins skip authorize(), so the fingerprint is derived from the current request's UA on first refresh
    try {
      const { headers: getHeaders } = await import("next/headers");
      const h = await getHeaders();
      const ua = h.get("user-agent") ?? "";
      if (ua) token.uaFingerprint = serializeFingerprint(extractUaFingerprint(ua));
    } catch {
      // jwt() invoked outside request context — fingerprint stays unset, populated on next request
    }
  }

  if (dbUser.role !== token.role) {
    const newSessionId = await rotateSessionIdOnRoleChange(sessionId);
    if (!newSessionId) return null;
    token.sessionId = newSessionId;
  }

  token.role = dbUser.role;

  const provider = token.provider as string | null;
  if (provider !== "plex" && provider !== "jellyfin" && provider !== "jellyfin-quickconnect") {
    token.mediaServer = dbUser.mediaServer ?? null;
  }
  token.dbCheckedAt = now;

  // Non-admins get their token silently shortened to 1 h on each DB check to
  // cap stale JWT lifetime — but bounded by maxExpiresAt (set once at sign-in)
  // so the sliding window can NEVER push the effective expiry past the original
  // session TTL. Without that ceiling an actively-used session would be
  // immortal: every refresh re-extended expiresAt to now+3600.
  if (token.role !== "ADMIN") {
    // Backfill for any pre-existing JWTs minted before maxExpiresAt was set.
    // We anchor it to the token's current expiresAt — not "now + 3600" — so a
    // missing column on an older token cannot itself create immortality.
    if (typeof token.maxExpiresAt !== "number" && typeof token.expiresAt === "number") {
      token.maxExpiresAt = token.expiresAt;
    }
    const maxExp = token.maxExpiresAt as number | undefined;
    if (typeof maxExp === "number") {
      if (now >= maxExp) {
        return null;
      }
      if ((token.expiresAt as number) > now + 3600) {
        token.expiresAt = Math.min(now + 3600, maxExp);
      }
    } else if ((token.expiresAt as number) > now + 3600) {
      // No maxExpiresAt available at all — clamp to the absolute hard ceiling so
      // a successful refresh still can't outlive MAX_ALLOWED_SESSION_SECONDS.
      token.expiresAt = now + 3600;
    }
  }

  return token;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  trustHost: !!(process.env.AUTH_URL || process.env.NEXTAUTH_URL || process.env.AUTH_TRUST_HOST === "true"),
  // Account OAuth tokens are encrypted/decrypted by the Prisma extension in src/lib/prisma.ts
  // (account.create/update/upsert encrypt; findUnique/findFirst/findMany decrypt). Wrapping the
  // adapter with a second encrypt-on-linkAccount layer produced double-encrypted rows — see
  // guardrail #7a in CLAUDE.md.
  adapter: prismaAuthAdapter(prisma),
  callbacks: {
    ...authConfig.callbacks,
    async jwt(params) {
      // Delegate to the base jwt callback in auth.config.ts so the provider
      // wiring (mediaServer, role, sessionId, fingerprint) stays in one place.
      // Typed local instead of `as any` — auth.config.ts always defines it,
      // but the NextAuth config type marks `callbacks.jwt` optional.
      const baseJwt = authConfig.callbacks?.jwt;
      if (!baseJwt) throw new Error("auth.config.ts must define callbacks.jwt");
      // NextAuth types baseJwt as returning `JWT | null`, but auth.config.ts's
      // implementation always returns the mutated token object. Treat null as a
      // hard failure rather than passing it through to the helpers.
      const baseToken = await baseJwt(params);
      if (!baseToken) throw new Error("base jwt callback returned null");
      const token = baseToken as JwtToken;
      if (params.user) return initializeTokenOnSignIn(token, params.user as Record<string, unknown>);
      return refreshToken(token);
    },
  },
  events: {
    async signIn({ user, account, profile }) {
      const u = user as { _auditIp?: string; _auditUa?: string; id?: string; name?: string | null; email?: string | null; role?: string };

      // OIDC: keep notificationEmail in lock-step with the OIDC provider's current email claim.
      // Prefer the fresh `profile.email` over `user.email` — the adapter-returned user is
      // the stored DB row and can lag behind OIDC email changes.
      if (account?.provider === "oidc" && u.id) {
        const oidcEmail = typeof profile?.email === "string"
          ? normalizeEmail(profile.email)
          : u.email
            ? normalizeEmail(u.email)
            : null;
        if (oidcEmail) {
          await prisma.user.update({
            where: { id: u.id },
            data: { notificationEmail: oidcEmail },
          }).catch((err) => console.error("[auth] notificationEmail sync (oidc) failed:", err instanceof Error ? err.message : err));
        }
      }

      if (account?.provider && account.provider !== "credentials" && u.id) {
        const signingInUserId = u.id;
        const promoted = await prisma.$transaction(async (tx) => {
          // Advisory lock prevents two concurrent first-time OAuth sign-ins both being promoted to ADMIN
          await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(1947888749)");

          const setupRow = await tx.setting.findUnique({ where: { key: "setup_completed_at" } });
          if (setupRow) return false;
          // Failsafe: promote whenever no ADMIN exists yet. Two concurrent first-time
          // sign-ins create their User rows before entering this lock; the lock
          // serializes them, so the second to acquire it sees existingAdmin !== 0
          // and skips promotion. The first acquirer always promotes ITSELF — never
          // `findFirst(orderBy createdAt)`, which can return a different user that
          // raced into the table first but isn't the one signing in right now.
          const existingAdmin = await tx.user.findFirst({ where: { role: "ADMIN" }, select: { id: true } });
          if (existingAdmin) return false;
          // Confirm the signing-in user still exists (e.g. wasn't deleted between
          // adapter insert and event firing) before promoting.
          const self = await tx.user.findUnique({ where: { id: signingInUserId }, select: { id: true } });
          if (!self) return false;
          await tx.user.update({ where: { id: signingInUserId }, data: { role: "ADMIN" } });
          await tx.setting.create({ data: { key: "setup_completed_at", value: new Date().toISOString() } }).catch(() => {});
          return true;
        });
        if (promoted) u.role = "ADMIN";
      }

      void logAudit({
        userId: u.id ?? "unknown",
        userName: u.name ?? u.email ?? "unknown",
        action: "AUTH_LOGIN",
        target: "auth:login",
        ipAddress: u._auditIp ?? null,
        userAgent: u._auditUa ?? null,
        provider: account?.provider ?? null,
        details: {
          provider: account?.provider,
          email: u.email,
          role: u.role,
          ip: u._auditIp,
          browser: u._auditUa?.slice(0, 100),
        },
      });
    },
    async signOut(message) {
      if ("token" in message && message.token) {
        const t = message.token;

        const sessionId = t.sessionId as string | undefined;
        if (sessionId) {
          void prisma.authSession.delete({ where: { sessionId } }).catch(() => {});
        }

        void logAudit({
          userId: (t.id as string) ?? "unknown",
          userName: (t.name as string) ?? (t.email as string) ?? "unknown",
          action: "AUTH_LOGOUT",
          target: "auth:logout",
          provider: (t.provider as string) ?? null,
          details: {
            provider: (t.provider as string) ?? null,
            email: t.email,
            role: t.role,
          },
        });
      }
    },
  },
  providers: [
    Credentials({
      id: "credentials",
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
        rememberMe: { label: "Remember me", type: "text" },
      },
      async authorize(credentials, req) {
        if (!credentials?.email || !credentials?.password) return null;
        if ((credentials.password as string).length > 1000) return null;

        const disableRow = await prisma.setting.findUnique({ where: { key: "disableLocalLogin" } });
        if (disableRow?.value === "true") return null;

        const headers = (req as Request).headers as Headers;
        const ip = getClientIp(headers);
        const ua = headers.get("user-agent")?.slice(0, 512) ?? null;
        const email = normalizeEmail(credentials.email as string);

        // When TRUST_PROXY is unset (single-host deployments behind no reverse proxy), getClientIp
        // returns the literal "unknown" — keying a single `login-ip:unknown` bucket would mean five
        // typos from any one client locks out the whole instance for 5 minutes. Fall back to a
        // per-email bucket so the attack surface is limited to the targeted account.
        const emailHash = hashAuditEmail(email);
        const rateKey = ip === "unknown" ? `login-email:${emailHash}` : `login-ip:${ip}`;
        const rateMax  = ip === "unknown" ? 10 : 20;

        if (!checkRateLimit(rateKey, rateMax, 5 * 60 * 1000)) {
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
      },
    }),

    Credentials({
      id: "plex",
      name: "Plex",
      credentials: {
        plexToken: { label: "Plex Token", type: "text" },
        plexClientId: { label: "Plex Client ID", type: "text" },
        rememberMe: { label: "Remember me", type: "text" },
      },
      async authorize(credentials, req) {
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
        return plexResult;
      },
    }),

    ...(process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID && process.env.OIDC_CLIENT_SECRET
      ? [
          {
            id: "oidc",
            name: process.env.OIDC_DISPLAY_NAME || "SSO",
            type: "oidc" as const,
            issuer: process.env.OIDC_ISSUER,
            clientId: process.env.OIDC_CLIENT_ID,
            clientSecret: process.env.OIDC_CLIENT_SECRET,
            profile(profile: { sub: string; email?: string; email_verified?: boolean; name?: string; picture?: string; preferred_username?: string }) {
              if (!profile.sub || typeof profile.sub !== "string" || profile.sub.trim() === "") {
                throw new Error("[auth/oidc] OIDC profile missing required subject identifier (sub)");
              }

              if (profile.email_verified !== true) {
                throw new Error("OIDC account email is not verified");
              }
              if (!profile.email) {
                console.error("[auth/oidc] provider returned no email — rejecting sign-in for sub:", profile.sub);
                throw new Error("[auth/oidc] provider returned no email");
              }
              const email = normalizeEmail(profile.email);
              return {
                id: profile.sub,
                email,
                name: profile.name ?? profile.preferred_username ?? null,
                image: profile.picture ?? null,

              };
            },
          },
        ]
      : []),

    ...(process.env.JELLYFIN_URL
      ? [
          Credentials({
            id: "jellyfin",
            name: "Jellyfin",
            credentials: {
              username: { label: "Username", type: "text" },
              password: { label: "Password", type: "password" },
              rememberMe: { label: "Remember me", type: "text" },
            },
            async authorize(credentials, req) {
              if (!credentials?.username || !credentials?.password) return null;
              const username = credentials.username as string;
              if (username.length > 200 || (credentials.password as string).length > 1000) {
                return null;
              }
              const headers = (req as Request).headers as Headers;
              const ip = getClientIp(headers);
              const ua = headers.get("user-agent")?.slice(0, 512) ?? null;

              if (!checkRateLimit(`jellyfin-ip:${ip}`, 10, 5 * 60 * 1000)) {
                void logAudit({ userId: "anonymous", userName: "anonymous", action: "AUTH_LOGIN_FAILED", target: "auth:login", ipAddress: ip, userAgent: ua, provider: "jellyfin", details: { reason: "rate_limited" } });
                return null;
              }

              let jfUser;
              try {
                jfUser = await authenticateWithJellyfin(
                  process.env.JELLYFIN_URL!,
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
            },
          }),
          Credentials({
            id: "jellyfin-quickconnect",
            name: "Jellyfin QuickConnect",
            credentials: {
              secret: { label: "QuickConnect Secret", type: "text" },
              rememberMe: { label: "Remember me", type: "text" },
            },
            async authorize(credentials, req) {
              if (!credentials?.secret) return null;
              const headers = (req as Request).headers as Headers;
              const ip = getClientIp(headers);
              const ua = headers.get("user-agent")?.slice(0, 512) ?? null;
              if (!checkRateLimit(`jellyfin-qc-ip:${ip}`, 10, 5 * 60 * 1000)) {
                void logAudit({ userId: "anonymous", userName: "anonymous", action: "AUTH_LOGIN_FAILED", target: "auth:login", ipAddress: ip, userAgent: ua, provider: "jellyfin-quickconnect", details: { reason: "rate_limited" } });
                return null;
              }
              let jfUser;
              try {
                jfUser = await authenticateWithJellyfinQuickConnect(
                  process.env.JELLYFIN_URL!,
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
            },
          }),
        ]
      : []),
  ],
});
