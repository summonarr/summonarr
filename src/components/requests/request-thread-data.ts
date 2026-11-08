// How a request's comment thread (request-thread.tsx) reads and merges the
// comments route's answers. Pure and React-free so the unit suite runs it
// directly (tests/issue-thread.test.mts).
import { check, v, type Infer } from "@/lib/validate";

export const CommentSchema = v.object({
  id: v.string(),
  createdAt: v.string(),
  body: v.string(),
  fromAdmin: v.boolean(),
  authorId: v.string(),
  // `email` is selected for request managers only.
  author: v.object({ name: v.nullable(v.string()), email: v.optional(v.nullable(v.string())), role: v.string() }),
});

export type CommentData = Infer<typeof CommentSchema>;

/** One comment, or null when the answer isn't one (a proxy page, a changed shape). */
export function readComment(data: unknown): CommentData | null {
  const r = check(CommentSchema, data);
  return r.ok ? r.value : null;
}

/** The thread's comments; an entry that isn't a comment is left out. */
export function readComments(data: unknown): CommentData[] {
  if (!Array.isArray(data)) return [];
  const out: CommentData[] = [];
  for (const item of data) {
    const c = readComment(item);
    if (c) out.push(c);
  }
  return out;
}

/**
 * A reload's list, plus the viewer's own comments appended since that the
 * list doesn't hold yet: a reload sent before the POST committed answers
 * without them, and must not take a sent comment off the screen. `pending` is
 * the ids appended locally that no server list has held yet.
 */
export function mergeReload(list: CommentData[], prev: CommentData[], pending: ReadonlySet<string>): CommentData[] {
  const seen = new Set(list.map((c) => c.id));
  const kept = prev.filter((c) => pending.has(c.id) && !seen.has(c.id));
  return kept.length === 0 ? list : [...list, ...kept];
}
