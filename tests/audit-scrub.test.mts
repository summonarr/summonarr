// Unit tests for src/lib/audit-scrub.ts — removing the TARGET user's name/email
// from admin-action audit details (the retention scrub and the account purge).
//
// The properties pinned here:
//   - only the target-identity keys go; the rest of the record (what happened,
//     to which account id) stays, byte-for-byte as JSON;
//   - details that don't parse are left alone, never guessed at — and can't
//     make the paging loop spin forever;
//   - each write is a CAS on the details it read, scoped by the caller's where;
//   - every page is visited (paging past the batch size) and every matching row
//     on it is rewritten. The fake pages the way Prisma does: a `cursor` is a
//     position on the UNFILTERED table by id (`id >= cursor`), then the filter,
//     then `skip` as an OFFSET — so a cursor+skip:1 loop whose cursor row it had
//     just rewritten (and that no longer matches) loses the next matching row,
//     exactly as it did against Postgres;
//   - a `match` predicate narrows by exact value, and a caller's AND survives
//     onto the later pages;
//   - `requestedBy` (request moderation rows) goes with the target keys, so the
//     retention scrub removes it too;
//   - the purge's legacy scrubs find an email only by the exact `match`: the
//     fake's `contains` is a real LIKE (`%`/`_` wildcards, backslash escape), so
//     an email term in the `where` would miss one whose JSON has a backslash.
import { test } from "node:test";
import assert from "node:assert/strict";

const {
  stripTargetPii, scrubTargetPiiFromAudit, scrubLegacySessionRevokePii, scrubRequesterPii, requesterAuditDetails, AUDIT_TARGET_PII_KEYS,
} = await import("../src/lib/audit-scrub.ts");

test("stripTargetPii removes exactly targetUser, targetEmail and requestedBy", () => {
  assert.deepEqual([...AUDIT_TARGET_PII_KEYS], ["targetUser", "targetEmail", "requestedBy"]);
  const out = stripTargetPii(JSON.stringify({ targetUser: "Alice", targetEmail: "a@example.com", role: "USER", nested: { targetUser: "kept" } }));
  assert.deepEqual(JSON.parse(out!), { role: "USER", nested: { targetUser: "kept" } }, "top-level keys only — nested values are not target identities");
  assert.deepEqual(JSON.parse(stripTargetPii(JSON.stringify({ targetEmail: "a@example.com" }))!), {});
  assert.deepEqual(
    JSON.parse(stripTargetPii(JSON.stringify({ title: "T", requesterId: "u1", requestedBy: "alice@example.com" }))!),
    { title: "T", requesterId: "u1" },
    "the requester's name/email goes, the id stays",
  );
});

test("requesterAuditDetails: the id, plus the display name only when there is one — never anything else", () => {
  assert.deepEqual(requesterAuditDetails("u1", "Alice"), { requesterId: "u1", requestedBy: "Alice" });
  assert.deepEqual(requesterAuditDetails("u1", null), { requesterId: "u1" });
  assert.deepEqual(requesterAuditDetails("u1", undefined), { requesterId: "u1" });
  assert.deepEqual(requesterAuditDetails("u1", ""), { requesterId: "u1" });
});

test("stripTargetPii: nothing to remove, not JSON, or not an object ⇒ null (leave the row alone)", () => {
  assert.equal(stripTargetPii(JSON.stringify({ role: "USER" })), null);
  assert.equal(stripTargetPii('not json "targetUser"'), null);
  assert.equal(stripTargetPii(JSON.stringify(["targetUser"])), null);
  assert.equal(stripTargetPii("null"), null);
  assert.equal(stripTargetPii(JSON.stringify("targetUser")), null);
});

type Row = { id: string; target: string; details: string | null; action?: string; createdAt?: Date };
type Where = Record<string, unknown>;

// What Prisma's `contains`/`startsWith` really run: a LIKE on `%term%` /
// `term%` with the term bound unescaped and no ESCAPE clause, so `%`/`_` are
// wildcards and a backslash is Postgres's default LIKE escape. A plain
// `includes` hid R11/R12.
function like(value: string, pattern: string): boolean {
  const lit = (ch: string) => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") re += lit(pattern[++i] ?? "");
    else if (ch === "%") re += "[\\s\\S]*";
    else if (ch === "_") re += "[\\s\\S]";
    else re += lit(ch);
  }
  return new RegExp(`^${re}$`).test(value);
}

