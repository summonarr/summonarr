// Admin → Activity → Users checks a Plex row against ITS OWN server.
//
// Why: MediaServerUser rows are per server instance, but the page's
// Active/Removed filter checked every Plex row against getCachedPlexAllowlist —
// the UNION of every Plex server's share list (right for the sign-in gate,
// guardrail 35). A friend unshared from server B but still shared on A kept
// their B row under "Active" and never showed under "Removed".
//
// Pinned: getCachedPlexMembersByInstance (src/lib/plex-membership.ts) hands back
// each instance's own set from the SAME caches (no extra plex.tv call), leaves
// out an instance it can't read without poisoning the others (the union's
// poison rule is unchanged); the page's plexOnServer (cut from page.tsx, types
// stripped) answers per row from its own server; and the page reads the
// per-instance sets, never the union.
//
// No DB, network or DNS: prisma is a findUnique-only fake on globalThis, fetch
// is scripted per URL (the server's /identity, then plex.tv/api/users keyed on
// the token), dns.lookup is stubbed for the plex.tv SSRF resolve.
import { test } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);

const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

const warns: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };

const A_URL = "http://203.0.113.10:32400";
const B_URL = "http://203.0.113.20:32400";
const C_URL = "http://203.0.113.30:32400";
const A_TOKEN = "a-plex-token";
const B_TOKEN = "b-plex-token";
const C_TOKEN = "c-plex-token";

let settings: Record<string, string | undefined> = {};
(globalThis as unknown as { prisma: unknown }).prisma = {
  setting: {
    findUnique: async (args: { where: { key: string } }) => {
      const value = settings[args.where.key];
      return value === undefined ? null : { key: args.where.key, value };
    },
  },
};

let usersCalls = 0;
const identity = (machine: string) =>
  new Response(JSON.stringify({ MediaContainer: { machineIdentifier: machine } }), { status: 200, headers: { "content-type": "application/json" } });
// <User id> is the plex.tv account id; each <Server> names a server it is shared on.
const usersXml = (users: Array<{ id: number; machines: string[] }>) =>
  `<?xml version="1.0"?><MediaContainer size="${users.length}">${users
    .map((u) => `<User id="${u.id}" title="u${u.id}" email="u${u.id}@example.com">${u.machines.map((m) => `<Server machineIdentifier="${m}"/>`).join("")}</User>`)
    .join("")}</MediaContainer>`;
// Friend 101 is shared on A only (unshared from B); 102 on both.
const FRIENDS = usersXml([{ id: 101, machines: ["machine-a"] }, { id: 102, machines: ["machine-a", "machine-b"] }]);

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith(`${A_URL}/identity`)) return identity("machine-a");
  if (url.startsWith(`${B_URL}/identity`)) return identity("machine-b");
  if (url.startsWith(`${C_URL}/identity`)) throw new Error("server C is down");
  if (url.startsWith("https://plex.tv/api/users")) {
    usersCalls++;
    const token = new Headers(init?.headers).get("x-plex-token");
    if (token === A_TOKEN || token === B_TOKEN) return new Response(FRIENDS, { status: 200, headers: { "content-type": "application/xml" } });
    throw new Error(`unexpected plex.tv token ${token}`);
  }
  throw new Error(`unexpected fetch to ${url}`);
}) as typeof fetch;

const registry = (...slugs: string[]) => JSON.stringify(slugs.map((slug) => ({ slug, name: slug })));
settings = {
  plexServerUrl: A_URL,
  plexAdminToken: A_TOKEN,
  plexInstances: registry("b"),
  plexBServerUrl: B_URL,
  plexBAdminToken: B_TOKEN,
};

const { getCachedPlexAllowlist, getCachedPlexMembersByInstance } = await import("../src/lib/plex-membership.ts");

