// What an editor saved for a row, kept until the page's re-read delivers it.
//
// The users page is re-read once when the permissions editor closes, and with
// many users that takes a moment. Until it lands the table row still carries
// the values from BEFORE the edit, and the editor sends whole values (the
// permission mask, the grant maps). Reopened inside that window and seeded
// from the row, it showed the old state, and the next switch sent
// `old | bit` — silently undoing what was just saved.
//
// So the editor remembers what the server took, keyed by the row's id and
// beside the row values it replaced. A reopen is seeded from the remembered
// values only while the row still shows exactly those replaced values; once
// the row changed (the re-read landed, or brought someone else's edit) the
// row wins and the entry is dropped.
//
// Pure (no React, no imports), so the unit suite drives it directly
// (tests/admin-user-saved-fields.test.mts).

export interface SavedFields<T extends object> {
  /** After a save: `base` is the row as the editor was given it, `saved` what the server holds now. */
  remember(id: string, base: T, saved: T): void;
  /** The values to seed an editor from: `row`, or the remembered ones while `row` is still the replaced copy. */
  seed(id: string, row: T): T;
}

const sameValues = (a: object, b: object) => JSON.stringify(a) === JSON.stringify(b);

/** At most `cap` rows are remembered; the oldest entry leaves first. */
export function createSavedFields<T extends object>(cap = 50): SavedFields<T> {
  const entries = new Map<string, { base: T; saved: T }>();
  return {
    remember(id, base, saved) {
      entries.delete(id);
      // Nothing differs: the row already shows what the server holds.
      if (sameValues(base, saved)) return;
      entries.set(id, { base, saved });
      while (entries.size > cap) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    },
    seed(id, row) {
      const entry = entries.get(id);
      if (!entry) return row;
      if (sameValues(row, entry.base)) return entry.saved;
      entries.delete(id);
      return row;
    },
  };
}
