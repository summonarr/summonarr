// Route-level unit tests for the outbound notification channel admin API
// (src/app/api/admin/notification-agents/**): list/create, update/delete and the
// Test button, invoked directly with constructed NextRequests + a REAL signed
// admin session over an in-memory prisma fake (the admin-routes.test.mts idiom).
//
// Division of labour (owned elsewhere, NOT re-pinned here):
//   - tests/notify-agents-admin.test.mts OWNS parseAgentInput (kind fixed at
//     creation, secret tri-state, Gotify token), toPublicAgent, and the
//     guardrail-7a Prisma-extension coverage of NotificationAgent.secret. Here we
//     pin that the ROUTES send every success body through toPublicAgent and hand
//     the extension PLAINTEXT (never a pre-encrypted value).
//   - tests/notify-agents.test.mts OWNS deliverOnce + the retry policy. Here we
//     pin only the test ROUTE's wiring: a disabled channel still sends, the
//     per-admin limit answers 429, a stored config that no longer validates is 400.
//   - tests/api-auth.test.mts OWNS the withAdmin matrix; spot-checked here.
//
// The pins:
//   - Every success body (GET list, POST 201, PATCH 200) carries `hasSecret` and
//     NEVER a `secret` key or the plaintext. The fake hands the route whole rows
//     (secret included, `select` ignored), so stripping is the route's job alone.
//   - PATCH { enabled } alone leaves the stored secret untouched — no `secret`
//     key in the updateMany data.
//   - PATCH / DELETE / test on an unknown id → 404, no mutation, no audit.
//   - Guardrail 26: the SETTINGS_CHANGE audit is written AFTER the mutation,
//     through the swallowing logAudit — an auditLog.create that throws leaves the
//     201/200 intact and logs the swallow line.
//   - The audit details name the DESTINATION (url; webhook headerName +
//     hasTemplate; ntfy topic) and never the secret.
//   - The test route ignores enabled=false, is rate-limited 10/min per admin,
//     400s a stored config that no longer validates, and the OpenAPI spec
//     documents that 400.
//
// No DB, no network, no DNS: globalThis.prisma is a recording fake seeded BEFORE
// the module graph loads, fetch is scripted per test, and the channel URLs are
// RFC1918 IP literals so safeFetchAdminConfigured's SSRF stack short-circuits on
// isIP with no lookup. Sessions are REAL jose JWTs over in-memory User/AuthSession
// rows; claims mirror the rows so the privilege-rotation path never fires, and
// the bearer transport skips the UA-fingerprint check + Set-Cookie.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto at load
process.env.NEXTAUTH_SECRET = "notification-agents-routes-test-secret-0123456789";
process.env.AUTH_URL = "http://localhost:3000"; // unprefixed cookie name + trusted origin + payload siteUrl
process.env.TRUST_PROXY = "true"; // silence rate-limit's module-load warning
// English instance default ⇒ titleResolver is a no-op (guardrail 40a): no DB read.
delete process.env.SUMMONARR_DEFAULT_LOCALE;

// ── console capture (guardrail 7: warn/error only; the audit swallow logs on error) ─
const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// ── scripted fetch (the test route only) ────────────────────────────────────
type FetchCall = { url: URL; method: string; headers: Record<string, string>; body: string | null };
const fetchCalls: FetchCall[] = [];
let respond: (call: FetchCall) => Response | Promise<Response> = (call) => {
  throw new Error(`unexpected fetch ${call.url} — script a responder for this test`);
};
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
  const call: FetchCall = {
    url: new URL(String(input)),
    method: init?.method ?? "GET",
    headers,
    body: typeof init?.body === "string" ? init.body : null,
  };
  fetchCalls.push(call);
  return respond(call);
}) as typeof fetch;

const okJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// ── recording fake prisma (seeded on globalThis before the module graph) ─────
type DbUser = {
  id: string; role: string; permissions: bigint; name: string | null; email: string | null;
  mediaServer: string | null; notificationEmail: string | null;
  sessionsRevokedAt: Date | null; passwordChangedAt: Date | null; deactivatedAt: Date | null;
  purgedAt: Date | null;
};
const usersById = new Map<string, DbUser>();
const authSessionsById = new Map<string, { userId: string }>();

type AgentRow = {
  id: string; kind: string; name: string; enabled: boolean; events: string[]; config: unknown;
  secret: string | null; lastStatus: string | null; lastError: string | null; lastAttemptAt: Date | null;
  createdAt: Date;
};
const agentsById = new Map<string, AgentRow>();
let agentSeq = 0;

