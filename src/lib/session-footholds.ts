import type { prisma } from "@/lib/prisma";
import { verifyIdentifierPrefixFor } from "@/lib/notification-email-verify";

// State that a session holder can PLANT and that outlives the session itself
// (guardrail 6g). A password change or "sign out everywhere" is the owner's
// compromise response: it ends every session, and these must go with them, or a
// hijacker keeps a channel into the account afterwards:
//
//   - PushSubscription rows: a hijacker's own browser or device keeps receiving
//     the owner's notifications. The owner's own devices re-register on their
//     own (the iOS app after it signs back in; the web bell on its next page
//     load — push-notifications.tsx), so deleting every row costs nothing.
//   - DiscordLinkToken / DiscordMergeCode: a pending link the hijacker started
//     could still be redeemed from THEIR Discord account after the sign-out.
//   - A pending notification-email verification (VerificationToken
//     "notif-email:<userId>:…"): the confirm link is public and needs no
//     session, so a hijacker who asked for one at THEIR address could still
//     confirm it after the sign-out and receive the owner's notification and
//     security mail from then on. An address already CONFIRMED stays bound, like
//     a redeemed Discord link.
//
// A link that was already REDEEMED (User.discordId) and a Trakt connection are
// deliberately left in place — unlinking them would make the owner reconnect
// everything after every password change. Instead the security email lists them
// (account-security-notify.ts) so the owner can spot one that isn't theirs.
//
// Typed off the EXTENDED client (the encryption extension in prisma.ts changes
// it, so the generated Prisma.TransactionClient doesn't fit — account-lifecycle.ts
// does the same).
type FootholdClient = Pick<
  typeof prisma,
  "pushSubscription" | "discordLinkToken" | "discordMergeCode" | "verificationToken"
>;

// The identifier carries the user id, so the prefix matches only THIS user's
// pending verifications (account-lifecycle.ts's purge uses the same match).
function pendingNotificationEmailWhere(userId: string) {
  return { identifier: { startsWith: verifyIdentifierPrefixFor(userId) } };
}

export function footholdDeletes(db: FootholdClient, userId: string) {
  return [
    db.pushSubscription.deleteMany({ where: { userId } }),
    db.discordLinkToken.deleteMany({ where: { userId } }),
    db.discordMergeCode.deleteMany({ where: { userId } }),
    db.verificationToken.deleteMany({ where: pendingNotificationEmailWhere(userId) }),
  ] as const;
}

// Interactive-transaction form: one statement at a time on the tx connection.
export async function clearSessionFootholdsInTx(tx: FootholdClient, userId: string): Promise<void> {
  await tx.pushSubscription.deleteMany({ where: { userId } });
  await tx.discordLinkToken.deleteMany({ where: { userId } });
  await tx.discordMergeCode.deleteMany({ where: { userId } });
  await tx.verificationToken.deleteMany({ where: pendingNotificationEmailWhere(userId) });
}
