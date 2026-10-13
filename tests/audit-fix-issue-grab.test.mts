// IssueGrab lifetime: one pending grab per (issue, instance, admin), and none claimed
// for a RESOLVED issue (src/lib/issue-grab.ts, the two Download webhooks, and
// the two routes that record a grab — issues/[id]/{releases,files}).
//
// Why: a row stayed pending until SOME import of the title (and scope) on that
// instance claimed it. A Replace file whose follow-up found nothing stayed
// pending after the admin resolved the issue, and an unrelated RSS import months
// later pushed "finished downloading" for it; and every Replace release /
// Replace file attempt added its own row, so one import sent N identical pushes
// and N `arr.grab_completed` events.
//
// Pinned:
//  - recordIssueGrab retires the SAME admin's EARLIER pending rows of the issue
//    on the SAME instance, after its own create — never another instance's,
//    another issue's or another admin's (the push goes to the row's admin),
//    never an already-notified row's stamp, never the new row; two attempts
//    recording at once leave exactly the newer one pending; a failed create
//    retires nothing; a failed retire never fails the caller.
//  - Every IssueGrab create in src/ goes through recordIssueGrab (structural).
//  - Radarr and Sonarr Downloads never claim a grab whose issue is RESOLVED,
//    and still claim an open one's.
//
// Harness: the request scope of tests/webhook-routes.test.mts, cut down to what
// a Download touches (the after() tasks are recorded and never run — they would
// open the library-scan debounce timers).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.TRUST_PROXY = "true";
(globalThis as { AsyncLocalStorage?: typeof AsyncLocalStorage }).AsyncLocalStorage = AsyncLocalStorage;

globalThis.fetch = (async () => { throw new Error("scripted network refusal"); }) as typeof fetch;
const warns: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = () => {};
Math.random = () => 0.5;

const { NextRequest } = await import("next/server");
const { workAsyncStorage } = await import("../node_modules/next/dist/server/app-render/work-async-storage.external.js");
const { workUnitAsyncStorage } = await import("../node_modules/next/dist/server/app-render/work-unit-async-storage.external.js");
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { arrSettingKey } = await import("../src/lib/arr-instances.ts");

const RADARR_SECRET = "radarr-default-secret";
const SONARR_SECRET = "sonarr-default-secret";
const settings = new Map<string, string>();
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) =>
    settings.has(args.where.key) ? { key: args.where.key, value: settings.get(args.where.key)! } : null,
  findMany: async (args: { where?: { key?: { in?: string[] } } } = {}) => {
    const keys = args.where?.key?.in;
    return [...settings].filter(([k]) => !keys || keys.includes(k)).map(([key, value]) => ({ key, value }));
  },
  createMany: async () => ({ count: 0 }),
  deleteMany: async () => ({ count: 0 }),
});
const replay = new Set<string>();
shadowPrismaModel(prisma, "webhookReplay", {
  create: async (args: { data: { digest: string; expiresAt: Date } }) => { replay.add(args.data.digest); return args.data; },
  updateMany: async () => ({ count: 0 }),
  delete: async (args: { where: { digest: string } }) => { replay.delete(args.where.digest); return { digest: args.where.digest }; },
  deleteMany: async () => ({ count: 0 }),
});
const mediaRequestStub = {
  updateMany: async () => ({ count: 0 }),
  findMany: async () => [],
  findFirst: async () => null,
};
shadowPrismaModel(prisma, "mediaRequest", mediaRequestStub);
const cacheStub = { deleteMany: async () => ({ count: 0 }), createMany: async () => ({ count: 0 }) };
for (const model of ["radarrWantedItem", "radarrAvailableItem", "sonarrWantedItem", "sonarrAvailableItem"]) {
  shadowPrismaModel(prisma, model, cacheStub);
}
shadowPrismaModel(prisma, "deletionVote", { deleteMany: async () => ({ count: 0 }) });
shadowPrismaModel(prisma, "notificationAgent", { findMany: async () => [], update: async () => ({}) });
// No push subscriptions: the grab-completed push is "skipped-no-subs", never a send.
shadowPrismaModel(prisma, "pushSubscription", { findMany: async () => [] });
shadowPrismaModel(prisma, "user", { findMany: async () => [], findUnique: async () => null });
const txDelegates = {
  $executeRaw: async () => 0,
  mediaRequest: mediaRequestStub,
  radarrWantedItem: cacheStub,
  radarrAvailableItem: cacheStub,
  sonarrWantedItem: cacheStub,
  sonarrAvailableItem: cacheStub,
};
shadowPrismaClientMethod(prisma, "$transaction", async (arg: unknown) =>
  typeof arg === "function" ? (arg as (tx: typeof txDelegates) => Promise<unknown>)(txDelegates) : Promise.all(arg as Promise<unknown>[]),
);

