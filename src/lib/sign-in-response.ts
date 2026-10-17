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
// (/api/auth/sign-in/*). The token goes out on exactly ONE transport — the one
// it was minted for (guardrail 6h):
//   - a browser sign-in gets the HttpOnly session cookie, and the token never
//     appears in the body;
//   - a native client (X-Summonarr-Client) gets the JWT in the JSON body, which
//     it stores and presents as `Authorization: Bearer <token>`, and NO session
//     cookie. The token is bound to the bearer transport, so a cookie copy could
//     never authenticate anything; it would only be one more place a
//     never-expiring credential sits. The iOS apps keep no cookie jar anyway
//     (NetworkSession.swift: httpCookieStorage = nil).
//
// The body token is gated on the header AND on a bearer-bound token, so a
// browser login never exposes the session JWT to JavaScript — preserving the
// HttpOnly guarantee for the web app. Browsers don't send X-Summonarr-Client.
// Both conditions come from the same header in the same request
// (initializeTokenOnSignIn), so they cannot disagree in practice; if they ever
// did, nothing is delivered rather than a token on the wrong transport.
export function buildSignInResponse(
  req: NextRequest,
  result: SignInResult,
  opts?: { extraSetCookies?: string[] },
): NextResponse {
  const body: Record<string, unknown> = { ok: true, user: result.user };

  const nativeCaller = hasNativeClientHeader(req.headers.get(NATIVE_CLIENT_HEADER));
  if (nativeCaller && result.transport === "bearer") {
    body.token = result.token;
    body.tokenType = "Bearer";
    body.expiresInSeconds = result.expiresInSeconds;
  }

  // no-store: for a native caller this body carries the long-lived session JWT
  // itself, so no intermediary or service worker may ever store it — the same
  // directive the less-sensitive MFA challenge, /me and sign-out already set.
  const res = NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  if (!nativeCaller && result.transport === "cookie") {
    res.headers.append(
      "Set-Cookie",
      serializeSessionCookie(result.token, { maxAgeSeconds: result.expiresInSeconds }),
    );
  }
  for (const cookie of opts?.extraSetCookies ?? []) {
    res.headers.append("Set-Cookie", cookie);
  }
  return res;
}
