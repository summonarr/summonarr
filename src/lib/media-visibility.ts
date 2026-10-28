import "server-only";
import { prisma } from "@/lib/prisma";
import {
  Permission,
  canViewMediaInstance,
  effectivePermissions,
  parseMediaServerGrants,
  type MediaInstanceAccess,
  type MediaServerGrants,
} from "@/lib/permissions";
import { getMediaInstances } from "@/lib/media-instance-registry";
import type { SummonarrSession } from "@/lib/api-auth";

// Which Plex/Jellyfin server instances a given viewer may see (multi-server
// per-user visibility grants). A server marked `restricted` in the registry
// contributes availability ONLY for users granted `view` on it, so the
// availability union — historically global — is now scoped per viewer.
//
// The impure counterpart to canViewMediaInstance in permissions.ts, which must
// stay a zero-import leaf (client components import it). Modeled on
// four-k-visibility.ts: resolve the viewer's visibility ONCE per request and
// pass the result down, rather than re-deriving it per media item.
//
// DB cost per call:
//   • 2 × setting.findUnique — one registry blob per service (getMediaInstances).
//   • 1 × user.findUnique — the grants column, and ONLY when it can change the
//     answer: skipped for a null session, skipped for ADMIN (superbit bypasses),
//     and skipped when no configured instance is restricted. That last case is
//     every deployment that hasn't opted in, so the common path stays at two
//     Setting reads — the same cost the module had before grants existed.
//
// Three entry points, one per shape of "who is asking":
//   • getVisibleServerInstances(session)          — a request's own viewer.
//   • getVisibleServerInstancesForUserId(userId)  — a bare id (attach-all's
//     chokepoint). Same answers; it cannot skip the read for ADMIN because the
//     superbit isn't in a claim here, so it derives perms from the stored role.
//   • getMediaInstanceAccessLists()               — the registry half alone, for
//     callers that already hold their acting user's row or resolve it by some
//     other key, finishing with the pure visibleInstancesFor.

export interface VisibleServerInstances {
  plex: string[];
  jellyfin: string[];
}

// PURE core. Exported separately because the sync orchestrator resolves
// visibility for MANY requesters in one pass (the availability-marking and
// notification paths) and must not issue a registry round-trip per user: it
// reads the two instance lists once, then calls this in a loop over requesters
// with each one's already-loaded perms + grants.
export function visibleInstancesFor(
  perms: bigint,
  grants: MediaServerGrants,
  plexInstances: MediaInstanceAccess[],
  jellyfinInstances: MediaInstanceAccess[],
): VisibleServerInstances {
  return {
    plex: plexInstances.filter((i) => canViewMediaInstance(perms, i, grants, "plex")).map((i) => i.slug),
    jellyfin: jellyfinInstances
      .filter((i) => canViewMediaInstance(perms, i, grants, "jellyfin"))
      .map((i) => i.slug),
  };
}

// The registry half of the resolver: both instance lists plus whether the
// grants column can change the answer at all.
//
// Exported for callers whose acting user is neither the session user nor
// addressable by primary key — the on-behalf bulk route (which already holds
// the TARGET's row) and the Discord interaction handler (whose user is keyed by
// discordId). They finish with the pure visibleInstancesFor rather than
// re-deriving `anyRestricted`, which is the one piece that must not drift: read
// it wrong and either a restricted library leaks or every deployment pays an
// identity round-trip it doesn't need.
export async function getMediaInstanceAccessLists(): Promise<{
  plex: MediaInstanceAccess[];
  jellyfin: MediaInstanceAccess[];
  anyRestricted: boolean;
}> {
  const [plex, jellyfin] = await Promise.all([getMediaInstances("plex"), getMediaInstances("jellyfin")]);
  return {
    plex,
    jellyfin,
    anyRestricted: plex.some((i) => i.restricted) || jellyfin.some((i) => i.restricted),
  };
}

// Per-request resolver for a single viewer.
//
// A null session (anonymous/unauthenticated reader) sees UNRESTRICTED instances
// only — 0n permissions and an empty grant map, which is exactly the
// least-privileged answer. Deliberate: restricted means "granted users only",
// and nobody can hold a grant without an account, so anonymous can never be
// more visible than the least-privileged signed-in user.
export async function getVisibleServerInstances(
  session: SummonarrSession | null,
): Promise<VisibleServerInstances> {
  return visibleForSession(session, await getMediaInstanceAccessLists());
}

