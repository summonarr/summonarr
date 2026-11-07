// Auto-resolve an issue when its replacement lands (src/lib/issue-auto-resolve.ts),
// called by the Radarr/Sonarr Download webhooks on the FIRST claim of a grab.
process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "issue-auto-resolve-test-secret-0123456789abcdef";
process.env.TRUST_PROXY = "true";

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const { invalidateFeatureFlagCache } = await import("../src/lib/features.ts");
const { sseEmitter } = await import("../src/lib/sse-emitter.ts");
const m = await import("../src/lib/issue-auto-resolve.ts");
const { autoResolveIssueForGrab, scopeCanAutoResolve, grabIsFreshEnough, AUTO_RESOLVE_MAX_GRAB_AGE_DAYS } = m;

const NOW = new Date("2026-10-31T12:00:00Z");
const settings = new Map<string, string>();
type Args = { where?: unknown; data: Record<string, unknown> };
type Op = { op: string; args?: Args };
const ops: Op[] = [];
const rec = (op: string, args?: unknown) => { ops.push({ op, args: args as Args }); };
const sse: Array<Record<string, unknown>> = [];
sseEmitter.on("event", (e: Record<string, unknown>) => { sse.push(e); });

let issueRow: Record<string, unknown> | null = null;
let casCount = 1;
let reporter: Record<string, unknown> | null = { deactivatedAt: null };

shadowPrismaModel(prisma, "setting", {
  findUnique: async (a: { where: { key: string } }) => (settings.has(a.where.key) ? { key: a.where.key, value: settings.get(a.where.key) } : null),
  findMany: async (a: { where: { key: { in: string[] } } }) => a.where.key.in.filter((k) => settings.has(k)).map((k) => ({ key: k, value: settings.get(k) })),
});
shadowPrismaModel(prisma, "issue", {
  findUnique: async () => (issueRow ? { ...issueRow } : null),
  updateMany: async (a: unknown) => { rec("issue.updateMany", a); return { count: casCount }; },
});
shadowPrismaModel(prisma, "user", { findUnique: async (a: unknown) => { rec("user.findUnique", a); return reporter; } });
shadowPrismaModel(prisma, "auditLog", { create: async (a: unknown) => { rec("auditLog.create", a); return {}; } });
shadowPrismaModel(prisma, "notification", { create: async (a: unknown) => { rec("notification.create", a); return {}; } });
shadowPrismaModel(prisma, "notificationAgent", { findMany: async () => [] });
shadowPrismaModel(prisma, "pushSubscription", { findMany: async () => [] });

const grab = (over: Record<string, unknown> = {}) => ({
  issueId: "iss-1", triggeredById: "admin-1", mediaType: "MOVIE", scope: "FULL", createdAt: new Date(NOW.getTime() - 3600_000), ...over,
});
const count = (name: string) => ops.filter((o) => o.op === name).length;
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  ops.length = 0; sse.length = 0; settings.clear(); invalidateFeatureFlagCache();
  casCount = 1; reporter = { deactivatedAt: null };
  issueRow = { id: "iss-1", status: "OPEN", reportedBy: "reporter-1", title: "Dune", mediaType: "MOVIE", tmdbId: 438631, posterPath: null, issueType: "BAD_VIDEO" };
});

test("scope rule: a movie resolves; TV only on a single-episode issue — a season or whole series stays with the admin", () => {
  assert.equal(scopeCanAutoResolve({ mediaType: "MOVIE", scope: "FULL" }), true);
  assert.equal(scopeCanAutoResolve({ mediaType: "TV", scope: "EPISODE" }), true);
  assert.equal(scopeCanAutoResolve({ mediaType: "TV", scope: "SEASON" }), false);
  assert.equal(scopeCanAutoResolve({ mediaType: "TV", scope: "FULL" }), false);
});

