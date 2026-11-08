// Re-requesting a non-permanently DECLINED title deletes the old row
// to free the unique key, and RequestComment cascades with it, so the decline
// conversation vanished. src/lib/request-comment-carry.ts reads the thread before
// the delete and writes it back onto the new row; the web/auto-request path
// (request-create.ts — behaviour pinned in tests/requests-route.test.mts), the
// bulk route and the Discord pick all go through it.
//
// Here: the helper against an in-memory tx (order, CAS, cap, budget, one query in
// flight — guardrail 23c), and source pins that every create site of the three
// replace paths restores the thread it dropped.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const warns: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };

const {
  dropStaleDeclined,
  dropStaleDeclinedMany,
  restoreThread,
  MAX_CARRIED_COMMENTS,
  MAX_CARRIED_COMMENTS_PER_CALL,
} = await import("../src/lib/request-comment-carry.ts");

type Comment = { id: string; requestId: string; createdAt: Date; authorId: string; body: string; fromAdmin: boolean };
type Row = { id: string; status: string; permanentlyDeclined: boolean };

// ── in-memory tx: honours the queries the helper writes ─────────────────────
let rows: Row[] = [];
let comments: Comment[] = [];
const ops: Array<{ op: string; args: unknown }> = [];
let inFlight = 0;
let maxInFlight = 0;
// Runs once a thread read has answered: models another writer committing between
// the read and the delete (possible below Serializable).
let afterRead: (() => void) | null = null;
async function track<T>(op: string, args: unknown, fn: () => T): Promise<T> {
  ops.push({ op, args });
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  try {
    await new Promise((r) => setImmediate(r));
    return fn();
  } finally {
    inFlight--;
  }
}
const matchesCas = (r: Row, w: { status?: string; permanentlyDeclined?: boolean }) =>
  (w.status === undefined || r.status === w.status) && (w.permanentlyDeclined === undefined || r.permanentlyDeclined === w.permanentlyDeclined);

const tx = {
  requestComment: {
    findMany: (args: {
      where: { requestId: string; request?: { status: string; permanentlyDeclined: boolean } };
      orderBy: Array<{ createdAt?: "asc" | "desc"; id?: "asc" | "desc" }>;
      take: number;
    }) =>
      track("requestComment.findMany", args, () => {
        const parent = rows.find((r) => r.id === args.where.requestId);
        if (!parent || (args.where.request && !matchesCas(parent, args.where.request))) return [];
        const dir = args.orderBy[0]?.createdAt === "desc" ? -1 : 1;
        const out = comments
          .filter((c) => c.requestId === args.where.requestId)
          .sort((a, b) => dir * (a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1)))
          .slice(0, args.take)
          .map(({ requestId: _r, ...rest }) => rest);
        afterRead?.();
        return out;
      }),
    groupBy: (args: { by: string[]; where: { requestId: { in: string[] }; request: { status: string; permanentlyDeclined: boolean } } }) =>
      track("requestComment.groupBy", args, () => {
        assert.deepEqual(args.by, ["requestId"]);
        const live = rows.filter((r) => args.where.requestId.in.includes(r.id) && matchesCas(r, args.where.request));
        return live.filter((r) => comments.some((c) => c.requestId === r.id)).map((r) => ({ requestId: r.id }));
      }),
    createMany: (args: { data: Comment[] }) =>
      track("requestComment.createMany", args, () => {
        for (const c of args.data) {
          if (comments.some((x) => x.id === c.id)) throw new Error(`duplicate comment id ${c.id}`);
          comments.push({ ...c });
        }
        return { count: args.data.length };
      }),
  },
  mediaRequest: {
    deleteMany: (args: { where: { id: string | { in: string[] }; status: string; permanentlyDeclined: boolean } }) =>
      track("mediaRequest.deleteMany", args, () => {
        const ids = typeof args.where.id === "string" ? [args.where.id] : args.where.id.in;
        const doomed = rows.filter((r) => ids.includes(r.id) && matchesCas(r, args.where));
        rows = rows.filter((r) => !doomed.includes(r));
        // ON DELETE CASCADE
        comments = comments.filter((c) => !doomed.some((r) => r.id === c.requestId));
        return { count: doomed.length };
      }),
  },
};
// The helper is typed off the extended client; the stub implements the slice it uses.
const TX = tx as unknown as Parameters<typeof dropStaleDeclined>[0];

