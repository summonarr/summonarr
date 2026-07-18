// Unit tests for getShow4kVisibility (src/lib/four-k-visibility.ts) — the
// security-adjacent gate deciding whether a viewer is shown 4K availability /
// pending state they can act on. It must be false when no 4K instance is
// configured (state would be meaningless), false for HD-only users (mirrors the
// detail-page "Request in 4K" button gate), and correctly scoped by mediaType
// so /movies never surfaces 4K state that only the Sonarr 4K backend explains.
// The sole impurity is one setting.findMany; shadowed in-memory (the
// jellyfin-config.test pattern). Permission logic is the REAL canRequest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma.ts";
import { Permission, PRESETS } from "../src/lib/permissions.ts";
import type { SummonarrSession } from "../src/lib/api-auth.ts";
import { getShow4kVisibility } from "../src/lib/four-k-visibility.ts";
import { shadowPrismaModel } from "./_helpers.mts";

let settings: Record<string, string> = {};
let findManyCalls = 0;

const settingStub = {
  findMany: async (args: { where: { key: { in: string[] } } }) => {
    findManyCalls++;
    return args.where.key.in
      .filter((k) => k in settings)
      .map((k) => ({ key: k, value: settings[k] }));
  },
};

shadowPrismaModel(prisma, "setting", settingStub);

function makeSession(permissions: bigint, role = "USER"): SummonarrSession {
  return {
    user: { id: "u_1", role, permissions, mediaServer: null },
    sessionId: "sess_1",
  };
}

const RADARR_4K = { radarr4kUrl: "http://radarr4k:7878", radarr4kApiKey: "key" };
const SONARR_4K = { sonarr4kUrl: "http://sonarr4k:8989", sonarr4kApiKey: "key" };

test("null session → false, without touching the DB", async () => {
  findManyCalls = 0;
  assert.equal(await getShow4kVisibility(null), false);
  assert.equal(findManyCalls, 0);
});

test("no 4K instance configured → false even for an admin", async () => {
  settings = {};
  assert.equal(await getShow4kVisibility(makeSession(Permission.ADMIN, "ADMIN")), false);
});

test("a URL without its API key does not count as configured", async () => {
  settings = { radarr4kUrl: "http://radarr4k:7878" };
  assert.equal(await getShow4kVisibility(makeSession(Permission.ADMIN, "ADMIN")), false);
});

test("HD-only user never sees 4K state, even with both instances configured", async () => {
  settings = { ...RADARR_4K, ...SONARR_4K };
  assert.equal(await getShow4kVisibility(makeSession(PRESETS.USER)), false);
  assert.equal(await getShow4kVisibility(makeSession(PRESETS.USER), "movie"), false);
  assert.equal(await getShow4kVisibility(makeSession(PRESETS.USER), "tv"), false);
});

test("mediaType scopes to the configured backend: Radarr-4K only", async () => {
  settings = { ...RADARR_4K };
  const perms = Permission.REQUEST | Permission.REQUEST_4K; // umbrella 4K bit
  assert.equal(await getShow4kVisibility(makeSession(perms), "movie"), true);
  // No Sonarr 4K instance → a TV-only page must not surface 4K state.
  assert.equal(await getShow4kVisibility(makeSession(perms), "tv"), false);
  // Mixed lists use the OR.
  assert.equal(await getShow4kVisibility(makeSession(perms)), true);
});

test("mediaType scopes to the configured backend: Sonarr-4K only", async () => {
  settings = { ...SONARR_4K };
  const perms = Permission.REQUEST | Permission.REQUEST_4K;
  assert.equal(await getShow4kVisibility(makeSession(perms), "tv"), true);
  assert.equal(await getShow4kVisibility(makeSession(perms), "movie"), false);
  assert.equal(await getShow4kVisibility(makeSession(perms)), true);
});

test("per-type 4K bit gates only its own type", async () => {
  settings = { ...RADARR_4K, ...SONARR_4K };
  const movieOnly = Permission.REQUEST | Permission.REQUEST_4K_MOVIE;
  assert.equal(await getShow4kVisibility(makeSession(movieOnly), "movie"), true);
  assert.equal(await getShow4kVisibility(makeSession(movieOnly), "tv"), false);
});

test("request4kAll='true' opens 4K to any base requester without the 4K bit", async () => {
  settings = { ...RADARR_4K, ...SONARR_4K, request4kAll: "true" };
  assert.equal(await getShow4kVisibility(makeSession(PRESETS.USER)), true);
  assert.equal(await getShow4kVisibility(makeSession(PRESETS.USER), "movie"), true);
  assert.equal(await getShow4kVisibility(makeSession(PRESETS.USER), "tv"), true);
});

test("request4kAll only widens 4K for users who can request the base type at all", async () => {
  settings = { ...RADARR_4K, request4kAll: "true" };
  // No REQUEST/REQUEST_MOVIE bit → canRequest base check fails → still false.
  assert.equal(await getShow4kVisibility(makeSession(Permission.MANAGE_ISSUES), "movie"), false);
});
