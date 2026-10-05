// The outbound-channel dispatcher (src/lib/notify-agents.ts): which agents a
// given event reaches, the exact HTTP request each kind sends, the retry policy
// (5xx/network retried on a timer, 4xx and SSRF refusals never; a retry
// re-resolves the agent and a retry the shared pool refuses is the recorded final
// failure), the feature flag, outcome bookkeeping (the cache's invalidate-during-
// load race, the Test button's awaited write), and the structural rules —
// admin-entered URLs go through safeFetchAdminConfigured (guardrail 5a) and every
// "now available" path goes through the one fan-out helper.
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
// Parks the agent read mid-flight (rows already computed) so a test can
// invalidate the cache while a load is in flight.
let findManyGate: Promise<void> | null = null;
// Delays the outcome write by N macrotask rounds AFTER it is called, so a
// fire-and-forget recordOutcome is observable as "not yet written".
let updateDelayRounds = 0;
shadowPrismaModel(prisma, "notificationAgent", {
  findMany: async (args: { where?: { enabled?: boolean } }) => {
    agentReads++;
    const rows = agents.filter((a) => args.where?.enabled === undefined || a.enabled === args.where.enabled);
    if (findManyGate) await findManyGate;
    return rows;
  },
  update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
    if (updateDelayRounds > 0) await settle(updateDelayRounds);
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
// The SAME pool instance notify-agents retries through (same resolved module
// URL) — the cap tests fill it from here.
const { scheduleDelayed } = await import("../src/lib/delayed-jobs.ts");

async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

// A manually-opened latch.
function gate(): { promise: Promise<void>; open: () => void } {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, open: () => release?.() };
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
  findManyGate = null;
  updateDelayRounds = 0;
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

// ── retries re-resolve the agent ────────────────────────────────────────────
// The retry closure must not carry the LoadedAgent snapshot from attempt 0: an
// admin may disable, delete, unsubscribe or re-point the channel while a retry
// is pending, and the stale copy would keep posting to the old URL with the old
// secret, then overwrite the row's fresh status with its failure. The admin
// routes call invalidateAgentCache() after every write — the tests do the same.

test("a retry re-resolves the agent: one disabled or deleted in the meantime is neither fetched nor recorded", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    for (const withdraw of ["disabled", "deleted", "unsubscribed"] as const) {
      calls.length = 0;
      updates.length = 0;
      warns.length = 0;
      respond = () => new Response("down", { status: 503 });
      agents = [{ id: "a", kind: "webhook", name: "hook", enabled: true, events: ["request.available"], config: { url: "https://a.example/" }, secret: null }];
      invalidateAgentCache();
      emitNotificationEvent(AVAILABLE);
      await settle();
      assert.equal(calls.length, 1, withdraw);
      assert.equal(updates.length, 0, withdraw);
      if (withdraw === "disabled") agents = [{ ...agents[0], enabled: false }];
      else if (withdraw === "deleted") agents = [];
      else agents = [{ ...agents[0], events: ["issue.created"] }];
      invalidateAgentCache();
      mock.timers.tick(30_000);
      await settle();
      mock.timers.tick(15 * 60_000);
      await settle();
      assert.equal(calls.length, 1, `${withdraw}: the retry posted with the stale snapshot`);
      assert.equal(updates.length, 0, `${withdraw}: the retry wrote an outcome onto a channel the admin withdrew`);
      assert.equal(warns.filter((w) => w.includes("[notify-agents]")).length, 0, withdraw);
    }
  } finally {
    mock.timers.reset();
  }
});

test("a retry delivers with the agent's CURRENT url and secret, not the snapshot from attempt 0", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    respond = (c) => (new URL(c.url).hostname === "typo.example" ? new Response("", { status: 503 }) : new Response(null, { status: 204 }));
    agents = [{ id: "a", kind: "webhook", name: "hook", enabled: true, events: ["request.available"], config: { url: "https://typo.example/" }, secret: "Bearer old" }];
    emitNotificationEvent(AVAILABLE);
    await settle();
    assert.equal(calls.length, 1);
    // The admin fixes the host and rotates the token before the 30s retry.
    agents = [{ ...agents[0], config: { url: "https://fixed.example/" }, secret: "Bearer new" }];
    invalidateAgentCache();
    mock.timers.tick(30_000);
    await settle();
    assert.equal(calls.length, 2);
    assert.equal(new URL(calls[1].url).hostname, "fixed.example");
    assert.equal(calls[1].headers.get("authorization"), "Bearer new");
    assert.deepEqual(updates.map((u) => u.data.lastStatus), ["ok"]);
  } finally {
    mock.timers.reset();
  }
});

