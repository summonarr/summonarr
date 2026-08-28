// Shared validation + redaction for admin-configured SERVER URLs
// (Plex/Jellyfin/Radarr/Sonarr). Two routes persist these — /api/settings (the
// legacy `plexServerUrl`/`jellyfinUrl` keys) and /api/admin/media-instances
// (the per-instance `plex<Slug>ServerUrl`/`jellyfin<Slug>Url` keys) — and the
// value ships out verbatim on every safeFetchAdminConfigured call, so both must
// reject the same shapes and neither may echo an embedded credential back to a
// client.

export const SERVER_URL_MAX_LEN = 2000;

// Returns an error message when the value is not an acceptable server URL, or
// null when it passes. `value` is assumed already trimmed and non-empty.
export function validateServerUrl(
  value: string,
  opts: { httpsOnly?: boolean; maxLen?: number } = {},
): string | null {
  const maxLen = opts.maxLen ?? SERVER_URL_MAX_LEN;
  if (value.length > maxLen) return `must be ${maxLen} characters or fewer`;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "must be a valid URL";
  }
  if (opts.httpsOnly) {
    if (parsed.protocol !== "https:") return "must be an https:// URL";
  } else if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "must be an http(s) URL";
  }
  // Embedded credentials (user:pass@host) parse silently and would ship out on
  // every request — operators set credentials via the dedicated apiKey/token
  // field instead.
  if (parsed.username || parsed.password) return "must not contain embedded credentials";
  return null;
}

// Removes any embedded userinfo before a stored URL is returned to a client, so
// a GET never leaks a credential into browser history / devtools / a cache. A
// non-URL value passes through unchanged.
export function stripUrlUserinfo(value: string): string {
  try {
    const u = new URL(value);
    if (u.username || u.password) {
      u.username = "";
      u.password = "";
      return u.toString();
    }
  } catch {
    // Not a parseable URL — let it through unchanged.
  }
  return value;
}
