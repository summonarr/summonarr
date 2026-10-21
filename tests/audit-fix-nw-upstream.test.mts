// Audit fix (nw-upstream): removing a media-server instance must also remove its
// upstream watch-record state — the UpstreamWatchEvidence snapshot and the
// `upstreamWatch:status:<source>:<slug>` Setting (guardrail 14d, the guardrail-35
// de-registering rule).
//
// Why: a status left behind is inherited by a server later registered under the
// same slug. It reads "ok" for up to UPSTREAM_MAX_AGE_MS (7 days) before that
// server's own first refresh, which lifts the cleanup's `upstreamUnchecked` hold
// on evidence the new server never produced — a title its users watched before
// registration can then read "never watched" and be offered for deletion. A
// removed slug's evidence rows are refreshed by nothing ever again.
//
// Harness: a trimmed copy of tests/media-instances-route.test.mts — a recording
// fake prisma on globalThis (every op journaled with its transaction id), real
// jose session JWTs over in-memory AuthSession/User rows, bearer transport. No
// DB, no network: no instance in these fixtures is configured, so the route's
// connection tests never fetch.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "audit-fix-nw-upstream-test-secret-0123456789";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";

console.warn = () => {};
console.error = () => {};
globalThis.fetch = (async (input: RequestInfo | URL) => {
  throw new Error(`unexpected fetch ${String(input)}`);
}) as typeof fetch;

type Where = Record<string, unknown> | undefined;
type Op = { txId: number | null; model: string; op: string; where: Where };
const ops: Op[] = [];
let txSeq = 0;

const settings = new Map<string, string>();
type Row = Record<string, unknown>;
let evidence: Row[] = [];
let plexLibrary: Row[] = [];
let jellyfinLibrary: Row[] = [];
let activeSessions: Row[] = [];
let serverUsers: Row[] = [];

function whereMatches(row: Row, where: Where): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    const value = row[key];
    if (cond !== null && typeof cond === "object" && "in" in (cond as Record<string, unknown>)) {
      if (!(cond as { in: unknown[] }).in.includes(value)) return false;
    } else if (value !== cond) return false;
  }
  return true;
}

type DbUser = {
  id: string; role: string; permissions: bigint; name: string | null; email: string | null;
  mediaServer: string | null; notificationEmail: string | null;
  sessionsRevokedAt: Date | null; passwordChangedAt: Date | null; deactivatedAt: Date | null;
};
const usersById = new Map<string, DbUser>();
const authSessionsById = new Map<string, { userId: string }>();

function makeClient(txId: number | null) {
  const record = (model: string, op: string, where: Where) => { ops.push({ txId, model, op, where }); };
  const rows = (model: string, store: () => Row[], write: (r: Row[]) => void) => ({
    deleteMany: async (args?: { where?: Where }) => {
      record(model, "deleteMany", args?.where);
      const kept = store().filter((r) => !whereMatches(r, args?.where));
      const count = store().length - kept.length;
      write(kept);
      return { count };
    },
    updateMany: async (args: { where?: Where; data: Row }) => {
      record(model, "updateMany", args.where);
      let count = 0;
      for (const r of store()) if (whereMatches(r, args.where)) { Object.assign(r, args.data); count++; }
      return { count };
    },
    findMany: async (args?: { where?: Where }) => {
      record(model, "findMany", args?.where);
      return store().filter((r) => whereMatches(r, args?.where));
    },
  });
  return {
    setting: {
      findMany: async (args?: { where?: { key?: { in?: string[] } } }) => {
        const only = args?.where?.key?.in;
        const all = [...settings.entries()].map(([key, value]) => ({ key, value }));
        return only ? all.filter((r) => only.includes(r.key)) : all;
      },
      findUnique: async (args: { where: { key: string } }) => {
        const value = settings.get(args.where.key);
        return value === undefined ? null : { key: args.where.key, value };
      },
      upsert: async (args: { where: { key: string }; create: { key: string; value: string } }) => {
        record("setting", "upsert", args.where);
        settings.set(args.where.key, args.create.value);
        return { key: args.where.key, value: args.create.value };
      },
      deleteMany: async (args: { where: { key: { in: string[] } } }) => {
        record("setting", "deleteMany", args.where);
        let count = 0;
        for (const key of args.where.key.in) if (settings.delete(key)) count++;
        return { count };
      },
    },
    upstreamWatchEvidence: rows("upstreamWatchEvidence", () => evidence, (r) => { evidence = r; }),
    plexLibraryItem: rows("plexLibraryItem", () => plexLibrary, (r) => { plexLibrary = r; }),
    jellyfinLibraryItem: rows("jellyfinLibraryItem", () => jellyfinLibrary, (r) => { jellyfinLibrary = r; }),
    activeSession: rows("activeSession", () => activeSessions, (r) => { activeSessions = r; }),
    mediaServerUser: rows("mediaServerUser", () => serverUsers, (r) => { serverUsers = r; }),
    user: {
      findUnique: async (args: { where: { id: string } }) => {
        const u = usersById.get(args.where.id);
        return u ? { ...u } : null;
      },
      update: async () => ({}),
    },
    authSession: {
      findUnique: async (args: { where: { sessionId: string } }) =>
        authSessionsById.has(args.where.sessionId) ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId } : null,
      update: async () => ({}),
    },
    auditLog: { create: async (args: { data: Row }) => args.data },
  };
}

