// A comment notification links to /requests?comments=<id> (the requester) or
// /admin?comments=<id> (the request queue). Both pages only open the thread of a
// row they render, so a request outside the first page used to open nothing.
// The pages now find the page that holds the request — under their own filter
// and order, so only a row the viewer can already list is ever located — and
// redirect there with the param kept (src/lib/request-comment-deep-link.ts).
// Only the arrival from a link locates: the target URL always names its page,
// so a live refresh never moves the viewer.
//
// No DB: prisma.mediaRequest is shadowed by an in-memory evaluator of the few
// where/orderBy shapes the helpers send.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NEXTAUTH_SECRET ??= "unit-test-session-secret-0123456789abcdef";
process.env.TOKEN_ENCRYPTION_KEY ??= "ab".repeat(32);
process.env.DATABASE_URL ??= "postgresql://unit:unit@127.0.0.1:9/never_connects";

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");

type Row = { id: string; requestedBy: string; status: string; title: string; tmdbId: number; mediaType: "MOVIE" | "TV"; createdAt: Date };
let rows: Row[] = [];
let queries = 0;
const groupByArgs: unknown[] = [];

type Where = Record<string, unknown>;
function cmp(a: unknown, b: unknown): number {
  const x = a instanceof Date ? a.getTime() : a;
  const y = b instanceof Date ? b.getTime() : b;
  return (x as number | string) < (y as number | string) ? -1 : (x as number | string) > (y as number | string) ? 1 : 0;
}
function fieldMatches(value: unknown, cond: unknown): boolean {
  if (cond instanceof Date || typeof cond !== "object" || cond === null) return cmp(value, cond) === 0;
  const c = cond as { gt?: unknown; lt?: unknown; contains?: string; mode?: string };
  if (c.gt !== undefined && !(cmp(value, c.gt) > 0)) return false;
  if (c.lt !== undefined && !(cmp(value, c.lt) < 0)) return false;
  if (c.contains !== undefined) {
    const hay = c.mode === "insensitive" ? String(value).toLowerCase() : String(value);
    const needle = c.mode === "insensitive" ? c.contains.toLowerCase() : c.contains;
    if (!hay.includes(needle)) return false;
  }
  return true;
}
function matches(row: Row, where: Where | undefined): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (k === "AND") {
      if (!(v as Where[]).every((w) => matches(row, w))) return false;
    } else if (k === "OR") {
      if (!(v as Where[]).some((w) => matches(row, w))) return false;
    } else if (!fieldMatches(row[k as keyof Row], v)) return false;
  }
  return true;
}
// An orderBy list of `{ field: dir }`, `{ _max: { field: dir } }` or `{ _min: … }`.
type OrderSpec = Array<Record<string, unknown>>;
function compareBy<T>(order: OrderSpec, value: (item: T, agg: string | null, field: string) => unknown) {
  return (a: T, b: T): number => {
    for (const o of order) {
      const [key, inner] = Object.entries(o)[0];
      const [agg, field, dir] =
        typeof inner === "string" ? [null, key, inner] : [key, ...Object.entries(inner as Record<string, string>)[0]];
      const c = cmp(value(a, agg, field as string), value(b, agg, field as string));
      if (c !== 0) return dir === "desc" ? -c : c;
    }
    return 0;
  };
}
type Group = { tmdbId: number; mediaType: string; members: Row[] };
const groupValue = (g: Group, agg: string | null, field: string): unknown => {
  if (agg === null) return g[field as "tmdbId" | "mediaType"];
  const vals = g.members.map((m) => m[field as keyof Row]).sort(cmp);
  return agg === "_max" ? vals[vals.length - 1] : vals[0];
};

const rowValue = (r: Row, _agg: string | null, field: string): unknown => r[field as keyof Row];

function project<T extends Record<string, unknown>>(row: T, select?: Record<string, boolean>): Partial<T> {
  if (!select) return row;
  return Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) as Partial<T>;
}

shadowPrismaModel(prisma, "mediaRequest", {
  findFirst: async (args: { where: Where; select?: Record<string, boolean> }) => {
    queries++;
    const r = rows.find((row) => matches(row, args.where));
    return r ? project(r, args.select) : null;
  },
  count: async (args: { where: Where }) => {
    queries++;
    return rows.filter((row) => matches(row, args.where)).length;
  },
  groupBy: async (args: { by: string[]; where: Where; orderBy: OrderSpec }) => {
    queries++;
    groupByArgs.push(args);
    assert.deepEqual(args.by, ["tmdbId", "mediaType"]);
    const groups = new Map<string, Group>();
    for (const r of rows.filter((row) => matches(row, args.where))) {
      const key = `${r.tmdbId}:${r.mediaType}`;
      const g = groups.get(key) ?? { tmdbId: r.tmdbId, mediaType: r.mediaType, members: [] };
      g.members.push(r);
      groups.set(key, g);
    }
    return [...groups.values()]
      .sort(compareBy(args.orderBy, groupValue))
      .map((g) => ({ tmdbId: g.tmdbId, mediaType: g.mediaType }));
  },
});

