export const dynamic = "force-dynamic";

import { Suspense } from "react";
import { requireAppSession } from "@/lib/require-app-session";
import { prisma } from "@/lib/prisma";
import { posterUrl } from "@/lib/tmdb-types";
import Image from "next/image";
import Link from "next/link";
import { Film, Trash2, Tv2 } from "@/components/icons";
import { VoteActions } from "@/components/votes/vote-actions";
import { PaginationBar } from "@/components/media/pagination-bar";
import { FilterPills, SearchBox } from "@/components/user-list-filters";
import { requireFeature } from "@/lib/features";
import { loadVotesList, VOTES_PAGE_SIZE, type VoteListItem, type VoteListSort } from "@/lib/votes-list-data";
import { parsePageNumber } from "@/lib/pagination";
import { hasPermission, Permission } from "@/lib/permissions";
import { EmptyState, PageHeader } from "@/components/ui/design";
import { sanitizeContainsSearch } from "@/lib/sanitize";
import { getTranslator } from "@/lib/i18n/server";
import type { Translator } from "@/lib/i18n/translate";
// A repeated query key (?q=a&q=b) arrives as an array; every read takes the
// first value (`.trim()` on the array would throw and 500 the page).
import { first, type PageSearchParams } from "@/lib/search-params";

const VALID_SORTS = ["votes", "recent"] as const satisfies readonly VoteListSort[];
// Reasons shown per title: the viewer's own first, then other voters' newest.
const REASONS_SHOWN = 3;

export default async function VotesPage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  await requireFeature("feature.page.votes");
  const [sp, session, t] = await Promise.all([searchParams, requireAppSession(), getTranslator()]);
  // Clamped: an oversized ?page= would reach Prisma's skip as a huge offset.
  const page = parsePageNumber(sp.page);

  const mine = first(sp.mine) === "1";
  const sortParam = first(sp.sort);
  const sort: VoteListSort = VALID_SORTS.find((s) => s === sortParam) ?? "votes";
  // Feeds an ILIKE with no ESCAPE clause: strip wildcard metacharacters and
  // bound the length (search-box DoS, matches /api/votes).
  const q = sanitizeContainsSearch((first(sp.q) ?? "").trim());

  // The same list GET /api/votes answers (votes-list-data.ts): the paging
  // scope hides titles held only on servers this viewer holds no grant for
  // (guardrail 35a), and "my votes" by count pages over every voter's rows on
  // the caller's titles so the order follows the real totals.
  const { items: listed, total } = await loadVotesList(session, { page, mine, sort, q });
  const totalPages = Math.max(1, Math.ceil(total / VOTES_PAGE_SIZE));
  const names = await reasonAuthorNames(listed);
  const anonymous = t("personal.votes.anonymous");
  const viewerName = session.user.name ?? anonymous;
  const items = listed.map((item) => ({
    ...item,
    reasons: [
      ...(item.userReason?.trim() ? [{ reason: item.userReason.trim(), userName: viewerName }] : []),
      ...item.reasonEntries.map((e) => ({ reason: e.reason, userName: names.get(e.id) ?? anonymous })),
    ].slice(0, REASONS_SHOWN),
  }));

  const isAdmin = hasPermission(session.user.permissions, Permission.ADMIN);
  const hasFilters = mine || sort !== "votes" || q !== "";
  // The first page under the active filters (only the page param is dropped).
  const firstPageParams = new URLSearchParams();
  if (mine) firstPageParams.set("mine", "1");
  if (sort !== "votes") firstPageParams.set("sort", sort);
  if (q) firstPageParams.set("q", q);
  const firstPageHref = firstPageParams.size > 0 ? `/votes?${firstPageParams.toString()}` : "/votes";

  return (
    <div className="ds-page-enter">
      <PageHeader
        title={t("personal.votes.title")}
        subtitle={t("personal.votes.subtitle")}
      />

      <div className="flex flex-col gap-3 mb-5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <FilterPills
          param="mine"
          active={mine ? "1" : ""}
          label={t("personal.votes.filter.label")}
          options={[
            { value: "", label: t("personal.votes.filter.all") },
            { value: "1", label: t("personal.votes.filter.mine") },
          ]}
          preserve={["sort", "q"]}
        />
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          <FilterPills
            param="sort"
            active={sort === "votes" ? "" : sort}
            label={t("personal.votes.sort.label")}
            options={[
              { value: "", label: t("personal.votes.sort.most") },
              { value: "recent", label: t("personal.votes.sort.recent") },
            ]}
            preserve={["mine", "q"]}
          />
          <SearchBox
            param="q"
            initial={q}
            placeholder={t("personal.common.searchTitles")}
            preserve={["mine", "sort"]}
          />
        </div>
      </div>

      {items.length === 0 && total > 0 ? (
        // Past the last page (same as /requests): the pager is hidden when
        // totalPages <= 1, so "no votes yet" there would be both wrong and a
        // dead end.
        <EmptyState
          icon={Trash2}
          title={t("personal.common.nothingOnPage")}
          description={t("personal.votes.emptyPageDescription")}
          cta={{ href: firstPageHref, label: t("personal.common.backToFirst") }}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={Trash2}
          title={hasFilters ? t("personal.votes.emptyFilteredTitle") : t("personal.votes.emptyTitle")}
          description={
            hasFilters
              ? t("personal.votes.emptyFilteredDescription")
              : t("personal.votes.emptyDescription")
          }
          cta={hasFilters ? undefined : { href: "/movies", label: t("personal.common.browseMovies") }}
        />
      ) : (
        <div className="flex flex-col" style={{ gap: 8 }}>
          {items.map((item) => (
            <VoteRow key={`${item.mediaType}-${item.tmdbId}`} item={item} isAdmin={isAdmin} t={t} />
          ))}
        </div>
      )}

      <Suspense>
        <PaginationBar currentPage={page} totalPages={totalPages} />
      </Suspense>
    </div>
  );
}

