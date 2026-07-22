export const dynamic = "force-dynamic";

import { Suspense } from "react";
import { requireAppSession } from "@/lib/require-app-session";
import { prisma } from "@/lib/prisma";
import { posterUrl } from "@/lib/tmdb-types";
import { EmptyState } from "@/components/ui/empty-state";
import Image from "next/image";
import Link from "next/link";
import { VoteActions } from "@/components/votes/vote-actions";
import { PaginationBar } from "@/components/media/pagination-bar";
import { FilterPills, SearchBox } from "@/components/user-list-filters";
import { requireFeature } from "@/lib/features";
import { Prisma } from "@/generated/prisma";
import { hasPermission, Permission } from "@/lib/permissions";
import { Chip, PageHeader } from "@/components/ui/design";

const PAGE_SIZE = 40;
const VALID_SORTS = ["votes", "recent"] as const;

export default async function VotesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  await requireFeature("feature.page.votes");
  const [sp, session] = await Promise.all([searchParams, requireAppSession()]);
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);

  const mine = sp.mine === "1";
  const sort = VALID_SORTS.includes(sp.sort as typeof VALID_SORTS[number])
    ? (sp.sort as typeof VALID_SORTS[number])
    : "votes";
  const q = (sp.q ?? "").trim();

  const where: Prisma.DeletionVoteWhereInput = {
    ...(mine && session ? { userId: session.user.id } : {}),
    ...(q ? { title: { contains: q, mode: "insensitive" } } : {}),
  };

  const grouped = await prisma.deletionVote.groupBy({
    by: ["tmdbId", "mediaType"],
    where,
    _count: { id: true },
    _max: { createdAt: true },
    orderBy: sort === "recent"
      ? { _max: { createdAt: "desc" } }
      : { _count: { id: "desc" } },
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
  });

  // Count distinct (tmdbId, mediaType) groups for pagination without
  // materializing one row per group into memory (which scales with the number
  // of distinct voted titles). Mirrors the `where` above with parameterized
  // fragments.
  const conditions: Prisma.Sql[] = [];
  if (mine && session) conditions.push(Prisma.sql`"userId" = ${session.user.id}`);
  if (q) conditions.push(Prisma.sql`"title" ILIKE ${`%${q}%`}`);
  const whereSql = conditions.length
    ? Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}`
    : Prisma.empty;
  const [{ count }] = await prisma.$queryRaw<{ count: bigint }[]>(
    Prisma.sql`SELECT COUNT(*)::bigint AS count FROM (SELECT 1 FROM "DeletionVote" ${whereSql} GROUP BY "tmdbId", "mediaType") AS g`,
  );
  const totalPages = Math.max(1, Math.ceil(Number(count) / PAGE_SIZE));

  // Batched lookup: 2 queries total (was 3×PAGE_SIZE = up to 120 round-trips/render).
  // Split by mediaType so each becomes a `tmdbId: { in: [...] }` predicate that
  // the planner can serve from the composite (tmdbId, mediaType) PK efficiently.
  const movieIds = grouped.filter((g) => g.mediaType === "MOVIE").map((g) => g.tmdbId);
  const tvIds = grouped.filter((g) => g.mediaType === "TV").map((g) => g.tmdbId);
  const groupWhere: Prisma.DeletionVoteWhereInput = {
    OR: [
      ...(movieIds.length ? [{ mediaType: "MOVIE" as const, tmdbId: { in: movieIds } }] : []),
      ...(tvIds.length ? [{ mediaType: "TV" as const, tmdbId: { in: tvIds } }] : []),
    ],
  };

  const [allVotes, userVotes] = grouped.length === 0
    ? [[], []]
    : await Promise.all([
        prisma.deletionVote.findMany({
          where: groupWhere,
          select: {
            tmdbId: true,
            mediaType: true,
            title: true,
            posterPath: true,
            reason: true,
            user: { select: { name: true } },
          },
          orderBy: { createdAt: "desc" },
        }),
        session
          ? prisma.deletionVote.findMany({
              where: { ...groupWhere, userId: session.user.id },
              select: { tmdbId: true, mediaType: true },
            })
          : Promise.resolve([] as Array<{ tmdbId: number; mediaType: "MOVIE" | "TV" }>),
      ]);

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
  const userVoteSet = new Set(userVotes.map((v) => `${v.mediaType}:${v.tmdbId}`));

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
      userVoted: userVoteSet.has(k),
      reasons: reasons.map((v) => ({ reason: v.reason!, userName: v.user.name ?? "Anonymous" })),
    };
  });

  const isAdmin = !!session && hasPermission(session.user.permissions, Permission.ADMIN);
  const hasFilters = mine || sort !== "votes" || q !== "";

  return (
    <div className="ds-page-enter">
      <PageHeader
        title="Vote to Delete"
        subtitle="Nominate library items for removal. Browse movies or TV shows and click the vote button on any item already in your library."
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
        <EmptyState>
          {hasFilters
            ? "No votes match these filters."
            : "No deletion votes yet. Browse your library and vote on items you think should be removed."}
        </EmptyState>
      ) : (
        <div className="flex flex-col" style={{ gap: 8 }}>
          {items.map((item) => {
            const poster = posterUrl(item.posterPath);
            const href = `/${item.mediaType === "MOVIE" ? "movie" : "tv"}/${item.tmdbId}`;
            return (
              <div
                key={`${item.mediaType}-${item.tmdbId}`}
                className="flex items-start"
                style={{
                  gap: 14,
                  padding: 14,
                  background: "var(--ds-bg-2)",
                  border: "1px solid var(--ds-border)",
                  borderRadius: 8,
                }}
              >
                <Link
                  href={href}
                  className="relative shrink-0 overflow-hidden"
                  style={{
                    width: 56,
                    aspectRatio: "2 / 3",
                    borderRadius: 4,
                    background: "var(--ds-bg-3)",
                  }}
                >
                  {poster ? (
                    <Image
                      src={poster}
                      alt={item.title}
                      width={56}
                      height={84}
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
                </Link>

                <div className="flex-1 min-w-0">
                  <div
                    className="flex items-center flex-wrap"
                    style={{ gap: 6 }}
                  >
                    <h3
                      className="font-medium truncate"
                      style={{ fontSize: 14, margin: 0 }}
                    >
                      <Link
                        href={href}
                        className="hover:underline"
                        style={{ color: "var(--ds-fg)" }}
                      >
                        {item.title}
                      </Link>
                    </h3>
                    <Chip>{item.mediaType === "MOVIE" ? "MOVIE" : "TV"}</Chip>
                  </div>

                  <div
                    className="ds-mono"
                    style={{
                      marginTop: 6,
                      fontSize: 12,
                      color: "var(--ds-accent)",
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
