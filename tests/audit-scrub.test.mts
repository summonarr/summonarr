// Unit tests for src/lib/audit-scrub.ts — removing the TARGET user's name/email
// from admin-action audit details (the retention scrub and the account purge).
//
// The properties pinned here:
//   - only the target-identity keys go; the rest of the record (what happened,
//     to which account id) stays, byte-for-byte as JSON;
//   - details that don't parse are left alone, never guessed at — and can't
//     make the paging loop spin forever;
//   - each write is a CAS on the details it read, scoped by the caller's where;
//   - every page is visited (paging past the batch size).
import { test } from "node:test";
import assert from "node:assert/strict";

const { stripTargetPii, scrubTargetPiiFromAudit, AUDIT_TARGET_PII_KEYS } = await import("../src/lib/audit-scrub.ts");

test("stripTargetPii removes exactly targetUser and targetEmail", () => {
  assert.deepEqual([...AUDIT_TARGET_PII_KEYS], ["targetUser", "targetEmail"]);
  const out = stripTargetPii(JSON.stringify({ targetUser: "Alice", targetEmail: "a@example.com", role: "USER", nested: { targetUser: "kept" } }));
  assert.deepEqual(JSON.parse(out!), { role: "USER", nested: { targetUser: "kept" } }, "top-level keys only — nested values are not target identities");
  assert.deepEqual(JSON.parse(stripTargetPii(JSON.stringify({ targetEmail: "a@example.com" }))!), {});
});

test("stripTargetPii: nothing to remove, not JSON, or not an object ⇒ null (leave the row alone)", () => {
  assert.equal(stripTargetPii(JSON.stringify({ role: "USER" })), null);
  assert.equal(stripTargetPii('not json "targetUser"'), null);
  assert.equal(stripTargetPii(JSON.stringify(["targetUser"])), null);
  assert.equal(stripTargetPii("null"), null);
  assert.equal(stripTargetPii(JSON.stringify("targetUser")), null);
});

type Row = { id: string; target: string; details: string | null };

function fakeDb(rows: Row[], opts: { concurrentEdit?: string } = {}) {
  const calls = { findMany: 0, updateMany: [] as Array<Record<string, unknown>> };
  const matchesWhere = (r: Row, w: Record<string, unknown>) =>
    (w.target === undefined || r.target === w.target) && (w.id === undefined || r.id === w.id);
  const db = {
    auditLog: {
      findMany: async (args: { where: Record<string, unknown> & { OR: Array<{ details: { contains: string } }> }; take: number; cursor?: { id: string }; skip?: number }) => {
        calls.findMany++;
        if (calls.findMany > 50) throw new Error("paging loop did not terminate");
        let list = rows
          .filter((r) => matchesWhere(r, args.where) && args.where.OR.some((o) => r.details?.includes(o.details.contains)))
          .sort((a, b) => (a.id < b.id ? -1 : 1));
        if (args.cursor) list = list.slice(list.findIndex((r) => r.id === args.cursor!.id) + (args.skip ?? 0));
        return list.slice(0, args.take).map((r) => ({ id: r.id, details: r.details }));
      },
      updateMany: async (args: { where: Record<string, unknown> & { details: string }; data: { details: string } }) => {
        calls.updateMany.push(args.where);
        const r = rows.find((x) => matchesWhere(x, args.where));
        if (opts.concurrentEdit && r?.id === opts.concurrentEdit) r.details = JSON.stringify({ editedMeanwhile: true, targetUser: "Z" });
        if (!r || r.details !== args.where.details) return { count: 0 };
        r.details = args.data.details;
        return { count: 1 };
      },
    },
  };
  return { db: db as never, calls };
}

test("scrubTargetPiiFromAudit pages past the batch size and visits every matching row", async () => {
  const rows: Row[] = [];
  for (let i = 0; i < 1203; i++) {
    rows.push({ id: `r${String(i).padStart(5, "0")}`, target: "user:u1", details: JSON.stringify({ targetUser: `N${i}`, targetEmail: `e${i}@example.com`, n: i }) });
  }
  // Rows that mention a key but can't be rewritten, mixed in: they must not
  // stall the loop (they keep matching the query on every page).
  rows.push({ id: "r00100x", target: "user:u1", details: 'broken "targetUser"' });
  rows.push({ id: "r00900x", target: "user:u1", details: 'broken "targetEmail"' });
  const { db, calls } = fakeDb(rows);
  const n = await scrubTargetPiiFromAudit(db, { target: "user:u1" });
  assert.equal(n, 1203);
  assert.ok(calls.findMany >= 3 && calls.findMany <= 4, `paged in ${calls.findMany} reads`);
  for (const r of rows) {
    if (r.details!.startsWith("broken")) continue;
    const d = JSON.parse(r.details!);
    assert.ok(!("targetUser" in d) && !("targetEmail" in d), r.id);
    assert.equal(typeof d.n, "number", "the rest of the record stays");
  }
});

test("scrubTargetPiiFromAudit is scoped by the caller's where, on the read AND on every write", async () => {
  const rows: Row[] = [
    { id: "a", target: "user:u1", details: JSON.stringify({ targetUser: "Mine" }) },
    { id: "b", target: "user:u2", details: JSON.stringify({ targetUser: "Theirs" }) },
  ];
  const { db, calls } = fakeDb(rows);
  assert.equal(await scrubTargetPiiFromAudit(db, { target: "user:u1" }), 1);
  assert.equal(rows[1].details, JSON.stringify({ targetUser: "Theirs" }));
  for (const w of calls.updateMany) assert.equal(w.target, "user:u1", "the write carries the scope too");
});

test("scrubTargetPiiFromAudit writes a CAS on the details it read — a row edited meanwhile is not overwritten with a stale copy", async () => {
  const rows: Row[] = [{ id: "a", target: "user:u1", details: JSON.stringify({ targetUser: "Old" }) }];
  const { db } = fakeDb(rows, { concurrentEdit: "a" });
  assert.equal(await scrubTargetPiiFromAudit(db, { target: "user:u1" }), 0);
  assert.deepEqual(JSON.parse(rows[0].details!), { editedMeanwhile: true, targetUser: "Z" }, "left for the next scrub run");
});
