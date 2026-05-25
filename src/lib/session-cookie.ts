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

// Legacy next-auth cookies left over from < v0.12.0 deployments. The custom
// session JWT replaced them, but a user who upgraded with these cookies set
// on their device keeps the orphan rows in their cookie jar. They don't
// authenticate anyone (the new flow doesn't honor them), but clearing them
// on every sign-out / clearedCookieResponse path lets browsers tidy up.
const LEGACY_NEXT_AUTH_COOKIE_NAMES = [
  "next-auth.session-token",
  "__Secure-next-auth.session-token",
  "__Host-next-auth.session-token",
  "authjs.session-token",
  "__Secure-authjs.session-token",
  "next-auth.csrf-token",
  "__Host-next-auth.csrf-token",
  "authjs.csrf-token",
  "__Host-authjs.csrf-token",
  "next-auth.callback-url",
  "__Secure-next-auth.callback-url",
  "authjs.callback-url",
  "__Secure-authjs.callback-url",
] as const;

// Returns the Summonarr cookie variants plus the legacy next-auth cookie
// names, all cleared. Handles AUTH_URL flips between deploys (both prefixed
// and unprefixed Summonarr variants) and migration cleanup (legacy cookies
// expired so browser cookie jars stop replaying them).
export function serializeClearedSessionCookies(): string[] {
  const base = "Max-Age=0; Path=/; HttpOnly; SameSite=Lax";
  const out: string[] = [
    `${COOKIE_NAME_SECURE}=; ${base}; Secure`,
    `${COOKIE_NAME_INSECURE}=; ${base}`,
  ];
  for (const name of LEGACY_NEXT_AUTH_COOKIE_NAMES) {
    // Some legacy cookies were set with the __Secure- prefix and Secure flag;
    // we emit both with and without Secure so the browser matches whatever's
    // actually in the jar without us having to special-case each one.
    out.push(`${name}=; ${base}`);
    out.push(`${name}=; ${base}; Secure`);
  }
  return out;
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