// ── IssueGrab table, with the Issue relation filter the webhooks send ────────
type GrabRow = {
  id: string;
  createdAt: Date;
  issueId: string;
  triggeredById: string;
  tmdbId: number;
  tvdbId: number | null;
  mediaType: "MOVIE" | "TV";
  title: string;
  scope: "FULL" | "SEASON" | "EPISODE";
  seasonNumber: number | null;
  episodeNumber: number | null;
  arrInstance: string;
  notifiedAt: Date | null;
};
const grabs: GrabRow[] = [];
const issueStatus = new Map<string, "OPEN" | "IN_PROGRESS" | "RESOLVED">();
const seq: string[] = [];
let clock = Date.parse("2026-10-01T00:00:00Z");
let createThrows = false;
let retireThrows = false;
// When set, each create parks until this many creates are in flight, then all
// proceed together — two attempts whose creates both land before either retire.
let createBarrier = 0;
let parked: Array<() => void> = [];

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [field, cond] of Object.entries(where)) {
    if (field === "OR") {
      if (!(cond as Record<string, unknown>[]).some((sub) => matches(row, sub))) return false;
      continue;
    }
    if (field === "issue") {
      // The required IssueGrab → Issue relation: filter on the issue's own row.
      if (!matches({ status: issueStatus.get(row.issueId as string) ?? "OPEN" }, cond as Record<string, unknown>)) return false;
      continue;
    }
    const v = row[field];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as Record<string, unknown>;
      for (const [op, x] of Object.entries(c)) {
        if (op === "not" && (x === null ? v === null : v === x)) return false;
        else if (op === "lt" && !((v as Date).getTime() < (x as Date).getTime())) return false;
        else if (op === "in" && !(x as unknown[]).includes(v)) return false;
        else if (op !== "not" && op !== "lt" && op !== "in") throw new Error(`unsupported operator ${op} on ${field}`);
      }
      continue;
    }
    if (v !== cond) return false;
  }
  return true;
}

shadowPrismaModel(prisma, "issueGrab", {
  create: async (args: { data: Omit<GrabRow, "id" | "createdAt" | "notifiedAt"> }) => {
    if (createBarrier > 0) {
      await new Promise<void>((resolve) => {
        parked.push(resolve);
        if (parked.length === createBarrier) { for (const go of parked) go(); parked = []; }
      });
    }
    if (createThrows) throw new Error("P2003: the issue was deleted meanwhile");
    seq.push("create");
    const row: GrabRow = { id: `grab-${grabs.length + 1}`, createdAt: new Date((clock += 1000)), notifiedAt: null, ...args.data };
    grabs.push(row);
    return { ...row };
  },
  findMany: async (args: { where: Record<string, unknown> }) =>
    grabs.filter((g) => matches(g as unknown as Record<string, unknown>, args.where)).map((g) => ({ ...g })),
  updateMany: async (args: { where: Record<string, unknown>; data: Partial<GrabRow> }) => {
    seq.push(`updateMany:${"issueId" in args.where ? "retire" : "claim"}`);
    if (retireThrows && "issueId" in args.where) throw new Error("retire failed");
    let count = 0;
    for (const g of grabs) {
      if (!matches(g as unknown as Record<string, unknown>, args.where)) continue;
      Object.assign(g, args.data);
      count++;
    }
    return { count };
  },
  update: async (args: { where: { id: string }; data: Partial<GrabRow> }) => {
    const g = grabs.find((x) => x.id === args.where.id)!;
    Object.assign(g, args.data);
    return { ...g };
  },
});

const { recordIssueGrab } = await import("../src/lib/issue-grab.ts");
const { POST: radarrPOST } = await import("../src/app/api/webhooks/radarr/route.ts");
const { POST: sonarrPOST } = await import("../src/app/api/webhooks/sonarr/route.ts");

