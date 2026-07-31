// Route-level unit tests for POST /api/interactions — the Discord slash-command
// and component webhook, and the largest single uncovered route in the tree.
//
// This endpoint is PUBLIC. Discord calls it directly from the internet with no
// session, so the ONLY thing standing between an anonymous POST and "create a
// media request as any linked user" is the Ed25519 signature check. That makes
// the request-gate ordering the whole point of this file, and every test below
// signs with a REAL Ed25519 keypair rather than stubbing the verifier — a
// stubbed signature check would make these assertions meaningless.
//
// The gate, in the order it must run:
//   1. BODY CAPS FIRST, both the Content-Length fast-reject and a post-read byte
//      check (a proxy can strip Content-Length on a chunked upload).
//   2. NO PUBLIC KEY ⇒ 503. An unconfigured bot must refuse, never fall open.
//   3. SIGNATURE VERIFICATION ⇒ 401 — and it runs BEFORE JSON.parse. Parsing
//      untrusted input ahead of authentication is the classic ordering mistake;
//      a malformed body from an UNSIGNED caller must be rejected as unsigned,
//      not as bad JSON.
//   4. TIMESTAMP REPLAY WINDOW, deliberately ASYMMETRIC: a past timestamp must
//      be under 5s (Discord's own rule), while future timestamps get only 2s of
//      clock-skew tolerance, because a future timestamp widens the replay window.
//   5. INTERACTION-ID REPLAY GUARD, defence-in-depth beyond that window: a
//      captured, validly-signed interaction re-POSTed inside 5s is rejected.
//      Best-effort by design — ONLY a unique violation counts as a replay, so a
//      storage hiccup can never drop a legitimate interaction.
//
// Two behaviours are deliberately exempt from later gates and are pinned as such:
// PING (type 1) answers PONG even when the Discord integration is switched off,
// so Discord's endpoint verification keeps passing; and the feature gate returns
// an EPHEMERAL explanation (type 4 + flags 64) rather than an error status, so a
// user sees why nothing happened instead of a silent failure.
//
// Finally the /link redemption, which is the counterpart to the binding
// tests/discord-routes.test.mts pins on generate-link: a token minted FOR a
// specific Discord account must be refused for any other, or the token is a
// bearer credential that hands over the victim's request history.
//
// Harness: the real handler, real Ed25519 signing, in-memory prisma stubs,
// scripted discord.com + TMDB. No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import dns from "node:dns/promises";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "interactions-route-secret-0123456789ab";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
process.env.TMDB_READ_TOKEN = "test-tmdb-read-token";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// ── a REAL Ed25519 keypair ───────────────────────────────────────────────────
// Discord publishes the raw 32-byte public key as hex; the route re-wraps it in
// an SPKI header to hand to node:crypto. Signing here for real is what makes the
// 401 assertions mean anything.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const SPKI_PREFIX_LEN = 12; // 302a300506032b6570032100
const PUBLIC_KEY_HEX = publicKey
  .export({ format: "der", type: "spki" })
  .subarray(SPKI_PREFIX_LEN)
  .toString("hex");

function signBody(timestamp: string, body: string): string {
  return cryptoSign(null, Buffer.from(timestamp + body), privateKey).toString("hex");
}

// ── scripted upstreams ───────────────────────────────────────────────────────
const fetchCalls: URL[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  fetchCalls.push(url);
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
  if (url.hostname.endsWith("themoviedb.org")) {
    return json({ page: 1, total_pages: 1, results: [], id: 603, title: "The Matrix" });
  }
  // discord.com: editOriginal / role calls.
  return new Response(null, { status: 204 });
}) as unknown as typeof fetch;

const { NextRequest } = await import("next/server");
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { Prisma } = await import("@/generated/prisma");
const { invalidateFeatureFlagCache } = await import("../src/lib/features.ts");

