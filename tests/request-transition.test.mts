// The request decision state machine (src/lib/request-transition.ts): the ONE
// push → settle step every approval path runs (the single PATCH, the batch
// PATCH, the Discord buttons, auto-approve at creation and in bulk), and the
// follow-up the deciding paths share.
//
//   1. A push settles as pushed / unknown / rolled-back / failed, and only a
//      rollback that LANDED announces PENDING. A rollback that matched nothing
//      (the row moved on) or whose write threw announces nothing: the row is not
//      PENDING, and telling the live lists it is would be false.
//   2. A failed rollback write is caught, never thrown into the caller.
//   3. An unknown outcome (the add was sent, no definite answer) is never rolled
//      back; a failure before the add went out always is.
//   4. A Sonarr add stamps its tvdbId outside the push's failure handling.
//   5. The 90s download check goes to every row that kept its backstop (all but
//      rolled-back), and "approved" only to requesters whose approval stands,
//      never to the admin deciding their own request.
//
// Harness: in-memory prisma stubs, a scripted Radarr/Sonarr behind the fetch
// seam, the real SSE emitter. No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);

const errors: string[] = [];
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
console.warn = () => {};

// ── a scripted Radarr/Sonarr ─────────────────────────────────────────────────
// `addStatus` answers the add itself; `lookupStatus` the lookup before it (a
// failure there means the add was never sent).
let addStatus: number | null = null;
let lookupStatus: number | null = null;
const adds: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
  if (url.pathname.includes("/api/v3/qualityprofile")) return json([{ id: 1, name: "HD-1080p" }]);
  if (url.pathname.includes("/api/v3/rootfolder")) return json([{ path: "/media" }]);
  if (url.pathname.includes("/api/v3/languageprofile")) return json([{ id: 1 }]);
  if (url.pathname.includes("/lookup")) {
    if (lookupStatus !== null) return json({ message: "LOOKUP DOWN" }, lookupStatus);
    const tmdbId = Number((url.searchParams.get("term") ?? "").replace(/^tmdb:/, "")) || 0;
    return json([{ tmdbId, tvdbId: 4242, title: "The Matrix", year: 1999, titleSlug: "the-matrix", images: [], seasons: [] }]);
  }
  if ((init?.method ?? "GET") === "POST" && (url.pathname.endsWith("/api/v3/movie") || url.pathname.endsWith("/api/v3/series"))) {
    adds.push(url.pathname);
    if (addStatus !== null) return new Response("upstream says no", { status: addStatus });
    return json({ id: 1, tvdbId: 4242 });
  }
  return json([]);
}) as unknown as typeof fetch;

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const { sseEmitter } = await import("../src/lib/sse-emitter.ts");
const {
  pushApproval,
  pushApprovals,
  downloadChecksFor,
  followUpDecidedApprovals,
  approvalStands,
  isAllowedTransition,
} = await import("../src/lib/request-transition.ts");

const sse: Array<{ type: string; requestId?: string; status?: string }> = [];
sseEmitter.on("event", (e: { type: string; requestId?: string; status?: string }) => { sse.push(e); });

const settings = new Map<string, string>([
  ["radarrUrl", "http://10.0.0.2:7878"],
  ["radarrApiKey", "radarr-key"],
  ["sonarrUrl", "http://10.0.0.3:8989"],
  ["sonarrApiKey", "sonarr-key"],
]);
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
  findMany: async (args: { where?: { key?: { in?: string[] } } } = {}) => {
    const keys = args.where?.key?.in;
    return [...settings.entries()].filter(([k]) => !keys || keys.includes(k)).map(([key, value]) => ({ key, value }));
  },
});

type Row = { id: string; status: string; pendingNotifyAt: Date | null; tvdbId: number | null };
let rows: Row[] = [];
const writes: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
// Throws on the rollback write (data.status === "PENDING") when set.
let rollbackThrows = false;
shadowPrismaModel(prisma, "mediaRequest", {
  updateMany: async (args: { where: { id: string; status?: string }; data: Record<string, unknown> }) => {
    writes.push(args);
    if (rollbackThrows && args.data.status === "PENDING") throw new Error("pool timeout");
    let count = 0;
    for (const r of rows) {
      if (r.id !== args.where.id) continue;
      if (args.where.status !== undefined && r.status !== args.where.status) continue;
      Object.assign(r, args.data);
      count++;
    }
    return { count };
  },
});
const ownerReads: string[][] = [];
shadowPrismaModel(prisma, "user", {
  // notifyRequestStatusChanges' one owner read: the ids it was asked about.
  findMany: async (args: { where: { id: { in: string[] } } }) => {
    ownerReads.push([...args.where.id.in].sort());
    return [];
  },
});

