// Cross-path pin for the Discord slash-command schema (src/lib/discord-commands.ts).
//
// ── THE HEADLINE: TWO REGISTRATION PATHS, ONE SCHEMA ─────────────────────────
// Two places PUT the command array to Discord's
// /applications/{id}[/guilds/{id}]/commands endpoint, which is a FULL REPLACE:
//
//   1. POST /api/discord/register-commands  — the admin "Register commands" button
//   2. PATCH /api/settings                  — fire-and-forget re-registration when
//                                             any discord* key changes
//
// They used to hold SEPARATE literals and drifted: the settings-triggered copy
// declared the `/link` token option with max_length 20 while generate-link mints
// a 32-hex token (randomBytes(16).toString("hex")). Discord enforces max_length
// client- AND server-side, so every /link attempt was rejected before it reached
// the interactions handler — and because whichever path ran last wins, saving
// settings silently re-broke what the manual button had just fixed.
//
// So this file drives BOTH real handlers and asserts the bytes they publish are
// identical and accept a real token. The assertions that fail on a re-divergence:
//   - the two PUT bodies are byte-identical, and both equal DISCORD_SLASH_COMMANDS
//   - the `/link` token option admits a genuine 32-char generate-link token
//   - the full command set (names/descriptions/options/choices) matches an
//     explicit literal, so a rename or a dropped option can't pass silently
//   - neither route file declares max_length itself — both must import the module
//
// Division of labour (owned elsewhere; NOT re-pinned here):
//   - tests/discord-routes.test.mts OWNS register-commands' auth, 400-on-missing-
//     config, global-vs-guild scoping and 502 mapping. Here we only pin the schema.
//   - tests/settings-route.test.mts OWNS the PATCH write contract (guardrail 7a,
//     masking, rollback). Here we only pin the re-registration payload.
//
// Harness: real wrapped handlers, a genuine signed admin JWT over in-memory rows,
// a recording fake prisma seeded on globalThis BEFORE the module graph loads (the
// settings-route.test.mts idiom), scripted discord.com, stubbed DNS. No DB, no
// network. Bearer transport skips the UA fingerprint and the sliding Set-Cookie.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import dns from "node:dns/promises";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto at load
process.env.NEXTAUTH_SECRET = "discord-commands-test-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true"; // silence rate-limit's module-load warning
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

// safeFetchTrusted still runs the DNS-based SSRF check against discord.com.
const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

// ── console capture (guardrail 7: warn/error only) ───────────────────────────
const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// ── scripted discord.com ─────────────────────────────────────────────────────
type PutCall = { url: URL; method: string; body: string };
const commandPuts: PutCall[] = [];

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "discord.com" && url.pathname.endsWith("/commands")) {
    commandPuts.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : "" });
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  }
  throw new Error(`unexpected fetch ${url} — this file scripts the commands endpoint only`);
}) as typeof fetch;

