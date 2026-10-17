// Unit tests for isSafeToReconcileJellyfinUsers (src/lib/download-policy.ts) —
// the sole guard between a degraded Jellyfin /Users response and a mass
// soft-deactivation of every MediaServerUser absent from it. getJellyfinAllUsers
// only throws on a non-2xx, so a 200 carrying a truncated list (reduced API-key
// elevation, transient server quirk) reaches the reconcile looking legitimate;
// this predicate is what refuses it. A regression here re-creates the incident
// that motivated guardrail 28. Pure function — boundary-tested exhaustively.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isSafeToReconcileJellyfinUsers, PRUNE_MAX_SHRINK } from "../src/lib/download-policy.ts";

test("an empty fetch is never safe — even with no prior active users", () => {
  assert.equal(isSafeToReconcileJellyfinUsers(0, 0), false);
  assert.equal(isSafeToReconcileJellyfinUsers(0, 10), false);
});

test("first sync (no prior active rows) is safe for any non-empty fetch", () => {
  assert.equal(isSafeToReconcileJellyfinUsers(1, 0), true);
  assert.equal(isSafeToReconcileJellyfinUsers(500, 0), true);
});

test("steady state and growth are safe", () => {
  assert.equal(isSafeToReconcileJellyfinUsers(10, 10), true);
  assert.equal(isSafeToReconcileJellyfinUsers(12, 10), true);
});

test("shrink tolerance boundary: exactly PRUNE_MAX_SHRINK departures pass, one more refuses", () => {
  const prior = 10;
  assert.equal(isSafeToReconcileJellyfinUsers(prior - PRUNE_MAX_SHRINK, prior), true);
  assert.equal(isSafeToReconcileJellyfinUsers(prior - PRUNE_MAX_SHRINK - 1, prior), false);
});

test("a truncated response (large shrink) refuses to reconcile", () => {
  assert.equal(isSafeToReconcileJellyfinUsers(3, 50), false);
  assert.equal(isSafeToReconcileJellyfinUsers(1, 4), false);
});

test("small servers: shrink-to-one passes only within tolerance", () => {
  // 3 active → 1 fetched is exactly PRUNE_MAX_SHRINK (2) departures: allowed.
  assert.equal(isSafeToReconcileJellyfinUsers(1, 3), true);
  // 4 active → 1 fetched exceeds it: refused.
  assert.equal(isSafeToReconcileJellyfinUsers(1, 4), false);
});

// ═══ syncDownloadPolicies: guardrail 28 — the per-instance prune scope ══════
//
// Multi-server support widened MediaServerUser's identity to
// (source, serverInstance, sourceUserId). syncJellyfinPolicies's soft-delete
// prune (isSafeToReconcileJellyfinUsers, tested above, is only the safety
// GATE around it) must scope its updateMany by the instance it's CURRENTLY
// syncing — without that scoping, a user who exists only on a second,
// independently-configured Jellyfin server looks "absent" the moment the
// FIRST server's sync runs with the first server's /Users list, and gets
// soft-deactivated even though they never left anywhere. This is a real
// guardrail-28 violation, not a hypothetical: it destroys that user's
// attribution to play history the live poller can never rebuild (guardrail
// 19 — no Jellyfin backfill cron exists).
//
// Unlike the pure-predicate tests above, these run the real
// syncDownloadPolicies/syncJellyfinPolicies end to end. Outbound HTTP goes to a
// fake globalThis.fetch (as in jellyfin.test.mts — the servers use private IP
// addresses, so the SSRF check never needs a DNS lookup), and the database is an
// in-memory stub installed with shadowPrismaModel (as in jellyfin-config.test.mts).
// Two servers are configured together: the default ("") and a named "remote",
// like someone who also syncs a friend's second server.
import { prisma } from "../src/lib/prisma.ts";
import { shadowPrismaModel, shadowPrismaClientMethod } from "./_helpers.mts";
import { __resetProcessSingletonForTests } from "../src/lib/process-singleton.ts";

const DEFAULT_URL = "http://10.77.0.1:8096";
const REMOTE_URL = "http://10.77.0.2:8096";

