import { prisma } from "@/lib/prisma";
import { headers } from "next/headers";
import { logAudit } from "@/lib/audit";
import { notifyAccountSecurityEvent } from "@/lib/account-security-notify";
import { signSessionJwt, type SessionTransport } from "@/lib/session-jwt";
import { defaultPermissionsForRole, serializePermissions } from "@/lib/permissions";
import { hasNativeClientHeader, NATIVE_CLIENT_HEADER } from "@/lib/mobile-auth";
import { NEVER_EXPIRES_AT_SEC } from "@/lib/session-lifetime";
import { lockSetupInTx } from "@/lib/setup-lock";
import { hashAuditEmail, logBestEffortFailure } from "@/lib/auth-provider";
import { getSessionDurations, sessionDeadline } from "@/lib/auth-session-durations";
import type { AuthorizedSignIn } from "@/lib/auth-sign-in-context";

// Session minting. The sign-in route handlers under /api/auth/sign-in/* (and the
// OIDC callback) call signInAndMintSession after the provider-specific
// authorize*/findOrCreate* step returns a user; it creates the AuthSession row
// and signs the session JWT.

export interface SignInResult {
  token: string;
  expiresInSeconds: number;
  sessionId: string;
  // The transport the token is bound to (guardrail 6h). buildSignInResponse
  // delivers it on exactly this one: the body for "bearer", Set-Cookie for
  // "cookie".
  transport: SessionTransport;
  user: {
    id: string;
    role: string;
    email: string | null;
    name: string | null;
    provider: string;
    mediaServer: string | null;
  };
}

export type SignInProviderId = "credentials" | "plex" | "jellyfin" | "jellyfin-quickconnect" | "oidc";

// The session JWT's claims while they are being assembled at sign-in:
// signInAndMintSession fills the identity and mediaServer,
// initializeTokenOnSignIn the deadline and the transport.
type SignInToken = {
  id: string;
  role: string;
  provider: string;
  mediaServer: string | null;
  sessionId?: string;
  uaFingerprint?: string;
  isMobile?: boolean;
  deviceLabel?: string;
};

// The same claims once initializeTokenOnSignIn has filled them.
type MintedSignInToken = SignInToken & { sessionId: string; expiresAt: number; transport: SessionTransport };

// Refusal for a DISABLED account (User.deactivatedAt set). Account removal
// disables rather than scrubs (see account-lifecycle.ts), so the row keeps its
// email, plexUserId/jellyfinUserId and OAuth rows — every provider's lookup still
// MATCHES it. Thrown by signInAndMintSession and surfaced as a 403 by each
// sign-in route.
export class AccountDeactivatedError extends Error {
  constructor() {
    super("This account has been disabled.");
    this.name = "AccountDeactivatedError";
  }
}

// Is this sign-in from a native client? The never-expiring native-app session
// is reserved for one, identified by the X-Summonarr-Client header it presents
// (a custom header a cross-origin web page cannot forge on a credentialed
// request — guardrail 6b). A spoofed mobile User-Agent alone (isMobile is
// UA-derived) must NOT grant it, or any browser could mint a never-expiring
// cookie by lying about its UA.
async function isNativeSignIn(): Promise<boolean> {
  try {
    const h = await headers();
    return hasNativeClientHeader(h.get(NATIVE_CLIENT_HEADER));
  } catch {
    // Invoked outside a request context — treat as non-native.
    return false;
  }
}

// Computes the session's deadline and transport and upserts the backing
// AuthSession row, returning the completed claims. Every input — identity,
// mediaServer, device — is already on `token`.
export async function initializeTokenOnSignIn(token: SignInToken, user: AuthorizedSignIn): Promise<MintedSignInToken> {
  // Normally already set from DeviceMeta._sessionId; this is a fallback for a caller that skipped it.
  const sessionId = token.sessionId || crypto.randomUUID();
  const durations = await getSessionDurations();
  const native = await isNativeSignIn();

  // Native app (iOS Keychain bearer) — no time-based expiry. Every native
  // sign-in qualifies regardless of rememberMe / device class: the header is
  // the signal, the UA only feeds the device label. See session-lifetime.ts.
  // Web "remember me" gets the admin-configurable maxDuration (30d default,
  // capped at 90d).
  const expiresAt = sessionDeadline({
    native,
    rememberMe: user.rememberMe === "true",
    isMobile: token.isMobile === true,
    durations,
    nowSec: Math.floor(Date.now() / 1000),
  });
  // The transport binding (guardrail 6h), decided by the same header as the
  // deadline: the never-expiring native session is presented as a bearer and
  // nothing else, a browser session as the cookie and nothing else. Every
  // reader refuses the token on the other one.
  const transport: SessionTransport = native ? "bearer" : "cookie";

  await prisma.authSession.upsert({
    where: { sessionId },
    update: { lastSeenAt: new Date(), expiresAt: new Date(expiresAt * 1000) },
    create: {
      sessionId,
      userId: user.id,
      deviceType: token.isMobile ? "mobile" : "desktop",
      deviceLabel: token.deviceLabel || null,
      ipAddress: user._auditIp,
      expiresAt: new Date(expiresAt * 1000),
    },
  });

  return { ...token, sessionId, expiresAt, transport };
}

