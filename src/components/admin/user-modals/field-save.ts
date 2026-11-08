// One field of the user permissions editor, saved the way PATCH
// /api/admin/users/[id] takes it: one field per request, the whole value.
//
// - Saves of one field run ONE AT A TIME, and each sends the field's LATEST
//   value when it starts. A change made while a save is out is never dropped:
//   it goes next, and several changes in that window go as one request. Two
//   requests for one field are never in flight together, so they can't reach
//   the server out of order.
// - A refused save puts the field back to what the server holds, but only
//   while the field still shows the value that was refused. A newer change
//   made meanwhile is kept and sent instead.
// - `settled()` is what closing the editor waits on: it resolves once nothing
//   of this field is in flight or due, false when the last save was refused.
//
// Pure (no React, no imports), so the unit suite drives it directly
// (tests/admin-user-field-save.test.mts).

export interface FieldSaveOptions<T> {
  /** What the server holds when the editor opened. */
  initial: T;
  /** PATCHes `value`; resolves true when the server took it. A rejection counts as refused. */
  send: (value: T) => Promise<boolean>;
  /** After a refusal: the field still shows `sent`, put it back to `saved` (the server's value). */
  revert: (sent: T, saved: T) => void;
  /** Same value, no request. Default Object.is. */
  equals?: (a: T, b: T) => boolean;
}

export interface FieldSave<T> {
  /** The value the admin chose last (what the field shows). */
  readonly value: T;
  /**
   * The admin's new value, already shown. Saved after any save of this field
   * in flight. Resolves true once the server holds the latest value (or there
   * was nothing to save), false when the last save was refused.
   */
  set(value: T): Promise<boolean>;
  /** Resolves when nothing of this field is in flight or due; false when the last save was refused. */
  settled(): Promise<boolean>;
}

export function createFieldSave<T>(opts: FieldSaveOptions<T>): FieldSave<T> {
  const equals = opts.equals ?? Object.is;
  let saved = opts.initial;
  let latest = opts.initial;
  let running: Promise<boolean> | null = null;

  async function drain(): Promise<boolean> {
    let ok = true;
    try {
      while (!equals(latest, saved)) {
        const sent = latest;
        let accepted: boolean;
        try {
          // Always across a tick, even if `send` throws at once: `set` must
          // have stored `running` before this run can end and clear it.
          accepted = await Promise.resolve().then(() => opts.send(sent));
        } catch {
          accepted = false;
        }
        if (accepted) {
          saved = sent;
          ok = true;
          continue;
        }
        ok = false;
        // Refused. Put the field back only while it still shows what was
        // refused; a change made since then goes out on the next turn.
        if (equals(latest, sent)) {
          latest = saved;
          opts.revert(sent, saved);
        }
      }
    } finally {
      running = null;
    }
    return ok;
  }

  return {
    get value() {
      return latest;
    },
    set(value: T): Promise<boolean> {
      latest = value;
      if (running) return running;
      if (equals(latest, saved)) return Promise.resolve(true);
      running = drain();
      return running;
    },
    settled(): Promise<boolean> {
      return running ?? Promise.resolve(true);
    },
  };
}
