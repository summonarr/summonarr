// The outbound-channel dispatcher (src/lib/notify-agents.ts): which agents a
// given event reaches, the exact HTTP request each kind sends, the retry policy
// (5xx/network retried on a timer, 4xx and SSRF refusals never), the feature
// flag, outcome bookkeeping, and the structural rules — admin-entered URLs go
// through safeFetchAdminConfigured (guardrail 5a) and every "now available" path
// goes through the one fan-out helper.
//
// No DB, network or DNS: prisma.notificationAgent / prisma.setting are shadowed
// in memory, dns/promises.lookup is stubbed, globalThis.fetch is scripted.
import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { readFileSync } from "node:fs";

process.env.NEXTAUTH_SECRET ??= "unit-test-session-secret-0123456789abcdef";
process.env.TOKEN_ENCRYPTION_KEY ??= "ab".repeat(32);
process.env.DATABASE_URL ??= "postgresql://unit:unit@127.0.0.1:9/never_connects";
process.env.AUTH_URL = "https://summon.example";
delete process.env.BASE_PATH;
delete process.env.SUMMONARR_DEFAULT_LOCALE;

const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

const warns: string[] = [];
const errors: string[] = [];
console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };
console.error = (...a: unknown[]) => { errors.push(a.map(String).join(" ")); };

type Call = { url: string; method: string; headers: Headers; body: string };
const calls: Call[] = [];
let respond: (c: Call) => Response | Promise<Response> = () => new Response("ok", { status: 200 });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  const c: Call = { url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body: String(init?.body ?? "") };
  calls.push(c);
  return respond(c);
}) as typeof fetch;

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const { invalidateFeatureFlagCache } = await import("../src/lib/features.ts");

type AgentRow = { id: string; kind: string; name: string; enabled: boolean; events: string[]; config: unknown; secret: string | null };
let agents: AgentRow[] = [];
let agentReads = 0;
const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = [];
shadowPrismaModel(prisma, "notificationAgent", {
  findMany: async (args: { where?: { enabled?: boolean } }) => {
    agentReads++;
    return agents.filter((a) => args.where?.enabled === undefined || a.enabled === args.where.enabled);
  },
  update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
    updates.push(args);
    return { id: args.where.id };
  },
});
const settings = new Map<string, string>();
shadowPrismaModel(prisma, "setting", {
  findMany: async (args: { where: { key: { in: string[] } } }) =>
    args.where.key.in.filter((k) => settings.has(k)).map((k) => ({ key: k, value: settings.get(k)! })),
  findUnique: async (args: { where: { key: string } }) => (settings.has(args.where.key) ? { key: args.where.key, value: settings.get(args.where.key)! } : null),
});

const { emitNotificationEvent, emitNotificationEvents, invalidateAgentCache, sendAgentTest, loadedAgentFromRow } = await import("../src/lib/notify-agents.ts");

async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

const AVAILABLE = { event: "request.available" as const, media: { type: "MOVIE" as const, tmdbId: 438631, title: "Dune", posterPath: "/d.jpg" }, request: { id: "r1", instance: "" } };

beforeEach(() => {
  calls.length = 0;
  updates.length = 0;
  warns.length = 0;
  errors.length = 0;
  agentReads = 0;
  agents = [];
  settings.clear();
  respond = () => new Response("ok", { status: 200 });
  invalidateAgentCache();
  invalidateFeatureFlagCache();
});

test("webhook: one JSON POST with the auth header from the secret and the standard v1 payload", async () => {
  agents = [{ id: "a1", kind: "webhook", name: "hook", enabled: true, events: ["request.available"], config: { url: "https://hooks.example/in" }, secret: "Bearer s3cret" }];
  emitNotificationEvent(AVAILABLE);
  await settle();
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.url, "https://hooks.example/in");
  assert.equal(c.method, "POST");
  assert.equal(c.headers.get("authorization"), "Bearer s3cret");
  assert.equal(c.headers.get("content-type"), "application/json");
  const body = JSON.parse(c.body);
  assert.equal(body.version, 1);
  assert.equal(body.event, "request.available");
  assert.equal(body.title, "Now available: Dune");
  assert.equal(body.url, "https://summon.example/movie/438631");
  assert.deepEqual(body.request, { id: "r1", instance: "" });
  assert.deepEqual(updates.map((u) => u.data.lastStatus), ["ok"]);
});

