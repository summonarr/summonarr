// Route test for PATCH /api/profile/trakt — the user's own Trakt switches
// (src/lib/trakt-user.ts, guardrail 34c).
//
// Pinned, each mutation-verified:
//   - re-sending the history switch's CURRENT value changes nothing: the import
//     bookkeeping (historyActivityAt / historyImportedAt) is reset only by a
//     real flip, because a reset forces the cron's full history and ratings
//     re-read;
//   - turning it off still deletes the imported history and ratings (40c);
//   - a connection deleted under the request (a disconnect racing it) answers
//     404 notConnected, not a 500 from updating a row that's gone.
//
// Harness: the real wrapped handler, genuine signed session JWTs, in-memory
// prisma stubs whose transaction client answers the connection-row lock from
// the same rows. No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "profile-trakt-route-secret-0123456789ab";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
console.warn = () => {};
console.error = () => {};

const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");
globalThis.fetch = (async (input: RequestInfo | URL) => {
  throw new Error(`unexpected fetch to ${String(input)}`);
}) as typeof fetch;

const { NextRequest } = await import("next/server");
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");

// ── auth fixture ────────────────────────────────────────────────────────────
const users = new Map<string, Record<string, unknown>>();
const sessions = new Set<string>();
shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id: string } }) => {
    const u = users.get(args.where.id);
    return u ? { ...u } : null;
  },
});
shadowPrismaModel(prisma, "authSession", {
  findUnique: async (args: { where: { sessionId: string } }) =>
    sessions.has(args.where.sessionId) ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId, createdAt: new Date() } : null,
  update: async () => ({}),
});
const SETTINGS: Record<string, string> = {
  traktClientId: "client-id",
  traktClientSecret: "client-secret",
  "feature.page.forYou": "true",
};
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) =>
    SETTINGS[args.where.key] === undefined ? null : { key: args.where.key, value: SETTINGS[args.where.key] },
  findMany: async (args: { where: { key: { in: string[] } } }) =>
    args.where.key.in.filter((k) => SETTINGS[k] !== undefined).map((k) => ({ key: k, value: SETTINGS[k] })),
});

// ── Trakt rows ──────────────────────────────────────────────────────────────
type Conn = {
  userId: string; username: string; watchlistAutoRequest: boolean; historySeeds: boolean;
  historyActivityAt: Date | null; historyImportedAt: Date | null; syncedAt: Date | null; status: string | null;
};
let conns: Conn[] = [];
let watchedRows: string[] = [];
let ratingRows: string[] = [];
// Runs at the moment the route locks the connection row (simulates a racing
// disconnect).
let onLock: (() => void) | null = null;

const connModel = {
  findUnique: async (args: { where: { userId: string } }) => conns.find((c) => c.userId === args.where.userId) ?? null,
  updateMany: async (args: { where: { userId: string }; data: Partial<Conn> }) => {
    const hits = conns.filter((c) => c.userId === args.where.userId);
    for (const c of hits) Object.assign(c, args.data);
    return { count: hits.length };
  },
  update: async (args: { where: { userId: string }; data: Partial<Conn> }) => {
    const c = conns.find((x) => x.userId === args.where.userId);
    if (!c) {
      const err = new Error("Record to update not found") as Error & { code: string };
      err.name = "PrismaClientKnownRequestError";
      err.code = "P2025";
      throw err;
    }
    Object.assign(c, args.data);
    return c;
  },
};
const watchedModel = {
  deleteMany: async (args: { where: { userId: string } }) => {
    watchedRows = watchedRows.filter((u) => u !== args.where.userId);
    return { count: 0 };
  },
};
const ratingModel = {
  deleteMany: async (args: { where: { userId: string } }) => {
    ratingRows = ratingRows.filter((u) => u !== args.where.userId);
    return { count: 0 };
  },
};
shadowPrismaModel(prisma, "traktConnection", connModel);
shadowPrismaModel(prisma, "traktWatchedItem", watchedModel);
shadowPrismaModel(prisma, "traktRating", ratingModel);
shadowPrismaModel(prisma, "account", {
  findFirst: async (args: { where: { userId: string } }) =>
    conns.some((c) => c.userId === args.where.userId) ? { id: `acct-${args.where.userId}` } : null,
});
const lockRead = async (query: { values: unknown[] }) => {
  onLock?.();
  const userId = query.values[0];
  return conns.filter((c) => c.userId === userId).map((c) => ({ historySeeds: c.historySeeds }));
};
shadowPrismaClientMethod(prisma, "$transaction", async (fn: (tx: unknown) => Promise<unknown>) =>
  fn({ traktConnection: connModel, traktWatchedItem: watchedModel, traktRating: ratingModel, $queryRaw: lockRead }));

