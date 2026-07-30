// Unit tests for the server-side Plex/Jellyfin instance registry
// (src/lib/media-instance-registry.ts): how the configured-instance list is
// assembled from the JSON registry Setting + the synthesized default entry.
// A regression here mis-lists instances, which mis-scopes the sync fan-out
// once later phases wire it up.
//
// Impurity: prisma.setting.findUnique (registry JSON) + findMany (per-instance
// connection-field presence). No local DB here, so we shadow the `setting`
// delegate on the shared extended client with an in-memory stub (same pattern
// as tests/arr-instance-registry.test.mts / jellyfin-config.test.mts). No DB
// or network touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma.ts";
import {
  getMediaInstances,
  getSyncableMediaInstances,
  buildMediaInstanceRegistryWrite,
} from "../src/lib/media-instance-registry.ts";
import { shadowPrismaModel } from "./_helpers.mts";

const registryValues = new Map<string, string>();
let configuredKeys = new Set<string>();
// Per-key override for the connection-field VALUE the stub reports (default
// "set") — used by the whitespace test below.
let configuredValues = new Map<string, string>();

const settingStub = {
  findUnique: async (args: { where: { key: string } }) => {
    const v = registryValues.get(args.where.key);
    return v !== undefined ? { key: args.where.key, value: v } : null;
  },
  findMany: async (args: { where: { key: { in: string[] } } }) => {
    return args.where.key.in
      .filter((k) => configuredKeys.has(k))
      .map((k) => ({ key: k, value: configuredValues.get(k) ?? "set" }));
  },
};

shadowPrismaModel(prisma, "setting", settingStub);

function reset() {
  registryValues.clear();
  configuredKeys = new Set<string>();
  configuredValues = new Map<string, string>();
}

test("no registry + no additional config → the default instance only", async () => {
  reset();
  const list = await getMediaInstances("plex");
  assert.deepEqual(list.map((i) => i.slug), [""]);
  assert.equal(list[0].name, "Default");
});

test("a named Plex instance from the registry JSON is parsed (default first)", async () => {
  reset();
  registryValues.set("plexInstances", JSON.stringify([{ slug: "remote", name: "Friend's Server" }]));
  const list = await getMediaInstances("plex");
  assert.deepEqual(list.map((i) => i.slug), ["", "remote"]);
  assert.equal(list.find((i) => i.slug === "remote")?.name, "Friend's Server");
});

test("a named entry without a name falls back to the slug", async () => {
  reset();
  registryValues.set("jellyfinInstances", JSON.stringify([{ slug: "remote" }]));
  const list = await getMediaInstances("jellyfin");
  assert.equal(list.find((i) => i.slug === "remote")?.name, "remote");
});

test("malformed registry JSON falls back to the default (never throws)", async () => {
  reset();
  registryValues.set("plexInstances", "{not json");
  const list = await getMediaInstances("plex");
  assert.deepEqual(list.map((i) => i.slug), [""]);
});

test("invalid / reserved slugs in the registry are dropped", async () => {
  reset();
  registryValues.set(
    "plexInstances",
    JSON.stringify([{ slug: "" }, { slug: "Remote" }, { slug: "2bad" }, { slug: "good" }]),
  );
  const list = await getMediaInstances("plex");
  assert.deepEqual(list.map((i) => i.slug), ["", "good"]);
});

test("getSyncableMediaInstances (plex): only instances with ServerUrl + AdminToken configured", async () => {
  reset();
  registryValues.set("plexInstances", JSON.stringify([{ slug: "remote" }, { slug: "unconfigured" }]));
  // default + remote configured; unconfigured registered but missing its token.
  configuredKeys = new Set(["plexServerUrl", "plexAdminToken", "plexRemoteServerUrl", "plexRemoteAdminToken"]);
  const syncable = await getSyncableMediaInstances("plex");
  assert.deepEqual(syncable.map((i) => i.slug).sort(), ["", "remote"]);
});

test("getSyncableMediaInstances (jellyfin): only instances with Url + ApiKey configured", async () => {
  reset();
  registryValues.set("jellyfinInstances", JSON.stringify([{ slug: "remote" }]));
  // Only the default is configured — remote is registered but has no ApiKey yet.
  configuredKeys = new Set(["jellyfinUrl", "jellyfinApiKey", "jellyfinRemoteUrl"]);
  const syncable = await getSyncableMediaInstances("jellyfin");
  assert.deepEqual(syncable.map((i) => i.slug), [""]);
});

