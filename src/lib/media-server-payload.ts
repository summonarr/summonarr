// Lenient field schemas for Plex and Jellyfin payloads, built on the shared
// validator (validate.ts).
//
// A media server's JSON is checked at the boundary, but ITEM fields are read
// leniently on purpose: one oddly typed field (a numeric `year` sent as a
// string, a `ratingKey` sent as a number) must cost that field, never the
// title. A strict `v.object` would drop the whole item, and a dropped title
// reads as "not in the library" to the sync, the never-watched report and the
// availability badges. So:
//   - an ENVELOPE (MediaContainer, Items, the Sessions array) is strict: a
//     wrong shape there is a failed read, exactly like a non-2xx;
//   - an item FIELD is `loose`: the wrong type reads as absent;
//   - a LIST inside an item is `looseList`: a non-array reads as absent and a
//     malformed entry is dropped, the rest kept.
// `v.object` keeps only the declared keys, so a checked item also holds far
// less than the raw record a large library page carried.
//
// Imports only the zero-import validator, so plex/jellyfin stay DB-free.
import { typeName, v, type Infer, type OptionalSchema, type Schema } from "./validate";

/** A field whose wrong type reads as absent instead of failing the item. */
export function loose<T>(inner: Schema<T>): OptionalSchema<T> {
  return {
    expected: `${inner.expected} | undefined`,
    optional: true,
    run: (value, depth) => {
      // An absent field is the common case: skip building a failure for it.
      if (value === undefined) return { ok: true, value: undefined };
      const r = inner.run(value, depth);
      return r.ok ? r : { ok: true, value: undefined };
    },
  };
}

/**
 * A list field: a non-array reads as absent; entries that fail `item` are
 * dropped and the rest kept, in order.
 */
export function looseList<S extends Schema<unknown>>(item: S): OptionalSchema<Infer<S>[]> {
  return {
    expected: `${item.expected}[] | undefined`,
    optional: true,
    run: (value, depth) => {
      if (!Array.isArray(value)) return { ok: true, value: undefined };
      const out: Infer<S>[] = [];
      for (const entry of value) {
        const r = item.run(entry, depth + 1);
        if (r.ok) out.push(r.value as Infer<S>);
      }
      return { ok: true, value: out };
    },
  };
}

/**
 * An upstream identifier (a Plex ratingKey, a user id): a non-empty string,
 * or a safe integer read as its decimal string. Plex sends most keys as
 * strings and some as numbers.
 */
export const idKey: Schema<string> = {
  expected: "non-empty string | integer",
  run: (value) => {
    if (typeof value === "string" && value !== "") return { ok: true, value };
    if (typeof value === "number" && Number.isSafeInteger(value)) return { ok: true, value: String(value) };
    return { ok: false, path: [], message: `expected non-empty string | integer, got ${typeName(value)}` };
  },
};

/** A finite number or a numeric string, read as a number. */
export const numberish: Schema<number> = {
  expected: "number | numeric string",
  run: (value) => {
    const n = typeof value === "number" ? value : typeof value === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(value) ? Number(value) : NaN;
    return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, path: [], message: "expected number | numeric string" };
  },
};

/** The plain object a value is, or null — for records read field by field. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** `loose(v.string())`, the commonest item field. */
export const looseString = (): OptionalSchema<string> => loose(v.string());

/** The entries of a list that pass `item`, in order; the rest are dropped. */
export function parseEach<T>(item: Schema<T>, list: readonly unknown[]): T[] {
  const out: T[] = [];
  for (const entry of list) {
    const r = item.run(entry, 0);
    if (r.ok) out.push(r.value);
  }
  return out;
}

// What a page callback returns to end a paged walk early. Anything else (or
// nothing) reads the next page. One spelling for both clients' pagers.
export const STOP_PAGING = "stop";
export type PageControl = typeof STOP_PAGING | void;

/**
 * An object of string values (Jellyfin's ProviderIds): the string entries are
 * kept and any other value is dropped, so one provider sent as null never
 * costs the item its other ids.
 */
export const stringRecord: Schema<Record<string, string>> = {
  expected: "object",
  run: (value) => {
    const o = asRecord(value);
    if (!o) return { ok: false, path: [], message: `expected object, got ${typeName(value)}` };
    const out: Record<string, string> = {};
    for (const key of Object.keys(o)) {
      const entry = o[key];
      // Defined, never assigned: `out["__proto__"] = x` would set the prototype.
      if (typeof entry === "string") Object.defineProperty(out, key, { value: entry, enumerable: true, writable: true, configurable: true });
    }
    return { ok: true, value: out };
  },
};
