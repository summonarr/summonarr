// Admin side of the outbound notification channels: input parsing for the
// /api/admin/notification-agents routes (kind fixed at creation, secret
// tri-state, Gotify needs a token), the wire shape never carrying the secret,
// and guardrail 7a for NotificationAgent.secret — encrypted at rest by the
// Prisma extension, with every operation that can surface or write the column
// intercepted (the same three angles as tests/mfa-prisma-extension.test.mts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.TOKEN_ENCRYPTION_KEY = "ef".repeat(32);
process.env.DATABASE_URL = "postgresql://u:p@127.0.0.1:1/none";

const errors: string[] = [];
console.error = (...a: unknown[]) => { errors.push(a.map(String).join(" ")); };

const { prisma, encryptAgentSecretInPlace, decryptAgentSecretInPlace } = await import("../src/lib/prisma.ts");
const { parseAgentInput, toPublicAgent, AGENT_BODY_CAP } = await import("../src/lib/notify-agents-admin.ts");
const SOURCE = readFileSync(new URL("../src/lib/prisma.ts", import.meta.url), "utf8");

const WEBHOOK = { kind: "webhook", name: "Hook", events: ["request.created"], config: { url: "https://h.example/x" } };

test("create: kind + name + events + config validated; secret absent ⇒ null", () => {
  const r = parseAgentInput({ ...WEBHOOK }, null);
  assert.ok(r.ok);
  assert.equal(r.input.secret, null);
  assert.equal(r.input.enabled, true);
  assert.deepEqual(parseAgentInput({ ...WEBHOOK, kind: "slack" }, null), { ok: false, error: "kind" });
  assert.deepEqual(parseAgentInput({ ...WEBHOOK, name: "  " }, null), { ok: false, error: "name" });
  assert.deepEqual(parseAgentInput({ ...WEBHOOK, events: ["agent.test"] }, null), { ok: false, error: "events" });
  assert.deepEqual(parseAgentInput({ ...WEBHOOK, config: { url: "https://u:p@h.example/" } }, null), { ok: false, error: "url" });
  assert.deepEqual(parseAgentInput({ ...WEBHOOK, enabled: "yes" }, null), { ok: false, error: "enabled" });
});

test("gotify cannot be created, or edited, without an application token", () => {
  const g = { kind: "gotify", name: "G", events: [], config: { url: "https://g.example" } };
  assert.deepEqual(parseAgentInput(g, null), { ok: false, error: "gotifyToken" });
  assert.ok(parseAgentInput({ ...g, secret: "tok" }, null).ok);
  const existing = { kind: "gotify", name: "G", enabled: true, events: [], config: { url: "https://g.example/" } };
  assert.ok(parseAgentInput({ name: "G2" }, existing).ok, "omitting the secret on edit keeps the saved one");
  assert.deepEqual(parseAgentInput({ secret: "" }, existing), { ok: false, error: "gotifyToken" });
  // Whitespace-only trims to nothing: that is a CLEAR, never an empty token the
  // guard above would wave through (every delivery then goes out without X-Gotify-Key).
  assert.deepEqual(parseAgentInput({ ...g, secret: "   " }, null), { ok: false, error: "gotifyToken" });
  assert.deepEqual(parseAgentInput({ secret: "   " }, existing), { ok: false, error: "gotifyToken" });
});

test("edit: the kind is fixed, omitted fields keep their stored value, secret is tri-state", () => {
  const existing = { kind: "webhook", name: "Old", enabled: false, events: ["request.created"], config: { url: "https://h.example/x" } };
  assert.deepEqual(parseAgentInput({ kind: "ntfy" }, existing), { ok: false, error: "kindChange" });
  const keep = parseAgentInput({ enabled: true }, existing);
  assert.ok(keep.ok);
  assert.equal(keep.input.name, "Old");
  assert.deepEqual(keep.input.events, ["request.created"]);
  assert.equal(keep.input.secret, undefined, "undefined ⇒ leave the stored secret alone");
  const clear = parseAgentInput({ secret: null }, existing);
  assert.ok(clear.ok && clear.input.secret === null);
  const set = parseAgentInput({ secret: "  Bearer x  " }, existing);
  assert.ok(set.ok && set.input.secret === "Bearer x");
  const blank = parseAgentInput({ secret: "   " }, existing);
  assert.ok(blank.ok && blank.input.secret === null, "whitespace-only is stored as null (hasSecret: false), never as an empty string");
  // CR/LF is header injection; NUL and the other C0 controls / DEL make undici's
  // Headers throw a TypeError whose message EMBEDS the value, which would then
  // land in lastError, the warn line and the Test response.
  for (const bad of ["a\r\nX-Injected: 1", "tok\u0000en", "\u0001tok", "tok\u007f", "tok\ten"]) {
    assert.deepEqual(parseAgentInput({ secret: bad }, existing), { ok: false, error: "secret" }, JSON.stringify(bad));
  }
});

