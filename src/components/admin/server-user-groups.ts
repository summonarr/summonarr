// What the Users page's media-server table lists (server-user-table.tsx): the
// identities matching the search, grouped Plex then Jellyfin, and the counts
// under the table. Pure and directive-free (tests/server-user-groups.test.mts).
//
// The table renders exactly two sources. A row of any other source is never
// listed, so it is never counted either: the footer and the "no match" row read
// the same set the table shows.

export type MediaServerSource = "plex" | "jellyfin";

export const MEDIA_SERVER_SOURCES: readonly MediaServerSource[] = ["plex", "jellyfin"];

export function isMediaServerSource(source: string): source is MediaServerSource {
  return source === "plex" || source === "jellyfin";
}

export interface ServerUserLike {
  source: string;
  username: string;
  email: string | null;
  isServerAdmin: boolean;
  downloadsEnabled: boolean | null;
}

export interface ServerUserView<U> {
  /** The listed rows of each source, in the order given. */
  groups: Record<MediaServerSource, U[]>;
  /** Rows listed under the search. */
  shown: number;
  /** Rows the table can list at all, search aside. */
  total: number;
  /** Listed Jellyfin members (not server admins) with downloads off. */
  disabledJellyfin: number;
}

export function serverUserView<U extends ServerUserLike>(users: readonly U[], search: string): ServerUserView<U> {
  const query = search.trim().toLowerCase();
  const groups: Record<MediaServerSource, U[]> = { plex: [], jellyfin: [] };
  let total = 0;
  for (const u of users) {
    if (!isMediaServerSource(u.source)) continue;
    total++;
    if (query && !u.username.toLowerCase().includes(query) && !(u.email ?? "").toLowerCase().includes(query)) continue;
    groups[u.source].push(u);
  }
  const disabledJellyfin = groups.jellyfin.filter((u) => !u.isServerAdmin && u.downloadsEnabled === false).length;
  return { groups, shown: groups.plex.length + groups.jellyfin.length, total, disabledJellyfin };
}
