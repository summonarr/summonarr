import { cookies } from "next/headers";
import { getSessionCookieName } from "./session-cookie";
import { verifySessionJwt, type SessionClaims } from "./session-jwt";

// Server-component-friendly read of the Summonarr session JWT. Returns null
// for any of: no cookie, malformed JWT, bad signature, expired token. Never
// throws.
//
// Used by the root layout to seed the initial value of the client-side
// SummonarrSessionProvider, and (in a later PR) by proxy.ts so the middleware
// doesn't have to round-trip through next-auth.
export async function readSummonarrSession(): Promise<SessionClaims | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(getSessionCookieName())?.value;
  if (!token) return null;
  return verifySessionJwt(token);
}
