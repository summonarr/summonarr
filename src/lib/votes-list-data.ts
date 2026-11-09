import "server-only";
import { Prisma } from "@/generated/prisma";
import { prisma } from "@/lib/prisma";
import type { SummonarrSession } from "@/lib/api-auth";
import { mapLimit } from "@/lib/concurrency";
import { hiddenVoteTitles, myVotesByCountScope, scopeVotesWhere } from "@/lib/votes-visibility";

// The deletion-votes list behind GET /api/votes (the native mirror of the web
// /votes page): one page of voted titles, the caller's own vote on each, and a
// few other voters' reasons. The paging scope is the page's
// (votes-visibility.ts, guardrail 35a); the total is a COUNT, read only when the
// visibility scope didn't already produce it.

export const VOTES_PAGE_SIZE = 40;
export type VoteListSort = "votes" | "recent";

// Other voters' reasons shown per title, and how many of their newest reasoned
// votes are read to find them (headroom for the dedupe of identical reasons).
const REASONS_PER_TITLE = 3;
const REASON_ROWS_PER_TITLE = 10;
// The per-title reason reads run beside the page's other three reads; two at a
// time keeps the whole fan-out under the pool's five connections.
const REASON_READ_CONCURRENCY = 2;

export interface VoteListItem {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  title: string;
  posterPath: string | null;
  voteCount: number;
  userVoted: boolean;
  userReason: string | null;
  // `reasons` stays a plain string list for the web page and shipped clients;
  // `reasonEntries` is the same list, in the same order, with each reason's
  // vote id — what POST /api/report `vote_reason` takes.
  reasons: string[];
  reasonEntries: Array<{ id: string; reason: string }>;
}

type TitleKey = { tmdbId: number; mediaType: "MOVIE" | "TV" };
const keyOf = (k: TitleKey) => `${k.tmdbId}:${k.mediaType}`;

export async function loadVotesList(
  session: SummonarrSession,
  opts: { page: number; mine: boolean; sort: VoteListSort; q: string },
): Promise<{ items: VoteListItem[]; total: number }> {
  const userId = session.user.id;
  // `mine` scopes to the caller's votes, `q` matches the title.
  const where: Prisma.DeletionVoteWhereInput = {
    ...(opts.mine ? { userId } : {}),
    ...(opts.q ? { title: { contains: opts.q, mode: "insensitive" } } : {}),
  };

  // A title held only on servers this viewer holds no grant for is not on the
  // list for them (guardrail 35a), and the total is reduced by it. "My votes"
  // by count pages over every voter's rows on the caller's titles, so `_count`
  // is the real total and the sort follows it; the recent sort stays
  // caller-scoped (it orders by the caller's own vote).
  const byTotalCount = opts.mine && opts.sort === "votes";
  let scopedWhere: Prisma.DeletionVoteWhereInput;
  let total: number;
  if (byTotalCount) {
    ({ where: scopedWhere, total } = await myVotesByCountScope(session, where));
  } else {
    const { hidden, votedTitles } = await hiddenVoteTitles(session, where);
    scopedWhere = scopeVotesWhere(where, hidden);
    total = votedTitles !== null ? votedTitles - hidden.length : await countVotedTitles(opts.mine ? userId : null, opts.q);
  }

  // The WHOLE group key — `tmdbId` AND `mediaType` — is the tiebreaker on both
  // sorts: groups tied on _count (most titles sit at 1-2 votes) otherwise have
  // no total order, so page=1 and page=2 can return them in different
  // sequences and OFFSET paging duplicates one row while skipping another. A
  // MOVIE and a TV group can share one TMDB id, so `tmdbId` alone is not enough.
  const grouped = await prisma.deletionVote.groupBy({
    by: ["tmdbId", "mediaType"],
    where: scopedWhere,
    _count: { id: true },
    _max: { createdAt: true },
    orderBy: opts.sort === "recent"
      ? [{ _max: { createdAt: "desc" } }, { tmdbId: "asc" }, { mediaType: "asc" }]
      : [{ _count: { id: "desc" } }, { tmdbId: "asc" }, { mediaType: "asc" }],
    skip: (opts.page - 1) * VOTES_PAGE_SIZE,
    take: VOTES_PAGE_SIZE,
  });
  if (grouped.length === 0) return { items: [], total };

  const pairs: TitleKey[] = grouped.map((g) => ({ tmdbId: g.tmdbId, mediaType: g.mediaType }));
  const [reps, userVotes, reasonsByTitle, recounts] = await Promise.all([
    prisma.deletionVote.findMany({
      where: { OR: pairs },
      select: { tmdbId: true, mediaType: true, title: true, posterPath: true },
      // Newest row first, so the title shown is the latest metadata rather than
      // whichever row the database returns first.
      orderBy: { createdAt: "desc" },
      distinct: ["tmdbId", "mediaType"],
    }),
    prisma.deletionVote.findMany({
      where: { userId, OR: pairs },
      select: { tmdbId: true, mediaType: true, id: true, reason: true },
    }),
    otherVotersReasons(pairs, userId),
    // Under `mine` sorted by recent, the paging `where` also scopes the
    // aggregate — and @@unique([tmdbId, mediaType, userId]) means the caller
    // owns exactly one row per group, so `g._count.id` would always be 1. That
    // shipped a "1 vote" badge next to three reasons written by three other
    // users. Recount the page's pairs unscoped; the by-count path's aggregate
    // is already unscoped.
    opts.mine && !byTotalCount
      ? prisma.deletionVote.groupBy({ by: ["tmdbId", "mediaType"], where: { OR: pairs }, _count: { id: true } })
      : Promise.resolve(null),
  ]);

  const repMap = new Map(reps.map((r) => [keyOf(r), r]));
  const userVoteMap = new Map(userVotes.map((v) => [keyOf(v), v]));
  const recountMap = new Map(recounts?.map((g) => [keyOf(g), g._count.id]) ?? []);
  const items = grouped.map((g): VoteListItem => {
    const key = keyOf(g);
    const rep = repMap.get(key);
    const userVote = userVoteMap.get(key);
    const reasonEntries = reasonsByTitle.get(key) ?? [];
    return {
      tmdbId: g.tmdbId,
      mediaType: g.mediaType,
      title: rep?.title ?? "",
      posterPath: rep?.posterPath ?? null,
      voteCount: recountMap.get(key) ?? g._count.id,
      userVoted: !!userVote,
      userReason: userVote?.reason ?? null,
      reasons: reasonEntries.map((e) => e.reason),
      reasonEntries,
    };
  });
  return { items, total };
}

