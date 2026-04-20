import { prisma } from "@/lib/prisma";

export interface MergeResult {
  migrated: number;
}

export async function mergeDiscordIntoWebAccount(
  webUserId: string,
  discordUserId: string
): Promise<MergeResult> {

  const result = await prisma.$transaction(async (tx) => {
    // Per-discordUserId advisory lock prevents duplicate merges if the user clicks the link button twice rapidly
    const lockId = BigInt("0x" + Buffer.from(discordUserId).subarray(0, 7).toString("hex"));
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock($1::bigint)`, lockId);

    const existing = await tx.user.findUnique({ where: { discordId: discordUserId } });

    if (existing && existing.id !== webUserId) {
      // A non-synthetic email means the Discord account is a real web user, not a bot-created shadow — refuse merge
      if (!existing.email.endsWith("@discord.local")) {
        throw new Error("This Discord account is already linked to another user.");
      }

      const webRequests = await tx.mediaRequest.findMany({
        where: { requestedBy: webUserId },
        select: { tmdbId: true, mediaType: true },
      });
      const webKeys = new Set(webRequests.map((r) => `${r.tmdbId}:${r.mediaType}`));

      const discordRequests = await tx.mediaRequest.findMany({
        where: { requestedBy: existing.id },
        select: { id: true, tmdbId: true, mediaType: true },
      });

      const conflictIds = discordRequests
        .filter((r) => webKeys.has(`${r.tmdbId}:${r.mediaType}`))
        .map((r) => r.id);
      if (conflictIds.length > 0) {
        await tx.mediaRequest.deleteMany({ where: { id: { in: conflictIds } } });
      }

      const toMigrate = discordRequests.length - conflictIds.length;
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

      await tx.issueGrab.updateMany({
        where: { triggeredById: existing.id },
        data: { triggeredById: webUserId },
      });

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

      return { migrated: toMigrate };
    }

    await tx.user.update({ where: { id: webUserId }, data: { discordId: discordUserId } });
    return { migrated: 0 };
  });

  return result;
}
