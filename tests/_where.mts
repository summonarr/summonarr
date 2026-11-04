// A small Prisma `where` evaluator for in-memory test stubs (not a test file —
// the runner glob is tests/*.test.mts).
//
// Why: a stub written as `findMany: async () => rows` returns the same rows for
// every query, so deleting the `userId` / `serverInstance` / `status` filter from
// the code under test leaves the test green. A stub built on `memoryTable` applies
// the `where` it was given, so a dropped or widened filter changes the answer.
//
// Supports what the app's own queries use: scalar equality, null, the filters
// equals / not / in / notIn / gt / gte / lt / lte / contains / startsWith /
// endsWith / has / hasSome, and AND / OR / NOT. An operator it does not know
// THROWS, so a stub never silently ignores a clause it can't evaluate.

type Row = Record<string, unknown>;

const FILTER_KEYS = new Set([
  "equals", "not", "in", "notIn", "gt", "gte", "lt", "lte",
  "contains", "startsWith", "endsWith", "mode", "has", "hasSome", "hasEvery",
]);

function isFilterObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v) || v instanceof Date) return false;
  const keys = Object.keys(v);
  return keys.length > 0 && keys.every((k) => FILTER_KEYS.has(k));
}

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

function compare(a: unknown, b: unknown): number {
  const x = a instanceof Date ? a.getTime() : (a as number | bigint | string);
  const y = b instanceof Date ? b.getTime() : (b as number | bigint | string);
  return x < y ? -1 : x > y ? 1 : 0;
}

function matchesFilter(value: unknown, filter: Record<string, unknown>): boolean {
  const insensitive = filter.mode === "insensitive";
  const norm = (s: unknown) => (insensitive && typeof s === "string" ? s.toLowerCase() : s);
  for (const [op, arg] of Object.entries(filter)) {
    switch (op) {
      case "mode": break;
      case "equals": if (!same(value, arg)) return false; break;
      case "not":
        if (isFilterObject(arg) ? matchesFilter(value, arg) : same(value, arg)) return false;
        break;
      case "in": if (!(arg as unknown[]).some((x) => same(value, x))) return false; break;
      case "notIn": if ((arg as unknown[]).some((x) => same(value, x))) return false; break;
      case "gt": if (value == null || !(compare(value, arg) > 0)) return false; break;
      case "gte": if (value == null || !(compare(value, arg) >= 0)) return false; break;
      case "lt": if (value == null || !(compare(value, arg) < 0)) return false; break;
      case "lte": if (value == null || !(compare(value, arg) <= 0)) return false; break;
      case "contains": if (typeof value !== "string" || !String(norm(value)).includes(String(norm(arg)))) return false; break;
      case "startsWith": if (typeof value !== "string" || !String(norm(value)).startsWith(String(norm(arg)))) return false; break;
      case "endsWith": if (typeof value !== "string" || !String(norm(value)).endsWith(String(norm(arg)))) return false; break;
      case "has": if (!Array.isArray(value) || !value.some((x) => same(x, arg))) return false; break;
      case "hasSome": if (!Array.isArray(value) || !(arg as unknown[]).some((a) => value.some((x) => same(x, a)))) return false; break;
      case "hasEvery": if (!Array.isArray(value) || !(arg as unknown[]).every((a) => value.some((x) => same(x, a)))) return false; break;
      default: throw new Error(`matchesWhere: unsupported filter "${op}"`);
    }
  }
  return true;
}

export function matchesWhere(row: Row, where: Row | undefined | null): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (key === "AND") {
      const list = Array.isArray(cond) ? cond : [cond];
      if (!list.every((c) => matchesWhere(row, c as Row))) return false;
    } else if (key === "OR") {
      if (!(cond as Row[]).some((c) => matchesWhere(row, c))) return false;
    } else if (key === "NOT") {
      const list = Array.isArray(cond) ? cond : [cond];
      if (list.some((c) => matchesWhere(row, c as Row))) return false;
    } else if (cond === null) {
      if (row[key] !== null && row[key] !== undefined) return false;
    } else if (isFilterObject(cond)) {
      if (!matchesFilter(row[key], cond)) return false;
    } else if (typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond)) {
      throw new Error(`matchesWhere: relation or JSON filter on "${key}" is not supported by the in-memory matcher`);
    } else if (!same(row[key], cond)) {
      return false;
    }
  }
  return true;
}

/**
 * An in-memory model delegate that APPLIES the `where` it is given. Pass the
 * result to `shadowPrismaModel`. `rows` is read live, so a test can mutate it.
 */
export function memoryTable(rows: Row[]) {
  const pick = (where?: Row) => rows.filter((r) => matchesWhere(r, where));
  return {
    findMany: async (args?: { where?: Row; take?: number }) => {
      const hit = pick(args?.where);
      return args?.take != null ? hit.slice(0, args.take) : hit;
    },
    findFirst: async (args?: { where?: Row }) => pick(args?.where)[0] ?? null,
    count: async (args?: { where?: Row }) => pick(args?.where).length,
    deleteMany: async (args?: { where?: Row }) => {
      const doomed = new Set(pick(args?.where));
      let n = 0;
      for (let i = rows.length - 1; i >= 0; i--) if (doomed.has(rows[i])) { rows.splice(i, 1); n++; }
      return { count: n };
    },
    updateMany: async (args: { where?: Row; data: Row }) => {
      const hit = pick(args.where);
      for (const r of hit) Object.assign(r, args.data);
      return { count: hit.length };
    },
  };
}
