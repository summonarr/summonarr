// The audit-log filter is built once (src/lib/audit-log-filter.ts) for the
// admin page's first page, the list API's "Load more" and the export. Three
// copies had drifted: the page dropped an unparseable date and rendered an
// UNFILTERED list, while "Load more" and the export of the same view answered
// 400. These pin the builder's own rules; tests/admin-users-audit-routes
// pins that the list and the export hand Prisma the same `where`.
import { test } from "node:test";
import assert from "node:assert/strict";

// A zone with DST, so the dateTo case below crosses a change wherever the
// suite runs: local-time day arithmetic lands 23h later there, not 24h.
process.env.TZ = "America/Los_Angeles";

const { buildAuditLogWhere, AUDIT_GROUP_ACTIONS } = await import("../src/lib/audit-log-filter.ts");
const { AUDIT_ACTIONS, ACTION_GROUP } = await import("../src/lib/audit-actions.ts");

const build = (q: string) => buildAuditLogWhere(new URLSearchParams(q));

function ok(q: string) {
  const r = build(q);
  if (r.error) assert.fail(`unexpected ${r.error} for ${q}`);
  return r;
}

test("an unparseable dateFrom or dateTo is an error naming the param — never a silently dropped bound", () => {
  assert.deepEqual(build("dateFrom=not-a-date"), { error: "invalidDateFrom", param: "dateFrom" });
  assert.deepEqual(build("dateTo=not-a-date"), { error: "invalidDateTo", param: "dateTo" });
  assert.deepEqual(build("dateFrom=2026-13-45&dateTo=2026-07-01"), { error: "invalidDateFrom", param: "dateFrom" });
  assert.deepEqual(build("dateFrom=2026-07-01&dateTo=nope"), { error: "invalidDateTo", param: "dateTo" });
});

test("dateFrom is the lower bound as sent; dateTo is exclusive, exactly 24h past the instant sent", () => {
  const from = "2026-03-07T08:00:00.000Z";
  const to = "2026-03-08T08:00:00.000Z"; // the Los Angeles day start the filter bar sends, on the DST change
  const { where } = ok(`dateFrom=${from}&dateTo=${to}`);
  const createdAt = where.createdAt as { gte: Date; lt: Date };
  assert.equal(createdAt.gte.toISOString(), from);
  assert.equal(createdAt.lt.getTime() - new Date(to).getTime(), 24 * 3_600_000);
  // A bare YYYY-MM-DD from an old bookmark still parses, as UTC midnight.
  const bare = ok("dateTo=2026-07-01").where.createdAt as { lt: Date; gte?: Date };
  assert.equal(bare.lt.toISOString(), "2026-07-02T00:00:00.000Z");
  assert.equal(bare.gte, undefined);
});

test("action beats group; an unknown action is ignored (the group still applies) and reads back as null", () => {
  const both = ok("action=AUTH_LOGIN&group=admin");
  assert.equal(both.where.action, "AUTH_LOGIN");
  assert.equal(both.filters.action, "AUTH_LOGIN");
  assert.equal(both.filters.group, "admin");

  const unknown = ok("action=NOT_A_REAL_ACTION&group=auth");
  assert.deepEqual(unknown.where.action, { in: AUDIT_GROUP_ACTIONS.auth });
  assert.equal(unknown.filters.action, null);

  const nothing = ok("action=NOT_A_REAL_ACTION&group=bogus");
  assert.equal(nothing.where.action, undefined);
  assert.equal(nothing.filters.group, null);
});

test("every audit action sits in exactly the group ACTION_GROUP gives it", () => {
  const seen = new Set<string>();
  for (const [group, actions] of Object.entries(AUDIT_GROUP_ACTIONS)) {
    for (const a of actions) {
      assert.equal(ACTION_GROUP[a], group, a);
      assert.ok(!seen.has(a), `${a} is in two groups`);
      seen.add(a);
    }
  }
  assert.equal(seen.size, AUDIT_ACTIONS.length);
});

test("hideCron hides the system principal but KEEPS null-userId rows (the machine-session mint)", () => {
  const { where, filters } = ok("hideCron=1");
  assert.deepEqual(where.AND, [{ OR: [{ userId: null }, { userId: { not: "system" } }] }]);
  assert.equal(filters.hideCron, true);
  assert.equal(ok("hideCron=true").where.AND, undefined, "only the literal 1 turns it on");
});

test("the user and target terms are wildcard-stripped, case-insensitive contains", () => {
  const { where, filters } = ok(`user=${encodeURIComponent("al%_\\ice")}&target=${encodeURIComponent("user:%")}`);
  assert.deepEqual(where.userName, { contains: "alice", mode: "insensitive" });
  assert.deepEqual(where.target, { contains: "user:", mode: "insensitive" });
  assert.equal(filters.user, "al%_\\ice", "the filter reads back as sent");
});

test("a repeated key reads as its first value, and an empty value is no filter", () => {
  const { where } = ok("user=first&user=second&target=");
  assert.deepEqual(where.userName, { contains: "first", mode: "insensitive" });
  assert.equal(where.target, undefined);
  assert.deepEqual(ok("dateFrom=&dateTo=").where, {});
  assert.deepEqual(ok("").filters, {
    action: null, group: null, dateFrom: null, dateTo: null, user: null, target: null, hideCron: false,
  });
});
