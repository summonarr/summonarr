// Unit tests for the feature-flag registry (src/lib/features.ts) — the single
// source of truth behind the admin Features tab, requireFeature() page 404
// gates, and the integration off-switches. These pins matter because:
//   - Flag values are "true"/"false" strings in the Setting table; anything
//     else (case drift, whitespace, "1"/"yes") must fall back to the
//     registered default, never truthy-coerce — a mis-parse silently 404s a
//     page or resurrects a disabled integration.
//   - Legacy keys (motdEnabled, playHistoryEnabled, trashGuidesEnabled) reuse
//     pre-Features-tab Setting rows so old and new UIs stay in sync — their
//     exact spelling and their historical default-OFF state are load-bearing.
//   - groupFeaturesByCategory drives the Features tab render; a definition
//     that falls out of the partition becomes an admin-invisible flag that can
//     never be toggled back.
// Only the DB-bypassing surfaces are exercised: getFeatureFlags(cfg) with an
// explicit map (the pure computeFlags path), the registry constants, and the
// category grouping. The prisma.setting delegate is shadowed with a throwing
// stub (the tests/jellyfin-config.test.mts pattern) so any accidental hit on
// the DB-backed path fails fast instead of hanging on a nonexistent database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma.ts";
import {
  FEATURE_DEFINITIONS,
  FEATURE_KEYS,
  getFeatureFlags,
  groupFeaturesByCategory,
  invalidateFeatureFlagCache,
  type FeatureCategory,
} from "../src/lib/features.ts";

// ── DB guard ─────────────────────────────────────────────────────────────
// Nothing in this file may read the Setting table. Shadow the delegate so a
// regression (or a future test calling isFeatureEnabled/requireFeature) throws
// immediately rather than issuing a real query that would hang the harness.
const throwingSettingStub = {
  findMany: async (): Promise<never> => {
    throw new Error("unexpected prisma.setting.findMany — this suite must stay on the DB-bypassing cfg path");
  },
  findUnique: async (): Promise<never> => {
    throw new Error("unexpected prisma.setting.findUnique — this suite must stay on the DB-bypassing cfg path");
  },
};
(prisma as unknown as { setting: unknown }).setting = throwingSettingStub;
if ((prisma as unknown as { setting: unknown }).setting !== throwingSettingStub) {
  throw new Error("could not shadow prisma.setting with the throwing stub — aborting before a real DB query can hang");
}

const VALID_CATEGORIES: readonly FeatureCategory[] = ["pages", "behaviors", "integrations", "admin"];

// Legacy Setting rows exposed through the Features tab. Renaming one silently
// desyncs the old settings UI from the new toggle (both write the same row).
const LEGACY_KEYS = ["motdEnabled", "playHistoryEnabled", "trashGuidesEnabled"] as const;

// ── Registry invariants ──────────────────────────────────────────────────

test("FEATURE_KEYS mirrors FEATURE_DEFINITIONS order and every key is unique", () => {
  assert.ok(FEATURE_DEFINITIONS.length >= 22); // 22 flags as of this writing
  assert.deepEqual(
    FEATURE_KEYS,
    FEATURE_DEFINITIONS.map((f) => f.key),
  );
  assert.equal(new Set(FEATURE_KEYS).size, FEATURE_KEYS.length);
});

test("every definition carries a valid category and non-empty UI strings", () => {
  for (const def of FEATURE_DEFINITIONS) {
    assert.ok(VALID_CATEGORIES.includes(def.category), `${def.key} has unknown category "${def.category}"`);
    assert.ok(def.label.length > 0, `${def.key} has an empty label`);
    assert.ok(def.description.length > 0, `${def.key} has an empty description`);
    assert.equal(typeof def.defaultEnabled, "boolean", `${def.key} defaultEnabled is not a boolean`);
  }
});

test("labels are unique — no two toggles render the same Features-tab text", () => {
  const labels = FEATURE_DEFINITIONS.map((f) => f.label);
  assert.equal(new Set(labels).size, labels.length);
});

test("every key is either a feature.* key or one of the exact legacy Setting keys", () => {
  const legacy = FEATURE_KEYS.filter((k) => !k.startsWith("feature."));
  assert.deepEqual([...legacy].sort(), [...LEGACY_KEYS].sort());
});

test("feature.* key prefixes agree with their category (nav/gating consistency)", () => {
  const prefixToCategory: ReadonlyArray<[string, FeatureCategory]> = [
    ["feature.page.", "pages"],
    ["feature.behavior.", "behaviors"],
    ["feature.integration.", "integrations"],
    ["feature.admin.", "admin"],
  ];
  for (const def of FEATURE_DEFINITIONS) {
    if (!def.key.startsWith("feature.")) continue;
    const match = prefixToCategory.find(([prefix]) => def.key.startsWith(prefix));
    assert.ok(match, `${def.key} has no recognized feature.* prefix`);
    assert.equal(def.category, match[1], `${def.key} category disagrees with its prefix`);
  }
});

test("defaults are sane: feature.* flags default ON, legacy flags keep their historical OFF default", () => {
  // Legacy keys predate the Features tab; a missing row historically meant
  // "off" for them (MOTD popup, play-history capture, TRaSH sync are all
  // opt-in). Flipping one of these defaults would activate the behavior on
  // every install with no explicit Setting row.
  for (const def of FEATURE_DEFINITIONS) {
    if ((LEGACY_KEYS as readonly string[]).includes(def.key)) {
      assert.equal(def.defaultEnabled, false, `legacy ${def.key} must default OFF`);
    } else {
      assert.equal(def.defaultEnabled, true, `${def.key} must default ON`);
    }
  }
});

