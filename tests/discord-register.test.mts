// Unit tests for the Discord slash-command registration helper
// (src/lib/discord-register.ts) — the boot-time self-heal that resolves the
// long-standing "/link rejects my 32-char token" problem: a command-option
// change that ships in an upgrade (the token max_length going 20 -> 32) stayed
// invisible on Discord until an admin manually clicked "Register commands",
// because Discord caches the registered schema. syncDiscordCommandsIfChanged
// re-registers ONLY when the schema (or its guild/global scope) changed since
// the last successful registration, so the correct schema republishes on the
// first boot after the upgrade with no manual step — and skips the Discord API
// entirely on an unchanged schema so a crash-looping container can't burn the
// global-command rate limit.
//
// No network: globalThis.fetch is scripted. No DB: prisma.setting is an
// in-memory shadow (the jellyfin-config/poster-cache idiom).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto
process.env.NEXTAUTH_SECRET = "discord-register-test-secret-0123456789ab";

// ── console capture ─────────────────────────────────────────────────────────
const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// ── scripted discord.com ──────────────────────────────────────────────────────
type PutCall = { url: string; method: string; auth: string | null; body: string | null };
const puts: PutCall[] = [];
let putStatus = 200;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  puts.push({
    url,
    method: init?.method ?? "GET",
    auth: new Headers(init?.headers).get("authorization"),
    body: typeof init?.body === "string" ? init.body : null,
  });
  return new Response(putStatus === 200 ? "[]" : "boom", { status: putStatus, headers: { "content-type": "application/json" } });
}) as unknown as typeof fetch;

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");

// ── in-memory Setting store ───────────────────────────────────────────────────
const settings = new Map<string, string>();
const upserts: Array<{ key: string; value: string }> = [];
shadowPrismaModel(prisma, "setting", {
  findMany: async (args: { where?: { key?: { in?: string[] } } }) => {
    const keys = args.where?.key?.in ?? [];
    return keys.flatMap((k) => (settings.has(k) ? [{ key: k, value: settings.get(k)! }] : []));
  },
  upsert: async (args: { where: { key: string }; create: { key: string; value: string } }) => {
    upserts.push({ key: args.where.key, value: args.create.value });
    settings.set(args.where.key, args.create.value);
    return args.create;
  },
});

const { syncDiscordCommandsIfChanged, discordSchemaHash, DISCORD_SCHEMA_HASH_KEY } = await import("../src/lib/discord-register.ts");
const { DISCORD_LINK_TOKEN_LENGTH } = await import("../src/lib/discord-commands.ts");

beforeEach(() => {
  settings.clear();
  upserts.length = 0;
  puts.length = 0;
  warns.length = 0;
  errors.length = 0;
  putStatus = 200;
});

test("unconfigured (no bot token / client id): no Discord call, no hash write", async () => {
  settings.set("discordGuildId", "999");
  await syncDiscordCommandsIfChanged();
  assert.equal(puts.length, 0);
  assert.equal(upserts.length, 0);
});

test("a stale/absent hash registers GLOBALLY, records the hash, and the /link token max_length is the full 32", async () => {
  settings.set("discordBotToken", "bot-tok");
  settings.set("discordClientId", "12345");
  // no discordCommandsSchemaHash → never registered by this mechanism

  await syncDiscordCommandsIfChanged();

  assert.equal(puts.length, 1, "a stale schema must re-register exactly once");
  const call = puts[0];
  assert.equal(call.method, "PUT");
  assert.equal(call.url, "https://discord.com/api/v10/applications/12345/commands", "global scope with no guild id");
  assert.equal(call.auth, "Bot bot-tok", "the decrypted bot token authorizes the PUT");

  // The actual bug this whole fix exists for: the /link token option must allow
  // the full 32-hex token, not the old 20.
  const cmds = JSON.parse(call.body!) as Array<{ name: string; options?: Array<{ name: string; max_length?: number }> }>;
  const linkToken = cmds.find((c) => c.name === "link")?.options?.find((o) => o.name === "token");
  assert.equal(linkToken?.max_length, DISCORD_LINK_TOKEN_LENGTH);
  assert.equal(linkToken?.max_length, 32);

  assert.deepEqual(upserts, [{ key: DISCORD_SCHEMA_HASH_KEY, value: discordSchemaHash(null) }], "the schema hash is recorded on success");
});

test("an UP-TO-DATE hash makes ZERO Discord calls — the rate-limit guard", async () => {
  settings.set("discordBotToken", "bot-tok");
  settings.set("discordClientId", "12345");
  settings.set(DISCORD_SCHEMA_HASH_KEY, discordSchemaHash(null)); // already current

  await syncDiscordCommandsIfChanged();
  assert.equal(puts.length, 0, "an unchanged schema must not hit the Discord API");
  assert.equal(upserts.length, 0);
});

test("a guild id targets the GUILD endpoint and the hash is scope-specific (a guild<->global flip re-registers)", async () => {
  settings.set("discordBotToken", "bot-tok");
  settings.set("discordClientId", "12345");
  settings.set("discordGuildId", "67890");
  // The GLOBAL hash is stored — but the scope is now guild, so it must NOT count
  // as current.
  settings.set(DISCORD_SCHEMA_HASH_KEY, discordSchemaHash(null));

  await syncDiscordCommandsIfChanged();
  assert.equal(puts.length, 1, "a scope flip (global->guild) must re-register");
  assert.equal(puts[0].url, "https://discord.com/api/v10/applications/12345/guilds/67890/commands");
  assert.deepEqual(upserts, [{ key: DISCORD_SCHEMA_HASH_KEY, value: discordSchemaHash("67890") }]);
  assert.notEqual(discordSchemaHash("67890"), discordSchemaHash(null), "guild and global hashes must differ");
});

test("a failed registration warns and does NOT record the hash (so the next boot retries)", async () => {
  settings.set("discordBotToken", "bot-tok");
  settings.set("discordClientId", "12345");
  putStatus = 401;

  await syncDiscordCommandsIfChanged();
  assert.equal(puts.length, 1);
  assert.equal(upserts.length, 0, "a failed PUT must leave the hash unset so the next boot retries");
  assert.ok(warns.some((w) => w.includes("[discord] boot command sync failed (401)")));
});
