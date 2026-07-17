// Unit tests for the server-side Radarr/Sonarr instance registry
// (src/lib/arr-instance-registry.ts): how the configured-instance list is
// assembled from the JSON registry Setting + the synthesized default and legacy
// 4K entries. A regression here mis-lists instances, which mis-routes requests
// and mis-scopes the sync fan-out.
//
// Impurity: prisma.setting.findUnique (registry JSON) + findMany (per-instance
// url/apiKey presence). No local DB here, so we shadow the `setting` delegate on
// the shared extended client with an in-memory stub (same pattern as
// jellyfin-config.test.mts / poster-cache.test.mts). No DB or network touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma.ts";
import { getArrInstances, getSyncableArrInstances } from "../src/lib/arr-instance-registry.ts";
import { shadowPrismaModel } from "./_helpers.mts";

// The registry JSON value keyed by Setting key, plus the set of connection keys
// that are "present" (have a value) — drives isInstanceConfigured's findMany.
const registryValues = new Map<string, string>();
let configuredKeys = new Set<string>();

const settingStub = {
  findUnique: async (args: { where: { key: string } }) => {
    const v = registryValues.get(args.where.key);
    return v !== undefined ? { key: args.where.key, value: v } : null;
  },
  findMany: async (args: { where: { key: { in: string[] } } }) => {
    return args.where.key.in
      .filter((k) => configuredKeys.has(k))
      .map((k) => ({ key: k, value: "set" }));
  },
};

shadowPrismaModel(prisma, "setting", settingStub);

function reset() {
  registryValues.clear();
  configuredKeys = new Set<string>();
}

test("no registry + no 4K config → the default instance only", async () => {
  reset();
  const list = await getArrInstances("radarr");
  assert.deepEqual(list.map((i) => i.slug), [""]);
  assert.equal(list[0].restricted, false);
});

test("legacy 4K is synthesized (after default) when configured but absent from the registry", async () => {
  reset();
  configuredKeys = new Set(["radarr4kUrl", "radarr4kApiKey"]);
  const list = await getArrInstances("radarr");
  assert.deepEqual(list.map((i) => i.slug), ["", "4k"]);
  // 4K keeps its legacy behavior: skipLibraryCheck true.
  assert.equal(list.find((i) => i.slug === "4k")?.skipLibraryCheck, true);
});

test("a named instance from the registry JSON is parsed (default first)", async () => {
  reset();
  registryValues.set(
    "arrRadarrInstances",
    JSON.stringify([{ slug: "anime", name: "Anime", restricted: true, autoRoute: { animeOnly: true } }]),
  );
  const list = await getArrInstances("radarr");
  assert.deepEqual(list.map((i) => i.slug), ["", "anime"]);
  const anime = list.find((i) => i.slug === "anime");
  assert.equal(anime?.name, "Anime");
  assert.equal(anime?.restricted, true);
  assert.deepEqual(anime?.autoRoute, { animeOnly: true, genreIds: undefined, originalLanguages: undefined });
});

test("registry + configured 4K → default, named, then synthesized 4K", async () => {
  reset();
  configuredKeys = new Set(["radarr4kUrl", "radarr4kApiKey"]);
  registryValues.set("arrRadarrInstances", JSON.stringify([{ slug: "anime", name: "Anime" }]));
  const list = await getArrInstances("radarr");
  // 4K is spliced in right after the default; named entries follow.
  assert.deepEqual(list.map((i) => i.slug), ["", "4k", "anime"]);
});

test("malformed registry JSON falls back to the default (never throws)", async () => {
  reset();
  registryValues.set("arrRadarrInstances", "{not json");
  const list = await getArrInstances("radarr");
  assert.deepEqual(list.map((i) => i.slug), [""]);
});

test("invalid / reserved slugs in the registry are dropped", async () => {
  reset();
  registryValues.set(
    "arrRadarrInstances",
    JSON.stringify([{ slug: "" }, { slug: "hd" }, { slug: "Anime" }, { slug: "good" }]),
  );
  const list = await getArrInstances("radarr");
  assert.deepEqual(list.map((i) => i.slug), ["", "good"]);
});

test("getSyncableArrInstances returns only instances with url + apiKey configured", async () => {
  reset();
  registryValues.set("arrRadarrInstances", JSON.stringify([{ slug: "anime" }, { slug: "kids" }]));
  // default + anime configured; kids registered but not configured.
  configuredKeys = new Set(["radarrUrl", "radarrApiKey", "radarrAnimeUrl", "radarrAnimeApiKey"]);
  const syncable = await getSyncableArrInstances("radarr");
  assert.deepEqual(syncable.map((i) => i.slug).sort(), ["", "anime"]);
});

test("sonarr registry is read from its own key (services don't cross-contaminate)", async () => {
  reset();
  registryValues.set("arrRadarrInstances", JSON.stringify([{ slug: "anime" }]));
  const sonarr = await getArrInstances("sonarr");
  assert.deepEqual(sonarr.map((i) => i.slug), [""]); // no arrSonarrInstances set
});
