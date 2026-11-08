// One-click webhook setup (setupArrWebhook) changes the arr, and one
// Radarr/Sonarr can be shared by two Summonarrs (staging and production):
//   - it rewrites only THIS deployment's Connect entry — the one with our
//     token, else the one at our address, else the only Summonarr entry there
//     is (Summonarr moved) — and creates its own beside another deployment's;
//   - a blank secret row (an admin cleared it) is filled only WHILE blank, so
//     two setups racing end on ONE secret and the arr gets the stored one.
// The token never leaves the server (guardrail 2a) — that is pinned with the
// route in tests/arr-ops-routes.test.mts; here the data layer is called directly.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "arr-webhook-setup-ownership-secret-0123456789abcdef";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "10.0.0.250", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

console.warn = () => {};
console.error = () => {};

const RADARR = "http://10.0.0.5:7878";
type Call = { method: string; path: string; body: unknown };
let calls: Call[] = [];
let responder: (c: Call) => Response | undefined = () => undefined;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  let body: unknown;
  if (typeof init?.body === "string" && init.body !== "") {
    try { body = JSON.parse(init.body); } catch { body = init.body; }
  }
  const c = { method, path: url.pathname, body };
  calls.push(c);
  const res = responder(c);
  if (res) return res;
  throw new Error(`unexpected ${method} ${url}`);
}) as unknown as typeof fetch;

const { prisma } = await import("../src/lib/prisma.ts");
const { Prisma } = await import("@/generated/prisma");
const { shadowPrismaModel } = await import("./_helpers.mts");

