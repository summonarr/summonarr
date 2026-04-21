import NextAuth, { type Session } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
import { createHash } from "crypto";
import { authConfig } from "@/lib/auth.config";
import { getPlexUser, getPlexFriendEmails, pingPlexToken } from "@/lib/plex";
import { authenticateWithJellyfin, authenticateWithJellyfinQuickConnect, getJellyfinUserEmail } from "@/lib/jellyfin";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import { extractUaFingerprint, serializeFingerprint, fingerprintToLabel } from "@/lib/ua-fingerprint";
import { consumePendingFingerprint } from "@/lib/oidc-fingerprint-bootstrap";
import { encryptToken, decryptToken } from "@/lib/token-crypto";
import type { Adapter, AdapterAccount } from "next-auth/adapters";

// Always run bcrypt even on missing accounts to prevent timing-based user enumeration
const DUMMY_HASH = "$2a$12$K4v7Dp0.fiN0EKr9lUDBTeVrQBH1/6Mo3hVRfVIGdFJZQ6XH2GKGK";

export function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

async function findOrCreateUser({
  email,
  name,
  image,
}: {
  email: string;
  name?: string | null;
  image?: string | null;
}) {
  const normalized = normalizeEmail(email);
  const existing = await prisma.user.findUnique({ where: { email: normalized } });
  if (existing) {
    return { id: existing.id, email: existing.email, name: existing.name, role: existing.role };
  }

  const user = await prisma.user.create({
    data: { email: normalized, name: name ?? null, image: image ?? null, role: "USER" },
    select: { id: true, email: true, name: true, role: true },
  });
  return user;
}

async function findOrCreateJellyfinUser(jellyfinId: string, name: string): Promise<{ id: string; email: string; name: string | null; role: string }> {
  // Jellyfin users may lack email addresses; synthetic address is the stable identity anchor
  const syntheticEmail = `jellyfin-${jellyfinId}@jellyfin.local`;

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

  }

  const existing = await prisma.user.findUnique({ where: { email: syntheticEmail } });
  if (existing) {
    if (realEmail && existing.email !== realEmail) {
      await prisma.user.update({ where: { id: existing.id }, data: { email: realEmail } });
      return { id: existing.id, email: realEmail, name: existing.name, role: existing.role };
    }
    return { id: existing.id, email: existing.email, name: existing.name, role: existing.role };
  }

  return findOrCreateUser({ email: realEmail ?? syntheticEmail, name });
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

const forceRevalidateUserIds = new Set<string>();

export function invalidateUserSession(userId: string): void {
  forceRevalidateUserIds.add(userId);
}

const forceRevokeSessions = new Set<string>();

export async function revokeSessionById(sessionId: string): Promise<void> {
  forceRevokeSessions.add(sessionId);

  await prisma.authSession.delete({ where: { sessionId } }).catch(() => {});
}

