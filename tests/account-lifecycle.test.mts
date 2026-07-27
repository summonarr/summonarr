// Unit tests for src/lib/account-lifecycle.ts — the two halves of account
// removal, shared by the self-delete (/api/profile) and admin-delete
// (/api/admin/users/[id]) paths.
//
// The whole contract is WHICH data goes and which survives, so these tests pin
// the exact write set of each half:
//
//   deactivateUserInTx (REVERSIBLE — "block sign-in", not "erase")
//   - writes EXACTLY two things: every AuthSession row is deleted, and the User
//     row gets deactivatedAt + sessionsRevokedAt. A deepEqual on the update
//     payload fails the moment anyone re-adds a scrub field here;
//   - MediaServerUser is NEVER touched. The fake tx traps both updateMany and
//     deleteMany on it: severing that link orphans the user's Plex/Jellyfin
//     identity and silently stops every subsequent watch from being attributed
//     (getMyWatchHistory and the admin per-user views both resolve play history
//     through MediaServerUser.userId) — the exact regression this split fixes;
//   - identity data (email, provider keys, OAuth rows, push subs) survives, so
//     an admin can re-enable the account;
//   - the last-admin guard: only the exact role "ADMIN" arms it (advisory lock
//     42 + a CAS whose subquery counts other active admins); a 0-row CAS throws
//     LastAdminError BEFORE any write, so the caller's $transaction rolls back
//     with nothing issued (guardrail 23: propagate, don't swallow).
//
//   purgeUserDataInTx (IRREVERSIBLE — the admin-only PII scrub)
//   - refuses to run at all unless the row is already deactivated
//     (NotDeactivatedError), and is idempotent once purgedAt is set;
//   - scrubbed on the User row (deepEqual pins the full payload): name, email
//     (→ unique, unroutable deleted-<id>@deleted.invalid), image, passwordHash,
//     discordId, notificationEmail, plexClientId/plexUserId/jellyfinUserId;
//   - deleted outright: Account rows (OAuth tokens), AuthSessions, push subs,
//     Discord link tokens + merge codes, watchlist / hidden / notifications;
//   - UNLINKED, never deleted: MediaServerUser rows get userId → null
//     (guardrail 28 — hard-deleting would restrict on play history);
//   - NEVER a hard-delete of the User row itself (requests/votes/issues stay
//     attached to the de-identified row) — user.delete on the fake tx throws.
//
// The tx client is a parameter, so no prisma stubbing is needed — a recording
// fake tx (with throwing traps for the forbidden ops) is passed in. No DB or
// network is touched. reactivateUser() talks to the real prisma singleton, so it
// is covered by the route tests (tests/admin-routes.test.mts) instead.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // the module's prisma import pulls in token-crypto

// Dynamic import so the env assignment above genuinely precedes the
// module-graph load (account-lifecycle imports ./prisma for its TxClient type).
const { deactivateUserInTx, purgeUserDataInTx, LastAdminError, NotDeactivatedError, isPurgedRow, purgedEmailFor } =
  await import("../src/lib/account-lifecycle.ts");
type AnyTx = Parameters<typeof deactivateUserInTx>[0];

// ── recording fake tx ───────────────────────────────────────────────────────
type Op = { op: string; args?: unknown };
const ops: Op[] = [];
const opNames = () => ops.map((o) => o.op);
let casRows = 1; // rows affected by the last-admin CAS ($executeRaw)
let lastCas: { sql: string; values: unknown[] } | null = null;
// What user.findUnique returns to purgeUserDataInTx's precondition check.
let userState: { deactivatedAt: Date | null; purgedAt: Date | null } | null = null;

function record(model: string, method: string) {
  return async (args: unknown) => {
    ops.push({ op: `${model}.${method}`, args });
    return { count: 1 };
  };
}

function trap(message: string) {
  return async () => {
    throw new Error(message);
  };
}

