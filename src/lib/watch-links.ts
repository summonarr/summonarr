// "Watch on Plex / Jellyfin" — the pure half: where a library item lives in
// each server's own client. The data half (which servers the viewer may see,
// which item, which address) is watch-links-data.ts (guardrail 35b).
//
// Plex is addressed through app.plex.tv by the server's machineIdentifier, so
// it needs no server address; its mobile apps take the same pair as a
// plex:// link. Jellyfin's web client is served by the server itself, so its
// link needs the address a BROWSER uses; Jellyfin's mobile apps have no
// documented link to an item, so there is no app link for it.
import { arrBrowserBase } from "./arr-links";

export type WatchLinkServer = "plex" | "jellyfin";

export interface WatchLink {
  server: WatchLinkServer;
  // The server's display name — only when the viewer can see more than one
  // server of this kind (otherwise the brand name says it all). Never a slug.
  name: string | null;
  // Opens the title in a browser.
  webUrl: string;
  // Opens the title in the server's own mobile app; null when it has none.
  appUrl: string | null;
}

// A server identity or item id as the servers issue them: Plex's
// machineIdentifier (hex), a ratingKey (digits), Jellyfin's ids (hex, some
// versions dashed). Anything else is not put in a link.
const LINK_ID_RE = /^[A-Za-z0-9-]{1,128}$/;

export function isWatchLinkId(value: unknown): value is string {
  return typeof value === "string" && LINK_ID_RE.test(value);
}

export function plexWatchUrls(machineId: string, ratingKey: string): { webUrl: string; appUrl: string } | null {
  if (!isWatchLinkId(machineId) || !isWatchLinkId(ratingKey)) return null;
  const key = encodeURIComponent(`/library/metadata/${ratingKey}`);
  return {
    webUrl: `https://app.plex.tv/desktop/#!/server/${machineId}/details?key=${key}`,
    appUrl: `plex://preplay/?metadataKey=${key}&server=${machineId}`,
  };
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
