// The Discord /status command's account gates: a deactivated account is told so
// (as /recent and /request tell it) instead of "no requests", and reads nothing;
// a linked account lists its own requests. No DB, no network: a fake prisma on
// globalThis, a scripted discord.com, stubbed DNS.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "discord-status-test-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;

const edits: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "discord.com" && url.pathname.endsWith("/messages/@original")) {
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { content?: string };
    edits.push(body.content ?? "");
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }
  throw new Error(`unexpected fetch ${url}`);
}) as typeof fetch;

type Row = { id: string; email: string; deactivatedAt: Date | null };
let user: Row | null = null;
let requestReads = 0;
(globalThis as unknown as { prisma: unknown }).prisma = {
  user: { findUnique: async () => (user ? { ...user } : null) },
  mediaRequest: {
    findMany: async () => {
      requestReads++;
      return [{ title: "Arrival", mediaType: "MOVIE", status: "PENDING", tmdbId: 329865, arrInstance: "" }];
    },
  },
  radarrWantedItem: { findMany: async () => [] },
  sonarrWantedItem: { findMany: async () => [] },
};

const { handleStatusCommand } = await import("../src/lib/discord-interactions/commands/status.ts");

const t = (key: string) => key;
function ctx(requireLinked: boolean) {
  return {
    interaction: {} as never,
    t: t as never,
    appId: "app",
    token: `tok-${Math.random()}`,
    interactionId: "i",
    discordUserId: "111111111111111111",
    discordUsername: undefined,
    data: { name: "status" },
    requireLinked,
    isExemptByRole: false,
  };
}

beforeEach(() => { edits.length = 0; requestReads = 0; user = null; });

test("a deactivated account is told it is deactivated and reads no requests", async () => {
  user = { id: "u1", email: "u1@example.com", deactivatedAt: new Date() };
  await handleStatusCommand(ctx(false));
  assert.deepEqual(edits, ["notify.bot.pick.deactivated"]);
  assert.equal(requestReads, 0);
});

test("a deactivated account is refused as deactivated even when a link is required", async () => {
  user = { id: "u1", email: "u1@example.com", deactivatedAt: new Date() };
  await handleStatusCommand(ctx(true));
  assert.deepEqual(edits, ["notify.bot.pick.deactivated"]);
});

test("a stranger's Discord id gets 'no requests', or the link prompt when a link is required", async () => {
  await handleStatusCommand(ctx(false));
  await handleStatusCommand(ctx(true));
  assert.deepEqual(edits, ["notify.bot.status.none", "notify.bot.linkRequired"]);
  assert.equal(requestReads, 0);
});

test("an active linked account lists its requests", async () => {
  user = { id: "u1", email: "u1@example.com", deactivatedAt: null };
  await handleStatusCommand(ctx(true));
  assert.equal(edits.length, 1);
  assert.match(edits[0], /Arrival/);
});
