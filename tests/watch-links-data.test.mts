// Unit tests for loadWatchLinks (src/lib/watch-links-data.ts, guardrail 35b):
// a link exists only for a server the viewer may see, whose chip is shown,
// whose identity the sync has stored — and it carries ids and the browser
// address only. Plus the identity stamper (src/lib/media-server-identity.ts).
// In-memory prisma stubs; fetch is scripted; no DB, no real network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto
process.env.NEXTAUTH_SECRET = "watch-links-data-secret-0123456789abcdef";
process.env.TRUST_PROXY = "true";

const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) {
  throw new Error("could not stub dns.lookup — aborting before a real DNS query can leave the process");
}

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const { loadWatchLinks } = await import("../src/lib/watch-links-data.ts");

const MACHINE = "0123456789abcdef0123456789abcdef01234567";
const MACHINE_B = "76543210fedcba9876543210fedcba9876543210";
const JF_SERVER = "f0e1d2c3b4a5968778695a4b3c2d1e0f";
const JF_ITEM = "aabbccddeeff00112233445566778899";

type Where = { tmdbId: number; mediaType: string; serverInstance: { in: string[] } };
let settings: Record<string, string> = {};
let plexRows: Array<Record<string, unknown>> = [];
let jellyfinRows: Array<Record<string, unknown>> = [];
let libraryCalls: Array<{ model: string; where: Where; select: Record<string, boolean> }> = [];
let settingWrites: Array<{ key: string; value: string }> = [];
let viewer: { id: string; plexUserId: string | null; jellyfinUserId: string | null } | null = null;
let serverUsers: Array<{ id: string; source: string; serverInstance: string; sourceUserId: string; userId: string | null; manualUserLink: boolean; active: boolean }> = [];
let identityReads = 0;

beforeEach(() => {
  viewer = null;
  serverUsers = [];
  identityReads = 0;
  settings = {};
  plexRows = [];
  jellyfinRows = [];
  libraryCalls = [];
  settingWrites = [];
});

shadowPrismaModel(prisma, "setting", {
  findUnique: async ({ where }: { where: { key: string } }) =>
    where.key in settings ? { key: where.key, value: settings[where.key] } : null,
  findMany: async ({ where }: { where: { key: { in: string[] } } }) =>
    where.key.in.filter((k) => k in settings).map((k) => ({ key: k, value: settings[k] })),
  upsert: async ({ where, create }: { where: { key: string }; create: { key: string; value: string } }) => {
    settings[where.key] = create.value;
    settingWrites.push({ key: where.key, value: create.value });
    return create;
  },
});
shadowPrismaModel(prisma, "user", {
  findUnique: async () => {
    identityReads++;
    return viewer;
  },
});
type Branch = { userId?: string; source?: string; sourceUserId?: string; manualUserLink?: boolean };
shadowPrismaModel(prisma, "mediaServerUser", {
  findMany: async ({ where }: { where: { source: string; active: boolean; serverInstance: { in: string[] }; OR: Branch[] } }) =>
    serverUsers
      .filter((r) => r.source === where.source && r.active === where.active && where.serverInstance.in.includes(r.serverInstance))
      .filter((r) => where.OR.some((b) => Object.entries(b).every(([k, v]) => (r as Record<string, unknown>)[k] === v)))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((r) => ({ serverInstance: r.serverInstance, sourceUserId: r.sourceUserId })),
});
for (const [model, rows] of [["plexLibraryItem", () => plexRows], ["jellyfinLibraryItem", () => jellyfinRows]] as const) {
  shadowPrismaModel(prisma, model, {
    findMany: async ({ where, select }: { where: Where; select: Record<string, boolean> }) => {
      libraryCalls.push({ model, where, select });
      return rows()
        .filter((r) => r.tmdbId === where.tmdbId && r.mediaType === where.mediaType && where.serverInstance.in.includes(r.serverInstance as string))
        .map((r) => Object.fromEntries(Object.keys(select).map((k) => [k, r[k]])));
    },
  });
}

