// The audit-log PII retention scrub both paths run (src/lib/audit-pii-scrub.ts):
// each column pass writes in bounded batches until one comes back short, and
// a scrub that stops part-way says which steps finished.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
console.error = () => {};
console.warn = () => {};

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const { AUDIT_SCRUB_BATCH, AuditPiiScrubError, scrubAuditPii } = await import("../src/lib/audit-pii-scrub.ts");
const { REDACTED_USER_NAME } = await import("../src/lib/audit.ts");

type Row = { id: string; createdAt: Date; ipAddress: string | null; userAgent: string | null; userName: string; action: string; details: string | null };
let rows: Row[] = [];
const updates: Array<{ where: Record<string, unknown>; limit?: number }> = [];
let failOnUpdate: number | null = null;

const OLD = new Date("2020-01-01T00:00:00Z");
const CUTOFF = new Date("2024-01-01T00:00:00Z");

// Just enough of the two column passes' filters to apply them in memory.
function matches(r: Row, where: Record<string, unknown>): boolean {
  const lt = (where.createdAt as { lt?: Date } | undefined)?.lt;
  if (lt && !(r.createdAt < lt)) return false;
  const actions = (where.action as { in?: string[] } | undefined)?.in;
  if (actions && !actions.includes(r.action)) return false;
  if (where.details && r.details === null) return false;
  if (Array.isArray(where.OR)) return r.ipAddress !== null || r.userAgent !== null || r.userName !== REDACTED_USER_NAME;
  return true;
}

shadowPrismaModel(prisma, "auditLog", {
  updateMany: async (args: { where: Record<string, unknown>; data: Partial<Row>; limit?: number }) => {
    updates.push({ where: args.where, limit: args.limit });
    if (failOnUpdate !== null && updates.length === failOnUpdate) throw new Error("simulated lock timeout");
    let n = 0;
    for (const r of rows) {
      if (args.limit !== undefined && n >= args.limit) break;
      if (!matches(r, args.where)) continue;
      Object.assign(r, args.data);
      n++;
    }
    return { count: n };
  },
  findMany: async () => [],
});

beforeEach(() => {
  rows = [];
  updates.length = 0;
  failOnUpdate = null;
});

const row = (i: number, extra: Partial<Row> = {}): Row => ({
  id: `r${i}`, createdAt: OLD, ipAddress: "10.0.0.1", userAgent: "ua", userName: "bob", action: "AUTH_LOGIN", details: "{}", ...extra,
});

test("each column pass writes at most AUDIT_SCRUB_BATCH rows a statement, and repeats until a batch comes back short", async () => {
  rows = Array.from({ length: AUDIT_SCRUB_BATCH * 2 + 3 }, (_, i) => row(i));
  const counts = await scrubAuditPii(CUTOFF);
  assert.equal(counts.scrubbed, AUDIT_SCRUB_BATCH * 2 + 3);
  assert.equal(counts.authDetailsCleared, AUDIT_SCRUB_BATCH * 2 + 3);
  assert.ok(updates.every((u) => u.limit === AUDIT_SCRUB_BATCH), "every statement is bounded");
  // Three PII statements (full, full, short), then three details statements.
  assert.equal(updates.length, 6);
  assert.ok(rows.every((r) => r.ipAddress === null && r.userAgent === null && r.userName === REDACTED_USER_NAME && r.details === null));
});

test("rows inside the retention window are untouched, and a scrub with nothing to do is one statement per pass", async () => {
  rows = [row(1, { createdAt: new Date("2025-01-01T00:00:00Z") })];
  const counts = await scrubAuditPii(CUTOFF);
  assert.deepEqual(counts, { scrubbed: 0, authDetailsCleared: 0, adminDetailsScrubbed: 0 });
  assert.equal(updates.length, 2);
  assert.equal(rows[0].ipAddress, "10.0.0.1");
});

test("a scrub that fails part-way throws AuditPiiScrubError naming the steps that finished", async () => {
  rows = [row(1)];
  failOnUpdate = 2; // the login-details pass
  await assert.rejects(scrubAuditPii(CUTOFF), (err: unknown) => {
    assert.ok(err instanceof AuditPiiScrubError);
    assert.deepEqual(err.done, { scrubbed: 1 });
    assert.match(err.message, /simulated lock timeout/);
    return true;
  });
});