type VoteRowItem = Pick<VoteListItem, "tmdbId" | "mediaType" | "title" | "posterPath" | "voteCount" | "userVoted"> & {
  reasons: Array<{ reason: string; userName: string }>;
};

// The display names behind the reasons on this page, by vote id: one bounded
// read (at most a few reasons per title).
async function reasonAuthorNames(items: readonly VoteListItem[]): Promise<Map<string, string | null>> {
  const ids = items.flatMap((i) => i.reasonEntries.map((e) => e.id));
  if (ids.length === 0) return new Map();
  const rows = await prisma.deletionVote.findMany({
    where: { id: { in: ids } },
    select: { id: true, user: { select: { name: true } } },
  });
  return new Map(rows.map((r) => [r.id, r.user.name]));
}

// One voted title: poster, title, vote count, a few reasons and the actions.
function VoteRow({ item, isAdmin, t }: { item: VoteRowItem; isAdmin: boolean; t: Translator }) {
  const poster = posterUrl(item.posterPath);
  const href = `/${item.mediaType === "MOVIE" ? "movie" : "tv"}/${item.tmdbId}`;
  return (
    <div
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
            // Same glyph fallback as /requests and /issues — the words
            // "No poster" don't fit a 44px tile.
            <div
              className="absolute inset-0 flex items-center justify-center"
              style={{ color: "var(--ds-fg-subtle)" }}
            >
              {item.mediaType === "MOVIE" ? (
                <Film style={{ width: 16, height: 16 }} />
              ) : (
                <Tv2 style={{ width: 16, height: 16 }} />
              )}
            </div>
          )}
        </div>

        <div className="flex-1 min-w-0">
          {/* Row recipe shared with /requests and /issues: a <p> title (an
              <h3> here was an orphaned heading level) and the media type
              as the mono meta line, not a chip beside the title.
              DeletionVote stores no release year, so the line is type only. */}
          <p
            className="font-medium truncate transition-colors group-hover:text-[var(--ds-accent-text)]"
            style={{ fontSize: 14, margin: 0, color: "var(--ds-fg)" }}
          >
            {item.title}
          </p>
          <div
            className="ds-mono"
            style={{ fontSize: 10.5, color: "var(--ds-fg-subtle)", marginTop: 2 }}
          >
            {item.mediaType === "MOVIE" ? t("personal.common.movie") : t("personal.common.tv")}
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
            {t("personal.votes.count", { count: item.voteCount })}
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
}