const BOTH = { showPlex: true, showJellyfin: true };
const plexRow = (serverInstance: string, plexRatingKey: string | null, plexRatingKeys: string[] = []) =>
  ({ tmdbId: 550, mediaType: "MOVIE", serverInstance, plexRatingKey, plexRatingKeys, filePath: "/mnt/secret/Fight Club.mkv" });
const jellyfinRow = (serverInstance: string, jellyfinItemId: string | null, jellyfinItemIds: string[] = []) =>
  ({ tmdbId: 550, mediaType: "MOVIE", serverInstance, jellyfinItemId, jellyfinItemIds, filePath: "/mnt/secret/Fight Club.mkv" });

test("a title on the default Plex and Jellyfin servers gets one link each", async () => {
  plexRows = [plexRow("", "12345")];
  jellyfinRows = [jellyfinRow("", JF_ITEM)];
  settings = { plexMachineId: MACHINE, jellyfinServerId: JF_SERVER, jellyfinUrl: "http://10.0.0.5:8096", jellyfinWebAddress: "https://watch.example.com" };
  const links = await loadWatchLinks({ plex: [""], jellyfin: [""] }, 550, "MOVIE", BOTH);
  assert.deepEqual(links, [
    {
      server: "plex",
      name: null,
      webUrl: `https://app.plex.tv/desktop/#!/server/${MACHINE}/details?key=%2Flibrary%2Fmetadata%2F12345`,
      appUrl: `plex://libraries/${MACHINE}/unmatched/%2Flibrary%2Fmetadata%2F12345`,
    },
    {
      server: "jellyfin",
      name: null,
      webUrl: `https://watch.example.com/web/index.html#/details?id=${JF_ITEM}&serverId=${JF_SERVER}`,
      appUrl: null,
    },
  ]);
});

test("the library read is scoped to the viewer's visible servers and never selects the path", async () => {
  // Held ONLY on a restricted server the viewer has no grant for.
  plexRows = [plexRow("family", "777")];
  settings = { plexFamilyMachineId: MACHINE_B };
  const links = await loadWatchLinks({ plex: [""], jellyfin: [""] }, 550, "MOVIE", BOTH);
  assert.deepEqual(links, []);
  assert.equal(libraryCalls.length, 2);
  for (const call of libraryCalls) {
    assert.deepEqual(call.where.serverInstance, { in: [""] });
    assert.equal("filePath" in call.select, false);
  }
  assert.equal(JSON.stringify(links).includes("secret"), false);
});

test("a granted viewer gets the restricted server's link, named beside the default's", async () => {
  plexRows = [plexRow("family", "777"), plexRow("", "12345")];
  settings = {
    plexMachineId: MACHINE,
    plexFamilyMachineId: MACHINE_B,
    plexInstances: JSON.stringify([{ slug: "family", name: "Family", restricted: true }]),
  };
  const links = await loadWatchLinks({ plex: ["", "family"], jellyfin: [] }, 550, "MOVIE", BOTH);
  assert.deepEqual(links.map((l) => [l.name, l.webUrl.includes(MACHINE_B)]), [["Default", false], ["Family", true]]);
  // The slug itself is never on the wire.
  assert.equal(JSON.stringify(links).includes("family"), false);
});

test("a server whose identity the sync has not stored yet yields no link", async () => {
  plexRows = [plexRow("", "12345")];
  jellyfinRows = [jellyfinRow("", JF_ITEM)];
  settings = { jellyfinUrl: "http://10.0.0.5:8096" };
  assert.deepEqual(await loadWatchLinks({ plex: [""], jellyfin: [""] }, 550, "MOVIE", BOTH), []);
});