test("ntfy: publishes to the server root with a Bearer token; gotify: token in X-Gotify-Key, never the URL", async () => {
  agents = [
    { id: "n1", kind: "ntfy", name: "n", enabled: true, events: ["request.available"], config: { url: "https://ntfy.example", topic: "media", priority: 4 }, secret: "tk_abc" },
    { id: "g1", kind: "gotify", name: "g", enabled: true, events: ["request.available"], config: { url: "https://gotify.example/" }, secret: "AppTok" },
  ];
  emitNotificationEvent(AVAILABLE);
  await settle();
  const ntfy = calls.find((c) => new URL(c.url).hostname === "ntfy.example")!;
  assert.match(ntfy.url, /^https:\/\/ntfy\.example\/?$/, "the server ROOT — the topic rides in the body");
  assert.equal(ntfy.headers.get("authorization"), "Bearer tk_abc");
  assert.equal(JSON.parse(ntfy.body).topic, "media");
  assert.equal(JSON.parse(ntfy.body).priority, 4);
  const gotify = calls.find((c) => new URL(c.url).hostname === "gotify.example")!;
  assert.equal(gotify.url, "https://gotify.example/message");
  assert.ok(!gotify.url.includes("AppTok"));
  assert.equal(gotify.headers.get("x-gotify-key"), "AppTok");
});

test("an event reaches only the enabled agents subscribed to it; a batch is one agent read", async () => {
  agents = [
    { id: "a", kind: "webhook", name: "a", enabled: true, events: ["request.created"], config: { url: "https://a.example/" }, secret: null },
    { id: "b", kind: "webhook", name: "b", enabled: true, events: ["request.available"], config: { url: "https://b.example/" }, secret: null },
    { id: "c", kind: "webhook", name: "c", enabled: false, events: ["request.available"], config: { url: "https://c.example/" }, secret: null },
  ];
  emitNotificationEvents([AVAILABLE, { ...AVAILABLE, request: { id: "r2", instance: "" } }]);
  await settle();
  assert.deepEqual(calls.map((c) => new URL(c.url).hostname), ["b.example", "b.example"]);
  assert.equal(agentReads, 1);
  assert.equal(calls[0].headers.get("authorization"), null, "no secret ⇒ no auth header");
});

test("a custom webhook template replaces the body and escapes user text", async () => {
  agents = [{ id: "t", kind: "webhook", name: "t", enabled: true, events: ["issue.reply"], config: { url: "https://t.example/", template: "{\"content\": \"{{actor.name}} said {{text}}\"}" }, secret: null }];
  emitNotificationEvent({ event: "issue.reply", actor: { name: "bo\"b" }, text: "line1\nline2", issue: { id: "i1" } });
  await settle();
  assert.deepEqual(JSON.parse(calls[0].body), { content: "bo\"b said line1\nline2" });
});

test("feature flag off ⇒ nothing is read and nothing is sent", async () => {
  settings.set("feature.integration.webhooks", "false");
  agents = [{ id: "a", kind: "webhook", name: "a", enabled: true, events: ["request.available"], config: { url: "https://a.example/" }, secret: null }];
  emitNotificationEvent(AVAILABLE);
  await settle();
  assert.equal(calls.length, 0);
  assert.equal(agentReads, 0);
});

test("a stored config that no longer validates is skipped, not sent", async () => {
  agents = [{ id: "bad", kind: "ntfy", name: "bad", enabled: true, events: ["request.available"], config: { url: "https://n.example/", topic: "has space" }, secret: null }];
  emitNotificationEvent(AVAILABLE);
  await settle();
  assert.equal(calls.length, 0);
});

test("a 4xx is a config error: recorded as failed, warned once, never retried", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    respond = () => new Response("nope", { status: 401 });
    agents = [{ id: "a", kind: "webhook", name: "hook", enabled: true, events: ["request.available"], config: { url: "https://a.example/" }, secret: null }];
    emitNotificationEvent(AVAILABLE);
    await settle();
    mock.timers.tick(15 * 60_000);
    await settle();
    assert.equal(calls.length, 1);
    assert.deepEqual(updates.map((u) => [u.data.lastStatus, u.data.lastError]), [["failed", "HTTP 401"]]);
    assert.equal(warns.filter((w) => w.includes("[notify-agents]")).length, 1);
  } finally {
    mock.timers.reset();
  }
});

test("a 5xx is retried at 30s / 2m / 10m, then given up and recorded once", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    respond = () => new Response("down", { status: 503 });
    agents = [{ id: "a", kind: "webhook", name: "hook", enabled: true, events: ["request.available"], config: { url: "https://a.example/" }, secret: null }];
    emitNotificationEvent(AVAILABLE);
    await settle();
    assert.equal(calls.length, 1);
    assert.equal(updates.length, 0, "nothing recorded while a retry is pending");
    mock.timers.tick(29_999);
    await settle();
    assert.equal(calls.length, 1, "not before 30s");
    mock.timers.tick(1);
    await settle();
    assert.equal(calls.length, 2);
    mock.timers.tick(120_000);
    await settle();
    assert.equal(calls.length, 3);
    mock.timers.tick(600_000);
    await settle();
    assert.equal(calls.length, 4);
    mock.timers.tick(3_600_000);
    await settle();
    assert.equal(calls.length, 4, "three retries, then stop");
    assert.deepEqual(updates.map((u) => u.data.lastStatus), ["failed"]);
  } finally {
    mock.timers.reset();
  }
});

