// The System tab's "Current shares" tile (src/app/(app)/settings/_tabs/current-shares.ts):
// every Plex and Jellyfin server the library sync uses — default AND named
// (guardrail 35) — not just the default instance's keys. Plex accounts are
// counted once across servers (plex.tv ids are global); Jellyfin servers each
// keep their own users, so they add up.
//
// No DB, no network: globalThis.prisma is an in-memory Setting store seeded
// before the module graph loads, fetch is scripted, server URLs are RFC1918
// literals (no DNS for admin-configured hosts) and dns.lookup answers plex.tv
// with a public address.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.TRUST_PROXY = "true";

const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

const settings = new Map<string, string>();
(globalThis as unknown as { prisma: unknown }).prisma = {
  setting: {
    findUnique: async (args: { where: { key: string } }) => {
      const value = settings.get(args.where.key);
      return value === undefined ? null : { key: args.where.key, value };
    },
    findMany: async (args?: { where?: { key?: { in?: string[] } } }) => {
      const only = args?.where?.key?.in;
      return [...settings].filter(([k]) => !only || only.includes(k)).map(([key, value]) => ({ key, value }));
    },
  },
};

type Call = { url: URL; token: string | null };
const calls: Call[] = [];
let respond: (call: Call) => Response = (c) => { throw new Error(`unexpected fetch ${c.url}`); };
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const call = { url: new URL(String(input)), token: new Headers(init?.headers).get("X-Plex-Token") };
  calls.push(call);
  return respond(call);
}) as typeof fetch;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const xml = (body: string) => new Response(body, { status: 200, headers: { "content-type": "application/xml" } });
const users = (rows: Array<[id: string, machine: string]>) =>
  xml(`<MediaContainer>${rows.map(([id, m]) => `<User id="${id}" title="u${id}"><Server machineIdentifier="${m}"/></User>`).join("")}</MediaContainer>`);

const { combineShareCounts, countCurrentShares } = await import("../src/app/(app)/settings/_tabs/current-shares.ts");
const { plexSettingKey, jellyfinSettingKey } = await import("../src/lib/media-instances.ts");

beforeEach(() => {
  settings.clear();
  calls.length = 0;
  respond = (c) => { throw new Error(`unexpected fetch ${c.url}`); };
});

function plexServer(slug: string, url: string, token: string) {
  settings.set(plexSettingKey(slug, "ServerUrl"), url);
  settings.set(plexSettingKey(slug, "AdminToken"), token);
}
function jellyfinServer(slug: string, url: string, apiKey: string) {
  settings.set(jellyfinSettingKey(slug, "Url"), url);
  settings.set(jellyfinSettingKey(slug, "ApiKey"), apiKey);
}

test("combineShareCounts: plex.tv accounts once across servers, owners included; Jellyfin servers add up", () => {
  assert.equal(combineShareCounts([{ friends: new Set(["1", "2"]), ownerId: null }], []), 3, "one token: its friends + the owner");
  assert.equal(
    combineShareCounts([{ friends: new Set(["1", "2"]), ownerId: "100" }, { friends: new Set(["2", "100"]), ownerId: "200" }], []),
    4,
    "a friend of both servers counts once, and an owner who is a friend on the other server too",
  );
  assert.equal(combineShareCounts([null, { friends: new Set(["5"]), ownerId: "6" }], [null, 4]), 6, "a server that didn't answer adds nothing");
  assert.equal(combineShareCounts([], [3, 2]), 5);
  assert.equal(combineShareCounts([null], [null]), null, "nothing answered: no number");
});

test("every syncable server counts — a named Plex and a named Jellyfin server beside the defaults", async () => {
  settings.set("plexInstances", JSON.stringify([{ slug: "remote", name: "Remote" }]));
  settings.set("jellyfinInstances", JSON.stringify([{ slug: "den", name: "Den" }]));
  plexServer("", "http://10.1.0.1:32400", "tokA");
  plexServer("remote", "http://10.1.0.2:32400", "tokB");
  jellyfinServer("", "http://10.1.0.3:8096", "k1");
  jellyfinServer("den", "http://10.1.0.4:8096", "k2");
  respond = ({ url, token }) => {
    if (url.pathname === "/identity") return json({ MediaContainer: { machineIdentifier: url.hostname === "10.1.0.1" ? "mA" : "mB" } });
    if (url.hostname === "plex.tv" && url.pathname === "/api/users") {
      return token === "tokA" ? users([["7", "mA"], ["8", "mA"], ["9", "mX"]]) : users([["8", "mB"], ["100", "mB"]]);
    }
    if (url.hostname === "plex.tv" && url.pathname === "/api/v2/user") {
      return json({ id: token === "tokA" ? 100 : 200, email: `${token}@example.com`, username: token });
    }
    if (url.pathname === "/Users") return json(url.hostname === "10.1.0.3" ? [{}, {}, {}] : [{}, {}]);
    throw new Error(`unexpected fetch ${url}`);
  };
  // Plex: 7, 8 and owner A (100, also B's friend), and owner B (200) — 4.
  // Jellyfin: 3 + 2. The other server's friend (9) is not counted.
  assert.equal(await countCurrentShares(), 9);
});

test("a named server alone still counts (the default's keys are blank)", async () => {
  settings.set("plexInstances", JSON.stringify([{ slug: "remote", name: "Remote" }]));
  plexServer("remote", "http://10.1.0.5:32400", "tokC");
  respond = ({ url }) => {
    if (url.pathname === "/identity") return json({ MediaContainer: { machineIdentifier: "mC" } });
    if (url.hostname === "plex.tv" && url.pathname === "/api/users") return users([["7", "mC"], ["8", "mC"]]);
    throw new Error(`unexpected fetch ${url}`);
  };
  assert.equal(await countCurrentShares(), 3, "two friends and the owner");
  assert.equal(calls.filter((c) => c.url.pathname === "/api/v2/user").length, 0, "one token: the owner is not looked up");
});

test("two servers on one admin token read plex.tv's friends list once", async () => {
  settings.set("plexInstances", JSON.stringify([{ slug: "remote", name: "Remote" }]));
  plexServer("", "http://10.1.0.6:32400", "same");
  plexServer("remote", "http://10.1.0.7:32400", "same");
  respond = ({ url }) => {
    if (url.pathname === "/identity") return json({ MediaContainer: { machineIdentifier: url.hostname === "10.1.0.6" ? "m6" : "m7" } });
    if (url.hostname === "plex.tv" && url.pathname === "/api/users") return users([["1", "m6"], ["2", "m7"], ["3", "mZ"]]);
    throw new Error(`unexpected fetch ${url}`);
  };
  assert.equal(await countCurrentShares(), 3, "a friend of either server, plus the one owner");
  assert.equal(calls.filter((c) => c.url.pathname === "/api/users").length, 1);
});

test("no number when no server answers, and none configured", async () => {
  assert.equal(await countCurrentShares(), null, "nothing configured");
  plexServer("", "http://10.1.0.8:32400", "tokD");
  jellyfinServer("", "http://10.1.0.9:8096", "k");
  respond = () => new Response("down", { status: 503 });
  assert.equal(await countCurrentShares(), null);
});