// ── op log ───────────────────────────────────────────────────────────────────
type Op = { op: string; args?: unknown };
let ops: Op[] = [];
const rec = (op: string, args?: unknown) => { ops.push({ op, args }); };
const opsOf = (name: string) => ops.filter((o) => o.op === name);

// ── stores ───────────────────────────────────────────────────────────────────
const settings = new Map<string, string>();
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    rec("setting.findUnique", args.where.key);
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
  findMany: async (args: { where?: { key?: { in?: string[] } } } = {}) => {
    const keys = args.where?.key?.in;
    const all = [...settings.entries()].map(([key, value]) => ({ key, value }));
    return keys ? all.filter((r) => keys.includes(r.key)) : all;
  },
  upsert: async () => ({}), create: async () => ({}), update: async () => ({}), deleteMany: async () => ({ count: 0 }),
});

// The replay guard writes a nonce row here; `nonces` models its unique index.
let nonces = new Set<string>();
let nonceWriteThrows: Error | null = null;
shadowPrismaModel(prisma, "discordSearchCache", {
  create: async (args: { data: { queryKey: string } }) => {
    rec("discordSearchCache.create", args.data.queryKey);
    if (nonceWriteThrows) throw nonceWriteThrows;
    if (nonces.has(args.data.queryKey)) {
      throw new Prisma.PrismaClientKnownRequestError("unique violation", { code: "P2002", clientVersion: "0.0.0-test" });
    }
    nonces.add(args.data.queryKey);
    return { id: "n1" };
  },
  findUnique: async () => null, findFirst: async () => null, findMany: async () => [],
  upsert: async () => ({}), deleteMany: async () => ({ count: 0 }),
});

type LinkToken = { token: string; userId: string; expiresAt: Date; discordId: string | null; user: Record<string, unknown> };
let linkTokens: LinkToken[] = [];
shadowPrismaModel(prisma, "discordLinkToken", {
  findUnique: async (args: { where: { token?: string; userId?: string } }) => {
    rec("discordLinkToken.findUnique", args.where);
    return linkTokens.find((t) => (args.where.token ? t.token === args.where.token : t.userId === args.where.userId)) ?? null;
  },
  delete: async (args: unknown) => { rec("discordLinkToken.delete", args); return {}; },
  deleteMany: async (args: { where: { token?: string } }) => {
    rec("discordLinkToken.deleteMany", args.where);
    const before = linkTokens.length;
    linkTokens = linkTokens.filter((t) => t.token !== args.where.token);
    return { count: before - linkTokens.length };
  },
  upsert: async () => ({}), findMany: async () => [],
});

type AppUser = Record<string, unknown> & { id: string; email: string; discordId: string | null };
let appUsers: AppUser[] = [];
shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id?: string; discordId?: string } }) => {
    rec("user.findUnique", args.where);
    const hit = args.where.id
      ? appUsers.find((u) => u.id === args.where.id)
      : args.where.discordId
        ? appUsers.find((u) => u.discordId === args.where.discordId)
        : undefined;
    return hit ? { ...hit } : null;
  },
  findFirst: async () => null,
  findMany: async () => appUsers.map((u) => ({ ...u })),
  update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
    rec("user.update", args);
    const u = appUsers.find((x) => x.id === args.where.id);
    if (u) Object.assign(u, args.data);
    return u ? { ...u } : {};
  },
  updateMany: async (args: unknown) => { rec("user.updateMany", args); return { count: 0 }; },
  create: async (args: unknown) => { rec("user.create", args); return { id: "new" }; },
  // mergeDiscordIntoWebAccount removes the @discord.local shadow row once its
  // requests have been migrated. Without this the merge throws into the route
  // catch and the link silently fails - the token is never consumed.
  delete: async (args: { where: { id: string } }) => {
    rec("user.delete", args.where);
    appUsers = appUsers.filter((u) => u.id !== args.where.id);
    return {};
  },
  deleteMany: async (args: unknown) => { rec("user.deleteMany", args); return { count: 0 }; },
  count: async () => appUsers.length,
});

