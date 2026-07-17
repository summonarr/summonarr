// Unit tests for claimAvailableNotificationWinners (src/lib/notify-available.ts)
// — the compare-and-swap behind the "now available" notification fire-exactly-
// once guarantee (CLAUDE.md guardrail 14). The real atomicity lives in
// Postgres's UPDATE … RETURNING; what CAN regress in JS — and what these tests
// pin — is the statement's shape and the winner-filter contract:
//
//  - exactly ONE statement (the TOCTOU fix: no snapshot-then-update pair),
//  - the WHERE always includes `notifiedAvailable = false` (the CAS predicate),
//  - markAvailable adds the status flip AND the PENDING/APPROVED guard (without
//    it, a claim would resurrect a row an admin DECLINED mid-run — a terminal
//    state — and notify the requester of content the admin just declined),
//  - requireStatusAvailable adds `AND "status" = 'AVAILABLE'` for the
//    notify-fallback path that must not claim not-yet-available rows,
//  - only candidates whose id came back in RETURNING are returned (losers of a
//    concurrent race are dropped, unknown ids ignored).
//
// prisma.$queryRaw is shadowed in-memory; the captured Prisma.Sql object's
// `.sql` / `.values` expose the exact statement and bind params.
import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma.ts";
import { claimAvailableNotificationWinners } from "../src/lib/notify-available.ts";

type SqlLike = { sql: string; values: unknown[] };

let nextRows: { id: string }[] = [];
const queries: SqlLike[] = [];

const queryRawStub = async (query: SqlLike): Promise<{ id: string }[]> => {
  queries.push(query);
  return nextRows;
};

(prisma as unknown as { $queryRaw: unknown }).$queryRaw = queryRawStub;
if ((prisma as unknown as { $queryRaw: unknown }).$queryRaw !== queryRawStub) {
  throw new Error("could not shadow prisma.$queryRaw with the in-memory stub — aborting before a real DB query can hang");
}

const norm = (sql: string) => sql.replace(/\s+/g, " ").trim();

test("empty candidate set returns [] without issuing a statement", async () => {
  queries.length = 0;
  assert.deepEqual(await claimAvailableNotificationWinners([]), []);
  assert.equal(queries.length, 0);
});

test("default path: single CAS statement, no status predicate, ids as bind params", async () => {
  queries.length = 0;
  nextRows = [{ id: "a" }];
  const candidates = [{ id: "a" }, { id: "b" }];
  const winners = await claimAvailableNotificationWinners(candidates);

  // One statement — the TOCTOU fix means there is no snapshot query first.
  assert.equal(queries.length, 1);
  const sql = norm(queries[0].sql);
  assert.match(sql, /^UPDATE "MediaRequest" SET "notifiedAvailable" = true WHERE id IN \(/);
  assert.match(sql, /AND "notifiedAvailable" = false/);
  assert.match(sql, /RETURNING id$/);
  // No status guard of any kind on the default path.
  assert.doesNotMatch(sql, /"status"/);
  // Ids travel as bind params (never interpolated into the SQL text).
  assert.deepEqual(queries[0].values, ["a", "b"]);

  assert.deepEqual(winners, [{ id: "a" }]);
});

test("markAvailable: same statement also flips status, guarded to PENDING/APPROVED", async () => {
  queries.length = 0;
  nextRows = [{ id: "a" }];
  await claimAvailableNotificationWinners([{ id: "a" }], { markAvailable: true });

  assert.equal(queries.length, 1);
  const sql = norm(queries[0].sql);
  assert.match(sql, /SET "notifiedAvailable" = true, "status" = 'AVAILABLE', "availableAt" = NOW\(\)/);
  assert.match(sql, /AND "notifiedAvailable" = false/);
  // The DECLINED-resurrection guard: only PENDING/APPROVED rows may be claimed.
  assert.match(sql, /AND "status" IN \('PENDING', 'APPROVED'\)/);
  assert.match(sql, /RETURNING id$/);
});

test("requireStatusAvailable: notify-fallback path claims only rows ALREADY AVAILABLE", async () => {
  queries.length = 0;
  nextRows = [{ id: "a" }];
  await claimAvailableNotificationWinners([{ id: "a" }], { requireStatusAvailable: true });

  const sql = norm(queries[0].sql);
  assert.match(sql, /AND "status" = 'AVAILABLE'/);
  // This path must NOT set status — the row is already AVAILABLE upstream.
  const setClause = sql.slice(sql.indexOf("SET"), sql.indexOf("WHERE"));
  assert.doesNotMatch(setClause, /"status"/);
});

test("winner filter: only RETURNING ids survive, original candidate objects preserved", async () => {
  const a = { id: "a", title: "A" };
  const b = { id: "b", title: "B" };
  const c = { id: "c", title: "C" };
  // "b" lost the race (already claimed elsewhere); "zzz" is an id we never sent
  // — a nonsense RETURNING row must not invent a winner.
  nextRows = [{ id: "a" }, { id: "c" }, { id: "zzz" }];
  const winners = await claimAvailableNotificationWinners([a, b, c]);
  assert.deepEqual(winners, [a, c]);
  // Same object references — callers rely on their enriched candidate shapes.
  assert.equal(winners[0], a);
  assert.equal(winners[1], c);
});

test("zero rows updated (all lost the race) → []", async () => {
  nextRows = [];
  assert.deepEqual(await claimAvailableNotificationWinners([{ id: "a" }]), []);
});
