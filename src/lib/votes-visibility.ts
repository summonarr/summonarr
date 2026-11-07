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
// A `where` that already carries its own NOT is ANDed with the scope: spreading
// over it would silently drop the caller's exclusion.
export function scopeVotesWhere(where: Prisma.DeletionVoteWhereInput, hidden: MediaTitleKey[]): Prisma.DeletionVoteWhereInput {
  if (!hidden.length) return where;
  const NOT = titleKeysWhere(hidden);
  return where.NOT === undefined ? { ...where, NOT } : { AND: [where, { NOT }] };
}

// "My votes" sorted by vote count. Scoped to the caller, every group holds just
// their own row (@@unique([tmdbId, mediaType, userId])), so `_count` tied at 1
// and the order fell through to tmdbId while the badge showed the real total.
// This pages over EVERY voter's rows on the caller's titles instead: the
// caller's filters (userId, title search) picked `voted`, and are not applied to
// other voters' rows. Hidden titles are subtracted as on every path (guardrail
// 35a). An empty `voted` selects nothing (titleKeysWhere).
export function votesOnTitlesWhere(voted: MediaTitleKey[], hidden: MediaTitleKey[]): Prisma.DeletionVoteWhereInput {
  return scopeVotesWhere(titleKeysWhere(voted), hidden);
}

// The /votes page's read for that path: the caller's voted titles (bounded by
// their own votes), the paging `where` over them, and the visible count.
export async function myVotesByCountScope(
  session: SummonarrSession | null,
  where: Prisma.DeletionVoteWhereInput,
): Promise<{ where: Prisma.DeletionVoteWhereInput; total: number }> {
  const voted = await prisma.deletionVote.findMany({
    where,
    distinct: ["tmdbId", "mediaType"],
    select: { tmdbId: true, mediaType: true },
  });
  const hidden = await titlesHiddenFromViewer(session, voted);
  return { where: votesOnTitlesWhere(voted, hidden), total: voted.length - hidden.length };
}