// Up to three deduped, non-empty reasons per title from OTHER voters, newest
// first, each with the id of the (newest) vote it came from so a client can
// report it. Read PER TITLE: one newest-first read across the whole page let a
// few heavily voted titles use up the row budget and left other titles on the
// page showing none of the reasons they have.
async function otherVotersReasons(pairs: readonly TitleKey[], viewerId: string): Promise<Map<string, Array<{ id: string; reason: string }>>> {
  const perTitle = await mapLimit([...pairs], REASON_READ_CONCURRENCY, (p) =>
    prisma.deletionVote.findMany({
      where: { tmdbId: p.tmdbId, mediaType: p.mediaType, userId: { not: viewerId }, reason: { not: null } },
      select: { id: true, reason: true },
      orderBy: { createdAt: "desc" },
      take: REASON_ROWS_PER_TITLE,
    }),
  );
  const out = new Map<string, Array<{ id: string; reason: string }>>();
  pairs.forEach((p, i) => out.set(keyOf(p), pickReasons(perTitle[i])));
  return out;
}

/** The first REASONS_PER_TITLE distinct non-blank reasons of newest-first rows, trimmed. */
export function pickReasons(rows: ReadonlyArray<{ id: string; reason: string | null }>): Array<{ id: string; reason: string }> {
  const out: Array<{ id: string; reason: string }> = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (out.length >= REASONS_PER_TITLE) break;
    const reason = r.reason?.trim();
    if (!reason || seen.has(reason)) continue;
    seen.add(reason);
    out.push({ id: r.id, reason });
  }
  return out;
}

/**
 * How many distinct titles carry a vote matching the list's filters — one
 * COUNT over the groups instead of reading every voted title into memory. The
 * filters mirror loadVotesList's `where`: `userId` (mine) and the title search
 * (already stripped of wildcard characters by sanitizeContainsSearch). One
 * Prisma.sql value, never a fragment in a tagged template (guardrail 23a).
 */
export async function countVotedTitles(userId: string | null, q: string): Promise<number> {
  const conditions: Prisma.Sql[] = [];
  if (userId) conditions.push(Prisma.sql`"userId" = ${userId}`);
  if (q) conditions.push(Prisma.sql`"title" ILIKE ${`%${q}%`}`);
  const whereSql = conditions.length ? Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}` : Prisma.empty;
  const [row] = await prisma.$queryRaw<Array<{ count: bigint }>>(
    Prisma.sql`SELECT COUNT(*)::bigint AS count FROM (SELECT 1 FROM "DeletionVote" ${whereSql} GROUP BY "tmdbId", "mediaType") AS g`,
  );
  return Number(row?.count ?? 0);
}