const baseTx = {
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
  watchlistItem: { deleteMany: record("watchlistItem", "deleteMany") },
  hiddenItem: { deleteMany: record("hiddenItem", "deleteMany") },
  notification: { deleteMany: record("notification", "deleteMany") },
  user: {
    findUnique: async (args: unknown) => {
      ops.push({ op: "user.findUnique", args });
      return userState;
    },
    update: record("user", "update"),
    delete: trap("account removal must never hard-delete the User row — history stays attached"),
    deleteMany: trap("account removal must never hard-delete the User row — history stays attached"),
  },
};

// Deactivation must not touch the play-history identity link AT ALL — both
// mutation shapes are trapped, so any regression fails loudly rather than
// silently orphaning the user's watch history.
const deactivateTx = {
  ...baseTx,
  mediaServerUser: {
    updateMany: trap(
      "deactivation must NOT unlink MediaServerUser — it orphans the user's play history",
    ),
    deleteMany: trap("guardrail 28 violated: MediaServerUser must never be hard-deleted"),
  },
} as unknown as AnyTx;

const purgeTx = {
  ...baseTx,
  mediaServerUser: {
    updateMany: record("mediaServerUser", "updateMany"),
    deleteMany: trap("guardrail 28 violated: MediaServerUser must never be hard-deleted"),
  },
} as unknown as AnyTx;

const NOW = new Date("2026-07-27T12:00:00.000Z");
const DISABLED_AT = new Date("2026-07-20T09:00:00.000Z");
const ID = "user-abc123";

const DEACTIVATE_OPS = ["authSession.deleteMany", "user.update"];
const PURGE_OPS = [
  "user.findUnique",
  "account.deleteMany",
  "authSession.deleteMany",
  "pushSubscription.deleteMany",
  "discordLinkToken.deleteMany",
  "discordMergeCode.deleteMany",
  "mediaServerUser.updateMany",
  "watchlistItem.deleteMany",
  "hiddenItem.deleteMany",
  "notification.deleteMany",
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
  userState = { deactivatedAt: DISABLED_AT, purgedAt: null };
});

// ── deactivate ──────────────────────────────────────────────────────────────

test("deactivate, non-admin: no advisory lock, no CAS — exactly the session kill + row flag", async () => {
  await deactivateUserInTx(deactivateTx, ID, "USER", NOW);
  assert.deepEqual(opNames(), DEACTIVATE_OPS); // nothing else is touched
  assert.deepEqual(opArgs("authSession.deleteMany"), { where: { userId: ID } });
});

test("deactivate writes EXACTLY the two lifecycle timestamps — no personal field is scrubbed", async () => {
  await deactivateUserInTx(deactivateTx, ID, "USER", NOW);
  // deepEqual pins both directions: the row is disabled, and NOTHING else is
  // written — email, provider keys, passwordHash, Discord and notification
  // settings all survive so an admin can re-enable the account intact.
  assert.deepEqual(opArgs("user.update"), {
    where: { id: ID },
    data: { deactivatedAt: NOW, sessionsRevokedAt: NOW },
  });
});

test("deactivate leaves the MediaServerUser link alone (play history keeps being attributed)", async () => {
  // deactivateTx traps BOTH mediaServerUser mutations, so this test passing is
  // the proof: the user's Plex/Jellyfin identity stays bound to their row and
  // watches recorded after they were disabled still resolve to them.
  await deactivateUserInTx(deactivateTx, ID, "USER", NOW);
  assert.ok(!opNames().some((o) => o.startsWith("mediaServerUser.")));
});

test("deactivate: OAuth/push/Discord rows survive — only sessions are dropped", async () => {
  await deactivateUserInTx(deactivateTx, ID, "USER", NOW);
  for (const op of ["account.deleteMany", "pushSubscription.deleteMany", "discordLinkToken.deleteMany"]) {
    assert.ok(!opNames().includes(op), `${op} must not run on the reversible path`);
  }
});

