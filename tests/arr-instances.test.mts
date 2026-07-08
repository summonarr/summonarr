// Unit tests for Radarr/Sonarr instance→Setting-key derivation
// (src/lib/arr-instances.ts). A regression here silently points config at the
// wrong (or a non-existent) instance, which the reader treats as "not
// configured" — so the mapping is worth pinning down.
import { test } from "node:test";
import assert from "node:assert/strict";
import { arrSettingKey, variantToInstanceKey, ARR_INSTANCE_KEYS } from "../src/lib/arr-instances.ts";

test("arrSettingKey derives HD (default) and 4K keys", () => {
  assert.equal(arrSettingKey("radarr", "", "Url"), "radarrUrl");
  assert.equal(arrSettingKey("radarr", "", "ApiKey"), "radarrApiKey");
  assert.equal(arrSettingKey("radarr", "", "RootFolder"), "radarrRootFolder");
  assert.equal(arrSettingKey("radarr", "", "QualityProfileId"), "radarrQualityProfileId");
  assert.equal(arrSettingKey("radarr", "4k", "Url"), "radarr4kUrl");
  assert.equal(arrSettingKey("sonarr", "4k", "ApiKey"), "sonarr4kApiKey");
  assert.equal(arrSettingKey("sonarr", "", "Url"), "sonarrUrl");
});

test("variantToInstanceKey maps the legacy variant union", () => {
  assert.equal(variantToInstanceKey("hd"), "");
  assert.equal(variantToInstanceKey("4k"), "4k");
});

test("derived keys match the existing convention for both instances × services", () => {
  for (const inst of ARR_INSTANCE_KEYS) {
    for (const svc of ["radarr", "sonarr"] as const) {
      const expectedSuffix = inst === "4k" ? "4k" : "";
      assert.equal(arrSettingKey(svc, inst, "Url"), `${svc}${expectedSuffix}Url`);
      assert.equal(arrSettingKey(svc, inst, "ApiKey"), `${svc}${expectedSuffix}ApiKey`);
    }
  }
});