// Every prisma op the routes issue, in call order — the guardrail-26 ordering
// surface (mutation BEFORE auditLog.create) and the "nothing touched" checks.
const ops: Array<{ op: string; args?: unknown }> = [];
let auditThrows = false;
const auditAttempts: Array<Record<string, unknown>> = [];
const auditRows: Array<Record<string, unknown>> = [];

const fakePrisma = {
  user: {
    findUnique: async (args: { where: { id: string } }) => {
      const u = usersById.get(args.where.id);
      return u ? { ...u } : null;
    },
    update: async () => ({}),
  },
  authSession: {
    findUnique: async (args: { where: { sessionId: string } }) =>
      authSessionsById.has(args.where.sessionId)
        ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId }
        : null,
    update: async () => ({}), // lastSeenAt fire-and-forget touch
  },
  setting: {
    findUnique: async () => null,
    findMany: async () => [],
  },
  notificationAgent: {
    // `select` is deliberately ignored everywhere: the route gets the WHOLE row,
    // secret included, so a body that leaks it can only be the route's doing.
    findMany: async (args?: unknown) => {
      ops.push({ op: "notificationAgent.findMany", args });
      return [...agentsById.values()]
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((r) => ({ ...r }));
    },
    count: async () => agentsById.size,
    create: async (args: { data: Record<string, unknown> }) => {
      ops.push({ op: "notificationAgent.create", args });
      agentSeq++;
      const row: AgentRow = {
        id: `agent-${agentSeq}`,
        kind: String(args.data.kind),
        name: String(args.data.name),
        enabled: Boolean(args.data.enabled),
        events: args.data.events as string[],
        config: args.data.config,
        secret: (args.data.secret as string | null | undefined) ?? null,
        lastStatus: null, lastError: null, lastAttemptAt: null,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, agentSeq)),
      };
      agentsById.set(row.id, row);
      return { ...row };
    },
    findUnique: async (args: { where: { id: string } }) => {
      const r = agentsById.get(args.where.id);
      return r ? { ...r } : null;
    },
    updateMany: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      ops.push({ op: "notificationAgent.updateMany", args });
      const row = agentsById.get(args.where.id);
      if (!row) return { count: 0 };
      Object.assign(row, args.data);
      return { count: 1 };
    },
    deleteMany: async (args: { where: { id: string } }) => {
      ops.push({ op: "notificationAgent.deleteMany", args });
      return { count: agentsById.delete(args.where.id) ? 1 : 0 };
    },
    // recordOutcome's bookkeeping write (awaited by sendAgentTest).
    update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      ops.push({ op: "notificationAgent.update", args });
      const row = agentsById.get(args.where.id);
      if (!row) throw new Error("P2025 (unit test)");
      Object.assign(row, args.data);
      return { id: row.id };
    },
  },
  auditLog: {
    create: async (args: { data: Record<string, unknown> }) => {
      ops.push({ op: "auditLog.create", args: args.data });
      auditAttempts.push(args.data);
      if (auditThrows) throw new Error("audit insert exploded (unit test)");
      auditRows.push(args.data);
      return args.data;
    },
  },
};
(globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;

// ── dynamic imports (env + globalThis stubs must precede the module graph) ───
const { NextRequest } = await import("next/server");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { AGENT_BODY_CAP, MAX_AGENTS } = await import("../src/lib/notify-agents-admin.ts");
const { GET: listAgents, POST: createAgent } = await import("../src/app/api/admin/notification-agents/route.ts");
const { PATCH: patchAgent, DELETE: deleteAgent } = await import("../src/app/api/admin/notification-agents/[id]/route.ts");
const { POST: testAgent } = await import("../src/app/api/admin/notification-agents/[id]/test/route.ts");
const { GET: openapiGet } = await import("../src/app/api/openapi/route.ts");

type Req = InstanceType<typeof NextRequest>;
type Ctx = { params: Promise<{ id: string }> };

const BASE = "http://localhost:3000/api/admin/notification-agents";
// RFC1918 literals ⇒ admin SSRF mode, isIP short-circuit, no DNS.
const HOOK_URL = "http://10.88.0.5:8080/hook";
const NTFY_URL = "http://10.88.0.6:2586/"; // validateAgentUrl's URL.toString() keeps the root slash
const SECRET = "hunter2-token-plaintext";

// ── fixtures ────────────────────────────────────────────────────────────────
let seq = 0;

// Mint a real signed session JWT backed by an in-memory User + AuthSession row.
async function mintSession(role: string): Promise<{ userId: string; header: Record<string, string> }> {
  seq++;
  const userId = `actor-${seq}`;
  const sessionId = `actor-sess-${seq}`;
  usersById.set(userId, {
    id: userId, role, permissions: 0n, name: `Actor ${seq}`, email: "admin@example.com",
    mediaServer: null, notificationEmail: null,
    sessionsRevokedAt: null, passwordChangedAt: null, deactivatedAt: null, purgedAt: null,
  });
  authSessionsById.set(sessionId, { userId });
  const token = await signSessionJwt(
    { id: userId, role, permissions: "0", provider: "credentials", sessionId, expiresAt: Math.floor(Date.now() / 1000) + 86_400 },
    { expiresInSeconds: 7_200 },
  );
  return { userId, header: { authorization: `Bearer ${token}` } };
}

function seedAgent(over: Partial<AgentRow> = {}): AgentRow {
  agentSeq++;
  const row: AgentRow = {
    id: `agent-${agentSeq}`, kind: "webhook", name: `Hook ${agentSeq}`, enabled: true,
    events: ["request.created"], config: { url: HOOK_URL, headerName: "Authorization", template: null },
    secret: null, lastStatus: null, lastError: null, lastAttemptAt: null,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, agentSeq)),
    ...over,
  };
  agentsById.set(row.id, row);
  return row;
}