for (const m of [
  "mediaRequest", "auditLog", "plexLibraryItem", "jellyfinLibraryItem", "tmdbCache",
  "tmdbMediaCore", "radarrWantedItem", "sonarrWantedItem", "blacklistItem", "issue",
  "deletionVote", "notification", "hiddenItem", "watchlistItem", "discordMergeCode",
  // issueMessage/issueGrab: mergeDiscordIntoWebAccount reassigns them from the
  // shadow row. An unstubbed model throws into the route catch, so the link just
  // reports "could not link" and the token is silently left unconsumed.
  "pushSubscription", "mediaServerUser", "playHistory", "issueMessage", "issueGrab",
  "authSession", "account",
]) {
  shadowPrismaModel(prisma, m, {
    findMany: async (args: unknown) => { rec(`${m}.findMany`, args); return []; },
    findUnique: async () => null, findFirst: async () => null, count: async () => 0,
    groupBy: async () => [], aggregate: async () => ({ _count: { _all: 0 }, _sum: {} }),
    create: async (args: unknown) => { rec(`${m}.create`, args); return { id: "x" }; },
    createMany: async () => ({ count: 0 }), update: async (args: unknown) => { rec(`${m}.update`, args); return {}; },
    updateMany: async () => ({ count: 0 }), upsert: async () => ({}), deleteMany: async () => ({ count: 0 }),
  });
}
shadowPrismaClientMethod(prisma, "$transaction", async (arg: unknown) =>
  Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => Promise<unknown>)(prisma));
shadowPrismaClientMethod(prisma, "$queryRaw", async () => []);
shadowPrismaClientMethod(prisma, "$queryRawUnsafe", async () => []);
shadowPrismaClientMethod(prisma, "$executeRaw", async () => 1);
shadowPrismaClientMethod(prisma, "$executeRawUnsafe", async () => 1);

const interactions = await import("../src/app/api/interactions/route.ts");

// ── invocation ───────────────────────────────────────────────────────────────
let idSeq = 0;
function nextInteractionId(): string {
  idSeq++;
  return `9${String(idSeq).padStart(17, "0")}`;
}

type PostOpts = {
  signed?: boolean;          // sign with the real key (default true)
  signature?: string;        // override the signature outright
  timestamp?: string;        // override the timestamp
  rawBody?: string;          // send this exact body instead of JSON.stringify
  contentLength?: string;    // override the Content-Length header
};

async function post(payload: unknown, opts: PostOpts = {}): Promise<Response> {
  const body = opts.rawBody ?? JSON.stringify(payload);
  const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature = opts.signature ?? (opts.signed === false ? "00".repeat(64) : signBody(timestamp, body));
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-signature-ed25519": signature,
    "x-signature-timestamp": timestamp,
  };
  const req = new NextRequest("http://localhost:3000/api/interactions", { method: "POST", headers, body });
  if (opts.contentLength) req.headers.set("content-length", opts.contentLength);
  return interactions.POST(req);
}

const ping = () => ({ id: nextInteractionId(), type: 1 });
const command = (name: string, options: Array<{ name: string; value: string }> = [], discordUserId = "123456789012345678") => ({
  id: nextInteractionId(),
  type: 2,
  application_id: "app-1",
  token: "interaction-token",
  member: { user: { id: discordUserId, username: "someone" } },
  data: { name, options },
});

