// The runtime shape check for data from outside the process
// (src/lib/validate.ts): what each builder accepts, the path a failure names,
// what a checked object keeps, the depth bound, linear work over a big array,
// and — as compile-time assertions both typecheckers run — the inferred types.
import { test } from "node:test";
import assert from "node:assert/strict";
import { check, v, MAX_DEPTH, typeName, type Infer, type Schema } from "../src/lib/validate.ts";

// Messages are built only on failure: a payload here can be 200k elements or 100k levels deep.
const ok = <S extends Schema<unknown>>(s: S, value: unknown): Infer<S> => {
  const r = check(s, value);
  if (!r.ok) assert.fail(`expected a pass, got: ${r.error}`);
  return r.value;
};
const err = (s: Schema<unknown>, value: unknown): string => {
  const r = check(s, value);
  if (r.ok) assert.fail("expected a failure");
  return r.error;
};

// ── type-level assertions (checked by `npm run typecheck` and `typecheck:classic`) ──

type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends (<X>() => X extends B ? 1 : 2) ? true : false;
const assertType = <T extends true>(_: T) => {};

const Item = v.object({
  tmdbId: v.int(),
  title: v.string(),
  year: v.nullable(v.int()),
  note: v.optional(v.string()),
  kind: v.literal("movie", "tv"),
  tags: v.array(v.string()),
  extra: v.record(v.boolean()),
  either: v.union(v.string(), v.number()),
  raw: v.unknown(),
});
type ItemT = Infer<typeof Item>;
assertType<Equal<ItemT, {
  tmdbId: number;
  title: string;
  year: number | null;
  note?: string | undefined;
  kind: "movie" | "tv";
  tags: string[];
  extra: Record<string, boolean>;
  either: string | number;
  raw: unknown;
}>>(true);
assertType<Equal<Infer<ReturnType<typeof v.literal<[1, true, null]>>>, 1 | true | null>>(true);
assertType<Equal<Infer<ReturnType<typeof v.array<typeof Item>>>, ItemT[]>>(true);

test("the checked value is typed from the schema with no cast at the call site", () => {
  const r = check(Item, {
    tmdbId: 603, title: "The Matrix", year: 1999, kind: "movie", tags: ["sf"], extra: { hd: true }, either: 1, raw: [1],
  });
  assert.ok(r.ok);
  const title: string = r.value.title;
  const note: string | undefined = r.value.note;
  // @ts-expect-error — `year` may be null
  const year: number = r.value.year;
  assert.equal(title, "The Matrix");
  assert.equal(note, undefined);
  assert.equal(year, 1999);
});

// ── leaves ───────────────────────────────────────────────────────────────────

test("string, boolean and unknown accept exactly their type", () => {
  assert.equal(ok(v.string(), ""), "");
  assert.equal(err(v.string(), 1), "expected string, got number");
  assert.equal(ok(v.boolean(), false), false);
  assert.equal(err(v.boolean(), "true"), "expected boolean, got string");
  assert.equal(err(v.boolean(), 0), "expected boolean, got number");
  const anything = { a: 1 };
  assert.equal(ok(v.unknown(), anything), anything, "unknown hands the value back as is");
  assert.equal(ok(v.unknown(), undefined), undefined);
});