beforeEach(() => {
  addStatus = null;
  lookupStatus = null;
  adds.length = 0;
  rows = [];
  writes.length = 0;
  rollbackThrows = false;
  sse.length = 0;
  errors.length = 0;
  ownerReads.length = 0;
});

const MOVIE = { id: "r1", tmdbId: 603, mediaType: "MOVIE", arrInstance: "", requestedBy: "u1", qualityProfileId: null };
const approvedRow = (id = "r1"): Row => ({ id, status: "APPROVED", pendingNotifyAt: new Date(), tvdbId: null });

// ── 1–3: the settle ──────────────────────────────────────────────────────────

test("a push that lands is `pushed`: no rollback, nothing announced", async () => {
  rows = [approvedRow()];
  const outcome = await pushApproval(MOVIE, "Approve");
  assert.equal(outcome.kind, "pushed");
  assert.equal(adds.length, 1);
  assert.equal(rows[0].status, "APPROVED");
  assert.deepEqual(sse, []);
  assert.equal(approvalStands(outcome), true);
});

test("a definite failure rolls back to PENDING, disarms the backstop and announces PENDING — once", async () => {
  rows = [approvedRow()];
  addStatus = 500;
  const outcome = await pushApproval(MOVIE, "Approve");
  assert.equal(outcome.kind, "rolled-back");
  assert.equal(rows[0].status, "PENDING");
  assert.equal(rows[0].pendingNotifyAt, null);
  assert.deepEqual(writes.map((w) => w.where), [{ id: "r1", status: "APPROVED" }], "the rollback is a CAS on APPROVED");
  assert.deepEqual(sse, [{ type: "request:updated", requestId: "r1", status: "PENDING", userId: "u1" }]);
  assert.ok(errors.some((e) => e.includes("[arr] Approve push failed (request r1)")));
  assert.equal(approvalStands(outcome), false);
});

test("a rollback that matches nothing (the row moved on) is `failed` and announces NO PENDING", async () => {
  // A webhook marked the row AVAILABLE between the claim and the failed push.
  rows = [{ ...approvedRow(), status: "AVAILABLE" }];
  addStatus = 500;
  const outcome = await pushApproval(MOVIE, "Approve");
  assert.equal(outcome.kind, "failed");
  assert.equal(rows[0].status, "AVAILABLE", "the moved row is left alone");
  assert.deepEqual(sse, [], "telling the lists PENDING would be false");
});

test("a rollback write that THROWS is caught and logged: `failed`, the row still APPROVED, nothing announced", async () => {
  rows = [approvedRow()];
  addStatus = 500;
  rollbackThrows = true;
  const outcome = await pushApproval(MOVIE, "Discord approve");
  assert.equal(outcome.kind, "failed");
  assert.equal(rows[0].status, "APPROVED");
  assert.deepEqual(sse, []);
  assert.ok(errors.some((e) => e.includes("[requests] rollback to PENDING failed (request r1)") && e.includes("pool timeout")));
});

test("an add that was SENT and got no definite answer (gateway 504) is `unknown`: never rolled back", async () => {
  rows = [approvedRow()];
  addStatus = 504;
  const outcome = await pushApproval(MOVIE, "Auto-approve");
  assert.equal(outcome.kind, "unknown");
  assert.equal(rows[0].status, "APPROVED");
  assert.ok(rows[0].pendingNotifyAt instanceof Date, "the backstop stays armed");
  assert.equal(writes.length, 0, "no rollback write at all");
  assert.deepEqual(sse, []);
  assert.ok(errors.some((e) => e.includes("[arr] Auto-approve push outcome unknown, left APPROVED (request r1)")));
  assert.equal(approvalStands(outcome), true);
});

test("a gateway error BEFORE the add went out (the lookup) added nothing: rolled back", async () => {
  rows = [approvedRow()];
  lookupStatus = 504;
  const outcome = await pushApproval(MOVIE, "Approve");
  assert.equal(adds.length, 0, "fixture sanity: the add was never sent");
  assert.equal(outcome.kind, "rolled-back");
  assert.equal(rows[0].status, "PENDING");
});

// ── 4: Sonarr's tvdbId ───────────────────────────────────────────────────────

