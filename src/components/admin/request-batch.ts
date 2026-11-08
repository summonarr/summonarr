// The admin request queue's batch bookkeeping (admin-request-list.tsx): which
// ids are pending, which selected ids a page can still judge, how a run's
// chunks add up, and what is left to say when it ends. Pure — no React, no
// fetch — so the unit suite drives it directly (tests/admin-request-batch.test.mts).
// The approve/decline itself is PATCH /api/requests/batch; the one request
// state machine stays on the server (request-transition.ts).

import { v } from "@/lib/validate";

/** /api/requests/batch refuses more ids than this per call. */
export const BATCH_ID_CAP = 100;

interface GroupLike {
  title: string;
  requesters: readonly { requestId: string; status: string }[];
}

/** The PENDING request ids of one title's group. */
export function pendingIdsFor(group: Pick<GroupLike, "requesters">): string[] {
  return group.requesters.filter((r) => r.status === "PENDING").map((r) => r.requestId);
}

/** Every PENDING request id on the page. */
export function pendingIdsOf(groups: readonly Pick<GroupLike, "requesters">[]): string[] {
  return groups.flatMap(pendingIdsFor);
}

/**
 * The selection minus the ids this page shows as no longer PENDING (another
 * admin decided them, the owner deleted them). An id missing from the page may
 * be on another page — selecting across pages is allowed — so it is kept. The
 * same set comes back when nothing changed, so a state update is a no-op.
 */
export function pruneSelection(
  prev: ReadonlySet<string>,
  groups: readonly Pick<GroupLike, "requesters">[],
): ReadonlySet<string> {
  const onPage = new Set(groups.flatMap((g) => g.requesters.map((r) => r.requestId)));
  const pending = new Set(pendingIdsOf(groups));
  const next = new Set([...prev].filter((id) => !onPage.has(id) || pending.has(id)));
  return next.size === prev.size ? prev : next;
}

/** How many selected ids this page doesn't show (the batch bar names them). */
export function offPageCount(selected: ReadonlySet<string>, groups: readonly Pick<GroupLike, "requesters">[]): number {
  const onPage = new Set(groups.flatMap((g) => g.requesters.map((r) => r.requestId)));
  let n = 0;
  for (const id of selected) if (!onPage.has(id)) n++;
  return n;
}

/** `ids` in calls of at most `cap`, in order. */
export function idChunks(ids: readonly string[], cap = BATCH_ID_CAP): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += cap) out.push(ids.slice(i, i + cap));
  return out;
}

/**
 * A chunk's 200: `failed` lists the rows whose Radarr/Sonarr push definitely
 * failed (rolled back to PENDING — they stay selected for another try),
 * `arrError` is its one-line summary, and `outcomeUnknown` the ids whose add
 * got no answer and that stay APPROVED. Each is absent when empty.
 */
export const BatchAnswer = v.object({
  ok: v.optional(v.boolean()),
  arrError: v.optional(v.string()),
  failed: v.optional(
    v.array(
      v.object({
        id: v.string(),
        title: v.optional(v.nullable(v.string())),
        error: v.optional(v.nullable(v.string())),
      }),
    ),
  ),
  outcomeUnknown: v.optional(v.array(v.string())),
});

export interface BatchAnswerData {
  arrError?: string;
  failed?: readonly { id: string }[];
  outcomeUnknown?: readonly string[];
}

/** What a run has learned so far, chunk by chunk. */
export interface BatchProgress {
  /** Ids in chunks the route answered. */
  answered: readonly string[];
  /** Answered ids that stay selected: their push failed and they are PENDING again. */
  keep: readonly string[];
  /** Every chunk's push-failure summary, once each, in order. */
  arrErrors: readonly string[];
  /** Ids whose push got no answer; they stay APPROVED. */
  outcomeUnknown: readonly string[];
}

export const NO_PROGRESS: BatchProgress = { answered: [], keep: [], arrErrors: [], outcomeUnknown: [] };

/** The run after one chunk the route answered. */
export function recordChunk(p: BatchProgress, chunk: readonly string[], answer: BatchAnswerData): BatchProgress {
  const arrErrors = answer.arrError && !p.arrErrors.includes(answer.arrError) ? [...p.arrErrors, answer.arrError] : p.arrErrors;
  return {
    answered: [...p.answered, ...chunk],
    keep: [...p.keep, ...(answer.failed ?? []).map((f) => f.id)],
    arrErrors,
    outcomeUnknown: [...p.outcomeUnknown, ...(answer.outcomeUnknown ?? [])],
  };
}

/** The ids the run settled: answered, and not kept for another try. */
export function settledIds(p: BatchProgress): string[] {
  const keep = new Set(p.keep);
  return p.answered.filter((id) => !keep.has(id));
}

/**
 * The bar's error line: every chunk's push failures (those rows stay selected,
 * so their reasons stay on screen), then whatever stopped the run. One line
 * each; null when there is nothing to say.
 */
export function batchErrorText(p: BatchProgress, stop: string | null): string | null {
  const lines = stop === null ? [...p.arrErrors] : [...p.arrErrors, stop];
  return lines.length > 0 ? lines.join("\n") : null;
}

/** The titles on this page for `ids` (once each), and how many ids it doesn't show. */
export function titlesFor(ids: readonly string[], groups: readonly GroupLike[]): { titles: string[]; unknown: number } {
  const titleOf = new Map<string, string>();
  for (const g of groups) for (const r of g.requesters) titleOf.set(r.requestId, g.title);
  const titles = new Set<string>();
  let unknown = 0;
  for (const id of ids) {
    const title = titleOf.get(id);
    if (title === undefined) unknown++;
    else titles.add(title);
  }
  return { titles: [...titles], unknown };
}