test("spot checks: security/UX-salient definitions are exact", () => {
  const byKey = new Map(FEATURE_DEFINITIONS.map((f) => [f.key, f]));
  assert.equal(byKey.get("feature.page.top")?.defaultEnabled, true);
  assert.equal(byKey.get("motdEnabled")?.category, "behaviors");
  assert.equal(byKey.get("playHistoryEnabled")?.category, "behaviors");
  assert.equal(byKey.get("trashGuidesEnabled")?.category, "admin");
  assert.equal(byKey.get("feature.integration.push")?.category, "integrations");
});

// ── groupFeaturesByCategory partition ────────────────────────────────────

test("grouping is a complete partition — every definition appears exactly once", () => {
  const groups = groupFeaturesByCategory();
  assert.deepEqual(Object.keys(groups).sort(), [...VALID_CATEGORIES].sort());
  const all = Object.values(groups).flat();
  assert.equal(all.length, FEATURE_DEFINITIONS.length);
  assert.deepEqual(
    all.map((f) => f.key).sort(),
    [...FEATURE_KEYS].sort(),
  );
});

test("each group contains exactly the definitions of its category, in registry order", () => {
  const groups = groupFeaturesByCategory();
  for (const category of VALID_CATEGORIES) {
    assert.deepEqual(
      groups[category],
      FEATURE_DEFINITIONS.filter((f) => f.category === category),
      `group "${category}" drifted from the registry`,
    );
    for (const def of groups[category]) {
      assert.equal(def.category, category, `${def.key} landed in the wrong group`);
    }
  }
});

test("group sizes are exact (pins accidental category reassignment)", () => {
  const groups = groupFeaturesByCategory();
  assert.equal(groups.pages.length, 6);
  assert.equal(groups.behaviors.length, 4);
  assert.equal(groups.integrations.length, 7);
  assert.equal(groups.admin.length, 5);
});

// ── getFeatureFlags(cfg) — the pure computeFlags path ────────────────────

test("empty cfg → every flag equals its registered default", async () => {
  const flags = await getFeatureFlags({});
  assert.deepEqual(Object.keys(flags).sort(), [...FEATURE_KEYS].sort());
  for (const def of FEATURE_DEFINITIONS) {
    assert.equal(flags[def.key], def.defaultEnabled, def.key);
  }
});

test('explicit "true"/"false" overrides the default in BOTH directions', async () => {
  // Flip every flag to the opposite of its default: default-ON pages must be
  // disableable and default-OFF legacy behaviors must be enableable.
  const cfg: Record<string, string> = {};
  for (const def of FEATURE_DEFINITIONS) cfg[def.key] = def.defaultEnabled ? "false" : "true";
  const flags = await getFeatureFlags(cfg);
  for (const def of FEATURE_DEFINITIONS) {
    assert.equal(flags[def.key], !def.defaultEnabled, def.key);
  }
});

test('only the exact strings "true"/"false" parse — anything else falls back to the default', async () => {
  // The Setting convention stores exact lowercase strings. Truthy-looking
  // junk must NOT enable a default-OFF flag, and falsy-looking junk must NOT
  // disable a default-ON one — unparseable rows read as "no row".
  const junkValues = ["TRUE", "True", "FALSE", "False", "1", "0", "yes", "no", "on", "off", " true", "false ", ""];
  for (const junk of junkValues) {
    const cfg: Record<string, string> = {
      motdEnabled: junk, // default OFF — junk must not switch it on
      "feature.page.top": junk, // default ON — junk must not switch it off
    };
    const flags = await getFeatureFlags(cfg);
    assert.equal(flags.motdEnabled, false, `motdEnabled flipped on by ${JSON.stringify(junk)}`);
    assert.equal(flags["feature.page.top"], true, `feature.page.top flipped off by ${JSON.stringify(junk)}`);
  }
});

test("mixed cfg: per-key values, junk, and missing rows resolve independently", async () => {
  const flags = await getFeatureFlags({
    "feature.page.votes": "false", // explicit off
    trashGuidesEnabled: "true", // explicit on (default off)
    playHistoryEnabled: "enabled", // junk → default off
    // feature.integration.plex missing → default on
  });
  assert.equal(flags["feature.page.votes"], false);
  assert.equal(flags.trashGuidesEnabled, true);
  assert.equal(flags.playHistoryEnabled, false);
  assert.equal(flags["feature.integration.plex"], true);
});

test("cfg keys outside the registry are ignored — output is exactly the registered flags", async () => {
  const flags = await getFeatureFlags({
    "feature.page.top": "false",
    maintenanceEnabled: "true", // a real Setting key, but not a feature flag
    "feature.page.nonexistent": "true",
  });
  assert.deepEqual(Object.keys(flags).sort(), [...FEATURE_KEYS].sort());
  assert.equal(flags["feature.page.top"], false);
  assert.ok(!("maintenanceEnabled" in flags));
  assert.ok(!("feature.page.nonexistent" in flags));
});

test("an explicit cfg bypasses the cache and the Setting query entirely", async () => {
  // The prisma.setting delegate above throws on any call — reaching this
  // assertion proves the cfg path never touched it. This is the contract the
  // settings page relies on: it already holds a findMany scan and must not
  // pay (or race) a second read through the flag cache.
  const flags = await getFeatureFlags({ motdEnabled: "true" });
  assert.equal(flags.motdEnabled, true);
});

test("invalidateFeatureFlagCache is DB-free and callable at any time", () => {
  // /api/settings calls this synchronously after its writes; it must never
  // throw or touch the database (the throwing stub would surface it).
  invalidateFeatureFlagCache();
  invalidateFeatureFlagCache(); // idempotent — double invalidation is fine
});
