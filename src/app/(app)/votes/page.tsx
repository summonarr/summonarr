export const dynamic = "force-dynamic";

import { Suspense } from "react";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { posterUrl } from "@/lib/tmdb-types";
import Image from "next/image";
import { VoteActions } from "@/components/votes/vote-actions";
import { PaginationBar } from "@/components/media/pagination-bar";
import { FilterPills, SearchBox } from "@/components/user-list-filters";
import { requireFeature } from "@/lib/features";
import type { Prisma } from "@/generated/prisma";
import { Chip, PageHeader } from "@/components/ui/design";

const PAGE_SIZE = 40;
const VALID_SORTS = ["votes", "recent"] as const;

export default async function VotesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  await requireFeature("feature.page.votes");
  const [sp, session] = await Promise.all([searchParams, auth()]);
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

  const totalGrouped = await prisma.deletionVote.groupBy({
    by: ["tmdbId", "mediaType"],
    where,
    _count: { id: true },
  });
  const totalPages = Math.max(1, Math.ceil(totalGrouped.length / PAGE_SIZE));

  const items = await Promise.all(
    grouped.map(async (g) => {
      const [representative, userVote, recentVotes] = await Promise.all([
        prisma.deletionVote.findFirst({
          where: { tmdbId: g.tmdbId, mediaType: g.mediaType },
          select: { title: true, posterPath: true },
        }),
        session
          ? prisma.deletionVote.findFirst({
              where: { tmdbId: g.tmdbId, mediaType: g.mediaType, userId: session.user.id },
              select: { id: true },
            })
          : null,
        prisma.deletionVote.findMany({
          where: { tmdbId: g.tmdbId, mediaType: g.mediaType, reason: { not: null } },
          select: { reason: true, user: { select: { name: true } } },
          orderBy: { createdAt: "desc" },
          take: 3,
        }),
      ]);
      return {
        tmdbId: g.tmdbId,
        mediaType: g.mediaType as "MOVIE" | "TV",
        title: representative?.title ?? "",
        posterPath: representative?.posterPath ?? null,
        voteCount: g._count.id,
        userVoted: !!userVote,
        reasons: recentVotes
          .filter((v) => v.reason)
          .map((v) => ({ reason: v.reason!, userName: v.user.name ?? "Anonymous" })),
      };
    })
  );

  const isAdmin = session?.user.role === "ADMIN";
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
        <div
          className="text-center ds-mono"
          style={{
            padding: "40px 20px",
            background: "var(--ds-bg-1)",
            border: "1px dashed var(--ds-border)",
            borderRadius: 8,
            fontSize: 12,
            color: "var(--ds-fg-subtle)",
          }}
        >
          {hasFilters
            ? "No votes match these filters."
            : "No deletion votes yet. Browse your library and vote on items you think should be removed."}
        </div>
      ) : (
        <div className="flex flex-col" style={{ gap: 8 }}>
          {items.map((item) => {
            const poster = posterUrl(item.posterPath);
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
                <div
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
                </div>

                <div className="flex-1 min-w-0">
                  <div
                    className="flex items-center flex-wrap"
                    style={{ gap: 6 }}
                  >
                    <h3
                      className="font-medium truncate"
                      style={{ fontSize: 14, color: "var(--ds-fg)", margin: 0 }}
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
