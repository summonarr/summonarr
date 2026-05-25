import { NextResponse, type NextRequest } from "next/server";
import { findOrCreateOidcUser, signInAndMintSession, buildDeviceMeta, normalizeEmail } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  exchangeOidcCode,
  isOidcConfigured,
  OIDC_STATE_COOKIE,
  verifyOidcStateCookie,
} from "@/lib/oidc";
import { serializeSessionCookie } from "@/lib/session-cookie";

function readStateCookie(req: NextRequest): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const piece of header.split(/;\s*/)) {
    const eq = piece.indexOf("=");
    if (eq === -1) continue;
    if (piece.slice(0, eq) === OIDC_STATE_COOKIE) return piece.slice(eq + 1);
  }
  return null;
}

function clearStateCookieHeader(): string {
  return `${OIDC_STATE_COOKIE}=; Path=/api/auth/oidc; Max-Age=0; HttpOnly; SameSite=Lax`;
}

function loginErrorRedirect(req: NextRequest, code: string): NextResponse {
  const base = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL ?? new URL("/", req.url).toString();
  const url = new URL("/login", base);
  url.searchParams.set("error", code);
  const res = NextResponse.redirect(url.toString());
  res.headers.append("Set-Cookie", clearStateCookieHeader());
  return res;
}

export async function GET(req: NextRequest) {
  if (!isOidcConfigured()) {
    return loginErrorRedirect(req, "oidc_not_configured");
  }

  const stateCookie = readStateCookie(req);
  if (!stateCookie) {
    return loginErrorRedirect(req, "oidc_no_state");
  }
  const flowState = await verifyOidcStateCookie(stateCookie);
  if (!flowState) {
    return loginErrorRedirect(req, "oidc_state_invalid");
  }

  let claims;
  try {
    claims = await exchangeOidcCode(new URL(req.url), flowState);
  } catch (err) {
    console.error("[oidc/callback] code exchange failed:", err);
    return loginErrorRedirect(req, "oidc_exchange_failed");
  }

  let dbUser;
  try {
    dbUser = await findOrCreateOidcUser(claims);
  } catch (err) {
    console.error("[oidc/callback] user lookup failed:", err);
    return loginErrorRedirect(req, "oidc_user_rejected");
  }

  // Keep notificationEmail in lock-step with the OIDC provider's email claim
  // on every sign-in. Mirrors the events.signIn handler in next-auth's flow.
  if (claims.email) {
    const oidcEmail = normalizeEmail(claims.email);
    await prisma.user
      .update({ where: { id: dbUser.id }, data: { notificationEmail: oidcEmail } })
      .catch((err) => console.error("[oidc/callback] notificationEmail sync failed:", err instanceof Error ? err.message : err));
  }

  const device = buildDeviceMeta(req.headers);
  const result = await signInAndMintSession({
    user: { ...dbUser, ...device },
    providerId: "oidc",
  });

  const base = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL ?? new URL("/", req.url).toString();
  const res = NextResponse.redirect(new URL("/", base).toString());
  res.headers.append(
    "Set-Cookie",
    serializeSessionCookie(result.token, { maxAgeSeconds: result.expiresInSeconds }),
  );
  res.headers.append("Set-Cookie", clearStateCookieHeader());
  return res;
}
