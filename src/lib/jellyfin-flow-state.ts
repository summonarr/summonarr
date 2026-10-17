import { createHash } from "node:crypto";
import { type JWTPayload } from "jose";
import { type MediaInstanceKey } from "@/lib/media-instances";
import { signPurposeJwt, verifyPurposeJwt } from "@/lib/signing-keys";

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
// Signed with the "qc-flow" subkey, its own typ and audience (guardrail 6h),
// never the raw NEXTAUTH_SECRET. A flow in progress when that changed fails
// once; it lives ten minutes.
const QC_FLOW_JWT = { typ: "summonarr-qc-flow+jwt", audience: "summonarr:qc-flow" };

export interface QcFlowState {
  // SHA-256 of the QuickConnect secret — never store the secret itself in the
  // cookie, since stuffing a high-entropy upstream token into our own JWT
  // expands its blast-radius unnecessarily.
  secretHash: string;
  // Which Jellyfin instance the secret was issued against, pinned at initiate
  // time. The finalize route (sign-in/jellyfin-quickconnect) reads this back
  // out of the VERIFIED cookie rather than trusting a client-supplied
  // instance field — mirrors how plexId/clientId are pinned in
  // plex-flow-state.ts.
  instance: MediaInstanceKey;
}

export function hashQuickConnectSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export async function signQcFlowCookie(state: QcFlowState): Promise<string> {
  return signPurposeJwt("qc-flow", { ...state } as JWTPayload, {
    ...QC_FLOW_JWT,
    ttlSeconds: QC_FLOW_TTL_SECONDS,
  });
}

export async function verifyQcFlowCookie(token: string): Promise<QcFlowState | null> {
  const payload = await verifyPurposeJwt("qc-flow", token, QC_FLOW_JWT);
  if (!payload || typeof payload.secretHash !== "string" || typeof payload.instance !== "string") {
    return null;
  }
  return { secretHash: payload.secretHash, instance: payload.instance };
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

// See the identical note in plex-flow-state.ts: a Path missing BASE_PATH is never
// sent back to `${BASE_PATH}/api/auth/...`, which breaks QuickConnect sign-in
// outright on a subpath deployment. SET and CLEAR must stay identical.
const FLOW_COOKIE_PATH = `${process.env.BASE_PATH ?? ""}/api/auth`;

export function buildQcFlowSetCookie(value: string, secure: boolean): string {
  const attrs = [
    `${QC_FLOW_COOKIE}=${value}`,
    `Path=${FLOW_COOKIE_PATH}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${QC_FLOW_TTL_SECONDS}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function buildQcFlowClearedSetCookie(): string {
  return `${QC_FLOW_COOKIE}=; Path=${FLOW_COOKIE_PATH}; Max-Age=0; HttpOnly; SameSite=Lax`;
}
