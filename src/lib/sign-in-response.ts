import { NextResponse, type NextRequest } from "next/server";
import { serializeSessionCookie } from "@/lib/session-cookie";
import { NATIVE_CLIENT_HEADER, hasNativeClientHeader } from "@/lib/mobile-auth";
import type { SignInResult } from "@/lib/auth";
import type { Translator } from "@/lib/i18n/translate";

// English text of apiAuth.signIn.accountDisabled (the catalog is the source;
// this constant is kept for tests that pin the English wire text).
// Shown when signInAndMintSession throws AccountDeactivatedError — i.e. the
// credential was valid but the account is disabled (see account-lifecycle.ts).
// 403, not 401: retrying with different credentials for the same account will
// never help, and the client should stop offering "try again".
export const DISABLED_ACCOUNT_MESSAGE =
  "This account has been disabled. Contact an administrator.";

export function disabledAccountResponse(t: Translator): NextResponse {
  return NextResponse.json({ error: t("apiAuth.signIn.accountDisabled") }, { status: 403 });
}

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

  // no-store: for a native caller this body carries the long-lived session JWT
  // itself, so no intermediary or service worker may ever store it — the same
  // directive the less-sensitive MFA challenge, /me and sign-out already set.
  const res = NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  res.headers.append(
    "Set-Cookie",
    serializeSessionCookie(result.token, { maxAgeSeconds: result.expiresInSeconds }),
  );
  for (const cookie of opts?.extraSetCookies ?? []) {
    res.headers.append("Set-Cookie", cookie);
  }
  return res;
}
