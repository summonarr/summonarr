// The watch sync page's lists (GET /api/admin/watch-sync), built from the rows
// the route reads. Pure. No provider subject id, token or server address
// reaches the browser: an account is its row id, username and server name.
import { compareNames, compareServerUsers } from "@/lib/watch-sync";

export interface ServerUserRow {
  id: string;
  source: string;
  serverInstance: string;
  username: string;
  active: boolean;
  userId: string | null;
}

export interface ServerUserOut {
  id: string;
  username: string;
  server: string;
  active: boolean;
}

export interface ServerNames {
  plex: ReadonlyMap<string, string>;
  jellyfin: ReadonlyMap<string, string>;
}

export interface WatchSyncSuggestion {
  plexUserId: string;
  jellyfinUserId: string;
  account: string;
}

// The server's display name; a slug the registry no longer lists shows as itself.
export function serverUserOut(names: ServerNames, u: ServerUserRow): ServerUserOut {
  const server = (u.source === "plex" ? names.plex : names.jellyfin).get(u.serverInstance) ?? (u.serverInstance || u.source);
  return { id: u.id, username: u.username, server, active: u.active };
}

const pairKey = (plexId: string, jellyfinId: string) => `${plexId}\u0000${jellyfinId}`;

// A Plex account and a Jellyfin user linked to the same Summonarr account, not
// already paired. Only a suggestion: an admin makes every pair (guardrail
// 19e). Both lists come in A–Z; the answer is A–Z by account. The Jellyfin
// users are bucketed by account, so each Plex account visits only its own
// account's users.
export function watchSyncSuggestions<U extends ServerUserRow & { user?: { name: string | null; email: string | null } | null }>(
  plexUsers: readonly U[],
  jellyfinUsers: readonly U[],
  pairs: ReadonlyArray<{ plexUser: { id: string }; jellyfinUser: { id: string } }>,
): WatchSyncSuggestion[] {
  const paired = new Set(pairs.map((p) => pairKey(p.plexUser.id, p.jellyfinUser.id)));
  const jellyfinByAccount = new Map<string, U[]>();
  for (const j of jellyfinUsers) {
    if (!j.userId) continue;
    const bucket = jellyfinByAccount.get(j.userId);
    if (bucket) bucket.push(j);
    else jellyfinByAccount.set(j.userId, [j]);
  }
  const suggestions: WatchSyncSuggestion[] = [];
  for (const p of plexUsers) {
    if (!p.userId) continue;
    for (const j of jellyfinByAccount.get(p.userId) ?? []) {
      if (paired.has(pairKey(p.id, j.id))) continue;
      suggestions.push({ plexUserId: p.id, jellyfinUserId: j.id, account: p.user?.name || p.user?.email || p.username });
    }
  }
  return suggestions.sort((a, b) => compareNames(a.account, b.account));
}

// Each service's accounts, A–Z by user name ignoring case (the database order
// is case-sensitive: "GuestRoom" before "alice").
export function splitServerUsers<U extends ServerUserRow>(users: readonly U[]): { plex: U[]; jellyfin: U[] } {
  return {
    plex: users.filter((u) => u.source === "plex").sort(compareServerUsers),
    jellyfin: users.filter((u) => u.source === "jellyfin").sort(compareServerUsers),
  };
}