interface MsuRow {
  id: string;
  source: string;
  serverInstance: string;
  sourceUserId: string;
  username: string;
  email: string | null;
  isServerAdmin: boolean;
  downloadsEnabled: boolean | null;
  active: boolean;
  manualUserLink: boolean;
  userId?: string | null;
}

const settings = new Map<string, string>();
const msuStore = new Map<string, MsuRow>();

// ── offboarding state (jellyfin-offboarding.ts) ─────────────────────────────
// The Summonarr accounts a departed identity can sign in as, their AuthSession
// rows, and the audit rows the revoke writes. revokeAllUserSessions runs for
// real against these through the $transaction stub below.
interface UserRow {
  id: string;
  role: string;
  permissions: bigint;
  name: string | null;
  email: string;
  jellyfinUserId: string | null;
  sessionsRevokedAt: Date | null;
}
const userStore = new Map<string, UserRow>();
const sessionStore = new Map<string, { sessionId: string; userId: string }>();
const auditRows: Array<{ action: string; target: string; userId: string | null; details: string | null }> = [];
let txThrows = 0; // fail the next N revoke transactions

function seedUser(row: Partial<UserRow> & { id: string }, sessions = 2): void {
  userStore.set(row.id, {
    role: "USER", permissions: 0n, name: row.id, email: `${row.id}@example.com`,
    jellyfinUserId: null, sessionsRevokedAt: null, ...row,
  });
  for (let i = 0; i < sessions; i++) {
    const sessionId = `${row.id}-s${i}`;
    sessionStore.set(sessionId, { sessionId, userId: row.id });
  }
}
const sessionsOf = (userId: string) => [...sessionStore.values()].filter((s) => s.userId === userId).length;
const offboardAudits = () =>
  auditRows.filter((r) => r.action === "SESSION_REVOKE" && (r.details ?? "").includes("jellyfin_offboarded"));

function seedMsu(row: MsuRow): void {
  msuStore.set(row.id, row);
}

function compoundKeyOf(r: { source: string; serverInstance: string; sourceUserId: string }): string {
  return `${r.source}:${r.serverInstance}:${r.sourceUserId}`;
}

shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    const value = settings.get(args.where.key);
    return value !== undefined ? { key: args.where.key, value } : null;
  },
  findMany: async (args?: { where?: { key?: { in?: string[] } } }) => {
    const keys = args?.where?.key?.in ?? [];
    return keys.flatMap((k) => (settings.has(k) ? [{ key: k, value: settings.get(k)! }] : []));
  },
});

function findUser(where: { id?: string; jellyfinUserId?: string }): UserRow | undefined {
  return [...userStore.values()].find((u) =>
    where.id !== undefined ? u.id === where.id : u.jellyfinUserId === where.jellyfinUserId,
  );
}
const userDelegate = {
  // No account-linking under test here — every identity resolves unlinked.
  findMany: async () => [],
  findUnique: async (args: { where: { id?: string; jellyfinUserId?: string } }) => {
    const u = findUser(args.where);
    return u ? { ...u } : null;
  },
  update: async (args: { where: { id: string }; data: Partial<UserRow> }) => {
    const u = findUser(args.where);
    if (!u) throw new Error("user.update: no row");
    Object.assign(u, args.data);
    return { ...u };
  },
};
shadowPrismaModel(prisma, "user", userDelegate);

const authSessionDelegate = {
  findMany: async (args: { where: { userId: string } }) =>
    [...sessionStore.values()].filter((s) => s.userId === args.where.userId).map((s) => ({ sessionId: s.sessionId })),
  deleteMany: async (args: { where: { userId: string } }) => {
    let count = 0;
    for (const [k, v] of sessionStore) if (v.userId === args.where.userId) { sessionStore.delete(k); count++; }
    return { count };
  },
};
shadowPrismaModel(prisma, "authSession", authSessionDelegate);

shadowPrismaModel(prisma, "auditLog", {
  create: async (args: { data: { action: string; target: string; userId: string | null; details: string | null } }) => {
    auditRows.push(args.data);
    return args.data;
  },
});

