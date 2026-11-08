// A runtime shape check for data from outside the process: fetch bodies,
// upstream API payloads, JSON.parse of a stored blob. `res.json() as T` trusts
// whatever arrived; a check says what arrived instead, and its result type is
// inferred from the schema, so the call site needs no cast.
//
//   const Movie = v.object({ id: v.int(), title: v.string(), year: v.nullable(v.int()) });
//   const parsed = check(Movie, body);
//   if (!parsed.ok) return fail(parsed.error);   // "year: expected integer, got string"
//   parsed.value.title;                          // string
//
// Rules a caller can rely on:
// - `v.object` RETURNS A NEW OBJECT holding only the declared keys. Unknown
//   extra keys never fail a check, and are dropped from the result, so a
//   checked value can be spread into a write without carrying fields nobody
//   declared. Only OWN properties count: an inherited `constructor` is not a
//   value. An optional key that is absent stays absent.
// - `v.record` copies every own key, `__proto__` included, as a plain own
//   property: a payload can't reach any prototype through it.
// - The first failure ends the check, and its message names the path
//   (`items[3].tmdbId: expected number, got string`) and the TYPE that arrived,
//   never the value (a payload can carry secrets or megabytes).
// - Work is linear in the payload, and recursion follows the SCHEMA, never
//   the payload: there is no recursive schema, so a hostile payload can't
//   deepen it. MAX_DEPTH backs that up. The path is only built on failure.
//
// Zero imports, so the browser bundle, the server and the unit suite all load
// it as is (tests/validate.test.mts).

type PathSegment = string | number;

/** Internal outcome of one check; `path` is collected innermost-first on the way out. */
type Outcome<T> =
  | { ok: true; value: T }
  | { ok: false; path: PathSegment[]; message: string };

export interface Schema<T> {
  /** What this schema accepts, for messages ("number", "array", `"movie" | "tv"`). */
  readonly expected: string;
  /** Checks `value`; `depth` is how many containers enclose it. Call `check`, not this. */
  readonly run: (value: unknown, depth: number) => Outcome<T>;
}

/** A schema whose key may be absent from an object (built by `v.optional`). */
export interface OptionalSchema<T> extends Schema<T | undefined> {
  readonly optional: true;
}

/** The type a schema accepts. */
export type Infer<S> = S extends Schema<infer T> ? T : never;

type Shape = Record<string, Schema<unknown>>;
type OptionalKeys<S extends Shape> = { [K in keyof S]: S[K] extends { readonly optional: true } ? K : never }[keyof S];
type RequiredKeys<S extends Shape> = Exclude<keyof S, OptionalKeys<S>>;
type Simplify<T> = { [K in keyof T]: T[K] } & {};
export type InferObject<S extends Shape> = Simplify<
  { [K in RequiredKeys<S>]: Infer<S[K]> } & { [K in OptionalKeys<S>]?: Infer<S[K]> }
>;

type Literal = string | number | boolean | null;

export type CheckResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Containers nested deeper than this fail the check. A schema this deep is a bug of its own. */
export const MAX_DEPTH = 64;

const hasOwn = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);

/** The type name a message reports for what arrived — never the value itself. */
export function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  return typeof value;
}

function fail(expected: string, value: unknown): { ok: false; path: PathSegment[]; message: string } {
  return { ok: false, path: [], message: `expected ${expected}, got ${typeName(value)}` };
}

function leaf<T>(expected: string, test: (value: unknown) => value is T): Schema<T> {
  return {
    expected,
    run: (value) => (test(value) ? { ok: true, value } : fail(expected, value)),
  };
}

function tooDeep(): { ok: false; path: PathSegment[]; message: string } {
  return { ok: false, path: [], message: `nested deeper than ${MAX_DEPTH}` };
}

const isRecordLike = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const MAX_KEY_SHOWN = 64;

function formatPath(innermostFirst: PathSegment[]): string {
  let out = "";
  for (let i = innermostFirst.length - 1; i >= 0; i--) {
    const seg = innermostFirst[i];
    if (typeof seg === "number") out += `[${seg}]`;
    else if (seg.length <= MAX_KEY_SHOWN && IDENTIFIER.test(seg)) out += out === "" ? seg : `.${seg}`;
    // A record key is payload text: quoted, and cut short.
    else out += `[${JSON.stringify(seg.length > MAX_KEY_SHOWN ? `${seg.slice(0, MAX_KEY_SHOWN)}…` : seg)}]`;
  }
  return out;
}

