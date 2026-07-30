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
// Full integration harness (not just the pure predicate above): the real
// syncDownloadPolicies/syncJellyfinPolicies run against a scripted
// globalThis.fetch (the jellyfin.ts idiom — RFC1918 IP-literal bases skip the
// SSRF DNS resolver entirely) and an in-memory prisma stub (the
// jellyfin-config.ts idiom — shadowPrismaModel on the real, shared client).
// Two configured instances are exercised together: the default ("") and a
// named "remote" — mirroring a real friend's-second-server deployment.
import { prisma } from "../src/lib/prisma.ts";
import { shadowPrismaModel } from "./_helpers.mts";

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
}

const settings = new Map<string, string>();
const msuStore = new Map<string, MsuRow>();

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

shadowPrismaModel(prisma, "user", {
  // No account-linking under test here — every identity resolves unlinked.
  findMany: async () => [],
});

shadowPrismaModel(prisma, "mediaServerUser", {
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
const { syncDownloadPolicies } = await import("../src/lib/download-policy.ts");

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
