// Session-lifetime constants shared by the server (auth.ts mints the deadline,
// session-refresh.ts enforces it) and client components (the device list
// renders it). Zero imports so "use client" files can import it directly —
// the media-instances.ts pattern.
//
// Every session lives until the deadline captured at sign-in (the `expiresAt`
// claim, mirrored into AuthSession.expiresAt): the admin-configured desktop /
// mobile / remember-me duration for browsers. There is no inactivity window and
// no role-based ceiling on top of it — see guardrail 6c.
//
// Native-app (bearer) sessions have NO time-based expiry at all. That is
// represented as a deadline far enough out to never be reached, NOT as an
// absent claim, because every consumer of the deadline expects a number/date:
// the JWT `exp` (jose enforces it on every verify), the `expiresAt` claim, the
// non-null AuthSession.expiresAt column the purge cron sweeps with `< now`, and
// the /api/sessions wire contract — the iOS app decodes each device's
// `expiresAt` as a NON-OPTIONAL string, so a null there would break the
// Sessions screen of every shipped build. Revocation (sign-out, per-device
// revoke, revoke-all, a password change, account deactivation) is the only way
// such a session ends; the DB-checked verify honours all of those on the next
// request regardless of this deadline.
export const NEVER_EXPIRES_AT_MS = Date.UTC(9999, 0, 1);
export const NEVER_EXPIRES_AT_SEC = Math.floor(NEVER_EXPIRES_AT_MS / 1000);

// True when a deadline is the "never" sentinel (or, defensively, anything past
// it). Accepts the three shapes the deadline travels in: epoch seconds (JWT
// claim), a Date (Prisma row) or an ISO string (a Date crossing the RSC /
// JSON boundary).
export function isIndefiniteDeadline(deadline: number | Date | string): boolean {
  const ms =
    typeof deadline === "number"
      ? deadline * 1000
      : typeof deadline === "string"
        ? Date.parse(deadline)
        : deadline.getTime();
  return Number.isFinite(ms) && ms >= NEVER_EXPIRES_AT_MS;
}
