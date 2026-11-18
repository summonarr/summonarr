// "Watch on Plex / Jellyfin" — the pure half: where a library item lives in
// each server's own client. The data half (which servers the viewer may see,
// which item, which address) is watch-links-data.ts (guardrail 35b).
//
// Plex is addressed through app.plex.tv by the server's machineIdentifier, so
// it needs no server address; its mobile apps take the same pair as a
// plex://libraries/… link. Jellyfin's web client is served by the server
// itself, so its link needs the address a BROWSER uses; its app link is
// Swiftfin's, which also names the viewer's own Jellyfin user on that server.
//
// Neither app documents its links. Plex's is the form its 2026 apps route (the
// older plex://preplay/?metadataKey=… only opens the app's home screen);
// Swiftfin's is the pattern its DeepLink parser matches.
import { arrBrowserBase } from "./arr-links";

export type WatchLinkServer = "plex" | "jellyfin";

export interface WatchLink {
  server: WatchLinkServer;
  // The server's display name — only when the viewer can see more than one
  // server of this kind (otherwise the brand name says it all). Never a slug.
  name: string | null;
  // Opens the title in a browser.
  webUrl: string;
  // Opens the title in a mobile app for the server (Plex's own; Swiftfin for
  // Jellyfin); null when there is none to name.
  appUrl: string | null;
}

// A server identity or item id as the servers issue them: Plex's
// machineIdentifier (hex), a ratingKey (digits), Jellyfin's ids (hex, some
// versions dashed). Anything else is not put in a link.
const LINK_ID_RE = /^[A-Za-z0-9-]{1,128}$/;

export function isWatchLinkId(value: unknown): value is string {
  return typeof value === "string" && LINK_ID_RE.test(value);
}

export function plexWatchUrls(
  machineId: string,
  ratingKey: string,
  mediaType: "MOVIE" | "TV",
): { webUrl: string; appUrl: string } | null {
  if (!isWatchLinkId(machineId) || !isWatchLinkId(ratingKey)) return null;
  // Encoded once, as ONE path segment of the app link.
  const key = encodeURIComponent(`/library/metadata/${ratingKey}`);
  return {
    webUrl: `https://app.plex.tv/desktop/#!/server/${machineId}/details?key=${key}`,
    appUrl: `plex://libraries/${machineId}/unmatched/${mediaType === "TV" ? "tv/" : ""}${key}`,
  };
}

// Jellyfin sends its ids undashed and Swiftfin stores them that way; a dashed
// copy (some rows keep the GUID form) names the same thing.
const bareId = (id: string): string => id.replace(/-/g, "").toLowerCase();

/**
 * Swiftfin's item link: the server, the viewer's own Jellyfin user on it, then
 * the item. Null without all three — Swiftfin routes by server and user first.
 */
export function swiftfinWatchUrl(serverId: string, jellyfinUserId: string | null | undefined, itemId: string): string | null {
  if (!isWatchLinkId(serverId) || !isWatchLinkId(jellyfinUserId) || !isWatchLinkId(itemId)) return null;
  return `swiftfin://${bareId(serverId)}/${bareId(jellyfinUserId)}/item/${bareId(itemId)}`;
}

/**
 * `candidates` are browser-facing addresses in order of preference (the
 * admin's browser address, then the connection URL); the first usable one
 * (absolute http(s), no credentials) is the link's host.
 */
export function jellyfinWatchUrl(
  candidates: ReadonlyArray<string | null | undefined>,
  serverId: string,
  itemId: string,
): string | null {
  if (!isWatchLinkId(serverId) || !isWatchLinkId(itemId)) return null;
  const base = arrBrowserBase(...candidates);
  if (base === null) return null;
  return `${base}/web/index.html#/details?id=${itemId}&serverId=${serverId}`;
}

/** The item a link opens: the row's canonical id, else its first listed copy (guardrails 37, 37c). */
export function watchItemId(canonical: string | null | undefined, all: ReadonlyArray<string> | null | undefined): string | null {
  if (isWatchLinkId(canonical)) return canonical;
  for (const id of all ?? []) if (isWatchLinkId(id)) return id;
  return null;
}
