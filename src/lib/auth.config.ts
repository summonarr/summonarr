import type { NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { extractUaFingerprint, serializeFingerprint } from "@/lib/ua-fingerprint";
import { setPendingFingerprint } from "@/lib/oidc-fingerprint-bootstrap";

export const authConfig: NextAuthConfig = {

  trustHost: !!(process.env.AUTH_URL || process.env.NEXTAUTH_URL || process.env.AUTH_TRUST_HOST === "true"),
  pages: {
    signIn: "/login",
  },
  session: { strategy: "jwt" },
  providers: [
    Credentials({ id: "credentials", credentials: { email: {}, password: {} } }),
    Credentials({ id: "plex", credentials: { plexToken: {} } }),
    ...(process.env.JELLYFIN_URL
      ? [
          Credentials({ id: "jellyfin", credentials: { username: {}, password: {} } }),
          Credentials({ id: "jellyfin-quickconnect", credentials: { secret: {} } }),
        ]
      : []),
  ],
  callbacks: {
    async authorized({ auth, request }) {
      const { nextUrl } = request;
      const isLoggedIn = !!auth?.user;

      const isPublic =
        nextUrl.pathname.startsWith("/login") ||
        nextUrl.pathname.startsWith("/register") ||
        nextUrl.pathname.startsWith("/setup") ||
        nextUrl.pathname.startsWith("/auth/plex") ||
        nextUrl.pathname.startsWith("/api/auth/") ||
        nextUrl.pathname.startsWith("/api/webhooks/") ||
        nextUrl.pathname.startsWith("/api/discord/") ||
        nextUrl.pathname === "/api/sync" ||
        nextUrl.pathname.startsWith("/api/sync/") ||
        nextUrl.pathname.startsWith("/api/cron/") ||
        nextUrl.pathname === "/api/interactions" ||
        nextUrl.pathname === "/api/health";

      if (isPublic) return true;

      const baseUrl = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL ?? nextUrl.origin;
      const basePath = process.env.BASE_PATH ?? "";

      if (isLoggedIn) {
        const loginUrl = new URL(`${basePath}/login`, baseUrl);
        loginUrl.searchParams.set("callbackUrl", nextUrl.pathname);

        if (auth.tokenExpiresAt && Math.floor(Date.now() / 1000) > auth.tokenExpiresAt) {
          return Response.redirect(loginUrl);
        }

        const storedFp = (auth as unknown as Record<string, unknown>).uaFingerprint as string | undefined;
        const sessionId = (auth as unknown as Record<string, unknown>).sessionId as string | undefined;
        const currentFp = serializeFingerprint(
          extractUaFingerprint(request.headers.get("user-agent") ?? "")
        );

        if (!storedFp && sessionId) {
          // OIDC sign-ins never pass through authorize(), so the fingerprint is bootstrapped here on first request
          setPendingFingerprint(sessionId, currentFp);
        }

        if (storedFp) {
          if (currentFp !== storedFp) {
            // UA fingerprint mismatch — redirect and clear both cookie variants (secure and non-secure)
            const response = Response.redirect(loginUrl);
            response.headers.append(
              "Set-Cookie",
              "authjs.session-token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"
            );
            response.headers.append(
              "Set-Cookie",
              "__Secure-authjs.session-token=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax"
            );
            return response;
          }
        }
      }

      if (!isLoggedIn) {
        const loginUrl = new URL(`${basePath}/login`, baseUrl);
        loginUrl.searchParams.set("callbackUrl", nextUrl.pathname);
        return Response.redirect(loginUrl);
      }

      const role = auth?.user?.role;
      const lowerPath = nextUrl.pathname.toLowerCase();
      if (lowerPath.startsWith("/admin") && role !== "ADMIN") {
        if (
          role !== "ISSUE_ADMIN" ||
          !lowerPath.startsWith("/admin/issues")
        ) {
          return Response.redirect(new URL(`${basePath}/`, nextUrl));
        }
      }

      return true;
    },
    jwt({ token, user, account }) {
      if (account) {
        token.provider = account.provider;
        // mediaServer is baked into the token at sign-in; for plex/jellyfin it cannot be overridden by DB value
        if (account.provider === "plex") token.mediaServer = "plex";
        else if (account.provider === "jellyfin" || account.provider === "jellyfin-quickconnect") token.mediaServer = "jellyfin";
      }
      if (user) {
        token.id = user.id;
        token.role = (user as { role?: string }).role;

        const u = user as {
          role?: string;
          _sessionId?: string;
          _uaFingerprint?: string;
          _isMobile?: boolean;
          _deviceLabel?: string;
        };
        if (u._sessionId)                   token.sessionId     = u._sessionId;
        if (u._uaFingerprint)               token.uaFingerprint = u._uaFingerprint;
        if (u._isMobile !== undefined)      token.isMobile      = u._isMobile;
        if (u._deviceLabel)                 token.deviceLabel   = u._deviceLabel;

      }
      return token;
    },
    session({ session, token }) {
      if (token) {

        const id   = token.id   as string | undefined;
        const role = token.role as string | undefined;
        if (!id || !role) return session;

        session.user.id          = id;
        session.user.role        = role;
        session.user.provider    = token.provider as string | undefined;
        session.user.mediaServer = (token.mediaServer as string | null | undefined) ?? null;
        if (token.expiresAt) session.tokenExpiresAt = token.expiresAt as number;
        if (token.sessionId) session.sessionId      = token.sessionId as string;

        if (token.uaFingerprint) {
          (session as unknown as Record<string, unknown>).uaFingerprint = token.uaFingerprint;
        }
      }
      return session;
    },
  },
};
