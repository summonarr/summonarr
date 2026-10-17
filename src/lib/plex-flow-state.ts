import { hkdfSync, randomUUID } from "node:crypto";
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

// ── Admin "Connect Plex" (Settings) ──────────────────────────────────────────
//
// The admin connect flow creates a PIN and later reads the Plex OWNER token back
// out of it. plex.tv returns a PIN's authToken to anyone presenting the PIN id
// and the client identifier that created it — no code, no secret. This flow
// used to create AND poll every PIN with the constant `summonarr-server`, which
// is the same in every install and public in the source, so (pinId, clientId)
// was a credential anyone could assemble: poll recent PIN ids with that
// identifier and collect whichever admin approved next.
//
// Now every connect attempt gets its own random client identifier, and both it
// and the pinId live ONLY in this signed HttpOnly cookie, bound to the admin
// who started it. The poll reads them from the cookie — never from the query —
// and saves the token server-side, so the token never reaches the browser.
//
// Signed with an HKDF subkey of NEXTAUTH_SECRET (its own purpose, typ and
// audience), never the raw secret the session JWT is signed with.

export const PLEX_CONNECT_COOKIE = "summonarr-plex-connect";
const PLEX_CONNECT_TTL_SECONDS = 10 * 60;
const PLEX_CONNECT_TYP = "summonarr-plex-connect+jwt";
const PLEX_CONNECT_AUD = "summonarr:plex-connect";

function connectKey(): Uint8Array {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("[plex-flow] NEXTAUTH_SECRET must be set");
  return new Uint8Array(hkdfSync("sha256", secret, "summonarr-plex-connect", "summonarr:plex-connect:v1", 32));
}

export interface PlexConnectState {
  pinId: number;
  clientId: string;
  // The admin who started the flow. The poll refuses any other session.
  uid: string;
}

// A fresh, unguessable client identifier for one connect attempt.
export function newPlexConnectClientId(): string {
  return `summonarr-connect-${randomUUID()}`;
}

export async function signPlexConnectCookie(state: PlexConnectState): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...state } as JWTPayload)
    .setProtectedHeader({ alg: "HS256", typ: PLEX_CONNECT_TYP })
    .setAudience(PLEX_CONNECT_AUD)
    .setIssuedAt(now)
    .setExpirationTime(now + PLEX_CONNECT_TTL_SECONDS)
    .sign(connectKey());
}

export async function verifyPlexConnectCookie(token: string): Promise<PlexConnectState | null> {
  try {
    const { payload, protectedHeader } = await jwtVerify(token, connectKey(), {
      algorithms: ["HS256"],
      audience: PLEX_CONNECT_AUD,
    });
    if (protectedHeader.typ !== PLEX_CONNECT_TYP) return null;
    if (
      typeof payload.pinId !== "number" ||
      !Number.isInteger(payload.pinId) ||
      payload.pinId <= 0 ||
      typeof payload.clientId !== "string" ||
      typeof payload.uid !== "string"
    ) {
      return null;
    }
    return { pinId: payload.pinId, clientId: payload.clientId, uid: payload.uid };
  } catch {
    return null;
  }
}

export function readPlexConnectCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const piece of cookieHeader.split(/;\s*/)) {
    const eq = piece.indexOf("=");
    if (eq === -1) continue;
    if (piece.slice(0, eq) === PLEX_CONNECT_COOKIE) return piece.slice(eq + 1);
  }
  return null;
}

// Scoped to the one route that reads it (BASE_PATH included, same reason as
// FLOW_COOKIE_PATH above). SET and CLEAR must stay identical.
const CONNECT_COOKIE_PATH = `${process.env.BASE_PATH ?? ""}/api/auth/plex/pin`;

export function buildPlexConnectSetCookie(value: string, secure: boolean): string {
  const attrs = [
    `${PLEX_CONNECT_COOKIE}=${value}`,
    `Path=${CONNECT_COOKIE_PATH}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${PLEX_CONNECT_TTL_SECONDS}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function buildPlexConnectClearedSetCookie(): string {
  return `${PLEX_CONNECT_COOKIE}=; Path=${CONNECT_COOKIE_PATH}; Max-Age=0; HttpOnly; SameSite=Lax`;
}
