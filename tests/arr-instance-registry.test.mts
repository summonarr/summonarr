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
import {
  getArrInstances,
  getArrInstancesWithConfigured,
  getSyncableArrInstances,
  isInstanceConfigured,
} from "../src/lib/arr-instance-registry.ts";
import { shadowPrismaModel } from "./_helpers.mts";

// The registry JSON value keyed by Setting key, plus the set of connection keys
// that are "present" (have a value) — drives isInstanceConfigured's findMany.
const registryValues = new Map<string, string>();
let configuredKeys = new Set<string>();
let blankKeys = new Set<string>();

// Query log — the module's contract is a FIXED two round-trips (registry row +
// one batched connection-key probe) regardless of instance count; the tests below
// pin that shape, so every read is recorded here.
const queries: Array<{ op: "findUnique"; key: string } | { op: "findMany"; keys: string[] }> = [];

const settingStub = {
  findUnique: async (args: { where: { key: string } }) => {
    queries.push({ op: "findUnique", key: args.where.key });
    const v = registryValues.get(args.where.key);
    return v !== undefined ? { key: args.where.key, value: v } : null;
  },
  findMany: async (args: { where: { key: { in: string[] } } }) => {
    queries.push({ op: "findMany", keys: [...args.where.key.in] });
    return args.where.key.in
      .filter((k) => configuredKeys.has(k))
      // A key can be present with a blanked value — configured-ness needs the VALUE.
      .map((k) => ({ key: k, value: blankKeys.has(k) ? "" : "set" }));
  },
};

shadowPrismaModel(prisma, "setting", settingStub);

function reset() {
  registryValues.clear();
  configuredKeys = new Set<string>();
  blankKeys = new Set<string>();
  queries.length = 0;
}

const findManyKeyLists = () => queries.filter((q) => q.op === "findMany").map((q) => (q as { keys: string[] }).keys);
const findUniqueKeys = () => queries.filter((q) => q.op === "findUnique").map((q) => (q as { key: string }).key);

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

// ── query-count pins (review 2026-09 f104/f16/f56) ─────────────────────────
// The old shape was 1 registry read + a 4K probe + one findMany PER instance
// (2 + N, on request-scoped paths: detail pages, POST /api/requests, admin
// pages). Both list readers must now be exactly two queries however many
// instances are registered, and the single batched probe must carry EVERY
// instance's Url + ApiKey key so the filtering is unchanged.

test("getSyncableArrInstances issues exactly one findUnique + one findMany for default + 4k + two named instances", async () => {
  reset();
  registryValues.set("arrRadarrInstances", JSON.stringify([{ slug: "anime" }, { slug: "kids" }]));
  configuredKeys = new Set([
    "radarrUrl", "radarrApiKey",
    "radarr4kUrl", "radarr4kApiKey",
    "radarrAnimeUrl", "radarrAnimeApiKey",
    // kids: registered, url set, no apiKey → NOT configured
    "radarrKidsUrl",
  ]);
  const syncable = await getSyncableArrInstances("radarr");
  assert.deepEqual(syncable.map((i) => i.slug), ["", "4k", "anime"]);

  assert.deepEqual(findUniqueKeys(), ["arrRadarrInstances"], "one registry read");
  const lists = findManyKeyLists();
  assert.equal(lists.length, 1, `one batched connection probe, got ${lists.length}`);
  for (const key of [
    "radarrUrl", "radarrApiKey",
    "radarr4kUrl", "radarr4kApiKey",
    "radarrAnimeUrl", "radarrAnimeApiKey",
    "radarrKidsUrl", "radarrKidsApiKey",
  ]) {
    assert.ok(lists[0].includes(key), `batched probe must carry ${key}`);
  }
});

test("getArrInstances is also exactly two queries (the 4K probe rides on the batched read)", async () => {
  reset();
  registryValues.set("arrRadarrInstances", JSON.stringify([{ slug: "anime" }, { slug: "kids" }, { slug: "docs" }]));
  configuredKeys = new Set(["radarr4kUrl", "radarr4kApiKey"]);
  const list = await getArrInstances("radarr");
  assert.deepEqual(list.map((i) => i.slug), ["", "4k", "anime", "kids", "docs"]);
  assert.equal(findUniqueKeys().length, 1);
  assert.equal(findManyKeyLists().length, 1);
});

test("a present-but-blank connection value reads as unconfigured (value semantics, not row presence)", async () => {
  reset();
  registryValues.set("arrRadarrInstances", JSON.stringify([{ slug: "anime" }]));
  configuredKeys = new Set(["radarrUrl", "radarrApiKey", "radarrAnimeUrl", "radarrAnimeApiKey", "radarr4kUrl", "radarr4kApiKey"]);
  blankKeys = new Set(["radarrAnimeApiKey", "radarr4kUrl"]);
  const syncable = await getSyncableArrInstances("radarr");
  assert.deepEqual(syncable.map((i) => i.slug), [""]);
  // A blanked 4K url must not synthesize the legacy instance either.
  assert.deepEqual((await getArrInstances("radarr")).map((i) => i.slug), ["", "anime"]);
  assert.equal(await isInstanceConfigured("radarr", "anime"), false);
  assert.equal(await isInstanceConfigured("radarr", ""), true);
});

test("getArrInstancesWithConfigured hands back both views of ONE two-query read (the request route's shape)", async () => {
  reset();
  registryValues.set("arrRadarrInstances", JSON.stringify([{ slug: "anime" }, { slug: "kids" }]));
  configuredKeys = new Set(["radarrUrl", "radarrApiKey", "radarrKidsUrl", "radarrKidsApiKey"]);
  const { all, configured } = await getArrInstancesWithConfigured("radarr");
  assert.deepEqual(all.map((i) => i.slug), ["", "anime", "kids"], "the FULL list still carries the unconfigured entry");
  assert.deepEqual([...configured].sort(), ["", "kids"]);
  assert.equal(findUniqueKeys().length, 1, "one registry read");
  assert.equal(findManyKeyLists().length, 1, "one batched probe");
});
