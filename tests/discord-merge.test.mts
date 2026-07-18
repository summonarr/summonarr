// Unit tests for mergeDiscordIntoWebAccount (src/lib/discord-merge.ts) — the
// account-linking transaction that absorbs a bot-created Discord shadow account
// (synthetic <discordId>@discord.local email) into a real web user. The
// contracts pinned here:
//
//   - plain link (no shadow account, or re-linking the same user): ONE
//     user.update stamping discordId, migrated 0, and no migration ops at all;
//   - refusal: a Discord id already owned by ANOTHER real web account (any
//     non-@discord.local email) throws before a single write — the rejection
//     rolls the real transaction back;
//   - the per-discordUserId advisory lock (double-click guard) is taken FIRST,
//     derived from the first 7 bytes of the id (hex → bigint, ≤56 bits so it
//     always fits Postgres's signed BIGINT);
//   - request dedup keys on tmdbId:mediaType:ARRINSTANCE — the same title on a
//     different instance (default vs 4K/named) is NOT a conflict. Keying
//     without arrInstance deleted the non-default variant (the historical bug
//     the source comment documents); this suite is the regression pin;
//   - conflicts are DELETED (web user's copy wins), the remainder migrates via
//     one updateMany, and `migrated` counts exactly the moved rows; when
//     everything conflicts the updateMany is skipped entirely;
//   - issues / issue messages / issue grabs always migrate; deletion votes
//     dedup on tmdbId:mediaType with the web user's vote winning, and the vote
//     transfer updateMany is unconditional;
//   - finale: the shadow row is deleted BEFORE the web row takes the discordId
//     (two rows may not share a unique discordId even transiently).
//
// No DB: prisma.$transaction is shadowed (tests/_helpers.mts) with a stub that
// hands the callback a recording fake tx. The stub provides tx-callback
// semantics only — real BEGIN/ROLLBACK atomicity is Postgres's job; what CAN
// regress in JS is the op sequence and payloads, which is what's pinned.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto

// Dynamic imports so the env assignment above genuinely precedes the
// module-graph load (static imports would hoist above it).
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaClientMethod } = await import("./_helpers.mts");

// ── recording fake tx ───────────────────────────────────────────────────────
const WEB = "web-user-1";
const SHADOW = "shadow-user-1";
const DISCORD_ID = "123456789012345678";

type Op = { op: string; args?: unknown };
const ops: Op[] = [];
const opNames = () => ops.map((o) => o.op);

type ReqRow = { id: string; tmdbId: number; mediaType: string; arrInstance: string };
type VoteRow = { id: string; tmdbId: number; mediaType: string };

let existingUser: { id: string; email: string } | null = null;
let webRequests: Array<Omit<ReqRow, "id">> = [];
let shadowRequests: ReqRow[] = [];
let webVotes: Array<Omit<VoteRow, "id">> = [];
let shadowVotes: VoteRow[] = [];

function record(model: string, method: string) {
  return async (args: unknown) => {
    ops.push({ op: `${model}.${method}`, args });
    return { count: 0 };
  };
}

const fakeTx = {
  $executeRawUnsafe: async (sql: string, ...params: unknown[]) => {
    ops.push({ op: "$executeRawUnsafe", args: { sql, params } });
    return 0;
  },
  user: {
    findUnique: async (args: unknown) => {
      ops.push({ op: "user.findUnique", args });
      return existingUser;
    },
    update: record("user", "update"),
    delete: record("user", "delete"),
  },
  mediaRequest: {
    findMany: async (args: { where: { requestedBy: string } }) => {
      ops.push({ op: "mediaRequest.findMany", args });
      return args.where.requestedBy === WEB ? webRequests : shadowRequests;
    },
    deleteMany: record("mediaRequest", "deleteMany"),
    updateMany: record("mediaRequest", "updateMany"),
  },
  issue: { updateMany: record("issue", "updateMany") },
  issueMessage: { updateMany: record("issueMessage", "updateMany") },
  issueGrab: { updateMany: record("issueGrab", "updateMany") },
  deletionVote: {
    findMany: async (args: { where: { userId: string } }) => {
      ops.push({ op: "deletionVote.findMany", args });
      return args.where.userId === WEB ? webVotes : shadowVotes;
    },
    deleteMany: record("deletionVote", "deleteMany"),
    updateMany: record("deletionVote", "updateMany"),
  },
};

shadowPrismaClientMethod(prisma, "$transaction", async (fn: (tx: unknown) => Promise<unknown>) =>
  fn(fakeTx),
);

const { mergeDiscordIntoWebAccount } = await import("../src/lib/discord-merge.ts");

function opArgs(op: string): unknown {
  const found = ops.find((o) => o.op === op);
  assert.ok(found, `expected op ${op} to have been issued`);
  return found.args;
}

