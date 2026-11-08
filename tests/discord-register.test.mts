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
// No network: globalThis.fetch is scripted and dns.lookup is stubbed.
// No DB: prisma.setting is an in-memory shadow (the jellyfin-config/poster-cache idiom).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto
process.env.NEXTAUTH_SECRET = "discord-register-test-secret-0123456789ab";

// ── DNS stub ────────────────────────────────────────────────────────────────
// safeFetchTrusted resolves discord.com (its SSRF check) before calling fetch.
// Without this stub the test would make a real DNS query and fail offline.
const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

// ── console capture ─────────────────────────────────────────────────────────
const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// ── scripted discord.com ──────────────────────────────────────────────────────
type PutCall = { url: string; method: string; auth: string | null; body: string | null };
const puts: PutCall[] = [];
let putStatus = 200;
// Per-URL override (the global-clear failure test).
let putStatusFor: ((url: string) => number) | null = null;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const status = putStatusFor ? putStatusFor(url) : putStatus;
  puts.push({
    url,
    method: init?.method ?? "GET",
    auth: new Headers(init?.headers).get("authorization"),
    body: typeof init?.body === "string" ? init.body : null,
  });
  return new Response(status === 200 ? "[]" : "boom", { status, headers: { "content-type": "application/json" } });
}) as unknown as typeof fetch;

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");

// ── in-memory Setting store ───────────────────────────────────────────────────
const settings = new Map<string, string>();
const upserts: Array<{ key: string; value: string }> = [];
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) =>
    settings.has(args.where.key) ? { key: args.where.key, value: settings.get(args.where.key)! } : null,
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

const { syncDiscordCommandsIfChanged, discordSchemaHash, recordDiscordSchemaHash, putDiscordCommands, DISCORD_SCHEMA_HASH_KEY, DISCORD_REGISTERED_GUILD_KEY } = await import("../src/lib/discord-register.ts");
const { invalidateFeatureFlagCache } = await import("../src/lib/features.ts");
const { DISCORD_LINK_TOKEN_LENGTH } = await import("../src/lib/discord-commands.ts");

// The schema-hash writes alone (each registration also records its target guild).
const hashUpserts = () => upserts.filter((u) => u.key === DISCORD_SCHEMA_HASH_KEY);

beforeEach(() => {
  settings.clear();
  upserts.length = 0;
  puts.length = 0;
  warns.length = 0;
  errors.length = 0;
  putStatus = 200;
  putStatusFor = null;
  invalidateFeatureFlagCache();
});

test("unconfigured (no bot token / client id): no Discord call, no hash write", async () => {
  settings.set("discordGuildId", "999");
  await syncDiscordCommandsIfChanged();
  assert.equal(puts.length, 0);
  assert.equal(upserts.length, 0);
});

test("a stale/absent hash registers GLOBALLY, records the hash, and the /link token max_length is the full 32", async () => {
  settings.set("discordBotToken", "bot-tok");
  settings.set("discordClientId", "100000000000012345");
  // no discordCommandsSchemaHash → never registered by this mechanism

  await syncDiscordCommandsIfChanged();

  assert.equal(puts.length, 1, "a stale schema must re-register exactly once");
  const call = puts[0];
  assert.equal(call.method, "PUT");
  assert.equal(call.url, "https://discord.com/api/v10/applications/100000000000012345/commands", "global scope with no guild id");
  assert.equal(call.auth, "Bot bot-tok", "the decrypted bot token authorizes the PUT");

  // The actual bug this whole fix exists for: the /link token option must allow
  // the full 32-hex token, not the old 20.
  const cmds = JSON.parse(call.body!) as Array<{ name: string; options?: Array<{ name: string; max_length?: number }> }>;
  const linkToken = cmds.find((c) => c.name === "link")?.options?.find((o) => o.name === "token");
  assert.equal(linkToken?.max_length, DISCORD_LINK_TOKEN_LENGTH);
  assert.equal(linkToken?.max_length, 32);

  assert.deepEqual(hashUpserts(), [{ key: DISCORD_SCHEMA_HASH_KEY, value: discordSchemaHash("100000000000012345", null) }], "the schema hash is recorded on success");
});