// The where subset the scrub sends, with SQL semantics: an unknown key throws
// rather than silently matching.
function matchesWhere(r: Row, w: Where): boolean {
  for (const [k, v] of Object.entries(w)) {
    if (k === "AND") {
      if (!(Array.isArray(v) ? v : [v]).every((c) => matchesWhere(r, c as Where))) return false;
    } else if (k === "OR") {
      if (!(v as Where[]).some((c) => matchesWhere(r, c))) return false;
    } else if (k === "NOT") {
      // NOT over a NULL comparison is NULL: the row is not selected.
      if ((Array.isArray(v) ? v : [v]).some((c) => r.details == null || matchesWhere(r, c as Where))) return false;
    } else if (k === "action") {
      if (typeof v === "string" ? r.action !== v : !(v as { in: string[] }).in.includes(r.action ?? "")) return false;
    } else if (k === "target") {
      if (typeof v === "string" ? r.target !== v : !like(r.target, `${(v as { startsWith: string }).startsWith}%`)) return false;
    } else if (k === "id") {
      if (typeof v === "string" ? r.id !== v : !(r.id > (v as { gt: string }).gt)) return false;
    } else if (k === "createdAt") {
      if (!r.createdAt || !(r.createdAt < (v as { lt: Date }).lt)) return false;
    } else if (k === "details") {
      if (typeof v === "string") { if (r.details !== v) return false; continue; }
      if (r.details == null || !like(r.details, `%${(v as { contains: string }).contains}%`)) return false;
    } else {
      throw new Error(`fake auditLog: unhandled where key ${k}`);
    }
  }
  return true;
}

