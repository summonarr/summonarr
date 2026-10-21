// Guardrail 34e, Jellyfin half — the boot backfill that moved pre-34e rows onto
// the identity binding (src/lib/jellyfin-identity.ts), plus the reserved-domain
// helper every account-creating path refuses with (src/lib/reserved-email.ts).
// Sign-in's own binding rules are pinned in tests/auth.test.mts.
//
// Backfill step 1, ONCE EVER: rows that identify as Jellyfin only by the
// synthetic `jellyfin-<id>@jellyfin.local` address get that id as their
// jellyfinUserId, because sign-in no longer falls back to the address. ONLY rows
// shaped like a Jellyfin-provisioned account qualify — a row that also has a
// password, a Plex id or an OIDC binding is exactly the impostor the fallback
// used to hand a sign-in to, so it is counted and logged, never bound. A
// conflicting id (another row holds it) is skipped, and a sign-in that bound
// the row meanwhile is never overwritten (conditional write). The marker makes
// it one-shot.
//
// Backfill step 2, EVERY BOOT: a bound row with no jellyfinInstance takes the
// instance its id was FIRST seen on (oldest MediaServerUser row, soft-deleted
// rows included); a row with no evidence stays null for sign-in to adopt.
//
// No DB: globalThis.prisma is pre-seeded with a fake client before prisma.ts
// loads (the cron-auth.test pattern), with a where-evaluator covering exactly
// the shapes the backfill issues.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);

const warns: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };

type UserRow = {
  id: string;
  email: string;
  passwordHash: string | null;
  plexUserId: string | null;
  jellyfinUserId: string | null;
  jellyfinInstance: string | null;
  oidc: boolean; // has an `oidc` Account row
};
type MsuRow = { source: string; serverInstance: string; sourceUserId: string; createdAt: Date };

let users: UserRow[] = [];
let msus: MsuRow[] = [];
const settings = new Map<string, string>();
let beforeUpdate: ((where: Record<string, unknown>) => void) | null = null;

function matchValue(actual: unknown, cond: unknown): boolean {
  if (cond === null || typeof cond !== "object") return actual === cond;
  const c = cond as Record<string, unknown>;
  if ("endsWith" in c) return typeof actual === "string" && actual.endsWith(c.endsWith as string);
  if ("in" in c) return (c.in as unknown[]).includes(actual);
  if ("not" in c) return actual !== c.not;
  throw new Error(`unsupported condition ${JSON.stringify(cond)}`);
}
function matchUser(u: UserRow, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === "OR") return (v as Record<string, unknown>[]).some((w) => matchUser(u, w));
    if (k === "accounts") {
      const rel = v as { none?: { provider: string }; some?: { provider: string } };
      if (rel.none) return !u.oidc;
      if (rel.some) return u.oidc;
    }
    return matchValue((u as unknown as Record<string, unknown>)[k], v);
  });
}

const { Prisma } = await import("@/generated/prisma");

(globalThis as unknown as { prisma: unknown }).prisma = {
  setting: {
    findUnique: async (a: { where: { key: string } }) =>
      settings.has(a.where.key) ? { key: a.where.key, value: settings.get(a.where.key)! } : null,
    upsert: async (a: { where: { key: string }; create: { value: string } }) => {
      if (!settings.has(a.where.key)) settings.set(a.where.key, a.create.value);
      return { key: a.where.key, value: settings.get(a.where.key)! };
    },
  },
  user: {
    findMany: async (a: { where: Record<string, unknown>; select: Record<string, boolean> }) =>
      users.filter((u) => matchUser(u, a.where)).map((u) => Object.fromEntries(Object.keys(a.select).map((k) => [k, (u as unknown as Record<string, unknown>)[k]]))),
    count: async (a: { where: Record<string, unknown> }) => users.filter((u) => matchUser(u, a.where)).length,
    updateMany: async (a: { where: Record<string, unknown>; data: Partial<UserRow> }) => {
      beforeUpdate?.(a.where);
      const hits = users.filter((u) => matchUser(u, a.where));
      if (a.data.jellyfinUserId !== undefined && users.some((u) => u.jellyfinUserId === a.data.jellyfinUserId && !hits.includes(u))) {
        throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" });
      }
      for (const u of hits) Object.assign(u, a.data);
      return { count: hits.length };
    },
  },
  mediaServerUser: {
    findMany: async (a: { where: { source: string; sourceUserId: { in: string[] } } }) =>
      msus
        .filter((m) => m.source === a.where.source && a.where.sourceUserId.in.includes(m.sourceUserId))
        .sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime() || x.serverInstance.localeCompare(y.serverInstance))
        .map((m) => ({ sourceUserId: m.sourceUserId, serverInstance: m.serverInstance })),
  },
};