// Interactive transactions only (revokeAllUserSessions). Writes land in the
// stores directly; a forced throw happens before any of them.
shadowPrismaClientMethod(prisma, "$transaction", async (fn: (tx: unknown) => Promise<unknown>) => {
  if (txThrows > 0) {
    txThrows--;
    throw new Error("transaction exploded (unit test)");
  }
  return fn({
    $executeRawUnsafe: async () => 0,
    user: userDelegate,
    authSession: authSessionDelegate,
  });
});

type MsuWhere = {
  source?: string;
  serverInstance?: string;
  active?: boolean;
  OR?: Array<{ sourceUserId?: string; userId?: string }>;
};
function msuMatches(r: MsuRow, where: MsuWhere): boolean {
  return (where.source === undefined || r.source === where.source)
    && (where.serverInstance === undefined || r.serverInstance === where.serverInstance)
    && (where.active === undefined || r.active === where.active)
    && (where.OR === undefined || where.OR.some((c) =>
      (c.sourceUserId !== undefined && r.sourceUserId === c.sourceUserId)
      || (c.userId !== undefined && r.userId === c.userId)));
}

shadowPrismaModel(prisma, "mediaServerUser", {
  findFirst: async (args: { where: MsuWhere }) => {
    const row = [...msuStore.values()].find((r) => msuMatches(r, args.where));
    return row ? { id: row.id } : null;
  },
  findMany: async (args?: { where?: { source?: string; serverInstance?: string }; select?: unknown }) => {
    const where = args?.where ?? {};
    return [...msuStore.values()].filter(
      (r) => (where.source === undefined || r.source === where.source)
        && (where.serverInstance === undefined || r.serverInstance === where.serverInstance),
    );
  },
  upsert: async (args: {
    where: { source_serverInstance_sourceUserId: { source: string; serverInstance: string; sourceUserId: string } };
    create: Omit<MsuRow, "id" | "active" | "manualUserLink"> & Partial<Pick<MsuRow, "active" | "manualUserLink">>;
    update: Partial<MsuRow>;
  }) => {
    const key = args.where.source_serverInstance_sourceUserId;
    const existing = [...msuStore.values()].find((r) => compoundKeyOf(r) === compoundKeyOf(key));
    if (existing) {
      Object.assign(existing, args.update);
      return existing;
    }
    const created: MsuRow = {
      id: `msu-${msuStore.size + 1}`,
      active: true,
      manualUserLink: false,
      ...args.create,
    };
    msuStore.set(created.id, created);
    return created;
  },
  updateMany: async (args: { where: { source: string; serverInstance?: string; sourceUserId: { notIn: string[] }; active: boolean }; data: { active: boolean } }) => {
    // serverInstance is OPTIONAL here on purpose: an absent key must behave
    // like real Prisma (no filter on that field, matching every instance) so a
    // test that deliberately reverts the guardrail-28 scoping exercises the
    // ACTUAL historical bug shape instead of accidentally matching nothing.
    let count = 0;
    for (const r of msuStore.values()) {
      if (
        r.source === args.where.source
        && (args.where.serverInstance === undefined || r.serverInstance === args.where.serverInstance)
        && r.active === args.where.active
        && !args.where.sourceUserId.notIn.includes(r.sourceUserId)
      ) {
        r.active = args.data.active;
        count++;
      }
    }
    return { count };
  },
});

let respond: (url: string) => Response | Promise<Response> = (url) => {
  throw new Error(`unexpected fetch ${url} — script a responder for this test`);
};
globalThis.fetch = (async (input: RequestInfo | URL) => respond(String(input))) as typeof fetch;

const okJson = (data: unknown) =>
  new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });

// Dynamic import so the prisma-shadow/fetch stubs above precede the module
// graph (the established pattern — see jellyfin.test.mts).
const { syncDownloadPolicies, RECONCILE_CONFIRM_RUNS } = await import("../src/lib/download-policy.ts");
const { OFFBOARD_PENDING_KEY } = await import("../src/lib/jellyfin-offboarding.ts");