// Script a mergeable shadow account (synthetic bot email).
function seedShadow(): void {
  existingUser = { id: SHADOW, email: `${DISCORD_ID}@discord.local` };
}

beforeEach(() => {
  ops.length = 0;
  existingUser = null;
  webRequests = [];
  shadowRequests = [];
  webVotes = [];
  shadowVotes = [];
});

test("no account owns the discordId → plain link: lock, lookup, ONE user.update, migrated 0", async () => {
  const result = await mergeDiscordIntoWebAccount(WEB, DISCORD_ID);
  assert.deepEqual(result, { migrated: 0 });
  assert.deepEqual(opNames(), ["$executeRawUnsafe", "user.findUnique", "user.update"]);
  assert.deepEqual(opArgs("user.update"), {
    where: { id: WEB },
    data: { discordId: DISCORD_ID },
  });
});

test("re-linking a discordId the web user already owns is the plain link, not a merge or a refusal", async () => {
  // existing.id === webUserId short-circuits BEFORE the synthetic-email check,
  // so a real (non-@discord.local) email on one's own row never trips the
  // "already linked to another user" refusal.
  existingUser = { id: WEB, email: "chris@example.com" };
  const result = await mergeDiscordIntoWebAccount(WEB, DISCORD_ID);
  assert.deepEqual(result, { migrated: 0 });
  assert.deepEqual(opNames(), ["$executeRawUnsafe", "user.findUnique", "user.update"]);
});

test("a discordId owned by ANOTHER real web account refuses the merge before any write", async () => {
  existingUser = { id: "other-web-user", email: "someone-else@gmail.com" };
  await assert.rejects(
    () => mergeDiscordIntoWebAccount(WEB, DISCORD_ID),
    /This Discord account is already linked to another user\./,
  );
  // Lock + lookup only — the throw precedes every mutation, so the real
  // transaction rolls back having changed nothing.
  assert.deepEqual(opNames(), ["$executeRawUnsafe", "user.findUnique"]);
});

test("the double-click guard: per-discordUserId advisory lock, first 7 id bytes as a bigint, taken FIRST", async () => {
  await mergeDiscordIntoWebAccount(WEB, DISCORD_ID);
  assert.equal(opNames()[0], "$executeRawUnsafe");
  // "1234567" (the first 7 ASCII bytes of the id) → hex 31323334353637.
  assert.deepEqual(opArgs("$executeRawUnsafe"), {
    sql: "SELECT pg_advisory_xact_lock($1::bigint)",
    params: [0x31323334353637n],
  });

  // A short id (< 7 bytes) clamps instead of throwing, and 7 bytes = 56 bits
  // always fits Postgres's signed BIGINT.
  ops.length = 0;
  await mergeDiscordIntoWebAccount(WEB, "ab");
  const { params } = opArgs("$executeRawUnsafe") as { params: bigint[] };
  assert.deepEqual(params, [0x6162n]);
  assert.ok(0x31323334353637n < 2n ** 63n);
});

test("merge: conflicting requests (same tmdbId+mediaType+arrInstance) die, the rest migrate, migrated counts the moved", async () => {
  seedShadow();
  webRequests = [{ tmdbId: 100, mediaType: "MOVIE", arrInstance: "" }];
  shadowRequests = [
    { id: "r-dup", tmdbId: 100, mediaType: "MOVIE", arrInstance: "" }, // conflict — web copy wins
    { id: "r-new", tmdbId: 200, mediaType: "TV", arrInstance: "" },
  ];
  const result = await mergeDiscordIntoWebAccount(WEB, DISCORD_ID);
  assert.deepEqual(result, { migrated: 1 });
  assert.deepEqual(opArgs("mediaRequest.deleteMany"), { where: { id: { in: ["r-dup"] } } });
  assert.deepEqual(opArgs("mediaRequest.updateMany"), {
    where: { requestedBy: SHADOW },
    data: { requestedBy: WEB },
  });
});

test("REGRESSION PIN: the same title on a DIFFERENT arr instance is not a conflict", async () => {
  // The dedup key is tmdbId:mediaType:arrInstance — the MediaRequest unique
  // includes arrInstance, so a default-instance and a 4K request for the same
  // title are distinct rows. Keying without arrInstance deleted the 4K variant.
  seedShadow();
  webRequests = [{ tmdbId: 100, mediaType: "MOVIE", arrInstance: "" }];
  shadowRequests = [{ id: "r-4k", tmdbId: 100, mediaType: "MOVIE", arrInstance: "4k" }];
  const result = await mergeDiscordIntoWebAccount(WEB, DISCORD_ID);
  assert.deepEqual(result, { migrated: 1 });
  assert.ok(!opNames().includes("mediaRequest.deleteMany"), "the 4K variant must survive the merge");
  assert.deepEqual(opArgs("mediaRequest.updateMany"), {
    where: { requestedBy: SHADOW },
    data: { requestedBy: WEB },
  });
});