// The session half of the resolver, over instance lists the caller already
// loaded — so titlesHiddenFromViewer below reads the registry once, not twice.
async function visibleForSession(
  session: SummonarrSession | null,
  lists: { plex: MediaInstanceAccess[]; jellyfin: MediaInstanceAccess[]; anyRestricted: boolean },
): Promise<VisibleServerInstances> {
  const { plex: plexInstances, jellyfin: jellyfinInstances, anyRestricted } = lists;

  if (!session) return visibleInstancesFor(0n, {}, plexInstances, jellyfinInstances);

  const perms = session.user.permissions;
  const isAdmin = (perms & Permission.ADMIN) !== 0n;

  let grants: MediaServerGrants = {};
  // Nothing restricted ⇒ every instance is visible to everyone, so the grants
  // column cannot change the answer. Skip the read.
  if (!isAdmin && anyRestricted) {
    const row = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { mediaServerGrants: true },
    });
    grants = parseMediaServerGrants(row?.mediaServerGrants);
  }

  return visibleInstancesFor(perms, grants, plexInstances, jellyfinInstances);
}

export interface MediaTitleKey {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
}

// A where fragment selecting exactly these (tmdbId, mediaType) keys, split per
// type so each half is one `IN` the planner serves from the composite key. The
// shape fits every table carrying the pair (DeletionVote, the two library
// tables). An EMPTY list selects nothing (`OR: []` is false in Prisma) — a
// caller negating it must check the length first.
export function titleKeysWhere(keys: MediaTitleKey[]): { OR: Array<{ mediaType: "MOVIE" | "TV"; tmdbId: { in: number[] } }> } {
  const movie: number[] = [];
  const tv: number[] = [];
  for (const k of keys) (k.mediaType === "MOVIE" ? movie : tv).push(k.tmdbId);
  const OR: Array<{ mediaType: "MOVIE" | "TV"; tmdbId: { in: number[] } }> = [];
  if (movie.length) OR.push({ mediaType: "MOVIE", tmdbId: { in: movie } });
  if (tv.length) OR.push({ mediaType: "TV", tmdbId: { in: tv } });
  return { OR };
}

// Among `keys`, the titles this viewer must not be shown at all: held ONLY on
// servers they hold no grant for (guardrail 35). A title the viewer can see on
// some server is not hidden, and neither is one in no library at all — a vote
// or a request outlives the copy it was about, and "it was here once" is not a
// restricted server's holding. Lists built from user records (the deletion
// votes list, which otherwise names a restricted server's titles AND other
// voters' reasons about them) subtract this before paging.
//
// `keys` may be a loader, called only when something IS hidden from this
// viewer: an unrestricted deployment, an ADMIN, or a fully granted user pays
// no read for it.
export async function titlesHiddenFromViewer(
  session: SummonarrSession | null,
  keys: MediaTitleKey[] | (() => Promise<MediaTitleKey[]>),
): Promise<MediaTitleKey[]> {
  const lists = await getMediaInstanceAccessLists();
  if (!lists.anyRestricted) return [];
  const visible = await visibleForSession(session, lists);
  const hiddenPlex = lists.plex.map((i) => i.slug).filter((s) => !visible.plex.includes(s));
  const hiddenJellyfin = lists.jellyfin.map((i) => i.slug).filter((s) => !visible.jellyfin.includes(s));
  if (hiddenPlex.length === 0 && hiddenJellyfin.length === 0) return [];

  const list = typeof keys === "function" ? await keys() : keys;
  if (list.length === 0) return [];
  const keyWhere = titleKeysWhere(list);
  const select = { tmdbId: true, mediaType: true } as const;
  // A fixed four-way fan-out (guardrail 31), each bounded by `list`.
  const [onHiddenPlex, onHiddenJellyfin, onVisiblePlex, onVisibleJellyfin] = await Promise.all([
    hiddenPlex.length
      ? prisma.plexLibraryItem.findMany({ where: { ...keyWhere, serverInstance: { in: hiddenPlex } }, select })
      : Promise.resolve([]),
    hiddenJellyfin.length
      ? prisma.jellyfinLibraryItem.findMany({ where: { ...keyWhere, serverInstance: { in: hiddenJellyfin } }, select })
      : Promise.resolve([]),
    visible.plex.length
      ? prisma.plexLibraryItem.findMany({ where: { ...keyWhere, serverInstance: { in: visible.plex } }, select })
      : Promise.resolve([]),
    visible.jellyfin.length
      ? prisma.jellyfinLibraryItem.findMany({ where: { ...keyWhere, serverInstance: { in: visible.jellyfin } }, select })
      : Promise.resolve([]),
  ]);
  const keyOf = (r: { tmdbId: number; mediaType: string }) => `${r.mediaType}:${r.tmdbId}`;
  const seenOnVisible = new Set<string>();
  for (const r of onVisiblePlex) seenOnVisible.add(keyOf(r));
  for (const r of onVisibleJellyfin) seenOnVisible.add(keyOf(r));
  const out: MediaTitleKey[] = [];
  const added = new Set<string>();
  for (const r of [...onHiddenPlex, ...onHiddenJellyfin]) {
    const k = keyOf(r);
    if (seenOnVisible.has(k) || added.has(k)) continue;
    added.add(k);
    out.push({ tmdbId: r.tmdbId, mediaType: r.mediaType });
  }
  return out;
}