test("an UP-TO-DATE hash makes ZERO Discord calls — the rate-limit guard", async () => {
  settings.set("discordBotToken", "bot-tok");
  settings.set("discordClientId", "100000000000012345");
  settings.set(DISCORD_SCHEMA_HASH_KEY, discordSchemaHash("100000000000012345", null)); // already current

  await syncDiscordCommandsIfChanged();
  assert.equal(puts.length, 0, "an unchanged schema must not hit the Discord API");
  assert.equal(upserts.length, 0);
});

test("a guild id targets the GUILD endpoint and the hash is scope-specific (a guild<->global flip re-registers)", async () => {
  settings.set("discordBotToken", "bot-tok");
  settings.set("discordClientId", "100000000000012345");
  settings.set("discordGuildId", "200000000000067890");
  // The GLOBAL hash is stored — but the scope is now guild, so it must NOT count
  // as current.
  settings.set(DISCORD_SCHEMA_HASH_KEY, discordSchemaHash("100000000000012345", null));

  await syncDiscordCommandsIfChanged();
  assert.equal(puts.length, 2, "a scope flip (global->guild) must re-register, then clear the global set");
  assert.equal(puts[0].url, "https://discord.com/api/v10/applications/100000000000012345/guilds/200000000000067890/commands");
  // The leftover GLOBAL set would keep the commands usable in every other server
  // the bot is in — it is replaced with an empty one.
  assert.equal(puts[1].url, "https://discord.com/api/v10/applications/100000000000012345/commands");
  assert.equal(puts[1].method, "PUT");
  assert.equal(puts[1].body, "[]");
  assert.deepEqual(hashUpserts(), [{ key: DISCORD_SCHEMA_HASH_KEY, value: discordSchemaHash("100000000000012345", "200000000000067890") }]);
  assert.notEqual(discordSchemaHash("100000000000012345", "200000000000067890"), discordSchemaHash("100000000000012345", null), "guild and global hashes must differ");
});

test("a failed registration warns and does NOT record the hash (so the next boot retries)", async () => {
  settings.set("discordBotToken", "bot-tok");
  settings.set("discordClientId", "100000000000012345");
  putStatus = 401;

  await syncDiscordCommandsIfChanged();
  assert.equal(puts.length, 1);
  assert.equal(upserts.length, 0, "a failed PUT must leave the hash unset so the next boot retries");
  assert.ok(warns.some((w) => w.includes("[discord] boot command sync failed (401)")));
});

test("a failed GLOBAL clear after a guild registration is a failure: the hash stays unset so the next boot retries", async () => {
  settings.set("discordBotToken", "bot-tok");
  settings.set("discordClientId", "100000000000012345");
  settings.set("discordGuildId", "200000000000067890");
  putStatusFor = (url) => (url.endsWith("/applications/100000000000012345/commands") ? 500 : 200);

  await syncDiscordCommandsIfChanged();
  assert.equal(puts.length, 2, "guild PUT, then the clear");
  assert.equal(upserts.length, 0, "the clear failed — not current yet");
  assert.ok(warns.some((w) => w.includes("[discord] boot command sync failed (500)")));
});

test("a global-scope registration (no Guild ID) makes no clear call", async () => {
  settings.set("discordBotToken", "bot-tok");
  settings.set("discordClientId", "100000000000012345");
  await syncDiscordCommandsIfChanged();
  assert.equal(puts.length, 1);
  assert.notEqual(puts[0].body, "[]");
});