test("all shadow requests conflict → deleted, updateMany SKIPPED, migrated 0 — the account is still absorbed", async () => {
  seedShadow();
  webRequests = [{ tmdbId: 100, mediaType: "MOVIE", arrInstance: "" }];
  shadowRequests = [{ id: "r-dup", tmdbId: 100, mediaType: "MOVIE", arrInstance: "" }];
  const result = await mergeDiscordIntoWebAccount(WEB, DISCORD_ID);
  assert.deepEqual(result, { migrated: 0 });
  assert.deepEqual(opArgs("mediaRequest.deleteMany"), { where: { id: { in: ["r-dup"] } } });
  assert.ok(!opNames().includes("mediaRequest.updateMany"), "nothing left to move");
  // The merge still completes: shadow deleted, web user linked.
  assert.deepEqual(opArgs("user.delete"), { where: { id: SHADOW } });
  assert.deepEqual(opArgs("user.update"), { where: { id: WEB }, data: { discordId: DISCORD_ID } });
});

test("issues, issue messages, and issue grabs ALWAYS migrate to the web user", async () => {
  seedShadow(); // no requests, no votes — the issue transfer is unconditional
  await mergeDiscordIntoWebAccount(WEB, DISCORD_ID);
  assert.deepEqual(opArgs("issue.updateMany"), {
    where: { reportedBy: SHADOW },
    data: { reportedBy: WEB },
  });
  assert.deepEqual(opArgs("issueMessage.updateMany"), {
    where: { authorId: SHADOW },
    data: { authorId: WEB },
  });
  assert.deepEqual(opArgs("issueGrab.updateMany"), {
    where: { triggeredById: SHADOW },
    data: { triggeredById: WEB },
  });
});

test("deletion votes dedup on tmdbId:mediaType — the web user's existing vote wins, the survivor transfers", async () => {
  seedShadow();
  webVotes = [{ tmdbId: 55, mediaType: "MOVIE" }];
  shadowVotes = [
    { id: "v-dup", tmdbId: 55, mediaType: "MOVIE" }, // both voted — count must not double
    { id: "v-keep", tmdbId: 66, mediaType: "TV" },
  ];
  await mergeDiscordIntoWebAccount(WEB, DISCORD_ID);
  assert.deepEqual(opArgs("deletionVote.deleteMany"), { where: { id: { in: ["v-dup"] } } });
  assert.deepEqual(opArgs("deletionVote.updateMany"), {
    where: { userId: SHADOW },
    data: { userId: WEB },
  });
  // Conflict removal precedes the transfer — the shadow's duplicate must be
  // gone before its remaining votes take the web user's id.
  assert.ok(
    opNames().indexOf("deletionVote.deleteMany") < opNames().indexOf("deletionVote.updateMany"),
  );
});

test("no vote conflicts → no deleteMany, but the vote-transfer updateMany is still issued (unconditional)", async () => {
  seedShadow();
  shadowVotes = [{ id: "v-solo", tmdbId: 77, mediaType: "MOVIE" }];
  await mergeDiscordIntoWebAccount(WEB, DISCORD_ID);
  assert.ok(!opNames().includes("deletionVote.deleteMany"));
  assert.deepEqual(opArgs("deletionVote.updateMany"), {
    where: { userId: SHADOW },
    data: { userId: WEB },
  });
});

test("merge finale: the shadow row is deleted BEFORE the web row takes the discordId, and the tx result flows out", async () => {
  seedShadow();
  shadowRequests = [
    { id: "r-1", tmdbId: 1, mediaType: "MOVIE", arrInstance: "" },
    { id: "r-2", tmdbId: 2, mediaType: "TV", arrInstance: "anime" },
  ];
  const result = await mergeDiscordIntoWebAccount(WEB, DISCORD_ID);
  assert.deepEqual(result, { migrated: 2 });

  const names = opNames();
  const deleteIdx = names.indexOf("user.delete");
  const linkIdx = names.indexOf("user.update");
  assert.ok(deleteIdx !== -1 && linkIdx !== -1);
  // discordId is unique on User — the shadow holder must be gone before the
  // web row claims it, even transiently within the tx.
  assert.ok(deleteIdx < linkIdx, "shadow delete must precede the discordId claim");
  assert.deepEqual(opArgs("user.delete"), { where: { id: SHADOW } });
  assert.deepEqual(opArgs("user.update"), { where: { id: WEB }, data: { discordId: DISCORD_ID } });
});