function req(url: string, opts: { method: string; headers?: Record<string, string>; body?: unknown } = { method: "GET" }): Req {
  const hasBody = opts.body !== undefined;
  return new NextRequest(url, {
    method: opts.method,
    headers: { ...(hasBody ? { "content-type": "application/json" } : {}), ...(opts.headers ?? {}) },
    ...(hasBody ? { body: typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body) } : {}),
  });
}
const ctxFor = (id: string): Ctx => ({ params: Promise.resolve({ id }) });

// Drain the microtask/macrotask queue so a `void logAudit(...)` fire-and-forget
// settles before we read auditRows / the swallow log.
const flush = () => new Promise((r) => setTimeout(r, 5));

const SWALLOW = "[audit] Failed to write audit log:";
const sawSwallow = () => errors.some((e) => e.includes(SWALLOW));
const opIndex = (op: string) => ops.findIndex((o) => o.op === op);
const detailsOf = (row: Record<string, unknown>) => JSON.parse(row.details as string) as Record<string, unknown>;

type PublicAgent = {
  id: string; kind: string; name: string; enabled: boolean; events: string[];
  config: Record<string, unknown>; hasSecret: boolean; lastStatus: string | null;
};
// The wire-shape pin, applied to every success body: hasSecret present, the
// secret absent as a KEY and as a VALUE.
function assertPublicShape(agent: Record<string, unknown>, text: string) {
  assert.equal(typeof agent.hasSecret, "boolean", "every agent body carries hasSecret");
  assert.ok(!("secret" in agent), "the secret must never be a key on the wire");
  assert.ok(!text.includes(SECRET), "the plaintext secret must never appear anywhere in a response");
}

const WEBHOOK_BODY = { kind: "webhook", name: "Ops hook", events: ["request.created", "issue.created"], config: { url: HOOK_URL }, secret: SECRET };

beforeEach(() => {
  ops.length = 0;
  agentsById.clear();
  auditThrows = false;
  auditAttempts.length = 0;
  auditRows.length = 0;
  fetchCalls.length = 0;
  warns.length = 0;
  errors.length = 0;
  respond = (call) => { throw new Error(`unexpected fetch ${call.url}`); };
});

// ════════════════════════════════════════════════════════════════════════════
// Authorization fronting (guardrail 6a) — spot-checked, not re-enumerated
// ════════════════════════════════════════════════════════════════════════════