const settings = new Map<string, string>();
// Runs just before this setup's conditional fill: another setup's write landing first.
let beforeFill: (() => void) | null = null;
const fills: string[] = [];
shadowPrismaModel(prisma, "setting", {
  findMany: async (args?: { where?: { key?: { in?: string[] } } }) => {
    const keys = args?.where?.key?.in;
    return [...settings.entries()].filter(([k]) => !keys || keys.includes(k)).map(([key, value]) => ({ key, value }));
  },
  findUnique: async (args: { where: { key: string } }) => {
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
  createMany: async (args: { data: Array<{ key: string; value: string }> }) => {
    let count = 0;
    for (const row of args.data) {
      if (settings.has(row.key)) continue;
      settings.set(row.key, row.value);
      count++;
    }
    return { count };
  },
  // Prisma's update with an extra filter: no row matching both → P2025.
  update: async (args: { where: { key: string; value?: string }; data: { value: string } }) => {
    beforeFill?.();
    beforeFill = null;
    const cur = settings.get(args.where.key);
    if (cur === undefined || (args.where.value !== undefined && cur !== args.where.value)) {
      throw new Prisma.PrismaClientKnownRequestError("No record was found for an update.", { code: "P2025", clientVersion: "0.0.0-test" });
    }
    settings.set(args.where.key, args.data.value);
    fills.push(args.data.value);
    return { key: args.where.key, value: args.data.value };
  },
  upsert: async (args: { where: { key: string }; update: { value: string } }) => {
    settings.set(args.where.key, args.update.value);
    fills.push(args.update.value);
    return { key: args.where.key, value: args.update.value };
  },
});

const { setupArrWebhook } = await import("../src/lib/arr-health-data.ts");
const { webhookSetupTarget } = await import("../src/lib/arr-health.ts");

const SECRET = "c0ffee0123456789c0ffee0123456789";
const hook = (id: number, url: string) => ({
  id, name: `Hook ${id}`, implementation: "Webhook", tags: [],
  fields: [{ name: "url", value: url }, { name: "method", value: 1 }],
  onDownload: true, onGrab: false,
});
const schema = [{ implementation: "Webhook", fields: [{ name: "url", value: "" }] }];

beforeEach(() => {
  calls = [];
  responder = () => undefined;
  beforeFill = null;
  fills.length = 0;
  settings.clear();
  settings.set("radarrUrl", RADARR);
  settings.set("radarrApiKey", "radarr-key");
  settings.set("radarrWebhookSecret", SECRET);
});

function arrWith(connect: unknown[]) {
  responder = (c) => {
    if (c.method === "GET" && c.path === "/api/v3/notification") return json(connect);
    if (c.method === "GET" && c.path === "/api/v3/notification/schema") return json(schema);
    if (c.method === "PUT" && c.path.startsWith("/api/v3/notification/")) return json({ id: Number(c.path.split("/").pop()) });
    if (c.method === "POST" && c.path === "/api/v3/notification") return json({ id: 99 }, 201);
    return undefined;
  };
}
const writes = () => calls.filter((c) => c.method !== "GET");
const sentUrl = (c: Call) => (c.body as { fields: Array<{ name: string; value: string }> }).fields.find((f) => f.name === "url")!.value;

// ── whose entry ──────────────────────────────────────────────────────────────

test("with another deployment's hook beside our stale one, the setup rewrites OURS (same address) and leaves theirs", async () => {
  arrWith([
    hook(7, "https://staging.example.test/api/webhooks/radarr?token=their-token"),
    hook(8, "http://summonarr:3000/api/webhooks/radarr?token=rotated-away"),
  ]);
  assert.deepEqual(await setupArrWebhook("radarr", "", "http://summonarr:3000"), { outcome: "updated", secretGenerated: false });
  assert.deepEqual(writes().map((c) => [c.method, c.path]), [["PUT", "/api/v3/notification/8"]]);
  assert.equal(sentUrl(writes()[0]), `http://summonarr:3000/api/webhooks/radarr?token=${SECRET}`);
});

test("with only other deployments' hooks (more than one), the setup creates its own and PUTs nothing", async () => {
  arrWith([
    hook(7, "https://staging.example.test/api/webhooks/radarr?token=their-token"),
    hook(9, "https://other.example.test/base/api/webhooks/radarr?token=theirs-too"),
  ]);
  assert.deepEqual(await setupArrWebhook("radarr", "", "http://summonarr:3000"), { outcome: "created", secretGenerated: false });
  assert.deepEqual(writes().map((c) => [c.method, c.path]), [["POST", "/api/v3/notification"]]);
  assert.equal(sentUrl(writes()[0]), `http://summonarr:3000/api/webhooks/radarr?token=${SECRET}`);
});

test("the hook carrying our token is ours wherever it points (a moved address is repaired in place)", async () => {
  arrWith([
    hook(7, "https://staging.example.test/api/webhooks/radarr?token=their-token"),
    hook(8, `http://old-host:3000/api/webhooks/radarr?token=${SECRET}`),
  ]);
  assert.deepEqual(await setupArrWebhook("radarr", "", "http://summonarr:3000"), { outcome: "updated", secretGenerated: false });
  assert.deepEqual(writes().map((c) => [c.method, c.path]), [["PUT", "/api/v3/notification/8"]]);
});

test("the only Summonarr hook, at another address with a stale token, is repaired in place (Summonarr moved)", async () => {
  arrWith([hook(8, "http://old-host:3000/api/webhooks/radarr?token=rotated-away")]);
  assert.deepEqual(await setupArrWebhook("radarr", "", "http://summonarr:3000"), { outcome: "updated", secretGenerated: false });
  assert.deepEqual(writes().map((c) => [c.method, c.path]), [["PUT", "/api/v3/notification/8"]]);
});

test("our address matches across a base path and trailing slashes; the token never decides an address", () => {
  const url = `http://summonarr:3000/app/api/webhooks/radarr?token=${SECRET}`;
  const list = [
    hook(1, "http://summonarr:3000/other/api/webhooks/radarr?token=x"),
    hook(2, "http://summonarr:3000/app/api/webhooks/radarr//?token=y"),
  ];
  assert.equal(webhookSetupTarget(list, "radarr", SECRET, url), 2);
  assert.equal(webhookSetupTarget(list, "radarr", SECRET, "http://elsewhere/api/webhooks/radarr?token=z"), null, "two foreign entries: create");
  assert.equal(webhookSetupTarget([], "radarr", SECRET, url), null);
  assert.equal(webhookSetupTarget([hook(3, "http://x/api/webhooks/sonarr?token=a")], "radarr", SECRET, url), null, "another service's path is no Summonarr radarr hook");
});

// ── a blank secret row ───────────────────────────────────────────────────────

test("a blank secret row is filled with this setup's secret, and the arr gets that one", async () => {
  settings.set("radarr4kUrl", "http://10.0.0.6:7878");
  settings.set("radarr4kApiKey", "radarr-4k-key");
  settings.set("radarr4kWebhookSecret", "");
  arrWith([]);
  const result = await setupArrWebhook("radarr", "4k", "http://summonarr:3000");
  assert.deepEqual(result, { outcome: "created", secretGenerated: true });
  const stored = settings.get("radarr4kWebhookSecret")!;
  assert.match(stored, /^[0-9a-f]{48}$/);
  assert.equal(new URL(sentUrl(writes()[0])).searchParams.get("token"), stored);
});

test("two setups racing on a BLANK secret row end on one secret — the loser uses the winner's, never overwrites it", async () => {
  settings.set("radarr4kUrl", "http://10.0.0.6:7878");
  settings.set("radarr4kApiKey", "radarr-4k-key");
  settings.set("radarr4kWebhookSecret", "");
  arrWith([]);
  // The other setup's fill lands between this one's read and its own fill.
  beforeFill = () => settings.set("radarr4kWebhookSecret", "winner-secret");
  let generated = false;
  const result = await setupArrWebhook("radarr", "4k", "http://summonarr:3000", { onSecretGenerated: () => { generated = true; } });
  assert.deepEqual(result, { outcome: "created", secretGenerated: false });
  assert.equal(generated, false, "only the winner reports a generated secret");
  assert.equal(settings.get("radarr4kWebhookSecret"), "winner-secret");
  assert.deepEqual(fills, [], "nothing of ours was written");
  assert.equal(new URL(sentUrl(writes()[0])).searchParams.get("token"), "winner-secret");
});
