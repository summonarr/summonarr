import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma";
import type { TmdbMedia } from "@/lib/tmdb-types";

// Build one `tmdbId IN […]` clause per media type. Postgres can answer this
// from the (tmdbId, mediaType) index; one OR branch per item could not.
// Exported for unit tests.
export function buildMediaTypeWhere(items: TmdbMedia[]): Prisma.MediaRequestWhereInput | null {
  const movieIds = items.filter((i) => i.mediaType === "movie").map((i) => i.id);
  const tvIds = items.filter((i) => i.mediaType === "tv").map((i) => i.id);
  if (movieIds.length === 0 && tvIds.length === 0) return null;
  return {
    OR: [
      ...(movieIds.length ? [{ mediaType: "MOVIE" as const, tmdbId: { in: movieIds } }] : []),
      ...(tvIds.length ? [{ mediaType: "TV" as const, tmdbId: { in: tvIds } }] : []),
    ],
  };
}

type DbMediaType = "MOVIE" | "TV";

// The ONE key for a title in this module: TmdbMedia's own lowercase mediaType
// and the id, `${mediaType}:${id}` — what permanentlyDeclinedKeys hands the
// client, and what the requested sets below are keyed on.
function titleKey(mediaType: TmdbMedia["mediaType"], id: number): string {
  return `${mediaType}:${id}`;
}

function rowKey(row: { tmdbId: number; mediaType: DbMediaType }): string {
  return titleKey(row.mediaType === "MOVIE" ? "movie" : "tv", row.tmdbId);
}

// Two queries, not one selecting requestedBy: the global one is DISTINCT per
// title, so it stays bounded by the page's items however many users asked for
// each, where a merged read would return one row per requester.
export async function attachRequestedStatus(items: TmdbMedia[], userId?: string): Promise<TmdbMedia[]> {
  if (items.length === 0) return items;
  const baseWhere = buildMediaTypeWhere(items);
  if (!baseWhere) return items;

  // Only look at the default instance (arrInstance ""). A request made on a 4K
  // or named instance must not light up the main "requested" flag that the
  // grids and default request buttons use. Detail pages query each instance
  // separately, since each instance has its own requested/pending state.
  const [globalRows, mineRows] = await Promise.all([
    prisma.mediaRequest.findMany({
      where: { status: { not: "DECLINED" }, arrInstance: "", ...baseWhere },
      select: { tmdbId: true, mediaType: true },
      distinct: ["tmdbId", "mediaType"],
    }),
    userId
      ? prisma.mediaRequest.findMany({
          where: { status: { not: "DECLINED" }, requestedBy: userId, arrInstance: "", ...baseWhere },
          select: { tmdbId: true, mediaType: true },
          distinct: ["tmdbId", "mediaType"],
        })
      : Promise.resolve([] as { tmdbId: number; mediaType: DbMediaType }[]),
  ]);

  const globalSet = new Set(globalRows.map(rowKey));
  const mineSet = new Set(mineRows.map(rowKey));

  return items.map((item) => {
    const key = titleKey(item.mediaType, item.id);
    return {
      ...item,
      requested:     globalSet.has(key),
      requestedByMe: mineSet.has(key),
    };
  });
}

// The titles THIS viewer can never re-request on the default instance: their
// PERMANENTLY declined requests (an ordinary decline is re-requestable — the
// request routes drop the stale row and file a fresh one). The collection
// "Request all" button leaves these out; it used to count and send them on
// every visit, and the bulk route answered `skipped-declined` each time.
// Keyed `${mediaType}:${id}` in TmdbMedia's own lowercase mediaType, so a
// client component rebuilds the key from the item it holds. Default instance
// only, like attachRequestedStatus.
export async function permanentlyDeclinedKeys(items: TmdbMedia[], userId: string): Promise<string[]> {
  const baseWhere = buildMediaTypeWhere(items);
  if (!baseWhere) return [];
  const rows = await prisma.mediaRequest.findMany({
    where: { requestedBy: userId, arrInstance: "", permanentlyDeclined: true, ...baseWhere },
    select: { tmdbId: true, mediaType: true },
  });
  return rows.map(rowKey);
}