test("every handler is fronted by withAdmin: anonymous → 401, a plain USER → 403, nothing is read or written", async () => {
  const a = seedAgent({ secret: SECRET });
  const user = await mintSession("USER");
  const calls: Array<[string, (h?: Record<string, string>) => Promise<Response>]> = [
    ["GET list", (h) => listAgents(req(BASE, { method: "GET", headers: h }), undefined)],
    ["POST create", (h) => createAgent(req(BASE, { method: "POST", headers: h, body: WEBHOOK_BODY }), undefined)],
    ["PATCH", (h) => patchAgent(req(`${BASE}/${a.id}`, { method: "PATCH", headers: h, body: { enabled: false } }), ctxFor(a.id))],
    ["DELETE", (h) => deleteAgent(req(`${BASE}/${a.id}`, { method: "DELETE", headers: h }), ctxFor(a.id))],
    ["POST test", (h) => testAgent(req(`${BASE}/${a.id}/test`, { method: "POST", headers: h }), ctxFor(a.id))],
  ];
  for (const [label, call] of calls) {
    const anon = await call();
    assert.equal(anon.status, 401, `${label}: no session must be 401`);
    assert.deepEqual(await anon.json(), { error: "Unauthorized" });
    const forbidden = await call(user.header);
    assert.equal(forbidden.status, 403, `${label}: a USER must be 403`);
    assert.deepEqual(await forbidden.json(), { error: "Forbidden" });
  }
  assert.deepEqual(ops.filter((o) => o.op.startsWith("notificationAgent.") || o.op === "auditLog.create"), [], "the handler bodies must not run");
  assert.equal(fetchCalls.length, 0);
  assert.equal(agentsById.get(a.id)?.enabled, true);
});

// ════════════════════════════════════════════════════════════════════════════
// The wire shape — hasSecret always, the secret never
// ════════════════════════════════════════════════════════════════════════════

test("GET: every row ships hasSecret (true/false) and never the secret key or its plaintext", async () => {
  const admin = await mintSession("ADMIN");
  const withSecret = seedAgent({ secret: SECRET, lastStatus: "ok" });
  const without = seedAgent({ kind: "ntfy", config: { url: NTFY_URL, topic: "alerts", priority: 3, attachPoster: false } });
  const res = await listAgents(req(BASE, { method: "GET", headers: admin.header }), undefined);
  assert.equal(res.status, 200);
  const text = await res.text();
  const body = JSON.parse(text) as { agents: PublicAgent[] };
  assert.equal(body.agents.length, 2);
  for (const agent of body.agents) assertPublicShape(agent as unknown as Record<string, unknown>, text);
  const byId = new Map(body.agents.map((x) => [x.id, x]));
  assert.equal(byId.get(withSecret.id)?.hasSecret, true);
  assert.equal(byId.get(withSecret.id)?.lastStatus, "ok");
  assert.equal(byId.get(without.id)?.hasSecret, false);
  assert.deepEqual(byId.get(without.id)?.config, { url: NTFY_URL, topic: "alerts", priority: 3, attachPoster: false }, "the (non-secret) config is the admin's to read back");
});

test("POST: 201 in the public shape; the row stores the PLAINTEXT secret for the extension to encrypt (guardrail 7a); the audit lands AFTER the create, names the destination, never the secret", async () => {
  const admin = await mintSession("ADMIN");
  const res = await createAgent(req(BASE, { method: "POST", headers: admin.header, body: WEBHOOK_BODY }), undefined);
  assert.equal(res.status, 201);
  const text = await res.text();
  const { agent } = JSON.parse(text) as { agent: PublicAgent };
  assertPublicShape(agent as unknown as Record<string, unknown>, text);
  assert.equal(agent.hasSecret, true);
  assert.equal(agent.kind, "webhook");
  assert.deepEqual(agent.events, ["issue.created", "request.created"].sort((x, y) => (x === "request.created" ? -1 : y === "request.created" ? 1 : 0)), "events come back in catalog order");
  assert.deepEqual(agent.config, { url: HOOK_URL, template: null, headerName: "Authorization" });

  // Guardrail 7a: the route hands the extension plaintext; a pre-encrypted value
  // here would be double-wrapped (`enc:v1:<enc:v1:…>`) and fail auth upstream.
  const stored = agentsById.get(agent.id);
  assert.ok(stored, "the row was created");
  assert.equal(stored.secret, SECRET, "the route must store the plaintext secret — the Prisma extension is the sole encryptor");

  await flush();
  assert.equal(auditRows.length, 1, "exactly one SETTINGS_CHANGE row");
  assert.equal(auditRows[0].action, "SETTINGS_CHANGE");
  assert.equal(auditRows[0].target, `notification-agent:${agent.id}`);
  assert.ok(opIndex("notificationAgent.create") < opIndex("auditLog.create"), "guardrail 26: the audit is written AFTER the create has committed");
  const details = detailsOf(auditRows[0]);
  assert.equal(details.op, "create");
  assert.equal(details.kind, "webhook");
  assert.equal(details.url, HOOK_URL, "the audit names WHERE events go — a re-pointed channel must be readable after the fact");
  assert.equal(details.headerName, "Authorization");
  assert.equal(details.hasTemplate, false);
  assert.ok(!("secret" in details), "the audit details must never carry a secret key");
  assert.ok(!JSON.stringify(auditRows[0]).includes(SECRET), "the plaintext secret must never reach the audit row");
});

