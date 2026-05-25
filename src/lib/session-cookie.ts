// Cookie names and attribute serialization for the Summonarr session JWT.
//
// In a secure context (production / HTTPS AUTH_URL) we use the `__Host-` prefix,
// which the browser enforces three guarantees on: must be Secure, Path must be
// /, and Domain must not be set. This makes the cookie un-spoofable by any
// other host the user visits.
//
// In dev (HTTP) we fall back to the unprefixed name because `__Host-` requires
// Secure, which requires HTTPS, which dev doesn't have.
//
// JWTs are base64url-encoded with dots between parts — all cookie-safe chars,
// so we never percent-encode the value.

const COOKIE_NAME_SECURE = "__Host-summonarr-session";
const COOKIE_NAME_INSECURE = "summonarr-session";

function isSecureContext(): boolean {
  const url = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL ?? "";
  if (url.startsWith("https://")) return true;
  if (url.startsWith("http://")) return false;
  return process.env.NODE_ENV === "production";
}

export function getSessionCookieName(): string {
  return isSecureContext() ? COOKIE_NAME_SECURE : COOKIE_NAME_INSECURE;
}

export interface CookieAttrs {
  maxAgeSeconds: number;
}

export function serializeSessionCookie(
  token: string,
  attrs: CookieAttrs,
): string {
  const secure = isSecureContext();
  const name = secure ? COOKIE_NAME_SECURE : COOKIE_NAME_INSECURE;
  const parts = [
    `${name}=${token}`,
    `Path=/`,
    `HttpOnly`,
    `SameSite=Lax`,
    `Max-Age=${attrs.maxAgeSeconds}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

// Returns both cookie variants cleared so callers can issue them regardless
// of which name was set at sign-in (handles AUTH_URL flips between deploys).
export function serializeClearedSessionCookies(): [string, string] {
  const base = "Max-Age=0; Path=/; HttpOnly; SameSite=Lax";
  return [
    `${COOKIE_NAME_SECURE}=; ${base}; Secure`,
    `${COOKIE_NAME_INSECURE}=; ${base}`,
  ];
}

export function parseSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const name = getSessionCookieName();
  for (const piece of cookieHeader.split(/;\s*/)) {
    const eq = piece.indexOf("=");
    if (eq === -1) continue;
    if (piece.slice(0, eq) === name) return piece.slice(eq + 1);
  }
  return null;
}
