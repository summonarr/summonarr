// The shared "now available" marking pass (src/lib/available-marking.ts) behind
// the orchestrator's passes and the per-source Resync routes, plus the Resync
// helpers in src/lib/library-resync.ts. The routes' end-to-end behaviour is
// pinned in tests/sync-orchestrator-route.test.mts and tests/sync-routes.test.mts;
// this file pins the pieces on their own — the pure rules and the writes'
// shapes — over in-memory prisma tables.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { memoryTable } = await import("./_where.mts");
const {
  PENDING_SCOPE_MAX_TITLES,
  createRequesterCache,
  fallbackShouldNotify,
  flipToAvailable,
  inLibrary,
  keepVisibleOnInstance,
  markAvailableFromLibrary,
  readPendingRequests,
  splitByPreferredSource,
  withoutSonarrHeld,
} = await import("../src/lib/available-marking.ts");
const { parseLibrarySelection, reidentifiedJellyfinRows, resyncJobKey, resyncTarget, ownsEpisodeCache } = await import("../src/lib/library-resync.ts");

type Row = Record<string, unknown>;
const requestRows: Row[] = [];
const requestTable = memoryTable(requestRows);
const requestFindManyWheres: unknown[] = [];
const requestUpdateManys: Array<{ where?: Row; data: Row }> = [];
shadowPrismaModel(prisma, "mediaRequest", {
  findMany: async (args?: { where?: Row }) => {
    requestFindManyWheres.push(args?.where);
    return requestTable.findMany(args);
  },
  updateMany: async (args: { where?: Row; data: Row }) => {
    requestUpdateManys.push(args);
    return requestTable.updateMany(args);
  },
});
const userRows: Row[] = [];
const userFindManyIds: string[][] = [];
shadowPrismaModel(prisma, "user", {
  findMany: async (args: { where: { id: { in: string[] } } }) => {
    userFindManyIds.push(args.where.id.in);
    return userRows.filter((u) => args.where.id.in.includes(u.id as string));
  },
});
// clearDeletionVotesForTmdbs' writes (fire-and-forget behind an AVAILABLE flip).
shadowPrismaModel(prisma, "deletionVote", { deleteMany: async () => ({ count: 0 }) });
shadowPrismaModel(prisma, "setting", { deleteMany: async () => ({ count: 0 }) });
shadowPrismaClientMethod(prisma, "$transaction", async (arg: unknown) => (Array.isArray(arg) ? Promise.all(arg) : arg));
// The notifiedAvailable claim is raw SQL; counted, never won here.
let claimCalls = 0;
shadowPrismaClientMethod(prisma, "$queryRaw", async () => {
  claimCalls++;
  return [];
});

beforeEach(() => {
  requestRows.length = 0;
  requestFindManyWheres.length = 0;
  requestUpdateManys.length = 0;
  userRows.length = 0;
  userFindManyIds.length = 0;
  claimCalls = 0;
});

const pending = (id: string, over: Row = {}) => ({
  id, tmdbId: 1, mediaType: "MOVIE" as const, arrInstance: "", requestedBy: `u-${id}`,
  title: id, posterPath: null, notifiedAvailable: false, ...over,
});

// ── the marking pass ────────────────────────────────────────────────────────

test("the claim flag is RE-READ: a row claimed since the caller's snapshot flips without re-entering the claim", async () => {
  // The Resync routes used to trust the snapshot's notifiedAvailable. A row a
  // concurrent pass or webhook claimed meanwhile went to the claim, lost it, and
  // stayed APPROVED until the next run.
  requestRows.push({ id: "r1", status: "APPROVED", notifiedAvailable: true, availableAt: null, pendingNotifyAt: null });
  const snapshot = [pending("r1", { notifiedAvailable: false })];

  await markAvailableFromLibrary(snapshot, "plex", { requesters: createRequesterCache(), logScope: "test" });

  assert.equal(claimCalls, 0, "an already-claimed row never reaches the claim again");
  assert.equal(requestRows[0].status, "AVAILABLE", "…and is flipped forward instead");
  assert.deepEqual(userFindManyIds, [], "no requester read is needed for it");
});

