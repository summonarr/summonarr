// Unit tests for the per-request media-server visibility resolver
// (src/lib/media-visibility.ts): which Plex/Jellyfin instances a given viewer
// may see once servers can be marked `restricted`. A regression here either
// leaks a restricted server's library to everyone or blanks availability for
// legitimate viewers — and the same answer drives the request status that
// follows from it, so it is not a cosmetic surface.
//
// Impurity: prisma.setting.findUnique (the two registry blobs) +
// prisma.user.findUnique (the grants column). No local DB here, so both model
// delegates are shadowed with in-memory stubs (the tests/_helpers.mts idiom, as
// in tests/media-instance-registry.test.mts). No DB or network touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma.ts";
import { getVisibleServerInstances, visibleInstancesFor } from "../src/lib/media-visibility.ts";
import { Permission, type MediaServerGrants } from "../src/lib/permissions.ts";
import type { SummonarrSession } from "../src/lib/api-auth.ts";
import { shadowPrismaModel } from "./_helpers.mts";

const registryValues = new Map<string, string>();
// Grants JSON keyed by user id, plus a counter so the "skip the read when it
// can't change the answer" cost contract is pinned, not just assumed.
const userGrants = new Map<string, unknown>();
let userReads = 0;

shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    const v = registryValues.get(args.where.key);
    return v !== undefined ? { key: args.where.key, value: v } : null;
  },
});

shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id: string } }) => {
    userReads++;
    return userGrants.has(args.where.id)
      ? { mediaServerGrants: userGrants.get(args.where.id) }
      : { mediaServerGrants: null };
  },
});

function reset() {
  registryValues.clear();
  userGrants.clear();
  userReads = 0;
}

function session(id: string, permissions: bigint): SummonarrSession {
  return { user: { id, role: permissions === Permission.ADMIN ? "ADMIN" : "USER", permissions } };
}

// One restricted + one open named server on each service, so every test can
// distinguish "sees everything" from "sees only the unrestricted set".
function seedBothServices() {
  registryValues.set(
    "plexInstances",
    JSON.stringify([
      { slug: "remote", name: "Friend's", restricted: true },
      { slug: "open", name: "Shared", restricted: false },
    ]),
  );
  registryValues.set(
    "jellyfinInstances",
    JSON.stringify([{ slug: "remote", name: "Attic", restricted: true }]),
  );
}

test("no restricted servers → everyone sees every instance, with NO grants read", async () => {
  reset();
  registryValues.set("plexInstances", JSON.stringify([{ slug: "open", name: "Shared" }]));
  const v = await getVisibleServerInstances(session("u1", 0n));
  assert.deepEqual(v, { plex: ["", "open"], jellyfin: [""] });
  // Cost contract: the grants column cannot change this answer, so it must not
  // be read. This is every deployment that hasn't opted into restricted servers.
  assert.equal(userReads, 0, "no instance is restricted — the user row must not be read");
});

test("ADMIN sees every instance (superbit), with NO grants read", async () => {
  reset();
  seedBothServices();
  const v = await getVisibleServerInstances(session("admin", Permission.ADMIN));
  assert.deepEqual(v, { plex: ["", "remote", "open"], jellyfin: ["", "remote"] });
  assert.equal(userReads, 0, "ADMIN bypasses grants — the user row must not be read");
});

test("a null session sees UNRESTRICTED instances only", async () => {
  reset();
  seedBothServices();
  const v = await getVisibleServerInstances(null);
  // Restricted means "granted users only", and nobody can hold a grant without
  // an account, so anonymous is never more visible than the least-privileged
  // signed-in user. The default ("") is always present.
  assert.deepEqual(v, { plex: ["", "open"], jellyfin: [""] });
  assert.equal(userReads, 0, "no session — there is no user row to read");
});

test("an ungranted user does not see a restricted server; a granted one does", async () => {
  reset();
  seedBothServices();

  const ungranted = await getVisibleServerInstances(session("u1", 0n));
  assert.deepEqual(ungranted, { plex: ["", "open"], jellyfin: [""] });

  userGrants.set("u2", { plex: { remote: { view: true } } });
  const granted = await getVisibleServerInstances(session("u2", 0n));
  assert.deepEqual(granted, { plex: ["", "remote", "open"], jellyfin: [""] });

  // Both did consult the grants column — a restricted instance exists, so the
  // read is genuinely load-bearing here.
  assert.equal(userReads, 2);
});

test("grants are SERVICE-NAMESPACED: a plex grant never unlocks the jellyfin server of the same slug", async () => {
  reset();
  seedBothServices();
  // The headline pin for the nested { plex: {...}, jellyfin: {...} } shape.
  // Both services have a RESTRICTED instance whose slug is literally "remote",
  // but they are different servers holding different content. A flat slug map
  // (the arr InstanceGrants shape) would return jellyfin:["", "remote"] here.
  userGrants.set("u1", { plex: { remote: { view: true } } });
  const plexOnly = await getVisibleServerInstances(session("u1", 0n));
  assert.deepEqual(plexOnly.plex, ["", "remote", "open"]);
  assert.deepEqual(plexOnly.jellyfin, [""], "a plex grant must NOT unlock jellyfin's same-slug server");

  userGrants.set("u2", { jellyfin: { remote: { view: true } } });
  const jellyfinOnly = await getVisibleServerInstances(session("u2", 0n));
  assert.deepEqual(jellyfinOnly.jellyfin, ["", "remote"]);
  assert.deepEqual(jellyfinOnly.plex, ["", "open"], "a jellyfin grant must NOT unlock plex's same-slug server");
});

test("a malformed / hostile grants column fails closed", async () => {
  reset();
  seedBothServices();
  for (const raw of ["not json at all", 42, [], { plex: "yes" }, { emby: { remote: { view: true } } }]) {
    userGrants.set("u1", raw);
    const v = await getVisibleServerInstances(session("u1", 0n));
    assert.deepEqual(v.plex, ["", "open"], `hostile grants ${JSON.stringify(raw)} must not widen visibility`);
  }
});

test("visibleInstancesFor (pure): the sync path's session-free form", () => {
  // The orchestrator resolves visibility for MANY requesters in one pass, so it
  // calls this in a loop with ONE pre-fetched registry read rather than issuing
  // a round-trip per user. Same answers as the async wrapper, zero DB.
  const plex = [
    { slug: "", restricted: false },
    { slug: "remote", restricted: true },
  ];
  const jellyfin = [{ slug: "remote", restricted: true }];
  const grants: MediaServerGrants = { plex: { remote: { view: true } } };

  assert.deepEqual(visibleInstancesFor(0n, {}, plex, jellyfin), { plex: [""], jellyfin: [] });
  assert.deepEqual(visibleInstancesFor(0n, grants, plex, jellyfin), { plex: ["", "remote"], jellyfin: [] });
  assert.deepEqual(visibleInstancesFor(Permission.ADMIN, {}, plex, jellyfin), {
    plex: ["", "remote"],
    jellyfin: ["remote"],
  });
  // Namespacing holds in the pure form too.
  assert.deepEqual(visibleInstancesFor(0n, grants, [], jellyfin).jellyfin, []);
  // Empty registries are not an error.
  assert.deepEqual(visibleInstancesFor(0n, {}, [], []), { plex: [], jellyfin: [] });
});
