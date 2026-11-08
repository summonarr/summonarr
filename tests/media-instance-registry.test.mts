// Unit tests for the server-side Plex/Jellyfin instance registry
// (src/lib/media-instance-registry.ts): how the configured-instance list is
// assembled from the JSON registry Setting + the synthesized default entry.
// A regression here mis-lists instances, which makes the sync loop over the
// wrong set of servers.
//
// DB reads: prisma.setting.findUnique (the registry JSON) + findMany (which
// connection fields are filled in per instance). There is no local DB, so the
// `setting` model is replaced with an in-memory stub (same pattern as
// tests/arr-instance-registry.test.mts / jellyfin-config.test.mts). No DB or
// network is touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { prisma } from "../src/lib/prisma.ts";
import {
  getMediaInstances,
  getSyncableMediaInstances,
  buildMediaInstanceRegistryWrite,
  registryKeyFor,
  readMediaInstanceRegistryForSave,
  registeredSlugsForUpdateInTx,
} from "../src/lib/media-instance-registry.ts";
import { MEDIA_INSTANCE_NAME_MAX_LEN } from "../src/lib/media-instances.ts";
import { shadowPrismaModel } from "./_helpers.mts";
import { resetLogDedup } from "../src/lib/log-dedup.ts";

const registryValues = new Map<string, string>();
let configuredKeys = new Set<string>();
// Per-key override for the connection-field VALUE the stub reports (default
// "set") — used by the whitespace test below.
let configuredValues = new Map<string, string>();

let findManyCalls = 0;
const settingStub = {
  findUnique: async (args: { where: { key: string } }) => {
    const v = registryValues.get(args.where.key);
    return v !== undefined ? { key: args.where.key, value: v } : null;
  },
  findMany: async (args: { where: { key: { in: string[] } } }) => {
    findManyCalls += 1;
    return args.where.key.in
      .filter((k) => configuredKeys.has(k))
      .map((k) => ({ key: k, value: configuredValues.get(k) ?? "set" }));
  },
};

shadowPrismaModel(prisma, "setting", settingStub);

