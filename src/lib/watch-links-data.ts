import "server-only";
import { prisma } from "@/lib/prisma";
import { getMediaInstances } from "@/lib/media-instance-registry";
import { plexSettingKey, jellyfinSettingKey, type MediaServerService } from "@/lib/media-instances";
import type { VisibleServerInstances } from "@/lib/media-visibility";
import { jellyfinWatchUrl, plexWatchUrls, watchItemId, type WatchLink } from "@/lib/watch-links";

// "Watch on Plex / Jellyfin" — the data half, and the ONLY producer of a watch
// link (guardrail 35b). A link exists for a server only when:
//   • the viewer may see it — the library read is scoped to `visible`, the
//     same list every availability read on the page uses (guardrail 35), so a
//     restricted server the viewer holds no grant for contributes nothing;
//   • its chip is shown to this viewer (`show`, the badge-visibility mask);
//   • the library sync has stored its identity (media-server-identity.ts) —
//     no upstream call is made here;
//   • for Jellyfin, a browser-usable address is stored.
// It carries the item id, the server identity and the browser address — never
// a path (guardrail 37f), a token or a slug.

type MediaType = "MOVIE" | "TV";

interface Held {
  slug: string;
  itemId: string;
}

// Display names, read only when the viewer sees several servers of one kind.
async function namesFor(service: MediaServerService, held: Held[]): Promise<Map<string, string>> {
  if (held.length < 2) return new Map();
  return new Map((await getMediaInstances(service)).map((i) => [i.slug, i.name]));
}

const usable = (rows: Array<{ serverInstance: string; itemId: string | null }>, order: string[]): Held[] =>
  rows
    .flatMap((r) => (r.itemId === null ? [] : [{ slug: r.serverInstance, itemId: r.itemId }]))
    // The registry's order (default first), not the table's.
    .sort((a, b) => order.indexOf(a.slug) - order.indexOf(b.slug));

export async function loadWatchLinks(
  visible: VisibleServerInstances,
  tmdbId: number,
  mediaType: MediaType,
  show: { showPlex: boolean; showJellyfin: boolean },
): Promise<WatchLink[]> {
  const plexSlugs = show.showPlex ? visible.plex : [];
  const jellyfinSlugs = show.showJellyfin ? visible.jellyfin : [];
  if (plexSlugs.length === 0 && jellyfinSlugs.length === 0) return [];

  const [plexRows, jellyfinRows] = await Promise.all([
    plexSlugs.length === 0
      ? []
      : prisma.plexLibraryItem.findMany({
          where: { tmdbId, mediaType, serverInstance: { in: plexSlugs } },
          select: { serverInstance: true, plexRatingKey: true, plexRatingKeys: true },
        }),
    jellyfinSlugs.length === 0
      ? []
      : prisma.jellyfinLibraryItem.findMany({
          where: { tmdbId, mediaType, serverInstance: { in: jellyfinSlugs } },
          select: { serverInstance: true, jellyfinItemId: true, jellyfinItemIds: true },
        }),
  ]);
  const plex = usable(plexRows.map((r) => ({ serverInstance: r.serverInstance, itemId: watchItemId(r.plexRatingKey, r.plexRatingKeys) })), plexSlugs);
  const jellyfin = usable(jellyfinRows.map((r) => ({ serverInstance: r.serverInstance, itemId: watchItemId(r.jellyfinItemId, r.jellyfinItemIds) })), jellyfinSlugs);
  if (plex.length === 0 && jellyfin.length === 0) return [];

  const keys = [
    ...plex.map((h) => plexSettingKey(h.slug, "MachineId")),
    ...jellyfin.flatMap((h) => [
      jellyfinSettingKey(h.slug, "ServerId"),
      jellyfinSettingKey(h.slug, "WebAddress"),
      jellyfinSettingKey(h.slug, "Url"),
    ]),
  ];
  const [settingRows, plexNames, jellyfinNames] = await Promise.all([
    prisma.setting.findMany({ where: { key: { in: keys } }, select: { key: true, value: true } }),
    namesFor("plex", plex),
    namesFor("jellyfin", jellyfin),
  ]);
  const setting = new Map(settingRows.map((r) => [r.key, r.value]));

  const links: WatchLink[] = [];
  for (const held of plex) {
    const urls = plexWatchUrls(setting.get(plexSettingKey(held.slug, "MachineId")) ?? "", held.itemId);
    if (urls) links.push({ server: "plex", name: plexNames.get(held.slug) ?? null, ...urls });
  }
  for (const held of jellyfin) {
    const webUrl = jellyfinWatchUrl(
      [setting.get(jellyfinSettingKey(held.slug, "WebAddress")), setting.get(jellyfinSettingKey(held.slug, "Url"))],
      setting.get(jellyfinSettingKey(held.slug, "ServerId")) ?? "",
      held.itemId,
    );
    if (webUrl) links.push({ server: "jellyfin", name: jellyfinNames.get(held.slug) ?? null, webUrl, appUrl: null });
  }
  return links;
}
