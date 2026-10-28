import "server-only";
import type { Prisma } from "@/generated/prisma";
import { prisma } from "@/lib/prisma";
import type { SummonarrSession } from "@/lib/api-auth";
import { titleKeysWhere, titlesHiddenFromViewer, type MediaTitleKey } from "@/lib/media-visibility";

// The deletion-vote groups this viewer must not be shown (guardrail 35a): titles
// held only on servers they hold no grant for. The voted titles the caller's
// own filters leave in are read ONLY when something is hidden from this viewer
// (titlesHiddenFromViewer's lazy loader), and `votedTitles` reports that count
// so the page can skip its COUNT query on that path.
export async function hiddenVoteTitles(
  session: SummonarrSession | null,
  where: Prisma.DeletionVoteWhereInput,
): Promise<{ hidden: MediaTitleKey[]; votedTitles: number | null }> {
  const voted = { titles: null as number | null };
  const hidden = await titlesHiddenFromViewer(session, async () => {
    const rows = await prisma.deletionVote.findMany({
      where,
      distinct: ["tmdbId", "mediaType"],
      select: { tmdbId: true, mediaType: true },
    });
    voted.titles = rows.length;
    return rows;
  });
  return { hidden, votedTitles: voted.titles };
}

// The paging `where` with the hidden groups subtracted. `NOT: { OR: [] }` would
// exclude nothing but still change the plan, so an empty list leaves it alone.
export function scopeVotesWhere(where: Prisma.DeletionVoteWhereInput, hidden: MediaTitleKey[]): Prisma.DeletionVoteWhereInput {
  return hidden.length ? { ...where, NOT: titleKeysWhere(hidden) } : where;
}