test("POST: a webhook template audits hasTemplate=true and an ntfy channel audits its topic — still no secret", async () => {
  const admin = await mintSession("ADMIN");
  const hook = await createAgent(req(BASE, {
    method: "POST", headers: admin.header,
    body: { ...WEBHOOK_BODY, config: { url: HOOK_URL, headerName: "X-Hook-Key", template: '{ "t": "{{title}}" }' } },
  }), undefined);
  assert.equal(hook.status, 201);
  const ntfy = await createAgent(req(BASE, {
    method: "POST", headers: admin.header,
    body: { kind: "ntfy", name: "Phone", events: ["request.available"], config: { url: NTFY_URL, topic: "alerts", priority: 4 }, secret: SECRET },
  }), undefined);
  assert.equal(ntfy.status, 201);
  const ntfyText = await ntfy.text();
  assertPublicShape((JSON.parse(ntfyText) as { agent: Record<string, unknown> }).agent, ntfyText);
  await flush();
  assert.equal(auditRows.length, 2);
  const hookDetails = detailsOf(auditRows[0]);
  assert.equal(hookDetails.headerName, "X-Hook-Key");
  assert.equal(hookDetails.hasTemplate, true);
  assert.ok(!("template" in hookDetails), "the template body itself is config, not audit detail");
  const ntfyDetails = detailsOf(auditRows[1]);
  assert.equal(ntfyDetails.url, NTFY_URL);
  assert.equal(ntfyDetails.topic, "alerts");
  assert.ok(!("headerName" in ntfyDetails) && !("hasTemplate" in ntfyDetails), "webhook-only fields stay off an ntfy row");
  for (const row of auditRows) {
    assert.ok(!("secret" in detailsOf(row)));
    assert.ok(!JSON.stringify(row).includes(SECRET));
  }
});

test("POST: invalid input → 400 with the translated reason and nothing written or audited", async () => {
  const admin = await mintSession("ADMIN");
  const res = await createAgent(req(BASE, { method: "POST", headers: admin.header, body: { ...WEBHOOK_BODY, kind: "slack" } }), undefined);
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "Choose a channel type: webhook, ntfy or Gotify." });
  assert.equal(agentsById.size, 0);
  await flush();
  assert.equal(auditAttempts.length, 0, "a refused create must not audit");
});

test("POST: the body goes through readJsonCapped (guardrail 30) — over the cap → 413 before anything is parsed or written", async () => {
  const admin = await mintSession("ADMIN");
  const oversized = JSON.stringify({ ...WEBHOOK_BODY, name: "x".repeat(AGENT_BODY_CAP + 1) });
  const res = await createAgent(req(BASE, { method: "POST", headers: admin.header, body: oversized }), undefined);
  assert.equal(res.status, 413);
  assert.equal(agentsById.size, 0);
});

test("POST: the channel cap → 400 naming the limit, nothing written", async () => {
  const admin = await mintSession("ADMIN");
  for (let i = 0; i < MAX_AGENTS; i++) seedAgent();
  const res = await createAgent(req(BASE, { method: "POST", headers: admin.header, body: WEBHOOK_BODY }), undefined);
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: `You can configure up to ${MAX_AGENTS} channels.` });
  assert.equal(agentsById.size, MAX_AGENTS);
  assert.equal(opIndex("notificationAgent.create"), -1);
});

// ════════════════════════════════════════════════════════════════════════════
// PATCH — partial updates keep the stored secret; the response is public-shaped
// ════════════════════════════════════════════════════════════════════════════