test("number is finite; int is a safe integer", () => {
  assert.equal(ok(v.number(), 1.5), 1.5);
  assert.equal(err(v.number(), Number.NaN), "expected number, got NaN");
  assert.equal(err(v.number(), Number.POSITIVE_INFINITY), "expected number, got Infinity");
  assert.equal(err(v.number(), "1"), "expected number, got string");
  assert.equal(ok(v.int(), -3), -3);
  assert.equal(ok(v.int(), Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  assert.equal(err(v.int(), 1.5), "expected integer, got number");
  assert.equal(err(v.int(), 2 ** 60), "expected integer, got number", "an unsafe integer can't be an id");
  assert.equal(err(v.int(), null), "expected integer, got null");
});

test("literal accepts only the listed values, compared strictly", () => {
  const kind = v.literal("movie", "tv");
  assert.equal(ok(kind, "tv"), "tv");
  assert.equal(err(kind, "show"), 'expected "movie" | "tv", got string');
  assert.equal(err(v.literal(1), "1"), "expected 1, got string");
  assert.equal(ok(v.literal(null), null), null);
  assert.equal(err(v.literal(), "x"), "expected never, got string");
});

test("nullable admits null, optional admits undefined, and neither admits the other", () => {
  assert.equal(ok(v.nullable(v.string()), null), null);
  assert.equal(err(v.nullable(v.string()), undefined), "expected string, got undefined");
  assert.equal(ok(v.optional(v.string()), undefined), undefined);
  assert.equal(err(v.optional(v.string()), null), "expected string, got null");
  assert.equal(ok(v.optional(v.nullable(v.int())), null), null);
});

// ── objects ──────────────────────────────────────────────────────────────────

test("an object keeps only its declared keys, and extra keys never fail it", () => {
  const User = v.object({ id: v.string(), admin: v.boolean() });
  const input = { id: "u1", admin: false, passwordHash: "x", role: "ADMIN" };
  const out = ok(User, input);
  assert.deepEqual(out, { id: "u1", admin: false });
  assert.notEqual(out, input, "a new object, so a spread can't carry undeclared fields");
  assert.deepEqual(Object.keys(out), ["id", "admin"]);
});

test("an absent optional key stays absent; a present one is kept", () => {
  const S = v.object({ a: v.optional(v.string()), b: v.optional(v.string()) });
  const out = ok(S, { b: "x" });
  assert.equal("a" in out, false);
  assert.deepEqual(out, { b: "x" });
});

test("only own properties are values: an inherited key reads as missing", () => {
  const S = v.object({ constructor: v.unknown(), toString: v.optional(v.unknown()) });
  const out = ok(S, {});
  assert.equal(Object.prototype.hasOwnProperty.call(out, "constructor"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(out, "toString"), false);
  assert.equal(err(v.object({ valueOf: v.string() }), {}), "valueOf: expected string, got undefined");
});

test("an object rejects arrays, null and primitives", () => {
  const S = v.object({});
  assert.equal(err(S, []), "expected object, got array");
  assert.equal(err(S, null), "expected object, got null");
  assert.equal(err(S, "{}"), "expected object, got string");
  assert.deepEqual(ok(S, { any: 1 }), {});
});

test("a required key that is missing fails with its name", () => {
  assert.equal(err(v.object({ id: v.int() }), {}), "id: expected integer, got undefined");
});

// ── arrays, records, unions and paths ────────────────────────────────────────

test("a failure names the path to it", () => {
  const S = v.object({ items: v.array(v.object({ tmdbId: v.number() })) });
  assert.equal(
    err(S, { items: [{ tmdbId: 1 }, { tmdbId: 2 }, { tmdbId: 3 }, { tmdbId: "4" }] }),
    "items[3].tmdbId: expected number, got string",
  );
  assert.equal(err(v.array(v.array(v.int())), [[1], [2, "x"]]), "[1][1]: expected integer, got string");
  assert.equal(err(v.array(v.string()), {}), "expected array, got object");
});

test("a record key that isn't an identifier is quoted, and a long one cut short", () => {
  const S = v.object({ byName: v.record(v.int()) });
  assert.equal(err(S, { byName: { "two words": "x" } }), 'byName["two words"]: expected integer, got string');
  const long = "k".repeat(200);
  const message = err(S, { byName: { [long]: "x" } });
  assert.ok(message.length < 120, message);
  assert.ok(message.includes("…"));
});

test("a failure message carries the type that arrived, never the value", () => {
  const secret = "apikey=0123456789abcdef";
  const message = err(v.object({ n: v.number() }), { n: secret });
  assert.equal(message.includes(secret), false);
  assert.equal(typeName([]), "array");
  assert.equal(typeName(undefined), "undefined");
});

test("a record copies every own key as a plain property — __proto__ included — and pollutes nothing", () => {
  const parsed = JSON.parse('{"__proto__": {"polluted": true}, "a": {"polluted": false}}') as unknown;
  const out = ok(v.record(v.object({ polluted: v.boolean() })), parsed);
  assert.equal(Object.getPrototypeOf(out), Object.prototype, "the result's prototype is untouched");
  assert.deepEqual(Object.keys(out), ["__proto__", "a"]);
  assert.deepEqual(Object.getOwnPropertyDescriptor(out, "__proto__")?.value, { polluted: true });
  assert.equal(({} as { polluted?: unknown }).polluted, undefined);
  assert.equal(err(v.record(v.int()), ["1"]), "expected object, got array");
});

test("a union takes the first option that passes, and lists every option when none does", () => {
  const S = v.union(v.literal("all"), v.array(v.int()));
  assert.equal(ok(S, "all"), "all");
  assert.deepEqual(ok(S, [1, 2]), [1, 2]);
  assert.equal(err(S, "some"), 'expected "all" | array, got string');
  // The passing option's own result is kept, so an object option still strips.
  assert.deepEqual(ok(v.union(v.object({ a: v.int() }), v.string()), { a: 1, b: 2 }), { a: 1 });
  assert.equal(err(v.union(), 1), "expected never, got number");
});

// ── bounds ───────────────────────────────────────────────────────────────────

function nested(depth: number): Schema<unknown> {
  let s: Schema<unknown> = v.int();
  for (let i = 0; i < depth; i++) s = v.array(s);
  return s;
}
function nestedValue(depth: number): unknown {
  let x: unknown = 1;
  for (let i = 0; i < depth; i++) x = [x];
  return x;
}

test("containers nest at most MAX_DEPTH deep", () => {
  assert.equal(ok(nested(MAX_DEPTH), nestedValue(MAX_DEPTH)) !== undefined, true);
  const message = err(nested(MAX_DEPTH + 1), nestedValue(MAX_DEPTH + 1));
  assert.match(message, new RegExp(`nested deeper than ${MAX_DEPTH}$`));
  assert.ok(message.startsWith("[0]".repeat(MAX_DEPTH)), "the path says where it stopped");
  // Records and objects count as containers too.
  let obj: Schema<unknown> = v.int();
  let val: unknown = 1;
  for (let i = 0; i <= MAX_DEPTH; i++) {
    obj = i % 2 ? v.object({ x: obj }) : v.record(obj);
    val = { x: val };
  }
  assert.match(err(obj, val), /nested deeper than/);
});

test("a hostile payload can't deepen the check: recursion follows the schema", () => {
  // A payload far deeper than any schema reaches only as far as the schema goes.
  const deep = nestedValue(100_000);
  assert.equal(err(v.array(v.array(v.int())), deep), "[0][0]: expected integer, got array");
  assert.equal(ok(v.array(v.unknown()), deep) !== undefined, true);
});

test("an array is checked in one linear pass, each element read once", () => {
  const n = 200_000;
  const rows = Array.from({ length: n }, (_, i) => ({ tmdbId: i }));
  let reads = 0;
  const counted = new Proxy(rows, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && /^\d+$/.test(prop)) reads++;
      return Reflect.get(target, prop, receiver);
    },
  });
  const out = ok(v.array(v.object({ tmdbId: v.int() })), counted);
  assert.equal(out.length, n);
  assert.equal(reads, n);
  // The first bad element ends the check: nothing after it is read.
  reads = 0;
  rows[10] = { tmdbId: "x" as unknown as number };
  assert.equal(err(v.array(v.object({ tmdbId: v.int() })), counted), "[10].tmdbId: expected integer, got string");
  assert.equal(reads, 11);
});
