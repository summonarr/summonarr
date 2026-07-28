// Plex/Jellyfin instance addressing — the single source of truth for how a
// media-server instance maps to its Setting keys and to an ActiveSession id.
// Mirrors the arr-instances.ts precedent (Radarr/Sonarr multi-instance), with
// one deliberate divergence: nothing here routes a request to one instance —
// availability is a union across every configured server of a type (see
// CLAUDE.md's multi-server guardrail), so there is no routing predicate to
// carry, unlike arr's ArrAutoRoute/routeMediaToSlug.
//
// An instance is identified by a slug string:
//   ""       → the default server   (Setting keys: plexServerUrl, jellyfinUrl, …)
//   "<name>" → a named additional server (plex<Name>ServerUrl, jellyfin<Name>Url, …)
//
// Named slugs capitalize their first character when forming a Setting key
// (plex + Remote + AdminToken → plexRemoteAdminToken), matching the camelCase
// shape settings-sensitive-keys.ts's MEDIA_INSTANCE_SECRET_RE expects.
//
// PURE — zero imports so it's unit-testable and usable from client components
// (the settings UI) as well as server routes. The server-side registry (which
// reads the configured instances out of Settings) lives in
// media-instance-registry.ts and delegates key derivation to this module.

export type MediaServerService = "plex" | "jellyfin";

// Instance slug. "" is the default (and, today, only) server for every existing
// deployment; any other value is a named additional server.
export type MediaInstanceKey = string;

export const DEFAULT_MEDIA_INSTANCE = "";

// Named slugs are lowercase alnum starting with a letter, so the derived
// Setting key is a valid camelCase identifier. "" is the one grandfathered
// exception. Identical shape to arr-instances.ts's NAMED_SLUG_RE.
const NAMED_SLUG_RE = /^[a-z][a-z0-9]{0,23}$/;

export function isValidMediaInstanceSlug(slug: string): boolean {
  if (slug === DEFAULT_MEDIA_INSTANCE) return true;
  return NAMED_SLUG_RE.test(slug);
}

// The Setting-key segment for an instance slug. "" → "", "remote" → "Remote".
export function instanceKeySegment(instance: MediaInstanceKey): string {
  if (instance === DEFAULT_MEDIA_INSTANCE) return "";
  return instance.charAt(0).toUpperCase() + instance.slice(1);
}

// Plex and Jellyfin don't share a field-name shape (unlike Radarr/Sonarr), so
// two typed key-derivation functions instead of one shared field union.
export type PlexSettingField =
  | "ServerUrl"
  | "AdminToken"
  | "AdminEmail"
  | "Libraries"
  | "PathStripPrefix"
  | "MoviePathStripPrefix"
  | "TvPathStripPrefix";

// e.g. plexSettingKey("", "ServerUrl")       → "plexServerUrl"   (exact legacy key)
//      plexSettingKey("remote", "ServerUrl") → "plexRemoteServerUrl"
export function plexSettingKey(instance: MediaInstanceKey, field: PlexSettingField): string {
  return `plex${instanceKeySegment(instance)}${field}`;
}

export type JellyfinSettingField =
  | "Url"
  | "ApiKey"
  | "Libraries"
  | "PathStripPrefix"
  | "MoviePathStripPrefix"
  | "TvPathStripPrefix"
  | "RestrictSignIn";

// e.g. jellyfinSettingKey("", "Url")           → "jellyfinUrl"   (exact legacy key)
//      jellyfinSettingKey("remote", "ApiKey")  → "jellyfinRemoteApiKey"
export function jellyfinSettingKey(instance: MediaInstanceKey, field: JellyfinSettingField): string {
  return `jellyfin${instanceKeySegment(instance)}${field}`;
}

// ─── ActiveSession id ─────────────────────────────────────────────────────────
// Default instance keeps the exact legacy 2-segment format so every existing
// single-server deployment sees byte-identical ids; named instances get a 3rd
// segment. Slugs can't contain ":" (NAMED_SLUG_RE) and a Plex/Jellyfin
// sessionKey is never colon-bearing either, so a 2-vs-3-part colon split is
// unambiguous.
export function activeSessionId(
  source: "plex" | "jellyfin",
  instance: MediaInstanceKey,
  sessionKey: string,
): string {
  return instance === DEFAULT_MEDIA_INSTANCE ? `${source}:${sessionKey}` : `${source}:${instance}:${sessionKey}`;
}

export interface ParsedActiveSessionId {
  source: string;
  serverInstance: MediaInstanceKey;
  sessionKey: string;
}

export function parseActiveSessionId(id: string): ParsedActiveSessionId {
  const parts = id.split(":");
  if (parts.length >= 3) {
    return { source: parts[0], serverInstance: parts[1], sessionKey: parts.slice(2).join(":") };
  }
  return { source: parts[0] ?? "", serverInstance: DEFAULT_MEDIA_INSTANCE, sessionKey: parts.slice(1).join(":") };
}