test("flipToAvailable moves only PENDING/APPROVED rows forward, and onlyNotified also requires the burned claim", async () => {
  requestRows.push(
    { id: "a", status: "APPROVED", notifiedAvailable: false },
    { id: "b", status: "DECLINED", notifiedAvailable: true },
    { id: "c", status: "APPROVED", notifiedAvailable: true },
  );
  const rows = ["a", "b", "c"].map((id) => ({ id, tmdbId: 1, mediaType: "MOVIE" }));
  assert.equal(await flipToAvailable(rows, { onlyNotified: true }), 1);
  assert.deepEqual(requestUpdateManys[0].where, { id: { in: ["a", "b", "c"] }, notifiedAvailable: true, status: { in: ["PENDING", "APPROVED"] } });
  assert.deepEqual(requestRows.map((r) => r.status), ["APPROVED", "DECLINED", "AVAILABLE"], "a declined row is never resurrected; an unclaimed one keeps its claim");
  assert.equal(await flipToAvailable([]), 0, "nothing to flip issues no write");
  assert.equal(requestUpdateManys.length, 1);
});

// ── reads ───────────────────────────────────────────────────────────────────

test("readPendingRequests narrows to the titles seen, skips the read for none, and falls back past the scope cap", async () => {
  await readPendingRequests({ movieIds: [603, 603], tvIds: [1399] });
  assert.deepEqual(requestFindManyWheres.at(-1), {
    status: { in: ["PENDING", "APPROVED"] },
    OR: [{ mediaType: "MOVIE", tmdbId: { in: [603] } }, { mediaType: "TV", tmdbId: { in: [1399] } }],
  });

  requestFindManyWheres.length = 0;
  assert.deepEqual(await readPendingRequests({ movieIds: [], tvIds: [] }), []);
  assert.equal(requestFindManyWheres.length, 0, "no titles ⇒ no candidates ⇒ no query");

  const many = Array.from({ length: PENDING_SCOPE_MAX_TITLES + 1 }, (_, i) => i + 1);
  await readPendingRequests({ movieIds: many, tvIds: [] });
  assert.deepEqual(requestFindManyWheres.at(-1), { status: { in: ["PENDING", "APPROVED"] } }, "an oversized scope reads the whole backlog");
});

test("the requester cache reads each user once, in one batch per new set", async () => {
  userRows.push({ id: "u1", mediaServer: null, role: "USER", permissions: 0n, mediaServerGrants: null });
  const cache = createRequesterCache();
  await cache.load(["u1", "u1", "u-gone"]);
  await cache.load(["u1", "u-gone"]);
  assert.deepEqual(userFindManyIds, [["u1", "u-gone"]], "a user — found or not — is read at most once per run");
  assert.equal(cache.get("u1")?.id, "u1");
  assert.equal(cache.get("u-gone"), undefined);
});

test("keepVisibleOnInstance: a restricted server keeps only granted requesters and fails CLOSED on a vanished one; an open one reads nothing", async () => {
  userRows.push(
    { id: "u-granted", mediaServer: null, role: "USER", permissions: 0n, mediaServerGrants: { plex: { remote: { view: true } } } },
    { id: "u-none", mediaServer: null, role: "USER", permissions: 0n, mediaServerGrants: {} },
    { id: "u-admin", mediaServer: null, role: "ADMIN", permissions: 0n, mediaServerGrants: {} },
  );
  const rows = ["u-granted", "u-none", "u-admin", "u-vanished"].map((u) => ({ requestedBy: u }));
  const kept = await keepVisibleOnInstance(rows, { slug: "remote", restricted: true }, "plex", createRequesterCache());
  assert.deepEqual(kept.map((r) => r.requestedBy), ["u-granted", "u-admin"], "a legacy ADMIN row (permissions 0) is gated by its role");

  userFindManyIds.length = 0;
  assert.equal(await keepVisibleOnInstance(rows, { slug: "", restricted: false }, "plex", createRequesterCache()), rows);
  assert.deepEqual(userFindManyIds, [], "an unrestricted server costs no read");
});

// ── pure rules ──────────────────────────────────────────────────────────────

test("splitByPreferredSource: no preference or this source notifies; the OTHER source only flips", () => {
  const prefs = new Map([["u-plex", { mediaServer: "plex" }], ["u-jf", { mediaServer: "jellyfin" }], ["u-none", { mediaServer: null }]]);
  const rows = ["u-plex", "u-jf", "u-none", "u-unknown"].map((requestedBy) => ({ requestedBy }));
  const { toNotify, toMarkOnly } = splitByPreferredSource(rows, "plex", prefs);
  assert.deepEqual(toNotify.map((r) => r.requestedBy), ["u-plex", "u-none", "u-unknown"]);
  assert.deepEqual(toMarkOnly.map((r) => r.requestedBy), ["u-jf"]);
});

