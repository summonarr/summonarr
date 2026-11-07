import { prisma } from "@/lib/prisma";
import { Prisma, type RequestStatus } from "@/generated/prisma";
import { revokeDiscordRolesOnUnlink } from "@/lib/discord-notify";
import { DISCORD_SYNTHETIC_EMAIL_SUFFIX } from "@/lib/user-source";
import { logAudit } from "@/lib/audit";
import { notifyAccountSecurityEvent } from "@/lib/account-security-notify";

export interface MergeResult {
  migrated: number;
}

// The tables a code claim may touch. Typed off the extended client, like
// session-footholds.ts: the encryption extension in prisma.ts changes it, so the
// generated Prisma.TransactionClient doesn't fit.
export type CodeClaimClient = Pick<typeof prisma, "discordLinkToken" | "discordMergeCode">;

export interface MergeOptions {
  // Consumes the one-time code that authorized this link (the /link token or the
  // confirm-merge code) INSIDE the merge transaction. Return true when this
  // caller's conditional delete removed it, false when nothing was left to take.
  //
  // Inside, not before or after: two redemptions of one code used to both pass
  // the route's read and both link (an unbound /link token from two Discord
  // accounts linked the account twice, the second overwriting the first), and
  // consuming it before the merge burned the code on a transient failure. A
  // delete in the same transaction is single-use under concurrency — the loser
  // waits on the row lock and then deletes nothing — and a failed merge rolls
  // the delete back, so the user can retry. Required: every link spends a code.
  claimCode: (tx: CodeClaimClient) => Promise<boolean>;
}

// Thrown inside the merge transaction when the claim finds nothing to consume:
// a concurrent redemption of the same code won, or it was replaced or expired
// in between. The throw rolls the transaction back (guardrail 23), so nothing is
// linked.
export class DiscordCodeAlreadyUsedError extends Error {
  constructor() {
    super("This link code was already used.");
    this.name = "DiscordCodeAlreadyUsedError";
  }
}

// Thrown inside the merge transaction, before any write, when the Discord id
// already belongs to another REAL account (not a @discord.local shadow). The
// expected refusal, told apart from an infrastructure failure so callers can
// say so; the throw rolls the claim back with the rest (guardrail 23).
export class DiscordAlreadyLinkedError extends Error {
  constructor() {
    super("This Discord account is already linked to another user.");
    this.name = "DiscordAlreadyLinkedError";
  }
}

// An admin already said yes to it: APPROVED, or AVAILABLE and not a cleanup
// removal (guardrail 14b — a stamped row records a deliberate delete).
function isGreenlit(r: { status: RequestStatus; cleanedUpAt: Date | null }): boolean {
  return r.status === "APPROVED" || (r.status === "AVAILABLE" && r.cleanedUpAt === null);
}