const PAST = new Date("2026-09-01T00:00:00Z");
function seedGrab(over: Partial<GrabRow> & { issueId: string }): GrabRow {
  const row: GrabRow = {
    id: `seed-${grabs.length + 1}`,
    createdAt: new Date((clock += 1000)),
    triggeredById: "admin-1",
    tmdbId: 603,
    tvdbId: null,
    mediaType: "MOVIE",
    title: "The Matrix",
    scope: "FULL",
    seasonNumber: null,
    episodeNumber: null,
    arrInstance: "",
    notifiedAt: null,
    ...over,
  };
  grabs.push(row);
  return row;
}
const grabData = (issueId: string, arrInstance = "") => ({
  issueId,
  triggeredById: "admin-1",
  tmdbId: 603,
  tvdbId: null,
  mediaType: "MOVIE" as const,
  title: "The Matrix",
  scope: "FULL" as const,
  seasonNumber: null,
  episodeNumber: null,
  arrInstance,
});
const rowOf = (id: string) => grabs.find((g) => g.id === id)!;

let ip = 0;
async function deliver(
  service: "radarr" | "sonarr",
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const secret = service === "radarr" ? RADARR_SECRET : SONARR_SECRET;
  const req = new NextRequest(`http://localhost:3000/api/webhooks/${service}?token=${secret}`, {
    method: "POST",
    headers: { "x-forwarded-for": `203.0.113.${(ip++ % 200) + 1}` },
    body: JSON.stringify(body),
  });
  const workStore = { afterContext: { after: () => {} } };
  const requestStore = { type: "request", phase: "render", usedDynamic: false };
  const handler = (service === "radarr" ? radarrPOST : sonarrPOST) as unknown as (r: unknown) => Promise<Response>;
  const res = await workAsyncStorage.run(workStore as never, () =>
    workUnitAsyncStorage.run(requestStore as never, () => handler(req)),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  settings.clear();
  settings.set(arrSettingKey("radarr", "", "WebhookSecret"), RADARR_SECRET);
  settings.set(arrSettingKey("sonarr", "", "WebhookSecret"), SONARR_SECRET);
  replay.clear();
  grabs.length = 0;
  issueStatus.clear();
  seq.length = 0;
  warns.length = 0;
  createThrows = false;
  retireThrows = false;
  createBarrier = 0;
  parked = [];
});

// ── recordIssueGrab ─────────────────────────────────────────────────────────

test("recordIssueGrab retires the issue's earlier pending grabs on the SAME instance only, after its own create", async () => {
  const earlier = seedGrab({ issueId: "issue-1" });
  const earlier2 = seedGrab({ issueId: "issue-1" });
  const notified = seedGrab({ issueId: "issue-1", notifiedAt: PAST });
  const fourK = seedGrab({ issueId: "issue-1", arrInstance: "4k" });
  const otherIssue = seedGrab({ issueId: "issue-2" });

  const created = await recordIssueGrab(grabData("issue-1"));

  assert.deepEqual(seq, ["create", "updateMany:retire"], "the retire runs only once the new row exists");
  assert.ok(rowOf(earlier.id).notifiedAt instanceof Date, "an earlier pending grab of the issue on this instance is retired");
  assert.ok(rowOf(earlier2.id).notifiedAt instanceof Date);
  assert.equal(rowOf(notified.id).notifiedAt, PAST, "an already-announced grab keeps its own stamp");
  assert.equal(rowOf(fourK.id).notifiedAt, null, "another instance's grab matches other deliveries — untouched");
  assert.equal(rowOf(otherIssue.id).notifiedAt, null, "another issue's grab is untouched");
  assert.equal(rowOf(created.id).notifiedAt, null, "the new row stays pending — it announces the replacement");
  assert.equal(grabs.filter((g) => g.issueId === "issue-1" && g.arrInstance === "" && g.notifiedAt === null).length, 1);
});

test("recordIssueGrab never retires ANOTHER admin's pending grab — its completion push goes to that admin alone", async () => {
  const mine = seedGrab({ issueId: "issue-1", triggeredById: "admin-1" });
  const theirs = seedGrab({ issueId: "issue-1", triggeredById: "admin-2" });

  const created = await recordIssueGrab(grabData("issue-1"));

  assert.ok(rowOf(mine.id).notifiedAt instanceof Date, "the same admin's earlier attempt is a duplicate — retired");
  assert.equal(rowOf(theirs.id).notifiedAt, null, "admin-2 started that replacement and must still be told it landed");
  assert.equal(rowOf(created.id).notifiedAt, null);

  // The import then pushes to each admin once: both pending rows are claimed by one delivery.
  issueStatus.set("issue-1", "IN_PROGRESS");
  const res = await deliver("radarr", { eventType: "Download", movie: { tmdbId: 603, title: "The Matrix" } });
  assert.equal(res.status, 200);
  assert.ok(rowOf(theirs.id).notifiedAt instanceof Date);
  assert.ok(rowOf(created.id).notifiedAt instanceof Date);
});

