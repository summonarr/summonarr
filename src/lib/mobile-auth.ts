// Native / mobile-client auth helpers.
//
// Summonarr's web flow is cookie-based: an HttpOnly session JWT the browser
// attaches automatically. A native app (iOS) can't use that cookie, so it
// authenticates by presenting the SAME session JWT as a bearer token —
// `Authorization: Bearer <jwt>` — and tags every request with the
// X-Summonarr-Client header.
//
// Why these two headers are safe CSRF-skip + fingerprint-skip signals: a
// cross-origin web page CANNOT attach a custom request header (`Authorization`
// or `X-Summonarr-Client`) to a *credentialed* request — doing so makes it a
// non-simple request, which the browser gates behind a CORS preflight the
// server never approves. So a request carrying either header was not forged by
// another site riding the victim's ambient cookie, which is exactly the threat
// the Origin check and UA-fingerprint binding defend against.

export const NATIVE_CLIENT_HEADER = "x-summonarr-client";

// Extracts the token from an `Authorization: Bearer <token>` header. Returns
// null for a missing/blank/non-Bearer header. The token is returned verbatim
// (not verified here) — callers run it through verifySessionJwt /
// verifyAndRefreshSession, which reject anything that isn't a JWT we signed, so
// a non-session bearer (e.g. a CRON_SECRET) simply fails to authenticate.
export function parseBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const match = /^Bearer[ \t]+(.+)$/i.exec(authHeader.trim());
  if (!match) return null;
  const token = match[1].trim();
  return token.length > 0 ? token : null;
}

// True when the request declares itself a native client via X-Summonarr-Client.
// Browsers never send this header, so the web flow is unaffected.
export function hasNativeClientHeader(value: string | null): boolean {
  return typeof value === "string" && value.trim().length > 0;
}
