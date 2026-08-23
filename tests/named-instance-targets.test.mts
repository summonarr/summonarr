// Unit tests for the shared named-instance target resolver
// (src/lib/named-instance-targets.ts) — the one place that decides which
// "Request on <instance>" buttons a viewer sees, for the movie page, the TV
// page and GET /api/requests/instances alike.
//
// The pin that matters most is the CONFIGURED filter. These three call sites had
// each open-coded the resolution, and two of them had already drifted apart: the
// pages enumerated getSyncableArrInstances (configured only) while the route
// used getArrInstances (every REGISTERED instance, configured or not). A button
// for an unconfigured instance can only ever fail — /api/requests rejects an
// unconfigured named slug with 400 — so the route was offering the native client
// a dead action the web correctly hid.
//
// Impurity: prisma.setting (registry JSON + per-instance url/apiKey presence),
// prisma.user (grants), prisma.mediaRequest + prisma.{radarr,sonarr}
// AvailableItem. All shadowed in-memory — no DB, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma.ts";
import { resolveNamedInstanceTargets } from "../src/lib/named-instance-targets.ts";
import { Permission } from "../src/lib/permissions.ts";
import { shadowPrismaModel } from "./_helpers.mts";

const registryValues = new Map<string, string>();
let configuredKeys = new Set<string>();
// Rows the two existence queries should return, as arrInstance slugs.
let requestSlugs: string[] = [];
let availableSlugs: string[] = [];
let grants: unknown = null;
// Every `arrInstance: { in: [...] }` list the resolver asked for — the query
// count is what proves it stayed at two reads rather than two PER instance.
const inLists: string[][] = [];

shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    const v = registryValues.get(args.where.key);
    return v !== undefined ? { key: args.where.key, value: v } : null;
  },
  findMany: async (args: { where: { key: { in: string[] } } }) =>
    args.where.key.in.filter((k) => configuredKeys.has(k)).map((k) => ({ key: k, value: "set" })),
});

shadowPrismaModel(prisma, "user", {
  findUnique: async () => ({ instanceGrants: grants }),
});

function existenceStub(source: () => string[]) {
  return {
    findMany: async (args: { where: { arrInstance: { in: string[] } } }) => {
      inLists.push(args.where.arrInstance.in);
      return source()
        .filter((s) => args.where.arrInstance.in.includes(s))
        .map((s) => ({ arrInstance: s }));
    },
  };
}

shadowPrismaModel(prisma, "mediaRequest", existenceStub(() => requestSlugs));
shadowPrismaModel(prisma, "radarrAvailableItem", existenceStub(() => availableSlugs));
shadowPrismaModel(prisma, "sonarrAvailableItem", existenceStub(() => availableSlugs));

function reset() {
  registryValues.clear();
  configuredKeys = new Set<string>();
  requestSlugs = [];
  availableSlugs = [];
  grants = null;
  inLists.length = 0;
}

// An open (non-restricted) named instance in the Radarr registry.
function registerAnime(opts: { configured: boolean; restricted?: boolean }) {
  registryValues.set(
    "arrRadarrInstances",
    JSON.stringify([{ slug: "anime", name: "Anime", restricted: opts.restricted ?? false }]),
  );
  if (opts.configured) configuredKeys = new Set(["radarrAnimeUrl", "radarrAnimeApiKey"]);
}

const requester = { tmdbId: 42, mediaType: "MOVIE" as const, userId: "u1", blacklisted: false };
const USER_PERMS = Permission.REQUEST | Permission.REQUEST_MOVIE | Permission.REQUEST_TV;

test("a REGISTERED but UNCONFIGURED named instance is never offered", async () => {
  reset();
  registerAnime({ configured: false });

  const targets = await resolveNamedInstanceTargets({ ...requester, permissions: USER_PERMS });

  // /api/requests would 400 this slug ("that instance isn't configured"), so a
  // button for it is a dead action. This is the exact drift the shared resolver
  // closed — the route used to enumerate every registered instance.
  assert.deepEqual(targets, []);
});