(globalThis as unknown as { prisma: unknown }).prisma = {
  ...makeClient(null),
  $transaction: async (arg: unknown) => {
    if (typeof arg !== "function") return Promise.all(arg as Promise<unknown>[]);
    const id = ++txSeq;
    return (arg as (t: ReturnType<typeof makeClient>) => Promise<unknown>)(makeClient(id));
  },
};

const { NextRequest } = await import("next/server");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { upstreamStatusKey } = await import("../src/lib/never-watched-data.ts");
const { POST } = await import("../src/app/api/admin/media-instances/route.ts");

let seq = 0;
async function adminHeader(): Promise<Record<string, string>> {
  seq++;
  const userId = `admin-${seq}`;
  const sessionId = `admin-sess-${seq}`;
  usersById.set(userId, {
    id: userId, role: "ADMIN", permissions: 0n, name: `Admin ${seq}`, email: "admin@example.com",
    mediaServer: null, notificationEmail: null, sessionsRevokedAt: null, passwordChangedAt: null, deactivatedAt: null,
  });
  authSessionsById.set(sessionId, { userId });
  const token = await signSessionJwt(
    { id: userId, role: "ADMIN", permissions: "0", provider: "credentials", sessionId, expiresAt: Math.floor(Date.now() / 1000) + 86_400 },
    { expiresInSeconds: 7_200 },
  );
  return { authorization: `Bearer ${token}` };
}
const post = (body: unknown, headers: Record<string, string>) =>
  POST(new NextRequest("http://localhost:3000/api/admin/media-instances", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }), undefined);

const ev = (source: string, serverInstance: string, itemKey: string): Row => ({ source, serverInstance, itemKey, seasonNumber: -1, mediaType: "MOVIE", playCount: 1 });
const STATUS = JSON.stringify({ fetchedAt: new Date().toISOString(), attemptedAt: new Date().toISOString(), ok: true, entries: 5, matched: 5, samples: 0, agreed: 0, error: null });

beforeEach(() => {
  ops.length = 0;
  settings.clear();
  evidence = [];
  plexLibrary = [];
  jellyfinLibrary = [];
  activeSessions = [];
  serverUsers = [];
});