const { PATCH } = await import("../src/app/api/profile/trakt/route.ts");

let seq = 0;
async function connectedUser(over: Partial<Conn> = {}): Promise<{ userId: string; token: string }> {
  seq++;
  const userId = `user-${seq}`;
  const sessionId = `sess-${seq}`;
  users.set(userId, {
    id: userId, role: "USER", permissions: 0n, mediaServer: null, sessionsRevokedAt: null, passwordChangedAt: null,
    deactivatedAt: null, email: `${userId}@example.com`, notificationEmail: null,
  });
  sessions.add(sessionId);
  conns.push({
    userId, username: `trakt-${userId}`, watchlistAutoRequest: true, historySeeds: true,
    historyActivityAt: new Date("2026-10-08T10:00:00Z"), historyImportedAt: new Date("2026-10-08T11:00:00Z"),
    syncedAt: null, status: "ok", ...over,
  });
  watchedRows.push(userId);
  ratingRows.push(userId);
  const iat = Math.floor(Date.now() / 1000);
  const token = await signSessionJwt(
    { id: userId, role: "USER", permissions: "0", provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
  return { userId, token };
}
const patch = (token: string, body: unknown) =>
  PATCH(
    new NextRequest("http://localhost:3000/api/profile/trakt", {
      method: "PATCH",
      headers: { cookie: `${getSessionCookieName()}=${token}`, "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify(body),
    }),
    undefined,
  );

beforeEach(() => {
  conns = [];
  watchedRows = [];
  ratingRows = [];
  onLock = null;
});

test("re-sending historySeeds:true on a connection already on keeps the import bookkeeping", async () => {
  const { userId, token } = await connectedUser({ historySeeds: true });
  const res = await patch(token, { historySeeds: true });
  assert.equal(res.status, 200);
  const conn = conns.find((c) => c.userId === userId)!;
  assert.equal(conn.historyActivityAt?.toISOString(), "2026-10-08T10:00:00.000Z", "no forced re-import");
  assert.equal(conn.historyImportedAt?.toISOString(), "2026-10-08T11:00:00.000Z");
  assert.equal((await res.json()).historySeeds, true, "the GET-shaped state comes back");
});

test("a real flip resets the bookkeeping: off deletes the history and ratings, back on re-imports", async () => {
  const { userId, token } = await connectedUser({ historySeeds: true });
  assert.equal((await patch(token, { historySeeds: false })).status, 200);
  let conn = conns.find((c) => c.userId === userId)!;
  assert.equal(conn.historySeeds, false);
  assert.equal(conn.historyActivityAt, null);
  assert.equal(conn.historyImportedAt, null);
  assert.equal(watchedRows.includes(userId), false, "the imported history is deleted at once");
  assert.equal(ratingRows.includes(userId), false, "and the ratings with it (40c)");

  conn.historyImportedAt = new Date("2026-10-09T00:00:00Z"); // as if an import had run since
  assert.equal((await patch(token, { historySeeds: true })).status, 200);
  conn = conns.find((c) => c.userId === userId)!;
  assert.equal(conn.historySeeds, true);
  assert.equal(conn.historyImportedAt, null, "turning it back on re-imports on the next run");
});

test("a watchlist-only PATCH never touches the history bookkeeping", async () => {
  const { userId, token } = await connectedUser({ watchlistAutoRequest: true });
  assert.equal((await patch(token, { watchlistAutoRequest: false })).status, 200);
  const conn = conns.find((c) => c.userId === userId)!;
  assert.equal(conn.watchlistAutoRequest, false);
  assert.equal(conn.historyImportedAt?.toISOString(), "2026-10-08T11:00:00.000Z");
});

test("a connection deleted under the request answers 404 notConnected, not a 500", async () => {
  const { userId, token } = await connectedUser();
  // The user's disconnect lands between the route's existence check and its write.
  onLock = () => { conns = conns.filter((c) => c.userId !== userId); };
  const res = await patch(token, { watchlistAutoRequest: false });
  assert.equal(res.status, 404);
});

test("not connected at all is a 404 too", async () => {
  const { userId, token } = await connectedUser();
  conns = conns.filter((c) => c.userId !== userId);
  assert.equal((await patch(token, { historySeeds: true })).status, 404);
});
