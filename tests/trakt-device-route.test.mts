// Route test for POST /api/profile/trakt/device — starting a Trakt connection
// needs a step-up (guardrail 6g). A connected Trakt account files its watchlist
// as this user's requests and survives a password change, so a hijacked
// session must not be able to connect the hijacker's own Trakt account: a
// password account re-enters its password, an SSO account must have signed in
// within the last 5 minutes. No native client calls this route.
//
// Harness: the real wrapped handler, genuine signed session JWTs, in-memory
// prisma stubs, and a scripted api.trakt.tv. No DB, no real network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "trakt-device-route-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
console.warn = () => {};
console.error = () => {};

const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

let traktCalls = 0;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  if (url.hostname === "api.trakt.tv" && url.pathname === "/oauth/device/code") {
    traktCalls++;
    return new Response(
      JSON.stringify({ device_code: "dev-123", user_code: "ABCD1234", verification_url: "https://trakt.tv/activate", expires_in: 600, interval: 5 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  throw new Error(`unexpected fetch to ${url.href}`);
}) as typeof fetch;

const { NextRequest } = await import("next/server");
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");
const { hashPassword } = await import("../src/lib/password-hash.ts");

const users = new Map<string, Record<string, unknown>>();
const sessions = new Map<string, Date>();
shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id: string } }) => {
    const u = users.get(args.where.id);
    return u ? { ...u } : null;
  },
});
shadowPrismaModel(prisma, "authSession", {
  findUnique: async (args: { where: { sessionId: string } }) => {
    const createdAt = sessions.get(args.where.sessionId);
    return createdAt ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId, createdAt } : null;
  },
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
shadowPrismaModel(prisma, "auditLog", { create: async (args: { data: unknown }) => args.data });

const { POST: startTrakt } = await import("../src/app/api/profile/trakt/device/route.ts");

const PASSWORD = "correct-horse-battery";
const HASH = await hashPassword(PASSWORD);
let seq = 0;
async function mint(opts: { passwordHash?: string | null; sessionAgeMs?: number } = {}): Promise<string> {
  seq++;
  const id = `user-${seq}`;
  const sessionId = `sess-${seq}`;
  users.set(id, {
    id, role: "USER", permissions: 0n, mediaServer: null, sessionsRevokedAt: null, passwordChangedAt: null,
    deactivatedAt: null, email: `${id}@example.com`, notificationEmail: null, passwordHash: opts.passwordHash ?? null,
  });
  sessions.set(sessionId, new Date(Date.now() - (opts.sessionAgeMs ?? 0)));
  const iat = Math.floor(Date.now() / 1000);
  return signSessionJwt(
    { id, role: "USER", permissions: "0", provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
}
const post = (token: string, body?: unknown) =>
  startTrakt(
    new NextRequest("http://localhost:3000/api/profile/trakt/device", {
      method: "POST",
      headers: { cookie: `${getSessionCookieName()}=${token}`, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    undefined,
  );

beforeEach(() => { traktCalls = 0; });

test("a PASSWORD account must confirm its password before Trakt is ever contacted", async () => {
  const token = await mint({ passwordHash: HASH });
  const ask = await post(token);
  assert.equal(ask.status, 401);
  assert.equal((await ask.json()).error, "password-required");
  const wrong = await post(token, { confirmPassword: "nope-nope-nope" });
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).error, "invalid-password");
  assert.equal(traktCalls, 0, "no device code is requested without the step-up");
  const ok = await post(token, { confirmPassword: PASSWORD });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).userCode, "ABCD1234");
  assert.equal(traktCalls, 1);
});

test("an SSO account must have signed in within 5 minutes", async () => {
  const stale = await post(await mint({ sessionAgeMs: 6 * 60_000 }));
  assert.equal(stale.status, 401);
  assert.equal((await stale.json()).error, "session-too-old");
  assert.equal(traktCalls, 0);
  const fresh = await post(await mint());
  assert.equal(fresh.status, 200);
});
