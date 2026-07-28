// Unit tests for Plex/Jellyfin instance→Setting-key derivation and the
// ActiveSession id encoding (src/lib/media-instances.ts). A regression in the
// key mapping silently points config at the wrong (or a non-existent)
// instance, which the reader treats as "not configured"; a regression in the
// session-id encoding can collide two servers' sessions onto one row.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  plexSettingKey,
  jellyfinSettingKey,
  instanceKeySegment,
  isValidMediaInstanceSlug,
  activeSessionId,
  parseActiveSessionId,
  DEFAULT_MEDIA_INSTANCE,
} from "../src/lib/media-instances.ts";

test("plexSettingKey derives the default instance's keys byte-identical to the legacy spelling", () => {
  assert.equal(plexSettingKey("", "ServerUrl"), "plexServerUrl");
  assert.equal(plexSettingKey("", "AdminToken"), "plexAdminToken");
  assert.equal(plexSettingKey("", "AdminEmail"), "plexAdminEmail");
  assert.equal(plexSettingKey("", "Libraries"), "plexLibraries");
  assert.equal(plexSettingKey("", "PathStripPrefix"), "plexPathStripPrefix");
  assert.equal(plexSettingKey("", "MoviePathStripPrefix"), "plexMoviePathStripPrefix");
  assert.equal(plexSettingKey("", "TvPathStripPrefix"), "plexTvPathStripPrefix");
});

test("jellyfinSettingKey derives the default instance's keys byte-identical to the legacy spelling", () => {
  assert.equal(jellyfinSettingKey("", "Url"), "jellyfinUrl");
  assert.equal(jellyfinSettingKey("", "ApiKey"), "jellyfinApiKey");
  assert.equal(jellyfinSettingKey("", "Libraries"), "jellyfinLibraries");
  assert.equal(jellyfinSettingKey("", "RestrictSignIn"), "jellyfinRestrictSignIn");
});

test("named instances camelCase the slug into the key", () => {
  assert.equal(plexSettingKey("remote", "ServerUrl"), "plexRemoteServerUrl");
  assert.equal(plexSettingKey("remote", "AdminToken"), "plexRemoteAdminToken");
  assert.equal(jellyfinSettingKey("remote", "Url"), "jellyfinRemoteUrl");
  assert.equal(jellyfinSettingKey("remote", "ApiKey"), "jellyfinRemoteApiKey");
  assert.equal(instanceKeySegment(""), "");
  assert.equal(instanceKeySegment("remote"), "Remote");
});

test("named-instance secret keys match the encryption gate shape (guardrail 7a)", async () => {
  const { isSensitiveSettingKey } = await import("../src/lib/settings-sensitive-keys.ts");
  assert.equal(isSensitiveSettingKey("plexRemoteAdminToken"), true);
  assert.equal(isSensitiveSettingKey("jellyfinRemoteApiKey"), true);
  assert.equal(isSensitiveSettingKey("plexAdminToken"), true);
  assert.equal(isSensitiveSettingKey("jellyfinApiKey"), true);
  // ...but non-secret instance keys stay plaintext by design.
  assert.equal(isSensitiveSettingKey("plexRemoteServerUrl"), false);
  assert.equal(isSensitiveSettingKey("plexRemoteAdminEmail"), false);
  assert.equal(isSensitiveSettingKey("plexRemoteLibraries"), false);
  assert.equal(isSensitiveSettingKey("jellyfinRemoteUrl"), false);
  assert.equal(isSensitiveSettingKey("jellyfinRemoteRestrictSignIn"), false);
});

test("isValidMediaInstanceSlug accepts the default + named slugs, rejects malformed ones", () => {
  assert.equal(isValidMediaInstanceSlug(""), true);
  assert.equal(isValidMediaInstanceSlug("remote"), true);
  assert.equal(isValidMediaInstanceSlug("server2"), true);
  // Must be lowercase, start with a letter, no separators.
  assert.equal(isValidMediaInstanceSlug("Remote"), false);
  assert.equal(isValidMediaInstanceSlug("2server"), false);
  assert.equal(isValidMediaInstanceSlug("re mote"), false);
  assert.equal(isValidMediaInstanceSlug("remote!"), false);
  assert.equal(isValidMediaInstanceSlug("plex:remote"), false);
});

test("activeSessionId: default instance keeps the exact legacy 2-segment format", () => {
  assert.equal(activeSessionId("plex", DEFAULT_MEDIA_INSTANCE, "5"), "plex:5");
  assert.equal(activeSessionId("jellyfin", "", "abc-123"), "jellyfin:abc-123");
});

test("activeSessionId: a named instance gets a 3rd segment", () => {
  assert.equal(activeSessionId("plex", "remote", "5"), "plex:remote:5");
  assert.equal(activeSessionId("jellyfin", "remote", "abc-123"), "jellyfin:remote:abc-123");
});

test("parseActiveSessionId round-trips both the 2-segment and 3-segment forms", () => {
  assert.deepEqual(parseActiveSessionId("plex:5"), { source: "plex", serverInstance: "", sessionKey: "5" });
  assert.deepEqual(parseActiveSessionId("plex:remote:5"), { source: "plex", serverInstance: "remote", sessionKey: "5" });
  assert.deepEqual(parseActiveSessionId("jellyfin:abc-123"), { source: "jellyfin", serverInstance: "", sessionKey: "abc-123" });
  assert.deepEqual(parseActiveSessionId("jellyfin:remote:abc-123"), { source: "jellyfin", serverInstance: "remote", sessionKey: "abc-123" });
});

test("activeSessionId/parseActiveSessionId round-trip is lossless for every instance kind", () => {
  for (const [source, instance, key] of [
    ["plex", "", "42"],
    ["plex", "remote", "42"],
    ["jellyfin", "", "session-uuid"],
    ["jellyfin", "remote", "session-uuid"],
  ] as const) {
    const id = activeSessionId(source, instance, key);
    const parsed = parseActiveSessionId(id);
    assert.equal(parsed.source, source);
    assert.equal(parsed.serverInstance, instance);
    assert.equal(parsed.sessionKey, key);
  }
});

test("two Plex instances never collide on the same sessionKey — the collision risk this format fixes", () => {
  const defaultId = activeSessionId("plex", "", "5");
  const remoteId = activeSessionId("plex", "remote", "5");
  assert.notEqual(defaultId, remoteId);
});