test("a different bot APPLICATION re-registers: the hash covers the client id, not only the schema and scope", async () => {
  // The stored hash is the one application A's registration recorded. A move to
  // application B that skipped (or failed) the settings-save registration used
  // to match it, and every boot answered "already current" for an app that had
  // no commands.
  settings.set("discordBotToken", "bot-tok");
  settings.set("discordClientId", "400000000000022222");
  settings.set(DISCORD_SCHEMA_HASH_KEY, discordSchemaHash("300000000000011111", null));

  await syncDiscordCommandsIfChanged();
  assert.equal(puts.length, 1, "the new application gets its commands");
  assert.equal(puts[0].url, "https://discord.com/api/v10/applications/400000000000022222/commands");
  assert.deepEqual(hashUpserts(), [{ key: DISCORD_SCHEMA_HASH_KEY, value: discordSchemaHash("400000000000022222", null) }]);
  assert.notEqual(discordSchemaHash("300000000000011111", null), discordSchemaHash("400000000000022222", null));
});

test("recordDiscordSchemaHash without a client id hashes the STORED one; with none stored it writes nothing", async () => {
  settings.set("discordClientId", "500000000000033333");
  await recordDiscordSchemaHash("200000000000067890");
  assert.deepEqual(hashUpserts(), [{ key: DISCORD_SCHEMA_HASH_KEY, value: discordSchemaHash("500000000000033333", "200000000000067890") }]);

  upserts.length = 0;
  settings.clear();
  await recordDiscordSchemaHash(null);
  assert.deepEqual(upserts, [], "no application to describe — nothing recorded, so the boot sync registers");
});

// ── leftovers in a guild the commands no longer live in ──────────────────────

const CLIENT = "100000000000012345";
const GUILD_A = "200000000000067890";
const GUILD_B = "600000000000000006";

test("moving from a guild to global registration clears the old guild's commands", async () => {
  settings.set("discordBotToken", "bot-tok");
  settings.set("discordClientId", CLIENT);
  settings.set("discordGuildId", GUILD_A);
  await syncDiscordCommandsIfChanged();
  assert.equal(settings.get(DISCORD_REGISTERED_GUILD_KEY), `${CLIENT}:${GUILD_A}`);

  puts.length = 0;
  settings.delete("discordGuildId");
  await syncDiscordCommandsIfChanged();
  assert.deepEqual(
    puts.map((p) => [p.url, p.body]),
    [
      [`https://discord.com/api/v10/applications/${CLIENT}/commands`, puts[0].body],
      [`https://discord.com/api/v10/applications/${CLIENT}/guilds/${GUILD_A}/commands`, "[]"],
    ],
  );
  assert.equal(settings.get(DISCORD_REGISTERED_GUILD_KEY), "");
});

test("moving to another guild clears the first; a guild the bot has left counts as cleared", async () => {
  settings.set(DISCORD_REGISTERED_GUILD_KEY, `${CLIENT}:${GUILD_A}`);
  putStatusFor = (url) => (url.includes(`/guilds/${GUILD_A}/`) ? 403 : 200);
  const res = await putDiscordCommands("bot-tok", CLIENT, GUILD_B);
  assert.equal(res.status, 200);
  assert.ok(puts.some((p) => p.url.includes(`/guilds/${GUILD_A}/commands`) && p.body === "[]"));
});

test("another application's old guild is left alone", async () => {
  settings.set(DISCORD_REGISTERED_GUILD_KEY, `700000000000000007:${GUILD_A}`);
  await putDiscordCommands("bot-tok", CLIENT, null);
  assert.ok(!puts.some((p) => p.url.includes("/guilds/")));
});

test("ids that are not snowflakes never reach a Discord URL", async () => {
  for (const [client, guild] of [["../../users/@me", null], [CLIENT, "1/../../x"], ["12345", null]] as const) {
    const res = await putDiscordCommands("bot-tok", client, guild);
    assert.equal(res.status, 400);
  }
  assert.equal(puts.length, 0);
});

test("the boot sync registers nothing while the Discord integration is switched off", async () => {
  settings.set("feature.integration.discord", "false");
  settings.set("discordBotToken", "bot-tok");
  settings.set("discordClientId", CLIENT);
  await syncDiscordCommandsIfChanged();
  assert.equal(puts.length, 0);
});