const { commentLinkToLocate, ownRequestCommentPage, ownRequestsOrderBy, queueCommentPage, pageForIndex } = await import(
  "../src/lib/request-comment-deep-link.ts"
);

beforeEach(() => {
  rows = [];
  queries = 0;
  groupByArgs.length = 0;
});

const T0 = Date.parse("2026-10-01T00:00:00Z");
// Ids out of insertion order, so a createdAt-only order can't line up with the
// id tiebreak by accident.
const idFor = (i: number) => `c${((i * 37) % 101).toString().padStart(3, "0")}x${i}`;

function seedOwnRequests(): void {
  // 47 of u1's requests in tie groups of 9 — two of them straddle the page
  // boundaries at 20 and 40 — plus another user's.
  for (let i = 0; i < 47; i++) {
    rows.push({
      id: idFor(i), requestedBy: "u1", status: i % 3 === 0 ? "PENDING" : "APPROVED", title: `Title ${i}`,
      tmdbId: 1000 + i, mediaType: "MOVIE", createdAt: new Date(T0 + Math.floor(i / 9) * 1000),
    });
  }
  for (let i = 0; i < 5; i++) {
    rows.push({ id: `other${i}`, requestedBy: "u2", status: "PENDING", title: `Other ${i}`, tmdbId: 5000 + i, mediaType: "TV", createdAt: new Date(T0 + 500) });
  }
}

test("the requester list is totally ordered: createdAt, then id", () => {
  assert.deepEqual(ownRequestsOrderBy("desc"), [{ createdAt: "desc" }, { id: "desc" }]);
  assert.deepEqual(ownRequestsOrderBy("asc"), [{ createdAt: "asc" }, { id: "asc" }]);
  assert.equal(pageForIndex(0, 20), 1);
  assert.equal(pageForIndex(19, 20), 1);
  assert.equal(pageForIndex(20, 20), 2);
});

test("every request lands on the page of the list that renders it, ties included, both directions", async () => {
  seedOwnRequests();
  const where = { requestedBy: "u1" };
  for (const dir of ["desc", "asc"] as const) {
    // The page's own list: the rows of `where` in ownRequestsOrderBy order.
    const listed = rows.filter((r) => matches(r, where)).sort(compareBy(ownRequestsOrderBy(dir) as OrderSpec, rowValue));
    for (let i = 0; i < listed.length; i++) {
      const page = await ownRequestCommentPage(where, listed[i].id, dir, 20);
      assert.equal(page, Math.floor(i / 20) + 1, `${dir}: ${listed[i].id} (position ${i})`);
    }
  }
});

test("the page is computed under the current filter", async () => {
  seedOwnRequests();
  const where = { requestedBy: "u1", status: "PENDING" } as const;
  const listed = rows.filter((r) => matches(r, where)).sort(compareBy(ownRequestsOrderBy("desc") as OrderSpec, rowValue));
  for (let i = 0; i < listed.length; i++) {
    assert.equal(await ownRequestCommentPage(where, listed[i].id, "desc", 5), Math.floor(i / 5) + 1);
  }
  // A request the filter excludes is not located (the link does nothing, as before).
  const approved = rows.find((r) => r.requestedBy === "u1" && r.status === "APPROVED")!;
  assert.equal(await ownRequestCommentPage(where, approved.id, "desc", 5), null);
});

test("another user's request is never located from the requester list", async () => {
  seedOwnRequests();
  assert.equal(await ownRequestCommentPage({ requestedBy: "u1" }, "other3", "desc", 20), null);
});

test("an id that can't be a request id costs no query", async () => {
  seedOwnRequests();
  for (const bad of ["", "../x", "a b", "x".repeat(65)]) {
    assert.equal(await ownRequestCommentPage({ requestedBy: "u1" }, bad, "desc", 20), null);
    assert.equal(await queueCommentPage({}, [{ _max: { createdAt: "desc" } }], bad, 20), null);
  }
  assert.equal(queries, 0);
});

const NEWEST: OrderSpec = [{ _max: { createdAt: "desc" } }, { tmdbId: "asc" }, { mediaType: "asc" }];

function seedQueue(): void {
  // 11 titles, several requested by more than one user, and two titles sharing a
  // tmdbId across media types.
  let n = 0;
  for (let t = 0; t < 11; t++) {
    const requesters = t % 3 === 0 ? 3 : 1;
    for (let k = 0; k < requesters; k++) {
      rows.push({
        id: `q${String(n).padStart(3, "0")}`, requestedBy: `u${k}`, status: k === 0 ? "PENDING" : "APPROVED",
        title: `T${t}`, tmdbId: 700 + (t % 10), mediaType: t === 10 ? "TV" : "MOVIE",
        createdAt: new Date(T0 + ((t * 7) % 5) * 1000 + k),
      });
      n++;
    }
  }
}

