import { createHash } from "node:crypto";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";

// Server-side state binding for the Jellyfin QuickConnect sign-in flow.
//
// Without this, an attacker who phishes a QC secret can submit it to
// /api/auth/sign-in/jellyfin-quickconnect from their own browser. The QC
// protocol binds nothing to the relying party — Jellyfin's QuickConnect
// endpoint authenticates whichever caller redeems the secret.
//
// Mitigation: POST /api/auth/jellyfin/quickconnect (the initiation route)
// hashes the returned secret and stamps it into a short-lived HttpOnly
// signed cookie. The sign-in route refuses any submission whose body secret
// hash doesn't match the cookie's stored hash, defeating phished-secret
// redemption from a different browser.

export const QC_FLOW_COOKIE = "summonarr-qc-flow";
const QC_FLOW_TTL_SECONDS = 10 * 60;
const ENCODER = new TextEncoder();

function getSecret(): Uint8Array {
  const s = process.env.NEXTAUTH_SECRET;
  if (!s) throw new Error("[qc-flow] NEXTAUTH_SECRET must be set");
  return ENCODER.encode(s);
}

export interface QcFlowState {
  // SHA-256 of the QuickConnect secret — never store the secret itself in the
  // cookie, since stuffing a high-entropy upstream token into our own JWT
  // expands its blast-radius unnecessarily.
  secretHash: string;
}

export function hashQuickConnectSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export async function signQcFlowCookie(state: QcFlowState): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...state } as JWTPayload)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(now)
    .setExpirationTime(now + QC_FLOW_TTL_SECONDS)
    .sign(getSecret());
}

export async function verifyQcFlowCookie(token: string): Promise<QcFlowState | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ["HS256"] });
    if (typeof payload.secretHash !== "string") {
      return null;
    }
    return { secretHash: payload.secretHash };
  } catch {
    return null;
  }
}

export function readQcFlowCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const piece of cookieHeader.split(/;\s*/)) {
    const eq = piece.indexOf("=");
    if (eq === -1) continue;
    if (piece.slice(0, eq) === QC_FLOW_COOKIE) return piece.slice(eq + 1);
  }
  return null;
}

export function buildQcFlowSetCookie(value: string, secure: boolean): string {
  const attrs = [
    `${QC_FLOW_COOKIE}=${value}`,
    "Path=/api/auth",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${QC_FLOW_TTL_SECONDS}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function buildQcFlowClearedSetCookie(): string {
  return `${QC_FLOW_COOKIE}=; Path=/api/auth; Max-Age=0; HttpOnly; SameSite=Lax`;
}