// Links a Discord account to a web user, migrating a bot-created shadow account's
// requests/issues/votes onto the web user (deduping conflicts) before deleting it.
export async function mergeDiscordIntoWebAccount(
  webUserId: string,
  discordUserId: string,
  opts: MergeOptions,
): Promise<MergeResult> {

  const { migrated, previousDiscordId } = await prisma.$transaction(async (tx) => {
    // Per-Discord-user advisory lock (a Postgres lock held until the transaction ends)
    // so two fast clicks of the link button can't run the merge twice at once.
    // The key is built from the first 7 characters of the id, so unrelated users
    // can occasionally share a key — that only makes one wait, never breaks anything.
    const lockId = BigInt("0x" + Buffer.from(discordUserId).subarray(0, 7).toString("hex"));
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock($1::bigint)`, lockId);

    // The lock above is per DISCORD id, so two Discord accounts redeeming one
    // unbound code don't share it; the claim's row lock is what serializes them.
    if (!(await opts.claimCode(tx))) throw new DiscordCodeAlreadyUsedError();

    const existing = await tx.user.findUnique({ where: { discordId: discordUserId } });

    // A non-synthetic email means the Discord account is a real web user, not a
    // bot-created shadow — refuse the merge before any read of the web row or write.
    if (existing && existing.id !== webUserId && !existing.email.endsWith(DISCORD_SYNTHETIC_EMAIL_SUFFIX)) {
      throw new DiscordAlreadyLinkedError();
    }

    // The web user's CURRENT link, read inside the tx: a re-link (generate-link
    // and initiate-merge don't refuse an already-linked caller) overwrites it
    // below, and the superseded Discord member would otherwise keep every role
    // Summonarr granted it — nothing else ever revisits a replaced id (sync-roles
    // iterates current links only). Revoked after commit, guardrail 27.
    //
    // FOR UPDATE: the advisory lock above is per DISCORD id, and a user can hold
    // a /link token and a merge code at once, so two links of DIFFERENT Discord
    // accounts to this user could both read "not linked" and the loser's roles
    // would never be revoked. The row lock makes the second wait, then read the
    // first one's discordId as the link it supersedes.
    const webRows = await tx.$queryRaw<Array<{ discordId: string | null }>>(
      Prisma.sql`SELECT "discordId" FROM "User" WHERE "id" = ${webUserId} FOR UPDATE`,
    );
    const previousDiscordId = webRows[0]?.discordId ?? null;

    if (existing && existing.id !== webUserId) {

      const webRequests = await tx.mediaRequest.findMany({
        where: { requestedBy: webUserId },
        select: { id: true, tmdbId: true, mediaType: true, arrInstance: true, status: true, cleanedUpAt: true },
      });
      // Key on arrInstance too — the MediaRequest unique is (tmdbId, mediaType, requestedBy,
      // arrInstance), so requests for the same title on different instances (default vs
      // 4K/named) are DISTINCT rows. Keying only on tmdbId:mediaType treated them as
      // duplicates and deleted the non-default variant.
      const webByKey = new Map(webRequests.map((r) => [`${r.tmdbId}:${r.mediaType}:${r.arrInstance}`, r]));

      const discordRequests = await tx.mediaRequest.findMany({
        where: { requestedBy: existing.id },
        select: { id: true, tmdbId: true, mediaType: true, arrInstance: true, status: true, cleanedUpAt: true },
      });

      // One of each colliding pair goes. The web copy wins, unless only the
      // shadow copy was greenlit: an APPROVED/AVAILABLE Discord request must not
      // be thrown away for the same user's PENDING or DECLINED web request.
      const conflicts: { loserId: string; survivorId: string; shadowLost: boolean }[] = [];
      for (const r of discordRequests) {
        const web = webByKey.get(`${r.tmdbId}:${r.mediaType}:${r.arrInstance}`);
        if (web === undefined) continue;
        const shadowWins = isGreenlit(r) && (web.status === "PENDING" || web.status === "DECLINED");
        conflicts.push(shadowWins
          ? { loserId: web.id, survivorId: r.id, shadowLost: false }
          : { loserId: r.id, survivorId: web.id, shadowLost: true });
      }
      if (conflicts.length > 0) {
        // RequestComment cascades with its request, so the losing copy's thread
        // (an admin's notes to the requester) would vanish with it. Move it onto
        // the surviving request first — the same comments, kept as they are and
        // announced to no one, as request-comment-carry.ts does for a replaced
        // request. One statement at a time (guardrail 23c).
        for (const c of conflicts) {
          await tx.requestComment.updateMany({
            where: { requestId: c.loserId },
            data: { requestId: c.survivorId },
          });
        }
        // Before the move below: a surviving shadow row takes the web user's id,
        // and the unique (tmdbId, mediaType, requestedBy, arrInstance) needs the
        // losing web row gone first.
        await tx.mediaRequest.deleteMany({ where: { id: { in: conflicts.map((c) => c.loserId) } } });
      }

      const toMigrate = discordRequests.length - conflicts.filter((c) => c.shadowLost).length;
      if (toMigrate > 0) {
        await tx.mediaRequest.updateMany({
          where: { requestedBy: existing.id },
          data: { requestedBy: webUserId },
        });
      }

      await tx.issue.updateMany({
        where: { reportedBy: existing.id },
        data: { reportedBy: webUserId },
      });

      await tx.issueMessage.updateMany({
        where: { authorId: existing.id },
        data: { authorId: webUserId },
      });

      await tx.requestComment.updateMany({
        where: { authorId: existing.id },
        data: { authorId: webUserId },
      });

      await tx.issueGrab.updateMany({
        where: { triggeredById: existing.id },
        data: { triggeredById: webUserId },
      });

      // No deletion-vote threshold re-evaluation is needed after this transfer:
      // for any (tmdbId, mediaType) the merge either moves a vote from the shadow
      // user to the web user (distinct-voter count unchanged) or deletes it as a
      // conflict because the web user already voted (count decreases by one). The
      // count can never INCREASE, so the threshold alert in /api/votes (the
      // `deletionVoteNotified:` one-shot gate) can neither newly fire nor need
      // re-arming here.
      const webVotes = await tx.deletionVote.findMany({
        where: { userId: webUserId },
        select: { tmdbId: true, mediaType: true },
      });
      const webVoteKeys = new Set(webVotes.map((v) => `${v.tmdbId}:${v.mediaType}`));
      const conflictVoteIds = (await tx.deletionVote.findMany({
        where: { userId: existing.id },
        select: { id: true, tmdbId: true, mediaType: true },
      })).filter((v) => webVoteKeys.has(`${v.tmdbId}:${v.mediaType}`)).map((v) => v.id);
      if (conflictVoteIds.length > 0) {
        await tx.deletionVote.deleteMany({ where: { id: { in: conflictVoteIds } } });
      }
      await tx.deletionVote.updateMany({
        where: { userId: existing.id },
        data: { userId: webUserId },
      });

      await tx.user.delete({ where: { id: existing.id } });
      await tx.user.update({ where: { id: webUserId }, data: { discordId: discordUserId } });

      return { migrated: toMigrate, previousDiscordId };
    }

    await tx.user.update({ where: { id: webUserId }, data: { discordId: discordUserId } });
    return { migrated: 0, previousDiscordId };
  });

  // Only AFTER the commit (guardrail 27): the DB now says the account belongs to
  // the new Discord member, so the old one loses the roles that link granted.
  // Fire-and-forget and self-swallowing, like the unlink route — a Discord API
  // hiccup must not fail a link that has already succeeded.
  if (previousDiscordId && previousDiscordId !== discordUserId) {
    void revokeDiscordRolesOnUnlink(previousDiscordId);
  }

  // Every completed link — the bot's /link command and the confirm-merge code
  // both land here — is audited and mailed to the owner (guardrail 6g). A link
  // lets that Discord account act as this user and survives a password change,
  // so a link the owner didn't make must be visible to them. Both are
  // best-effort and post-commit (guardrail 26).
  if (previousDiscordId !== discordUserId) {
    void auditDiscordLink(webUserId, discordUserId, previousDiscordId, migrated);
    void notifyAccountSecurityEvent(webUserId, "discord-linked");
  }

  return { migrated };
}

async function auditDiscordLink(
  webUserId: string,
  discordUserId: string,
  previousDiscordId: string | null,
  migrated: number,
): Promise<void> {
  const owner = await prisma.user
    .findUnique({ where: { id: webUserId }, select: { name: true, email: true } })
    .catch(() => null);
  await logAudit({
    userId: webUserId,
    userName: owner?.name ?? owner?.email ?? "unknown",
    action: "SETTINGS_CHANGE",
    target: `discord-link:${webUserId}`,
    details: { type: "discord-link", discordId: discordUserId, previousDiscordId, migrated },
  });
}
