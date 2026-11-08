// The Jellyfin transport: who we say we are, the token headers, and the one
// builder every /Items query goes through. Everything else in the Jellyfin
// client (jellyfin-*.ts, re-exported by jellyfin.ts) builds on this. The
// server URL is an admin Setting, so every call goes through
// safeFetchAdminConfigured (guardrail 5a).
import { trimServerBase } from "./server-url";

export const FETCH_TIMEOUT_MS = 30_000;

// Jellyfin is removing its legacy auth transports: PR jellyfin/jellyfin#13306
// (10.11) deprecates X-Emby-Authorization / X-Emby-Token / X-MediaBrowser-Token /
// api_key behind an EnableLegacyAuthorization flag, and 10.12 turns that flag
// off by default — including for UPGRADED installs, via a startup migration.
// With legacy off, only `Authorization: MediaBrowser ...` (and the ApiKey query
// param) is read, so every identity/token below is sent under BOTH the standard
// Authorization header and its legacy twin: old servers keep finding the form
// they honor, 10.12+ finds the only one it still reads.
const JELLYFIN_IDENTITY = 'MediaBrowser Client="Summonarr", Device="Summonarr", DeviceId="summonarr-server", Version="1.0"';

/** The client identity alone, for the token-less sign-in calls. */
export function jellyfinIdentityHeaders(withJsonBody: boolean): Record<string, string> {
  return {
    "Authorization": JELLYFIN_IDENTITY,
    "X-Emby-Authorization": JELLYFIN_IDENTITY,
    ...(withJsonBody ? { "Content-Type": "application/json" } : {}),
  };
}

// Token-authenticated calls dual-send the API key: `Authorization: MediaBrowser
// ..., Token="..."` for 10.12+ (legacy transports disabled — see
// JELLYFIN_IDENTITY) plus the legacy X-MediaBrowser-Token for older servers.
export function jellyfinHeaders(apiKey: string): Record<string, string> {
  return {
    "Authorization": `${JELLYFIN_IDENTITY}, Token="${apiKey}"`,
    "X-MediaBrowser-Token": apiKey,
    "Content-Type": "application/json",
    "User-Agent": "Summonarr/1.0 (Node.js)",
  };
}

// Alias kept for call sites hitting RequiresElevation endpoints (GET /Users,
// POST /Users/{id}/Policy, session commands, RemoteSearch/Apply, item Refresh).
// The header shape is now identical to jellyfinHeaders — upstream's elevation
// check keys on the API key's admin role, never on which header carried it —
// but the distinct name documents which surfaces assume an admin-scoped key.
export const jellyfinAdminHeaders = jellyfinHeaders;

// Sent on every /Items query that can list a Movie or a Series (guardrail 37d).
// An API key has no user, and for a user-less query Jellyfin groups movies and
// shows into their collections whatever the server's "group into collections"
// settings say (Folder.CollapseBoxSetItems: those settings are only consulted
// when there IS a user). Each member of a TMDB collection is then replaced by
// its BoxSet — ExcludeItemTypes=BoxSet does not stop it, the grouping runs
// after the type filter. Seen live on Jellyfin 12.2: 2,230 of 9,134 movies
// were missing from the library sync, Practical Magic 2 among them. Only an
// explicit false always wins; a filter like MinDateLastSaved or SearchTerm
// does not turn the grouping off.
export const JELLYFIN_NO_COLLECTION_GROUPING = "CollapseBoxSetItems=false";

/** One /Items query parameter; a falsy entry is left out (an optional filter). */
export type ItemsParam = readonly [name: string, value: string | number] | null | undefined | false;

// The params that choose WHICH items a query lists. The grouping flag follows
// the last of them.
const SELECTION_PARAMS = new Set(["IncludeItemTypes", "ExcludeItemTypes", "Ids"]);

// A query limited to Episode can't be grouped (Folder.CollapseBoxSetItems only
// fires for Movie/Series or an untyped query), so it is the one exemption.
function canListMovieOrSeries(params: ReadonlyArray<readonly [string, string | number]>): boolean {
  const types = params.find(([name]) => name === "IncludeItemTypes")?.[1];
  return types === undefined || String(types).split(",").some((t) => t !== "Episode");
}

// Jellyfin's list params are comma-separated, so a comma stays a comma; every
// other reserved character in a value is percent-encoded (a stored ParentId or
// user id can never add a query parameter).
function encodeValue(value: string | number): string {
  return encodeURIComponent(String(value)).replace(/%2C/gi, ",");
}

/**
 * The URL of a GET /Items query: the params in the order given. Every query
 * that can list a Movie or a Series also carries CollapseBoxSetItems=false
 * (guardrail 37d), placed right after the params that choose the items — the
 * flag is the builder's, so no query can leave it out.
 */
export function jellyfinItemsUrl(baseUrl: string, params: readonly ItemsParam[]): string {
  const present = params.filter((p): p is readonly [string, string | number] => Boolean(p));
  const parts = present.map(([name, value]) => `${name}=${encodeValue(value)}`);
  if (canListMovieOrSeries(present) && !present.some(([name]) => name === "CollapseBoxSetItems")) {
    let at = 0;
    present.forEach(([name], i) => { if (SELECTION_PARAMS.has(name)) at = i + 1; });
    parts.splice(at, 0, JELLYFIN_NO_COLLECTION_GROUPING);
  }
  return `${trimServerBase(baseUrl)}/Items?${parts.join("&")}`;
}