// ── recording fake prisma (seeded on globalThis before the module graph) ─────
const settings = new Map<string, string>();
type DbUser = {
  id: string; role: string; permissions: bigint; name: string | null; email: string | null;
  mediaServer: string | null; notificationEmail: string | null;
  sessionsRevokedAt: Date | null; passwordChangedAt: Date | null; deactivatedAt: Date | null;
};
const usersById = new Map<string, DbUser>();
const authSessionsById = new Map<string, { userId: string }>();

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
    findMany: async (args?: { where?: { key?: { in?: string[] } } }) => {
      const only = args?.where?.key?.in;
      const rows = [...settings.entries()].map(([key, value]) => ({ key, value }));
      return only ? rows.filter((r) => only.includes(r.key)) : rows;
    },
    findUnique: async (args: { where: { key: string } }) => {
      const value = settings.get(args.where.key);
      return value === undefined ? null : { key: args.where.key, value };
    },
    // Both registration paths record the schema hash after a successful PUT
    // (recordDiscordSchemaHash) so the boot self-heal won't redundantly re-push.
    upsert: async (a: { where: { key: string }; create: { key: string; value: string } }) => {
      settings.set(a.where.key, a.create.value);
      return a.create;
    },
  },
  $transaction: async (arg: unknown) => {
    const tx = {
      setting: {
        upsert: async (a: { where: { key: string }; create: { value: string } }) => {
          settings.set(a.where.key, a.create.value);
          return { key: a.where.key, value: a.create.value };
        },
        deleteMany: async (a: { where: { key: string } }) => { settings.delete(a.where.key); return { count: 1 }; },
      },
      auditLog: { create: async (a: { data: Record<string, unknown> }) => a.data },
    };
    if (typeof arg === "function") return (arg as (t: typeof tx) => Promise<unknown>)(tx);
    return Promise.all(arg as Promise<unknown>[]);
  },
};
(globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;

// ── dynamic imports (env + globalThis stubs must precede the module graph) ───
const { NextRequest } = await import("next/server");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { DISCORD_SLASH_COMMANDS, DISCORD_LINK_TOKEN_LENGTH } = await import("../src/lib/discord-commands.ts");
const registerCommands = await import("../src/app/api/discord/register-commands/route.ts");
const settingsRoute = await import("../src/app/api/settings/route.ts");

// ── fixtures ────────────────────────────────────────────────────────────────
const BOT_TOKEN = "a-bot-token";
// 18-digit snowflakes: the settings route rejects anything outside 17–20 digits.
const CLIENT_ID = "123456789012345678";
const GUILD_ID = "987654321098765432";

let seq = 0;
async function mintAdmin(): Promise<Record<string, string>> {
  seq++;
  const userId = `actor-${seq}`;
  const sessionId = `actor-sess-${seq}`;
  usersById.set(userId, {
    id: userId, role: "ADMIN", permissions: 0n, name: `Actor ${seq}`, email: "admin@example.com",
    mediaServer: null, notificationEmail: null,
    sessionsRevokedAt: null, passwordChangedAt: null, deactivatedAt: null,
  });
  authSessionsById.set(sessionId, { userId });
  const token = await signSessionJwt(
    { id: userId, role: "ADMIN", permissions: "0", provider: "credentials", sessionId, expiresAt: Math.floor(Date.now() / 1000) + 86_400 },
    { expiresInSeconds: 7_200 },
  );
  return { authorization: `Bearer ${token}` };
}

// The settings re-registration is deliberately fire-and-forget (a `void` IIFE
// several awaits deep), so a single setImmediate is not enough to observe it.
async function waitForPuts(count: number, timeoutTurns = 50): Promise<void> {
  for (let i = 0; i < timeoutTurns && commandPuts.length < count; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

// Both paths run ONCE, here: the settings route enforces a module-private 10s
// per-key write cooldown, so a second PATCH of discordGuildId in this file would
// 429. Every test below reads these two captured payloads.
let manualPut: PutCall;
let settingsPut: PutCall;

before(async () => {
  // Configured Discord bot, guild-scoped — so both paths target the same URL and
  // any difference in the captured calls is a difference in what they publish.
  settings.set("discordBotToken", BOT_TOKEN);
  settings.set("discordClientId", CLIENT_ID);
  settings.set("discordGuildId", GUILD_ID);

  // Path 1 — the admin "Register commands" button.
  const manualRes = await registerCommands.POST(
    new NextRequest("http://localhost:3000/api/discord/register-commands", { method: "POST", headers: await mintAdmin() }),
    undefined,
  );
  assert.equal(manualRes.status, 200, "manual registration should succeed in this harness");
  assert.equal(commandPuts.length, 1, "manual registration should publish exactly one command PUT");
  manualPut = commandPuts[0];

  // Path 2 — a settings save that CHANGES a registration input. The route only
  // re-registers on a real change to discordBotToken/discordClientId/discordGuildId
  // (the form posts every field on every save, so a presence gate fired the
  // bulk-overwrite PUT on unrelated Channels/Roles saves). Park a stale guild id
  // so the PATCH below is a genuine change back to GUILD_ID — both paths still
  // end up publishing to the same guild-scoped URL.
  settings.set("discordGuildId", "111111111111111111");
  const patchRes = await settingsRoute.PATCH(
    new NextRequest("http://localhost:3000/api/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...(await mintAdmin()) },
      body: JSON.stringify({ discordGuildId: GUILD_ID }),
    }),
    undefined,
  );
  assert.equal(patchRes.status, 200, "the settings write should succeed in this harness");
  await waitForPuts(2);
  assert.equal(commandPuts.length, 2, "a discord* settings change should re-register the commands");
  settingsPut = commandPuts[1];
});

// ════════════════════════════════════════════════════════════════════════════
// The regression: both paths publish the SAME schema
// ════════════════════════════════════════════════════════════════════════════

test("both registration paths publish byte-identical command JSON", () => {
  assert.equal(
    settingsPut.body,
    manualPut.body,
    "the settings-triggered re-registration must publish exactly what the manual button does",
  );
});

test("both paths publish the shared DISCORD_SLASH_COMMANDS definition verbatim", () => {
  const shared = JSON.parse(JSON.stringify(DISCORD_SLASH_COMMANDS));
  assert.deepEqual(JSON.parse(manualPut.body), shared);
  assert.deepEqual(JSON.parse(settingsPut.body), shared);
});

test("both paths PUT to the same commands endpoint on discord.com", () => {
  for (const [label, put] of [["manual", manualPut], ["settings", settingsPut]] as const) {
    assert.equal(put.method, "PUT", `${label}: registration is a full replace`);
    assert.equal(put.url.hostname, "discord.com", `${label}: allowedHosts`);
    assert.match(put.url.pathname, new RegExp(`/applications/${CLIENT_ID}/guilds/${GUILD_ID}/commands$`), label);
  }
  assert.equal(settingsPut.url.href, manualPut.url.href);
});

// ════════════════════════════════════════════════════════════════════════════
// The defect that motivated the shared module: a 20-char cap on a 32-char token
// ════════════════════════════════════════════════════════════════════════════

test("every path's /link token option accepts a real 32-character link token", () => {
  // Exactly what POST /api/discord/generate-link mints.
  const realToken = randomBytes(16).toString("hex").toUpperCase();
  assert.equal(realToken.length, 32, "generate-link mints 16 random bytes as hex");
  assert.equal(DISCORD_LINK_TOKEN_LENGTH, 32);

  for (const [label, put] of [["manual", manualPut], ["settings", settingsPut]] as const) {
    const commands = JSON.parse(put.body) as Array<{
      name: string;
      options?: Array<{ name: string; min_length?: number; max_length?: number }>;
    }>;
    const tokenOption = commands.find((c) => c.name === "link")?.options?.find((o) => o.name === "token");
    assert.ok(tokenOption, `${label}: /link must still declare a token option`);
    assert.equal(tokenOption.max_length, 32, `${label}: Discord rejects a longer value before the handler sees it`);
    assert.ok(
      tokenOption.max_length >= realToken.length,
      `${label}: max_length ${tokenOption.max_length} cannot fit a ${realToken.length}-char token`,
    );
    assert.ok(
      (tokenOption.min_length ?? 0) <= realToken.length,
      `${label}: min_length ${tokenOption.min_length} rejects a ${realToken.length}-char token`,
    );
  }
});

// ════════════════════════════════════════════════════════════════════════════
// Nothing else moved: the full published command set, pinned field by field
// ════════════════════════════════════════════════════════════════════════════

test("the published command set preserves every name, description and option", () => {
  const expected = [
    {
      name: "request",
      description: "Request a movie or TV show to be added to the library",
      options: [
        {
          name: "type",
          description: "Movie or TV show",
          type: 3,
          required: true,
          choices: [
            { name: "Movie", value: "movie" },
            { name: "TV Show", value: "tv" },
          ],
        },
        { name: "query", description: "Title to search for", type: 3, required: true, min_length: 1, max_length: 200 },
      ],
    },
    { name: "status", description: "Check the status of your recent media requests" },
    {
      name: "link",
      description: "Link your Discord account to your Summonarr account",
      options: [
        { name: "token", description: "Link token from your Profile page", type: 3, required: true, min_length: 1, max_length: 32 },
      ],
    },
  ];
  assert.deepEqual(JSON.parse(manualPut.body), expected);
  assert.deepEqual(JSON.parse(settingsPut.body), expected);
});

// ════════════════════════════════════════════════════════════════════════════
// Structural: the duplicate literal must not come back
// ════════════════════════════════════════════════════════════════════════════

test("both registration paths funnel through the shared helper — the schema lives in exactly ONE place", () => {
  // Both routes PUT via putDiscordCommands (src/lib/discord-register.ts), which
  // is the single module that references DISCORD_SLASH_COMMANDS for
  // registration — so neither route can inline (and drift) a copy.
  const routes = [
    join("src", "app", "api", "discord", "register-commands", "route.ts"),
    join("src", "app", "api", "settings", "route.ts"),
  ];
  for (const rel of routes) {
    const src = readFileSync(join(process.cwd(), rel), "utf-8");
    assert.match(
      src,
      /import \{[^}]*\bputDiscordCommands\b[^}]*\} from "@\/lib\/discord-register"/,
      `${rel} must register via the shared putDiscordCommands helper`,
    );
    assert.ok(
      !src.includes("max_length"),
      `${rel} declares an option constraint inline — that is how the /link cap drifted to 20`,
    );
    assert.ok(
      !src.includes("DISCORD_SLASH_COMMANDS"),
      `${rel} references the schema directly — it must go through the shared helper only`,
    );
  }
  // The shared helper is the one place the schema is referenced for registration.
  const helper = readFileSync(join(process.cwd(), "src", "lib", "discord-register.ts"), "utf-8");
  assert.match(
    helper,
    /import \{[^}]*\bDISCORD_SLASH_COMMANDS\b[^}]*\} from "@\/lib\/discord-commands"/,
    "the shared helper must import the single command definition",
  );
});

test("registration produced no error logs in this harness", () => {
  assert.deepEqual(errors, []);
  assert.deepEqual(warns, []);
});