const here = dirname(fileURLToPath(import.meta.url));
const PAGE = readFileSync(join(here, "../src/app/(app)/admin/activity/users/page.tsx"), "utf8");
type Members = Map<string, { ids: Set<string>; emails: Set<string> }> | null;
type Row = { active: boolean; isServerAdmin: boolean; serverInstance: string; sourceUserId: string };
const plexOnServer = (() => {
  const start = PAGE.indexOf("function plexOnServer(");
  assert.ok(start >= 0, "plexOnServer is in the users page");
  const end = PAGE.indexOf("\n}\n", start);
  return new Function(`${stripTypeScriptTypes(PAGE.slice(start, end + 2))}\nreturn plexOnServer;`)() as (u: Row, m: Members) => boolean;
})();
const row = (serverInstance: string, sourceUserId: string, extra: Partial<Row> = {}): Row => ({ active: true, isServerAdmin: false, serverInstance, sourceUserId, ...extra });

test("each instance's OWN members, from the same caches the union is built from — no extra plex.tv call", async () => {
  const union = await getCachedPlexAllowlist();
  assert.deepEqual([...(union?.ids ?? [])].sort(), ["101", "102"], "the union (sign-in gate) still has both");
  const callsAfterUnion = usersCalls;
  assert.equal(callsAfterUnion, 2, "one plex.tv read per instance");
  const byInstance = await getCachedPlexMembersByInstance();
  assert.ok(byInstance);
  assert.deepEqual([...byInstance.keys()].sort(), ["", "b"]);
  assert.deepEqual([...byInstance.get("")!.ids].sort(), ["101", "102"]);
  assert.deepEqual([...byInstance.get("b")!.ids], ["102"], "101 was unshared from B");
  assert.equal(usersCalls, callsAfterUnion, "served from the cache");
});

test("the Users page: a Plex row is on ITS OWN server's list, not the union", async () => {
  const byInstance = await getCachedPlexMembersByInstance();
  assert.equal(plexOnServer(row("b", "101"), byInstance), false, "unshared from B, still shared on A: Removed on B");
  assert.equal(plexOnServer(row("", "101"), byInstance), true);
  assert.equal(plexOnServer(row("b", "102"), byInstance), true);
  assert.equal(plexOnServer(row("b", "999", { isServerAdmin: true }), byInstance), true, "the server's owner is never on its share list");
  // A server with no list (removed — its rows were soft-deleted — or unreadable) falls back to `active`.
  assert.equal(plexOnServer(row("gone", "101", { active: false }), byInstance), false);
  assert.equal(plexOnServer(row("gone", "101"), byInstance), true);
  assert.equal(plexOnServer(row("b", "101", { active: false }), null), false, "no answer at all: `active`");
  assert.equal(plexOnServer(row("b", "101"), null), true);
});

test("a cold instance that can't be read is left out WITHOUT poisoning the others; the union's poison rule is unchanged", async () => {
  settings = { ...settings, plexInstances: registry("b", "c"), plexCServerUrl: C_URL, plexCAdminToken: C_TOKEN };
  const byInstance = await getCachedPlexMembersByInstance();
  assert.ok(byInstance);
  assert.deepEqual([...byInstance.keys()].sort(), ["", "b"], "C is absent: no answer for C's rows alone");
  assert.equal(plexOnServer(row("c", "101"), byInstance), true, "C's row falls back to `active`");
  assert.equal(plexOnServer(row("b", "101"), byInstance), false, "B still answers");
  assert.equal(await getCachedPlexAllowlist(), null, "the sign-in union still fails open on a cold unreadable instance");
});

test("structural: the Users page reads the per-instance sets, never the union", () => {
  assert.doesNotMatch(PAGE, /getCachedPlexAllowlist/);
  assert.match(PAGE, /await Promise\.all\(\[getCachedPlexMembersByInstance\(\), getCachedLiveJellyfinUsers\(\)\]\)/);
  assert.match(PAGE, /onServer: u\.source === "plex" \? plexOnServer\(u, plexMembers\) : jellyfinOnServer\(u, jellyfinLive\),/);
});
