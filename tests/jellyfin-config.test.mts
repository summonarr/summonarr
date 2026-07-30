// Unit tests for getConfiguredJellyfinUrl (src/lib/jellyfin-config.ts) — the
// single source of truth for the Jellyfin server URL. It replaced the old
// JELLYFIN_URL env var so login (standard + QuickConnect), library sync,
// play-history, and fix-match can never drift onto different servers. Its
// null contract gates every Jellyfin sign-in surface: null must mean
// "unconfigured", so an admin clearing the setting (or saving stray
// whitespace) actually disables the integration instead of leaking a bogus
// base URL into fetch calls. Trimming tolerates copy-paste whitespace, and
// trim is the ONLY normalization — no scheme or trailing-slash rewriting.
//
// The function's sole impurity is one prisma.setting.findUnique. There is no
// local DB in this harness, so the tests shadow the `setting` delegate on the
// shared extended client with an in-memory stub (Prisma 7's $extends result
// exposes model delegates as own writable data properties). No DB or network
// is touched. Bypassing the crypto extension is faithful here: "jellyfinUrl"
// is not in SETTINGS_SENSITIVE_KEYS, so the extension's decrypt wrapper is a
// passthrough for this key in production too.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma.ts";
import { getConfiguredJellyfinUrl, getJellyfinConfig } from "../src/lib/jellyfin-config.ts";
import { shadowPrismaModel } from "./_helpers.mts";

// The real Setting row also carries id/timestamps; the function only reads
// `value` (via `row?.value?.trim()`), so the stub models just what it touches.
type StubRow = { key?: string; value?: string } | null;

let nextRow: StubRow = null;
// Multi-key mode for getJellyfinConfig (which issues TWO findUnique calls per
// key at once, unlike getConfiguredJellyfinUrl's single call) — a per-key map
// instead of the single nextRow. Cleared before every test so an old
// nextRow-based test never sees leftover keyed state (and vice versa).
const keyedRows = new Map<string, StubRow>();
const findUniqueCalls: Array<{ where: { key: string } }> = [];

const settingStub = {
  findUnique: async (args: { where: { key: string } }): Promise<StubRow> => {
    findUniqueCalls.push(args);
    if (keyedRows.size > 0) return keyedRows.get(args.where.key) ?? null;
    return nextRow;
  },
};

// Shadow the delegate BEFORE any test runs. The helper fails fast and loudly
// if a Prisma upgrade ever stops this from taking effect — otherwise the first
// call would issue a real query against a DB that doesn't exist and hang.
shadowPrismaModel(prisma, "setting", settingStub);

beforeEach(() => {
  keyedRows.clear();
});

test("returns the configured URL exactly as stored (happy path)", async () => {
  nextRow = { key: "jellyfinUrl", value: "http://jellyfin.local:8096" };
  assert.equal(await getConfiguredJellyfinUrl(), "http://jellyfin.local:8096");
});

test("trim is the only normalization — path, port, and trailing slash survive verbatim", async () => {
  // Callers join paths onto this base; pin that the helper does NOT rewrite
  // scheme, strip a trailing slash, or otherwise "clean up" the stored value.
  nextRow = { key: "jellyfinUrl", value: "https://media.example.com:8920/jellyfin/" };
  assert.equal(await getConfiguredJellyfinUrl(), "https://media.example.com:8920/jellyfin/");
});

test("surrounding whitespace from copy-paste is trimmed", async () => {
  nextRow = { key: "jellyfinUrl", value: "  \thttps://jf.example.com \n" };
  assert.equal(await getConfiguredJellyfinUrl(), "https://jf.example.com");
});

test("no Setting row → null (never undefined, never empty string)", async () => {
  nextRow = null;
  const result = await getConfiguredJellyfinUrl();
  assert.equal(result, null);
});

test("empty-string value (cleared setting) → null", async () => {
  nextRow = { key: "jellyfinUrl", value: "" };
  assert.equal(await getConfiguredJellyfinUrl(), null);
});

test("whitespace-only value → null (trims to empty, reads as unconfigured)", async () => {
  nextRow = { key: "jellyfinUrl", value: " \n\t  " };
  assert.equal(await getConfiguredJellyfinUrl(), null);
});

test("row without a value field → null (defensive optional chain)", async () => {
  nextRow = { key: "jellyfinUrl" };
  assert.equal(await getConfiguredJellyfinUrl(), null);
});