test("a queue request lands on the page that renders its title group, under the page's own where and order", async () => {
  seedQueue();
  for (const [where, orderBy] of [
    [{}, NEWEST],
    [{ status: "APPROVED" }, NEWEST],
    [{}, [{ _min: { title: "asc" } }, { tmdbId: "asc" }, { mediaType: "asc" }]],
    [{ mediaType: "MOVIE" }, [{ _min: { createdAt: "asc" } }, { tmdbId: "asc" }, { mediaType: "asc" }]],
  ] as Array<[Where, OrderSpec]>) {
    const groups = new Map<string, Group>();
    for (const r of rows.filter((row) => matches(row, where))) {
      const key = `${r.tmdbId}:${r.mediaType}`;
      const g = groups.get(key) ?? { tmdbId: r.tmdbId, mediaType: r.mediaType, members: [] };
      g.members.push(r);
      groups.set(key, g);
    }
    const ordered = [...groups.values()].sort(compareBy(orderBy, groupValue));
    for (const [gi, g] of ordered.entries()) {
      for (const m of g.members) {
        groupByArgs.length = 0;
        assert.equal(await queueCommentPage(where as never, orderBy as never, m.id, 4), Math.floor(gi / 4) + 1, `${JSON.stringify(orderBy[0])} ${m.id}`);
        assert.deepEqual(groupByArgs, [{ by: ["tmdbId", "mediaType"], where, orderBy }], "the paging query's own where and order");
      }
    }
  }
});

test("a queue request the filter excludes is not located", async () => {
  seedQueue();
  const pending = rows.find((r) => r.status === "PENDING")!;
  assert.equal(await queueCommentPage({ status: "APPROVED" } as never, NEWEST as never, pending.id, 4), null);
  assert.equal(await queueCommentPage({} as never, NEWEST as never, "q999", 4), null);
});

// ── only the arrival from a link locates ───────────────────────────────────
// Both pages live-refresh on request events, and a refresh re-renders the
// server page at the same URL. A redirect on every render would move a viewer
// who stayed on the landing page whenever a new request pushed the target off
// it. Links never carry `page`; the redirect always sets one.

test("only a URL without `page` locates its ?comments= request", () => {
  assert.equal(commentLinkToLocate(undefined, "creq1"), "creq1");
  assert.equal(commentLinkToLocate(undefined, ["creq1", "creq2"]), "creq1");
  assert.equal(commentLinkToLocate("1", "creq1"), null, "the redirect target (page set) must never relocate");
  assert.equal(commentLinkToLocate("3", "creq1"), null);
  assert.equal(commentLinkToLocate("", "creq1"), null);
  assert.equal(commentLinkToLocate(["2"], "creq1"), null);
  assert.equal(commentLinkToLocate(undefined, undefined), null);
  assert.equal(commentLinkToLocate(undefined, ""), null);
});

// ── the pages use the helpers on the link path ─────────────────────────────
const read = (p: string) => readFileSync(new URL(`../src/app/(app)/${p}`, import.meta.url), "utf-8");

test("/requests pages in the helper's order and sends a comment link's arrival to the request's page", () => {
  const src = read("requests/page.tsx");
  assert.match(src, /orderBy: ownRequestsOrderBy\(sort === "oldest" \? "asc" : "desc"\)/);
  assert.match(src, /const locateId = commentsEnabled \? commentLinkToLocate\(pageParam, commentsRaw\) : null;\s*if \(locateId\) \{/);
  assert.match(src, /ownRequestCommentPage\(where, locateId, sort === "oldest" \? "asc" : "desc", PAGE_SIZE\)/);
  assert.match(src, /if \(target !== null\) redirect\(pageHref\(target, locateId\)\)/);
  // The target always names its page (even 1), so it is never located again.
  assert.match(src, /if \(p > 1 \|\| comments\) params\.set\("page", String\(p\)\)/);
  assert.match(src, /if \(comments\) params\.set\("comments", comments\)/);
  // The requester `where` is what keeps the lookup to the viewer's own requests.
  assert.match(src, /const where: Prisma\.MediaRequestWhereInput = \{\s*requestedBy: session\.user\.id,/);
});

test("/admin sends a comment link's arrival to the page that holds the request's title, with its paging query's where and order", () => {
  const src = read("admin/page.tsx");
  assert.match(src, /orderBy: groupOrderBy,\s*skip: \(p - 1\) \* PAGE_SIZE,/);
  assert.match(src, /const locateId = commentLinkToLocate\(pageParam, commentsRaw\);\s*if \(locateId\) \{/);
  assert.match(src, /queueCommentPage\(where, groupOrderBy, locateId, PAGE_SIZE\)/);
  // The target always names its page (even 1), so it is never located again.
  assert.match(src, /if \(target !== null\) \{\s*const params = new URLSearchParams\(\);\s*params\.set\("page", String\(target\)\);/);
  assert.match(src, /params\.set\("comments", locateId\);\s*redirect\(`\/admin\?\$\{params\.toString\(\)\}`\)/);
});