function thread(requestId: string, n: number, base = Date.UTC(2026, 9, 1)): Comment[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${requestId}-c${String(i).padStart(4, "0")}`,
    requestId,
    createdAt: new Date(base + i * 60_000),
    authorId: i % 2 === 0 ? "u-admin" : "u-req",
    body: `comment ${i}`,
    fromAdmin: i % 2 === 0,
  }));
}

beforeEach(() => {
  rows = [];
  comments = [];
  ops.length = 0;
  inFlight = 0;
  maxInFlight = 0;
  warns.length = 0;
  afterRead = null;
});

test("no stale row ⇒ no query at all", async () => {
  assert.deepEqual(await dropStaleDeclined(TX, null), []);
  assert.deepEqual(await dropStaleDeclinedMany(TX, []), new Map());
  await restoreThread(TX, "new", []);
  await restoreThread(TX, "new", undefined);
  assert.deepEqual(ops, []);
});

test("dropStaleDeclined reads the thread, then CAS-deletes; restoreThread moves the same comments onto the new row", async () => {
  rows = [{ id: "old", status: "DECLINED", permanentlyDeclined: false }];
  const original = thread("old", 3);
  comments = original.map((c) => ({ ...c }));

  const carried = await dropStaleDeclined(TX, "old");
  assert.deepEqual(ops.map((o) => o.op), ["requestComment.findMany", "mediaRequest.deleteMany"]);
  assert.deepEqual((ops[1].args as { where: unknown }).where, { id: "old", status: "DECLINED", permanentlyDeclined: false });
  assert.deepEqual(comments, [], "the delete cascaded the thread");

  rows.push({ id: "new", status: "PENDING", permanentlyDeclined: false });
  await restoreThread(TX, "new", carried);
  assert.equal(ops.filter((o) => o.op === "requestComment.createMany").length, 1, "one INSERT");
  // Same id, author, body, fromAdmin and createdAt, oldest first, on the new row.
  assert.deepEqual(comments, original.map((c) => ({ ...c, requestId: "new" })));
  assert.equal(maxInFlight, 1, "one query in flight on the tx (guardrail 23c)");
});

test("a CAS that no-ops (re-approved or banned since the read) carries nothing and leaves the thread on the old row", async () => {
  for (const row of [
    { id: "old", status: "APPROVED", permanentlyDeclined: false },
    { id: "old", status: "DECLINED", permanentlyDeclined: true },
  ]) {
    rows = [row];
    comments = thread("old", 2);
    assert.deepEqual(await dropStaleDeclined(TX, "old"), []);
    assert.equal(comments.length, 2, "the surviving row keeps its thread");
  }
});

test("a row that stops matching the CAS between the read and the delete carries nothing (its thread stays put)", async () => {
  rows = [{ id: "old", status: "DECLINED", permanentlyDeclined: false }];
  comments = thread("old", 2);
  afterRead = () => { rows[0].status = "APPROVED"; }; // an admin re-approved it meanwhile
  assert.deepEqual(await dropStaleDeclined(TX, "old"), []);
  assert.equal(comments.length, 2);
  // Restoring them anyway would re-insert ids the surviving row still holds.
});

test("a thread longer than the cap carries its newest MAX_CARRIED_COMMENTS, in order, and says so", async () => {
  rows = [{ id: "old", status: "DECLINED", permanentlyDeclined: false }];
  const all = thread("old", MAX_CARRIED_COMMENTS + 7);
  comments = all.map((c) => ({ ...c }));
  const carried = await dropStaleDeclined(TX, "old");
  assert.equal(carried.length, MAX_CARRIED_COMMENTS);
  assert.deepEqual(carried.map((c) => c.id), all.slice(7).map((c) => c.id), "the newest, oldest first");
  assert.equal((ops[0].args as { take: number }).take, MAX_CARRIED_COMMENTS + 1, "bounded read");
  assert.equal(warns.length, 1);
  assert.match(warns[0], /^\[requests\] re-request of old: kept the newest 500 comments/);
});

test("dropStaleDeclinedMany: threads read one at a time, ONE CAS deleteMany, keyed by the OLD request id", async () => {
  rows = [
    { id: "a", status: "DECLINED", permanentlyDeclined: false },
    { id: "b", status: "DECLINED", permanentlyDeclined: false },
    { id: "c", status: "APPROVED", permanentlyDeclined: false }, // re-approved since the route's read
    { id: "d", status: "DECLINED", permanentlyDeclined: false }, // no comments
  ];
  comments = [...thread("a", 2), ...thread("b", 1), ...thread("c", 3)];
  const threads = await dropStaleDeclinedMany(TX, ["a", "b", "c", "d"]);

  assert.deepEqual(ops.map((o) => o.op), [
    "requestComment.findMany", "requestComment.findMany", "requestComment.findMany", "requestComment.findMany",
    "mediaRequest.deleteMany",
  ]);
  assert.deepEqual((ops[4].args as { where: unknown }).where, { id: { in: ["a", "b", "c", "d"] }, status: "DECLINED", permanentlyDeclined: false });
  assert.deepEqual([...threads.keys()], ["a", "b"], "only rows the CAS removes have a thread");
  assert.deepEqual(threads.get("a")!.map((c) => c.id), ["a-c0000", "a-c0001"]);
  assert.deepEqual(comments.map((c) => c.requestId), ["c", "c", "c"], "the surviving row keeps its thread");
  assert.equal(maxInFlight, 1, "one query in flight on the tx (guardrail 23c)");
});

test("dropStaleDeclinedMany caps the whole call at MAX_CARRIED_COMMENTS_PER_CALL, and ONE warning names every thread it dropped", async () => {
  // Full threads spend the budget exactly; then one thread past it (wholly lost)
  // and one with no comments (nothing lost — not named).
  const full = MAX_CARRIED_COMMENTS_PER_CALL / MAX_CARRIED_COMMENTS;
  assert.ok(Number.isInteger(full), "the fixture assumes the budget is whole threads");
  const ids = [...Array.from({ length: full }, (_, i) => `r${i}`), "lost", "empty"];
  rows = ids.map((id) => ({ id, status: "DECLINED", permanentlyDeclined: false }));
  comments = ids.filter((id) => id !== "empty").flatMap((id) => thread(id, MAX_CARRIED_COMMENTS));
  const threads = await dropStaleDeclinedMany(TX, ids);
  const total = [...threads.values()].reduce((s, t) => s + t.length, 0);
  assert.equal(total, MAX_CARRIED_COMMENTS_PER_CALL);
  assert.equal(threads.has("lost"), false);
  const reads = ops.filter((x) => x.op === "requestComment.findMany");
  assert.equal(reads.length, full, "no read past the budget");
  for (const o of reads) assert.ok((o.args as { take: number }).take <= MAX_CARRIED_COMMENTS + 1);
  assert.equal(ops.filter((x) => x.op === "requestComment.groupBy").length, 1, "one query for every unread row");
  assert.deepEqual(warns.length, 1, "once per call, not per row");
  assert.match(warns[0], /^\[requests\] bulk re-request: .*older comments of 1 declined request\(s\) were deleted with them: lost$/);
  assert.equal(maxInFlight, 1);
});

test("dropStaleDeclinedMany: a thread cut part-way by the budget and one cut by the per-thread cap share the single warning", async () => {
  // "big" is cut by the per-thread cap; the fillers leave exactly 10 of the budget for "partial".
  const fillers = Array.from({ length: MAX_CARRIED_COMMENTS_PER_CALL / MAX_CARRIED_COMMENTS - 1 }, (_, i) => `f${i}`);
  const ids = ["big", ...fillers, "partial", "small"];
  rows = ids.map((id) => ({ id, status: "DECLINED", permanentlyDeclined: false }));
  comments = [
    ...thread("big", MAX_CARRIED_COMMENTS + 3),
    ...fillers.flatMap((id, i) => thread(id, i === fillers.length - 1 ? MAX_CARRIED_COMMENTS - 10 : MAX_CARRIED_COMMENTS)),
    ...thread("partial", 25),
    ...thread("small", 4),
  ];
  const threads = await dropStaleDeclinedMany(TX, ids);
  assert.equal(threads.get("big")!.length, MAX_CARRIED_COMMENTS);
  assert.equal(threads.get("partial")!.length, 10, "the newest 10 the budget had left");
  assert.equal(threads.has("small"), false, "the budget is spent");
  assert.equal(warns.length, 1);
  assert.match(warns[0], /of 3 declined request\(s\) were deleted with them: big, partial, small$/);
});

test("dropStaleDeclinedMany within every cap warns nothing and runs no grouped query", async () => {
  rows = [{ id: "a", status: "DECLINED", permanentlyDeclined: false }];
  comments = thread("a", 3);
  await dropStaleDeclinedMany(TX, ["a"]);
  assert.deepEqual(warns, []);
  assert.equal(ops.filter((x) => x.op === "requestComment.groupBy").length, 0);
});

// ── the three replace paths restore what they drop ──────────────────────────

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const code = (rel: string) =>
  readFileSync(join(ROOT, rel), "utf8").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");

test("request-create.ts (and the Discord pick, which files through it): the stale row is dropped through the helper and EVERY create restores its thread", () => {
  for (const f of ["src/lib/request-create.ts"]) {
    const src = code(f);
    assert.doesNotMatch(src, /mediaRequest\.deleteMany\(\{ where: \{ id: staleDeclinedId/, `${f}: a bare stale-row delete cascades the thread`);
    const drops = src.match(/const carried = await dropStaleDeclined\(tx, staleDeclinedId\);/g) ?? [];
    const creates = [...src.matchAll(/(\w+) = await tx\.mediaRequest\.create\(\{[\s\S]*?\}\);\s*\n\s*await restoreThread\(tx, (\w+)\.id, carried\);/g)];
    const allCreates = src.match(/tx\.mediaRequest\.create\(/g) ?? [];
    assert.ok(drops.length >= 1, `${f}: dropStaleDeclined`);
    assert.equal(creates.length, allCreates.length, `${f}: a create without restoreThread right after it`);
    for (const m of creates) assert.equal(m[1], m[2], `${f}: restores onto the row it created`);
  }
  // One drop per create transaction: request-create has one tx. The pick has no
  // create of its own to drop a row for.
  assert.equal((code("src/lib/request-create.ts").match(/dropStaleDeclined\(/g) ?? []).length, 1);
  assert.equal((code("src/lib/discord-interactions/components/pick.ts").match(/dropStaleDeclined\(|tx\.mediaRequest/g) ?? []).length, 0);
});