test("isMediaInstanceConfigured trims: a whitespace-only URL or token is NOT configured", async () => {
  reset();
  registryValues.set("plexInstances", JSON.stringify([{ slug: "blank" }, { slug: "tabtoken" }]));
  configuredKeys = new Set([
    "plexServerUrl", "plexAdminToken",
    "plexBlankServerUrl", "plexBlankAdminToken",
    "plexTabtokenServerUrl", "plexTabtokenAdminToken",
  ]);
  // A row that exists but holds only whitespace. Untrimmed, `!!"   "` is true,
  // so the instance advertised itself as configured — the login tab rendered and
  // the sync fan-out included it — while every consumer trims before use
  // (authorizeWithPlex, plex-membership, the poller) and therefore refused it.
  configuredValues.set("plexBlankServerUrl", "   ");
  configuredValues.set("plexTabtokenAdminToken", "\t\n ");

  const syncable = await getSyncableMediaInstances("plex");
  assert.deepEqual(syncable.map((i) => i.slug), [""], "only the genuinely-configured default survives");
});

test("plex and jellyfin registries are read from their own keys (services don't cross-contaminate)", async () => {
  reset();
  registryValues.set("plexInstances", JSON.stringify([{ slug: "remote" }]));
  const jellyfin = await getMediaInstances("jellyfin");
  assert.deepEqual(jellyfin.map((i) => i.slug), [""]); // no jellyfinInstances set
});

// ─── restricted (per-user server-visibility grants) ─────────────────────────

test("restricted round-trips through the registry JSON", async () => {
  reset();
  registryValues.set(
    "plexInstances",
    JSON.stringify([
      { slug: "remote", name: "Friend's Server", restricted: true },
      { slug: "open", name: "Shared", restricted: false },
    ]),
  );
  const list = await getMediaInstances("plex");
  assert.equal(list.find((i) => i.slug === "remote")?.restricted, true);
  assert.equal(list.find((i) => i.slug === "open")?.restricted, false);
});

test("restricted coerces to false for non-boolean / absent values", async () => {
  reset();
  // Truthy-but-not-true values must NOT read as restricted: a hand-edited
  // "false" string is famously truthy, and reading it as restricted would blank
  // that server's library for every non-granted user.
  registryValues.set(
    "plexInstances",
    JSON.stringify([
      { slug: "strtrue", restricted: "true" },
      { slug: "strfalse", restricted: "false" },
      { slug: "one", restricted: 1 },
      { slug: "nullish", restricted: null },
      { slug: "absent" },
    ]),
  );
  const list = await getMediaInstances("plex");
  for (const slug of ["strtrue", "strfalse", "one", "nullish", "absent"]) {
    assert.equal(list.find((i) => i.slug === slug)?.restricted, false, `${slug} must coerce to restricted:false`);
  }
});

test("the synthesized default instance is ALWAYS restricted:false", async () => {
  reset();
  // Guardrail 35: a single-server deployment must never be able to observe the
  // multi-server generalization. The default ("") is synthesized, never
  // registry-backed, so a hostile/hand-edited "" entry claiming restricted:true
  // is dropped rather than shadowing it — otherwise one bad blob would hide the
  // entire library from every non-admin.
  registryValues.set("plexInstances", JSON.stringify([{ slug: "", name: "Evil", restricted: true }]));
  const list = await getMediaInstances("plex");
  assert.deepEqual(list.map((i) => i.slug), [""]);
  assert.equal(list[0].restricted, false);
  assert.equal(list[0].name, "Default");

  // Same for jellyfin, and with no registry row at all.
  reset();
  const jf = await getMediaInstances("jellyfin");
  assert.equal(jf[0].restricted, false);
});

test("buildMediaInstanceRegistryWrite persists restricted and never stores the default", () => {
  const { key, value } = buildMediaInstanceRegistryWrite("jellyfin", [
    { slug: "", name: "Default", restricted: false },
    { slug: "attic", name: "Attic", restricted: true },
    { slug: "open", name: "Open", restricted: false },
  ]);
  assert.equal(key, "jellyfinInstances");
  assert.deepEqual(JSON.parse(value), [
    { slug: "attic", name: "Attic", restricted: true },
    { slug: "open", name: "Open", restricted: false },
  ]);
});