function reset() {
  findManyCalls = 0;
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

test("an unreadable registry is reported once per value, and again after it is fixed and breaks again", async () => {
  reset();
  resetLogDedup();
  const warned: string[] = [];
  const realWarn = console.warn;
  console.warn = (msg: unknown) => { warned.push(String(msg)); };
  try {
    registryValues.set("plexInstances", "{not json");
    await getMediaInstances("plex");
    await getMediaInstances("plex");
    assert.equal(warned.length, 1, "an unchanged bad value is said once");
    assert.match(warned[0], /^\[media-instances\] the plexInstances setting is not a JSON array/);
    registryValues.set("plexInstances", JSON.stringify({ slug: "remote" }));
    await getMediaInstances("plex");
    assert.equal(warned.length, 2, "a different bad value (an object, not an array) is said too");
    registryValues.set("plexInstances", "[]");
    await getMediaInstances("plex");
    registryValues.set("plexInstances", JSON.stringify({ slug: "remote" }));
    await getMediaInstances("plex");
    assert.equal(warned.length, 3, "a readable value in between clears the memory");
  } finally {
    console.warn = realWarn;
  }
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
  assert.equal(findManyCalls, 1, "every instance's connection fields come from one Setting read");
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

test("buildMediaInstanceRegistryWrite drops the default, invalid, non-string and duplicate slugs and bounds the name with the shared cap", () => {
  const long = "n".repeat(MEDIA_INSTANCE_NAME_MAX_LEN + 20);
  const { value } = buildMediaInstanceRegistryWrite("plex", [
    { slug: "", name: "Default", restricted: false },
    { slug: "Bad Slug", name: "Bad", restricted: false },
    { slug: 7, name: "Seven", restricted: false } as unknown as { slug: string; name: string; restricted: boolean },
    { slug: "remote", name: long, restricted: false },
    { slug: "remote", name: "Again", restricted: true },
  ]);
  const stored = JSON.parse(value) as Array<{ slug: string; name: string; restricted: boolean }>;
  assert.deepEqual(stored.map((e) => e.slug), ["remote"], "first occurrence wins; nothing invalid is stored");
  assert.equal(stored[0].name.length, MEDIA_INSTANCE_NAME_MAX_LEN);
  assert.equal(stored[0].restricted, false);
  assert.equal(MEDIA_INSTANCE_NAME_MAX_LEN, 100, "the route's refusal message and the read-side cap are this one value");
});

test("readMediaInstanceRegistryForSave takes the service's save lock, THEN reads the registry through the transaction client", async () => {
  reset();
  registryValues.set("jellyfinInstances", JSON.stringify([{ slug: "remote", name: "Remote" }, { slug: "" }]));
  const calls: string[] = [];
  const tx = {
    $executeRaw: async (q: { sql: string }) => { calls.push(`lock ${q.sql}`); return 0; },
    setting: {
      findUnique: async (args: { where: { key: string } }) => {
        calls.push(`read ${args.where.key}`);
        const v = registryValues.get(args.where.key);
        return v === undefined ? null : { key: args.where.key, value: v };
      },
    },
  };
  const list = await readMediaInstanceRegistryForSave(tx as unknown as Parameters<typeof readMediaInstanceRegistryForSave>[0], "jellyfin");
  assert.deepEqual(calls, ["lock SELECT pg_advisory_xact_lock(2101, 4)", "read jellyfinInstances"]);
  assert.deepEqual(list.map((i) => i.slug), ["remote"], "named entries only, through the same normalizer");
});

test("registryKeyFor names the same Setting row a registry save writes", () => {
  for (const service of ["plex", "jellyfin"] as const) {
    assert.equal(registryKeyFor(service), buildMediaInstanceRegistryWrite(service, []).key);
  }
  assert.notEqual(registryKeyFor("plex"), registryKeyFor("jellyfin"));
});

test("registeredSlugsForUpdateInTx locks the registry row and reads it through the registry's own parser", async () => {
  resetLogDedup();
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  let value: string | undefined = JSON.stringify([
    { slug: "remote", name: "Remote" },
    { slug: "Not A Slug!" },
    { slug: "" },
  ]);
  const tx = {
    $queryRaw: async (q: { sql: string; values: unknown[] }) => {
      queries.push(q);
      return value === undefined ? [] : [{ value }];
    },
  };
  const slugs = await registeredSlugsForUpdateInTx(tx as unknown as Parameters<typeof registeredSlugsForUpdateInTx>[0], "jellyfin");
  assert.deepEqual([...slugs], ["remote"], "invalid and default slugs are dropped, as every other reader drops them");
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /FOR UPDATE/);
  assert.deepEqual(queries[0].values, [registryKeyFor("jellyfin")]);

  value = "{not json";
  assert.equal((await registeredSlugsForUpdateInTx(tx as never, "plex")).size, 0, "an unreadable registry lists nothing");
  value = undefined;
  assert.equal((await registeredSlugsForUpdateInTx(tx as never, "plex")).size, 0, "a missing registry lists nothing");
});

test("the watch-evidence writers re-check their slug through the shared registry reader, not an inline parse", () => {
  for (const file of ["upstream-watch-data.ts", "server-watch-history-data.ts"]) {
    const src = readFileSync(new URL(`../src/lib/${file}`, import.meta.url), "utf8");
    assert.match(src, /registeredSlugsForUpdateInTx\(tx, source\)/, `${file} uses the shared reader`);
    assert.doesNotMatch(src, /\$queryRaw[^;]*FOR UPDATE/, `${file} carries no copy of the registry lock`);
    assert.doesNotMatch(src, /JSON\.parse\(raw\)/, `${file} carries no copy of the registry parse`);
  }
});
