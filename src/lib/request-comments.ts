// Pure, zero-import rules for request comment threads (RequestComment): who may
// read or post, when a thread is closed to its requester, and who a new comment
// is announced to. Everything with I/O lives in request-comments-data.ts and
// request-comment-notify.ts.

/** Server cap on a comment body (the column is VarChar(2000)). */
export const COMMENT_MAX_CHARS = 2000;

export interface CommentViewer {
  /** Holds MANAGE_REQUESTS (the ADMIN superbit included). */
  isManager: boolean;
  /** The viewer is the user the request belongs to. */
  isRequester: boolean;
}

export interface CommentRequestState {
  permanentlyDeclined: boolean;
}

/** A thread is private to the requester and the people who manage requests. */
export function canReadThread(v: CommentViewer): boolean {
  return v.isManager || v.isRequester;
}

export type PostVerdict = { ok: true } | { ok: false; reason: "forbidden" | "closed" };

/**
 * Managers can always post — a closing note on a finished request is part of
 * the job. The requester is shut out of a permanently declined request: the
 * decision is final, and a thread would only invite pestering.
 */
export function canPostComment(v: CommentViewer, req: CommentRequestState): PostVerdict {
  if (!canReadThread(v)) return { ok: false, reason: "forbidden" };
  if (v.isManager) return { ok: true };
  if (req.permanentlyDeclined) return { ok: false, reason: "closed" };
  return { ok: true };
}

export type CommentAudience =
  /** A manager commented: tell the requester. */
  | { to: "requester" }
  /** The requester commented: tell every other manager. */
  | { to: "managers" }
  /** Nobody to tell (a manager commenting on their own request). */
  | { to: "none" };

/**
 * Who hears about a new comment. `authorIsManager` is the same MANAGE_REQUESTS
 * check that sets `fromAdmin`. A manager commenting on a request they filed
 * themselves has no one else to notify; their fellow managers are not told of
 * manager-to-manager chatter on a request nobody else owns.
 */
export function commentAudience(a: { authorIsManager: boolean; authorIsRequester: boolean }): CommentAudience {
  if (a.authorIsManager && !a.authorIsRequester) return { to: "requester" };
  if (a.authorIsRequester) return { to: "managers" };
  return { to: "none" };
}

/** Trims and validates a posted body. Returns the cleaned text or an error code. */
export function parseCommentBody(raw: unknown): { ok: true; text: string } | { ok: false; error: "required" | "too-long" } {
  // Parsed JSON is not type-checked at runtime: a number/object/null body must
  // be a 400, not a thrown .trim().
  if (typeof raw !== "string") return { ok: false, error: "required" };
  const text = raw.trim();
  if (!text) return { ok: false, error: "required" };
  if (text.length > COMMENT_MAX_CHARS) return { ok: false, error: "too-long" };
  return { ok: true, text };
}
