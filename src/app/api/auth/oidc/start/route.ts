import { NextResponse, type NextRequest } from "next/server";
import {
  buildOidcAuthorization,
  isOidcConfigured,
  OIDC_STATE_COOKIE,
  signOidcStateCookie,
} from "@/lib/oidc";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

function getRedirectUri(base: string): string {
  return `${base.replace(/\/$/, "")}/api/auth/oidc/callback`;
}

function isSecureCookieContext(): boolean {
  const url = process.env.AUTH_URL ?? "";
  if (url.startsWith("https://")) return true;
  if (url.startsWith("http://")) return false;
  return process.env.NODE_ENV === "production";
}

// Validates a callbackUrl query param so an attacker can't smuggle an open
// redirect through the OIDC state cookie. Same rules as login-form.tsx
// (must start with "/", not "//"). Returns undefined for missing or invalid
// input — the callback then falls back to "/".
function safeCallbackUrl(raw: string | null): string | undefined {
  if (!raw) return undefined;
  if (!raw.startsWith("/") || raw.startsWith("//")) return undefined;
  // Reject `\` which Internet Explorer / older browsers historically treated as `/`.
  if (raw.includes("\\")) return undefined;
  return raw;
}

export async function GET(req: NextRequest) {
  if (!checkRateLimit(`oidc-start:${getClientIp(req.headers)}`, 20, 5 * 60 * 1000)) {
    return NextResponse.json({ error: "Too many requests — try again later." }, { status: 429 });
  }

  if (!isOidcConfigured()) {
    return NextResponse.json({ error: "OIDC sign-in is not configured" }, { status: 503 });
  }

  const authUrl = process.env.AUTH_URL;
  if (!authUrl) {
    return NextResponse.json({ error: "Server misconfigured: AUTH_URL is not set" }, { status: 500 });
  }

  const redirectUri = getRedirectUri(authUrl);
  const returnTo = safeCallbackUrl(req.nextUrl.searchParams.get("callbackUrl"));
  let auth;
  try {
    auth = await buildOidcAuthorization(redirectUri, returnTo);
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
