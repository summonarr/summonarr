// The "before" cursor of a message thread read (request comments, issue
// messages): `<createdAt-iso>|<id>` of the OLDEST message a client already
// holds, the same shape as the issues list cursor. A read with `before` answers
// the newest page of messages strictly older than it (keyset on createdAt, id),
// in the same oldest-first shape and under the same cap. Zero imports: the
// routes and the thread components both use it.

export interface ThreadCursor {
  createdAt: Date;
  id: string;
}

/** The cursor naming `message`; the client sends it back as `?before=`. */
export function threadCursorOf(message: { createdAt: string | Date; id: string }): string {
  const at = message.createdAt instanceof Date ? message.createdAt.toISOString() : message.createdAt;
  return `${at}|${message.id}`;
}

/** Absent or malformed ⇒ null: the newest page, exactly as before the cursor existed. */
export function parseThreadCursor(raw: string | null): ThreadCursor | null {
  if (!raw) return null;
  const sep = raw.indexOf("|");
  if (sep <= 0) return null;
  const createdAt = new Date(raw.slice(0, sep));
  const id = raw.slice(sep + 1);
  if (!id || Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, id };
}

/** The where-fragment for rows strictly older than the cursor in (createdAt desc, id desc) order; empty without one. */
export function olderThanWhere(cursor: ThreadCursor | null) {
  if (!cursor) return {};
  return { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] };
}
