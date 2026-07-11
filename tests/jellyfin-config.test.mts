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
import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma.ts";
import { getConfiguredJellyfinUrl } from "../src/lib/jellyfin-config.ts";

// The real Setting row also carries id/timestamps; the function only reads
// `value` (via `row?.value?.trim()`), so the stub models just what it touches.
type StubRow = { key?: string; value?: string } | null;

let nextRow: StubRow = null;
const findUniqueCalls: Array<{ where: { key: string } }> = [];

const settingStub = {
  findUnique: async (args: { where: { key: string } }): Promise<StubRow> => {
    findUniqueCalls.push(args);
    return nextRow;
  },
};

// Shadow the delegate BEFORE any test runs. If a Prisma upgrade ever stops
// this from taking effect, fail fast and loudly here — otherwise the first
// call would issue a real query against a DB that doesn't exist and hang.
(prisma as unknown as { setting: unknown }).setting = settingStub;
if ((prisma as unknown as { setting: unknown }).setting !== settingStub) {
  throw new Error("could not shadow prisma.setting with the in-memory stub — aborting before a real DB query can hang");
}

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
