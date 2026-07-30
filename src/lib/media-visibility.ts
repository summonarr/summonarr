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
  const { plex: plexInstances, jellyfin: jellyfinInstances, anyRestricted } =
    await getMediaInstanceAccessLists();

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

// Same resolver for a caller holding a bare user id instead of a session — the
// attachAllAvailability chokepoint, which every discovery list funnels through
// and which already carries `userId` (not the session) through its 28 call
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
