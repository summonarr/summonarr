import "server-only";

// Owner-facing email for two-factor security events: every enrollment change
// and every lockout. Best-effort by contract — it is always called with `void`,
// it swallows every error, and it never blocks or fails the change it reports.
// It reuses the ordinary notification-email path (resolveUserNotificationEmail +
// the global "send notification emails" switch); with email off it is a no-op.

import { prisma } from "@/lib/prisma";
import { resolveUserNotificationEmail } from "@/lib/notification-email";
import { notifyUserSecurityEventEmail } from "@/lib/email";

export type MfaSecurityEvent =
  | "totp-enabled"
  | "totp-removed"
  | "passkey-added"
  | "passkey-renamed"
  | "passkey-removed"
  | "recovery-regenerated"
  | "mfa-disabled"
  | "mfa-reset"
  | "lockout";

const MESSAGES: Record<MfaSecurityEvent, string> = {
  "totp-enabled": "An authenticator app was turned on for your Summonarr account.",
  "totp-removed": "The authenticator app was removed from your Summonarr account.",
  "passkey-added": "A passkey was added to your Summonarr account.",
  "passkey-renamed": "A passkey on your Summonarr account was renamed.",
  "passkey-removed": "A passkey was removed from your Summonarr account.",
  "recovery-regenerated": "New recovery codes were generated for your Summonarr account. The old ones no longer work.",
  "mfa-disabled": "Two-factor authentication was turned off for your Summonarr account.",
  "mfa-reset": "An administrator reset two-factor authentication on your Summonarr account.",
  lockout:
    "Too many incorrect verification codes were entered for your Summonarr account, so code sign-in is temporarily locked. Someone may know your password.",
};

export async function notifyMfaSecurityEvent(userId: string, event: MfaSecurityEvent): Promise<void> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, notificationEmail: true },
    });
    if (!user) return;
    const to = resolveUserNotificationEmail(user);
    if (!to) return;
    await notifyUserSecurityEventEmail({
      toEmail: to,
      subject: event === "lockout" ? "Summonarr — two-factor sign-in locked" : "Summonarr — two-factor settings changed",
      heading: event === "lockout" ? "Two-factor sign-in locked" : "Two-factor settings changed",
      message: MESSAGES[event],
    });
  } catch (err) {
    console.error("[mfa] security notification failed:", err instanceof Error ? err.message : err);
  }
}
