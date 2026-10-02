import "server-only";

// Owner-facing email for two-factor security events: every enrollment change
// and every lockout. Best-effort by contract — it is always called with `void`,
// it swallows every error, and it never blocks or fails the change it reports.
// It reuses the ordinary notification-email path (resolveUserNotificationEmail +
// the global "send notification emails" switch); with email off it is a no-op.

import { prisma } from "@/lib/prisma";
import { resolveUserNotificationEmail } from "@/lib/notification-email";
import { notifyUserSecurityEventEmail } from "@/lib/email";
import { translatorForUser } from "@/lib/i18n/server-locale";

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

// Text lives in the notify.mfa.* catalog keys, written in the account owner's
// language (their stored User.locale, else the instance default).
export async function notifyMfaSecurityEvent(userId: string, event: MfaSecurityEvent): Promise<void> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, notificationEmail: true, locale: true },
    });
    if (!user) return;
    const to = resolveUserNotificationEmail(user);
    if (!to) return;
    const t = translatorForUser(user);
    await notifyUserSecurityEventEmail({
      toEmail: to,
      subject: event === "lockout" ? t("notify.mfa.subject.locked") : t("notify.mfa.subject.changed"),
      heading: event === "lockout" ? t("notify.mfa.heading.locked") : t("notify.mfa.heading.changed"),
      message: t(`notify.mfa.event.${event}`),
      locale: user.locale ?? null,
    });
  } catch (err) {
    console.error("[mfa] security notification failed:", err instanceof Error ? err.message : err);
  }
}