test("PATCH { enabled } alone: 200, the stored secret is untouched (no secret key in the write), hasSecret stays true, audit after the write with secretChanged=false + the url", async () => {
  const admin = await mintSession("ADMIN");
  const a = seedAgent({ secret: SECRET, enabled: true });
  const res = await patchAgent(req(`${BASE}/${a.id}`, { method: "PATCH", headers: admin.header, body: { enabled: false } }), ctxFor(a.id));
  assert.equal(res.status, 200);
  const text = await res.text();
  const { agent } = JSON.parse(text) as { agent: PublicAgent };
  assertPublicShape(agent as unknown as Record<string, unknown>, text);
  assert.equal(agent.enabled, false);
  assert.equal(agent.hasSecret, true, "a toggle must not read as 'secret gone'");
  assert.equal(agent.name, a.name, "fields left out keep their stored value");

  const write = ops.find((o) => o.op === "notificationAgent.updateMany")?.args as { data: Record<string, unknown> } | undefined;
  assert.ok(write, "the update went through updateMany (404 on a concurrent delete, not P2025)");
  assert.ok(!("secret" in write.data), "an omitted secret must not be written at all — not even as undefined");
  assert.equal(agentsById.get(a.id)?.secret, SECRET, "the stored secret survives a partial update");

  await flush();
  assert.equal(auditRows.length, 1);
  assert.equal(auditRows[0].target, `notification-agent:${a.id}`);
  assert.ok(opIndex("notificationAgent.updateMany") < opIndex("auditLog.create"), "guardrail 26: audit AFTER the update");
  const details = detailsOf(auditRows[0]);
  assert.equal(details.op, "update");
  assert.equal(details.enabled, false);
  assert.equal(details.secretChanged, false);
  assert.equal(details.url, HOOK_URL, "the update audit names the destination too");
  assert.equal(details.headerName, "Authorization");
  assert.equal(details.hasTemplate, false);
  assert.ok(!("secret" in details));
  assert.ok(!JSON.stringify(auditRows[0]).includes(SECRET));
});

test("PATCH { secret: null } clears it: hasSecret false on the wire, secretChanged true in the audit, the new URL audited", async () => {
  const admin = await mintSession("ADMIN");
  const a = seedAgent({ secret: SECRET });
  const moved = "http://10.88.0.7:9000/elsewhere";
  const res = await patchAgent(req(`${BASE}/${a.id}`, { method: "PATCH", headers: admin.header, body: { secret: null, config: { url: moved } } }), ctxFor(a.id));
  assert.equal(res.status, 200);
  const text = await res.text();
  const { agent } = JSON.parse(text) as { agent: PublicAgent };
  assertPublicShape(agent as unknown as Record<string, unknown>, text);
  assert.equal(agent.hasSecret, false);
  assert.equal(agentsById.get(a.id)?.secret, null);
  await flush();
  const details = detailsOf(auditRows[0]);
  assert.equal(details.secretChanged, true);
  assert.equal(details.url, moved, "a redirected channel is visible in the audit log");
  assert.ok(!JSON.stringify(auditRows[0]).includes(SECRET));
});

test("PATCH: a stored config that no longer validates is re-validated → 400 and no write", async () => {
  const admin = await mintSession("ADMIN");
  const a = seedAgent({ secret: SECRET, config: { url: "not-a-url" } });
  const res = await patchAgent(req(`${BASE}/${a.id}`, { method: "PATCH", headers: admin.header, body: { enabled: false } }), ctxFor(a.id));
  assert.equal(res.status, 400);
  assert.equal(opIndex("notificationAgent.updateMany"), -1);
  assert.equal(agentsById.get(a.id)?.enabled, true);
});

// ════════════════════════════════════════════════════════════════════════════
// Unknown ids — 404, no mutation, no audit, no send
// ════════════════════════════════════════════════════════════════════════════

test("PATCH / DELETE / test on an unknown id → 404 {error:'Not found'}, nothing mutated, nothing audited, nothing sent", async () => {
  const admin = await mintSession("ADMIN");
  seedAgent({ secret: SECRET });
  const patch = await patchAgent(req(`${BASE}/nope`, { method: "PATCH", headers: admin.header, body: { enabled: false } }), ctxFor("nope"));
  assert.equal(patch.status, 404);
  assert.deepEqual(await patch.json(), { error: "Not found" });
  const del = await deleteAgent(req(`${BASE}/nope`, { method: "DELETE", headers: admin.header }), ctxFor("nope"));
  assert.equal(del.status, 404);
  assert.deepEqual(await del.json(), { error: "Not found" });
  const send = await testAgent(req(`${BASE}/nope/test`, { method: "POST", headers: admin.header }), ctxFor("nope"));
  assert.equal(send.status, 404);
  assert.deepEqual(await send.json(), { error: "Not found" });
  assert.equal(opIndex("notificationAgent.updateMany"), -1, "PATCH 404s on the pre-read, before any write");
  assert.equal(agentsById.size, 1);
  assert.equal(fetchCalls.length, 0);
  await flush();
  assert.equal(auditAttempts.length, 0, "a 404 must not audit a change that didn't happen");
});