test("two attempts recording at once leave exactly the NEWER grab pending — never retire each other", async () => {
  createBarrier = 2;
  const [a, b] = await Promise.all([recordIssueGrab(grabData("issue-1")), recordIssueGrab(grabData("issue-1"))]);
  assert.deepEqual(seq, ["create", "create", "updateMany:retire", "updateMany:retire"], "the creates interleave before either retire");
  const pending = grabs.filter((g) => g.notifiedAt === null).map((g) => g.id);
  assert.deepEqual(pending, [rowOf(a.id).createdAt < rowOf(b.id).createdAt ? b.id : a.id]);
});

test("a failed create retires nothing and throws (the route's catch); a failed retire never fails the caller", async () => {
  const earlier = seedGrab({ issueId: "issue-1" });
  createThrows = true;
  await assert.rejects(recordIssueGrab(grabData("issue-1")), /P2003/);
  assert.equal(rowOf(earlier.id).notifiedAt, null, "nothing new exists, so the old row must still announce");
  assert.deepEqual(seq, []);

  createThrows = false;
  retireThrows = true;
  const created = await recordIssueGrab(grabData("issue-1"));
  assert.ok(created.id, "the grab is recorded even though the retire failed");
  assert.equal(rowOf(earlier.id).notifiedAt, null);
  assert.ok(warns.some((w) => w.includes("retiring the issue's earlier pending grabs failed")));
});

test("every IssueGrab create in src/ goes through recordIssueGrab — no route writes one bare", () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name !== "generated") walk(p);
      } else if (/\.tsx?$/.test(name) && p !== join("src", "lib", "issue-grab.ts")) {
        if (/issueGrab\.(create|createMany|upsert)\s*\(/.test(readFileSync(p, "utf8"))) offenders.push(p);
      }
    }
  };
  walk("src");
  assert.deepEqual(offenders, []);
  for (const route of ["src/app/api/issues/[id]/releases/route.ts", "src/app/api/issues/[id]/files/route.ts"]) {
    assert.match(readFileSync(route, "utf8"), /await recordIssueGrab\(\{/, route);
  }
});

// ── the webhooks never claim a RESOLVED issue's grab ────────────────────────

test("radarr Download: a RESOLVED issue's pending grab is never claimed; an open issue's still is", async () => {
  const resolved = seedGrab({ issueId: "issue-resolved" });
  const open = seedGrab({ issueId: "issue-open" });
  issueStatus.set("issue-resolved", "RESOLVED");
  issueStatus.set("issue-open", "IN_PROGRESS");

  const res = await deliver("radarr", { eventType: "Download", movie: { tmdbId: 603, title: "The Matrix" } });
  assert.equal(res.status, 200);
  assert.equal(rowOf(resolved.id).notifiedAt, null, "a resolved issue's grab must not announce an unrelated import");
  assert.ok(rowOf(open.id).notifiedAt instanceof Date, "an open issue's grab is still claimed");
  assert.deepEqual(seq, ["updateMany:claim"], "exactly one claim — the resolved row never reaches the CAS");

  // Reopened: its row counts again.
  issueStatus.set("issue-resolved", "OPEN");
  replay.clear();
  await deliver("radarr", { eventType: "Download", movie: { tmdbId: 603, title: "The Matrix" } });
  assert.ok(rowOf(resolved.id).notifiedAt instanceof Date);
});

test("sonarr Download: a RESOLVED issue's pending grab is never claimed; an open issue's still is", async () => {
  const tv = { tmdbId: 888, tvdbId: 777, mediaType: "TV" as const, title: "Frieren" };
  const resolved = seedGrab({ issueId: "issue-resolved", ...tv });
  const open = seedGrab({ issueId: "issue-open", ...tv });
  issueStatus.set("issue-resolved", "RESOLVED");
  issueStatus.set("issue-open", "OPEN");

  const res = await deliver("sonarr", {
    eventType: "Download",
    series: { tvdbId: 777, tmdbId: 888, title: "Frieren" },
    episodes: [{ seasonNumber: 1, episodeNumber: 1 }],
  });
  assert.equal(res.status, 200);
  assert.equal(rowOf(resolved.id).notifiedAt, null, "a resolved issue's grab must not announce an unrelated import");
  assert.ok(rowOf(open.id).notifiedAt instanceof Date, "an open issue's grab is still claimed");
  assert.deepEqual(seq, ["updateMany:claim"]);
});