test("guardrail 28: a user existing ONLY on a second Jellyfin instance survives the FIRST instance's prune untouched, while a genuine same-instance departure is still pruned", async () => {
  settings.clear();
  msuStore.clear();

  // Two independently-configured Jellyfin servers: the default and a named
  // "remote" (jellyfinRemoteUrl/jellyfinRemoteApiKey — see media-instances.ts).
  settings.set("jellyfinUrl", DEFAULT_URL);
  settings.set("jellyfinApiKey", "key-default");
  settings.set("jellyfinRemoteUrl", REMOTE_URL);
  settings.set("jellyfinRemoteApiKey", "key-remote");
  settings.set("jellyfinInstances", JSON.stringify([{ slug: "remote", name: "Remote" }]));

  // Pre-existing rows: two on the default instance (one staying, one about to
  // genuinely depart), one on "remote" that the default instance's sync must
  // never be able to see or touch.
  seedMsu({ id: "row-a1", source: "jellyfin", serverInstance: "", sourceUserId: "a1", username: "alice-old", email: null, isServerAdmin: false, downloadsEnabled: null, active: true, manualUserLink: false });
  seedMsu({ id: "row-a2", source: "jellyfin", serverInstance: "", sourceUserId: "a2-departed", username: "alice2-old", email: null, isServerAdmin: false, downloadsEnabled: null, active: true, manualUserLink: false });
  seedMsu({ id: "row-b1", source: "jellyfin", serverInstance: "remote", sourceUserId: "b1", username: "bob-old", email: null, isServerAdmin: false, downloadsEnabled: null, active: true, manualUserLink: false });

  respond = (url) => {
    if (url === `${DEFAULT_URL}/Users`) {
      // a2-departed is genuinely gone from THIS server; b1 was never here — it
      // lives on the other server entirely.
      return okJson([{ Id: "a1", Name: "alice", Policy: { IsAdministrator: false, EnableContentDownloading: true } }]);
    }
    if (url === `${REMOTE_URL}/Users`) {
      return okJson([{ Id: "b1", Name: "bob", Policy: { IsAdministrator: false, EnableContentDownloading: true } }]);
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const results = await syncDownloadPolicies();
  assert.equal(results.every((r) => r.errors === 0), true, `expected zero errors, got ${JSON.stringify(results)}`);

  assert.equal(msuStore.get("row-a1")!.active, true, "still-present same-instance user stays active");
  assert.equal(msuStore.get("row-a2")!.active, false, "a genuine same-instance departure is still pruned");
  assert.equal(
    msuStore.get("row-b1")!.active,
    true,
    "guardrail 28: a user that exists ONLY on the OTHER instance must survive this instance's prune — it was never absent from ITS OWN server",
  );
});

test("reconcile wedge escape: an over-tolerance shrink refuses, then the SAME fetched set on the Nth identical run is accepted and pruned", async () => {
  settings.clear();
  msuStore.clear();
  settings.set("jellyfinUrl", DEFAULT_URL);
  settings.set("jellyfinApiKey", "key-default");

  // 5 active users, then a real mass departure leaves 1 — beyond
  // PRUNE_MAX_SHRINK, so the guard refuses. That refusal used to be PERMANENT:
  // it skips the only writer of active=false, so priorActiveCount never shrank
  // and the warn fired every run forever with no remediation path. The
  // confirmation counter accepts the shrink once the IDENTICAL fetched set has
  // been observed RECONCILE_CONFIRM_RUNS consecutive runs.
  for (let i = 1; i <= 5; i++) {
    seedMsu({ id: `w-${i}`, source: "jellyfin", serverInstance: "", sourceUserId: `w${i}`, username: `w${i}`, email: null, isServerAdmin: false, downloadsEnabled: null, active: true, manualUserLink: false });
  }
  respond = (url) => {
    if (url === `${DEFAULT_URL}/Users`) {
      return okJson([{ Id: "w1", Name: "w1", Policy: { IsAdministrator: false, EnableContentDownloading: true } }]);
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  for (let run = 1; run < RECONCILE_CONFIRM_RUNS; run++) {
    await syncDownloadPolicies();
    assert.equal(
      [...msuStore.values()].filter((r) => r.active).length,
      5,
      `run ${run}: an unconfirmed shrink must not prune (first-observation refusal preserved)`,
    );
  }
  await syncDownloadPolicies(); // the Nth identical observation — accepted
  const active = [...msuStore.values()].filter((r) => r.active).map((r) => r.sourceUserId);
  assert.deepEqual(active, ["w1"], "the persistent identical set is finally accepted and the departures pruned");
});

// ═══ Jellyfin offboarding (jellyfin-offboarding.ts) ════════════════════════
//
// A member removed or disabled on the Jellyfin server can no longer sign in,
// but the Summonarr session they hold stays valid — the iOS app's forever
// (guardrail 6c). The hourly user sync is where the departure is learned, so it
// signs out the account whose sign-in identity it was: only once the identity is
// gone from EVERY configured server (guardrail 35), never an admin, and never by
// deleting anything (guardrail 28).

const user = (id: string, extra: Record<string, unknown> = {}) =>
  ({ Id: id, Name: id, Policy: { IsAdministrator: false, EnableContentDownloading: true, ...extra } });

function resetOffboarding(): void {
  settings.clear();
  msuStore.clear();
  userStore.clear();
  sessionStore.clear();
  auditRows.length = 0;
  txThrows = 0;
  __resetProcessSingletonForTests(OFFBOARD_PENDING_KEY);
  settings.set("jellyfinUrl", DEFAULT_URL);
  settings.set("jellyfinApiKey", "key-default");
}

function seedRow(id: string, sourceUserId: string, over: Partial<MsuRow> = {}): void {
  seedMsu({
    id, source: "jellyfin", serverInstance: "", sourceUserId, username: sourceUserId, email: null,
    isServerAdmin: false, downloadsEnabled: null, active: true, manualUserLink: false, ...over,
  });
}

const flush = () => new Promise((r) => setImmediate(r));

test("offboarding: a member REMOVED from the Jellyfin server is signed out everywhere and audited; the row is only soft-deleted", async () => {
  resetOffboarding();
  seedRow("row-gone", "j-gone", { userId: "u-gone" });
  seedRow("row-stay", "j-stay", { userId: "u-stay" });
  seedUser({ id: "u-gone", jellyfinUserId: "j-gone" });
  seedUser({ id: "u-stay", jellyfinUserId: "j-stay" });
  respond = (url) => {
    if (url === `${DEFAULT_URL}/Users`) return okJson([user("j-stay")]);
    throw new Error(`unexpected fetch ${url}`);
  };

  const results = await syncDownloadPolicies();
  assert.ok(results.every((r) => r.errors === 0), JSON.stringify(results));
  assert.equal(msuStore.get("row-gone")!.active, false);
  assert.ok(msuStore.has("row-gone"), "guardrail 28: the identity row is kept");
  assert.equal(sessionsOf("u-gone"), 0, "every session of the departed member is revoked");
  assert.ok(userStore.get("u-gone")!.sessionsRevokedAt instanceof Date, "revokeAllUserSessions stamps the cutoff");
  assert.equal(sessionsOf("u-stay"), 2, "a member still on the server keeps their sessions");
  await flush();
  const audits = offboardAudits();
  assert.equal(audits.length, 1);
  assert.equal(audits[0].target, "user:u-gone");
  assert.equal(audits[0].userId, "system");

  // The next run sees the row already inactive: no second revoke, no second audit.
  seedUser({ id: "u-gone", jellyfinUserId: "j-gone" }, 1); // e.g. signed in with a local password since
  await syncDownloadPolicies();
  await flush();
  assert.equal(sessionsOf("u-gone"), 1, "offboarding fires once, on the transition");
  assert.equal(offboardAudits().length, 1);
});

test("offboarding: a member DISABLED on the server is marked inactive and signed out; re-enabling re-activates the row", async () => {
  resetOffboarding();
  seedRow("row-dis", "j-dis", { userId: "u-dis" });
  seedUser({ id: "u-dis", jellyfinUserId: "j-dis" });
  let disabled = true;
  respond = (url) => {
    if (url === `${DEFAULT_URL}/Users`) return okJson([user("j-dis", { IsDisabled: disabled })]);
    throw new Error(`unexpected fetch ${url}`);
  };

  await syncDownloadPolicies();
  assert.equal(msuStore.get("row-dis")!.active, false, "a disabled account is as gone as a removed one");
  assert.equal(sessionsOf("u-dis"), 0);
  await flush();
  assert.equal(offboardAudits().length, 1);

  disabled = false;
  await syncDownloadPolicies();
  assert.equal(msuStore.get("row-dis")!.active, true, "re-enabled on the server ⇒ active again");
});

test("offboarding (guardrail 35): an identity still on ANOTHER configured server is not signed out", async () => {
  resetOffboarding();
  settings.set("jellyfinRemoteUrl", REMOTE_URL);
  settings.set("jellyfinRemoteApiKey", "key-remote");
  settings.set("jellyfinInstances", JSON.stringify([{ slug: "remote", name: "Remote" }]));
  // u-linked signs in as j-a1, removed from the default server, but is still on
  // "remote" under that server's own id, linked to the same account.
  seedRow("row-a1", "j-a1", { userId: "u-linked" });
  seedRow("row-b1", "j-b1", { serverInstance: "remote", userId: "u-linked" });
  seedUser({ id: "u-linked", jellyfinUserId: "j-a1" });
  // u-same's id is also present (and active) on "remote".
  seedRow("row-a2", "j-shared", { userId: "u-same" });
  seedRow("row-b2", "j-shared", { serverInstance: "remote" });
  seedUser({ id: "u-same", jellyfinUserId: "j-shared" });
  seedRow("row-a3", "j-keep");
  respond = (url) => {
    if (url === `${DEFAULT_URL}/Users`) return okJson([user("j-keep")]);
    if (url === `${REMOTE_URL}/Users`) return okJson([user("j-b1"), user("j-shared")]);
    throw new Error(`unexpected fetch ${url}`);
  };

  await syncDownloadPolicies();
  assert.equal(msuStore.get("row-a1")!.active, false);
  assert.equal(msuStore.get("row-a2")!.active, false);
  assert.equal(sessionsOf("u-linked"), 2, "a linked identity on another server keeps the member signed in");
  assert.equal(sessionsOf("u-same"), 2, "the same id active on another server keeps the member signed in");
  await flush();
  assert.equal(offboardAudits().length, 0);
});

test("offboarding: an ADMIN (role or ADMIN bit) is never signed out", async () => {
  resetOffboarding();
  const { Permission } = await import("../src/lib/permissions.ts");
  seedRow("row-r", "j-role-admin", { userId: "u-role" });
  seedRow("row-b", "j-bit-admin", { userId: "u-bit" });
  seedRow("row-k", "j-keep");
  seedUser({ id: "u-role", role: "ADMIN", jellyfinUserId: "j-role-admin" });
  seedUser({ id: "u-bit", permissions: Permission.ADMIN, jellyfinUserId: "j-bit-admin" });
  respond = (url) => {
    if (url === `${DEFAULT_URL}/Users`) return okJson([user("j-keep")]);
    throw new Error(`unexpected fetch ${url}`);
  };

  await syncDownloadPolicies();
  assert.equal(msuStore.get("row-r")!.active, false);
  assert.equal(sessionsOf("u-role"), 2);
  assert.equal(sessionsOf("u-bit"), 2);
  await flush();
  assert.equal(offboardAudits().length, 0);
});

test("offboarding: a COLD server with no opinion holds every identity back until it answers", async () => {
  resetOffboarding();
  settings.set("jellyfinRemoteUrl", REMOTE_URL);
  settings.set("jellyfinRemoteApiKey", "key-remote");
  settings.set("jellyfinInstances", JSON.stringify([{ slug: "remote", name: "Remote" }]));
  seedRow("row-gone", "j-gone", { userId: "u-gone" });
  seedRow("row-keep", "j-keep");
  seedUser({ id: "u-gone", jellyfinUserId: "j-gone" });
  let remoteUp = false; // "remote" has never stored a user: cold
  respond = (url) => {
    if (url === `${DEFAULT_URL}/Users`) return okJson([user("j-keep")]);
    if (url === `${REMOTE_URL}/Users`) {
      return remoteUp ? okJson([user("j-other")]) : new Response("down", { status: 503 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  await syncDownloadPolicies();
  assert.equal(msuStore.get("row-gone")!.active, false, "the departure itself is still recorded");
  assert.equal(sessionsOf("u-gone"), 2, "the member might be on the server that didn't answer");

  // Next hour the cold server answers — the held-back identity is decided then,
  // although its own row was already inactive (no new transition).
  remoteUp = true;
  await syncDownloadPolicies();
  assert.equal(sessionsOf("u-gone"), 0);
  await flush();
  assert.equal(offboardAudits().length, 1);
});

test("offboarding: a cold server answering an EMPTY user list has no opinion either", async () => {
  // guardrail 35: "cold with a failing/empty fetch" — a 200 with no users (an API
  // key without admin elevation, a server mid-restart) says nothing about who
  // is on it.
  resetOffboarding();
  settings.set("jellyfinRemoteUrl", REMOTE_URL);
  settings.set("jellyfinRemoteApiKey", "key-remote");
  settings.set("jellyfinInstances", JSON.stringify([{ slug: "remote", name: "Remote" }]));
  seedRow("row-gone", "j-gone", { userId: "u-gone" });
  seedRow("row-keep", "j-keep");
  seedUser({ id: "u-gone", jellyfinUserId: "j-gone" });
  respond = (url) => {
    if (url === `${DEFAULT_URL}/Users`) return okJson([user("j-keep")]);
    if (url === `${REMOTE_URL}/Users`) return okJson([]);
    throw new Error(`unexpected fetch ${url}`);
  };

  await syncDownloadPolicies();
  assert.equal(sessionsOf("u-gone"), 2);
});

test("offboarding: a STALE server (rows stored, fetch failed) does not hold it back — its last-known rows count", async () => {
  resetOffboarding();
  settings.set("jellyfinRemoteUrl", REMOTE_URL);
  settings.set("jellyfinRemoteApiKey", "key-remote");
  settings.set("jellyfinInstances", JSON.stringify([{ slug: "remote", name: "Remote" }]));
  seedRow("row-gone", "j-gone", { userId: "u-gone" });
  seedRow("row-keep", "j-keep");
  seedRow("row-remote", "j-other", { serverInstance: "remote" });
  seedUser({ id: "u-gone", jellyfinUserId: "j-gone" });
  respond = (url) => {
    if (url === `${DEFAULT_URL}/Users`) return okJson([user("j-keep")]);
    if (url === `${REMOTE_URL}/Users`) return new Response("down", { status: 503 });
    throw new Error(`unexpected fetch ${url}`);
  };

  await syncDownloadPolicies();
  assert.equal(sessionsOf("u-gone"), 0);
});

test("offboarding: a failed revoke is reported and retried on the next run", async () => {
  resetOffboarding();
  seedRow("row-gone", "j-gone", { userId: "u-gone" });
  seedRow("row-keep", "j-keep");
  seedUser({ id: "u-gone", jellyfinUserId: "j-gone" });
  respond = (url) => {
    if (url === `${DEFAULT_URL}/Users`) return okJson([user("j-keep")]);
    throw new Error(`unexpected fetch ${url}`);
  };

  txThrows = 1;
  const first = await syncDownloadPolicies();
  assert.equal(sessionsOf("u-gone"), 2);
  assert.ok(first.some((r) => r.source === "jellyfin-offboarding" && r.errors === 1), "the cron run is not-ok");

  const second = await syncDownloadPolicies();
  assert.ok(second.every((r) => r.errors === 0), JSON.stringify(second));
  assert.equal(sessionsOf("u-gone"), 0, "the identity stayed pending and is signed out on the retry");
});