export async function revokeAllUserSessions(userId: string): Promise<void> {
  const sessions = await prisma.authSession.findMany({
    where: { userId },
    select: { sessionId: true },
  });
  await prisma.authSession.deleteMany({ where: { userId } });
  for (const s of sessions) forceRevokeSessions.add(s.sessionId);

  forceRevalidateUserIds.add(userId);
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

function encryptAccountTokens(account: AdapterAccount): AdapterAccount {
  return {
    ...account,
    access_token:  account.access_token  ? encryptToken(account.access_token)  : account.access_token,
    refresh_token: account.refresh_token ? encryptToken(account.refresh_token) : account.refresh_token,
    id_token:      account.id_token      ? encryptToken(account.id_token)      : account.id_token,
  };
}

function decryptAccountTokens(account: AdapterAccount): AdapterAccount {
  return {
    ...account,
    access_token:  account.access_token  ? decryptToken(account.access_token)  : account.access_token,
    refresh_token: account.refresh_token ? decryptToken(account.refresh_token) : account.refresh_token,
    id_token:      account.id_token      ? decryptToken(account.id_token)      : account.id_token,
  };
}

function encryptingAdapter(base: Adapter): Adapter {
  return {
    ...base,
    linkAccount: base.linkAccount
      ? (account: AdapterAccount) => base.linkAccount!(encryptAccountTokens(account))
      : undefined,
    getAccount: base.getAccount
      ? async (providerAccountId: string, provider: string) => {
          const account = await base.getAccount!(providerAccountId, provider);
          return account ? decryptAccountTokens(account) : null;
        }
      : undefined,
  };
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  trustHost: !!(process.env.AUTH_URL || process.env.NEXTAUTH_URL || process.env.AUTH_TRUST_HOST === "true"),
  adapter: encryptingAdapter(PrismaAdapter(prisma)),
  callbacks: {
    ...authConfig.callbacks,
    async jwt(params) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const token = await (authConfig.callbacks as any).jwt(params);

      if (params.user) {

        if (!token.sessionId) {
          // Credentials provider supplies _sessionId via DeviceMeta; OIDC/OAuth do not
          token.sessionId = crypto.randomUUID();

        }

        const rememberMe = (params.user as { rememberMe?: string }).rememberMe === "true";
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

        if (!token.mediaServer && params.user.id) {
          const dbUser = await prisma.user.findUnique({
            where: { id: params.user.id as string },
            select: { mediaServer: true },
          });
          token.mediaServer = dbUser?.mediaServer ?? null;
        }

        const sessionId = token.sessionId as string;
        if (params.user.id) {
          const deviceLabel = (token.deviceLabel as string | undefined) ?? null;
          const deviceType  = isMobile ? "mobile" : "desktop";
          const ipAddress   = (params.user as { _auditIp?: string })._auditIp ?? null;
          await prisma.authSession.upsert({
            where: { sessionId },
            update: { lastSeenAt: new Date(), expiresAt: new Date(token.expiresAt * 1000) },
            create: {
              sessionId,
              userId:      params.user.id as string,
              deviceType,
              deviceLabel,
              ipAddress,
              expiresAt:   new Date(token.expiresAt * 1000),
            },
          });
        }

        return token;
      }

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

      const now           = Math.floor(Date.now() / 1000);
      const lastChecked   = token.dbCheckedAt as number | undefined;
      const forceCheck    = forceRevalidateUserIds.has(userId);
      if (forceCheck) forceRevalidateUserIds.delete(userId);
      // Admins/issue-admins recheck DB every 10 s so role demotions propagate quickly
      const checkInterval = (token.role === "ADMIN" || token.role === "ISSUE_ADMIN") ? 10 : 60;

      if (forceCheck || !lastChecked || now - lastChecked > checkInterval) {

        const [dbUser, authSessionRow] = await Promise.all([
          prisma.user.findUnique({
            where: { id: userId },
            select: { role: true, mediaServer: true },
          }),
          prisma.authSession.findUnique({ where: { sessionId } }),
        ]);

        if (!dbUser) return null;
        if (!authSessionRow) return null;

        void prisma.authSession.update({
          where: { sessionId },
          data: { lastSeenAt: new Date() },
        }).catch(() => {});

        if (!token.uaFingerprint) {
          const bootstrapFp = consumePendingFingerprint(sessionId);
          if (bootstrapFp) token.uaFingerprint = bootstrapFp;
        }

        if (dbUser.role !== token.role) {
          // Rotate sessionId when role changes so the old token cannot be replayed after a role change
          const newSessionId = crypto.randomUUID();
          forceRevokeSessions.add(sessionId);
          const rotated = await prisma.authSession.update({
            where: { sessionId },
            data: { sessionId: newSessionId },
          }).catch(() => null);
          if (!rotated) return null;
          token.sessionId = newSessionId;
        }

        token.role = dbUser.role;

        const provider = token.provider as string | null;
        if (provider !== "plex" && provider !== "jellyfin" && provider !== "jellyfin-quickconnect") {
          token.mediaServer = dbUser.mediaServer ?? null;
        }
        token.dbCheckedAt = now;

        // Non-admins get their token silently shortened to 1 h on each DB check to cap stale JWT lifetime
        if (token.role !== "ADMIN" && (token.expiresAt as number) > now + 3600) {
          token.expiresAt = now + 3600;
        }
      }

      return token;
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
        const promoted = await prisma.$transaction(async (tx) => {
          // Advisory lock prevents two concurrent first-time OAuth sign-ins both being promoted to ADMIN
          await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(1947888749)");

          const setupRow = await tx.setting.findUnique({ where: { key: "setup_completed_at" } });
          if (setupRow) return false;
          const totalUsers = await tx.user.count();
          if (totalUsers === 1) {
            await tx.user.update({ where: { id: u.id }, data: { role: "ADMIN" } });
            await tx.setting.create({ data: { key: "setup_completed_at", value: new Date().toISOString() } }).catch(() => {});
            return true;
          }
          return false;
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
        const rateKey = ip === "unknown" ? "login-ip:unknown" : `login-ip:${ip}`;
        const rateMax  = ip === "unknown" ? 5 : 20;
        const email = normalizeEmail(credentials.email as string);

        if (!checkRateLimit(rateKey, rateMax, 5 * 60 * 1000)) {
          void logAudit({ userId: "anonymous", userName: "anonymous", action: "AUTH_LOGIN_FAILED", target: "auth:login", ipAddress: ip, userAgent: ua, provider: "credentials", details: { reason: "rate_limited", email } });
          return null;
        }

        const user = await prisma.user.findUnique({ where: { email } });

        const hash = user?.passwordHash ?? DUMMY_HASH;
        const valid = await bcrypt.compare(credentials.password as string, hash);

        if (!valid || !user) {
          void logAudit({ userId: "anonymous", userName: "anonymous", action: "AUTH_LOGIN_FAILED", target: "auth:login", ipAddress: ip, userAgent: ua, provider: "credentials", details: { reason: "invalid_credentials", email } });
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
          const tokenHash = createHash("sha256").update(plexToken).digest("hex");

          const CACHE_TTL_DAYS = 30;
          const cacheCutoff = new Date(Date.now() - CACHE_TTL_DAYS * 24 * 60 * 60 * 1000);
          const cached = await prisma.plexTokenCache.findUnique({ where: { tokenHash } });

          let verifiedEmail: string | null = null;
          let plexName: string | null = null;
          let plexThumb: string = "";

          if (cached && cached.verifiedAt > cacheCutoff) {
            // A lightweight ping avoids a full /api/v2/user round-trip on every cached sign-in
            const stillValid = await pingPlexToken(plexToken, browserClientId);
            if (stillValid) {
              verifiedEmail = cached.email;
              await prisma.plexTokenCache.update({ where: { tokenHash }, data: { lastUsedAt: new Date() } });
            } else {
              // Token was revoked in Plex — purge cache so next attempt re-validates from scratch
              await prisma.plexTokenCache.delete({ where: { tokenHash } }).catch(() => {});
            }
          }

          if (!verifiedEmail) {
            const plexUser = await getPlexUser(plexToken, browserClientId);
            verifiedEmail = normalizeEmail(plexUser.email);
            plexName = plexUser.username;
            plexThumb = plexUser.thumb;
            await prisma.plexTokenCache.upsert({
              where: { tokenHash },
              create: { tokenHash, email: verifiedEmail },
              update: { email: verifiedEmail, verifiedAt: new Date(), lastUsedAt: new Date() },
            });
          }

          const [adminTokenRow, adminEmailRow, serverUrlRow] = await Promise.all([
            prisma.setting.findUnique({ where: { key: "plexAdminToken" } }),
            prisma.setting.findUnique({ where: { key: "plexAdminEmail" } }),
            prisma.setting.findUnique({ where: { key: "plexServerUrl" } }),
          ]);
          if (adminTokenRow?.value) {
            const allowed = await getPlexFriendEmails(adminTokenRow.value, serverUrlRow?.value ?? undefined);
            if (adminEmailRow?.value) allowed.add(adminEmailRow.value.toLowerCase());

            if (allowed.has(verifiedEmail)) {
              const plexDbUser = await findOrCreateUser({
                email: verifiedEmail,
                name: plexName,
                image: plexThumb,
              });

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
        } catch (err) {
          console.error("[plex auth] error:", err);
        }
        if (!plexResult) {
          // Constant-time delay mirrors the credentials provider path to prevent timing oracle
          await bcrypt.compare("x", DUMMY_HASH);
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
                await bcrypt.compare("x", DUMMY_HASH);
                void logAudit({ userId: "anonymous", userName: "anonymous", action: "AUTH_LOGIN_FAILED", target: "auth:login", ipAddress: ip, userAgent: ua, provider: "jellyfin", details: { reason: "invalid_credentials" } });
                return null;
              }
              const jfDbUser = await findOrCreateJellyfinUser(jfUser.id, jfUser.name);
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
              const device = buildDeviceMeta(headers);
              return { ...qcDbUser, rememberMe: credentials.rememberMe as string | undefined, ...device };
            },
          }),
        ]
      : []),
  ],
});