test("reads exactly the jellyfinUrl key, once per call", async () => {
  findUniqueCalls.length = 0;
  nextRow = { key: "jellyfinUrl", value: "http://jf.internal" };
  await getConfiguredJellyfinUrl();
  assert.equal(findUniqueCalls.length, 1);
  assert.deepEqual(findUniqueCalls[0].where, { key: "jellyfinUrl" });
});

test("no memoization — an admin edit is visible on the very next call", async () => {
  findUniqueCalls.length = 0;
  nextRow = { key: "jellyfinUrl", value: "http://old.example.com" };
  assert.equal(await getConfiguredJellyfinUrl(), "http://old.example.com");
  nextRow = { key: "jellyfinUrl", value: "http://new.example.com" };
  assert.equal(await getConfiguredJellyfinUrl(), "http://new.example.com");
  assert.equal(findUniqueCalls.length, 2); // one Setting read per call, no cache
});

// ── instance parameterization (Phase 1.5) ───────────────────────────────────

test("a named instance reads its OWN Setting key, not the default's", async () => {
  findUniqueCalls.length = 0;
  nextRow = { key: "jellyfinRemoteUrl", value: "http://remote.example.com:8096" };
  assert.equal(await getConfiguredJellyfinUrl("remote"), "http://remote.example.com:8096");
  assert.deepEqual(findUniqueCalls[0].where, { key: "jellyfinRemoteUrl" });
});

test("the default instance ('') is byte-identical to the legacy zero-arg call", async () => {
  findUniqueCalls.length = 0;
  nextRow = { key: "jellyfinUrl", value: "http://default.example.com" };
  const viaExplicitDefault = await getConfiguredJellyfinUrl("");
  const viaZeroArg = await getConfiguredJellyfinUrl();
  assert.equal(viaExplicitDefault, "http://default.example.com");
  assert.equal(viaZeroArg, "http://default.example.com");
  assert.deepEqual(findUniqueCalls[0].where, { key: "jellyfinUrl" });
  assert.deepEqual(findUniqueCalls[1].where, { key: "jellyfinUrl" });
});

test("getJellyfinConfig: reads the given instance's own url+apiKey key pair", async () => {
  keyedRows.set("jellyfinRemoteUrl", { key: "jellyfinRemoteUrl", value: "http://remote.example.com:8096" });
  keyedRows.set("jellyfinRemoteApiKey", { key: "jellyfinRemoteApiKey", value: "remote-secret-key" });
  assert.deepEqual(await getJellyfinConfig("remote"), {
    url: "http://remote.example.com:8096",
    apiKey: "remote-secret-key",
  });
});

test("getJellyfinConfig: zero-arg call reads the exact legacy jellyfinUrl/jellyfinApiKey keys", async () => {
  keyedRows.set("jellyfinUrl", { key: "jellyfinUrl", value: "http://default.example.com" });
  keyedRows.set("jellyfinApiKey", { key: "jellyfinApiKey", value: "default-secret-key" });
  assert.deepEqual(await getJellyfinConfig(), {
    url: "http://default.example.com",
    apiKey: "default-secret-key",
  });
});

test("getJellyfinConfig: a missing row on either side normalizes to null, never undefined", async () => {
  keyedRows.set("jellyfinRemoteUrl", { key: "jellyfinRemoteUrl", value: "http://remote.example.com" });
  // No jellyfinRemoteApiKey row at all for "remote".
  assert.deepEqual(await getJellyfinConfig("remote"), { url: "http://remote.example.com", apiKey: null });
});

test("getJellyfinConfig: two different instances never see each other's keys", async () => {
  keyedRows.set("jellyfinUrl", { key: "jellyfinUrl", value: "http://default.example.com" });
  keyedRows.set("jellyfinApiKey", { key: "jellyfinApiKey", value: "default-secret-key" });
  keyedRows.set("jellyfinRemoteUrl", { key: "jellyfinRemoteUrl", value: "http://remote.example.com" });
  keyedRows.set("jellyfinRemoteApiKey", { key: "jellyfinRemoteApiKey", value: "remote-secret-key" });
  assert.deepEqual(await getJellyfinConfig(""), { url: "http://default.example.com", apiKey: "default-secret-key" });
  assert.deepEqual(await getJellyfinConfig("remote"), { url: "http://remote.example.com", apiKey: "remote-secret-key" });
});
