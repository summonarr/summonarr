// Pure, zero-import: whether a media-server user is STILL ON their server.
//
// Shared by the admin Activity users page and its native-client mirror (GET
// /api/play-history/users), so the two cannot disagree about who was removed.
//
// "Still on the server" is read live from each server, not from the stored
// `active` flag alone: nothing marks a Plex user inactive, and the hourly
// Jellyfin sync can lag or refuse a shrink. Each row is checked against ITS OWN
// server — never the union across servers, which kept a friend unshared from B
// "Active" there while A still shared with them. A server whose list can't be
// read (or a removed server, whose rows were soft-deleted) falls back to
// `active`.

export interface PresenceRow {
  source: string;
  active: boolean;
  isServerAdmin: boolean;
  serverInstance: string;
  sourceUserId: string;
}

/** Per Plex server: the ids its plex.tv share list holds. */
export type PlexMembersByInstance = ReadonlyMap<string, { ids: ReadonlySet<string> }>;
/** Per Jellyfin server: user id → disabled. */
export type JellyfinLiveUsers = ReadonlyMap<string, ReadonlyMap<string, boolean>>;

export function plexOnServer(
  u: Pick<PresenceRow, "active" | "isServerAdmin" | "serverInstance" | "sourceUserId">,
  byInstance: PlexMembersByInstance | null | undefined,
): boolean {
  // The owner is never on their own share list.
  if (u.isServerAdmin) return true;
  const members = byInstance?.get(u.serverInstance);
  if (!members) return u.active;
  return members.ids.has(u.sourceUserId);
}

export function jellyfinOnServer(
  u: Pick<PresenceRow, "active" | "serverInstance" | "sourceUserId">,
  live: JellyfinLiveUsers | null | undefined,
): boolean {
  const users = live?.get(u.serverInstance);
  if (!users) return u.active;
  const disabled = users.get(u.sourceUserId);
  return disabled !== undefined && !disabled;
}

export function isOnServer(
  u: PresenceRow,
  plexMembers: PlexMembersByInstance | null | undefined,
  jellyfinLive: JellyfinLiveUsers | null | undefined,
): boolean {
  return u.source === "plex" ? plexOnServer(u, plexMembers) : jellyfinOnServer(u, jellyfinLive);
}
