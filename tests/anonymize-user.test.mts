// Unit tests for anonymizeUserInTx (src/lib/anonymize-user.ts) — the shared
// anonymize-and-disable used by BOTH account-deletion paths (self-delete via
// /api/profile and admin-delete via /api/admin/users/[id]). The whole contract
// is WHICH data goes and which survives, so these tests pin the exact write
// set:
//
//   - scrubbed on the User row (deepEqual pins the full update payload, so a
//     new personal field silently NOT being scrubbed fails here): name, email
//     (→ unique, unroutable deleted-<id>@deleted.invalid), image, passwordHash,
//     discordId, notificationEmail, plexClientId/plexUserId/jellyfinUserId
//     (the OAuth provider-subject keys), plus deactivatedAt + sessionsRevokedAt
//     stamped with the SAME `now` (the JWT-iat cutoff);
//   - deleted outright: Account rows (OAuth tokens), AuthSessions (devices),
//     PushSubscriptions, Discord link tokens + merge codes;
//   - UNLINKED, never deleted: MediaServerUser rows get userId → null
//     (guardrail 28 — hard-deleting would cascade/restrict on play history);
//     the fake tx's mediaServerUser.deleteMany THROWS so any regression to a
//     hard-delete fails loudly;
//   - NEVER a hard-delete of the User row itself (requests/votes/issues stay
//     attached to the de-identified row) — user.delete on the fake tx throws;
//   - the last-admin guard: only the exact role "ADMIN" arms it (advisory lock
//     42 + a CAS whose subquery counts other active admins); a 0-row CAS throws
//     LastAdminError BEFORE any scrub write, so the caller's $transaction rolls
//     back with nothing issued (guardrail 23: propagate, don't swallow).
//
// The tx client is a parameter, so no prisma stubbing is needed — a recording
// fake tx (with throwing traps for the forbidden ops) is passed in. No DB or
// network is touched.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // the module's prisma import pulls in token-crypto

// Dynamic import so the env assignment above genuinely precedes the
// module-graph load (anonymize-user imports ./prisma for its TxClient type).
const { anonymizeUserInTx, LastAdminError } = await import("../src/lib/anonymize-user.ts");
type AnonTx = Parameters<typeof anonymizeUserInTx>[0];

// ── recording fake tx ───────────────────────────────────────────────────────
type Op = { op: string; args?: unknown };
const ops: Op[] = [];
const opNames = () => ops.map((o) => o.op);
let casRows = 1; // rows affected by the last-admin CAS ($executeRaw)
let lastCas: { sql: string; values: unknown[] } | null = null;

function record(model: string, method: string) {
  return async (args: unknown) => {
    ops.push({ op: `${model}.${method}`, args });
    return { count: 1 };
  };
}

const fakeTx = {
  $executeRawUnsafe: async (sql: string, ...params: unknown[]) => {
    ops.push({ op: "$executeRawUnsafe", args: { sql, params } });
    return 0;
  },
  // $executeRaw is invoked as a TAGGED TEMPLATE — first arg is the strings
  // array, the rest are the interpolated bind values.
  $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    lastCas = { sql: strings.join(" $bind "), values };
    ops.push({ op: "$executeRaw", args: lastCas });
    return casRows;
  },
  account: { deleteMany: record("account", "deleteMany") },
  authSession: { deleteMany: record("authSession", "deleteMany") },
  pushSubscription: { deleteMany: record("pushSubscription", "deleteMany") },
  discordLinkToken: { deleteMany: record("discordLinkToken", "deleteMany") },
  discordMergeCode: { deleteMany: record("discordMergeCode", "deleteMany") },
  mediaServerUser: {
    updateMany: record("mediaServerUser", "updateMany"),
    deleteMany: async () => {
      throw new Error("guardrail 28 violated: MediaServerUser must never be hard-deleted");
    },
  },
  user: {
    update: record("user", "update"),
    delete: async () => {
      throw new Error("anonymize must never hard-delete the User row — history stays attached");
    },
    deleteMany: async () => {
      throw new Error("anonymize must never hard-delete the User row — history stays attached");
    },
  },
} as unknown as AnonTx;

const NOW = new Date("2026-07-18T12:00:00.000Z");
const ID = "user-abc123";

// The scrub sequence shared by every successful path. Order is account/session
// teardown first, identity unlink, then the in-place row scrub last.
const SCRUB_OPS = [
  "account.deleteMany",
  "authSession.deleteMany",
  "pushSubscription.deleteMany",
  "discordLinkToken.deleteMany",
  "discordMergeCode.deleteMany",
  "mediaServerUser.updateMany",
  "user.update",
];

function opArgs(op: string): unknown {
  const found = ops.find((o) => o.op === op);
  assert.ok(found, `expected op ${op} to have been issued`);
  return found.args;
}

beforeEach(() => {
  ops.length = 0;
  casRows = 1;
  lastCas = null;
});

test("non-admin target: no advisory lock, no CAS — exactly the scrub write set, in order", async () => {
  await anonymizeUserInTx(fakeTx, ID, "USER", NOW);
  assert.deepEqual(opNames(), SCRUB_OPS); // nothing else is touched
  // Every teardown op targets exactly this user's rows.
  for (const op of SCRUB_OPS.slice(0, 5)) {
    assert.deepEqual(opArgs(op), { where: { userId: ID } }, op);
  }
});

