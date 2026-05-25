import { NextResponse, type NextRequest } from "next/server";
import {
  buildOidcAuthorization,
  isOidcConfigured,
  OIDC_STATE_COOKIE,
  signOidcStateCookie,
} from "@/lib/oidc";

function getRedirectUri(req: NextRequest): string {
  const base = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL;
  if (base) {
    return `${base.replace(/\/$/, "")}/api/auth/oidc/callback`;
  }
  return new URL("/api/auth/oidc/callback", req.url).toString();
}

function isSecureCookieContext(): boolean {
  const url = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL ?? "";
  if (url.startsWith("https://")) return true;
  if (url.startsWith("http://")) return false;
  return process.env.NODE_ENV === "production";
}

export async function GET(req: NextRequest) {
  if (!isOidcConfigured()) {
    return NextResponse.json({ error: "OIDC sign-in is not configured" }, { status: 503 });
  }

  const redirectUri = getRedirectUri(req);
  let auth;
  try {
    auth = await buildOidcAuthorization(redirectUri);
  } catch (err) {
    console.error("[oidc/start] discovery or URL build failed:", err);
    return NextResponse.json({ error: "OIDC sign-in is unavailable" }, { status: 503 });
  }

  const cookieValue = await signOidcStateCookie(auth.state);
  const res = NextResponse.redirect(auth.url.toString());
  const secure = isSecureCookieContext();
  const attrs = [
    `${OIDC_STATE_COOKIE}=${cookieValue}`,
    "Path=/api/auth/oidc",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=300",
  ];
  if (secure) attrs.push("Secure");
  res.headers.append("Set-Cookie", attrs.join("; "));
  return res;
}