test("deactivate: only the exact role string ADMIN arms the last-admin guard (ISSUE_ADMIN does not)", async () => {
  await deactivateUserInTx(deactivateTx, ID, "ISSUE_ADMIN", NOW);
  assert.ok(!opNames().includes("$executeRawUnsafe"), "no advisory lock for ISSUE_ADMIN");
  assert.ok(!opNames().includes("$executeRaw"), "no CAS for ISSUE_ADMIN");
  assert.deepEqual(opNames(), DEACTIVATE_OPS);
});

test("deactivate, ADMIN target: advisory lock 42 first, then the CAS, then the write set", async () => {
  casRows = 1; // another active admin exists — the CAS deactivated the row
  await deactivateUserInTx(deactivateTx, ID, "ADMIN", NOW);
  assert.deepEqual(opNames(), ["$executeRawUnsafe", "$executeRaw", ...DEACTIVATE_OPS]);
  assert.deepEqual(opArgs("$executeRawUnsafe"), {
    sql: "SELECT pg_advisory_xact_lock(42)",
    params: [],
  });
});

test("the CAS deactivates in place, is guarded on still-active + other-admins-remain, and binds [now, id]", async () => {
  await deactivateUserInTx(deactivateTx, ID, "ADMIN", NOW);
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

test("last active admin: 0-row CAS throws LastAdminError with NOT ONE write issued", async () => {
  casRows = 0;
  await assert.rejects(
    () => deactivateUserInTx(deactivateTx, ID, "ADMIN", NOW),
    (err: unknown) => err instanceof LastAdminError && err instanceof Error,
  );
  // Only the lock + the failed CAS ran — the throw precedes every write, so the
  // caller's transaction rolls back having changed nothing.
  assert.deepEqual(opNames(), ["$executeRawUnsafe", "$executeRaw"]);
});

test("deactivatedAt and sessionsRevokedAt are the SAME `now` instant the caller passed (JWT-iat cutoff)", async () => {
  await deactivateUserInTx(deactivateTx, ID, "USER", NOW);
  const { data } = opArgs("user.update") as { data: Record<string, unknown> };
  // Reference equality: the caller's single timestamp is used verbatim for
  // both, so no JWT issued before this instant can outlive the removal.
  assert.equal(data.deactivatedAt, NOW);
  assert.equal(data.sessionsRevokedAt, NOW);
});

// ── purge ───────────────────────────────────────────────────────────────────

test("purge REFUSES an account that is still active — nothing is written", async () => {
  userState = { deactivatedAt: null, purgedAt: null };
  await assert.rejects(
    () => purgeUserDataInTx(purgeTx, ID, NOW),
    (err: unknown) => err instanceof NotDeactivatedError,
  );
  // The precondition read is the ONLY op — an admin can never destroy a live
  // user's data in one step.
  assert.deepEqual(opNames(), ["user.findUnique"]);
});

test("purge on a missing row throws rather than scrubbing something else", async () => {
  userState = null;
  await assert.rejects(
    () => purgeUserDataInTx(purgeTx, ID, NOW),
    (err: unknown) => err instanceof NotDeactivatedError,
  );
  assert.deepEqual(opNames(), ["user.findUnique"]);
});

test("purge is idempotent — an already-purged row is a no-op, not a second scrub", async () => {
  userState = { deactivatedAt: DISABLED_AT, purgedAt: new Date("2026-07-21T00:00:00.000Z") };
  await purgeUserDataInTx(purgeTx, ID, NOW);
  assert.deepEqual(opNames(), ["user.findUnique"]);
});

test("purge of a disabled account issues the full scrub set, in order", async () => {
  await purgeUserDataInTx(purgeTx, ID, NOW);
  assert.deepEqual(opNames(), PURGE_OPS);
  for (const op of PURGE_OPS.slice(1, 6)) {
    assert.deepEqual(opArgs(op), { where: { userId: ID } }, op);
  }
});

test("the purge payload is EXACTLY the personal-data field set — nothing more, nothing less", async () => {
  await purgeUserDataInTx(purgeTx, ID, NOW);
  // deepEqual pins both directions: every personal field is nulled/replaced, and
  // no OTHER field (role, quotas, createdAt, …) is touched — requests/votes/
  // issues stay attached to the de-identified row. deactivatedAt is absent on
  // purpose: the row is ALREADY disabled and must stay that way.
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
      purgedAt: NOW,
      sessionsRevokedAt: NOW,
    },
  });
});

