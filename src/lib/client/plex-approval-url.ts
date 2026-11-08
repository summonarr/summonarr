// The plex.tv PIN approval URL and the address Plex sends the browser back to
// (/auth/plex/done). Pure and zero-import so the rules are unit-tested; the
// settings "Connect Plex" form builds its URL here, and the login form's copy
// should move here too so the two can't drift again.

// Normalised like base-path.ts: leading slash, no trailing slash, "" for none.
function normaliseBasePath(basePath: string): string {
  const trimmed = basePath.trim().replace(/^\/+|\/+$/g, "");
  return trimmed ? `/${trimmed}` : "";
}

/**
 * The app's root URL for the return trip: the configured public URL (the admin
 * site URL, else AUTH_URL), else this page's origin, with the base path on the
 * end. The app is served only under BASE_PATH, and AUTH_URL and the origin are
 * bare origins, so a bare base sent Plex back to a 404 on a sub-path install.
 * A configured URL that already ends in the base path is used as is (the same
 * rule email.ts applies to AUTH_URL).
 */
export function plexReturnBase(configured: string, origin: string, basePath: string): string {
  const base = (configured.trim() || origin).replace(/\/+$/, "");
  const bp = normaliseBasePath(basePath);
  return bp && !base.endsWith(bp) ? `${base}${bp}` : base;
}

/** Where Plex sends the browser once the PIN is approved. */
export function plexForwardUrl(base: string, state: string): string {
  return `${base}/auth/plex/done?state=${encodeURIComponent(state)}`;
}

/**
 * The plex.tv page that approves a PIN. Every value is query-encoded, the code
 * included: it comes from plex.tv through our server, which checks only that it
 * is a string. `clientId` must be the identifier the PIN was created under (for
 * the settings flow, the per-attempt one the server minted — guardrail 6f).
 */
export function plexApprovalUrl(params: {
  clientId: string;
  code: string;
  forwardUrl: string;
  device?: Record<string, string>;
}): string {
  const query = new URLSearchParams({ clientID: params.clientId, code: params.code });
  for (const [key, value] of Object.entries(params.device ?? {})) query.set(`context[device][${key}]`, value);
  query.set("forwardUrl", params.forwardUrl);
  return `https://app.plex.tv/auth#?${query.toString()}`;
}