test("Jellyfin falls back to the connection URL, and has no link without a usable address", async () => {
  jellyfinRows = [jellyfinRow("", JF_ITEM)];
  settings = { jellyfinServerId: JF_SERVER, jellyfinUrl: "http://10.0.0.5:8096/" };
  const [link] = await loadWatchLinks({ plex: [], jellyfin: [""] }, 550, "MOVIE", BOTH);
  assert.equal(link.webUrl, `http://10.0.0.5:8096/web/index.html#/details?id=${JF_ITEM}&serverId=${JF_SERVER}`);
  settings = { jellyfinServerId: JF_SERVER, jellyfinUrl: "http://user:pw@10.0.0.5:8096" };
  assert.deepEqual(await loadWatchLinks({ plex: [], jellyfin: [""] }, 550, "MOVIE", BOTH), []);
});

test("a hidden chip means no link and no library read for that server kind", async () => {
  plexRows = [plexRow("", "12345")];
  jellyfinRows = [jellyfinRow("", JF_ITEM)];
  settings = { plexMachineId: MACHINE, jellyfinServerId: JF_SERVER, jellyfinUrl: "http://jf.lan" };
  const links = await loadWatchLinks({ plex: [""], jellyfin: [""] }, 550, "MOVIE", { showPlex: false, showJellyfin: true });
  assert.deepEqual(links.map((l) => l.server), ["jellyfin"]);
  assert.deepEqual(libraryCalls.map((c) => c.model), ["jellyfinLibraryItem"]);
  libraryCalls = [];
  assert.deepEqual(await loadWatchLinks({ plex: [""], jellyfin: [""] }, 550, "MOVIE", { showPlex: false, showJellyfin: false }), []);
  assert.equal(libraryCalls.length, 0);
});

test("a row with no canonical id links its first listed copy; one with no id at all links nothing", async () => {
  plexRows = [plexRow("", null, ["901", "902"])];
  settings = { plexMachineId: MACHINE };
  const [link] = await loadWatchLinks({ plex: [""], jellyfin: [] }, 550, "MOVIE", BOTH);
  assert.ok(link.webUrl.endsWith("%2Flibrary%2Fmetadata%2F901"));
  plexRows = [plexRow("", null, [])];
  assert.deepEqual(await loadWatchLinks({ plex: [""], jellyfin: [] }, 550, "MOVIE", BOTH), []);
});

test("the media type is part of the read: a movie's row is not a show's link", async () => {
  plexRows = [plexRow("", "12345")];
  settings = { plexMachineId: MACHINE };
  assert.deepEqual(await loadWatchLinks({ plex: [""], jellyfin: [] }, 550, "TV", BOTH), []);
});

// ── the Jellyfin app link (Swiftfin) ────────────────────────────────────────
const JF_USER = "11112222333344445555666677778888";
const jfSettings = () => ({ jellyfinServerId: JF_SERVER, jellyfinUrl: "http://jf.lan" });
const serverUser = (over: Partial<(typeof serverUsers)[number]>) =>
  ({ id: "m1", source: "jellyfin", serverInstance: "", sourceUserId: JF_USER, userId: null, manualUserLink: false, active: true, ...over });

test("a viewer with a Jellyfin identity on the server gets the Swiftfin link beside the web one", async () => {
  jellyfinRows = [jellyfinRow("", JF_ITEM)];
  settings = jfSettings();
  viewer = { id: "u_1", plexUserId: null, jellyfinUserId: JF_USER };
  serverUsers = [serverUser({})];
  const [link] = await loadWatchLinks({ plex: [], jellyfin: [""] }, 550, "MOVIE", BOTH, "u_1");
  assert.equal(link.appUrl, `swiftfin://${JF_SERVER}/${JF_USER}/item/${JF_ITEM}`);
  assert.ok(link.webUrl.startsWith("http://jf.lan/web/index.html#/details"));
});