test("purge never clears deactivatedAt — a purged row can't come back as a live account", async () => {
  await purgeUserDataInTx(purgeTx, ID, NOW);
  const { data } = opArgs("user.update") as { data: Record<string, unknown> };
  assert.ok(!("deactivatedAt" in data), "deactivatedAt must be left untouched by the purge");
});

test("the tombstone email is unique per user id and sits on the unroutable .invalid TLD", async () => {
  await purgeUserDataInTx(purgeTx, "user-one", NOW);
  const first = (opArgs("user.update") as { data: { email: string } }).data.email;
  ops.length = 0;
  await purgeUserDataInTx(purgeTx, "user-two", NOW);
  const second = (opArgs("user.update") as { data: { email: string } }).data.email;

  assert.notEqual(first, second); // id keeps the unique-email constraint satisfiable
  for (const email of [first, second]) {
    assert.match(email, /^deleted-user-(one|two)@deleted\.invalid$/);
  }
});

// ── purged-row detection (the pre-`purgedAt` migration gap) ─────────────────

test("isPurgedRow recognises a row scrubbed BEFORE purgedAt existed, by its tombstone email", async () => {
  // The gap that shipped a zombie: `purgedAt` is new, so every account removed
  // by the older anonymize-on-delete code has the scrubbed shape and a NULL
  // marker. A bare `purgedAt != null` test reads those as merely "disabled" and
  // lets them be re-enabled — producing an ACTIVE row nobody can sign into (no
  // password, no provider subject, no OAuth rows, an unroutable email) that
  // still counts toward the active-admin total.
  const legacy = { id: "abc123", email: "deleted-abc123@deleted.invalid", purgedAt: null };
  assert.equal(isPurgedRow(legacy), true);

  // The explicit marker still wins on its own, whatever the address.
  assert.equal(isPurgedRow({ id: "x", email: "real@example.com", purgedAt: new Date() }), true);

  // A live account is never mistaken for one — including the near-miss where
  // the tombstone belongs to a DIFFERENT id (the address embeds the row's own).
  assert.equal(isPurgedRow({ id: "x", email: "real@example.com", purgedAt: null }), false);
  assert.equal(isPurgedRow({ id: "x", email: "deleted-someone-else@deleted.invalid", purgedAt: null }), false);
});

test("the purge writes exactly the address isPurgedRow looks for (no drift between them)", async () => {
  await purgeUserDataInTx(purgeTx, ID, NOW);
  const { data } = opArgs("user.update") as { data: { email: string } };
  assert.equal(data.email, purgedEmailFor(ID));
  // The round trip is the invariant: whatever purge writes must be detectable.
  assert.equal(isPurgedRow({ id: ID, email: data.email, purgedAt: null }), true);
});

test("purge severs the MediaServerUser identity by UNLINKING (userId → null), never by deletion", async () => {
  // purgeTx's mediaServerUser.deleteMany throws, so this test going green also
  // proves no hard-delete was attempted (guardrail 28) — watch history rows
  // survive, just unattributed. This is the ONE step deactivation skips.
  await purgeUserDataInTx(purgeTx, ID, NOW);
  assert.deepEqual(opArgs("mediaServerUser.updateMany"), {
    where: { userId: ID },
    data: { userId: null },
  });
});