test("the route body cap is the text-bearing tier (guardrail 30): an 8,000-char CJK template must reach templateTooLong, not a 413", () => {
  assert.equal(AGENT_BODY_CAP, 64 * 1024);
});

test("the wire shape carries hasSecret, never the secret", () => {
  const out = toPublicAgent({
    id: "a", kind: "webhook", name: "n", enabled: true, events: [], config: {}, secret: "Bearer hunter2",
    lastStatus: null, lastError: null, lastAttemptAt: null, createdAt: new Date("2026-01-01T00:00:00Z"),
  });
  assert.equal(out.hasSecret, true);
  assert.ok(!JSON.stringify(out).includes("hunter2"));
  assert.ok(!("secret" in out));
});

// ── guardrail 7a: NotificationAgent.secret ──────────────────────────────────

function segment(): string {
  const q = SOURCE.slice(SOURCE.indexOf("query: {"));
  const start = q.indexOf("      notificationAgent: {");
  assert.ok(start >= 0, "the extension declares no notificationAgent block");
  return q.slice(start, q.indexOf("\n      },", start));
}
const handled = () => [...segment().matchAll(/^\s{8}async (\w+)\(/gm)].map((m) => m[1]);
function body(op: string): string {
  const seg = segment();
  const s = seg.indexOf(`        async ${op}(`);
  return seg.slice(s, seg.indexOf("\n        },", s));
}

test("every operation that can surface or write NotificationAgent.secret is intercepted", () => {
  const META = new Set(["fields", "name", "$name", "$parent"]);
  const real = Object.keys(prisma.notificationAgent as object).filter((k) => !META.has(k));
  assert.ok(real.length >= 15, "operation enumeration is broken");
  const h = new Set(handled());
  assert.deepEqual([...h].filter((op) => !real.includes(op)), []);
  assert.deepEqual(real.filter((op) => !h.has(op)).sort(), ["aggregate", "aggregateRaw", "count", "deleteMany", "findRaw", "groupBy"].sort());
});

test("read handlers decrypt; write handlers encrypt", () => {
  for (const op of ["findUnique", "findFirst", "findUniqueOrThrow", "findFirstOrThrow", "findMany", "delete", "createManyAndReturn", "updateManyAndReturn"]) {
    assert.ok(body(op).includes("decryptAgentSecretInPlace"), `${op} returns rows without decrypting them`);
  }
  for (const op of ["create", "update", "upsert", "updateMany", "createMany", "updateManyAndReturn", "createManyAndReturn"]) {
    assert.match(body(op), /encryptAgent(SecretInPlace|RowsInPlace)/, `${op} writes the secret in plaintext`);
  }
  // upsert carries TWO write payloads. One encrypt call satisfies the loop above
  // while the other branch stores plaintext — pin each argument by name.
  assert.match(body("upsert"), /encryptAgentSecretInPlace\(args\.create\b/, "upsert's create branch writes the secret in plaintext");
  assert.match(body("upsert"), /encryptAgentSecretInPlace\(args\.update\b/, "upsert's update branch writes the secret in plaintext");
});

test("round-trip: a written secret is enc:v1 ciphertext and reads back as the plaintext", () => {
  const data: Record<string, unknown> = { id: "a1", secret: "Bearer hunter2" };
  encryptAgentSecretInPlace(data);
  assert.match(data.secret as string, /^enc:v1:/);
  decryptAgentSecretInPlace(data);
  assert.equal(data.secret, "Bearer hunter2");
  const setForm: Record<string, unknown> = { secret: { set: "tok" } };
  encryptAgentSecretInPlace(setForm);
  assert.match((setForm.secret as { set: string }).set, /^enc:v1:/);
  const cleared: Record<string, unknown> = { secret: null };
  encryptAgentSecretInPlace(cleared);
  assert.equal(cleared.secret, null, "clearing writes null, not an encrypted empty string");
});

test("an undecryptable secret fails closed to empty and is logged", () => {
  const row: Record<string, unknown> = { id: "a9", secret: "enc:v1:garbage" };
  decryptAgentSecretInPlace(row);
  assert.equal(row.secret, "");
  assert.ok(errors.some((e) => e.includes("[agent-crypto]") && e.includes("a9")));
});