// ── a refused retry is the recorded final failure ───────────────────────────
// The retry pool is shared with download-check and has two drop points. Either
// way nothing will deliver this event, so the row must say so (guardrail 14c:
// the last outcome is recorded on the row) instead of keeping a stale "ok".

test("a retry the pool refuses at schedule time (pending cap) is recorded as the final failure, not lost", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  let fillers = 0;
  try {
    // Fill the pending-timer cap with far-future no-ops (knob-independent: stop
    // at the first refusal). Staggered so draining them later never saturates the
    // run queue.
    while (scheduleDelayed(60_000 + fillers * 10, async () => {}, { name: `filler-${fillers}` })) {
      fillers++;
      assert.ok(fillers < 10_000, "the pending cap never engaged");
    }
    warns.length = 0;
    respond = () => new Response("down", { status: 503 });
    agents = [{ id: "a", kind: "webhook", name: "hook", enabled: true, events: ["request.available"], config: { url: "https://a.example/" }, secret: null }];
    emitNotificationEvent(AVAILABLE);
    await settle();
    assert.equal(calls.length, 1);
    assert.deepEqual(updates.map((u) => [u.data.lastStatus, u.data.lastError]), [["failed", "retry queue full: HTTP 503"]]);
    assert.ok(warns.some((w) => w.includes('[delayed-jobs] dropping "notify-agent:a"')), "the pool refused the retry");
    assert.equal(warns.filter((w) => w.includes("[notify-agents]") && w.includes("retry queue full: HTTP 503")).length, 1);
    mock.timers.tick(15 * 60_000);
    await settle();
    assert.equal(calls.length, 1, "nothing retried a refused retry");
    assert.equal(updates.length, 1);
  } finally {
    // Drain the fillers one tick at a time so pendingTimers returns to 0 for the
    // tests that follow (mock.timers.reset() would discard the timers, not the count).
    mock.timers.tick(60_000);
    for (let i = 0; i < fillers; i++) {
      mock.timers.tick(10);
      await settle(2);
    }
    mock.timers.reset();
  }
});

test("a retry the pool drops at FIRE time (queue cap) is recorded as the final failure, not lost", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const g = gate();
  let started = 0;
  let finished = 0;
  const blocker = async () => {
    started += 1;
    await g.promise;
    finished += 1;
  };
  try {
    // Occupy every worker and fill the run queue (knob-independent: stop at the
    // first fire-time drop, which means the queue is exactly full).
    let fillers = 0;
    while (!errors.some((e) => e.includes("at fire time"))) {
      assert.ok(scheduleDelayed(1, blocker, { name: `blocker-${fillers++}` }), "pending cap hit before the queue filled");
      mock.timers.tick(1);
      await settle(2);
      assert.ok(fillers < 10_000, "the queue cap never engaged");
    }
    errors.length = 0;
    respond = () => new Response("down", { status: 503 });
    agents = [{ id: "a", kind: "webhook", name: "hook", enabled: true, events: ["request.available"], config: { url: "https://a.example/" }, secret: null }];
    emitNotificationEvent(AVAILABLE);
    await settle();
    assert.equal(calls.length, 1);
    assert.equal(updates.length, 0, "accepted at schedule time — nothing recorded yet");
    mock.timers.tick(30_000);
    await settle();
    assert.equal(calls.length, 1, "a dropped retry must not fetch");
    assert.deepEqual(updates.map((u) => [u.data.lastStatus, u.data.lastError]), [["failed", "retry queue full: HTTP 503"]]);
    assert.ok(errors.some((e) => e.includes('dropping "notify-agent:a" at fire time')));
    assert.equal(warns.filter((w) => w.includes("[notify-agents]") && w.includes("retry queue full: HTTP 503")).length, 1);
    g.open();
    for (let i = 0; i < 200 && finished < started; i++) await settle(5);
    assert.equal(finished, started, "the pool did not drain");
    mock.timers.tick(15 * 60_000);
    await settle();
    assert.equal(calls.length, 1);
    assert.equal(updates.length, 1);
  } finally {
    g.open();
    mock.timers.reset();
  }
});

// ── a secret the transport rejects ──────────────────────────────────────────

