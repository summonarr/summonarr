import { createHash } from "crypto";
import { auditContext, logAudit } from "@/lib/audit";
import { dummyVerify } from "@/lib/password-hash";
import { extractUaFingerprint, serializeFingerprint, fingerprintToLabel } from "@/lib/ua-fingerprint";
import type { AuthorizedDbUser } from "@/lib/auth-provider";

// The per-request half of every sign-in: the device payload a session is
// minted with, the context a refusal is audited with, and the one refusal
// shape. Shared by the credentials, Plex and Jellyfin steps and the mint.

export interface DeviceMeta {
  _sessionId: string;
  _uaFingerprint: string;
  _isMobile: boolean;
  _deviceLabel: string;
  _auditIp: string;
  _auditUa: string;
}

// Derives the per-device session metadata (fresh sessionId, UA fingerprint,
// mobile flag, device label, audit IP/UA) from the request headers at sign-in.
// The audit IP and the capped UA come from auditContext, so a sign-in row and
// every other audit row derive them the same way.
export function buildDeviceMeta(headers: Headers): DeviceMeta {
  const fp = extractUaFingerprint(headers.get("user-agent") ?? "");
  const { ipAddress, userAgent } = auditContext({ headers });
  return {
    _sessionId:     crypto.randomUUID(),
    _uaFingerprint: serializeFingerprint(fp),
    _isMobile:      fp.device !== "desktop",
    _deviceLabel:   fingerprintToLabel(fp),
    _auditIp:       ipAddress,
    _auditUa:       userAgent ?? "",
  };
}

// What every authorize* step hands to signInAndMintSession: the resolved user,
// this request's device payload (buildDeviceMeta) and the sign-in's options.
// The MFA and OIDC routes build the same shape from their own user row.
export type AuthorizedSignIn = AuthorizedDbUser & DeviceMeta & {
  // "true" picks the configured remember-me duration (web only — guardrail 6c).
  rememberMe?: string;
  // Keyed fingerprint of the password hash the credentials step verified; the
  // 2FA challenge binds to it (guardrail 6d). Never the hash itself.
  _passwordVersion?: string;
};

// The credentials step always carries the fingerprint: mfaChallengeFor needs it.
export type CredentialsAuthorizedUser = AuthorizedSignIn & { _passwordVersion: string };

// What every sign-in attempt is audited with: the request headers, the client
// address (getClientIp — the UA bucket when it can't be trusted) and the
// capped User-Agent.
export type SignInRequestContext = { headers: Headers; ip: string; ua: string | null };

export function signInRequestContext(req: Request): SignInRequestContext {
  const { ipAddress, userAgent } = auditContext(req);
  return { headers: req.headers, ip: ipAddress, ua: userAgent };
}

export type SignInProvider = "credentials" | "plex" | "jellyfin" | "jellyfin-quickconnect";

// The limiter-key form of a sign-in secret (a Plex token, a QuickConnect
// secret): a truncated SHA-256, so no raw secret material — not even a prefix,
// which was most of a live Plex token — lands in a limiter key.
export function secretLimiterKey(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 16);
}

// The one AUTH_LOGIN_FAILED row shape for every refused sign-in:
// anonymous actor, `details.reason` plus any extra detail (an emailHash).
export function auditLoginFailure(
  ctx: SignInRequestContext,
  provider: SignInProvider,
  reason: string,
  extra?: Record<string, unknown>,
): void {
  void logAudit({
    userId: "anonymous",
    userName: "anonymous",
    action: "AUTH_LOGIN_FAILED",
    target: "auth:login",
    ipAddress: ctx.ip,
    userAgent: ctx.ua,
    provider,
    details: { reason, ...extra },
  });
}

// A refusal past the rate-limit gates: padded with a dummy password check so it
// takes about as long as a real attempt (response timing then leaks nothing),
// then audited. The client sees the same 401 whatever the reason.
export async function refuseSignIn(
  ctx: SignInRequestContext,
  provider: SignInProvider,
  reason: string,
  extra?: Record<string, unknown>,
): Promise<null> {
  await dummyVerify();
  auditLoginFailure(ctx, provider, reason, extra);
  return null;
}

// The user a provider step authorized, with this request's device payload.
export function authorizedSignIn(
  user: AuthorizedDbUser,
  ctx: SignInRequestContext,
  rememberMe: string | undefined,
): AuthorizedSignIn {
  return { ...user, rememberMe, ...buildDeviceMeta(ctx.headers) };
}
