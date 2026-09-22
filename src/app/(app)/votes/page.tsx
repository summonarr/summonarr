export const dynamic = "force-dynamic";

import { Suspense } from "react";
import { requireAppSession } from "@/lib/require-app-session";
import { prisma } from "@/lib/prisma";
import { posterUrl } from "@/lib/tmdb-types";
import Image from "next/image";
import Link from "next/link";
import { Trash2 } from "@/components/icons";
import { VoteActions } from "@/components/votes/vote-actions";
import { PaginationBar } from "@/components/media/pagination-bar";
import { FilterPills, SearchBox } from "@/components/user-list-filters";
import { requireFeature } from "@/lib/features";
import { Prisma } from "@/generated/prisma";
import { hasPermission, Permission } from "@/lib/permissions";
import { Chip, EmptyState, PageHeader } from "@/components/ui/design";
import { sanitizeContainsSearch } from "@/lib/sanitize";

const PAGE_SIZE = 40;
const VALID_SORTS = ["votes", "recent"] as const;

// A repeated query key (?q=a&q=b) is delivered as an array, so every read takes
// the first value — `.trim()` on the array throws and 500s the whole page.
const first = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

export default async function VotesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireFeature("feature.page.votes");
  const [sp, session] = await Promise.all([searchParams, requireAppSession()]);
  const page = Math.max(1, parseInt(first(sp.page) ?? "1", 10) || 1);

  const mine = first(sp.mine) === "1";
  const sortParam = first(sp.sort);
  const sort = VALID_SORTS.includes(sortParam as typeof VALID_SORTS[number])
    ? (sortParam as typeof VALID_SORTS[number])
    : "votes";
  // Feeds both the Prisma `contains` below (ILIKE, no ESCAPE clause) and the raw
  // ILIKE further down — strip wildcard metacharacters and bound the length for
  // both at once (search-box DoS, matches /api/votes).
  const q = sanitizeContainsSearch((first(sp.q) ?? "").trim());

  // `session` is never null here — requireAppSession() redirects instead of
  // returning — so the "mine" filter keys on the flag alone.
  const where: Prisma.DeletionVoteWhereInput = {
    ...(mine ? { userId: session.user.id } : {}),
    ...(q ? { title: { contains: q, mode: "insensitive" } } : {}),
  };

  // Count distinct (tmdbId, mediaType) groups for pagination without
  // materializing one row per group into memory (which scales with the number
  // of distinct voted titles). Mirrors the `where` above with parameterized
  // fragments. Built before the queries below so the page query and the count
  // query — which depend only on the request, not on each other — can share
  // one round-trip.
  const conditions: Prisma.Sql[] = [];
  if (mine) conditions.push(Prisma.sql`"userId" = ${session.user.id}`);
  if (q) conditions.push(Prisma.sql`"title" ILIKE ${`%${q}%`}`);
  const whereSql = conditions.length
    ? Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}`
    : Prisma.empty;

  const [grouped, [{ count }]] = await Promise.all([
    prisma.deletionVote.groupBy({
      by: ["tmdbId", "mediaType"],
      where,
      _count: { id: true },
      _max: { createdAt: true },
      // Both sorts need a TIEBREAKER, because both are paginated with skip/take.
      // Neither key is unique across groups — most titles hold exactly one vote,
      // so ordering by _count alone leaves the bulk of the table in one tied
      // block that Postgres may return in a different order per query. Two
      // requests for two pages are two queries, so a title could appear on both
      // pages while another appeared on neither. Appending the group key makes
      // the order total, and it is free: [tmdbId, mediaType] is the group key
      // already being computed.
      orderBy: [
        sort === "recent"
          ? { _max: { createdAt: "desc" } }
          : { _count: { id: "desc" } },
        { tmdbId: "asc" },
        { mediaType: "asc" },
      ],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.$queryRaw<{ count: bigint }[]>(
      Prisma.sql`SELECT COUNT(*)::bigint AS count FROM (SELECT 1 FROM "DeletionVote" ${whereSql} GROUP BY "tmdbId", "mediaType") AS g`,
    ),
  ]);
  const totalPages = Math.max(1, Math.ceil(Number(count) / PAGE_SIZE));

  // Batched lookup: 1 query total (was 3×PAGE_SIZE = up to 120 round-trips/render,
  // then 2). Split by mediaType so each becomes a `tmdbId: { in: [...] }`
  // predicate that the planner can serve from the composite (tmdbId, mediaType)
  // PK efficiently. The rows carry `userId`, so "did the viewer vote on this"
  // is derived in memory instead of re-reading the same row set filtered to
  // the viewer. `userId` is server-side only and never reaches the client.
  const movieIds = grouped.filter((g) => g.mediaType === "MOVIE").map((g) => g.tmdbId);
  const tvIds = grouped.filter((g) => g.mediaType === "TV").map((g) => g.tmdbId);
  const groupWhere: Prisma.DeletionVoteWhereInput = {
    OR: [
      ...(movieIds.length ? [{ mediaType: "MOVIE" as const, tmdbId: { in: movieIds } }] : []),
      ...(tvIds.length ? [{ mediaType: "TV" as const, tmdbId: { in: tvIds } }] : []),
    ],
  };

  const allVotes = grouped.length === 0
    ? []
    : await prisma.deletionVote.findMany({
        where: groupWhere,
        select: {
          tmdbId: true,
          mediaType: true,
          userId: true,
          title: true,
          posterPath: true,
          reason: true,
          user: { select: { name: true } },
        },
        orderBy: { createdAt: "desc" },
      });

  const byKey = new Map<string, typeof allVotes>();
  for (const v of allVotes) {
    const k = `${v.mediaType}:${v.tmdbId}`;
    let arr = byKey.get(k);
    if (!arr) {
      arr = [];
      byKey.set(k, arr);
    }
    arr.push(v);
  }

  const items = grouped.map((g) => {
    const k = `${g.mediaType}:${g.tmdbId}`;
    const votes = byKey.get(k) ?? [];
    const representative = votes[0];
    const reasons = votes.filter((v) => v.reason).slice(0, 3);
    return {
      tmdbId: g.tmdbId,
      mediaType: g.mediaType as "MOVIE" | "TV",
      title: representative?.title ?? "",
      posterPath: representative?.posterPath ?? null,
      voteCount: g._count.id,
      userVoted: votes.some((v) => v.userId === session.user.id),
      reasons: reasons.map((v) => ({ reason: v.reason!, userName: v.user.name ?? "Anonymous" })),
    };
  });

  const isAdmin = hasPermission(session.user.permissions, Permission.ADMIN);
  const hasFilters = mine || sort !== "votes" || q !== "";

  return (
    <div className="ds-page-enter">
      <PageHeader
        title="Vote to Delete"
        subtitle="Nominate library titles for removal — browse Movies or TV and vote on anything already in your library"
      />

      <div className="flex flex-col gap-3 mb-5 sm:flex-row sm:items-center sm:justify-between">
        <FilterPills
          param="mine"
          active={mine ? "1" : ""}
          options={[
            { value: "", label: "All votes" },
            { value: "1", label: "My votes only" },
          ]}
          preserve={["sort", "q"]}
        />
        <div className="flex items-center gap-3">
          <FilterPills
            param="sort"
            active={sort === "votes" ? "" : sort}
            options={[
              { value: "", label: "Most votes" },
              { value: "recent", label: "Most recent" },
            ]}
            preserve={["mine", "q"]}
          />
          <SearchBox
            param="q"
            initial={q}
            placeholder="Search titles…"
            preserve={["mine", "sort"]}
          />
        </div>
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={Trash2}
          title={hasFilters ? "No matching votes" : "No deletion votes yet"}
          description={
            hasFilters
              ? "No votes match these filters."
              : "Browse your library and vote on items you think should be removed."
          }
          cta={hasFilters ? undefined : { href: "/movies", label: "Browse movies" }}
        />
      ) : (
        <div className="flex flex-col" style={{ gap: 8 }}>
          {items.map((item) => {
            const poster = posterUrl(item.posterPath);
            const href = `/${item.mediaType === "MOVIE" ? "movie" : "tv"}/${item.tmdbId}`;
            return (
              <div
                key={`${item.mediaType}-${item.tmdbId}`}
                className="flex flex-wrap items-start transition-colors bg-[var(--ds-bg-2)] hover:bg-[var(--ds-bg-3)] border border-[var(--ds-border)]"
                style={{
                  gap: 14,
                  padding: 14,
                  borderRadius: 8,
                }}
              >
                <Link
                  href={href}
                  className="flex items-start flex-1 min-w-0 group"
                  style={{ gap: 14 }}
                >
                  <div
                    className="relative shrink-0 overflow-hidden"
                    style={{
                      width: 44,
                      aspectRatio: "2 / 3",
                      borderRadius: 4,
                      background: "var(--ds-bg-3)",
                    }}
                  >
                    {poster ? (
                      <Image
                        src={poster}
                        alt={item.title}
                        width={44}
                        height={66}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div
                        className="w-full h-full flex items-center justify-center ds-mono"
                        style={{ color: "var(--ds-fg-subtle)", fontSize: 10 }}
                      >
                        No poster
                      </div>
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div
                      className="flex items-center flex-wrap"
                      style={{ gap: 6 }}
                    >
                      <h3
                        className="font-medium truncate transition-colors group-hover:text-[var(--ds-accent-text)]"
                        style={{ fontSize: 14, margin: 0, color: "var(--ds-fg)" }}
                      >
                        {item.title}
                      </h3>
                      <Chip>{item.mediaType === "MOVIE" ? "MOVIE" : "TV"}</Chip>
                    </div>

                    <div
                      className="ds-mono"
                      style={{
                        marginTop: 6,
                        fontSize: 12,
                        color: "var(--ds-accent-text)",
                        fontWeight: 600,
                      }}
                    >
                      {item.voteCount} vote{item.voteCount !== 1 ? "s" : ""}
                    </div>

                    {item.reasons.length > 0 && (
                      <div
                        className="flex flex-col"
                        style={{ gap: 3, marginTop: 6 }}
                      >
                        {item.reasons.map((r, i) => (
                          <p
                            // biome-ignore lint/suspicious/noArrayIndexKey: reasons are unordered snippets
                            key={i}
                            style={{
                              fontSize: 11,
                              color: "var(--ds-fg-subtle)",
                              margin: 0,
                            }}
                          >
                            <span style={{ color: "var(--ds-fg-muted)" }}>
                              {r.userName}:
                            </span>{" "}
                            {r.reason}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                </Link>

                <VoteActions
                  tmdbId={item.tmdbId}
                  mediaType={item.mediaType}
                  userVoted={item.userVoted}
                  isAdmin={isAdmin}
                />
              </div>
            );
          })}
        </div>
      )}

      <Suspense>
        <PaginationBar currentPage={page} totalPages={totalPages} />
      </Suspense>
    </div>
  );
}
