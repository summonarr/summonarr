import { NextResponse, type NextRequest } from "next/server";
import { serializeSessionCookie } from "@/lib/session-cookie";
import { NATIVE_CLIENT_HEADER, hasNativeClientHeader } from "@/lib/mobile-auth";
import type { SignInResult } from "@/lib/auth";

// Shared response builder for the provider sign-in routes
// (/api/auth/sign-in/*). Always sets the HttpOnly session cookie so the web
// flow is unchanged. A native client opts in via the X-Summonarr-Client header
// to ALSO receive the JWT in the JSON body, which it then stores and presents
// as `Authorization: Bearer <token>`.
//
// The token is gated on the header (not returned unconditionally) so a browser
// login never exposes the session JWT to JavaScript — preserving the HttpOnly
// guarantee for the web app. Browsers don't send X-Summonarr-Client.
export function buildSignInResponse(
  req: NextRequest,
  result: SignInResult,
  opts?: { extraSetCookies?: string[] },
): NextResponse {
  const body: Record<string, unknown> = { ok: true, user: result.user };

  if (hasNativeClientHeader(req.headers.get(NATIVE_CLIENT_HEADER))) {
    body.token = result.token;
    body.tokenType = "Bearer";
    body.expiresInSeconds = result.expiresInSeconds;
  }

  const res = NextResponse.json(body);
  res.headers.append(
    "Set-Cookie",
    serializeSessionCookie(result.token, { maxAgeSeconds: result.expiresInSeconds }),
  );
  for (const cookie of opts?.extraSetCookies ?? []) {
    res.headers.append("Set-Cookie", cookie);
  }
  return res;
}
