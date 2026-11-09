import { authActive } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { hasPermission, Permission } from "@/lib/permissions";
import { requireFeature } from "@/lib/features";
import Link from "next/link";
import Image from "next/image";
import { resolvePosterMap, posterPathKey } from "@/lib/poster-cache";
import { Chip, PageHeader, EmptyState } from "@/components/ui/design";
import { ActivityFilterBar } from "@/components/admin/activity-filter-bar";
import { Film, Tv2 } from "@/components/icons";
import { getLocale, getTranslator } from "@/lib/i18n/server";
import { relativeWithDateFallback } from "../_relative";
import { getStatsTimeZone } from "@/lib/stats-time-zone-data";
import { mergeRecentlyAdded, newestDistinctTitles } from "@/lib/activity-recent-added";

export const dynamic = "force-dynamic";

const RECENT_SELECT = { tmdbId: true, mediaType: true, title: true, year: true, addedAt: true } as const;
// Newest first with the primary key as the tiebreak, so the paged reads below
// walk one total order and never repeat or skip a row at a page boundary.
const RECENT_ORDER = [
  { addedAt: "desc" as const },
  { tmdbId: "asc" as const },
  { mediaType: "asc" as const },
  { serverInstance: "asc" as const },
];

// Rows with an addedAt only (the where), typed as such for the merge.
const withAddedAt = <R extends { addedAt: Date | null }>(rows: R[]) =>
  rows.filter((r): r is R & { addedAt: Date } => r.addedAt !== null);

export default async function RecentlyAddedPage() {
  await requireFeature("feature.admin.activity");
  const session = await authActive();
  if (!session || !hasPermission(session.user.permissions, Permission.ADMIN)) redirect("/");
  const [t, locale] = await Promise.all([getTranslator(), getLocale()]);

  const [plexItems, jellyfinItems, timeZone] = await Promise.all([
    newestDistinctTitles(async (skip, take) =>
      withAddedAt(await prisma.plexLibraryItem.findMany({
        where: { addedAt: { not: null } }, orderBy: RECENT_ORDER, skip, take, select: RECENT_SELECT,
      })),
    ),
    newestDistinctTitles(async (skip, take) =>
      withAddedAt(await prisma.jellyfinLibraryItem.findMany({
        where: { addedAt: { not: null } }, orderBy: RECENT_ORDER, skip, take, select: RECENT_SELECT,
      })),
    ),
    getStatsTimeZone(),
  ]);

  const merged = mergeRecentlyAdded(plexItems, jellyfinItems, t("adminActivity.common.unknownTitle"));
  // The shared lookup (TmdbMediaCore first, then the :details cache), each
  // title in its own media type's namespace.
  const posters = merged.length > 0 ? await resolvePosterMap(merged) : {};
  const items = merged.map((i) => ({ ...i, posterPath: posters[posterPathKey(i.tmdbId, i.mediaType)] ?? null }));
  // The media-activity page 404s for a title nobody has played, so an unplayed
  // tile links to the title page instead.
  const playedRows = items.length > 0
    ? await prisma.playHistory.findMany({
        where: { tmdbId: { in: items.map((i) => i.tmdbId) } },
        distinct: ["tmdbId", "mediaType"],
        select: { tmdbId: true, mediaType: true },
      })
    : [];
  const played = new Set(playedRows.map((r) => `${r.mediaType}:${r.tmdbId}`));

  return (
    <div className="ds-page-enter">
      <PageHeader
        title={t("adminActivity.tab.recentlyAdded")}
        subtitle={
          // items is capped (mergeRecentlyAdded), so this is "the latest N", not a total.
          items.length > 0
            ? t("adminActivity.recent.subtitle", { count: items.length })
            : t("adminActivity.recent.subtitleEmpty")
        }
      />

      <ActivityFilterBar />

      {items.length === 0 ? (
        <EmptyState
          icon={Film}
          title={t("adminActivity.recent.emptyTitle")}
          description={t("adminActivity.recent.emptyDescription")}
          cta={{ href: "/admin/library", label: t("adminActivity.recent.goToLibrary") }}
        />
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          {items.map((item, i) => {
            const activityHref = played.has(`${item.mediaType}:${item.tmdbId}`)
              ? `/admin/activity/media/${item.tmdbId}?type=${item.mediaType}`
              : `/${item.mediaType === "TV" ? "tv" : "movie"}/${item.tmdbId}`;

            return (
              <div key={`${item.mediaType}-${item.tmdbId}-${i}`} className="group">
                <div className="relative aspect-[2/3] bg-zinc-800 rounded-lg overflow-hidden mb-2">
                  {/* The whole tile is the link, poster or not: a fresh instance
                      (or one just after a TMDB cache clear) renders every tile
                      through the fallback branch, and those must stay clickable
                      with the same hover as their postered neighbours. */}
                  <Link href={activityHref} className="block w-full h-full">
                    {item.posterPath ? (
                      <Image
                        src={item.posterPath}
                        alt={item.title}
                        fill
                        className="object-cover group-hover:scale-105 transition-transform duration-200"
                        sizes="(min-width: 1280px) 16vw, (min-width: 768px) 25vw, 50vw"
                      />
                    ) : (
                      <div className="w-full h-full flex flex-col items-center justify-center gap-2 p-3 group-hover:scale-105 transition-transform duration-200">
                        {item.mediaType === "TV" ? (
                          <Tv2 className="w-8 h-8 text-zinc-500" />
                        ) : (
                          <Film className="w-8 h-8 text-zinc-500" />
                        )}
                        <p className="text-zinc-500 text-[10px] text-center leading-tight">{item.title}</p>
                      </div>
                    )}
                  </Link>
                  <div className="absolute top-1.5 right-1.5 flex gap-1 pointer-events-none">
                    {item.sources.plex && <Chip tone="plex">Plex</Chip>}
                    {item.sources.jellyfin && <Chip tone="jellyfin">Jellyfin</Chip>}
                  </div>
                </div>
                <div className="min-w-0">
                  <Link href={activityHref} className="text-xs font-medium text-zinc-100 hover:text-indigo-400 transition-colors truncate block">
                    {item.title}
                  </Link>
                  <p className="text-[10px] text-zinc-500">
                    {item.year && <span>{item.year} · </span>}
                    {relativeWithDateFallback(item.addedAt, locale, timeZone)}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