function fakeDb(rows: Row[], opts: { concurrentEdit?: string } = {}) {
  const calls = { findMany: 0, findManyWhere: [] as Where[], updateMany: [] as Array<Record<string, unknown>> };
  const db = {
    auditLog: {
      findMany: async (args: { where: Where; orderBy: unknown; take: number; cursor?: { id: string }; skip?: number }) => {
        calls.findMany++;
        calls.findManyWhere.push(args.where);
        if (calls.findMany > 50) throw new Error("paging loop did not terminate");
        assert.deepEqual(args.orderBy, { id: "asc" });
        let list = [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
        // Prisma's cursor: `id >= (SELECT id … WHERE id = cursor)` on the table,
        // before (and independent of) the filter — NULL, so nothing, when the
        // cursor row is gone.
        if (args.cursor) {
          const at = args.cursor.id;
          list = rows.some((r) => r.id === at) ? list.filter((r) => r.id >= at) : [];
        }
        list = list.filter((r) => matchesWhere(r, args.where)).slice(args.skip ?? 0);
        return list.slice(0, args.take).map((r) => ({ id: r.id, details: r.details }));
      },
      updateMany: async (args: { where: Where & { details: string }; data: { details: string } }) => {
        calls.updateMany.push(args.where);
        const r = rows.find((x) => x.id === args.where.id);
        if (opts.concurrentEdit && r?.id === opts.concurrentEdit) r.details = JSON.stringify({ editedMeanwhile: true, targetUser: "Z" });
        if (!r || !matchesWhere(r, args.where)) return { count: 0 };
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

test("scrubTargetPiiFromAudit rewrites EVERY row across full batches — 1,001 rows, none left behind", async () => {
  // Two full 500-row pages and one row on a third. Each page's last row is
  // rewritten before the next read, so it no longer matches the filter: paging
  // by Prisma's cursor + skip:1 from it skipped the first still-matching row of
  // the next page (r00500, then r01000) and they kept the name and email.
  const rows: Row[] = [];
  for (let i = 0; i < 1001; i++) {
    rows.push({ id: `r${String(i).padStart(5, "0")}`, target: "user:u1", details: JSON.stringify({ targetUser: `N${i}`, targetEmail: `e${i}@example.com`, n: i }) });
  }
  const { db, calls } = fakeDb(rows);
  assert.equal(await scrubTargetPiiFromAudit(db, { target: "user:u1" }), 1001);
  const left = rows.filter((r) => /"target(User|Email)"/.test(r.details!)).map((r) => r.id);
  assert.deepEqual(left, [], "every row lost the target's name and email");
  assert.equal(calls.findMany, 3);
});

test("scrubTargetPiiFromAudit pages on a strict id bound and keeps the caller's AND terms on every page", async () => {
  const rows: Row[] = [];
  for (let i = 0; i < 600; i++) {
    rows.push({ id: `r${String(i).padStart(5, "0")}`, target: "user:u1", details: JSON.stringify({ targetUser: `N${i}`, keep: i % 2 === 0 }) });
  }
  const { db, calls } = fakeDb(rows);
  // Only the even rows: the caller's AND must narrow page 2 as it did page 1.
  const n = await scrubTargetPiiFromAudit(db, { target: "user:u1", AND: [{ details: { contains: '"keep":true' } }] });
  assert.equal(n, 300);
  assert.equal(calls.findMany, 1, "300 matching rows fit one page");
  const odd = rows.filter((_, i) => i % 2 === 1);
  assert.ok(odd.every((r) => r.details!.includes('"targetUser"')), "rows outside the caller's AND are untouched");

  const many: Row[] = [];
  for (let i = 0; i < 1200; i++) {
    many.push({ id: `r${String(i).padStart(5, "0")}`, target: "user:u1", details: JSON.stringify({ targetUser: `N${i}`, keep: i % 2 === 0 }) });
  }
  const second = fakeDb(many);
  assert.equal(await scrubTargetPiiFromAudit(second.db, { target: "user:u1", AND: [{ details: { contains: '"keep":true' } }] }), 600);
  const page2 = second.calls.findManyWhere[1] as { AND: Where[] };
  assert.deepEqual(page2.AND, [{ details: { contains: '"keep":true' } }, { id: { gt: "r00998" } }], "the caller's AND plus the id bound");
  assert.ok(many.filter((_, i) => i % 2 === 1).every((r) => r.details!.includes('"targetUser"')));
});

test("scrubTargetPiiFromAudit with a match predicate rewrites only the rows it accepts — and still terminates", async () => {
  const rows: Row[] = [];
  for (let i = 0; i < 1100; i++) {
    rows.push({ id: `r${String(i).padStart(5, "0")}`, target: "user:u1", details: JSON.stringify({ targetEmail: i % 3 === 0 ? "me@example.com" : `other${i}@example.com` }) });
  }
  const { db } = fakeDb(rows);
  const n = await scrubTargetPiiFromAudit(db, { target: "user:u1" }, (d) => d.targetEmail === "me@example.com");
  assert.equal(n, 367);
  for (const [i, r] of rows.entries()) {
    assert.equal(r.details!.includes("targetEmail"), i % 3 !== 0, r.id);
  }
});

test("stripTargetPii leaves details a match predicate rejects alone", () => {
  const details = JSON.stringify({ targetUser: "Alice", targetEmail: "a@example.com" });
  assert.equal(stripTargetPii(details, (d) => d.targetEmail === "b@example.com"), null);
  assert.deepEqual(JSON.parse(stripTargetPii(details, (d) => d.targetEmail === "a@example.com")!), {});
});

test("the retention scrub (a createdAt-only where) strips requestedBy from aged request moderation rows", async () => {
  const aged = new Date("2026-01-01T00:00:00.000Z");
  const fresh = new Date("2026-10-19T00:00:00.000Z");
  const cutoff = new Date("2026-07-01T00:00:00.000Z");
  const rows: Row[] = [
    { id: "a", target: "request:r1", action: "REQUEST_APPROVE", createdAt: aged, details: JSON.stringify({ title: "T", requesterId: "u1", requestedBy: "Alice" }) },
    { id: "b", target: "request:r2", action: "REQUEST_DELETE", createdAt: aged, details: JSON.stringify({ title: "T", requestedBy: "bob@example.com" }) },
    { id: "c", target: "request:r3", action: "REQUEST_DECLINE", createdAt: fresh, details: JSON.stringify({ title: "T", requestedBy: "Carol" }) },
  ];
  const { db } = fakeDb(rows);
  // The where both retention paths send (cron/scrub-audit-pii, DELETE /api/admin/audit-log).
  assert.equal(await scrubTargetPiiFromAudit(db, { createdAt: { lt: cutoff } }), 2);
  assert.deepEqual(JSON.parse(rows[0].details!), { title: "T", requesterId: "u1" });
  assert.deepEqual(JSON.parse(rows[1].details!), { title: "T" });
  assert.deepEqual(JSON.parse(rows[2].details!), { title: "T", requestedBy: "Carol" }, "inside the retention window");
});

// JSON writes `\"` for a quote and `\\` for a backslash in a value.
const AWKWARD = ['o"brien@example.com', "a\\b@example.com", "a_b@example.com", "a%b@example.com"];

test("scrubLegacySessionRevokePii finds an email with a quote, a backslash or a LIKE wildcard — exact match only", async () => {
  for (const email of AWKWARD) {
    const rows: Row[] = [
      { id: "s1", action: "SESSION_REVOKE", target: "session:1", details: JSON.stringify({ targetUser: email, targetEmail: email, deviceLabel: "d" }) },
      { id: "s2", action: "SESSION_REVOKE", target: "session:2", details: JSON.stringify({ targetUser: "X", targetEmail: `x${email}`, deviceLabel: "d" }) },
    ];
    // A look-alike the LIKE wildcard in this email would also match.
    if (/[_%]/.test(email)) {
      rows.push({ id: "s3", action: "SESSION_REVOKE", target: "session:3", details: JSON.stringify({ targetUser: "Y", targetEmail: email.replace(/[_%]/g, "z"), deviceLabel: "d" }) });
    }
    const { db } = fakeDb(rows);
    assert.equal(await scrubLegacySessionRevokePii(db, "u1", email), 1, email);
    assert.deepEqual(JSON.parse(rows[0].details!), { deviceLabel: "d" }, email);
    for (const r of rows.slice(1)) assert.match(r.details!, /"targetEmail"/, `${email}: ${r.id} is another account`);
  }
});

test("scrubLegacySessionRevokePii: the email is never a where term", async () => {
  const { db, calls } = fakeDb([]);
  await scrubLegacySessionRevokePii(db, "u1", "a@b.com");
  assert.ok(!JSON.stringify(calls.findManyWhere).includes("a@b.com"), JSON.stringify(calls.findManyWhere));
});

test("scrubRequesterPii: by requesterId, or on a row without one by the exact email — never a name, never another account", async () => {
  for (const email of [...AWKWARD, "a@b.com"]) {
    const rows: Row[] = [
      { id: "q1", action: "REQUEST_APPROVE", target: "request:1", details: JSON.stringify({ title: "T", ...requesterAuditDetails("u1", "Alice") }) },
      { id: "q2", action: "REQUEST_DECLINE", target: "request:2", details: JSON.stringify({ title: "T", requestedBy: email }) },
      { id: "q3", action: "REQUEST_DELETE", target: "request:3", details: JSON.stringify({ title: "T", requestedBy: `x${email}` }) },
      { id: "q4", action: "REQUEST_DELETE", target: "request:4", details: JSON.stringify({ title: "T", ...requesterAuditDetails("u2", "Alice") }) },
      // Another account's new row, whose name happens to be this email.
      { id: "q5", action: "REQUEST_APPROVE", target: "request:5", details: JSON.stringify({ title: "T", requesterId: "u2", requestedBy: email }) },
      { id: "q6", action: "REQUEST_APPROVE", target: "request:6", details: JSON.stringify({ title: "T", requestedBy: "Alice" }) },
      { id: "q7", action: "SETTINGS_CHANGE", target: "request:7:adminNote", details: JSON.stringify({ requestedBy: email }) },
    ];
    const { db, calls } = fakeDb(rows);
    assert.equal(await scrubRequesterPii(db, "u1", email), 2, email);
    assert.deepEqual(JSON.parse(rows[0].details!), { title: "T", requesterId: "u1" }, email);
    assert.deepEqual(JSON.parse(rows[1].details!), { title: "T" }, email);
    for (const r of rows.slice(2)) assert.match(r.details!, /"requestedBy"/, `${email}: ${r.id} is not this account's`);
    assert.ok(!JSON.stringify(calls.findManyWhere).includes(JSON.stringify(email).slice(1, -1)), "the email is never a where term");
  }
});

test("scrubRequesterPii: the exact match decides, even if an id held a LIKE wildcard the where term widens on", async () => {
  // Ids are cuid2 (no `_`/`%`), but the where is only ever a pre-filter.
  const email = "a@b.com";
  const rows: Row[] = [
    { id: "q1", action: "REQUEST_APPROVE", target: "request:1", details: JSON.stringify({ title: "T", requesterId: "u_1", requestedBy: "Alice" }) },
    // Fetched by the `u_1` pattern; another account, whose display name is this email.
    { id: "q2", action: "REQUEST_APPROVE", target: "request:2", details: JSON.stringify({ title: "T", requesterId: "uX1", requestedBy: email }) },
  ];
  const { db } = fakeDb(rows);
  assert.equal(await scrubRequesterPii(db, "u_1", email), 1);
  assert.deepEqual(JSON.parse(rows[0].details!), { title: "T", requesterId: "u_1" });
  assert.deepEqual(JSON.parse(rows[1].details!), { title: "T", requesterId: "uX1", requestedBy: email }, "uX1 is another account");
});
