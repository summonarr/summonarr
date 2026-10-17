import "server-only";

// Owner-facing email for account security events outside two-factor (those are
// src/lib/mfa/notify.ts): a password change, signing out everywhere, a Discord
// account being linked, and password sign-in being paused after too many wrong
// passwords (guardrail 6i). Best-effort by contract, like the MFA notice —
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
import { processSingleton } from "@/lib/process-singleton";
import type { TranslateVars, Translator } from "@/lib/i18n/translate";

export type AccountSecurityEvent =
  | "password-changed"
  | "signed-out-all"
  | "signed-out-others"
  | "discord-linked"
  | "sign-in-locked";

// Pure so the wording rules are testable without a mailer: the event sentence,
// plus — for the compromise-response events only — what is still connected.
export function accountSecurityMessage(
  t: Translator,
  event: AccountSecurityEvent,
  linked: { discordId: string | null; traktUsername: string | null },
  vars?: TranslateVars,
): string {
  const sentence = t(`notify.account.event.${event}`, vars);
  if (event === "discord-linked" || event === "sign-in-locked") return sentence;
  const items: string[] = [];
  if (linked.discordId) items.push(t("notify.account.linked.discord", { id: linked.discordId }));
  if (linked.traktUsername) items.push(t("notify.account.linked.trakt", { name: linked.traktUsername }));
  if (items.length === 0) return sentence;
  return `${sentence} ${t("notify.account.stillLinked", { list: items.join(", ") })}`;
}

export async function notifyAccountSecurityEvent(
  userId: string,
  event: AccountSecurityEvent,
  vars?: TranslateVars,
): Promise<void> {
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
    // A lockout changed nothing on the account and the owner can still sign in
    // once it lifts, so its advice is the password + two-factor one, not "contact
    // your administrator".
    const locked = event === "sign-in-locked";
    await notifyUserSecurityEventEmail({
      toEmail: to,
      subject: t("notify.account.subject"),
      heading: t(locked ? "notify.account.lockedHeading" : "notify.account.heading"),
      message: accountSecurityMessage(
        t,
        event,
        {
          discordId: user.discordId ?? null,
          traktUsername: user.traktConnection?.username ?? null,
        },
        vars,
      ),
      locale: user.locale ?? null,
      ctaPath: "/profile",
      advice: locked ? "mfa" : "account",
    });
  } catch (err) {
    console.error("[account] security notification failed:", err instanceof Error ? err.message : err);
  }
}

// ─── sign-in lockout notice ─────────────────────────────────────────────────
//
// The per-account sign-in bucket (`login-email:` in authorizeWithCredentials) is
// full: someone has spent the account's whole budget of wrong passwords within
// the window, and the owner's own password sign-in is refused until it drains.
// The owner is told — at most ONCE per window per account however many attempts
// keep arriving, so a flood can't turn the notice into a mail bomb. The caller
// learns nothing new: the claim is a synchronous map check and the mail goes out
// detached (`void`), so the failed attempt's response and timing are unchanged.

// Far beyond reach: each entry takes a full bucket of failed password verifies.
export const MAX_LOCKOUT_NOTICES = 10_000;
// Process-wide (guardrail 27a): a per-chunk copy would mail once per chunk.
const lockoutNotices = processSingleton("account-security:lockout-notices", () => new Map<string, number>());

// Claims the one notice for `key` (the account bucket's email hash) in the
// current window. Synchronous on purpose: concurrent attempts can never both
// claim it. Returns false when it was already claimed, or when the ledger is
// full of live claims (the notice is best-effort; the lockout itself still holds).
export function claimSignInLockoutNotice(key: string, windowMs: number, now = Date.now()): boolean {
  const until = lockoutNotices.get(key);
  if (until !== undefined && until > now) return false;
  if (until === undefined && lockoutNotices.size >= MAX_LOCKOUT_NOTICES) {
    for (const [k, expiresAt] of lockoutNotices) if (expiresAt <= now) lockoutNotices.delete(k);
    if (lockoutNotices.size >= MAX_LOCKOUT_NOTICES) return false;
  }
  lockoutNotices.set(key, now + windowMs);
  return true;
}

/** Test seam: forget every claimed notice. */
export function resetSignInLockoutNoticesForTests(): void {
  lockoutNotices.clear();
}

// Mails the owner that password sign-in is paused for up to the window. The
// caller decides who qualifies (a live local-password account) from the row it
// already holds. Never throws (notifyAccountSecurityEvent swallows everything).
export async function notifySignInLockout(userId: string, windowMs: number): Promise<void> {
  await notifyAccountSecurityEvent(userId, "sign-in-locked", {
    minutes: Math.max(1, Math.round(windowMs / 60_000)),
  });
}
