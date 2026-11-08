import { prisma } from "@/lib/prisma";
import { dummyVerify, hashPassword, needsRehash, verifyPassword, MAX_PASSWORD_LENGTH } from "@/lib/password-hash";
import { checkRateLimit, peekRateLimit, reserveRateLimit, refundHit, ipBucketKey } from "@/lib/rate-limit";
import { claimSignInLockoutNotice, notifySignInLockout } from "@/lib/account-security-notify";
import { normalizeEmail } from "@/lib/email-normalize";
import { passwordVersion } from "@/lib/mfa/mfa-store";
import { hashAuditEmail } from "@/lib/auth-provider";
import {
  auditLoginFailure,
  authorizedSignIn,
  signInRequestContext,
  type CredentialsAuthorizedUser,
  type SignInRequestContext,
} from "@/lib/auth-sign-in-context";

// The local email + password sign-in step (guardrails 6d, 6e, 6i). A correct
// password returns the user with its password fingerprint; the route decides
// between a session and a two-factor challenge.
//
// Wherever User.passwordHash is updated (e.g. src/app/api/profile/password/route.ts
// and admin password-set endpoints), the same code path must also call
// revokeAllUserSessions(userId) so the AuthSession rows are deleted and stale
// JWTs cannot refresh on any replica. The one write in this file is the sign-in
// rehash (rehashPassword), which stores the SAME password at a higher cost and so
// deliberately revokes nothing.

// The route has checked both are strings; anything else (or an empty value)
// refuses here too, before any read.
export type CredentialsSignInInput = { email?: string; password?: string; rememberMe?: string };

// Per-account bucket: failed password verifications against one account, from
// anywhere. Generous so ordinary mistyping doesn't lock a user out.
const ACCOUNT_LIMIT = 50;
const ACCOUNT_WINDOW_MS = 15 * 60 * 1000;
// Per-IP bucket: every attempt from one source.
const IP_LIMIT = 20;
const IP_WINDOW_MS = 5 * 60 * 1000;

// Two independent throttles:
//   • Per-IP — bounds rapid attempts from one source, counting EVERY attempt
//     (consumed here, before the password check).
//   • Per-account — ALWAYS enforced so a password-spray distributed across
//     many IPs against one account is still bounded (the per-IP bucket can't
//     see that). Only an ACTUAL FAILED PASSWORD VERIFICATION keeps its hit — an
//     attacker who merely knows the victim's email can't burn the account's
//     lockout without supplying wrong passwords. In-memory and per-replica like
//     the rest of the limiter; protected from eviction (guardrail 6e).
//
// NOTE: there is deliberately no special case for an indeterminate client IP.
// getClientIp never returns the bare string "unknown" — when the address can't be
// trusted it returns `unknown:<uaHash>`, a per-User-Agent bucket (see
// untrustedBucket in rate-limit.ts). The old `ip === "unknown"` test was therefore
// dead: it was meant to widen the limit to 100 for a single shared bucket, but the
// bucket is already per-UA, so the standard limit applies per bucket and no group
// of users shares one counter. Don't reintroduce a widened limit here — that would
// loosen the throttle without the shared-bucket problem it was written for.
//
// The account hit is RESERVED atomically rather than peeked. A peek is
// synchronous but the verify is awaited, so concurrent attempts all passed a peek
// before any of them recorded — an attacker firing N requests at once got N
// password verifications regardless of the limit. The hit is refunded on a
// successful login, so the bucket still counts only failed verifications.
// Short-circuited on an IP rejection: that attempt never reaches the verify, so
// reserving (and never refunding) an account slot for it would charge the
// account bucket for an attempt it never judged.
//
// Returns the reserved account hit (refunded on success), or null when either
// bucket refused — audited as rate_limited.
function reserveCredentialAttempt(ctx: SignInRequestContext, accountKey: string, emailHash: string): number | null {
  const ipAllowed = checkRateLimit(`login-ip:${ipBucketKey(ctx.ip)}`, IP_LIMIT, IP_WINDOW_MS);
  const accountHitAt = ipAllowed ? reserveRateLimit(accountKey, ACCOUNT_LIMIT, ACCOUNT_WINDOW_MS) : null;
  if (accountHitAt === null) {
    auditLoginFailure(ctx, "credentials", "rate_limited", { emailHash });
    return null;
  }
  return accountHitAt;
}

type CredentialsUser = NonNullable<Awaited<ReturnType<typeof findCredentialsUser>>>;

function findCredentialsUser(email: string) {
  return prisma.user.findUnique({ where: { email } });
}

