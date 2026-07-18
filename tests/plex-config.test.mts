// Unit tests for getPlexConfig (src/lib/plex-config.ts) — the single source of
// truth for the plexServerUrl/plexAdminToken Setting pair, the sibling of
// getConfiguredJellyfinUrl (tests/jellyfin-config.test.mts). Every Plex surface
// (library sync, SSE events, session terminate, fix-match) reads the server URL
// and admin token through this helper, and its null contract gates them all:
// null must mean "unconfigured" so an admin clearing a setting actually disables
// the integration, and so `!url || !token` guards at call sites behave exactly
// like the old inline `!row?.value` checks.
//
// The deliberate divergence from the Jellyfin helper is pinned here: values come
// back RAW — no trim, no trailing-slash strip — because call sites keep their own
// post-processing (`url.replace(/\/$/, "")`). Only a MISSING row or an EMPTY
// string normalizes to null (the `|| null`); whitespace survives verbatim. A
// "helpful" trim added here would silently change what every caller sees.
//
// The function's only impurity is two prisma.setting.findUnique reads (one per
// key, via Promise.all). No DB exists in this harness, so the `setting` delegate
// is shadowed in-memory (tests/_helpers.mts). Bypassing the crypto extension is
// faithful: plexServerUrl is plaintext by design, and for plexAdminToken (a
// sensitive key) the extension hands callers decrypted plaintext — exactly what
// the stub returns.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto

// Dynamic imports so the env assignment above genuinely precedes the
// module-graph load (static imports would hoist above it).
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const { getPlexConfig } = await import("../src/lib/plex-config.ts");

// The real Setting row also carries timestamps; the function only reads `value`
// (via `row?.value || null`), so the stub models just what it touches.
type StubRow = { key: string; value?: string };
const rows = new Map<string, StubRow>();
const findUniqueCalls: string[] = [];

shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }): Promise<StubRow | null> => {
    findUniqueCalls.push(args.where.key);
    return rows.get(args.where.key) ?? null;
  },
});

function seed(url?: string, token?: string): void {
  rows.clear();
  findUniqueCalls.length = 0;
  if (url !== undefined) rows.set("plexServerUrl", { key: "plexServerUrl", value: url });
  if (token !== undefined) rows.set("plexAdminToken", { key: "plexAdminToken", value: token });
}

test("returns both configured values exactly as stored (happy path)", async () => {
  seed("http://plex.local:32400", "plex-admin-token-1");
  assert.deepEqual(await getPlexConfig(), {
    url: "http://plex.local:32400",
    token: "plex-admin-token-1",
  });
});

test("RAW contract: trailing slash and surrounding whitespace survive verbatim (no trim)", async () => {
  // The deliberate divergence from getConfiguredJellyfinUrl: call sites do their
  // own `url.replace(/\/$/, "")`, so the helper must not normalize for them.
  seed(" https://plex.example.com:32400/ ", "\ttoken-with-tab ");
  assert.deepEqual(await getPlexConfig(), {
    url: " https://plex.example.com:32400/ ",
    token: "\ttoken-with-tab ",
  });
});

test("whitespace-only value is truthy and survives as-is — only EMPTY normalizes to null", async () => {
  // `|| null` is a falsiness check, not a trim: "   " passes through. Pinned as
  // the documented behavior ("missing/empty normalized to null", nothing more).
  seed("   ", "  ");
  assert.deepEqual(await getPlexConfig(), { url: "   ", token: "  " });
});

test("no Setting rows at all → { url: null, token: null } (never undefined)", async () => {
  seed();
  const cfg = await getPlexConfig();
  assert.deepEqual(cfg, { url: null, token: null });
});

test("empty-string values (cleared settings) → null for each", async () => {
  seed("", "");
  assert.deepEqual(await getPlexConfig(), { url: null, token: null });
});

test("url and token are independently nullable — one configured, the other missing", async () => {
  seed("http://plex.local:32400", undefined);
  assert.deepEqual(await getPlexConfig(), { url: "http://plex.local:32400", token: null });

  seed(undefined, "orphan-token");
  assert.deepEqual(await getPlexConfig(), { url: null, token: "orphan-token" });
});

test("a row without a value field → null (defensive optional chain)", async () => {
  rows.clear();
  findUniqueCalls.length = 0;
  rows.set("plexServerUrl", { key: "plexServerUrl" });
  rows.set("plexAdminToken", { key: "plexAdminToken" });
  assert.deepEqual(await getPlexConfig(), { url: null, token: null });
});

test("reads exactly the plexServerUrl and plexAdminToken keys, once each per call", async () => {
  seed("http://plex.internal", "tok");
  await getPlexConfig();
  // Promise.all issues the reads in declaration order; two reads total, no more.
  assert.deepEqual(findUniqueCalls, ["plexServerUrl", "plexAdminToken"]);
});

test("no memoization — an admin edit is visible on the very next call", async () => {
  seed("http://old.example.com", "old-token");
  assert.deepEqual(await getPlexConfig(), { url: "http://old.example.com", token: "old-token" });

  rows.set("plexServerUrl", { key: "plexServerUrl", value: "http://new.example.com" });
  rows.set("plexAdminToken", { key: "plexAdminToken", value: "new-token" });
  assert.deepEqual(await getPlexConfig(), { url: "http://new.example.com", token: "new-token" });
  assert.equal(findUniqueCalls.length, 4); // two Setting reads per call, no cache
});