// Same resolver for a caller holding a bare user id instead of a session — the
// attachAllAvailability chokepoint, which every discovery list funnels through
// and which already carries `userId` (not the session) through its many call
// sites. Threading a session down instead would mean editing all of them.
//
// Unlike the session form this cannot read the ADMIN bit for free, so a
// restricted deployment always pays the user read; effectivePermissions then
// applies the superbit / role preset exactly as sign-in would. A missing row
// (stale id) falls back to the least-privileged answer, not to "sees
// everything". Anonymous (undefined userId) does the same, matching the null
// session above.
export async function getVisibleServerInstancesForUserId(
  userId: string | null | undefined,
): Promise<VisibleServerInstances> {
  const { plex, jellyfin, anyRestricted } = await getMediaInstanceAccessLists();
  if (!userId || !anyRestricted) return visibleInstancesFor(0n, {}, plex, jellyfin);

  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, permissions: true, mediaServerGrants: true },
  });
  if (!row) return visibleInstancesFor(0n, {}, plex, jellyfin);

  return visibleInstancesFor(
    effectivePermissions(row.role, row.permissions),
    parseMediaServerGrants(row.mediaServerGrants),
    plex,
    jellyfin,
  );
}

// ── TVEpisodeCache visibility ────────────────────────────────────────────────
// TVEpisodeCache deliberately has NO serverInstance column — episodes are
// TMDB-anchored shared data, and every configured server's episodes accumulate
// into ONE `source: "plex"` / `"jellyfin"` namespace (guardrail 35). That makes
// the table itself unable to answer "which server is this from", so a plain
// `source IN (...)` read would expose a RESTRICTED server's per-episode
// holdings to an ungranted viewer — the exact fact the grants feature exists to
// withhold, and it would leak as raw JSON on the season/availability routes,
// not merely as a rendered tick.
//
// The gate is therefore one level up: report a source's episodes only when the
// viewer can see SOME server of that type actually holding the title. That
// reduces the residual to episode granularity WITHIN a title the viewer already
// knows is available, which is exactly the pre-grants status quo for an
// unrestricted server. A real per-instance answer would need a serverInstance
// column on TVEpisodeCache, which contradicts its shared-data design.
export type EpisodeSource = "plex" | "jellyfin";

// JS-only form for callers that already hold the scoped library rows (a detail
// page fetching them in the same Promise.all) — costs no extra query.
export function visibleEpisodeSourcesFrom(
  hasVisiblePlexItem: boolean,
  hasVisibleJellyfinItem: boolean,
  providerSources: readonly string[],
): EpisodeSource[] {
  const out: EpisodeSource[] = [];
  if (hasVisiblePlexItem && providerSources.includes("plex")) out.push("plex");
  if (hasVisibleJellyfinItem && providerSources.includes("jellyfin")) out.push("jellyfin");
  return out;
}

// Query form for callers that hold only a tmdbId (the season + availability
// routes). Two indexed findFirsts; skipped entirely for a source the viewer's
// provider preference already excludes.
export async function visibleEpisodeSourcesFor(
  tmdbId: number,
  visible: VisibleServerInstances,
  providerSources: readonly string[],
): Promise<EpisodeSource[]> {
  const [plexItem, jellyfinItem] = await Promise.all([
    providerSources.includes("plex")
      ? prisma.plexLibraryItem.findFirst({
          where: { tmdbId, mediaType: "TV", serverInstance: { in: visible.plex } },
          select: { tmdbId: true },
        })
      : Promise.resolve(null),
    providerSources.includes("jellyfin")
      ? prisma.jellyfinLibraryItem.findFirst({
          where: { tmdbId, mediaType: "TV", serverInstance: { in: visible.jellyfin } },
          select: { tmdbId: true },
        })
      : Promise.resolve(null),
  ]);
  return visibleEpisodeSourcesFrom(!!plexItem, !!jellyfinItem, providerSources);
}