test("removing a named Plex instance deletes ITS upstream snapshot and status — in the registry's transaction — and nobody else's", async () => {
  settings.set("plexInstances", JSON.stringify([{ slug: "remote", name: "Remote" }, { slug: "keep", name: "Keep" }]));
  for (const k of [upstreamStatusKey("plex", "remote"), upstreamStatusKey("plex", ""), upstreamStatusKey("plex", "keep"), upstreamStatusKey("jellyfin", "remote")]) {
    settings.set(k, STATUS);
  }
  evidence = [ev("plex", "remote", "1"), ev("plex", "remote", "2"), ev("plex", "", "3"), ev("plex", "keep", "4"), ev("jellyfin", "remote", "5")];

  const res = await post({ service: "plex", instances: [{ slug: "keep", name: "Keep" }] }, await adminHeader());
  assert.equal(res.status, 200);

  assert.equal(settings.get(upstreamStatusKey("plex", "remote")), undefined, "the removed server's status is gone — a re-registered slug reads 'never', not 'ok'");
  assert.equal(settings.get(upstreamStatusKey("plex", "")), STATUS, "the default server's status survives");
  assert.equal(settings.get(upstreamStatusKey("plex", "keep")), STATUS, "another instance's status survives");
  assert.equal(settings.get(upstreamStatusKey("jellyfin", "remote")), STATUS, "the same slug on the OTHER service is a different server");
  assert.deepEqual(
    evidence.map((e) => `${e.source}:${e.serverInstance}:${e.itemKey}`).sort(),
    ["jellyfin:remote:5", "plex::3", "plex:keep:4"],
    "only the removed server's evidence rows are deleted",
  );

  const evDel = ops.filter((o) => o.model === "upstreamWatchEvidence" && o.op === "deleteMany");
  assert.equal(evDel.length, 1);
  assert.deepEqual(evDel[0].where, { source: "plex", serverInstance: "remote" }, "scoped by source AND slug");
  const registry = ops.find((o) => o.model === "setting" && o.op === "upsert" && (o.where as { key: string }).key === "plexInstances");
  assert.ok(registry && registry.txId !== null);
  assert.equal(evDel[0].txId, registry!.txId, "the evidence delete commits with the registry write");
  const statusDel = ops.find((o) => o.model === "setting" && o.op === "deleteMany" &&
    ((o.where as { key: { in: string[] } }).key.in).includes(upstreamStatusKey("plex", "remote")));
  assert.ok(statusDel, "the status key is deleted");
  assert.equal(statusDel!.txId, registry!.txId, "the status delete commits with the registry write");
});

test("removing a named Jellyfin instance deletes its jellyfin snapshot and status, never the Plex one under the same slug", async () => {
  settings.set("jellyfinInstances", JSON.stringify([{ slug: "remote", name: "Remote" }]));
  settings.set(upstreamStatusKey("jellyfin", "remote"), STATUS);
  settings.set(upstreamStatusKey("plex", "remote"), STATUS);
  evidence = [ev("jellyfin", "remote", "j1"), ev("plex", "remote", "p1")];

  const res = await post({ service: "jellyfin", instances: [] }, await adminHeader());
  assert.equal(res.status, 200);
  assert.equal(settings.get(upstreamStatusKey("jellyfin", "remote")), undefined);
  assert.equal(settings.get(upstreamStatusKey("plex", "remote")), STATUS);
  assert.deepEqual(evidence.map((e) => `${e.source}:${e.itemKey}`), ["plex:p1"]);
});

test("a save that removes nothing touches no upstream state", async () => {
  settings.set("plexInstances", JSON.stringify([{ slug: "keep", name: "Keep" }]));
  settings.set(upstreamStatusKey("plex", "keep"), STATUS);
  evidence = [ev("plex", "keep", "4")];
  const res = await post({ service: "plex", instances: [{ slug: "keep", name: "Keep" }] }, await adminHeader());
  assert.equal(res.status, 200);
  assert.equal(ops.filter((o) => o.model === "upstreamWatchEvidence").length, 0);
  assert.equal(settings.get(upstreamStatusKey("plex", "keep")), STATUS);
  assert.equal(evidence.length, 1);
});

test("a removal drops the cached never-watched report after the commit (structural)", () => {
  const src = readFileSync(new URL("../src/app/api/admin/media-instances/route.ts", import.meta.url), "utf8");
  const commit = src.indexOf("}, { timeout: BATCH_TX_TIMEOUT });");
  const call = src.indexOf("invalidateNeverWatchedReport()");
  assert.ok(commit > 0 && call > commit, "invalidateNeverWatchedReport() runs after the transaction commits");
});
