// The arr instance save's body checks and connection writes
// (src/lib/arr-instances-save.ts): a wrong JSON type is refused before any
// write instead of being stored as text that reads back as nothing, and only a
// changed address or key earns a connection test.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  connectionChanged,
  connectionWrites,
  instancePayloadError,
  isProfileIdInput,
} from "../src/lib/arr-instances-save.ts";
import { SECRET_MASK_SENTINEL } from "../src/lib/secret-mask.ts";

// Echoes the key, so a test can tell which refusal it got.
const t = ((key: string) => key) as Parameters<typeof instancePayloadError>[1];

test("a profile id is a positive whole number or its digits — never true, a list, a fraction or padded text", () => {
  for (const ok of [1, 5, "5", "12"]) assert.equal(isProfileIdInput(ok), true, String(ok));
  for (const bad of [true, [5], 0, -1, 1.5, "0", "5.0", " 5", "5 ", "abc", {}, Number.MAX_SAFE_INTEGER + 2]) {
    assert.equal(isProfileIdInput(bad), false, JSON.stringify(bad));
  }
});

test("profile ids of the wrong JSON type are refused; null and \"\" still clear", () => {
  for (const field of ["qualityProfileId", "languageProfileId"] as const) {
    const key = field === "qualityProfileId" ? "apiAdmin.arrInstances.invalidQualityProfileId" : "apiAdmin.arrInstances.invalidLanguageProfileId";
    assert.equal(instancePayloadError({ slug: "anime", [field]: true }, t), key);
    assert.equal(instancePayloadError({ slug: "anime", [field]: [5] }, t), key);
    assert.equal(instancePayloadError({ slug: "anime", [field]: null }, t), null);
    assert.equal(instancePayloadError({ slug: "anime", [field]: "" }, t), null);
    assert.equal(instancePayloadError({ slug: "anime", [field]: 3 }, t), null);
  }
});

test("an externalUrl that is not text, null or absent is refused before it could be stored as \"[object Object]\"", () => {
  assert.equal(instancePayloadError({ slug: "anime", externalUrl: { href: "http://x" } }, t), "apiAdmin.arrInstances.invalidUrl");
  assert.equal(instancePayloadError({ slug: "anime", externalUrl: 7 }, t), "apiAdmin.arrInstances.invalidUrl");
  assert.equal(instancePayloadError({ slug: "anime", externalUrl: null }, t), null);
  assert.equal(instancePayloadError({ slug: "anime", externalUrl: "https://radarr.example.com" }, t), null);
});

test("minimumAvailability is one of Radarr's values as text — a list carrying one is refused", () => {
  assert.equal(instancePayloadError({ slug: "anime", minimumAvailability: ["released"] }, t), "apiAdmin.arrInstances.invalidMinimumAvailability");
  assert.equal(instancePayloadError({ slug: "anime", minimumAvailability: "soon" }, t), "apiAdmin.arrInstances.invalidMinimumAvailability");
  assert.equal(instancePayloadError({ slug: "anime", minimumAvailability: "released" }, t), null);
  assert.equal(instancePayloadError({ slug: "anime", minimumAvailability: null }, t), null);
});

test("the slug, secrets and name keep their checks", () => {
  assert.equal(instancePayloadError({ slug: "Bad Slug" }, t), "apiAdmin.common.invalidSlug");
  assert.equal(instancePayloadError(null, t), "apiAdmin.common.invalidSlug");
  assert.equal(instancePayloadError({ slug: "anime", apiKey: 5 }, t), "apiAdmin.common.invalidSecret");
  assert.equal(instancePayloadError({ slug: "anime", webhookSecret: "x".repeat(513) }, t), "apiAdmin.common.invalidSecret");
  assert.equal(instancePayloadError({ slug: "anime", name: "n".repeat(101) }, t), "apiAdmin.common.instanceNameTooLong");
});

test("connectionWrites leaves absent fields alone, clears with null, and never writes a masked secret", () => {
  assert.deepEqual(connectionWrites({ slug: "anime" }), []);
  assert.deepEqual(
    connectionWrites({ slug: "anime", url: " http://r:7878 ", externalUrl: null, apiKey: SECRET_MASK_SENTINEL, qualityProfileId: 4, webhookSecret: "s" }),
    [
      { field: "Url", value: "http://r:7878" },
      { field: "ExternalUrl", value: "" },
      { field: "QualityProfileId", value: "4" },
      { field: "WebhookSecret", value: "s" },
    ],
  );
});

test("a connection counts as changed only when its address or key differs from the stored one", () => {
  const stored = { url: "http://r:7878", apiKey: "k" };
  assert.equal(connectionChanged(connectionWrites({ slug: "a", url: "http://r:7878", apiKey: SECRET_MASK_SENTINEL, name: "renamed" }), stored), false);
  assert.equal(connectionChanged(connectionWrites({ slug: "a", rootFolder: "/movies" }), stored), false);
  assert.equal(connectionChanged(connectionWrites({ slug: "a", url: "http://r2:7878" }), stored), true);
  assert.equal(connectionChanged(connectionWrites({ slug: "a", apiKey: "k2" }), stored), true);
  // A new instance: nothing stored yet.
  assert.equal(connectionChanged(connectionWrites({ slug: "a", url: "http://r:7878", apiKey: "k" }), { url: undefined, apiKey: undefined }), true);
});