test("a configured named instance is offered, with its request/available state", async () => {
  reset();
  registerAnime({ configured: true });
  requestSlugs = ["anime"];
  availableSlugs = [];

  const targets = await resolveNamedInstanceTargets({ ...requester, permissions: USER_PERMS });

  assert.deepEqual(targets, [
    { slug: "anime", name: "Anime", requested: true, available: false },
  ]);
});

test("available state is read per instance, not conflated with requested", async () => {
  reset();
  registerAnime({ configured: true });
  requestSlugs = [];
  availableSlugs = ["anime"];

  const [target] = await resolveNamedInstanceTargets({ ...requester, permissions: USER_PERMS });
  assert.equal(target.requested, false);
  assert.equal(target.available, true);
});

test("the state lookup is TWO queries for N instances, not two per instance", async () => {
  reset();
  registryValues.set(
    "arrRadarrInstances",
    JSON.stringify([
      { slug: "anime", name: "Anime", restricted: false },
      { slug: "docs", name: "Docs", restricted: false },
      { slug: "kids", name: "Kids", restricted: false },
    ]),
  );
  configuredKeys = new Set([
    "radarrAnimeUrl", "radarrAnimeApiKey",
    "radarrDocsUrl", "radarrDocsApiKey",
    "radarrKidsUrl", "radarrKidsApiKey",
  ]);

  const targets = await resolveNamedInstanceTargets({ ...requester, permissions: USER_PERMS });

  assert.deepEqual(targets.map((t) => t.slug), ["anime", "docs", "kids"]);
  // Exactly one mediaRequest read and one radarrAvailableItem read, each
  // covering all three slugs at once.
  assert.equal(inLists.length, 2);
  for (const list of inLists) assert.deepEqual(list, ["anime", "docs", "kids"]);
});

test("a RESTRICTED instance is withheld without a grant and offered with one", async () => {
  reset();
  registerAnime({ configured: true, restricted: true });

  assert.deepEqual(
    await resolveNamedInstanceTargets({ ...requester, permissions: USER_PERMS }),
    [],
    "restricted + no grant ⇒ no button",
  );

  grants = { anime: { request: true } };
  const granted = await resolveNamedInstanceTargets({ ...requester, permissions: USER_PERMS });
  assert.deepEqual(granted.map((t) => t.slug), ["anime"]);
});

test("a blacklisted title yields no targets and issues no state queries", async () => {
  reset();
  registerAnime({ configured: true });

  const targets = await resolveNamedInstanceTargets({
    ...requester,
    permissions: USER_PERMS,
    blacklisted: true,
  });

  assert.deepEqual(targets, []);
  assert.equal(inLists.length, 0, "blacklisted short-circuits before any lookup");
});

test("the default and legacy 4K instances are never enumerated here", async () => {
  reset();
  // Default is always synthesized; 4K is synthesized when configured.
  configuredKeys = new Set(["radarr4kUrl", "radarr4kApiKey", "radarrUrl", "radarrApiKey"]);

  const targets = await resolveNamedInstanceTargets({
    ...requester,
    permissions: USER_PERMS | Permission.ADMIN,
  });

  // Both have their own dedicated buttons on the media payload; duplicating them
  // here would give callers two sources of truth for the same action.
  assert.deepEqual(targets, []);
});

test("TV resolves against Sonarr's registry, not Radarr's", async () => {
  reset();
  registerAnime({ configured: true }); // radarr only
  const asTv = await resolveNamedInstanceTargets({
    ...requester,
    mediaType: "TV",
    permissions: USER_PERMS,
  });
  assert.deepEqual(asTv, [], "the Radarr registry must not leak into a TV lookup");

  registryValues.set(
    "arrSonarrInstances",
    JSON.stringify([{ slug: "anime", name: "Anime TV", restricted: false }]),
  );
  configuredKeys.add("sonarrAnimeUrl");
  configuredKeys.add("sonarrAnimeApiKey");
  const found = await resolveNamedInstanceTargets({
    ...requester,
    mediaType: "TV",
    permissions: USER_PERMS,
  });
  assert.deepEqual(found.map((t) => t.name), ["Anime TV"]);
});