// The exact hash the password was checked against, or null when it didn't
// verify (an unknown account runs a dummy verify of the same cost). The
// two-factor challenge fingerprints THIS hash (guardrail 6d), never a later
// re-read that a password change landing in between could have replaced.
async function verifiedPasswordHash(user: CredentialsUser | null, password: string): Promise<string | null> {
  if (!user?.passwordHash) {
    await dummyVerify();
    return null;
  }
  return (await verifyPassword(password, user.passwordHash)) ? user.passwordHash : null;
}

// This failure spent the last of the account's budget of wrong passwords, so
// the owner's own password sign-in is refused from now on too: tell them, ONCE
// per window however many attempts follow (guardrail 6i). Noticed here, where
// the row is already loaded, so a refused attempt still never reads the DB; the
// claim is synchronous and the mail detached, so the caller's response and
// timing don't change. Only a live local-password account has one to guess.
function noticeAccountLockout(user: CredentialsUser | null, accountKey: string, emailHash: string): void {
  if (
    user?.passwordHash &&
    !user.deactivatedAt &&
    !peekRateLimit(accountKey, ACCOUNT_LIMIT, ACCOUNT_WINDOW_MS) &&
    claimSignInLockoutNotice(emailHash, ACCOUNT_WINDOW_MS)
  ) {
    void notifySignInLockout(user.id, ACCOUNT_WINDOW_MS);
  }
}

// Replaces a hash written with older parameters by one at the current cost
// (guardrail 6i). The password itself is unchanged, so — unlike a password change —
// nothing is revoked and passwordChangedAt is left alone. Conditional on the stored
// hash still being the one just verified, so a password change landing in between
// is never overwritten with the old password. Best-effort: on failure the old hash
// stays (it still verifies) and the sign-in carries on.
// Returns the hash the row holds afterwards as far as this call knows: the new
// one when the compare-and-swap landed, else the verified one (a concurrent
// password change won, or the write failed). The two-factor challenge
// fingerprints THIS value, so it must match what the MFA step will re-read.
async function rehashPassword(userId: string, verifiedHash: string, password: string): Promise<string> {
  try {
    const passwordHash = await hashPassword(password);
    const { count } = await prisma.user.updateMany({ where: { id: userId, passwordHash: verifiedHash }, data: { passwordHash } });
    return count === 1 ? passwordHash : verifiedHash;
  } catch (err) {
    console.error("[auth] password rehash failed:", err instanceof Error ? err.message : err);
    return verifiedHash;
  }
}

export async function authorizeWithCredentials(
  credentials: CredentialsSignInInput,
  req: Request,
): Promise<CredentialsAuthorizedUser | null> {
  const { email: rawEmail, password } = credentials;
  if (typeof rawEmail !== "string" || typeof password !== "string" || !rawEmail || !password) return null;
  if (password.length > MAX_PASSWORD_LENGTH) return null;

  const disableRow = await prisma.setting.findUnique({ where: { key: "disableLocalLogin" } });
  if (disableRow?.value === "true") return null;

  const ctx = signInRequestContext(req);
  const email = normalizeEmail(rawEmail);
  const emailHash = hashAuditEmail(email);
  const accountKey = `login-email:${emailHash}`;
  const accountHitAt = reserveCredentialAttempt(ctx, accountKey, emailHash);
  if (accountHitAt === null) return null;

  const user = await findCredentialsUser(email);
  const verifiedHash = await verifiedPasswordHash(user, password);
  if (!user || !verifiedHash) {
    // The hit reserved at the gate stays: a genuine wrong password, or an
    // unknown account (which also ran the dummy verify).
    auditLoginFailure(ctx, "credentials", "invalid_credentials", { emailHash });
    noticeAccountLockout(user, accountKey, emailHash);
    return null;
  }

  // Successful sign-in: give back THIS attempt's reserved slot, so the account
  // bucket still counts only failures.
  refundHit(accountKey, accountHitAt);

  // The plaintext is in hand and proven, so upgrade a hash written with older
  // parameters (guardrail 6i). AWAITED on purpose: the two-factor challenge minted
  // next fingerprints the stored hash (passwordVersion), so a rehash landing after
  // it would kill the challenge and fail the owner's sign-in once.
  //
  // The challenge's fingerprint must follow the hash the row holds NOW: the MFA
  // step re-reads the stored hash and compares fingerprints, so fingerprinting
  // the pre-rehash hash expired every legacy-hash owner's first 2FA sign-in.
  const currentHash = needsRehash(verifiedHash) ? await rehashPassword(user.id, verifiedHash, password) : verifiedHash;

  return {
    ...authorizedSignIn({ id: user.id, email: user.email, name: user.name, role: user.role }, ctx, credentials.rememberMe),
    // A keyed fingerprint, never the hash itself (it rides along to the mint).
    _passwordVersion: passwordVersion(currentHash),
  };
}