test("DELETE: a concurrent delete (deleteMany count 0) → 404 — the route never relies on P2025", async () => {
  const admin = await mintSession("ADMIN");
  const a = seedAgent();
  agentsById.delete(a.id); // gone between the admin's list render and the click
  const res = await deleteAgent(req(`${BASE}/${a.id}`, { method: "DELETE", headers: admin.header }), ctxFor(a.id));
  assert.equal(res.status, 404);
  assert.equal(opIndex("notificationAgent.deleteMany") >= 0, true, "the delete is attempted as a counted deleteMany");
  await flush();
  assert.equal(auditAttempts.length, 0);
});

test("DELETE: happy path → 200 {ok:true}, the row is gone, one audit row after the delete", async () => {
  const admin = await mintSession("ADMIN");
  const a = seedAgent({ secret: SECRET });
  const res = await deleteAgent(req(`${BASE}/${a.id}`, { method: "DELETE", headers: admin.header }), ctxFor(a.id));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(agentsById.has(a.id), false);
  await flush();
  assert.equal(auditRows.length, 1);
  assert.equal(auditRows[0].action, "SETTINGS_CHANGE");
  assert.equal(auditRows[0].target, `notification-agent:${a.id}`);
  assert.deepEqual(detailsOf(auditRows[0]), { op: "delete" });
  assert.ok(opIndex("notificationAgent.deleteMany") < opIndex("auditLog.create"), "guardrail 26: audit AFTER the delete");
  assert.ok(!JSON.stringify(auditRows[0]).includes(SECRET));
});

// ════════════════════════════════════════════════════════════════════════════
// GUARDRAIL 26 — the audit write throws, the mutation still succeeds
// ════════════════════════════════════════════════════════════════════════════

test("GUARDRAIL 26 (create): auditLog throws → 201 kept, the row exists, swallow logged", async () => {
  const admin = await mintSession("ADMIN");
  auditThrows = true;
  const res = await createAgent(req(BASE, { method: "POST", headers: admin.header, body: WEBHOOK_BODY }), undefined);
  assert.equal(res.status, 201, "a failed audit write must not 500 a committed create (logAudit, not logAuditOrFail)");
  const text = await res.text();
  const { agent } = JSON.parse(text) as { agent: PublicAgent };
  assertPublicShape(agent as unknown as Record<string, unknown>, text);
  assert.ok(agentsById.has(agent.id), "the create committed before the audit");
  await flush();
  assert.equal(auditAttempts.length, 1, "logAudit WAS invoked (proves it isn't skipped)");
  assert.equal(auditRows.length, 0, "the throwing write left no committed row");
  assert.ok(sawSwallow(), "the swallowing variant must log the scoped failure line");
});

test("GUARDRAIL 26 (update): auditLog throws → 200 kept, the write landed, swallow logged", async () => {
  const admin = await mintSession("ADMIN");
  const a = seedAgent({ secret: SECRET, enabled: true });
  auditThrows = true;
  const res = await patchAgent(req(`${BASE}/${a.id}`, { method: "PATCH", headers: admin.header, body: { enabled: false } }), ctxFor(a.id));
  assert.equal(res.status, 200, "a failed audit write must not 500 a committed update");
  assert.equal(agentsById.get(a.id)?.enabled, false, "the update committed before the audit");
  assert.equal(agentsById.get(a.id)?.secret, SECRET);
  await flush();
  assert.equal(auditAttempts.length, 1);
  assert.equal(auditRows.length, 0);
  assert.ok(sawSwallow());
});

test("GUARDRAIL 26 (delete): auditLog throws → 200 {ok:true} kept, the row is gone, swallow logged", async () => {
  const admin = await mintSession("ADMIN");
  const a = seedAgent();
  auditThrows = true;
  const res = await deleteAgent(req(`${BASE}/${a.id}`, { method: "DELETE", headers: admin.header }), ctxFor(a.id));
  assert.equal(res.status, 200, "a failed audit write must not 500 a committed delete — the retry would 404 with no trail");
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(agentsById.has(a.id), false);
  await flush();
  assert.equal(auditAttempts.length, 1);
  assert.ok(sawSwallow());
});

// ════════════════════════════════════════════════════════════════════════════
// The Test button route
// ════════════════════════════════════════════════════════════════════════════