test("the Swiftfin link uses only the viewer's own active identity on THAT server", async () => {
  jellyfinRows = [jellyfinRow("", JF_ITEM)];
  settings = jfSettings();
  viewer = { id: "u_1", plexUserId: null, jellyfinUserId: null };
  const none = async () => (await loadWatchLinks({ plex: [], jellyfin: [""] }, 550, "MOVIE", BOTH, "u_1"))[0].appUrl;
  // Someone else's identity.
  serverUsers = [serverUser({ userId: "u_2" })];
  assert.equal(await none(), null);
  // The viewer's, but removed from the server.
  serverUsers = [serverUser({ userId: "u_1", active: false })];
  assert.equal(await none(), null);
  // The viewer's, on another server.
  serverUsers = [serverUser({ userId: "u_1", serverInstance: "remote" })];
  assert.equal(await none(), null);
  // A subject match an admin has pinned elsewhere is not the viewer's (guardrail 34).
  viewer = { id: "u_1", plexUserId: null, jellyfinUserId: JF_USER };
  serverUsers = [serverUser({ userId: "u_2", manualUserLink: true })];
  assert.equal(await none(), null);
  // An admin's manual link to the viewer is.
  serverUsers = [serverUser({ userId: "u_1", manualUserLink: true })];
  assert.equal(await none(), `swiftfin://${JF_SERVER}/${JF_USER}/item/${JF_ITEM}`);
});

test("no viewer, or no Jellyfin link, means no identity read at all", async () => {
  jellyfinRows = [jellyfinRow("", JF_ITEM)];
  plexRows = [plexRow("", "12345")];
  settings = { ...jfSettings(), plexMachineId: MACHINE };
  const [, jf] = await loadWatchLinks({ plex: [""], jellyfin: [""] }, 550, "MOVIE", BOTH);
  assert.equal(jf.appUrl, null);
  await loadWatchLinks({ plex: [""], jellyfin: [] }, 550, "MOVIE", BOTH, "u_1");
  assert.equal(identityReads, 0);
});

// ── the identity stamper ────────────────────────────────────────────────────
const { stampMediaServerIdentities, getJellyfinServerId } = await import("../src/lib/media-server-identity.ts");
test("getJellyfinServerId reads the server's Id and refuses an unusable answer", async () => {
  const answers: Array<() => Response> = [
    () => new Response(JSON.stringify({ Id: JF_SERVER, ServerName: "jf" }), { status: 200 }),
    () => new Response(JSON.stringify({ Id: "not an id!" }), { status: 200 }),
    () => new Response("nope", { status: 503 }),
    () => new Response("[]", { status: 200 }),
  ];
  const seen: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    seen.push(String(url));
    const next = answers.shift();
    if (!next) throw new Error("unexpected fetch");
    return next();
  }) as typeof fetch;
  try {
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await getJellyfinServerId("http://jf.example.com/"));
    assert.deepEqual(results, [JF_SERVER, null, null, null]);
    assert.equal(seen.length, 4);
    assert.ok(seen.every((u) => u === "http://jf.example.com/System/Info/Public"), seen.join(" "));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the stamper stores a changed identity once and keeps the stored one on a failed read", async () => {
  settings = { jellyfinUrl: "http://jf.example.com", jellyfinApiKey: "k" };
  const realFetch = globalThis.fetch;
  let fail = false;
  globalThis.fetch = (async () =>
    fail ? new Response("down", { status: 502 }) : new Response(JSON.stringify({ Id: JF_SERVER }), { status: 200 })) as typeof fetch;
  try {
    const targets = { plexInstances: [], jellyfinInstances: [{ slug: "" }] };
    await stampMediaServerIdentities(targets);
    await stampMediaServerIdentities(targets);
    assert.deepEqual(settingWrites, [{ key: "jellyfinServerId", value: JF_SERVER }]);
    fail = true;
    await stampMediaServerIdentities(targets);
    assert.equal(settings.jellyfinServerId, JF_SERVER);
    assert.equal(settingWrites.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the stamper never throws and writes nothing for an unconfigured server", async () => {
  await stampMediaServerIdentities({ plexInstances: [{ slug: "" }], jellyfinInstances: [{ slug: "" }] });
  assert.deepEqual(settingWrites, []);
});