const { backfillJellyfinIdentities, jellyfinIdFromSyntheticEmail, JELLYFIN_SYNTHETIC_BACKFILL_KEY } =
  await import("../src/lib/jellyfin-identity.ts");
const { isReservedEmailDomain, RESERVED_EMAIL_DOMAINS } = await import("../src/lib/reserved-email.ts");

function seed(overrides: Partial<UserRow> & { id: string; email: string }): UserRow {
  const row: UserRow = { passwordHash: null, plexUserId: null, jellyfinUserId: null, jellyfinInstance: null, oidc: false, ...overrides };
  users.push(row);
  return row;
}
function byId(id: string): UserRow {
  const u = users.find((x) => x.id === id);
  if (!u) throw new Error(`no ${id}`);
  return u;
}

beforeEach(() => {
  users = [];
  msus = [];
  settings.clear();
  warns.length = 0;
  beforeUpdate = null;
});

test("step 1: a Jellyfin-shaped synthetic row is bound to its id; impostor-shaped rows are counted and logged, never bound", async () => {
  seed({ id: "genuine", email: "jellyfin-jf-1@jellyfin.local" });
  seed({ id: "local", email: "jellyfin-jf-2@jellyfin.local", passwordHash: "scrypt$…" });
  seed({ id: "plex", email: "jellyfin-jf-3@jellyfin.local", plexUserId: "px-3" });
  seed({ id: "oidc", email: "jellyfin-jf-4@jellyfin.local", oidc: true });
  seed({ id: "ordinary", email: "someone@example.com" });

  const result = await backfillJellyfinIdentities();
  assert.equal(byId("genuine").jellyfinUserId, "jf-1");
  for (const id of ["local", "plex", "oidc"]) assert.equal(byId(id).jellyfinUserId, null, `${id} must not be bound`);
  assert.equal(byId("ordinary").jellyfinUserId, null);
  assert.equal(result.boundFromEmail, 1);
  assert.equal(result.skippedFromEmail, 3);
  assert.ok(warns.some((w) => w.includes("3 account(s)")), warns.join(" | "));
});

test("step 1 is ONE-SHOT: the marker is stamped and a later boot binds nothing, even a newly matching row", async () => {
  seed({ id: "a", email: "jellyfin-a@jellyfin.local" });
  await backfillJellyfinIdentities();
  assert.ok(settings.get(JELLYFIN_SYNTHETIC_BACKFILL_KEY), "marker stamped");
  seed({ id: "b", email: "jellyfin-b@jellyfin.local" });
  const second = await backfillJellyfinIdentities();
  assert.equal(second.boundFromEmail, 0);
  assert.equal(byId("b").jellyfinUserId, null, "after the one-time bridge, nothing binds by address again");
});

test("step 1: a conflicting id is skipped (not thrown), and a row a sign-in bound meanwhile is never overwritten", async () => {
  seed({ id: "holder", email: "jellyfin-holder@jellyfin.local", jellyfinUserId: "jf-dup", jellyfinInstance: "" });
  seed({ id: "dup", email: "jellyfin-jf-dup@jellyfin.local" });
  seed({ id: "raced", email: "jellyfin-jf-raced@jellyfin.local" });
  beforeUpdate = (where) => {
    if (where.id === "raced") byId("raced").jellyfinUserId = "jf-raced-signin";
  };
  const result = await backfillJellyfinIdentities();
  assert.equal(byId("dup").jellyfinUserId, null);
  assert.equal(byId("raced").jellyfinUserId, "jf-raced-signin", "the conditional write lost to the sign-in");
  assert.equal(result.skippedFromEmail, 1);
  assert.equal(result.boundFromEmail, 0);
});

