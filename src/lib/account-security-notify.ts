import "server-only";

// Owner-facing email for account security events outside two-factor (those are
// src/lib/mfa/notify.ts): a password change, signing out everywhere, and a
// Discord account being linked. Best-effort by contract, like the MFA notice —
// always called with `void`, swallows every error, never blocks or fails the
// change it reports, and is a no-op while notification email is off.
//
// For a password change or a sign-out-everywhere the notice also LISTS what is
// still connected to the account (a Discord link, a Trakt connection). Those
// survive the sign-out on purpose: unlinking them would make the owner reconnect
// everything after every password change. But a session hijacker could have
// linked their OWN Discord or Trakt account while they held the session, and
// after the owner's compromise response that link would quietly keep acting as
// them — so the owner is shown exactly what to check (guardrail 6g).

import { prisma } from "@/lib/prisma";
import { resolveUserNotificationEmail } from "@/lib/notification-email";
import { notifyUserSecurityEventEmail } from "@/lib/email";
import { translatorForUser } from "@/lib/i18n/server-locale";
import type { Translator } from "@/lib/i18n/translate";

export type AccountSecurityEvent =
  | "password-changed"
  | "signed-out-all"
  | "signed-out-others"
  | "discord-linked";

// Pure so the wording rules are testable without a mailer: the event sentence,
// plus — for the compromise-response events only — what is still connected.
export function accountSecurityMessage(
  t: Translator,
  event: AccountSecurityEvent,
  linked: { discordId: string | null; traktUsername: string | null },
): string {
  const sentence = t(`notify.account.event.${event}`);
  if (event === "discord-linked") return sentence;
  const items: string[] = [];
  if (linked.discordId) items.push(t("notify.account.linked.discord", { id: linked.discordId }));
  if (linked.traktUsername) items.push(t("notify.account.linked.trakt", { name: linked.traktUsername }));
  if (items.length === 0) return sentence;
  return `${sentence} ${t("notify.account.stillLinked", { list: items.join(", ") })}`;
}

export async function notifyAccountSecurityEvent(userId: string, event: AccountSecurityEvent): Promise<void> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        notificationEmail: true,
        locale: true,
        discordId: true,
        traktConnection: { select: { username: true } },
      },
    });
    if (!user) return;
    const to = resolveUserNotificationEmail(user);
    if (!to) return;
    const t = translatorForUser(user);
    await notifyUserSecurityEventEmail({
      toEmail: to,
      subject: t("notify.account.subject"),
      heading: t("notify.account.heading"),
      message: accountSecurityMessage(t, event, {
        discordId: user.discordId ?? null,
        traktUsername: user.traktConnection?.username ?? null,
      }),
      locale: user.locale ?? null,
      ctaPath: "/profile",
      advice: "account",
    });
  } catch (err) {
    console.error("[account] security notification failed:", err instanceof Error ? err.message : err);
  }
}
