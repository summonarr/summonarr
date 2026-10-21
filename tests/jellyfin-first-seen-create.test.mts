// Guardrail 34e, the CREATE half of the Jellyfin first-seen rule
// (findOrCreateJellyfinUser in src/lib/auth.ts).
//
// The bound-row and pre-34e adoption paths are pinned in tests/auth.test.mts.
// This file pins the order those don't cover: a twin planted on a LATER server
// signs in before the genuine owner ever has, so no User row holds the id yet.
// Creating it bound to the twin's server would hand the owner's watch history to
// the twin (attribution matches the subject on any server, guardrail 34) and
// lock the owner out, because jellyfinUserId is unique. So the create path asks
// jellyfinFirstSeenInstance too:
//
//   - oldest MediaServerUser row on another server → ProviderRefusal
//     "instance_mismatch", audited AUTH_LOGIN_FAILED with that reason on both
//     transports, and user.create is never called;
//   - oldest row on the sign-in server → created, bound to it;
//   - no row anywhere → created, bound to the sign-in server (as before).
//
// No DB or network: globalThis.prisma is pre-seeded with an in-memory fake
// before the module graph loads, and globalThis.fetch is scripted (the Jellyfin
// base URLs are IP literals, so no DNS resolve happens; dns.lookup is stubbed
// anyway as a guard). Rate-limit buckets are per-UA-hash with TRUST_PROXY
// unset, so each sign-in uses its own UA tag.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "jellyfin-first-seen-test-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000";
delete process.env.TRUST_PROXY;
delete process.env.TRUSTED_PROXY_HOPS;
delete process.env.SUMMONARR_ALLOW_OAUTH_FIRST_ADMIN;
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) {
  throw new Error("could not stub dns.lookup — aborting before a real DNS query can leave the process");
}

// ── in-memory DB ────────────────────────────────────────────────────────────
type UserRow = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  jellyfinUserId: string | null;
  jellyfinInstance: string | null;
};
type MsuRow = { source: string; serverInstance: string; sourceUserId: string; active: boolean; createdAt: Date };
type AuditRow = { action: string; provider: string | null; details: string | null };

const users: UserRow[] = [];
const settings = new Map<string, string>();
const mediaServerUsers: MsuRow[] = [];
const auditRows: AuditRow[] = [];
let userCreates = 0;

function pick(row: Record<string, unknown>, select?: Record<string, boolean>): Record<string, unknown> {
  if (!select) return { ...row };
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(select)) if (select[key]) out[key] = row[key];
  return out;
}

type UserWhere = { id?: string; email?: string; jellyfinUserId?: string };
function findUser(where: UserWhere): UserRow | undefined {
  return users.find((u) =>
    where.id !== undefined ? u.id === where.id
    : where.email !== undefined ? u.email === where.email
    : where.jellyfinUserId !== undefined ? u.jellyfinUserId === where.jellyfinUserId
    : false,
  );
}