test("step 2: an unbound row takes the instance its id was FIRST seen on; no evidence leaves it for sign-in", async () => {
  seed({ id: "twinned", email: "jellyfin-t@jellyfin.local", jellyfinUserId: "jf-t" });
  seed({ id: "remote-only", email: "jellyfin-r@jellyfin.local", jellyfinUserId: "jf-r" });
  seed({ id: "unseen", email: "jellyfin-u@jellyfin.local", jellyfinUserId: "jf-u" });
  seed({ id: "already", email: "jellyfin-al@jellyfin.local", jellyfinUserId: "jf-al", jellyfinInstance: "remote" });
  msus.push({ source: "jellyfin", serverInstance: "remote", sourceUserId: "jf-t", createdAt: new Date("2026-09-01") });
  msus.push({ source: "jellyfin", serverInstance: "", sourceUserId: "jf-t", createdAt: new Date("2026-02-01") });
  msus.push({ source: "jellyfin", serverInstance: "remote", sourceUserId: "jf-r", createdAt: new Date("2026-05-01") });
  msus.push({ source: "plex", serverInstance: "", sourceUserId: "jf-u", createdAt: new Date("2026-01-01") });
  msus.push({ source: "jellyfin", serverInstance: "", sourceUserId: "jf-al", createdAt: new Date("2026-01-01") });

  const result = await backfillJellyfinIdentities();
  assert.equal(byId("twinned").jellyfinInstance, "", "the earlier server wins over a later twin");
  assert.equal(byId("remote-only").jellyfinInstance, "remote");
  assert.equal(byId("unseen").jellyfinInstance, null, "a Plex row with the same id is not Jellyfin evidence");
  assert.equal(byId("already").jellyfinInstance, "remote", "an existing binding is never rewritten");
  assert.equal(result.boundInstance, 2);
});

test("step 1 feeds step 2 in the same boot", async () => {
  seed({ id: "legacy", email: "jellyfin-jf-l@jellyfin.local" });
  msus.push({ source: "jellyfin", serverInstance: "remote", sourceUserId: "jf-l", createdAt: new Date("2026-03-01") });
  await backfillJellyfinIdentities();
  assert.equal(byId("legacy").jellyfinUserId, "jf-l");
  assert.equal(byId("legacy").jellyfinInstance, "remote");
});

test("jellyfinIdFromSyntheticEmail reads only the exact placeholder shape", () => {
  assert.equal(jellyfinIdFromSyntheticEmail("jellyfin-abc123@jellyfin.local"), "abc123");
  assert.equal(jellyfinIdFromSyntheticEmail("jellyfin-@jellyfin.local"), null);
  assert.equal(jellyfinIdFromSyntheticEmail("xjellyfin-abc@jellyfin.local"), null);
  assert.equal(jellyfinIdFromSyntheticEmail("jellyfin-abc@a.jellyfin.local"), null);
  assert.equal(jellyfinIdFromSyntheticEmail("someone@example.com"), null);
});

test("isReservedEmailDomain: the three minted domains, any case or compatibility form; nothing else", () => {
  assert.deepEqual([...RESERVED_EMAIL_DOMAINS], ["jellyfin.local", "discord.local", "deleted.invalid"]);
  for (const email of [
    "jellyfin-x@jellyfin.local",
    "discord_1@discord.local",
    "deleted-u@deleted.invalid",
    "Admin@JELLYFIN.LOCAL",
    " x@deleted.invalid ",
    "x@ｊｅｌｌｙｆｉｎ.local", // fullwidth — NFKC folds it
  ]) {
    assert.equal(isReservedEmailDomain(email), true, email);
  }
  for (const email of ["x@example.com", "x@a.jellyfin.local", "x@jellyfin.localhost", "jellyfin.local", "x@local"]) {
    assert.equal(isReservedEmailDomain(email), false, email);
  }
});
