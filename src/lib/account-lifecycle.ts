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

// Thrown inside the deactivation transaction to roll it back when the target is
// the last active admin (guardrail 23: propagate out of the tx, don't swallow).
export class LastAdminError extends Error {}

// Thrown by purgeUserDataInTx when the target is still active. Purging is the
// irreversible half of account removal and is only ever reachable for an account
// that is already disabled — see the note on that function.
export class NotDeactivatedError extends Error {}

// ─── Account removal is TWO steps ──────────────────────────────────────────
//
// 1. DEACTIVATE (this function) — reversible. Shared by the self-delete
//    (/api/profile) and admin-delete (/api/admin/users/[id]) paths. Every
//    session is revoked and sign-in is refused for every provider, but NOTHING
//    is scrubbed: name, email, provider-subject keys, OAuth rows, Discord link,
//    push subscriptions and the MediaServerUser link all survive, so an admin
//    can re-enable the account and the user picks up exactly where they left off.
//    Critically, the MediaServerUser link is left INTACT — severing it orphans
//    the user's Plex/Jellyfin identity and every subsequent watch stops being
//    attributed to them (both getMyWatchHistory and the admin per-user views
//    resolve play history through MediaServerUser.userId).
//
// 2. PURGE (purgeUserDataInTx) — irreversible, admin-only, and only reachable
//    for an already-disabled account. This is the anonymization: PII scrubbed,
//    provider keys + OAuth rows cleared, MediaServerUser link severed, while
//    requests / votes / issues stay attached to the now de-identified row so the
//    instance keeps its history. This is what satisfies a genuine "delete my
//    data" request (App Store Guideline 5.1.1(v), GDPR erasure).
//
// Deactivation alone does NOT scrub, so it is not a data deletion — when a user
// asks for their data to be removed, an admin must follow up with a purge.
//
// Runs INSIDE the caller's $transaction. Throws LastAdminError (rolling the
// whole thing back) when the target is the last active admin. The caller is
// responsible for the already-deactivated short-circuit: re-running this on a
// disabled ADMIN row would see its own row excluded from the active-admin count
// and throw LastAdminError spuriously.
export async function deactivateUserInTx(
  tx: TxClient,
  id: string,
  targetRole: string,
  now: Date,
): Promise<void> {
  if (targetRole === "ADMIN") {
    // Never disable the LAST active admin and lock the instance out of
    // administration. Advisory lock 42 + an atomic count of non-deactivated
    // admins guards against concurrent deletes/demotions (mirrors the role-change
    // CAS). A 0-row result throws to roll the whole thing back.
    await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(42)");
    const rows = await tx.$executeRaw`
      UPDATE "User" SET "deactivatedAt" = ${now}
      WHERE id = ${id} AND "deactivatedAt" IS NULL
      AND (SELECT COUNT(*) FROM "User" WHERE role = 'ADMIN' AND "deactivatedAt" IS NULL) > 1
    `;
    if (rows === 0) throw new LastAdminError();
  }
  // Kill every device session. `sessionsRevokedAt` is the cross-replica backstop
  // that pushes every already-minted JWT's iat below the cutoff; `deactivatedAt`
  // is the absolute block honored by verifyAndRefreshSession and by every
  // sign-in path (signInAndMintSession throws AccountDeactivatedError).
  await tx.authSession.deleteMany({ where: { userId: id } });
  await tx.user.update({
    where: { id },
    data: { deactivatedAt: now, sessionsRevokedAt: now },
  });
}

// Re-enable a disabled account. `sessionsRevokedAt` is deliberately NOT cleared —
// the sessions that existed before deactivation stay dead; the user signs in
// again to get a fresh one. Returns false when the row is missing, already
// active, or purged: a purged row has no identity left to sign in with, so
// re-enabling it would only resurrect a ghost (and re-add it to the
// active-admin count).
export async function reactivateUser(id: string): Promise<boolean> {
  const res = await prisma.user.updateMany({
    where: { id, purgedAt: null, deactivatedAt: { not: null } },
    data: { deactivatedAt: null },
  });
  return res.count === 1;
}

// The irreversible half — see the note on deactivateUserInTx. Scrubs the row's
// personal data in place and severs every identity link, leaving the user's
// requests / votes / issues attached to a de-identified "Deleted user" row.
//
// Runs INSIDE the caller's $transaction. Throws NotDeactivatedError when the
// account is still active: purge is deliberately a two-step operation (disable,
// then purge) so an admin can never destroy a live user's data in one click, and
// that precondition is what makes a last-admin CAS unnecessary here — a disabled
// row is already out of the active-admin count.
export async function purgeUserDataInTx(
  tx: TxClient,
  id: string,
  now: Date,
): Promise<void> {
  const row = await tx.user.findUnique({
    where: { id },
    select: { deactivatedAt: true, purgedAt: true },
  });
  if (!row) throw new NotDeactivatedError();
  if (row.purgedAt) return; // idempotent — already scrubbed
  if (!row.deactivatedAt) throw new NotDeactivatedError();

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
  // devices. History rows stay (server data), just unattributed. This is the one
  // step deactivation deliberately skips — it is what stops future watches from
  // being attributed, so it belongs only to the irreversible path.
  await tx.mediaServerUser.updateMany({ where: { userId: id }, data: { userId: null } });
  // Watchlist / hidden / in-app notification rows are personal data with no value
  // to the instance once the identity is gone (unlike requests and issues, which
  // other users can see and vote on). Drop them rather than leaving them behind
  // on the de-identified row.
  await tx.watchlistItem.deleteMany({ where: { userId: id } });
  await tx.hiddenItem.deleteMany({ where: { userId: id } });
  await tx.notification.deleteMany({ where: { userId: id } });
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
      purgedAt: now,
      sessionsRevokedAt: now, // pushes every existing JWT's iat below the cutoff
    },
  });
}