const fakePrisma = {
  setting: {
    findUnique: async (args: { where: { key: string } }) => {
      const value = settings.get(args.where.key);
      return value === undefined ? null : { key: args.where.key, value };
    },
  },
  user: {
    findUnique: async (args: { where: UserWhere; select?: Record<string, boolean> }) => {
      const row = findUser(args.where);
      return row ? pick(row, args.select) : null;
    },
    findFirst: async (args: { where?: { role?: string }; select?: Record<string, boolean> }) => {
      const row = users.find((u) => args.where?.role === undefined || u.role === args.where.role);
      return row ? pick(row, args.select) : null;
    },
    create: async (args: { data: Record<string, unknown>; select?: Record<string, boolean> }) => {
      userCreates++;
      const d = args.data;
      const row: UserRow = {
        id: `u-${users.length + 1}`,
        email: d.email as string,
        name: (d.name as string | null | undefined) ?? null,
        role: (d.role as string | undefined) ?? "USER",
        jellyfinUserId: (d.jellyfinUserId as string | undefined) ?? null,
        jellyfinInstance: (d.jellyfinInstance as string | undefined) ?? null,
      };
      users.push(row);
      return pick(row, args.select);
    },
    updateMany: async (args: { where: UserWhere & Record<string, unknown>; data: Record<string, unknown> }) => {
      const row = findUser(args.where);
      const matches =
        row !== undefined &&
        Object.entries(args.where).every(([k, v]) => k === "id" || (row as unknown as Record<string, unknown>)[k] === v);
      if (matches) Object.assign(row, args.data);
      return { count: matches ? 1 : 0 };
    },
  },
  mediaServerUser: {
    findFirst: async (args: {
      where?: { source?: string; serverInstance?: string; sourceUserId?: string; active?: boolean };
      orderBy?: Array<Record<string, "asc" | "desc">>;
      select?: Record<string, boolean>;
    }) => {
      const w = args.where ?? {};
      const matching = mediaServerUsers.filter(
        (m) =>
          (w.source === undefined || m.source === w.source) &&
          (w.serverInstance === undefined || m.serverInstance === w.serverInstance) &&
          (w.sourceUserId === undefined || m.sourceUserId === w.sourceUserId) &&
          (w.active === undefined || m.active === w.active),
      );
      // The first-seen lookup's order: createdAt, then slug.
      if (args.orderBy?.some((o) => "createdAt" in o)) {
        matching.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.serverInstance.localeCompare(b.serverInstance));
      }
      const row = matching[0];
      return row ? pick(row as unknown as Record<string, unknown>, args.select) : null;
    },
  },
  auditLog: {
    create: async (args: { data: AuditRow }) => {
      auditRows.push(args.data);
      return { id: auditRows.length, ...args.data };
    },
  },
};
(globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;

// ── scripted Jellyfin wire ──────────────────────────────────────────────────
let signInId = "";
const fetchCalls: URL[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  fetchCalls.push(url);
  if (url.pathname === "/Users/AuthenticateByName" || url.pathname === "/Users/AuthenticateWithQuickConnect") {
    return new Response(JSON.stringify({ User: { Id: signInId, Name: "JF User" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  throw new Error(`unexpected fetch to ${url}`);
}) as typeof fetch;

const { findOrCreateJellyfinUser, authorizeWithJellyfin, authorizeWithJellyfinQuickConnect, ProviderRefusal } =
  await import("../src/lib/auth.ts");

// ── helpers ─────────────────────────────────────────────────────────────────
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
function makeReq(tag: string): Request {
  return new Request("http://localhost:3000/api/auth/sign-in", { method: "POST", headers: { "user-agent": `${UA} uniq/${tag}` } });
}
function msu(serverInstance: string, sourceUserId: string, createdAt: string, active = true): void {
  mediaServerUsers.push({ source: "jellyfin", serverInstance, sourceUserId, active, createdAt: new Date(createdAt) });
}
// `void logAudit(...)` is fire-and-forget.
function flushAsync(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
function lastAudit(): AuditRow & { reason: unknown } {
  const row = auditRows.at(-1);
  if (!row) throw new Error("no audit rows recorded");
  return { ...row, reason: (JSON.parse(row.details ?? "{}") as Record<string, unknown>).reason };
}
function refusalReason(result: unknown): string | null {
  return result instanceof ProviderRefusal ? result.reason : null;
}

beforeEach(() => {
  users.length = 0;
  settings.clear();
  mediaServerUsers.length = 0;
  auditRows.length = 0;
  userCreates = 0;
  fetchCalls.length = 0;
  warns.length = 0;
  errors.length = 0;
  // Setup completed, so the pre-setup bootstrap gate stays out of the way.
  settings.set("setup_completed_at", "2026-01-01T00:00:00.000Z");
  settings.set("jellyfinUrl", "http://10.77.20.1:8096");
  settings.set("jellyfinRemoteUrl", "http://10.77.20.2:8096");
});

test("first-seen create (34e): an id first seen on the default server is refused through 'remote' — nothing is created", async () => {
  // The genuine server reported the id long before the twin appeared on
  // remote; remote's own sync lists the twin as an active member, so its
  // membership gate passes. The owner has never signed in (no User row).
  msu("", "jf-planted", "2026-01-01T00:00:00Z");
  msu("remote", "jf-planted", "2026-10-01T00:00:00Z");

  const result = await findOrCreateJellyfinUser("jf-planted", "Twin", "remote");
  assert.equal(refusalReason(result), "instance_mismatch");
  assert.equal(userCreates, 0, "user.create must never run for a twin");
  assert.equal(users.length, 0);
  assert.ok(warns.some((w) => w.startsWith("[auth]") && w.includes("first seen on a different server")));
});

test("first-seen create (34e): the refusal is audited instance_mismatch on both transports, and the owner still gets the account", async () => {
  msu("", "jf-planted2", "2026-01-01T00:00:00Z");
  msu("remote", "jf-planted2", "2026-10-01T00:00:00Z");
  signInId = "jf-planted2";

  assert.equal(await authorizeWithJellyfin({ username: "twin", password: "pw" }, makeReq("fs-pw-remote"), "remote"), null);
  await flushAsync();
  assert.equal(lastAudit().action, "AUTH_LOGIN_FAILED");
  assert.equal(lastAudit().provider, "jellyfin");
  assert.equal(lastAudit().reason, "instance_mismatch");

  assert.equal(await authorizeWithJellyfinQuickConnect({ secret: "qc-first-seen-twin" }, makeReq("fs-qc-remote"), "remote"), null);
  await flushAsync();
  assert.equal(lastAudit().provider, "jellyfin-quickconnect");
  assert.equal(lastAudit().reason, "instance_mismatch");
  assert.equal(userCreates, 0, "neither transport may mint the twin an account");

  // The first-seen server's sign-in creates the account, bound to it.
  const owner = await authorizeWithJellyfin({ username: "owner", password: "pw" }, makeReq("fs-pw-default"));
  assert.ok(owner, "the genuine owner signs in through the server the id was first seen on");
  assert.equal(users.length, 1);
  assert.equal(users[0].jellyfinUserId, "jf-planted2");
  assert.equal(users[0].jellyfinInstance, "");
});

test("first-seen create (34e): a soft-deleted oldest row is still evidence", async () => {
  // Guardrail 28: removal from the server soft-deletes; the row still says
  // where the id came from.
  msu("", "jf-gone", "2026-01-01T00:00:00Z", false);
  msu("remote", "jf-gone", "2026-10-01T00:00:00Z");
  assert.equal(refusalReason(await findOrCreateJellyfinUser("jf-gone", "Twin", "remote")), "instance_mismatch");
  assert.equal(userCreates, 0);
});

test("first-seen create (34e): an id first seen on 'remote' is created bound to 'remote'", async () => {
  msu("remote", "jf-remote-first", "2026-01-01T00:00:00Z");
  msu("", "jf-remote-first", "2026-10-01T00:00:00Z");
  signInId = "jf-remote-first";

  const result = await authorizeWithJellyfin({ username: "r", password: "pw" }, makeReq("fs-remote-first"), "remote");
  assert.ok(result, "sign-in through the first-seen server is admitted");
  assert.equal(userCreates, 1);
  assert.equal(users[0].jellyfinUserId, "jf-remote-first");
  assert.equal(users[0].jellyfinInstance, "remote");
});

test("first-seen create (34e): with no MediaServerUser evidence the sign-in server decides", async () => {
  const result = await findOrCreateJellyfinUser("jf-no-evidence", "New", "remote");
  assert.equal(refusalReason(result), null);
  assert.equal(userCreates, 1);
  assert.equal(users[0].jellyfinUserId, "jf-no-evidence");
  assert.equal(users[0].jellyfinInstance, "remote");
  assert.equal(users[0].email, "jellyfin-jf-no-evidence@jellyfin.local");
});