test("freshness: a grab older than the window is a stale intent", () => {
  const edge = AUTO_RESOLVE_MAX_GRAB_AGE_DAYS * 86_400_000;
  assert.equal(grabIsFreshEnough(new Date(NOW.getTime() - edge), NOW), true);
  assert.equal(grabIsFreshEnough(new Date(NOW.getTime() - edge - 1), NOW), false);
});

test("a landed replacement resolves the issue, audits it as system, tells the reporter", async () => {
  assert.equal(await autoResolveIssueForGrab(grab(), NOW), true);
  await flush();
  const cas = ops.find((o) => o.op === "issue.updateMany")!.args!;
  assert.deepEqual(cas.where, { id: "iss-1", status: { in: ["OPEN", "IN_PROGRESS"] } });
  assert.equal(cas.data.status, "RESOLVED");
  assert.deepEqual(cas.data.resolvedAt, NOW);
  assert.deepEqual(sse.find((e) => e.type === "issue:updated"), { type: "issue:updated", issueId: "iss-1", status: "RESOLVED", userId: "reporter-1" });
  const audit = ops.find((o) => o.op === "auditLog.create")!.args!.data;
  assert.equal(audit.action, "ISSUE_STATUS_CHANGE");
  assert.equal(audit.userName, "system");
  assert.equal(JSON.parse(audit.details as string).trigger, "auto-resolve-replacement");
  const note = ops.find((o) => o.op === "notification.create")!.args!.data;
  assert.equal(note.userId, "reporter-1");
  assert.equal(note.type, "ISSUE_RESOLVED");
  // The row an admin's resolve with no note stores (tests/issues-routes.test.mts):
  // one writer, announceIssueResolved, for both.
  assert.equal(note.body, "Your reported issue was resolved.");
  assert.deepEqual(note.data, { v: 1, resolution: null });
});

test("feature switched off ⇒ nothing is written", async () => {
  settings.set("feature.behavior.issueAutoResolve", "false"); invalidateFeatureFlagCache();
  assert.equal(await autoResolveIssueForGrab(grab(), NOW), false);
  assert.equal(count("issue.updateMany"), 0);
});

test("an already RESOLVED issue, or a lost CAS, announces nothing", async () => {
  issueRow = { ...issueRow!, status: "RESOLVED" };
  assert.equal(await autoResolveIssueForGrab(grab(), NOW), false);
  assert.equal(count("issue.updateMany"), 0);
  issueRow = { ...issueRow, status: "OPEN" };
  casCount = 0; // an admin resolved it between the read and the write
  assert.equal(await autoResolveIssueForGrab(grab(), NOW), false);
  await flush();
  assert.equal(count("auditLog.create"), 0);
  assert.equal(count("notification.create"), 0);
});

test("a TV season grab and a stale grab never auto-resolve", async () => {
  assert.equal(await autoResolveIssueForGrab(grab({ mediaType: "TV", scope: "SEASON" }), NOW), false);
  assert.equal(await autoResolveIssueForGrab(grab({ createdAt: new Date(NOW.getTime() - 40 * 86_400_000) }), NOW), false);
  assert.equal(count("issue.updateMany"), 0);
});

test("the reporter is not messaged when they ARE the admin whose grab landed, nor when deactivated (guardrail 33)", async () => {
  assert.equal(await autoResolveIssueForGrab(grab({ triggeredById: "reporter-1" }), NOW), true);
  await flush();
  assert.equal(count("notification.create"), 0, "they were just told by the grab-completed push");
  ops.length = 0; issueRow = { ...issueRow!, status: "OPEN" };
  reporter = { deactivatedAt: new Date() };
  assert.equal(await autoResolveIssueForGrab(grab(), NOW), true);
  await flush();
  assert.equal(count("notification.create"), 0);
});

test("never throws into the webhook", async () => {
  shadowPrismaModel(prisma, "issue", { findUnique: async () => { throw new Error("db down"); }, updateMany: async () => ({ count: 0 }) });
  const origErr = console.error; console.error = () => {};
  try { assert.equal(await autoResolveIssueForGrab(grab(), NOW), false); } finally { console.error = origErr; }
});
