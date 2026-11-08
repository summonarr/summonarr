// The in-memory `where` evaluator behind scoping-sensitive stubs (tests/_where.mts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesWhere, memoryTable } from "./_where.mts";

const rows = () => [
  { id: "a", userId: "u1", serverInstance: "", status: "APPROVED", n: 1, tags: ["x"], at: new Date("2026-01-02") },
  { id: "b", userId: "u2", serverInstance: "4k", status: "DECLINED", n: 5, tags: [], at: new Date("2026-01-05") },
  { id: "c", userId: "u1", serverInstance: "4k", status: "PENDING", n: 9, tags: ["y"], at: new Date("2026-01-09") },
];

test("a stub built on memoryTable answers differently when a filter is dropped", async () => {
  const t = memoryTable(rows());
  assert.equal(await t.count({ where: { userId: "u1" } }), 2);
  assert.equal(await t.count({ where: { userId: "u1", serverInstance: "4k" } }), 1);
  assert.equal(await t.count({}), 3);
});

test("operators: in / notIn / not / gt / gte / lt / lte / contains / has / hasSome", () => {
  const r = rows()[1];
  assert.ok(matchesWhere(r, { status: { in: ["DECLINED"] } }));
  assert.ok(!matchesWhere(r, { status: { notIn: ["DECLINED"] } }));
  assert.ok(matchesWhere(r, { status: { not: "APPROVED" } }));
  assert.ok(matchesWhere(r, { n: { gt: 4, lte: 5 } }));
  assert.ok(!matchesWhere(r, { n: { lt: 5 } }));
  assert.ok(matchesWhere(r, { at: { gte: new Date("2026-01-05") } }));
  assert.ok(matchesWhere(r, { serverInstance: { contains: "K", mode: "insensitive" } }));
  assert.ok(matchesWhere(rows()[0], { tags: { has: "x" } }));
  assert.ok(matchesWhere(rows()[2], { tags: { hasSome: ["q", "y"] } }));
});

test("AND / OR / NOT and null equality", () => {
  const [a, b, c] = rows();
  assert.ok(matchesWhere(c, { OR: [{ userId: "u9" }, { serverInstance: "4k" }] }));
  assert.ok(!matchesWhere(a, { OR: [{ userId: "u9" }, { serverInstance: "4k" }] }));
  assert.ok(matchesWhere(a, { AND: [{ userId: "u1" }, { n: 1 }] }));
  assert.ok(!matchesWhere(b, { NOT: { status: "DECLINED" } }));
  assert.ok(matchesWhere({ id: "z", gone: null }, { gone: null }));
  assert.ok(!matchesWhere(a, { id: null }));
});

test("deleteMany and updateMany touch only the rows the where selects", async () => {
  const data = rows();
  const t = memoryTable(data);
  assert.deepEqual(await t.updateMany({ where: { userId: "u1" }, data: { status: "AVAILABLE" } }), { count: 2 });
  assert.equal(data.filter((r) => r.status === "AVAILABLE").length, 2);
  assert.deepEqual(await t.deleteMany({ where: { serverInstance: "4k" } }), { count: 2 });
  assert.deepEqual(data.map((r) => r.id), ["a"]);
});

test("an operator or relation filter it cannot evaluate throws instead of being ignored", () => {
  assert.throws(() => matchesWhere({ id: "a" }, { id: { search: "a" } as never }), /unsupported|not supported/);
  assert.throws(() => matchesWhere({ id: "a" }, { user: { name: "x" } as never }), /not supported/);
});