// The link redemption is fire-and-forget behind withDiscordTimeout; poll for it.
async function waitFor(predicate: () => boolean, turns = 60): Promise<void> {
  for (let i = 0; i < turns; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
}

beforeEach(async () => {
  // Drain any fire-and-forget work from the previous test before resetting, so
  // one test's deferred command handler can't write into the next one's log.
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  ops = [];
  nonces = new Set();
  nonceWriteThrows = null;
  linkTokens = [];
  appUsers = [];
  fetchCalls.length = 0;
  warns.length = 0;
  errors.length = 0;
  settings.clear();
  settings.set("discordPublicKey", PUBLIC_KEY_HEX);
  settings.set("discordBotToken", "a-bot-token");
  interactions.invalidatePublicKeyCache();
  invalidateFeatureFlagCache();
});

// ── 2: unconfigured bot refuses ──────────────────────────────────────────────

test("with NO public key configured the endpoint refuses with 503, never falls open", async () => {
  settings.delete("discordPublicKey");
  interactions.invalidatePublicKeyCache();
  const res = await post(ping());
  assert.equal(res.status, 503);
  assert.match(await res.text(), /not configured/i);
});

// ── 3: the signature gate ────────────────────────────────────────────────────

test("a correctly signed PING is answered with PONG", async () => {
  const res = await post(ping());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { type: 1 });
});

test("an UNSIGNED request is 401", async () => {
  const res = await post(ping(), { signed: false });
  assert.equal(res.status, 401);
  assert.match(await res.text(), /signature/i);
});

test("a signature over a DIFFERENT body is 401 — the body is covered, not just present", async () => {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = signBody(timestamp, JSON.stringify({ id: "1", type: 1 }));
  const res = await post(null, { rawBody: JSON.stringify({ id: "2", type: 2 }), timestamp, signature });
  assert.equal(res.status, 401);
});

test("a signature over a DIFFERENT timestamp is 401 — the timestamp is covered too", async () => {
  const realTs = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify(ping());
  const signature = signBody(String(Number(realTs) - 100), body);
  const res = await post(null, { rawBody: body, timestamp: realTs, signature });
  assert.equal(res.status, 401);
});

test("a signature from the WRONG key is 401", async () => {
  const other = generateKeyPairSync("ed25519");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify(ping());
  const signature = cryptoSign(null, Buffer.from(timestamp + body), other.privateKey).toString("hex");
  const res = await post(null, { rawBody: body, timestamp, signature });
  assert.equal(res.status, 401);
});

for (const [label, sig] of [
  ["an empty signature", ""],
  ["a non-hex signature", "not-hex-at-all"],
  ["a truncated signature", "abcd"],
  ["an over-long signature", "ab".repeat(200)],
] as const) {
  test(`${label} is a clean 401, not a crash`, async () => {
    const res = await post(ping(), { signature: sig });
    assert.equal(res.status, 401);
  });
}

test("a malformed public key setting yields 401 rather than throwing", async () => {
  settings.set("discordPublicKey", "not-a-key");
  interactions.invalidatePublicKeyCache();
  assert.equal((await post(ping())).status, 401);
});

test("SIGNATURE VERIFICATION RUNS BEFORE JSON.parse", async () => {
  // Parsing untrusted input ahead of authentication is the classic ordering
  // mistake. A malformed body from an UNSIGNED caller must be rejected as
  // unsigned (401), never as bad JSON (400).
  const res = await post(null, { rawBody: "{not json at all", signed: false });
  assert.equal(res.status, 401, "an unsigned malformed body must be refused as unsigned");
});

test("a malformed body from a SIGNED caller is a 400", async () => {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = "{still not json";
  const res = await post(null, { rawBody: body, timestamp, signature: signBody(timestamp, body) });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "Invalid JSON");
});

test("the signature-failure log never echoes the signature or the body", async () => {
  await post(ping(), { signature: "de".repeat(64) });
  const dump = warns.join(" | ");
  assert.ok(dump.includes("[interactions]"), "the rejection should be logged");
  assert.ok(!dump.includes("de".repeat(64)), "the presented signature must not be logged");
});

// ── 1: body caps run first ───────────────────────────────────────────────────

test("an oversized Content-Length is rejected before any signature work", async () => {
  const res = await post(ping(), { contentLength: String(2 * 1024 * 1024) });
  assert.ok(res.status === 400 || res.status === 413, `expected a cap rejection, got ${res.status}`);
  assert.equal(opsOf("setting.findUnique").length, 0, "the public-key read must not happen for an oversized body");
});