test("a retry that succeeds is recorded as ok", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let n = 0;
    respond = () => (n++ === 0 ? new Response("", { status: 502 }) : new Response(null, { status: 204 }));
    agents = [{ id: "a", kind: "webhook", name: "hook", enabled: true, events: ["request.available"], config: { url: "https://a.example/" }, secret: null }];
    emitNotificationEvent(AVAILABLE);
    await settle();
    mock.timers.tick(30_000);
    await settle();
    assert.equal(calls.length, 2);
    assert.deepEqual(updates.map((u) => u.data.lastStatus), ["ok"]);
  } finally {
    mock.timers.reset();
  }
});

test("an SSRF refusal (cloud metadata address) is never fetched and never retried", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    agents = [{ id: "m", kind: "webhook", name: "meta", enabled: true, events: ["request.available"], config: { url: "http://169.254.169.254/latest" }, secret: null }];
    emitNotificationEvent(AVAILABLE);
    await settle();
    mock.timers.tick(15 * 60_000);
    await settle();
    assert.equal(calls.length, 0);
    assert.deepEqual(updates.map((u) => u.data.lastStatus), ["failed"]);
  } finally {
    mock.timers.reset();
  }
});

test("a LAN address is allowed (admin-configured policy, not the user-URL policy)", async () => {
  (dns as { lookup: unknown }).lookup = async () => [{ address: "192.168.1.20", family: 4 }];
  try {
    agents = [{ id: "l", kind: "ntfy", name: "lan", enabled: true, events: ["request.available"], config: { url: "http://ntfy.lan:8080", topic: "t" }, secret: null }];
    emitNotificationEvent(AVAILABLE);
    await settle();
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /^http:\/\/(ntfy\.lan|192\.168\.1\.20):8080\/?$/);
  } finally {
    (dns as { lookup: unknown }).lookup = fakeLookup;
  }
});

test("the Test button sends one immediate attempt even for a disabled agent and reports the status", async () => {
  respond = () => new Response("", { status: 500 });
  const agent = loadedAgentFromRow({ id: "x", kind: "webhook", name: "x", events: [], config: { url: "https://x.example/" }, secret: null })!;
  const r = await sendAgentTest(agent, { event: "agent.test" });
  assert.deepEqual(r, { verdict: "retry", status: 500, error: "HTTP 500" });
  assert.equal(calls.length, 1, "no retry for a test");
  assert.equal(JSON.parse(calls[0].body).title, "Test notification");
});

test("a dispatch failure never throws into the caller", async () => {
  shadowPrismaModel(prisma, "notificationAgent", { findMany: async () => { throw new Error("db down"); }, update: async () => ({}) });
  assert.doesNotThrow(() => emitNotificationEvent(AVAILABLE));
  await settle();
  assert.ok(errors.some((e) => e.includes("[notify-agents] dispatch failed") && e.includes("db down")));
});

// ── structural pins ─────────────────────────────────────────────────────────

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("guardrail 5a: channel URLs are admin-entered ⇒ safeFetchAdminConfigured, never a bare fetch or the user-URL helper", () => {
  const src = read("src/lib/notify-agents.ts");
  assert.match(src, /safeFetchAdminConfigured\(url,/);
  assert.doesNotMatch(src, /(?<![.\w])fetch\(/);
  assert.doesNotMatch(src, /safeFetch\(|safeFetchTrusted\(/);
});

test("guardrail 7a: nothing on the channel path pre-encrypts the secret", () => {
  for (const p of [
    "src/lib/notify-agents.ts",
    "src/lib/notify-agents-admin.ts",
    "src/app/api/admin/notification-agents/route.ts",
    "src/app/api/admin/notification-agents/[id]/route.ts",
    "src/app/api/admin/notification-agents/[id]/test/route.ts",
  ]) assert.doesNotMatch(read(p), /encryptToken/, p);
});

test("every 'now available' sync path goes through fanOutAvailableWinners — no per-site channel list", () => {
  for (const p of ["src/app/api/sync/route.ts", "src/app/api/sync/plex/route.ts", "src/app/api/sync/jellyfin/route.ts"]) {
    const src = read(p);
    assert.match(src, /fanOutAvailableWinners\(/, p);
    assert.doesNotMatch(src, /notifyUsersRequestsAvailable(Push|Email)?\(|writeAvailableInAppNotifications\(/, `${p} re-lists the channels instead of using the shared fan-out`);
  }
  const hub = read("src/lib/request-notifications.ts");
  const fan = hub.slice(hub.indexOf("export async function fanOutAvailableWinners"));
  assert.match(fan.slice(0, fan.indexOf("\n}\n")), /emitNotificationEvents\(/, "the shared fan-out feeds the outbound channels");
});