async function runFirstAdminPromotion(
  userId: string,
  providerId: SignInProviderId,
): Promise<boolean> {
  // Bootstrap promotion only fires for the credentials path (matched against
  // /api/auth/register, which is the only sanctioned setup flow). OAuth/OIDC
  // first-sign-in cannot grant ADMIN — defends against an attacker reaching
  // /api/auth/oidc/start (or completing a Plex PIN) before the operator has
  // run setup, where any IdP-vouched user would otherwise inherit ADMIN.
  // Opt-in escape hatch for OAuth-only deployments via env var.
  const allowOauthBootstrap = process.env.SUMMONARR_ALLOW_OAUTH_FIRST_ADMIN === "true";
  if (providerId !== "credentials" && !allowOauthBootstrap) return false;
  // Once setup has completed nothing ever promotes, so every sign-in after it
  // answers here, without the lock both first-admin paths serialize on. Only a
  // "not yet" goes on to decide under the lock.
  if (await prisma.setting.findUnique({ where: { key: "setup_completed_at" } })) return false;
  return prisma.$transaction(async (tx) => {
    // Lock 43 (setup-lock.ts) is the SAME advisory lock /api/auth/register holds
    // for its count→create-ADMIN→setup_completed_at sequence. Sharing it
    // serializes the two first-admin paths so a concurrent register + OAuth
    // bootstrap can't both observe "no admin yet" and each mint an ADMIN.
    await lockSetupInTx(tx);
    const setupRow = await tx.setting.findUnique({ where: { key: "setup_completed_at" } });
    if (setupRow) return false;
    const existingAdmin = await tx.user.findFirst({ where: { role: "ADMIN" }, select: { id: true } });
    if (existingAdmin) return false;
    const self = await tx.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!self) return false;
    await tx.user.update({ where: { id: userId }, data: { role: "ADMIN", permissions: defaultPermissionsForRole("ADMIN") } });
    // upsert, not create().catch(): if some other writer created this key first,
    // a caught P2002 (unique-violation) error would still abort the transaction
    // and silently roll back the ADMIN promotion above (guardrail 23). upsert is
    // idempotent and never trips the unique constraint.
    await tx.setting.upsert({
      where: { key: "setup_completed_at" },
      update: {},
      create: { key: "setup_completed_at", value: new Date().toISOString() },
    });
    return true;
  });
}

// mediaServer is provider-determined for plex/jellyfin*; credentials and OIDC
// sign-ins carry the user's stored column instead.
function providerMediaServer(providerId: SignInProviderId): "plex" | "jellyfin" | null {
  if (providerId === "plex") return "plex";
  if (providerId === "jellyfin" || providerId === "jellyfin-quickconnect") return "jellyfin";
  return null;
}

// Everything the mint reads off the user row, in one query: the deactivation
// refusal, the permissions claim and the stored mediaServer.
function readMintAccountState(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: { deactivatedAt: true, permissions: true, mediaServer: true },
  });
}

// The role and the permissions claim (the stored bitmask, raw decimal) the token
// carries. A just-promoted first admin carries the ADMIN preset the promotion
// wrote. If the row is somehow gone the claim is "0", and effectivePermissions()
// on the read side falls back to the role preset.
async function sessionRoleClaims(
  user: AuthorizedSignIn,
  providerId: SignInProviderId,
  storedPermissions: bigint | null,
): Promise<{ role: string; permissions: string }> {
  if (await runFirstAdminPromotion(user.id, providerId)) {
    return { role: "ADMIN", permissions: serializePermissions(defaultPermissionsForRole("ADMIN")) };
  }
  return { role: user.role, permissions: storedPermissions === null ? "0" : serializePermissions(storedPermissions) };
}