test("a Sonarr add stamps its tvdbId; a failed stamp is logged and the push still counts as landed", async () => {
  rows = [approvedRow("tv1")];
  const series = { ...MOVIE, id: "tv1", mediaType: "TV" };
  assert.equal((await pushApproval(series, "Approve")).kind, "pushed");
  assert.equal(rows[0].tvdbId, 4242);
  assert.deepEqual(writes.at(-1)?.where, { id: "tv1" });

  rows = [approvedRow("tv1")];
  shadowPrismaModel(prisma, "mediaRequest", {
    updateMany: async (args: { data: Record<string, unknown> }) => {
      if ("tvdbId" in args.data) throw new Error("stamp lost");
      return { count: 1 };
    },
  });
  try {
    const outcome = await pushApproval(series, "Approve");
    assert.equal(outcome.kind, "pushed", "a bookkeeping failure is not a push failure");
    assert.equal(rows[0].status, "APPROVED");
    assert.ok(errors.some((e) => e.includes("[requests] tvdbId stamp failed (request tv1)")));
  } finally {
    shadowPrismaModel(prisma, "mediaRequest", {
      updateMany: async () => ({ count: 0 }),
    });
  }
});

test("pushApprovals settles every row and keeps the rows' order", async () => {
  shadowPrismaModel(prisma, "mediaRequest", {
    updateMany: async (args: { where: { id: string; status?: string }; data: Record<string, unknown> }) => {
      let count = 0;
      for (const r of rows) {
        if (r.id !== args.where.id || (args.where.status !== undefined && r.status !== args.where.status)) continue;
        Object.assign(r, args.data);
        count++;
      }
      return { count };
    },
  });
  rows = [approvedRow("a"), approvedRow("b")];
  const settled = await pushApprovals([{ ...MOVIE, id: "a" }, { ...MOVIE, id: "b", tmdbId: 604 }], "Batch approve");
  assert.deepEqual(settled.map((s) => [s.row.id, s.outcome.kind]), [["a", "pushed"], ["b", "pushed"]]);
});

// ── 5: the follow-up ─────────────────────────────────────────────────────────

const followRow = (id: string, requestedBy: string) => ({ ...MOVIE, id, requestedBy, title: `T ${id}`, posterPath: null });

test("the download check goes to every row that kept its backstop — all but a rolled-back one", () => {
  const settled = [
    { row: followRow("pushed", "u1"), outcome: { kind: "pushed" as const } },
    { row: followRow("unknown", "u1"), outcome: { kind: "unknown" as const, error: null } },
    { row: followRow("failed", "u1"), outcome: { kind: "failed" as const, error: null } },
    { row: followRow("rolled", "u1"), outcome: { kind: "rolled-back" as const, error: null } },
  ];
  assert.deepEqual(downloadChecksFor(settled).map((c) => c.requestId), ["pushed", "unknown", "failed"]);
});

test("'approved' goes only to requesters whose approval stands, never to the admin deciding their own request", async () => {
  const settled = [
    { row: followRow("pushed", "u-pushed"), outcome: { kind: "pushed" as const } },
    { row: followRow("unknown", "u-unknown"), outcome: { kind: "unknown" as const, error: null } },
    { row: followRow("failed", "u-failed"), outcome: { kind: "failed" as const, error: null } },
    { row: followRow("rolled", "u-rolled"), outcome: { kind: "rolled-back" as const, error: null } },
    { row: followRow("mine", "admin-1"), outcome: { kind: "pushed" as const } },
  ];
  followUpDecidedApprovals(settled, { actorId: "admin-1", checkName: "test:download-check", logScope: "test" });
  for (let i = 0; i < 20 && ownerReads.length === 0; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(ownerReads, [["u-pushed", "u-unknown"]]);
});

test("the transition table: every target differs from its source, and AVAILABLE is terminal", () => {
  assert.equal(isAllowedTransition("PENDING", "APPROVED"), true);
  assert.equal(isAllowedTransition("DECLINED", "APPROVED"), true);
  assert.equal(isAllowedTransition("DECLINED", "PENDING"), true);
  assert.equal(isAllowedTransition("APPROVED", "AVAILABLE"), true);
  for (const s of ["PENDING", "APPROVED", "DECLINED", "AVAILABLE"] as const) assert.equal(isAllowedTransition(s, s), false, s);
  for (const s of ["PENDING", "APPROVED", "DECLINED"] as const) assert.equal(isAllowedTransition("AVAILABLE", s), false, s);
});
