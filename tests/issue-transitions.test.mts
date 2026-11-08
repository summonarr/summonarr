// promoteIssueInProgress (src/lib/issue-transitions.ts): the OPEN → IN_PROGRESS
// flip several issue routes share. Two callers that both read the issue OPEN
// race on the write; only the one whose write found it OPEN may announce and
// audit the flip.
process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "issue-transitions-test-secret-0123456789abcdef";
process.env.TRUST_PROXY = "true";

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const { sseEmitter } = await import("../src/lib/sse-emitter.ts");
const { promoteIssueInProgress, resolveIssueAfterAction } = await import("../src/lib/issue-transitions.ts");

// One row, with updateMany honouring its predicate the way Postgres would.
let row = { id: "iss-1", status: "OPEN" };
// What the NEXT findUnique reports instead of the row (once): a read gone stale.
let staleRead: { status: string } | null = null;
const audits: unknown[] = [];
const detail = { reportedBy: "reporter-1", title: "Dune", mediaType: "MOVIE", tmdbId: 438631, posterPath: null, issueType: "BAD_VIDEO" };
shadowPrismaModel(prisma, "issue", {
  findUnique: async () => {
    const read = { ...detail, ...row, ...(staleRead ?? {}) };
    staleRead = null;
    return read;
  },
  updateMany: async (a: { where: { id: string; status: string | { not: string } }; data: { status: string } }) => {
    const want = a.where.status;
    const matches = typeof want === "string" ? row.status === want : row.status !== want.not;
    if (!matches) return { count: 0 };
    row = { ...row, ...a.data };
    return { count: 1 };
  },
});
shadowPrismaModel(prisma, "user", { findUnique: async () => ({ deactivatedAt: null }) });
shadowPrismaModel(prisma, "notification", { create: async () => ({}) });
shadowPrismaModel(prisma, "notificationAgent", { findMany: async () => [] });
shadowPrismaModel(prisma, "pushSubscription", { findMany: async () => [] });
shadowPrismaModel(prisma, "auditLog", { create: async (a: unknown) => { audits.push(a); return {}; } });
const sse: Array<Record<string, unknown>> = [];
sseEmitter.on("event", (e: Record<string, unknown>) => { sse.push(e); });

const session = { user: { id: "admin-1", name: "Admin", email: null, role: "ADMIN", permissions: 1 } } as never;
const req = { headers: new Headers() };
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => { row = { id: "iss-1", status: "OPEN" }; staleRead = null; audits.length = 0; sse.length = 0; });

test("two promotes that both read OPEN flip it once, announced and audited once", async () => {
  const seen = { id: "iss-1", status: "OPEN", reportedBy: "reporter-1" };
  const [a, b] = await Promise.all([
    promoteIssueInProgress({ issue: seen, from: "notResolved", trigger: "grab", session, req }),
    promoteIssueInProgress({ issue: seen, from: "notResolved", trigger: "grab", session, req }),
  ]);
  await flush();
  assert.deepEqual([a, b], [1, 1], "both still claim the unresolved issue");
  assert.equal(row.status, "IN_PROGRESS");
  assert.equal(sse.filter((e) => e.type === "issue:updated").length, 1);
  assert.equal(audits.length, 1);
});

test("a resolved issue is never claimed; an admin's first reply on an issue no longer OPEN changes nothing", async () => {
  row = { id: "iss-1", status: "RESOLVED" };
  const seen = { id: "iss-1", status: "OPEN", reportedBy: "reporter-1" };
  assert.equal(await promoteIssueInProgress({ issue: seen, from: "notResolved", trigger: "grab", session, req }), 0);
  row = { id: "iss-1", status: "IN_PROGRESS" };
  assert.equal(await promoteIssueInProgress({ issue: seen, from: "open", trigger: "reply", session, req }), 0);
  await flush();
  assert.equal(row.status, "IN_PROGRESS");
  assert.equal(sse.length, 0);
  assert.equal(audits.length, 0);
});

test("a close that committed answers true even when its announcement throws", async () => {
  const boom = () => { throw new Error("listener down"); };
  sseEmitter.on("event", boom);
  const origErr = console.error; console.error = () => {};
  try {
    const closed = await resolveIssueAfterAction({
      issueId: "iss-1", about: { tmdbId: 438631, mediaType: "MOVIE" }, resolution: "Rematched", trigger: "fix-match",
      actor: { userId: "admin-1", userName: "Admin", ctx: {} as never },
    });
    assert.equal(closed, true);
    assert.equal(row.status, "RESOLVED");
  } finally {
    sseEmitter.off("event", boom);
    console.error = origErr;
  }
});

test("a close audits the status it really closed from, not a stale read", async () => {
  row = { id: "iss-1", status: "IN_PROGRESS" };
  staleRead = { status: "OPEN" }; // read before an admin's grab promoted it
  const closed = await resolveIssueAfterAction({
    issueId: "iss-1", about: { tmdbId: 438631, mediaType: "MOVIE" }, resolution: "Rematched", trigger: "fix-match",
    actor: { userId: "admin-1", userName: "Admin", ctx: {} as never },
  });
  await flush();
  assert.equal(closed, true);
  assert.equal(row.status, "RESOLVED");
  assert.equal(audits.length, 1);
  const details = JSON.parse((audits[0] as { data: { details: string } }).data.details) as { before: { status: string } };
  assert.deepEqual(details.before, { status: "IN_PROGRESS" });
});

test("a close that lost to another resolve announces nothing", async () => {
  row = { id: "iss-1", status: "RESOLVED" };
  staleRead = { status: "OPEN" };
  const closed = await resolveIssueAfterAction({
    issueId: "iss-1", about: { tmdbId: 438631, mediaType: "MOVIE" }, resolution: "Rematched", trigger: "fix-match",
    actor: { userId: "admin-1", userName: "Admin", ctx: {} as never },
  });
  await flush();
  assert.equal(closed, true, "closed is closed, whoever closed it");
  assert.equal(sse.length, 0);
  assert.equal(audits.length, 0);
});