test("test: a DISABLED channel still sends one sample event with the stored secret in its header; 200 {ok:true,status,error:null}; the outcome is recorded", async () => {
  const admin = await mintSession("ADMIN");
  const a = seedAgent({ enabled: false, secret: SECRET, config: { url: HOOK_URL, headerName: "X-Hook-Key", template: null } });
  respond = () => new Response(null, { status: 204 }); // a 204 may carry no body — also exercises the body-less drain path
  const res = await testAgent(req(`${BASE}/${a.id}/test`, { method: "POST", headers: admin.header }), ctxFor(a.id));
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.deepEqual(JSON.parse(text), { ok: true, status: 204, error: null });
  assert.ok(!text.includes(SECRET));
  assert.equal(fetchCalls.length, 1, "enabled=false is deliberately ignored — an admin verifies a destination BEFORE turning it on");
  const call = fetchCalls[0];
  assert.equal(call.url.toString(), HOOK_URL);
  assert.equal(call.method, "POST");
  assert.equal(call.headers["x-hook-key"], SECRET, "the stored (plaintext-through-the-extension) secret rides in the configured header");
  assert.equal(call.headers["content-type"], "application/json");
  const payload = JSON.parse(call.body ?? "null") as { event: string; version: number; media: { title: string } | null };
  assert.equal(payload.event, "agent.test");
  assert.equal(payload.version, 1);
  assert.equal(payload.media?.title, "The Matrix", "the sample event, title left English on an English instance");
  assert.equal(agentsById.get(a.id)?.lastStatus, "ok", "sendAgentTest records the outcome before answering");
  await flush();
  assert.equal(auditAttempts.length, 0, "a test send is not a settings change");
});

test("test: a 5xx from the destination → 200 {ok:false,status:500,error:'HTTP 500'} with no retry, lastStatus=failed", async () => {
  const admin = await mintSession("ADMIN");
  const a = seedAgent({ secret: SECRET });
  respond = () => okJson({ error: "boom" }, 500);
  const res = await testAgent(req(`${BASE}/${a.id}/test`, { method: "POST", headers: admin.header }), ctxFor(a.id));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: false, status: 500, error: "HTTP 500" });
  assert.equal(fetchCalls.length, 1, "one attempt, no retry — the Test button reports, it does not queue");
  assert.equal(agentsById.get(a.id)?.lastStatus, "failed");
  assert.equal(agentsById.get(a.id)?.lastError, "HTTP 500");
});

test("test: rate-limited 10/min per admin — the 11th answers 429 and sends nothing", async () => {
  const admin = await mintSession("ADMIN");
  const a = seedAgent();
  respond = () => okJson({}, 200);
  for (let i = 0; i < 10; i++) {
    const res = await testAgent(req(`${BASE}/${a.id}/test`, { method: "POST", headers: admin.header }), ctxFor(a.id));
    assert.equal(res.status, 200, `send ${i + 1} must be under the limit`);
  }
  assert.equal(fetchCalls.length, 10);
  const limited = await testAgent(req(`${BASE}/${a.id}/test`, { method: "POST", headers: admin.header }), ctxFor(a.id));
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { error: "Too many test sends. Wait a minute and try again." });
  assert.equal(fetchCalls.length, 10, "a rate-limited test must not reach the destination");
  // The bucket is per ADMIN, not global: another admin is unaffected.
  const other = await mintSession("ADMIN");
  const fresh = await testAgent(req(`${BASE}/${a.id}/test`, { method: "POST", headers: other.header }), ctxFor(a.id));
  assert.equal(fresh.status, 200);
});

test("test: a stored config that no longer validates → 400 invalidStored with no send — and the OpenAPI spec documents that 400", async () => {
  const admin = await mintSession("ADMIN");
  const a = seedAgent({ config: { url: "not-a-url" } });
  const res = await testAgent(req(`${BASE}/${a.id}/test`, { method: "POST", headers: admin.header }), ctxFor(a.id));
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "This channel's saved settings are no longer valid. Edit and save it again." });
  assert.equal(fetchCalls.length, 0);

  // Spec parity: the route answers 200/400/404/429, and a client generated from
  // the spec must not meet the 400 as an undocumented response.
  const specRes = await openapiGet(req("http://localhost:3000/api/openapi", { method: "GET", headers: admin.header }), undefined);
  assert.equal(specRes.status, 200);
  const spec = (await specRes.json()) as { paths: Record<string, { post: { responses: Record<string, { description: string }> } }> };
  const responses = spec.paths["/admin/notification-agents/{id}/test"].post.responses;
  assert.deepEqual(Object.keys(responses).sort(), ["200", "400", "404", "429"]);
  assert.match(responses["400"].description, /stored settings/i);
});
