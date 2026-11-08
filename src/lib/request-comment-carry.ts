// Keeps a request's comment thread when a re-request replaces its DECLINED row.
//
// Re-requesting a non-permanently declined title deletes the old row inside the
// create transaction, to free the unique (tmdbId, mediaType, requestedBy,
// arrInstance) key for the new one. RequestComment cascades with its request, so
// the decline conversation ("declined for now, request again once X") vanished at
// the moment the requester followed it. The three replace paths — request-create.ts
// (web + watchlist auto-request), the bulk route and the Discord pick — therefore
// read the thread here before the delete and write it back onto the new row.
//
// A carried comment is the SAME comment moved, not a new one: id, author, body,
// fromAdmin and createdAt are kept, and nothing is announced (no notification, no
// `request:comment` SSE, no REQUEST_COMMENT audit row — the original audit rows
// stay under the old request id and still name the requester, so the purge finds
// them). Every query here runs on the caller's transaction, one at a time
// (guardrail 23c).
import type { prisma } from "./prisma";

// Typed off the extended client, like account-lifecycle.ts: the encryption
// extension changes the client, so Prisma.TransactionClient doesn't fit.
export type CommentCarryClient = Pick<typeof prisma, "mediaRequest" | "requestComment">;

/**
 * The most comments one replaced request carries: the newest ones, the same
 * number the thread view reads. A comment has no count limit of its own (only
 * the 10-a-minute rate limit), and every carried row is held in memory until
 * the new request exists, so the read is capped. Older comments go with the
 * declined row, as every comment did before this module, and a warning says so.
 */
export const MAX_CARRIED_COMMENTS = 500;

/** The bulk route replaces up to 50 rows in one transaction; this caps the whole call (one warning names every thread it cuts). */
export const MAX_CARRIED_COMMENTS_PER_CALL = 2_000;

/** The CAS a stale row must still match to be replaced (an admin's re-approve or permanent ban wins). */
const STALE_DECLINED = { status: "DECLINED", permanentlyDeclined: false } as const;

export interface CarriedComment {
  id: string;
  createdAt: Date;
  authorId: string;
  body: string;
  fromAdmin: boolean;
}

// The newest `limit` (≥ 1) comments of a stale row the CAS delete is about to
// remove, oldest first, and whether older ones were left behind. The relation
// filter reads exactly the thread the delete destroys. The caller warns.
async function readThread(
  tx: CommentCarryClient,
  requestId: string,
  limit: number,
): Promise<{ thread: CarriedComment[]; cut: boolean }> {
  const rows = await tx.requestComment.findMany({
    where: { requestId, request: STALE_DECLINED },
    select: { id: true, createdAt: true, authorId: true, body: true, fromAdmin: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const cut = rows.length > limit;
  if (cut) rows.length = limit;
  return { thread: rows.reverse(), cut };
}

/**
 * Deletes one stale DECLINED row (CAS on status + permanentlyDeclined, deleteMany
 * so a concurrent double re-request no-ops instead of throwing P2025) and returns
 * the thread to hand to `restoreThread` once the replacement row exists. Empty
 * when there is no stale row or the CAS removed nothing: a row an admin
 * re-approved or banned since keeps its thread, and the create then answers 409.
 */
export async function dropStaleDeclined(tx: CommentCarryClient, staleId: string | null): Promise<CarriedComment[]> {
  if (!staleId) return [];
  const { thread, cut } = await readThread(tx, staleId, MAX_CARRIED_COMMENTS);
  const dropped = await tx.mediaRequest.deleteMany({ where: { id: staleId, ...STALE_DECLINED } });
  if (dropped.count === 0) return [];
  if (cut) {
    console.warn(`[requests] re-request of ${staleId}: kept the newest ${MAX_CARRIED_COMMENTS} comments, older ones were deleted with the declined request`);
  }
  return thread;
}

/**
 * The bulk twin: one deleteMany over every stale row, threads keyed by the OLD
 * request id. A row the CAS left alone has no thread here; the caller restores a
 * thread only onto a row it actually created for the same key (skipDuplicates
 * creates nothing while the old row still holds the key).
 */
export async function dropStaleDeclinedMany(
  tx: CommentCarryClient,
  staleIds: readonly string[],
): Promise<Map<string, CarriedComment[]>> {
  const threads = new Map<string, CarriedComment[]>();
  if (staleIds.length === 0) return threads;
  // Requests whose comments (some or all) go with their row: cut by the per-thread
  // cap, cut by the per-call budget, or never read because the budget ran out.
  const cut: string[] = [];
  let budget = MAX_CARRIED_COMMENTS_PER_CALL;
  let read = 0;
  for (; read < staleIds.length && budget > 0; read++) {
    const id = staleIds[read];
    const r = await readThread(tx, id, Math.min(MAX_CARRIED_COMMENTS, budget));
    budget -= r.thread.length;
    if (r.thread.length > 0) threads.set(id, r.thread);
    if (r.cut) cut.push(id);
  }
  if (read < staleIds.length) {
    // One grouped query (at most one row per stale id) says which unread rows lose a thread.
    const lost = await tx.requestComment.groupBy({
      by: ["requestId"],
      where: { requestId: { in: staleIds.slice(read) }, request: STALE_DECLINED },
    });
    for (const g of lost) cut.push(g.requestId);
  }
  await tx.mediaRequest.deleteMany({ where: { id: { in: [...staleIds] }, ...STALE_DECLINED } });
  // Once per call, never per row.
  if (cut.length > 0) {
    console.warn(
      `[requests] bulk re-request: comments carried up to ${MAX_CARRIED_COMMENTS} per request and ${MAX_CARRIED_COMMENTS_PER_CALL} per call; older comments of ${cut.length} declined request(s) were deleted with them: ${cut.join(", ")}`,
    );
  }
  return threads;
}

/**
 * Writes a carried thread onto the request that replaced its row. One INSERT:
 * at most MAX_CARRIED_COMMENTS rows of six values, far under Postgres's bind
 * limit (guardrail 23c). No query for an empty thread.
 */
export async function restoreThread(
  tx: CommentCarryClient,
  requestId: string,
  thread: readonly CarriedComment[] | undefined,
): Promise<void> {
  if (!thread || thread.length === 0) return;
  await tx.requestComment.createMany({ data: thread.map((c) => ({ ...c, requestId })) });
}
