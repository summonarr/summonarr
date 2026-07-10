// Registry pins for STARTER_PACK (src/lib/trash-recommendations.ts) — the
// curated TRaSH-Guides starter set shown at the top of the admin TRaSH page.
// Each entry is a *match descriptor* resolved against the local TrashSpec
// cache (resolveCurated tries match.trashId, then match.slug, then an exact
// then partial case-insensitive name match). These pins guard the properties
// resolution depends on: every entry must carry at least one exact-match
// candidate (trashId/slug) plus a name for the rename-resilience fallback,
// (service, kind) is the effective registry key (the two NAMING entries
// deliberately share the pseudo-id "default", so trashId alone is NOT unique),
// and the identity strings must not drift — a silently-edited trashId/slug
// would make the starter pack render as "not synced" against a healthy cache.
// The trash-validators payload guards are not applicable here: these are match
// descriptors, not upstream payloads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { STARTER_PACK } from "../src/lib/trash-recommendations.ts";
import type { StarterPackItem } from "../src/lib/trash-recommendations.ts";

test("pack shape: exactly 4 entries — QUALITY_PROFILE + NAMING for each service", () => {
  assert.equal(STARTER_PACK.length, 4);
  const keys = STARTER_PACK.map((i) => `${i.service}:${i.kind}`).sort();
  assert.deepEqual(keys, [
    "RADARR:NAMING",
    "RADARR:QUALITY_PROFILE",
    "SONARR:NAMING",
    "SONARR:QUALITY_PROFILE",
  ]);
});

test("(service, kind) is unique — it is the registry key", () => {
  const keys = new Set(STARTER_PACK.map((i) => `${i.service}:${i.kind}`));
  assert.equal(keys.size, STARTER_PACK.length);
});

test("every entry is recommended — non-recommended rows are derived at runtime, never curated", () => {
  for (const item of STARTER_PACK) {
    assert.equal(item.recommended, true, `${item.label} must be recommended`);
  }
});

test("every entry has a non-empty label and rationale for the admin UI", () => {
  for (const item of STARTER_PACK) {
    assert.ok(item.label.trim().length > 0, "label must be non-empty");
    assert.ok(item.rationale.trim().length > 0, `rationale for ${item.label} must be non-empty`);
  }
});

test("labels are unique and prefixed by service (Movies: / TV:)", () => {
  const labels = new Set(STARTER_PACK.map((i) => i.label));
  assert.equal(labels.size, STARTER_PACK.length);
  for (const item of STARTER_PACK) {
    const prefix = item.service === "RADARR" ? "Movies:" : "TV:";
    assert.ok(
      item.label.startsWith(prefix),
      `label "${item.label}" must start with "${prefix}" for service ${item.service}`,
    );
  }
});

test("every entry carries a match with an exact candidate AND a name fallback", () => {
  for (const item of STARTER_PACK) {
    const match = item.match;
    assert.ok(match, `${item.label}: match is required — resolveCurated returns null without one`);
    // At least one exact-match candidate feeds resolveCurated's trashId loop.
    assert.ok(
      Boolean(match.trashId) || Boolean(match.slug),
      `${item.label}: needs a trashId or slug exact-match candidate`,
    );
    // The name backstop keeps minor TRaSH upstream renames from blanking the pack.
    assert.ok(
      typeof match.name === "string" && match.name.trim().length > 0,
      `${item.label}: needs a non-empty match.name for the rename-resilience fallback`,
    );
    // Whatever candidates exist must be non-empty strings — "" would query for
    // a blank trashId and can never match a cached spec.
    for (const candidate of [match.trashId, match.slug]) {
      if (candidate !== undefined) {
        assert.ok(candidate.trim().length > 0, `${item.label}: empty match candidate`);
      }
    }
  }
});

function find(service: StarterPackItem["service"], kind: StarterPackItem["kind"]): StarterPackItem {
  const item = STARTER_PACK.find((i) => i.service === service && i.kind === kind);
  assert.ok(item, `missing ${service}:${kind} entry`);
  return item;
}

test("PIN: Radarr quality profile identity (HD Bluray + WEB)", () => {
  const item = find("RADARR", "QUALITY_PROFILE");
  assert.equal(item.match?.trashId, "d1d67249d3890e49bc12e275d989a7e9");
  assert.equal(item.match?.slug, "hd-bluray-web");
  assert.equal(item.match?.name, "HD Bluray + WEB");
  // Real TRaSH ids are 32-char lowercase hex — a typo'd or truncated id would
  // silently fall through to the name match and mask itself.
  assert.match(item.match?.trashId ?? "", /^[0-9a-f]{32}$/);
});

test("PIN: Sonarr quality profile identity (WEB-1080p, slug-resolved — no trashId)", () => {
  const item = find("SONARR", "QUALITY_PROFILE");
  assert.equal(item.match?.trashId, undefined);
  assert.equal(item.match?.slug, "web-1080p");
  assert.equal(item.match?.name, "WEB-1080p");
});

test('PIN: both NAMING entries use the pseudo-id "default" + the canonical name', () => {
  for (const service of ["RADARR", "SONARR"] as const) {
    const item = find(service, "NAMING");
    assert.equal(item.match?.trashId, "default");
    assert.equal(item.match?.name, "TRaSH Standard Naming");
    assert.equal(item.match?.slug, undefined);
  }
});

test('the "default" pseudo-id appears ONLY on NAMING entries', () => {
  // "default" is not a real TRaSH hash; it is meaningful only inside a
  // (service, NAMING) namespace. A QUALITY_PROFILE/QUALITY_SIZE entry using it
  // would collide with whatever spec the sync stored under that id.
  for (const item of STARTER_PACK) {
    if (item.match?.trashId === "default") {
      assert.equal(item.kind, "NAMING", `${item.label}: "default" outside NAMING`);
    }
  }
});

test("slugs are unique across the pack where present", () => {
  const slugs = STARTER_PACK.map((i) => i.match?.slug).filter((s): s is string => Boolean(s));
  assert.equal(new Set(slugs).size, slugs.length);
});

test("non-default trashIds are unique across the pack", () => {
  const ids = STARTER_PACK
    .map((i) => i.match?.trashId)
    .filter((id): id is string => Boolean(id) && id !== "default");
  assert.equal(new Set(ids).size, ids.length);
});
