// savePlexAdminToken (src/lib/plex-admin-connect.ts) — the one writer of the
// Plex admin token, shared by POST /api/settings/plex and the Connect Plex poll.
// Pinned:
//   1. A token plex.tv rejects returns null BEFORE any write.
//   2. The token, the owner's email and the PlexTokenCache flush run inside ONE
//      interactive transaction, one statement at a time (guardrails 23, 23c),
//      with the raw token (the Prisma extension encrypts — guardrail 7a).
//   3. A failing email write leaves no token behind: the transaction rolls the
//      token back with it. (Two bare parallel upserts committed the token alone,
//      and the per-user auth decisions made under the old token survived.)
//   4. The one warn (the cache flush, for operator correlation) carries the
//      CALLER's log prefix, never a hard-coded one.
//
// Harness: in-memory prisma stubs whose $transaction buffers the writes and
// applies them only when the callback resolves (Postgres's all-or-nothing),
// dns.lookup stubbed, scripted globalThis.fetch for plex.tv. No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

let plexUserOk = true;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  if (url.hostname === "plex.tv" && url.pathname === "/api/v2/user") {
    return plexUserOk
      ? new Response(JSON.stringify({ id: 77, email: "owner@example.com", username: "owner" }), { status: 200, headers: { "content-type": "application/json" } })
      : new Response("{}", { status: 401 });
  }
  throw new Error(`unexpected fetch ${url}`);
}) as typeof fetch;

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");

// Committed state, and what a transaction did.
const settings = new Map<string, string>();
let tokenCacheRows = 0;
let failEmailWrite = false;
let transactions = 0;
let inTx = 0;
let maxInFlight = 0;
const ops: string[] = [];

type Pending = Array<() => void>;
function delegates(pending: Pending | null) {
  const apply = (fn: () => void) => (pending ? pending.push(fn) : fn());
  const track = async <T,>(name: string, fn: () => T): Promise<T> => {
    ops.push(`${pending ? "tx" : "bare"}:${name}`);
    inTx++;
    maxInFlight = Math.max(maxInFlight, inTx);
    await new Promise((r) => setImmediate(r));
    inTx--;
    return fn();
  };
  return {
    setting: {
      upsert: (args: { where: { key: string }; update: { value: string } }) => track("setting.upsert", () => {
        if (failEmailWrite && args.where.key === "plexAdminEmail") throw new Error("simulated write failure");
        apply(() => settings.set(args.where.key, args.update.value));
        return { key: args.where.key, value: args.update.value };
      }),
    },
    plexTokenCache: {
      deleteMany: () => track("plexTokenCache.deleteMany", () => {
        apply(() => { tokenCacheRows = 0; });
        return { count: 0 };
      }),
    },
  };
}
const bare = delegates(null);
shadowPrismaModel(prisma, "setting", bare.setting);
shadowPrismaModel(prisma, "plexTokenCache", bare.plexTokenCache);
shadowPrismaClientMethod(prisma, "$transaction", async (arg: unknown) => {
  if (typeof arg !== "function") throw new Error("expected an interactive transaction");
  transactions++;
  const pending: Pending = [];
  const result = await (arg as (tx: unknown) => Promise<unknown>)(delegates(pending));
  for (const commit of pending) commit(); // COMMIT only when the callback resolved
  return result;
});

const { savePlexAdminToken } = await import("../src/lib/plex-admin-connect.ts");

beforeEach(() => {
  settings.clear();
  settings.set("plexAdminToken", "old-token");
  settings.set("plexAdminEmail", "old-owner@example.com");
  tokenCacheRows = 5;
  failEmailWrite = false;
  plexUserOk = true;
  transactions = 0;
  maxInFlight = 0;
  ops.length = 0;
  warns.length = 0;
  errors.length = 0;
});

test("a token plex.tv rejects returns null with no Setting or PlexTokenCache write", async () => {
  plexUserOk = false;
  assert.equal(await savePlexAdminToken("bad-token", "settings/plex"), null);
  assert.deepEqual(ops, []);
  assert.equal(transactions, 0);
  assert.equal(settings.get("plexAdminToken"), "old-token");
  assert.equal(tokenCacheRows, 5);
  assert.ok(errors.some((e) => e.startsWith("[settings/plex] Plex token validation failed")));
});

test("a valid token writes both keys and flushes PlexTokenCache inside ONE transaction, one statement at a time", async () => {
  const user = await savePlexAdminToken("new-token", "plex/pin");
  assert.equal(user?.email, "owner@example.com");
  assert.equal(transactions, 1);
  assert.deepEqual(ops, ["tx:setting.upsert", "tx:setting.upsert", "tx:plexTokenCache.deleteMany"]);
  assert.equal(maxInFlight, 1, "never two queries in flight on the transaction's connection (guardrail 23c)");
  assert.equal(settings.get("plexAdminToken"), "new-token", "the raw token — the Prisma extension encrypts it (7a)");
  assert.equal(settings.get("plexAdminEmail"), "owner@example.com");
  assert.equal(tokenCacheRows, 0);
  assert.deepEqual(warns, ["[plex/pin] plexAdminToken changed — cleared PlexTokenCache"], "one warn, under the caller's prefix");
  assert.deepEqual(errors, []);
});

test("a failing email write rejects and leaves NO token behind: the old token, email and token cache are untouched", async () => {
  failEmailWrite = true;
  await assert.rejects(() => savePlexAdminToken("new-token", "settings/plex"), /simulated write failure/);
  assert.equal(settings.get("plexAdminToken"), "old-token", "the token write rolled back with the failed email write");
  assert.equal(settings.get("plexAdminEmail"), "old-owner@example.com");
  assert.equal(tokenCacheRows, 5);
  assert.ok(!ops.some((o) => o.startsWith("bare:")), "nothing was written outside the transaction");
});