test("a secret undici's Headers rejects (NUL byte) is a config failure: never fetched, never retried, and the secret never appears in the outcome or logs", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const secret = "tok\u0000en";
    // The admin route refuses control characters; this is the row an older or
    // hand-edited deployment could still hold.
    agents = [{ id: "nul", kind: "webhook", name: "nul", enabled: true, events: ["request.available"], config: { url: "https://a.example/" }, secret }];
    emitNotificationEvent(AVAILABLE);
    await settle();
    mock.timers.tick(15 * 60_000);
    await settle();
    assert.equal(calls.length, 0, "Headers rejected the value before any network call");
    assert.deepEqual(updates.map((u) => [u.data.lastStatus, u.data.lastError]), [["failed", "request could not be built (check the secret and URL)"]]);
    const leaks = (s: string) => s.includes(secret) || s.includes("invalid header value");
    assert.ok(!warns.some(leaks) && !errors.some(leaks), "the Headers TypeError (which embeds the secret) reached a log line");
    const r = await sendAgentTest(loadedAgentFromRow({ id: "nul", kind: "webhook", name: "nul", events: [], config: { url: "https://a.example/" }, secret })!, { event: "agent.test" });
    assert.equal(r.verdict, "fail");
    assert.ok(!leaks(JSON.stringify(r)), "the Test response carried the secret");
  } finally {
    mock.timers.reset();
  }
});

// ── cache + bookkeeping races ───────────────────────────────────────────────

test("invalidating the cache during an in-flight load does not repopulate it with the pre-invalidate rows", async () => {
  const g = gate();
  findManyGate = g.promise;
  agents = [{ id: "gone", kind: "webhook", name: "gone", enabled: true, events: ["request.available"], config: { url: "https://gone.example/" }, secret: null }];
  emitNotificationEvent(AVAILABLE);
  await settle();
  assert.equal(agentReads, 1, "the read is parked mid-flight");
  // The admin deletes the agent and the route invalidates while that read is in flight.
  agents = [];
  invalidateAgentCache();
  g.open();
  await settle();
  // The in-flight read already held the pre-delete rows — that one dispatch goes out (accepted).
  assert.equal(calls.length, 1);
  findManyGate = null;
  emitNotificationEvent(AVAILABLE);
  await settle();
  assert.equal(agentReads, 2, "the stale read repopulated the cache after the invalidation");
  assert.equal(calls.length, 1, "the deleted agent was served from the stale cache");
});

test("the Test button's outcome is committed before it responds (the UI reloads the list the moment it does)", async () => {
  updateDelayRounds = 3;
  respond = () => new Response(null, { status: 204 });
  const agent = loadedAgentFromRow({ id: "t", kind: "webhook", name: "t", events: [], config: { url: "https://t.example/" }, secret: null })!;
  const r = await sendAgentTest(agent, { event: "agent.test" });
  assert.equal(r.verdict, "ok");
  assert.deepEqual(updates.map((u) => [u.where.id, u.data.lastStatus]), [["t", "ok"]], "lastStatus was not yet written when sendAgentTest resolved");
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
  // The channel modules fanOutAvailableWinners itself composes. A sync route that
  // imports ANY of them (aliased or not), or emits to the outbound channels
  // itself, has re-listed a channel at the call site (guardrail 14c). Matching
  // the import side closes the alias hole a call-paren regex leaves open.
  const CHANNEL_MODULES = ["discord-notify", "push", "email", "in-app-notify", "notify-agents"];
  const hub = read("src/lib/request-notifications.ts");
  for (const m of CHANNEL_MODULES) {
    assert.match(hub, new RegExp(`from "\\./${m}"`), `the hub no longer imports ./${m} — the channel list above has rotted`);
  }
  const channelImport = new RegExp(`\\blib/(${CHANNEL_MODULES.join("|")})(\\.ts)?["']`);
  for (const p of ["src/app/api/sync/route.ts", "src/app/api/sync/plex/route.ts", "src/app/api/sync/jellyfin/route.ts"]) {
    const src = read(p);
    assert.match(src, /fanOutAvailableWinners\(/, p);
    assert.doesNotMatch(src, channelImport, `${p} imports a notification channel module directly`);
    assert.doesNotMatch(src, /emitNotificationEvents?\(/, `${p} emits to the outbound channels at the call site`);
    assert.doesNotMatch(
      src,
      /notifyUsersRequestsAvailable|notifyUserRequestAvailable|writeAvailableInAppNotifications|writeInAppNotification/,
      `${p} names a channel helper (an aliased import still has to spell it once)`,
    );
  }
  const fan = hub.slice(hub.indexOf("export async function fanOutAvailableWinners"));
  assert.match(fan.slice(0, fan.indexOf("\n}\n")), /emitNotificationEvents\(/, "the shared fan-out feeds the outbound channels");
});
