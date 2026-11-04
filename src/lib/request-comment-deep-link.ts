import "server-only";
import type { Prisma } from "@/generated/prisma";
import { prisma } from "./prisma";

// A comment notification links to /requests?comments=<id> (the requester) or
// /admin?comments=<id> (the queue). Both pages only open the thread of a row on
// the page they render, so a request outside the first page needs its page
// found and the link sent there. These helpers answer "which page" under the
// page's OWN filter and order, so the visibility rule is the page's: the
// requester's `where` holds only their requests, the queue's every request.

export type SortDir = "asc" | "desc";

// A request id is a cuid; anything else can't name a row, so it costs no query.
const REQUEST_ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The request a page should locate for this URL, or null. Only the ARRIVAL
 * from a comment link locates: those links never carry `page`, and the
 * redirect always sets one. Both pages live-refresh on request events, and a
 * refresh re-renders the server page at the same URL, so without this a new
 * request that pushed the target off the page would move the viewer to
 * another page in the middle of their work.
 */
export function commentLinkToLocate(
  page: string | string[] | undefined,
  comments: string | string[] | undefined,
): string | null {
  if (page !== undefined) return null;
  const id = Array.isArray(comments) ? comments[0] : comments;
  return id || null;
}

export function pageForIndex(index: number, pageSize: number): number {
  return Math.floor(index / pageSize) + 1;
}

/**
 * The requester list's order. The id breaks createdAt ties so every row has
 * exactly one position: with ties, Postgres may order them differently for
 * different OFFSETs, and the counted page would not be the page that holds it.
 */
export function ownRequestsOrderBy(dir: SortDir): Prisma.MediaRequestOrderByWithRelationInput[] {
  return [{ createdAt: dir }, { id: dir }];
}

/** The rows that sort strictly before `target` under ownRequestsOrderBy(dir). */
export function rowsBeforeRequest(target: { id: string; createdAt: Date }, dir: SortDir): Prisma.MediaRequestWhereInput {
  return dir === "desc"
    ? { OR: [{ createdAt: { gt: target.createdAt } }, { createdAt: target.createdAt, id: { gt: target.id } }] }
    : { OR: [{ createdAt: { lt: target.createdAt } }, { createdAt: target.createdAt, id: { lt: target.id } }] };
}

/**
 * The page of the requester list (`where`, ordered by ownRequestsOrderBy(dir))
 * that holds `requestId`, or null when no row of `where` has that id (another
 * user's request, or one the current filter excludes).
 */
export async function ownRequestCommentPage(
  where: Prisma.MediaRequestWhereInput,
  requestId: string,
  dir: SortDir,
  pageSize: number,
): Promise<number | null> {
  if (!REQUEST_ID_SHAPE.test(requestId)) return null;
  const target = await prisma.mediaRequest.findFirst({
    where: { AND: [where, { id: requestId }] },
    select: { id: true, createdAt: true },
  });
  if (!target) return null;
  const before = await prisma.mediaRequest.count({ where: { AND: [where, rowsBeforeRequest(target, dir)] } });
  return pageForIndex(before, pageSize);
}

/**
 * The page of the request queue that holds `requestId`'s title group, or null
 * when no request of `where` has that id. `where` and `groupOrderBy` must be the
 * queue's paging query's own, so the group's index here IS its position there.
 * It reads every group key under the filter: only a link to a request that
 * isn't on the rendered page pays for that.
 */
export async function queueCommentPage(
  where: Prisma.MediaRequestWhereInput,
  groupOrderBy: Prisma.MediaRequestOrderByWithAggregationInput[],
  requestId: string,
  pageSize: number,
): Promise<number | null> {
  if (!REQUEST_ID_SHAPE.test(requestId)) return null;
  const target = await prisma.mediaRequest.findFirst({
    where: { AND: [where, { id: requestId }] },
    select: { tmdbId: true, mediaType: true },
  });
  if (!target) return null;
  const groups = await prisma.mediaRequest.groupBy({
    by: ["tmdbId", "mediaType"],
    where,
    orderBy: groupOrderBy,
  });
  const index = groups.findIndex((g) => g.tmdbId === target.tmdbId && g.mediaType === target.mediaType);
  return index < 0 ? null : pageForIndex(index, pageSize);
}
