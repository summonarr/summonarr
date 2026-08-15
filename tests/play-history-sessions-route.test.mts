// GET /api/play-history/sessions must SERIALIZE, not just authorize.
//
// The route returns whole ActiveSession rows (`...s`), and JSON.stringify
// throws a TypeError on a BigInt — so a single uncoerced BigInt column turns
// every request that has at least one live session into a 500. That is exactly
// what shipped: the coercion list named the three BigInt columns that existed
// when it was written, `startProgressMs` was added later, and the endpoint
// 500'd for anyone with something playing.
//
// It went unnoticed because the iOS app is this route's ONLY consumer — the web
// now-playing list is rendered by the admin/activity server component (RSC
// serializes BigInt natively) and refreshed over the `activity:sessions` SSE
// payload, which projects its fields one by one. Neither path passes through
// here, so "works on the web" said nothing about this route.
//
// tests/play-history-admin-guard.test.mts already pins the ADMIN gate, but its
// activeSession stub returns [] — an empty array serializes fine, so the guard
// test can never see this class of bug. Hence this file: a REALISTIC row.
//
// The pin is structural. The BigInt column list is read out of
// prisma/schema.prisma at test time rather than hardcoded, so adding a fifth
// BigInt column to ActiveSession without teaching the route about it fails here
// instead of in production.
//
// Harness mirrors tests/play-history-admin-guard.test.mts: a real signed
// session JWT over bearer transport (guardrail 6b), in-memory authSession/user
// stubs, no DB, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";

// Next's async-local-storage shim captures globalThis.AsyncLocalStorage at
// module load — assign it BEFORE anything pulls in next/*.
(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "ph-sessions-route-test-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

globalThis.fetch = (() => {
  throw new Error("unexpected network call from play-history-sessions-route tests");
}) as unknown as typeof fetch;

console.warn = () => { };
console.error = () => { };

const { NextRequest } = await import("next/server");
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");

// ── the BigInt columns, read from the schema (not hardcoded) ──────────────────

/** Every `BigInt` field on a model in prisma/schema.prisma. */
function bigIntColumnsOf(model: string): string[] {
  const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
  const block = new RegExp(`^model ${model} \\{$([\\s\\S]*?)^\\}$`, "m").exec(schema);
  assert.ok(block, `model ${model} not found in prisma/schema.prisma`);
  return block[1]
    .split("\n")
    .map((line) => /^\s*(\w+)\s+BigInt\b/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1]);
}

const BIGINT_COLUMNS = bigIntColumnsOf("ActiveSession");

// Sanity: if this ever reads empty the test would pass vacuously.
assert.ok(
  BIGINT_COLUMNS.length >= 4,
  `expected ActiveSession to still carry its BigInt columns, parsed: ${BIGINT_COLUMNS.join(", ")}`,
);

// One live session, with every BigInt column set to a distinct value so the
// assertions below can tell them apart (and catch a coercion writing the wrong
// field). Values are the ms magnitudes these columns really carry.
const LIVE_SESSION: Record<string, unknown> = {
  id: "plex:42",
  source: "plex",
  serverInstance: "",
  state: "playing",
  mediaServerUserId: "msu-1",
  serverUsername: "someone",
  title: "A Movie",
  tmdbId: 603,
  mediaType: "MOVIE",
  progressPercent: 35,
  platform: "tvOS",
  player: "Apple TV",
  startedAt: new Date("2026-08-15T00:00:00.000Z"),
  lastSeenAt: new Date("2026-08-15T00:10:00.000Z"),
  progressUpdatedAt: new Date("2026-08-15T00:10:00.000Z"),
};
BIGINT_COLUMNS.forEach((column, i) => {
  LIVE_SESSION[column] = BigInt((i + 1) * 60_000);
});

shadowPrismaModel(prisma, "activeSession", {
  findMany: async () => [{ ...LIVE_SESSION }],
});

// ── admin session ─────────────────────────────────────────────────────────────

const usersById = new Map<string, Record<string, unknown>>();
const authSessions = new Map<string, Record<string, unknown>>();

shadowPrismaModel(prisma, "authSession", {
  findUnique: async (a: { where: { sessionId: string } }) => authSessions.get(a.where.sessionId) ?? null,
  update: async () => ({}),
});
shadowPrismaModel(prisma, "user", {
  findUnique: async (a: { where: { id: string } }) => usersById.get(a.where.id) ?? null,
  update: async () => ({}),
});

async function mintAdminToken(): Promise<string> {
  const userId = "admin-1";
  const sessionId = "sess-admin-1";
  usersById.set(userId, {
    role: "ADMIN", permissions: 0n, mediaServer: null,
    sessionsRevokedAt: null, passwordChangedAt: null, deactivatedAt: null,
    email: "admin@example.com", notificationEmail: null, passwordHash: null,
    plexUserId: null, jellyfinUserId: null,
  });
  authSessions.set(sessionId, { sessionId, userId, expiresAt: new Date(Date.now() + 86_400_000) });
  const iat = Math.floor(Date.now() / 1000);
  return signSessionJwt(
    { id: userId, role: "ADMIN", permissions: "0", provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
}

const sessionsRoute = (await import("../src/app/api/play-history/sessions/route.ts")).GET;

function request(token: string) {
  return new NextRequest("http://localhost:3000/api/play-history/sessions", {
    headers: { authorization: `Bearer ${token}`, "x-forwarded-for": "203.0.113.5" },
  });
}

// ── tests ─────────────────────────────────────────────────────────────────────

test("a live session serializes: 200 with a parseable body, NOT a BigInt 500", async () => {
  const res = await sessionsRoute(request(await mintAdminToken()), undefined);
  assert.equal(res.status, 200, "a row with BigInt columns must not blow up JSON.stringify");
  const body = (await res.json()) as Record<string, unknown>[];
  assert.equal(body.length, 1);
  assert.equal(body[0].id, "plex:42");
});

test("EVERY BigInt column on ActiveSession arrives as a JSON number, with its own value", async () => {
  const res = await sessionsRoute(request(await mintAdminToken()), undefined);
  const [row] = (await res.json()) as Record<string, unknown>[];
  for (const column of BIGINT_COLUMNS) {
    assert.equal(
      typeof row[column],
      "number",
      `${column} must be coerced — an uncoerced BigInt 500s the whole route`,
    );
    // Not just "a number": the right one. Guards a coercion that overwrites the
    // wrong field (the failure mode a spread + per-field override invites).
    assert.equal(row[column], Number(LIVE_SESSION[column] as bigint), `${column} value must be preserved`);
  }
});

test("non-BigInt fields pass through unchanged — the wire shape is what the client already decodes", async () => {
  const res = await sessionsRoute(request(await mintAdminToken()), undefined);
  const [row] = (await res.json()) as Record<string, unknown>[];
  assert.equal(row.source, "plex");
  assert.equal(row.state, "playing");
  assert.equal(row.tmdbId, 603);
  assert.equal(row.progressPercent, 35);
  assert.equal(row.startedAt, "2026-08-15T00:00:00.000Z");
  // No field is dropped: every key of the row survives serialization.
  for (const key of Object.keys(LIVE_SESSION)) {
    assert.ok(key in row, `${key} must still be present in the response`);
  }
});