async function signMintedToken(
  minted: MintedSignInToken,
  user: AuthorizedSignIn,
  permissions: string,
  expiresInSeconds: number,
): Promise<string> {
  try {
    return await signSessionJwt(
      {
        id: minted.id,
        role: minted.role,
        permissions,
        email: user.email ?? null,
        name: user.name ?? null,
        provider: minted.provider,
        mediaServer: minted.mediaServer,
        sessionId: minted.sessionId,
        uaFingerprint: minted.uaFingerprint,
        isMobile: minted.isMobile,
        deviceLabel: minted.deviceLabel,
        expiresAt: minted.expiresAt,
        transport: minted.transport,
      },
      { expiresInSeconds },
    );
  } catch (err) {
    // No token, so no session: drop the row just written (best-effort — the
    // signing failure is what the caller must hear about).
    await prisma.authSession
      .delete({ where: { sessionId: minted.sessionId } })
      .catch(logBestEffortFailure("auth", "orphan session row removal"));
    throw err;
  }
}

function auditSignIn(
  minted: MintedSignInToken,
  user: AuthorizedSignIn,
  providerId: SignInProviderId,
  secondFactor: "totp" | "recovery" | "webauthn" | undefined,
): void {
  void logAudit({
    userId: user.id,
    userName: user.name ?? user.email,
    action: "AUTH_LOGIN",
    target: "auth:login",
    ipAddress: user._auditIp,
    userAgent: user._auditUa,
    provider: providerId,
    details: {
      provider: providerId,
      // Store a hash, not the raw address — matches the AUTH_LOGIN_FAILED paths
      // and minimizes cleartext PII held in the audit log (it would otherwise
      // persist until the 90-day scrub).
      emailHash: hashAuditEmail(user.email),
      role: minted.role,
      ...(secondFactor ? { secondFactor } : {}),
      ip: user._auditIp,
      browser: user._auditUa.slice(0, 100),
    },
  });
}

export async function signInAndMintSession(params: {
  user: AuthorizedSignIn;
  providerId: SignInProviderId;
  // Set ONLY by POST /api/auth/sign-in/mfa, after the second factor verified —
  // recorded in the AUTH_LOGIN audit row. The credentials route never mints for
  // an account with 2FA (guardrail 6d), so this is the only way such a session
  // comes into existence.
  secondFactor?: "totp" | "recovery" | "webauthn";
}): Promise<SignInResult> {
  const { user, providerId, secondFactor } = params;

  // Single chokepoint for every provider (credentials / plex / jellyfin /
  // jellyfin-quickconnect / oidc): refuse a disabled account BEFORE
  // initializeTokenOnSignIn mints a JWT and writes an AuthSession row
  // (guardrail 33). verifyAndRefreshSession would reject the resulting token on
  // the very next request anyway, but only after handing the client a session
  // it can't use and leaving a live AuthSession row behind. The check runs
  // post-authorization, so "disabled" is only ever disclosed to someone who
  // already proved the credential — it leaks nothing to a stranger probing
  // addresses.
  const account = await readMintAccountState(user.id);
  if (account?.deactivatedAt) throw new AccountDeactivatedError();

  // Everything that can fail runs BEFORE initializeTokenOnSignIn writes the
  // AuthSession row: a promotion that threw afterwards left a row with no token
  // behind it, listed as a device — and, for a native client, one that never
  // expires.
  const claims = await sessionRoleClaims(user, providerId, account?.permissions ?? null);

  const minted = await initializeTokenOnSignIn(
    {
      id: user.id,
      role: claims.role,
      provider: providerId,
      mediaServer: providerMediaServer(providerId) ?? account?.mediaServer ?? null,
      sessionId: user._sessionId,
      uaFingerprint: user._uaFingerprint || undefined,
      isMobile: user._isMobile,
      deviceLabel: user._deviceLabel || undefined,
    },
    user,
  );

  const expiresInSeconds = Math.max(60, minted.expiresAt - Math.floor(Date.now() / 1000));
  const jwt = await signMintedToken(minted, user, claims.permissions, expiresInSeconds);
  auditSignIn(minted, user, providerId, secondFactor);

  // A NATIVE session was just minted (the X-Summonarr-Client caller, whose
  // deadline is the never-reached sentinel — guardrail 6c). Nothing time-based
  // will ever end it, so a stolen password or media-server credential used from
  // a native client would hold the account until someone notices: email the
  // owner on every one, with the device, so they can sign it out. Best-effort
  // and never awaited — it can't fail or slow the sign-in, and it runs only
  // after initializeTokenOnSignIn has written the AuthSession row it reports.
  if (minted.expiresAt === NEVER_EXPIRES_AT_SEC) {
    void notifyAccountSecurityEvent(user.id, "app-signed-in", {
      device: minted.deviceLabel ?? null,
    });
  }

  return {
    token: jwt,
    expiresInSeconds,
    sessionId: minted.sessionId,
    transport: minted.transport,
    user: {
      id: minted.id,
      role: minted.role,
      email: user.email ?? null,
      name: user.name ?? null,
      provider: providerId,
      mediaServer: minted.mediaServer,
    },
  };
}