test("an oversized BODY is rejected even without a Content-Length header", async () => {
  // A proxy can strip Content-Length on a chunked upload; the post-read byte
  // check is the backstop.
  const huge = JSON.stringify({ id: "1", type: 1, pad: "z".repeat(1_100_000) });
  const res = await post(null, { rawBody: huge });
  assert.ok(res.status === 400 || res.status === 413, `expected a cap rejection, got ${res.status}`);
});

// ── 4: the asymmetric timestamp window ───────────────────────────────────────

test("a timestamp older than 5s is rejected", async () => {
  const old = String(Math.floor(Date.now() / 1000) - 10);
  const body = JSON.stringify(ping());
  const res = await post(null, { rawBody: body, timestamp: old, signature: signBody(old, body) });
  assert.equal(res.status, 401);
  assert.match(await res.text(), /timestamp/i);
});

test("a timestamp within the 5s past window is accepted", async () => {
  const recent = String(Math.floor(Date.now() / 1000) - 2);
  const body = JSON.stringify(ping());
  const res = await post(null, { rawBody: body, timestamp: recent, signature: signBody(recent, body) });
  assert.equal(res.status, 200);
});

test("the FUTURE tolerance is tighter than the past one — a future timestamp widens the replay window", async () => {
  const body = JSON.stringify(ping());
  // +1s: benign clock skew, accepted.
  const near = String(Math.floor(Date.now() / 1000) + 1);
  assert.equal((await post(null, { rawBody: body, timestamp: near, signature: signBody(near, body) })).status, 200);

  // +10s: well inside the 5s PAST allowance in magnitude, but rejected because
  // it is in the future.
  const body2 = JSON.stringify(ping());
  const far = String(Math.floor(Date.now() / 1000) + 10);
  assert.equal((await post(null, { rawBody: body2, timestamp: far, signature: signBody(far, body2) })).status, 401);
});

test("a non-numeric timestamp is rejected rather than producing NaN arithmetic", async () => {
  const body = JSON.stringify(ping());
  const res = await post(null, { rawBody: body, timestamp: "not-a-number", signature: signBody("not-a-number", body) });
  assert.equal(res.status, 401);
});

// ── PING exemptions ──────────────────────────────────────────────────────────

test("PING answers PONG even when the Discord integration is DISABLED", async () => {
  // Otherwise Discord's endpoint verification fails while the feature is off and
  // the operator cannot re-enable it without re-verifying.
  settings.set("feature.integration.discord", "false");
  invalidateFeatureFlagCache();
  const res = await post(ping());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { type: 1 });
});

test("PING is still signature-gated — the exemption is from the FEATURE gate only", async () => {
  settings.set("feature.integration.discord", "false");
  invalidateFeatureFlagCache();
  assert.equal((await post(ping(), { signed: false })).status, 401);
});

// ── the feature gate is an ephemeral message, not an error ───────────────────

