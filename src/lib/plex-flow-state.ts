import { SignJWT, jwtVerify, type JWTPayload } from "jose";

// Server-side state binding for the Plex PIN sign-in flow.
//
// Without this, an attacker who phishes a Plex user into approving an
// attacker-created PIN can submit the resulting token directly to
// /api/auth/sign-in/plex from their own browser and end up with a Summonarr
// session as that Plex user. The PIN flow itself binds nothing to the relying
// party — Plex doesn't issue per-RP audience checks.
//
// Mitigation: /api/auth/plex/start creates the PIN server-side and sets a
// short-lived HttpOnly signed cookie carrying the pinId. /api/auth/sign-in/plex
// rejects any submission whose body pinId doesn't match the cookie's pinId.

export const PLEX_FLOW_COOKIE = "summonarr-plex-flow";
const PLEX_FLOW_TTL_SECONDS = 10 * 60;
const ENCODER = new TextEncoder();

function getSecret(): Uint8Array {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("[plex-flow] NEXTAUTH_SECRET must be set");
  return ENCODER.encode(secret);
}

export interface PlexFlowState {
  pinId: number;
  clientId: string;
}

export async function signPlexFlowCookie(state: PlexFlowState): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...state } as JWTPayload)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(now)
    .setExpirationTime(now + PLEX_FLOW_TTL_SECONDS)
    .sign(getSecret());
}

export async function verifyPlexFlowCookie(token: string): Promise<PlexFlowState | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ["HS256"] });
    if (
      typeof payload.pinId !== "number" ||
      typeof payload.clientId !== "string"
    ) {
      return null;
    }
    return {
      pinId: payload.pinId,
      clientId: payload.clientId,
    };
  } catch {
    return null;
  }
}

export function readPlexFlowCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const piece of cookieHeader.split(/;\s*/)) {
    const eq = piece.indexOf("=");
    if (eq === -1) continue;
    if (piece.slice(0, eq) === PLEX_FLOW_COOKIE) return piece.slice(eq + 1);
  }
  return null;
}

// Cookie Path must include BASE_PATH. On a subpath deployment the sign-in routes
// live at `${BASE_PATH}/api/auth/...`, and a cookie scoped to "/api/auth" is never
// sent back to them — the flow state silently vanishes and Plex sign-in fails with
// a state mismatch on every attempt. The SET and CLEAR forms must stay identical or
// the clear won't match the cookie it's trying to expire. No-op when BASE_PATH is
// unset (the default).
const FLOW_COOKIE_PATH = `${process.env.BASE_PATH ?? ""}/api/auth`;

export function buildPlexFlowSetCookie(value: string, secure: boolean): string {
  const attrs = [
    `${PLEX_FLOW_COOKIE}=${value}`,
    `Path=${FLOW_COOKIE_PATH}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${PLEX_FLOW_TTL_SECONDS}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function buildPlexFlowClearedSetCookie(): string {
  return `${PLEX_FLOW_COOKIE}=; Path=${FLOW_COOKIE_PATH}; Max-Age=0; HttpOnly; SameSite=Lax`;
}