export const v = {
  string: (): Schema<string> => leaf("string", (x): x is string => typeof x === "string"),

  /** A finite number: NaN and ±Infinity fail. */
  number: (): Schema<number> =>
    leaf("number", (x): x is number => typeof x === "number" && Number.isFinite(x)),

  /** A safe integer (|n| ≤ 2^53 − 1), so an id survives arithmetic and comparison. */
  int: (): Schema<number> => leaf("integer", (x): x is number => Number.isSafeInteger(x)),

  boolean: (): Schema<boolean> => leaf("boolean", (x): x is boolean => typeof x === "boolean"),

  /** Exactly one of `values` (compared with ===). */
  literal: <const L extends readonly Literal[]>(...values: L): Schema<L[number]> => {
    const allowed = new Set<unknown>(values);
    return leaf(
      values.map((x) => JSON.stringify(x)).join(" | ") || "never",
      (x): x is L[number] => allowed.has(x),
    );
  },

  /** Anything at all, as is. Narrow it yourself before it drives logic. */
  unknown: (): Schema<unknown> => ({ expected: "anything", run: (value) => ({ ok: true, value }) }),

  /** `T | null`. */
  nullable: <T>(inner: Schema<T>): Schema<T | null> => ({
    expected: `${inner.expected} | null`,
    run: (value, depth) => (value === null ? { ok: true, value: null } : inner.run(value, depth)),
  }),

  /** `T | undefined`; as an object field, the key may be absent. */
  optional: <T>(inner: Schema<T>): OptionalSchema<T> => ({
    expected: `${inner.expected} | undefined`,
    optional: true,
    run: (value, depth) => (value === undefined ? { ok: true, value: undefined } : inner.run(value, depth)),
  }),

  /** An array whose every element passes `item`. */
  array: <S extends Schema<unknown>>(item: S): Schema<Infer<S>[]> => ({
    expected: "array",
    run: (value, depth) => {
      if (!Array.isArray(value)) return fail("array", value);
      if (depth >= MAX_DEPTH) return tooDeep();
      const out: Infer<S>[] = new Array(value.length);
      for (let i = 0; i < value.length; i++) {
        const r = item.run(value[i], depth + 1);
        if (!r.ok) {
          r.path.push(i);
          return r;
        }
        out[i] = r.value as Infer<S>;
      }
      return { ok: true, value: out };
    },
  }),

  /** A non-array object with the declared keys. Extra keys pass and are dropped from the result. */
  object: <S extends Shape>(shape: S): Schema<InferObject<S>> => {
    const keys = Object.keys(shape);
    return {
      expected: "object",
      run: (value, depth) => {
        if (!isRecordLike(value)) return fail("object", value);
        if (depth >= MAX_DEPTH) return tooDeep();
        const out: Record<string, unknown> = {};
        for (const key of keys) {
          const present = hasOwn(value, key);
          const r = shape[key].run(present ? value[key] : undefined, depth + 1);
          if (!r.ok) {
            r.path.push(key);
            return r;
          }
          if (present || r.value !== undefined) out[key] = r.value;
        }
        return { ok: true, value: out as InferObject<S> };
      },
    };
  },

  /** A non-array object whose every own value passes `item`, keyed by any string. */
  record: <S extends Schema<unknown>>(item: S): Schema<Record<string, Infer<S>>> => ({
    expected: "object",
    run: (value, depth) => {
      if (!isRecordLike(value)) return fail("object", value);
      if (depth >= MAX_DEPTH) return tooDeep();
      const out: Record<string, Infer<S>> = {};
      for (const key of Object.keys(value)) {
        const r = item.run(value[key], depth + 1);
        if (!r.ok) {
          r.path.push(key);
          return r;
        }
        // Defined, never assigned: `out["__proto__"] = x` would set the prototype.
        Object.defineProperty(out, key, { value: r.value, enumerable: true, writable: true, configurable: true });
      }
      return { ok: true, value: out };
    },
  }),

  /** The first of `options` that passes. On no match, the message lists what each expected. */
  union: <S extends readonly Schema<unknown>[]>(...options: S): Schema<Infer<S[number]>> => {
    const expected = options.map((o) => o.expected).join(" | ") || "never";
    return {
      expected,
      run: (value, depth) => {
        for (const option of options) {
          const r = option.run(value, depth);
          if (r.ok) return r as Outcome<Infer<S[number]>>;
        }
        return fail(expected, value);
      },
    };
  },
};

/**
 * Check `value` against `schema`. Never throws. On success `value` is the
 * checked copy (objects keep only their declared keys); on failure `error`
 * names the path and what was expected.
 */
export function check<S extends Schema<unknown>>(schema: S, value: unknown): CheckResult<Infer<S>> {
  const r = schema.run(value, 0);
  if (r.ok) return { ok: true, value: r.value as Infer<S> };
  const path = formatPath(r.path);
  return { ok: false, error: path ? `${path}: ${r.message}` : r.message };
}