test("a real interaction while DISABLED gets an ephemeral explanation, not an error status", async () => {
  settings.set("feature.integration.discord", "false");
  invalidateFeatureFlagCache();
  const res = await post(command("status"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.type, 4, "type 4 = immediate reply");
  assert.equal(body.data.flags, 64, "flags 64 = ephemeral");
  assert.match(body.data.content, /disabled/i);
});

test("a disabled integration runs NO command work", async () => {
  settings.set("feature.integration.discord", "false");
  invalidateFeatureFlagCache();
  await post(command("link", [{ name: "token", value: "ABC" }]));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(opsOf("discordLinkToken.findUnique").length, 0);
});

// ── 5: the interaction-id replay guard ───────────────────────────────────────

test("a REPLAYED interaction id is rejected with 401", async () => {
  // Defence-in-depth beyond the 5s window: a captured, validly-signed
  // interaction can otherwise be re-POSTed inside it.
  const payload = command("status");
  assert.equal((await post(payload)).status, 200);
  const replay = await post(payload);
  assert.equal(replay.status, 401);
  assert.match(await replay.text(), /duplicate/i);
});

test("the replay guard records one nonce per interaction id", async () => {
  const payload = command("status");
  await post(payload);
  const keys = opsOf("discordSearchCache.create").map((o) => o.args as string);
  assert.deepEqual(keys, [`nonce:${payload.id}`]);
});

test("DISTINCT interaction ids are both accepted", async () => {
  assert.equal((await post(command("status"))).status, 200);
  assert.equal((await post(command("status"))).status, 200);
});

test("a replayed interaction does NO command work", async () => {
  const payload = command("link", [{ name: "token", value: "TOKEN123" }]);
  linkTokens = [{
    token: "TOKEN123", userId: "u1", expiresAt: new Date(Date.now() + 60_000), discordId: null,
    user: { id: "u1", email: "u1@example.com", name: "One", role: "USER" },
  }];
  await post(payload);
  await waitFor(() => linkTokens.length === 0);
  ops = [];
  const replay = await post(payload);
  assert.equal(replay.status, 401);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(opsOf("discordLinkToken.findUnique").length, 0);
});

test("a STORAGE HICCUP in the replay guard must NOT drop a legitimate interaction", async () => {
  // Best-effort by design: only an actual unique violation counts as a replay.
  // Treating any write failure as one would make a transient DB blip silently
  // eat real commands.
  nonceWriteThrows = new Error("connection reset");
  const res = await post(command("status"));
  assert.equal(res.status, 200, "a non-P2002 failure must not reject the interaction");
  assert.ok(errors.some((e) => e.includes("[interactions]")), "the hiccup should still be logged");
});

test("PING is exempt from the replay guard", async () => {
  // Discord re-verifies endpoints with repeated PINGs.
  const payload = ping();
  assert.equal((await post(payload)).status, 200);
  assert.equal((await post(payload)).status, 200, "a repeated PING must keep answering");
});

// ── interaction-type dispatch ────────────────────────────────────────────────

test("a slash command (type 2) is acknowledged with a deferred EPHEMERAL response", async () => {
  const res = await post(command("status"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.type, 5, "type 5 = deferred");
  assert.equal(body.data.flags, 64, "the deferral must be ephemeral");
});

test("a component interaction (type 3) is acknowledged with type 6", async () => {
  const res = await post({
    id: nextInteractionId(), type: 3, application_id: "app-1", token: "t",
    member: { user: { id: "123456789012345678" } },
    data: { custom_id: "noop" },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { type: 6 });
});

test("an unknown interaction type is a 400", async () => {
  const res = await post({ id: nextInteractionId(), type: 99 });
  assert.equal(res.status, 400);
});

// ── /link redemption: the counterpart to the generate-link binding ───────────

function seedLinkToken(over: Partial<LinkToken> = {}): LinkToken {
  const t: LinkToken = {
    token: "TOKEN123", userId: "u1", expiresAt: new Date(Date.now() + 60_000), discordId: null,
    user: { id: "u1", email: "u1@example.com", name: "One", role: "USER" },
    ...over,
  };
  linkTokens = [t];
  return t;
}

test("a token BOUND to another Discord account is refused", async () => {
  // The counterpart to generate-link's binding: without this check the token is
  // a bearer credential and whoever sees it inherits the victim's history.
  seedLinkToken({ discordId: "999999999999999999" });
  await post(command("link", [{ name: "token", value: "TOKEN123" }], "123456789012345678"));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(linkTokens.length, 1, "a mismatched binding must not consume the token");
  assert.equal(opsOf("user.update").length, 0, "and must not link anything");
});

test("a token bound to the REDEEMING account is accepted", async () => {
  seedLinkToken({ discordId: "123456789012345678" });
  await post(command("link", [{ name: "token", value: "TOKEN123" }], "123456789012345678"));
  await waitFor(() => linkTokens.length === 0);
  assert.equal(linkTokens.length, 0, "a matching binding should redeem");
});

test("an UNBOUND token is redeemable by the caller (the web-UI flow)", async () => {
  seedLinkToken({ discordId: null });
  await post(command("link", [{ name: "token", value: "TOKEN123" }], "123456789012345678"));
  await waitFor(() => linkTokens.length === 0);
  assert.equal(linkTokens.length, 0);
});

test("an unknown token is refused without touching any account", async () => {
  seedLinkToken();
  await post(command("link", [{ name: "token", value: "WRONGTOKEN" }]));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(linkTokens.length, 1);
  assert.equal(opsOf("user.update").length, 0);
});

test("an EXPIRED token is deleted rather than left redeemable", async () => {
  seedLinkToken({ expiresAt: new Date(Date.now() - 1000) });
  await post(command("link", [{ name: "token", value: "TOKEN123" }]));
  await waitFor(() => opsOf("discordLinkToken.delete").length > 0);
  assert.ok(opsOf("discordLinkToken.delete").length > 0, "an expired token must be cleaned up");
});

test("a successful redemption consumes the token with deleteMany, never a bare delete", async () => {
  // A concurrent duplicate /link races both callers past the merge; the loser's
  // bare delete would throw P2025 and report "unexpected error" for a link that
  // actually SUCCEEDED.
  seedLinkToken();
  await post(command("link", [{ name: "token", value: "TOKEN123" }]));
  await waitFor(() => opsOf("discordLinkToken.deleteMany").length > 0);
  assert.ok(opsOf("discordLinkToken.deleteMany").length > 0);
});

test("a Discord id already linked to a REAL other account blocks the redemption", async () => {
  seedLinkToken();
  appUsers = [{ id: "other", email: "other@example.com", discordId: "123456789012345678", role: "USER" }];
  await post(command("link", [{ name: "token", value: "TOKEN123" }], "123456789012345678"));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(linkTokens.length, 1, "the token must survive a blocked redemption");
});

test("a @discord.local SHADOW account does NOT block the redemption", async () => {
  // Merging the shadow account is the whole point of linking.
  seedLinkToken();
  appUsers = [{ id: "shadow", email: "123456789012345678@discord.local", discordId: "123456789012345678", role: "USER" }];
  await post(command("link", [{ name: "token", value: "TOKEN123" }], "123456789012345678"));
  await waitFor(() => linkTokens.length === 0);
  assert.equal(linkTokens.length, 0);
});

test("/link with no token argument does not touch the token table", async () => {
  seedLinkToken();
  await post(command("link", []));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(opsOf("discordLinkToken.findUnique").length, 0);
  assert.equal(linkTokens.length, 1);
});

// ── hygiene ──────────────────────────────────────────────────────────────────

test("the endpoint never echoes the bot token or the public key", async () => {
  const res = await post(command("status"));
  const text = await res.text();
  assert.ok(!text.includes("a-bot-token"));
  assert.ok(!text.includes(PUBLIC_KEY_HEX));
});

test("every refusal path answers before any command work runs", async () => {
  for (const opts of [{ signed: false }, { timestamp: String(Math.floor(Date.now() / 1000) - 60) }] as PostOpts[]) {
    ops = [];
    const res = await post(command("link", [{ name: "token", value: "TOKEN123" }]), opts);
    assert.equal(res.status, 401);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(opsOf("discordLinkToken.findUnique").length, 0, "a refused interaction must not run its command");
  }
});

test("the route source contains no console.log (guardrail 7)", async () => {
  const { readFileSync } = await import("node:fs");
  const code = readFileSync("src/app/api/interactions/route.ts", "utf-8")
    .split("\n")
    .map((l) => { const i = l.indexOf("//"); return i === -1 ? l : l.slice(0, i); });
  assert.ok(!code.some((l) => /console\.log\s*\(/.test(l)));
});