test("inLibrary + withoutSonarrHeld: presence by type, dropped ids excluded, and only a TV request on its OWN instance is held", () => {
  const reqs = [
    { id: "m", tmdbId: 10, mediaType: "MOVIE", arrInstance: "" },
    { id: "m-dropped", tmdbId: 11, mediaType: "MOVIE", arrInstance: "" },
    { id: "t-held", tmdbId: 20, mediaType: "TV", arrInstance: "" },
    { id: "t-anime", tmdbId: 20, mediaType: "TV", arrInstance: "anime" },
    { id: "t-absent", tmdbId: 21, mediaType: "TV", arrInstance: "" },
  ];
  const present = inLibrary(reqs, { movieIds: new Set([10, 11]), tvIds: new Set([20]) }, { movieIds: new Set([11]) });
  assert.deepEqual(present.map((r) => r.id), ["m", "t-held", "t-anime"]);
  assert.deepEqual(withoutSonarrHeld(present, new Set(["20:"])).map((r) => r.id), ["m", "t-anime"]);
});

test("fallbackShouldNotify: presence for the preferred source, or the fallback when it can prove nothing", () => {
  const base = { inPlex: false, inJellyfin: false, plexUnusable: false, jellyfinUnusable: false };
  // No preference: either server, or neither can prove anything.
  assert.equal(fallbackShouldNotify({ ...base, preferred: null, inJellyfin: true }), true);
  assert.equal(fallbackShouldNotify({ ...base, preferred: null }), false);
  assert.equal(fallbackShouldNotify({ ...base, preferred: null, plexUnusable: true, jellyfinUnusable: true }), true);
  // Plex-pinned: Plex, else (Plex unusable AND Jellyfin has it or is unusable too).
  assert.equal(fallbackShouldNotify({ ...base, preferred: "plex", inJellyfin: true }), false, "a working Plex's absence blocks the notify");
  assert.equal(fallbackShouldNotify({ ...base, preferred: "plex", inJellyfin: true, plexUnusable: true }), true);
  assert.equal(fallbackShouldNotify({ ...base, preferred: "plex", plexUnusable: true }), false);
  // Jellyfin-pinned mirrors it; an unknown preference never notifies.
  assert.equal(fallbackShouldNotify({ ...base, preferred: "jellyfin", inPlex: true, jellyfinUnusable: true }), true);
  assert.equal(fallbackShouldNotify({ ...base, preferred: "jellyfin", inPlex: true }), false);
  assert.equal(fallbackShouldNotify({ ...base, preferred: "emby", inPlex: true, inJellyfin: true }), false);
});

// ── the Resync helpers ──────────────────────────────────────────────────────

test("parseLibrarySelection: unset or empty is every library; keys are trimmed", () => {
  assert.equal(parseLibrarySelection(null), undefined);
  assert.equal(parseLibrarySelection(""), undefined);
  assert.equal(parseLibrarySelection(" , ,"), undefined, "an all-blank list selects nothing, so it means every library");
  assert.deepEqual([...parseLibrarySelection(" 1, 2 ,,3")!], ["1", "2", "3"]);
});

test("resyncTarget: only `full: true` is a full replace, and a malformed slug is refused, never coerced", () => {
  assert.deepEqual(resyncTarget({}), { recentOnly: true, instance: "" });
  assert.deepEqual(resyncTarget({ full: "true" }), { recentOnly: true, instance: "" });
  assert.deepEqual(resyncTarget({ full: true, instance: "remote" }), { recentOnly: false, instance: "remote" });
  assert.equal(resyncTarget({ instance: "Not A Slug!" }), null);
  assert.equal(resyncJobKey("plex", { full: true, instance: "remote" }), resyncJobKey("plex", { instance: "remote", full: true, async: true }));
  assert.notEqual(resyncJobKey("plex", { full: true }), resyncJobKey("jellyfin", { full: true }));
});

test("ownsEpisodeCache: a Resync owns the shared episode cache only as the sole registered server", () => {
  assert.equal(ownsEpisodeCache(1), true);
  assert.equal(ownsEpisodeCache(2), false);
});

test("reidentifiedJellyfinRows: a row is stale only when EVERY copy it holds arrived under another title", () => {
  const incoming = new Set(["a", "b"]);
  const rows = [
    { tmdbId: 1, jellyfinItemId: "a", jellyfinItemIds: ["a"] },
    { tmdbId: 2, jellyfinItemId: "b", jellyfinItemIds: ["b", "z"] },
    { tmdbId: 3, jellyfinItemId: "a", jellyfinItemIds: [] }, // a row from before jellyfinItemIds existed
    { tmdbId: 4, jellyfinItemId: null, jellyfinItemIds: [] },
  ];
  assert.deepEqual(reidentifiedJellyfinRows(rows, incoming).map((r) => r.tmdbId), [1, 3]);
});