test("only the exact role string ADMIN arms the last-admin guard (ISSUE_ADMIN does not)", async () => {
  await anonymizeUserInTx(fakeTx, ID, "ISSUE_ADMIN", NOW);
  assert.ok(!opNames().includes("$executeRawUnsafe"), "no advisory lock for ISSUE_ADMIN");
  assert.ok(!opNames().includes("$executeRaw"), "no CAS for ISSUE_ADMIN");
  assert.deepEqual(opNames(), SCRUB_OPS);
});

test("ADMIN target: advisory lock 42 first, then the CAS, then the same scrub set", async () => {
  casRows = 1; // another active admin exists — the CAS deactivated the row
  await anonymizeUserInTx(fakeTx, ID, "ADMIN", NOW);
  assert.deepEqual(opNames(), ["$executeRawUnsafe", "$executeRaw", ...SCRUB_OPS]);
  assert.deepEqual(opArgs("$executeRawUnsafe"), {
    sql: "SELECT pg_advisory_xact_lock(42)",
    params: [],
  });
});

test("the CAS deactivates in place, is guarded on still-active + other-admins-remain, and binds [now, id]", async () => {
  await anonymizeUserInTx(fakeTx, ID, "ADMIN", NOW);
  assert.ok(lastCas, "CAS statement must have been issued");
  const sql = lastCas!.sql.replace(/\s+/g, " ");
  assert.match(sql, /UPDATE "User" SET "deactivatedAt" = \$bind/);
  assert.match(sql, /WHERE id = \$bind AND "deactivatedAt" IS NULL/); // idempotence guard
  // The atomic other-admins count — the reason this is a CAS and not a read-then-write.
  assert.match(
    sql,
    /\(SELECT COUNT\(\*\) FROM "User" WHERE role = 'ADMIN' AND "deactivatedAt" IS NULL\) > 1/,
  );
  // Values travel as bind params, never interpolated; `now` is the SAME instance.
  assert.equal(lastCas!.values.length, 2);
  assert.equal(lastCas!.values[0], NOW);
  assert.equal(lastCas!.values[1], ID);
});

test("last active admin: 0-row CAS throws LastAdminError with NOT ONE scrub write issued", async () => {
  casRows = 0;
  await assert.rejects(
    () => anonymizeUserInTx(fakeTx, ID, "ADMIN", NOW),
    (err: unknown) => err instanceof LastAdminError && err instanceof Error,
  );
  // Only the lock + the failed CAS ran — the throw precedes every write, so the
  // caller's transaction rolls back having changed nothing.
  assert.deepEqual(opNames(), ["$executeRawUnsafe", "$executeRaw"]);
});

test("the scrub payload is EXACTLY the personal-data field set — nothing more, nothing less", async () => {
  await anonymizeUserInTx(fakeTx, ID, "USER", NOW);
  // deepEqual pins both directions: every personal field is nulled/replaced,
  // and no OTHER field (role, quotas, createdAt, …) is touched — requests/
  // votes/issues stay attached to the de-identified row.
  assert.deepEqual(opArgs("user.update"), {
    where: { id: ID },
    data: {
      name: "Deleted user",
      email: `deleted-${ID}@deleted.invalid`,
      image: null,
      passwordHash: null,
      discordId: null,
      notificationEmail: null,
      plexClientId: null,
      plexUserId: null,
      jellyfinUserId: null,
      deactivatedAt: NOW,
      sessionsRevokedAt: NOW,
    },
  });
});

test("deactivatedAt and sessionsRevokedAt are the SAME `now` instant the caller passed (JWT-iat cutoff)", async () => {
  await anonymizeUserInTx(fakeTx, ID, "USER", NOW);
  const { data } = opArgs("user.update") as { data: Record<string, unknown> };
  // Reference equality: the caller's single timestamp is used verbatim for
  // both, so no JWT issued before this instant can outlive the deletion.
  assert.equal(data.deactivatedAt, NOW);
  assert.equal(data.sessionsRevokedAt, NOW);
});

test("the tombstone email is unique per user id and sits on the unroutable .invalid TLD", async () => {
  await anonymizeUserInTx(fakeTx, "user-one", "USER", NOW);
  const first = (opArgs("user.update") as { data: { email: string } }).data.email;
  ops.length = 0;
  await anonymizeUserInTx(fakeTx, "user-two", "USER", NOW);
  const second = (opArgs("user.update") as { data: { email: string } }).data.email;

  assert.notEqual(first, second); // id keeps the unique-email constraint satisfiable
  for (const email of [first, second]) {
    assert.match(email, /^deleted-user-(one|two)@deleted\.invalid$/);
  }
});

test("MediaServerUser identity is severed by UNLINKING (userId → null), never by deletion", async () => {
  // The fake tx's mediaServerUser.deleteMany throws, so this test going green
  // also proves no hard-delete was attempted (guardrail 28) — watch history
  // rows survive, just unattributed.
  await anonymizeUserInTx(fakeTx, ID, "USER", NOW);
  assert.deepEqual(opArgs("mediaServerUser.updateMany"), {
    where: { userId: ID },
    data: { userId: null },
  });
});
