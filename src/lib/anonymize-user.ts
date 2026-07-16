import "server-only";

import { prisma } from "./prisma";

// The encryption extension in ./prisma changes the client's type, so the
// generated Prisma.TransactionClient is NOT assignable to the interactive-tx
// callback param — derive the tx client type from the extended client instead
// (same Omit shape the generated TransactionClient uses).
type TxClient = Omit<
  typeof prisma,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

// Thrown inside the anonymization transaction to roll it back when the target is
// the last active admin (guardrail 23: propagate out of the tx, don't swallow).
export class LastAdminError extends Error {}

// Shared by the self-delete (/api/profile) and admin-delete (/api/admin/users/[id])
// paths — both ANONYMIZE + DISABLE rather than hard-delete: the user's personal
// data is scrubbed (name / email / password / image / Discord / notification
// email + the Plex/Jellyfin provider-subject keys + their OAuth Account rows),
// every session is revoked, and the row is marked `deactivatedAt` so it can never
// sign in again — but their requests / votes / issues stay attached to the now
// de-identified "Deleted user" row so the instance keeps its history. For
// self-delete this is what satisfies App Store Review Guideline 5.1.1(v); a bare
// "disable" that retained personal data would not.
//
// Runs INSIDE the caller's $transaction. Throws LastAdminError (rolling the whole
// anonymization back) when the target is the last active admin.
export async function anonymizeUserInTx(
  tx: TxClient,
  id: string,
  targetRole: string,
  now: Date,
): Promise<void> {
  if (targetRole === "ADMIN") {
    // Never disable the LAST active admin and lock the instance out of
    // administration. Advisory lock 42 + an atomic count of non-deactivated
    // admins guards against concurrent deletes/demotions (mirrors the role-change
    // CAS). A 0-row result throws to roll the whole anonymization back.
    await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(42)");
    const rows = await tx.$executeRaw`
      UPDATE "User" SET "deactivatedAt" = ${now}
      WHERE id = ${id} AND "deactivatedAt" IS NULL
      AND (SELECT COUNT(*) FROM "User" WHERE role = 'ADMIN' AND "deactivatedAt" IS NULL) > 1
    `;
    if (rows === 0) throw new LastAdminError();
  }
  // Remove provider tokens/subject (OAuth) + every device session, then
  // anonymize the row in place (keeps requests/votes/issues linked).
  await tx.account.deleteMany({ where: { userId: id } });
  await tx.authSession.deleteMany({ where: { userId: id } });
  // Orphaned device + Discord-link rows would otherwise outlive the anonymized
  // row and keep delivering pushes (to a possibly handed-down device) or leave
  // dangling unique link/merge rows. Remove them in the same transaction.
  await tx.pushSubscription.deleteMany({ where: { userId: id } });
  await tx.discordLinkToken.deleteMany({ where: { userId: id } });
  await tx.discordMergeCode.deleteMany({ where: { userId: id } });
  // Sever the play-history identity link: MediaServerUser rows FK this user and
  // are NOT cascade-deleted (guardrail 28). Leaving userId set would let a new
  // account with the same email/sub inherit this user's watch history, IPs, and
  // devices. History rows stay (server data), just unattributed.
  await tx.mediaServerUser.updateMany({ where: { userId: id }, data: { userId: null } });
  await tx.user.update({
    where: { id },
    data: {
      name: "Deleted user",
      // RFC-2606 reserved `.invalid` TLD — never routable, and `id` keeps it unique.
      email: `deleted-${id}@deleted.invalid`,
      image: null,
      passwordHash: null,
      discordId: null,
      notificationEmail: null,
      plexClientId: null,
      plexUserId: null,
      jellyfinUserId: null,
      deactivatedAt: now,
      sessionsRevokedAt: now, // pushes every existing JWT's iat below the cutoff
    },
  });
}
