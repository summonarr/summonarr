// The System tab's "Current shares" tile: how many accounts can use the media
// servers Summonarr syncs — every one of them, default and named (guardrail 35),
// the same set the library sync fans out over. Live calls, so the tile awaits
// this behind its own <Suspense>.
import { prisma } from "@/lib/prisma";
import { getSyncableMediaInstances } from "@/lib/media-instance-registry";
import { jellyfinSettingKey, plexSettingKey } from "@/lib/media-instances";
import { getPlexServerFriendIds, getPlexUser } from "@/lib/plex";
import { getJellyfinUserCount } from "@/lib/jellyfin";

/** One admin token's Plex servers: their friends, and the owner when it was asked for. */
export interface PlexShareGroup {
  friends: ReadonlySet<string>;
  /** The owner's plex.tv id; null when not asked for (one token) or plex.tv didn't say. */
  ownerId: string | null;
}

/**
 * Distinct plex.tv accounts across every Plex server (an account shared two
 * servers counts once; an owner who is a friend on another owner's server too),
 * plus each Jellyfin server's users — separate user databases, so they add up.
 * A server that didn't answer adds nothing; null when none answered, so the
 * tile shows "—" rather than a wrong count.
 */
export function combineShareCounts(
  plexGroups: ReadonlyArray<PlexShareGroup | null>,
  jellyfinCounts: ReadonlyArray<number | null>,
): number | null {
  const answered = plexGroups.filter((g): g is PlexShareGroup => g !== null);
  const jellyfin = jellyfinCounts.filter((n): n is number => n !== null);
  if (answered.length === 0 && jellyfin.length === 0) return null;
  const accounts = new Set<string>();
  for (const g of answered) for (const id of g.friends) accounts.add(id);
  let unnamedOwners = 0;
  for (const g of answered) {
    if (g.ownerId === null) unnamedOwners++;
    else accounts.add(g.ownerId);
  }
  return accounts.size + unnamedOwners + jellyfin.reduce((sum, n) => sum + n, 0);
}

async function plexGroup(token: string, urls: readonly string[], askOwner: boolean): Promise<PlexShareGroup | null> {
  const friends = await getPlexServerFriendIds(token, urls);
  if (!friends) return null;
  if (!askOwner) return { friends, ownerId: null };
  const ownerId = await getPlexUser(token).then((u) => u.id, () => null);
  return { friends, ownerId };
}

export async function countCurrentShares(): Promise<number | null> {
  const [plex, jellyfin] = await Promise.all([getSyncableMediaInstances("plex"), getSyncableMediaInstances("jellyfin")]);
  const keys = [
    ...plex.flatMap((i) => [plexSettingKey(i.slug, "ServerUrl"), plexSettingKey(i.slug, "AdminToken")]),
    ...jellyfin.flatMap((i) => [jellyfinSettingKey(i.slug, "Url"), jellyfinSettingKey(i.slug, "ApiKey")]),
  ];
  if (keys.length === 0) return null;
  // Trimmed, as every consumer of these settings uses them.
  const rows = await prisma.setting.findMany({ where: { key: { in: keys } } });
  const cfg = new Map(rows.map((r) => [r.key, r.value.trim()]));

  // Servers reached with one admin token share one plex.tv friends list.
  const byToken = new Map<string, string[]>();
  for (const i of plex) {
    const url = cfg.get(plexSettingKey(i.slug, "ServerUrl"));
    const token = cfg.get(plexSettingKey(i.slug, "AdminToken"));
    if (url && token) byToken.set(token, [...(byToken.get(token) ?? []), url]);
  }
  // With one token the owner is one account; with several, the owners are
  // told apart by their plex.tv ids.
  const askOwner = byToken.size > 1;
  const jellyfinServers = jellyfin.flatMap((i) => {
    const url = cfg.get(jellyfinSettingKey(i.slug, "Url"));
    const apiKey = cfg.get(jellyfinSettingKey(i.slug, "ApiKey"));
    return url && apiKey ? [{ url, apiKey }] : [];
  });
  const [plexGroups, jellyfinCounts] = await Promise.all([
    Promise.all([...byToken].map(([token, urls]) => plexGroup(token, urls, askOwner))),
    Promise.all(jellyfinServers.map(({ url, apiKey }) => getJellyfinUserCount(url, apiKey).catch(() => null))),
  ]);
  return combineShareCounts(plexGroups, jellyfinCounts);
}
